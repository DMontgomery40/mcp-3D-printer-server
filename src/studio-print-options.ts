/**
 * The print options Bambu Studio's Send dialog sends, resolved the way it
 * resolves them, for the vendor SDK. Direct routes report which options their verified
 * wire format can carry; this does not establish SDK packet equivalence. Source: Bambu Studio v02.08.02.61 (commit 926a7192574b), the version
 * the hidden-HMS and stage tables are pinned to:
 *
 * - SelectMachine.cpp:3344-3356 `set_print_config(bed_type,
 *   bed_leveling == "on", flow_cali == "on", false, timelapse, true,
 *   ext_change_assist, bed_leveling.getValueInt(), flow_cali.getValueInt(),
 *   nozzle_offset_cali.getValueInt(), pa_value_switch ? 0 : 1)`. Vibration
 *   calibration is always false and layer inspection always true; the
 *   parameter order is PrintJob.hpp:98-116.
 * - SelectMachine.cpp:7318-7329 `getValueInt`: off 0, on 1, auto 2.
 * - SelectMachine.cpp:1117-1123 `update_select_layout`: update_option_opts
 *   (which choices each option offers on this printer) runs before
 *   load_option_vals.
 * - SelectMachine.cpp:2993-3027 `load_option_vals`: the value saved in
 *   BambuStudio.conf under the printer type, if the option offers it; else
 *   "auto" if offered; else "on". Dual-nozzle printers then set nozzle offset
 *   calibration to "auto" for a two-nozzle job and, without a filament
 *   switcher, "off" for a one-nozzle job.
 * - SelectMachine.cpp:2586-2615 `update_option_opts`: bed leveling offers
 *   auto/on/off when the printer's support_bed_leveling is 2 and on/off when it
 *   is 1; with 0 it is hidden and keeps the auto/on/off it was built with
 *   (SelectMachine.cpp:676-691), as does flow calibration when the printer has
 *   no PA calibration. DeviceManager.cpp:1100/4441 give P-series printers
 *   (series_p1p: P1P, P1S) no PA calibration, so their flow calibration is
 *   hidden and resolves to "auto". Nozzle offset calibration always offers auto.
 * - SelectMachine.cpp:705-707: the PA value switch starts on and is not saved,
 *   so extruder_cali_manual_mode is 0.
 *
 * Approximations, outside the P1P/P1S: flow calibration on other printers is
 * shown when the printer's push status reports PA calibration (assumed here),
 * and offers auto when support_auto_flow_calibration is true and the mapped
 * filaments allow it (can_support_pa_auto_cali, assumed true). A filament
 * switcher on a dual-nozzle printer is assumed absent.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type StudioOptionValue = "off" | "on" | "auto";
type Offers = readonly StudioOptionValue[];
const AUTO_ON_OFF: Offers = ["auto", "on", "off"];
const ON_OFF: Offers = ["on", "off"];

/**
 * Studio's printer types (resources/printers/<type>.json at the pinned commit:
 * model_id/printer_type, printer_series, support_bed_leveling,
 * support_auto_flow_calibration), keyed by this server's model names.
 */
const STUDIO_PRINTERS: Record<string, { types: string[]; pSeries: boolean; bedLeveling: 0 | 1 | 2; autoFlow: boolean; dualNozzle: boolean }> = {
  p1p: { types: ["C11"], pSeries: true, bedLeveling: 1, autoFlow: false, dualNozzle: false },
  p1s: { types: ["C12"], pSeries: true, bedLeveling: 1, autoFlow: false, dualNozzle: false },
  x1c: { types: ["3DPrinter-X1-Carbon"], pSeries: false, bedLeveling: 1, autoFlow: false, dualNozzle: false },
  x1: { types: ["3DPrinter-X1"], pSeries: false, bedLeveling: 1, autoFlow: false, dualNozzle: false },
  x1e: { types: ["C13"], pSeries: false, bedLeveling: 1, autoFlow: false, dualNozzle: false },
  a1mini: { types: ["N1"], pSeries: false, bedLeveling: 1, autoFlow: false, dualNozzle: false },
  a1: { types: ["N2S"], pSeries: false, bedLeveling: 1, autoFlow: false, dualNozzle: false },
  p2s: { types: ["N7"], pSeries: false, bedLeveling: 2, autoFlow: true, dualNozzle: false },
  x2d: { types: ["N6"], pSeries: false, bedLeveling: 2, autoFlow: true, dualNozzle: true },
  h2s: { types: ["O1S"], pSeries: false, bedLeveling: 2, autoFlow: true, dualNozzle: false },
  h2d: { types: ["O1D"], pSeries: false, bedLeveling: 2, autoFlow: true, dualNozzle: true },
  h2dpro: { types: ["O1E"], pSeries: false, bedLeveling: 2, autoFlow: true, dualNozzle: true },
  h2c: { types: ["O1C", "O1C2"], pSeries: false, bedLeveling: 2, autoFlow: true, dualNozzle: true },
};

export type StudioOptionSource = "caller" | "studio-config" | "studio-default";

/** Explicit caller choices; each one wins over Studio's resolution. */
export type CallerPrintOptions = {
  bedLeveling?: boolean;
  flowCalibration?: boolean;
  vibrationCalibration?: boolean;
  layerInspect?: boolean;
  /** 0 off, 1 on, 2 auto, as Studio's getValueInt. */
  autoBedLeveling?: number;
  autoFlowCali?: number;
  autoOffsetCali?: number;
  extruderCaliManualMode?: number;
};

export type StudioPrintOptions = {
  printerType?: string;
  values: { bed_leveling: StudioOptionValue; flow_cali: StudioOptionValue; nozzle_offset_cali: StudioOptionValue };
  sources: { bed_leveling: StudioOptionSource; flow_cali: StudioOptionSource; nozzle_offset_cali: StudioOptionSource };
  task_bed_leveling: boolean;
  task_flow_cali: boolean;
  task_vibration_cali: boolean;
  task_layer_inspect: boolean;
  auto_bed_leveling: number;
  auto_flow_cali: number;
  auto_offset_cali: number;
  extruder_cali_manual_mode: number;
};

/** Where Studio keeps BambuStudio.conf; BAMBU_STUDIO_CONFIG overrides it (empty: none). */
export function studioConfigPath(): string | undefined {
  const override = process.env.BAMBU_STUDIO_CONFIG;
  if (override !== undefined) return override.trim() || undefined;
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "BambuStudio", "BambuStudio.conf");
  if (process.platform === "win32") return process.env.APPDATA ? path.join(process.env.APPDATA, "BambuStudio", "BambuStudio.conf") : undefined;
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "BambuStudio", "BambuStudio.conf");
}

/**
 * The Send dialog options Studio saved for a printer type, and nothing else:
 * BambuStudio.conf also holds access codes, so only that one section is kept,
 * and a parse failure is reported without any of the file's text.
 */
export function readStudioSavedOptions(printerTypes: string[], configPath: string | undefined): Record<string, string> | undefined {
  if (!configPath) return undefined;
  let text: string;
  try {
    const stat = fs.statSync(configPath);
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) return undefined;
    text = fs.readFileSync(configPath, "utf8");
  } catch { return undefined; }
  let config: unknown;
  // Studio appends "# MD5 checksum <hex>" after the JSON.
  try { config = JSON.parse(text.split("\n").filter(line => !line.trimStart().startsWith("#")).join("\n")); }
  catch { return undefined; }
  if (!config || typeof config !== "object") return undefined;
  for (const type of printerTypes) {
    const section = (config as Record<string, unknown>)[type];
    if (!section || typeof section !== "object" || Array.isArray(section)) continue;
    const saved: Record<string, string> = {};
    for (const key of ["bed_leveling", "flow_cali", "nozzle_offset_cali", "timelapse"]) {
      const value = (section as Record<string, unknown>)[key];
      if (typeof value === "string") saved[key] = value;
    }
    return saved;
  }
  return undefined;
}

function fromInt(value: number, label: string): StudioOptionValue {
  if (value === 0) return "off";
  if (value === 1) return "on";
  if (value === 2) return "auto";
  throw new Error(`${label} must be 0 (off), 1 (on) or 2 (auto).`);
}

const toInt = (value: StudioOptionValue) => value === "off" ? 0 : value === "on" ? 1 : 2;

/** load_option_vals for one option: saved if offered, else auto if offered, else on. */
function loaded(saved: string | undefined, offers: Offers): { value: StudioOptionValue; source: StudioOptionSource } {
  if (saved !== undefined && (offers as readonly string[]).includes(saved)) return { value: saved as StudioOptionValue, source: "studio-config" };
  return { value: offers.includes("auto") ? "auto" : "on", source: "studio-default" };
}

/**
 * What Studio's Send dialog would send for this model, with the caller's
 * explicit choices taking precedence. usedNozzles is the number of nozzles the
 * job uses, for dual-nozzle printers.
 */
export function resolveStudioPrintOptions(model: string, caller: CallerPrintOptions = {}, options: { usedNozzles?: number; configPath?: string } = {}): StudioPrintOptions {
  const printer = STUDIO_PRINTERS[model];
  const saved = printer ? readStudioSavedOptions(printer.types, "configPath" in options ? options.configPath : studioConfigPath()) ?? {} : {};
  const printerType = printer?.types[0];

  const bedOffers = !printer || printer.bedLeveling !== 1 ? AUTO_ON_OFF : ON_OFF;
  const flowOffers = !printer || printer.pSeries || printer.autoFlow ? AUTO_ON_OFF : ON_OFF;
  const bed = loaded(saved.bed_leveling, bedOffers);
  const flow = loaded(saved.flow_cali, flowOffers);
  let offset = loaded(saved.nozzle_offset_cali, AUTO_ON_OFF);
  if (printer?.dualNozzle && options.usedNozzles !== undefined) {
    if (options.usedNozzles >= 2) offset = { value: "auto", source: "studio-default" };
    else if (options.usedNozzles === 1) offset = { value: "off", source: "studio-default" };
  }

  const choose = (current: { value: StudioOptionValue; source: StudioOptionSource }, auto: number | undefined, flag: boolean | undefined, label: string) =>
    auto !== undefined ? { value: fromInt(auto, label), source: "caller" as const }
      : flag !== undefined ? { value: flag ? "on" as const : "off" as const, source: "caller" as const }
        : current;
  const bedLeveling = choose(bed, caller.autoBedLeveling, caller.bedLeveling, "auto_bed_leveling");
  const flowCali = choose(flow, caller.autoFlowCali, caller.flowCalibration, "auto_flow_cali");
  const nozzleOffset = choose(offset, caller.autoOffsetCali, undefined, "auto_offset_cali");
  const manualMode = caller.extruderCaliManualMode ?? 0;
  if (!Number.isInteger(manualMode) || manualMode < -1 || manualMode > 1) throw new Error("extruder_cali_manual_mode must be -1, 0 or 1.");

  return {
    ...(printerType ? { printerType } : {}),
    values: { bed_leveling: bedLeveling.value, flow_cali: flowCali.value, nozzle_offset_cali: nozzleOffset.value },
    sources: { bed_leveling: bedLeveling.source, flow_cali: flowCali.source, nozzle_offset_cali: nozzleOffset.source },
    task_bed_leveling: bedLeveling.value === "on",
    task_flow_cali: flowCali.value === "on",
    task_vibration_cali: caller.vibrationCalibration ?? false,
    task_layer_inspect: caller.layerInspect ?? true,
    auto_bed_leveling: toInt(bedLeveling.value),
    auto_flow_cali: toInt(flowCali.value),
    auto_offset_cali: toInt(nozzleOffset.value),
    extruder_cali_manual_mode: manualMode,
  };
}

/** The number of nozzles a job's used filaments print from, when the inspection knows. */
export function usedNozzleCount(inspection: { usedFilamentPositions: number[]; filamentNozzleIndices?: Array<number | undefined> }): number | undefined {
  const nozzles = inspection.usedFilamentPositions.map(position => inspection.filamentNozzleIndices?.[position]).filter((value): value is number => Number.isInteger(value));
  return nozzles.length === inspection.usedFilamentPositions.length && nozzles.length ? new Set(nozzles).size : undefined;
}

/** Report only verified direct-wire fields. A task boolean is not an SDK mode.
 * null means this route does not transmit that option, not off/auto/unknown hardware state. */
export function directPrintOptionReport(caller: CallerPrintOptions, resolved: StudioPrintOptions, packet: Record<string, unknown>) {
  const fields = {
    bedLeveling: ["task_bed_leveling", "bed_leveling"],
    flowCalibration: ["task_flow_cali", "flow_cali"],
    vibrationCalibration: ["task_vibration_cali", "vibration_cali"],
    layerInspect: ["task_layer_inspect", "layer_inspect"],
    autoBedLeveling: ["auto_bed_leveling", "auto_bed_leveling"],
    autoFlowCali: ["auto_flow_cali", "auto_flow_cali"],
    autoOffsetCali: ["auto_offset_cali", "nozzle_offset_cali"],
    extruderCaliManualMode: ["extruder_cali_manual_mode", "extrude_cali_manual_mode"],
  } as const;
  const requested: CallerPrintOptions = {};
  const transmitted: Record<string, boolean | number | null> = {};
  const unsupported: string[] = [];
  for (const key of Object.keys(fields) as Array<keyof CallerPrintOptions>) {
    const [sdk, wire] = fields[key];
    if (caller[key] !== undefined) Object.assign(requested, { [key]: caller[key] });
    const value = packet[wire];
    transmitted[sdk] = typeof value === "boolean" || typeof value === "number" ? value : null;
    if (caller[key] !== undefined && transmitted[sdk] === null) unsupported.push(key);
  }
  const omitted = Object.keys(transmitted).filter(key => transmitted[key] === null);
  const warning = omitted.length
    ? `Direct print options not transmitted: ${omitted.join(", ")}. Task booleans are not equivalent to Studio integer modes.` +
      (unsupported.length ? ` Requested overrides unsupported by this route: ${unsupported.join(", ")}. Use a vendor bridge/native route that supports these options if required.` : "")
    : undefined;
  return { requested, resolved, transmitted, unsupported, ...(warning ? { warning } : {}) };
}
