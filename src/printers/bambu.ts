import { PrinterImplementation } from "../types.js";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client as FTPClient } from "basic-ftp";
import { BambuPrinter } from "bambu-js";
import { BambuClient, PushAllCommand } from "bambu-node";
import { MAX_PRINT_FILE_BYTES, readSafe3mfArchive } from "../safety/archive.js";
import { inspectPrintFile, type PrintFileInspection } from "../safety/print-file.js";
import { normalizeModel, validateTemperature } from "../safety/limits.js";
import {
  manualHeatingRequirements,
  publishBambuCommand,
  readFreshPrinterStatus,
  validatePrinterState,
  type PrinterStateRequirements,
} from "../safety/printer-state.js";
import {
  cancelPendingPrinterOperations,
  normalizedRemotePath,
  uniquePrintName,
  withPrinterOperation,
  withPrintSnapshot,
} from "../safety/artifact.js";
import { requireHumanConfirmation, type ConfirmHardware } from "../safety/confirmation.js";
import { installBambuNodeRejectionGuard } from "./bambu-node-guard.js";
import { assertExpectedPeaks, validateExpectedPeaks, type ExpectedPeakTemperatures, type PrintSafetyOptions } from "../safety/expected-peaks.js";

export interface BambuPrintOptionsInternal {
  projectName: string;
  filePath: string;
  bambuModel?: string;
  /** Requested nozzle diameters; compared with the sliced file when supplied. */
  nozzleDiameters?: number[];
  useAMS?: boolean;
  plateIndex?: number;
  bedType?: string;
  bedLeveling?: boolean;
  flowCalibration?: boolean;
  vibrationCalibration?: boolean;
  layerInspect?: boolean;
  timelapse?: boolean;
  /** Positional mapping: project filament position -> absolute AMS tray (254 = external spool). */
  amsMapping?: number[];
  md5?: string;
  expectedPeaks?: ExpectedPeakTemperatures;
}

export type BambuSafetyOptions = PrintSafetyOptions;

interface ProjectFileMetadata {
  plateFileName: string;
  plateInternalPath: string;
  md5: string;
}

const COMMAND_SETTLE_MS = 300;
/** bambu-node waits 1 s, then 5 s for its first command; allow that plus margin before giving up on it. */
const BAMBU_INITIAL_COMMAND_GRACE_MS = 8_000;
const DEVELOPER_MODE_HINT =
  "If requests stay unanswered, check that LAN Only Mode is on and, on firmware 01.08.05 and later, that Developer Mode is on (Settings > WLAN); the printer keeps broadcasting status either way.";
/** HMS 0500-0500-0001-0007: firmware 01.08.05+ rejected an unsigned MQTT command. */
const COMMAND_VERIFICATION_HMS = { attr: 0x05000500, code: 0x00010007 };
const COMMAND_REJECTED_MESSAGE =
  "The printer rejected the print command (HMS 0500-0500-0001-0007, \"MQTT command verification failed\"). " +
  "Bambu firmware 01.08.05 and later only accept third-party LAN control with LAN Only Mode and Developer Mode " +
  "enabled (Settings > WLAN on the printer). The printer keeps this error until it is dismissed on its screen, and the " +
  "safety check refuses new prints while it is present. The checked file is on the printer's storage, but nothing is printing.";
const DISPATCH_CANCELLED_MESSAGE =
  "The print command was sent, then a stop or heater-off request cancelled it before the printer confirmed the start. " +
  "Check get_printer_status.";

/** How long to watch fresh reports after a print command (BAMBU_DISPATCH_CHECK_MS, 0 disables). */
function dispatchCheckMs(): number {
  const raw = process.env.BAMBU_DISPATCH_CHECK_MS?.trim();
  const value = raw ? Number(raw) : 15_000;
  return Number.isInteger(value) && value >= 0 && value <= 60_000 ? value : 15_000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validateTrayValue(value: unknown, label: string): void {
  if (
    !Number.isInteger(value) ||
    (value as number) < -1 ||
    ((value as number) > 15 && (value as number) < 128) ||
    (value as number) > 254
  ) {
    throw new Error(
      `${label} values must be integers in [-1, 15] (absolute tray) or 128-254 (HT/external); got ${String(value)}`
    );
  }
}

class BambuClientStore {
  private printers: Map<string, BambuClient> = new Map();
  private initialConnectionPromises: Map<string, Promise<void>> = new Map();

  async getPrinter(host: string, serial: string, token: string): Promise<BambuClient> {
    installBambuNodeRejectionGuard();
    const key = `${host}-${serial}`;

    if (this.printers.has(key)) {
      return this.printers.get(key)!;
    }

    if (this.initialConnectionPromises.has(key)) {
      await this.initialConnectionPromises.get(key);
      if (this.printers.has(key)) {
        return this.printers.get(key)!;
      }
      throw new Error(`Existing Bambu client connection for ${key} failed.`);
    }

    const printer = new BambuClient({
      host,
      serialNumber: serial,
      accessToken: token,
    });

    printer.on("client:connect", () => {
      this.printers.set(key, printer);
      this.initialConnectionPromises.delete(key);
    });

    printer.on("client:error", () => {
      this.printers.delete(key);
      this.initialConnectionPromises.delete(key);
    });

    printer.on("client:disconnect", () => {
      this.printers.delete(key);
      this.initialConnectionPromises.delete(key);
    });

    const connectPromise = printer.connect().then(() => {});
    // bambu-node resolves connect() only after its own initial commands are
    // answered. A printer that broadcasts reports but ignores third-party
    // commands (LAN Only Mode without Developer Mode) never answers them, so
    // connect() would hang forever. Once the MQTT session is up, keep the
    // client after a grace period: reports still fill printer.data, and each
    // caller's own command fails on its own timeout instead. Concurrent callers
    // wait on the same bounded promise.
    const ready = this.awaitUsableClient(printer, connectPromise, serial).then(() => {
      this.printers.set(key, printer);
    });
    this.initialConnectionPromises.set(key, ready);
    // A late connect() failure must not leave a half-initialised client cached.
    connectPromise.catch(() => {
      if (this.printers.get(key) === printer) this.printers.delete(key);
    });

    try {
      await ready;
      return printer;
    } catch (error) {
      this.initialConnectionPromises.delete(key);
      this.printers.delete(key);
      void printer.disconnect(true).catch(() => {});
      throw error;
    } finally {
      this.initialConnectionPromises.delete(key);
    }
  }

  private async awaitUsableClient(printer: BambuClient, connectPromise: Promise<void>, serial: string): Promise<void> {
    const mqttClient = (printer as unknown as {
      mqttClient?: { connected?: boolean; once(event: "connect", listener: () => void): unknown };
    }).mqttClient;
    let graceTimer: NodeJS.Timeout | undefined;
    const sessionUpThenSilent = new Promise<void>((resolve) => {
      const armGrace = () => {
        graceTimer = setTimeout(() => {
          console.warn(
            `Bambu printer ${serial} accepted the MQTT login but did not answer the initial version request; continuing with its broadcast reports. ${DEVELOPER_MODE_HINT}`
          );
          resolve();
        }, BAMBU_INITIAL_COMMAND_GRACE_MS);
      };
      if (!mqttClient) return; // no session handle: rely on connect() alone
      if (mqttClient.connected) armGrace();
      else mqttClient.once("connect", armGrace);
    });
    try {
      await Promise.race([connectPromise, sessionUpThenSilent]);
    } finally {
      if (graceTimer) clearTimeout(graceTimer);
    }
  }

  async disconnectAll(): Promise<void> {
    const disconnectPromises: Promise<void>[] = [];

    for (const printer of this.printers.values()) {
      disconnectPromises.push(
        (async () => {
          try {
            await printer.disconnect();
          } catch (error) {
            console.error("Failed to disconnect Bambu client", error);
          }
        })()
      );
    }

    await Promise.allSettled(disconnectPromises);
    this.printers.clear();
    this.initialConnectionPromises.clear();
  }
}

export class BambuImplementation extends PrinterImplementation {
  private printerStore: BambuClientStore;

  constructor(apiClient: any, private readonly confirm?: ConfirmHardware) {
    super(apiClient);
    this.printerStore = new BambuClientStore();
  }

  async confirmHardwareAction(message: string, physicalCheck = false): Promise<void> {
    await requireHumanConfirmation(this.confirm, message, "bambu", physicalCheck);
  }

  private finishedJobIdentity(status: any): string | undefined {
    return status.raw.gcode_state === "FINISH"
      ? JSON.stringify([status.raw.gcode_file, status.raw.subtask_name, status.raw.task_id, status.raw.subtask_id])
      : undefined;
  }

  async confirmPrintPreflight(serial: string, status: any, inspection: PrintFileInspection): Promise<string | undefined> {
    const finishedJob = this.finishedJobIdentity(status);
    await this.confirmHardwareAction(
      `Start a checked print on ${inspection.model.toUpperCase()} (${serial})? Nozzles: ${inspection.nozzleDiameters.join(", ")} mm. ` +
      `Materials: ${inspection.materials.join(", ")}. Peak targets: nozzle ${inspection.maxNozzleTemperature}°C, bed ${inspection.maxBedTemperature}°C, chamber ${inspection.maxChamberTemperature}°C. ` +
      `File SHA-256: ${inspection.sha256}. Confirm the physical spool labels and that the build plate is clear.` +
      (finishedJob !== undefined ? " The printer reports FINISH: remove the previous part and debris before confirming." : ""),
      finishedJob !== undefined
    );
    return finishedJob;
  }

  assertBedClearance(status: any, confirmedFinishedJob: string | undefined): void {
    const current = this.finishedJobIdentity(status);
    if (current !== undefined && current !== confirmedFinishedJob) {
      throw new Error("Printer reports a newly finished job. Confirm that its part and debris have been removed before retrying the print.");
    }
  }

  private async getPrinter(host: string, serial: string, token: string): Promise<BambuClient> {
    return this.printerStore.getPrinter(host, serial, token);
  }

  /** Safety reads never use the display cache or configured-serial model inference. */
  async getSafetyStatus(host: string, serial: string, token: string): Promise<any> {
    return readFreshPrinterStatus(await this.getPrinter(host, serial, token), serial);
  }

  /** Raw gcode_file printing cannot remap spools: verify the material already at the nozzle. */
  private validateLoadedGcodeState(status: any, inspection: PrintFileInspection): PrinterStateRequirements {
    const usedMaterials = inspection.usedFilamentPositions.map((position) => inspection.materials[position]);
    if (new Set(usedMaterials).size !== 1) {
      throw new Error("gcode_file printing cannot verify physical changes between different materials. Use a mapped .3mf project.");
    }
    const loaded = manualHeatingRequirements(status, inspection.model, inspection.nozzleDiameters[0], usedMaterials[0]);
    const mapping = Array<number>(inspection.materials.length).fill(-1);
    inspection.usedFilamentPositions.forEach((position) => { mapping[position] = loaded.amsMapping?.[0] ?? 254; });
    const requirements: PrinterStateRequirements = {
      ...inspection, useAMS: loaded.useAMS, amsMapping: mapping,
      usedNozzleIndices: loaded.usedNozzleIndices, requireLoadedFilament: true,
    };
    validatePrinterState(status, requirements);
    return requirements;
  }

  private async resolveProjectFileMetadata(
    localThreeMfPath: string,
    plateIndex: number | undefined,
    inspectedPlatePath?: string
  ): Promise<ProjectFileMetadata> {
    const { zip } = await readSafe3mfArchive(localThreeMfPath);
    const expectedEntryName = `Metadata/plate_${(plateIndex ?? 0) + 1}.gcode`;
    if (inspectedPlatePath !== undefined && inspectedPlatePath !== expectedEntryName) {
      throw new Error("Inspected plate path does not match the requested print plate.");
    }
    const selectedEntry = zip.file(inspectedPlatePath ?? expectedEntryName);
    if (!selectedEntry) {
      throw new Error(`Selected inspected plate ${expectedEntryName} is not present in 3MF. Re-slice that plate.`);
    }
    const gcodeBuffer = await selectedEntry.async("nodebuffer");
    return {
      plateFileName: path.posix.basename(selectedEntry.name),
      plateInternalPath: selectedEntry.name,
      md5: createHash("md5").update(gcodeBuffer).digest("hex"),
    };
  }

  async getStatus(host: string, port: string, apiKey: string): Promise<any> {
    const [serial, token] = this.extractBambuCredentials(apiKey);

    try {
      const printer = await this.getPrinter(host, serial, token);

      try {
        await printer.executeCommand(new PushAllCommand());
      } catch (error) {
        console.warn("PushAllCommand failed, continuing with cached status", error);
      }

      if (!printer.data || Object.keys(printer.data).length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }

      const data = printer.data;

      return {
        status: data.gcode_state || "UNKNOWN",
        connected: true,
        temperatures: {
          nozzle: {
            actual: data.nozzle_temper || 0,
            target: data.nozzle_target_temper || 0,
          },
          bed: {
            actual: data.bed_temper || 0,
            target: data.bed_target_temper || 0,
          },
          chamber: data.chamber_temper || data.frame_temper || 0,
        },
        print: {
          filename: data.subtask_name || data.gcode_file || "None",
          progress: data.mc_percent || 0,
          timeRemaining: data.mc_remaining_time || 0,
          currentLayer: data.layer_num || 0,
          totalLayers: data.total_layer_num || 0,
        },
        ams: data.ams || null,
        model: data.model || "Unknown",
        serial,
        raw: data,
      };
    } catch (error) {
      console.error(`Failed to get Bambu status for ${serial}:`, error);
      const message = (error as Error).message;
      return {
        status: "error", connected: false, error: message,
        ...(/not authori[sz]ed|\b530\b|login incorrect/i.test(message)
          ? { hint: "The printer rejected its LAN access code. Read the current Access Code on the printer (Settings > Network/WLAN), update BAMBU_TOKEN, and check BAMBU_SERIAL." }
          : {}),
      };
    }
  }

  async print3mf(
    host: string,
    serial: string,
    token: string,
    options: BambuPrintOptionsInternal
  ): Promise<any> {
    if (!normalizeModel(options.bambuModel)) {
      throw new Error("A supported bambuModel is required before printing.");
    }
    if (!options.filePath.toLowerCase().endsWith(".3mf")) {
      throw new Error("print3mf requires a .3mf input file.");
    }
    validateExpectedPeaks(options.expectedPeaks);
    return withPrinterOperation(host, serial, (assertActive) => withPrintSnapshot(options.filePath, (filePath) =>
      this.print3mfPrepared(host, serial, token, { ...options, filePath }, assertActive)
    ));
  }

  private async print3mfPrepared(
    host: string,
    serial: string,
    token: string,
    options: BambuPrintOptionsInternal,
    assertActive: () => void
  ): Promise<any> {
    const model = normalizeModel(options.bambuModel)!;
    // Inspect the private snapshot: these exact bytes are uploaded below.
    const inspection = await inspectPrintFile(options.filePath, {
      model, nozzleDiameters: options.nozzleDiameters, plateIndex: options.plateIndex ?? 0, bedType: options.bedType,
    });
    assertExpectedPeaks(options.expectedPeaks, { nozzle: inspection.maxNozzleTemperature, bed: inspection.maxBedTemperature });
    const projectMetadata = await this.resolveProjectFileMetadata(options.filePath, options.plateIndex, inspection.plateInternalPath);
    const md5 = projectMetadata.md5;
    if (options.md5 !== undefined && options.md5 !== md5) {
      throw new Error("Provided checksum does not match the inspected plate G-code.");
    }

    for (const value of options.amsMapping ?? []) validateTrayValue(value, "ams_mapping");
    const useAMS = options.useAMS !== false;
    let checkedMapping: number[];
    if (useAMS) {
      checkedMapping = (options.amsMapping ?? []).slice();
    } else {
      checkedMapping = Array<number>(inspection.materials.length).fill(-1);
      inspection.usedFilamentPositions.forEach((position) => { checkedMapping[position] = 254; });
    }
    for (const position of inspection.usedFilamentPositions) {
      if (checkedMapping[position] === undefined || checkedMapping[position] < 0) {
        throw new Error(
          `Missing physical filament mapping for project filament ${position}. ` +
          "Pass ams_mapping with a tray for every used project filament, or use_ams:false for the external spool."
        );
      }
    }

    // Wire mapping: position = project filament, value = absolute tray. Never
    // truncate a checked mapping; pad to the historical five entries.
    const amsMapping = options.amsMapping && options.amsMapping.length > 0
      ? Array.from({ length: Math.max(5, options.amsMapping.length) }, (_, i) =>
          i < options.amsMapping!.length ? options.amsMapping![i] : -1)
      : [-1, -1, -1, -1, 0];

    const requirements: PrinterStateRequirements = { ...inspection, amsMapping: checkedMapping, useAMS };
    const initialStatus = await this.getSafetyStatus(host, serial, token);
    validatePrinterState(initialStatus, requirements);
    const bedClearance = await this.confirmPrintPreflight(serial, initialStatus, inspection);
    // Recheck after the human response: the printer may have changed meanwhile.
    const confirmedStatus = await this.getSafetyStatus(host, serial, token);
    validatePrinterState(confirmedStatus, requirements);
    this.assertBedClearance(confirmedStatus, bedClearance);
    assertActive();

    const remoteFileName = uniquePrintName(options.filePath);
    const remoteProjectPath = `cache/${remoteFileName}`;
    await this.ftpUpload(host, token, options.filePath, `/${remoteProjectPath}`);
    // Uploads can be long. Recheck current state before the command is dispatched.
    const dispatchStatus = await this.getSafetyStatus(host, serial, token);
    validatePrinterState(dispatchStatus, requirements);
    this.assertBedClearance(dispatchStatus, bedClearance);
    const printer = await this.getPrinter(host, serial, token);
    assertActive();

    const projectFileCmd = {
      print: {
        command: "project_file",
        param: projectMetadata.plateInternalPath,
        url: `file:///sdcard/${remoteProjectPath}`,
        subtask_name: options.projectName,
        md5,
        flow_cali: options.flowCalibration ?? true,
        layer_inspect: options.layerInspect ?? true,
        vibration_cali: options.vibrationCalibration ?? true,
        bed_leveling: options.bedLeveling ?? true,
        bed_type: options.bedType || "textured_plate",
        timelapse: options.timelapse ?? false,
        use_ams: useAMS,
        ams_mapping: amsMapping,
        profile_id: "0",
        project_id: "0",
        sequence_id: "0",
        subtask_id: "0",
        task_id: "0",
      },
    };

    const watcher = this.watchDispatch(printer, host, serial, token, dispatchStatus, assertActive);
    await printer.publish(projectFileCmd);
    await sleep(COMMAND_SETTLE_MS);
    const dispatch = await watcher.settled();

    return {
      status: "success",
      dispatch,
      message: dispatch === "started"
        ? `The printer accepted and started the checked 3MF print: ${options.projectName}`
        : `Uploaded the checked 3MF and sent the print command for ${options.projectName}; the printer has not reported starting yet. ` +
          "Check get_printer_status before assuming it is printing.",
      remoteProjectPath,
      plateFile: projectMetadata.plateFileName,
      platePath: projectMetadata.plateInternalPath,
      md5,
      sha256: inspection.sha256,
      amsMapping,
      peakTemperatures: {
        nozzle: inspection.maxNozzleTemperature,
        bed: inspection.maxBedTemperature,
        chamber: inspection.maxChamberTemperature,
      },
    };
  }

  /**
   * A published print command is not proof the printer took it. Listen to the
   * reports the printer pushes anyway (no extra pushall polling on weak P1
   * boards): a new command-verification HMS means the firmware refused the
   * command; PREPARE/SLICING/RUNNING means it started. Attach before publishing.
   */
  private watchDispatch(printer: any, host: string, serial: string, token: string, before: any, assertActive: () => void): { settled: () => Promise<"started" | "unconfirmed"> } {
    const windowMs = dispatchCheckMs();
    const stillActive = () => { try { assertActive(); } catch { throw new Error(DISPATCH_CANCELLED_MESSAGE); } };
    if (windowMs === 0 || typeof printer?.on !== "function") return { settled: async () => { stillActive(); return "unconfirmed"; } };
    const key = (entry: any) => `${Number(entry?.attr)}:${Number(entry?.code)}:${entry?.timestamp ?? ""}`;
    const known = new Set((Array.isArray(before?.raw?.hms) ? before.raw.hms : []).map(key));
    const judge = (report: any): "started" | "rejected" | undefined => {
      const hms = Array.isArray(report?.hms) ? report.hms : [];
      if (hms.some((entry: any) => Number(entry?.attr) === COMMAND_VERIFICATION_HMS.attr &&
          Number(entry?.code) === COMMAND_VERIFICATION_HMS.code && !known.has(key(entry)))) return "rejected";
      if (["PREPARE", "SLICING", "RUNNING"].includes(String(report?.gcode_state ?? "").toUpperCase())) return "started";
      return undefined;
    };
    let resolveOutcome!: (value: "started" | "rejected" | "cancelled" | undefined) => void;
    const outcome = new Promise<"started" | "rejected" | "cancelled" | undefined>((resolve) => { resolveOutcome = resolve; });
    // cancel_print bumps a local generation; notice it without touching the printer.
    const cancelCheck = setInterval(() => { try { assertActive(); } catch { resolveOutcome("cancelled"); } }, 500);
    const onRaw = (topic: string, payload: Buffer) => {
      if (topic !== `device/${serial}/report`) return;
      let parsed: any;
      try { parsed = JSON.parse(payload.toString()); } catch { return; }
      const verdict = judge(parsed?.print);
      if (verdict) resolveOutcome(verdict);
    };
    printer.on("rawMessage", onRaw);
    const timer = setTimeout(() => resolveOutcome(undefined), windowMs);
    return {
      settled: async () => {
        let verdict: "started" | "rejected" | "cancelled" | undefined;
        try {
          verdict = await outcome;
        } finally {
          clearTimeout(timer);
          clearInterval(cancelCheck);
          printer.off?.("rawMessage", onRaw);
        }
        if (verdict === "cancelled") throw new Error(DISPATCH_CANCELLED_MESSAGE);
        // Nothing pushed during the window: take one full report, not a polling loop.
        if (verdict === undefined) {
          try { verdict = judge((await this.getSafetyStatus(host, serial, token))?.raw); } catch { /* stays unconfirmed */ }
        }
        if (verdict === "rejected") throw new Error(COMMAND_REJECTED_MESSAGE);
        stillActive();
        return verdict ?? "unconfirmed";
      },
    };
  }

  /** Stop is never gated or queued behind pending checked operations. */
  async cancelJob(host: string, port: string, apiKey: string): Promise<any> {
    const [serial, token] = this.extractBambuCredentials(apiKey);
    cancelPendingPrinterOperations(host, serial);
    const printer = await this.getPrinter(host, serial, token);

    try {
      await publishBambuCommand(printer, "print", "stop");
      return { status: "success", message: "Cancel command sent successfully." };
    } catch (error) {
      throw new Error(`Failed to cancel print: ${(error as Error).message}`);
    }
  }

  async setTemperature(
    host: string,
    port: string,
    apiKey: string,
    component: string,
    temperature: unknown,
    options: BambuSafetyOptions = {}
  ) {
    const normalizedComponent = String(component).toLowerCase();
    const heater = normalizedComponent === "bed" ? "bed" :
      ["extruder", "nozzle", "tool", "tool0"].includes(normalizedComponent) ? "nozzle" : undefined;
    if (!heater) {
      throw new Error(
        `Unsupported temperature component: ${component}. Use one of: bed, nozzle, extruder.`
      );
    }
    // Validate before any credential use or connection.
    if (typeof temperature !== "number" || !Number.isFinite(temperature) || temperature < 0) {
      throw new Error("Temperature must be a finite, non-negative number in °C.");
    }
    const [serial, token] = this.extractBambuCredentials(apiKey);
    const model = normalizeModel(options.bambuModel);
    const material = options.material?.trim();
    const nozzleDiameter = options.nozzleDiameter ?? 0.4;
    if (temperature > 0 && !model) throw new Error("bambu_model is required before heating.");
    if (temperature > 0 && heater === "nozzle" && !material) {
      throw new Error("Declare material before nozzle heating, including non-RFID external spools.");
    }
    if (temperature > 0 && heater === "nozzle" && (!Number.isFinite(nozzleDiameter) || nozzleDiameter <= 0)) {
      throw new Error("nozzle_diameter must be a positive number for nozzle heating.");
    }
    const targetTemperature = temperature === 0
      ? 0
      : validateTemperature(heater, temperature, model!, material ? [material] : undefined);
    const gcode = `${heater === "bed" ? "M140" : "M104"}${heater === "nozzle" && targetTemperature > 0 ? " T0" : ""} S${targetTemperature}`;
    const send = async (assertActive: () => void) => {
      if (targetTemperature > 0) {
        const validateHeatingStatus = (current: any) => validatePrinterState(current, heater === "nozzle"
          ? manualHeatingRequirements(current, model!, nozzleDiameter, material!)
          : { model: model!, nozzleDiameters: [] });
        validateHeatingStatus(await this.getSafetyStatus(host, serial, token));
        await this.confirmHardwareAction(
          `Heat ${heater} on ${model!.toUpperCase()} (${serial}) to ${targetTemperature}°C?` +
          (material && heater === "nozzle" ? ` Declared material: ${material}. Confirm the physical spool label.` : "")
        );
        assertActive();
        validateHeatingStatus(await this.getSafetyStatus(host, serial, token));
      }
      const printer = await this.getPrinter(host, serial, token);
      assertActive();
      await publishBambuCommand(printer, "print", "gcode_line", { param: `${gcode}\n` });
      return { status: "success", message: `Temperature command sent for ${normalizedComponent}.`, command: gcode };
    };
    if (targetTemperature === 0) {
      // Heater-off is never gated and cancels pending checked operations.
      cancelPendingPrinterOperations(host, serial);
      return send(() => undefined);
    }
    return withPrinterOperation(host, serial, send);
  }

  async getFiles(host: string, port: string, apiKey: string) {
    const [, token] = this.extractBambuCredentials(apiKey);
    const directories = ["cache", "timelapse", "logs"];
    const filesByDirectory: Record<string, string[]> = {};
    // bambu-js swallowed listing failures as empty folders. List read-only over
    // the shared FTPS options with absolute paths and surface real failures.
    const client = new FTPClient(15_000);
    try {
      await client.access(this.ftpsOptions(host, token));
      const root = await client.list("/");
      for (const directory of directories) {
        const present = root.some((entry) => entry.name === directory && (entry.isDirectory || entry.isSymbolicLink));
        filesByDirectory[directory] = present ? (await client.list(`/${directory}`)).map((entry) => entry.name) : [];
      }
    } finally {
      client.close();
    }

    const files = Object.entries(filesByDirectory).flatMap(([directory, names]) =>
      names.map((name) => `${directory}/${name}`)
    );

    return {
      files,
      directories: filesByDirectory,
    };
  }

  async getFile(host: string, port: string, apiKey: string, filename: string) {
    const [serial, token] = this.extractBambuCredentials(apiKey);
    const printer = new BambuPrinter(host, serial, token);

    const normalized = filename.replace(/^\/+/, "");
    const directory = path.posix.dirname(normalized) === "." ? "cache" : path.posix.dirname(normalized);
    const baseName = path.posix.basename(normalized);

    let exists = false;

    await printer.manipulateFiles(async (context) => {
      const entries = await context.readDir(directory);
      exists = entries.includes(baseName);
    });

    return {
      name: `${directory}/${baseName}`,
      exists,
    };
  }

  async uploadFile(
    host: string,
    port: string,
    apiKey: string,
    filePath: string,
    filename: string,
    print: boolean,
    options: BambuSafetyOptions = {}
  ) {
    await fs.access(filePath);

    const [serial, token] = this.extractBambuCredentials(apiKey);
    const remotePath = normalizedRemotePath(filename);

    if (!print) {
      // Use direct FTP upload (bypasses bambu-js double-path bug)
      await this.ftpUpload(host, token, filePath, `/${remotePath}`);
      return {
        status: "success",
        uploaded: true,
        remotePath,
        printRequested: false,
      };
    }

    if (!remotePath.toLowerCase().endsWith(".gcode") || !filePath.toLowerCase().endsWith(".gcode")) {
      throw new Error("Automatic print after upload requires .gcode. Use print_3mf for inspected .3mf project prints.");
    }
    const model = normalizeModel(options.bambuModel);
    if (!model) throw new Error("A supported bambuModel is required before printing.");
    validateExpectedPeaks(options.expectedPeaks);
    return withPrinterOperation(host, serial, (assertActive) => withPrintSnapshot(filePath, (snapshot) =>
      this.printRawPrepared(host, serial, token, snapshot, remotePath, model, assertActive, options.expectedPeaks)
    ));
  }

  private async printRawPrepared(
    host: string,
    serial: string,
    token: string,
    filePath: string,
    filename: string,
    model: string,
    assertActive: () => void,
    expectedPeaks?: ExpectedPeakTemperatures
  ) {
    const inspection = await inspectPrintFile(filePath, { model });
    assertExpectedPeaks(expectedPeaks, { nozzle: inspection.maxNozzleTemperature, bed: inspection.maxBedTemperature });
    if (inspection.selectsAms) {
      throw new Error("Raw G-code with AMS selection requires a .3mf project export with verified physical slot mappings.");
    }
    const initialStatus = await this.getSafetyStatus(host, serial, token);
    this.validateLoadedGcodeState(initialStatus, inspection);
    const bedClearance = await this.confirmPrintPreflight(serial, initialStatus, inspection);
    const confirmedStatus = await this.getSafetyStatus(host, serial, token);
    this.validateLoadedGcodeState(confirmedStatus, inspection);
    this.assertBedClearance(confirmedStatus, bedClearance);
    assertActive();
    // Start a uniquely named copy of the inspected bytes, never a name that can change.
    const remotePath = path.posix.join(path.posix.dirname(filename), uniquePrintName(filename));
    await this.ftpUpload(host, token, filePath, `/${remotePath}`);
    const dispatchStatus = await this.getSafetyStatus(host, serial, token);
    this.validateLoadedGcodeState(dispatchStatus, inspection);
    this.assertBedClearance(dispatchStatus, bedClearance);
    const printer = await this.getPrinter(host, serial, token);
    assertActive();
    const watcher = this.watchDispatch(printer, host, serial, token, dispatchStatus, assertActive);
    await publishBambuCommand(printer, "print", "gcode_file", { param: remotePath });
    const dispatch = await watcher.settled();
    return {
      status: "success",
      uploaded: true,
      printRequested: true,
      dispatch,
      remotePath,
      sha256: inspection.sha256,
      message: dispatch === "started"
        ? `The printer accepted and started ${remotePath}.`
        : `Sent the print command for ${remotePath}; the printer has not reported starting yet. Check get_printer_status before assuming it is printing.`,
    };
  }

  async startJob(host: string, port: string, apiKey: string, filename: string, options: BambuSafetyOptions = {}) {
    if (filename.toLowerCase().endsWith(".3mf")) {
      throw new Error("Use print_3mf for .3mf project files.");
    }

    const [serial, token] = this.extractBambuCredentials(apiKey);
    const model = normalizeModel(options.bambuModel);
    if (!model) throw new Error("A supported bambuModel is required before printing.");
    const remotePath = normalizedRemotePath(filename);
    if (!remotePath.toLowerCase().endsWith(".gcode")) {
      throw new Error("Remote starts require inspectable .gcode. Use print_3mf with the local project for .3mf printing.");
    }
    validateExpectedPeaks(options.expectedPeaks);

    return withPrinterOperation(host, serial, async (assertActive) => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bambu-remote-check-"));
      const localPath = path.join(directory, path.basename(remotePath));
      try {
        await this.ftpDownload(host, token, remotePath, localPath);
        // Send a unique copy of the downloaded, inspected bytes. Starting the
        // original remote name would allow it to change after inspection.
        return await withPrintSnapshot(localPath, (snapshot) =>
          this.printRawPrepared(host, serial, token, snapshot, remotePath, model, assertActive, options.expectedPeaks)
        );
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    });
  }

  private ftpsOptions(host: string, token: string) {
    return {
      host,
      port: 990,
      user: "bblp",
      password: token,
      secure: "implicit" as const,
      // basic-ftp passes getSession() to the data socket. Keep both channels
      // on TLS 1.2, where that session is available at handshake completion;
      // TLS 1.3 tickets arrive later and can break Bambu's required reuse.
      // Node also binds resumable sessions to the host identity. basic-ftp
      // retains these options for its wrapped data socket, so explicitly keep
      // the same host there (nodejs/node#64402 affects implicit FTPS).
      secureOptions: { host, rejectUnauthorized: false, minVersion: "TLSv1.2" as const, maxVersion: "TLSv1.2" as const },
    };
  }

  private async ftpDownload(host: string, token: string, remotePath: string, localPath: string): Promise<void> {
    const client = new FTPClient(15_000);
    try {
      await client.access(this.ftpsOptions(host, token));
      const size = await client.size(`/${remotePath}`);
      if (!Number.isFinite(size) || size <= 0 || size > MAX_PRINT_FILE_BYTES) {
        throw new Error("Remote print file is empty or exceeds the 256 MiB inspection limit.");
      }
      await client.downloadTo(localPath, `/${remotePath}`);
    } finally {
      client.close();
    }
  }

  /**
   * Upload a file to the printer via FTP using basic-ftp directly.
   * Bypasses bambu-js's sendFile which has a double-path bug (ensureDir CDs
   * into the target directory, then uploadFrom uses the full relative path
   * again, resulting in e.g. /cache/cache/file.3mf).
   */
  private async ftpUpload(
    host: string,
    token: string,
    localPath: string,
    remotePath: string
  ): Promise<void> {
    const client = new FTPClient(15_000);
    try {
      await client.access(this.ftpsOptions(host, token));
      // Use absolute path to avoid CWD side-effects
      const absoluteRemote = remotePath.startsWith("/") ? remotePath : `/${remotePath}`;
      const remoteDir = path.posix.dirname(absoluteRemote);
      await client.ensureDir(remoteDir);
      // uploadFrom with just the basename since we're already in the right dir
      await client.uploadFrom(localPath, path.posix.basename(absoluteRemote));
    } finally {
      client.close();
    }
  }

  private extractBambuCredentials(apiKey: string): [string, string] {
    const separatorIndex = apiKey.indexOf(":");

    if (separatorIndex <= 0 || separatorIndex === apiKey.length - 1) {
      throw new Error("Invalid Bambu credentials format. Expected 'serial:token'.");
    }

    const serial = apiKey.slice(0, separatorIndex).trim();
    const token = apiKey.slice(separatorIndex + 1).trim();

    if (!serial || !token) {
      throw new Error("Invalid Bambu credentials format. Expected 'serial:token'.");
    }

    return [serial, token];
  }

  async disconnectAll(): Promise<void> {
    await this.printerStore.disconnectAll();
  }
}
