/**
 * counterpart_setup_fields (counterpart/1): the printers this server drives (each PRINTER_TYPE) and the settings it reads for each, by the
 * environment variable names it reads (first canonical, then aliases). A client renders these fields, writes the values
 * to this server's .env and never needs its own printer or model tables. Pure: no printer traffic, no secrets returned.
 */
import { normalizeModel } from "../safety/limits.js";
import { SERIAL_MODELS } from "../safety/printer-state.js";
import { COUNTERPART_CONTRACT, PRINTER_KINDS } from "./contract.js";

export const SETUP_FIELD_NAMES = ["host", "port", "serial", "model", "secret", "slicer", "slicer-path", "profiles"] as const;
export type SetupField = {
  /** The client's form field this is: an address, a port, a serial number, a model choice or a secret. */
  name: typeof SETUP_FIELD_NAMES[number];
  env: string; aliases?: string[]; label: string; hint?: string; required: boolean;
  /** A path on this computer (a slicer app, a profiles folder): a client may offer a file chooser. */
  input?: "path";
  /** Written as typed, or upper-cased (Bambu serial numbers). */
  transform?: "uppercase";
  choices?: Array<{ value: string; label: string }>;
  /** A model field: the model a serial number names, by its first `prefixLength` characters. */
  fromSerial?: { prefixLength: number; models: Record<string, string> };
};
export type SetupKind = {
  kind: typeof PRINTER_KINDS[number]; label: string;
  /** Values this server needs for the kind whatever the person enters (MCP_TRANSPORT, PRINTER_TYPE). */
  env: Record<string, string>;
  /** The kind this server runs when a .env sets none of these values (no PRINTER_TYPE). */
  default?: boolean;
  fields: SetupField[];
};
/** The slicer this server runs, as it resolves it now, and the settings that choose it (for every printer). */
export type SlicerSetup = {
  type: string;
  /** The slicer app it would run, and whether that app is there. */
  path?: string; found: boolean;
  /** The Bambu profiles folder it would read (Bambu Studio and Orca), and whether it has BBL's profiles. */
  profilesRoot?: string; profilesFound?: boolean;
  fields: SetupField[];
};
export type SetupFields = { contract: typeof COUNTERPART_CONTRACT; server: { name: string; version: string }; kinds: SetupKind[]; model?: string; slicer?: SlicerSetup };

const SLICER_LABELS: Record<string, string> = {
  bambustudio: "Bambu Studio", orcaslicer: "OrcaSlicer", "orcaslicer-bambulab": "OrcaSlicer-bambulab (FULU)", "orca-slicer-api": "OrcaSlicer API (remote)",
  prusaslicer: "PrusaSlicer", cura: "Cura", slic3r: "Slic3r",
};
/**
 * The slicer settings, with what this server resolves now: a client shows "Bambu Studio isn't installed" or asks for
 * its location instead of the person editing SLICER_PATH by hand. A setting is required only when what it would
 * default to isn't there.
 */
export function slicerSetup(options: { types: readonly string[]; type: string; path?: string; found: boolean; profilesRoot?: string; profilesFound?: boolean; remote?: boolean }): SlicerSetup {
  const label = SLICER_LABELS[options.type] ?? options.type;
  const fields: SetupField[] = [
    { name: "slicer", env: "SLICER_TYPE", label: "Slicer", required: false, choices: options.types.map(value => ({ value, label: SLICER_LABELS[value] ?? value })) },
  ];
  if (!options.remote) fields.push({ name: "slicer-path", env: "SLICER_PATH", label: `${label} app`, input: "path", required: !options.found,
    hint: options.found ? `Found at ${options.path}. Set this only to use another copy.`
      : options.path ? `${label} isn't at ${options.path}. Install it, or choose where it is.` : `Where ${label} is installed.` });
  if (options.profilesFound !== undefined) fields.push({ name: "profiles", env: "BAMBU_PROFILES_ROOT", label: "Bambu profiles folder", input: "path", required: !options.profilesFound,
    hint: options.profilesFound ? `Found at ${options.profilesRoot}. Set this only to use other profiles.` : `The folder with ${label}'s BBL profiles (it holds BBL/machine). Install ${label}, or choose the folder.` });
  return { type: options.type, ...(options.path !== undefined ? { path: options.path } : {}), found: options.found,
    ...(options.profilesRoot !== undefined ? { profilesRoot: options.profilesRoot } : {}), ...(options.profilesFound !== undefined ? { profilesFound: options.profilesFound } : {}), fields };
}

/** Each serial prefix's model in this server's values (bambu_model), where it has one. */
export function serialModelValues(valid: readonly string[]): Record<string, string> {
  return Object.fromEntries(Object.entries(SERIAL_MODELS).flatMap(([prefix, name]) => {
    const model = normalizeModel(name);
    return model && valid.includes(model) ? [[prefix, model]] : [];
  }));
}

/** Bambu's display names for this server's model values ("a1mini" → "A1 Mini"). */
export function modelChoices(valid: readonly string[]): Array<{ value: string; label: string }> {
  const names = new Map(Object.values(SERIAL_MODELS).map(name => [normalizeModel(name), name]));
  return valid.map(value => ({ value, label: names.get(value) ?? value.toUpperCase() }));
}

const BAMBU_FIELDS = (models: readonly string[], fromSerial: SetupField["fromSerial"]): SetupField[] => [
  { name: "host", env: "PRINTER_HOST", label: "Address", hint: "The printer's IP address: on the printer, Settings → WLAN", required: true },
  { name: "serial", env: "BAMBU_SERIAL", label: "Serial number", hint: "On the printer: Settings → Device", required: true, transform: "uppercase" },
  { name: "model", env: "BAMBU_MODEL", label: "Model", required: true, choices: modelChoices(models), ...(fromSerial ? { fromSerial } : {}) },
  { name: "secret", env: "BAMBU_TOKEN", label: "Access code", hint: "On the printer: Settings → WLAN → Access Code", required: true },
];
const host: SetupField = { name: "host", env: "PRINTER_HOST", label: "Address", hint: "The printer's IP address or host name", required: true };
const port = (hint: string): SetupField => ({ name: "port", env: "PRINTER_PORT", label: "Port", hint, required: false });
const secret = (label: string, hint: string, required: boolean): SetupField => ({ name: "secret", env: "API_KEY", label, hint, required });

/** Every PRINTER_TYPE this server drives (its PrinterFactory), with the settings it reads for each. */
export function genericSetupFields(options: { server: { name: string; version: string }; models: readonly string[]; serial?: string; slicer?: SlicerSetup; defaultKind?: string }): SetupFields {
  const fromSerial = { prefixLength: 3, models: serialModelValues(options.models) };
  const model = options.serial ? fromSerial.models[options.serial.trim().slice(0, 3).toUpperCase()] : undefined;
  const kind = (kind: SetupKind["kind"], label: string, fields: SetupField[]): SetupKind =>
    ({ kind, label, env: { MCP_TRANSPORT: "stdio", PRINTER_TYPE: kind }, fields, ...(kind === options.defaultKind ? { default: true } : {}) });
  return {
    contract: COUNTERPART_CONTRACT,
    server: options.server,
    kinds: [
      kind("bambu", "Bambu Lab", BAMBU_FIELDS(options.models, fromSerial)),
      kind("octoprint", "OctoPrint", [host, port("Only if OctoPrint isn't on port 80"), secret("API key", "In OctoPrint: Settings → API", true)]),
      kind("klipper", "Klipper (Moonraker)", [host, port("Moonraker's port, often 7125"), secret("API key", "Only if Moonraker asks for one", false)]),
      kind("prusa", "Prusa (PrusaLink)", [host, port("Only if PrusaLink isn't on port 80"), secret("API key", "The key PrusaLink shows in its settings", true)]),
      kind("creality", "Creality", [host, port("Only if your printer uses another port"), secret("API key", "Only if your printer asks for one", false)]),
      kind("duet", "Duet", [host, port("Only if your Duet isn't on port 80"), secret("Password", "Only if your Duet has one set", false)]),
      kind("repetier", "Repetier", [host, port("Repetier-Server's port, often 3344"), secret("API key", "The key Repetier-Server shows in its settings", true)]),
    ],
    ...(model ? { model } : {}),
    ...(options.slicer ? { slicer: options.slicer } : {}),
  };
}

const field = {
  type: "object",
  properties: {
    name: { type: "string", enum: [...SETUP_FIELD_NAMES] }, env: { type: "string" }, aliases: { type: "array", items: { type: "string" } },
    label: { type: "string" }, hint: { type: "string" }, required: { type: "boolean" }, input: { type: "string", enum: ["path"] }, transform: { type: "string", enum: ["uppercase"] },
    choices: { type: "array", items: { type: "object", properties: { value: { type: "string" }, label: { type: "string" } }, required: ["value", "label"] } },
    fromSerial: { type: "object", properties: { prefixLength: { type: "integer" }, models: { type: "object", additionalProperties: { type: "string" } } }, required: ["prefixLength", "models"] },
  },
  required: ["name", "env", "label", "required"],
};
export const SETUP_FIELDS_OUTPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    contract: { type: "string", const: COUNTERPART_CONTRACT },
    server: { type: "object", properties: { name: { type: "string" }, version: { type: "string" } }, required: ["name", "version"] },
    kinds: { type: "array", items: { type: "object", properties: {
      kind: { type: "string", enum: [...PRINTER_KINDS] }, label: { type: "string" },
      default: { type: "boolean", description: "The kind this server runs when a .env sets none of its fixed values (no PRINTER_TYPE)." },
      env: { type: "object", additionalProperties: { type: "string" } }, fields: { type: "array", items: field },
    }, required: ["kind", "label", "env", "fields"] } },
    model: { type: "string" },
    slicer: { type: "object", properties: {
      type: { type: "string" }, path: { type: "string" }, found: { type: "boolean" }, profilesRoot: { type: "string" }, profilesFound: { type: "boolean" },
      fields: { type: "array", items: field },
    }, required: ["type", "found", "fields"] },
  },
  required: ["contract", "server", "kinds"],
};
