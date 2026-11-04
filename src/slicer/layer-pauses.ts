import fs from "node:fs";
import JSZip from "jszip";

/**
 * Pause-at-layer for Bambu-compatible slicer CLIs ("Add pause" in Bambu Studio
 * and OrcaSlicer). The slicer writes the machine's own machine_pause_gcode
 * (M400 U1 on Bambu printers) before the chosen layer, so the printer pauses
 * by itself there and waits for Resume; no remote command is involved.
 *
 * The CLI takes these as --load-custom-gcodes <json> (CustomGCode::Info). It
 * does not apply the pauses a project 3MF already carries in
 * Metadata/custom_gcode_per_print_z.xml, so those are read here and passed the
 * same way. A pause's print_z must be the exact top of its layer: a height
 * between layers lands on the layer below.
 */

/** CustomGCode::Type, in the order bbs_3mf.cpp writes it as an integer. */
const CUSTOM_GCODE_TYPES = ["ColorChange", "PausePrint", "ToolChange", "Template", "Custom", "Unknown"] as const;
export type CustomGcodeType = (typeof CUSTOM_GCODE_TYPES)[number];

export interface CustomGcodeItem {
  type: CustomGcodeType;
  print_z: number;
  color: string;
  extruder: number;
  extra: string;
}

export interface CustomGcodeInfo {
  mode: string;
  gcodes: CustomGcodeItem[];
}

/** 1-based layer numbers, as Bambu Studio's and OrcaSlicer's preview slider count them. */
export function parsePauseLayers(value: unknown): number[] | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const raw = Array.isArray(value) ? value : String(value).split(/[\s,;]+/).filter(Boolean);
  const layers = raw.map(entry => Number(entry));
  for (const layer of layers) {
    if (!Number.isInteger(layer) || layer < 2) {
      throw new Error(`pause_at_layers takes whole layer numbers of 2 or more (the printer cannot pause before layer 1), not ${JSON.stringify(value)}.`);
    }
  }
  const unique = [...new Set(layers)].sort((a, b) => a - b);
  return unique.length ? unique : undefined;
}

function xmlAttr(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return match ? match[1].replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") : undefined;
}

/**
 * The custom G-codes (pauses, colour changes, ...) a project 3MF stores for
 * one plate (1-based), as Bambu Studio and OrcaSlicer save them.
 */
export async function readProjectCustomGcodes(threeMfPath: string, plate = 1): Promise<CustomGcodeInfo | undefined> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(await fs.promises.readFile(threeMfPath));
  } catch {
    return undefined;
  }
  const file = zip.file(/^Metadata\/custom_gcode_per_print_z\.xml$/i)[0];
  if (!file) return undefined;
  const xml = await file.async("string");
  for (const block of xml.match(/<plate>[\s\S]*?<\/plate>/g) ?? []) {
    const info = /<plate_info\b[^>]*>/.exec(block)?.[0];
    if (Number(info ? xmlAttr(info, "id") : NaN) !== plate) continue;
    const gcodes: CustomGcodeItem[] = [];
    for (const tag of block.match(/<layer\b[^>]*>/g) ?? []) {
      const type = CUSTOM_GCODE_TYPES[Number(xmlAttr(tag, "type"))] ?? "Unknown";
      const printZ = Number(xmlAttr(tag, "top_z"));
      if (!Number.isFinite(printZ)) continue;
      gcodes.push({
        type,
        print_z: printZ,
        color: xmlAttr(tag, "color") ?? "",
        extruder: Number(xmlAttr(tag, "extruder") ?? 1) || 1,
        // Template and Custom keep their G-code text in "extra" (CustomGCode.hpp).
        extra: xmlAttr(tag, "extra") ?? "",
      });
    }
    const modeTag = /<mode\b[^>]*>/.exec(block)?.[0];
    return { mode: (modeTag && xmlAttr(modeTag, "value")) || "SingleExtruder", gcodes };
  }
  return undefined;
}

/** The plate's G-code text inside a sliced 3MF. */
export async function readPlateGcode(threeMfPath: string, plate = 1): Promise<string | undefined> {
  const zip = await JSZip.loadAsync(await fs.promises.readFile(threeMfPath));
  const exact = zip.file(`Metadata/plate_${plate}.gcode`);
  const file = exact ?? zip.file(/^Metadata\/plate_\d+\.gcode$/)[0];
  return file ? file.async("string") : undefined;
}

/** Each layer's top Z in order, from the slicer's "; Z_HEIGHT:" markers. */
export function layerTops(gcode: string): number[] {
  const tops: number[] = [];
  for (const match of gcode.matchAll(/^; Z_HEIGHT: ([0-9.]+)\s*$/gm)) tops.push(Number(match[1]));
  return tops;
}

/**
 * The 1-based layers whose block holds a pause: the slicer's "; PAUSE_PRINTING"
 * marker or the machine's pause G-code on its own line.
 */
export function pausedLayers(gcode: string, pauseGcode = "M400 U1"): number[] {
  const lines = gcode.split(/\r?\n/);
  const paused = new Set<number>();
  let layer = 0;
  const pauseLine = pauseGcode.trim();
  for (const line of lines) {
    if (line.startsWith("; Z_HEIGHT:")) { layer += 1; continue; }
    if (layer === 0) continue;
    const trimmed = line.trim();
    if (trimmed === "; PAUSE_PRINTING" || (pauseLine && trimmed === pauseLine)) paused.add(layer);
  }
  return [...paused].sort((a, b) => a - b);
}

/** The machine_pause_gcode a sliced file was made with (its config block), else Bambu's M400 U1. */
export function machinePauseGcode(gcode: string): string {
  const match = /^; machine_pause_gcode = (.*)$/m.exec(gcode);
  const value = match?.[1]?.split("\\n")[0]?.trim();
  return value || "M400 U1";
}

/** Project custom G-codes plus a pause before each requested layer, at that layer's exact top. */
export function customGcodesWithPauses(tops: number[], layers: number[], project?: CustomGcodeInfo): CustomGcodeInfo {
  const total = tops.length;
  const beyond = layers.filter(layer => layer > total);
  if (beyond.length) {
    throw new Error(`This print has ${total} layers, so it cannot pause before layer ${beyond.join(", ")}.`);
  }
  const pauses: CustomGcodeItem[] = layers.map(layer => ({ type: "PausePrint", print_z: tops[layer - 1], color: "", extruder: 1, extra: "" }));
  const kept = (project?.gcodes ?? []).filter(item => !(item.type === "PausePrint" && pauses.some(p => Math.abs(p.print_z - item.print_z) < 1e-4)));
  return {
    mode: project?.mode || "SingleExtruder",
    gcodes: [...kept, ...pauses].sort((a, b) => a.print_z - b.print_z),
  };
}
