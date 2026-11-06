import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import JSZip from "jszip";
import { bedFromMachine, objTriangles, plateColumns, splitToPlates } from "../../dist/slicer/bed-plates.js";
import { plainSlicerError, UNKNOWN_SLICER_ERROR } from "../../dist/slicer/slicer-messages.js";
import { slicerReport } from "../../dist/counterpart/sliced-file.js";
import { sliceCapabilities } from "../../dist/slicer/capabilities.js";

// The P1S as its flattened Bambu Studio preset has it: the 256 mm bed, the purge chute's corner, 250 mm tall.
const P1S = bedFromMachine({ printable_area: ["0x0", "256x0", "256x256", "0x256"], bed_exclude_area: ["0x0", "18x0", "18x28", "0x28"], printable_height: "250" });

/** A binary STL of axis-aligned boxes, each its own closed shell. */
function boxesStl(boxes) {
  const corners = ([x0, y0, z0], [x1, y1, z1]) => [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const buffer = Buffer.alloc(84 + boxes.length * faces.length * 50);
  buffer.writeUInt32LE(boxes.length * faces.length, 80);
  let offset = 84;
  for (const [min, max] of boxes) {
    const vertices = corners(min, max);
    for (const face of faces) {
      offset += 12;
      for (const vertex of face) for (const value of vertices[vertex]) { buffer.writeFloatLE(value, offset); offset += 4; }
      offset += 2;
    }
  }
  return buffer;
}
const box = (x, y, w, d, h) => [[x, y, 0], [x + w, y + d, h]];

function workspace(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bed-plates-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
async function split(t, boxes, bed = P1S, extension = ".stl") {
  const directory = workspace(t);
  const modelPath = path.join(directory, `kit${extension}`);
  fs.writeFileSync(modelPath, boxes);
  const outPath = path.join(directory, "kit_plates.3mf");
  return { result: await splitToPlates({ modelPath, outPath, bed, printer: "P1S" }), outPath, modelPath, directory };
}

/** Each plate's objects and where their footprints land, read back from the written 3MF. */
async function readPlates(file) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const model = await zip.file("3D/3dmodel.model").async("string");
  const settings = await zip.file("Metadata/model_settings.config").async("string");
  const meshes = new Map();
  for (const [, id, body] of model.matchAll(/<object id="(\d+)" type="model">\s*<mesh>([\s\S]*?)<\/mesh>/g)) {
    const xs = [...body.matchAll(/x="([-\d.e]+)"/g)].map(m => Number(m[1])), ys = [...body.matchAll(/y="([-\d.e]+)"/g)].map(m => Number(m[1]));
    meshes.set(Number(id), { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) });
  }
  const items = new Map([...model.matchAll(/<item objectid="(\d+)" transform="1 0 0 0 1 0 0 0 1 ([-\d.e]+) ([-\d.e]+) 0"/g)]
    .map(m => [Number(m[1]), [Number(m[2]), Number(m[3])]]));
  const plates = [...settings.matchAll(/<plate>([\s\S]*?)<\/plate>/g)].map(([, block]) =>
    [...block.matchAll(/key="object_id" value="(\d+)"/g)].map(m => {
      const id = Number(m[1]), mesh = meshes.get(id - 1), [x, y] = items.get(id);
      return { id, minX: x + mesh.minX, maxX: x + mesh.maxX, minY: y + mesh.minY, maxY: y + mesh.maxY };
    }));
  return { plates, bytes: fs.readFileSync(file) };
}

// The reduced repro of David's six-plate kit (Nov 6): one STL holding the kit's plate groups side by side.
test("separate boxes laid out wider than the bed are arranged across plates, each inside its plate", async (t) => {
  // Three plate-sized groups 70 mm apart (as a designer exports a kit), one of two boxes 4 mm apart.
  const stl = boxesStl([box(0, 0, 200, 200, 10), box(270, 0, 100, 200, 20), box(374, 0, 100, 200, 20), box(544, 0, 230, 230, 5)]);
  const { result, outPath } = await split(t, stl);
  assert.equal(result.fits, false);
  assert.equal(result.three_mf_path, outPath);
  assert.deepEqual(result.bed_mm, [256, 256, 250]);
  assert.equal(result.plates.length, 3);
  assert.deepEqual(result.plates.map(plate => plate.index), [0, 1, 2]);
  assert.deepEqual(result.plates.map(plate => plate.name), ["Plate 1", "Plate 2", "Plate 3"]);
  assert.deepEqual(result.plates.flatMap(plate => plate.objects).sort(), ["Part 1", "Part 2", "Part 3", "Part 4"]);
  // The two boxes the designer put together stay on one plate.
  assert.ok(result.plates.some(plate => plate.objects.length === 2), JSON.stringify(result.plates));
  assert.match(result.message, /bigger than the P1S bed \(256 × 256 mm, 250 mm tall\), so its 4 parts are arranged on 3 plates/);
  const { plates } = await readPlates(outPath);
  const columns = plateColumns(3), stride = 256 * 1.2;
  plates.forEach((objects, index) => objects.forEach(object => {
    // Inside this plate of the slicer's plate grid, clear of the chute corner.
    const x0 = (index % columns) * stride, y0 = -Math.floor(index / columns) * stride;
    const [minX, maxX, minY, maxY] = [object.minX - x0, object.maxX - x0, object.minY - y0, object.maxY - y0];
    assert.ok(minX >= -1e-3 && maxX <= 256 + 1e-3 && minY >= -1e-3 && maxY <= 256 + 1e-3, `plate ${index + 1}: ${JSON.stringify(object)}`);
    assert.ok(minX >= 18 || minY >= 28, `plate ${index + 1} object over the excluded corner: ${JSON.stringify(object)}`);
  }));
});

test("the same model and bed give the same 3MF bytes", async (t) => {
  const stl = boxesStl([box(0, 0, 200, 200, 10), box(300, 0, 200, 200, 10)]);
  const first = await split(t, stl);
  // A later second: anything stamped with the time would change.
  await new Promise(resolve => setTimeout(resolve, 2100));
  const second = await split(t, stl);
  assert.deepEqual(fs.readFileSync(first.outPath), fs.readFileSync(second.outPath));
});

test("a model that fits the bed as it is is left to the slicer", async (t) => {
  const { result, outPath } = await split(t, boxesStl([box(0, 0, 100, 100, 10), box(120, 0, 100, 100, 10)]));
  assert.deepEqual(result, { fits: true });
  assert.equal(fs.existsSync(outPath), false);
});

test("a body larger than the bed is named with its size against the bed's, and nothing is written", async (t) => {
  const { result, outPath } = await split(t, boxesStl([box(0, 0, 100, 150, 10), box(400, 0, 300, 120, 40)]));
  assert.equal(result.fits, false);
  assert.equal(result.three_mf_path, undefined);
  assert.deepEqual(result.too_large, [{ name: "Part 2", size_mm: [300, 120, 40] }]);
  assert.equal(result.message, "Part 2 is 300 × 120 mm and 40 mm tall, larger than the P1S bed (256 × 256 mm, 250 mm tall), so it can't be printed on it as it is. Scale it down or cut it into pieces that fit.");
  assert.equal(fs.existsSync(outPath), false);
});

test("a body taller than the printer prints is too large too", async (t) => {
  const { result } = await split(t, boxesStl([box(0, 0, 50, 50, 300), box(300, 0, 50, 50, 10)]));
  assert.deepEqual(result.too_large, [{ name: "Part 1", size_mm: [50, 50, 300] }]);
});

// Kass 3D's 240 × 220 base fits a P1S only clear of the chute corner, and only one way round or the other.
test("a body that fits only beside the excluded corner is placed, never reported too large", async (t) => {
  const { result, outPath } = await split(t, boxesStl([box(0, 0, 240, 220, 2), box(300, 0, 254, 200, 2)]));
  assert.equal(result.fits, false);
  assert.equal(result.plates.length, 2);
  const { plates } = await readPlates(outPath);
  for (const [index, objects] of plates.entries()) for (const object of objects) {
    const x0 = (index % plateColumns(2)) * 256 * 1.2;
    assert.ok(object.minX - x0 >= -1e-3 && object.maxX - x0 <= 256 + 1e-3 && object.minY >= -1e-3 && object.maxY <= 256 + 1e-3);
    assert.ok(object.minX - x0 >= 18 - 1e-3 || object.minY >= 28 - 1e-3, JSON.stringify(object));
  }
});

test("parts nested in a group too big for one plate stay together, as they were", async (t) => {
  // A ring (its walls touch, so one body) around a peg, in a 400 mm group: the group splits, the ring and peg don't.
  const ring = [box(0, 0, 60, 10, 10), box(0, 50, 60, 10, 10), box(0, 10, 10, 40, 10), box(50, 10, 10, 40, 10)];
  const stl = boxesStl([...ring, box(25, 25, 10, 10, 10), box(70, 0, 200, 200, 10), box(280, 0, 120, 120, 10)]);
  const { result, outPath } = await split(t, stl);
  assert.equal(result.fits, false);
  // Back row first: the 200 mm box, the 120 mm box, the ring, then the peg, which is written in the ring's object.
  const objects = result.plates.flatMap(plate => plate.objects);
  assert.deepEqual(objects.sort(), ["Part 1", "Part 2", "Part 3"]);
  const { plates } = await readPlates(outPath);
  const ringPlate = plates[result.plates.findIndex(plate => plate.objects.includes("Part 3"))];
  const ringObject = ringPlate.find(object => Math.abs(object.maxX - object.minX - 60) < 1e-3);
  assert.ok(ringObject, "the ring and its peg are one 60 mm object");
  const zip = await JSZip.loadAsync(fs.readFileSync(outPath));
  const model = await zip.file("3D/3dmodel.model").async("string");
  const mesh = model.match(new RegExp(`<object id="${ringObject.id - 1}" type="model">\\s*<mesh>([\\s\\S]*?)</mesh>`))[1];
  assert.equal((mesh.match(/<triangle /g) ?? []).length, 4 * 12 + 12, "the ring's walls and the peg, in one mesh");
});

test("two parts over each other that only fit apart are arranged apart, never called too large", async (t) => {
  // A rod lying across a slab: their footprints overlap, together 250 × 260 mm, each fits the bed alone.
  const bed = bedFromMachine({ printable_area: ["0x0", "256x0", "256x256", "0x256"], printable_height: "250" });
  const { result } = await split(t, boxesStl([box(0, 0, 250, 200, 10), [[115, -60, 10], [135, 196, 20]]]), bed);
  assert.equal(result.too_large, undefined, JSON.stringify(result));
  assert.equal(result.plates.length, 2);
});

test("a model taller than the bed as one piece is split, not left to fail in the slicer", async (t) => {
  const { result } = await split(t, boxesStl([box(0, 0, 50, 50, 300), box(60, 0, 50, 50, 10)]));
  assert.deepEqual(result.too_large, [{ name: "Part 1", size_mm: [50, 50, 300] }]);
});

// A hollow part is an outer shell and an inner, inward-facing cavity shell. Written as two objects,
// the cavity would print as a solid inside a solid; it must stay in its part's mesh.
test("a hollow part's cavity shell stays in its part's mesh, so the part stays hollow", async (t) => {
  const outer = boxesStl([box(0, 0, 60, 60, 60)]);
  // The cavity: a box whose triangles face inward (each triangle's corners reversed).
  const cavity = boxesStl([box(10, 10, 40, 40, 40)]);
  for (let i = 0; i < cavity.readUInt32LE(80); i++) {
    const o = 84 + i * 50 + 12;
    const second = cavity.subarray(o + 12, o + 24), third = Buffer.from(cavity.subarray(o + 24, o + 36));
    cavity.copy(cavity, o + 24, o + 12, o + 24); third.copy(cavity, o + 12);
    void second;
  }
  const other = boxesStl([box(300, 0, 200, 200, 10)]);
  const stl = Buffer.concat([outer.subarray(0, 80), Buffer.alloc(4), outer.subarray(84), cavity.subarray(84), other.subarray(84)]);
  stl.writeUInt32LE((stl.length - 84) / 50, 80);
  const { result, outPath } = await split(t, stl);
  assert.equal(result.fits, false);
  // Three bodies, two objects: the hollow part (Part 2, its cavity Part 3 inside it) and the slab (Part 1).
  assert.deepEqual(result.plates.flatMap(plate => plate.objects).sort(), ["Part 1", "Part 2"]);
  const zip = await JSZip.loadAsync(fs.readFileSync(outPath));
  const model = await zip.file("3D/3dmodel.model").async("string");
  const meshes = [...model.matchAll(/<mesh>([\s\S]*?)<\/mesh>/g)].map(([, body]) => (body.match(/<triangle /g) ?? []).length);
  assert.deepEqual(meshes.sort((a, b) => a - b), [12, 24], "the cavity's 12 triangles are in the hollow part's mesh");
});

test("an OBJ model is split the same way", async (t) => {
  const quad = (x, w) => `v ${x} 0 0\nv ${x + w} 0 0\nv ${x + w} 200 0\nv ${x} 200 0\nv ${x} 0 5\nv ${x + w} 0 5\nv ${x + w} 200 5\nv ${x} 200 5\n`;
  const faces = base => [[1, 2, 3, 4], [5, 8, 7, 6], [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 8, 4], [4, 8, 5, 1]].map(f => `f ${f.map(i => `${i + base}/1/1`).join(" ")}`).join("\n");
  const obj = `# two slabs\n${quad(0, 200)}${faces(0)}\n${quad(300, 200)}${faces(8)}\n`;
  assert.equal(objTriangles(obj).length, 2 * 12 * 9);
  const { result } = await split(t, obj, P1S, ".obj");
  assert.equal(result.plates.length, 2);
});

test("the bed comes from the flattened preset: its printable area, excluded polygon and height", () => {
  // fdm_bbl_3dp_001_common's L-shaped exclusion, with its repeated corner point.
  const bed = bedFromMachine({ printable_area: ["0x0", "256x0", "256x256", "0x256"], bed_exclude_area: ["0x0", "28x0", "28x28", "0x28", "0x28", "8x28", "8x256", "0x256"], printable_height: ["250"] });
  assert.deepEqual({ width: bed.width, depth: bed.depth, height: bed.height }, { width: 256, depth: 256, height: 250 });
  assert.deepEqual(bed.excluded.sort((a, b) => a.y - b.y || a.x - b.x), [{ x: 0, y: 0, w: 8, d: 28 }, { x: 8, y: 0, w: 20, d: 28 }, { x: 0, y: 28, w: 8, d: 228 }]);
  assert.deepEqual(bedFromMachine(undefined, [180, 180, 180]), { x: 0, y: 0, width: 180, depth: 180, height: 180, excluded: [] });
  assert.throws(() => bedFromMachine({}), /bed size is unknown/);
});

test("slice capabilities say where split_to_plates works", () => {
  assert.equal(sliceCapabilities("bambustudio", true).plates, true);
  assert.equal(sliceCapabilities("orcaslicer-bambulab", false).plates, true);
  assert.equal(sliceCapabilities("orcaslicer", true).plates, true);
  assert.equal(sliceCapabilities("orcaslicer", false).plates, false);
  assert.equal(sliceCapabilities("prusaslicer", false).plates, false);
  assert.equal(sliceCapabilities("cura", false).plates, false);
});

// The slicers' own strings (Bambu Studio 02.09 and OrcaSlicer binaries, PrusaSlicer 2.9.2 and CuraEngine source).
test("slicer refusals map to plain sentences, and unknown words to a plain fallback", () => {
  const empty = plainSlicerError("One of the plate is empty or has no object fully inside it. Please check that the 3mf contains no empty plate in Bambu Studio before uploading.");
  assert.match(empty, /^Nothing on this plate can be printed/);
  for (const words of [
    "Cannot send the print job for empty plate",
    ": Nothing to be sliced, Either the print is empty or no object is fully inside the print volume before apply.",
    "Found no objects in print volume to slice.",
    "All objects are outside of the print volume.",
    "Nothing to print for a.gcode . Either the print is empty or no object is fully inside the print volume.",
  ]) assert.equal(plainSlicerError(words), empty, words);
  const off = plainSlicerError("An object is laid over the boundary of plate or exceeds the height limit.");
  assert.match(off, /across the edge of the plate/);
  assert.equal(plainSlicerError("Following objects are laid over the boundary of plate or exceeds the height limit:\nPart 1"), off);
  assert.equal(plainSlicerError("An object is laid over the plate boundaries."), off);
  assert.match(plainSlicerError("Object too large"), /larger than the printer's bed/);
  assert.match(plainSlicerError("The object exceeds the maximum build volume height."), /taller than the printer can print/);
  assert.match(plainSlicerError("Found G-code outside of the printable area. The issue may be caused by support, wipe tower, brim, or skirt."), /outside the area the printer can reach/);
  assert.match(plainSlicerError("[warning] Stopping process because there are no non-empty layers."), /would print nothing/);
  assert.match(plainSlicerError("The supplied settings will cause an empty print."), /would print nothing/);
  assert.equal(plainSlicerError("Failed slicing the model."), undefined);
  // slicer_report: the sentence for the person, the slicer's words for the log.
  const words = "One of the plate is empty or has no object fully inside it. Please check that the 3mf contains no empty plate in Bambu Studio before uploading.";
  assert.deepEqual(slicerReport({ return_code: -50, error_string: words, sliced_plates: [] }), { failed: true, message: empty, slicer_message: words });
  assert.deepEqual(slicerReport({ return_code: -100, error_string: "Failed slicing the model." }), { failed: true, message: UNKNOWN_SLICER_ERROR, slicer_message: "Failed slicing the model." });
  assert.deepEqual(slicerReport({ return_code: -100 }), { failed: true, message: UNKNOWN_SLICER_ERROR, slicer_message: "return code -100" });
});
