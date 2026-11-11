import {geometryFromFile} from "../counterpart/print-geometry.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
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
import { markPrintCommandSent } from "../refusal.js";
import type { CounterpartProgress, FilamentSlot, PrinterIdentity } from "../counterpart/contract.js";

/** A camera snapshot URL as the firmware configures it, before resolution against the printer host. */
export interface SnapshotCandidate {
  url: string;
  source: string;
  /** True when the firmware's own settings name this URL; false for a conventional fallback. */
  configured: boolean;
}
export interface CameraCandidate extends SnapshotCandidate {
  transport: "http-mjpeg" | "http-snapshot";
  /** Snapshot belonging to this same camera, never an unrelated later candidate. */
  snapshotUrl?: string;
  unsupportedStream?: boolean;
}

/** Normalized adapter state used by the print and heating preflight. */
export interface GenericPrinterState {
  /** Adapter-reported state text. */
  state: string;
  /** Idle enough to start a job or heat: not printing, paused, busy, errored or offline. */
  ready: boolean;
  /** Why the printer is not ready. */
  reason?: string;
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
 * uploaded, check fresh adapter state, recheck it and only then dispatch.
 * Heater-off and cancel are never gated.
 */
/** seenRunning: a report showed this job printing or paused, so a later ended report is about it, not about the previous job. */
type CheckedJob = { name: string; sha256: string; peaks: GenericPrintInspection["peaks"]; materials: string[]; seenRunning: boolean };
const checkedJob = (name: string, inspection: GenericPrintInspection): CheckedJob =>
  ({ name, sha256: inspection.sha256, peaks: inspection.peaks, materials: inspection.materials, seenRunning: false });
const RUNNING_STATES = new Set<string>(["preparing", "printing", "paused"]);
/** Reports after which the checked job can no longer be resumed. */
const ENDED_STATES = new Set<string>(["idle", "finished", "cancelled", "failed"]);

export abstract class GenericPrinterImplementation extends PrinterImplementation {
  protected abstract readonly printerLabel: string;
  /** True when rawUploadFile(print=true) starts the uploaded bytes atomically. */
  protected readonly uploadStartsPrint: boolean = false;

  /**
   * The last job this server instance inspected and started, per printer.
   * Cleared by cancel and by a report that the job ended, so a later job
   * reusing the name is never resumed on this record.
   */
  private readonly checkedJobs = new Map<string, CheckedJob>();

  constructor(apiClient: AxiosInstance, private readonly confirm?: ConfirmHardware) {
    super(apiClient);
  }

  // ---- Counterpart contract (counterpart/1) ----

  /** Normalized progress for counterpart_print_progress; throws when the printer cannot be read. */
  abstract counterpartProgress(host: string, port: string, apiKey: string): Promise<CounterpartProgress>;

  /** Progress that also retires the resume record once the printer reports the job ended. */
  async observedProgress(host: string, port: string, apiKey: string): Promise<CounterpartProgress> {
    const progress = await this.counterpartProgress(host, port, apiKey);
    const key = this.operationKey(host, port);
    this.flightRecords.observe(key, {
      observation_source:'adapter-progress',adapter_problems:progress.problems,
      subtask_name:progress.job?.name, gcode_state:({printing:'RUNNING',preparing:'PREPARE',paused:'PAUSE',finished:'FINISH',failed:'FAILED',cancelled:'FAILED',idle:'IDLE'} as Record<string,string>)[progress.state],
      layer_num:progress.job?.layer,total_layer_num:progress.job?.totalLayers,mc_percent:progress.job?.progress,
      nozzle_temper:progress.temps?.nozzle?.actual,nozzle_target_temper:progress.temps?.nozzle?.target,
      bed_temper:progress.temps?.bed?.actual,bed_target_temper:progress.temps?.bed?.target
    },Date.parse(progress.observedAt));
    const checked = this.checkedJobs.get(key);
    if (checked && RUNNING_STATES.has(progress.state) && progress.job?.name === checked.name) checked.seenRunning = true;
    else if (checked?.seenRunning && (ENDED_STATES.has(progress.state) || (RUNNING_STATES.has(progress.state) && progress.job?.name !== undefined))) {
      this.checkedJobs.delete(key);
    }
    return progress;
  }

  /** Optional identity fields; failures are ignored by the caller. */
  async counterpartIdentity(_host: string, _port: string, _apiKey: string): Promise<PrinterIdentity> {
    return {};
  }

  /** Snapshot URLs from the firmware's own settings, in preference order. */
  async snapshotCandidates(_host: string, _port: string, _apiKey: string): Promise<SnapshotCandidate[]> {
    return [];
  }

  /** Existing snapshot discovery is the fallback for cameras without an MJPEG URL. */
  async cameraCandidates(host: string, port: string, apiKey: string): Promise<CameraCandidate[]> {
    return (await this.snapshotCandidates(host, port, apiKey)).map(candidate => ({...candidate, transport: "http-snapshot"}));
  }

  /** The single extruder slot; adapters with a spool manager override this. */
  async counterpartFilaments(_host: string, _port: string, _apiKey: string): Promise<FilamentSlot[]> {
    return [{ id: "ext", source: "unknown" }];
  }

  /** Whether progress reports carry layer numbers on this firmware. */
  async reportsLayers(_host: string, _port: string, _apiKey: string): Promise<boolean> {
    return false;
  }

  async supportsPauseResume(_host: string, _port: string, _apiKey: string): Promise<boolean> {
    return this.rawPauseJob !== undefined && this.rawResumeJob !== undefined;
  }

  protected rawPauseJob?(host: string, port: string, apiKey: string): Promise<unknown>;
  protected rawResumeJob?(host: string, port: string, apiKey: string): Promise<unknown>;

  /** Pause is never gated, like cancel and heater-off. */
  async pauseJob(host: string, port: string, apiKey: string): Promise<{ status: string; action: "pause"; message: string }> {
    if (!(await this.supportsPauseResume(host, port, apiKey)) || !this.rawPauseJob) {
      throw new Error(`Unsupported: ${this.printerLabel} has no verified pause route in this server.`);
    }
    await this.rawPauseJob(host, port, apiKey);
    return { status: "success", action: "pause", message: `Pause command sent to ${this.printerLabel} (${host}:${port}).` };
  }

  /**
   * Resume reheats and moves the printer, so it is gated like a print start:
   * only the job this server instance inspected and started, only while the
   * printer freshly reports that job paused, with its bytes re-read and
   * compared where the firmware can download them. Only when the bytes cannot
   * be re-read does a person confirm (MCP elicitation). A stop or heater-off
   * request in the meantime cancels it.
   */
  async resumeJob(host: string, port: string, apiKey: string): Promise<{ status: string; action: "resume"; message: string; jobName: string; bytesVerified: boolean }> {
    if (!(await this.supportsPauseResume(host, port, apiKey)) || !this.rawResumeJob) {
      throw new Error(`Unsupported: ${this.printerLabel} has no verified resume route in this server.`);
    }
    const key = this.operationKey(host, port);
    return withPrinterOperation(host, key, async (assertActive) => {
      const checked = this.checkedJobs.get(key);
      if (!checked) {
        throw new Error(
          `Print safety: resume_print only resumes a job this server instance inspected and started on ${this.printerLabel}; nothing was sent. ` +
          "Check the paused job at the printer and resume it there."
        );
      }
      await this.assertPausedJob(host, port, apiKey, checked.name);
      let bytesVerified = false;
      if (this.downloadRemoteFile) {
        const sha256 = await this.remoteSha256(host, port, apiKey, checked.name).catch(() => {
          throw new Error(`Print safety: could not re-read ${checked.name} from ${this.printerLabel} to confirm it is the inspected file; nothing was sent. Resume it at the printer.`);
        });
        if (sha256 !== checked.sha256) {
          this.checkedJobs.delete(key);
          throw new Error(`Print safety: ${checked.name} on ${this.printerLabel} is no longer the file this server inspected (SHA-256 changed); nothing was sent.`);
        }
        bytesVerified = true;
      }
      assertActive();
      if (!bytesVerified) {
        // This firmware cannot hand the file back, so only a person can tell it is still the inspected job.
        await requireHumanConfirmation(
          this.confirm,
          `Resume ${checked.name} on ${this.printerLabel} (${host}:${port})? This firmware cannot re-read the file, so it is matched by name only. ` +
          `It reheats to its targets (peak nozzle ${checked.peaks.nozzle}°C, bed ${checked.peaks.bed}°C, chamber ${checked.peaks.chamber}°C) and moves. ` +
          `Materials: ${checked.materials.length ? checked.materials.join(", ") : "none declared"}. Inspected file SHA-256: ${checked.sha256}. ` +
          "Confirm the paused job is that file, the nozzle path is clear and the filament is still loaded."
        );
        assertActive();
      }
      // Someone may have resumed or stopped it at the printer meanwhile (for example while a prompt was open).
      await this.assertPausedJob(host, port, apiKey, checked.name);
      // A progress read meanwhile may have retired this record (the job ended, and a new one
      // could now be paused under the same name); only the record that was checked may be resumed.
      if (this.checkedJobs.get(key) !== checked) {
        throw new Error(`Print safety: ${checked.name} ended on ${this.printerLabel} during the resume checks; nothing was sent.`);
      }
      assertActive();
      await this.rawResumeJob!(host, port, apiKey);
      return {
        status: "success",
        action: "resume",
        message: `Resume command sent to ${this.printerLabel} (${host}:${port}) for ${checked.name}.`,
        jobName: checked.name,
        bytesVerified,
      };
    });
  }

  private async assertPausedJob(host: string, port: string, apiKey: string, name: string): Promise<void> {
    const progress = await this.observedProgress(host, port, apiKey);
    if (progress.state === "paused" && progress.job?.stage === "Pausing") {
      // OctoPrint accepts a resume while still pausing and then drops it.
      throw new Error(`Print safety: ${this.printerLabel} is still pausing; nothing was sent. Resume once it reports paused.`);
    }
    if (progress.state !== "paused") {
      throw new Error(`Print safety: ${this.printerLabel} reports '${progress.state}', not a paused job; nothing was sent.`);
    }
    if (progress.job?.name !== name) {
      throw new Error(
        `Print safety: the paused job (${progress.job?.name ?? "unknown"}) does not match the job this server started (${name}); nothing was sent.`
      );
    }
  }

  private async remoteSha256(host: string, port: string, apiKey: string, name: string): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "printer-resume-"));
    try {
      const destination = path.join(directory, "job.gcode");
      await this.downloadRemoteFile!(host, port, apiKey, name, destination);
      return createHash("sha256").update(await fs.readFile(destination)).digest("hex");
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
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

  flightRecordKey(host: string, port: string): string {
    return this.operationKey(host,port);
  }

  private operationKey(host: string, port: string): string {
    return `${this.printerLabel}:${host}:${port}`;
  }

  async cancelJob(host: string, port: string, apiKey: string): Promise<any> {
    cancelPendingPrinterOperations(host, this.operationKey(host, port));
    // A cancelled job is never resumed, even if a later job reuses its name.
    this.checkedJobs.delete(this.operationKey(host, port));
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
    const flight={sha256:inspection.sha256,jobName:remoteName,materials:inspection.materials,expected:await geometryFromFile(snapshot)};
    const initial = await this.readPrinterState(host, port, apiKey);
    this.assertReady(initial, "print");
    assertActive();
    const rechecked = await this.readPrinterState(host, port, apiKey);
    this.assertReady(rechecked, "print");
    assertActive();

    const summary = {
      status: "success",
      printRequested: true,
      remotePath: remoteName,
      jobName: remoteName,
      sha256: inspection.sha256,
      materials: inspection.materials,
      peakTemperatures: inspection.peaks,
    };
    if (this.uploadStartsPrint) {
      this.flightRecords.begin(this.operationKey(host,port),flight);
      markPrintCommandSent();
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
      this.checkedJobs.set(this.operationKey(host, port), checkedJob(remoteName, inspection));
      this.flightRecords.accept(this.operationKey(host,port),remoteName);
      return { ...summary, response };
    }
    const upload = await this.rawUploadFile(host, port, apiKey, snapshot, remoteName, false);
    if (!this.uploadSucceeded(upload)) {
      throw new Error(`${this.printerLabel} did not confirm the upload of ${remoteName}; the print was not started.`);
    }
    // Uploads can be long. Recheck state before the start command.
    const dispatch = await this.readPrinterState(host, port, apiKey);
    this.assertReady(dispatch, "print");
    assertActive();
    this.flightRecords.begin(this.operationKey(host,port),flight);
    markPrintCommandSent();
    const response = await this.rawStartJob(host, port, apiKey, remoteName);
    this.checkedJobs.set(this.operationKey(host, port), checkedJob(remoteName, inspection));
    this.flightRecords.accept(this.operationKey(host,port),remoteName);
    return { ...summary, upload, response };
  }
}
