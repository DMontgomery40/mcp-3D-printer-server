/**
 * counterpart_part_meshes (counterpart/1, scan-to-make #691 and #845): one STL per printable part of any 3MF, in its
 * filament's colour, so a client can draw a multi-colour design part by part, or show a designer's published 3MF in
 * AR, without reading 3MF itself.
 *
 * Plates, parts and filaments come from list_3mf_plates (model-plates.ts), so both tools agree on what a part is and
 * which filament it prints with. Each part is written in the 3MF's build frame, in millimetres: its component
 * transforms and its build item's transform applied, and the root model's unit converted, so the parts line up when drawn
 * together. Only bounded model text is read; nothing in the file is run. Shared by bambu-printer-mcp and
 * mcp-3D-printer-server.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type JSZip from "jszip";
import { readSafe3mfArchive } from "../safety/archive.js";
import { listModelPlates } from "./model-plates.js";
import { COUNTERPART_CONTRACT } from "./contract.js";

const MAX_MODEL_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_DEPTH = 8;
/** All the STLs one call writes, together: about 200 MB of binary STL. Parts beyond it are listed in skipped. */
const MAX_TOTAL_TRIANGLES = 4_000_000;
const ROOT = "3D/3dmodel.model";
const UNITS: Record<string, number> = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };

export class PartMeshesError extends Error {}
function fail(message: string): never { throw new PartMeshesError(message); }

export interface PartMesh {
  id: string;
  name: string;
  plate?: number;
  color?: string;
  filament?: number;
  painted?: true;
  stl_path: string;
  triangles: number;
  size_mm: [number, number, number];
}
export interface PartMeshes {
  contract: typeof COUNTERPART_CONTRACT;
  units: "mm";
  folder: string;
  parts: PartMesh[];
  skipped?: { id: string; name: string; reason: string }[];
}

/** A 3MF transform ("m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32", row vectors) as 12 numbers; identity when absent. */
function matrix(value: string | undefined): number[] {
  const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
  if (!value) return identity;
  const numbers = value.trim().split(/\s+/).map(Number);
  return numbers.length === 12 && numbers.every(Number.isFinite) ? numbers : fail(`A transform in the 3MF is malformed: "${value.slice(0, 80)}".`);
}
/** First a, then b (p' = (p a) b). */
function compose(a: number[], b: number[]): number[] {
  const out = new Array<number>(12);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++)
    out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c] + (r === 3 ? b[9 + c] : 0);
  return out;
}

type ModelFile = { scale: number; objects: Map<string, string> };

/** The model files, read once each within the byte budgets. */
function modelReader(zip: JSZip) {
  const files = new Map<string, ModelFile | string>();
  let total = 0;
  return async (name: string): Promise<ModelFile | string> => {
    const known = files.get(name);
    if (known !== undefined) return known;
    const file = zip.file(name);
    let result: ModelFile | string;
    if (!file) result = `the model part ${name} is missing from the file`;
    else {
      const bytes = await file.async("nodebuffer");
      total += bytes.length;
      if (bytes.length > MAX_MODEL_BYTES) result = `its model part ${name} is larger than ${MAX_MODEL_BYTES / 1024 / 1024} MiB`;
      else if (total > MAX_TOTAL_BYTES) result = `the 3MF's model parts are larger than ${MAX_TOTAL_BYTES / 1024 / 1024} MiB in all`;
      else {
        const text = bytes.toString("utf8");
        const unit = /<(?:\w+:)?model\b[^>]*\bunit="(\w+)"/.exec(text)?.[1] ?? "millimeter";
        const objects = new Map<string, string>();
        // An <object .../> closes itself: its (empty) body never runs on into the next object's.
        for (const object of text.matchAll(/<(?:\w+:)?object\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?object>)/g)) {
          const id = /\bid="(\d+)"/.exec(object[1])?.[1];
          if (id) objects.set(id, object[2] ?? "");
        }
        // Only the root model's unit counts (3MF core spec); a model part's own is read and ignored.
        result = { scale: UNITS[unit] ?? (name === ROOT ? fail(`The 3MF's unit "${unit}" is not one the 3MF standard defines.`) : 1), objects };
      }
    }
    files.set(name, result);
    return result;
  };
}

type ParsedMesh = { vertices: Float64Array; corners: Uint32Array } | string;
/** Each mesh object parsed once, however many copies and components place it. */
const parsed = new WeakMap<ModelFile, Map<string, ParsedMesh>>();
function parseMesh(model: ModelFile, file: string, id: string, mesh: string): ParsedMesh {
  let cache = parsed.get(model);
  if (!cache) parsed.set(model, cache = new Map());
  const known = cache.get(id);
  if (known) return known;
  let result: ParsedMesh;
  const vertices: number[] = [];
  for (const v of mesh.matchAll(/<(?:\w+:)?vertex\b([^>]*)\/?>/g)) {
    const x = Number(/\bx="([^"]+)"/.exec(v[1])?.[1]), y = Number(/\by="([^"]+)"/.exec(v[1])?.[1]), z = Number(/\bz="([^"]+)"/.exec(v[1])?.[1]);
    vertices.push(x, y, z);
  }
  const count = vertices.length / 3;
  const corners: number[] = [];
  if (!vertices.every(Number.isFinite)) result = `a vertex of object ${id} in ${file} is not a number`;
  else {
    result = { vertices: Float64Array.from(vertices), corners: new Uint32Array() };
    for (const tri of mesh.matchAll(/<(?:\w+:)?triangle\b([^>]*)\/?>/g)) {
      const c = ["v1", "v2", "v3"].map(key => Number(new RegExp(`\\b${key}="(\\d+)"`).exec(tri[1])?.[1]));
      if (!c.every(k => Number.isInteger(k) && k >= 0 && k < count)) { result = `a triangle of object ${id} in ${file} names a vertex it doesn't have`; break; }
      corners.push(c[0], c[1], c[2]);
    }
    if (typeof result !== "string") result.corners = Uint32Array.from(corners);
  }
  cache.set(id, result);
  return result;
}

/** An object's triangles in the build frame: its own mesh, or its components' meshes, each through its transform. */
async function collect(read: ReturnType<typeof modelReader>, file: string, id: string, transform: number[], out: number[], depth = 0): Promise<string | undefined> {
  if (depth > MAX_DEPTH) return "its components nest too deeply";
  const model = await read(file);
  if (typeof model === "string") return model;
  const body = model.objects.get(id);
  if (body === undefined) return `object ${id} is missing from ${file}`;
  const mesh = /<(?:\w+:)?mesh\b[^>]*>([\s\S]*?)<\/(?:\w+:)?mesh>/.exec(body)?.[1];
  if (mesh) {
    const parsedMesh = parseMesh(model, file, id, mesh);
    if (typeof parsedMesh === "string") return parsedMesh;
    const t = transform, v = parsedMesh.vertices, corners = parsedMesh.corners;
    // A mirroring placement (negative determinant) turns the surface inside out: each triangle's winding is reversed.
    const mirrored = t[0] * (t[4] * t[8] - t[5] * t[7]) - t[1] * (t[3] * t[8] - t[5] * t[6]) + t[2] * (t[3] * t[7] - t[4] * t[6]) < 0;
    for (let i = 0; i < corners.length; i += 3) for (const k of mirrored ? [0, 2, 1] : [0, 1, 2]) {
      const c = corners[i + k];
      const x = v[c * 3], y = v[c * 3 + 1], z = v[c * 3 + 2];
      out.push(x * t[0] + y * t[3] + z * t[6] + t[9], x * t[1] + y * t[4] + z * t[7] + t[10], x * t[2] + y * t[5] + z * t[8] + t[11]);
    }
    return undefined;
  }
  for (const component of body.matchAll(/<(?:\w+:)?component\b([^>]*)\/?>/g)) {
    const child = /\bobjectid="(\d+)"/.exec(component[1])?.[1];
    if (!child) continue;
    const childFile = /\b(?:\w+:)?path="\/?([^"]+)"/.exec(component[1])?.[1] ?? file;
    const problem = await collect(read, childFile, child, compose(matrix(/\btransform="([^"]+)"/.exec(component[1])?.[1]), transform), out, depth + 1);
    if (problem) return problem;
  }
  return undefined;
}

/** A binary STL of a flat triangle list, with each facet's normal. */
function stl(values: number[]): Buffer {
  const count = values.length / 9;
  const buffer = Buffer.alloc(84 + count * 50);
  buffer.write("counterpart_part_meshes", 0, "ascii");
  buffer.writeUInt32LE(count, 80);
  for (let i = 0; i < count; i++) {
    const p = values.slice(i * 9, i * 9 + 9); // nine numbers: cheap beside the file write
    const u = [p[3] - p[0], p[4] - p[1], p[5] - p[2]], v = [p[6] - p[0], p[7] - p[1], p[8] - p[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const length = Math.hypot(n[0], n[1], n[2]) || 1;
    const at = 84 + i * 50;
    n.forEach((value, k) => buffer.writeFloatLE(value / length, at + k * 4));
    p.forEach((value, k) => buffer.writeFloatLE(value, at + 12 + k * 4));
  }
  return buffer;
}

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "part";

/** A new folder inside out_dir, named after the 3MF; nothing that exists is reused or overwritten. */
async function newFolder(outDir: string, base: string): Promise<string> {
  const parent = await fs.realpath(outDir).catch(() => fail("out_dir must be an existing folder."));
  if (!(await fs.stat(parent)).isDirectory()) fail("out_dir must be an existing folder.");
  for (let n = 1; n <= 1000; n++) {
    const folder = path.join(parent, `${slug(base)}-parts-${n}`);
    try { await fs.mkdir(folder); return folder; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  return fail("out_dir already holds 1000 part folders for this 3MF; choose another out_dir.");
}

export async function partMeshes(args: Record<string, unknown>): Promise<PartMeshes> {
  if (Object.keys(args).some(key => key !== "three_mf_path" && key !== "out_dir")) fail("counterpart_part_meshes accepts only three_mf_path and out_dir.");
  if (typeof args.three_mf_path !== "string" || !args.three_mf_path.trim()) fail("three_mf_path must name a 3MF file.");
  if (typeof args.out_dir !== "string" || !args.out_dir.trim()) fail("out_dir must name an existing folder.");
  const source = path.resolve(args.three_mf_path);
  const plates = await listModelPlates(source);
  const { zip } = await readSafe3mfArchive(source);
  const settings = await zip.file("Metadata/model_settings.config")?.async("string") ?? "";
  const hasPlates = /<plate\b/.test(settings);
  const colours = new Map(plates.project_filaments.flatMap(f => f.colour && /^#[0-9A-Fa-f]{6}/.test(f.colour) ? [[f.index, f.colour.slice(0, 7).toUpperCase()]] : []));
  const read = modelReader(zip);
  const root = await read(ROOT);
  if (typeof root === "string") fail(`This 3MF has no model to draw: ${root}.`);
  const rootScale = (root as ModelFile).scale;
  const items = [...(await zip.file(ROOT)!.async("string")).matchAll(/<(?:\w+:)?item\b([^>]*)\/?>/g)].map(item => item[1]);
  if (!plates.plates.some(plate => plate.parts.length)) fail("This 3MF has no printable part to draw.");

  const folder = await newFolder(args.out_dir, path.basename(source, path.extname(source)));
  const parts: PartMesh[] = [];
  const skipped: NonNullable<PartMeshes["skipped"]> = [];
  let written = 0;
  try {
  for (const plate of plates.plates) if (plate.parts_truncated)
    skipped.push({ id: `plate ${plate.index + 1}`, name: plate.name, reason: `${plate.parts_truncated} more parts beyond the first 1000 on this plate were not read` });
  for (const plate of plates.plates) for (const itemIndex of plate.build_items) {
    const item = items[itemIndex];
    if (!item || /\bprintable="(?:0|false)"/.test(item)) continue;
    const objectId = /\bobjectid="(\d+)"/.exec(item)?.[1];
    for (const part of plate.parts.filter(p => String(p.build_object_id) === objectId)) {
      const file = part.path?.replace(/^\//, "") ?? ROOT;
      // Each place the object puts this mesh: itself, or every component that names it (one mesh placed twice is two
      // parts on the plate, like a plain 3MF's pair of wheels).
      const placements: (string | undefined)[] = String(part.object_id) === objectId ? [undefined]
        : [...((root as ModelFile).objects.get(objectId ?? "") ?? "").matchAll(/<(?:\w+:)?component\b([^>]*)\/?>/g)]
          .map(match => match[1]).filter(attrs => /\bobjectid="(\d+)"/.exec(attrs)?.[1] === String(part.object_id)
            && (/\b(?:\w+:)?path="\/?([^"]+)"/.exec(attrs)?.[1] ?? ROOT) === file);
      if (!placements.length) { skipped.push({ id: `${itemIndex + 1}/${part.object_id}`, name: part.name, reason: `its component is missing from object ${objectId}` }); continue; }
      for (const [copy, component] of placements.entries()) {
      const id = copy ? `${itemIndex + 1}/${part.object_id}/${copy + 1}` : `${itemIndex + 1}/${part.object_id}`;
      const triangles: number[] = [];
      let problem: string | undefined;
      try {
        const placed = matrix(/\btransform="([^"]+)"/.exec(item)?.[1]);
        problem = component === undefined ? await collect(read, ROOT, objectId!, placed, triangles)
          : await collect(read, file, String(part.object_id), compose(matrix(/\btransform="([^"]+)"/.exec(component)?.[1]), placed), triangles);
      } catch (error) {
        // A malformed transform spoils this part only: it is listed with why, and the others are still written.
        if (!(error instanceof PartMeshesError)) throw error;
        problem = error.message;
      }
      if (!problem && !triangles.length) problem = "it has no triangles";
      if (!problem && written + triangles.length / 9 > MAX_TOTAL_TRIANGLES) problem = `the parts before it already fill this call's ${MAX_TOTAL_TRIANGLES} triangles`;
      // The root model's unit covers every model part and transform in the package (3MF core spec, 3.4).
      if (rootScale !== 1) for (let i = 0; i < triangles.length; i++) triangles[i] *= rootScale;
      if (problem) { skipped.push({ id, name: part.name, reason: problem }); continue; }
      written += triangles.length / 9;
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < triangles.length; i++) { min[i % 3] = Math.min(min[i % 3], triangles[i]); max[i % 3] = Math.max(max[i % 3], triangles[i]); }
      const stlPath = path.join(folder, `${parts.length + 1}-${slug(part.name)}.stl`);
      await fs.writeFile(stlPath, stl(triangles), { flag: "wx" });
      const colour = colours.get(part.filament);
      parts.push({
        id, name: part.name,
        ...(hasPlates ? { plate: plate.index + 1 } : {}),
        ...(colour ? { color: colour } : {}),
        filament: part.filament,
        ...(part.painted ? { painted: true as const } : {}),
        stl_path: stlPath,
        triangles: triangles.length / 9,
        size_mm: [0, 1, 2].map(k => Math.round((max[k] - min[k]) * 1000) / 1000) as [number, number, number],
      });
      }
    }
  }
  } catch (error) {
    // Nothing half-written is left behind.
    await fs.rm(folder, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return { contract: COUNTERPART_CONTRACT, units: "mm", folder, parts, ...(skipped.length ? { skipped } : {}) };
}

export const PART_MESHES_OUTPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    contract: { type: "string", const: COUNTERPART_CONTRACT },
    units: { type: "string", const: "mm" },
    folder: { type: "string", description: "The new folder the STLs were written in." },
    parts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "<build item, from 1>/<part's object id>, with /<n> for its second and later placements as a component: stable for the same file; a key, not to be parsed." },
          name: { type: "string" },
          plate: { type: "integer", minimum: 1, description: "Plate number from 1 (list_3mf_plates index + 1); absent without plate metadata." },
          color: { type: "string", pattern: "^#[0-9A-F]{6}$", description: "The filament's colour as the 3MF declares it; absent when it declares none." },
          filament: { type: "integer", minimum: 1 },
          painted: { type: "boolean", const: true, description: "Slicer painting recolours some facets; color is the base filament's." },
          stl_path: { type: "string" },
          triangles: { type: "integer", minimum: 1 },
          size_mm: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
        },
        required: ["id", "name", "stl_path", "triangles", "size_mm"],
      },
    },
    skipped: { type: "array", items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, reason: { type: "string" } }, required: ["id", "name", "reason"] } },
  },
  required: ["contract", "units", "folder", "parts"],
};
