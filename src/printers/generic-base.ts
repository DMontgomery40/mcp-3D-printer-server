import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AxiosInstance } from "axios";
import { PrinterImplementation } from "../types.js";
import { cancelPendingPrinterOperations, withPrinterOperation } from "../safety/artifact.js";
import { MAX_PRINT_FILE_BYTES } from "../safety/archive.js";
import { requireHumanConfirmation, type ConfirmHardware } from "../safety/confirmation.js";
import { assertExpectedPeaks, validateExpectedPeaks, type PrintSafetyOptions } from "../safety/expected-peaks.js";
import {
  assertInspectableGcodeName,
  finiteTemperature,
  genericCeilings,
  inspectGcodeFile,
  validateGenericTemperature,
  type GenericPrintInspection,
  type Heater,
} from "../safety/gcode-thermal.js";

/** Normalized adapter state used by the print and heating preflight. */
export interface GenericPrinterState {
  /** Adapter-reported state text. */
  state: string;
  /** Idle enough to start a job or heat: not printing, paused, busy, errored or offline. */
  ready: boolean;
  /** Why the printer is not ready. */
  reason?: string;
  /** Set when the printer explicitly reports a finished or cancelled job that may still be on the bed. */
  finishedJob?: string;
}

export interface HeaterComponent {
  heater: Heater;
  /** Component name passed to the adapter's raw transport. */
  raw: string;
}

/** Download timeout for remote-start inspection; the shared client times out at 10 s. */
export const REMOTE_DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * Shared print and heating gate for non-Bambu adapters. Public mutations
 * validate every input before connecting, inspect the exact bytes that are
 * uploaded, check fresh adapter state, ask a human (MCP elicitation), recheck
 * state and only then dispatch. Heater-off and cancel are never gated.
 */
export abstract class GenericPrinterImplementation extends PrinterImplementation {
  protected abstract readonly printerLabel: string;
  /** True when rawUploadFile(print=true) starts the uploaded bytes atomically. */
  protected readonly uploadStartsPrint: boolean = false;

  constructor(apiClient: AxiosInstance, private readonly confirm?: ConfirmHardware) {
    super(apiClient);
  }

  protected abstract rawUploadFile(host: string, port: string, apiKey: string, filePath: string, filename: string, print: boolean): Promise<any>;
  protected abstract rawStartJob(host: string, port: string, apiKey: string, filename: string): Promise<any>;
  protected abstract rawCancelJob(host: string, port: string, apiKey: string): Promise<any>;
  protected abstract rawSetTemperature(host: string, port: string, apiKey: string, component: string, temperature: number): Promise<any>;
  /** Throw when the state cannot be read; never guess. */
  protected abstract readPrinterState(host: string, port: string, apiKey: string): Promise<GenericPrinterState>;

  /**
   * Download a printer-side file for inspection. Adapters without a verified
   * download route leave this undefined and remote starts are refused.
   */
  protected downloadRemoteFile?(host: string, port: string, apiKey: string, filename: string, destination: string): Promise<void>;

  /** Adapter-specific upload acknowledgement for the upload-then-start route. */
  protected uploadSucceeded(_data: unknown): boolean {
    return true;
  }

  /** Adapter-specific acknowledgement that an atomic upload-and-print started. */
  protected uploadStartedPrint(_data: unknown): boolean {
    return true;
  }

  /** Map caller component names to a heater and the raw adapter name. */
  protected heaterComponent(component: string): HeaterComponent | undefined {
    const normalized = component.trim().toLowerCase();
    if (normalized === "bed") return { heater: "bed", raw: "bed" };
    if (["extruder", "nozzle", "tool", "tool0"].includes(normalized)) return { heater: "nozzle", raw: "extruder" };
    return undefined;
  }

  private operationKey(host: string, port: string): string {
    return `${this.printerLabel}:${host}:${port}`;
  }

  async cancelJob(host: string, port: string, apiKey: string): Promise<any> {
    cancelPendingPrinterOperations(host, this.operationKey(host, port));
    return this.rawCancelJob(host, port, apiKey);
  }

  async setTemperature(host: string, port: string, apiKey: string, component: string, temperature: unknown, options: PrintSafetyOptions = {}): Promise<any> {
    const target = this.heaterComponent(String(component));
    if (!target) throw new Error(`Unsupported component: ${component}`);
    const value = finiteTemperature(temperature);
    const key = this.operationKey(host, port);
    if (value === 0) {
      // Heater-off is never gated and cancels pending checked operations.
      cancelPendingPrinterOperations(host, key);
      return this.rawSetTemperature(host, port, apiKey, target.raw, 0);
    }
    const material = options.material?.trim();
    validateGenericTemperature(target.heater, value, material ? [material] : undefined);
    return withPrinterOperation(host, key, async (assertActive) => {
      this.assertReady(await this.readPrinterState(host, port, apiKey), "heat");
      await requireHumanConfirmation(
        this.confirm,
        `Heat ${target.heater} on ${this.printerLabel} (${host}:${port}) to ${value}°C?` +
        (material && target.heater === "nozzle" ? ` Declared material: ${material}. Confirm the loaded filament matches.` : ""),
        "generic"
      );
      assertActive();
      this.assertReady(await this.readPrinterState(host, port, apiKey), "heat");
      assertActive();
      return this.rawSetTemperature(host, port, apiKey, target.raw, value);
    });
  }

  async uploadFile(host: string, port: string, apiKey: string, filePath: string, filename: string, print: boolean, options: PrintSafetyOptions = {}): Promise<any> {
    if (!print) return this.rawUploadFile(host, port, apiKey, filePath, filename, false);
    const remoteName = this.printableRemoteName(filename);
    this.validateOffline(options);
    return withPrinterOperation(host, this.operationKey(host, port), (assertActive) =>
      this.withNamedSnapshot(filePath, remoteName, (snapshot) =>
        this.printChecked(host, port, apiKey, snapshot, remoteName, options, assertActive)
      )
    );
  }

  async startJob(host: string, port: string, apiKey: string, filename: string, options: PrintSafetyOptions = {}): Promise<any> {
    this.validateOffline(options);
    if (!this.downloadRemoteFile) {
      throw new Error(
        `Print safety: start_print cannot inspect files already stored on ${this.printerLabel}; this adapter has no verified download route. ` +
        "Uninspected remote jobs are refused. Use upload_gcode with print=true and the local G-code so the exact bytes are inspected."
      );
    }
    assertInspectableGcodeName(filename);
    const checkedName = `checked-${randomUUID()}-${path.posix.basename(filename.replace(/\\/g, "/"))}`;
    return withPrinterOperation(host, this.operationKey(host, port), async (assertActive) => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "printer-remote-check-"));
      const downloaded = path.join(directory, "download");
      try {
        await this.downloadRemoteFile!(host, port, apiKey, filename, downloaded);
        // Start a uniquely named copy of the inspected download; the original
        // remote name could change between inspection and start.
        return await this.withNamedSnapshot(downloaded, checkedName, (snapshot) =>
          this.printChecked(host, port, apiKey, snapshot, checkedName, options, assertActive)
        );
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    });
  }

  /** Download with a bounded size and its own timeout. */
  protected async downloadToFile(url: string, headers: Record<string, string>, destination: string): Promise<void> {
    const response = await this.apiClient.get(url, {
      headers,
      responseType: "arraybuffer",
      timeout: REMOTE_DOWNLOAD_TIMEOUT_MS,
      maxContentLength: MAX_PRINT_FILE_BYTES,
      maxBodyLength: MAX_PRINT_FILE_BYTES,
    });
    const bytes = Buffer.from(response.data as ArrayBuffer);
    if (!bytes.length || bytes.length > MAX_PRINT_FILE_BYTES) {
      throw new Error("Remote print file is empty or exceeds the 256 MiB inspection limit.");
    }
    await fs.writeFile(destination, bytes);
  }

  private validateOffline(options: PrintSafetyOptions): void {
    validateExpectedPeaks(options.expectedPeaks);
    genericCeilings();
  }

  /** The started name must be the uploaded name: no directories. */
  private printableRemoteName(filename: string): string {
    const name = String(filename);
    if (!name || name !== path.posix.basename(name) || name.includes("\\") || name === "." || name === ".." || /[\r\n\0]/.test(name)) {
      throw new Error("Print safety: printing after upload needs a plain filename without directories, so the started file is exactly the uploaded file.");
    }
    assertInspectableGcodeName(name);
    return name;
  }

  /** A private read-only copy named like the remote file; multipart adapters use its basename. */
  private async withNamedSnapshot<T>(source: string, name: string, operation: (snapshot: string) => Promise<T>): Promise<T> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "printer-print-"));
    const snapshot = path.join(directory, name);
    try {
      await fs.copyFile(source, snapshot);
      await fs.chmod(snapshot, 0o400);
      return await operation(snapshot);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }

  private assertReady(state: GenericPrinterState, action: "print" | "heat"): void {
    if (!state.ready) {
      throw new Error(
        `Print safety: ${this.printerLabel} reports '${state.state}'${state.reason ? ` (${state.reason})` : ""}; ` +
        `it is not safely idle, so the ${action === "print" ? "print was not started" : "heater was not changed"}.`
      );
    }
  }

  private assertBedClearance(state: GenericPrinterState, confirmedFinishedJob: string | undefined): void {
    if (state.finishedJob !== undefined && state.finishedJob !== confirmedFinishedJob) {
      throw new Error("Print safety: the printer reports a newly finished job. Confirm its part and debris were removed before retrying.");
    }
  }

  private async printChecked(
    host: string,
    port: string,
    apiKey: string,
    snapshot: string,
    remoteName: string,
    options: PrintSafetyOptions,
    assertActive: () => void
  ): Promise<any> {
    const inspection = await inspectGcodeFile(snapshot, { material: options.material });
    assertExpectedPeaks(options.expectedPeaks, { nozzle: inspection.peaks.nozzle, bed: inspection.peaks.bed });
    const initial = await this.readPrinterState(host, port, apiKey);
    this.assertReady(initial, "print");
    await requireHumanConfirmation(this.confirm, this.printPrompt(host, port, remoteName, inspection, initial), "generic", initial.finishedJob !== undefined);
    assertActive();
    const confirmed = await this.readPrinterState(host, port, apiKey);
    this.assertReady(confirmed, "print");
    this.assertBedClearance(confirmed, initial.finishedJob);
    assertActive();

    const summary = {
      status: "success",
      printRequested: true,
      remotePath: remoteName,
      sha256: inspection.sha256,
      materials: inspection.materials,
      peakTemperatures: inspection.peaks,
    };
    if (this.uploadStartsPrint) {
      const response = await this.rawUploadFile(host, port, apiKey, snapshot, remoteName, true);
      // A stop sent while the upload was in flight reached the printer before
      // this upload started the job, so stop again: the cancellation must win.
      try {
        assertActive();
      } catch {
        await this.rawCancelJob(host, port, apiKey).catch(() => undefined);
        throw new Error(`A stop request arrived while ${remoteName} was uploading; the print it started was stopped again. Check the printer before retrying.`);
      }
      if (!this.uploadStartedPrint(response)) {
        throw new Error(`${this.printerLabel} stored ${remoteName} but reports that it did not start printing it.`);
      }
      return { ...summary, response };
    }
    const upload = await this.rawUploadFile(host, port, apiKey, snapshot, remoteName, false);
    if (!this.uploadSucceeded(upload)) {
      throw new Error(`${this.printerLabel} did not confirm the upload of ${remoteName}; the print was not started.`);
    }
    // Uploads can be long. Recheck state before the start command.
    const dispatch = await this.readPrinterState(host, port, apiKey);
    this.assertReady(dispatch, "print");
    this.assertBedClearance(dispatch, initial.finishedJob);
    assertActive();
    const response = await this.rawStartJob(host, port, apiKey, remoteName);
    return { ...summary, upload, response };
  }

  private printPrompt(host: string, port: string, remoteName: string, inspection: GenericPrintInspection, state: GenericPrinterState): string {
    const materials = inspection.materials.length ? inspection.materials.join(", ") : "none declared (no positive nozzle target)";
    return (
      `Start a checked print of ${remoteName} on ${this.printerLabel} (${host}:${port})? ` +
      `Materials: ${materials} (${inspection.materialSource}). Peak targets: nozzle ${inspection.peaks.nozzle}°C, bed ${inspection.peaks.bed}°C, chamber ${inspection.peaks.chamber}°C ` +
      `(server ceilings ${inspection.ceilings.nozzle}/${inspection.ceilings.bed}/${inspection.ceilings.chamber}°C). File SHA-256: ${inspection.sha256}. ` +
      "Confirm the loaded filament matches and that the build plate is clear." +
      (state.finishedJob !== undefined ? ` The printer reports '${state.state}': remove the previous part and debris before confirming.` : "")
    );
  }
}
