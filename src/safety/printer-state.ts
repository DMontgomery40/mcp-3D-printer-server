import type { BambuClient } from "bambu-node";
import { normalizeMaterial, normalizeModel } from "./limits.js";

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

const MAX_REPORT_AGE_MS = 15_000;
const MODEL_IDS: Record<string, string> = {
  O1C: "H2C", O1C2: "H2C", O1D: "H2D", O1E: "H2D Pro", O1S: "H2S", N6: "X2D",
  N2S: "A1", A1M: "A1 Mini", C11: "P1P", C12: "P1S", C13: "X1E", "BL-P001": "X1C", "BL-P002": "X1",
};
const SERIAL_MODELS: Record<string, string> = {
  "093": "H2S", "094": "H2D", "239": "H2C", "31B": "H2D Pro", "20P": "X2D",
  "00M": "X1C", "00W": "X1", "03W": "X1E", "01S": "P1P", "01P": "P1S", "22E": "P2S", "039": "A1", "030": "A1 Mini",
};

function object(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function observedIdentity(raw: Record<string, any>, configuredSerial: string) {
  const declarations = [raw.model_id, raw.model, raw.printer_type, raw.device?.devModel, raw.device?.dev_model]
    .filter(value => typeof value === "string" && value.trim());
  const models = declarations.map(value => normalizeModel(MODEL_IDS[value.trim().toUpperCase()] ?? value));
  if (models.some(model => !model)) throw new Error("Printer reported an unknown model identity; cannot verify this printer.");
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
  return { model, observedSerial: serials[0], identitySource: declarations.length ? "report" : "module-serial" };
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
    // Publish only; an ACK wait would add a dependency that H2 firmware lacks.
    void Promise.all([publishBambuCommand(printer, "pushing", "pushall"), publishBambuCommand(printer, "info", "get_version")])
      .then(() => { requestsPublished = true; maybeResolve(); }, fail);
  });
}

export interface PrinterStateRequirements {
  model: string;
  nozzleDiameters: number[];
  materials?: string[];
  usedFilamentPositions?: number[];
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

function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
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
        const stat = finiteNumber(entry.stat);
        if (stat === undefined || !Number.isInteger(stat) || stat < 0 || (stat & 7) !== 0) throw new Error(`Printer nozzle ${index} information is unreliable, abnormal or unknown.`);
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

function validateErrors(raw: Record<string,any>, requireIdle: boolean) {
  const state = typeof raw.gcode_state === "string" ? raw.gcode_state.toUpperCase() : "UNKNOWN";
  if (requireIdle && !["IDLE","FINISH"].includes(state)) throw new Error(`Printer state ${state} is not safely idle.`);
  if (!requireIdle && !["IDLE","FINISH","RUNNING","PAUSE"].includes(state)) throw new Error(`Printer state ${state} is unknown or failed.`);
  if (finiteNumber(raw.print_error) !== 0) throw new Error("Printer reports a print error or did not report its error state.");
  if (!Array.isArray(raw.hms)) throw new Error("Printer HMS error state is missing or malformed.");
  for (const entry of raw.hms) {
    const code = finiteNumber(entry?.code);
    const attr = finiteNumber(entry?.attr);
    // BambuStudio DevHMS.cpp: code >> 16; DevHMS.h: 1=fatal,2=serious,3=common,4=info.
    // Unknown severities fail closed; attr identifies the module and is not a severity bitmask.
    if (code === undefined || attr === undefined || !Number.isInteger(code) || !Number.isInteger(attr) || code < 0 || code > 0xffffffff || attr < 0 || attr > 0xffffffff || Math.floor(code / 65536) !== 4) {
      const hex = (value: number) => value.toString(16).toUpperCase().padStart(8, "0");
      const label = code !== undefined && attr !== undefined && Number.isInteger(code) && Number.isInteger(attr) && code >= 0 && attr >= 0
        ? ` (HMS ${hex(attr).slice(0, 4)}-${hex(attr).slice(4)}-${hex(code).slice(0, 4)}-${hex(code).slice(4)})` : "";
      throw new Error(`Printer reports actionable or unknown HMS errors${label}; inspect and resolve them on the printer before proceeding.`);
    }
  }
}
function trayRange(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === "" || value === "0" || value === 0) return undefined;
  const number = finiteNumber(value);
  if (number === undefined || number <= 0) throw new Error(`Reported filament ${label} temperature is malformed.`);
  return number;
}
function externalTray(raw: Record<string,any>): Record<string,any> | undefined {
  const slots = raw.vir_slot;
  if (Array.isArray(slots)) {
    const selected = slots.filter((slot:any) => Number(slot?.id) === 254);
    if (slots.length === 1 && selected.length === 1) return selected[0];
    if (slots.length > 0) throw new Error("External spool report is ambiguous for this nozzle; cannot verify the selected material.");
  }
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
  validateErrors(raw, requirements.requireIdle !== false);
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
  if (requirements.nozzleDiameters.length && ["h2d","h2dpro","h2c","x2d"].includes(model) &&
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
    if (!positions.length) throw new Error("A declared material is required for each used filament or external spool.");
    for (const position of positions) {
      const material = normalizeMaterial(materials[position]);
      if (!Number.isInteger(position) || position < 0 || !material) throw new Error(`A known declared material is required for filament position ${position}.`);
      const trayIndex = requirements.useAMS ? requirements.amsMapping?.[position] : 254;
      if (trayIndex === undefined || !Number.isInteger(trayIndex) || trayIndex < 0 || trayIndex > 254) throw new Error(`Complete AMS mapping is required for filament position ${position}.`);
      const tray = trayIndex === 254 ? externalTray(raw) : mappedTray(raw,trayIndex);
      const reportedType = typeof tray?.tray_type === "string" ? tray.tray_type.trim() : "";
      if (reportedType && normalizeMaterial(reportedType) !== material) throw new Error(`Reported material ${reportedType} in slot ${trayIndex} contradicts declared ${materials[position]}.`);
      const nozzleMin = trayRange(tray?.nozzle_temp_min,"minimum");
      const nozzleMax = trayRange(tray?.nozzle_temp_max,"maximum");
      if (nozzleMin !== undefined && nozzleMax !== undefined && nozzleMin > nozzleMax) throw new Error(`Reported filament temperature range in slot ${trayIndex} is invalid.`);
      filaments.push({position,material,trayIndex,nozzleMin,nozzleMax});
    }
  }
  return {model,reportedNozzles:nozzles,filaments};
}

/** Manual M104 cannot remap filament slots. Validate the material already at the nozzle. */
export function manualHeatingRequirements(status: any, model: string, nozzleDiameter: number, material: string): PrinterStateRequirements {
  const normalized = normalizeModel(model);
  if (!normalized) throw new Error("A known printer model is required for manual nozzle heating.");
  const raw = status?.raw;
  if (!object(raw)) throw new Error("A fresh printer report is required for manual nozzle heating.");
  if (["h2d","h2dpro","h2c","x2d"].includes(normalized) || reportedNozzles(raw).some(nozzle => nozzle.index !== 0)) {
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
