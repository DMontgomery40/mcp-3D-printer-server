// cad_run's 3MF project output (scan-to-make #642): a design script returns project_3mf(), the sandbox meshes the
// parts and writes a manifest, and this process writes the 3MF. The offline tests drive the writer with a manifest
// as the sandbox writes it; the real test (CAD_E2E_DATA_DIR) runs the whole path through cad_run.
import { trackedMkdtempSync } from "./support/temp.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeCadProject3mf } from "../dist/counterpart/make-3mf.js";
import { listModelPlates } from "../dist/counterpart/model-plates.js";

const KIT = fileURLToPath(new URL("./fixtures/studio-02.08.02.61/two-plates-three-filaments-unsliced.3mf", import.meta.url));
const SLICED = fileURLToPath(new URL("./fixtures/studio-02.08.02.61/two-plates-three-filaments-sliced.3mf", import.meta.url));

function boxStl(min, max) {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const t = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const buffer = Buffer.alloc(84 + t.length * 50);
  buffer.writeUInt32LE(t.length, 80);
  t.forEach((triangle, index) => {
    let offset = 84 + index * 50 + 12;
    for (const vertex of triangle) for (const value of v[vertex]) { buffer.writeFloatLE(value, offset); offset += 4; }
  });
  return buffer;
}

/** A run folder as the sandbox leaves it: <name>.parts/<n>.stl. */
function job(t, boxes) {
  const directory = trackedMkdtempSync(path.join(os.tmpdir(), "cad-project-3mf-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const parts = path.join(directory, "design.parts");
  fs.mkdirSync(parts);
  boxes.forEach(([min, max], index) => fs.writeFileSync(path.join(parts, `${index}.stl`), boxStl(min, max)));
  return { directory, parts, out: path.join(directory, "design.3mf") };
}

const summary = plates => plates.map(plate => [plate.index, plate.build_items, plate.parts.map(part => [part.name, part.filament, part.object_id, part.path])]);

test("an edited designer 3MF keeps its plates, settings and other parts and changes only what the script changed", async (t) => {
  const run = job(t, [[[-4, -4, 5], [4, 4, 6.2]], [[-5, -5, -5], [5, 5, 10]]]);
  const result = await writeCadProject3mf({ version: 1, base: "kit", edits: [
    { op: "add_part", object_id: 2, name: "Badge & <logo>", filament: 2, stl: 0 },
    { op: "replace_part", object_id: 6, part_id: 5, path: "/3D/Objects/object_3.model", stl: 1 },
    { op: "set_part", object_id: 4, part_id: 3, name: "Trim (body colour)", filament: 1 },
  ] }, run.parts, { kit: KIT }, run.out);
  assert.equal(result.base, "kit");
  assert.equal(result.changed.length, 3);
  const plates = await listModelPlates(run.out);
  assert.deepEqual(summary(plates.plates), [
    [0, [0, 1], [["Body", 1, 1, "/3D/Objects/object_1.model"], ["Badge & <logo>", 2, 2, "/3D/Objects/object_1.model"], ["Trim (body colour)", 1, 3, "/3D/Objects/object_2.model"]]],
    [1, [2], [["Lid", 2, 5, "/3D/Objects/object_3.model"]]]]);
  assert.deepEqual(plates.plates.map(plate => plate.filaments.map(filament => filament.index)), [[1, 2], [2]]);
  assert.deepEqual(plates.project_filaments.map(filament => filament.colour), ["#000000", "#FEC600", "#5B6579"], "the designer's filaments stay");
  // Byte for byte, every file the edit did not touch, in the same order and with no added folder entries.
  const before = await JSZip.loadAsync(fs.readFileSync(KIT)), after = await JSZip.loadAsync(fs.readFileSync(run.out));
  assert.deepEqual(Object.keys(after.files), Object.keys(before.files));
  const changed = [];
  for (const name of Object.keys(before.files)) {
    if (!(await before.file(name).async("nodebuffer")).equals(await after.file(name).async("nodebuffer"))) changed.push(name);
  }
  assert.deepEqual(changed.sort(), ["3D/3dmodel.model", "3D/Objects/object_1.model", "3D/Objects/object_3.model", "Metadata/model_settings.config"]);
  const settings = await after.file("Metadata/model_settings.config").async("string");
  assert.match(settings, /<metadata key="name" value="Badge &amp; &lt;logo&gt;"\/>/, "names stay escaped for Bambu Studio");
  const root = await after.file("3D/3dmodel.model").async("string");
  assert.match(root, /<component p:path="\/3D\/Objects\/object_1\.model" objectid="2" p:UUID="[0-9a-f-]+" transform="1 0 0 0 1 0 0 0 1 0 0 0"\/>/);
  const lid = await after.file("3D/Objects/object_3.model").async("string");
  assert.match(lid, /<vertex x="-5" y="-5" z="10"\/>/, "the Lid's mesh is the replacement");
});

test("a new project puts each object on its plate as Bambu Studio lays plates out, with each part's filament", async (t) => {
  const run = job(t, [[[-10, -10, 0], [10, 10, 3]], [[-4, -4, 3], [4, 4, 4]], [[25, -5, 0], [35, 5, 10]]]);
  await writeCadProject3mf({ version: 1, base: null, objects: [
    { name: "Coaster", plate: 1, parts: [{ stl: 0, name: "Tile", filament: 1 }, { stl: 1, name: "Dot", filament: 2 }] },
    { name: "Cube", plate: 2, parts: [{ stl: 2, name: "Cube", filament: 3 }] },
  ] }, run.parts, {}, run.out);
  const plates = await listModelPlates(run.out);
  assert.deepEqual(summary(plates.plates), [[0, [0], [["Tile", 1, 1, undefined], ["Dot", 2, 2, undefined]]], [1, [1], [["Cube", 3, 3, undefined]]]]);
  assert.deepEqual(plates.plates.map(plate => plate.objects), [["Coaster"], ["Cube"]]);
  const zip = await JSZip.loadAsync(fs.readFileSync(run.out));
  const items = [...(await zip.file("3D/3dmodel.model").async("string")).matchAll(/<item objectid="(\d+)" transform="([^"]+)"/g)].map(m => [m[1], m[2]]);
  // Two plates: two columns, 256 mm bed plus a fifth apart; each plate's objects centred on it, lowest point on the bed.
  assert.deepEqual(items, [["4", "1 0 0 0 1 0 0 0 1 128 128 0"], ["5", "1 0 0 0 1 0 0 0 1 405.2 128 0"]]);
});

test("project manifests the sandbox could forge are refused before anything is written", async (t) => {
  const run = job(t, [[[0, 0, 0], [1, 1, 1]]]);
  const edit = edits => writeCadProject3mf({ version: 1, base: "kit", edits }, run.parts, { kit: KIT }, run.out);
  await assert.rejects(writeCadProject3mf({ version: 1, base: "elsewhere", edits: [] }, run.parts, { kit: KIT }, run.out), /not one of this run's inputs/);
  await assert.rejects(writeCadProject3mf({ version: 1, base: "kit", edits: [{ op: "set_part", object_id: 2, part_id: 1, filament: 1 }] }, run.parts, { kit: SLICED }, run.out), /holds G-code/);
  await assert.rejects(edit([{ op: "add_part", object_id: 99, name: "X", filament: 1, stl: 0 }]), /no object 99/);
  await assert.rejects(edit([{ op: "add_part", object_id: 2, name: "X", filament: 65, stl: 0 }]), /filament/);
  await assert.rejects(edit([{ op: "add_part", object_id: 2, name: "X", filament: 1, stl: "../../etc/passwd" }]), /names no part file/);
  await assert.rejects(edit([{ op: "add_part", object_id: 2, name: "X", filament: 1, stl: 3 }]), /does not exist|not readable/);
  await assert.rejects(edit([{ op: "replace_part", object_id: 6, part_id: 5, path: "/3D/Objects/object_1.model", stl: 0 }]), /no part 5 in \/3D\/Objects\/object_1\.model/);
  await assert.rejects(edit([{ op: "set_part", object_id: 6, part_id: 9, name: "X" }]), /no part 9/);
  await assert.rejects(edit([{ op: "explode", object_id: 6 }]), /op is unknown/);
  await assert.rejects(edit([{ op: "add_part", object_id: 2, name: "X", filament: 4, stl: 0 }]), /not one of the 3 filaments/);
  await assert.rejects(edit([{ op: "set_part", object_id: 4, part_id: 3, filament: 4 }]), /not one of the 3 filaments/);
  await assert.rejects(writeCadProject3mf({ version: 2 }, run.parts, {}, run.out), /unknown version/);
  assert.equal(fs.existsSync(run.out), false);
  fs.writeFileSync(run.out, "taken");
  await assert.rejects(edit([{ op: "set_part", object_id: 4, part_id: 3, filament: 1 }]), /already exist/);
  assert.equal(fs.readFileSync(run.out, "utf8"), "taken", "an existing file is never overwritten");
});

// The real path: a design script edits the Studio-written two-plate kit through cad_run, and the result reads back
// with its parts and colours. Bambu Studio is not run here; slicing it needs an installed profile tree.
const data = process.env.CAD_E2E_DATA_DIR;
const EDIT = `from build123d import Cylinder, Pos
P = {"badge_d": 8.0, "badge_h": 1.2, "badge_filament": 2, "lid_height_scale": 1.5}

def build():
    project = project_3mf("kit")
    body = project.object("Body")
    low, high = body.parts[0].mesh.bounds
    badge = Pos((low[0] + high[0]) / 2, (low[1] + high[1]) / 2, high[2] + P["badge_h"] / 2) * Cylinder(P["badge_d"] / 2, P["badge_h"])
    project.add_part(badge, name="Badge", filament=P["badge_filament"], object="Body")
    lid = project.object("Lid").parts[0]
    taller = lid.mesh.copy()
    base = taller.bounds[0][2]
    taller.apply_translation([0, 0, -base]); taller.apply_scale([1, 1, P["lid_height_scale"]]); taller.apply_translation([0, 0, base])
    project.replace_part(lid, taller)
    project.set_part(project.object("Trim").parts[0], filament=1)
    return project
`;
const NEW = `from build123d import Box, Cylinder, Pos
P = {"size": 20.0, "inlay": 1.0}

def build():
    project = project_3mf()
    project.add_part(Pos(0, 0, 1.5) * Box(P["size"], P["size"], 3), name="Tile", filament=1, object="Coaster")
    project.add_part(Pos(0, 0, 3 + P["inlay"] / 2) * Cylinder(4, P["inlay"]), name="Dot", filament=2, object="Coaster")
    project.add_part(Pos(30, 0, 5) * Box(10, 10, 10), name="Cube", filament=3, plate=2)
    return project
`;

test("cad_run edits a designer's 3MF and makes a new two-plate project (real CAD runtime)", {
  skip: !data && "set CAD_E2E_DATA_DIR to an installed, verified CAD runtime", timeout: 600000,
}, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cad-project-real-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.copyFileSync(KIT, path.join(dir, "kit.3mf"));
  const client = new Client({ name: "cad-project-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))], cwd: dir, stderr: "pipe",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, MCP_TRANSPORT: "stdio", BAMBU_MODEL: "", BAMBU_PRINTER_HOST: "127.0.0.1", TEMP_DIR: dir, CAD_DATA_DIR: data },
  });
  transport.stderr?.on("data", () => {});
  t.after(() => client.close());
  await client.connect(transport);
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 300000 });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return result.structuredContent;
  };
  if (!(await call("cad_status", {})).ready) { t.skip("CAD runtime exists but is not ready: run cad_setup first"); return; }
  const edited = await call("cad_run", { script: EDIT, mode: "mesh", output_dir: dir, name: "kit-edit", inputs: [{ name: "kit", path: path.join(dir, "kit.3mf") }] });
  assert.equal(edited.valid, true);
  assert.equal(edited.three_mf_project.base, "kit");
  const listed = await call("list_3mf_plates", { three_mf_path: edited.three_mf });
  assert.deepEqual(listed.plates.map(plate => plate.parts.map(part => [part.name, part.filament])), [[["Body", 1], ["Badge", 2], ["Trim", 1]], [["Lid", 2]]]);
  assert.deepEqual(listed.project_filaments.map(filament => filament.colour), ["#000000", "#FEC600", "#5B6579"]);
  const made = await call("cad_run", { script: NEW, output_dir: dir, name: "coaster" });
  assert.equal(made.valid, true);
  assert.deepEqual(made.problems, [], "an object's own parts are one body for the checks: the inlay is not a fused-bodies problem");
  assert.ok(made.step, "an all-solid new project keeps its STEP");
  assert.deepEqual(made.three_mf_project.plates.map(plate => plate.parts.map(part => [part.name, part.filament])), [[["Tile", 1], ["Dot", 2]], [["Cube", 3]]]);
  await assert.rejects(call("cad_run", { script: EDIT, output_dir: dir, name: "solid-edit", inputs: [{ name: "kit", path: path.join(dir, "kit.3mf") }] }), /Editing a 3MF runs with mode/);
});

test("a part added to an object whose meshes are in the root model is defined before the object that uses it", async (t) => {
  const run = job(t, [[[0, 0, 1], [1, 1, 2]]]);
  const base = path.join(run.directory, "root.3mf");
  const zip = new JSZip();
  zip.file("3D/3dmodel.model", `<?xml version="1.0"?><model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object><object id="2" type="model"><components><component objectid="1"/></components></object></resources><build><item objectid="2"/></build></model>`);
  zip.file("Metadata/model_settings.config", `<config><object id="2"><metadata key="name" value="Tag"/><metadata key="extruder" value="1"/><part id="1" subtype="normal_part"><metadata key="name" value="tag"/></part></object></config>`);
  fs.writeFileSync(base, await zip.generateAsync({ type: "nodebuffer" }));
  await writeCadProject3mf({ version: 1, base: "tag", edits: [{ op: "add_part", object_id: 2, name: "Dot", filament: 2, stl: 0 }] }, run.parts, { tag: base }, run.out);
  const model = await (await JSZip.loadAsync(fs.readFileSync(run.out))).file("3D/3dmodel.model").async("string");
  assert.ok(model.indexOf('<object id="3"') < model.indexOf('<object id="2"'), "the new mesh object precedes its assembly");
  assert.match(model, /<component objectid="1"\/><component objectid="3" transform="1 0 0 0 1 0 0 0 1 0 0 0"\/><\/components>/);
  assert.deepEqual((await listModelPlates(run.out)).plates[0].parts.map(part => [part.name, part.filament, part.object_id]), [["tag", 1, 1], ["Dot", 2, 3]]);
});

// --- Review findings (Muse, 2026-11-12): a designer kit is untrusted input to the trusted writer -------------------

const CORE_NS = 'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"';
const PROD_NS = 'xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"';
async function craftBase(directory, entries) {
  const file = path.join(directory, `base-${Math.random().toString(36).slice(2)}.3mf`);
  const zip = new JSZip();
  for (const [name, value] of Object.entries(entries)) zip.file(name, value);
  fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" }));
  return file;
}
const settingsFor = (objectId, parts) => `<config><object id="${objectId}"><metadata key="name" value="Thing"/><metadata key="extruder" value="1"/>${parts}</object></config>`;

test("a component path that names a non-model entry is refused, never spliced into", async (t) => {
  const run = job(t, [[[0, 0, 0], [1, 1, 1]], [[0, 0, 0], [2, 2, 2]]]);
  const settingsJson = JSON.stringify({ filament_colour: ["#111111", "#222222"], note: "</resources>" });
  const base = await craftBase(run.directory, {
    "3D/3dmodel.model": `<?xml version="1.0"?><model ${CORE_NS} ${PROD_NS}><resources><object id="2" type="model"><components><component p:path="/Metadata/project_settings.config" objectid="1"/></components></object></resources><build><item objectid="2"/></build></model>`,
    "Metadata/model_settings.config": settingsFor(2, `<part id="1" subtype="normal_part"><metadata key="name" value="p"/></part>`),
    "Metadata/project_settings.config": settingsJson,
  });
  await assert.rejects(writeCadProject3mf({ version: 1, base: "kit", edits: [{ op: "add_part", object_id: 2, name: "X", filament: 1, stl: 0 }] }, run.parts, { kit: base }, run.out), /not a 3MF model part/);
  await assert.rejects(writeCadProject3mf({ version: 1, base: "kit", edits: [{ op: "replace_part", object_id: 2, part_id: 1, path: "/Metadata/project_settings.config", stl: 1 }] }, run.parts, { kit: base }, run.out), /not a 3MF model part/);
  // A .model entry that is not a model document is refused the same way.
  const fake = await craftBase(run.directory, {
    "3D/3dmodel.model": `<?xml version="1.0"?><model ${CORE_NS} ${PROD_NS}><resources><object id="2" type="model"><components><component p:path="/3D/Objects/fake.model" objectid="1"/></components></object></resources><build><item objectid="2"/></build></model>`,
    "3D/Objects/fake.model": `{"json": "</resources>"}`,
    "Metadata/model_settings.config": settingsFor(2, `<part id="1" subtype="normal_part"><metadata key="name" value="p"/></part>`),
  });
  await assert.rejects(writeCadProject3mf({ version: 1, base: "kit", edits: [{ op: "add_part", object_id: 2, name: "X", filament: 1, stl: 0 }] }, run.parts, { kit: fake }, run.out), /not a 3MF model part/);
  assert.equal(fs.existsSync(run.out), false);
});

test("recolouring a self-closing <part/> writes its metadata inside that part, not on its object", async (t) => {
  const run = job(t, [[[0, 0, 0], [1, 1, 1]]]);
  const mesh = id => `<object id="${id}" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>`;
  const base = await craftBase(run.directory, {
    "3D/3dmodel.model": `<?xml version="1.0"?><model ${CORE_NS}><resources>${mesh(1)}${mesh(2)}<object id="3" type="model"><components><component objectid="1"/><component objectid="2"/></components></object></resources><build><item objectid="3"/></build></model>`,
    "Metadata/model_settings.config": settingsFor(3, `<part id="1" subtype="normal_part"/><part id="2" subtype="normal_part"/>`),
    "Metadata/project_settings.config": JSON.stringify({ filament_colour: ["#111111", "#222222"] }),
  });
  await writeCadProject3mf({ version: 1, base: "kit", edits: [{ op: "set_part", object_id: 3, part_id: 1, filament: 2 }] }, run.parts, { kit: base }, run.out);
  const settings = await (await JSZip.loadAsync(fs.readFileSync(run.out))).file("Metadata/model_settings.config").async("string");
  assert.equal((settings.match(/<metadata key="extruder"/g) ?? []).length, 2, "one for the object, one for part 1");
  assert.match(settings, /<part id="1" subtype="normal_part">\s*<metadata key="extruder" value="2"\/>\s*<\/part>/);
  assert.deepEqual((await listModelPlates(run.out)).plates[0].parts.map(part => [part.object_id, part.filament]), [[1, 2], [2, 1]]);
});

test("replace_part finds a part by id and model file when two files reuse an object id", async (t) => {
  const run = job(t, [[[0, 0, 0], [3, 3, 3]]]);
  const sub = z => `<?xml version="1.0"?><model ${CORE_NS}><resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="${z}"/><vertex x="1" y="0" z="${z}"/><vertex x="0" y="1" z="${z}"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources></model>`;
  const base = await craftBase(run.directory, {
    "3D/3dmodel.model": `<?xml version="1.0"?><model ${CORE_NS} ${PROD_NS}><resources><object id="2" type="model"><components><component p:path="/3D/Objects/a.model" objectid="1"/><component p:path="/3D/Objects/b.model" objectid="1"/></components></object></resources><build><item objectid="2"/></build></model>`,
    "3D/Objects/a.model": sub(7), "3D/Objects/b.model": sub(9),
    "Metadata/model_settings.config": settingsFor(2, `<part id="1" subtype="normal_part"><metadata key="name" value="p"/></part>`),
  });
  await writeCadProject3mf({ version: 1, base: "kit", edits: [{ op: "replace_part", object_id: 2, part_id: 1, path: "/3D/Objects/b.model", stl: 0 }] }, run.parts, { kit: base }, run.out);
  const zip = await JSZip.loadAsync(fs.readFileSync(run.out));
  assert.equal(await zip.file("3D/Objects/a.model").async("string"), sub(7), "a.model's part 1 is untouched");
  assert.match(await zip.file("3D/Objects/b.model").async("string"), /<vertex x="3" y="3" z="3"\/>/, "b.model's part 1 is replaced");
});

test("a base whose settings or model files are too large to edit is refused before they become strings", async (t) => {
  const run = job(t, [[[0, 0, 0], [1, 1, 1]]]);
  const kit = await JSZip.loadAsync(fs.readFileSync(KIT));
  const entries = {};
  for (const [name, entry] of Object.entries(kit.files)) if (!entry.dir) entries[name] = await entry.async("nodebuffer");
  entries["Metadata/model_settings.config"] = Buffer.concat([entries["Metadata/model_settings.config"], Buffer.from(`<!--${"x".repeat(9 * 1024 * 1024)}-->`)]);
  const base = await craftBase(run.directory, entries);
  await assert.rejects(writeCadProject3mf({ version: 1, base: "kit", edits: [{ op: "set_part", object_id: 4, part_id: 3, filament: 1 }] }, run.parts, { kit: base }, run.out), /too large to edit/);
  assert.equal(fs.existsSync(run.out), false);
});
