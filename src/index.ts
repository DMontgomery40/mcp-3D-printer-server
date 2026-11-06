#!/usr/bin/env node

// Must stay first: Node.js 18 needs the global crypto before any SDK transport code runs.
import "./ensure-web-crypto.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ErrorCode,
  McpError
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import os from "node:os";
import { BlenderMcpBridge } from "./blender-mcp-bridge.js";
import { BLENDER_SETUP_OUTPUT_SCHEMA, BlenderAddonSetup, FUSION_ADDIN_REPOSITORY, FUSION_SETUP_OUTPUT_SCHEMA, FusionAddinSetup, defaultSetupSystem, parseAddonHandshake, type BlenderAddonHandshake } from "./design-app-setup.js";
import { resolveFilamentProfile } from "./slicer/filament-profiles.js";
import { sliceCapabilities } from "./slicer/capabilities.js";
import {
  FUSION_CALL_OUTPUT_SCHEMA,
  FUSION_EXPORT_OUTPUT_SCHEMA,
  FUSION_MCP_DEFAULT_ARGS,
  FUSION_MCP_PINNED_COMMIT,
  FUSION_NEW_DESIGN_OUTPUT_SCHEMA,
  FUSION_STATUS_OUTPUT_SCHEMA,
  FusionMcpBridge,
  addinAddress,
} from "./fusion-mcp-bridge.js";
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import * as THREE from 'three';
import { PrinterFactory } from "./printers/printer-factory.js";
import { STLManipulator, SUPPORT_TYPES, type BambuSliceOptions, type ProcessOverrides, type SliceOutput } from "./stl/stl-manipulator.js";
import { parsePauseLayers, readPlateGcode, pausedLayers, machinePauseGcode } from "./slicer/layer-pauses.js";
import { PRINT_QUALITY_PROPERTIES, withPrintQuality } from "./slicer/print-quality.js";
import { PrinterRefusal } from "./refusal.js";
import { isBambuProjectSlicer, usesBambuCli } from "./slicer/capabilities.js";
import { CounterpartService, type BambuControlRoute, type PrinterTarget } from "./counterpart/service.js";
import {CAMERA_STREAM_TOOLS} from "./counterpart/camera-tools.js";
import { annotateTools } from "./tool-annotations.js";
import { withRemote } from "./counterpart/remote.js";
import { refusalReport, slicedFileFacts, slicerReport } from "./counterpart/sliced-file.js";
import { machineBed, splitToPlates, type BedSplit } from "./slicer/bed-plates.js";

/** The slicer's verdict beside its result.json (`slicer_report`). */
function reportOf(result: unknown): { slicer_report?: ReturnType<typeof slicerReport> } {
  const report = slicerReport(result);
  return report ? { slicer_report: report } : {};
}
/** A failed slice's report from its result.json, saying the plain sentence its text leads with. */
function refusedReport(result: unknown, plain: string | undefined): { slicer_report?: ReturnType<typeof slicerReport> } {
  const report = slicerReport(result);
  return report ? { slicer_report: report.failed && plain ? { ...report, message: plain } : report } : {};
}
function withSlicerReport<T extends { slicer_result?: unknown }>(sliced: T): T & { slicer_report?: ReturnType<typeof slicerReport> } {
  return { ...sliced, ...reportOf(sliced.slicer_result) };
}
import {
  CAMERA_SNAPSHOT_OUTPUT_SCHEMA,
  CONTROL_OUTPUT_SCHEMA,
  FILAMENTS_OUTPUT_SCHEMA,
  PRINT_PROGRESS_OUTPUT_SCHEMA,
  PRINTER_INFO_OUTPUT_SCHEMA,
} from "./counterpart/contract.js";
import { SlicerError } from "./slicer/slicer-error.js";
import {
  inspectSliceSettings,
  listTemplateRegistry,
  resolveTemplatePath,
  resolveTemplateSlicerProfilePath,
  withExtractedSettingsCleanup,
  hasBambuProjectSettings,
  saveTemplate,
} from "./slicer/templates.js";
import { parse3MF, ThreeMFData } from './3mf_parser.js';
import { BambuImplementation } from "./printers/bambu.js";
import {
  inspectFuluOrcaSetup,
  invokeFuluBridgeRpc,
} from "./fulu-orca.js";
import {
  bridgeAmsMapping2Entry,
  bridgeAmsMappingValue,
  externalTrayForNozzle,
  hasAmsMappingInput,
  normalizeAmsMappingObject,
  normalizeBridgeAmsTrayValue,
  studioAmsMappingInfo,
  trayColour,
} from "./ams-mapping.js";
import { isDualNozzleModel, MACHINE_LIMITS, normalizeModel } from "./safety/limits.js";
import { BambuNetworkBridge, bridgeSnapshotRoot, describeBambuNetworkPrintError, type BridgeJobUpdate } from "./bambu-network-bridge.js";
import { PRINT_ROUTES, connectionForRoute, routeOf, routeOptions, writeEnvValues, type PrintRoute } from "./counterpart/route.js";
import { resolveStudioPrintOptions, usedNozzleCount, type CallerPrintOptions } from "./studio-print-options.js";
import { inspectPrintFile } from "./safety/print-file.js";
import { previewPrintFile } from "./safety/print-preview.js";
import { loadSafe3mfArchive } from "./safety/archive.js";

/** inspect_print_file's preview: drawn from the snapshot's own bytes, refused if they aren't the inspected ones. */
async function previewOfSnapshot(snapshot: string, plateIndex: number, sha256: string) {
  const bytes = await fs.promises.readFile(snapshot);
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw new Error("The file changed while it was being inspected; nothing was previewed.");
  let gcode: string, projectColours: unknown[] | undefined;
  if (snapshot.toLowerCase().endsWith(".3mf")) {
    const zip = await loadSafe3mfArchive(bytes);
    const entry = zip.file(`Metadata/plate_${plateIndex + 1}.gcode`);
    if (!entry) return undefined;
    gcode = await entry.async("string");
    const settings = zip.file("Metadata/project_settings.config");
    if (settings) {
      try { const parsed = JSON.parse(await settings.async("string")); if (Array.isArray(parsed?.filament_colour)) projectColours = parsed.filament_colour; } catch { /* colours fall back to the G-code header */ }
    }
  } else gcode = bytes.toString("utf8");
  const preview = await previewPrintFile({ gcode, ...(projectColours ? { projectColours } : {}) });
  return preview ? { ...preview, artifact_sha256: sha256, plate_index: plateIndex } : undefined;
}
import { externalStorageState, validatePrinterState } from "./safety/printer-state.js";
import { uniquePrintName, withPrinterOperation, withPrintSnapshot } from "./safety/artifact.js";
import { checkedFile } from "./printers/bambu.js";
import { CONFIRMATION_UNAVAILABLE, confirmationTimedOut, confirmationTimeoutMs } from "./safety/confirmation.js";
import { validateExpectedPeaks, type ExpectedPeakTemperatures, type PrintSafetyOptions } from "./safety/expected-peaks.js";
import { DESIGN_PROMPTS, FDM_CAPABILITY_GUIDANCE, FDM_CAPABILITY_RESOURCE, FDM_CAPABILITY_URI, FDM_SLICING_PROMPT, SERVER_INSTRUCTIONS, slicingGuidance } from "./design-guidance.js";
import { DISCOVER_OUTPUT_SCHEMA, discoverPrinters } from "./counterpart/discovery.js";
import { SETUP_FIELDS_OUTPUT_SCHEMA, genericSetupFields, slicerSetup, type SlicerSetup } from "./counterpart/setup.js";
import { detectProfilesRoot } from "./slicer/profile-flatten.js";
import { PROPOSE_FILAMENTS_INPUT_PROPERTIES, PROPOSE_FILAMENTS_OUTPUT_SCHEMA, proposeFilaments, type ProposalTray } from "./counterpart/filaments.js";
import { bambuColourNames } from "./printers/bambu-filaments.js";

// Load environment variables from .env file
dotenv.config();

const SERVER_NAME = "mcp-3d-printer-server";
const SERVER_VERSION: string = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

// Default values
const DEFAULT_HOST = process.env.PRINTER_HOST || "localhost";
const DEFAULT_PORT = process.env.PRINTER_PORT || "80";
const DEFAULT_API_KEY = process.env.API_KEY || "";
const DEFAULT_TYPE = process.env.PRINTER_TYPE || "octoprint"; // Default to OctoPrint
// Resolve an explicit TEMP_DIR (e.g. ./temp) against the server's working directory, as
// dotenv's own .env lookup is: slicer CLIs receive paths under it, and Bambu Studio fails
// every 3MF export to a relative --outputdir (bambu-printer-mcp 1.1.44 fixed the same).
const TEMP_DIR = process.env.TEMP_DIR ? path.resolve(process.env.TEMP_DIR) : fs.mkdtempSync(path.join(os.tmpdir(), "mcp-3d-printer-server-"));

// Slicer configuration
const CANONICAL_SLICER_TYPES = [
  "prusaslicer",
  "cura",
  "slic3r",
  "orcaslicer",
  "orcaslicer-bambulab",
  "bambustudio",
] as const;
type SlicerType = typeof CANONICAL_SLICER_TYPES[number];

const SLICER_TYPE_ALIASES: Record<string, SlicerType> = {
  prusa: "prusaslicer",
  prusaslicer: "prusaslicer",
  cura: "cura",
  curaengine: "cura",
  slic3r: "slic3r",
  orca: "orcaslicer",
  orcaslicer: "orcaslicer",
  "orca-slicer": "orcaslicer",
  "orcaslicer-bambulab": "orcaslicer-bambulab",
  "orcaslicer_bambulab": "orcaslicer-bambulab",
  "orca-bambulab": "orcaslicer-bambulab",
  "orca_bambulab": "orcaslicer-bambulab",
  "fulu-orca": "orcaslicer-bambulab",
  "fulu_orca": "orcaslicer-bambulab",
  "orca-studio": "orcaslicer-bambulab",
  "orca_studio": "orcaslicer-bambulab",
  orcastudio: "orcaslicer-bambulab",
  bambustudio: "bambustudio",
  "bambu-studio": "bambustudio",
  "bambu_studio": "bambustudio",
};

const SLICER_TYPE_ENUM = [
  ...CANONICAL_SLICER_TYPES,
  "fulu_orca",
  "fulu-orca",
  "orca-studio",
  "orca_bambulab",
] as const;

function normalizeSlicerType(rawValue: string | undefined): SlicerType {
  const normalized = (rawValue || "").trim().toLowerCase();
  const resolved = SLICER_TYPE_ALIASES[normalized];
  if (!resolved) {
    throw new Error(
      `Unsupported slicer type "${rawValue}". Valid types: ${SLICER_TYPE_ENUM.join(", ")}`
    );
  }
  return resolved;
}


function firstExistingPath(candidates: string[]): string | undefined {
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function defaultFuluOrcaPath(): string {
  return (
    process.env.FULU_ORCA_PATH ||
    process.env.ORCASLICER_BAMBULAB_PATH ||
    process.env.ORCA_SLICER_BAMBULAB_PATH ||
    firstExistingPath([
      "/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer",
      "/Applications/Orca Studio.app/Contents/MacOS/OrcaSlicer",
      "/Applications/OrcaStudio.app/Contents/MacOS/OrcaStudio",
      "/usr/local/bin/orcaslicer",
      "/usr/bin/orcaslicer",
    ]) ||
    "orcaslicer"
  );
}

function defaultBambuStudioPath(): string {
  return (
    firstExistingPath([
      "/Applications/BambuStudio.app/Contents/MacOS/BambuStudio",
      "/Applications/Bambu Studio.app/Contents/MacOS/BambuStudio",
      "/usr/local/bin/bambustudio",
      "/usr/bin/bambustudio",
    ]) ||
    "bambustudio"
  );
}

/**
 * The slice's arguments change a resolved process: an explicit value (layer height, walls, infill, supports), or a
 * quality or strength other than standard. Invalid values throw, as slice_stl's own parsing does.
 */
function changesProcess(args: Record<string, unknown>): boolean {
  // slice_stl's own validation of these values (quality, strength, layer height, walls, infill, supports).
  parseProcessOverrides(withPrintQuality(args, Number(args.nozzle_diameter || DEFAULT_NOZZLE_DIAMETER)));
  return ["layer_height", "wall_loops", "sparse_infill_density", "enable_support", "support_type", "support_threshold_angle"].some(key => args[key] !== undefined)
    || (args.quality !== undefined && args.quality !== "standard") || (args.strength !== undefined && args.strength !== "standard");
}

/**
 * A designer's 3MF slices with its own process: a Bambu-compatible CLI, a call that names no slicer_profile or
 * template, and a 3MF that carries a process. slice_stl, print_3mf's auto-slice and get_slice_settings' own_process
 * all ask this, so what get_slice_settings reports is what slicing does.
 */
async function slicesWithOwnProcess(modelPath: string, bambuCli: boolean, namesProfileOrTemplate: boolean): Promise<boolean> {
  return bambuCli && !namesProfileOrTemplate && modelPath.toLowerCase().endsWith(".3mf") && await hasBambuProjectSettings(modelPath);
}

const DEFAULT_SLICER_TYPE = normalizeSlicerType(
  // Bambu Studio for Bambu printers, as in bambu-printer-mcp: FULU OrcaSlicer-bambulab v1.0.0's CLI
  // segfaults on every slice (FULU #56/#57 open), so it is chosen explicitly, not by default.
  process.env.SLICER_TYPE || (DEFAULT_TYPE.toLowerCase() === "bambu" ? "bambustudio" : "prusaslicer")
);
const DEFAULT_SLICER_PATH =
  process.env.SLICER_PATH ||
  (DEFAULT_SLICER_TYPE === "orcaslicer-bambulab"
    ? defaultFuluOrcaPath()
    : DEFAULT_SLICER_TYPE === "bambustudio"
      ? defaultBambuStudioPath()
      : "");
const DEFAULT_SLICER_PROFILE = process.env.SLICER_PROFILE || "";

/** An executable path, or a bare command found on PATH. */
function executableExists(command: string): boolean {
  if (!command) return false;
  if (command.includes("/") || command.includes("\\")) return fs.existsSync(command);
  return (process.env.PATH ?? "").split(path.delimiter).some(dir => dir && fs.existsSync(path.join(dir, command)));
}
/** The slicer this server would run now and the settings that choose it, for counterpart_setup_fields. */
function slicerSetupNow(): SlicerSetup {
  const type = DEFAULT_SLICER_TYPE, slicerPath = DEFAULT_SLICER_PATH;
  const bbl = ["bambustudio", "orcaslicer", "orcaslicer-bambulab"].includes(type);
  let profilesRoot: string | undefined;
  try { profilesRoot = bbl ? detectProfilesRoot(slicerPath || undefined, type) : undefined; } catch { profilesRoot = undefined; }
  const profilesFound = Boolean(profilesRoot && (fs.existsSync(path.join(profilesRoot, "BBL", "machine")) || fs.existsSync(path.join(profilesRoot, "BBL.opc"))));
  return slicerSetup({ types: CANONICAL_SLICER_TYPES, type, path: slicerPath, found: executableExists(slicerPath),
    ...(bbl ? { profilesFound, ...(profilesRoot ? { profilesRoot } : {}) } : {}) });
}

const DEFAULT_FILAMENT_PROFILE =
  process.env.FILAMENT_PROFILE || process.env.SLICER_FILAMENT_PROFILE || "";

// Bambu-specific default values
const DEFAULT_BAMBU_SERIAL = process.env.BAMBU_SERIAL || "";
const DEFAULT_BAMBU_TOKEN = process.env.BAMBU_TOKEN || "";

// Printer model and bed type (Bambu safety)
const DEFAULT_BAMBU_MODEL = process.env.BAMBU_MODEL?.trim().toLowerCase() || "";
const DEFAULT_BED_TYPE = process.env.BED_TYPE?.trim().toLowerCase() || "textured_plate";
const DEFAULT_NOZZLE_DIAMETER = process.env.NOZZLE_DIAMETER?.trim() || "0.4";
// counterpart_print_route changes these at run time (and in the .env file they came from).
let DEFAULT_BAMBU_CONNECTION_MODE = process.env.BAMBU_DEFAULT_CONNECTION_MODE?.trim().toLowerCase() || "";
let DEFAULT_BAMBU_CONNECTION_TYPE = process.env.BAMBU_DEFAULT_CONNECTION_TYPE?.trim().toLowerCase() || "";
const CONNECTION_MODES = ["lan_mqtt_ftps", "bambu_network", "bambu_native", "bambu_connect"];

/**
 * The one route decision for a Bambu printer, as in bambu-printer-mcp:
 * print_3mf and every print control (cancel, pause, resume) resolve it here,
 * so a job is never controlled over a different connection than the one that
 * started it. Arguments override BAMBU_DEFAULT_CONNECTION_MODE/_TYPE; without
 * either, direct LAN MQTT/FTPS. The type (lan or cloud) applies to FULU's
 * BambuNetwork route and defaults to cloud, as bambu-printer-mcp's does.
 */
function resolveConnection(args: Record<string, unknown> | undefined): { mode: string; type: string } {
  const mode = String(args?.connection_mode || DEFAULT_BAMBU_CONNECTION_MODE || "lan_mqtt_ftps").trim().toLowerCase();
  if (!CONNECTION_MODES.includes(mode)) throw new Error("Unsupported connection_mode.");
  const type = String(args?.connection_type || DEFAULT_BAMBU_CONNECTION_TYPE || "cloud").trim().toLowerCase();
  if (!["cloud", "lan"].includes(type)) throw new Error('connection_type must be "cloud" or "lan".');
  return { mode, type };
}

/** bambu-printer-mcp's installed-plug-in (X2D native) and Bambu Connect routes are not part of this server. */
function assertConnectionAvailable(mode: string): void {
  if (mode === "bambu_native" || mode === "bambu_connect") {
    throw new Error(
      `connection_mode ${mode} is not available in mcp-3D-printer-server. Use lan_mqtt_ftps or bambu_network (FULU), ` +
      `or bambu-printer-mcp for ${mode === "bambu_native" ? "the X2D native route" : "Bambu Connect"}. Nothing was sent.`
    );
  }
}

const CONNECTION_PROPERTIES = {
  connection_mode: { type: "string", enum: ["lan_mqtt_ftps", "bambu_network"], description: "Bambu only: the connection the print uses (print_3mf) or used (controls). lan_mqtt_ftps is direct LAN MQTT/FTPS (Developer Mode); bambu_network is FULU's authenticated BambuNetwork bridge. Defaults to BAMBU_DEFAULT_CONNECTION_MODE, else lan_mqtt_ftps." },
  connection_type: { type: "string", enum: ["lan", "cloud"], description: "Bambu only: FULU BambuNetwork connection type. lan is the authenticated local network session; cloud is Bambu Cloud. Defaults to BAMBU_DEFAULT_CONNECTION_TYPE, else cloud." },
};

/** The Send dialog options a caller set explicitly; the rest resolve as Bambu Studio does (studio-print-options.ts). */
function callerPrintOptions(args: Record<string, any> | undefined): CallerPrintOptions {
  const flag = (value: unknown) => value === undefined ? undefined : Boolean(value);
  const options: CallerPrintOptions = {
    bedLeveling: flag(args?.bed_leveling),
    flowCalibration: flag(args?.flow_calibration),
    vibrationCalibration: flag(args?.vibration_calibration),
    layerInspect: flag(args?.layer_inspect),
  };
  return Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) as CallerPrintOptions;
}

const VALID_BAMBU_MODELS = ["p1s", "p1p", "x1c", "x1e", "a1", "a1mini", "h2d"] as const;
type BambuModel = typeof VALID_BAMBU_MODELS[number];

const VALID_BED_TYPES = ["textured_plate", "cool_plate", "engineering_plate", "hot_plate"] as const;

// Map model IDs to BambuStudio --load-machine preset names
const BAMBU_MODEL_PRESETS: Record<string, (nozzle: string) => string> = {
  p1s: (n) => `Bambu Lab P1S ${n} nozzle`,
  p1p: (n) => `Bambu Lab P1P ${n} nozzle`,
  x1c: (n) => `Bambu Lab X1 Carbon ${n} nozzle`,
  x1e: (n) => `Bambu Lab X1E ${n} nozzle`,
  a1: (n) => `Bambu Lab A1 ${n} nozzle`,
  a1mini: (n) => `Bambu Lab A1 mini ${n} nozzle`,
  h2d: (n) => `Bambu Lab H2D ${n} nozzle`,
};

// Models whose bundled machine presets the Bambu-compatible CLI slicing path
// can target. The installed slicer must still contain the exact
// "<model> <nozzle> nozzle" preset; a missing preset stops the slice.
const SLICE_BAMBU_MODELS = ["p1s", "p1p", "p2s", "x1c", "x1e", "a1", "a1mini", "h2d", "h2s", "h2c"] as const;
const SLICE_BAMBU_MODEL_PRESETS: Record<string, (nozzle: string) => string> = {
  ...BAMBU_MODEL_PRESETS,
  p2s: (n) => `Bambu Lab P2S ${n} nozzle`,
  h2s: (n) => `Bambu Lab H2S ${n} nozzle`,
  h2c: (n) => `Bambu Lab H2C ${n} nozzle`,
};
const DEFAULT_TEMPLATE_3MF_PATH = process.env.BAMBU_TEMPLATE_3MF_PATH || "";
const VALID_NOZZLE_TYPES = ["stainless_steel", "hardened_steel", "tungsten_carbide", "brass"] as const;

/** The installed hotend material. Bambu machine presets assume the stock nozzle; the print gate compares this with the printer. */
function resolveNozzleType(value: unknown): string | undefined {
  const raw = value === undefined || value === null || value === "" ? process.env.BAMBU_NOZZLE_TYPE?.trim() : value;
  if (raw === undefined || raw === "") return undefined;
  const normalized = String(raw).trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!(VALID_NOZZLE_TYPES as readonly string[]).includes(normalized)) {
    throw new Error(`Invalid nozzle type "${raw}". Valid types: ${VALID_NOZZLE_TYPES.join(", ")}`);
  }
  return normalized;
}

// Shared slice_stl / slice_with_template argument schema.
const SLICE_TOOL_PROPERTIES = {
  pause_at_layers: { type: "array", items: { type: "integer", minimum: 2 }, description: "Pause before these 1-based layers, for example to insert magnets. Bambu-compatible CLI only; the slicer writes the printer's own pause G-code. Existing project pauses are preserved." },
  bambu_model: {
    type: "string",
    enum: [...SLICE_BAMBU_MODELS],
    description:
      "Bambu Lab printer model. Required for bambustudio and orcaslicer-bambulab (elicited or read from BAMBU_MODEL when omitted); " +
      "passing it with orcaslicer selects the Bambu-compatible path. The installed slicer must contain the exact model/nozzle preset.",
  },
  nozzle_diameter: {
    type: "string",
    description: "Nozzle diameter in mm (default: NOZZLE_DIAMETER or 0.4). Selects the '<model> <diameter> nozzle' machine preset.",
  },
  slicer_type: {
    type: "string",
    enum: [...SLICER_TYPE_ENUM],
    description:
      "Type of slicer to use (prusaslicer, cura, slic3r, orcaslicer, orcaslicer-bambulab, bambustudio). Use orcaslicer-bambulab for the FULU fork. " +
      "bambustudio and orcaslicer-bambulab (and orcaslicer with bambu_model) export a sliced 3MF.",
  },
  slicer_path: {
    type: "string",
    description: "Path to the slicer executable (default: value from env). Per-call overrides require MCP_ALLOW_EXECUTABLE_ARG=1.",
  },
  slicer_profile: {
    type: "string",
    description:
      "Profile to use for slicing (default: SLICER_PROFILE env). Bambu-compatible slicing: one process profile JSON (the machine preset comes from bambu_model). " +
      "Generic OrcaSlicer: machine/process profiles separated with ';', optionally followed by '|filament.json'.",
  },
  filament_profile: {
    type: "string",
    description: "Filament profile path(s), ';'-separated in slot order, loaded with --load-filaments (default: FILAMENT_PROFILE/SLICER_FILAMENT_PROFILE env). Alias of load_filaments.",
  },
  load_filaments: {
    type: "string",
    description: "Bambu-compatible slicing: filament profile JSON paths in slot order, ';'-separated. One profile applies to every project slot; otherwise supply one per slot.",
  },
  load_filament_ids: {
    type: "string",
    description: "Bambu-compatible slicing: comma-separated filament IDs mapping load_filaments to objects, e.g. '1,2,3,1'.",
  },
  filament_colours: {
    type: "string",
    description: "Bambu-compatible slicing: one #RRGGBB per filament slot, ';'-separated. Defaults to the input 3MF's colours, then each profile's colour.",
  },
  bed_type: {
    type: "string",
    enum: [...VALID_BED_TYPES],
    description: "Bambu-compatible slicing: build plate type (default: BED_TYPE or textured_plate).",
  },
  nozzle_type: {
    type: "string",
    enum: [...VALID_NOZZLE_TYPES],
    description: "Bambu-compatible slicing: the hotend nozzle material installed on the printer (default: BAMBU_NOZZLE_TYPE, else the model preset's stock nozzle, usually stainless_steel; X1C/X1E presets use hardened_steel). Printing compares it with the printer's reported nozzle.",
  },
  template_3mf_path: {
    type: "string",
    description: "Bambu-compatible slicing: 3MF or profile whose embedded slicer settings are reused as the process profile (default: BAMBU_TEMPLATE_3MF_PATH). An explicit slicer_profile takes precedence.",
  },
  template_name: {
    type: "string",
    description: "Named template from the local registry (see list_templates); resolves to its file.",
  },
  template_dir: {
    type: "string",
    description: "Template directory override when resolving template_name (default: BAMBU_TEMPLATE_DIR or ~/Sync/bambu/templates).",
  },
  uptodate: { type: "boolean", description: "Bambu-compatible slicing: refresh 3MF preset configs to the installed slicer version (--uptodate)." },
  repetitions: { type: "number", description: "Bambu-compatible slicing: print N identical copies. STL inputs use --clone-objects; selected 3MF plates retain --repetitions. Do not combine with clone_objects for STL." },
  orient: { type: "boolean", description: "Bambu-compatible slicing: auto-orient for printability (--orient)." },
  arrange: { type: "boolean", description: "Bambu-compatible slicing: auto-arrange objects on the plate (--arrange); STL input is arranged by default. Set false to keep an existing layout: an STL that is not already on the plate then fails to slice." },
  ensure_on_bed: { type: "boolean", description: "Bambu-compatible slicing: lower floating models onto the bed (--ensure-on-bed)." },
  clone_objects: { type: "string", description: "Bambu-compatible slicing: clone the loaded model, total copies as a single integer, e.g. '3' (--clone-objects). The Bambu-style CLIs count copies per input file and this tool loads one file, so a comma-separated list is rejected by the slicer." },
  skip_objects: { type: "string", description: "Bambu-compatible slicing: comma-separated object indices to skip, e.g. '3,5,10'." },
  enable_timelapse: { type: "boolean", description: "Bambu-compatible slicing: insert timelapse parking moves (--enable-timelapse)." },
  allow_mix_temp: { type: "boolean", description: "Bambu-compatible slicing: allow filaments with different temperature requirements on one plate." },
  scale: { type: "number", description: "Bambu-compatible slicing: uniform scale factor applied before slicing (1.0 = original size)." },
  rotate: { type: "number", description: "Bambu-compatible slicing: Z-axis rotation in degrees before slicing." },
  rotate_x: { type: "number", description: "Bambu-compatible slicing: X-axis rotation in degrees before slicing." },
  rotate_y: { type: "number", description: "Bambu-compatible slicing: Y-axis rotation in degrees before slicing." },
  min_save: { type: "boolean", description: "Bambu-compatible slicing: write a smaller output 3MF (--min-save)." },
  skip_modified_gcodes: { type: "boolean", description: "Bambu-compatible slicing: ignore custom G-code embedded in an input 3MF (--skip-modified-gcodes)." },
  slice_plate: { type: "number", description: "Bambu-compatible slicing: plate number to slice; 0 slices all plates (default)." },
  split_to_plates: { type: "boolean", description: "Bambu-compatible slicing, slice_stl: for an STL or OBJ that doesn't fit the printer's bed (the machine preset's printable area, excluded areas and height), split it into its separate parts, each kept whole and parts laid out close together kept together, and arrange them on as many plates as needed. structuredContent.bed_split then says fits: true (nothing changed), or gives three_mf_path (the multi-plate project 3MF, sliced here: plate slice_plate, default 1, or 0 for all), plates (index from 0, name, objects) and a plain message; slice another plate by slicing three_mf_path with slice_plate and arrange false. A part larger than the bed is an error whose message names it and its size against the bed's (bed_split.too_large). Not with scale, rotate or copies." },
  ...PRINT_QUALITY_PROPERTIES,
  layer_height: {
    type: "number", exclusiveMinimum: 0, maximum: 2,
    description: "Layer height in mm, written over the selected process profile (Orca/Bambu Studio layer_height; PrusaSlicer --layer-height). Not mapped for Cura.",
  },
  wall_loops: {
    type: "integer", minimum: 0, maximum: 100,
    description: "Number of walls, written over the selected process profile (Orca/Bambu Studio wall_loops; PrusaSlicer --perimeters). Not mapped for Cura.",
  },
  sparse_infill_density: {
    type: "string",
    description: "Sparse infill density such as \"15%\" (0–100%), written over the selected process profile (Orca/Bambu Studio sparse_infill_density; PrusaSlicer --fill-density). Not mapped for Cura.",
  },
  enable_support: { type: "boolean", description: "Turn support generation on or off (Orca/Bambu Studio enable_support), written over the selected process profile. Bambu Studio and OrcaSlicer only." },
  support_type: { type: "string", enum: [...SUPPORT_TYPES], description: "Support style (Orca/Bambu Studio support_type), written over the selected process profile. Bambu Studio and OrcaSlicer only." },
  support_threshold_angle: {
    type: "integer", minimum: 0, maximum: 90,
    description: "Overhang threshold in degrees for automatic supports (Orca/Bambu Studio support_threshold_angle; 0 lets the slicer decide). Bambu Studio and OrcaSlicer only.",
  },
};

/**
 * upload_gcode / start_print results name the remote file that was stored or
 * started (start_print starts a uniquely named checked copy), so a monitor can
 * match counterpart_print_progress job.name to it.
 */
function withJobName(result: unknown, requested: string): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const record = result as Record<string, unknown>;
  if (typeof record.jobName === "string" && record.jobName) return result;
  const remote = typeof record.remotePath === "string" && record.remotePath ? record.remotePath : requested;
  return { ...record, jobName: path.posix.basename(remote.replace(/\\/g, "/")) };
}

/** Connection overrides shared by the counterpart/1 tools. */
const PRINTER_TARGET_PROPERTIES = {
  host: { type: "string", description: "Hostname or IP address of the printer (default: value from env)" },
  port: { type: "string", description: "Port of the printer API (default: value from env)" },
  type: { type: "string", description: "Type of printer management system (octoprint, klipper, duet, repetier, bambu, prusa, creality) (default: value from env)" },
  api_key: { type: "string", description: "API key for authentication (default: value from env)" },
  bambu_serial: { type: "string", description: "Serial number for Bambu Lab printers (default: value from env)" },
  bambu_token: { type: "string", description: "Access token for Bambu Lab printers (default: value from env)" },
};

/** Tools that declare an outputSchema: their errors carry no structuredContent, which clients would validate. */
const OUTPUT_SCHEMA_TOOLS = new Set([
  "counterpart_discover_printers", "counterpart_setup_fields", "counterpart_propose_filaments",
  "counterpart_printer_info", "counterpart_print_progress", "camera_snapshot", "get_printer_filaments", "pause_print", "resume_print",
  "camera_stream_start", "camera_frame", "camera_stream_stop",
  "fusion_mcp_status", "fusion_mcp_call", "fusion_mcp_new_design", "fusion_mcp_export",
  "blender_mcp_setup", "fusion_mcp_setup",
]);

/** layer_height / wall_loops / sparse_infill_density / support settings (PRD §8.4), validated before slicing. */
function parseProcessOverrides(args: Record<string, unknown> | undefined): ProcessOverrides {
  const overrides: ProcessOverrides = {};
  if (args?.layer_height !== undefined) {
    const value = args.layer_height;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 2) {
      throw new Error("Invalid layer_height: expected a number of millimetres greater than 0 and at most 2.");
    }
    overrides.layerHeight = value;
  }
  if (args?.wall_loops !== undefined) {
    const value = args.wall_loops;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) {
      throw new Error("Invalid wall_loops: expected an integer from 0 to 100.");
    }
    overrides.wallLoops = value;
  }
  if (args?.sparse_infill_density !== undefined) {
    const raw = args.sparse_infill_density;
    const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
    const match = text.match(/^(\d+(?:\.\d+)?)\s*%?$/);
    const value = match ? Number(match[1]) : NaN;
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw new Error("Invalid sparse_infill_density: expected a percentage such as \"15%\" from 0% to 100%.");
    }
    overrides.sparseInfillDensity = `${value}%`;
  }
  // Written by withPrintQuality for strong/max, never by a caller: they only raise the process's own values.
  if (typeof args?.wall_loops_floor === "number") overrides.wallLoopsFloor = args.wall_loops_floor;
  if (typeof args?.sparse_infill_density_floor === "string") overrides.sparseInfillDensityFloor = args.sparse_infill_density_floor;
  if (args?.enable_support !== undefined) {
    if (typeof args.enable_support !== "boolean") throw new Error("Invalid enable_support: expected true or false.");
    overrides.enableSupport = args.enable_support;
  }
  if (args?.support_type !== undefined) {
    const value = args.support_type;
    if (typeof value !== "string" || !(SUPPORT_TYPES as readonly string[]).includes(value)) {
      throw new Error(`Invalid support_type: expected one of ${SUPPORT_TYPES.join(", ")}.`);
    }
    overrides.supportType = value;
  }
  if (args?.support_threshold_angle !== undefined) {
    const value = args.support_threshold_angle;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 90) {
      throw new Error("Invalid support_threshold_angle: expected an integer number of degrees from 0 to 90.");
    }
    overrides.supportThresholdAngle = value;
  }
  return overrides;
}

function validateSliceBambuModel(model: string): string {
  const normalized = model.trim().toLowerCase();
  if (!(SLICE_BAMBU_MODELS as readonly string[]).includes(normalized)) {
    throw new Error(
      `Invalid bambu_model "${model}" for slicing. Valid models: ${SLICE_BAMBU_MODELS.join(", ")}`
    );
  }
  return normalized;
}

function normalizeSliceNozzleDiameter(raw: unknown): string {
  const text = String(raw ?? "").trim() || DEFAULT_NOZZLE_DIAMETER;
  const value = Number(text);
  if (!/^\d+(\.\d+)?$/.test(text) || !Number.isFinite(value) || value <= 0 || value > 2) {
    throw new Error(`Invalid nozzle_diameter "${text}". Use a diameter in mm such as 0.2, 0.4, 0.6, or 0.8.`);
  }
  return String(value);
}

/** Parse "#RRGGBB;#RRGGBB" (leading '#' optional) into positional slot colours. */
function parseFilamentColours(value: string): string[] {
  const colours = value.split(";").map((c) => c.trim()).filter(Boolean)
    .map((c) => (c.startsWith("#") ? c : `#${c}`).toUpperCase());
  for (const c of colours) {
    if (!/^#[0-9A-F]{6}([0-9A-F]{2})?$/.test(c)) {
      throw new Error(`Invalid filament colour "${c}"; expected #RRGGBB.`);
    }
  }
  if (colours.length === 0) throw new Error("Invalid filament_colours: list at least one colour.");
  return colours;
}

function optionalFiniteNumber(args: Record<string, unknown> | undefined, key: string): number | undefined {
  if (args?.[key] === undefined) return undefined;
  const value = Number(args[key]);
  if (!Number.isFinite(value)) throw new Error(`Invalid ${key}: expected a number.`);
  return value;
}

function optionalBoolean(args: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const value = args?.[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`Invalid ${key}: expected a boolean.`);
  return value;
}

/** Map slice_stl/slice_with_template arguments to Bambu-compatible CLI options. */
function buildBambuSliceOptions(args: Record<string, unknown> | undefined): BambuSliceOptions {
  const options: BambuSliceOptions = {};
  const text = (key: string) => (args?.[key] !== undefined && String(args[key]).trim() ? String(args[key]).trim() : undefined);
  options.uptodate = optionalBoolean(args, "uptodate");
  options.orient = optionalBoolean(args, "orient");
  options.arrange = optionalBoolean(args, "arrange");
  options.ensureOnBed = optionalBoolean(args, "ensure_on_bed");
  options.enableTimelapse = optionalBoolean(args, "enable_timelapse");
  options.allowMixTemp = optionalBoolean(args, "allow_mix_temp");
  options.minSave = optionalBoolean(args, "min_save");
  options.skipModifiedGcodes = optionalBoolean(args, "skip_modified_gcodes");
  options.repetitions = optionalFiniteNumber(args, "repetitions");
  options.scale = optionalFiniteNumber(args, "scale");
  options.rotate = optionalFiniteNumber(args, "rotate");
  options.rotateX = optionalFiniteNumber(args, "rotate_x");
  options.rotateY = optionalFiniteNumber(args, "rotate_y");
  options.slicePlate = optionalFiniteNumber(args, "slice_plate");
  options.pauseAtLayers = parsePauseLayers(args?.pause_at_layers);
  if (options.repetitions !== undefined && (!Number.isInteger(options.repetitions) || options.repetitions < 1)) {
    throw new Error("Invalid repetitions: expected a positive integer.");
  }
  if (options.slicePlate !== undefined && (!Number.isInteger(options.slicePlate) || options.slicePlate < 0)) {
    throw new Error("Invalid slice_plate: expected 0 (all plates) or a plate number.");
  }
  if (options.scale !== undefined && options.scale <= 0) throw new Error("Invalid scale: expected a positive factor.");
  options.cloneObjects = text("clone_objects");
  options.skipObjects = text("skip_objects");
  options.loadFilamentIds = text("load_filament_ids");
  const loadFilaments = text("load_filaments");
  const filamentAlias = text("filament_profile");
  if (loadFilaments && filamentAlias && loadFilaments !== filamentAlias) {
    throw new Error("Provide either load_filaments or filament_profile, not conflicting values.");
  }
  options.loadFilaments = loadFilaments ?? filamentAlias;
  const colours = text("filament_colours");
  if (colours) options.filamentColours = parseFilamentColours(colours);
  options.bedType = resolveBedType(args?.bed_type as string | undefined);
  options.nozzleType = resolveNozzleType(args?.nozzle_type);
  return Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) as BambuSliceOptions;
}

/** The slicer, printer and filament slice_stl uses when a call names none (get_printer_filaments' profile). */
function defaultFilamentProfileContext() {
  const splitList = (value: string) => value.split(";").map((item) => item.trim()).filter(Boolean);
  const pipeFilaments = DEFAULT_SLICER_PROFILE.includes("|") ? splitList(DEFAULT_SLICER_PROFILE.split("|", 2)[1]) : [];
  const configuredFilaments = DEFAULT_SLICER_TYPE === "cura" ? []
    : DEFAULT_SLICER_TYPE === "prusaslicer" || DEFAULT_SLICER_TYPE === "slic3r" ? splitList(DEFAULT_FILAMENT_PROFILE)
    : [...pipeFilaments, ...splitList(DEFAULT_FILAMENT_PROFILE)];
  return {
    slicerType: DEFAULT_SLICER_TYPE,
    slicerPath: defaultSlicerPathFor(DEFAULT_SLICER_TYPE) || undefined,
    slicerProfile: DEFAULT_SLICER_PROFILE || undefined,
    configuredFilaments,
  };
}

function defaultSlicerPathFor(slicerType: SlicerType): string {
  if (process.env.SLICER_PATH) return process.env.SLICER_PATH;
  if (slicerType === DEFAULT_SLICER_TYPE) return DEFAULT_SLICER_PATH;
  if (slicerType === "bambustudio") return defaultBambuStudioPath();
  if (slicerType === "orcaslicer-bambulab") return defaultFuluOrcaPath();
  return DEFAULT_SLICER_PATH;
}

function validateBambuModel(model: string): BambuModel {
  const normalized = model.trim().toLowerCase();
  if (!(VALID_BAMBU_MODELS as readonly string[]).includes(normalized)) {
    throw new Error(
      `Invalid Bambu printer model "${model}". Valid models: ${VALID_BAMBU_MODELS.join(", ")}`
    );
  }
  return normalized as BambuModel;
}

/** An inventory model hint: the argument, else BAMBU_MODEL; validated when present, never required. */
function optionalBambuModelHint(value: unknown): string | undefined {
  const requested = String(value ?? DEFAULT_BAMBU_MODEL ?? "").trim().toLowerCase();
  return requested ? validateBambuModel(requested) : undefined;
}

function resolveBedType(bedType: string | undefined): string {
  const resolved = (bedType || DEFAULT_BED_TYPE).trim().toLowerCase();
  if (!(VALID_BED_TYPES as readonly string[]).includes(resolved)) {
    throw new Error(
      `Invalid bed type "${bedType}". Valid types: ${VALID_BED_TYPES.join(", ")}`
    );
  }
  return resolved;
}

const SUPPORTED_NOZZLE_DIAMETERS = [0.2, 0.4, 0.6, 0.8];

/** Optional declared material; blank means "not declared". */
function optionalMaterialArg(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("material must be a non-empty string such as PLA, PETG, ABS, ASA, TPU, PA or PC.");
  }
  return value.trim();
}

/** Temperatures are validated as finite numbers before any printer connection. */
function optionalTemperatureArg(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite, non-negative number in °C.`);
  }
  return value;
}

function optionalNozzleDiameterArg(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const diameter = Number(value);
  if ((typeof value !== "number" && typeof value !== "string") || !SUPPORTED_NOZZLE_DIAMETERS.includes(diameter)) {
    throw new Error(`nozzle_diameter must be one of ${SUPPORTED_NOZZLE_DIAMETERS.join(", ")} mm.`);
  }
  return diameter;
}

type RuntimeConfig = {
  transport: "stdio" | "streamable-http";
  httpHost: string;
  httpPort: number;
  httpPath: string;
  statefulSession: boolean;
  enableJsonResponse: boolean;
  allowedOrigins: Set<string>;
  blenderBridgeCommand?: string;
  allowExecutableArg: boolean;
  allowBridgeCommandArg: boolean;
};

function parseBooleanEnv(rawValue: string | undefined, fallback: boolean): boolean {
  if (rawValue === undefined) {
    return fallback;
  }

  const value = rawValue.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(value)) {
    return false;
  }
  return fallback;
}

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`Invalid MCP_HTTP_PORT value: ${value}`);
  }
  return parsed;
}

function normalizePath(pathValue: string | undefined): string {
  const value = (pathValue ?? "/mcp").trim();
  if (!value) {
    return "/mcp";
  }
  return value.startsWith("/") ? value : `/${value}`;
}

function parseCsvEnv(value: string | undefined): Set<string> {
  if (!value) {
    return new Set();
  }
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return new Set(entries);
}

function readRuntimeConfig(): RuntimeConfig {
  const rawTransport = process.env.MCP_TRANSPORT?.trim().toLowerCase();
  const transport =
    rawTransport === "streamable-http" || rawTransport === "http"
      ? "streamable-http"
      : "stdio";

  return {
    transport,
    httpHost: process.env.MCP_HTTP_HOST?.trim() || "127.0.0.1",
    httpPort: parsePort(process.env.MCP_HTTP_PORT, 3000),
    httpPath: normalizePath(process.env.MCP_HTTP_PATH),
    statefulSession: parseBooleanEnv(process.env.MCP_HTTP_STATEFUL, true),
    enableJsonResponse: parseBooleanEnv(process.env.MCP_HTTP_JSON_RESPONSE, true),
    allowedOrigins: parseCsvEnv(process.env.MCP_HTTP_ALLOWED_ORIGINS),
    blenderBridgeCommand: process.env.BLENDER_MCP_BRIDGE_COMMAND?.trim() || undefined,
    allowExecutableArg: parseBooleanEnv(process.env.MCP_ALLOW_EXECUTABLE_ARG, false),
    allowBridgeCommandArg: parseBooleanEnv(process.env.MCP_ALLOW_BRIDGE_COMMAND_ARG, false),
  };
}

type StructuredToolError = {
  status: "error";
  retryable: boolean;
  suggestion: string;
  message: string;
  tool: string;
  /** A stable refusal code (src/refusal.ts) when the printer refused; clients act on it, not on the words. */
  code?: string;
  slicer?: Record<string, unknown>;
  /** The slicer's own result.json, verbatim. */
  slicer_result?: Record<string, unknown>;
};

const SLICING_TOOLS = new Set(["slice_stl", "slice_with_template", "list_templates", "save_template", "get_slice_settings"]);

// Ensure temp directory exists
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}


/** MQTT "Not authorized", FTP 530, and HTTP 401/403 all mean the printer rejected its credentials. */
function isCredentialRejection(message: string): boolean {
  return /not authori[sz]ed|\b530\b|login incorrect|\b401\b|\b403\b|unauthori[sz]ed|forbidden|bad user name or password/i.test(message);
}

function credentialSuggestion(): string {
  return (process.env.PRINTER_TYPE ?? "").toLowerCase() === "bambu"
    ? "The printer rejected its LAN access code. Read the current Access Code on the printer (Settings > Network/WLAN; it changes " +
        "when LAN mode is toggled and after some resets), update BAMBU_TOKEN, and check BAMBU_SERIAL. Retrying unchanged will not help."
    : "The printer rejected its credentials. Check API_KEY (and PRINTER_HOST/PRINTER_PORT) for this printer system. Retrying unchanged will not help.";
}

class ThreeDPrinterMCPServer {
  private server: Server;
  private readonly blender = new BlenderMcpBridge();
  private readonly fusion = new FusionMcpBridge();
  // Downloads and installer output are staged in this server's own temporary folder.
  private readonly blenderSetup = new BlenderAddonSetup(() => this.blenderAddonHandshake(), { ...defaultSetupSystem, tmp: TEMP_DIR });
  private readonly fusionSetup = new FusionAddinSetup(() => addinAddress().port, FUSION_MCP_DEFAULT_ARGS, { ...defaultSetupSystem, tmp: TEMP_DIR });
  private printerFactory: PrinterFactory;
  private readonly counterpart: CounterpartService;
  private stlManipulator: STLManipulator;
  /** FULU's BambuNetwork bridge host, started on first use by the bambu_network route. */
  private bambuNetwork = new BambuNetworkBridge();
  private readonly runtimeConfig: RuntimeConfig;
  private httpRuntime?: { transport: StreamableHTTPServerTransport; httpServer: HttpServer };

  constructor() {
    this.runtimeConfig = readRuntimeConfig();
    this.server = new Server(
      {
        name: SERVER_NAME,
        version: SERVER_VERSION
      },
      {
        capabilities: {
          prompts: {},
          resources: {},
          tools: {}
        },
        instructions: SERVER_INSTRUCTIONS
      }
    );

    this.printerFactory = new PrinterFactory((message) => this.confirmHardware(message));
    this.counterpart = new CounterpartService(
      (printerType) => this.printerFactory.getImplementation(printerType),
      axios.create({ timeout: 10000 }),
      { name: SERVER_NAME, version: SERVER_VERSION },
      (material) => resolveFilamentProfile(material, defaultFilamentProfileContext()),
      () => ({ slicerType: DEFAULT_SLICER_TYPE, slicerPath: DEFAULT_SLICER_PATH || undefined })
    );
    this.stlManipulator = new STLManipulator(TEMP_DIR);

    this.setupHandlers();
    this.setupErrorHandling();
  }

  /** The running Blender add-on's get_addon_status, read through this server's Blender bridge (undefined when it has none). */
  private async blenderAddonHandshake(): Promise<BlenderAddonHandshake | undefined> {
    const signal = AbortSignal.timeout(20_000);
    const status = await this.blender.status({ connect: true, timeout_ms: 15_000 }, signal) as { connected?: boolean; tools?: { name?: string }[] };
    if (status?.connected !== true || !status.tools?.some(tool => tool.name === "get_addon_status")) return undefined;
    return parseAddonHandshake(await this.blender.call({ tool_name: "get_addon_status", arguments: {}, timeout_ms: 15_000 }, signal));
  }

  /** Human MCP elicitation for a physical check software cannot make (resuming a job that cannot be re-read). */
  private async confirmHardware(message: string): Promise<boolean> {
    let response;
    const timeout = confirmationTimeoutMs();
    try {
      response = await this.server.elicitInput({
        mode: "form",
        message,
        requestedSchema: {
          type: "object",
          properties: {
            confirmed: { type: "boolean", title: "I checked the printer and confirm this operation", default: false },
          },
          required: ["confirmed"],
        },
      }, { timeout });
    } catch (error) {
      // A person may take minutes to check the printer; a timeout is not a missing capability.
      if ((error as { code?: unknown })?.code === ErrorCode.RequestTimeout) throw new Error(confirmationTimedOut(timeout));
      throw new Error(CONFIRMATION_UNAVAILABLE);
    }
    return response.action === "accept" && response.content?.confirmed === true;
  }

  private async resolveBambuModel(argsModel: string | undefined): Promise<string> {
    const fromArgs = (argsModel || DEFAULT_BAMBU_MODEL).trim().toLowerCase();
    if (fromArgs) {
      return validateBambuModel(fromArgs);
    }

    // No model from args or env — ask the user via elicitation
    try {
      const result = await this.server.elicitInput({
        mode: "form" as const,
        message:
          "Your Bambu Lab printer model is required for safe operation. " +
          "Using the wrong model can cause the bed to crash into the nozzle and damage the printer.",
        requestedSchema: {
          type: "object",
          properties: {
            bambu_model: {
              type: "string",
              title: "Printer Model",
              description: "Which Bambu Lab printer do you have?",
              oneOf: [
                { const: "p1s", title: "P1S" },
                { const: "p1p", title: "P1P" },
                { const: "x1c", title: "X1 Carbon" },
                { const: "x1e", title: "X1E" },
                { const: "a1", title: "A1" },
                { const: "a1mini", title: "A1 Mini" },
                { const: "h2d", title: "H2D" },
              ],
            },
          },
          required: ["bambu_model"],
        },
      }, { timeout: confirmationTimeoutMs() });

      if (result.action === "accept" && result.content?.bambu_model) {
        return validateBambuModel(String(result.content.bambu_model));
      }

      throw new Error(
        "Printer model selection was cancelled. Cannot proceed without knowing the printer model."
      );
    } catch (elicitError: any) {
      const msg = elicitError?.message || String(elicitError);
      if (elicitError?.code === ErrorCode.RequestTimeout) {
        throw new Error(
          "No printer model was chosen in time; nothing was sent. Set BAMBU_MODEL or pass bambu_model, " +
          `or answer the prompt within PRINT_CONFIRMATION_TIMEOUT_MS. Valid models: ${VALID_BAMBU_MODELS.join(", ")}`
        );
      }
      if (
        elicitError?.code === -32601 || elicitError?.code === -32600 ||
        msg.includes("does not support") || msg.includes("elicitation")
      ) {
        throw new Error(
          "bambu_model is required but your MCP client does not support elicitation. " +
          `Set the BAMBU_MODEL environment variable or pass bambu_model in the tool call. ` +
          `Valid models: ${VALID_BAMBU_MODELS.join(", ")}`
        );
      }
      throw elicitError;
    }
  }

  /** Slicing accepts every model with a Bambu-compatible CLI preset mapping. */
  private async resolveSliceBambuModel(argsModel: string | undefined): Promise<string> {
    const requested = (argsModel || DEFAULT_BAMBU_MODEL).trim().toLowerCase();
    if (requested) {
      return validateSliceBambuModel(requested);
    }
    return this.resolveBambuModel(undefined);
  }

  /** Shared slice_stl / slice_with_template implementation. */
  private async runSliceTool(toolName: string, args: Record<string, unknown> | undefined): Promise<SliceOutput & { bed_split?: BedSplit }> {
    if (!args?.stl_path) {
      throw new Error("Missing required parameter: stl_path");
    }
    const processOverrides = parseProcessOverrides(withPrintQuality(args, Number(args.nozzle_diameter || DEFAULT_NOZZLE_DIAMETER)));
    const slicerType = normalizeSlicerType(String(args.slicer_type || DEFAULT_SLICER_TYPE));
    const explicitModel =
      typeof args.bambu_model === "string" && args.bambu_model.trim() ? args.bambu_model : undefined;
    // Generic OrcaSlicer keeps its user-supplied machine profile unless the
    // call explicitly targets a Bambu model.
    const bambuCli = usesBambuCli(slicerType, explicitModel !== undefined);
    if (!bambuCli && parsePauseLayers(args.pause_at_layers)) {
      throw new Error(`Pausing at a layer needs the Bambu Studio or OrcaSlicer CLI, not ${slicerType}.`);
    }
    // Copies only come from the Bambu-compatible CLI; elsewhere one copy would be sliced without a word.
    if (!bambuCli && args.repetitions !== undefined && Number(args.repetitions) > 1) {
      throw new Error(`Copies (repetitions) need the Bambu Studio or OrcaSlicer CLI with a Bambu model, not ${slicerType}; nothing was sliced.`);
    }

    let printerPreset: string | undefined;
    let options: BambuSliceOptions | undefined;
    if (bambuCli) {
      const model = await this.resolveSliceBambuModel(explicitModel);
      printerPreset = SLICE_BAMBU_MODEL_PRESETS[model](normalizeSliceNozzleDiameter(args.nozzle_diameter));
      options = buildBambuSliceOptions(args);
    }

    // Process profile precedence: explicit slicer_profile, then a template, then SLICER_PROFILE.
    const explicitProfile =
      typeof args.slicer_profile === "string" && args.slicer_profile.trim() ? args.slicer_profile.trim() : undefined;
    const templateDir = typeof args.template_dir === "string" ? args.template_dir : undefined;
    const requestedTemplate =
      resolveTemplatePath(
        typeof args.template_name === "string" ? args.template_name : undefined,
        templateDir,
        ["json", "config", "3mf"]
      ) ||
      (typeof args.template_3mf_path === "string" && args.template_3mf_path.trim() ? args.template_3mf_path.trim() : undefined);
    if (requestedTemplate && !bambuCli) {
      throw new Error(
        "template_name/template_3mf_path apply to Bambu-compatible slicing (bambustudio, orcaslicer-bambulab, or orcaslicer with bambu_model)."
      );
    }
    let slicerProfile = explicitProfile;
    // A 3MF that carries its own process (a designer's project) slices with it: a configured default
    // profile or template must not replace the designer's layer height, walls and infill. The machine
    // still comes from bambu_model and nozzle_diameter.
    const ownProcess = await slicesWithOwnProcess(String(args.stl_path), bambuCli, !!explicitProfile || !!requestedTemplate) ? String(args.stl_path) : undefined;
    const templatePath = ownProcess || requestedTemplate || (bambuCli && DEFAULT_TEMPLATE_3MF_PATH ? DEFAULT_TEMPLATE_3MF_PATH : undefined);
    if (!slicerProfile && templatePath) {
      if (!fs.existsSync(templatePath)) {
        throw new Error(`Template not found: ${templatePath}`);
      }
      slicerProfile = await resolveTemplateSlicerProfilePath(templatePath, path.join(TEMP_DIR, "templates"));
    }
    slicerProfile ??= DEFAULT_SLICER_PROFILE || undefined;

    const explicitFilament =
      typeof args.filament_profile === "string" && args.filament_profile.trim() ? args.filament_profile.trim() : undefined;
    // Generic slicers take load_filaments too (filament_profile is its alias), as the Bambu CLI path does.
    const explicitLoad =
      !bambuCli && typeof args.load_filaments === "string" && args.load_filaments.trim() ? args.load_filaments.trim() : undefined;
    if (explicitLoad && explicitFilament && explicitLoad !== explicitFilament) {
      throw new Error("Provide either load_filaments or filament_profile, not conflicting values.");
    }
    const filamentProfile = options?.loadFilaments ?? explicitLoad ?? explicitFilament ?? (DEFAULT_FILAMENT_PROFILE || undefined);
    // A filament chosen for this call replaces the default riding in "machine;process|filament",
    // or Orca would keep that default as slot 1 and add the chosen one as slot 2.
    if (!bambuCli && (explicitLoad ?? explicitFilament) && slicerProfile?.includes("|")) {
      slicerProfile = slicerProfile.split("|", 1)[0];
    }
    const slicerPath =
      this.resolveExecutableSelectorArg(args.slicer_path, toolName, "slicer_path") ?? defaultSlicerPathFor(slicerType);

    // A model bigger than the bed: split into its parts and arranged on as many plates as it needs
    // (src/slicer/bed-plates.ts), then that project is sliced, one plate (slice_plate, default 1) or all (0).
    let slicePath = String(args.stl_path);
    let bedSplit: BedSplit | undefined;
    // slice_stl only: it is the tool that hands back the plates (slice_with_template returns just a path).
    if (toolName === "slice_stl" && args.split_to_plates === true && /\.(stl|obj)$/i.test(slicePath)) {
      if (!bambuCli || !options || !printerPreset) {
        throw new Error(`split_to_plates needs the Bambu Studio or OrcaSlicer CLI with a Bambu model, not ${slicerType}; nothing was sliced.`);
      }
      const transformed = ["scale", "rotate", "rotate_x", "rotate_y", "repetitions", "clone_objects"].filter(key => args[key] !== undefined && !(key === "repetitions" && Number(args.repetitions) === 1));
      if (transformed.length) throw new Error(`split_to_plates can't be combined with ${transformed.join(", ")}; nothing was sliced.`);
      let profilesRoot: string | undefined;
      try { profilesRoot = detectProfilesRoot(slicerPath, slicerType); }
      catch (error) { console.error(`split_to_plates: no profile tree for ${slicerType} (${error instanceof Error ? error.message : String(error)}).`); }
      const printerName = printerPreset.replace(/^Bambu Lab /, "").replace(/ [\d.]+ nozzle$/, "");
      const model = normalizeModel(printerName);
      const bed = await machineBed(profilesRoot, printerPreset, model ? MACHINE_LIMITS[model]?.volume : undefined);
      // Named by the model's bytes and the bed: different models, or one model on different beds, never share a file.
      const modelHash = createHash("sha256").update(await fs.promises.readFile(slicePath)).update(JSON.stringify(bed)).digest("hex").slice(0, 12);
      bedSplit = await splitToPlates({ modelPath: slicePath, bed, printer: printerName,
        outPath: path.join(TEMP_DIR, `${path.basename(slicePath, path.extname(slicePath))}_plates_${modelHash}.3mf`) });
      // A part bigger than the bed: said plainly by the caller, nothing sliced.
      if (!bedSplit.fits && !("three_mf_path" in bedSplit)) return { path: "", bed_split: bedSplit };
      if (!bedSplit.fits) {
        slicePath = bedSplit.three_mf_path;
        // The project keeps the arrangement: exactly what a client slicing that 3MF's plate sends.
        Object.assign(options, { arrange: false, orient: false, ensureOnBed: false, slicePlate: options.slicePlate ?? 1 });
      }
    }

    const sliced = await this.stlManipulator.sliceSTLWithResult(
      slicePath,
      slicerType,
      slicerPath,
      slicerProfile,
      undefined, // progressCallback
      printerPreset,
      filamentProfile,
      options,
      processOverrides
    );
    return bedSplit ? { ...sliced, bed_split: bedSplit } : sliced;
  }

  setupErrorHandling() {
    this.server.onerror = (error) => {
      console.error("[MCP Error]", error);
    };
  }

  setupHandlers() {
    this.setupResourceHandlers();
    this.setupPromptHandlers();
    this.setupToolHandlers();
  }

  /**
   * The AMS choice for a Bambu print, as bambu-printer-mcp's print_3mf resolves
   * it: the 3MF's own mapping (ordered by project filament index), overridden by
   * an explicit ams_mapping, which ams_slots (one tray per used filament)
   * replaces. use_ams:false prints from the external spool. Tray values are
   * checked here; the adapter expands ams_slots against the inspected plate.
   */
  private resolveAmsPrintOptions(
    parsed3MFData: ThreeMFData | undefined,
    args: Record<string, unknown> | undefined,
    model?: string
  ): { useAMS: boolean; amsMapping?: number[]; amsSlots?: number[] } {
    const trayOptions = { dualNozzle: isDualNozzleModel(model) };
    let finalAmsMapping: number[] | undefined;
    let finalAmsSlots: number[] | undefined;
    if (parsed3MFData?.slicerConfig?.ams_mapping) {
      const slots = normalizeAmsMappingObject(parsed3MFData.slicerConfig.ams_mapping as Record<string, unknown>, "ams_mapping", trayOptions);
      if (slots.length > 0) finalAmsMapping = slots;
    }
    let useAMS = args?.use_ams !== undefined ? Boolean(args.use_ams) : !!finalAmsMapping && finalAmsMapping.length > 0;
    const hasUserAmsMapping = hasAmsMappingInput(args?.ams_mapping);
    const hasUserAmsSlots = Array.isArray(args?.ams_slots);

    if (hasUserAmsMapping) {
      let userMapping: number[] | undefined;
      if (Array.isArray(args!.ams_mapping)) {
        userMapping = (args!.ams_mapping as unknown[]).map((value, index) =>
          normalizeBridgeAmsTrayValue(value, `ams_mapping[${index}]`, trayOptions));
      } else if (args!.ams_mapping && typeof args!.ams_mapping === "object") {
        userMapping = normalizeAmsMappingObject(args!.ams_mapping as Record<string, unknown>, "ams_mapping", trayOptions);
      } else {
        throw new Error("ams_mapping must be an array of trays or an object of trays keyed by project filament index.");
      }
      if (userMapping.length > 0) {
        finalAmsMapping = userMapping;
        useAMS = true;
      }
    }
    if (hasUserAmsSlots) {
      const userSlots = (args!.ams_slots as unknown[]).map((value, index) =>
        normalizeBridgeAmsTrayValue(value, `ams_slots[${index}]`, trayOptions));
      if (userSlots.length > 0) {
        finalAmsSlots = userSlots;
        finalAmsMapping = undefined;
        useAMS = true;
      }
    }
    if (args?.use_ams === false) {
      if (!hasUserAmsMapping) finalAmsMapping = undefined;
      if (!hasUserAmsSlots) finalAmsSlots = undefined;
      useAMS = false;
    }
    if ((!finalAmsMapping || finalAmsMapping.length === 0) && (!finalAmsSlots || finalAmsSlots.length === 0)) {
      useAMS = false;
    }
    return { useAMS, amsMapping: finalAmsMapping, amsSlots: finalAmsSlots };
  }

  /**
   * print_3mf over FULU's BambuNetwork bridge (connection_mode bambu_network),
   * ported from bambu-printer-mcp: the route a P1S on authorization firmware
   * without Developer Mode prints through. connection_type lan opens the
   * plug-in's authenticated local session (start_local_print); cloud sends
   * through Bambu Cloud (start_print). The shared gates run first: the exact
   * snapshot bytes are inspected, the AMS mapping checked, and fresh LAN MQTT
   * state validated before the bridge starts, again immediately before the
   * print frame, and the job is recorded for a checked resume.
   */
  private async print3mfViaBambuNetwork(options: {
    args: Record<string, any>; host: string; serial: string; token: string; threeMFPath: string;
    model: string; nozzleDiameters?: number[]; bedType: string; connectionType: string;
    ams: { useAMS: boolean; amsMapping?: number[]; amsSlots?: number[] };
    /** The zero-based plate print_3mf validated: inspected and dispatched as the same plate. */
    plateIndex: number;
  }): Promise<Record<string, unknown>> {
    const { args, model, bedType, connectionType } = options;
    const devId = options.serial.trim();
    const devIp = options.host.trim();
    const password = options.token.trim();
    if (!devId || !devIp || devIp === "localhost" || !password) {
      throw new Error("FULU BambuNetwork printing requires bambu_serial, the printer host and its LAN access code: fresh printer state is checked over MQTT before every bridge print, including cloud dispatch.");
    }
    const isLocalBridgePrint = connectionType === "lan";
    // Bambu Studio sends a cloud-bound printer it can reach on the LAN with record first, in the cloud
    // session, then start_print (PrintJob.cpp). This server always has the printer's IP and access code.
    let bridgeMethod = isLocalBridgePrint ? "net.start_local_print" : "net.start_local_print_with_record";
    let cloudFallbackMethod = isLocalBridgePrint ? undefined : "net.start_print";
    const { plateIndex } = options;
    const threeMfFilename = path.basename(options.threeMFPath);
    const projectName = threeMfFilename.replace(/\.3mf$/i, "");
    const presetName = `${projectName}_plate_${plateIndex + 1}`;
    const clientJobId = Date.now();
    const bambu = this.printerFactory.getImplementation("bambu") as unknown as BambuImplementation;
    const dualNozzle = isDualNozzleModel(model);

    return withPrinterOperation(devIp, devId, (assertActive) => withPrintSnapshot(options.threeMFPath, async (snapshot, retainForDispatchedUpload) => {
      const inspection = await inspectPrintFile(snapshot, { model, nozzleDiameters: options.nozzleDiameters, plateIndex, bedType });
      const resumeFile = await checkedFile(inspection, snapshot);
      // The options Bambu Studio's Send dialog would send; explicit ones win.
      const studio = resolveStudioPrintOptions(model, callerPrintOptions(args), { usedNozzles: usedNozzleCount(inspection) });
      const { useAMS, amsSlots } = options.ams;
      let mapping = options.ams.amsMapping?.slice();
      if (amsSlots) {
        if (amsSlots.length !== inspection.usedFilamentPositions.length) throw new Error("ams_slots must supply exactly one physical tray per used filament.");
        mapping = Array<number>(inspection.materials.length).fill(-1);
        inspection.usedFilamentPositions.forEach((position, index) => { mapping![position] = amsSlots[index]; });
      }
      if (!useAMS) {
        mapping ??= Array<number>(inspection.materials.length).fill(-1);
        for (const position of inspection.usedFilamentPositions) {
          if (mapping[position] === undefined || mapping[position] < 0) {
            mapping[position] = externalTrayForNozzle(inspection.filamentNozzleIndices?.[position], dualNozzle);
          }
          if (mapping[position] !== 254 && !(dualNozzle && mapping[position] === 255)) {
            throw new Error("use_ams:false requires an external-spool mapping for every used filament.");
          }
        }
      }
      for (const position of inspection.usedFilamentPositions) {
        if (mapping?.[position] === undefined || mapping[position] < 0) {
          throw new Error(`Missing physical filament mapping for project filament ${position}. Pass ams_slots (one tray per used filament), ams_mapping, or use_ams:false for the external spool.`);
        }
      }
      const requirements = { ...inspection, amsMapping: mapping, useAMS };
      validatePrinterState(await bambu.getSafetyStatus(devIp, devId, password), requirements);
      const confirmedStatus = await bambu.getSafetyStatus(devIp, devId, password);
      validatePrinterState(confirmedStatus, requirements);
      if (cloudFallbackMethod && externalStorageState(confirmedStatus.raw) !== "normal") {
        // Studio sends straight through the cloud when the printer has no storage for the LAN upload.
        bridgeMethod = cloudFallbackMethod;
        cloudFallbackMethod = undefined;
      }
      const wireMapping = mapping!.map((value) => bridgeAmsMappingValue(value, dualNozzle));
      const remoteFileName = uniquePrintName(options.threeMFPath);
      const checkedName = remoteFileName.replace(/(?:\.gcode)?\.3mf$/i, "");
      const params: Record<string, unknown> = {
        dev_id: devId,
        // The printer reports the task or project name back; both carry the unique
        // checked name, which binds the job to this inspected artifact for a later resume.
        task_name: checkedName,
        project_name: checkedName,
        preset_name: presetName,
        filename: snapshot,
        config_filename: snapshot,
        plate_index: plateIndex + 1,
        ftp_folder: "",
        ftp_file: "",
        ftp_file_md5: "",
        nozzle_mapping: "",
        ams_mapping: JSON.stringify(wireMapping),
        ams_mapping2: JSON.stringify(mapping!.map((value) => bridgeAmsMapping2Entry(value, dualNozzle))),
        // Bambu Studio and FULU's slicer send this with every job (get_ams_mapping_result).
        ams_mapping_info: inspection.projectFilaments?.length
          ? JSON.stringify(studioAmsMappingInfo(inspection.projectFilaments, mapping!, (tray) => trayColour(confirmedStatus.raw, tray)))
          : "",
        nozzles_info: "",
        connection_type: connectionType,
        comments: "",
        origin_profile_id: 0,
        stl_design_id: 0,
        origin_model_id: "",
        print_type: "from_normal",
        dst_file: remoteFileName,
        dev_name: "",
        dev_ip: devIp,
        use_ssl_for_ftp: true,
        use_ssl_for_mqtt: true,
        username: "bblp",
        password,
        task_bed_leveling: studio.task_bed_leveling,
        task_flow_cali: studio.task_flow_cali,
        task_vibration_cali: studio.task_vibration_cali,
        task_layer_inspect: studio.task_layer_inspect,
        task_record_timelapse: args?.timelapse !== undefined ? Boolean(args.timelapse) : false,
        task_use_ams: useAMS,
        task_bed_type: bedType,
        extra_options: "",
        auto_bed_leveling: studio.auto_bed_leveling,
        auto_flow_cali: studio.auto_flow_cali,
        auto_offset_cali: studio.auto_offset_cali,
        extruder_cali_manual_mode: studio.extruder_cali_manual_mode,
        task_ext_change_assist: false,
        try_emmc_print: false,
      };
      assertActive();
      const bridgeOptions = {
        // Trusted in-process preflight immediately before the print frame.
        beforeDispatch: async (method: string) => {
          if (method !== bridgeMethod && method !== cloudFallbackMethod) return;
          assertActive();
          validatePrinterState(await bambu.getSafetyStatus(devIp, devId, password), requirements);
        },
        assertDispatchAllowed: (method: string) => { if (method === bridgeMethod || method === cloudFallbackMethod) assertActive(); },
        onDispatched: (method: string) => { if (method === bridgeMethod || method === cloudFallbackMethod) retainForDispatchedUpload(); },
      };
      let jobUpdates: BridgeJobUpdate[] = [];
      let bridgeResult: unknown;
      let firstAttempt = "";
      if (isLocalBridgePrint) {
        ({ result: bridgeResult, jobUpdates } = await this.bambuNetwork.startLocalPrint(
          { devId, devIp, username: "bblp", password, useSsl: true },
          bridgeMethod, { client_job_id: clientJobId, params }, bridgeOptions, assertActive
        ));
      } else {
        let firstFailure: number | undefined;
        ({ result: bridgeResult, jobUpdates, firstFailure } = await this.bambuNetwork.startCloudPrint(devId, bridgeMethod, { client_job_id: clientJobId, params }, bridgeOptions, assertActive, undefined, cloudFallbackMethod));
        if (firstFailure !== undefined) {
          bridgeMethod = cloudFallbackMethod!;
          firstAttempt = ` It first tried net.start_local_print_with_record, as Bambu Studio does, which returned ${firstFailure}${describeBambuNetworkPrintError(firstFailure)}.`;
        }
      }
      if (typeof bridgeResult === "object" && bridgeResult !== null && (bridgeResult as { ok?: unknown }).ok === false) {
        throw new Error(`FULU BambuNetwork bridge method ${bridgeMethod} failed: ${String((bridgeResult as { error?: unknown }).error || "unknown bridge error")}`);
      }
      const value = typeof bridgeResult === "object" && bridgeResult !== null ? (bridgeResult as { value?: unknown }).value : undefined;
      if (typeof value === "number" && value !== 0) {
        const reported = jobUpdates.filter((update) => update.code !== 0 || update.msg).slice(-3)
          .map((update) => `status ${update.status}, code ${update.code}${update.msg ? `: ${update.msg}` : ""}`).join("; ");
        throw new Error(`FULU BambuNetwork bridge method ${bridgeMethod} returned non-zero result ${value}${describeBambuNetworkPrintError(value)}.` +
          (reported ? ` Plug-in reported: ${reported}.` : "") + firstAttempt);
      }
      assertActive();
      // Bambu's plug-in placed the file, so a resume re-reads it if it can and otherwise asks a person.
      bambu.recordCheckedJob(devIp, devId, remoteFileName, requirements, resumeFile, false);
      return {
        status: "success",
        message: `FULU BambuNetwork ${bridgeMethod.replace(/^net\./, "")} command for ${threeMfFilename} sent successfully.${firstAttempt}`,
        connectionMode: "bambu_network",
        connectionType,
        bridgeMethod,
        bridgeResult,
        clientJobId,
        projectName,
        plateIndex,
        bridgePlateIndex: plateIndex + 1,
        printerJobName: checkedName,
        useAMS,
        amsMapping: mapping,
        sha256: inspection.sha256,
        params: { ...params, password: "[redacted]" },
      };
    }, bridgeSnapshotRoot()));
  }

  /** The FDM design guidance as MCP prompts: the client decides when to attach each one. */
  setupPromptHandlers() {
    this.server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: [...DESIGN_PROMPTS, FDM_SLICING_PROMPT].map(({ name, title, description }) => ({ name, title, description })),
    }));
    this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      if (request.params.name === FDM_SLICING_PROMPT.name) {
        // The slicer slice_stl uses by default, and what it applies there (as counterpart_printer_info reports it).
        const bambu = DEFAULT_TYPE.toLowerCase() === "bambu";
        return {
          description: FDM_SLICING_PROMPT.description,
          messages: [{ role: "user" as const, content: { type: "text" as const, text: slicingGuidance(DEFAULT_SLICER_TYPE, sliceCapabilities(DEFAULT_SLICER_TYPE, bambu)) } }],
        };
      }
      const prompt = DESIGN_PROMPTS.find(item => item.name === request.params.name);
      if (!prompt) throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${request.params.name}`);
      return {
        description: prompt.description,
        messages: [{ role: "user" as const, content: { type: "text" as const, text: prompt.text } }],
      };
    });
  }

  setupResourceHandlers() {
    // List available resources
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      return {
        resources: [
          {
            uri: `printer://${DEFAULT_HOST}/status`,
            name: "3D Printer Status",
            mimeType: "application/json",
            description: "Current status of the 3D printer including temperatures, print progress, and more"
          },
          {
            uri: `printer://${DEFAULT_HOST}/files`,
            name: "3D Printer Files",
            mimeType: "application/json",
            description: "List of files available on the 3D printer"
          },
          FDM_CAPABILITY_RESOURCE
        ],
        templates: [
          {
            uriTemplate: "printer://{host}/status",
            name: "3D Printer Status",
            mimeType: "application/json"
          },
          {
            uriTemplate: "printer://{host}/files",
            name: "3D Printer Files",
            mimeType: "application/json"
          },
          {
            uriTemplate: "printer://{host}/file/{filename}",
            name: "3D Printer File Content",
            mimeType: "application/gcode"
          }
        ]
      };
    });

    // Read resource
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const uri = request.params.uri;
      if (uri === FDM_CAPABILITY_URI) {
        return { contents: [{ uri, mimeType: FDM_CAPABILITY_RESOURCE.mimeType, text: FDM_CAPABILITY_GUIDANCE }] };
      }
      const match = uri.match(/^printer:\/\/([^\/]+)\/(.+)$/);

      if (!match) {
        throw new McpError(ErrorCode.InvalidRequest, `Invalid resource URI: ${uri}`);
      }

      const [, host, resource] = match;
      let content;

      try {
        if (resource === "status") {
          content = await this.getPrinterStatus(host);
        } else if (resource === "files") {
          content = await this.getPrinterFiles(host);
        } else if (resource.startsWith("file/")) {
          const filename = resource.substring(5);
          content = await this.getPrinterFile(host, filename);
        } else {
          throw new McpError(ErrorCode.InvalidRequest, `Unknown resource: ${resource}`);
        }

        return {
          contents: [
            {
              uri,
              mimeType: resource.startsWith("file/") ? "application/gcode" : "application/json",
              text: typeof content === "string" ? content : JSON.stringify(content, null, 2)
            }
          ]
        };
      } catch (error) {
        if (axios.isAxiosError(error)) {
          throw new McpError(
            ErrorCode.InternalError,
            `API error: ${error.response?.data?.error || error.message}`
          );
        }
        throw error;
      }
    });
  }

  setupToolHandlers() {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: annotateTools([
          {
            name: "get_printer_status",
            description: "Get the current status of the 3D printer",
            inputSchema: {
              type: "object",
              properties: {
                host: {
                  type: "string",
                  description: "Hostname or IP address of the printer (default: value from env)"
                },
                port: {
                  type: "string",
                  description: "Port of the printer API (default: value from env)"
                },
                type: {
                  type: "string",
                  description: "Type of printer management system (octoprint, klipper, duet, repetier, bambu, prusa, creality) (default: value from env)"
                },
                api_key: {
                  type: "string",
                  description: "API key for authentication (default: value from env)"
                },
                bambu_serial: {
                  type: "string",
                  description: "Serial number for Bambu Lab printers (default: value from env)"
                },
                bambu_token: {
                  type: "string",
                  description: "Access token for Bambu Lab printers (default: value from env)"
                }
              }
            }
          },
          {
            name: "list_printer_files",
            description: "List files available on the 3D printer",
            inputSchema: {
              type: "object",
              properties: {
                host: {
                  type: "string",
                  description: "Hostname or IP address of the printer (default: value from env)"
                },
                port: {
                  type: "string",
                  description: "Port of the printer API (default: value from env)"
                },
                type: {
                  type: "string",
                  description: "Type of printer management system (octoprint, klipper, duet, repetier, bambu, prusa, creality) (default: value from env)"
                },
                api_key: {
                  type: "string",
                  description: "API key for authentication (default: value from env)"
                },
                bambu_serial: {
                  type: "string",
                  description: "Serial number for Bambu Lab printers (default: value from env)"
                },
                bambu_token: {
                  type: "string",
                  description: "Access token for Bambu Lab printers (default: value from env)"
                }
              }
            }
          },
          {
            name: "upload_gcode",
            description: "Upload G-code content or a local G-code file path to the printer. With print=true the exact uploaded bytes are inspected first (every S/R heater target, tool changes, hardware and material ceilings) and printer state is checked before the print starts.",
            inputSchema: {
              type: "object",
              properties: {
                host: {
                  type: "string",
                  description: "Hostname or IP address of the printer (default: value from env)"
                },
                port: {
                  type: "string",
                  description: "Port of the printer API (default: value from env)"
                },
                type: {
                  type: "string",
                  description: "Type of printer management system (octoprint, klipper, duet, repetier, bambu, prusa, creality) (default: value from env)"
                },
                api_key: {
                  type: "string",
                  description: "API key for authentication (default: value from env)"
                },
                bambu_serial: {
                  type: "string",
                  description: "Serial number for Bambu Lab printers (default: value from env)"
                },
                bambu_token: {
                  type: "string",
                  description: "Access token for Bambu Lab printers (default: value from env)"
                },
                bambu_model: {
                  type: "string",
                  enum: [...VALID_BAMBU_MODELS],
                  description: "Required for Bambu print operations unless BAMBU_MODEL is configured. Must match the printer and pre-sliced G-code."
                },
                filename: {
                  type: "string",
                  description: "Filename to use on the printer. Defaults to the basename of gcode_path when omitted."
                },
                gcode: {
                  type: "string",
                  description: "G-code content, or a local path to a G-code file."
                },
                gcode_path: {
                  type: "string",
                  description: "Local path to a G-code file to upload."
                },
                print: {
                  type: "boolean",
                  description: "Start printing after upload when the printer backend supports it. Printing requires a declared material from slicer metadata (; filament_type = PLA) or the material argument."
                },
                material: {
                  type: "string",
                  description: "Declared filament material (for example PLA, PETG, ABS, ASA, TPU, PA, PC) when the G-code has no slicer filament_type metadata. Must not contradict the file. Material ceilings limit nozzle targets."
                }
              }
            }
          },
          {
            name: "start_print",
            description: "Start printing a G-code file already stored on the printer. The server downloads and inspects the exact file, then starts a uniquely named checked copy after printer-state checks. Printers whose API cannot download files (Repetier, Prusa, Creality) refuse; use upload_gcode with print=true instead.",
            inputSchema: {
              type: "object",
              properties: {
                host: {
                  type: "string",
                  description: "Hostname or IP address of the printer (default: value from env)"
                },
                port: {
                  type: "string",
                  description: "Port of the printer API (default: value from env)"
                },
                type: {
                  type: "string",
                  description: "Type of printer management system (octoprint, klipper, duet, repetier, bambu, prusa, creality) (default: value from env)"
                },
                api_key: {
                  type: "string",
                  description: "API key for authentication (default: value from env)"
                },
                bambu_serial: {
                  type: "string",
                  description: "Serial number for Bambu Lab printers (default: value from env)"
                },
                bambu_token: {
                  type: "string",
                  description: "Access token for Bambu Lab printers (default: value from env)"
                },
                bambu_model: {
                  type: "string",
                  enum: [...VALID_BAMBU_MODELS],
                  description: "Required for Bambu print operations unless BAMBU_MODEL is configured. Must match the printer and pre-sliced G-code."
                },
                filename: {
                  type: "string",
                  description: "Name/path of the printer-side G-code file to start."
                },
                material: {
                  type: "string",
                  description: "Declared filament material when the G-code has no slicer filament_type metadata (non-Bambu printers). Must not contradict the file."
                }
              },
              required: ["filename"]
            }
          },
          {
            name: "cancel_print",
            description: "Cancel the current print job",
            inputSchema: {
              type: "object",
              properties: {
                host: {
                  type: "string",
                  description: "Hostname or IP address of the printer (default: value from env)"
                },
                port: {
                  type: "string",
                  description: "Port of the printer API (default: value from env)"
                },
                type: {
                  type: "string",
                  description: "Type of printer management system (octoprint, klipper, duet, repetier, bambu, prusa, creality) (default: value from env)"
                },
                api_key: {
                  type: "string",
                  description: "API key for authentication (default: value from env)"
                },
                bambu_serial: {
                  type: "string",
                  description: "Serial number for Bambu Lab printers (default: value from env)"
                },
                bambu_token: {
                  type: "string",
                  description: "Access token for Bambu Lab printers (default: value from env)"
                },
                ...CONNECTION_PROPERTIES,
              }
            }
          },
          ...CAMERA_STREAM_TOOLS,
          {
            name: "counterpart_print_route",
            description: "Counterpart contract (counterpart/1), Bambu: how this server reaches the printer for prints and for Stop/Pause/Resume. route is \"lan\" (the local network through FULU's BambuNetwork bridge), \"cloud\" (Bambu Cloud through FULU's bridge) or \"developer\" (the local network straight to a printer in LAN Only + Developer Mode, whose Pause, Resume and Stop need no Bambu app). options lists each with its label, whether it can be chosen here (and why not) and what controls do on it; choices lists the ids that can be chosen. mode and type are BAMBU_DEFAULT_CONNECTION_MODE and BAMBU_DEFAULT_CONNECTION_TYPE as resolved. Pass route to change it: the change applies to the next print and control at once, and is saved to the .env file in this server's working directory when that file exists (savedTo; null otherwise). Sends nothing to the printer.",
            inputSchema: {
              type: "object",
              properties: {
                route: { type: "string", enum: ["lan", "cloud", "developer"], description: "Change the route. Omit to read it." }
              },
              additionalProperties: false
            }
          },
          {
            name: "counterpart_printer_info",
            description: "Describe this printer for the counterpart/1 contract: server name and version, printer kind and identity, and which features work (progress, layers, camera, filaments, pause, resume, cancel, print_3mf, G-code), detected from the firmware. Read-only.",
            inputSchema: { type: "object", properties: { ...PRINTER_TARGET_PROPERTIES } },
            outputSchema: PRINTER_INFO_OUTPUT_SCHEMA,
          },
          {
            name: "counterpart_print_progress",
            description: "Read the printer's state and current job in the counterpart/1 shape: state, job name, progress (0-100), elapsed and remaining seconds, layers when the firmware reports them, temperatures and problems. job.name matches the jobName that upload_gcode and start_print return. Read-only.",
            inputSchema: { type: "object", properties: { ...PRINTER_TARGET_PROPERTIES } },
            outputSchema: PRINT_PROGRESS_OUTPUT_SCHEMA,
          },
          {
            name: "camera_snapshot",
            description: "Capture one JPEG frame from the printer's camera: OctoPrint's configured snapshot URL (Classic Webcam on 1.9+, webcam.snapshotUrl on 1.8, then /webcam/?action=snapshot), Moonraker's first enabled webcam, or Repetier's webcam staticUrl. PrusaLink and Duet have no local snapshot API. PRINTER_CAMERA_SNAPSHOT_URL overrides the source for any printer. Returns the JPEG as base64; pass save_path to also write it to disk.",
            inputSchema: {
              type: "object",
              properties: {
                ...PRINTER_TARGET_PROPERTIES,
                save_path: { type: "string", description: "Optional absolute path to write the JPEG to disk. If omitted, only the base64 payload is returned." },
                timeout_ms: { type: "number", description: "Max ms to wait for a frame (default 8000, 100 to 120000)." },
              },
            },
            outputSchema: CAMERA_SNAPSHOT_OUTPUT_SCHEMA,
          },
          {
            name: "counterpart_discover_printers",
            description: "Counterpart contract (counterpart/1): printers on the local network. Bambu Lab printers from their own SSDP announcements (UDP 2021), with serial, model (as bambu_model names it), name and firmware; OctoPrint, Klipper (Moonraker) and PrusaLink hosts from their Bonjour adverts (dns-sd on macOS, avahi-browse on Linux), with host and port. Listens for duration_ms (default 4000). network is \"unavailable\" when another app holds the Bambu port. Never connects to or authenticates with a printer.",
            inputSchema: {
              type: "object",
              properties: { duration_ms: { type: "integer", minimum: 500, maximum: 15000, description: "How long to listen (default 4000)." } },
              additionalProperties: false,
            },
            outputSchema: DISCOVER_OUTPUT_SCHEMA,
          },
          {
            name: "counterpart_setup_fields",
            description: "Counterpart contract (counterpart/1): the printers this server drives (each PRINTER_TYPE) and the settings it reads for each, by .env variable name: label, hint, whether required, the fixed values a kind needs (PRINTER_TYPE), the Bambu model choices and the model each serial-number prefix names. Pass serial to get the model it names. Sends nothing to a printer and returns no configured values.",
            inputSchema: {
              type: "object",
              properties: { serial: { type: "string", maxLength: 64, description: "A Bambu serial number: model is the one it names, when known." } },
              additionalProperties: false,
            },
            outputSchema: SETUP_FIELDS_OUTPUT_SCHEMA,
          },
          {
            name: "counterpart_propose_filaments",
            description: "Counterpart contract (counterpart/1): which loaded spool prints each of a model's colours, before slicing. Reads the printer's filaments once (Bambu: the AMS and external spools). trays lists the spools a person may choose (label like \"A2\" or \"External\", a person-readable name, colour, material, feed, and the filament profile slice_stl takes). proposal gives each filament its nearest spool in OKLab colour with the asked-for material preferred, and a verdict: same-colour, closest (that colour isn't loaded; note says so), no-colour or none. One print feeds from one source: the AMS or the external spool. Pass chosen to check the person's spools against what is loaded now; mapping then lists every filament slot's spool (painted slots included), and problems says why a choice can't print.",
            inputSchema: {
              type: "object",
              properties: {
                ...PROPOSE_FILAMENTS_INPUT_PROPERTIES,
                ...PRINTER_TARGET_PROPERTIES,
                bambu_model: { type: "string", description: "Bambu only: printer model (default BAMBU_MODEL). Selects the filament profiles that decide which spools can slice." },
                nozzle_diameter: { type: "string", description: "Bambu only: nozzle diameter (default NOZZLE_DIAMETER or 0.4)." },
              },
              required: ["filaments"],
              additionalProperties: false,
            },
            outputSchema: PROPOSE_FILAMENTS_OUTPUT_SCHEMA,
          },
          {
            name: "get_printer_filaments",
            description: "Report the loaded filament. Bambu: the live AMS and external-spool inventory over MQTT, as bambu-printer-mcp reports it (trays with absolute slot, loaded state, material, colour, tray_info_idx and resolved slicer profile path; summary; recommended load_filaments), plus counterpart/1 slots for every loaded tray and external spool (254, and 255 on dual-nozzle printers). Other printers: one external slot (id \"ext\"); Moonraker printers with Spoolman report the active spool's material, colour and name, others source \"unknown\". Read-only.",
            inputSchema: {
              type: "object",
              properties: {
                ...PRINTER_TARGET_PROPERTIES,
                bambu_model: { type: "string", description: "Bambu only: optional model hint used to resolve Bambu/Orca filament profile JSONs for each tray (default: BAMBU_MODEL)." },
                nozzle_diameter: { type: "string", description: "Bambu only: optional nozzle diameter used when resolving model-specific filament profile JSONs (default: 0.4)." },
              },
            },
            outputSchema: FILAMENTS_OUTPUT_SCHEMA,
          },
          {
            name: "pause_print",
            description: "Pause the current print (Bambu Lab, OctoPrint, Klipper/Moonraker, PrusaLink, Duet M25, Repetier, and Creality printers that run Moonraker). Bambu pauses over the same connection that prints. Pause is never gated.",
            inputSchema: { type: "object", properties: { ...PRINTER_TARGET_PROPERTIES, ...CONNECTION_PROPERTIES } },
            outputSchema: CONTROL_OUTPUT_SCHEMA,
          },
          {
            name: "resume_print",
            description: "Resume a paused print. Resume reheats and moves the printer, so it only resumes a job this server instance inspected and started, and only when the printer freshly reports that job paused. Bambu re-reads the job over FTPS (or the plate G-code the printer extracted) and compares its SHA-256, and resumes over the same connection that printed. When the file cannot be re-read, a person confirms through MCP elicitation first (Bambu: only for files Bambu's plug-in placed; a file this server uploaded must re-read). Resume other jobs at the printer.",
            inputSchema: { type: "object", properties: { ...PRINTER_TARGET_PROPERTIES, ...CONNECTION_PROPERTIES } },
            outputSchema: CONTROL_OUTPUT_SCHEMA,
          },
          {
            name: "set_printer_temperature",
            description: "Set the temperature of a printer component. Temperature 0 switches a heater off and is never gated. Positive targets are validated before connecting, limited by independent hardware and material ceilings, and require a ready printer.",
            inputSchema: {
              type: "object",
              properties: {
                host: {
                  type: "string",
                  description: "Hostname or IP address of the printer (default: value from env)"
                },
                port: {
                  type: "string",
                  description: "Port of the printer API (default: value from env)"
                },
                type: {
                  type: "string",
                  description: "Type of printer management system (octoprint, klipper, duet, repetier, bambu, prusa, creality) (default: value from env)"
                },
                api_key: {
                  type: "string",
                  description: "API key for authentication (default: value from env)"
                },
                bambu_serial: {
                  type: "string",
                  description: "Serial number for Bambu Lab printers (default: value from env)"
                },
                bambu_token: {
                  type: "string",
                  description: "Access token for Bambu Lab printers (default: value from env)"
                },
                component: {
                  type: "string",
                  description: "Printer component to heat, such as extruder or bed."
                },
                temperature: {
                  type: "number",
                  description: "Target temperature in Celsius: a finite number >= 0. 0 switches the heater off."
                },
                material: {
                  type: "string",
                  description: "Declared material at the nozzle (for example PLA, PETG, ABS). Required for positive nozzle heating, including non-RFID spools."
                },
                bambu_model: {
                  type: "string",
                  enum: [...VALID_BAMBU_MODELS],
                  description: "Bambu printer model; required for positive Bambu heating unless BAMBU_MODEL is configured. Checked against the live printer."
                },
                nozzle_diameter: {
                  type: "string",
                  description: "Installed Bambu nozzle diameter in mm for nozzle heating (default: NOZZLE_DIAMETER or 0.4). Checked against the live printer."
                }
              },
              required: ["component", "temperature"]
            }
          },
          // New STL manipulation tools
          {
            name: "extend_stl_base",
            description: "Extend the base of an STL file by a specified amount",
            inputSchema: {
              type: "object",
              properties: {
                stl_path: {
                  type: "string",
                  description: "Path to the STL file to modify"
                },
                extension_inches: {
                  type: "number",
                  description: "Amount to extend the base in inches"
                }
              },
              required: ["stl_path", "extension_inches"]
            }
          },
          {
            name: "slice_stl",
            description:
              "Slice an STL or 3MF file to generate G-code or a sliced 3MF. For Bambu-compatible CLI slicing " +
              "(bambustudio, orcaslicer-bambulab, or orcaslicer with bambu_model), the exact bambu_model/nozzle machine " +
              "preset from the selected slicer installation is required, profile inheritance is resolved before the CLI " +
              "runs, and the result must contain plate G-code. Failures stop with the slicer's exit status and output. A 3MF that carries its own process settings (a designer's Bambu Studio or Orca project) slices with them unless slicer_profile, template_name or template_3mf_path is given; the machine still comes from bambu_model. quality and strength adjust that process, and strength never lowers its walls or infill.",
            inputSchema: {
              type: "object",
              properties: {
                stl_path: {
                  type: "string",
                  description: "Path to the STL or 3MF file to slice"
                },
                ...SLICE_TOOL_PROPERTIES,
              },
              required: ["stl_path"]
            }
          },
          {
            name: "slice_with_template",
            description:
              "Slice an STL or 3MF with a named template from the local template registry (BAMBU_TEMPLATE_DIR). " +
              "The template supplies process settings; the machine preset still comes from bambu_model and nozzle_diameter.",
            inputSchema: {
              type: "object",
              properties: {
                stl_path: { type: "string", description: "Path to the STL or 3MF file to slice" },
                ...SLICE_TOOL_PROPERTIES,
                template_name: { type: "string", description: "Named template from the local registry (required)." },
                slicer_profile: {
                  type: "string",
                  description: "Explicit process profile that overrides the named template only when provided in this call."
                },
              },
              required: ["stl_path", "template_name"]
            }
          },
          {
            name: "list_templates",
            description: "List saved slicing templates (.3mf, .json, .config) in the local template registry directory.",
            inputSchema: {
              type: "object",
              properties: {
                template_dir: {
                  type: "string",
                  description: "Template directory override. Defaults to BAMBU_TEMPLATE_DIR or ~/Sync/bambu/templates."
                }
              }
            }
          },
          {
            name: "save_template",
            description: "Copy a .3mf, .json, or .config file into the local template registry under a template name.",
            inputSchema: {
              type: "object",
              properties: {
                source_path: { type: "string", description: "Local .3mf, .json, or .config file to save as a template." },
                template_name: { type: "string", description: "Template name. Defaults to the source filename without extension." },
                template_dir: {
                  type: "string",
                  description: "Template directory override. Defaults to BAMBU_TEMPLATE_DIR or ~/Sync/bambu/templates."
                }
              },
              required: ["source_path"]
            }
          },
          {
            name: "get_slice_settings",
            description: "Inspect slicer settings in a 3MF template or JSON/config profile without slicing (layer height, infill, walls, supports, brim, bed, printer, filaments). For a 3MF given as source_path, own_process is true when slice_stl, given this call's other arguments as it would take them (slicer_type, bambu_model, slicer_profile, template_name, template_3mf_path, layer_height, wall_loops, sparse_infill_density, quality, strength), prints the process the file carries (a designer's Bambu Studio or Orca project) unchanged. A 3MF with no slicer settings reports raw_key_count 0; a file that can't be read is an error.",
            inputSchema: {
              type: "object",
              properties: {
                source_path: { type: "string", description: "Path to a 3MF, extracted project_settings.config, or slicer profile JSON." },
                slicer_type: { type: "string", description: "The slicer_type slice_stl would be given, for own_process. Defaults to SLICER_TYPE." },
                bambu_model: { type: "string", description: "The bambu_model slice_stl would be given, for own_process." },
                slicer_profile: { type: "string", description: "For own_process: the slicer_profile slice_stl would be given." },
                template_3mf_path: { type: "string", description: "For own_process: the template_3mf_path slice_stl would be given." },
                layer_height: { type: "number", description: "For own_process: the layer_height slice_stl would be given." },
                nozzle_diameter: { type: "string", description: "For own_process: the nozzle_diameter slice_stl would be given; layer heights are checked against it." },
                wall_loops: { type: "number", description: "For own_process: the wall_loops slice_stl would be given." },
                sparse_infill_density: { type: "string", description: "For own_process: the sparse_infill_density slice_stl would be given." },
                enable_support: { type: "boolean", description: "For own_process: the enable_support slice_stl would be given." },
                support_type: { type: "string", description: "For own_process: the support_type slice_stl would be given." },
                ...PRINT_QUALITY_PROPERTIES,
                template_name: { type: "string", description: "Named template from the local registry. Without source_path it is the source read; with source_path it is the slice's template, for own_process." },
                template_dir: { type: "string", description: "Template directory override when resolving template_name." }
              }
            }
          },
          {
            name: "confirm_temperatures",
            description: "Report every heater target in a G-code file (S and R forms, tool-addressed, RepRapFirmware G10/M568 and Klipper SET_HEATER_TEMPERATURE). An expected temperature matches only when it equals the file's highest target. Read-only; printing tools enforce their own safety gate.",
            inputSchema: {
              type: "object",
              properties: {
                gcode_path: {
                  type: "string",
                  description: "Path to the G-code file"
                },
                extruder_temp: {
                  type: "number",
                  description: "Expected highest nozzle target"
                },
                bed_temp: {
                  type: "number",
                  description: "Expected highest bed target"
                }
              },
              required: ["gcode_path"]
            }
          },
          {
            name: "process_and_print_stl",
            description: "Process an STL file (extend base), slice it, and start printing through the same checked print gate as upload_gcode/print_3mf. Expected temperatures are enforced: a mismatch refuses before upload.",
            inputSchema: {
              type: "object",
              properties: {
                stl_path: {
                  type: "string",
                  description: "Path to the STL file to process"
                },
                extension_inches: {
                  type: "number",
                  description: "Amount to extend the base in inches"
                },
                extruder_temp: {
                  type: "number",
                  description: "Expected highest nozzle target in the sliced G-code (S and R forms, every tool). Printing stops before upload if it differs."
                },
                bed_temp: {
                  type: "number",
                  description: "Expected highest bed target in the sliced G-code (S and R forms). Printing stops before upload if it differs."
                },
                material: {
                  type: "string",
                  description: "Declared filament material when the sliced G-code has no filament_type metadata. Must not contradict the file."
                },
                host: {
                  type: "string",
                  description: "Hostname or IP address of the printer (default: value from env)"
                },
                port: {
                  type: "string",
                  description: "Port of the printer API (default: value from env)"
                },
                type: {
                  type: "string",
                  description: "Type of printer management system (default: value from env)"
                },
                api_key: {
                  type: "string",
                  description: "API key for authentication (default: value from env)"
                },
                bambu_model: {
                  type: "string",
                  enum: ["p1s", "p1p", "x1c", "x1e", "a1", "a1mini", "h2d"],
                  description: "Bambu Lab printer model. Required for Bambu print operations."
                },
                bed_type: {
                  type: "string",
                  enum: ["textured_plate", "cool_plate", "engineering_plate", "hot_plate"],
                  description: "Bed/plate type installed on the printer (default: textured_plate)."
                },
                nozzle_type: {
                  type: "string",
                  enum: [...VALID_NOZZLE_TYPES],
                  description: "Installed Bambu nozzle material used when slicing (default: BAMBU_NOZZLE_TYPE, else the preset's stock nozzle). The print gate compares it with the printer's report."
                },
                nozzle_diameter: {
                  type: "string",
                  description: "Nozzle diameter in mm (default: 0.4)."
                },
                slicer_type: {
                  type: "string",
                  enum: [...SLICER_TYPE_ENUM],
                  description: "Type of slicer to use. Use orcaslicer-bambulab for FULU OrcaSlicer-bambulab."
                },
                slicer_path: {
                  type: "string",
                  description: "Path to the slicer executable (default: value from env). Per-call overrides require MCP_ALLOW_EXECUTABLE_ARG=1."
                },
                slicer_profile: {
                  type: "string",
                  description: "Profile to use for slicing (default: value from env). OrcaSlicer also accepts machine/process profiles separated with ';', optionally followed by '|filament.json'."
                },
                filament_profile: {
                  type: "string",
                  description: "OrcaSlicer filament profile path loaded with --load-filaments (default: FILAMENT_PROFILE/SLICER_FILAMENT_PROFILE env)."
                }
              },
              required: ["stl_path", "extension_inches"]
            }
          },
          // New STL manipulation tools
          {
            name: "get_stl_info",
            description: "Get detailed information about an STL file",
            inputSchema: {
              type: "object",
              properties: {
                stl_path: {
                  type: "string",
                  description: "Path to the STL file"
                }
              },
              required: ["stl_path"]
            }
          },
          {
            name: "scale_stl",
            description: "Scale an STL model uniformly or along specific axes",
            inputSchema: {
              type: "object",
              properties: {
                stl_path: {
                  type: "string",
                  description: "Path to the STL file"
                },
                scale_factor: {
                  type: "number",
                  description: "Uniform scaling factor to apply"
                },
                scale_x: {
                  type: "number",
                  description: "X-axis scaling factor (overrides scale_factor for X axis)"
                },
                scale_y: {
                  type: "number",
                  description: "Y-axis scaling factor (overrides scale_factor for Y axis)"
                },
                scale_z: {
                  type: "number",
                  description: "Z-axis scaling factor (overrides scale_factor for Z axis)"
                }
              },
              required: ["stl_path"]
            }
          },
          {
            name: "rotate_stl",
            description: "Rotate an STL model around specific axes",
            inputSchema: {
              type: "object",
              properties: {
                stl_path: {
                  type: "string",
                  description: "Path to the STL file"
                },
                rotate_x: {
                  type: "number",
                  description: "Rotation around X-axis in degrees"
                },
                rotate_y: {
                  type: "number",
                  description: "Rotation around Y-axis in degrees"
                },
                rotate_z: {
                  type: "number",
                  description: "Rotation around Z-axis in degrees"
                }
              },
              required: ["stl_path"]
            }
          },
          {
            name: "translate_stl",
            description: "Move an STL model along specific axes",
            inputSchema: {
              type: "object",
              properties: {
                stl_path: {
                  type: "string",
                  description: "Path to the STL file"
                },
                translate_x: {
                  type: "number",
                  description: "Translation along X-axis in millimeters"
                },
                translate_y: {
                  type: "number",
                  description: "Translation along Y-axis in millimeters"
                },
                translate_z: {
                  type: "number",
                  description: "Translation along Z-axis in millimeters"
                }
              },
              required: ["stl_path"]
            }
          },
          {
            name: "modify_stl_section",
            description: "Apply a specific transformation to a selected section of an STL file",
            inputSchema: {
              type: "object",
              properties: {
                stl_path: {
                  type: "string",
                  description: "Path to the STL file"
                },
                section: {
                  type: "string",
                  description: "Section to modify: 'top', 'bottom', 'center', or custom bounds",
                  enum: ["top", "bottom", "center", "custom"]
                },
                transformation_type: {
                  type: "string",
                  description: "Type of transformation to apply",
                  enum: ["scale", "rotate", "translate"]
                },
                value_x: {
                  type: "number",
                  description: "Transformation value for X axis"
                },
                value_y: {
                  type: "number",
                  description: "Transformation value for Y axis"
                },
                value_z: {
                  type: "number",
                  description: "Transformation value for Z axis"
                },
                custom_min_x: {
                  type: "number",
                  description: "Minimum X for custom section bounds"
                },
                custom_min_y: {
                  type: "number",
                  description: "Minimum Y for custom section bounds"
                },
                custom_min_z: {
                  type: "number",
                  description: "Minimum Z for custom section bounds"
                },
                custom_max_x: {
                  type: "number",
                  description: "Maximum X for custom section bounds"
                },
                custom_max_y: {
                  type: "number",
                  description: "Maximum Y for custom section bounds"
                },
                custom_max_z: {
                  type: "number",
                  description: "Maximum Z for custom section bounds"
                }
              },
              required: ["stl_path", "section", "transformation_type"]
            }
          },
          {
            name: "generate_stl_visualization",
            description: "Generate an SVG visualization of an STL file from multiple angles",
            inputSchema: {
              type: "object",
              properties: {
                stl_path: {
                  type: "string",
                  description: "Path to the STL file"
                },
                width: {
                  type: "number",
                  description: "Width of each view in pixels (default: 300)"
                },
                height: {
                  type: "number",
                  description: "Height of each view in pixels (default: 300)"
                }
              },
              required: ["stl_path"]
            }
          },
          {
            name: "inspect_print_file",
            description: "Inspect an exact private snapshot of a prepared sliced 3MF or textual G-code file and selected plate without contacting a printer. Returns versioned file-only evidence; no printer readiness or permission to dispatch is established. Does not auto-slice.",
            inputSchema: {
              type: "object",
              additionalProperties: false,
              properties: {
                file_path: { type: "string", minLength: 1, description: "Local prepared .3mf or textual .gcode artifact to inspect; checksum-only and unsliced projects reject." },
                bambu_model: { type: "string", enum: [...VALID_BAMBU_MODELS], description: "Explicit file-inspection target model; never inferred from environment or live state." },
                plate_index: { type: "integer", minimum: 0, description: "Zero-based selected plate; defaults to 0. Raw G-code only supports 0." },
                nozzle_diameters: { type: "array", minItems: 1, maxItems: 2, items: { type: "number", enum: [0.2, 0.4, 0.6, 0.8] }, description: "Optional requested nozzle diameters to compare with file declarations; this does not observe installed hardware." },
                bed_type: { type: "string", enum: [...VALID_BED_TYPES], description: "Optional declared bed type to compare with file metadata." },
                include_preview: { type: "boolean", description: "Also return preview: PNG pictures drawn from this exact file's G-code (every extruding line in its filament's colour; the top as it sits on the bed, and the bed side turned over), with the artifact's sha256. Large (tens of KB of base64); for apps that show the person what will print, not for agents." },
              },
              required: ["file_path", "bambu_model"],
            },
          },
          {
            name: "print_3mf",
            description: "Print a 3MF file on a Bambu Lab printer. The exact selected plate is inspected (model, nozzle, bed type, materials, every heater target) and checked against a fresh MQTT report of the printer's identity, nozzle, state, errors and loaded filament before upload and start.",
            inputSchema: {
              type: "object",
              properties: {
                pause_at_layers: { type: "array", items: { type: "integer", minimum: 2 }, description: "Pause before these 1-based layers when auto-slicing. An already sliced 3MF must contain the requested pauses or printing is refused." },
                three_mf_path: {
                  type: "string",
                  description: "Path to the 3MF file to print."
                },
                plate_index: { type: "integer", minimum: 0, description: "Zero-based selected plate; defaults to 0. The same plate is inspected and printed; auto-slicing uses its one-based CLI plate number." },
                bambu_model: {
                  type: "string",
                  enum: ["p1s", "p1p", "x1c", "x1e", "a1", "a1mini", "h2d"],
                  description: "REQUIRED: Bambu Lab printer model. Ensures correct G-code generation — wrong model can crash the bed into the nozzle."
                },
                bed_type: {
                  type: "string",
                  enum: ["textured_plate", "cool_plate", "engineering_plate", "hot_plate"],
                  description: "Bed/plate type installed on the printer (default: textured_plate)."
                },
                nozzle_type: {
                  type: "string",
                  enum: [...VALID_NOZZLE_TYPES],
                  description: "Installed nozzle material, used when the 3MF must be auto-sliced (default: BAMBU_NOZZLE_TYPE, else the preset's stock nozzle)."
                },
                nozzle_diameter: {
                  type: "string",
                  description: "Nozzle diameter in mm (default: 0.4)."
                },
                host: {
                  type: "string",
                  description: "Hostname or IP address of the Bambu printer (default: value from env)"
                },
                bambu_serial: {
                  type: "string",
                  description: "Serial number for the Bambu Lab printer (default: value from env)"
                },
                bambu_token: {
                  type: "string",
                  description: "Access token for the Bambu Lab printer (default: value from env)"
                },
                layer_height: { type: "number", description: "Override layer height (mm)." },
                nozzle_temperature: { type: "number", description: "Override nozzle temperature (°C)." },
                bed_temperature: { type: "number", description: "Override bed temperature (°C)." },
                support_enabled: { type: "boolean", description: "Override support generation." },
                ...CONNECTION_PROPERTIES,
                ams_mapping: {
                  anyOf: [
                    { type: "array", items: { type: "number" } },
                    { type: "object", additionalProperties: { type: "number" } },
                  ],
                  description: "Project-level AMS mapping. Array: position = project filament index, value = absolute AMS tray (0-3 = AMS 0, 4-7 = AMS 1, 8-11 = AMS 2, 12-15 = AMS 3, 128+ = AMS-HT, 254 = external spool, -1 = unused); on dual-nozzle printers (H2D, H2D Pro, H2C, X2D) 254 is the left/deputy nozzle external spool and 255 the right/main one. Object: trays keyed by project filament index (numeric keys first, in order), e.g. {\"0\": 2}. Prefer ams_slots unless you know the project-level layout.",
                },
                ams_slots: {
                  type: "array",
                  items: { type: "number" },
                  description: "Preferred AMS input: one absolute tray per USED filament in plate order, e.g. [1] for a single-filament print from AMS 0 slot 1. Use 254 for the external spool (on dual-nozzle printers 254 = left/deputy, 255 = right/main). Expanded to the project-level ams_mapping from the 3MF's plate_N.json and G-code header. Overrides ams_mapping.",
                },
                slicer_type: {
                  type: "string",
                  enum: [...SLICER_TYPE_ENUM],
                  description: "Slicer to use if the 3MF needs auto-slicing. Use orcaslicer-bambulab for FULU OrcaSlicer-bambulab."
                },
                slicer_path: {
                  type: "string",
                  description: "Path to the slicer executable if auto-slicing is needed. Per-call overrides require MCP_ALLOW_EXECUTABLE_ARG=1."
                },
                slicer_profile: {
                  type: "string",
                  description: "Optional slicer settings/profile path for auto-slicing."
                },
                filament_profile: {
                  type: "string",
                  description: "Optional filament profile path for auto-slicing with OrcaSlicer/Bambu Studio."
                },
                use_ams: {
                  type: "boolean",
                  description: "Whether to use the AMS. Defaults to true when ams_slots, ams_mapping or the 3MF's own mapping is present; false prints every used filament from the external spool."
                },
                bed_leveling: {
                  type: "boolean",
                  description: "Override bed leveling flag for the Bambu print command."
                },
                flow_calibration: {
                  type: "boolean",
                  description: "Override flow calibration flag for the Bambu print command."
                },
                vibration_calibration: {
                  type: "boolean",
                  description: "Override vibration calibration flag for the Bambu print command."
                },
                layer_inspect: {
                  type: "boolean",
                  description: "Override layer inspection flag for the Bambu print command."
                },
                timelapse: {
                  type: "boolean",
                  description: "Override timelapse flag for the Bambu print command."
                }
              },
              required: ["three_mf_path", "bambu_model"]
            }
          },
          {
            name: "check_fulu_orca_setup",
            description:
              "Inspect a FULU OrcaSlicer-bambulab install, platform runtime payload, setup commands, and optionally probe the BambuNetwork bridge.",
            inputSchema: {
              type: "object",
              properties: {
                slicer_path: {
                  type: "string",
                  description:
                    "Path to the FULU OrcaSlicer executable. Defaults from SLICER_PATH/FULU_ORCA_PATH. " +
                    "When run_bridge_probe=true, requires MCP_ALLOW_EXECUTABLE_ARG=1 to be accepted here."
                },
                plugin_dir: {
                  type: "string",
                  description:
                    "Directory containing the FULU Bambu runtime payload; on macOS this is usually " +
                    "OrcaSlicer.app/Contents/MacOS. When run_bridge_probe=true, requires " +
                    "MCP_ALLOW_EXECUTABLE_ARG=1 to be accepted here."
                },
                runtime_dir: {
                  type: "string",
                  description:
                    "Installed runtime directory. On macOS this defaults to ~/Library/Application " +
                    "Support/OrcaSlicer/macos-bridge/runtime. When run_bridge_probe=true, requires " +
                    "MCP_ALLOW_EXECUTABLE_ARG=1 to be accepted here."
                },
                platform: {
                  type: "string",
                  enum: ["darwin", "macos", "win32", "windows", "linux"],
                  description: "Platform to inspect. Defaults to the current Node.js platform."
                },
                bridge_command: {
                  type: "string",
                  description:
                    "Command that starts the FULU BambuNetwork bridge host for probing. Read from " +
                    "FULU_BAMBU_BRIDGE_COMMAND by default; requires MCP_ALLOW_EXECUTABLE_ARG=1 " +
                    "to be accepted here."
                },
                run_bridge_probe: {
                  type: "boolean",
                  description: "When true, sends bridge.handshake, bridge.capabilities, and bridge.runtime_info to the bridge host."
                },
                probe_timeout_ms: {
                  type: "number",
                  description: "Bridge probe timeout in milliseconds (default: 5000)."
                }
              }
            }
          },
          {
            name: "fulu_bambu_network_rpc",
            description:
              "Advanced FULU bridge RPC for BambuNetwork diagnostics and development. Read-only methods are allowed by default. Agent/session setup methods require allow_mutating_method=true. Raw print methods, printer messages, file transfers and unknown methods are refused because they would bypass the print safety gate; use print_3mf for checked printing.",
            inputSchema: {
              type: "object",
              properties: {
                bridge_command: {
                  type: "string",
                  description:
                    "Command that starts the FULU BambuNetwork bridge host. Defaults to " +
                    "FULU_BAMBU_BRIDGE_COMMAND; requires MCP_ALLOW_EXECUTABLE_ARG=1 to be " +
                    "accepted here."
                },
                method: {
                  type: "string",
                  description: "FULU bridge method, e.g. bridge.handshake, bridge.runtime_info, net.get_user_print_info, net.start_print."
                },
                payload: {
                  type: "object",
                  description: "JSON payload sent to the FULU bridge method.",
                  additionalProperties: true
                },
                timeout_ms: {
                  type: "number",
                  description: "Bridge request timeout in milliseconds (default: 5000)."
                },
                allow_mutating_method: {
                  type: "boolean",
                  description: "Required for the allowlisted agent/session setup methods. It never enables print, printer-message, or unknown methods."
                },
                bambu_model: {
                  type: "string",
                  enum: ["p1s", "p1p", "x1c", "x1e", "a1", "a1mini", "h2d"],
                  description: "Informational only. Raw FULU print RPC methods are disabled; use print_3mf."
                }
              },
              required: ["method"]
            }
          },
          {
            name: "merge_vertices",
            description: "Merge vertices in an STL file that are closer than the specified tolerance.",
            inputSchema: {
              type: "object",
              properties: {
                stl_path: {
                  type: "string",
                  description: "Path to the STL file to modify."
                },
                tolerance: {
                  type: "number",
                  description: "Maximum distance between vertices to merge (in mm, default: 0.01)."
                }
              },
              required: ["stl_path"]
            }
          },
          {
            name: "center_model",
            description: "Translate the model so its geometric center is at the origin (0,0,0).",
            inputSchema: {
              type: "object",
              properties: {
                stl_path: {
                  type: "string",
                  description: "Path to the STL file to center."
                }
              },
              required: ["stl_path"]
            }
          },
          {
            name: "lay_flat",
            description: "Rotate the model so a face rests on the bed (Z=0), choosing the orientation with the least part and support volume per mm² of bed contact. A face counts only if nothing hangs below it. Returns the new STL path; structuredContent.laid_flat is false, with the input path, when no orientation qualifies.",
            inputSchema: {
              type: "object",
              properties: {
                stl_path: {
                  type: "string",
                  description: "Path to the STL file to lay flat."
                }
              },
              required: ["stl_path"]
            }
          },
          {
            name: "blender_mcp_status",
            description: "Inspect Blender MCP configuration or connect and discover the remote server's tools. Lists tool names and summaries; pass tool_names for the full input schemas of the tools you will call. Connecting does not edit the scene; use get_scene_info through blender_mcp_call to check the Blender addon.",
            inputSchema: {
              type: "object",
              properties: {
                connect: { type: "boolean", description: "Initialize the configured stdio MCP server and discover its tools (default false)." },
                tool_names: { type: "array", items: { type: "string" }, maxItems: 64, description: "Return full input schemas for these discovered tools, such as [\"execute_blender_code\"]." },
                include_schemas: { type: "boolean", description: "Return every discovered tool's full definition (large; default false)." },
                timeout_ms: { type: "integer", minimum: 100, maximum: 300000, description: "Total connection and discovery deadline in milliseconds; defaults to BLENDER_MCP_TIMEOUT_MS or 120000." }
              },
              additionalProperties: false
            }
          },
          {
            name: "blender_mcp_call",
            description: "Call a discovered tool on the configured Blender MCP server, preserving its full MCP content and errors. Discover tool schemas with blender_mcp_status first; execute_blender_code accepts Python code and user_prompt. Calls can modify the active Blender scene and are never automatically retried.",
            inputSchema: {
              type: "object",
              properties: {
                tool_name: { type: "string", description: "Exact name advertised by Blender MCP, such as get_scene_info or execute_blender_code." },
                arguments: { type: "object", description: "Arguments matching the remote tool's discovered input schema. Preserve the user's own words in user_prompt when the remote tool requests it." },
                timeout_ms: { type: "integer", minimum: 100, maximum: 300000, description: "Total connection, discovery, and tool deadline in milliseconds; defaults to BLENDER_MCP_TIMEOUT_MS or 120000." }
              },
              required: ["tool_name"],
              additionalProperties: false
            }
          },
          {
            name: "blender_mcp_export_stl",
            description: "Export named objects from the live Blender scene to a new, verified STL for slicing. Writes world-space geometry with modifiers applied, without changing the scene, selection, or mode, and reports triangle count and bounding-box dimensions from the written file. Use this after editing or modelling through blender_mcp_call; Blender MCP's own export_scene writes GLB/FBX only. Requires standard Blender MCP and a shared local filesystem.",
            inputSchema: {
              type: "object",
              properties: {
                object_names: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 64, description: "Blender object names to export together as one STL (mesh, curve, surface, metaball, or text objects)." },
                output_path: { type: "string", description: "New local .stl path. Its parent must exist; existing files are never overwritten." },
                apply_modifiers: { type: "boolean", description: "Export the evaluated geometry with modifiers applied (default true)." },
                scale: { type: "number", exclusiveMinimum: 0, description: "Multiply coordinates before writing (default 1). Slicers read STL units as millimetres, so use 1000 for a scene modelled in metres." },
                user_prompt: { type: "string", description: "The user's own words, passed unchanged to Blender MCP." },
                timeout_ms: { type: "integer", minimum: 100, maximum: 300000, description: "Total Blender request deadline in milliseconds; defaults to BLENDER_MCP_TIMEOUT_MS or 120000." }
              },
              required: ["object_names", "output_path"],
              additionalProperties: false
            }
          },
          {
            name: "blender_mcp_edit_model",
            description: "Import, edit, and export a local STL through standard Blender MCP with verified output and existing scene objects preserved. Requires a shared local filesystem and Blender Object Mode. Also supports a separately configured legacy executable bridge.",
            inputSchema: {
              type: "object",
              properties: {
                stl_path: { type: "string", description: "Path to the local STL file" },
                operations: {
                  type: "array",
                  description: "Ordered operations: decimate:<ratio greater than 0 and at most 1>, remesh:<positive voxel size in STL units>, boolean_union:<STL path>. Legacy custom bridges define their own operations.",
                  minItems: 1,
                  maxItems: 64,
                  items: { type: "string" }
                },
                output_path: { type: "string", description: "New local STL output path for standard MCP editing; defaults to a unique model-edited-<id>.stl beside the input. Its parent must exist and existing files are never overwritten. Reuse the preview's output_path when executing that plan." },
                user_prompt: { type: "string", description: "The user's own words describing the edit, passed unchanged to Blender MCP." },
                timeout_ms: { type: "integer", minimum: 100, maximum: 300000, description: "Total Blender request deadline in milliseconds; defaults to BLENDER_MCP_TIMEOUT_MS or 120000." },
                bridge_command: { type: "string", description: "Legacy custom bridge executable override, not a standard MCP command. Per-call overrides require MCP_ALLOW_EXECUTABLE_ARG=1." },
                execute: { type: "boolean", description: "Apply edits and export (true) or validate and return the prepared request without connecting (false, default)." }
              },
              required: ["stl_path", "operations"],
              additionalProperties: false
            }
          },
          {
            name: "blender_mcp_setup",
            description: "Check or update the MCP for Blender add-on that the configured Blender bridge (BLENDER_MCP_COMMAND uvx, BLENDER_MCP_ARGS naming mcp-for-blender or blender-mcp) needs. Without update: which add-on file Blender loads, its protocol and the protocol the package expects, whether Blender is listening and the running add-on's own handshake. Changes nothing. With update: true, stages the add-on with the package's own installer (mcp-for-blender install-addon) at the inspected version, checks it, keeps the old file as a backup next to it and renames the new one into place. Never starts, stops or edits Blender; a running Blender uses the new add-on once it is re-enabled or restarted. A custom bridge returns supported false.",
            inputSchema: {
              type: "object",
              properties: { update: { type: "boolean", description: "Replace the installed add-on with the package's own (default false: check only)." } },
              additionalProperties: false
            },
            outputSchema: BLENDER_SETUP_OUTPUT_SCHEMA,
          },
          {
            name: "fusion_mcp_setup",
            description: `Check or install what the Fusion bridge needs on macOS: Autodesk Fusion itself (found, never installed), the Fusion360MCP add-in from ${FUSION_ADDIN_REPOSITORY} at ${FUSION_MCP_PINNED_COMMIT} (every file checked against its pinned SHA-256) set to run on startup, a login item that sets FUSION_MCP_PORT for Fusion however it is opened, and this server's FUSION_MCP_* settings. Without install: reports them and changes nothing. With install: true, installs what is missing and adds the missing settings to this server's own .env (after a copy of it), never rewriting one it already has. Never starts or quits Fusion; check the connection with fusion_mcp_status.`,
            inputSchema: {
              type: "object",
              properties: { install: { type: "boolean", description: "Install what is missing (default false: check only)." } },
              additionalProperties: false
            },
            outputSchema: FUSION_SETUP_OUTPUT_SCHEMA,
          },
          {
            name: "fusion_mcp_status",
            description: `Check the Autodesk Fusion bridge: whether the Fusion MCP server is configured (by default ${FUSION_ADDIN_REPOSITORY}@${FUSION_MCP_PINNED_COMMIT}, faust-machines' server with document binding; fusion_mcp_setup installs it), whether Fusion is running, whether its Fusion360MCP add-in answers on its port, and the server's tools and schemas. connected is true only when the add-in answered. With launch: true and Fusion not running on this Mac, opens Autodesk Fusion and waits up to 90 s for the add-in.`,
            inputSchema: {
              type: "object",
              properties: {
                launch: { type: "boolean", description: "Open Autodesk Fusion when it is not running (macOS), then wait up to 90 s for the add-in (default false)." },
                timeout_ms: { type: "integer", minimum: 100, maximum: 600000, description: "Deadline in milliseconds; defaults to FUSION_MCP_TIMEOUT_MS or 180000. The first start downloads the pinned server with uvx." }
              },
              additionalProperties: false
            },
            outputSchema: FUSION_STATUS_OUTPUT_SCHEMA,
          },
          {
            name: "fusion_mcp_call",
            description: "Call a discovered tool on the Fusion MCP server (create_sketch, extrude, fillet, set_parameter, export_stl, execute_code, and others), preserving its full MCP content and errors. Discover tool schemas with fusion_mcp_status first. Calls change the active Fusion design and are never automatically retried. Most tools need an active design: call fusion_mcp_new_design first.",
            inputSchema: {
              type: "object",
              properties: {
                tool_name: { type: "string", description: "Exact name advertised by the Fusion MCP server." },
                arguments: { type: "object", description: "Arguments matching the remote tool's discovered input schema. Fusion lengths are in centimetres unless a tool says otherwise." },
                timeout_ms: { type: "integer", minimum: 100, maximum: 600000, description: "Deadline in milliseconds; defaults to FUSION_MCP_TIMEOUT_MS or 180000." }
              },
              required: ["tool_name"],
              additionalProperties: false
            },
            outputSchema: FUSION_CALL_OUTPUT_SCHEMA,
          },
          {
            name: "fusion_mcp_new_design",
            description: "Open a new parametric design document in Fusion, so the Fusion tools have an active design. Fusion must already have some document open: at the pinned faust-machines commit no tool works from Fusion's home screen (issue #12).",
            inputSchema: {
              type: "object",
              properties: {
                timeout_ms: { type: "integer", minimum: 100, maximum: 600000, description: "Deadline in milliseconds; defaults to FUSION_MCP_TIMEOUT_MS or 180000." }
              },
              additionalProperties: false
            },
            outputSchema: FUSION_NEW_DESIGN_OUTPUT_SCHEMA,
          },
          {
            name: "fusion_mcp_export",
            description: "Export the active Fusion design into output_dir as <name>.stl (export_stl), <name>.f3d (export_f3d) and <name>.parameters.json (the design's user parameters), and return their absolute paths. The STL is checked as a finite triangle mesh and its size compared with the Fusion body to report its units. Existing files are never overwritten. Fusion and this server must share the computer's file system.",
            inputSchema: {
              type: "object",
              properties: {
                output_dir: { type: "string", description: "Existing absolute directory for the three files." },
                name: { type: "string", description: "Base file name without a path or extension, such as \"bracket\"." },
                body_name: { type: "string", description: "Body to export as the STL. Optional when the design has exactly one visible solid body." },
                timeout_ms: { type: "integer", minimum: 100, maximum: 600000, description: "Deadline in milliseconds; defaults to FUSION_MCP_TIMEOUT_MS or 180000." }
              },
              required: ["output_dir", "name"],
              additionalProperties: false
            },
            outputSchema: FUSION_EXPORT_OUTPUT_SCHEMA,
          }
        ]).map(withRemote)
      };
    });

    // Handle tool calls
    // A designer's settings extracted for this call are removed when it settles.
    this.server.setRequestHandler(CallToolRequestSchema, (request, extra) => withExtractedSettingsCleanup(async () => {
      const { name, arguments: args } = request.params;
      
      // Set default values for common parameters
      const host = String(args?.host || DEFAULT_HOST);
      const port = String(args?.port || DEFAULT_PORT);
      const type = String(args?.type || DEFAULT_TYPE);
      const apiKey = String(args?.api_key || DEFAULT_API_KEY);
      const bambuSerial = String(args?.bambu_serial || DEFAULT_BAMBU_SERIAL);
      const bambuToken = String(args?.bambu_token || DEFAULT_BAMBU_TOKEN);
      const slicerType = normalizeSlicerType(String(args?.slicer_type || DEFAULT_SLICER_TYPE));
      const slicerProfile = String(args?.slicer_profile || DEFAULT_SLICER_PROFILE);
      const filamentProfile = String(args?.filament_profile || DEFAULT_FILAMENT_PROFILE);

      try {
        let result;

        const target: PrinterTarget = {
          type, host, port,
          apiKey: type.toLowerCase() === "bambu" ? `${bambuSerial}:${bambuToken}` : apiKey,
        };
        // Bambu print controls go over the same connection as the print (resolveConnection);
        // undefined keeps direct LAN MQTT in BambuImplementation.
        const bambuControlRoute: BambuControlRoute = (command) => {
          if (type.toLowerCase() !== "bambu") return undefined;
          const route = resolveConnection(args);
          assertConnectionAvailable(route.mode);
          if (route.mode !== "bambu_network") return undefined;
          return (assertActive?: () => void, beforeDispatch?: () => Promise<void>) => {
            const options = { assertDispatchAllowed: () => { extra.signal.throwIfAborted(); assertActive?.(); } };
            return route.type === "cloud"
              ? this.bambuNetwork.sendCloudPrintCommand(bambuSerial, command, options, beforeDispatch)
              : this.bambuNetwork.sendLocalPrintCommand({ devId: bambuSerial, devIp: host, username: "bblp", password: bambuToken, useSsl: true }, command, options, beforeDispatch);
          };
        };
        const structured = (value: object) => ({
          content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
          structuredContent: value as Record<string, unknown>,
        });

        switch (name) {
          case "camera_stream_start":
            return structured(await this.counterpart.cameraStreamStart(target, {fps: args?.fps as number | undefined, idleTimeoutMs: args?.idle_timeout_ms as number | undefined}));
          case "camera_frame": {
            const frame = await this.counterpart.cameraStreamFrame(target, {
              sinceSeq: args?.since_seq as number | undefined, waitMs: args?.wait_ms as number | undefined,
              maxWidth: args?.max_width as number | undefined, maxBytes: args?.max_bytes as number | undefined,
              changedOnly: args?.changed_only as boolean | undefined, minChange: args?.min_change as number | undefined, signal: extra.signal,
            });
            // The JPEG appears only once in the MCP payload; text is useful metadata.
            return {content: [{type: "text" as const, text: JSON.stringify(Object.fromEntries(Object.entries(frame).filter(([key]) => key !== "base64")))}], structuredContent: frame};
          }
          case "camera_stream_stop":
            return structured(this.counterpart.cameraStreamStop(target));
          case "counterpart_printer_info":
            return structured(await this.counterpart.printerInfo(target));

          case "counterpart_print_progress":
            return structured(await this.counterpart.printProgress(target));

          case "camera_snapshot": {
            if (args?.save_path !== undefined && typeof args.save_path !== "string") throw new Error("Invalid save_path: expected a string.");
            if (args?.timeout_ms !== undefined && typeof args.timeout_ms !== "number") throw new Error("Invalid timeout_ms: expected a number.");
            return structured(await this.counterpart.cameraSnapshot(target, {
              savePath: args?.save_path as string | undefined,
              timeoutMs: args?.timeout_ms as number | undefined,
            }));
          }

          case "counterpart_discover_printers": {
            const requested = Number(args?.duration_ms);
            const found = await discoverPrinters(Number.isFinite(requested) ? requested : 4000);
            // Only models bambu_model accepts here; others stay unset.
            return structured({ ...found, printers: found.printers.map(({ model, ...printer }) =>
              ({ ...printer, ...(model && (VALID_BAMBU_MODELS as readonly string[]).includes(model) ? { model } : {}) })) });
          }

          case "counterpart_setup_fields":
            return structured(genericSetupFields({ server: { name: SERVER_NAME, version: SERVER_VERSION }, models: VALID_BAMBU_MODELS, slicer: slicerSetupNow(),
              ...(typeof args?.serial === "string" ? { serial: args.serial } : {}) }));

          case "counterpart_propose_filaments": {
            const bambu = type.toLowerCase() === "bambu";
            const inventory = await this.counterpart.filaments(target, bambu ? {
              bambuModel: optionalBambuModelHint(args?.bambu_model),
              nozzleDiameter: String(args?.nozzle_diameter || DEFAULT_NOZZLE_DIAMETER),
            } : {});
            const trays: ProposalTray[] = inventory.slots.flatMap(slot => {
              const number = slot.id === "ext" ? 254 : Number(slot.id);
              if (!Number.isSafeInteger(number) || !slot.color || !slot.material) return [];
              return [{ slot: number, label: slot.label ?? slot.id, name: slot.name ?? slot.material, colour: slot.color, material: slot.material,
                filamentId: slot.filamentId ?? "", feed: number >= 254 ? "external" : "ams", sliceable: Boolean(slot.profile),
                ...(slot.profile ? { profile: slot.profile } : {}) }];
            });
            const proposal = proposeFilaments({ trays, filaments: Array.isArray(args?.filaments) ? args.filaments : [],
              ...(Array.isArray(args?.painted) ? { painted: args.painted } : {}), ...(Array.isArray(args?.chosen) ? { chosen: args.chosen } : {}),
              sliced: args?.sliced === true, // Colour words ("White") come from Bambu Studio's colour table whatever the printer.
              names: bambuColourNames({ slicerType: DEFAULT_SLICER_TYPE, slicerPath: DEFAULT_SLICER_PATH || undefined }) });
            // A sliced file binds each filament to a nozzle, and each of a dual-nozzle printer's two external spools
            // feeds one nozzle. This proposal can't read that binding, so it never offers such a mapping as printable.
            const dualExternal = trays.some(tray => tray.slot === 254) && trays.some(tray => tray.slot === 255);
            if (args?.sliced === true && dualExternal && proposal.mapping?.some(entry => entry.slot >= 254)) {
              delete proposal.mapping;
              proposal.problems.push({ code: "external-nozzle-unverified", message: "This file was sliced for particular nozzles, and the right external spool for each colour can't be checked here. Print these colours from the AMS, or choose the external spools in Bambu Studio." });
            }
            return structured(proposal);
          }

          case "get_printer_filaments": {
            const filamentOptions = type.toLowerCase() === "bambu" ? {
              bambuModel: optionalBambuModelHint(args?.bambu_model),
              nozzleDiameter: String(args?.nozzle_diameter || DEFAULT_NOZZLE_DIAMETER),
            } : {};
            return structured(await this.counterpart.filaments(target, filamentOptions));
          }

          case "pause_print":
            return structured(await this.counterpart.pause(target, bambuControlRoute));

          case "resume_print":
            return structured(await this.counterpart.resume(target, bambuControlRoute));

          case "counterpart_print_route": {
            let savedTo: string | null = null;
            // FULU's bridge is set up (configured or discovered), so the routes through it can be used.
            const bridgeConfigured = Boolean(this.bambuNetwork.resolveBridgeCommand());
            if (args?.route !== undefined) {
              if (!PRINT_ROUTES.includes(args.route as PrintRoute)) throw new Error('route must be "lan", "cloud" or "developer".');
              const next = connectionForRoute(args.route as PrintRoute, { mode: DEFAULT_BAMBU_CONNECTION_MODE, type: DEFAULT_BAMBU_CONNECTION_TYPE }, bridgeConfigured);
              // dotenv loaded .env from the working directory at start; a client's own env block has no file to update.
              const file = path.resolve(process.cwd(), ".env");
              if (fs.existsSync(file)) {
                writeEnvValues(file, {
                  ...(next.mode ? { BAMBU_DEFAULT_CONNECTION_MODE: next.mode } : {}),
                  ...(next.type ? { BAMBU_DEFAULT_CONNECTION_TYPE: next.type } : {}),
                });
                savedTo = file;
              }
              DEFAULT_BAMBU_CONNECTION_MODE = next.mode;
              DEFAULT_BAMBU_CONNECTION_TYPE = next.type;
            }
            const connection = resolveConnection({});
            const options = routeOptions(connection, bridgeConfigured);
            result = { route: routeOf(connection), mode: connection.mode, type: connection.type,
              choices: options.filter(option => option.available).map(option => option.id), options, savedTo };
            break;
          }

          case "inspect_print_file": {
            const allowed = new Set(["file_path", "bambu_model", "plate_index", "nozzle_diameters", "bed_type", "include_preview"]);
            if (!args || Object.keys(args).some(key => !allowed.has(key))) throw new Error("inspect_print_file accepts only file/model/plate/nozzle/bed/preview arguments.");
            if (args.include_preview !== undefined && typeof args.include_preview !== "boolean") throw new Error("include_preview must be true or false.");
            if (typeof args.file_path !== "string" || !args.file_path.trim() || args.file_path.includes("\0")) throw new Error("file_path must name a local prepared artifact.");
            if (typeof args.bambu_model !== "string" || !args.bambu_model.trim()) throw new Error("An explicit bambu_model is required for file inspection.");
            const model = validateBambuModel(args.bambu_model);
            const plateIndex = args.plate_index === undefined ? 0 : args.plate_index;
            if (typeof plateIndex !== "number" || !Number.isSafeInteger(plateIndex) || plateIndex < 0) throw new Error("plate_index must be a nonnegative safe integer.");
            if (args.nozzle_diameters !== undefined && (!Array.isArray(args.nozzle_diameters) || args.nozzle_diameters.some(value => typeof value !== "number"))) throw new Error("nozzle_diameters must be numeric sizes.");
            const nozzles = args.nozzle_diameters as number[] | undefined;
            if (nozzles && (nozzles.length < 1 || nozzles.length > 2 || nozzles.some(value => !SUPPORTED_NOZZLE_DIAMETERS.includes(value)))) throw new Error("nozzle_diameters must contain one or two supported sizes.");
            if (args.bed_type !== undefined && (typeof args.bed_type !== "string" || !args.bed_type.trim())) throw new Error("bed_type must be a supported plate type.");
            const bedType = args.bed_type === undefined ? undefined : resolveBedType(args.bed_type);
            if (extra.signal.aborted) throw new Error("File inspection cancelled.");
            result = await withPrintSnapshot(args.file_path, async snapshot => {
              const inspection = await inspectPrintFile(snapshot, { model, nozzleDiameters: nozzles, plateIndex, bedType });
              if (extra.signal.aborted) throw new Error("File inspection cancelled.");
              const byteLength = (await fs.promises.stat(snapshot)).size;
              // The picture is drawn from these same snapshot bytes, so it is of exactly the file inspected.
              const preview = args.include_preview === true ? await previewOfSnapshot(snapshot, plateIndex, inspection.sha256) : undefined;
              return {
                receipt_version: "1",
                evidence: "file-only",
                dispatch_authorized: false,
                artifact: { sha256: inspection.sha256, byte_length: byteLength, file_format: path.extname(snapshot).toLowerCase() === ".3mf" ? "3mf" : "gcode" },
                selection: { bambu_model: model, plate_index: plateIndex, ...(nozzles === undefined ? {} : { nozzle_diameters: nozzles }), ...(bedType === undefined ? {} : { bed_type: bedType }) },
                inspection,
                // The plate's estimate and slice settings, and the file's plate count, read here so clients don't parse slicer files.
                sliced: await slicedFileFacts(snapshot, plateIndex),
                ...(preview ? { preview } : {}),
              };
            });
            break;
          }
          case "get_printer_status":
            result = await this.getPrinterStatus(host, port, type, apiKey, bambuSerial, bambuToken);
            break;
            
          case "list_printer_files":
            result = await this.getPrinterFiles(host, port, type, apiKey, bambuSerial, bambuToken);
            break;
            
          case "upload_gcode":
            if (!args?.gcode && !args?.gcode_path) {
              throw new Error("Missing required parameter: gcode or gcode_path");
            }
            if (args?.gcode_path && !fs.existsSync(String(args.gcode_path))) {
              throw new Error(`G-code file not found: ${String(args.gcode_path)}`);
            }
            if (!args?.filename && !args?.gcode_path) {
              throw new Error("Missing required parameter: filename");
            }
            if (args.print !== undefined && typeof args.print !== "boolean") {
              throw new Error("print must be a boolean.");
            }
            const uploadOptions: PrintSafetyOptions = { material: optionalMaterialArg(args?.material) };
            if (type.toLowerCase() === "bambu" && args.print === true) {
              uploadOptions.bambuModel = await this.resolveBambuModel(args?.bambu_model as string | undefined);
            }
            const uploadFilename = String(args?.filename || path.basename(String(args.gcode_path)));
            const uploadGcodeSource = String(args?.gcode_path || args.gcode);
            result = withJobName(await this.uploadGcode(
              host, port, type, apiKey, bambuSerial, bambuToken,
              uploadFilename,
              uploadGcodeSource,
              Boolean(args.print || false),
              uploadOptions
            ), uploadFilename);
            break;
            
          case "start_print":
            if (!args?.filename) {
              throw new Error("Missing required parameter: filename");
            }
            const startOptions: PrintSafetyOptions = { material: optionalMaterialArg(args?.material) };
            if (type.toLowerCase() === "bambu") {
              startOptions.bambuModel = await this.resolveBambuModel(args?.bambu_model as string | undefined);
            }
            result = withJobName(
              await this.startPrint(host, port, type, apiKey, bambuSerial, bambuToken, String(args.filename), startOptions),
              String(args.filename)
            );
            break;
            
          case "cancel_print":
            result = await this.cancelPrint(host, port, type, apiKey, bambuSerial, bambuToken, bambuControlRoute("stop"));
            break;
            
          case "set_printer_temperature":
            if (!args?.component || args?.temperature === undefined) {
              throw new Error("Missing required parameters: component and temperature");
            }
            // Never coerce: "not-a-number" must not become NaN in a heater command.
            const requestedTemperature = optionalTemperatureArg(args.temperature, "temperature")!;
            const heatOptions: PrintSafetyOptions = { material: optionalMaterialArg(args.material) };
            if (type.toLowerCase() === "bambu" && requestedTemperature > 0) {
              heatOptions.bambuModel = await this.resolveBambuModel(args?.bambu_model as string | undefined);
              heatOptions.nozzleDiameter =
                optionalNozzleDiameterArg(args.nozzle_diameter) ?? Number(DEFAULT_NOZZLE_DIAMETER);
            }
            result = await this.setPrinterTemperature(
              host, port, type, apiKey, bambuSerial, bambuToken,
              String(args.component),
              requestedTemperature,
              heatOptions
            );
            break;
            
          // New STL manipulation tools
          case "extend_stl_base":
            if (!args?.stl_path || args?.extension_inches === undefined) {
              throw new Error("Missing required parameters: stl_path and extension_inches");
            }
            result = await this.stlManipulator.extendBase(
              String(args.stl_path),
              Number(args.extension_inches)
            );
            break;
            
          case "slice_stl": {
            const sliced = await this.runSliceTool("slice_stl", args as Record<string, unknown> | undefined);
            const split = sliced.bed_split;
            if (split && !split.fits && !("three_mf_path" in split)) {
              return { content: [{ type: "text", text: split.message }], isError: true,
                structuredContent: { slicer_report: { failed: true, message: split.message }, bed_split: split } };
            }
            // The text stays the sliced file's path; slicer_result is the slicer's own result.json, verbatim, and
            // slicer_report its verdict and words, so clients don't read the slicer's format.
            return { content: [{ type: "text", text: sliced.path }], structuredContent: withSlicerReport(sliced) };
          }

          case "slice_with_template":
            if (!args?.template_name || !String(args.template_name).trim()) {
              throw new Error("Missing required parameter: template_name");
            }
            result = (await this.runSliceTool("slice_with_template", args as Record<string, unknown> | undefined)).path;
            break;

          case "list_templates":
            result = listTemplateRegistry(typeof args?.template_dir === "string" ? args.template_dir : undefined);
            break;

          case "save_template":
            if (!args?.source_path) {
              throw new Error("Missing required parameter: source_path");
            }
            result = saveTemplate(
              String(args.source_path),
              typeof args?.template_name === "string" ? args.template_name : undefined,
              typeof args?.template_dir === "string" ? args.template_dir : undefined
            );
            break;

          case "get_slice_settings": {
            if (!args?.source_path && !args?.template_name) {
              throw new Error("Missing required parameter: source_path or template_name");
            }
            const settingsSource = args?.source_path
              ? String(args.source_path)
              : resolveTemplatePath(
                  String(args.template_name),
                  typeof args?.template_dir === "string" ? args.template_dir : undefined,
                  ["3mf", "json", "config"]
                )!;
            result = await inspectSliceSettings(settingsSource, TEMP_DIR);
            if (result.source_type === "3mf") {
              // What slice_stl does with the slice's own arguments (with source_path, template_name is its template),
              // through the same test runSliceTool uses; an explicit value or a quality or strength changes the process.
              const sliceArgs = (args ?? {}) as Record<string, unknown>;
              const slicerType = normalizeSlicerType(String(args?.slicer_type || DEFAULT_SLICER_TYPE));
              const bambuModel = typeof args?.bambu_model === "string" && args.bambu_model.trim() !== "";
              const explicitProfile = typeof args?.slicer_profile === "string" && args.slicer_profile.trim() !== "";
              const requestedTemplate = args?.source_path ? (resolveTemplatePath(typeof args?.template_name === "string" ? args.template_name : undefined,
                typeof args?.template_dir === "string" ? args.template_dir : undefined, ["json", "config", "3mf"])
                || (typeof args?.template_3mf_path === "string" && args.template_3mf_path.trim() ? args.template_3mf_path.trim() : undefined)) : undefined;
              // Validated first, so an invalid value is refused even when a named profile or template decides the answer.
              const changed = changesProcess(sliceArgs);
              result = { ...result, own_process: !changed && await slicesWithOwnProcess(settingsSource, usesBambuCli(slicerType, bambuModel), explicitProfile || !!requestedTemplate) };
            }
            break;
          }

          case "confirm_temperatures":
            if (!args?.gcode_path) {
              throw new Error("Missing required parameter: gcode_path");
            }
            result = await this.stlManipulator.confirmTemperatures(
              String(args.gcode_path),
              {
                extruder: args.extruder_temp !== undefined ? Number(args.extruder_temp) : undefined,
                bed: args.bed_temp !== undefined ? Number(args.bed_temp) : undefined
              }
            );
            break;
            
          case "process_and_print_stl":
            if (!args?.stl_path || args?.extension_inches === undefined) {
              throw new Error("Missing required parameters: stl_path and extension_inches");
            }
            
            // Validate every safety input before extending, slicing or connecting.
            const expectedPeaks: ExpectedPeakTemperatures = {
              nozzle: optionalTemperatureArg(args.extruder_temp, "extruder_temp"),
              bed: optionalTemperatureArg(args.bed_temp, "bed_temp"),
            };
            validateExpectedPeaks(expectedPeaks);
            const processMaterial = optionalMaterialArg(args?.material);
            let processModel: string | undefined;
            let processNozzle = String(DEFAULT_NOZZLE_DIAMETER);
            if (type.toLowerCase() === 'bambu' || isBambuProjectSlicer(slicerType)) {
              processModel = await this.resolveBambuModel(args?.bambu_model as string | undefined);
              processNozzle = String(optionalNozzleDiameterArg(args?.nozzle_diameter) ?? DEFAULT_NOZZLE_DIAMETER);
            }

            // Define progress callback for UI updates
            const processProgressCallback = (progress: number, message?: string) => {
              console.error(`Process progress: ${progress}% - ${message || ''}`);
            };

            // 1. Extend the base of the STL file
            const extendedStlPath = await this.stlManipulator.extendBase(
              String(args.stl_path),
              Number(args.extension_inches),
              processProgressCallback
            );

            // 2. Slice the extended STL file
            let processPreset: string | undefined;
            if (processModel && isBambuProjectSlicer(slicerType)) {
              processPreset = BAMBU_MODEL_PRESETS[processModel]?.(processNozzle);
            }
            const gcodePath = await this.stlManipulator.sliceSTL(
              extendedStlPath,
              slicerType,
              this.resolveExecutableSelectorArg(
                args?.slicer_path,
                "process_and_print_stl",
                "slicer_path"
              ) ?? DEFAULT_SLICER_PATH,
              slicerProfile || undefined,
              processProgressCallback,
              processPreset,
              filamentProfile || undefined,
              // Slice for the plate and nozzle the print gate will check against.
              processPreset
                ? {
                    bedType: resolveBedType(args?.bed_type as string | undefined),
                    ...(resolveNozzleType(args?.nozzle_type) ? { nozzleType: resolveNozzleType(args?.nozzle_type) } : {}),
                  }
                : undefined
            );

            if (type.toLowerCase() === 'bambu' && gcodePath.toLowerCase().endsWith(".3mf")) {
              if (!bambuSerial || !bambuToken) {
                throw new Error("Bambu serial number and access token are required for Bambu 3MF printing.");
              }

              const factoryImplementation = this.printerFactory.getImplementation('bambu');
              if (!(factoryImplementation instanceof BambuImplementation)) {
                throw new Error("Internal error: Could not get Bambu printer implementation.");
              }

              const printBedType = resolveBedType(args?.bed_type as string | undefined);
              let parsedProcess3MF: ThreeMFData | undefined;
              try {
                parsedProcess3MF = await parse3MF(gcodePath);
              } catch (error) {
                console.warn(
                  `Could not parse AMS metadata from sliced 3MF ${gcodePath}:`,
                  (error as Error).message
                );
              }
              const amsOptions = this.resolveAmsPrintOptions(
                parsedProcess3MF,
                args as Record<string, unknown> | undefined,
                processModel
              );

              result = await factoryImplementation.print3mf(host, bambuSerial, bambuToken, {
                projectName: path.basename(gcodePath).replace(/\.3mf$/i, ''),
                filePath: gcodePath,
                bambuModel: processModel,
                nozzleDiameters: [Number(processNozzle)],
                expectedPeaks,
                plateIndex: 0,
                ...amsOptions,
                bedType: printBedType,
                bedLeveling: args?.bed_leveling !== undefined ? Boolean(args.bed_leveling) : undefined,
                flowCalibration:
                  args?.flow_calibration !== undefined ? Boolean(args.flow_calibration) : undefined,
                vibrationCalibration:
                  args?.vibration_calibration !== undefined
                    ? Boolean(args.vibration_calibration)
                    : undefined,
                layerInspect: args?.layer_inspect !== undefined ? Boolean(args.layer_inspect) : undefined,
                timelapse: args?.timelapse !== undefined ? Boolean(args.timelapse) : undefined,
              });
              break;
            }

            if (gcodePath.toLowerCase().endsWith(".3mf")) {
              throw new Error(
                "process_and_print_stl produced a sliced 3MF. Direct process-and-print for sliced 3MF is only supported for Bambu printers via print_3mf."
              );
            }
            
            // 3. Upload and print through the adapter's hard safety gate. It
            // inspects the exact bytes sent (S and R targets, tool changes,
            // hardware and material ceilings), requires the expected peaks to
            // match, and reads fresh printer state.
            // A mismatch refuses before upload; nothing is only logged.
            const filename = path.basename(gcodePath);
            const printResult = await this.uploadGcode(
              host, port, type, apiKey, bambuSerial, bambuToken,
              filename,
              gcodePath,
              true, // Start printing immediately
              { bambuModel: processModel, material: processMaterial, expectedPeaks }
            );

            result = {
              extended_stl_path: extendedStlPath,
              gcode_path: gcodePath,
              filename,
              status: "Checked print job started",
              print: printResult,
            };
            break;
            
          // New STL manipulation tool handlers
          case "get_stl_info":
            if (!args?.stl_path) {
              throw new Error("Missing required parameter: stl_path");
            }
            
            result = await this.stlManipulator.getSTLInfo(String(args.stl_path));
            break;
            
          case "scale_stl":
            if (!args?.stl_path) {
              throw new Error("Missing required parameter: stl_path");
            }
            
            // Define progress callback for UI updates
            const scaleProgressCallback = (progress: number, message?: string) => {
              console.error(`Scale progress: ${progress}% - ${message || ''}`);
            };
            
            let scaleFactors: number | [number, number, number];
            
            // Check if we have individual axis scaling factors
            if (args.scale_x !== undefined || args.scale_y !== undefined || args.scale_z !== undefined) {
              // Use individual axis scaling
              scaleFactors = [
                Number(args.scale_x ?? 1.0),
                Number(args.scale_y ?? 1.0),
                Number(args.scale_z ?? 1.0)
              ];
            } else {
              // Use uniform scaling
              scaleFactors = Number(args.scale_factor ?? 1.0);
            }
            
            result = await this.stlManipulator.scaleSTL(
              String(args.stl_path),
              scaleFactors,
              scaleProgressCallback
            );
            break;
            
          case "rotate_stl":
            if (!args?.stl_path) {
              throw new Error("Missing required parameter: stl_path");
            }
            
            // Define progress callback for UI updates
            const rotateProgressCallback = (progress: number, message?: string) => {
              console.error(`Rotate progress: ${progress}% - ${message || ''}`);
            };
            
            // Get rotation angles, defaulting to 0 for any undefined axis
            const rotationAngles: [number, number, number] = [
              Number(args.rotate_x ?? 0),
              Number(args.rotate_y ?? 0),
              Number(args.rotate_z ?? 0)
            ];
            
            result = await this.stlManipulator.rotateSTL(
              String(args.stl_path),
              rotationAngles,
              rotateProgressCallback
            );
            break;
            
          case "translate_stl":
            if (!args?.stl_path) {
              throw new Error("Missing required parameter: stl_path");
            }
            
            // Define progress callback for UI updates
            const translateProgressCallback = (progress: number, message?: string) => {
              console.error(`Translate progress: ${progress}% - ${message || ''}`);
            };
            
            // Get translation values, defaulting to 0 for any undefined axis
            const translationValues: [number, number, number] = [
              Number(args.translate_x ?? 0),
              Number(args.translate_y ?? 0),
              Number(args.translate_z ?? 0)
            ];
            
            result = await this.stlManipulator.translateSTL(
              String(args.stl_path),
              translationValues,
              translateProgressCallback
            );
            break;
            
          case "modify_stl_section":
            if (!args?.stl_path || !args?.section || !args?.transformation_type) {
              throw new Error("Missing required parameters: stl_path, section, and transformation_type");
            }
            
            // Define progress callback for UI updates
            const modifySectionProgressCallback = (progress: number, message?: string) => {
              console.error(`Modify section progress: ${progress}% - ${message || ''}`);
            };
            
            // Determine the section to modify
            let sectionBox: THREE.Box3 | 'top' | 'bottom' | 'center';
            
            if (args.section === 'custom') {
              // Create a custom bounding box from the provided bounds
              if (args.custom_min_x === undefined || args.custom_min_y === undefined || 
                  args.custom_min_z === undefined || args.custom_max_x === undefined || 
                  args.custom_max_y === undefined || args.custom_max_z === undefined) {
                throw new Error("Custom section requires all min/max bounds to be specified");
              }
              
              sectionBox = new THREE.Box3(
                new THREE.Vector3(
                  Number(args.custom_min_x),
                  Number(args.custom_min_y),
                  Number(args.custom_min_z)
                ),
                new THREE.Vector3(
                  Number(args.custom_max_x),
                  Number(args.custom_max_y),
                  Number(args.custom_max_z)
                )
              );
            } else {
              // Use a predefined section
              sectionBox = String(args.section) as 'top' | 'bottom' | 'center';
            }
            
            // Determine the transformation to apply
            const transformationType = String(args.transformation_type) as 'scale' | 'rotate' | 'translate';
            let transformationValue: number | number[];
            
            if (transformationType === 'scale') {
              if (args.value_x !== undefined || args.value_y !== undefined || args.value_z !== undefined) {
                transformationValue = [
                  Number(args.value_x ?? 1.0),
                  Number(args.value_y ?? 1.0),
                  Number(args.value_z ?? 1.0)
                ];
              } else {
                transformationValue = 1.0; // Default scale factor
              }
            } else if (transformationType === 'rotate') {
              transformationValue = [
                Number(args.value_x ?? 0),
                Number(args.value_y ?? 0),
                Number(args.value_z ?? 0)
              ];
            } else { // translate
              transformationValue = [
                Number(args.value_x ?? 0),
                Number(args.value_y ?? 0),
                Number(args.value_z ?? 0)
              ];
            }
            
            result = await this.stlManipulator.modifySection(
              String(args.stl_path),
              sectionBox,
              {
                type: transformationType,
                value: transformationValue
              },
              modifySectionProgressCallback
            );
            break;
            
          case "generate_stl_visualization":
            if (!args?.stl_path) {
              throw new Error("Missing required parameter: stl_path");
            }
            
            // Define progress callback for UI updates
            const visualizationProgressCallback = (progress: number, message?: string) => {
              console.error(`Visualization progress: ${progress}% - ${message || ''}`);
            };
            
            // Get width and height parameters, with defaults
            const width = args.width !== undefined ? Number(args.width) : 300;
            const height = args.height !== undefined ? Number(args.height) : 300;
            
            result = await this.stlManipulator.generateVisualization(
              String(args.stl_path),
              width,
              height,
              visualizationProgressCallback
            );
            break;
            
          case "print_3mf": {
            if (!args?.three_mf_path) {
              throw new Error("Missing required parameter: three_mf_path");
            }
            if (type.toLowerCase() !== 'bambu') {
                throw new Error("The print_3mf tool currently only supports Bambu printers.");
            }
            if (!bambuSerial || !bambuToken) {
                throw new Error("Bambu serial number and access token are required for print_3mf.");
            }

            const printPlate = args.plate_index === undefined ? 0 : args.plate_index;
            if (typeof printPlate !== "number" || !Number.isSafeInteger(printPlate) || printPlate < 0 || printPlate >= Number.MAX_SAFE_INTEGER) throw new Error("plate_index must be a nonnegative safe integer with a supported one-based plate number.");
            const printModel = await this.resolveBambuModel(args?.bambu_model as string | undefined);
            const printBedType = resolveBedType(args?.bed_type as string | undefined);
            const explicitPrintNozzle = optionalNozzleDiameterArg(args?.nozzle_diameter);
            const printNozzle = String(explicitPrintNozzle ?? DEFAULT_NOZZLE_DIAMETER);
            const printPreset = BAMBU_MODEL_PRESETS[printModel]?.(printNozzle);
            const printConnection = resolveConnection(args);
            assertConnectionAvailable(printConnection.mode);

            let threeMFPath = String(args.three_mf_path);

            // Only the selected plate's exact G-code entry counts as sliced output;
            // a stray .gcode entry elsewhere in the archive is not printable.
            const selectedPlateEntry = `Metadata/plate_${printPlate + 1}.gcode`;
            let shouldAutoSlice = false;
            try {
              const JSZip = (await import('jszip')).default;
              const zipData = fs.readFileSync(threeMFPath);
              const zip = await JSZip.loadAsync(zipData);
              const plateEntry = zip.file(selectedPlateEntry);
              shouldAutoSlice = !plateEntry || plateEntry.dir;
            } catch (sliceCheckErr: any) {
              throw new Error(
                `Cannot read 3MF archive ${threeMFPath}; nothing was uploaded or started: ${sliceCheckErr?.message ?? String(sliceCheckErr)}`
              );
            }

            // Only treat slicer_path as an executable selector when a slicer
            // will actually launch. Ready-to-print archives ignore it.
            const pauseLayers = parsePauseLayers(args?.pause_at_layers);
            if (!shouldAutoSlice && pauseLayers) {
              const gcode = await readPlateGcode(threeMFPath, printPlate + 1);
              const placed = gcode ? pausedLayers(gcode, machinePauseGcode(gcode)) : [];
              const missing = pauseLayers.filter(layer => !placed.includes(layer));
              if (missing.length) throw new Error(`This 3MF is already sliced without a pause before layer ${missing.join(", ")}. Slice it again with pause_at_layers (slice_stl), or add the pause in Bambu Studio or OrcaSlicer.`);
            }
            if (shouldAutoSlice) {
              const printSlicerPath =
                this.resolveExecutableSelectorArg(
                  args?.slicer_path,
                  "print_3mf",
                  "slicer_path"
                ) ?? DEFAULT_SLICER_PATH;
              try {
                console.error(`3MF has no gcode — auto-slicing with ${slicerType} for ${printModel}`);
                // A designer's project slices with its own process unless the call names a profile.
                const explicitPrintProfile = typeof args?.slicer_profile === "string" && args.slicer_profile.trim().length > 0;
                const printProfile = await slicesWithOwnProcess(threeMFPath, usesBambuCli(slicerType, true), explicitPrintProfile)
                  ? await resolveTemplateSlicerProfilePath(threeMFPath, path.join(TEMP_DIR, "templates"))
                  : slicerProfile || undefined;
                threeMFPath = await this.stlManipulator.sliceSTL(
                  threeMFPath,
                  slicerType,
                  printSlicerPath,
                  printProfile,
                  undefined, // progressCallback
                  printPreset,
                  filamentProfile || undefined,
                  // Slice for the plate and nozzle the print will be checked against.
                  { bedType: printBedType, slicePlate: printPlate + 1, ...(pauseLayers ? { pauseAtLayers: pauseLayers } : {}), ...(resolveNozzleType(args?.nozzle_type) ? { nozzleType: resolveNozzleType(args?.nozzle_type) } : {}) }
                );
                console.error("Auto-sliced to: " + threeMFPath);
              } catch (sliceErr: any) {
                // Never fall back to uploading the original unsliced project.
                // Rethrow the original instance (for example a SlicerError) so
                // structured slicer suggestions survive.
                const prefix = "Auto-slicing failed; nothing was uploaded or started: ";
                if (sliceErr instanceof Error) {
                  if (!sliceErr.message.startsWith(prefix)) sliceErr.message = `${prefix}${sliceErr.message}`;
                  throw sliceErr;
                }
                throw new Error(`${prefix}${String(sliceErr)}`);
              }
            }
            // Compare the sliced file with an explicit or auto-slice nozzle request.
            const requestedPrintNozzles =
              explicitPrintNozzle !== undefined || shouldAutoSlice ? [Number(printNozzle)] : undefined;

            // Define variables needed outside the parse try block
            let implementation: BambuImplementation;
            let threeMfFilename: string;
            let projectName: string;
            let printOptions: any; // Use a more specific type later if possible

            try {
                // --- Parse 3MF --- 
                const parsed3MFData = await parse3MF(threeMFPath);
                console.error(`Successfully parsed 3MF file: ${threeMFPath}`);
                const amsOptions = this.resolveAmsPrintOptions(
                  parsed3MFData,
                  args as Record<string, unknown> | undefined,
                  printModel
                );

                // --- Prepare Implementation and Print Options --- 
                const factoryImplementation = this.printerFactory.getImplementation('bambu');
                if (!(factoryImplementation instanceof BambuImplementation)) {
                    throw new Error("Internal error: Could not get Bambu printer implementation.");
                }
                implementation = factoryImplementation; // Assign to outer scope variable

                threeMfFilename = path.basename(threeMFPath); // Assign to outer scope variable
                projectName = threeMfFilename.replace(/\.3mf$/i, ''); // Assign to outer scope variable

                printOptions = { // Assign to outer scope variable
                    ...amsOptions,
                    bambuModel: printModel,
                    nozzleDiameters: requestedPrintNozzles,
                    bedType: printBedType,
                    bedLeveling: args?.bed_leveling !== undefined ? Boolean(args.bed_leveling) : undefined,
                    flowCalibration: args?.flow_calibration !== undefined ? Boolean(args.flow_calibration) : undefined,
                    vibrationCalibration: args?.vibration_calibration !== undefined ? Boolean(args.vibration_calibration) : undefined,
                    layerInspect: args?.layer_inspect !== undefined ? Boolean(args.layer_inspect) : undefined,
                    timelapse: args?.timelapse !== undefined ? Boolean(args.timelapse) : undefined,
                    // md5: parsed3MFData?.metadata?.md5
                };

            } catch (error) { // Catch parsing or setup errors
                console.error(`Error processing 3MF or setting up print:`, error);
                throw new Error(`Failed during 3MF processing: ${(error as Error).message}`);
            }
                
            if (printConnection.mode === "bambu_network") {
              result = await this.print3mfViaBambuNetwork({
                args: args as Record<string, any>, host, serial: bambuSerial, token: bambuToken, threeMFPath,
                model: printModel, nozzleDiameters: requestedPrintNozzles, bedType: printBedType,
                connectionType: printConnection.type, plateIndex: printPlate,
                ams: { useAMS: printOptions.useAMS, amsMapping: printOptions.amsMapping, amsSlots: printOptions.amsSlots },
              });
              break;
            }

            // --- Call Implementation (Now variables are in scope) --- 
            try {
                result = await implementation.print3mf(host, bambuSerial, bambuToken, {
                    projectName: projectName,
                    filePath: threeMFPath,
                    plateIndex: printPlate,
                    ...printOptions // Spread the final options
                });
                // Report what the printer did, not merely that a command was published.
            } catch (printError) {
                 console.error(`Error starting 3MF print for ${threeMfFilename}:`, printError);
                 const wrapped = `Failed to start print: ${(printError as Error).message}`;
                 // A printer refusal keeps its code through the wrap: clients act on it (src/refusal.ts).
                 throw printError instanceof PrinterRefusal ? new PrinterRefusal(printError.code, wrapped) : new Error(wrapped);
            }

            break;
          }

          case "check_fulu_orca_setup": {
            const runBridgeProbe = Boolean(args?.run_bridge_probe ?? false);
            result = await inspectFuluOrcaSetup({
              slicerPath: this.resolveExecutableSelectorArg(
                args?.slicer_path,
                "check_fulu_orca_setup",
                "slicer_path",
                runBridgeProbe,
                true
              ),
              pluginDir: this.resolveExecutableSelectorArg(
                args?.plugin_dir,
                "check_fulu_orca_setup",
                "plugin_dir",
                runBridgeProbe,
                true
              ),
              runtimeDir: this.resolveExecutableSelectorArg(
                args?.runtime_dir,
                "check_fulu_orca_setup",
                "runtime_dir",
                runBridgeProbe,
                true
              ),
              platform: args?.platform !== undefined ? String(args.platform) : undefined,
              bridgeCommand: this.resolveExecutableSelectorArg(
                args?.bridge_command,
                "check_fulu_orca_setup",
                "bridge_command",
                true,
                true
              ),
              runBridgeProbe,
              probeTimeoutMs:
                args?.probe_timeout_ms !== undefined ? Number(args.probe_timeout_ms) : undefined,
            });
            break;
          }

          case "fulu_bambu_network_rpc": {
            if (!args?.method) {
              throw new Error("Missing required parameter: method");
            }

            // Raw print methods, printer messages and unknown methods are refused
            // inside invokeFuluBridgeRpc before any bridge process starts.
            const method = String(args.method);
            const rpcBambuModel =
              typeof args?.bambu_model === "string" && args.bambu_model.trim() ? args.bambu_model.trim() : undefined;

            const payload =
              typeof args.payload === "object" && args.payload !== null && !Array.isArray(args.payload)
                ? (args.payload as Record<string, unknown>)
                : undefined;

            result = await invokeFuluBridgeRpc({
              bridgeCommand: this.resolveExecutableSelectorArg(
                args?.bridge_command,
                "fulu_bambu_network_rpc",
                "bridge_command",
                true,
                true
              ),
              method,
              payload,
              timeoutMs: args?.timeout_ms !== undefined ? Number(args.timeout_ms) : undefined,
              allowMutatingMethod: Boolean(args?.allow_mutating_method ?? false),
              bambuModel: rpcBambuModel,
            });
            break;
          }

          case "merge_vertices":
            if (!args?.stl_path) {
                throw new Error("Missing required parameter: stl_path");
            }
            result = await this.stlManipulator.mergeVertices(
                String(args.stl_path),
                args.tolerance !== undefined ? Number(args.tolerance) : undefined // Pass tolerance if provided
            );
            break;

          case "center_model":
            if (!args?.stl_path) {
                throw new Error("Missing required parameter: stl_path");
            }
            result = await this.stlManipulator.centerModel(String(args.stl_path));
            break;

          case "lay_flat": {
            if (!args?.stl_path) {
                throw new Error("Missing required parameter: stl_path");
            }
            const layFlatResult = await this.stlManipulator.layFlatWithResult(String(args.stl_path));
            // The text stays the STL path clients read; structuredContent says whether it was laid flat.
            return { content: [{ type: "text", text: layFlatResult.path }], structuredContent: layFlatResult };
          }

          case "blender_mcp_setup":
            if (args?.update !== undefined && typeof args.update !== "boolean") throw new Error("update must be a boolean.");
            return structured(args?.update === true ? await this.blenderSetup.update(extra.signal) : await this.blenderSetup.check());

          case "fusion_mcp_setup":
            if (args?.install !== undefined && typeof args.install !== "boolean") throw new Error("install must be a boolean.");
            return structured(args?.install === true ? await this.fusionSetup.install(extra.signal) : await this.fusionSetup.check());

          case "fusion_mcp_status":
            return structured(await this.fusion.status(args ?? {}, extra.signal));

          case "fusion_mcp_call":
            return await this.fusion.call(args ?? {}, extra.signal);

          case "fusion_mcp_new_design":
            return structured(await this.fusion.newDesign(args ?? {}, extra.signal));

          case "fusion_mcp_export":
            return structured(await this.fusion.export(args ?? {}, extra.signal));

          case "blender_mcp_status":
            result = await this.blender.status(args ?? {}, extra.signal);
            break;

          case "blender_mcp_call":
            return await this.blender.call(args ?? {}, extra.signal);

          case "blender_mcp_export_stl":
            result = await this.blender.exportStl(args ?? {}, extra.signal);
            break;

          case "blender_mcp_edit_model":
            result = await this.blender.edit(
              args ?? {},
              this.resolveExecutableSelectorArg(
                args?.bridge_command,
                "blender_mcp_edit_model",
                "bridge_command",
                true,
                true
              ) ?? (!process.env.BLENDER_MCP_COMMAND?.trim() ? this.runtimeConfig.blenderBridgeCommand : undefined),
              extra.signal
            );
            break;

          default:
            throw new Error(`Unknown tool: ${name}`);
        }

        return {
          content: [
            {
              type: "text",
              text: typeof result === "string" ? result : JSON.stringify(result, null, 2)
            }
          ]
        };
      } catch (error: unknown) {
        console.error(`Error calling tool ${name}:`, error);
        
        const errorMessage = error instanceof Error ? error.message : String(error);
        // A printer refusal adds its stable code (src/refusal.ts); the message and suggestion stay as they were.
        const structuredError = { ...this.toStructuredToolError(name, errorMessage, error), ...(error instanceof PrinterRefusal ? { code: error.code } : {}) };
        
        return {
          content: [
            {
              type: "text",
              // A slicer failure leads with its plain sentence, then the slicer's own words.
              text: `${error instanceof SlicerError && (error.slicerText || error.plain) ? "" : "Error: "}${errorMessage}\nSuggestion: ${structuredError.suggestion}`
            }
          ],
          // Clients validate structuredContent against a declared outputSchema even on errors.
          ...(OUTPUT_SCHEMA_TOOLS.has(name) ? {} : { structuredContent: structuredError }),
          isError: true
        };
      }
    }));
  }

  // Delegating methods to printer implementations
  
  async getPrinterStatus(
    host: string, 
    port = DEFAULT_PORT, 
    type = DEFAULT_TYPE, 
    apiKey = DEFAULT_API_KEY,
    bambuSerial = DEFAULT_BAMBU_SERIAL,
    bambuToken = DEFAULT_BAMBU_TOKEN
  ) {
    const implementation = this.printerFactory.getImplementation(type);
    
    if (type.toLowerCase() === "bambu") {
      const bambuApiKey = `${bambuSerial}:${bambuToken}`;
      return implementation.getStatus(host, port, bambuApiKey);
    }
    
    return implementation.getStatus(host, port, apiKey);
  }

  async getPrinterFiles(
    host: string, 
    port = DEFAULT_PORT, 
    type = DEFAULT_TYPE, 
    apiKey = DEFAULT_API_KEY,
    bambuSerial = DEFAULT_BAMBU_SERIAL,
    bambuToken = DEFAULT_BAMBU_TOKEN
  ) {
    const implementation = this.printerFactory.getImplementation(type);
    
    if (type.toLowerCase() === "bambu") {
      const bambuApiKey = `${bambuSerial}:${bambuToken}`;
      return implementation.getFiles(host, port, bambuApiKey);
    }
    
    return implementation.getFiles(host, port, apiKey);
  }

  async getPrinterFile(
    host: string, 
    filename: string, 
    port = DEFAULT_PORT, 
    type = DEFAULT_TYPE, 
    apiKey = DEFAULT_API_KEY,
    bambuSerial = DEFAULT_BAMBU_SERIAL,
    bambuToken = DEFAULT_BAMBU_TOKEN
  ) {
    const implementation = this.printerFactory.getImplementation(type);
    
    if (type.toLowerCase() === "bambu") {
      const bambuApiKey = `${bambuSerial}:${bambuToken}`;
      return implementation.getFile(host, port, bambuApiKey, filename);
    }
    
    return implementation.getFile(host, port, apiKey, filename);
  }

  async uploadGcode(
    host: string, 
    port: string, 
    type: string, 
    apiKey: string,
    bambuSerial: string,
    bambuToken: string, 
    filename: string, 
    gcode: string, 
    print: boolean,
    options: PrintSafetyOptions = {}
  ) {
    const sourceIsFilePath = fs.existsSync(gcode) && fs.statSync(gcode).isFile();
    // The remote filename must never select a local write/delete target.
    const localFilename = path.basename(filename);
    if (!sourceIsFilePath && (!localFilename || localFilename === "." || localFilename === "..")) {
      throw new Error("filename must include a file basename.");
    }
    const scratchDir = sourceIsFilePath ? undefined : fs.mkdtempSync(path.join(TEMP_DIR, "upload-"));
    // Multipart adapters infer their file-part name from this safe basename.
    const tempFilePath = scratchDir ? path.join(scratchDir, localFilename) : gcode;

    try {
      if (scratchDir) fs.writeFileSync(tempFilePath, gcode);
      const implementation = this.printerFactory.getImplementation(type);
      
      if (type.toLowerCase() === "bambu") {
        const bambuApiKey = `${bambuSerial}:${bambuToken}`;
        return await implementation.uploadFile(host, port, bambuApiKey, tempFilePath, filename, print, options);
      }
      
      return await implementation.uploadFile(host, port, apiKey, tempFilePath, filename, print, options);
    } finally {
      if (scratchDir) fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  }

  async startPrint(
    host: string, 
    port: string, 
    type: string, 
    apiKey: string,
    bambuSerial: string,
    bambuToken: string, 
    gcodeFilename: string,
    options: PrintSafetyOptions = {}
  ) {
    const implementation = this.printerFactory.getImplementation(type);
    
    if (type.toLowerCase() === "bambu") {
      const bambuApiKey = `${bambuSerial}:${bambuToken}`;
      return await implementation.startJob(host, port, bambuApiKey, gcodeFilename, options);
    }
    
    return await implementation.startJob(host, port, apiKey, gcodeFilename, options);
  }

  async cancelPrint(
    host: string, 
    port: string, 
    type: string, 
    apiKey: string,
    bambuSerial: string,
    bambuToken: string,
    bambuDispatch?: () => Promise<any>
  ) {
    const implementation = this.printerFactory.getImplementation(type);
    
    if (type.toLowerCase() === "bambu") {
      const bambuApiKey = `${bambuSerial}:${bambuToken}`;
      return await (implementation as unknown as BambuImplementation).cancelJob(host, port, bambuApiKey, bambuDispatch);
    }
    
    return await implementation.cancelJob(host, port, apiKey);
  }

  async setPrinterTemperature(
    host: string, 
    port: string, 
    type: string, 
    apiKey: string,
    bambuSerial: string,
    bambuToken: string,
    component: string, 
    temperature: unknown,
    options: PrintSafetyOptions = {}
  ) {
    const implementation = this.printerFactory.getImplementation(type);
    
    if (type.toLowerCase() === "bambu") {
      const bambuApiKey = `${bambuSerial}:${bambuToken}`;
      return implementation.setTemperature(host, port, bambuApiKey, component, temperature, options);
    }
    
    return implementation.setTemperature(host, port, apiKey, component, temperature, options);
  }

  private toStructuredToolError(tool: string, message: string, error?: unknown): StructuredToolError {
    // Slicer failures are local profile/slicer problems, never printer connectivity.
    if (error instanceof SlicerError) {
      return {
        status: "error",
        retryable: false,
        suggestion: error.suggestion,
        message,
        tool,
        slicer: { phase: error.phase, ...error.details },
        // A slicer's refusal always carries slicer_report: the plain sentence a person sees, the slicer's words for the log.
        // The plain sentence of the text is the report's too (it also reads the slicer's output, not only result.json).
        ...(error.slicerResult ? { slicer_result: error.slicerResult, ...refusedReport(error.slicerResult, error.plain) }
          : error.plain ? { slicer_report: { ...refusalReport([error.details.stderrTail, error.details.stdoutTail].filter(Boolean).join("\n") || error.detail), message: error.plain } } : {}),
      };
    }
    if (SLICING_TOOLS.has(tool)) {
      return {
        status: "error",
        retryable: false,
        suggestion: "Check the slicing arguments, template, and profile paths named in the error, then retry.",
        message,
        tool,
      };
    }
    if (tool.startsWith("fusion_mcp_")) {
      return {
        status: "error",
        retryable: false,
        suggestion: "Check that Autodesk Fusion is open with the Fusion360MCP add-in running and the FUSION_MCP_* settings, then ask again. Fusion requests are never replayed; inspect the design before repeating a change.",
        message,
        tool,
      };
    }
    if (isCredentialRejection(message)) {
      return { status: "error", retryable: false, suggestion: credentialSuggestion(), message, tool };
    }
    // Safety refusals stop before the printer is touched; retrying unchanged repeats the refusal.
    if (/nothing was (?:sent|uploaded)|no command was sent|print safety|hardware limit|material policy|declared material|confirmation was declined|are refused|is refused|refused because|refused until|refused before|does not match the job|is ambiguous|is missing or ambiguous|rejected the print command/i.test(message)) {
      return {
        status: "error",
        retryable: false,
        suggestion: "A safety check stopped this before anything reached the printer. Read the reason, fix the file, arguments, or printer state, and ask again.",
        message,
        tool,
      };
    }
    const isInputError =
      message.toLowerCase().includes("missing required") ||
      message.toLowerCase().includes("invalid") ||
      message.toLowerCase().includes("unsupported");

    return {
      status: "error",
      retryable: !isInputError,
      suggestion: isInputError
        ? "Fix tool arguments and retry."
        : "Retry the call. If it keeps failing, verify printer connectivity and credentials.",
      message,
      tool,
    };
  }

  private async parseHttpRequestBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    if (chunks.length === 0) {
      return undefined;
    }

    const rawBody = Buffer.concat(chunks).toString("utf8").trim();
    if (!rawBody) {
      return undefined;
    }

    return JSON.parse(rawBody);
  }

  private isAllowedOrigin(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) {
      return true;
    }

    if (this.runtimeConfig.allowedOrigins.size === 0) {
      return false;
    }

    return this.runtimeConfig.allowedOrigins.has(origin);
  }

  private async connectStdio(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    // A host that disconnects by closing stdin sends no signal. Shut down then,
    // so the server and its persistent Fusion MCP child do not outlive it.
    const disconnected = () => { void this.close().finally(() => process.exit(0)); };
    process.stdin.once("end", disconnected);
    process.stdin.once("close", disconnected);
    console.error("3D Printer MCP server running on stdio transport");
  }

  private async connectStreamableHttp(): Promise<void> {
    if (this.httpRuntime) {
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: this.runtimeConfig.statefulSession ? () => randomUUID() : undefined,
      enableJsonResponse: this.runtimeConfig.enableJsonResponse
    });

    await this.server.connect(transport);

    const requestHandler = async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        if (url.pathname !== this.runtimeConfig.httpPath) {
          res.statusCode = 404;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: "Not Found" }));
          return;
        }

        if (!this.isAllowedOrigin(req)) {
          res.statusCode = 403;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: "Forbidden origin" }));
          return;
        }

        const method = req.method?.toUpperCase() ?? "GET";
        if (!["POST", "GET", "DELETE"].includes(method)) {
          res.statusCode = 405;
          res.setHeader("allow", "POST, GET, DELETE");
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: "Method Not Allowed" }));
          return;
        }

        let parsedBody: unknown;
        if (method === "POST") {
          try {
            parsedBody = await this.parseHttpRequestBody(req);
          } catch {
            res.statusCode = 400;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: "Invalid JSON body" }));
            return;
          }
        }

        await transport.handleRequest(req, res, parsedBody);
      } catch (error) {
        console.error("Error handling streamable-http request:", error);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32603, message: "Internal server error" },
              id: null
            })
          );
        }
      }
    };

    const httpServer = createHttpServer((req, res) => {
      void requestHandler(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(this.runtimeConfig.httpPort, this.runtimeConfig.httpHost, () => resolve());
    });

    this.httpRuntime = { transport, httpServer };
    console.error(
      `3D Printer MCP server running on streamable-http at http://${this.runtimeConfig.httpHost}:${this.runtimeConfig.httpPort}${this.runtimeConfig.httpPath}`
    );
  }

  /**
   * Bridge commands and path-derived bridge executables are machine-local
   * settings. Accepting their selectors as tool arguments means anything that
   * can steer the model — a model description, a README in a downloaded
   * archive, 3MF metadata — can choose the program this server runs. They are
   * read from environment configuration by default and only accepted for
   * execution when MCP_ALLOW_EXECUTABLE_ARG is set. The older
   * MCP_ALLOW_BRIDGE_COMMAND_ARG name remains a compatibility alias only for
   * bridge commands and path selectors used to derive a bridge executable.
   */
  private resolveExecutableSelectorArg(
    rawValue: unknown,
    toolName: string,
    argumentName: string,
    executionRequested = true,
    allowLegacyBridgeArg = false
  ): string | undefined {
    if (rawValue === undefined) {
      return undefined;
    }

    const value = String(rawValue);
    if (value.length === 0) {
      return undefined;
    }

    const isAllowed =
      this.runtimeConfig.allowExecutableArg ||
      (allowLegacyBridgeArg && this.runtimeConfig.allowBridgeCommandArg);
    if (executionRequested && !isAllowed) {
      throw new Error(
        `${toolName}: the ${argumentName} argument cannot select an executable by default. ` +
        "Executable paths and commands are read from server environment configuration. Set " +
        `MCP_ALLOW_EXECUTABLE_ARG=1 to accept ${argumentName} for process execution.`
      );
    }

    return value;
  }

  private closing?: Promise<void>;

  /** Idempotent: a signal and stdin EOF can both arrive. */
  close(): Promise<void> {
    this.closing ??= this.closeOnce();
    return this.closing;
  }

  private async closeOnce(): Promise<void> {
    this.counterpart.close();
    await this.printerFactory.disconnectAll();
    await this.bambuNetwork.stop();
    await this.fusion.close();

    if (this.httpRuntime) {
      await this.httpRuntime.transport.close();
      await new Promise<void>((resolve, reject) => {
        this.httpRuntime?.httpServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      this.httpRuntime = undefined;
    } else {
      await this.server.close();
    }
  }

  async run(): Promise<void> {
    if (this.runtimeConfig.transport === "streamable-http") {
      await this.connectStreamableHttp();
      return;
    }

    await this.connectStdio();
  }
}

const server = new ThreeDPrinterMCPServer();

const shutdown = async () => {
  await server.close();
  process.exit(0);
};

process.once("SIGINT", () => {
  void shutdown();
});

process.once("SIGTERM", () => {
  void shutdown();
});

server.run().catch((error) => {
  console.error("[mcp-3d-printer-server] startup failed:", error);
  process.exit(1);
});
