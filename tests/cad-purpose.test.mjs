// What a design is for, evaluated on the design as it is used (scan-to-make #608). The council of 2026-11-11 found
// the engine verified only what the designer wrote down: a phone holder square to the cabin on a 30 mm taped strip
// passed. Needs a Python with the pinned CAD runtime: CAD_PYTHON, or CAD_E2E_DATA_DIR/runtime/bin/python.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const worker = fileURLToPath(new URL("../src/cad/worker.py", import.meta.url));
const fixtures = fileURLToPath(new URL("./fixtures/cad-purpose/", import.meta.url));
const python =
  process.env.CAD_PYTHON ??
  (process.env.CAD_E2E_DATA_DIR ? path.join(process.env.CAD_E2E_DATA_DIR, "runtime", "bin", "python") : undefined);
const runtime = {
  skip:
    !python || spawnSync(python, ["-I", "-c", "import build123d"], { timeout: 60000 }).status !== 0
      ? "set CAD_PYTHON (or CAD_E2E_DATA_DIR) to a Python with the pinned CAD runtime"
      : false,
  timeout: 300000,
};

function inspect(fixture, mode = "solid") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cad-purpose-"));
  try {
    fs.writeFileSync(path.join(dir, "p.json"), "{}");
    const request = path.join(dir, "request.json");
    fs.writeFileSync(request, JSON.stringify({ output: dir, name: "part", script: path.join(fixtures, fixture), parameters: path.join(dir, "p.json"), mode }));
    for (const step of ["build", "inspect"]) {
      const r = spawnSync(python, ["-I", "-B", worker, step, request], { encoding: "utf8", timeout: 240000 });
      assert.equal(r.status, 0, r.stderr);
      if (step === "inspect") {
        const result = JSON.parse(r.stdout);
        result.useRendered = !!result.renders.use && fs.existsSync(result.renders.use);
        return result;
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const find = (result, prefix) => result.purpose.requirements.find((r) => r.requirement.startsWith(prefix));

test("round 7b's holder, square to the cabin on a taped strip, is not ready: it does not face the driver", runtime, () => {
  const r = inspect("strip_square.py");
  assert.equal(r.valid, true);
  assert.equal(r.ready, false);
  assert.deepEqual(r.purpose.classes, ["holder", "vehicle", "screen"]);
  assert.equal(r.purpose.jolt_g, 1.5, "a vehicle takes jolts whatever the designer lists");
  const faces = find(r, "faces user");
  assert.equal(faces.status, "fail");
  assert.ok(faces.angle_deg > 30, String(faces.angle_deg));
  // what blocks it reads as the next step, not a verdict (cad_run's next quotes it)
  assert.ok(r.purpose.blocked.some((b) => /^Turn the phone toward the user: its face is \d+ deg off/.test(b)), r.purpose.blocked.join(" | "));
  assert.ok(r.purpose.loads.length >= 8, "gravity, six jolts and a press");
  assert.ok(r.useRendered);
});

test("a broad taped pad with the cradle aimed at the driver is ready, its tape loads computed from the geometry", runtime, () => {
  const r = inspect("ball_aimed.py");
  assert.equal(r.ready, true, JSON.stringify(r.purpose.blocked));
  assert.ok(find(r, "faces user").angle_deg < 10);
  const sustained = find(r, "tape on dash, sustained");
  assert.equal(sustained.status, "pass");
  assert.match(sustained.says, /kPa/);
  assert.ok(r.purpose.loads[0].moment_nm > 0, "the phone's weight out from the pad is a moment at the tape");
  assert.ok(r.checked.some((c) => c.startsWith("what PURPOSE says")));
});

test("a stand that tips when its phone is pressed is not ready", runtime, () => {
  const r = inspect("tall_stand.py");
  assert.equal(r.ready, false);
  const rests = find(r, "rests on desk");
  assert.equal(rests.status, "fail");
  assert.match(rests.says, /tips over/);
  assert.match(r.purpose.blocked[0], /^Widen or lengthen the base under the load/);
});

test("a mount the purpose names but use() never models blocks ready as not modelled", runtime, () => {
  const r = inspect("no_world.py");
  assert.equal(r.ready, false);
  assert.equal(find(r, "mounts desk").status, "not_modelled");
  assert.deepEqual(r.purpose.blocked, ["Model the desk as world:desk in use(): a solid slab where it really is, touching the part where it is taped, so the tape mount can be checked."]);
});

test("a solid design with no PURPOSE is not ready; one that holds nothing needs no use()", runtime, () => {
  const none = inspect("plain_box.py");
  assert.equal(none.ready, false);
  assert.equal(none.purpose.declared, false);
  assert.match(none.purpose.blocked[0], /^Add PURPOSE = \{"for": \.\.\., "modelled_on": \.\.\.\} beside P/);
  const pot = inspect("plain_purpose.py");
  assert.equal(pot.ready, true, JSON.stringify(pot.purpose.blocked));
  assert.equal(pot.useRendered, false);
});
