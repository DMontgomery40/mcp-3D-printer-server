import { xmlAttribute } from "../slicer/3mf-xml.js";
/**
 * counterpart_make_3mf: combine separately exported STL parts into one 3MF for
 * multi-colour printing (PRD §8.4/§8.5, M3b).
 *
 * The 3MF holds one object, an assembly with one part per STL, and each part
 * names its filament in Metadata/model_settings.config. One object per part
 * does not work with Bambu Studio 02.08.02.61's CLI: it arranges separate
 * objects apart, with arrange off it reports G-code path conflicts between
 * stacked parts, and --load-filament-ids is refused for 3MF input. An assembly
 * keeps the parts where they were exported and still slices one filament per
 * part. Vertices are copied unchanged, so parts keep their relative positions;
 * one shared transform puts the assembly on the plate.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { MACHINE_LIMITS, normalizeModel } from "../safety/limits.js";
import { COUNTERPART_CONTRACT } from "./contract.js";

const MAX_PARTS = 64;
const MAX_FILAMENT = 64;
const MAX_STL_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_TRIANGLES = 5_000_000;
const PART_KEYS = new Set(["stl_path", "name", "filament"]);

export class Make3mfError extends Error {}

type Mesh = { vertices: Float32Array; indices: Uint32Array; triangles: number; min: number[]; max: number[] };
type Part = { name: string; stlPath: string; filament: number; mesh: Mesh };
export type Make3mfResult = {
  contract: typeof COUNTERPART_CONTRACT;
  path: string;
  objects: number;
  filaments: number;
  parts: { name: string; stl_path: string; filament: number; triangles: number }[];
};

function fail(message: string): never { throw new Make3mfError(message); }

function nonEmptyText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) fail(`${label} must be a non-empty string without NUL characters.`);
  return value;
}

/** Parse a binary or ASCII STL into an indexed mesh, merging bit-identical vertices so edges stay shared. */
async function readMesh(filePath: string, label: string): Promise<Mesh> {
  const stat = await fs.lstat(filePath).catch(() => fail(`${label} does not exist or is not readable.`));
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_STL_BYTES) fail(`${label} must be a non-empty regular STL file of at most 256 MiB.`);
  const buffer = await fs.readFile(filePath);
  let geometry;
  try {
    geometry = new STLLoader().parse(Uint8Array.from(buffer).buffer);
    const positions = geometry.getAttribute("position");
    if (!positions || positions.count < 3 || positions.count % 3 !== 0) throw new Error("no triangles");
    const source = positions.array as Float32Array;
    const bits = new Uint32Array(source.buffer, source.byteOffset, source.length);
    const lookup = new Map<string, number>();
    const vertices: number[] = [];
    const indices = new Uint32Array(positions.count);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let vertex = 0; vertex < positions.count; vertex++) {
      const offset = vertex * 3;
      for (let axis = 0; axis < 3; axis++) {
        const value = source[offset + axis];
        if (!Number.isFinite(value)) throw new Error("non-finite vertex");
        if (value < min[axis]) min[axis] = value;
        if (value > max[axis]) max[axis] = value;
      }
      const key = `${bits[offset]},${bits[offset + 1]},${bits[offset + 2]}`;
      let index = lookup.get(key);
      if (index === undefined) {
        index = vertices.length / 3;
        vertices.push(source[offset], source[offset + 1], source[offset + 2]);
        lookup.set(key, index);
      }
      indices[vertex] = index;
    }
    return { vertices: Float32Array.from(vertices), indices, triangles: positions.count / 3, min, max };
  } catch {
    throw new Make3mfError(`${label} contains no valid finite triangle mesh.`);
  } finally {
    geometry?.dispose();
  }
}

/** Shortest decimal that reads back as the same float32. */
const coordinate = (value: number) => String(Number(value.toPrecision(9)));

/** The model XML as buffers, so a large mesh never becomes one giant string. */
function modelXml(parts: Part[], transform: number[]): Buffer {
  const chunks: Buffer[] = [];
  let pending: string[] = [];
  const write = (line: string) => {
    pending.push(line);
    if (pending.length >= 20_000) { chunks.push(Buffer.from(pending.join(""))); pending = []; }
  };
  write(`<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021">\n`);
  write(` <metadata name="Application">mcp-3D-printer-server counterpart_make_3mf</metadata>\n <metadata name="BambuStudio:3mfVersion">1</metadata>\n <resources>\n`);
  parts.forEach((part, index) => {
    write(`  <object id="${index + 1}" type="model">\n   <mesh>\n    <vertices>\n`);
    const { vertices, indices } = part.mesh;
    for (let i = 0; i < vertices.length; i += 3) write(`     <vertex x="${coordinate(vertices[i])}" y="${coordinate(vertices[i + 1])}" z="${coordinate(vertices[i + 2])}"/>\n`);
    write(`    </vertices>\n    <triangles>\n`);
    for (let i = 0; i < indices.length; i += 3) write(`     <triangle v1="${indices[i]}" v2="${indices[i + 1]}" v3="${indices[i + 2]}"/>\n`);
    write(`    </triangles>\n   </mesh>\n  </object>\n`);
  });
  const assembly = parts.length + 1;
  write(`  <object id="${assembly}" type="model">\n   <components>\n`);
  parts.forEach((_, index) => write(`    <component objectid="${index + 1}"/>\n`));
  write(`   </components>\n  </object>\n </resources>\n <build>\n`);
  write(`  <item objectid="${assembly}" transform="1 0 0 0 1 0 0 0 1 ${transform.map(coordinate).join(" ")}"/>\n </build>\n</model>\n`);
  chunks.push(Buffer.from(pending.join("")));
  return Buffer.concat(chunks);
}

function modelSettingsXml(parts: Part[], name: string): string {
  const assembly = parts.length + 1;
  const partBlocks = parts.map((part, index) => `    <part id="${index + 1}" subtype="normal_part">
      <metadata key="name" value="${xmlAttribute(part.name)}"/>
      <metadata key="extruder" value="${part.filament}"/>
    </part>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="${assembly}">
    <metadata key="name" value="${xmlAttribute(name)}"/>
    <metadata key="extruder" value="${parts[0].filament}"/>
${partBlocks}
  </object>
</config>
`;
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

/**
 * Where the assembly's footprint centre goes: the configured Bambu model's bed centre (BAMBU_MODEL), else a 256 mm
 * bed's. Other printer types slice with their own bed and arrange settings; this only places the assembly.
 */
function plateCentre(): [number, number] {
  const model = normalizeModel(process.env.BAMBU_MODEL);
  const volume = model ? MACHINE_LIMITS[model]?.volume : undefined;
  return volume ? [volume[0] / 2, volume[1] / 2] : [128, 128];
}

export async function makeCounterpart3mf(args: Record<string, unknown>): Promise<Make3mfResult> {
  if (Object.keys(args).some(key => key !== "parts" && key !== "out_path")) fail("counterpart_make_3mf accepts only parts and out_path.");
  if (!Array.isArray(args.parts) || args.parts.length === 0 || args.parts.length > MAX_PARTS) fail(`parts must list 1 to ${MAX_PARTS} STL parts.`);
  const requested = path.resolve(nonEmptyText(args.out_path, "out_path"));
  if (path.extname(requested).toLowerCase() !== ".3mf") fail("out_path must name a new .3mf file.");
  const directory = await fs.realpath(path.dirname(requested)).catch(() => fail("out_path parent directory must already exist."));
  const outPath = path.join(directory, path.basename(requested));
  const existing = await fs.lstat(outPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") fail("out_path cannot be accessed.");
    return undefined;
  });
  if (existing) fail("out_path already exists; choose a new file. Existing files are never overwritten.");

  const parts: Part[] = [];
  let triangles = 0;
  for (const [index, value] of args.parts.entries()) {
    const label = `parts[${index}]`;
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object with stl_path and name.`);
    const entry = value as Record<string, unknown>;
    if (Object.keys(entry).some(key => !PART_KEYS.has(key))) fail(`${label} accepts only stl_path, name and filament.`);
    const name = nonEmptyText(entry.name, `${label}.name`).trim();
    const stlPath = path.resolve(nonEmptyText(entry.stl_path, `${label}.stl_path`));
    if (path.extname(stlPath).toLowerCase() !== ".stl") fail(`${label}.stl_path must name an STL file.`);
    const filament = entry.filament ?? index + 1;
    if (typeof filament !== "number" || !Number.isInteger(filament) || filament < 1 || filament > MAX_FILAMENT) {
      fail(`${label}.filament must be an integer from 1 to ${MAX_FILAMENT}.`);
    }
    const mesh = await readMesh(await fs.realpath(stlPath).catch(() => fail(`${label}.stl_path does not exist.`)), `${label}.stl_path`);
    triangles += mesh.triangles;
    if (triangles > MAX_TOTAL_TRIANGLES) fail(`The parts have more than ${MAX_TOTAL_TRIANGLES} triangles in total; decimate them first.`);
    parts.push({ name, stlPath, filament, mesh });
  }

  // One shared translation: footprint centred on the plate, lowest point on the bed.
  const min = [0, 1, 2].map(axis => Math.min(...parts.map(part => part.mesh.min[axis])));
  const max = [0, 1, 2].map(axis => Math.max(...parts.map(part => part.mesh.max[axis])));
  const [centreX, centreY] = plateCentre();
  const transform = [centreX - (min[0] + max[0]) / 2, centreY - (min[1] + max[1]) / 2, -min[2]];

  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES);
  zip.file("_rels/.rels", RELATIONSHIPS);
  zip.file("3D/3dmodel.model", modelXml(parts, transform));
  zip.file("Metadata/model_settings.config", modelSettingsXml(parts, path.basename(outPath, path.extname(outPath))));
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
  const staged = path.join(directory, `.counterpart-${randomUUID()}.3mf`);
  try {
    await fs.writeFile(staged, bytes, { flag: "wx" });
    // link() publishes without replacing a file created since the check above.
    await fs.link(staged, outPath).catch(() => fail("Cannot write out_path; it may already exist or be unwritable."));
  } finally {
    await fs.rm(staged, { force: true }).catch(() => {});
  }
  return {
    contract: COUNTERPART_CONTRACT,
    path: outPath,
    objects: 1,
    filaments: Math.max(...parts.map(part => part.filament)),
    parts: parts.map(part => ({ name: part.name, stl_path: part.stlPath, filament: part.filament, triangles: part.mesh.triangles })),
  };
}
