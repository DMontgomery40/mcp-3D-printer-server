import { PrinterRefusal } from "../refusal.js";
import { PrinterImplementation } from "../types.js";
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client as FTPClient } from "basic-ftp";
import { BambuClient, PushAllCommand } from "bambu-node";
import { MAX_PRINT_FILE_BYTES, readSafe3mfArchive } from "../safety/archive.js";
import { inspectPrintFile, type PrintFileInspection } from "../safety/print-file.js";
import { isDualNozzleModel, normalizeModel, validateTemperature } from "../safety/limits.js";
import { describeAmsTrayRange, externalTrayForNozzle } from "../ams-mapping.js";
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
import { installBambuNodeRejectionGuard } from "./bambu-node-guard.js";
import { requireHumanConfirmation, type ConfirmHardware } from "../safety/confirmation.js";
import { assertExpectedPeaks, validateExpectedPeaks, type ExpectedPeakTemperatures, type PrintSafetyOptions } from "../safety/expected-peaks.js";
import { controlReply, refusedControlMessage, type ControlReply } from "../control-reply.js";

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
  /** One absolute tray per used filament in plate order; expanded to the project-level mapping. */
  amsSlots?: number[];
  md5?: string;
  expectedPeaks?: ExpectedPeakTemperatures;
}

export type BambuSafetyOptions = PrintSafetyOptions;

interface ProjectFileMetadata {
  plateFileName: string;
  plateInternalPath: string;
  md5: string;
  /** Project filament count from the plate G-code header (filament_colour, else filament_ids). */
  projectFilamentCount: number;
  /** 0-based project filament positions the plate uses, from Metadata/plate_<n>.json filament_ids. */
  usedFilamentPositions: number[];
}

const COMMAND_SETTLE_MS = 300;

/**
 * Pause, Resume or Stop exactly as Bambu Studio sends them (MachineObject::command_task_*), with this server's own
 * 32-bit sequence id, so the printer's answer to this one control can be told apart from any other report.
 */
function studioControl(command: "stop" | "pause" | "resume") {
  const sequenceId = String(20_000 + (Date.now() % 1_000_000));
  return { command, sequenceId, send: (printer: Pick<BambuClient, "publish">) => printer.publish({ print: { command, param: "", sequence_id: sequenceId } }) };
}

/** How long a control on the direct local network waits for the printer's answer (BAMBU_CONTROL_REPLY_MS, 0-30000). */
function controlReplyMs(): number {
  const configured = Number(process.env.BAMBU_CONTROL_REPLY_MS);
  return Number.isFinite(configured) && configured >= 0 ? Math.min(configured, 30_000) : 5_000;
}

/**
 * The printer's answer to one control on its report topic (bambu-node re-emits every message as rawMessage).
 * Started before the publish so a fast answer is not missed; undefined when none arrives in time.
 */
function watchControlReply(printer: unknown, command: string, sequenceId: string, ms: number): Promise<ControlReply | undefined> {
  const emitter = printer as any;
  if (ms <= 0 || typeof emitter?.on !== "function" || typeof emitter?.off !== "function") return Promise.resolve(undefined);
  return new Promise(resolve => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onMessage = (_topic: string, payload: Buffer | string) => {
      const reply = controlReply(String(payload), command, sequenceId);
      if (reply) finish(reply);
    };
    const finish = (reply: ControlReply | undefined) => { clearTimeout(timer); emitter.off("rawMessage", onMessage); resolve(reply); };
    timer = setTimeout(() => finish(undefined), ms);
    emitter.on("rawMessage", onMessage);
  });
}

/** Send one direct control and judge it by the printer's answer; a printer not in Developer Mode refuses unsigned ones. */
async function sendDirectControl(printer: BambuClient, command: "stop" | "pause" | "resume"): Promise<ControlReply | undefined> {
  const control = studioControl(command);
  const answered = watchControlReply(printer, command, control.sequenceId, controlReplyMs());
  await control.send(printer);
  const reply = await answered;
  if (reply && !reply.accepted) throw new Error(refusedControlMessage(command, "the local network", reply.errCode, true));
  return reply;
}
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

class BambuClientStore {
  /** Sees every merged report, so a resume record notices a job ending even when nobody polls. */
  constructor(private readonly onReport?: (host: string, serial: string, report: Record<string, any>) => void) {}

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

    printer.on("printer:dataUpdate", (data: Record<string, any>) => {
      if (!data || !this.onReport) return;
      try { this.onReport(host, serial, data); } catch { /* an observer never breaks report handling */ }
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
    this.initialConnectionPromises.set(key, connectPromise);

    try {
      await connectPromise;
      return printer;
    } catch (error) {
      this.initialConnectionPromises.delete(key);
      throw error;
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

/** The inspected bytes and limits of a started job, for the resume byte check and prompt. */
export type CheckedFile = {
  sha256: string;
  /** A project's printed plate: its number and the SHA-256 of its Metadata/plate_<index>.gcode. */
  plate?: { index: number; sha256: string };
  model: string;
  maxNozzleTemperature: number;
  maxBedTemperature: number;
  maxChamberTemperature: number;
  materials: string[];
};

/**
 * The last job this server inspected and started on a printer. seenRunning: a
 * report showed it preparing, printing or paused, so a later ended report, or
 * another job in its place, is about it rather than about the job before it.
 */
type CheckedJob = CheckedFile & {
  remotePath: string;
  requirements: PrinterStateRequirements;
  seenRunning: boolean;
  /** This server uploaded the bytes to remotePath over FTPS, so a failed re-read refuses the resume. */
  uploadedHere: boolean;
};

/** A route's own dispatch for a print control (FULU's BambuNetwork); undefined sends over LAN MQTT. */
export type ControlDispatch = () => Promise<any>;
export type ResumeDispatch = (assertActive: () => void, beforeDispatch: () => Promise<void>) => Promise<any>;

/**
 * Where each printer's resume record is kept so a restart of this server (a deploy, a crash, a reboot) during a
 * pause can still resume the job it started: BAMBU_RESUME_STATE_DIR, else mcp-3d-printer-server/resume in the
 * config home (bambu-printer-mcp keeps its own). Resume runs every check on a reloaded record: a fresh paused
 * report naming this exact job, the re-read bytes or its unique name, and a person for an unverified file.
 */
export function defaultResumeStateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.BAMBU_RESUME_STATE_DIR) return env.BAMBU_RESUME_STATE_DIR;
  const configHome = env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), ".config");
  return path.join(configHome, "mcp-3d-printer-server", "resume");
}

function isCheckedJob(value: any): value is CheckedJob {
  return Boolean(value) && typeof value === "object" && /^[a-f0-9]{64}$/.test(value.sha256 ?? "") &&
    typeof value.remotePath === "string" && value.remotePath !== "" && typeof value.model === "string" &&
    Boolean(value.requirements) && typeof value.requirements === "object" && Array.isArray(value.materials) &&
    typeof value.seenRunning === "boolean" && typeof value.uploadedHere === "boolean" &&
    [value.maxNozzleTemperature, value.maxBedTemperature, value.maxChamberTemperature].every(Number.isFinite);
}

/**
 * The resume record of each printer (keyed host and serial). With a folder, every change is written to that
 * printer's own file (private, replaced atomically) and the file is read the first time the printer is asked
 * about, so a new server process knows the job the previous one started. Without one it lives in memory only.
 */
class ResumeRecords {
  private readonly jobs = new Map<string, CheckedJob>();
  private readonly read = new Set<string>();
  constructor(private readonly dir?: string) {}

  get(key: string): CheckedJob | undefined {
    if (!this.read.has(key)) {
      this.read.add(key);
      const saved = this.dir ? this.readFile(key) : undefined;
      if (saved) this.jobs.set(key, saved);
    }
    return this.jobs.get(key);
  }

  set(key: string, job: CheckedJob): void {
    this.read.add(key);
    this.jobs.set(key, job);
    this.save(key);
  }

  delete(key: string): boolean {
    this.read.add(key);
    const had = this.jobs.delete(key);
    this.save(key);
    return had;
  }

  /** Write this printer's record as it is now (or remove its file). A failed write never stops a print or a control. */
  save(key: string): void {
    if (!this.dir) return;
    const file = this.file(key);
    const job = this.jobs.get(key);
    try {
      if (!job) { rmSync(file, { force: true }); return; }
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify({ version: 1, key, job }), { mode: 0o600 });
      renameSync(temporary, file);
    } catch (error) {
      console.error(`Could not save the resume record for ${key.replace("\n", " ")}: ${(error as Error).message}. Resume still works until this server restarts.`);
    }
  }

  private file(key: string): string {
    return path.join(this.dir!, `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.json`);
  }

  private readFile(key: string): CheckedJob | undefined {
    try {
      const saved = JSON.parse(readFileSync(this.file(key), "utf8"));
      return saved?.version === 1 && saved.key === key && isCheckedJob(saved.job) ? saved.job : undefined;
    } catch { return undefined; }
  }
}

const ACTIVE_JOB_STATES = new Set(["PREPARE", "SLICING", "RUNNING", "PAUSE"]);
/** Reports after which a started job can no longer be resumed. */
const ENDED_JOB_STATES = new Set(["FINISH", "FAILED", "IDLE"]);

const jobStem = (value: string) => path.posix.basename(value.replace(/\\/g, "/")).replace(/(?:\.gcode)?\.3mf$|\.gcode$/i, "");
const reportedJobNames = (raw: Record<string, any>): string[] =>
  [raw.gcode_file, raw.subtask_name].filter((value): value is string => typeof value === "string" && value.trim() !== "");
/** Whether a report names the job stored at remotePath (subtask_name for projects, gcode_file for raw G-code). */
function reportsJob(raw: Record<string, any>, remotePath: string): boolean {
  return reportedJobNames(raw).some((value) => jobStem(value) === jobStem(remotePath));
}

/** What a resume needs to know about a started file (filePath, the inspected snapshot). */
export async function checkedFile(inspection: PrintFileInspection, filePath: string): Promise<CheckedFile> {
  const used = inspection.usedFilamentPositions.map((position) => inspection.materials[position]).filter(Boolean);
  let plate: CheckedFile["plate"];
  const plateNumber = /^Metadata\/plate_(\d+)\.gcode$/i.exec(inspection.plateInternalPath ?? "");
  if (plateNumber && /\.3mf$/i.test(filePath)) {
    const entry = (await readSafe3mfArchive(filePath)).zip.file(inspection.plateInternalPath!);
    if (entry) plate = { index: Number(plateNumber[1]), sha256: createHash("sha256").update(await entry.async("nodebuffer")).digest("hex") };
  }
  return {
    sha256: inspection.sha256, ...(plate ? { plate } : {}), model: inspection.model,
    maxNozzleTemperature: inspection.maxNozzleTemperature, maxBedTemperature: inspection.maxBedTemperature,
    maxChamberTemperature: inspection.maxChamberTemperature,
    materials: [...new Set(used.length ? used : inspection.materials)],
  };
}

/**
 * Where a printer keeps the plate G-code it extracted from a project to print
 * it: a P1S removes the uploaded 3MF once it starts and keeps
 * cache/<name>_plate_<n>.gcode, byte-identical to the 3MF's plate G-code.
 */
function extractedPlatePath(remotePath: string, index: number): string {
  const directory = path.posix.dirname(remotePath);
  const stem = path.posix.basename(remotePath).replace(/(?:\.gcode)?\.3mf$/i, "");
  return `${directory === "." ? "" : `${directory}/`}${stem}_plate_${index}.gcode`;
}

/** The job name the printer reports: subtask_name, else the G-code file's basename. */
function reportedJobName(raw: Record<string, any>): string | undefined {
  const subtask = typeof raw.subtask_name === "string" ? raw.subtask_name.trim() : "";
  if (subtask) return subtask;
  return typeof raw.gcode_file === "string" ? path.posix.basename(raw.gcode_file.replace(/\\/g, "/").replace(/^\d+:/, "")) || undefined : undefined;
}

export class BambuImplementation extends PrinterImplementation {
  private printerStore: BambuClientStore;
  /**
   * The job each printer may resume, keyed host and serial. Cancel, a report
   * that it ended after it was seen running, or another job seen in its place
   * retires it, so a later job that reuses the name is never resumed.
   */
  private readonly checkedJobs: ResumeRecords;

  /** confirm: a person (MCP elicitation), asked only to resume a job whose file could not be re-read. */
  constructor(apiClient: any, private readonly confirm?: ConfirmHardware, options: { resumeStateDir?: string } = {}) {
    super(apiClient);
    this.checkedJobs = new ResumeRecords(options.resumeStateDir);
    this.printerStore = new BambuClientStore((host, serial, report) => this.observeReport(host, serial, report));
  }

  /**
   * Internal handoff from a successful inspected transport; never an MCP tool.
   * uploadedHere is false for FULU's BambuNetwork routes, where Bambu's plug-in
   * put the file on the printer at a path this server has not verified: a
   * resume then re-reads it if it can and otherwise asks a person.
   */
  recordCheckedJob(host: string, serial: string, remotePath: string, requirements: PrinterStateRequirements, file: CheckedFile, uploadedHere = true): void {
    if (!/^[a-f0-9]{64}$/.test(file?.sha256 ?? "")) throw new Error("A started job needs the SHA-256 of its inspected bytes.");
    this.checkedJobs.set(`${host}\n${serial}`, {
      ...structuredClone(file), remotePath, requirements: structuredClone(requirements), seenRunning: false, uploadedHere,
    });
  }

  /** Retire a record that never started (the dispatch was refused or failed). */
  forgetCheckedJob(host: string, serial: string, remotePath: string): void {
    const key = `${host}\n${serial}`;
    if (this.checkedJobs.get(key)?.remotePath === remotePath) this.checkedJobs.delete(key);
  }

  /** Feed one merged report to the resume record (the client store calls it for every report). */
  observeReport(host: string, serial: string, raw: Record<string, any> | undefined): void {
    const key = `${host}\n${serial}`;
    const checked = this.checkedJobs.get(key);
    if (!checked || !raw || typeof raw.gcode_state !== "string") return;
    const state = raw.gcode_state.toUpperCase();
    if (ACTIVE_JOB_STATES.has(state) && reportsJob(raw, checked.remotePath)) {
      if (!checked.seenRunning) { checked.seenRunning = true; this.checkedJobs.save(key); }
      return;
    }
    if (checked.seenRunning && (ENDED_JOB_STATES.has(state) || (ACTIVE_JOB_STATES.has(state) && reportedJobNames(raw).length > 0))) {
      this.checkedJobs.delete(key);
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
    // The slicer's project filament list length, from the G-code header
    // (`; filament_colour = #FFFFFF;#FF911A80;...`), scanning only its first 32 KB.
    let projectFilamentCount = 1;
    const head = gcodeBuffer.subarray(0, 32 * 1024).toString("utf8");
    const colourLine = head.match(/;\s*filament_colour\s*=\s*([^\n\r]+)/i);
    if (colourLine) {
      projectFilamentCount = colourLine[1].split(";").filter((entry) => entry.trim()).length;
    } else {
      const idsLine = head.match(/;\s*filament_ids\s*=\s*([^\n\r]+)/i);
      if (idsLine) projectFilamentCount = idsLine[1].split(";").filter((entry) => entry.trim()).length;
    }
    // The positions the selected plate consumes, from Metadata/plate_<n>.json filament_ids.
    let usedFilamentPositions: number[] = [];
    const plateJsonEntry = zip.file(selectedEntry.name.replace(/\.gcode$/i, ".json"));
    if (plateJsonEntry) {
      try {
        const json = JSON.parse(await plateJsonEntry.async("string"));
        if (Array.isArray(json.filament_ids)) {
          usedFilamentPositions = json.filament_ids.filter((n: unknown) => Number.isInteger(n));
        }
      } catch {
        // A malformed plate_N.json leaves ams_mapping as the way to map trays.
      }
    }
    if (usedFilamentPositions.length === 0) usedFilamentPositions = [0];
    return {
      plateFileName: path.posix.basename(selectedEntry.name),
      plateInternalPath: selectedEntry.name,
      md5: createHash("md5").update(gcodeBuffer).digest("hex"),
      projectFilamentCount,
      usedFilamentPositions,
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

      // The first push after connecting can be a sparse hello (model and
      // modules); the full status follows. Returning before it merges reported
      // status UNKNOWN, so wait for gcode_state within the same 1.5 s bound.
      const deadline = Date.now() + 1500;
      while (typeof printer.data?.gcode_state !== "string" && Date.now() < deadline) {
        await sleep(50);
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

    const { baseMapping, amsMapping, useAMS } = this.checkedAmsMapping(model, options, inspection, projectMetadata);
    const checkedMapping = baseMapping;

    const requirements: PrinterStateRequirements = { ...inspection, amsMapping: checkedMapping, useAMS };
    const resumeFile = await checkedFile(inspection, options.filePath);
    const initialStatus = await this.getSafetyStatus(host, serial, token);
    validatePrinterState(initialStatus, requirements);
    // Recheck before the upload: the printer may have changed meanwhile.
    const recheckedStatus = await this.getSafetyStatus(host, serial, token);
    validatePrinterState(recheckedStatus, requirements);
    assertActive();

    const remoteFileName = uniquePrintName(options.filePath);
    const remoteProjectPath = `cache/${remoteFileName}`;
    await this.ftpUpload(host, token, options.filePath, `/${remoteProjectPath}`);
    // Uploads can be long. Recheck current state before the command is dispatched.
    const dispatchStatus = await this.getSafetyStatus(host, serial, token);
    validatePrinterState(dispatchStatus, requirements);
    const printer = await this.getPrinter(host, serial, token);
    assertActive();

    const subtaskName = remoteFileName.replace(/\.3mf$/i, "");
    const projectFileCmd = {
      print: {
        command: "project_file",
        param: projectMetadata.plateInternalPath,
        url: `file:///sdcard/${remoteProjectPath}`,
        // The printer reports this back as subtask_name, which identifies the checked job for resume.
        subtask_name: subtaskName,
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
    this.recordCheckedJob(host, serial, remoteProjectPath, requirements, resumeFile);
    await sleep(COMMAND_SETTLE_MS);
    const dispatch = await this.settleRecorded(watcher, host, serial, remoteProjectPath);

    return {
      status: "success",
      dispatch,
      message: dispatch === "started"
        ? `The printer accepted and started the checked 3MF print: ${options.projectName}`
        : `Uploaded the checked 3MF and sent the print command for ${options.projectName}; the printer has not reported starting yet. ` +
          "Check get_printer_status before assuming it is printing.",
      remoteProjectPath,
      subtaskName,
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
   * The project-level tray mapping for a checked print, built as
   * bambu-printer-mcp builds it: position = project filament, value = absolute
   * tray (0-15 AMS, 128+ AMS-HT, 254 external; 255 the right/main external
   * spool on dual-nozzle printers, -1 unused). ams_mapping is taken as given;
   * ams_slots supplies one tray per used filament and is expanded against the
   * plate's filament_ids; use_ams:false maps every used filament to the
   * external spool of its nozzle. Every used position must end up mapped.
   * The wire form pads to the historical five entries.
   */
  private checkedAmsMapping(
    model: string,
    options: BambuPrintOptionsInternal,
    inspection: PrintFileInspection,
    projectMetadata: ProjectFileMetadata
  ): { baseMapping: number[]; amsMapping: number[]; useAMS: boolean } {
    const dualNozzle = isDualNozzleModel(model);
    const externalTrays = dualNozzle ? [254, 255] : [254];
    const useAMS = options.useAMS !== false;
    const validate = (value: unknown, label: string): void => {
      if (!Number.isInteger(value) || (value as number) < -1 ||
          ((value as number) > 15 && (value as number) < 128) || (value as number) > (dualNozzle ? 255 : 254)) {
        throw new Error(`${label} values must be integers in ${describeAmsTrayRange({ dualNozzle })}; got ${String(value)}`);
      }
    };
    let baseMapping: number[];
    if (options.amsMapping && options.amsMapping.length > 0) {
      for (const value of options.amsMapping) validate(value, "ams_mapping");
      baseMapping = options.amsMapping.slice();
    } else if (options.amsSlots && options.amsSlots.length > 0) {
      for (const value of options.amsSlots) validate(value, "ams_slots");
      const positions = projectMetadata.usedFilamentPositions;
      if (options.amsSlots.length !== positions.length) {
        throw new Error(
          `ams_slots length ${options.amsSlots.length} does not match used filament count ${positions.length} ` +
          `(plate uses positions ${JSON.stringify(positions)}). Provide one tray per used filament, or use ams_mapping for a raw project-level array.`
        );
      }
      baseMapping = Array<number>(Math.max(projectMetadata.projectFilamentCount, ...positions.map((p) => p + 1))).fill(-1);
      positions.forEach((position, index) => { baseMapping[position] = options.amsSlots![index]; });
    } else {
      if (useAMS) {
        throw new Error(
          "AMS printing requires ams_slots or ams_mapping for this sliced file. " +
          `Plate uses project filament positions ${JSON.stringify(inspection.usedFilamentPositions)}; pass one tray per used filament (for example ams_slots: [0]), or use_ams:false for the external spool.`
        );
      }
      const positions = inspection.usedFilamentPositions;
      baseMapping = Array<number>(Math.max(inspection.materials.length, projectMetadata.projectFilamentCount, ...positions.map((p) => p + 1), 1)).fill(-1);
      for (const position of positions) {
        baseMapping[position] = externalTrayForNozzle(inspection.filamentNozzleIndices?.[position], dualNozzle);
      }
    }
    for (const position of inspection.usedFilamentPositions) {
      if (baseMapping[position] === undefined || baseMapping[position] < 0) {
        throw new Error(
          `Missing physical filament mapping for project filament ${position}. ` +
          "Pass ams_slots (one tray per used filament) or ams_mapping with a tray for every used project filament, or use_ams:false for the external spool."
        );
      }
      if (!useAMS && !externalTrays.includes(baseMapping[position])) {
        throw new Error(`External-spool printing requires external spool mapping (${externalTrays.join(" or ")}).`);
      }
    }
    const amsMapping = Array.from(
      { length: Math.max(5, baseMapping.length, projectMetadata.projectFilamentCount) },
      (_, index) => (index < baseMapping.length ? baseMapping[index] : -1)
    );
    return { baseMapping, amsMapping, useAMS };
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
        if (verdict === "rejected") throw new PrinterRefusal("printer-command-rejected", COMMAND_REJECTED_MESSAGE);
        stillActive();
        return verdict ?? "unconfirmed";
      },
    };
  }

  /** A refused or unconfirmed-then-failed dispatch leaves no job to resume. */
  private async settleRecorded(watcher: { settled: () => Promise<"started" | "unconfirmed"> }, host: string, serial: string, remotePath: string) {
    try {
      return await watcher.settled();
    } catch (error) {
      this.forgetCheckedJob(host, serial, remotePath);
      throw error;
    }
  }

  /**
   * Stop is never gated or queued behind pending checked operations, and it
   * retires the resume record. dispatch sends it over the route that printed
   * (FULU's BambuNetwork); without one it goes over LAN MQTT.
   */
  async cancelJob(host: string, port: string, apiKey: string, dispatch?: ControlDispatch): Promise<any> {
    const [serial, token] = this.extractBambuCredentials(apiKey);
    cancelPendingPrinterOperations(host, serial);
    this.checkedJobs.delete(`${host}\n${serial}`);
    try {
      if (dispatch) return await dispatch();
      const printer = await this.getPrinter(host, serial, token);
      const reply = await sendDirectControl(printer, "stop");
      return { status: "success", confirmed: Boolean(reply), message: reply ? "The printer accepted Stop." : "Cancel command sent successfully." };
    } catch (error) {
      throw new Error(`Failed to cancel print: ${(error as Error).message}`);
    }
  }

  /** Pause is never gated. */
  async pauseJob(host: string, port: string, apiKey: string, dispatch?: ControlDispatch): Promise<{ status: string; action: "pause"; message: string; [key: string]: unknown }> {
    const [serial, token] = this.extractBambuCredentials(apiKey);
    try {
      if (dispatch) {
        const result = await dispatch();
        return { status: "success", message: "Pause command sent successfully.", ...result, action: "pause" };
      }
      const printer = await this.getPrinter(host, serial, token);
      const reply = await sendDirectControl(printer, "pause");
      if (!reply) await sleep(COMMAND_SETTLE_MS);
      return { status: "success", action: "pause", confirmed: Boolean(reply), message: reply ? "The printer accepted Pause." : "Pause command sent successfully." };
    } catch (error) {
      throw new Error(`Failed to pause print: ${(error as Error).message}`);
    }
  }

  /**
   * Resume reheats and moves the printer, so it is gated like a print start:
   * only the job this server inspected and started, while a fresh report shows
   * it paused, with its bytes re-read over FTPS and compared. Only a file that
   * could not be re-read, and that this server did not upload itself, asks a
   * person. The record must still be current at every check.
   */
  async resumeJob(host: string, port: string, apiKey: string, dispatch?: ResumeDispatch): Promise<{ status: string; action: "resume"; message: string; jobName: string; bytesVerified: boolean; [key: string]: unknown }> {
    const [serial, token] = this.extractBambuCredentials(apiKey);
    return withPrinterOperation(host, serial, async (assertActive) => {
      const key = `${host}\n${serial}`;
      const checked = this.checkedJobs.get(key);
      if (!checked) throw new Error("Resume requires a job inspected and started by this server instance. Verify other jobs on the printer before resuming them there.");
      let jobName = path.posix.basename(checked.remotePath);
      const pausedJob = async () => {
        assertActive();
        const status = await this.getSafetyStatus(host, serial, token);
        this.observeReport(host, serial, status.raw);
        if (this.checkedJobs.get(key) !== checked) {
          throw new Error(`${jobName} is no longer the job this server started: it was cancelled, it ended, or another job took its place. Nothing was sent; check the printer and resume it there.`);
        }
        validatePrinterState(status, { ...checked.requirements, requireIdle: false });
        if (status.raw.gcode_state !== "PAUSE") throw new Error("Resume requires a freshly reported paused job.");
        if (!reportsJob(status.raw, checked.remotePath)) throw new Error("Paused job identity does not match this server's inspected artifact.");
        jobName = reportedJobName(status.raw) ?? jobName;
        assertActive();
      };
      await pausedJob();
      const reread = await this.rereadJob(host, token, checked);
      if ("changed" in reread) {
        if (this.checkedJobs.get(key) === checked) this.checkedJobs.delete(key);
        throw new Error(`${jobName} on the printer is no longer the file this server inspected (SHA-256 of ${reread.changed} changed). Nothing was sent, and this job can no longer be resumed from here.`);
      }
      const unread = "unread" in reread ? reread.unread : undefined;
      if (unread !== undefined && checked.uploadedHere) {
        throw new Error(`Could not re-read ${jobName} from the printer over FTPS to confirm it is the inspected file (${unread}). Nothing was sent; resume it at the printer.`);
      }
      const bytesVerified = "verified" in reread;
      assertActive();
      if (!bytesVerified) {
        // Bambu's plug-in placed this file and it cannot be handed back, so only a person can tell it is still the inspected job.
        await requireHumanConfirmation(
          this.confirm,
          `Resume ${jobName} on ${checked.model.toUpperCase()} (${serial})? Bambu's plug-in placed the file and it could not be re-read over FTPS (${unread}), so it is matched by its unique name only. ` +
          `It reheats to its targets (peak nozzle ${checked.maxNozzleTemperature}°C, bed ${checked.maxBedTemperature}°C, chamber ${checked.maxChamberTemperature}°C) and moves. ` +
          `Materials: ${checked.materials.length ? checked.materials.join(", ") : "none declared"}. Inspected file SHA-256: ${checked.sha256}. ` +
          "Confirm the nozzle path is clear and the filament is still loaded."
        );
      }
      // The job may have been resumed, stopped or replaced at the printer during the re-read or the prompt.
      await pausedJob();
      if (dispatch) {
        const result = await dispatch(assertActive, pausedJob);
        return { status: "success", message: `Resume command sent for ${jobName}.`, ...result, action: "resume", jobName, bytesVerified };
      }
      const printer = await this.getPrinter(host, serial, token);
      assertActive();
      const reply = await sendDirectControl(printer, "resume");
      if (!reply) await sleep(COMMAND_SETTLE_MS);
      return { status: "success", action: "resume", confirmed: Boolean(reply), message: reply ? `The printer accepted Resume for ${jobName}.` : `Resume command sent for ${jobName}.`, jobName, bytesVerified };
    });
  }

  /**
   * Re-read a started job's bytes over FTPS: the uploaded file, else the plate
   * G-code the printer extracted from the project to print it. The first file
   * that can be read decides; a mismatch is reported as changed.
   */
  private async rereadJob(host: string, token: string, checked: CheckedJob): Promise<{ verified: string } | { changed: string } | { unread: string }> {
    const candidates = [{ remote: checked.remotePath, sha256: checked.sha256 }];
    if (checked.plate) candidates.push({ remote: extractedPlatePath(checked.remotePath, checked.plate.index), sha256: checked.plate.sha256 });
    const failures: string[] = [];
    for (const candidate of candidates) {
      let sha256: string;
      try { sha256 = await this.remoteSha256(host, token, candidate.remote); }
      catch (error) { failures.push(`${candidate.remote}: ${(error as Error).message}`); continue; }
      return sha256 === candidate.sha256 ? { verified: candidate.remote } : { changed: candidate.remote };
    }
    return { unread: failures.join("; ") };
  }

  /** SHA-256 of a printer file, streamed from an FTPS download into a private directory. */
  private async remoteSha256(host: string, token: string, remotePath: string): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bambu-resume-check-"));
    try {
      const localPath = path.join(directory, "job");
      await this.ftpDownload(host, token, remotePath.replace(/^\/+/, ""), localPath);
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(localPath)) hash.update(chunk as Buffer);
      return hash.digest("hex");
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
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
    const [, token] = this.extractBambuCredentials(apiKey);

    const normalized = filename.replace(/^\/+/, "");
    const directory = path.posix.dirname(normalized) === "." ? "cache" : path.posix.dirname(normalized);
    const baseName = path.posix.basename(normalized);

    let exists = false;

    const client = new FTPClient(15_000);
    try {
      await client.access(this.ftpsOptions(host, token));
      const entries = await client.list(`/${directory}`);
      exists = entries.some(entry => entry.name === baseName);
    } finally {
      client.close();
    }

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
    const recheckedStatus = await this.getSafetyStatus(host, serial, token);
    this.validateLoadedGcodeState(recheckedStatus, inspection);
    assertActive();
    // Start a uniquely named copy of the inspected bytes, never a name that can change.
    const remotePath = path.posix.join(path.posix.dirname(filename), uniquePrintName(filename));
    await this.ftpUpload(host, token, filePath, `/${remotePath}`);
    const dispatchStatus = await this.getSafetyStatus(host, serial, token);
    const requirements = this.validateLoadedGcodeState(dispatchStatus, inspection);
    const resumeFile = await checkedFile(inspection, filePath);
    const printer = await this.getPrinter(host, serial, token);
    assertActive();
    const watcher = this.watchDispatch(printer, host, serial, token, dispatchStatus, assertActive);
    await publishBambuCommand(printer, "print", "gcode_file", { param: remotePath });
    this.recordCheckedJob(host, serial, remotePath, requirements, resumeFile);
    const dispatch = await this.settleRecorded(watcher, host, serial, remotePath);
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
