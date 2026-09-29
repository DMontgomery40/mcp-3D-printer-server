import { createHash } from "node:crypto";
import { readBoundedPrintFile } from "./archive.js";
import { materialNozzleCeiling, normalizeMaterial } from "./limits.js";

/**
 * Thermal safety for printers without a Bambu model table (OctoPrint,
 * Klipper/Moonraker, Duet/RepRapFirmware, Repetier, PrusaLink, Creality).
 *
 * There is no invented per-model table. Independent server-side ceilings apply
 * to every heater and can only be changed through the server environment; a
 * tool argument or a file can never raise them. Material ceilings are shared
 * with the Bambu path (limits.ts) and positive nozzle heating always needs a
 * declared material.
 */
export type Heater = "nozzle" | "bed" | "chamber";
export interface HeaterCeilings { nozzle: number; bed: number; chamber: number }

export const DEFAULT_GENERIC_CEILINGS: Readonly<HeaterCeilings> = { nozzle: 300, bed: 120, chamber: 60 };
const CEILING_ENV: Readonly<Record<Heater, string>> = {
  nozzle: "PRINTER_MAX_NOZZLE_TEMP",
  bed: "PRINTER_MAX_BED_TEMP",
  chamber: "PRINTER_MAX_CHAMBER_TEMP",
};
// Typo guard for the environment override, not a hardware claim.
const ENV_SANITY_MAX: Readonly<HeaterCeilings> = { nozzle: 500, bed: 200, chamber: 100 };

/** Resolve ceilings from the server environment; an invalid override refuses heating. */
export function genericCeilings(env: NodeJS.ProcessEnv = process.env): HeaterCeilings {
  const ceilings: HeaterCeilings = { ...DEFAULT_GENERIC_CEILINGS };
  for (const heater of ["nozzle", "bed", "chamber"] as const) {
    const raw = env[CEILING_ENV[heater]]?.trim();
    if (!raw) continue;
    const value = Number(raw);
    if (!/^\d+(?:\.\d+)?$/.test(raw) || !Number.isFinite(value) || value > ENV_SANITY_MAX[heater]) {
      throw new Error(
        `${CEILING_ENV[heater]} must be a number from 0 to ${ENV_SANITY_MAX[heater]} °C; received "${raw}". ` +
        "Positive heating and printing are refused until the server configuration is corrected."
      );
    }
    ceilings[heater] = value;
  }
  return ceilings;
}

export function finiteTemperature(value: unknown, label = "temperature"): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite, non-negative number in °C; received ${String(value)}.`);
  }
  return value;
}

/** Check one heater target against server ceilings and every candidate material. */
export function validateGenericTemperature(
  heater: Heater,
  value: unknown,
  materials: readonly string[] | undefined,
  ceilings: HeaterCeilings = genericCeilings()
): number {
  const temperature = finiteTemperature(value, `${heater} temperature`);
  // Switching a heater off never needs a declaration.
  if (temperature === 0) return 0;
  if (temperature > ceilings[heater]) {
    throw new Error(
      `Print safety: ${heater} temperature ${temperature} C exceeds the ${ceilings[heater]} C server ceiling ` +
      `(${CEILING_ENV[heater]}). Tool arguments and files cannot raise it.`
    );
  }
  if (heater === "nozzle") {
    if (!materials?.length) {
      throw new Error(
        "Print safety: positive nozzle heating requires a declared material. Slice with filament_type metadata " +
        "(for example '; filament_type = PLA') or pass material (PLA, PETG, ABS, ASA, TPU, PA, PC, ...)."
      );
    }
    for (const declared of materials) {
      const ceiling = materialNozzleCeiling(declared);
      if (ceiling === undefined) {
        throw new Error(
          `Print safety: unknown material '${declared}' cannot authorize nozzle heating. ` +
          "Pass material with a known type such as PLA, PETG, ABS, ASA, TPU, PA or PC."
        );
      }
      if (temperature > ceiling) {
        throw new Error(
          `Print safety: ${normalizeMaterial(declared)} nozzle temperature ${temperature} C exceeds the independent ${ceiling} C material policy limit.`
        );
      }
    }
  }
  return temperature;
}

export interface ThermalTarget {
  line: number;
  command: string;
  heater: Heater;
  value: number;
  /** Physical tool index when known; undefined means any tool may be affected. */
  tool?: number;
}

export interface GcodeThermalScan {
  targets: ThermalTarget[];
  /** Raw slicer filament_type declarations, per tool, when present. */
  declaredMaterials?: string[];
  commandCount: number;
}

const NUMBER = String.raw`[+-]?(?:\d+(?:\.\d*)?|\.\d+)`;
const PARAMETER = new RegExp(`^([A-Z])\\s*(${NUMBER}(?::${NUMBER})*)?`, "i");
const fail = (message: string): never => { throw new Error(`Print safety: ${message}`); };

// Commands whose trailing text is free-form display text, never parameters.
const DISPLAY_COMMANDS = new Set(["M0", "M1", "M117", "M118", "M291", "M292"]);
// Not permitted inside a print job: they change heater limits, tune or create
// heaters, switch temperature units, or run/write another uninspected program.
const REFUSED_COMMANDS: Readonly<Record<string, string>> = {
  M143: "changes the firmware heater maximum",
  M301: "changes hotend heater control",
  M304: "changes bed heater control",
  M306: "changes the heater model",
  M307: "changes the heater model",
  M303: "runs a heater autotune",
  M570: "changes heater fault detection",
  M950: "creates or remaps a heater",
  M149: "changes temperature units",
  M98: "runs a printer-side macro file",
  M32: "starts another print file",
  M23: "selects another print file",
  M24: "starts another print file",
  M28: "writes a new file to printer storage",
  M29: "writes a new file to printer storage",
  M30: "deletes or ends a printer-side file",
  M997: "updates firmware",
};
const EMBEDDED_THERMAL = /(?:^|[\s;])(?:M0*(?:104|109|140|190|141|191|568|303|143)|G0*10)(?![\d.])/i;

function parseParameters(text: string, code: string, allowed: string, flags = ""): Map<string, number[]> {
  const result = new Map<string, number[]>();
  let rest = text.trim();
  while (rest) {
    const token = rest.match(PARAMETER);
    if (!token) return fail(`unsupported ${code} parameter syntax '${rest.slice(0, 40)}'`);
    const key = token[1].toUpperCase();
    if (!allowed.includes(key)) return fail(`unsupported ${code} parameter ${key}; thermal inspection fails closed`);
    if (result.has(key)) return fail(`duplicate ${code} parameter ${key}`);
    if (token[2] === undefined && !flags.includes(key)) return fail(`missing numeric ${code} ${key} value`);
    const values = token[2] === undefined ? [] : token[2].split(":").map(Number);
    if (values.some((value) => !Number.isFinite(value))) return fail(`nonfinite ${code} ${key} value`);
    result.set(key, values);
    rest = rest.slice(token[0].length).trimStart();
  }
  return result;
}

function toolIndex(values: number[] | undefined, code: string): number | undefined {
  if (values === undefined) return undefined;
  if (values.length !== 1 || !Number.isInteger(values[0]) || values[0] < 0) return fail(`${code} tool index must be a nonnegative integer`);
  return values[0];
}

function heaterForKlipperName(name: string): { heater: Heater; tool?: number } | undefined {
  const normalized = name.trim().replace(/^"|"$/g, "").toLowerCase();
  const extruder = normalized.match(/^extruder(\d*)$/);
  if (extruder) return { heater: "nozzle", tool: extruder[1] ? Number(extruder[1]) : 0 };
  if (normalized === "heater_bed" || normalized === "bed") return { heater: "bed" };
  if (/(?:^|[\s_])chamber(?:$|[\s_])|^chamber/.test(normalized)) return { heater: "chamber" };
  return undefined;
}

/** Best-effort classification of printer macro parameters that name a heater. */
function macroParameterHeater(key: string): Heater | "ambiguous" | undefined {
  const upper = key.toUpperCase();
  const namesHeater = /^(?:BED|HEATER_BED|EXTRUDER\d*|HOTEND|NOZZLE|CHAMBER)$/.test(upper);
  if (!namesHeater && !/TEMP/.test(upper)) return undefined;
  if (/BED/.test(upper)) return "bed";
  if (/CHAMBER/.test(upper)) return "chamber";
  if (/EXTRUDER|HOTEND|NOZZLE|TOOL/.test(upper)) return "nozzle";
  return "ambiguous";
}

/**
 * Parse every heater target in G-code text. This deliberately covers only
 * commands that affect heat; unrelated vendor commands do not need a global
 * allowlist. It cannot simulate printer-side macro bodies: Klipper macro
 * parameters that name a heater are checked, but a macro's own body is printer
 * configuration outside the uploaded file.
 */
export function scanGcodeThermal(text: string): GcodeThermalScan {
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f�]/.test(text)) {
    return fail("binary or malformed G-code cannot be inspected; export plain-text G-code (not .bgcode)");
  }
  const lines = text.split(/\r\n|\n|\r/);
  const targets: ThermalTarget[] = [];
  const declarations: string[][] = [];
  let activeTool: number | undefined;
  let commandCount = 0;

  for (let index = 0; index < lines.length; index++) {
    const lineNumber = index + 1;
    try {
      const raw = lines[index];
      const metadata = raw.match(/^\s*;\s*filament_type\s*[=:]\s*(.*?)\s*$/i);
      if (metadata) {
        const values = metadata[1].split(/[;,]/).map((value) => value.trim().replace(/^"|"$/g, "")).filter(Boolean);
        if (!values.length) fail("empty filament_type metadata");
        declarations.push(values);
        continue;
      }
      let line = raw;
      const comment = line.indexOf(";");
      if (comment >= 0) line = line.slice(0, comment);
      line = line.trim().replace(/^N\d+\s*/i, "").replace(/\*\d+\s*$/, "").trim();
      if (!line || line === "%") continue;

      const classic = line.match(/^([GMT])\s*(-?\d+(?:\.\d+)?)/i);
      if (!classic) {
        commandCount++;
        const word = line.match(/^([A-Za-z_][A-Za-z0-9_]*)/)?.[1]?.toUpperCase() ?? "";
        if (/^T[XC?]$/.test(word) || /^T\?/.test(line)) { activeTool = undefined; continue; }
        if (["RESPOND", "M117", "TEMPERATURE_WAIT", "SET_TEMPERATURE_FAN_TARGET"].includes(word)) continue;
        const rest = line.slice(word.length);
        const pairs = [...rest.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("[^"]*"|'[^']*'|\S+)/g)];
        if (word === "SET_HEATER_TEMPERATURE") {
          const params = new Map(pairs.map((pair) => [pair[1].toUpperCase(), pair[2]]));
          for (const key of params.keys()) if (!["HEATER", "TARGET"].includes(key)) fail(`unsupported SET_HEATER_TEMPERATURE parameter ${key}`);
          const heaterName = params.get("HEATER");
          const heater = heaterName ? heaterForKlipperName(heaterName) : undefined;
          if (!heater) fail(`SET_HEATER_TEMPERATURE heater '${heaterName ?? ""}' is unknown; cannot establish its ceiling`);
          const target = params.get("TARGET");
          if (target !== undefined) {
            if (!new RegExp(`^${NUMBER}$`).test(target)) fail(`SET_HEATER_TEMPERATURE TARGET '${target}' is not a literal number`);
            targets.push({ line: lineNumber, command: word, heater: heater!.heater, value: Number(target), tool: heater!.tool });
          }
          continue;
        }
        for (const [, key, value] of pairs) {
          const heater = macroParameterHeater(key);
          if (!heater) continue;
          if (heater === "ambiguous") fail(`${word} parameter ${key} looks like a temperature but does not name its heater; use BED/EXTRUDER/CHAMBER names`);
          if (!new RegExp(`^${NUMBER}$`).test(value)) fail(`${word} ${key}='${value}' is not a literal number (unresolved placeholder?)`);
          targets.push({ line: lineNumber, command: word, heater: heater as Heater, value: Number(value), tool: heater === "nozzle" ? activeTool : undefined });
        }
        continue;
      }

      commandCount++;
      const letter = classic[1].toUpperCase();
      const [base, sub] = classic[2].split(".");
      const code = `${letter}${Number(base)}${sub === undefined ? "" : `.${sub}`}`;
      const argumentsText = line.slice(classic[0].length);
      if (DISPLAY_COMMANDS.has(code)) continue;
      if (letter === "T") {
        const tool = Number(base);
        activeTool = sub === undefined && Number.isInteger(tool) && tool >= 0 ? tool : undefined;
        if (EMBEDDED_THERMAL.test(argumentsText)) fail("multiple commands on one line are unsupported");
        continue;
      }
      if (REFUSED_COMMANDS[code]) fail(`${code} ${REFUSED_COMMANDS[code]} and is not permitted in a checked print job`);
      if (/^M(?:104|109|140|190|141|191|568)\./.test(code) || /^G10\./.test(code)) {
        fail(`unsupported thermal command variant ${code}; re-slice with standard heater commands`);
      }
      if (code === "M104" || code === "M109") {
        // Marlin B is the AUTOTEMP maximum target; I would select an unknown preset.
        const params = parseParameters(argumentsText, code, "SRTBF", "F");
        const tool = toolIndex(params.get("T"), code) ?? activeTool;
        for (const key of ["S", "R", "B"]) {
          for (const value of params.get(key) ?? []) targets.push({ line: lineNumber, command: code, heater: "nozzle", value, tool });
        }
      } else if (["M140", "M190", "M141", "M191"].includes(code)) {
        const params = parseParameters(argumentsText, code, "SRPH");
        const heater: Heater = code === "M140" || code === "M190" ? "bed" : "chamber";
        for (const key of ["S", "R"]) {
          for (const value of params.get(key) ?? []) targets.push({ line: lineNumber, command: code, heater, value });
        }
      } else if (code === "G10") {
        // RepRapFirmware tool temperatures; with L it sets coordinates instead.
        const params = parseParameters(argumentsText, code, "PSRLXYZUVWABCEIJK");
        if (!params.has("L") && (params.has("S") || params.has("R"))) {
          const tool = toolIndex(params.get("P"), code) ?? activeTool;
          for (const key of ["S", "R"]) {
            for (const value of params.get(key) ?? []) targets.push({ line: lineNumber, command: code, heater: "nozzle", value, tool });
          }
        }
      } else if (code === "M568") {
        const params = parseParameters(argumentsText, code, "PSRAF");
        const tool = toolIndex(params.get("P"), code) ?? activeTool;
        for (const key of ["S", "R"]) {
          for (const value of params.get(key) ?? []) targets.push({ line: lineNumber, command: code, heater: "nozzle", value, tool });
        }
      } else if (EMBEDDED_THERMAL.test(argumentsText)) {
        fail("multiple commands on one line are unsupported");
      }
    } catch (error) {
      throw new Error(`Print safety line ${lineNumber}: ${(error instanceof Error ? error.message : String(error)).replace(/^Print safety: /, "")}`);
    }
  }

  let declaredMaterials: string[] | undefined;
  if (declarations.length) {
    const first = JSON.stringify(declarations[0]);
    if (declarations.some((values) => JSON.stringify(values) !== first)) fail("contradictory filament_type metadata");
    declaredMaterials = declarations[0];
  }
  return { targets, declaredMaterials, commandCount };
}

export interface GenericPrintInspection {
  sha256: string;
  /** Materials used for ceilings, per tool (normalized when known). */
  materials: string[];
  materialSource: "file" | "declared" | "none";
  peaks: HeaterCeilings;
  ceilings: HeaterCeilings;
  targetCount: number;
}

/** Resolve the caller's declaration against the file's slicer metadata. */
function resolveMaterials(fileMaterials: string[] | undefined, declared: string | undefined): { materials: string[]; source: GenericPrintInspection["materialSource"] } {
  if (declared !== undefined) {
    const normalized = normalizeMaterial(declared);
    if (!normalized) {
      return fail(`unknown declared material '${declared}'; use a known type such as PLA, PETG, ABS, ASA, TPU, PA or PC`);
    }
    for (const fileMaterial of fileMaterials ?? []) {
      const fileNormalized = normalizeMaterial(fileMaterial);
      // A known file declaration can never be relabelled by an argument.
      if (fileNormalized && fileNormalized !== normalized) {
        return fail(`declared material ${declared} contradicts the G-code filament_type ${fileMaterial}`);
      }
    }
    return { materials: [declared], source: "declared" };
  }
  if (fileMaterials?.length) return { materials: fileMaterials, source: "file" };
  return { materials: [], source: "none" };
}

/** Inspect exact G-code bytes: every heater target against ceilings and materials. */
export function inspectGcodeThermal(bytes: Buffer | string, options: { material?: string; ceilings?: HeaterCeilings } = {}): GenericPrintInspection {
  const buffer = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  const ceilings = options.ceilings ?? genericCeilings();
  const scan = scanGcodeThermal(buffer.toString("utf8"));
  if (!scan.commandCount) return fail("the G-code contains no printable commands");
  const { materials, source } = resolveMaterials(scan.declaredMaterials, options.material);
  const peaks: HeaterCeilings = { nozzle: 0, bed: 0, chamber: 0 };
  for (const target of scan.targets) {
    let candidates: string[] | undefined;
    if (target.heater === "nozzle") {
      if (materials.length <= 1) candidates = materials;
      else if (target.tool === undefined) candidates = materials; // unknown tool: every material must allow it
      else if (target.tool < materials.length) candidates = [materials[target.tool]];
      else fail(`line ${target.line}: tool ${target.tool} has no declared material`);
    }
    try {
      validateGenericTemperature(target.heater, target.value, candidates, ceilings);
    } catch (error) {
      throw new Error(`Print safety line ${target.line} (${target.command}): ${(error instanceof Error ? error.message : String(error)).replace(/^Print safety: /, "")}`);
    }
    peaks[target.heater] = Math.max(peaks[target.heater], target.value);
  }
  return {
    sha256: createHash("sha256").update(buffer).digest("hex"),
    materials: materials.map((material) => normalizeMaterial(material) ?? material),
    materialSource: source,
    peaks,
    ceilings,
    targetCount: scan.targets.length,
  };
}

const INSPECTABLE_GCODE = /\.(?:gcode|gco|g)$/i;

export function assertInspectableGcodeName(name: string): void {
  if (!INSPECTABLE_GCODE.test(name)) {
    fail(`'${name}' is not plain-text G-code (.gcode, .gco or .g). Binary .bgcode and project files cannot be inspected for heater targets`);
  }
}

/** Read a bounded file and inspect it. */
export async function inspectGcodeFile(filePath: string, options: { material?: string; ceilings?: HeaterCeilings } = {}): Promise<GenericPrintInspection> {
  return inspectGcodeThermal(await readBoundedPrintFile(filePath), options);
}
