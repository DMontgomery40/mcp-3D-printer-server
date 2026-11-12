import {PHYSICAL_EVIDENCE_SCHEMA} from "./physical-evidence.js";
import type {PhysicalEvidence} from "./physical-evidence.js";
/**
 * The Counterpart tool contract (`counterpart/1`). bambu-printer-mcp and this
 * server return the same shapes so one client can treat both alike. Optional
 * fields are omitted, never null: JSON Schema `number` rejects null.
 */
import path from "node:path";

export const COUNTERPART_CONTRACT = "counterpart/1";

export const PRINTER_KINDS = ["bambu", "octoprint", "klipper", "prusa", "duet", "repetier", "creality"] as const;
export type PrinterKind = (typeof PRINTER_KINDS)[number];

export const PROGRESS_STATES = ["idle", "preparing", "printing", "paused", "finished", "failed", "cancelled", "offline", "busy"] as const;
export type ProgressState = (typeof PROGRESS_STATES)[number];

export const PROBLEM_SEVERITIES = ["fatal", "error", "warning", "info"] as const;
export type ProblemSeverity = (typeof PROBLEM_SEVERITIES)[number];

export type CameraCapability = "bambu-tcp" | "rtsp" | "http-snapshot" | "none";
export type FilamentCapability = "ams" | "single" | "none";

export interface CounterpartProblem {
  code: string;
  severity: ProblemSeverity;
  message: string;
  url?: string;
}

export interface HeaterReading {
  actual: number;
  target: number;
}

export interface CounterpartJob {
  name: string;
  id?: string;
  progress?: number;
  elapsedSec?: number;
  remainingSec?: number;
  layer?: number;
  totalLayers?: number;
  stage?: string;
}

export interface CounterpartProgress {
  physical?: PhysicalEvidence;
  contract: typeof COUNTERPART_CONTRACT;
  observedAt: string;
  state: ProgressState;
  job?: CounterpartJob;
  temps?: { nozzle?: HeaterReading; bed?: HeaterReading; chamber?: number };
  activeFilament?: { slot?: string; material?: string; color?: string };
  problems: CounterpartProblem[];
}

export interface CounterpartCapabilities {
  cad?: {contract: string; status: string; setup: string; run: string; checkFit: string; prompt: string};
  progress: boolean;
  layers: boolean;
  camera: CameraCapability;
  cameraStream?: boolean;
  filaments: FilamentCapability;
  pause: boolean;
  resume: boolean;
  cancel: boolean;
  print3mf: boolean;
  gcode: boolean;
  /** What slice_stl can apply with this server's slicer for this printer (src/slicer/capabilities.ts). For a Bambu printer on
   *  OrcaSlicer this assumes the call passes the printer's bambu_model, as Counterpart does; without one, OrcaSlicer slices generically. */
  slicing?: { supports: boolean; copies: boolean; orient: boolean };
}

export interface PrinterIdentity {
  model?: string;
  serial?: string;
  name?: string;
}

export interface CounterpartPrinterInfo {
  contract: typeof COUNTERPART_CONTRACT;
  server: { name: string; version: string };
  printer: { kind: PrinterKind; host: string } & PrinterIdentity;
  capabilities: CounterpartCapabilities;
}

export interface FilamentSlot {
  /** "ext" for a single-spool printer; Bambu: the absolute AMS tray ("0"-"15", "128"+) or external spool ("254", "255"). */
  id: string;
  material?: string;
  color?: string;
  /** The spool as a person names it ("Sunflower Yellow PLA Basic"). */
  name?: string;
  /** Where it sits, as a person reads it: "A2", "AMS HT A", "External", "Spool". */
  label?: string;
  /** Bambu's filament id (tray_info_idx), when the printer reports one. */
  filamentId?: string;
  source: "spoolman" | "printer" | "unknown";
  /** Absolute path of the slicer filament profile for this material, as slice_stl's load_filaments takes it. */
  profile?: string;
}

export interface CameraSnapshotResult {
  status: "success";
  format: "image/jpeg";
  sizeBytes: number;
  base64: string;
  savedTo?: string;
  capturedAt: string;
  /** Where the frame came from, e.g. "octoprint-settings" or "env-override". */
  source: string;
}

const heater = {
  type: "object",
  required: ["actual", "target"],
  properties: { actual: { type: "number" }, target: { type: "number" } },
};

const problem = {
  type: "object",
  required: ["code", "severity", "message"],
  properties: {
    code: { type: "string" },
    severity: { type: "string", enum: [...PROBLEM_SEVERITIES] },
    message: { type: "string" },
    url: { type: "string" },
  },
};

/** outputSchema for counterpart_printer_info (PRD §8.4). */
export const PRINTER_INFO_OUTPUT_SCHEMA = {
  type: "object",
  required: ["contract", "server", "printer", "capabilities"],
  properties: {
    contract: { type: "string", const: COUNTERPART_CONTRACT },
    server: {
      type: "object",
      required: ["name", "version"],
      properties: { name: { type: "string" }, version: { type: "string" } },
    },
    printer: {
      type: "object",
      required: ["kind", "host"],
      properties: {
        kind: { type: "string", enum: [...PRINTER_KINDS] },
        model: { type: "string" },
        serial: { type: "string" },
        host: { type: "string" },
        name: { type: "string" },
      },
    },
    capabilities: {
      type: "object",
      required: ["progress", "layers", "camera", "filaments", "pause", "resume", "cancel", "print3mf", "gcode"],
      properties: {
        cad: {type: "object", properties: {contract: {type: "string", const: "cad/1"}, status: {type: "string"}, setup: {type: "string"}, run: {type: "string"}, checkFit: {type: "string"}, prompt: {type: "string"}}, required: ["contract", "status", "setup", "run", "checkFit", "prompt"]},
        progress: { type: "boolean" },
        layers: { type: "boolean" },
        camera: { type: "string", enum: ["bambu-tcp", "rtsp", "http-snapshot", "none"] },
        cameraStream: {type: "boolean"},
        filaments: { type: "string", enum: ["ams", "single", "none"] },
        pause: { type: "boolean" },
        resume: { type: "boolean" },
        cancel: { type: "boolean" },
        print3mf: { type: "boolean" },
        gcode: { type: "boolean" },
        slicing: {
          type: "object",
          required: ["supports", "copies", "orient"],
          properties: { supports: { type: "boolean" }, copies: { type: "boolean" }, orient: { type: "boolean" } },
        },
      },
    },
  },
} as const;

/** outputSchema for counterpart_print_progress (PRD §8.4). */
export const PRINT_PROGRESS_OUTPUT_SCHEMA = {
  type: "object",
  required: ["contract", "observedAt", "state", "problems"],
  properties: {
    physical: PHYSICAL_EVIDENCE_SCHEMA,
    contract: { type: "string", const: COUNTERPART_CONTRACT },
    observedAt: { type: "string" },
    state: { type: "string", enum: [...PROGRESS_STATES] },
    job: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string" },
        id: { type: "string" },
        progress: { type: "number", minimum: 0, maximum: 100 },
        elapsedSec: { type: "number", minimum: 0 },
        remainingSec: { type: "number", minimum: 0 },
        layer: { type: "number" },
        totalLayers: { type: "number" },
        stage: { type: "string" },
      },
    },
    temps: {
      type: "object",
      properties: { nozzle: heater, bed: heater, chamber: { type: "number" } },
    },
    activeFilament: {
      type: "object",
      properties: { slot: { type: "string" }, material: { type: "string" }, color: { type: "string" } },
    },
    problems: { type: "array", items: problem },
  },
} as const;

/** outputSchema for camera_snapshot; the result matches bambu-printer-mcp's plus capturedAt. */
export const CAMERA_SNAPSHOT_OUTPUT_SCHEMA = {
  type: "object",
  required: ["status", "format", "sizeBytes", "base64", "capturedAt"],
  properties: {
    status: { type: "string" },
    format: { type: "string" },
    sizeBytes: { type: "number" },
    base64: { type: "string" },
    savedTo: { type: "string" },
    capturedAt: { type: "string" },
    source: { type: "string" },
  },
} as const;

/**
 * outputSchema for get_printer_filaments: one external slot, or for Bambu every
 * loaded AMS tray and external spool plus bambu-printer-mcp's inventory fields
 * (trays, summary, recommended, load_filaments_all), which keep its nulls.
 */
export const FILAMENTS_OUTPUT_SCHEMA = {
  type: "object",
  required: ["slots"],
  properties: {
    trays: { type: "array", description: "Bambu only: bambu-printer-mcp's AMS tray list (slot = ams_id * 4 + tray_id), empty trays included.", items: { type: "object" } },
    slots: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "source"],
        properties: {
          id: { type: "string" },
          material: { type: "string" },
          color: { type: "string" },
          name: { type: "string", description: "The spool as a person names it (Bambu: its colour name and product, \"Sunflower Yellow PLA Basic\")." },
          label: { type: "string", description: "Where the spool sits, as a person reads it: \"A2\", \"AMS HT A\", \"External\", or \"Spool\" on a single-spool printer." },
          filamentId: { type: "string" },
          source: { type: "string", enum: ["spoolman", "printer", "unknown"] },
          profile: {
            type: "string",
            description: "Absolute path of the installed slicer filament profile for this slot's material, which slice_stl accepts as load_filaments. Omitted when none resolves.",
          },
        },
      },
    },
  },
} as const;

/** outputSchema for pause_print and resume_print. */
export const CONTROL_OUTPUT_SCHEMA = {
  type: "object",
  required: ["status", "message"],
  properties: {
    status: { type: "string" },
    message: { type: "string" },
    action: { type: "string", enum: ["pause", "resume"] },
    jobName: { type: "string" },
  },
} as const;

// ---- Value helpers: every optional number is finite or omitted. ----

export function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** A percentage clamped to 0–100, rounded to 0.1. */
export function percent(value: unknown): number | undefined {
  const number = finiteNumber(value);
  if (number === undefined) return undefined;
  return Math.round(Math.min(100, Math.max(0, number)) * 10) / 10;
}

/** Non-negative whole seconds. */
export function seconds(value: unknown): number | undefined {
  const number = finiteNumber(value);
  if (number === undefined || number < 0) return undefined;
  return Math.round(number);
}

/** A positive integer layer count or index. */
export function layerNumber(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number !== undefined && number > 0 ? Math.round(number) : undefined;
}

export function nonEmptyText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** {actual, target} when the actual reading is finite; a missing target means off (0). */
export function heaterReading(actual: unknown, target: unknown): HeaterReading | undefined {
  const value = finiteNumber(actual);
  if (value === undefined) return undefined;
  return { actual: Math.round(value * 10) / 10, target: Math.round((finiteNumber(target) ?? 0) * 10) / 10 };
}

/**
 * The job name the printer reports, reduced to its file name so it matches the
 * uploaded `jobName` (Duet reports 0:/gcodes/x.gcode, Klipper gcodes-relative paths).
 */
export function remoteJobName(value: unknown): string | undefined {
  const text = nonEmptyText(value);
  if (!text) return undefined;
  const name = path.posix.basename(text.replace(/\\/g, "/").replace(/^\d+:/, ""));
  return name || undefined;
}

/** Remove undefined members recursively so results never carry null/undefined fields. */
export function compact<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => compact(entry)) as unknown as T;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined && entry !== null && !(typeof entry === "number" && !Number.isFinite(entry)))
      .map(([key, entry]) => [key, compact(entry)]);
    return Object.fromEntries(entries.filter(([, entry]) =>
      !(entry && typeof entry === "object" && !Array.isArray(entry) && Object.keys(entry as object).length === 0)
    )) as T;
  }
  return value;
}

export function progressResult(
  observedAt: string,
  state: ProgressState,
  parts: Omit<Partial<CounterpartProgress>, "contract" | "observedAt" | "state">
): CounterpartProgress {
  return compact({
    contract: COUNTERPART_CONTRACT,
    observedAt,
    state,
    job: parts.job,
    temps: parts.temps,
    activeFilament: parts.activeFilament,
    problems: parts.problems ?? [],
  }) as CounterpartProgress;
}
