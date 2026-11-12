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
import { SaxesParser } from "saxes";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { MACHINE_LIMITS, normalizeModel } from "../safety/limits.js";
import { readSafe3mfArchive } from "../safety/archive.js";
import { listModelPlates } from "./model-plates.js";
import { COUNTERPART_CONTRACT } from "./contract.js";

const MAX_PARTS = 64;
const MAX_FILAMENT = 64;
const MAX_STL_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_TRIANGLES = 5_000_000;
const PART_KEYS = new Set(["stl_path", "name", "filament"]);

export class Make3mfError extends Error {}

const isFilament = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_FILAMENT;

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

/** One object of a project: an assembly of parts, placed on a plate (1-based). */
type Assembly = { name: string; plate: number; parts: Part[] };

/** Buffered XML, so a large mesh never becomes one giant string. */
function bufferWriter() {
  const chunks: Buffer[] = [];
  let pending: string[] = [];
  return {
    write(line: string) {
      pending.push(line);
      if (pending.length >= 20_000) { chunks.push(Buffer.from(pending.join(""))); pending = []; }
    },
    done(): Buffer { chunks.push(Buffer.from(pending.join(""))); pending = []; return Buffer.concat(chunks); },
  };
}

/** A mesh's <mesh> element. */
function writeMesh(write: (line: string) => void, mesh: Mesh) {
  const { vertices, indices } = mesh;
  write(`   <mesh>\n    <vertices>\n`);
  for (let i = 0; i < vertices.length; i += 3) write(`     <vertex x="${coordinate(vertices[i])}" y="${coordinate(vertices[i + 1])}" z="${coordinate(vertices[i + 2])}"/>\n`);
  write(`    </vertices>\n    <triangles>\n`);
  for (let i = 0; i < indices.length; i += 3) write(`     <triangle v1="${indices[i]}" v2="${indices[i + 1]}" v3="${indices[i + 2]}"/>\n`);
  write(`    </triangles>\n   </mesh>\n`);
}

/** The model XML: every part's mesh object (ids 1..P), then one assembly object per object, one build item each. */
function modelXml(objects: Assembly[], transforms: number[][], application: string): Buffer {
  const { write, done } = bufferWriter();
  write(`<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021">\n`);
  write(` <metadata name="Application">${application}</metadata>\n <metadata name="BambuStudio:3mfVersion">1</metadata>\n <resources>\n`);
  const parts = objects.flatMap(object => object.parts);
  parts.forEach((part, index) => {
    write(`  <object id="${index + 1}" type="model">\n`);
    writeMesh(write, part.mesh);
    write(`  </object>\n`);
  });
  let first = 1;
  objects.forEach((object, index) => {
    write(`  <object id="${parts.length + 1 + index}" type="model">\n   <components>\n`);
    object.parts.forEach((_, at) => write(`    <component objectid="${first + at}"/>\n`));
    first += object.parts.length;
    write(`   </components>\n  </object>\n`);
  });
  write(` </resources>\n <build>\n`);
  objects.forEach((_, index) => write(`  <item objectid="${parts.length + 1 + index}" transform="1 0 0 0 1 0 0 0 1 ${transforms[index].map(coordinate).join(" ")}"/>\n`));
  write(` </build>\n</model>\n`);
  return done();
}

function modelSettingsXml(objects: Assembly[], plates: number): string {
  const partCount = objects.reduce((sum, object) => sum + object.parts.length, 0);
  let first = 1;
  const blocks = objects.map((object, index) => {
    const partBlocks = object.parts.map((part, at) => `    <part id="${first + at}" subtype="normal_part">
      <metadata key="name" value="${xmlAttribute(part.name)}"/>
      <metadata key="extruder" value="${part.filament}"/>
    </part>`).join("\n");
    first += object.parts.length;
    return `  <object id="${partCount + 1 + index}">
    <metadata key="name" value="${xmlAttribute(object.name)}"/>
    <metadata key="extruder" value="${object.parts[0].filament}"/>
${partBlocks}
  </object>
`;
  }).join("");
  // Plates only when the project uses more than one, so a one-plate file stays as counterpart_make_3mf always wrote it.
  const plateBlocks = plates <= 1 ? "" : Array.from({ length: plates }, (_, i) => `  <plate>
    <metadata key="plater_id" value="${i + 1}"/>
    <metadata key="plater_name" value=""/>
    <metadata key="locked" value="false"/>
${objects.flatMap((object, index) => object.plate !== i + 1 ? [] : [`    <model_instance>
      <metadata key="object_id" value="${partCount + 1 + index}"/>
      <metadata key="instance_id" value="0"/>
      <metadata key="identify_id" value="${partCount + 1 + index}"/>
    </model_instance>
`]).join("")}  </plate>
`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<config>
${blocks}${plateBlocks}</config>
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
 * The configured Bambu model's bed (BAMBU_MODEL), else a 256 mm bed. Other printer types slice with their own bed and
 * arrange settings; this only places the assembly.
 */
function bedSize(): [number, number] {
  const model = normalizeModel(process.env.BAMBU_MODEL);
  const volume = model ? MACHINE_LIMITS[model]?.volume : undefined;
  return volume ? [volume[0], volume[1]] : [256, 256];
}

/**
 * Where plate N (1-based) starts in the build frame, as Bambu Studio lays plates out (PartPlateList::compute_origin
 * and compute_colum_count): about sqrt(count) columns, each plate a bed plus a fifth from the next, rows toward -Y.
 */
function plateOrigin(plate: number, plates: number, [width, depth]: [number, number]): [number, number] {
  const root = Math.sqrt(plates), rounded = Math.round(root);
  const columns = root > rounded ? rounded + 1 : rounded;
  const index = plate - 1;
  return [(index % columns) * width * 1.2, -Math.floor(index / columns) * depth * 1.2];
}

/** One shared translation per plate: its objects keep their relative positions, centred on the plate, lowest point on the bed. */
function plateTransforms(objects: Assembly[]): number[][] {
  const bed = bedSize();
  const plates = Math.max(...objects.map(object => object.plate));
  const shift = new Map<number, number[]>();
  for (const plate of new Set(objects.map(object => object.plate))) {
    const parts = objects.filter(object => object.plate === plate).flatMap(object => object.parts);
    const min = [0, 1, 2].map(axis => Math.min(...parts.map(part => part.mesh.min[axis])));
    const max = [0, 1, 2].map(axis => Math.max(...parts.map(part => part.mesh.max[axis])));
    const [x, y] = plateOrigin(plate, plates, bed);
    shift.set(plate, [x + bed[0] / 2 - (min[0] + max[0]) / 2, y + bed[1] / 2 - (min[1] + max[1]) / 2, -min[2]]);
  }
  return objects.map(object => shift.get(object.plate)!);
}

/** A new path, refusing one that exists; its parent directory must exist. */
async function newOutPath(value: unknown): Promise<string> {
  const requested = path.resolve(nonEmptyText(value, "out_path"));
  if (path.extname(requested).toLowerCase() !== ".3mf") fail("out_path must name a new .3mf file.");
  const directory = await fs.realpath(path.dirname(requested)).catch(() => fail("out_path parent directory must already exist."));
  const outPath = path.join(directory, path.basename(requested));
  const existing = await fs.lstat(outPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") fail("out_path cannot be accessed.");
    return undefined;
  });
  if (existing) fail("out_path already exists; choose a new file. Existing files are never overwritten.");
  return outPath;
}

/** Publish bytes at a new path without replacing anything that appeared there since it was checked. */
async function publish(outPath: string, bytes: Buffer): Promise<void> {
  const staged = path.join(path.dirname(outPath), `.counterpart-${randomUUID()}.3mf`);
  try {
    await fs.writeFile(staged, bytes, { flag: "wx" });
    // link() publishes without replacing a file created since the check above.
    await fs.link(staged, outPath).catch(() => fail("Cannot write out_path; it may already exist or be unwritable."));
  } finally {
    await fs.rm(staged, { force: true }).catch(() => {});
  }
}

async function writeAssemblies(objects: Assembly[], outPath: string, application: string): Promise<void> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES);
  zip.file("_rels/.rels", RELATIONSHIPS);
  zip.file("3D/3dmodel.model", modelXml(objects, plateTransforms(objects), application));
  zip.file("Metadata/model_settings.config", modelSettingsXml(objects, Math.max(...objects.map(object => object.plate))));
  await publish(outPath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } }));
}

export async function makeCounterpart3mf(args: Record<string, unknown>): Promise<Make3mfResult> {
  if (Object.keys(args).some(key => key !== "parts" && key !== "out_path")) fail("counterpart_make_3mf accepts only parts and out_path.");
  if (!Array.isArray(args.parts) || args.parts.length === 0 || args.parts.length > MAX_PARTS) fail(`parts must list 1 to ${MAX_PARTS} STL parts.`);
  const outPath = await newOutPath(args.out_path);

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
    if (!isFilament(filament)) fail(`${label}.filament must be an integer from 1 to ${MAX_FILAMENT}.`);
    const mesh = await readMesh(await fs.realpath(stlPath).catch(() => fail(`${label}.stl_path does not exist.`)), `${label}.stl_path`);
    triangles += mesh.triangles;
    if (triangles > MAX_TOTAL_TRIANGLES) fail(`The parts have more than ${MAX_TOTAL_TRIANGLES} triangles in total; decimate them first.`);
    parts.push({ name, stlPath, filament, mesh });
  }
  await writeAssemblies([{ name: path.basename(outPath, path.extname(outPath)), plate: 1, parts }], outPath, "mcp-3D-printer-server counterpart_make_3mf");
  return {
    contract: COUNTERPART_CONTRACT,
    path: outPath,
    objects: 1,
    filaments: Math.max(...parts.map(part => part.filament)),
    parts: parts.map(part => ({ name: part.name, stl_path: part.stlPath, filament: part.filament, triangles: part.mesh.triangles })),
  };
}

// --- cad_run 3MF projects (project_3mf in a design script) --------------------------------------------------------

const MAX_PLATES = 64;
const IDENTITY_COMPONENT = "1 0 0 0 1 0 0 0 1 0 0 0";
const IDENTITY_MATRIX = "1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1";
type ProjectEdit =
  | { op: "add_part"; object_id: number; name: string; filament: number; stl: number }
  | { op: "replace_part"; object_id: number; part_id: number; path: string; stl: number }
  | { op: "set_part"; object_id: number; part_id: number; name?: string; filament?: number };

const isId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One element by tag and id in XML text: its start offset, end offset and full text. */
function elementById(xml: string, tag: string, id: number): { start: number; end: number; text: string } | undefined {
  const pattern = new RegExp(`<((?:\\w+:)?${tag})\\b[^>]*\\bid="${id}"[^>]*?(?:/>|>[\\s\\S]*?</\\1>)`, "g");
  const match = pattern.exec(xml);
  return match ? { start: match.index, end: match.index + match[0].length, text: match[0] } : undefined;
}

/**
 * Whether XML text is a 3MF model document: well-formed, a <model> root and one <resources> directly under it, closed
 * once in the text, so a splice at its close lands inside the model's resources and nowhere else.
 */
function isModelDocument(xml: string): boolean {
  if ((xml.match(/<\/(?:\w+:)?resources\s*>/g) ?? []).length !== 1) return false;
  let depth = 0, root = "", resources = 0;
  try {
    const parser = new SaxesParser({ xmlns: false });
    parser.on("error", error => { throw error; });
    parser.on("opentag", tag => {
      const local = tag.name.replace(/^\w+:/, "");
      if (depth === 0) root = local;
      else if (depth === 1 && local === "resources") resources += 1;
      depth += 1;
    });
    parser.on("closetag", () => { depth -= 1; });
    parser.write(xml).close();
  } catch { return false; }
  return root === "model" && resources === 1;
}

/** The prefix a document binds to the 3MF production extension, if any. */
const productionPrefix = (xml: string) => /\bxmlns:(\w+)="http:\/\/schemas\.microsoft\.com\/3dmanufacturing\/production\/2015\/06"/.exec(xml)?.[1];

/** A mesh as <mesh> text, for splicing into an existing model part. */
function meshText(mesh: Mesh): string {
  const { write, done } = bufferWriter();
  writeMesh(write, mesh);
  return done().toString("utf8");
}

function setMetadata(block: string, key: string, value: string): string {
  const entry = `<metadata key="${key}" value="${xmlAttribute(value)}"/>`;
  const existing = new RegExp(`<metadata\\s+key="${escapeRegExp(key)}"\\s+value="[^"]*"\\s*/>`);
  if (existing.test(block)) return block.replace(existing, entry);
  // A self-closing <part …/> opens up, so the metadata lands inside the part and not on its object.
  const empty = /^<((?:\w+:)?part)\b([^>]*?)\s*\/>$/.exec(block);
  if (empty) return `<${empty[1]}${empty[2]}>\n      ${entry}\n    </${empty[1]}>`;
  return block.replace(/(<(?:\w+:)?part\b[^>]*>)/, `$1\n      ${entry}`);
}

/**
 * Write the 3MF a cad_run design script returned as project_3mf() (src/cad/project3mf.py): `manifest` is the
 * sandbox's <name>.project.json, `partsDir` its STL parts, `inputs` the run's input snapshots by alias. A new project
 * is written as counterpart_make_3mf writes one, an object per assembly on its plate. An edit copies the base 3MF and
 * changes only what the script changed, so its print settings, painting, plates and other parts stay as they were.
 */
export async function writeCadProject3mf(manifest: unknown, partsDir: string, inputs: Record<string, string>, outPath: string)
  : Promise<{ base: string | null; changed: string[] }> {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) fail("The design's 3MF project manifest is malformed.");
  const project = manifest as Record<string, unknown>;
  if (project.version !== 1) fail("The design's 3MF project manifest has an unknown version.");
  let triangles = 0;
  const stlIndexes = new Set<number>();
  const partMesh = async (index: unknown, label: string): Promise<Mesh> => {
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= MAX_PARTS || stlIndexes.has(index)) fail(`${label} names no part file.`);
    stlIndexes.add(index);
    const mesh = await readMesh(path.join(partsDir, `${index}.stl`), label);
    if ((triangles += mesh.triangles) > MAX_TOTAL_TRIANGLES) fail(`The project's new parts have more than ${MAX_TOTAL_TRIANGLES} triangles; decimate them first.`);
    return mesh;
  };
  const text = (value: unknown, label: string) => nonEmptyText(value, label).trim().slice(0, 200);

  if (project.base === null || project.base === undefined) {
    if (!Array.isArray(project.objects) || !project.objects.length || project.objects.length > MAX_PARTS) fail("A new 3MF project needs 1 to 64 objects.");
    const objects: Assembly[] = [];
    for (const [index, value] of project.objects.entries()) {
      const entry = value as Record<string, unknown>;
      const plate = entry?.plate;
      if (typeof plate !== "number" || !Number.isInteger(plate) || plate < 1 || plate > MAX_PLATES) fail(`objects[${index}].plate must be from 1 to ${MAX_PLATES}.`);
      if (!Array.isArray(entry.parts) || !entry.parts.length) fail(`objects[${index}] has no parts.`);
      const parts: Part[] = [];
      for (const [at, part] of (entry.parts as Record<string, unknown>[]).entries()) {
        if (!isFilament(part?.filament)) fail(`objects[${index}].parts[${at}].filament must be from 1 to ${MAX_FILAMENT}.`);
        parts.push({ name: text(part.name, "part name"), stlPath: "", filament: part.filament, mesh: await partMesh(part.stl, `objects[${index}].parts[${at}]`) });
      }
      objects.push({ name: text(entry.name, "object name"), plate, parts });
    }
    await writeAssemblies(objects, outPath, "mcp-3D-printer-server cad_run");
    return { base: null, changed: objects.flatMap(object => object.parts.map(part => `${object.name}: ${part.name} (filament ${part.filament}, plate ${object.plate})`)) };
  }

  const alias = project.base;
  if (typeof alias !== "string" || !Object.prototype.hasOwnProperty.call(inputs, alias)) fail("The 3MF project's base is not one of this run's inputs.");
  const { zip } = await readSafe3mfArchive(inputs[alias]);
  if (Object.keys(zip.files).some(name => /^Metadata\/plate_\d+\.gcode$/.test(name))) fail("The base 3MF holds G-code: edit the project file, not a sliced .gcode.3mf.");
  const files = new Map<string, string>();
  const read = async (name: string) => {
    if (!files.has(name)) {
      const file = zip.file(name);
      if (!file) fail(`The base 3MF has no ${name}.`);
      files.set(name, await file.async("string"));
    }
    return files.get(name)!;
  };
  const ROOT = "3D/3dmodel.model", SETTINGS = "Metadata/model_settings.config";
  // A component's path comes from the untrusted base: only a model part may take a mesh.
  const checkedModels = new Set<string>();
  const readModel = async (name: string) => {
    const model = await read(name);
    if (!checkedModels.has(name)) {
      if ((name !== ROOT && !name.toLowerCase().endsWith(".model")) || !isModelDocument(model)) fail(`The base 3MF's ${name} is not a 3MF model part; a part's mesh can only go into one.`);
      checkedModels.add(name);
    }
    return model;
  };
  await readModel(ROOT);
  await read(SETTINGS);
  if (!Array.isArray(project.edits) || !project.edits.length || project.edits.length > 256) fail("A 3MF edit needs 1 to 256 edits.");
  // A part can only print in a filament the project declares (none declared: the slicer's own list decides).
  const declared = (await listModelPlates(inputs[alias], { paintLimits: { meshBytes: 0, totalBytes: 0 } })).project_filaments.length;
  const declaredFilament = (value: unknown, label: string) => {
    if (!isFilament(value)) fail(`${label} must be from 1 to ${MAX_FILAMENT}.`);
    if (declared && value > declared) fail(`${label} ${value} is not one of the ${declared} filaments the base 3MF declares.`);
    return value;
  };
  const changed: string[] = [];
  // A root object's component in its model: the file a part's mesh lives in and its component transform.
  const componentsOf = (objectId: number) => {
    const object = elementById(files.get(ROOT)!, "object", objectId);
    if (!object) fail(`The base 3MF has no object ${objectId}.`);
    return [...object.text.matchAll(/<(?:\w+:)?component\b([^>]*)\/?>/g)].map(match => ({
      id: Number(/\bobjectid="(\d+)"/.exec(match[1])?.[1]),
      path: (/\b(?:\w+:)?path="\/?([^"]+)"/.exec(match[1])?.[1]) ?? ROOT,
    }));
  };
  const settingsObject = (objectId: number) => {
    const block = elementById(files.get(SETTINGS)!, "object", objectId);
    if (!block) fail(`The base 3MF's model_settings.config does not describe object ${objectId}.`);
    return block;
  };
  for (const [index, value] of project.edits.entries()) {
    const edit = value as ProjectEdit;
    if (!edit || typeof edit !== "object" || !isId(edit.object_id)) fail(`edits[${index}] is malformed.`);
    if (edit.op === "add_part") {
      declaredFilament(edit.filament, `edits[${index}].filament`);
      const name = text(edit.name, "part name");
      const components = componentsOf(edit.object_id);
      if (!components.length) fail(`Object ${edit.object_id} is a single mesh without parts; a part can only join an object made of parts.`);
      const target = components[0].path;
      const model = await readModel(target);
      const ids = [...model.matchAll(/<(?:\w+:)?object\b[^>]*\bid="(\d+)"/g)].map(match => Number(match[1]));
      const id = Math.max(0, ...ids, ...components.map(component => component.id)) + 1;
      const filePrefix = productionPrefix(model);
      const objectXml = `  <object id="${id}"${filePrefix ? ` ${filePrefix}:UUID="${randomUUID()}"` : ""} type="model">\n${meshText(await partMesh(edit.stl, `edits[${index}]`))}  </object>\n `;
      // A mesh kept in the root model goes before the object that uses it: the 3MF core forbids forward references.
      const at = target === ROOT ? elementById(model, "object", edit.object_id)!.start : model.lastIndexOf("</resources>");
      if (at < 0) fail(`${target} has no resources.`);
      files.set(target, model.slice(0, at) + objectXml + model.slice(at));
      const root = files.get(ROOT)!;
      const object = elementById(root, "object", edit.object_id)!;
      const rootPrefix = productionPrefix(root);
      if (target !== ROOT && !rootPrefix) fail("The base 3MF keeps parts in other model files without declaring the production extension.");
      const component = `<component${target !== ROOT ? ` ${rootPrefix}:path="/${xmlAttribute(target)}"` : ""} objectid="${id}"${rootPrefix ? ` ${rootPrefix}:UUID="${randomUUID()}"` : ""} transform="${IDENTITY_COMPONENT}"/>`;
      const close = object.text.search(/<\/(?:\w+:)?components>/);
      files.set(ROOT, root.slice(0, object.start) + object.text.slice(0, close) + component + object.text.slice(close) + root.slice(object.end));
      const settings = files.get(SETTINGS)!;
      const block = settingsObject(edit.object_id);
      const part = `  <part id="${id}" subtype="normal_part">\n      <metadata key="name" value="${xmlAttribute(name)}"/>\n      <metadata key="matrix" value="${IDENTITY_MATRIX}"/>\n      <metadata key="extruder" value="${edit.filament}"/>\n    </part>\n  `;
      const end = block.text.lastIndexOf("</object>");
      files.set(SETTINGS, settings.slice(0, block.start) + block.text.slice(0, end) + part + block.text.slice(end) + settings.slice(block.end));
      changed.push(`added ${name} to object ${edit.object_id} (filament ${edit.filament})`);
    } else if (edit.op === "replace_part" || edit.op === "set_part") {
      if (!isId(edit.part_id)) fail(`edits[${index}].part_id is malformed.`);
      // A part is its (objectid, model file): two model files may reuse an object id.
      const component = componentsOf(edit.object_id).find(entry => entry.id === edit.part_id && (edit.op !== "replace_part" || `/${entry.path}` === edit.path));
      if (!component) fail(`Object ${edit.object_id} has no part ${edit.part_id}${edit.op === "replace_part" ? ` in ${String(edit.path).slice(0, 200)}` : ""}.`);
      if (edit.op === "replace_part") {
        const model = await readModel(component.path);
        const mesh = elementById(model, "object", edit.part_id);
        if (!mesh || !/<(?:\w+:)?mesh\b/.test(mesh.text)) fail(`Part ${edit.part_id} of object ${edit.object_id} has no mesh to replace.`);
        const fresh = meshText(await partMesh(edit.stl, `edits[${index}]`)).trim();
        const next = mesh.text.replace(/<((?:\w+:)?mesh)\b[\s\S]*<\/\1>/, () => fresh);
        files.set(component.path, model.slice(0, mesh.start) + next + model.slice(mesh.end));
        changed.push(`replaced part ${edit.part_id} of object ${edit.object_id} (its painting, if any, went with the old mesh)`);
      } else {
        const settings = files.get(SETTINGS)!;
        const block = settingsObject(edit.object_id);
        const part = elementById(block.text, "part", edit.part_id);
        if (!part) fail(`model_settings.config has no part ${edit.part_id} in object ${edit.object_id}.`);
        let next = part.text;
        if (edit.name !== undefined) next = setMetadata(next, "name", text(edit.name, "part name"));
        if (edit.filament !== undefined) {
          declaredFilament(edit.filament, `edits[${index}].filament`);
          next = setMetadata(next, "extruder", String(edit.filament));
        }
        const updated = block.text.slice(0, part.start) + next + block.text.slice(part.end);
        files.set(SETTINGS, settings.slice(0, block.start) + updated + settings.slice(block.end));
        changed.push(`set part ${edit.part_id} of object ${edit.object_id}:${edit.name !== undefined ? ` name ${edit.name}` : ""}${edit.filament !== undefined ? ` filament ${edit.filament}` : ""}`);
      }
    } else fail(`edits[${index}].op is unknown.`);
  }
  // A fresh archive with the base's files in their order: JSZip would otherwise add directory entries the base never had.
  const output = new JSZip();
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    output.file(name, files.get(name) ?? await entry.async("nodebuffer"), { createFolders: false });
  }
  await publish(outPath, await output.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } }));
  return { base: alias, changed };
}
