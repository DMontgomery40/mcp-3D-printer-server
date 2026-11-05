import { PrinterRefusal } from "../refusal.js";
import { HIDDEN_HMS } from "./hidden-hms.js";
import type { BambuClient } from "bambu-node";
import { isDualNozzleModel, normalizeMaterial, normalizeModel } from "./limits.js";

const MAX_REPORT_AGE_MS = 15_000;
export const MODEL_IDS: Record<string, string> = {
  O1C: "H2C", O1C2: "H2C", O1D: "H2D", O1E: "H2D Pro", O1S: "H2S", N6: "X2D",
  N2S: "A1", A1M: "A1 Mini", C11: "P1P", C12: "P1S", C13: "X1E", "BL-P001": "X1C", "BL-P002": "X1",
};
export const SERIAL_MODELS: Record<string, string> = {
  "093": "H2S", "094": "H2D", "31B": "H2C", "239": "H2D Pro", "20P": "X2D",
  "00M": "X1C", "00W": "X1", "03W": "X1E", "01S": "P1P", "01P": "P1S", "22E": "P2S", "039": "A1", "030": "A1 Mini",
};

function object(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function observedIdentity(raw: Record<string, any>, configuredSerial: string) {
  const recognizedModelFromModelId = typeof raw.model_id === "string" && raw.model_id.trim()
    ? normalizeModel(MODEL_IDS[raw.model_id.trim().toUpperCase()] ?? raw.model_id)
    : undefined;
  const declarations = [raw.model, raw.printer_type, raw.device?.devModel, raw.device?.dev_model]
    .filter(value => typeof value === "string" && value.trim());
  const models = declarations.map(value => normalizeModel(MODEL_IDS[value.trim().toUpperCase()] ?? value));
  if (models.some(model => !model)) throw new Error("Printer reported an unknown model identity; cannot verify this printer.");
  if (recognizedModelFromModelId) models.unshift(recognizedModelFromModelId);
  const hasReportedModel = models.length > 0;
  const serials = [raw.serial, raw.serial_number, raw.sn, raw.device?.sn,
    ...(Array.isArray(raw.modules) ? raw.modules.filter((module: any) => module?.name === "ota").map((module: any) => module.sn) : [])]
    .filter(value => typeof value === "string" && value.trim()).map(value => value.trim());
  if (serials.some(serial => serial.toUpperCase() !== configuredSerial.trim().toUpperCase())) {
    throw new Error("Printer-returned serial does not match the configured printer serial.");
  }
  for (const serial of serials) {
    const model = normalizeModel(SERIAL_MODELS[serial.toUpperCase().slice(0, 3)] ?? "");
    if (model) models.push(model);
  }
  if (new Set(models).size > 1) throw new Error("Printer returned contradictory model identity information.");
  const model = models[0];
  return { model, observedSerial: serials[0], identitySource: hasReportedModel ? "report" : "module-serial" };
}

/** Only raw reports received after this request are evidence. Never read printer.data here. */
export function readFreshPrinterStatus(printer: BambuClient, serial: string, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw: Record<string, any> = {};
    const requestedAt = Date.now();
    let receivedAt = 0;
    let requestsPublished = false;
    let complete = false;
    const cleanup = () => {
      clearTimeout(timer);
      printer.off("rawMessage", onRaw);
      printer.off("client:disconnect", onDisconnect);
      printer.off("client:error", onError);
    };
    const fail = (error: unknown) => {
      if (complete) return;
      complete = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const maybeResolve = () => {
      if (complete || !requestsPublished || !receivedAt || !Object.prototype.hasOwnProperty.call(raw, "gcode_state") ||
          !Object.prototype.hasOwnProperty.call(raw, "print_error") || !Object.prototype.hasOwnProperty.call(raw, "hms")) return;
      try {
        const identity = observedIdentity(raw, serial);
        if (!identity.model) return;
        complete = true;
        cleanup();
        resolve({ connected: true, model: identity.model, status: raw.gcode_state, serial,
          observedSerial: identity.observedSerial, raw,
          observation: { source: "mqtt", requestedAt, receivedAt, identitySource: identity.identitySource } });
      } catch (error) { fail(error); }
    };
    const onRaw = (topic: string, payload: Buffer) => {
      if (complete || topic !== `device/${serial}/report`) return;
      let parsed: any;
      try { parsed = JSON.parse(payload.toString()); } catch { return; }
      if (object(parsed.print) && parsed.print.command === "push_status") {
        raw = { ...raw, ...parsed.print };
        receivedAt = Date.now();
      }
      if (object(parsed.info) && parsed.info.command === "get_version" && Array.isArray(parsed.info.module)) {
        raw = { ...raw, modules: parsed.info.module };
      }
      maybeResolve();
    };
    const onDisconnect = () => fail(new Error("Printer disconnected while waiting for a fresh safety report."));
    const onError = (error: Error) => fail(error);
    const timer = setTimeout(() => fail(new Error("Timed out waiting for a fresh MQTT safety report with observed printer identity, state and errors; cached status cannot authorize an operation.")), timeoutMs);
    printer.on("rawMessage", onRaw);
    printer.on("client:disconnect", onDisconnect);
    printer.on("client:error", onError);
    // invoke() publishes only; executeCommand() would add an ACK dependency that H2 firmware lacks.
    // String sequence ids without bambu-printer-mcp's bambu-node patch (H2-series firmware needs them).
    void Promise.all([publishBambuCommand(printer, "pushing", "pushall"), publishBambuCommand(printer, "info", "get_version")])
      .then(() => { requestsPublished = true; maybeResolve(); }, fail);
  });
}

export interface PrinterStateRequirements {
  model: string;
  nozzleDiameters: number[];
  materials?: string[];
  usedFilamentPositions?: number[];
  /** Verified physical nozzle index for each project filament, composed from the inspected plate mappings. */
  filamentNozzleIndices?: number[];
  amsMapping?: number[];
  useAMS?: boolean;
  requireIdle?: boolean;
  /** Raw gcode_file transport cannot load a mapped spool before printing. */
  requireLoadedFilament?: boolean;
  /** Upload-only identity checks do not select or consume a physical filament slot. */
  verifyMaterials?: boolean;
  /** Zero-based firmware nozzle indices corresponding positionally to nozzleDiameters. */
  usedNozzleIndices?: number[];
  nozzleTypes?: string[];
  nozzleFlows?: string[];
}
interface ReportedNozzle { index: number; diameter: number; type?: string; flow?: string }
interface ReportedFilament { position: number; material: string; trayIndex: number; nozzleMin?: number; nozzleMax?: number }
export interface ValidatedPrinterState { model: string; reportedNozzles: ReportedNozzle[]; filaments: ReportedFilament[] }

export function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

/**
 * X2D retains FAILED after a canceled job even with no active print error.
 * Bambu Studio classifies FAILED as a finished job; its v02.08.02.61
 * hms_en_20P table (926a7192574bcb9b3a732e1ec59a46d79cb45466)
 * calls 0300400C "The task was canceled."
 * Only this observed terminal condition qualifies, never an arbitrary failure.
 * Callers still validate HMS, identity, hardware and material configuration,
 * and print dispatch rechecks the identity of the observed job.
 */
export function isCancelledX2DJob(raw: Record<string, any>, model: string): boolean {
  return normalizeModel(model) === "x2d" && raw.gcode_state === "FAILED" &&
    finiteNumber(raw.print_error) === 0 && finiteNumber(raw.fail_reason) === 0x0300400c &&
    [raw.gcode_file, raw.subtask_name].some(value => typeof value === "string" && value.trim().length > 0);
}
/** Bambu Studio 2.8.2.61 marks FAILED as finished. Limit P1S recovery to
 * a named prior job explicitly reporting idle, no print error and no HMS.
 * Dispatch rechecks the observed job identity. */
export function isFinishedP1SJob(raw: Record<string, any>, model: string): boolean {
  return normalizeModel(model) === "p1s" && raw.gcode_state === "FAILED" && raw.print_type === "idle" &&
    finiteNumber(raw.print_error) === 0 && Array.isArray(raw.hms) && raw.hms.length === 0 &&
    [raw.gcode_file, raw.subtask_name].some(value => typeof value === "string" && value.trim().length > 0);
}
const token = (value: unknown) => typeof value === "string" ? value.trim().toLowerCase().replace(/[\s_-]/g, "") : "";
function nozzleTypeAndFlow(value: unknown): {type?: string; flow?: string} {
  const text = String(value ?? "");
  if (/^H[A-Z]\d\d/i.test(text)) {
    // BambuStudio DeviceCore/DevNozzleSystem.cpp s_parse_nozzle_type.
    const types: Record<string,string> = {"00":"stainlesssteel","01":"hardenedsteel","05":"tungstencarbide"};
    const flows: Record<string,string> = {S:"standard",A:"standard",X:"standard",H:"highflow",E:"highflow",U:"tpuhighflow",B:"e3dhighflow"};
    return {type:types[text.slice(2,4)],flow:flows[text[1].toUpperCase()]};
  }
  const type = token(value);
  return {type: ["stainlesssteel","hardenedsteel","tungstencarbide","brass"].includes(type) ? type : undefined};
}
/**
 * A nozzle without an identity chip reports serial "N/A" and keeps the
 * unreliable bit set permanently (stock H2D HS01 nozzles), so its diameter
 * and type are configured settings, as on single-nozzle printers.
 */
function hasNoIdentityChip(entry: any): boolean {
  return typeof entry?.sn === "string" && entry.sn.trim().toUpperCase() === "N/A";
}

/** Bit 0 (information unreliable) is accepted only from a nozzle without an identity chip. */
function unreliableWithoutChip(entry: any, stat: number): boolean {
  return (stat & 1) !== 0 && hasNoIdentityChip(entry);
}

/** Nozzles whose reported diameter and type are configured settings rather than chip readings. */
export function unchippedNozzles(raw: unknown): number[] {
  const info = (raw as any)?.device?.nozzle?.info;
  if (!Array.isArray(info)) return [];
  return info.flatMap(entry => {
    const index = finiteNumber(entry?.id);
    const stat = finiteNumber(entry?.stat);
    return index !== undefined && Number.isInteger(index) && index >= 0 && index < 16 &&
      stat !== undefined && Number.isInteger(stat) && unreliableWithoutChip(entry, stat) ? [index] : [];
  });
}

const loggedUnchippedNozzles = new Set<string>();
/** Name each unchipped nozzle a check accepted once per printer on stderr, so headless runs still record it. */
function logUnchippedNozzles(raw: Record<string, any>, serial: string): void {
  for (const index of unchippedNozzles(raw)) {
    const key = `${serial}:${index}`;
    if (loggedUnchippedNozzles.has(key)) continue;
    loggedUnchippedNozzles.add(key);
    console.error(`Printer ${serial || "(unknown serial)"} nozzle ${index} reports no identity chip; its diameter and type are the printer's configured settings.`);
  }
}

function reportedNozzles(raw: Record<string,any>): ReportedNozzle[] {
  const info = raw.device?.nozzle?.info;
  const output: ReportedNozzle[] = [];
  if (Array.isArray(info)) {
    for (const entry of info) {
      const index = finiteNumber(entry?.id);
      // Rack nozzles (0x10+) are not interchangeable with the active extruder nozzle.
      if (index !== undefined && index >= 16) continue;
      const diameter = finiteNumber(entry?.diameter);
      if (index === undefined || !Number.isInteger(index) || index < 0 || diameter === undefined || diameter <= 0) throw new Error("Printer reported malformed nozzle identity or diameter.");
      if (entry.stat !== undefined) {
        // BambuStudio DevNozzle: bit 0 set means the information is unreliable;
        // bits 1-2 are 0 normal, 1 abnormal, 2 unknown.
        const stat = finiteNumber(entry.stat);
        if (stat === undefined || !Number.isInteger(stat) || stat < 0 || (stat & 6) !== 0) throw new Error(`Printer nozzle ${index} information is unreliable, abnormal or unknown.`);
        if ((stat & 1) !== 0 && !unreliableWithoutChip(entry, stat)) throw new Error(`Printer nozzle ${index} information is unreliable; refresh the nozzle information on the printer.`);
      }
      if (output.some(nozzle => nozzle.index === index)) throw new Error("Printer reported ambiguous duplicate nozzle indices.");
      output.push({index,diameter,...nozzleTypeAndFlow(entry.type)});
    }
  } else if (Array.isArray(raw.nozzle_diameter)) {
    raw.nozzle_diameter.forEach((value: unknown,index: number) => {
      const diameter = finiteNumber(value);
      if (diameter === undefined || diameter <= 0) throw new Error("Printer reported an unknown nozzle diameter.");
      output.push({index,diameter,...nozzleTypeAndFlow(Array.isArray(raw.nozzle_type) ? raw.nozzle_type[index] : raw.nozzle_type),
        ...(Array.isArray(raw.nozzle_volume_type) ? {flow:token(raw.nozzle_volume_type[index])} : {})});
    });
  } else {
    const diameter = finiteNumber(raw.nozzle_diameter);
    if (diameter !== undefined && diameter > 0) {
      const configuration = nozzleTypeAndFlow(raw.nozzle_type);
      // Manufacturer legacy ParseV1_0 defaults a recognized nozzle to standard flow;
      // flag3 bits 10..12 equal 1 report the legacy high-flow upgrade.
      // https://github.com/bambulab/BambuStudio/blob/master/src/slic3r/GUI/DeviceCore/DevNozzleSystem.cpp
      if (configuration.type && !configuration.flow) {
        configuration.flow = "standard";
        if (raw.flag3 !== undefined) {
          const flag = finiteNumber(raw.flag3);
          if (flag === undefined || !Number.isInteger(flag) || flag < 0 || flag > 0xffffffff) throw new Error("Printer legacy nozzle flow report is malformed.");
          const flowFlag = (flag >>> 10) & 7;
          if (flowFlag > 1) throw new Error("Printer legacy nozzle flow variant is unknown.");
          if (flowFlag === 1) configuration.flow = "highflow";
        }
      }
      output.push({index:0,diameter,...configuration,
        ...(raw.nozzle_volume_type !== undefined ? {flow:token(raw.nozzle_volume_type)} : {})});
    }
  }
  return output;
}

const hiddenHmsSets = new Map(Object.entries(HIDDEN_HMS).map(([prefix, codes]) => [prefix, new Set(codes)]));

export type HmsEntry = { attr: number; code: number; severity: number; hex: string };
export function hmsCode(entry: any): HmsEntry | undefined {
  const code = finiteNumber(entry?.code);
  const attr = finiteNumber(entry?.attr);
  const valid = (value: number | undefined): value is number => value !== undefined && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
  if (!valid(code) || !valid(attr)) return undefined;
  // BambuStudio DevHMS.cpp: code >> 16; DevHMS.h: 1=fatal,2=serious,3=common,4=info.
  return { attr, code, severity: Math.floor(code / 65536), hex: (attr.toString(16).padStart(8, "0") + code.toString(16).padStart(8, "0")).toUpperCase() };
}

const hmsLabel = (hex: string) => `HMS ${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12)}`;
const hmsKey = (entry: HmsEntry) => `hms:${entry.attr}:${entry.code}`;

/** The one key format for a reported entry, shared by the gate and clear_hms_errors. */
export function reportedHmsKey(entry: unknown): string {
  const parsed = hmsCode(entry);
  return parsed ? hmsKey(parsed) : `hms:${(entry as any)?.attr}:${(entry as any)?.code}`;
}

/** Bambu's display form of a cleared-code key such as "hms:83887616:131184"; other keys unchanged. */
export function describeHmsKey(key: string): string {
  const match = /^hms:(\d+):(\d+)$/.exec(key);
  const entry = match ? hmsCode({ attr: Number(match[1]), code: Number(match[2]) }) : undefined;
  return entry ? hmsLabel(entry.hex) : key;
}

/**
 * A serious or common entry that Bambu lists for this serial prefix with empty
 * text: Bambu Studio, Bambu Handy and the printer screen never show it, and
 * the printer keeps printing with it (an X2D raises 0500-0600-0002-0070 at
 * every boot). Bambu Studio selects the table by serial prefix, so this does
 * too, but only when that prefix belongs to the verified model: a sparse report
 * without a serial must not let a misconfigured serial pick another model's
 * table. Fatal, invalid-level and unlisted entries never qualify.
 */
export function isHiddenNotice(serial: string, model: string, entry: HmsEntry): boolean {
  if (entry.severity !== 2 && entry.severity !== 3) return false;
  const prefix = serial.trim().toUpperCase().slice(0, 3);
  const normalized = normalizeModel(model);
  if (!normalized || normalizeModel(SERIAL_MODELS[prefix] ?? "") !== normalized) return false;
  return hiddenHmsSets.get(prefix)?.has(entry.hex) === true;
}

function hiddenHmsEntries(raw: unknown, serial: string, model: string): HmsEntry[] {
  if (!object(raw)) return [];
  const identity = observedIdentity(raw, serial);
  if (!identity.observedSerial || identity.model !== normalizeModel(model)) return [];
  const entries = Array.isArray(raw.hms) ? raw.hms : [];
  const seen = new Set<string>();
  return entries.map(hmsCode).filter((entry): entry is HmsEntry =>
    !!entry && isHiddenNotice(identity.observedSerial, model, entry) && !seen.has(entry.hex) && !!seen.add(entry.hex));
}

/** Labels of reported entries that pass only because Bambu hides them for this printer. */
export function hiddenHmsNotices(raw: unknown, serial: string, model: string): string[] {
  return hiddenHmsEntries(raw, serial, model).map(entry => hmsLabel(entry.hex));
}

/** Cleared-code keys of reported hidden entries; clearing never removes them, so they are not re-acknowledged. */
export function hiddenHmsKeys(raw: unknown, serial: string, model: string): string[] {
  return hiddenHmsEntries(raw, serial, model).map(hmsKey);
}

const loggedHiddenNotices = new Set<string>();
/** Name each hidden entry a check passed once per printer on stderr, so headless runs still record it. */
function logHiddenNotices(raw: Record<string, any>, serial: string, model: string): void {
  for (const entry of hiddenHmsEntries(raw, serial, model)) {
    const key = `${serial}:${entry.hex}`;
    if (loggedHiddenNotices.has(key)) continue;
    loggedHiddenNotices.add(key);
    console.error(`Printer ${serial} reports ${hmsLabel(entry.hex)}, which Bambu lists for it without text and never shows as a fault; it does not block operations.`);
  }
}

/**
 * 0300_8013, "Printing was paused by the user" / "paused due to the pause command added to the
 * printing file": the printer's report of a deliberate pause (a Pause, or a pause_at_layers stop),
 * which Resume clears. A paused P1S reports it as print_error, so it is not an error for resuming
 * a paused job. requireIdle is false only for Resume here; starting a job still needs no error.
 * Ported from bambu-printer-mcp src/safety/printer-state.ts.
 */
export const PAUSE_NOTICE = 0x03008013;
export function isPauseNotice(raw: Record<string, any>, requireIdle: boolean): boolean {
  const state = typeof raw?.gcode_state === "string" ? raw.gcode_state.toUpperCase() : "";
  return !requireIdle && state === "PAUSE" && finiteNumber(raw?.print_error) === PAUSE_NOTICE;
}
function validateErrors(raw: Record<string,any>, requireIdle: boolean, serial: string, model: string) {
  const state = typeof raw.gcode_state === "string" ? raw.gcode_state.toUpperCase() : "UNKNOWN";
  const terminal = isCancelledX2DJob(raw, model) || isFinishedP1SJob(raw, model);
  if (requireIdle && !["IDLE","FINISH"].includes(state) && !terminal) throw new PrinterRefusal("printer-not-ready", `Printer state ${state} is not safely idle.`);
  if (!requireIdle && !["IDLE","FINISH","RUNNING","PAUSE"].includes(state) && !terminal) throw new Error(`Printer state ${state} is unknown or failed.`);
  if (finiteNumber(raw.print_error) !== 0 && !isPauseNotice(raw, requireIdle)) throw new Error("Printer reports a print error or did not report its error state.");
  if (!Array.isArray(raw.hms)) throw new Error("Printer HMS error state is missing or malformed.");
  for (const reported of raw.hms) {
    const entry = hmsCode(reported);
    // Unknown severities fail closed; attr identifies the module and is not a severity bitmask.
    if (entry && (entry.severity === 4 || isHiddenNotice(serial, model, entry))) continue;
    throw new Error(`Printer reports actionable or unknown HMS errors${entry ? ` (${hmsLabel(entry.hex)})` : ""}; inspect and resolve them before proceeding.`);
  }
  logHiddenNotices(raw, serial, model);
}
function trayRange(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === "" || value === "0" || value === 0) return undefined;
  const number = finiteNumber(value);
  if (number === undefined || number <= 0) throw new Error(`Reported filament ${label} temperature is malformed.`);
  return number;
}
/** Dual-nozzle printers report one virtual external slot per nozzle, numbered as Bambu
 * Studio does (VIRTUAL_TRAY_MAIN_ID 255 = right/main nozzle, VIRTUAL_TRAY_DEPUTY_ID 254 =
 * left/deputy nozzle), so the requested tray selects its slot. Single-nozzle printers keep
 * requiring exactly one slot 254 report, then the legacy vt_tray field. */
function externalTray(raw: Record<string,any>, trayIndex: number, model: string): Record<string,any> | undefined {
  const slots = raw.vir_slot;
  const dualNozzle = isDualNozzleModel(model);
  if (Array.isArray(slots)) {
    const selected = slots.filter((slot:any) => Number(slot?.id) === trayIndex);
    if (selected.length === 1 && (dualNozzle || slots.length === 1)) return selected[0];
    if (dualNozzle && selected.length === 0 && slots.length > 0) throw new Error(`External spool ${trayIndex} is not in the fresh per-nozzle report; cannot verify the selected material.`);
    if (slots.length > 0) throw new Error("External spool report is ambiguous for this nozzle; cannot verify the selected material.");
  }
  if (dualNozzle) throw new Error(`Dual-nozzle external spool ${trayIndex} requires a fresh per-nozzle vir_slot report; legacy vt_tray cannot verify the selected nozzle.`);
  return object(raw.vt_tray) ? raw.vt_tray : undefined;
}
function mappedTray(raw: Record<string,any>, index: number): Record<string,any> {
  const unit = index >= 128 ? 128 : Math.floor(index / 4);
  const slot = index >= 128 ? index - 128 : index % 4;
  const units = raw.ams?.ams;
  const ams = Array.isArray(units) ? units.find((value:any) => Number(value?.id) === unit) : undefined;
  const tray = Array.isArray(ams?.tray) ? ams.tray.find((value:any) => Number(value?.id) === slot) : undefined;
  if (!object(tray)) throw new Error(`AMS mapped slot ${index} is not present in the fresh printer report.`);
  const bits = index >= 128 ? ams?.tray_exist_bits : raw.ams?.tray_exist_bits;
  if (bits !== undefined) {
    let present: boolean;
    try { present = (BigInt(typeof bits === "string" ? `0x${bits.replace(/^0x/i, "")}` : bits) & (1n << BigInt(index >= 128 ? slot : index))) !== 0n; }
    catch { throw new Error("AMS slot presence report is malformed."); }
    if (!present) throw new Error(`AMS mapped slot ${index} is reported empty.`);
  }
  return tray;
}

/** Verifies reported configuration, not a physical nozzle/spool inspection. */
export function validatePrinterState(status: any, requirements: PrinterStateRequirements): ValidatedPrinterState {
  if (status?.connected !== true) throw new Error("A connected printer is required for safety validation.");
  const observation = status.observation;
  const now = Date.now();
  if (!observation || observation.source !== "mqtt" || !Number.isFinite(observation.requestedAt) || !Number.isFinite(observation.receivedAt) ||
      observation.receivedAt < observation.requestedAt || observation.receivedAt > now || now - observation.requestedAt > MAX_REPORT_AGE_MS) {
    throw new Error("A fresh observed MQTT report is required; cached or stale status cannot authorize an operation.");
  }
  if (!object(status.raw)) throw new Error("Fresh raw printer report is missing.");
  const raw = status.raw;
  const identity = observedIdentity(raw, String(status.serial ?? ""));
  const model = normalizeModel(requirements.model);
  if (!model || !identity.model || model !== identity.model) throw new Error(`Printer model identity mismatch: requested ${requirements.model}, observed ${identity.model ?? "unknown"}.`);
  validateErrors(raw, requirements.requireIdle !== false, identity.observedSerial ?? "", model);
  if (requirements.requireLoadedFilament && (raw.ams?.tray_now !== undefined || Array.isArray(raw.ams?.ams))) {
    const current = finiteNumber(raw.ams?.tray_now);
    if (current === 255) throw new Error("The nozzle is explicitly reported unloaded. Load the declared filament before starting or resuming this G-code job.");
    if (current === undefined || !Number.isInteger(current) || current < 0 || current > 254) {
      throw new Error("Cannot verify the currently loaded AMS tray before starting or resuming this G-code job.");
    }
    if ((requirements.usedFilamentPositions ?? []).some(position => current !== (requirements.useAMS ? requirements.amsMapping?.[position] : 254))) {
      throw new Error("The currently loaded spool differs from the tray checked for this G-code job.");
    }
  }
  const nozzles = requirements.nozzleDiameters.length ? reportedNozzles(raw) : [];
  if (requirements.nozzleDiameters.length && isDualNozzleModel(model) &&
      !Array.isArray(raw.device?.nozzle?.info) && !Array.isArray(raw.nozzle_diameter)) {
    throw new Error("A scalar legacy nozzle report is ambiguous for this multi-nozzle printer; fresh per-nozzle configuration is required.");
  }
  // Without a physical selection, a scalar file requirement must match every reported nozzle.
  const broadcast = !requirements.usedNozzleIndices && requirements.nozzleDiameters.length === 1 && nozzles.length > 1;
  const expectedDiameters = broadcast ? nozzles.map(() => requirements.nozzleDiameters[0]) : requirements.nozzleDiameters;
  const indices = requirements.usedNozzleIndices ?? (broadcast ? nozzles.map(nozzle => nozzle.index) : requirements.nozzleDiameters.map((_, index) => index));
  if (indices.length !== expectedDiameters.length || (!requirements.usedNozzleIndices && nozzles.length !== expectedDiameters.length)) {
    throw new Error("Nozzle selection is missing or ambiguous; specify each used nozzle and verify its reported diameter.");
  }
  expectedDiameters.forEach((diameter,position) => {
    const nozzle = nozzles.find(value => value.index === indices[position]);
    if (!Number.isFinite(diameter) || diameter <= 0 || !nozzle || Math.abs(nozzle.diameter - diameter) > 0.0001) throw new Error(`Printer nozzle ${indices[position]} diameter does not match the job (${diameter} mm).`);
    const expectedType = token(requirements.nozzleTypes?.[broadcast ? 0 : position]);
    const expectedFlow = token(requirements.nozzleFlows?.[broadcast ? 0 : position]);
    if (requirements.nozzleTypes !== undefined && (!["stainlesssteel","hardenedsteel","tungstencarbide","brass"].includes(expectedType) || expectedType !== nozzle.type)) {
      throw new Error(`Printer nozzle ${indices[position]} type is unknown or does not match the job.`);
    }
    if (requirements.nozzleFlows !== undefined && (!["standard","highflow","tpuhighflow","e3dhighflow"].includes(expectedFlow) || expectedFlow !== nozzle.flow)) {
      throw new Error(`Printer nozzle ${indices[position]} flow variant is unknown or does not match the job.`);
    }
  });
  const filaments: ReportedFilament[] = [];
  // Heating the bed alone has no filament requirement. All other callers declare each used material.
  if (requirements.verifyMaterials !== false && (requirements.materials !== undefined || requirements.nozzleDiameters.length)) {
    const materials = requirements.materials ?? [];
    const positions = requirements.usedFilamentPositions ?? materials.map((_, index) => index);
    // 255 is the right/main nozzle external spool only on dual-nozzle printers.
    const dualNozzle = isDualNozzleModel(model);
    const maxTray = dualNozzle ? 255 : 254;
    if (!positions.length) throw new Error("A declared material is required for each used filament or external spool.");
    for (const position of positions) {
      const material = normalizeMaterial(materials[position]);
      if (!Number.isInteger(position) || position < 0 || !material) throw new Error(`A known declared material is required for filament position ${position}.`);
      const physicalNozzle = requirements.filamentNozzleIndices?.[position];
      const externalForNozzle = physicalNozzle === 0 ? 255 : physicalNozzle === 1 ? 254 : undefined;
      const trayIndex = requirements.useAMS || requirements.amsMapping !== undefined
        ? requirements.amsMapping?.[position] : dualNozzle ? externalForNozzle : 254;
      if (!requirements.useAMS && dualNozzle && requirements.amsMapping === undefined && externalForNozzle === undefined) {
        throw new Error(`External spool for filament position ${position} is ambiguous; re-slice with complete filament_map and physical_extruder_map nozzle bindings or provide a verified sliced plate.`);
      }
      if (trayIndex === undefined || !Number.isInteger(trayIndex) || trayIndex < 0 || trayIndex > maxTray) throw new Error(`Complete AMS mapping is required for filament position ${position}.`);
      if (!requirements.useAMS && trayIndex < 254) throw new Error("External-spool printing requires an external spool mapping; AMS trays require use_ams:true.");
      if (dualNozzle && trayIndex >= 254) {
        if (externalForNozzle === undefined) throw new Error(`External spool ${trayIndex} needs a verified physical nozzle binding for filament position ${position}; re-slice with complete filament_map and physical_extruder_map metadata.`);
        if (trayIndex !== externalForNozzle) throw new Error(`External spool ${trayIndex} does not feed physical nozzle ${physicalNozzle} for filament position ${position}; use spool ${externalForNozzle}.`);
      }
      const tray = trayIndex >= 254 ? externalTray(raw,trayIndex,model) : mappedTray(raw,trayIndex);
      const reportedType = typeof tray?.tray_type === "string" ? tray.tray_type.trim() : "";
      if (reportedType && normalizeMaterial(reportedType) !== material) throw new Error(`Reported material ${reportedType} in slot ${trayIndex} contradicts declared ${materials[position]}.`);
      const nozzleMin = trayRange(tray?.nozzle_temp_min,"minimum");
      const nozzleMax = trayRange(tray?.nozzle_temp_max,"maximum");
      if (nozzleMin !== undefined && nozzleMax !== undefined && nozzleMin > nozzleMax) throw new Error(`Reported filament temperature range in slot ${trayIndex} is invalid.`);
      filaments.push({position,material,trayIndex,nozzleMin,nozzleMax});
    }
  }
  if (nozzles.length) logUnchippedNozzles(raw, identity.observedSerial ?? String(status.serial ?? ""));
  return {model,reportedNozzles:nozzles,filaments};
}

/** Manual M104 cannot remap filament slots. Validate the material already at the nozzle. */
export function manualHeatingRequirements(status: any, model: string, nozzleDiameter: number, material: string): PrinterStateRequirements {
  const normalized = normalizeModel(model);
  if (!normalized) throw new Error("A known printer model is required for manual nozzle heating.");
  const raw = status?.raw;
  if (!object(raw)) throw new Error("A fresh printer report is required for manual nozzle heating.");
  if (isDualNozzleModel(normalized) || reportedNozzles(raw).some(nozzle => nozzle.index !== 0)) {
    throw new Error("Manual heating cannot verify the active nozzle and loaded material on this multi-nozzle printer. Use a checked sliced print instead.");
  }
  const requirements: PrinterStateRequirements = {
    model: normalized, nozzleDiameters: [nozzleDiameter], usedNozzleIndices: [0],
    materials: [material], usedFilamentPositions: [0], useAMS: false,
  };
  const current = raw.ams?.tray_now;
  if (current === undefined && !Array.isArray(raw.ams?.ams)) return requirements;
  const tray = finiteNumber(current);
  if (tray === undefined || !Number.isInteger(tray) || tray < 0 || tray > 255) {
    throw new Error("Cannot identify the currently loaded AMS tray for manual heating; refresh the printer's filament state.");
  }
  // 254 is external spool; 255 means no filament loaded. The caller must still declare a material.
  if (tray < 254) { requirements.useAMS = true; requirements.amsMapping = [tray]; }
  return requirements;
}

export type ExternalStorageState = "none" | "normal" | "abnormal" | "readonly";
const EXTERNAL_STORAGE_STATES: readonly ExternalStorageState[] = ["none", "normal", "abnormal", "readonly"];

/**
 * The SD card or USB stick state, read as Bambu Studio does: the `sdcard`
 * flag, then `home_flag` bits 8-9, then on firmware that reports cfg/fun/aux/stat
 * the `aux` bits 12-13, each later source overriding the earlier one
 * (DevStorage.cpp, DeviceManager.cpp parse_home_flag and parse_new_info).
 */
export function externalStorageState(raw: unknown): ExternalStorageState {
  if (!object(raw)) return "none";
  let state: ExternalStorageState = raw.sdcard === true ? "normal" : "none";
  if (Number.isInteger(raw.home_flag)) state = EXTERNAL_STORAGE_STATES[(raw.home_flag >> 8) & 3];
  if (["cfg", "fun", "aux", "stat"].every(key => key in raw) && typeof raw.aux === "string" && /^[0-9a-f]+$/i.test(raw.aux)) {
    state = EXTERNAL_STORAGE_STATES[Number((BigInt(`0x${raw.aux}`) >> 12n) & 3n)];
  }
  return state;
}

let sequence = 0;
/**
 * Publish one MQTT command with a string sequence id and no ACK wait.
 * Unpatched bambu-node 3.22.21 command classes send numeric sequence ids;
 * bambu-printer-mcp patches them to strings for H2-series firmware. This
 * server does not install that patch, so safety-relevant commands are
 * published here with the patched wire shape: {category:{sequence_id,command,...}}.
 */
export function publishBambuCommand(printer: Pick<BambuClient, "publish">, category: "print" | "pushing" | "info", command: string, extra: Record<string, unknown> = {}): Promise<void> {
  sequence = (sequence + 1) % 1_000_000_000;
  return printer.publish({ [category]: { sequence_id: String(sequence), command, ...extra } });
}
