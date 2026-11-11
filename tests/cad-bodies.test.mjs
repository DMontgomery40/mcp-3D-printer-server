// Bodies in a cad_run result: the council's print-in-place failures of 2026-11-11 (scan-to-make #734), rebuilt in
// build123d. Each passed as valid: true with nothing else to say. Needs a Python with the pinned CAD runtime:
// CAD_PYTHON, or CAD_E2E_DATA_DIR/runtime/bin/python after cad_setup.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const worker = fileURLToPath(new URL("../src/cad/worker.py", import.meta.url));
const fixtures = fileURLToPath(new URL("./fixtures/cad-bodies/", import.meta.url));
const python =
  process.env.CAD_PYTHON ??
  (process.env.CAD_E2E_DATA_DIR
    ? path.join(process.env.CAD_E2E_DATA_DIR, "runtime", "bin", "python")
    : undefined);
const runtime = {
  skip:
    !python ||
    spawnSync(python, ["-I", "-c", "import build123d"], { timeout: 60000 })
      .status !== 0
      ? "set CAD_PYTHON (or CAD_E2E_DATA_DIR) to a Python with the pinned CAD runtime"
      : false,
  timeout: 300000,
};

function inspect(fixture, parameters = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cad-bodies-"));
  try {
    fs.writeFileSync(path.join(dir, "p.json"), JSON.stringify(parameters));
    const request = path.join(dir, "request.json");
    fs.writeFileSync(
      request,
      JSON.stringify({
        output: dir,
        name: "part",
        script: path.join(fixtures, fixture),
        parameters: path.join(dir, "p.json"),
        mode: "solid",
      }),
    );
    for (const mode of ["build", "inspect"]) {
      const r = spawnSync(python, ["-I", "-B", worker, mode, request], {
        encoding: "utf8",
        timeout: 240000,
      });
      assert.equal(r.status, 0, r.stderr);
      if (mode === "inspect") return JSON.parse(r.stdout);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("links that touch or sit under the print-in-place clearance are named, even when valid is true", runtime, () => {
  const good = inspect("links.py");
  assert.deepEqual(good.problems, []);
  assert.equal(good.bodies.declared_bodies.length, 5);
  assert.ok(good.checked.some((c) => /each near pair of the 5 solids/.test(c)));

  const close = inspect("links.py", { post_grow: 1.1 });
  assert.equal(close.valid, true, "the geometry itself is sound");
  assert.ok(close.bodies.too_close.length > 0);
  assert.ok(close.bodies.too_close.every((r) => r.gap_mm < 0.3 && r.gap_mm > 0.19));
  assert.ok(close.problems.some((p) => /under the 0\.3 mm print-in-place clearance/.test(p)));

  const fused = inspect("links.py", { post_grow: 1.5 });
  assert.equal(fused.valid, true, "overlapping links export as sound separate shells");
  assert.ok(fused.bodies.fused.length >= 6);
  assert.ok(fused.problems.some((p) => /touch or overlap .*print as one piece/.test(p)));
});

test("the clearance comes from P when the script declares it", runtime, () => {
  const r = inspect("links.py", { post_grow: 0.5, print_in_place_clearance_mm: 1.5 });
  assert.equal(r.bodies.clearance_mm, 1.5);
  assert.match(r.bodies.clearance_source, /print_in_place_clearance_mm/);
  assert.ok(r.bodies.too_close.length > 0, "1.4 mm posts are now under the declared 1.5 mm");
});

test("a severed body cannot hide behind a fused pair in the solid count (Gemini's fidget v1)", runtime, () => {
  const good = inspect("fidget.py");
  assert.deepEqual(good.problems, []);
  assert.deepEqual(
    good.bodies.declared_bodies.map((b) => b.solids),
    [1, 1],
  );

  const v1 = inspect("fidget.py", { v1: 1 });
  assert.equal(v1.valid, true);
  assert.ok(v1.problems.some((p) => /body "frame" is 2 separate solids/.test(p)));
  assert.ok(v1.problems.some((p) => /frame piece \d and wheel touch or overlap/.test(p)));

  // fused into one shape with no labels the count reads 2 again: the result says identity was not checked
  const masked = inspect("fidget.py", { v1: 1, declare: 0 });
  assert.equal(masked.solid_count, 2);
  assert.equal(masked.bodies.declared_bodies, null);
  assert.ok(masked.not_checked.some((c) => /which solids are meant to be separate bodies/.test(c)));
});

test("solids that start above the bed are named (Astra's floating discs)", runtime, () => {
  assert.deepEqual(inspect("discs.py").problems, []);
  const floating = inspect("discs.py", { floating: 1 });
  assert.equal(floating.bodies.above_bed.length, 3);
  assert.ok(floating.problems.every((p) => /starts 1\.6 mm above the print plate .*printed on air/.test(p)));
});

test("curved pairs under the clearance are measured exactly, not cleared by the tessellation screen", runtime, () => {
  // the screen reads two R50 balls 0.28 mm apart as about 0.33 mm (Muse's review)
  const spheres = inspect("curved.py", { kind: "spheres", gap: 0.28 });
  assert.equal(spheres.bodies.too_close.length, 1);
  assert.equal(spheres.bodies.too_close[0].gap_mm, 0.28);
  assert.equal(spheres.bodies.too_close[0].exact, true);
  assert.ok(spheres.problems.some((p) => /0\.28 mm apart/.test(p)));
  assert.deepEqual(inspect("curved.py", { kind: "spheres", gap: 0.35 }).bodies.too_close, []);
  assert.equal(inspect("curved.py", { kind: "pins", gap: 0.25 }).bodies.too_close.length, 1);
  const pin = inspect("curved.py", { kind: "pin", gap: 0.15 });
  assert.equal(pin.bodies.too_close[0].gap_mm, 0.15);
  assert.deepEqual(inspect("curved.py", { kind: "pin", gap: 0.4 }).problems, []);
});

test("bodies shown assembled are held to touching only, and say the clearance was not checked", runtime, () => {
  const fit = inspect("curved.py", { kind: "pin", gap: 0.15, print_in_place: false });
  assert.deepEqual(fit.problems, []);
  assert.equal(fit.bodies.print_in_place, false);
  assert.ok(fit.not_checked.some((c) => /print-in-place clearance/.test(c)));
  assert.ok(inspect("curved.py", { kind: "pin", gap: -0.1, print_in_place: false }).bodies.fused.length === 1, "interference is still a problem");
});

test("the print plate is Z = 0, and a solid resting on a solid that reaches it is supported", runtime, () => {
  assert.deepEqual(inspect("plate.py", { case: "on" }).problems, []);
  assert.ok(inspect("plate.py", { case: "floating" }).problems.some((p) => /starts 10(\.0)? mm above the print plate/.test(p)));
  assert.ok(inspect("plate.py", { case: "below" }).problems.some((p) => /below the print plate/.test(p)));
  assert.equal(inspect("plate.py", { case: "pair" }).problems.length, 2);
  const lid = inspect("plate.py", { case: "lid" });
  assert.deepEqual(lid.problems, []);
  assert.equal(lid.bodies.above_bed[0].rests_on, "a");
  assert.ok(lid.checked.some((c) => /Z = 0 of the exported frame/.test(c)));
});

test("problems say how many more there are", runtime, () => {
  const r = inspect("many.py", { gap: 0.2 });
  assert.equal(r.bodies.too_close.length, 24);
  assert.ok(r.problems.some((p) => /and 16 more pairs under the clearance/.test(p)));
});

test("a single valid solid still lists what valid does not prove", runtime, () => {
  const r = inspect("discs.py");
  for (const gap of [/fit to the real object/, /strength/, /motion/, /printing/])
    assert.ok(r.not_checked.some((c) => gap.test(c)), String(gap));
});

// The exact-measurement cap and per-pair failures, on in-memory shapes (no export): geometry.bodies() directly.
function probe(body) {
  const r = spawnSync(python, ["-I", "-B", "-c", `import sys,json\nsys.path.insert(0, ${JSON.stringify(path.dirname(worker))})\nimport geometry\nfrom build123d import Box, Compound, Pos, Solid\n${body}`], { encoding: "utf8", timeout: 240000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").pop());
}
const row = "def row(n, gap):\n out=[]\n for k in range(n):\n  b=Pos(k*(5+gap),0,2.5)*Box(5,5,5); b.label=f'box {k+1}'; out.append(b)\n return Compound(children=out)\n";

test("exact calls are capped, and pairs past the cap are reported as screened, not cleared", runtime, () => {
  const r = probe(`${row}geometry.EXACT_CAP=4\nb=geometry.bodies(row(10,0.31),{})\nprint(json.dumps({'exact':b['exact_measurements'],'screened':b['screened_only'],'unconfirmed':len(b['unconfirmed']),'problems':b['problems'],'ev':geometry.evidence(b)['not_checked']}))`);
  assert.equal(r.exact, 4);
  assert.equal(r.screened, 5);
  assert.equal(r.unconfirmed, 5);
  assert.ok(r.problems.some((p) => /not measured exactly/.test(p)));
  assert.ok(r.ev.some((c) => /only screened/.test(c)), "the pair check moves to not_checked");
});

test("one pair that cannot be measured does not cost the rest of the evidence", runtime, () => {
  const r = probe(`${row}orig=Solid.distance_to_with_closest_points\ncalls=[0]\ndef flaky(self, other):\n calls[0]+=1\n if calls[0]==2: raise RuntimeError('boom')\n return orig(self, other)\nSolid.distance_to_with_closest_points=flaky\nb=geometry.bodies(row(4,0.2),{})\nprint(json.dumps({'too_close':len(b['too_close']),'not':b['pairs_not_measured'],'errors':b['errors'],'problems':b['problems']}))`);
  assert.equal(r.too_close, 2);
  assert.equal(r.not.length, 1);
  assert.match(r.errors[0], /boom/);
  assert.ok(r.problems.some((p) => /1 near pair\(s\) were not measured/.test(p)));
});
