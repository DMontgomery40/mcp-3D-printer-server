/**
 * The installed slicer filament profile for a material, as a path slice_stl's
 * load_filaments accepts (get_printer_filaments slots[].profile).
 *
 * The existing resolvers do not fit: bambu-printer-mcp's inventory resolver
 * and bambu-cli.ts look up Bambu (BBL) profiles by an AMS tray_info_idx, which
 * other printers do not report. Here the key is the spool's material, matched
 * exactly against each profile's filament_type, in the slicer slice_stl uses
 * by default:
 * - OrcaSlicer: the app's bundled profiles/<Vendor>/filament, the copies under
 *   OrcaSlicer/system, and the user's OrcaSlicer/user/<id>/filament presets.
 *   filament_type and compatible_printers are read through `inherits`.
 * - PrusaSlicer and Slic3r: the data directory's filament/*.ini presets.
 *   Vendor bundle INIs hold many presets in one file and cannot be --load-ed.
 * Profiles whose compatible_printers names other printers are excluded; ones
 * that name the configured printer (SLICER_PROFILE's machine) come first,
 * then universal ones. Any failure resolves to undefined: a missing profile
 * never fails get_printer_filaments.
 */
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectProfilesRoot } from "./profile-flatten.js";
import { parseLooseSlicerConfig } from "./templates.js";

export interface FilamentProfileContext {
  /** The canonical slicer type slice_stl uses without a slicer_type argument. */
  slicerType: string;
  slicerPath?: string;
  /** SLICER_PROFILE: Orca "machine.json;process.json[|filament.json]", or PrusaSlicer's exported config. */
  slicerProfile?: string;
  /** What slice_stl loads when no filament is passed, in slot order. */
  configuredFilaments?: string[];
  /** Tests replace the searched directories. */
  roots?: { system: string[]; user: string[] };
}

type Entry = { file: string; name: string; config: Record<string, unknown>; user: boolean };
type Index = { entries: Entry[]; byName: Map<string, Entry> };

const ORCA = new Set(["orcaslicer"]);
const PRUSA = new Set(["prusaslicer", "slic3r"]);
const MAX_FILES = 20_000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 5;
const INDEX_TTL_MS = 60_000;
const indexes = new Map<string, { at: number; index: Promise<Index> }>();

/** Per-user application data directories, in the order the slicers use them. */
function appDataDirs(): string[] {
  const home = os.homedir();
  return [
    path.join(home, "Library", "Application Support"),
    path.join(home, ".config"),
    ...(process.env.APPDATA ? [process.env.APPDATA] : []),
  ];
}

function defaultRoots(context: FilamentProfileContext): { system: string[]; user: string[] } {
  if (ORCA.has(context.slicerType)) {
    const system = [detectProfilesRoot(context.slicerPath, "orcaslicer"), ...appDataDirs().map((dir) => path.join(dir, "OrcaSlicer", "system"))];
    const user = appDataDirs().map((dir) => path.join(dir, "OrcaSlicer", "user"));
    return { system, user };
  }
  const home = os.homedir();
  const name = context.slicerType === "slic3r" ? "Slic3r" : "PrusaSlicer";
  const user = [
    ...appDataDirs().map((dir) => path.join(dir, name)),
    ...(name === "PrusaSlicer" ? [path.join(home, ".PrusaSlicer"), path.join(home, ".var", "app", "com.prusa3d.PrusaSlicer", "config", "PrusaSlicer")] : [path.join(home, ".Slic3r")]),
  ];
  return { system: [], user };
}

async function listFiles(dir: string, extension: string, depth: number, budget: { left: number }): Promise<string[]> {
  if (depth > MAX_DEPTH || budget.left <= 0) return [];
  const items = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
    if (budget.left <= 0) break;
    const full = path.join(dir, item.name);
    if (item.isDirectory()) files.push(...await listFiles(full, extension, depth + 1, budget));
    else if (item.isFile() && item.name.toLowerCase().endsWith(extension)) { files.push(full); budget.left -= 1; }
  }
  return files;
}

async function readConfig(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_BYTES) return undefined;
    const parsed = parseLooseSlicerConfig(await fs.readFile(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function buildIndex(context: FilamentProfileContext, roots: { system: string[]; user: string[] }): Promise<Index> {
  const budget = { left: MAX_FILES };
  const files: { file: string; user: boolean }[] = [];
  if (ORCA.has(context.slicerType)) {
    // <root>/<Vendor>/filament/** for system trees; <user>/<id>/filament/** for presets.
    for (const [list, user] of [[roots.system, false], [roots.user, true]] as const) {
      for (const root of list) {
        const groups = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
        for (const group of groups.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
          for (const file of await listFiles(path.join(root, group.name, "filament"), ".json", 0, budget)) files.push({ file, user });
        }
      }
    }
  } else {
    for (const root of roots.user) {
      for (const file of await listFiles(path.join(root, "filament"), ".ini", MAX_DEPTH, budget)) files.push({ file, user: true });
    }
  }
  const entries: Entry[] = [];
  const byName = new Map<string, Entry>();
  for (const { file, user } of files) {
    const config = await readConfig(file);
    if (!config) continue;
    const name = typeof config.name === "string" && config.name.trim() ? config.name.trim() : path.basename(file, path.extname(file));
    const entry = { file, name, config, user };
    entries.push(entry);
    // System names first: `inherits` points at system presets.
    if (!byName.has(name)) byName.set(name, entry);
  }
  return { entries, byName };
}

function profileIndex(context: FilamentProfileContext): Promise<Index> {
  const roots = context.roots ?? defaultRoots(context);
  const key = JSON.stringify([context.slicerType, roots]);
  const cached = indexes.get(key);
  if (cached && Date.now() - cached.at < INDEX_TTL_MS) return cached.index;
  const index = buildIndex(context, roots);
  indexes.set(key, { at: Date.now(), index });
  // A failed build is not cached.
  index.catch(() => indexes.delete(key));
  return index;
}

/** A key's value on the profile or the nearest preset it inherits from. */
function inherited(index: Index, entry: Entry, key: string): unknown {
  const seen = new Set<Entry>();
  let current: Entry | undefined = entry;
  for (let depth = 0; current && depth < 12 && !seen.has(current); depth += 1) {
    seen.add(current);
    if (current.config[key] !== undefined) return current.config[key];
    const parent: unknown = current.config.inherits;
    current = typeof parent === "string" && parent.trim() ? index.byName.get(parent.trim()) : undefined;
  }
  return undefined;
}

function textValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
  if (typeof value !== "string" || !value.trim()) return [];
  // PrusaSlicer lists are "a";"b"; Orca's are JSON arrays.
  const quoted = [...value.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1].trim()).filter(Boolean);
  return quoted.length ? quoted : value.split(";").map((item) => item.trim()).filter(Boolean);
}

/** The configured printer's preset names, from SLICER_PROFILE. */
async function printerNames(context: FilamentProfileContext): Promise<Set<string>> {
  const names = new Set<string>();
  const settings = (context.slicerProfile ?? "").split("|", 1)[0].split(";").map((item) => item.trim()).filter(Boolean);
  for (const file of settings) {
    const config = await readConfig(file);
    if (!config) continue;
    const isMachine = config.type === "machine" || config.printer_settings_id !== undefined || config.printer_model !== undefined;
    if (!isMachine) continue;
    for (const key of ["name", "inherits", "printer_settings_id"]) {
      for (const value of textValues(config[key])) names.add(value);
    }
  }
  return names;
}

export async function resolveFilamentProfile(material: string | undefined, context: FilamentProfileContext): Promise<string | undefined> {
  try {
    const wanted = material?.trim().toUpperCase();
    if (!wanted) {
      // No reported material: the profile slice_stl loads by default, when it exists.
      const configured = context.configuredFilaments?.map((item) => item.trim()).find(Boolean);
      return configured && existsSync(configured) ? path.resolve(configured) : undefined;
    }
    if (!ORCA.has(context.slicerType) && !PRUSA.has(context.slicerType)) return undefined;
    const [index, printers] = await Promise.all([profileIndex(context), printerNames(context)]);
    const candidates: { entry: Entry; rank: number }[] = [];
    for (const entry of index.entries) {
      if (String(entry.config.instantiation ?? "true").toLowerCase() === "false" || /@base$/i.test(entry.name)) continue;
      if (!textValues(inherited(index, entry, "filament_type")).some((type) => type.toUpperCase() === wanted)) continue;
      const compatible = textValues(inherited(index, entry, "compatible_printers"));
      const condition = inherited(index, entry, "compatible_printers_condition");
      let rank: number;
      if (compatible.length) {
        if (!compatible.some((name) => printers.has(name))) continue;
        rank = 0;
      } else {
        // A condition this server cannot evaluate ranks below a profile for every printer.
        rank = typeof condition === "string" && condition.trim() ? 2 : 1;
      }
      candidates.push({ entry, rank });
    }
    candidates.sort((a, b) => a.rank - b.rank || Number(b.entry.user) - Number(a.entry.user) || a.entry.file.localeCompare(b.entry.file));
    const best = candidates[0]?.entry.file;
    return best ? path.resolve(best) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A generic OrcaSlicer filament preset with its `inherits` chain merged in,
 * parent first, for --load-filaments: the CLI does not resolve inheritance,
 * so a bundled preset such as "Generic PETG @System" would otherwise slice
 * without its own temperatures. Undefined when the file inherits nothing, or
 * when a parent is not installed (the file is then passed as it is).
 */
export async function flattenOrcaFilament(file: string, context: Pick<FilamentProfileContext, "slicerPath" | "roots">): Promise<Record<string, unknown> | undefined> {
  const leaf = await readConfig(file);
  const parentName = leaf?.inherits;
  if (!leaf || typeof parentName !== "string" || !parentName.trim()) return undefined;
  const index = await profileIndex({ slicerType: "orcaslicer", ...context });
  const chain: Record<string, unknown>[] = [leaf];
  const seen = new Set<string>();
  for (let name = parentName.trim(); name; ) {
    const parent = index.byName.get(name);
    if (!parent || seen.has(name) || chain.length > 12) return undefined;
    seen.add(name);
    chain.push(parent.config);
    name = typeof parent.config.inherits === "string" ? parent.config.inherits.trim() : "";
  }
  const merged: Record<string, unknown> = Object.assign({}, ...chain.reverse());
  const name = typeof leaf.name === "string" && leaf.name.trim() ? leaf.name.trim() : path.basename(file, path.extname(file));
  // As the Bambu CLI flattener does: a user-owned, self-contained preset.
  merged.name = name;
  merged.inherits = "";
  merged.from = "User";
  merged.filament_settings_id = [name];
  delete merged.instantiation;
  delete merged.setting_id;
  return merged;
}

/** Tests only: forget cached profile indexes. */
export function clearFilamentProfileCache(): void {
  indexes.clear();
}
