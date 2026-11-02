/**
 * Per-firmware mapping for counterpart_print_progress (PRD §8.4). Each function
 * is pure: it receives the firmware's own JSON and returns the shared shape.
 * Sources are cited per mapper; rows marked "simulator" were also checked
 * against a running instance (see CHANGELOG evidence notes).
 */
import {
  type CounterpartJob,
  type CounterpartProblem,
  type CounterpartProgress,
  type ProblemSeverity,
  type ProgressState,
  finiteNumber,
  heaterReading,
  layerNumber,
  nonEmptyText,
  percent,
  progressResult,
  remoteJobName,
  seconds,
} from "./contract.js";

/** States in which a known job is reported; idle/offline/busy report none. */
const JOB_STATES = new Set<ProgressState>(["preparing", "printing", "paused", "finished", "failed", "cancelled"]);

function job(state: ProgressState, details: Partial<CounterpartJob> & { name?: string }): CounterpartJob | undefined {
  if (!JOB_STATES.has(state) || !details.name) return undefined;
  return details as CounterpartJob;
}

// ---------------------------------------------------------------------------
// OctoPrint — GET /api/job and GET /api/printer
// https://docs.octoprint.org/en/master/api/job.html
// https://docs.octoprint.org/en/master/api/printer.html (409 when not operational)
// State strings: OctoPrint src/octoprint/util/comm.py getStateString.
// ---------------------------------------------------------------------------

export interface OctoPrintInputs {
  job: any;
  /** GET /api/printer body; undefined when it returned 409 (not operational). */
  printer?: any;
  /** prints.last of the selected file, read only when an Operational job has no progress. */
  lastPrint?: { success?: unknown };
}

export function octoPrintState(text: string, completion: number | undefined, hasFile: boolean, lastPrint?: { success?: unknown }): ProgressState {
  const state = text.trim().toLowerCase();
  if (state === "operational") {
    if (hasFile && completion !== undefined && completion >= 100) return "finished";
    // A cancelled job returns to Operational with null progress; OctoPrint
    // records it in the file's print history as an unsuccessful print.
    if (hasFile && completion === undefined && lastPrint?.success === false) return "cancelled";
    return "idle";
  }
  if (state === "printing" || state === "printing from sd" || state === "finishing" || state === "resuming") return "printing";
  if (state === "starting" || state === "starting print from sd") return "preparing";
  if (state === "pausing" || state === "paused") return "paused";
  if (state === "cancelling") return "cancelled";
  if (state === "error") return "failed";
  if (state === "offline after error") return hasFile ? "failed" : "offline";
  if (state === "offline" || state === "") return "offline";
  // Opening/detecting serial connection, connecting, SD-card transfers and
  // unknown states: the printer is not idle, but no print of ours is running.
  return "busy";
}

/** Transitional printer states, reported as job.stage; resume waits for a settled pause. */
const OCTOPRINT_STAGES: Record<string, string> = {
  starting: "Starting", "starting print from sd": "Starting", pausing: "Pausing", resuming: "Resuming", cancelling: "Cancelling", finishing: "Finishing",
};

export function mapOctoPrint(inputs: OctoPrintInputs, observedAt: string): CounterpartProgress {
  const data = inputs.job ?? {};
  const file = data.job?.file ?? {};
  const name = remoteJobName(file.name ?? file.path);
  const completion = percent(data.progress?.completion);
  const state = octoPrintState(String(data.state ?? ""), completion, name !== undefined, inputs.lastPrint);
  const problems: CounterpartProblem[] = [];
  const error = nonEmptyText(data.error) ?? nonEmptyText(inputs.printer?.state?.error);
  if (error) problems.push({ code: "octoprint.error", severity: state === "failed" ? "error" : "warning", message: error });
  const temperature = inputs.printer?.temperature;
  return progressResult(observedAt, state, {
    job: job(state, {
      name,
      progress: state === "finished" ? 100 : completion,
      elapsedSec: seconds(data.progress?.printTime),
      remainingSec: state === "finished" ? 0 : seconds(data.progress?.printTimeLeft),
      stage: OCTOPRINT_STAGES[String(data.state ?? "").trim().toLowerCase()],
    }),
    temps: temperature ? {
      nozzle: heaterReading(temperature.tool0?.actual, temperature.tool0?.target),
      bed: heaterReading(temperature.bed?.actual, temperature.bed?.target),
      chamber: finiteNumber(temperature.chamber?.actual),
    } : undefined,
    problems,
  });
}

// ---------------------------------------------------------------------------
// Klipper via Moonraker — GET /printer/objects/query?print_stats&virtual_sdcard&
// display_status&extruder&heater_bed&webhooks, plus file metadata estimated_time.
// https://moonraker.readthedocs.io/en/latest/external_api/printer/
// https://www.klipper3d.org/Status_Reference.html (print_stats, display_status,
// virtual_sdcard, webhooks, heaters); state values: klippy/extras/print_stats.py.
// ---------------------------------------------------------------------------

const KLIPPER_STATES: Record<string, ProgressState> = {
  standby: "idle",
  printing: "printing",
  paused: "paused",
  complete: "finished",
  cancelled: "cancelled",
  error: "failed",
};

export function mapMoonraker(status: any, estimatedTime: number | undefined, observedAt: string): CounterpartProgress {
  const stats = status?.print_stats ?? {};
  const webhooks = status?.webhooks ?? {};
  const klippy = typeof webhooks.state === "string" ? webhooks.state : undefined;
  let state: ProgressState = KLIPPER_STATES[String(stats.state)] ?? "busy";
  if (klippy !== undefined && klippy !== "ready") state = "busy";
  const problems: CounterpartProblem[] = [];
  const message = nonEmptyText(stats.message);
  if (message) {
    problems.push({ code: "klipper.print_stats", severity: state === "failed" ? "error" : state === "paused" ? "warning" : "info", message });
  }
  if (klippy !== undefined && klippy !== "ready") {
    const severity: ProblemSeverity = klippy === "shutdown" ? "fatal" : klippy === "error" ? "error" : "info";
    problems.push({ code: `klipper.${klippy}`, severity, message: nonEmptyText(webhooks.state_message) ?? `Klipper is ${klippy}` });
  }
  const displayProgress = finiteNumber(status?.display_status?.progress);
  const sdProgress = finiteNumber(status?.virtual_sdcard?.progress);
  const fraction = displayProgress ?? sdProgress;
  const elapsed = finiteNumber(stats.print_duration);
  const remaining = estimatedTime !== undefined && elapsed !== undefined ? Math.max(0, estimatedTime - elapsed) : undefined;
  const info = stats.info ?? {};
  return progressResult(observedAt, state, {
    job: job(state, {
      name: remoteJobName(stats.filename),
      progress: state === "finished" ? 100 : fraction !== undefined ? percent(fraction * 100) : undefined,
      elapsedSec: seconds(elapsed),
      remainingSec: state === "finished" ? 0 : seconds(remaining),
      layer: layerNumber(info.current_layer),
      totalLayers: layerNumber(info.total_layer),
    }),
    temps: {
      nozzle: heaterReading(status?.extruder?.temperature, status?.extruder?.target),
      bed: heaterReading(status?.heater_bed?.temperature, status?.heater_bed?.target),
    },
    problems,
  });
}

// ---------------------------------------------------------------------------
// PrusaLink — GET /api/v1/status and GET /api/v1/job
// https://github.com/prusa3d/Prusa-Link-Web/blob/master/spec/openapi.yaml
// (StatusPrinter.state enum; StatusJob progress in percent, times in seconds;
// Job.file.display_name is the long file name, file.name the 8.3 short name).
// ---------------------------------------------------------------------------

const PRUSALINK_STATES: Record<string, ProgressState> = {
  PRINTING: "printing",
  PAUSED: "paused",
  FINISHED: "finished",
  STOPPED: "cancelled",
  ERROR: "failed",
  ATTENTION: "paused",
  IDLE: "idle",
  READY: "idle",
  BUSY: "busy",
};

export function mapPrusaLink(status: any, jobDetails: any | undefined, observedAt: string): CounterpartProgress {
  const printer = status?.printer ?? {};
  const raw = String(printer.state ?? "").toUpperCase();
  const state = PRUSALINK_STATES[raw] ?? "busy";
  const statusJob = status?.job ?? {};
  const file = jobDetails?.file ?? {};
  const problems: CounterpartProblem[] = [];
  if (raw === "ATTENTION") {
    problems.push({ code: "prusalink.attention", severity: "warning", message: "The printer needs attention; check its screen before resuming." });
  } else if (raw === "ERROR") {
    problems.push({ code: "prusalink.error", severity: "error", message: "The printer reports an error; check its screen." });
  }
  const id = finiteNumber(statusJob.id ?? jobDetails?.id);
  return progressResult(observedAt, state, {
    job: job(state, {
      name: remoteJobName(file.display_name) ?? remoteJobName(file.name),
      id: id !== undefined ? String(id) : undefined,
      progress: state === "finished" ? 100 : percent(statusJob.progress ?? jobDetails?.progress),
      elapsedSec: seconds(statusJob.time_printing ?? jobDetails?.time_printing),
      remainingSec: state === "finished" ? 0 : seconds(statusJob.time_remaining ?? jobDetails?.time_remaining),
    }),
    temps: {
      nozzle: heaterReading(printer.temp_nozzle, printer.target_nozzle),
      bed: heaterReading(printer.temp_bed, printer.target_bed),
    },
    problems,
  });
}

// ---------------------------------------------------------------------------
// Duet / RepRapFirmware 3 — rr_model?key=state|job&flags=d99v (standalone and
// DSF 3.5+), or the DSF object model from GET /machine/status.
// Flags: 'f' returns only frequently changing values and drops job.file
// (RepRapFirmware ObjectModel.cpp / PrintMonitor.cpp), so this server asks for
// the verbose model ('d99v') instead of the PRD's 'd99f'.
// https://github.com/Duet3D/RepRapFirmware/wiki/HTTP-requests
// https://github.com/Duet3D/RepRapFirmware/wiki/Object-Model-Documentation
// lastFile* flags: DuetSoftwareFramework src/DuetAPI/ObjectModel/Job/Job.cs.
// ---------------------------------------------------------------------------

export function mapDuet(stateModel: any, jobModel: any, observedAt: string): CounterpartProgress {
  const status = String(stateModel?.status ?? "");
  const file = jobModel?.file ?? {};
  const activeName = remoteJobName(file.fileName);
  let state: ProgressState;
  let name = activeName;
  switch (status) {
    case "processing":
    case "resuming":
      state = "printing";
      break;
    case "paused":
    case "pausing":
      state = "paused";
      break;
    case "cancelling":
      state = "cancelled";
      break;
    case "busy":
    case "changingTool":
      state = activeName ? "printing" : "busy";
      break;
    case "halted":
      state = "failed";
      break;
    case "off":
    case "disconnected":
      state = "offline";
      break;
    case "idle": {
      // After a job the firmware keeps a record of how the last file ended.
      const last = remoteJobName(jobModel?.lastFileName);
      if (last && jobModel?.lastFileSimulated !== true) {
        name = last;
        state = jobModel?.lastFileCancelled === true ? "cancelled" : jobModel?.lastFileAborted === true ? "failed" : "finished";
      } else {
        state = "idle";
      }
      break;
    }
    default:
      // starting, updating, simulating and unknown values.
      state = "busy";
  }
  const problems: CounterpartProblem[] = [];
  if (status === "halted") problems.push({ code: "duet.halted", severity: "fatal", message: "The machine is halted (emergency stop or firmware fault)." });
  const box = stateModel?.messageBox;
  const boxMessage = nonEmptyText(box?.message);
  if (boxMessage) {
    const title = nonEmptyText(box?.title);
    const blocking = box?.mode === 2 || box?.mode === 3;
    problems.push({ code: "duet.messageBox", severity: blocking ? "warning" : "info", message: title ? `${title}: ${boxMessage}` : boxMessage });
  }
  const display = nonEmptyText(stateModel?.displayMessage);
  if (display) problems.push({ code: "duet.displayMessage", severity: "info", message: display });

  const active = name === activeName && activeName !== undefined;
  const size = finiteNumber(file.size);
  const position = finiteNumber(jobModel?.filePosition);
  const timesLeft = jobModel?.timesLeft ?? {};
  // timesLeft values are null when there is no estimate (<= 0).
  const remaining = [timesLeft.slicer, timesLeft.file].map(seconds).find((value) => value !== undefined && value > 0);
  return progressResult(observedAt, state, {
    job: job(state, {
      name,
      progress: state === "finished" ? 100 : active && size && position !== undefined ? percent((position / size) * 100) : undefined,
      elapsedSec: active ? seconds(jobModel?.duration) : seconds(jobModel?.lastDuration),
      remainingSec: state === "finished" ? 0 : active ? remaining : undefined,
      layer: active ? layerNumber(jobModel?.layer) : undefined,
      totalLayers: active ? layerNumber(file.numLayers) : undefined,
      stage: ({ pausing: "Pausing", resuming: "Resuming", cancelling: "Cancelling", changingTool: "Changing tool" } as Record<string, string>)[status],
    }),
    problems,
  });
}

// ---------------------------------------------------------------------------
// Repetier-Server — GET /printer/api/<slug>?a=listPrinter
// https://www.repetier-server.com/manuals/programming/API/index.html documents
// active/job/name/online/slug. done, paused, jobid, printTime and
// printedTimeComp are returned by current servers but are not in that manual.
// printTime is the job's estimated total seconds; printedTimeComp the seconds
// printed so far, so remaining = printTime - printedTimeComp.
// ---------------------------------------------------------------------------

export function mapRepetier(printer: any, observedAt: string): CounterpartProgress {
  const online = printer?.online === 1 || printer?.online === true;
  const jobText = nonEmptyText(printer?.job);
  const hasJob = jobText !== undefined && jobText.toLowerCase() !== "none";
  let state: ProgressState;
  if (!online) state = "offline";
  else if (hasJob && (printer?.paused === true || finiteNumber(printer?.pauseState) === 1)) state = "paused";
  else if (hasJob) state = "printing";
  else state = "idle";
  const total = finiteNumber(printer?.printTime);
  const printed = finiteNumber(printer?.printedTimeComp);
  const id = finiteNumber(printer?.jobid);
  return progressResult(observedAt, state, {
    job: job(state, {
      name: hasJob ? remoteJobName(jobText) : undefined,
      id: id !== undefined && id > 0 ? String(id) : undefined,
      progress: percent(printer?.done),
      elapsedSec: seconds(printed),
      remainingSec: total !== undefined && printed !== undefined ? seconds(Math.max(0, total - printed)) : undefined,
    }),
    problems: [],
  });
}

// ---------------------------------------------------------------------------
// Creality without Moonraker — the adapter's existing GET /api/device/status.
// Not a documented Creality API: the state is read from the same candidate
// fields the print gate already accepts, and progress only when numeric.
// ---------------------------------------------------------------------------

export function mapCrealityDevice(data: any, observedAt: string): CounterpartProgress {
  const raw = [data?.state, data?.status, data?.printStatus, data?.print_state, data?.data?.state, data?.data?.status]
    .find((value) => typeof value === "string" && value.trim());
  const text = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  const map: Record<string, ProgressState> = {
    idle: "idle", ready: "idle", standby: "idle", operational: "idle",
    printing: "printing", paused: "paused", pausing: "paused",
    complete: "finished", completed: "finished", finished: "finished", finish: "finished",
    cancelled: "cancelled", canceled: "cancelled", stopped: "cancelled",
    error: "failed", failed: "failed",
  };
  const state = text ? map[text] ?? "busy" : "busy";
  const name = remoteJobName(data?.filename ?? data?.fileName ?? data?.data?.filename);
  return progressResult(observedAt, state, {
    job: job(state, {
      name,
      progress: percent(data?.progress ?? data?.printProgress ?? data?.data?.progress),
    }),
    problems: [],
  });
}

// ---------------------------------------------------------------------------
// Bambu — this server's cached MQTT report (BambuImplementation.getStatus raw).
// Encodings match bambu-printer-mcp's counterpart_print_progress.
// ---------------------------------------------------------------------------

/** print_error for a user cancel; reported with gcode_state FAILED. */
export const BAMBU_CANCEL_ERROR = 0x0300400c;
const NO_CHAMBER_MODELS = new Set(["p1s", "p1p", "a1", "a1mini", "a1 mini"]);

function hex(value: number, digits: number): string {
  return value.toString(16).toUpperCase().padStart(digits, "0");
}

function bambuCode(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number !== undefined && Number.isInteger(number) && number >= 0 && number <= 0xffffffff ? number : undefined;
}

export function bambuHmsSeverity(code: number): ProblemSeverity {
  switch (Math.floor(code / 0x10000)) {
    case 1: return "fatal";
    case 2: return "error";
    case 3: return "warning";
    case 4: return "info";
    default: return "error";
  }
}

export function mapBambu(raw: any, observedAt: string, options: { connected: boolean; model?: string }): CounterpartProgress {
  if (!options.connected || !raw || typeof raw !== "object") return progressResult(observedAt, "offline", { problems: [] });
  const gcodeState = typeof raw.gcode_state === "string" ? raw.gcode_state.toUpperCase() : "";
  const printError = bambuCode(raw.print_error) ?? 0;
  const failReason = bambuCode(raw.fail_reason);
  const cancelled = gcodeState === "FAILED" && (printError === BAMBU_CANCEL_ERROR || (printError === 0 && failReason === BAMBU_CANCEL_ERROR));
  const states: Record<string, ProgressState> = {
    IDLE: "idle", PREPARE: "preparing", SLICING: "preparing", RUNNING: "printing", PAUSE: "paused", FINISH: "finished", FAILED: "failed",
  };
  const state: ProgressState = cancelled ? "cancelled" : states[gcodeState] ?? "busy";
  const problems: CounterpartProblem[] = [];
  if (printError !== 0 && printError !== BAMBU_CANCEL_ERROR) {
    problems.push({ code: hex(printError, 8), severity: "error", message: `Printer error ${hex(printError, 8)}` });
  }
  for (const entry of Array.isArray(raw.hms) ? raw.hms : []) {
    const attr = bambuCode(entry?.attr);
    const code = bambuCode(entry?.code);
    if (attr === undefined || code === undefined) continue;
    const key = [attr >>> 16, attr & 0xffff, code >>> 16, code & 0xffff].map((part) => hex(part, 4)).join("_");
    problems.push({
      code: key,
      severity: bambuHmsSeverity(code),
      message: `HMS ${key}`,
      url: `https://e.bambulab.com/index.php?e=${key.replace(/_/g, "")}&s=device_hms&lang=en`,
    });
  }
  const taskId = typeof raw.task_id === "number" ? String(raw.task_id) : nonEmptyText(raw.task_id);
  const totalLayers = layerNumber(raw.total_layer_num);
  const model = String(options.model ?? raw.model ?? "").trim().toLowerCase();
  // V2 reports (H2/X2D) carry the active extruder's temperature and spool in device.extruder
  // (Bambu Studio DevExtruderSystem.cpp ParseV2_0); older reports use nozzle_temper and tray_now.
  const extruder = raw.device?.extruder;
  const extruders: any[] = Array.isArray(extruder?.info) ? extruder.info : [];
  const activeId = finiteNumber(extruder?.state) !== undefined ? (finiteNumber(extruder.state)! >> 4) & 0xf : undefined;
  const active = activeId !== undefined ? extruders.find((entry) => finiteNumber(entry?.id) === activeId) : undefined;
  const packed = finiteNumber(active?.temp);
  const nozzle = packed !== undefined ? heaterReading(packed & 0xffff, (packed >>> 16) & 0xffff) : heaterReading(raw.nozzle_temper, raw.nozzle_target_temper);
  let activeFilament: CounterpartProgress["activeFilament"];
  const dualNozzle = extruders.length > 1;
  if (active) {
    const snow = finiteNumber(active.snow);
    if (snow !== undefined && snow !== 0xffff) activeFilament = bambuSpool(raw, snow >>> 8, snow & 0xff, dualNozzle);
  } else {
    const trayNow = finiteNumber(raw.ams?.tray_now);
    if (trayNow === 254) activeFilament = bambuSpool(raw, 254, 0, dualNozzle);
    else if (trayNow !== undefined && trayNow >= 0x80 && trayNow <= 0x87) activeFilament = bambuSpool(raw, trayNow, trayNow & 3, dualNozzle);
    else if (trayNow !== undefined && trayNow !== 255) activeFilament = bambuSpool(raw, Math.floor(trayNow / 4), trayNow % 4, dualNozzle);
  }
  return progressResult(observedAt, state, {
    job: job(state, {
      name: nonEmptyText(raw.subtask_name) ?? nonEmptyText(raw.gcode_file),
      id: taskId && taskId !== "0" ? taskId : undefined,
      progress: percent(raw.mc_percent),
      // mc_remaining_time is in minutes.
      remainingSec: seconds(finiteNumber(raw.mc_remaining_time) !== undefined ? finiteNumber(raw.mc_remaining_time)! * 60 : undefined),
      layer: totalLayers ? layerNumber(raw.layer_num) : undefined,
      totalLayers,
    }),
    temps: {
      nozzle,
      bed: heaterReading(raw.bed_temper, raw.bed_target_temper),
      chamber: NO_CHAMBER_MODELS.has(model) ? undefined : finiteNumber(raw.chamber_temper),
    },
    activeFilament,
    problems,
  });
}

/**
 * The spool feeding the nozzle. External spools are 254/255: "ext" on a single
 * nozzle, "254" (left) or "255" (right) from vir_slot on dual-nozzle printers.
 * AMS-HT units are ids 0x80-0x87 with one tray; other AMS slots are ams_id*4+tray.
 */
function bambuSpool(raw: any, amsId: number, trayIndex: number, dualNozzle: boolean): CounterpartProgress["activeFilament"] {
  if (amsId === 254 || amsId === 255) {
    if (!dualNozzle) return bambuTray(raw.vt_tray ?? (Array.isArray(raw.vir_slot) ? raw.vir_slot[0] : undefined), "ext");
    const virtual = Array.isArray(raw.vir_slot) ? raw.vir_slot.find((entry: any) => finiteNumber(entry?.id) === amsId) : undefined;
    return bambuTray(virtual, String(amsId));
  }
  const unit = Array.isArray(raw.ams?.ams) ? raw.ams.ams.find((entry: any) => finiteNumber(entry?.id) === amsId) : undefined;
  const trays: any[] = Array.isArray(unit?.tray) ? unit.tray : [];
  if (amsId >= 0x80 && amsId <= 0x87) {
    const tray = trays.find((entry) => finiteNumber(entry?.id) === (trayIndex & 3)) ?? (trays.length === 1 ? trays[0] : undefined);
    return bambuTray(tray, String(amsId));
  }
  return bambuTray(trays.find((entry) => finiteNumber(entry?.id) === trayIndex), String(amsId * 4 + trayIndex));
}

function bambuTray(tray: any, slot: string): CounterpartProgress["activeFilament"] {
  const colour = typeof tray?.tray_color === "string" && /^[0-9a-f]{6}/i.test(tray.tray_color) ? `#${tray.tray_color.slice(0, 6).toUpperCase()}` : undefined;
  return { slot, material: nonEmptyText(tray?.tray_type), color: colour };
}
