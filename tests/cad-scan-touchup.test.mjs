import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The CAD runtime's libraries (numpy, scipy, trimesh, manifold3d, Pillow); CAD_TEST_PYTHON names a runtime that has them.
const python = process.env.CAD_TEST_PYTHON ?? "python3";
const check = fileURLToPath(new URL("./scan_touchup_check.py", import.meta.url));
const ready = spawnSync(python, ["-c", "import numpy, scipy, trimesh, manifold3d, PIL"], { timeout: 30000 }).status === 0;

test(
  "scan_touchup cleans, refines without shrinking, adds measured relief and places a flat card, beads, a cord and a seat",
  { skip: ready ? false : "needs the CAD runtime's Python libraries (set CAD_TEST_PYTHON)" },
  () => {
    const r = spawnSync(python, [check], { encoding: "utf8", timeout: 300000 });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const result = JSON.parse(r.stdout.trim().split("\n").at(-1));
    assert.equal(result.ok, true);
    assert.ok(result.seconds < 60, `took ${result.seconds} s`);
  },
);

test(
  "scan_touchup regions survives a colour region of one or two vertices (scan-to-make #858)",
  { skip: ready ? false : "needs the CAD runtime's Python libraries (set CAD_TEST_PYTHON)" },
  () => {
    const r = spawnSync(python, [fileURLToPath(new URL("./scan_touchup_regions_check.py", import.meta.url))], {
      encoding: "utf8",
      timeout: 120000,
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.equal(JSON.parse(r.stdout.trim().split("\n").at(-1)).ok, true);
  },
);

test(
  "measure_scan isolates an object from its turntable and floating pieces and measures it once (scan-to-make #859)",
  { skip: ready ? false : "needs the CAD runtime's Python libraries (set CAD_TEST_PYTHON)" },
  () => {
    // DAD_SCAN_MESH: the DAD pass's scan/mesh.obj, a private capture, checked only where it is present.
    const r = spawnSync(python, [fileURLToPath(new URL("./scan_measure_check.py", import.meta.url))], { encoding: "utf8", timeout: 180000 });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.equal(JSON.parse(r.stdout.trim().split("\n").at(-1)).ok, true);
  },
);
