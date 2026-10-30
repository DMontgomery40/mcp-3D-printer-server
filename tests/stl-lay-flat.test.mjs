import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as THREE from "three";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import { STLManipulator } from "../dist/stl/stl-manipulator.js";

// A 30 x 20 x 2 plate must rest on a 600 mm² face, regardless of its
// starting orientation. Excluding Z-aligned normals stands it on an edge.
for (const [name, rotation] of [
  ["horizontal", [0, 0, 0]],
  ["upside down", [Math.PI, 0, 0]],
  ["on its edge", [Math.PI / 2, 0, 0]],
  ["tilted", [0.4, 0.7, 0.2]],
]) {
  test(`lay_flat rests the ${name} plate on its largest face at Z=0`, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "stl-lay-flat-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const geometry = new THREE.BoxGeometry(30, 20, 2);
    geometry.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...rotation)));
    geometry.translate(13, -7, 42);
    const original = new STLExporter().parse(new THREE.Mesh(geometry));
    geometry.dispose();
    const input = path.join(directory, "plate.stl");
    await fs.writeFile(input, original);
    const manipulator = new STLManipulator(directory);

    const output = await manipulator.layFlat(input);
    const info = await manipulator.getSTLInfo(output);
    assert.ok(Math.abs(info.boundingBox.dimensions.z - 2) < 0.0001,
      `plate height should be 2 mm, got ${info.boundingBox.dimensions.z}`);
    assert.ok(Math.abs(info.boundingBox.min.z) < 0.0001,
      `plate should touch Z=0, got ${info.boundingBox.min.z}`);
    assert.equal(info.faceCount, 12);
    assert.notEqual(output, input);
    assert.equal(await fs.readFile(input, "utf8"), original, "input must remain unchanged");

    // Laying an already flattened output down again must not stand it up.
    const repeated = await manipulator.layFlat(output);
    const repeatedInfo = await manipulator.getSTLInfo(repeated);
    assert.ok(Math.abs(repeatedInfo.boundingBox.dimensions.z - 2) < 0.0001);
    assert.ok(Math.abs(repeatedInfo.boundingBox.min.z) < 0.0001);
    assert.notEqual(repeated, output);
  });
}
