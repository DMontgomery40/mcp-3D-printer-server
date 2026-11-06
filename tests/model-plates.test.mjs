import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import JSZip from "jszip";
import { listModelPlates } from "../dist/counterpart/model-plates.js";
import { paintedStates } from "../dist/counterpart/plate-filaments.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mNgYGAAAAAEAAHI6uv5AAAAAElFTkSuQmCC", "base64");
const MODEL = `<?xml version="1.0"?><model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Title">3D scan platform</metadata><metadata name="Designer">Kass 3D</metadata><resources><object id="1" type="model"><mesh><vertices/><triangles/></mesh></object></resources><build><item objectid="1"/></build></model>`;

async function write3mf(t, entries) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "model-plates-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  for (const [name, value] of Object.entries(entries)) zip.file(name, value);
  const file = path.join(directory, "model.3mf");
  fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" }));
  return file;
}

// A designer's kit as Bambu Studio saves it (the Kass 3D scan rig: six plates), unsliced. Bambu Studio shows its six
// plates before slicing; so does this tool.
test("a designer's project lists its plates, names and objects before slicing", async (t) => {
  const objects = Array.from({ length: 8 }, (_, i) => `<object id="${i + 10}"><metadata key="name" value="Part &amp; ${i + 1}"/></object>`).join("");
  const plate = (n, ids, name = "") => `<plate><metadata key="plater_id" value="${n}"/><metadata key="plater_name" value="${name}"/>${ids.map(id => `<model_instance><metadata key="object_id" value="${id}"/></model_instance>`).join("")}</plate>`;
  const settings = `<config>${objects}${plate(1, [10, 11], "Base")}${plate(2, [12])}${plate(3, [13])}${plate(4, [14])}${plate(5, [15, 16])}${plate(6, [17])}</config>`;
  const file = await write3mf(t, { "3D/3dmodel.model": MODEL, "Metadata/model_settings.config": settings, "Metadata/plate_1.png": PNG, "Metadata/plate_6.png": PNG });
  const result = await listModelPlates(file);
  assert.equal(result.plate_count, 6);
  assert.deepEqual(result.plates.map(p => [p.index, p.name, p.objects, p.sliced]), [
    [0, "Base", ["Part & 1", "Part & 2"], false], [1, "Plate 2", ["Part & 3"], false], [2, "Plate 3", ["Part & 4"], false],
    [3, "Plate 4", ["Part & 5"], false], [4, "Plate 5", ["Part & 6", "Part & 7"], false], [5, "Plate 6", ["Part & 8"], false]]);
  assert.equal(result.title, "3D scan platform");
  assert.equal(result.designer, "Kass 3D");
  assert.equal(result.plates[0].thumbnail_png_base64, undefined, "previews only when asked");
  const withThumbnails = await listModelPlates(file, { thumbnails: true });
  assert.equal(withThumbnails.plates[0].thumbnail_png_base64, PNG.toString("base64"));
  assert.equal(withThumbnails.plates[1].thumbnail_png_base64, undefined);
  assert.equal(withThumbnails.plates[5].thumbnail_png_base64, PNG.toString("base64"));
});

test("a sliced plate says so, and a plain 3MF is one plate", async (t) => {
  const sliced = await write3mf(t, { "3D/3dmodel.model": MODEL, "Metadata/plate_2.gcode": "; g", "Metadata/plate_2.json": JSON.stringify({ bbox_objects: [{ name: "Gear" }, { name: "wipe_tower" }] }),
    "Metadata/model_settings.config": `<config><plate><metadata key="plater_id" value="1"/></plate><plate><metadata key="plater_id" value="2"/></plate></config>` });
  assert.deepEqual((await listModelPlates(sliced)).plates.map(p => [p.index, p.objects, p.sliced]), [[0, [], false], [1, ["Gear"], true]]);
  const plain = await write3mf(t, { "3D/3dmodel.model": MODEL });
  assert.deepEqual(await listModelPlates(plain), { plate_count: 1, plates: [{ index: 0, name: "Plate 1", objects: [], instances: [], sliced: false, filaments: [{ index: 1 }] }], title: "3D scan platform", designer: "Kass 3D", project_filaments: [] });
});

test("a file that isn't a 3MF is refused; a plate number out of range is skipped", async (t) => {
  const notModel = await write3mf(t, { "readme.txt": "hi" });
  await assert.rejects(listModelPlates(notModel), /not a 3MF model/);
  const bad = await write3mf(t, { "3D/3dmodel.model": MODEL, "Metadata/model_settings.config": `<config><plate><metadata key="plater_id" value="0"/></plate><plate><metadata key="plater_id" value="2"/></plate></config>` });
  assert.deepEqual((await listModelPlates(bad)).plates.map(p => p.index), [1]);
});

// A plain 3MF (PrusaSlicer, Cura, Printables) keeps its whole mesh in 3D/3dmodel.model, often tens of MB.
test("a plain 3MF with a large mesh is one plate", async (t) => {
  const vertices = Array.from({ length: 400_000 }, (_, i) => `<vertex x="${i}" y="0" z="0"/>`).join("");
  const big = `<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices>${vertices}</vertices><triangles/></mesh></object></resources><build><item objectid="1"/></build></model>`;
  assert.ok(big.length > 8 * 1024 * 1024);
  const file = await write3mf(t, { "3D/3dmodel.model": big });
  assert.deepEqual((await listModelPlates(file)).plates, [{ index: 0, name: "Plate 1", objects: [], instances: [], sliced: false, filaments: [{ index: 1 }] }]);
});

// Bambu Studio 02.08.02.61 CLI slice of three cube copies (Nov 6 2026): model_settings.config gives each copy's
// identify_id in its <model_instance>, the ids slice_stl's skip_objects takes.
test("each plate lists its object copies with their identify_id", async () => {
  const file = new URL("./fixtures/studio-02.08.02.61/p1s-three-copies.3mf", import.meta.url).pathname;
  const result = await listModelPlates(file);
  assert.deepEqual(result.plates.map(p => p.instances), [[
    { identify_id: 15, name: "cube.stl_1" }, { identify_id: 26, name: "cube.stl_2" }, { identify_id: 37, name: "cube.stl_3" }]]);
});

// --- Each plate's filaments, as Bambu Studio works them out (counterpart/1) ---------------------------------------

const STUDIO = name => new URL(`./fixtures/studio-02.08.02.61/${name}`, import.meta.url).pathname;
const filamentsOf = result => result.plates.map(plate => [plate.index, plate.filaments.map(filament => filament.index)]);

// Written by Bambu Studio 02.08.02.61's CLI from a two-plate project: plate 1 holds Body (filament 1) and Trim
// (filament 3), plate 2 holds Lid (filament 2). The sliced copy's plate_N.json is Studio's own record.
test("a Studio-written two-plate project lists only each plate's own filaments, sliced or not", async () => {
  const unsliced = await listModelPlates(STUDIO("two-plates-three-filaments-unsliced.3mf"));
  const sliced = await listModelPlates(STUDIO("two-plates-three-filaments-sliced.3mf"));
  assert.deepEqual(filamentsOf(unsliced), [[0, [1, 3]], [1, [2]]]);
  assert.deepEqual(filamentsOf(sliced), filamentsOf(unsliced), "the derivation agrees with Studio's slice");
  assert.deepEqual(unsliced.plates[0].filaments, [
    { index: 1, colour: "#000000", material: "PLA", filament_id: "GFA00", name: "Body" },
    { index: 3, colour: "#5B6579", material: "PLA", filament_id: "GFA00", name: "Trim" }]);
  assert.deepEqual(sliced.plates[1].filaments, [{ index: 2, colour: "#FEC600", material: "PLA", filament_id: "GFA00", name: "Lid" }]);
  assert.deepEqual(unsliced.project_filaments.map(f => [f.index, f.colour]), [[1, "#000000"], [2, "#FEC600"], [3, "#5B6579"]], "every declared filament, for slice_stl's one profile per filament");
});

// Nov 6 repro: the Kass 3D scan rig (six plates, Studio-saved metadata). The Screws plate prints only filament 3;
// filaments 1 and 2 belong to parts on other plates and must not be offered for it.
test("the scan rig's Screws plate prints only its own filament, not the other plates'", async (t) => {
  const file = await write3mf(t, {
    "3D/3dmodel.model": MODEL,
    "Metadata/model_settings.config": fs.readFileSync(new URL("./fixtures/kass-scan-rig-model_settings.config", import.meta.url)),
    "Metadata/project_settings.config": fs.readFileSync(new URL("./fixtures/kass-scan-rig-project_settings.config", import.meta.url)),
  });
  const result = await listModelPlates(file);
  assert.deepEqual(filamentsOf(result), [[0, [3]], [1, [1]], [2, [1]], [3, [2]], [4, [1]], [5, [1]]]);
  assert.deepEqual(result.plates[0].filaments[0], { index: 3, colour: "#FF0000", material: "PLA", filament_id: "GFA00", name: "_____(1)" });
});

test("painted facets decode as Bambu Studio stores them", () => {
  assert.deepEqual(paintedStates("4"), [1]);
  assert.deepEqual(paintedStates("8"), [2]);
  assert.deepEqual(paintedStates("2C"), [5], "3 + the next nibble");
  assert.deepEqual(paintedStates("0FC"), [18], "each 0b1111 nibble adds 15");
  assert.deepEqual(paintedStates("841"), [1, 2], "a split facet's children");
  assert.deepEqual(paintedStates("0841"), [1, 2], "trailing nibbles past the tree are not read");
  assert.deepEqual(paintedStates("zz"), []);
});

const paintedProject = ({ objects, plates, project = {}, meshes = {}, extra = {} }) => ({
  "3D/3dmodel.model": `<?xml version="1.0"?><model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"><resources>${objects.map(o => `<object id="${o.id}" type="model"><components>${o.parts.map(part => `<component p:path="/3D/Objects/object_${o.id}.model" objectid="${part.id}"/>`).join("")}</components></object>`).join("")}</resources><build>${objects.map(o => `<item objectid="${o.id}"${o.printable === false ? ' printable="0"' : ""}/>`).join("")}</build></model>`,
  "Metadata/model_settings.config": `<config>${objects.map(o => `<object id="${o.id}"><metadata key="name" value="${o.name}"/>${Object.entries(o.settings ?? {}).map(([k, v]) => `<metadata key="${k}" value="${v}"/>`).join("")}${o.parts.map(part => `<part id="${part.id}" subtype="${part.subtype ?? "normal_part"}"><metadata key="name" value="${part.name ?? ""}"/>${Object.entries(part.settings ?? {}).map(([k, v]) => `<metadata key="${k}" value="${v}"/>`).join("")}</part>`).join("")}</object>`).join("")}${plates.map((ids, i) => `<plate><metadata key="plater_id" value="${i + 1}"/>${ids.map(id => `<model_instance><metadata key="object_id" value="${id}"/></model_instance>`).join("")}</plate>`).join("")}</config>`,
  "Metadata/project_settings.config": JSON.stringify({ filament_colour: ["#111111", "#222222", "#333333", "#444444", "#555555"], filament_type: ["PLA", "PLA", "PETG", "PLA", "PLA-S"], ...project }),
  ...Object.fromEntries(objects.map(o => [`3D/Objects/object_${o.id}.model`, `<model><resources>${o.parts.map(part => `<object id="${part.id}" type="model"><mesh><vertices/><triangles>${(meshes[`${o.id}/${part.id}`] ?? ['<triangle v1="0" v2="1" v3="2"/>']).join("")}</triangles></mesh></object>`).join("")}</resources></model>`])),
  ...extra,
});

test("a plate's painted, support, layer-range and tool-change filaments count; other plates' never do", async (t) => {
  const file = await write3mf(t, paintedProject({
    objects: [
      // Fully painted with filaments 2 and 4: the part's own filament 1 never prints.
      { id: 10, name: "Painted", settings: { extruder: "1" }, parts: [{ id: 1, name: "shell" }] },
      // Support on for this object, with filament 5 for support.
      { id: 11, name: "Supported", settings: { extruder: "1", enable_support: "1", support_filament: "5" }, parts: [{ id: 1, name: "arm" }] },
      // A negative part and a support blocker print nothing; a modifier prints with its filament.
      { id: 12, name: "Holes", settings: { extruder: "1" }, parts: [{ id: 1, name: "body" }, { id: 2, subtype: "negative_part", settings: { extruder: "4" } }, { id: 3, subtype: "support_blocker", settings: { extruder: "4" } }, { id: 4, subtype: "modifier_part", name: "insert", settings: { extruder: "3" } }] },
      // On plate 2: a layer range in filament 2.
      { id: 13, name: "Ranged", settings: { extruder: "3" }, parts: [{ id: 1 }] },
      // Not printable anywhere.
      { id: 14, name: "Hidden", settings: { extruder: "5" }, parts: [{ id: 1 }], printable: false },
    ],
    plates: [[10, 11, 12], [13, 14]],
    meshes: { "10/1": ['<triangle v1="0" v2="1" v3="2" paint_color="8"/>', '<triangle v1="0" v2="1" v3="2" paint_color="881"/>', '<triangle v1="0" v2="1" v3="2" paint_color="1C"/>'] },
    extra: {
      "Metadata/layer_config_ranges.xml": `<objects><object id="4"><range min_z="0" max_z="2"><option opt_key="extruder">2</option></range></object></objects>`,
      "Metadata/custom_gcode_per_layer.xml": `<custom_gcodes_per_layer><plate><plate_info id="2"/><layer top_z="1" type="2" extruder="5"/><layer top_z="2" type="0" extruder="4"/></plate></custom_gcodes_per_layer>`,
    },
  }));
  const result = await listModelPlates(file);
  assert.deepEqual(filamentsOf(result), [[0, [1, 2, 3, 4, 5]], [1, [2, 3, 5]]]);
  // Filament 1 is on plate 1 only through the unpainted parts; 4 only through painting (the negative part's 4 doesn't print).
  assert.deepEqual(result.plates[0].filaments.map(f => [f.index, f.name]), [[1, "arm"], [2, "shell"], [3, "insert"], [4, "shell"], [5, undefined]]);
});

test("a fully painted part drops its own filament; the project's support filament counts when support is on", async (t) => {
  const file = await write3mf(t, paintedProject({
    objects: [{ id: 10, name: "Painted", settings: { extruder: "1" }, parts: [{ id: 1, name: "shell" }] }],
    plates: [[10]],
    project: { enable_support: "1", support_filament: "0", support_interface_filament: "3" },
    meshes: { "10/1": ['<triangle v1="0" v2="1" v3="2" paint_color="8"/>'] },
  }));
  assert.deepEqual(filamentsOf(await listModelPlates(file)), [[0, [2, 3]]]);
});

test("a mixed filament counts as the filaments it mixes, as Bambu Studio expands it", async (t) => {
  const file = await write3mf(t, paintedProject({
    objects: [{ id: 10, name: "Blend", settings: { extruder: "3" }, parts: [{ id: 1, name: "gradient" }] }],
    plates: [[10]],
    project: { filament_is_mixed: ["0", "0", "1", "0", "0"], filament_mixed_components: ["", "", "1,4", "", ""] },
  }));
  assert.deepEqual((await listModelPlates(file)).plates[0].filaments.map(f => [f.index, f.name]), [[1, "gradient"], [4, "gradient"]]);
});

// feature filaments the project sets print on a part that names no extruder, and the slice applies a
// part's or object's feature filament whatever separate_filaments_for_features says (PrintObject.cpp:3105-3150).
test("feature filaments count as the slice applies them: the project's when no extruder is named, the object's always", async (t) => {
  const file = await write3mf(t, paintedProject({
    objects: [
      { id: 10, name: "Plain", parts: [{ id: 1, name: "plain" }] },
      { id: 11, name: "Infill", settings: { extruder: "1", sparse_infill_filament: "4", separate_filaments_for_features: "0" }, parts: [{ id: 1, name: "core" }] },
      { id: 12, name: "Named", settings: { extruder: "5" }, parts: [{ id: 1, name: "named" }] },
    ],
    plates: [[10], [11], [12]],
    project: { wall_filament: "2", sparse_infill_filament: "3", solid_infill_filament: "2" },
  }));
  assert.deepEqual(filamentsOf(await listModelPlates(file)), [[0, [2, 3]], [1, [1, 4]], [2, [5]]]);
});

// support and raft resolve one key at a time, each the object's own else the project's
// (PrintObject::object_config_from_model_object, PrintObject.cpp:3052-3063); support filament 0 follows the object.
test("support and raft overrides resolve independently, as the slice resolves them", async (t) => {
  const object = (id, settings) => ({ id, name: `O${id}`, settings: { extruder: "1", ...settings }, parts: [{ id: 1, name: `o${id}` }] });
  const file = await write3mf(t, paintedProject({
    objects: [
      object(10, { raft_layers: "0" }),                       // project support on: support still prints
      object(11, { enable_support: "0" }),                    // support off, no raft
      object(12, { enable_support: "0", raft_layers: "2" }),  // a raft prints with the support filament
      object(13, { support_filament: "0" }),                  // project support on, its own default filament
      object(14, { support_interface_filament: "4" }),        // interface on filament 4, support on the project's 5
    ],
    plates: [[10], [11], [12], [13], [14]],
    project: { enable_support: "1", raft_layers: "0", support_filament: "5", support_interface_filament: "0" },
  }));
  assert.deepEqual(filamentsOf(await listModelPlates(file)), [[0, [1, 5]], [1, [1]], [2, [1, 5]], [3, [1]], [4, [1, 4, 5]]]);
});

// printable is per copy. Each build item is its object's next instance with its own printable flag
// (bbs_3mf.cpp:4183-4185, 4375-4380); a plate names copies by instance_id and the CLI skips unprintable ones
// (PartPlate.cpp:1311-1322).
test("an object printable on one plate and not on another counts only where its copy prints", async (t) => {
  const settings = `<config><object id="10"><metadata key="name" value="Peg"/><metadata key="extruder" value="2"/><part id="1" subtype="normal_part"><metadata key="name" value="peg"/></part></object>`
    + `<object id="11"><metadata key="name" value="Base"/><metadata key="extruder" value="1"/><part id="1" subtype="normal_part"><metadata key="name" value="base"/></part></object>`
    + `<plate><metadata key="plater_id" value="1"/><model_instance><metadata key="object_id" value="10"/><metadata key="instance_id" value="0"/></model_instance><model_instance><metadata key="object_id" value="11"/><metadata key="instance_id" value="0"/></model_instance></plate>`
    + `<plate><metadata key="plater_id" value="2"/><model_instance><metadata key="object_id" value="10"/><metadata key="instance_id" value="1"/></model_instance><model_instance><metadata key="object_id" value="11"/><metadata key="instance_id" value="1"/></model_instance></plate></config>`;
  const model = `<?xml version="1.0"?><model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="10" type="model"><mesh><vertices/><triangles/></mesh></object><object id="11" type="model"><mesh><vertices/><triangles/></mesh></object></resources>`
    + `<build><item objectid="10" printable="1"/><item objectid="11" printable="1"/><item objectid="10" printable="0"/><item objectid="11" printable="1"/></build></model>`;
  const file = await write3mf(t, { "3D/3dmodel.model": model, "Metadata/model_settings.config": settings,
    "Metadata/project_settings.config": JSON.stringify({ filament_colour: ["#111111", "#222222"], filament_type: ["PLA", "PLA"] }) });
  assert.deepEqual(filamentsOf(await listModelPlates(file)), [[0, [1, 2]], [1, [1]]], "the Peg's second copy isn't printable: plate 2 prints only the Base");
});

// A component without p:path names a mesh object in the root model itself (bbs_3mf.cpp:4131-4148, 3891): its
// painting is read there.
test("painting on a component mesh kept in the root model counts", async (t) => {
  const model = `<?xml version="1.0"?><model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>`
    + `<object id="1" type="model"><mesh><vertices/><triangles><triangle v1="0" v2="1" v3="2" paint_color="8"/><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>`
    + `<object id="10" type="model"><components><component objectid="1"/></components></object></resources><build><item objectid="10"/></build></model>`;
  const settings = `<config><object id="10"><metadata key="name" value="Badge"/><metadata key="extruder" value="1"/><part id="1" subtype="normal_part"><metadata key="name" value="badge"/></part></object>`
    + `<plate><metadata key="plater_id" value="1"/><model_instance><metadata key="object_id" value="10"/><metadata key="instance_id" value="0"/></model_instance></plate></config>`;
  const file = await write3mf(t, { "3D/3dmodel.model": model, "Metadata/model_settings.config": settings,
    "Metadata/project_settings.config": JSON.stringify({ filament_colour: ["#111111", "#222222"], filament_type: ["PLA", "PLA"] }) });
  assert.deepEqual(filamentsOf(await listModelPlates(file)), [[0, [1, 2]]], "filament 2 is painted on; the unpainted facet keeps filament 1");
});
