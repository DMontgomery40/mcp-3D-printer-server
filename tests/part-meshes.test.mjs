import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { trackedMkdtempSync } from "./support/temp.mjs";
import { partMeshes, PART_MESHES_OUTPUT_SCHEMA } from "../dist/counterpart/part-meshes.js";
import { makeCounterpart3mf, writeCadProject3mf } from "../dist/counterpart/make-3mf.js";
import { stlTriangles } from "../dist/slicer/floating-regions.js";

function folder(t) {
  const directory = trackedMkdtempSync(path.join(os.tmpdir(), "part-meshes-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
// A unit cube's 12 triangles as 3MF mesh text, corner at the origin.
const CUBE = (() => {
  const v = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
  const t = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return `<mesh><vertices>${v.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join("")}</vertices><triangles>${t.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join("")}</triangles></mesh>`;
})();
function bounds(file) {
  const tris = stlTriangles(fs.readFileSync(file));
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  tris.forEach((v, i) => { min[i % 3] = Math.min(min[i % 3], v); max[i % 3] = Math.max(max[i % 3], v); });
  return { min: min.map(v => Math.round(v * 1000) / 1000), max: max.map(v => Math.round(v * 1000) / 1000), triangles: tris.length / 9 };
}

// scan-to-make #845: a designer's Bambu Studio project, meshes in a model part, two plates, a copy, a modifier and a
// non-printable item. Every part comes back in the build frame, coloured from the project's filaments.
test("counterpart_part_meshes writes each printable part of a designer's 3MF in the build frame, in its colour", async t => {
  const dir = folder(t);
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("3D/3dmodel.model", `<?xml version="1.0"?><model unit="centimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"><resources>
    <object id="10" type="model"><components>
      <component p:path="/3D/Objects/object_1.model" objectid="1" transform="2 0 0 0 1 0 0 0 1 0 0 0"/>
      <component p:path="/3D/Objects/object_1.model" objectid="2" transform="1 0 0 0 1 0 0 0 1 0 0 1"/>
      <component p:path="/3D/Objects/object_1.model" objectid="3"/>
    </components></object>
    <object id="20" type="model">${CUBE}</object>
    <object id="30" type="model">${CUBE}</object>
  </resources><build>
    <item objectid="10" transform="1 0 0 0 1 0 0 0 1 10 20 0"/>
    <item objectid="20" transform="0 1 0 -1 0 0 0 0 1 5 0 0"/>
    <item objectid="10" transform="1 0 0 0 1 0 0 0 1 40 20 0"/>
    <item objectid="30" printable="0"/>
  </build></model>`);
  zip.file("3D/Objects/object_1.model", `<model unit="centimeter"><resources><object id="1">${CUBE}</object><object id="2">${CUBE}</object><object id="3">${CUBE}</object></resources></model>`);
  zip.file("Metadata/model_settings.config", `<config>
    <object id="10"><metadata key="name" value="Lamp"/><metadata key="extruder" value="1"/>
      <part id="1" subtype="normal_part"><metadata key="name" value="Shade"/><metadata key="extruder" value="2"/></part>
      <part id="2" subtype="normal_part"><metadata key="name" value="Cap"/></part>
      <part id="3" subtype="modifier_part"><metadata key="name" value="Infill box"/></part>
    </object>
    <object id="20"><metadata key="name" value="Foot"/><metadata key="extruder" value="3"/></object>
    <object id="30"><metadata key="name" value="Hidden"/></object>
    <plate><metadata key="plater_id" value="1"/><model_instance><metadata key="object_id" value="10"/><metadata key="instance_id" value="0"/></model_instance><model_instance><metadata key="object_id" value="20"/><metadata key="instance_id" value="0"/></model_instance></plate>
    <plate><metadata key="plater_id" value="2"/><model_instance><metadata key="object_id" value="10"/><metadata key="instance_id" value="1"/></model_instance><model_instance><metadata key="object_id" value="30"/><metadata key="instance_id" value="0"/></model_instance></plate>
  </config>`);
  zip.file("Metadata/project_settings.config", JSON.stringify({ filament_colour: ["#ff0000", "#00FF00FF", "#0000ff"], filament_type: ["PLA", "PLA", "PETG"] }));
  const source = path.join(dir, "lamp.3mf");
  fs.writeFileSync(source, await zip.generateAsync({ type: "nodebuffer" }));

  const result = await partMeshes({ three_mf_path: source, out_dir: dir });
  assert.equal(result.contract, "counterpart/1");
  assert.equal(result.units, "mm");
  assert.equal(result.folder, path.join(fs.realpathSync(dir), "lamp-parts-1"));
  assert.equal(result.skipped, undefined);
  assert.deepEqual(result.parts.map(({ stl_path, ...p }) => p), [
    { id: "1/1", name: "Shade", plate: 1, color: "#00FF00", filament: 2, triangles: 12, size_mm: [20, 10, 10] },
    { id: "1/2", name: "Cap", plate: 1, color: "#FF0000", filament: 1, triangles: 12, size_mm: [10, 10, 10] },
    { id: "2/20", name: "Foot", plate: 1, color: "#0000FF", filament: 3, triangles: 12, size_mm: [10, 10, 10] },
    { id: "3/1", name: "Shade", plate: 2, color: "#00FF00", filament: 2, triangles: 12, size_mm: [20, 10, 10] },
    { id: "3/2", name: "Cap", plate: 2, color: "#FF0000", filament: 1, triangles: 12, size_mm: [10, 10, 10] },
  ]);
  // Centimetres to millimetres, the component's scale and offset, then the build item's: the parts line up.
  assert.deepEqual(bounds(result.parts[0].stl_path), { min: [100, 200, 0], max: [120, 210, 10], triangles: 12 });
  assert.deepEqual(bounds(result.parts[1].stl_path), { min: [100, 200, 10], max: [110, 210, 20], triangles: 12 });
  // A rotated item: x' = -y, y' = x, then 5 cm along x.
  assert.deepEqual(bounds(result.parts[2].stl_path), { min: [40, 0, 0], max: [50, 10, 10], triangles: 12 });
  assert.deepEqual(bounds(result.parts[3].stl_path).min, [400, 200, 0]);
  for (const part of result.parts) assert.equal(path.dirname(part.stl_path), result.folder);
  // The output keeps to its schema's required fields.
  for (const key of PART_MESHES_OUTPUT_SCHEMA.required) assert.ok(key in result, key);
  // A second call never touches the first folder.
  const again = await partMeshes({ three_mf_path: source, out_dir: dir });
  assert.equal(again.folder, path.join(fs.realpathSync(dir), "lamp-parts-2"));
  await assert.rejects(partMeshes({ three_mf_path: source, out_dir: path.join(dir, "missing") }), /out_dir must be an existing folder/);
  await assert.rejects(partMeshes({ three_mf_path: source, out_dir: dir, extra: 1 }), /accepts only/);
});

// The DAD pass's 3MF carried extruder numbers and no colours (#858); counterpart_make_3mf now writes them, and they
// come back from counterpart_part_meshes, with no plate for a one-plate file.
test("counterpart_make_3mf writes each part's colour, and counterpart_part_meshes reads it back aligned", async t => {
  const dir = folder(t);
  const box = (name, [x0, y0, z0], [x1, y1, z1]) => {
    const file = path.join(dir, `${name}.stl`);
    const c = (i) => [i & 1 ? x1 : x0, i & 2 ? y1 : y0, i & 4 ? z1 : z0];
    const faces = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]].flatMap(([a, b, cc, d]) => [[a, b, cc], [a, cc, d]]);
    fs.writeFileSync(file, `solid ${name}\n${faces.map(f => `facet normal 0 0 0\nouter loop\n${f.map(i => `vertex ${c(i).join(" ")}`).join("\n")}\nendloop\nendfacet`).join("\n")}\nendsolid\n`);
    return file;
  };
  const bar = box("bar", [0, 0, 0], [190, 20, 30]), letters = box("letters", [10, 5, 30], [180, 15, 100]);
  const made = path.join(dir, "dad.3mf");
  const result = await makeCounterpart3mf({ out_path: made, parts: [
    { stl_path: bar, name: "Bar", filament: 1, color: "#b0855d" }, { stl_path: letters, name: "Letters", filament: 2, color: "#1A1A1A" }] });
  assert.deepEqual(result.parts.map(p => p.color), ["#B0855D", "#1A1A1A"]);
  const zip = await JSZip.loadAsync(fs.readFileSync(made));
  assert.deepEqual(JSON.parse(await zip.file("Metadata/project_settings.config").async("string")), { filament_colour: ["#B0855D", "#1A1A1A"] });
  const meshes = await partMeshes({ three_mf_path: made, out_dir: dir });
  assert.deepEqual(meshes.parts.map(({ stl_path, id, ...p }) => p), [
    { name: "Bar", color: "#B0855D", filament: 1, triangles: 12, size_mm: [190, 20, 30] },
    { name: "Letters", color: "#1A1A1A", filament: 2, triangles: 12, size_mm: [170, 10, 70] },
  ]);
  // Still lined up: the letters sit 10 mm in and on top of the bar, wherever the plate put the assembly.
  const [b, l] = meshes.parts.map(p => bounds(p.stl_path));
  assert.deepEqual([l.min[0] - b.min[0], l.min[1] - b.min[1], l.min[2] - b.min[2]], [10, 5, 30]);
  // Without colours the file is exactly as before: no project settings.
  const plain = path.join(dir, "plain.3mf");
  await makeCounterpart3mf({ out_path: plain, parts: [{ stl_path: bar, name: "Bar" }] });
  assert.equal((await JSZip.loadAsync(fs.readFileSync(plain))).file("Metadata/project_settings.config"), null);
  assert.equal((await partMeshes({ three_mf_path: plain, out_dir: dir })).parts[0].color, undefined);
  // Colours for some parts but not all, two colours on one filament, or not a colour: refused.
  await assert.rejects(makeCounterpart3mf({ out_path: path.join(dir, "a.3mf"), parts: [{ stl_path: bar, name: "Bar", color: "#ffffff" }, { stl_path: letters, name: "L" }] }), /every part a color, or none/);
  await assert.rejects(makeCounterpart3mf({ out_path: path.join(dir, "b.3mf"), parts: [{ stl_path: bar, name: "Bar", filament: 1, color: "#ffffff" }, { stl_path: letters, name: "L", filament: 1, color: "#000000" }] }), /two colours/);
  await assert.rejects(makeCounterpart3mf({ out_path: path.join(dir, "c.3mf"), parts: [{ stl_path: bar, name: "Bar", filament: 2, color: "#ffffff" }] }), /No part uses filament 1/);
  await assert.rejects(makeCounterpart3mf({ out_path: path.join(dir, "d.3mf"), parts: [{ stl_path: bar, name: "Bar", color: "red" }] }), /#RRGGBB/);
});

// The guidance sends a multi-colour design through cad_run's project_3mf (#859 fix 5): its colours reach the file too.
test("a cad_run project_3mf with part colours declares them, and counterpart_part_meshes reads them", async t => {
  const dir = folder(t);
  const parts = path.join(dir, "parts");
  fs.mkdirSync(parts);
  const cube = (x) => `solid c\n${[[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]
    .map(f => `facet normal 0 0 0\nouter loop\n${f.map(i => `vertex ${(i & 1 ? 10 : 0) + x} ${i & 2 ? 10 : 0} ${i & 4 ? 10 : 0}`).join("\n")}\nendloop\nendfacet`).join("\n")}\nendsolid c\n`;
  fs.writeFileSync(path.join(parts, "0.stl"), cube(0));
  fs.writeFileSync(path.join(parts, "1.stl"), cube(10));
  const out = path.join(dir, "sign.3mf");
  await writeCadProject3mf({ version: 1, objects: [{ name: "Sign", plate: 1, parts: [
    { stl: 0, name: "Bar", filament: 1, color: "#B0855D" }, { stl: 1, name: "Letters", filament: 2, color: "#1A1A1A" }] }] }, parts, {}, out);
  const meshes = await partMeshes({ three_mf_path: out, out_dir: dir });
  assert.deepEqual(meshes.parts.map(p => [p.name, p.color, p.filament]), [["Bar", "#B0855D", 1], ["Letters", "#1A1A1A", 2]]);
});
