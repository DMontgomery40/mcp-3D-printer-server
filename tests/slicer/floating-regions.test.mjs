import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { floatingRegions, floatingWarningFacts, stlTriangles, SLICE_WARNING_RULE } from "../../dist/slicer/floating-regions.js";

// An axis-aligned box as outward-wound triangles.
function box([x0, y0, z0], [x1, y1, z1]) {
  const p = (i) => [i & 1 ? x1 : x0, i & 2 ? y1 : y0, i & 4 ? z1 : z0];
  const quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  return quads.flatMap(([a, b, c, d]) => [[a, b, c], [a, c, d]]).flatMap((t) => t.flatMap((i) => p(i)));
}
// A polygon in the x-z plane (counter-clockwise seen from -y), swept from y = 0 to y = depth: one welded body.
function prism(outline, depth) {
  const v = (i, y) => [outline[i % outline.length][0], y, outline[i % outline.length][1]];
  const out = [];
  for (let i = 0; i < outline.length; i++) out.push(...v(i, 0), ...v(i + 1, 0), ...v(i + 1, depth), ...v(i, 0), ...v(i + 1, depth), ...v(i, depth));
  // the end caps, fanned from the inner corner (index 2), which sees every other vertex
  for (let i = 3; i < outline.length + 1; i++) {
    out.push(...v(2, 0), ...v(i, 0), ...v(i + 1, 0));
    out.push(...v(2, depth), ...v(i + 1, depth), ...v(i, depth));
  }
  return out;
}
// A four-sided pyramid hanging point-down from a square at height top.
function pyramid([cx, cy], half, top, tip) {
  const s = [[cx - half, cy - half, top], [cx + half, cy - half, top], [cx + half, cy + half, top], [cx - half, cy + half, top]];
  const t = [cx, cy, tip];
  const sides = [0, 1, 2, 3].flatMap((i) => [...s[(i + 1) % 4], ...s[i], ...t]);
  return [...sides, ...s[0], ...s[1], ...s[2], ...s[0], ...s[2], ...s[3]];
}
function binarySTL(values) {
  const n = values.length / 9;
  const buf = Buffer.alloc(84 + n * 50);
  buf.writeUInt32LE(n, 80);
  for (let i = 0; i < n; i++) for (let k = 0; k < 9; k++) buf.writeFloatLE(values[i * 9 + k], 84 + i * 50 + 12 + k * 4);
  return buf;
}

// scan-to-make #859, pass B: the slicer said "has floating regions" and nothing about where, six rebuilds followed.
test("floatingRegions finds a speck in mid-air and a point hanging from a shelf, not the shelf, the plate or a void", () => {
  const model = [
    ...prism([[0, 0], [10, 0], [10, 20], [40, 20], [40, 30], [0, 30]], 20), // a post with a shelf out from it (not floating)
    ...pyramid([30, 10], 2, 20, 18.5),          // a point hanging 1.5 mm under the shelf
    ...box([60, 0, 5], [62, 2, 6]),             // a speck in mid-air, 5 mm up
    ...box([80, 0, 0], [90, 10, 10]),           // a second foot on the plate
  ];
  // A closed void inside the second foot, wound inward: its ceiling hangs, but its floor faces up and starts nothing.
  const cavity = box([82, 2, 4], [88, 8, 6]);
  for (let i = 0; i < cavity.length; i += 9) model.push(...cavity.slice(i, i + 3), ...cavity.slice(i + 6, i + 9), ...cavity.slice(i + 3, i + 6));
  // The whole model 3 mm up: z is measured from its lowest point, where the slicer puts the plate.
  const tris = Float64Array.from(model.map((v, i) => (i % 3 === 2 ? v + 3 : v)));
  const found = floatingRegions(tris);
  assert.equal(found.model_min_z, 3, "the STL's lowest z is reported; z is measured from it");
  assert.deepEqual(found.regions, [
    { z: 18.5, depth_mm: 1.5, box_mm: { min: [28, 8, 18.5], max: [32, 12, 20] } },
    { z: 5, depth_mm: 1, box_mm: { min: [60, 0, 5], max: [62, 2, 6] } },
  ]);
  assert.equal(found.count, 2);
  // Binary and ASCII STL read the same.
  assert.deepEqual(Array.from(stlTriangles(binarySTL(Array.from(tris)))), Array.from(tris).map((v) => Math.fround(v)));
  const ascii = `solid t\n${Array.from({ length: tris.length / 9 }, (_, i) => `facet normal 0 0 0\nouter loop\n${[0, 1, 2].map((k) => `vertex ${tris[i * 9 + k * 3]} ${tris[i * 9 + k * 3 + 1]} ${tris[i * 9 + k * 3 + 2]}`).join("\n")}\nendloop\nendfacet`).join("\n")}\nendsolid t\n`;
  assert.deepEqual(floatingRegions(stlTriangles(Buffer.from(ascii))).regions, found.regions);
});

test("floatingWarningFacts adds the stop rule and the places only for a floating-regions warning", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "floating-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stl = path.join(dir, "m.stl");
  fs.writeFileSync(stl, binarySTL([...box([0, 0, 0], [10, 10, 10]), ...box([20, 0, 4], [21, 1, 5])]));
  const warned = { failed: false, message: "It seems object m.stl has floating regions. Please re-orient the object or enable support generation." };
  const facts = await floatingWarningFacts(warned, stl, false);
  assert.equal(facts.next, SLICE_WARNING_RULE);
  assert.match(SLICE_WARNING_RULE, /one targeted fix and one re-slice, then stops/);
  assert.match(SLICE_WARNING_RULE, /a separate body in mid-air, or on a feature that carries load or makes a fit, is not cosmetic/);
  assert.deepEqual(facts.floating_regions.regions, [{ z: 4, depth_mm: 1, box_mm: { min: [20, 0, 4], max: [21, 1, 5] } }]);
  assert.match(facts.floating_regions.frame, /z is millimetres above its lowest point/);
  assert.match((await floatingWarningFacts(warned, stl, true)).floating_regions_unlocated, /turned or scaled the model/);
  assert.match((await floatingWarningFacts(warned, path.join(dir, "m.3mf"), false)).floating_regions_unlocated, /Only an STL/);
  assert.match((await floatingWarningFacts(warned, path.join(dir, "gone.stl"), false)).floating_regions_unlocated, /Could not read the STL/);
  assert.deepEqual(await floatingWarningFacts({ failed: false, message: "It seems object m.stl has floating cantilever." }, stl, false), {});
  assert.deepEqual(await floatingWarningFacts({ failed: true, message: "floating regions" }, stl, false), {});
  assert.deepEqual(await floatingWarningFacts(undefined, stl, false), {});
});
