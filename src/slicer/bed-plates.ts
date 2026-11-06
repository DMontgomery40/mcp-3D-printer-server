/**
 * A model bigger than the printer's bed, split across plates (Counterpart PRD §5.5, "Plates of an imported 3MF").
 *
 * A downloaded kit is often one STL holding every part, laid out in the designer's plate groups side by side, so it
 * is wider than any bed and Bambu Studio refuses it ("One of the plate is empty or has no object fully inside it").
 * Here the model is split into its bodies (connected triangle components, each kept whole), bodies that sit close
 * together in the file stay together as the designer laid them out, and the groups are arranged across as many
 * plates as the bed needs, clear of the machine preset's excluded areas. A group that doesn't fit one plate is
 * arranged body by body. A body larger than the bed is named, with its size against the bed's.
 *
 * The result is a Bambu Studio / OrcaSlicer project 3MF: one object per body, each plate listing its objects in
 * Metadata/model_settings.config and placed where the slicer's plate grid puts that plate. The same model and bed
 * always give the same bytes, so a client keeps one copy and the slice cache recognises it.
 */
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { resolveBblMachineProfile } from "./profile-flatten.js";

export interface Rect { x: number; y: number; w: number; d: number }

/** The printable bed in its own coordinates: its rectangle, height, and the areas nothing may be placed on. */
export interface Bed { x: number; y: number; width: number; depth: number; height: number; excluded: Rect[] }

/** A plate of the split file, in the shape clients use for a designer's plates: zero-based index, name, objects. */
export interface SplitPlate { index: number; name: string; objects: string[] }

export type BedSplit =
  | { fits: true }
  | { fits: false; too_large: { name: string; size_mm: number[] }[]; bed_mm: number[]; message: string }
  | { fits: false; three_mf_path: string; plates: SplitPlate[]; bed_mm: number[]; message: string };

export class BedSplitError extends Error {}

/** Room between bodies, and from the bed's edges and excluded areas, when there is room for it. */
const SPACING_MM = 6;
const EDGE_MM = 2;
/** Bodies this close in the file are one group of the designer's (a plate's parts sit a few mm apart). */
const GROUP_GAP_MM = 20;
/** Bambu Studio's and OrcaSlicer's plate grid: LOGICAL_PART_PLATE_GAP is a fifth of the plate. */
const PLATE_GAP = 1 / 5;
const MAX_MODEL_BYTES = 512 * 1024 * 1024;
const MAX_TRIANGLES = 10_000_000;
const MAX_PLATES = 36;
/** Fixed entry dates, so the same split is the same bytes. */
const ZIP_DATE = new Date(Date.UTC(2026, 0, 1));

const mm = (value: number) => {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
};

// ---------------------------------------------------------------- the bed

function points(value: unknown): [number, number][] {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return list.flatMap(entry => {
    const [x, y] = String(entry).trim().split("x").map(Number);
    return Number.isFinite(x) && Number.isFinite(y) ? [[x, y] as [number, number]] : [];
  });
}

function inside(polygon: [number, number][], x: number, y: number): boolean {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) result = !result;
  }
  return result;
}

/** A polygon as rectangles: the cells of its own coordinate grid whose centres lie inside it. */
function polygonRects(polygon: [number, number][]): Rect[] {
  if (polygon.length < 3) return [];
  const xs = [...new Set(polygon.map(p => p[0]))].sort((a, b) => a - b);
  const ys = [...new Set(polygon.map(p => p[1]))].sort((a, b) => a - b);
  const rects: Rect[] = [];
  for (let i = 0; i + 1 < xs.length; i++) for (let j = 0; j + 1 < ys.length; j++) {
    if (inside(polygon, (xs[i] + xs[i + 1]) / 2, (ys[j] + ys[j + 1]) / 2)) rects.push({ x: xs[i], y: ys[j], w: xs[i + 1] - xs[i], d: ys[j + 1] - ys[j] });
  }
  return rects;
}

const first = (value: unknown) => Array.isArray(value) ? value[0] : value;

/**
 * The bed of a resolved (flattened) machine preset: printable_area, bed_exclude_area and printable_height, as
 * Bambu Studio and OrcaSlicer define them. Without a printable_area, `fallback` ([width, depth, height]) is used.
 */
export function bedFromMachine(machine: Record<string, unknown> | undefined, fallback?: readonly number[]): Bed {
  const area = points(machine?.printable_area);
  const height = Number(first(machine?.printable_height));
  if (area.length >= 3) {
    const xs = area.map(p => p[0]), ys = area.map(p => p[1]);
    const x = Math.min(...xs), y = Math.min(...ys);
    const excluded = polygonRects(points(machine?.bed_exclude_area));
    return { x, y, width: Math.max(...xs) - x, depth: Math.max(...ys) - y,
      height: Number.isFinite(height) && height > 0 ? height : fallback?.[2] ?? Infinity, excluded };
  }
  if (!fallback || fallback.length < 2) throw new BedSplitError("The printer's bed size is unknown, so the model can't be arranged on plates.");
  return { x: 0, y: 0, width: fallback[0], depth: fallback[1], height: fallback[2] ?? Infinity, excluded: [] };
}

/**
 * The bed of the exact machine preset a slice uses (`Bambu Lab P1S 0.4 nozzle`), from the selected profile tree.
 * When that preset can't be read, the model's build volume stands in, without excluded areas, and says so on stderr.
 */
export async function machineBed(profilesRoot: string | undefined, preset: string | undefined, volume?: readonly number[]): Promise<Bed> {
  if (profilesRoot && preset) {
    try { return bedFromMachine(await resolveBblMachineProfile(profilesRoot, preset), volume); }
    catch (error) { console.error(`split_to_plates: could not read the ${preset} preset's bed (${error instanceof Error ? error.message : String(error)}); using the model's build volume.`); }
  }
  return bedFromMachine(undefined, volume);
}

// ---------------------------------------------------------------- the model

/** Triangle corners, nine floats per triangle. */
async function readTriangles(filePath: string): Promise<Float32Array> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_MODEL_BYTES) throw new BedSplitError("The model must be a non-empty file of at most 512 MiB.");
  const bytes = await fs.readFile(filePath);
  const extension = path.extname(filePath).toLowerCase();
  let positions: Float32Array;
  if (extension === ".obj") positions = objTriangles(bytes.toString("utf8"));
  else if (extension === ".stl") {
    const geometry = new STLLoader().parse(Uint8Array.from(bytes).buffer);
    positions = Float32Array.from(geometry.getAttribute("position").array as Float32Array);
    geometry.dispose();
  } else throw new BedSplitError("Only an STL or OBJ model can be split across plates.");
  if (positions.length < 9 || positions.length % 9 !== 0) throw new BedSplitError("The model has no triangles.");
  if (positions.length / 9 > MAX_TRIANGLES) throw new BedSplitError(`The model has more than ${MAX_TRIANGLES} triangles.`);
  for (const value of positions) if (!Number.isFinite(value)) throw new BedSplitError("The model has a vertex that isn't a finite number.");
  return positions;
}

/** OBJ vertices and faces (polygons as triangle fans; negative indices count back). Other statements are ignored. */
export function objTriangles(text: string): Float32Array {
  const vertices: number[] = [];
  const out: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("v ")) {
      const [x, y, z] = line.slice(2).trim().split(/\s+/).map(Number);
      vertices.push(x, y, z);
    } else if (line.startsWith("f ")) {
      const count = vertices.length / 3;
      const corners = line.slice(2).trim().split(/\s+/).map(token => {
        const index = Number.parseInt(token.split("/")[0], 10);
        const resolved = index < 0 ? count + index : index - 1;
        if (!Number.isInteger(resolved) || resolved < 0 || resolved >= count) throw new BedSplitError("The OBJ file has a face with a missing vertex.");
        return resolved;
      });
      for (let i = 1; i + 1 < corners.length; i++) for (const corner of [corners[0], corners[i], corners[i + 1]])
        out.push(vertices[corner * 3], vertices[corner * 3 + 1], vertices[corner * 3 + 2]);
    }
  }
  return Float32Array.from(out);
}

interface Body { triangles: Uint32Array; min: number[]; max: number[] }

/** Connected components: triangles that share a vertex (bit-identical position) are one body. */
function bodiesOf(positions: Float32Array): Body[] {
  const triangleCount = positions.length / 9;
  const bits = new Uint32Array(positions.buffer, positions.byteOffset, positions.length);
  const ids = new Map<string, number>();
  const corner = new Uint32Array(triangleCount * 3);
  for (let i = 0; i < triangleCount * 3; i++) {
    const key = `${bits[i * 3]},${bits[i * 3 + 1]},${bits[i * 3 + 2]}`;
    let id = ids.get(key);
    if (id === undefined) { id = ids.size; ids.set(key, id); }
    corner[i] = id;
  }
  const parent = new Int32Array(ids.size);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (x: number) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let t = 0; t < triangleCount; t++) {
    const a = find(corner[t * 3]);
    parent[find(corner[t * 3 + 1])] = a;
    parent[find(corner[t * 3 + 2])] = a;
  }
  const byRoot = new Map<number, number[]>();
  for (let t = 0; t < triangleCount; t++) {
    const root = find(corner[t * 3]);
    let list = byRoot.get(root);
    if (!list) { list = []; byRoot.set(root, list); }
    list.push(t);
  }
  return [...byRoot.values()].map(list => {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const t of list) for (let k = 0; k < 9; k++) {
      const value = positions[t * 9 + k], axis = k % 3;
      if (value < min[axis]) min[axis] = value;
      if (value > max[axis]) max[axis] = value;
    }
    return { triangles: Uint32Array.from(list), min, max };
  });
}

/** Single-linkage groups of footprints whose gap is at most `gap` (or that overlap). */
function groupsOf<T extends { min: number[]; max: number[] }>(items: T[], linked: (a: T, b: T) => boolean): T[][] {
  const parent = items.map((_, i) => i);
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const order = items.map((_, i) => i).sort((a, b) => items[a].min[0] - items[b].min[0]);
  for (let i = 0; i < order.length; i++) {
    const a = items[order[i]];
    for (let j = i + 1; j < order.length; j++) {
      const b = items[order[j]];
      if (b.min[0] - a.max[0] > GROUP_GAP_MM) break;
      if (linked(a, b)) parent[find(order[i])] = find(order[j]);
    }
  }
  const groups = new Map<number, T[]>();
  items.forEach((item, i) => {
    const root = find(i);
    const group = groups.get(root);
    if (group) group.push(item); else groups.set(root, [item]);
  });
  return [...groups.values()];
}

const gap = (a: { min: number[]; max: number[] }, b: { min: number[]; max: number[] }) =>
  Math.max(0, a.min[0] - b.max[0], b.min[0] - a.max[0], a.min[1] - b.max[1], b.min[1] - a.max[1]);
/** One footprint mostly over another: a part inside or around another (print-in-place) is never pulled apart. */
const nested = (a: { min: number[]; max: number[] }, b: { min: number[]; max: number[] }) => {
  const w = Math.min(a.max[0], b.max[0]) - Math.max(a.min[0], b.min[0]);
  const d = Math.min(a.max[1], b.max[1]) - Math.max(a.min[1], b.min[1]);
  if (w <= 0 || d <= 0) return false;
  const area = (box: { min: number[]; max: number[] }) => (box.max[0] - box.min[0]) * (box.max[1] - box.min[1]);
  return w * d >= 0.5 * Math.min(area(a), area(b));
};

interface Unit { bodies: Body[]; min: number[]; max: number[] }
const unitOf = (bodies: Body[]): Unit => ({ bodies,
  min: [0, 1, 2].map(axis => Math.min(...bodies.map(body => body.min[axis]))),
  max: [0, 1, 2].map(axis => Math.max(...bodies.map(body => body.max[axis]))) });

// ---------------------------------------------------------------- packing

/** MaxRects free-space bookkeeping for one plate. */
class Plate {
  free: Rect[];
  placed: { unit: Unit; x: number; y: number; rotated: boolean }[] = [];
  constructor(bed: Bed, readonly inset: number, readonly pad: number) {
    // The bed grown by half the spacing, less the edge margin: a padded footprint keeps both distances.
    const grow = pad / 2 - inset;
    this.free = [{ x: bed.x - grow, y: bed.y - grow, w: bed.width + 2 * grow, d: bed.depth + 2 * grow }];
    for (const area of bed.excluded) this.occupy({ x: area.x - pad / 2, y: area.y - pad / 2, w: area.w + pad, d: area.d + pad });
  }
  /** The best-short-side fit for a w × d footprint, either way round. */
  find(w: number, d: number, turns: readonly boolean[] = [false, true]): { x: number; y: number; rotated: boolean } | undefined {
    let best: { x: number; y: number; rotated: boolean; score: number; long: number } | undefined;
    for (const rect of this.free) for (const rotated of turns) {
      const [fw, fd] = rotated ? [d + this.pad, w + this.pad] : [w + this.pad, d + this.pad];
      if (fw > rect.w + 1e-6 || fd > rect.d + 1e-6) continue;
      const score = Math.min(rect.w - fw, rect.d - fd), long = Math.max(rect.w - fw, rect.d - fd);
      if (!best || score < best.score - 1e-9 || (Math.abs(score - best.score) <= 1e-9 && long < best.long)) best = { x: rect.x, y: rect.y, rotated, score, long };
    }
    return best && { x: best.x, y: best.y, rotated: best.rotated };
  }
  place(unit: Unit, at: { x: number; y: number; rotated: boolean }) {
    const w = unit.max[0] - unit.min[0], d = unit.max[1] - unit.min[1];
    const [fw, fd] = at.rotated ? [d + this.pad, w + this.pad] : [w + this.pad, d + this.pad];
    this.occupy({ x: at.x, y: at.y, w: fw, d: fd });
    this.placed.push({ unit, x: at.x + this.pad / 2, y: at.y + this.pad / 2, rotated: at.rotated });
  }
  occupy(used: Rect) {
    const next: Rect[] = [];
    for (const rect of this.free) {
      if (used.x >= rect.x + rect.w || used.x + used.w <= rect.x || used.y >= rect.y + rect.d || used.y + used.d <= rect.y) { next.push(rect); continue; }
      if (used.x > rect.x) next.push({ x: rect.x, y: rect.y, w: used.x - rect.x, d: rect.d });
      if (used.x + used.w < rect.x + rect.w) next.push({ x: used.x + used.w, y: rect.y, w: rect.x + rect.w - used.x - used.w, d: rect.d });
      if (used.y > rect.y) next.push({ x: rect.x, y: rect.y, w: rect.w, d: used.y - rect.y });
      if (used.y + used.d < rect.y + rect.d) next.push({ x: rect.x, y: used.y + used.d, w: rect.w, d: rect.y + rect.d - used.y - used.d });
    }
    this.free = next.filter((a, i) => a.w > 1e-6 && a.d > 1e-6 && !next.some((b, j) => j !== i
      && a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.d <= b.y + b.d && (j < i || a.x !== b.x || a.y !== b.y || a.w !== b.w || a.d !== b.d)));
  }
}

const footprint = (unit: Unit) => [unit.max[0] - unit.min[0], unit.max[1] - unit.min[1]];
/** Whether a unit fits an empty bed at all: no margins, either way round, and under the printable height. */
const fitsBed = (unit: Unit, bed: Bed) => unit.max[2] - unit.min[2] <= bed.height + 1e-6
  && new Plate(bed, 0, 0).find(footprint(unit)[0], footprint(unit)[1]) !== undefined;

function pack(units: Unit[], bed: Bed): Plate[] {
  const plates: Plate[] = [];
  const sorted = [...units].sort((a, b) => footprint(b)[0] * footprint(b)[1] - footprint(a)[0] * footprint(a)[1] || a.min[1] - b.min[1] || a.min[0] - b.min[0]);
  for (const unit of sorted) {
    const [w, d] = footprint(unit);
    let done = false;
    for (const plate of plates) {
      if (plate.inset === 0) continue;
      const at = plate.find(w, d);
      if (at) { plate.place(unit, at); done = true; break; }
    }
    if (done) continue;
    // A new plate with margins, else this unit alone on a plate without them.
    let plate = new Plate(bed, EDGE_MM, SPACING_MM);
    let at = plate.find(w, d);
    if (!at) { plate = new Plate(bed, 0, 0); at = plate.find(w, d); }
    if (!at) throw new BedSplitError("A part that fits the bed could not be placed.");
    plate.place(unit, at);
    plates.push(plate);
  }
  return plates;
}

// ---------------------------------------------------------------- the 3MF

function xmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}
const coordinate = (value: number) => String(Number(value.toPrecision(9)));

/** One object of the 3MF: a body, with any shells inside or around it (a hollow part's cavity) in the same mesh. */
interface Placed { name: string; plate: number; bodies: Body[]; transform: (x: number, y: number, z: number) => [number, number, number] }

function modelXml(positions: Float32Array, objects: Placed[]): { xml: Buffer; centres: [number, number][] } {
  const chunks: Buffer[] = [];
  let pending: string[] = [];
  const write = (line: string) => {
    pending.push(line);
    if (pending.length >= 20_000) { chunks.push(Buffer.from(pending.join(""))); pending = []; }
  };
  write(`<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021">\n`);
  write(` <metadata name="Application">mcp-3d-printer-server split_to_plates</metadata>\n <metadata name="BambuStudio:3mfVersion">1</metadata>\n <resources>\n`);
  const centres: [number, number][] = [];
  objects.forEach((object, index) => {
    // Vertices relative to the body's footprint centre on its plate; the build item carries the position.
    const corners: [number, number, number][] = [];
    const lookup = new Map<string, number>();
    const triangles: number[] = [];
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const body of object.bodies) for (const t of body.triangles) for (let k = 0; k < 3; k++) {
      const o = t * 9 + k * 3;
      const key = `${positions[o]},${positions[o + 1]},${positions[o + 2]}`;
      let id = lookup.get(key);
      if (id === undefined) {
        id = corners.length;
        lookup.set(key, id);
        const p = object.transform(positions[o], positions[o + 1], positions[o + 2]);
        corners.push(p);
        if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
        if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
      }
      triangles.push(id);
    }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    centres.push([cx, cy]);
    write(`  <object id="${index * 2 + 1}" type="model">\n   <mesh>\n    <vertices>\n`);
    for (const [x, y, z] of corners) write(`     <vertex x="${coordinate(x - cx)}" y="${coordinate(y - cy)}" z="${coordinate(z)}"/>\n`);
    write(`    </vertices>\n    <triangles>\n`);
    for (let i = 0; i < triangles.length; i += 3) write(`     <triangle v1="${triangles[i]}" v2="${triangles[i + 1]}" v3="${triangles[i + 2]}"/>\n`);
    write(`    </triangles>\n   </mesh>\n  </object>\n`);
    write(`  <object id="${index * 2 + 2}" type="model">\n   <components>\n    <component objectid="${index * 2 + 1}"/>\n   </components>\n  </object>\n`);
  });
  write(` </resources>\n <build>\n`);
  objects.forEach((_, index) => write(`  <item objectid="${index * 2 + 2}" transform="1 0 0 0 1 0 0 0 1 ${coordinate(centres[index][0])} ${coordinate(centres[index][1])} 0" printable="1"/>\n`));
  write(` </build>\n</model>\n`);
  chunks.push(Buffer.from(pending.join("")));
  return { xml: Buffer.concat(chunks), centres };
}

function modelSettingsXml(objects: Placed[], plateCount: number): string {
  const blocks = objects.map((object, index) => `  <object id="${index * 2 + 2}">
    <metadata key="name" value="${xmlText(object.name)}"/>
    <metadata key="extruder" value="1"/>
    <part id="${index * 2 + 1}" subtype="normal_part">
      <metadata key="name" value="${xmlText(object.name)}"/>
    </part>
  </object>`);
  const plates = Array.from({ length: plateCount }, (_, plate) => `  <plate>
    <metadata key="plater_id" value="${plate + 1}"/>
    <metadata key="plater_name" value=""/>
    <metadata key="locked" value="false"/>
${objects.map((object, index) => object.plate !== plate ? "" : `    <model_instance>
      <metadata key="object_id" value="${index * 2 + 2}"/>
      <metadata key="instance_id" value="0"/>
      <metadata key="identify_id" value="${1000 + index}"/>
    </model_instance>
`).join("")}  </plate>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<config>\n${blocks.join("\n")}\n${plates.join("\n")}\n</config>\n`;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="config" ContentType="application/octet-stream"/>
</Types>
`;
const RELATIONSHIPS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
`;

/** Columns of the slicer's plate grid: the rounded-up square root of the plate count. */
export function plateColumns(count: number): number {
  const root = Math.sqrt(count), rounded = Math.round(root);
  return root > rounded ? rounded + 1 : rounded;
}

// ---------------------------------------------------------------- the split

/**
 * Split `modelPath` across plates of `bed` when it doesn't fit as it is. `printer` names the printer in the
 * sentences ("the P1S bed"); `outPath` is where the multi-plate 3MF is written (replaced if present).
 */
export async function splitToPlates(options: { modelPath: string; outPath: string; bed: Bed; printer?: string }): Promise<BedSplit> {
  const { bed } = options;
  const positions = await readTriangles(options.modelPath);
  const whole = bodiesOf(positions);
  const bedName = `${options.printer ? `the ${options.printer} bed` : "the bed"} (${mm(bed.width)} × ${mm(bed.depth)} mm${Number.isFinite(bed.height) ? `, ${mm(bed.height)} mm tall` : ""})`;
  const bedMm = [bed.width, bed.depth, ...(Number.isFinite(bed.height) ? [bed.height] : [])];
  // The model as it is, one piece, unturned and under the printable height: the slicer arranges it.
  const all = unitOf(whole);
  if (new Plate(bed, 0, 0).find(footprint(all)[0], footprint(all)[1], [false]) && all.max[2] - all.min[2] <= bed.height + 1e-6) return { fits: true };

  // Parts numbered from the back of the layout (to the nearest mm), then left to right.
  whole.sort((a, b) => Math.round(b.max[1] - a.max[1]) || a.min[0] - b.min[0]);
  const names = new Map(whole.map((body, index) => [body, `Part ${index + 1}`]));
  const units: Unit[] = [];
  const tooLarge: { name: string; size_mm: number[] }[] = [];
  for (const group of groupsOf(whole, (a, b) => gap(a, b) <= GROUP_GAP_MM).map(unitOf)) {
    if (fitsBed(group, bed)) { units.push(group); continue; }
    // A group too big for one plate goes body by body, keeping parts nested in each other together where they fit.
    for (const unit of groupsOf(group.bodies, nested).map(unitOf)) {
      if (fitsBed(unit, bed)) { units.push(unit); continue; }
      for (const body of unit.bodies.map(body => unitOf([body]))) {
        if (fitsBed(body, bed)) { units.push(body); continue; }
        const size = [0, 1, 2].map(axis => Math.round((body.max[axis] - body.min[axis]) * 10) / 10);
        tooLarge.push({ name: names.get(body.bodies[0])!, size_mm: size });
      }
    }
  }
  if (tooLarge.length) {
    const said = tooLarge.slice(0, 3).map(item => `${item.name} is ${mm(item.size_mm[0])} × ${mm(item.size_mm[1])} mm and ${mm(item.size_mm[2])} mm tall`);
    const message = `${said.join("; ")}${tooLarge.length > 3 ? `; and ${tooLarge.length - 3} more` : ""}, larger than ${bedName}, so ${tooLarge.length === 1 ? "it" : "they"} can't be printed on it as ${tooLarge.length === 1 ? "it is" : "they are"}. Scale ${tooLarge.length === 1 ? "it" : "them"} down or cut ${tooLarge.length === 1 ? "it" : "them"} into pieces that fit.`;
    return { fits: false, too_large: tooLarge, bed_mm: bedMm, message };
  }
  const plates = pack(units, bed);
  if (plates.length > MAX_PLATES) throw new BedSplitError(`This model needs more than ${MAX_PLATES} plates.`);
  // Plates in the file's reading order of their first part.
  const firstPart = (plate: Plate) => Math.min(...plate.placed.flatMap(item => item.unit.bodies.map(body => whole.indexOf(body))));
  plates.sort((a, b) => firstPart(a) - firstPart(b));
  const columns = plateColumns(plates.length);
  const placed: Placed[] = [];
  plates.forEach((plate, plateIndex) => {
    const offsetX = (plateIndex % columns) * bed.width * (1 + PLATE_GAP);
    const offsetY = -Math.floor(plateIndex / columns) * bed.depth * (1 + PLATE_GAP);
    for (const item of plate.placed) {
      const { min } = item.unit;
      const depth = item.unit.max[1] - min[1];
      // Turned a quarter anticlockwise when rotated: (x, y) → (depth - y, x) within the footprint.
      const transform = (x: number, y: number, z: number): [number, number, number] => {
        const lx = x - min[0], ly = y - min[1];
        const [px, py] = item.rotated ? [depth - ly, lx] : [lx, ly];
        return [offsetX + item.x + px, offsetY + item.y + py, z - min[2]];
      };
      // Shells nested in each other stay one mesh, as in the model: a cavity shell keeps making its part hollow.
      for (const shells of groupsOf(item.unit.bodies, nested)) {
        const sorted = [...shells].sort((a, b) => whole.indexOf(a) - whole.indexOf(b));
        placed.push({ name: names.get(sorted[0])!, plate: plateIndex, bodies: sorted, transform });
      }
    }
  });
  placed.sort((a, b) => a.plate - b.plate || whole.indexOf(a.bodies[0]) - whole.indexOf(b.bodies[0]));
  const { xml } = modelXml(positions, placed);
  const zip = new JSZip();
  // No folder entries: JSZip would stamp them with the current time, and the bytes would differ.
  const entry = { date: ZIP_DATE, createFolders: false };
  zip.file("[Content_Types].xml", CONTENT_TYPES, entry);
  zip.file("_rels/.rels", RELATIONSHIPS, entry);
  zip.file("3D/3dmodel.model", xml, entry);
  zip.file("Metadata/model_settings.config", modelSettingsXml(placed, plates.length), entry);
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
  // Written whole, then renamed into place: a concurrent split of the same model writes the same bytes.
  const staged = `${options.outPath}.${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    await fs.writeFile(staged, bytes);
    await fs.rename(staged, options.outPath);
  } finally {
    await fs.rm(staged, { force: true }).catch(() => {});
  }
  const splitPlates: SplitPlate[] = plates.map((_, index) => ({ index, name: `Plate ${index + 1}`,
    objects: placed.filter(object => object.plate === index).map(object => object.name) }));
  return { fits: false, three_mf_path: options.outPath, plates: splitPlates, bed_mm: bedMm,
    message: `This model is bigger than ${bedName}, so its ${whole.length} parts are arranged on ${plates.length} plates. Each plate prints on its own.` };
}
