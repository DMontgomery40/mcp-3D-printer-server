/**
 * Bambu-compatible CLI (BambuStudio, OrcaSlicer, FULU OrcaSlicer-bambulab)
 * profile preparation. Ported from bambu-printer-mcp's STLManipulator so both
 * servers share the same safety semantics:
 *
 * - The exact model/nozzle machine preset must exist in the selected
 *   installation's BBL tree; it is never borrowed from another tree.
 * - `inherits` and `include` are resolved recursively (profile-flatten.ts);
 *   missing references, cycles, and malformed profiles stop preparation.
 * - Custom process/filament overrides keep their own values on top of their
 *   resolved parents; filament slots keep their positional order.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { flattenForCli, detectProfilesRoot, resolveBblMachineProfile } from "./profile-flatten.js";

export type BambuCliSlicerType = "bambustudio" | "orcaslicer" | "orcaslicer-bambulab";

export const BAMBU_CLI_BED_TYPES: Record<string, string> = {
  textured_plate: "Textured PEI Plate",
  cool_plate: "Cool Plate",
  engineering_plate: "Engineering Plate",
  hot_plate: "High Temp Plate",
};

/** Bambu-compatible slicer CLI options exposed through slice_stl. */
export interface BambuSliceOptions {
  uptodate?: boolean;          // --uptodate: update 3MF configs to latest presets
  repetitions?: number;        // --repetitions N: print N copies
  orient?: boolean;            // --orient 1: auto-orient for printability
  arrange?: boolean;           // --arrange 1: auto-arrange objects on plate
  ensureOnBed?: boolean;       // --ensure-on-bed: lift floating models onto bed
  cloneObjects?: string;       // --clone-objects "1,3,1,10": clone counts per object
  skipObjects?: string;        // --skip-objects "3,5,10": skip specific objects
  loadFilaments?: string;      // "f1.json;f2.json": positional filament profiles
  loadFilamentIds?: string;    // --load-filament-ids "1,2,3,1": filament-to-object mapping
  filamentColours?: string[];  // positional #RRGGBB per loaded filament slot
  bedType?: string;            // textured_plate, cool_plate, engineering_plate, hot_plate
  nozzleType?: string;         // installed hotend material written into the machine preset
  enableTimelapse?: boolean;   // --enable-timelapse
  allowMixTemp?: boolean;      // --allow-mix-temp
  scale?: number;              // --scale factor
  rotate?: number;             // --rotate degrees (Z)
  rotateX?: number;            // --rotate-x degrees
  rotateY?: number;            // --rotate-y degrees
  minSave?: boolean;           // --min-save
  skipModifiedGcodes?: boolean;// --skip-modified-gcodes
  slicePlate?: number;         // --slice N (0 = all plates)
}

export interface BambuSettingsBundle {
  settingsArg?: string;
  filamentPaths: string[];
  /** Positional slot colours declared by the input 3MF project. */
  filamentColours?: string[];
  /** Saved per-plate tower coordinates must survive default process loading. */
  projectTowerPosition?: { wipe_tower_x?: unknown; wipe_tower_y?: unknown };
  /** Identity provenance before the process is merged into a generated file. */
  processSource?: { filePath: string; profile: Record<string, unknown> };
}

/**
 * User/system profile directories searched for custom process and filament
 * dependencies (never for machine presets). BAMBU_SLICER_PROFILE_DIRS
 * (path-delimiter separated) replaces the defaults; an empty value disables them.
 */
export function configuredBambuProfileDirs(): string[] {
  const override = process.env.BAMBU_SLICER_PROFILE_DIRS;
  if (override !== undefined) {
    return override.split(path.delimiter).filter(Boolean);
  }

  const home = os.homedir();
  const roots = [
    path.join(home, "Library", "Application Support"),
    path.join(home, ".config"),
    ...(process.env.APPDATA ? [process.env.APPDATA] : []),
    ...(process.env.LOCALAPPDATA ? [process.env.LOCALAPPDATA] : []),
  ];
  const appNames = ["BambuStudio", "Bambu Studio", "OrcaSlicer", "Orca Slicer", "OrcaStudio", "Orca Studio"];
  return roots.flatMap((root) => appNames.map((appName) => path.join(root, appName, "system", "BBL")));
}

export function resolveBambuCliBedType(bedType?: string): string | undefined {
  if (!bedType) return undefined;
  const normalized = bedType.trim().toLowerCase();
  if (normalized === "supertack_plate") {
    throw new Error(
      "The Bambu CLI SuperTack bed type is not verified; use a pre-sliced 3MF or choose textured_plate, cool_plate, engineering_plate, or hot_plate."
    );
  }
  return BAMBU_CLI_BED_TYPES[normalized] || bedType;
}

export class BambuCliProfilePreparer {
  constructor(private readonly tempDir: string) {}

  private readJsonFile(filePath: string): any {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  }

  writeTempJson(outputBase: string, suffix: string, value: unknown): string {
    const serialized = JSON.stringify(value, null, 2);
    const hash = crypto.createHash("sha256").update(serialized).digest("hex").slice(0, 16);
    fs.mkdirSync(this.tempDir, { recursive: true });
    const safeBase = outputBase.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 64);
    const outPath = path.join(this.tempDir, `${safeBase}_${suffix}_${hash}.json`);
    fs.writeFileSync(outPath, serialized);
    return outPath;
  }

  private findProfileFile(
    category: "machine" | "process" | "filament",
    profileName: string | undefined,
    roots: string[]
  ): string | undefined {
    if (!profileName) return undefined;
    // Names are looked up as files; never let a name escape the profile tree.
    if (profileName.includes("/") || profileName.includes("\\") || profileName.includes("\0")) return undefined;
    for (const root of roots) {
      const candidate = path.join(root, category, `${profileName}.json`);
      if (fs.existsSync(candidate)) return candidate;
    }
    return undefined;
  }

  private buildFilamentIdIndex(roots: string[]): Map<string, string> {
    const index = new Map<string, string>();
    for (const root of roots) {
      const filamentDir = path.join(root, "filament");
      if (!fs.existsSync(filamentDir)) continue;
      for (const entry of fs.readdirSync(filamentDir)) {
        if (!entry.endsWith(".json")) continue;
        const filePath = path.join(filamentDir, entry);
        try {
          const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
          const filamentId = typeof parsed?.filament_id === "string" ? parsed.filament_id.trim() : "";
          if (filamentId && !index.has(filamentId)) index.set(filamentId, filePath);
        } catch {
          // A malformed unrelated profile cannot satisfy an ID lookup; a
          // requested ID that stays unresolved is rejected by the caller.
        }
      }
    }
    return index;
  }

  private stripAbsoluteExtruderResets(value: unknown): unknown {
    if (typeof value === "string") {
      return value.split(/\r?\n/).filter((line) => line.trim().toUpperCase() !== "G92 E0").join("\n");
    }
    if (Array.isArray(value)) {
      return value.filter((line) => String(line).trim().toUpperCase() !== "G92 E0");
    }
    return value;
  }

  /** Orca's existing absolute-extrusion normalization for process G-code. */
  sanitizeProcessForOrca(processConfig: any, printerPreset?: string): any {
    const sanitized = { ...processConfig };
    sanitized.type = "process";
    if (!sanitized.from || sanitized.from === "project") sanitized.from = "User";
    if (printerPreset) sanitized.compatible_printers = [printerPreset];
    if (sanitized.prime_tower_brim_width !== undefined && Number(sanitized.prime_tower_brim_width) < 0) {
      sanitized.prime_tower_brim_width = "0";
    } else if (sanitized.prime_tower_brim_width !== undefined) {
      sanitized.prime_tower_brim_width = String(sanitized.prime_tower_brim_width);
    }
    sanitized.use_relative_e_distances = "0";
    sanitized.before_layer_change_gcode = this.stripAbsoluteExtruderResets(sanitized.before_layer_change_gcode);
    sanitized.layer_gcode = this.stripAbsoluteExtruderResets(sanitized.layer_gcode);
    sanitized.layer_change_gcode = this.stripAbsoluteExtruderResets(sanitized.layer_change_gcode);
    return sanitized;
  }

  /**
   * The same normalization for the machine file. Machine isolation drops these
   * keys from the process when the machine defines them, so the machine copy
   * must carry the absolute-extrusion values or Orca would pair absolute E with
   * the machine's G92 E0 resets.
   */
  sanitizeMachineForOrca(machineConfig: any): any {
    const sanitized = { ...machineConfig };
    if (sanitized.use_relative_e_distances !== undefined) sanitized.use_relative_e_distances = "0";
    for (const key of ["before_layer_change_gcode", "layer_gcode", "layer_change_gcode"]) {
      if (sanitized[key] !== undefined) sanitized[key] = this.stripAbsoluteExtruderResets(sanitized[key]);
    }
    return sanitized;
  }

  /**
   * Select the machine preset, process, and positional filament profiles
   * from the active installation. Throws before any slicer runs when the
   * exact machine preset or a named dependency is missing.
   */
  async resolveSettingsBundle(
    outputBase: string,
    slicerType: BambuCliSlicerType,
    activeProfilesRoot: string,
    printerPreset: string | undefined,
    slicerProfile: string | undefined,
    options: BambuSliceOptions = {}
  ): Promise<BambuSettingsBundle> {
    const roots = [path.join(activeProfilesRoot, "BBL")];
    const userRoots = configuredBambuProfileDirs();
    const findProfile = (kind: "machine" | "process" | "filament", name?: string) =>
      this.findProfileFile(kind, name, kind === "machine" ? roots : [...roots, ...userRoots]);

    if (!printerPreset) {
      throw new Error(
        "Printer preset is required for Bambu-compatible CLI slicing; select the exact bambu_model and nozzle_diameter."
      );
    }
    const machinePath = findProfile("machine", printerPreset);
    if (!machinePath) {
      throw new Error(
        `Printer profile "${printerPreset}" was not found in ${path.join(roots[0], "machine")}. ` +
        `Check bambu_model/nozzle_diameter against the installed ${slicerType} version, or set BAMBU_PROFILES_ROOT ` +
        `to the matching profile tree; refusing to use printer defaults or another installation's preset.`
      );
    }
    let machineConfig: any;
    try {
      machineConfig = this.readJsonFile(machinePath);
      if (!machineConfig || Array.isArray(machineConfig) || machineConfig.name !== printerPreset) {
        throw new Error("expected a JSON machine profile with the selected preset name");
      }
    } catch (error: any) {
      throw new Error(`Printer profile "${printerPreset}" is invalid: ${error?.message ?? error}`);
    }
    // Some FULU/Orca machine leaves inherit their default process/filaments.
    // Resolve those selections before building the positional CLI bundle.
    machineConfig = await resolveBblMachineProfile(activeProfilesRoot, printerPreset);

    const filamentPaths: string[] = [];
    let processPath: string | undefined;
    let processSource: BambuSettingsBundle["processSource"];

    if (slicerProfile) {
      if (!fs.existsSync(slicerProfile)) {
        throw new Error(
          `Slicer process profile not found: ${slicerProfile} (from slicer_profile, a template, or SLICER_PROFILE). ` +
          "Fix the path, or leave slicer_profile and SLICER_PROFILE empty to use the machine preset's default process."
        );
      }
      let parsedProfile: any = null;
      try {
        parsedProfile = this.readJsonFile(slicerProfile);
      } catch {
        parsedProfile = null;
      }

      if (parsedProfile && typeof parsedProfile === "object" && !Array.isArray(parsedProfile)) {
        processSource = { filePath: slicerProfile, profile: parsedProfile };
        const inheritedProcessName =
          (typeof parsedProfile.inherits === "string" && parsedProfile.inherits) ||
          (typeof parsedProfile.print_settings_id === "string" && parsedProfile.print_settings_id !== parsedProfile.name
            ? parsedProfile.print_settings_id
            : undefined) ||
          (typeof parsedProfile.default_print_profile === "string" ? parsedProfile.default_print_profile : undefined) ||
          (typeof machineConfig?.default_print_profile === "string" ? machineConfig.default_print_profile : undefined);

        const inheritedProcessPath = findProfile("process", inheritedProcessName);
        const inheritedProcess = inheritedProcessPath ? this.readJsonFile(inheritedProcessPath) : {};
        const mergedProcess = { ...inheritedProcess, ...parsedProfile, type: "process" };

        processPath = this.writeTempJson(
          outputBase,
          slicerType === "orcaslicer" ? "process_orca" : "process",
          slicerType === "orcaslicer" ? this.sanitizeProcessForOrca(mergedProcess, printerPreset) : mergedProcess
        );

        const defaultFilamentProfiles =
          !options.loadFilaments && Array.isArray(parsedProfile.default_filament_profile)
            ? parsedProfile.default_filament_profile
            : [];
        for (const profileName of defaultFilamentProfiles) {
          const filamentPath = findProfile("filament", String(profileName));
          if (!filamentPath) {
            throw new Error(`Filament profile "${String(profileName)}" was not found; refusing to omit its slot.`);
          }
          filamentPaths.push(filamentPath);
        }

        if (!options.loadFilaments && filamentPaths.length === 0 && Array.isArray(parsedProfile.filament_ids)) {
          const filamentIdIndex = this.buildFilamentIdIndex([...roots, ...userRoots]);
          for (const filamentId of parsedProfile.filament_ids) {
            const filamentPath = filamentIdIndex.get(String(filamentId));
            if (!filamentPath) {
              throw new Error(`Filament ID "${String(filamentId)}" could not be resolved; refusing to omit its slot.`);
            }
            filamentPaths.push(filamentPath);
          }
        }
      } else {
        // Non-JSON configs are read again during resolution and rejected there.
        processPath = slicerProfile;
      }
    }

    if (!processPath) {
      const defaultProcessName =
        typeof machineConfig?.default_print_profile === "string" ? machineConfig.default_print_profile : undefined;
      const defaultProcessPath = findProfile("process", defaultProcessName);
      if (!defaultProcessPath) {
        throw new Error(
          `Default process profile "${defaultProcessName ?? "(none declared)"}" for "${printerPreset}" was not found; ` +
          "pass slicer_profile with a process profile JSON."
        );
      }
      processPath =
        slicerType === "orcaslicer"
          ? this.writeTempJson(
              outputBase,
              "process_default_orca",
              this.sanitizeProcessForOrca(this.readJsonFile(defaultProcessPath), printerPreset)
            )
          : defaultProcessPath;
    }

    if (!options.loadFilaments && filamentPaths.length === 0 && Array.isArray(machineConfig?.default_filament_profile)) {
      for (const profileName of machineConfig.default_filament_profile) {
        const filamentPath = findProfile("filament", String(profileName));
        if (!filamentPath) {
          throw new Error(`Filament profile "${String(profileName)}" was not found; refusing to omit its slot.`);
        }
        filamentPaths.push(filamentPath);
      }
    }

    if (options.loadFilaments) {
      filamentPaths.length = 0;
      for (const filamentPath of options.loadFilaments.split(";")) {
        const trimmed = filamentPath.trim();
        if (!trimmed) continue;
        if (!fs.existsSync(trimmed)) {
          throw new Error(`Filament profile not found: ${trimmed}; refusing to omit its slot.`);
        }
        filamentPaths.push(trimmed);
      }
    }

    return {
      settingsArg: [machinePath, processPath].join(";"),
      filamentPaths,
      processSource,
    };
  }

  /** --load-filaments is positional; a single override must cover every project slot. */
  async expandProjectFilaments(inputPath: string, bundle: BambuSettingsBundle): Promise<BambuSettingsBundle> {
    if (!inputPath.toLowerCase().endsWith(".3mf") || bundle.filamentPaths.length === 0) return bundle;
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(await fs.promises.readFile(inputPath));
    const file = zip.file("Metadata/project_settings.config");
    // Geometry-only 3MFs have no embedded filament slots.
    if (!file) return bundle;
    let config: unknown;
    try {
      config = JSON.parse(await file.async("string"));
    } catch {
      throw new Error("Cannot determine project filament slots: project_settings.config is not valid JSON.");
    }
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new Error("Cannot determine project filament slots: invalid project_settings.config.");
    }
    const data = config as Record<string, unknown>;
    const count = Math.max(0, ...["filament_settings_id", "filament_type", "filament_colour", "filament_diameter"]
      .map((key) => (Array.isArray(data[key]) ? (data[key] as unknown[]).length : 0)));
    if (count === 0) throw new Error("Cannot determine project filament slots from project_settings.config.");
    // Keep the project's slot colours; loaded profiles carry none of their own.
    const colours = Array.isArray(data.filament_colour) && data.filament_colour.length === count &&
      data.filament_colour.every((c) => typeof c === "string" && /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/.test(c))
      ? (data.filament_colour as string[])
      : undefined;
    const projectTowerPosition = Object.fromEntries(["wipe_tower_x", "wipe_tower_y"]
      .filter((key) => data[key] !== undefined).map((key) => [key, data[key]]));
    if (bundle.filamentPaths.length === 1) {
      return { ...bundle, filamentPaths: Array(count).fill(bundle.filamentPaths[0]), filamentColours: colours, projectTowerPosition };
    }
    if (bundle.filamentPaths.length !== count) {
      throw new Error(
        `Project declares ${count} filament slots, but ${bundle.filamentPaths.length} profiles were supplied. ` +
        "Provide one profile for all slots or one per slot."
      );
    }
    return { ...bundle, filamentColours: colours, projectTowerPosition };
  }

  /** Resolve BBL dependencies before invoking the CLI; failures stop the slice. */
  async flattenBundle(
    bundle: BambuSettingsBundle,
    options: BambuSliceOptions,
    activeProfilesRoot?: string
  ): Promise<BambuSettingsBundle> {
    const parts = bundle.settingsArg?.split(";").filter(Boolean) ?? [];
    const readProfile = (filePath: string): Record<string, unknown> => {
      try {
        const data: unknown = this.readJsonFile(filePath);
        if (!data || typeof data !== "object" || Array.isArray(data)) {
          throw new Error("expected a JSON profile object");
        }
        return data as Record<string, unknown>;
      } catch (err: any) {
        throw new Error(`Cannot read slicer profile "${filePath}": ${err?.message ?? err}`);
      }
    };
    const settings = parts.map(readProfile);
    // Read every slot: filtering unreadable names would change positional mapping.
    const filaments = bundle.filamentPaths.map(readProfile);
    const profilesRoot = activeProfilesRoot ?? detectProfilesRoot(process.env.SLICER_PATH);
    const profileRoots = [path.join(profilesRoot, "BBL")];
    const hasReferences = (profile: Record<string, unknown>) =>
      (typeof profile.inherits === "string" && profile.inherits.length > 0) ||
      (profile.include !== undefined && profile.include !== null);
    const isBundledFile = (filePath: string) =>
      profileRoots.some((root) => {
        const relative = path.relative(root, filePath);
        return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
      });
    const isBundled = (filePath: string, profile: Record<string, unknown>) =>
      String(profile.from).toLowerCase() === "system" || isBundledFile(filePath);
    const needsResolution = (filePath: string, profile: Record<string, unknown>) =>
      hasReferences(profile) || isBundled(filePath, profile);
    if (![...settings, ...filaments].some((profile, i) =>
      needsResolution([...parts, ...bundle.filamentPaths][i], profile))) return bundle;
    if (parts.length !== 2) {
      throw new Error("Resolving BBL profiles requires both a machine and process profile; refusing to slice with unresolved settings.");
    }

    const [machinePath, processPath] = parts;
    const [machine, processProfile] = settings;
    const leafName = (filePath: string, profile: Record<string, unknown>): string => {
      // A user preset inherits its system identity, while keeping its own values.
      const name = !isBundled(filePath, profile) && typeof profile.inherits === "string" && profile.inherits
        ? profile.inherits
        : profile.name;
      if (typeof name !== "string" || !name) {
        if (needsResolution(filePath, profile)) throw new Error(`Cannot determine the profile name for "${filePath}".`);
        return path.basename(filePath, ".json");
      }
      return name;
    };
    const flat = await flattenForCli({
      machineLeaf: leafName(machinePath, machine),
      // A generated path loses bundled provenance; inherited metadata can also
      // make a custom preset look like a system profile. Use the original source
      // only for identity and retain the prepared values in sourceProfiles below.
      processLeaf: bundle.processSource
        ? leafName(bundle.processSource.filePath, bundle.processSource.profile)
        : leafName(processPath, processProfile),
      filamentLeaves: filaments.map((profile, i) => leafName(bundle.filamentPaths[i], profile)),
      profilesRoot,
      userProfileRoots: configuredBambuProfileDirs(),
      tempDir: this.tempDir,
      bedType: resolveBambuCliBedType(options.bedType),
      filamentColours: options.filamentColours ?? bundle.filamentColours,
      projectTowerPosition: bundle.projectTowerPosition,
      sourceProfiles: {
        machine: isBundledFile(machinePath) ? undefined : machine,
        process: isBundledFile(processPath) ? undefined : processProfile,
        filaments: filaments.map((profile, i) => (isBundledFile(bundle.filamentPaths[i]) ? undefined : profile)),
      },
    });
    // Standalone files retain their own identity and settings, but still need
    // the CLI colour/tower fields. Do not discard those required overlays when
    // choosing the original profile instead of the normalized BBL output.
    const withCliFields = (filePath: string, profile: Record<string, unknown>, flatPath: string, keys: string[]): string => {
      const flattened = readProfile(flatPath);
      const fields = Object.fromEntries(keys.filter((key) => flattened[key] !== undefined).map((key) => [key, flattened[key]]));
      if (Object.entries(fields).every(([key, value]) => JSON.stringify(profile[key]) === JSON.stringify(value))) return filePath;
      return this.writeTempJson(path.basename(filePath, ".json"), "cli", { ...profile, ...fields });
    };
    return {
      settingsArg: [
        needsResolution(machinePath, machine) ? flat.machinePath : machinePath,
        needsResolution(processPath, processProfile)
          ? flat.processPath
          : withCliFields(processPath, processProfile, flat.processPath, ["wipe_tower_x", "wipe_tower_y"]),
      ].join(";"),
      filamentPaths: filaments.map((profile, i) =>
        needsResolution(bundle.filamentPaths[i], profile)
          ? flat.filamentPaths[i]
          : withCliFields(bundle.filamentPaths[i], profile, flat.filamentPaths[i], ["filament_colour"])),
    };
  }

  /**
   * Full preparation: select profiles, expand project slots, resolve every
   * BBL dependency, and apply Orca's post-resolution normalization.
   */
  async prepare(
    inputPath: string,
    outputBase: string,
    slicerType: BambuCliSlicerType,
    activeProfilesRoot: string,
    printerPreset: string | undefined,
    slicerProfile: string | undefined,
    options: BambuSliceOptions
  ): Promise<BambuSettingsBundle> {
    const rawBundle = await this.resolveSettingsBundle(
      outputBase, slicerType, activeProfilesRoot, printerPreset, slicerProfile, options);
    const bundle = await this.flattenBundle(
      await this.expandProjectFilaments(inputPath, rawBundle), options, activeProfilesRoot);
    // The machine preset assumes the stock hotend; record the installed one so
    // the sliced job's nozzle_type matches what the printer reports.
    if (options.nozzleType && bundle.settingsArg) {
      const [machinePath, ...rest] = bundle.settingsArg.split(";");
      const machine = this.readJsonFile(machinePath);
      const current = machine.nozzle_type;
      machine.nozzle_type = Array.isArray(current) && current.length > 0 ? current.map(() => options.nozzleType) : [options.nozzleType];
      bundle.settingsArg = [this.writeTempJson(outputBase, `machine_${options.nozzleType}`, machine), ...rest].join(";");
    }
    // Inherited process G-code is now present; apply Orca's existing
    // absolute-extrusion normalization after resolving those ancestors.
    if (slicerType === "orcaslicer" && bundle.settingsArg) {
      const [machinePath, processPath] = bundle.settingsArg.split(";");
      bundle.settingsArg = [
        this.writeTempJson(outputBase, "machine_orca_resolved", this.sanitizeMachineForOrca(this.readJsonFile(machinePath))),
        this.writeTempJson(outputBase, "process_orca_resolved", this.sanitizeProcessForOrca(this.readJsonFile(processPath), printerPreset)),
      ].join(";");
    }
    return this.isolateMachineSettings(bundle);
  }

  /**
   * The CLI applies every key in every --load-settings/--load-filaments file,
   * so machine settings carried by a process or filament file (for example a
   * template 3MF's project_settings from another printer) would replace the
   * selected preset's start G-code, model, and bed geometry. The machine
   * preset owns those keys; drop them from the other profiles.
   */
  private isolateMachineSettings(bundle: BambuSettingsBundle): BambuSettingsBundle {
    const [machinePath, processPath] = bundle.settingsArg?.split(";") ?? [];
    if (!machinePath || !processPath) return bundle;
    const machineKeys = Object.keys(this.readJsonFile(machinePath)).filter((key) => !PROFILE_METADATA_KEYS.has(key));
    const isolate = (filePath: string, label: string): string => {
      const profile = this.readJsonFile(filePath);
      const foreign = machineKeys.filter((key) => Object.prototype.hasOwnProperty.call(profile, key));
      if (foreign.length === 0) return filePath;
      const isolated = { ...profile };
      for (const key of foreign) delete isolated[key];
      console.error(
        `Ignoring ${foreign.length} machine setting(s) in ${label} profile ${filePath} ` +
        `(the selected machine preset owns them): ${foreign.slice(0, 8).join(", ")}${foreign.length > 8 ? ", ..." : ""}`
      );
      return this.writeTempJson(path.basename(filePath, ".json"), `${label}_without_machine`, isolated);
    };
    return {
      ...bundle,
      settingsArg: [machinePath, isolate(processPath, "process")].join(";"),
      filamentPaths: bundle.filamentPaths.map((filePath) => isolate(filePath, "filament")),
    };
  }
}

/** Keys every profile kind carries; they describe the file, not machine hardware. */
const PROFILE_METADATA_KEYS = new Set([
  "name", "type", "from", "inherits", "instantiation", "setting_id", "version", "is_custom_defined",
  "compatible_printers", "compatible_printers_condition", "compatible_prints", "compatible_prints_condition",
]);

/** CLI flags for the prepared bundle and caller options (input path appended by the caller). */
export function buildBambuCliArgs(
  bundle: BambuSettingsBundle,
  outputDir: string,
  exportName: string,
  options: BambuSliceOptions
): string[] {
  const args = [
    "--slice", String(options.slicePlate ?? 0),
    "--outputdir", outputDir,
    "--export-3mf", exportName,
  ];
  if (bundle.settingsArg) args.push("--load-settings", bundle.settingsArg);
  // Always allow newer-version 3MF files (the CLI rejects them by default).
  args.push("--allow-newer-file");
  if (options.uptodate) args.push("--uptodate");
  if (options.ensureOnBed) args.push("--ensure-on-bed");
  if (options.enableTimelapse) args.push("--enable-timelapse");
  if (options.allowMixTemp) args.push("--allow-mix-temp");
  if (options.minSave) args.push("--min-save");
  if (options.skipModifiedGcodes) args.push("--skip-modified-gcodes");
  if (options.orient !== undefined) args.push("--orient", options.orient ? "1" : "0");
  if (options.arrange !== undefined) args.push("--arrange", options.arrange ? "1" : "0");
  if (options.repetitions !== undefined) args.push("--repetitions", String(options.repetitions));
  if (options.scale !== undefined) args.push("--scale", String(options.scale));
  if (options.rotate !== undefined) args.push("--rotate", String(options.rotate));
  if (options.rotateX !== undefined) args.push("--rotate-x", String(options.rotateX));
  if (options.rotateY !== undefined) args.push("--rotate-y", String(options.rotateY));
  if (options.cloneObjects) args.push("--clone-objects", options.cloneObjects);
  if (options.skipObjects) args.push("--skip-objects", options.skipObjects);
  if (bundle.filamentPaths.length > 0) {
    args.push("--load-filaments", bundle.filamentPaths.join(";"));
    args.push("--load-defaultfila");
  }
  if (options.loadFilamentIds) args.push("--load-filament-ids", options.loadFilamentIds);
  return args;
}

/**
 * A sliced Bambu project must contain at least one nonempty
 * Metadata/plate_<n>.gcode entry. A .gcode.md5 checksum or the unsliced
 * input geometry is not printable output.
 */
export async function assertSlicedProjectOutput(outputPath: string): Promise<string[]> {
  const JSZip = (await import("jszip")).default;
  let zip: InstanceType<typeof JSZip>;
  try {
    zip = await JSZip.loadAsync(await fs.promises.readFile(outputPath));
  } catch (error: any) {
    throw new Error(`Slicer output ${outputPath} is not a readable 3MF archive: ${error?.message ?? error}`);
  }
  const plates: string[] = [];
  for (const entry of Object.values(zip.files)) {
    if (entry.dir || !/^Metadata\/plate_\d+\.gcode$/i.test(entry.name)) continue;
    const content = await entry.async("uint8array");
    if (content.length > 0) plates.push(entry.name);
  }
  if (plates.length === 0) {
    throw new Error(
      `Slicer output ${outputPath} does not contain any nonempty Metadata/plate_<n>.gcode entry; it is not a printable sliced project.`
    );
  }
  return plates.sort();
}
