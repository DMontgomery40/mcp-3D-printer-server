import fs from "node:fs";
import { loadSafe3mfArchive, readBoundedPrintFile } from "../safety/archive.js";

/**
 * What a client shows about a sliced file, read here so it never parses slicer formats itself (Counterpart PRD
 * §8.0 item 9): the selected plate's estimate and slice settings, and how many printable plates the file has.
 * Bambu Studio and OrcaSlicer 3MFs carry them in Metadata/slice_info.config, project_settings.config and the
 * plate's G-code header; a G-code file in its own header and footer comments. Anything not found is left out.
 */
export interface SlicedFileFacts {
  plate_count?: number;
  estimate?: { seconds?: number; grams?: number };
  settings: { layer_height_mm?: number; sparse_infill_percent?: number; wall_loops?: number; layer_count?: number };
}

const number = (value: unknown): number | undefined => {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};
const first = (value: unknown) => Array.isArray(value) ? value[0] : value;
const defined = <T extends Record<string, unknown>>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;

function headerSettings(text: string): SlicedFileFacts["settings"] {
  const read = (pattern: RegExp) => number(text.match(pattern)?.[1]);
  const layers = read(/^;\s*(?:total layer number|total layers count|LAYER_COUNT)\s*[:=]\s*(\d+)/im);
  const walls = read(/^;\s*(?:wall_loops|perimeters)\s*=\s*(\d+)/im);
  return defined({
    layer_height_mm: read(/^;\s*layer_height\s*=\s*([\d.]+)/im),
    sparse_infill_percent: read(/^;\s*(?:sparse_infill_density|fill_density)\s*=\s*([\d.]+)%/im),
    wall_loops: walls === undefined ? undefined : Math.trunc(walls),
    layer_count: layers ? Math.trunc(layers) : undefined,
  });
}

/** The facts of a sliced 3MF or G-code file for one zero-based plate; what can't be read is left out, never an error. */
export async function slicedFileFacts(filePath: string, plateIndex = 0): Promise<SlicedFileFacts> {
  try { return await readFacts(filePath, plateIndex); } catch { return { settings: {} }; }
}

async function readFacts(filePath: string, plateIndex: number): Promise<SlicedFileFacts> {
  const head = Buffer.alloc(4);
  const handle = await fs.promises.open(filePath, "r");
  try { await handle.read(head, 0, 4, 0); } finally { await handle.close(); }
  if (head[0] !== 0x50 || head[1] !== 0x4b) {
    // G-code: PrusaSlicer and Orca write their settings in a footer, others in a header; read both ends.
    const stat = await fs.promises.stat(filePath);
    const size = 256 * 1024;
    const read = async (start: number) => {
      const buffer = Buffer.alloc(Math.min(size, stat.size));
      const file = await fs.promises.open(filePath, "r");
      try { await file.read(buffer, 0, buffer.length, start); } finally { await file.close(); }
      return buffer.toString("latin1");
    };
    return { plate_count: 1, settings: headerSettings(`${await read(0)}\n${await read(Math.max(0, stat.size - size))}`) };
  }
  const zip = await loadSafe3mfArchive(await readBoundedPrintFile(filePath));
  const plates = new Set(Object.keys(zip.files).flatMap(name => /^Metadata\/plate_([1-9]\d*)\.gcode$/.exec(name)?.[1] ?? []));
  const text = async (name: string) => zip.file(name)?.async("string");
  let settings: SlicedFileFacts["settings"] = {};
  const project = await text("Metadata/project_settings.config");
  if (project) {
    try {
      const values = JSON.parse(project) as Record<string, unknown>;
      const infill = String(first(values.sparse_infill_density) ?? "");
      const walls = number(first(values.wall_loops));
      settings = defined({
        layer_height_mm: number(first(values.layer_height)),
        sparse_infill_percent: infill === "" ? undefined : number(infill.replace("%", "")),
        wall_loops: walls === undefined ? undefined : Math.trunc(walls),
      });
    } catch { /* the settings stay unknown */ }
  }
  // Only the plate G-code's header, never the whole (often hundreds of MB) as a string.
  const gcode = await zip.file(`Metadata/plate_${plateIndex + 1}.gcode`)?.async("nodebuffer");
  // The project settings are authoritative; the plate's G-code header adds the layer count.
  if (gcode) settings = { ...headerSettings(gcode.subarray(0, 64 * 1024).toString("latin1")), ...settings };
  let estimate: SlicedFileFacts["estimate"];
  const info = await text("Metadata/slice_info.config");
  const plate = info?.match(/<plate(?:\s[^>]*)?>[\s\S]*?<\/plate>/g)
    ?.find(block => new RegExp(`<metadata\\s+key=["']index["']\\s+value=["']${plateIndex + 1}["']`).test(block));
  if (plate) {
    const value = (key: string) => {
      const found = plate.match(new RegExp(`<metadata\\s+key=["']${key}["']\\s+value=["']([^"']+)["']`))?.[1];
      const parsed = found && /^\d+(?:\.\d+)?$/.test(found) ? Number(found) : undefined;
      return parsed !== undefined && parsed > 0 ? parsed : undefined;
    };
    const seconds = value("prediction"), grams = value("weight");
    if (seconds !== undefined || grams !== undefined) estimate = defined({ seconds, grams });
  }
  return { ...(plates.size ? { plate_count: plates.size } : {}), ...(estimate ? { estimate } : {}), settings };
}

/**
 * Bambu Studio's (or OrcaSlicer's) verdict on a slice, from its result.json: whether it failed, its own words
 * (the error and every plate's warning, verbatim), and how many plates it sliced.
 */
export interface SlicerReport { failed: boolean; message?: string; plate_count?: number }

const clean = (text: string) => text.replace(/\r\n?/g, "\n").replace(/[\x00-\x09\x0b-\x1f\x7f]/g, " ").trim();

export function slicerReport(result: unknown): SlicerReport | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  const value = result as { return_code?: unknown; error_string?: unknown; sliced_plates?: unknown };
  const plates = Array.isArray(value.sliced_plates) ? value.sliced_plates as Record<string, unknown>[] : [];
  const ids = plates.map(plate => plate && typeof plate === "object" ? plate.id : undefined);
  const plateCount = ids.length && ids.every(id => typeof id === "number" && Number.isSafeInteger(id) && id > 0) ? new Set(ids).size : undefined;
  const warnings = plates.map(plate => plate && typeof plate.warning_message === "string" ? clean(plate.warning_message) : "").filter(Boolean);
  // Anything but the slicer's success code fails closed, a missing one included.
  const failed = value.return_code !== 0;
  const error = typeof value.error_string === "string" ? clean(value.error_string) : "";
  const words = [...new Set([...(failed && error ? [error] : []), ...warnings])].join("\n").slice(0, 2000);
  if (failed) return { failed, message: words || `The slicer could not slice this model (return code ${String(value.return_code)}).` };
  return { failed, ...(words ? { message: words } : {}), ...(plateCount ? { plate_count: plateCount } : {}) };
}
