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

function inspect(fixture, mode = "solid", extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cad-purpose-"));
  try {
    fs.writeFileSync(path.join(dir, "p.json"), "{}");
    const request = path.join(dir, "request.json");
    fs.writeFileSync(request, JSON.stringify({ output: dir, name: "part", script: path.join(fixtures, fixture), parameters: path.join(dir, "p.json"), mode, ...extra }));
    for (const step of ["build", "inspect"]) {
      const r = spawnSync(python, ["-I", "-B", worker, step, request], { encoding: "utf8", timeout: 240000 });
      assert.equal(r.status, 0, r.stderr);
      if (step === "inspect") {
        const result = JSON.parse(r.stdout);
        result.useRendered = !!result.renders.use && fs.existsSync(result.renders.use);
        result.files = fs.readdirSync(dir);
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

test("a use() that raises keeps the export and blocks ready with what to fix", runtime, () => {
  const r = inspect("use_raises.py");
  assert.equal(r.valid, true);
  assert.equal(r.ready, false);
  assert.match(r.purpose.blocked[0], /^Fix use\(\) \(it raised NameError/);
});

test("use() must show the part build() exports, not another one", runtime, () => {
  const r = inspect("use_not_built.py");
  assert.equal(r.ready, false);
  assert.equal(find(r, "use is the built part").status, "fail");
  assert.match(r.purpose.blocked.join(" "), /^Build the part in use\(\) from build\(\)/);
});

test("a use() part with the built part's volume but another shape is not the built part", runtime, () => {
  // A 100 x 100 x 0.36 mm pad and the 30 x 30 x 4 mm strip build() exports are both 3600 mm^3.
  const r = inspect("use_same_volume.py");
  assert.equal(r.ready, false);
  assert.equal(find(r, "use is the built part").status, "fail");
  assert.match(r.purpose.blocked.join(" "), /Build the part in use\(\) from build\(\)[^.]*its shape is not the shape build\(\) exports/);
});

test("a held body inside the part does not sit on it; one resting on its face does", runtime, () => {
  const inside = inspect("held_inside.py");
  assert.equal(inside.ready, false);
  assert.equal(find(inside, "holds phone").status, "pass", "it touches the part");
  assert.equal(find(inside, "held phone is outside the part").status, "fail");
  assert.match(inside.purpose.blocked.join(" "), /Move held:phone out of the part in use\(\)/);
  const touching = inspect("held_touching.py");
  assert.equal(find(touching, "holds phone").status, "pass");
  assert.equal(find(touching, "held phone is outside the part"), undefined, "real contact adds no failure");
});

test("a thin held body buried whole inside the part does not sit on it, however thin its overlap", runtime, () => {
  // A 0.3 mm photo centred in a 20 mm slab: its overlap's average depth is 0.3 mm, but all of it is inside the part.
  const r = inspect("held_buried.py");
  assert.equal(r.ready, false);
  assert.equal(find(r, "held photo is outside the part").status, "fail");
  assert.match(r.purpose.blocked.join(" "), /Move held:photo out of the part in use\(\)/);
});

test("a base partly over a desk's edge touches it, with the patch the size of the overlap; a floating one does not", runtime, () => {
  // 100 x 60 mm, 30 mm over the edge: its bottom face is two triangles, each with a corner off the desk.
  const on = inspect("overhang_base.py");
  const mount = find(on, "mounts desk");
  assert.equal(mount.status, "pass", mount.says);
  const area = Number(/^(\d+) mm\^2/.exec(mount.says)[1]);
  assert.ok(Math.abs(area - 4200) <= 420, `${area} mm^2 of a 4200 mm^2 overlap`);
  const off = inspect("floating_base.py");
  assert.equal(find(off, "mounts desk").status, "not_modelled");
  assert.match(find(off, "mounts desk").says, /does not touch world:desk/);
});

test("a base across a narrow shelf touches it with no corner on it; a huge base stays cheap; a floating one does not touch", runtime, () => {
  const area = mount => Number(/^(\d+) mm\^2/.exec(mount.says)[1]);
  // 100 x 60 mm centred across a 300 x 20 mm shelf: 2000 mm^2 on it, and none of the base's corners.
  const across = find(inspect("shelf_base.py"), "mounts shelf");
  assert.equal(across.status, "pass", across.says);
  assert.ok(Math.abs(area(across) - 2000) <= 200, `${area(across)} mm^2 of a 2000 mm^2 overlap`);
  // 2000 x 2000 mm on the same shelf: 6000 mm^2, split only where the shelf is.
  const started = Date.now();
  const huge = find(inspect("shelf_huge_base.py"), "mounts shelf");
  assert.equal(huge.status, "pass", huge.says);
  assert.ok(Math.abs(area(huge) - 6000) <= 600, `${area(huge)} mm^2 of a 6000 mm^2 overlap`);
  assert.ok(Date.now() - started < 120_000, `${Date.now() - started} ms`);
  const off = find(inspect("shelf_floating.py"), "mounts shelf");
  assert.equal(off.status, "not_modelled");
});

const status = (r, prefix) => find(r, prefix)?.status;
const peak = (r, kase) => r.purpose.loads.find((l) => l.case === kase).peak_tension_kpa;

test("tape that cannot carry the load is refused, with the stress computed from the geometry", runtime, () => {
  const r = inspect("tape_overload.py");
  assert.equal(r.ready, false);
  assert.equal(status(r, "tape on wall, sustained"), "fail");
  assert.ok(peak(r, "gravity") > 30, String(peak(r, "gravity")));
  assert.match(r.purpose.blocked.join(" "), /Spread the tape or bring the load closer to it/);
});

test("the 30 mm strip puts more tension on its tape than the 60 mm pad does, under the same phone", runtime, () => {
  const strip = inspect("strip_square.py"), pad = inspect("ball_aimed.py");
  assert.ok(peak(strip, "gravity") > peak(pad, "gravity"), `${peak(strip, "gravity")} vs ${peak(pad, "gravity")}`);
  const worst = (r) => Math.max(...r.purpose.loads.map((l) => l.peak_tension_kpa));
  assert.ok(worst(strip) > worst(pad), `${worst(strip)} vs ${worst(pad)}`);
});

test("tape whose contact is not one flat patch fails closed", runtime, () => {
  const r = inspect("tape_curved.py");
  assert.equal(r.ready, false);
  assert.match(r.purpose.blocked.join(" "), /Model the taped contact as one flat patch per mount, on a flat world body/);
});

test("a mount declared 'other' that carries a held body blocks ready", runtime, () => {
  const r = inspect("other_kind.py");
  assert.equal(r.ready, false);
  assert.match(r.purpose.blocked.join(" "), /pick the nearest real kind: tape, rests, screw, clamp or hook/);
});

test("a mix of mount kinds still checks its tape", runtime, () => {
  const r = inspect("mixed_tape.py");
  assert.ok(find(r, "tape on wall"), JSON.stringify(r.purpose.requirements.map((q) => q.requirement)));
  assert.match(find(r, "tape on wall").says, /kPa/);
});

test("the designer's numbers have floors: a held mass, a press, a facing allowance", runtime, () => {
  const r = inspect("floors.py");
  assert.equal(r.ready, false);
  assert.match(r.purpose.blocked.join(" "), /phone in PURPOSE\["holds"\] needs its real mass/);
  assert.equal(r.purpose.press_n, 1.5);
  assert.equal(r.purpose.within_deg, 25);
});

test("a light, bulky real object passes the held-mass check: a paper-towel roll at about 0.094 g/cm3", runtime, () => {
  const r = inspect("towel_roll.py");
  assert.equal(find(r, "held roll size and mass"), undefined, JSON.stringify(r.purpose.blocked));
  assert.equal(r.ready, true, JSON.stringify(r.purpose.blocked));
});

test("a held body far larger than the object it stands for is refused", runtime, () => {
  const r = inspect("oversized_held.py");
  assert.equal(r.ready, false);
  assert.match(r.purpose.blocked.join(" "), /Model the keys at its real size and mass: 80 g in the 27000\.0 cm\^3 held:keys/);
});

test("a held object whose mass does not fit its size is refused", runtime, () => {
  const r = inspect("dense_held.py");
  assert.equal(r.ready, false);
  assert.match(r.purpose.blocked.join(" "), /Model the keys at its real size and mass/);
});

test("a world surface shaped to the part is not a surface: tape and rests need a real slab", runtime, () => {
  const r = inspect("shaped_world.py");
  assert.equal(r.ready, false);
  assert.match(r.purpose.blocked.join(" "), /Model the cabinet as one slab where it really is, not a block shaped to the part/);
});

test("the product class reads modelled_on and the body names too, not for alone", runtime, () => {
  const classes = (purpose) => {
    const r = spawnSync(python, ["-I", "-c", `import sys, json; sys.path.insert(0, ${JSON.stringify(path.dirname(worker))}); from purpose import compile_purpose; print(json.dumps(compile_purpose(json.loads(sys.argv[1]))["classes"]))`, JSON.stringify(purpose)], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  // "for" alone names none of these; the bought product and the bodies do
  assert.deepEqual(classes({ for: "something to keep my maps in view while I drive", modelled_on: "iOttie dash mount",
    holds: [{ body: "phone", mass_g: 200 }], mounts: [{ body: "dashboard", by: "tape" }] }), ["holder", "vehicle", "screen"]);
  assert.deepEqual(classes({ for: "a small pot for a succulent", modelled_on: "a terracotta cactus pot" }), []);
});

test("mesh mode evaluates no purpose and never calls use()", runtime, () => {
  const r = inspect("mesh_use.py", "mesh");
  assert.equal(r.purpose, undefined);
  assert.equal(r.ready, undefined);
  assert.ok(!r.files.some((f) => /\.use\.(step|error)$/.test(f)), r.files.join(", "));
});

test("a check run evaluates no purpose: a fit reference is not the design", runtime, () => {
  const r = inspect("strip_square.py", "solid", { role: "check" });
  assert.equal(r.purpose, undefined);
  assert.equal(r.ready, undefined);
});
