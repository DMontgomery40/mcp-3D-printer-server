/**
 * BambuStudio CLI profile flattener.
 *
 * Background: BambuStudio's bundled profile JSONs (Resources/profiles/BBL/...)
 * use an `inherits` chain that the GUI resolves at runtime but the CLI does
 * not. Passing a leaf profile straight to `--load-settings` / `--load-filaments`
 * yields a partial config and the slicer asserts (e.g. `nozzle_volume_type
 * not found` -> SIGSEGV / assertion in MutablePolygon.cpp / Geometry.hpp).
 * See https://github.com/bambulab/BambuStudio/issues/9636 and #9968.
 *
 * This module:
 *   1. Indexes every BBL profile JSON by its `name` field.
 *   2. Recursively walks `inherits`, deep-merging parent into child, and
 *      applies each level's `include` templates (G-code templates for
 *      machines, per-variant defaults for filaments) the way the GUI does.
 *   3. Derives `nozzle_volume_type` from `default_nozzle_volume_type[0]`
 *      (the GUI does this implicitly; the CLI doesn't).
 *   4. Validates the model in `BBL/cli_config.json` and merges its CLI-specific
 *      machine_limits where supplied for safe accelerations / jerks.
 *   5. Writes the flattened JSON to a temp file the caller passes to
 *      BambuStudio CLI.
 *
 * BBL only. Other vendors are out of scope and rejected explicitly so we
 * fail loud rather than producing dangerous gcode for hardware we don't own.
 */

import fs from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export type ProfileKind = "machine" | "process" | "filament";

export interface FlattenedProfiles {
  machinePath: string;
  processPath: string;
  filamentPaths: string[];
  /** Diagnostics for callers / logs. Not part of the slicer invocation. */
  meta: {
    profilesRoot: string;
    machineLeafName: string;
    processLeafName: string;
    filamentLeafNames: string[];
    /** False only for an explicit standalone custom machine. */
    cliConfigValidated: boolean;
    /** Some validated official model configs intentionally have no limits. */
    cliOverlayApplied: boolean;
  };
}

export interface FlattenOptions {
  /** e.g. "Bambu Lab H2S 0.4 nozzle" */
  machineLeaf: string;
  /** e.g. "0.20mm Standard @BBL H2S" */
  processLeaf: string;
  /** e.g. ["Bambu PLA Basic @BBL H2S"] */
  filamentLeaves: string[];
  /** Absolute path to `.../Resources/profiles`. */
  profilesRoot: string;
  /** Configured BBL directories for custom process/filament dependencies only. */
  userProfileRoots?: string[];
  /** Where to write flattened temp files. */
  tempDir: string;
  /** Vendor subdir under profilesRoot. Currently only "BBL" supported. */
  vendor?: string;
  /**
   * Override for installed nozzle flow type. The printer reports this on
   * boot from its physical nozzle scan; both nozzles always match (you
   * can't mix Standard + High Flow, just like you can't mix 0.2 + 0.4).
   * If omitted we use `default_nozzle_volume_type` from the profile tree
   * (= "Standard" on stock BBL machines). Pass "High Flow" when HF
   * nozzles are installed.
   */
  nozzleVolumeType?: "Standard" | "High Flow";
  /** BambuStudio display name, e.g. "Textured PEI Plate" or "Cool Plate". */
  bedType?: string;
  /** Actual input configs, including user overrides on top of BBL parents. */
  sourceProfiles?: {
    machine?: Record<string, unknown>;
    process?: Record<string, unknown>;
    filaments?: (Record<string, unknown> | undefined)[];
  };
  /**
   * Positional `#RRGGBB` colour per filament slot (e.g. from the input 3MF
   * project or the caller). Missing entries keep the profile's own colour or
   * fall back to DEFAULT_FILAMENT_COLOUR.
   */
  filamentColours?: (string | undefined)[];
  /** Saved per-plate positions, used only when the process sets no position. */
  projectTowerPosition?: { wipe_tower_x?: unknown; wipe_tower_y?: unknown };
}

interface IndexedProfile {
  filePath: string;
  data: Record<string, unknown>;
}

/** Name index plus unreadable JSON files, reported when a name is missing. */
type NameIndex = Map<string, IndexedProfile> & { malformed?: string[] };

/* -------------------------------------------------------------------------- */
/* Indexing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Build a name -> {filePath, data} map for every JSON in
 * <profilesRoot>/<vendor>/{machine,process,filament}/.
 *
 * The `name` field inside each JSON is the lookup key (this is what
 * `inherits` references). We index every file, including non-instantiable
 * abstract bases like `fdm_machine_common` and `fdm_bbl_3dp_001_common`,
 * because those are the parents we'll walk to.
 */
async function buildNameIndex(
  profilesRoot: string,
  vendor: string,
  userProfileRoots: string[] = []
): Promise<NameIndex> {
  const index: NameIndex = new Map();
  index.malformed = [];
  const subdirs: ProfileKind[] = ["machine", "process", "filament"];

  const directories = [
    ...subdirs.map(sub => path.join(profilesRoot, vendor, sub)),
    ...userProfileRoots.flatMap(root => ['process', 'filament'].map(sub => path.join(root, sub))),
  ];
  for (const dir of directories) {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      // Vendor or subdir missing -- skip silently; flatten will fail later
      // with a precise "name not found" error.
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const filePath = path.join(dir, entry);
      let raw: string;
      try {
        raw = await fs.readFile(filePath, "utf8");
      } catch {
        continue;
      }
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // Malformed profile -- skip, don't poison the index. A reference to
        // it still fails, and the error names the skipped file.
        index.malformed!.push(filePath);
        continue;
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        index.malformed!.push(filePath);
        continue;
      }
      const name = data["name"];
      if (typeof name !== "string" || name.length === 0) continue;
      // First-write wins. BBL doesn't have name collisions in practice;
      // log if it ever does so we notice.
      if (!index.has(name)) {
        index.set(name, { filePath, data });
      }
    }
  }

  return index;
}

/* -------------------------------------------------------------------------- */
/* Inheritance walk + merge                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the full inheritance chain for `leafName` and return a single
 * deep-merged object. Child wins on key collision.
 *
 * Throws on:
 *   - Unknown name (broken `inherits` reference).
 *   - Cycles (A -> B -> A).
 */
function flattenByName(
  leafName: string,
  index: NameIndex,
  visiting = new Set<string>()
): Record<string, unknown> {
  if (visiting.has(leafName)) {
    throw new Error(`Profile inheritance cycle detected (inherits/include): ${[...visiting, leafName].join(" -> ")}`);
  }
  const entry = index.get(leafName);
  if (!entry) {
    throw new Error(`Profile "${leafName}" not found in index. The profile tree is incomplete or the name is misspelled.${describeMalformed(index)}`);
  }
  visiting.add(leafName);
  try {
    return flattenData(entry.data, index, visiting);
  } finally {
    visiting.delete(leafName);
  }
}

function describeMalformed(index: NameIndex): string {
  const malformed = index.malformed ?? [];
  if (malformed.length === 0) return "";
  const shown = malformed.slice(0, 5).map((file) => path.basename(file)).join(", ");
  return ` Skipped ${malformed.length} unreadable or malformed profile file(s): ${shown}${malformed.length > 5 ? ", ..." : ""}.`;
}

function flattenData(
  data: Record<string, unknown>,
  index: NameIndex,
  visiting = new Set<string>()
): Record<string, unknown> {
  const parent = data["inherits"];
  const merged = typeof parent === "string" && parent.length > 0
    ? flattenByName(parent, index, visiting)
    : {};
  // Includes may themselves inherit or include templates. Each level wins
  // over its parent, then the including profile's own settings win last.
  applyIncludes(merged, data, index, visiting);
  Object.assign(merged, data);
  delete merged["include"];
  return merged;
}

/** Resolve bundled machine defaults before choosing process and filament leaves. */
export async function resolveBblMachineProfile(
  profilesRoot: string,
  machineLeaf: string
): Promise<Record<string, unknown>> {
  return flattenByName(machineLeaf, await buildNameIndex(profilesRoot, 'BBL'));
}

/** Keys of an include template that describe the template, not the config. */
const INCLUDE_METADATA_KEYS = new Set(["name", "type", "from", "instantiation", "inherits", "include", "setting_id"]);

/**
 * Recent BBL profiles (e.g. "Bambu Lab P2S 0.4 nozzle") no longer carry
 * their G-code inline: `machine_start_gcode`, `machine_end_gcode`,
 * `change_filament_gcode`, ... live in separate "... template <key>"
 * profiles listed under `include`. Skipping them silently falls back to
 * the generic G-code inherited from `fdm_machine_common` & co, which is
 * wrong for the printer (no AMS filament load, other printer's moves).
 */
function applyIncludes(
  target: Record<string, unknown>,
  profile: Record<string, unknown>,
  index: NameIndex,
  visiting: Set<string>
): void {
  const raw = profile["include"];
  if (raw === undefined || raw === null) return;
  if (typeof raw !== "string" && !Array.isArray(raw)) {
    throw new Error(`Profile "${String(profile["name"])}" has an invalid include; expected a name or array of names.`);
  }
  const names = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
  for (const name of names) {
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new Error(`Profile "${String(profile["name"])}" has an invalid include reference; every entry must be a nonempty name.`);
    }
    const entry = index.get(name);
    if (!entry) {
      throw new Error(
        `Profile "${String(profile["name"])}" includes "${name}", which is not in the index. ` +
          `Refusing to fall back to inherited defaults (wrong G-code for this printer).${describeMalformed(index)}`
      );
    }
    for (const [key, value] of Object.entries(flattenByName(name, index, visiting))) {
      if (!INCLUDE_METADATA_KEYS.has(key)) target[key] = value;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* CLI post-processing                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Bambu's CLI looks up `nozzle_volume_type`, but the profile tree only
 * defines `default_nozzle_volume_type`. The GUI propagates the latter
 * (or the value reported by the printer's nozzle scan on boot) into the
 * former at runtime. We do the same.
 *
 * Shape: array of strings, one entry per physical nozzle. Hardware
 * invariant from Bambu: BOTH nozzles must match (same diameter, same
 * flow type) -- you cannot install 0.2 + 0.4, and you cannot install
 * Standard + High Flow. So the array always contains identical entries.
 *
 * Verified against a GUI-sliced H2D project_settings.config:
 *   ["High Flow", "High Flow"]   (dual-nozzle, HF installed)
 *   ["Standard", "Standard"]     (dual-nozzle, stock)
 *   ["Standard"]                 (single-extruder default)
 *
 * Override priority:
 *   1. Caller-supplied `nozzleVolumeType` (e.g. printer reported HF).
 *   2. Existing `nozzle_volume_type` already in the flattened profile.
 *   3. `default_nozzle_volume_type` from the profile tree.
 *   4. ["Standard"] x extruder count.
 */
function deriveNozzleVolumeType(
  flat: Record<string, unknown>,
  override?: "Standard" | "High Flow"
): void {
  if (override) {
    const count = inferExtruderCount(flat);
    flat["nozzle_volume_type"] = Array(count).fill(override);
    return;
  }

  if (Array.isArray(flat["nozzle_volume_type"])) {
    enforceMatchingNozzles(flat["nozzle_volume_type"] as unknown[]);
    return;
  }

  const def = flat["default_nozzle_volume_type"];
  if (Array.isArray(def) && def.every((v) => typeof v === "string")) {
    enforceMatchingNozzles(def);
    flat["nozzle_volume_type"] = [...def];
    return;
  }

  const extruderCount = inferExtruderCount(flat);
  flat["nozzle_volume_type"] = Array(extruderCount).fill("Standard");
}

/**
 * Hardware invariant: all nozzles on a Bambu printer have identical flow
 * type (and diameter). If a profile somehow declares mixed types it's
 * either bad input or a future mistake -- fail loud so we don't ship
 * gcode that could damage the printer.
 */
function enforceMatchingNozzles(arr: unknown[]): void {
  if (arr.length <= 1) return;
  const first = arr[0];
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] !== first) {
      throw new Error(
        `nozzle_volume_type entries must all match (Bambu hardware invariant). ` +
          `Got: ${JSON.stringify(arr)}. ` +
          `Both nozzles on H2-series printers always have identical flow type.`
      );
    }
  }
}

/** Best-effort extruder count for fallback nozzle_volume_type sizing. */
/** BambuStudio's built-in filament_colour default. */
export const DEFAULT_FILAMENT_COLOUR = "#00AE42";
const FILAMENT_COLOUR_RE = /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/;

/**
 * No BBL filament profile defines `filament_colour`; the GUI fills it from
 * the AMS. Without it the CLI keeps a single-entry colour vector however many
 * filaments are loaded and crashes (access violation) as soon as a slice uses
 * any filament after the first. Give every slot exactly one colour.
 */
function ensureFilamentColour(flat: Record<string, unknown>, colour?: string): void {
  if (colour !== undefined) {
    if (!FILAMENT_COLOUR_RE.test(colour)) {
      throw new Error(`Invalid filament colour "${colour}"; expected #RRGGBB.`);
    }
    flat["filament_colour"] = [colour];
    return;
  }
  const own = flat["filament_colour"];
  if (Array.isArray(own) && typeof own[0] === "string" && FILAMENT_COLOUR_RE.test(own[0])) {
    flat["filament_colour"] = [own[0]];
    return;
  }
  flat["filament_colour"] = [DEFAULT_FILAMENT_COLOUR];
}

// BambuStudio's defaults when a process sets no prime tower position/width.
const DEFAULT_WIPE_TOWER_X = 15;
const DEFAULT_WIPE_TOWER_Y = 220;
const DEFAULT_PRIME_TOWER_WIDTH = 35;
// Clearance inside the shared nozzle area for the auto-sized tower brim and
// the CLI's own safety margin (X2D fails at 5 mm from the edge, passes at 6).
const WIPE_TOWER_MARGIN = 15;

interface Rect { minX: number; maxX: number; minY: number; maxY: number }

function parseArea(area: string): Rect {
  const points = area.split(",").map((p) => p.trim().split("x").map(Number));
  if (points.length < 3 || points.some((p) => p.length !== 2 || p.some((n) => !Number.isFinite(n)))) {
    throw new Error(`Malformed extruder_printable_area entry "${area}".`);
  }
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

/**
 * On multi-nozzle machines (H2D, X2D) each nozzle reaches only part of the
 * bed (`extruder_printable_area`), and the prime tower must be reachable by
 * every nozzle. The CLI's default tower position (x=15) lies outside the
 * X2D/H2D right-nozzle area, so slicing fails with "G-code outside of the
 * printable area". When the process sets no position and the default does
 * not fit, move the tower inside the area all nozzles share.
 */
function placePrimeTowerForAllNozzles(
  machineFlat: Record<string, unknown>,
  processFlat: Record<string, unknown>
): void {
  if (processFlat["wipe_tower_x"] !== undefined || processFlat["wipe_tower_y"] !== undefined) return;
  if (["0", "false"].includes(String(processFlat["enable_prime_tower"]).toLowerCase())) return;
  const areas = machineFlat["extruder_printable_area"];
  if (!Array.isArray(areas) || areas.length < 2) return;
  const rects = areas.map((a) => {
    if (typeof a !== "string") throw new Error("Malformed extruder_printable_area in machine profile.");
    return parseArea(a);
  });
  const shared: Rect = {
    minX: Math.max(...rects.map((r) => r.minX)) + WIPE_TOWER_MARGIN,
    maxX: Math.min(...rects.map((r) => r.maxX)) - WIPE_TOWER_MARGIN,
    minY: Math.max(...rects.map((r) => r.minY)) + WIPE_TOWER_MARGIN,
    maxY: Math.min(...rects.map((r) => r.maxY)) - WIPE_TOWER_MARGIN,
  };
  const width = Number(processFlat["prime_tower_width"] ?? DEFAULT_PRIME_TOWER_WIDTH);
  const size = Number.isFinite(width) && width > 0 ? width : DEFAULT_PRIME_TOWER_WIDTH;
  if (shared.maxX - shared.minX < size || shared.maxY - shared.minY < size) {
    throw new Error("No bed area is reachable by every nozzle for the prime tower.");
  }
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
  const x = clamp(DEFAULT_WIPE_TOWER_X, shared.minX, shared.maxX - size);
  const y = clamp(DEFAULT_WIPE_TOWER_Y, shared.minY, shared.maxY - size);
  if (x === DEFAULT_WIPE_TOWER_X && y === DEFAULT_WIPE_TOWER_Y) return;
  processFlat["wipe_tower_x"] = [String(x)];
  processFlat["wipe_tower_y"] = [String(y)];
}

function inferExtruderCount(flat: Record<string, unknown>): number {
  for (const key of ["nozzle_diameter", "extruder_type", "extruder_variant_list"]) {
    const v = flat[key];
    if (Array.isArray(v) && v.length > 0) return v.length;
  }
  return 1;
}

/**
 * Validate the selected model's CLI config before making a bundled profile
 * into a User profile. A1-family models require machine_limits overrides;
 * other official models (including P1S and H2D) intentionally declare only
 * downward_check. Missing config cannot tell us whether limits are required.
 * Returns whether limits were applied, not whether validation succeeded.
 */
async function applyCliOverlay(
  flat: Record<string, unknown>,
  profilesRoot: string,
  vendor: string
): Promise<boolean> {
  const cliConfigPath = path.join(profilesRoot, vendor, "cli_config.json");
  const fail = (reason: string): never => {
    throw new Error(
      `Cannot prepare machine profile "${String(flat["name"])}" ` +
      `(model "${String(flat["printer_model"] ?? stripNozzleSuffix(String(flat["name"])))}"): ` +
      `${cliConfigPath}: ${reason}. Check your BambuStudio installation or BAMBU_PROFILES_ROOT.`
    );
  };
  let raw: string;
  try {
    raw = await fs.readFile(cliConfigPath, "utf8");
  } catch {
    return fail("required CLI configuration is missing or unreadable");
  }
  let cliConfig: unknown;
  try {
    cliConfig = JSON.parse(raw);
  } catch {
    return fail("invalid JSON in required CLI configuration");
  }
  if (!isRecord(cliConfig)) return fail("expected a CLI configuration object");
  const printerSection = cliConfig["printer"];
  if (!isRecord(printerSection)) return fail("expected a printer configuration object");

  // Match key: cli_config.json keys are bare printer names like
  // "Bambu Lab H2D" / "Bambu Lab A1". If no model is provided, try preset
  // identity with the nozzle suffix stripped, then the name as-is.
  // An explicit model is authoritative; do not silently use another model's
  // limits because a stale preset name happens to match.
  const candidates = typeof flat["printer_model"] === "string" && flat["printer_model"].trim()
    ? [flat["printer_model"]]
    : [
      typeof flat["printer_settings_id"] === "string"
        ? stripNozzleSuffix(flat["printer_settings_id"])
        : undefined,
      typeof flat["name"] === "string" ? stripNozzleSuffix(flat["name"]) : undefined,
      flat["name"],
    ].filter((v): v is string => typeof v === "string" && v.length > 0);

  const model = candidates.find(key => Object.prototype.hasOwnProperty.call(printerSection, key));
  if (!model) return fail(`selected model is absent (looked for ${candidates.join(", ")})`);
  const block = printerSection[model];
  if (!isRecord(block)) return fail(`printer.${model} must be an object`);

  const downward = block["downward_check"];
  if (Object.prototype.hasOwnProperty.call(block, "downward_check") && (
    !isRecord(downward) || Object.keys(downward).length === 0 ||
    Object.entries(downward).some(([name, values]) => !name.trim() || !Array.isArray(values) ||
      values.some(value => typeof value !== "string" || !value.trim()))
  )) {
    return fail(`printer.${model}.downward_check must map profile names to arrays of names`);
  }

  if (!Object.prototype.hasOwnProperty.call(block, "machine_limits")) {
    if (!isRecord(downward)) return fail(`printer.${model} has neither machine_limits nor downward_check`);
    return false;
  }
  const limits = block["machine_limits"];
  if (!isRecord(limits) || Object.keys(limits).length === 0) {
    return fail(`printer.${model}.machine_limits must be a nonempty object`);
  }
  const limitKey = /^cli_safe_(?:acceleration_(?:e|extruding|retracting|travel|x|y|z)|(?:jerk|speed)_(?:e|x|y|z))$/;
  for (const [key, value] of Object.entries(limits)) {
    if (!limitKey.test(key) || typeof value !== "string" ||
      value.split(",").some(part => !part.trim() || !Number.isFinite(Number(part)) || Number(part) < 0)) {
      return fail(`printer.${model}.machine_limits contains an invalid limit "${key}"`);
    }
  }
  // CLI safety values override even explicit values in the selected leaf.
  Object.assign(flat, limits);
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Ensure the chosen machine is in the process/filament's
 * `compatible_printers` list. This mirrors what the GUI does when you
 * save a project with a printer/process combo that wasn't in the
 * shipped compat list.
 */
function ensureMachineInCompatList(
  flat: Record<string, unknown>,
  machineLeaf: string
): void {
  const list = flat["compatible_printers"];
  if (!Array.isArray(list)) {
    flat["compatible_printers"] = [machineLeaf];
    return;
  }
  if (!list.includes(machineLeaf)) {
    list.push(machineLeaf);
  }
}

function stripNozzleSuffix(name: string): string {
  return name.replace(/\s+\d+\.\d+\s+nozzle.*$/, "");
}

/**
 * Adjust fields for CLI consumption.
 *
 * - Strip `inherits` and `instantiation` (chain marker, abstract-base flag).
 *   The GUI consumes them; the CLI treats anything still present as part of
 *   the merged config.
 * - Rewrite `from`. Leaf BBL profiles ship with `"from": "system"`, which
 *   the CLI rejects when loaded via `--load-settings` (system presets
 *   aren't supposed to be loaded that way). The GUI rewrites this to
 *   `"from": "project"` when it embeds the merged config in a 3MF. We do
 *   the same so the CLI accepts our flattened temp file.
 * - Strip `setting_id` / `is_custom_defined` (user-registry markers that
 *   make no sense on a transient flattened file).
 */
function normalizeForCli(
  flat: Record<string, unknown>,
  kind: ProfileKind,
  leafName: string
): void {
  // Set inherits to the leaf name BEFORE we delete it below, so the
  // CLI's system_name resolution lands on the right value.
  // (See note further down for why this matters.)
  flat["inherits"] = leafName;
  // Identity field. The CLI sets this internally, but we mirror it for
  // consistency with what the GUI's project_settings.config emits.
  switch (kind) {
    case "machine":
      flat["printer_settings_id"] = leafName;
      break;
    case "process":
      flat["print_settings_id"] = leafName;
      break;
    case "filament":
      flat["filament_settings_id"] = [leafName];
      break;
  }

  // CRITICAL: when from=="User", the CLI computes `system_name = inherits`
  // and the compatibility check compares the *other* configs'
  // `compatible_printers` list against that system_name. The leaf
  // profiles' compat lists contain the leaf machine name (e.g.
  // "Bambu Lab H2S 0.4 nozzle"), so we must set `inherits` on the
  // flattened machine to that same leaf name. For process/filament,
  // `inherits` doesn't drive the compat check we hit, but we set it for
  // symmetry so any future check succeeds the same way.
  // Source: BambuStudio.cpp ~line 2222 (from!="system" -> system_name = inherits).
  // NOTE: do NOT delete inherits -- we just set it above. The CLI uses
  // its value (when from=="User") for the system_name compat check.
  delete flat["instantiation"];
  delete flat["setting_id"];
  delete flat["is_custom_defined"];
  // Always rewrite `from` to "User". "Project" is what the GUI uses when
  // embedding in a 3MF, but the CLI accepts "User" for --load-settings
  // paths and that's semantically what we are.
  flat["from"] = "User";
  // Mirror the GUI's behavior of clearing compatibility constraints in the
  // merged project config. The leaf process/filament profiles ship with
  // `compatible_printers: ["Bambu Lab H2S 0.4 nozzle"]` etc., and the CLI
  // re-validates that list against our flattened machine config -- which
  // has had `from` rewritten and inheritance collapsed, so the equality
  // check fails. The GUI's project_settings.config has these set to null
  // because at that point compatibility is already established by the
  // user. We do the same.
  // Leave compatible_printers / compatible_prints as the leaf declared
  // them. The GUI nulls these in embedded project configs, but the CLI's
  // --load-settings path requires a non-empty list and matches against
  // the machine's `name` / `printer_settings_id`. The leaves ship with
  // the correct list ([machine_leaf_name]) so just preserve.
  // _condition fields can stay null (string-typed, tolerated as null).
}

function applyBedType(processFlat: Record<string, unknown>, bedType?: string): void {
  if (!bedType) return;
  processFlat.curr_bed_type = bedType;
}

function applyMachineModelBedMetadata(
  machineFlat: Record<string, unknown>,
  index: NameIndex
): void {
  const modelName = machineFlat.printer_model;
  if (typeof modelName !== "string") return;

  const model = index.get(modelName)?.data;
  if (!model) return;

  for (const key of ["default_bed_type", "image_bed_type", "not_support_bed_type"]) {
    if (!(key in machineFlat) && key in model) {
      machineFlat[key] = model[key];
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Public entry point                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Flatten the leaf profiles, post-process for CLI, and write to temp files.
 *
 * Throws on unknown leaf names, missing profilesRoot, or cycles.
 */
export async function flattenForCli(opts: FlattenOptions): Promise<FlattenedProfiles> {
  const vendor = opts.vendor ?? "BBL";
  if (vendor !== "BBL") {
    throw new Error(
      `profile-flatten: only BBL vendor is supported (got "${vendor}"). ` +
        `Other vendors are out of scope -- contributions welcome but untested.`
    );
  }

  // Confirm the profiles root looks plausible before doing real work.
  const probe = path.join(opts.profilesRoot, vendor, "machine");
  try {
    await fs.access(probe);
  } catch {
    throw new Error(
      `profile-flatten: profilesRoot "${opts.profilesRoot}" does not contain "${vendor}/machine". ` +
        `Set BAMBU_PROFILES_ROOT or check your BambuStudio install.`
    );
  }

  // Machine inheritance must never resolve through user process/filament files.
  const machineIndex = await buildNameIndex(opts.profilesRoot, vendor);
  const index = opts.userProfileRoots?.length
    ? await buildNameIndex(opts.profilesRoot, vendor, opts.userProfileRoots)
    : machineIndex;

  // Flatten each leaf.
  if (opts.sourceProfiles?.filaments && opts.sourceProfiles.filaments.length !== opts.filamentLeaves.length) {
    throw new Error("Every filament slot must have a source profile.");
  }
  const machineFlat = opts.sourceProfiles?.machine
    ? flattenData(opts.sourceProfiles.machine, machineIndex)
    : flattenByName(opts.machineLeaf, machineIndex);
  const processFlat = opts.sourceProfiles?.process
    ? flattenData(opts.sourceProfiles.process, index)
    : flattenByName(opts.processLeaf, index);
  const filamentFlats = opts.filamentLeaves.map((n, i) => {
    const source = opts.sourceProfiles?.filaments?.[i];
    return source ? flattenData(source, index) : flattenByName(n, index);
  });

  // CLI-specific post-processing on machine profile only.
  deriveNozzleVolumeType(machineFlat, opts.nozzleVolumeType);
  applyMachineModelBedMetadata(machineFlat, machineIndex);
  // A standalone custom machine can accompany process/filament profiles that
  // need BBL resolution; do not impose bundled model config on that machine.
  const sourceMachine = opts.sourceProfiles?.machine;
  const standaloneMachine = sourceMachine && String(sourceMachine.from).toLowerCase() !== "system" &&
    !(typeof sourceMachine.inherits === "string" && sourceMachine.inherits.length > 0) &&
    (sourceMachine.include === undefined || sourceMachine.include === null);
  const cliConfigValidated = !standaloneMachine;
  const cliOverlayApplied = cliConfigValidated
    ? await applyCliOverlay(machineFlat, opts.profilesRoot, vendor)
    : false;

  // Normalize each flattened profile for CLI consumption.
  normalizeForCli(machineFlat, "machine", opts.machineLeaf);
  normalizeForCli(processFlat, "process", opts.processLeaf);
  filamentFlats.forEach((f, i) => normalizeForCli(f, "filament", opts.filamentLeaves[i]));
  if (opts.filamentColours && opts.filamentColours.length !== filamentFlats.length) {
    throw new Error(
      `${opts.filamentColours.length} filament colours were supplied for ${filamentFlats.length} filament slots.`
    );
  }
  filamentFlats.forEach((f, i) => ensureFilamentColour(f, opts.filamentColours?.[i]));
  applyBedType(processFlat, opts.bedType);
  if (processFlat["wipe_tower_x"] === undefined && processFlat["wipe_tower_y"] === undefined) {
    Object.assign(processFlat, opts.projectTowerPosition);
  }
  placePrimeTowerForAllNozzles(machineFlat, processFlat);

  // Mirror the GUI's auto-extend behavior: when the caller explicitly
  // chose a process or filament that wasn't pre-declared compatible with
  // the chosen machine (e.g. "0.20mm Standard @BBL P1P" used on a P1S),
  // add the machine name to the process/filament compat list. The GUI
  // does this implicitly when saving a project.
  ensureMachineInCompatList(processFlat, opts.machineLeaf);
  filamentFlats.forEach((f) => ensureMachineInCompatList(f, opts.machineLeaf));

  // Hash the resolved content so concurrent jobs using the same preset with
  // different overrides never overwrite each other's input files.
  await fs.mkdir(opts.tempDir, { recursive: true });
  const machinePath = await writeTemp(opts.tempDir, "machine", opts.machineLeaf, machineFlat);
  const processPath = await writeTemp(opts.tempDir, "process", opts.processLeaf, processFlat);
  const filamentPaths: string[] = [];
  for (let i = 0; i < filamentFlats.length; i++) {
    filamentPaths.push(
      await writeTemp(opts.tempDir, `filament-${i}`, opts.filamentLeaves[i], filamentFlats[i])
    );
  }

  return {
    machinePath,
    processPath,
    filamentPaths,
    meta: {
      profilesRoot: opts.profilesRoot,
      machineLeafName: opts.machineLeaf,
      processLeafName: opts.processLeaf,
      filamentLeafNames: opts.filamentLeaves,
      cliConfigValidated,
      cliOverlayApplied,
    },
  };
}

async function writeTemp(
  tempDir: string,
  kind: string,
  leafName: string,
  data: Record<string, unknown>
): Promise<string> {
  const serialized = JSON.stringify(data, null, 2);
  const hash = crypto.createHash("sha256").update(leafName).update("\0").update(serialized).digest("hex").slice(0, 16);
  const safe = leafName.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 64);
  const filename = `flat-${kind}-${safe}-${hash}.json`;
  const out = path.join(tempDir, filename);
  await fs.writeFile(out, serialized, "utf8");
  return out;
}

/* -------------------------------------------------------------------------- */
/* Profile root detection                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Given the SLICER_PATH (path to BambuStudio executable), walk up to the
 * profile directory for that installation (macOS, Windows, or Linux prefix).
 *
 * Override via BAMBU_PROFILES_ROOT env.
 */
export function detectProfilesRoot(slicerPath?: string, slicerType = 'bambustudio'): string {
  if (process.env["BAMBU_PROFILES_ROOT"]) {
    return process.env["BAMBU_PROFILES_ROOT"];
  }

  if (slicerPath) {
    let executable = slicerPath;
    if (!slicerPath.includes('/') && !slicerPath.includes('\\')) {
      const located = (process.env.PATH ?? '').split(path.delimiter)
        .map(dir => path.join(dir, slicerPath))
        .find(candidate => existsSync(candidate));
      if (located) executable = located;
    }
    // Package-manager launchers may be symlinks into the installation prefix.
    try { executable = realpathSync(executable); } catch { /* Probe the supplied path below. */ }
    const bin = path.dirname(executable);
    const installNames = slicerType === 'bambustudio'
      ? ['BambuStudio', 'bambu-studio']
      : ['OrcaSlicer', 'orca-slicer', 'OrcaStudio', 'orca-studio'];
    const candidates = path.basename(bin) === 'MacOS'
      ? [path.resolve(bin, '..', 'Resources', 'profiles')]
      : [
          path.join(bin, 'resources', 'profiles'),
          path.join(bin, 'Resources', 'profiles'),
          ...installNames.flatMap(name => [
            path.resolve(bin, '..', 'share', name, 'profiles'),
            path.resolve(bin, '..', 'share', name, 'resources', 'profiles'),
          ]),
        ];
    const found = candidates.find(root => existsSync(path.join(root, 'BBL', 'machine')));
    // Do not select another installation if this executable has no profile tree.
    // flattenForCli reports the missing tree and asks for BAMBU_PROFILES_ROOT.
    return found ?? candidates[0];
  }

  // Default macOS install.
  return slicerType === 'bambustudio'
    ? '/Applications/BambuStudio.app/Contents/Resources/profiles'
    : '/Applications/OrcaSlicer.app/Contents/Resources/profiles';
}
