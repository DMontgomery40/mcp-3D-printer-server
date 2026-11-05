/**
 * Bambu AMS and external-spool inventory, ported from bambu-printer-mcp's
 * get_printer_filaments (normalizePrinterFilamentInventory). `trays` and the
 * fields beside it are bambu-printer-mcp's result, field for field, so a
 * client reads either server alike; `slots` is the counterpart/1 contract,
 * which also lists the external spool(s) the printer reports (vt_tray, and
 * vir_slot on dual-nozzle printers).
 *
 * Profiles resolve by the tray's tray_info_idx (Bambu filament_id) against
 * the slicer's BBL/filament profiles, preferring the model-and-nozzle preset.
 */
import fs from "node:fs";
import path from "node:path";
import { detectProfilesRoot } from "../slicer/profile-flatten.js";
import type { FilamentSlot } from "../counterpart/contract.js";
import { NO_COLOUR_NAMES, bambuTrayLabel, loadColourNames, spoolName, type ColourNames } from "../counterpart/filaments.js";

export const FILAMENT_MODEL_CODES: Record<string, string> = {
  p1s: "P1S",
  p1p: "P1P",
  p2s: "P2S",
  x1c: "X1C",
  x1e: "X1E",
  a1: "A1",
  a1mini: "A1M",
  h2d: "H2D",
  h2dpro: "H2DP",
  h2s: "H2S",
  h2c: "H2C",
  x2d: "X2D",
};

type FilamentProfileIndex = {
  byName: Map<string, string>;
  baseNameByFilamentId: Map<string, string>;
};

type ProfileResolution = "exact-model-nozzle" | "model" | "generic" | "unresolved";

export type PrinterFilamentTray = {
  ams_id: number | null;
  tray_id: number | null;
  slot: number | null;
  state: number;
  loaded: boolean;
  tray_info_idx: string | null;
  tray_type: string | null;
  tray_sub_brands: string | null;
  tray_color: string | null;
  remain_percent: number | null;
  nozzle_temp_min: number | null;
  nozzle_temp_max: number | null;
  resolved_base_profile_name: string | null;
  resolved_profile_path: string | null;
  profile_resolution: ProfileResolution;
  match_confidence: "high" | "medium" | "low" | "none";
  display_name: string;
  /** Where the tray sits, as Bambu Studio labels it ("A2", "AMS HT A", "External"). */
  label: string | null;
  /** The spool as a person names it: Bambu's colour name and product ("Sunflower Yellow PLA Basic"). */
  spool_name: string | null;
  profile_candidates: string[];
};

export type PrinterFilamentInventory = {
  current_slot: number | null;
  current_source: "ams" | "external" | null;
  summary: {
    loaded_slots: number;
    resolved_profile_slots: number;
    unresolved_loaded_slots: number;
    empty_slots: number;
    current_slot: number | null;
    current_source: "ams" | "external" | null;
    recommended_slot: number | null;
    recommended_reason: string | null;
  };
  trays: PrinterFilamentTray[];
  recommended: {
    slot: number | null;
    tray_info_idx: string | null;
    tray_type: string | null;
    resolved_profile_path: string | null;
    load_filaments: string | null;
    reason: string;
  } | null;
  load_filaments_all: string | null;
};

export interface FilamentProfileSource {
  slicerPath?: string;
  slicerType?: string;
}

const indexCache = new Map<string, FilamentProfileIndex>();
const colourNamesCache = new Map<string, ColourNames>();

/** Bambu Studio's own colour names for its filaments, read once per slicer from its BBL profiles. */
export function bambuColourNames(source: FilamentProfileSource): ColourNames {
  const key = `${process.env.BAMBU_PROFILES_ROOT ?? ""}\n${source.slicerType ?? ""}\n${source.slicerPath ?? ""}`;
  let names = colourNamesCache.get(key);
  if (!names) {
    let dir: string | undefined;
    try {
      dir = path.join(detectProfilesRoot(source.slicerPath, source.slicerType === "bambustudio" ? "bambustudio" : "orcaslicer"), "BBL", "filament");
    } catch { dir = undefined; }
    names = loadColourNames(dir);
    // A slicer installed later still names its colours: only a table that loaded is kept.
    if (names !== NO_COLOUR_NAMES) colourNamesCache.set(key, names);
  }
  return names;
}

function buildFilamentProfileIndex(source: FilamentProfileSource): FilamentProfileIndex {
  const byName = new Map<string, string>();
  const baseNameByFilamentId = new Map<string, string>();
  let filamentProfileDir: string;
  try {
    const slicerType = source.slicerType === "bambustudio" ? "bambustudio" : "orcaslicer";
    filamentProfileDir = path.join(detectProfilesRoot(source.slicerPath, slicerType), "BBL", "filament");
  } catch {
    // Profile suggestions are optional; invalid slicer configuration must not hide AMS inventory.
    return { byName, baseNameByFilamentId };
  }

  let profileEntries: string[];
  try {
    profileEntries = fs.readdirSync(filamentProfileDir);
  } catch {
    return { byName, baseNameByFilamentId };
  }

  for (const entry of profileEntries) {
    if (!entry.endsWith(".json")) continue;
    const filePath = path.join(filamentProfileDir, entry);
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const name = typeof parsed?.name === "string" ? parsed.name.trim() : "";
      const filamentId = typeof parsed?.filament_id === "string" ? parsed.filament_id.trim() : "";
      if (name) byName.set(name, filePath);
      if (name && filamentId) baseNameByFilamentId.set(filamentId, name);
    } catch {
      // Ignore malformed or non-profile JSON files.
    }
  }
  return { byName, baseNameByFilamentId };
}

function filamentProfileIndex(source: FilamentProfileSource): FilamentProfileIndex {
  const key = `${process.env.BAMBU_PROFILES_ROOT ?? ""}\n${source.slicerType ?? ""}\n${source.slicerPath ?? ""}`;
  let index = indexCache.get(key);
  if (!index) {
    index = buildFilamentProfileIndex(source);
    indexCache.set(key, index);
  }
  return index;
}

export function clearBambuFilamentProfileCache(): void {
  indexCache.clear();
}

function resolveFilamentProfileCandidates(
  trayInfoIdx: string,
  source: FilamentProfileSource,
  bambuModel?: string,
  nozzleDiameter?: string
): { baseName: string | null; paths: string[]; resolution: ProfileResolution } {
  const index = filamentProfileIndex(source);
  const baseName = index.baseNameByFilamentId.get(trayInfoIdx) || null;
  if (!baseName) return { baseName: null, paths: [], resolution: "unresolved" };

  const bareName = baseName.replace(/\s*@base$/, "");
  const modelCode = bambuModel ? FILAMENT_MODEL_CODES[bambuModel] : undefined;
  const candidateNames: string[] = [];
  if (modelCode && nozzleDiameter) candidateNames.push(`${bareName} @BBL ${modelCode} ${nozzleDiameter} nozzle`);
  if (modelCode) candidateNames.push(`${bareName} @BBL ${modelCode}`);
  candidateNames.push(bareName, baseName);

  const resolvedPaths: string[] = [];
  let resolution: ProfileResolution = "unresolved";
  for (const [candidateIndex, candidateName] of candidateNames.entries()) {
    const candidatePath = index.byName.get(candidateName);
    if (!candidatePath || resolvedPaths.includes(candidatePath)) continue;
    resolvedPaths.push(candidatePath);
    if (resolution === "unresolved") {
      if (candidateIndex === 0 && modelCode && nozzleDiameter) {
        resolution = "exact-model-nozzle";
      } else if (
        (candidateIndex === 0 && modelCode && !nozzleDiameter) ||
        (candidateIndex === 1 && modelCode && nozzleDiameter)
      ) {
        resolution = "model";
      } else {
        resolution = "generic";
      }
    }
  }
  return { baseName, paths: resolvedPaths, resolution };
}

function parseIntegerOrNull(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Lowercase 6-character RGB, dropping a leading "#" and any alpha. Bambu mixes
 * #RRGGBB (3MF project settings) and RRGGBBAA (AMS reports); RGB is the key.
 */
export function normalizeRgbColor(color: string | null | undefined): string | null {
  if (!color) return null;
  const hex = color.replace(/^#/, "").toLowerCase();
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/.test(hex)) return null;
  return hex.slice(0, 6);
}

function trayEntry(
  tray: any,
  ids: { amsId: number | null; trayId: number | null; slot: number | null; state: number; label?: string },
  source: FilamentProfileSource,
  bambuModel?: string,
  nozzleDiameter?: string
): PrinterFilamentTray {
  const trayInfoIdx = typeof tray?.tray_info_idx === "string" ? tray.tray_info_idx : null;
  const profileResolution = trayInfoIdx
    ? resolveFilamentProfileCandidates(trayInfoIdx, source, bambuModel, nozzleDiameter)
    : { baseName: null, paths: [], resolution: "unresolved" as const };
  const matchConfidence =
    profileResolution.resolution === "exact-model-nozzle" ? "high" :
    profileResolution.resolution === "model" ? "medium" :
    profileResolution.resolution === "generic" ? "low" :
    "none";
  const trayType = typeof tray?.tray_type === "string" ? tray.tray_type : null;
  const traySubBrands = typeof tray?.tray_sub_brands === "string" ? tray.tray_sub_brands : null;
  const trayColor = typeof tray?.tray_color === "string" ? tray.tray_color : null;
  const displayParts = [
    traySubBrands && traySubBrands !== trayType ? traySubBrands : null,
    trayType,
    trayColor ? `#${normalizeRgbColor(trayColor) ?? trayColor.replace(/^#/, "").slice(0, 6)}` : null,
  ].filter(Boolean);
  return {
    ams_id: ids.amsId,
    tray_id: ids.trayId,
    slot: ids.slot,
    state: ids.state,
    loaded: ids.state !== 0 && Boolean(trayInfoIdx),
    tray_info_idx: trayInfoIdx,
    tray_type: trayType,
    tray_sub_brands: traySubBrands,
    tray_color: trayColor,
    remain_percent: typeof tray?.remain === "number" && tray.remain >= 0 ? tray.remain : null,
    nozzle_temp_min: parseIntegerOrNull(tray?.nozzle_temp_min),
    nozzle_temp_max: parseIntegerOrNull(tray?.nozzle_temp_max),
    resolved_base_profile_name: profileResolution.baseName,
    resolved_profile_path: profileResolution.paths[0] || null,
    profile_resolution: profileResolution.resolution,
    match_confidence: matchConfidence,
    display_name: displayParts.length > 0 ? displayParts.join(" ") : "empty/unknown",
    label: ids.label ?? (ids.amsId !== null && ids.trayId !== null ? bambuTrayLabel(ids.amsId, ids.trayId) : null),
    spool_name: trayType ? spoolName(traySubBrands || trayType,
      trayInfoIdx && trayColor ? bambuColourNames(source).spool(trayInfoIdx, trayColor) : undefined) : null,
    profile_candidates: profileResolution.paths,
  };
}

/** bambu-printer-mcp's inventory: AMS trays (absolute slot = ams_id * 4 + tray_id), summary and recommendation. */
export function normalizePrinterFilamentInventory(
  status: any,
  source: FilamentProfileSource,
  bambuModel?: string,
  nozzleDiameter?: string
): PrinterFilamentInventory {
  const rawAms = status?.raw?.ams || status?.ams || {};
  const trayNow = parseIntegerOrNull(rawAms?.tray_now);
  const trays: PrinterFilamentTray[] = [];

  const amsArray = Array.isArray(rawAms?.ams) ? rawAms.ams : [];
  for (const [amsIndex, amsUnit] of amsArray.entries()) {
    const trayArray = Array.isArray(amsUnit?.tray) ? amsUnit.tray : [];
    for (const [trayIndex, tray] of trayArray.entries()) {
      const amsId = parseIntegerOrNull(amsUnit?.id) ?? amsIndex;
      const trayId = parseIntegerOrNull(tray?.id) ?? trayIndex;
      const slot = amsId !== null && trayId !== null ? amsId * 4 + trayId : null;
      const state = parseIntegerOrNull(tray?.state) ?? 0;
      trays.push(trayEntry(tray, { amsId, trayId, slot, state }, source, bambuModel, nozzleDiameter));
    }
  }

  const loadedTrays = trays.filter((tray) => tray.loaded);
  const recommendedTray =
    loadedTrays.find((tray) => tray.slot === trayNow && tray.resolved_profile_path) ||
    loadedTrays.find((tray) => tray.resolved_profile_path) ||
    null;
  const recommendedReason =
    recommendedTray?.slot === trayNow
      ? "current AMS slot with resolved slicer profile"
      : recommendedTray
        ? "first loaded AMS slot with resolved slicer profile"
        : null;
  const allProfilePaths = Array.from(new Set(
    loadedTrays.map((tray) => tray.resolved_profile_path).filter((candidate): candidate is string => Boolean(candidate))
  ));
  const emptySlots = trays.filter((tray) => !tray.loaded).length;
  const resolvedProfileSlots = loadedTrays.filter((tray) => tray.resolved_profile_path).length;
  const currentSlot = trayNow !== null && trayNow >= 0 && trayNow < 254 ? trayNow : null;
  const currentSource = trayNow === 254 ? "external" : currentSlot !== null ? "ams" : null;

  return {
    current_slot: currentSlot,
    current_source: currentSource,
    summary: {
      loaded_slots: loadedTrays.length,
      resolved_profile_slots: resolvedProfileSlots,
      unresolved_loaded_slots: loadedTrays.length - resolvedProfileSlots,
      empty_slots: emptySlots,
      current_slot: currentSlot,
      current_source: currentSource,
      recommended_slot: recommendedTray?.slot ?? null,
      recommended_reason: recommendedReason,
    },
    trays,
    recommended: recommendedTray
      ? {
          slot: recommendedTray.slot,
          tray_info_idx: recommendedTray.tray_info_idx,
          tray_type: recommendedTray.tray_type,
          resolved_profile_path: recommendedTray.resolved_profile_path,
          load_filaments: recommendedTray.resolved_profile_path,
          reason: recommendedReason ?? "resolved slicer profile",
        }
      : null,
    load_filaments_all: allProfilePaths.length > 0 ? allProfilePaths.join(";") : null,
  };
}

/**
 * The external spool(s) the printer reports: vir_slot entries 254/255 on
 * dual-nozzle printers, else vt_tray as 254. A spool is loaded once the printer
 * knows its type (tray_type), as Bambu Studio shows it.
 */
export function externalSpools(status: any, source: FilamentProfileSource, bambuModel?: string, nozzleDiameter?: string): PrinterFilamentTray[] {
  const raw = status?.raw ?? status ?? {};
  const virtual: any[] = Array.isArray(raw?.vir_slot) ? raw.vir_slot : [];
  const spools = virtual
    .filter((slot) => [254, 255].includes(Number(slot?.id)))
    .map((slot) => ({ slot: Number(slot.id), tray: slot }));
  if (!spools.length && raw?.vt_tray && typeof raw.vt_tray === "object") spools.push({ slot: 254, tray: raw.vt_tray });
  // vir_slot is the dual-nozzle report; a single-nozzle printer reports vt_tray.
  const dual = virtual.length > 0;
  return spools.map(({ slot, tray }) => {
    const known = typeof tray?.tray_type === "string" && tray.tray_type.trim() !== "";
    // Dual-nozzle printers: 255 feeds the right (main) nozzle and 254 the left.
    const label = !dual ? "External" : slot === 255 ? "Right external" : "Left external";
    const entry = trayEntry(tray, { amsId: slot, trayId: 0, slot, state: known ? 1 : 0, label }, source, bambuModel, nozzleDiameter);
    return { ...entry, loaded: known };
  });
}

/** counterpart/1 slots: every AMS tray (id "<absolute slot>") and external spool ("254"/"255"); no nulls. */
export function counterpartSlots(inventory: PrinterFilamentInventory, external: PrinterFilamentTray[]): FilamentSlot[] {
  return [...inventory.trays, ...external].flatMap((tray): FilamentSlot[] => {
    if (tray.slot === null || !tray.loaded) return [];
    const rgb = normalizeRgbColor(tray.tray_color);
    // print_3mf's tray value: an AMS-HT unit (id 128 and up, one tray) is its unit id, not ams_id × 4 + tray.
    const id = tray.ams_id !== null && tray.ams_id >= 128 && tray.ams_id < 254 ? tray.ams_id : tray.slot;
    return [{
      id: String(id),
      ...(tray.tray_type ? { material: tray.tray_type } : {}),
      ...(rgb ? { color: `#${rgb.toUpperCase()}` } : {}),
      ...(tray.spool_name ? { name: tray.spool_name } : tray.display_name && tray.display_name !== "empty/unknown" ? { name: tray.display_name } : {}),
      ...(tray.label ? { label: tray.label } : {}),
      ...(tray.tray_info_idx ? { filamentId: tray.tray_info_idx } : {}),
      source: "printer",
      ...(tray.resolved_profile_path ? { profile: tray.resolved_profile_path } : {}),
    }];
  });
}
