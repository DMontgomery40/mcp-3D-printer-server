import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FlightRecords } from "../dist/counterpart/flight-record.js";
import { geometryFromGcode } from "../dist/counterpart/print-geometry.js";
const hash = "a".repeat(64);
function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flight-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, store: new FlightRecords({ dir, ...options }) };
}
const dispatch = {
  jobName: "checked-job.gcode.3mf",
  sha256: hash,
  mapping: [0],
  materials: ["PLA"],
};
const report = (layer, extra = {}) => ({
  subtask_name: "checked-job",
  gcode_state: "RUNNING",
  layer_num: layer,
  total_layer_num: 100,
  ...extra,
});

test("slot-0 feed loss and FINISH replay survives restart with raw changes and no leaked credentials", (t) => {
  const { store, dir } = setup(t);
  const id = store.begin("dummy-host\nprivate-serial", dispatch);
  store.observe(
    "dummy-host\nprivate-serial",
    report(1, {
      nozzle_temper: 220,
      nozzle_target_temper: 220,
      ams: {
        tray_now: "0",
        ams: [
          {
            id: "0",
            tray: [
              {
                id: "0",
                tray_type: "PLA",
                tray_info_idx: "GFA01",
                remain: 20,
                access_code: "SECRET",
              },
            ],
          },
        ],
      },
      hms: [],
      print_error: 0,
      mc_print_stage: "1",
      mc_print_sub_stage: 0,
    }),
  );
  store.observe(
    "dummy-host\nprivate-serial",
    report(40, {
      nozzle_temper: 219.5,
      ams: {
        tray_now: "0",
        ams: [
          {
            id: "0",
            tray: [
              { id: "0", tray_type: "PLA", tray_info_idx: "GFA01", remain: 0 },
            ],
          },
        ],
      },
      hms: [{ attr: 1, code: 2 }],
      print_error: 123,
      fail_reason: 456,
      mc_print_sub_stage: 3,
      access_code: "SECRET",
      url: "mqtt://SECRET",
    }),
  );
  store.observe(
    "dummy-host\nprivate-serial",
    report(100, {
      gcode_state: "FINISH",
      nozzle_temper: 206.9,
      nozzle_target_temper: 0,
    }),
  );
  const view = new FlightRecords({ dir }).read("dummy-host\nprivate-serial", {
    jobId: id,
  });
  assert.equal(view.record.dispatch.sha256, hash);
  assert.deepEqual(view.record.dispatch.mapping, [0]);
  assert.equal(view.record.reports.length, 3);
  assert.equal(view.record.reports[1].changes.print_error, 123);
  assert.equal(view.record.reports[1].changes.ams.ams[0].tray[0].remain, 0);
  assert.equal(view.record.reports[2].changes.gcode_state, "FINISH");
  assert.equal(view.physical.status, "unknown");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  assert.ok(files.length);
  const saved = files
    .map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
    .join("");
  for (const secret of ["SECRET", "dummy-host", "private-serial", "mqtt://"])
    assert.ok(!saved.includes(secret));
  assert.equal(new FlightRecords({ dir }).read("other").status, "unavailable");
});
test("deduplicates reports, ignores other jobs and preserves terminal evidence when bounded", (t) => {
  const { store, dir } = setup(t, { maxEvents: 4 });
  store.begin("p", dispatch);
  store.observe("p", report(1));
  store.observe("p", report(1));
  store.observe("p", report(9, { subtask_name: "another-job" }));
  assert.equal(store.read("p").record.reports.length, 1);
  for (let layer = 2; layer <= 10; layer++) store.observe("p", report(layer));
  store.observe("p", report(100, { gcode_state: "FINISH" }));
  const view = new FlightRecords({ dir, maxEvents: 4 }).read("p");
  assert.ok(view.record.reports.length <= 4);
  assert.ok(view.record.droppedReports > 0);
  assert.equal(view.record.latest.gcode_state, "FINISH");
  assert.equal(view.record.latest.layer_num, 100);
});
test("retention is bounded across printer keys, arbitrary IDs and corrupt records cannot read outside storage", (t) => {
  const { store, dir } = setup(t, { maxJobs: 2 });
  for (let i = 0; i < 4; i++)
    store.begin("p" + i, { ...dispatch, jobName: "job" + i });
  assert.equal(
    fs.readdirSync(dir).filter((f) => f.endsWith(".json")).length,
    2,
  );
  assert.throws(() => store.read("p3", { jobId: "../../outside" }));
  fs.writeFileSync(path.join(dir, "unrelated.json"), "{bad");
  assert.doesNotThrow(() => new FlightRecords({ dir }).read("p3"));
});
test("expected layer geometry comes from actual extrusion, excluding configuration/startup/end Z", () => {
  const geometry = geometryFromGcode(
    "; max_z_height: 80\nG1 Z200\nM83\n; CHANGE_LAYER\n; Z_HEIGHT: 0.2\nG1 X10 Y10\nG1 X20 Y10 E1\n; CHANGE_LAYER\n; Z_HEIGHT: 40\nG1 X20 Y30 E1\n; CHANGE_LAYER\n; Z_HEIGHT: 80\nG1 X10 Y30 E1\n; EXECUTABLE_BLOCK_END\nG1 Z200",
  );
  assert.equal(geometry.heightMm, 80);
  assert.equal(geometry.layers.length, 3);
  assert.equal(geometry.layers[1].zMm, 40);
  assert.ok(geometry.layers[1].boundsMm);
  assert.equal(geometryFromGcode("G1 Z200").layers.length, 0);
});
test("sampled frames bind to exact layer/height and are readable after restart without a camera", async (t) => {
  const { store, dir } = setup(t);
  const expected = {
    heightMm: 80,
    layers: Array.from({ length: 100 }, (_, i) => ({
      layer: i + 1,
      zMm: (i + 1) * 0.8,
    })),
  };
  store.begin("p", { ...dispatch, expected });
  let calls = 0;
  const capture = async () => {
    calls++;
    return { base64: Buffer.from([255, 216, 255, 217]).toString("base64") };
  };
  for (const layer of [5, 30, 60, 90, 100]) {
    store.observe("p", report(layer));
    await store.sample("p", capture);
  }
  const replay = new FlightRecords({ dir });
  const ids = replay
    .read("p")
    .record.frames.slice(0, 4)
    .map((f) => f.id);
  const view = replay.read("p", { includeFrames: true, frameIds: ids });
  assert.equal(calls, 5);
  assert.equal(view.record.frames.length, 5);
  assert.equal(view.record.frames[1].expectedHeightMm, 24);
  assert.ok(view.record.frames[0].base64);
  assert.equal(view.physical.status, "unknown");
  const evidence = (heights, visible = true) =>
    view.record.frames.slice(0, 3).map((f, i) => ({
      frameId: f.id,
      visible,
      observedHeightMm: heights[i],
      uncertaintyMm: 0.5,
      method: "calibrated-height",
    }));
  assert.equal(
    store.read("p", { measurements: evidence([4, 24, 48]) }).physical.status,
    "consistent",
  );
  assert.equal(
    store.read("p", { measurements: evidence([4, 4, 4]) }).physical.status,
    "suspect_no_growth",
  );
  assert.equal(
    store.read("p", { measurements: evidence([4, 4, 4], false) }).physical
      .status,
    "unknown",
  );
  assert.equal(
    store.read("p", {
      measurements: [
        {
          frameId: "unknown",
          visible: true,
          observedHeightMm: 0,
          uncertaintyMm: 0,
          method: "calibrated-height",
        },
      ],
    }).physical.status,
    "unknown",
  );
});
test("camera errors and uncalibrated or out-of-view frames cannot claim physical success", async (t) => {
  const { store } = setup(t);
  store.begin("p", {
    ...dispatch,
    expected: { heightMm: 80, layers: [{ layer: 1, zMm: 80 }] },
  });
  store.observe("p", report(1));
  await store.sample("p", async () => {
    throw Error("http://secret:password@host");
  });
  const view = store.read("p");
  assert.equal(view.physical.status, "unknown");
  assert.equal(view.record.frames[0].status, "unavailable");
  assert.ok(!JSON.stringify(view).includes("password"));
});
test("a terminal job freezes its flight record instead of evicting failure evidence with later cooling reports", (t) => {
  const { store } = setup(t, { maxEvents: 4 });
  store.begin("p", dispatch);
  store.observe("p", report(40, { print_error: 123 }));
  store.observe("p", report(100, { gcode_state: "FINISH" }));
  for (let i = 0; i < 20; i++)
    store.observe(
      "p",
      report(100, { gcode_state: "FINISH", nozzle_temper: 200 - i }),
    );
  assert.equal(store.read("p").record.reports.length, 2);
  assert.equal(store.read("p").record.reports[0].changes.print_error, 123);
});
test("an in-flight camera attempt cannot resurrect a pruned job or attach an old image to the next print", async (t) => {
  const { store, dir } = setup(t, { maxJobs: 1 });
  store.begin("p", {
    ...dispatch,
    expected: { heightMm: 80, layers: [{ layer: 1, zMm: 80 }] },
  });
  store.observe("p", report(1));
  let resolve;
  const capture = new Promise((r) => (resolve = r));
  const work = store.sample("p", () => capture);
  const next = store.begin("p", { ...dispatch, jobName: "next-job" });
  resolve({ base64: Buffer.from([255, 216, 255, 217]).toString("base64") });
  await work;
  assert.equal(store.read("p").record.id, next);
  assert.equal(store.read("p").record.frames.length, 0);
  assert.equal(
    fs.readdirSync(dir).filter((f) => f.endsWith(".json")).length,
    1,
  );
});
test("a stale cached image is unavailable and a stalled camera is bounded", async (t) => {
  const { store } = setup(t, { now: () => 100000, maxCaptureMs: 10 });
  store.begin("p", {
    ...dispatch,
    expected: { heightMm: 80, layers: [{ layer: 1, zMm: 80 }] },
  });
  store.observe("p", report(1));
  await store.sample("p", async () => ({
    base64: Buffer.from([255, 216, 255, 217]).toString("base64"),
    capturedAt: new Date(0).toISOString(),
  }));
  assert.equal(store.read("p").record.frames[0].status, "unavailable");
  store.begin("q", {
    ...dispatch,
    expected: { heightMm: 80, layers: [{ layer: 1, zMm: 80 }] },
  });
  store.observe("q", report(1));
  await store.sample("q", () => new Promise(() => {}));
  assert.equal(store.read("q").record.frames[0].status, "unavailable");
});

test("contradictory calibrated heights remain unknown and missing saved images cannot support a verdict", async (t) => {
  const { store, dir } = setup(t);
  store.begin("p", {
    ...dispatch,
    expected: {
      heightMm: 80,
      layers: [
        { layer: 1, zMm: 4 },
        { layer: 2, zMm: 24 },
        { layer: 3, zMm: 48 },
      ],
    },
  });
  for (const layer of [1, 2, 3]) {
    store.observe("p", report(layer));
    await store.sample("p", async () => ({
      base64: Buffer.from([255, 216, 255, 217]).toString("base64"),
    }));
  }
  const frames = store.read("p").record.frames;
  const measured = (heights) =>
    frames.map((f, i) => ({
      frameId: f.id,
      visible: true,
      observedHeightMm: heights[i],
      uncertaintyMm: 0.5,
      method: "calibrated-height",
    }));
  assert.equal(
    store.read("p", { measurements: measured([100, 4, 4]) }).physical.status,
    "unknown",
  );
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".jpg")))
    fs.unlinkSync(path.join(dir, f));
  assert.equal(
    store.read("p", { measurements: measured([4, 24, 48]) }).physical.status,
    "unknown",
  );
});

test("a matching initial IDLE report cannot freeze the real active and FINISH sequence", (t) => {
  const { store } = setup(t);
  store.begin("p", dispatch);
  for (const state of ["IDLE", "RUNNING", "FINISH"])
    store.observe("p", report(1, { gcode_state: state }));
  assert.deepEqual(
    store.read("p").record.reports.map((r) => r.changes.gcode_state),
    ["IDLE", "RUNNING", "FINISH"],
  );
});
test("camera acquisition crossing a layer or terminal transition cannot retain the old layer binding", async (t) => {
  for (const state of ["RUNNING", "FINISH"]) {
    const { store } = setup(t);
    store.begin("p", {
      ...dispatch,
      expected: {
        heightMm: 80,
        layers: [
          { layer: 1, zMm: 4 },
          { layer: 2, zMm: 8 },
        ],
      },
    });
    store.observe("p", report(1));
    let resolve;
    const acquired = new Promise((r) => (resolve = r));
    const work = store.sample("p", () => acquired);
    store.observe("p", report(2, { gcode_state: state }));
    resolve({ base64: Buffer.from([255, 216, 255, 217]).toString("base64") });
    await work;
    assert.equal(store.read("p").record.frames[0].status, "unavailable");
  }
});
test("two recorder instances sharing retention cannot resurrect the other instance cached pruned job", (t) => {
  const { store, dir } = setup(t, { maxJobs: 1 });
  store.begin("old", dispatch);
  const second = new FlightRecords({ dir, maxJobs: 1 });
  second.begin("new", { ...dispatch, jobName: "new" });
  store.observe("old", report(1));
  assert.equal(
    fs.readdirSync(dir).filter((f) => f.endsWith(".json")).length,
    1,
  );
  assert.equal(store.read("old").status, "unavailable");
});
test("raw hexadecimal diagnostic codes survive without losing HMS/error/fail_reason evidence", (t) => {
  const { store } = setup(t);
  store.begin("p", dispatch);
  store.observe(
    "p",
    report(1, {
      print_error: "0x03008011",
      fail_reason: "0300400C",
      hms: [{ attr: "0x07000000", code: "0x00030001" }],
    }),
  );
  const raw = store.read("p").record.latest;
  assert.equal(raw.print_error, "0x03008011");
  assert.equal(raw.fail_reason, "0300400C");
  assert.equal(raw.hms[0].attr, "0x07000000");
  assert.equal(raw.hms[0].code, "0x00030001");
});

test("expected geometry preserves explicit sliced layer numbers across an empty extrusion layer", () => {
  const g = geometryFromGcode(
    "M83\n; Z_HEIGHT: 0.2\n; layer num/total_layer_count: 1/3\nG1 X1 Y1\nG1 X2 Y2 E1\n; Z_HEIGHT: 0.4\n; layer num/total_layer_count: 2/3\nG1 X3 Y3\n; Z_HEIGHT: 0.6\n; layer num/total_layer_count: 3/3\nG1 X4 Y4 E1",
  );
  assert.deepEqual(
    g.layers.map((l) => [l.layer, l.zMm]),
    [
      [1, 0.2],
      [3, 0.6],
    ],
  );
});

test("a second live MCP recorder cannot overwrite newer observations from the dispatch owner", (t) => {
  const { store, dir } = setup(t);
  store.begin("p", dispatch);
  store.observe("p", report(1));
  const other = new FlightRecords({ dir });
  other.read("p");
  store.observe("p", report(2, { print_error: 123 }));
  other.observe("p", report(1));
  const persisted = new FlightRecords({ dir }).read("p");
  assert.equal(persisted.record.latest.layer_num, 2);
  assert.equal(persisted.record.latest.print_error, 123);
});

test("fresh observations continue the durable sequence after the dispatch process exits", (t) => {
  const { dir } = setup(t);
  const moduleUrl = new URL(
    "../dist/counterpart/flight-record.js",
    import.meta.url,
  ).href;
  const code = `import {FlightRecords} from ${JSON.stringify(moduleUrl)};const s=new FlightRecords({dir:${JSON.stringify(dir)}});s.begin('p',${JSON.stringify(dispatch)});s.observe('p',${JSON.stringify(report(1, { print_error: 123 }))});`;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", code],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr);
  const resumed = new FlightRecords({ dir });
  resumed.observe("p", report(2, { print_error: 0 }));
  const record = resumed.read("p").record;
  assert.equal(record.reports.length, 2);
  assert.equal(record.reports[0].changes.print_error, 123);
  assert.equal(record.latest.layer_num, 2);
});

test("the read-only index discovers older job IDs without knowing their UUIDs", (t) => {
  const { store } = setup(t);
  const first = store.begin("p", { ...dispatch, jobName: "older" });
  store.begin("p", { ...dispatch, jobName: "newer" });
  const view = store.read("p", { listJobs: true });
  assert.equal(view.jobs.length, 2);
  assert.ok(view.jobs.some((j) => j.id === first));
  assert.equal(store.read("p", { jobId: first }).record.id, first);
  assert.ok(view.jobs.every((j) => j.sha256 === hash));
});

test("corrupt older records cannot prevent the total retained-job cap", (t) => {
  const { store, dir } = setup(t, { maxJobs: 1 });
  store.begin("p", dispatch);
  const old = path.join(
    dir,
    fs.readdirSync(dir).find((name) => name.endsWith(".json")),
  );
  fs.writeFileSync(old, "{corrupt");
  fs.utimesSync(old, 0, 0);
  store.begin("p", { ...dispatch, jobName: "next" });
  assert.equal(
    fs.readdirSync(dir).filter((name) => name.endsWith(".json")).length,
    1,
  );
});

test("a cached owner discovers a newer dispatch from another MCP instance", (t) => {
  let now = 1000;
  const { store, dir } = setup(t, { now: () => now });
  const first = store.begin("p", dispatch);
  now = 2000;
  const other = new FlightRecords({ dir, now: () => now });
  const second = other.begin("p", { ...dispatch, jobName: "newer-job" });
  assert.equal(store.read("p").record.id, second);
  assert.equal(new FlightRecords({ dir }).read("p").record.id, second);
  assert.equal(store.read("p", { jobId: first }).record.id, first);
});

test("camera acquisition cannot precede its layer report even within the old 15-second window", async (t) => {
  const { store } = setup(t, { now: () => 100000 });
  store.begin("p", {
    ...dispatch,
    expected: {
      heightMm: 80,
      layers: [{ layer: 1, zMm: 4, boundsMm: [1, 1, 20, 20] }],
    },
  });
  store.observe("p", report(1));
  let boundary;
  await store.sample("p", async (after) => {
    boundary = after;
    return {
      base64: Buffer.from([255, 216, 255, 217]).toString("base64"),
      capturedAt: new Date(95000).toISOString(),
    };
  });
  assert.equal(boundary, new Date(100000).toISOString());
  assert.equal(store.read("p").record.frames[0].status, "unavailable");
});
test("expected footprint tracks rapid travel, relative XY and accepted compact command syntax", () => {
  const a = geometryFromGcode(
    "M83\n; Z_HEIGHT: 0.2\nG0 X100 Y100\nG1 X110 Y110 E1",
  );
  assert.deepEqual(a.layers[0].boundsMm, [100, 100, 110, 110]);
  const b = geometryFromGcode(
    "M83\n; Z_HEIGHT: 0.2\nN10 G00X100Y100*1\nG91\nG01X+10Y+10E1\nG1 X10 Y10 E1",
  );
  assert.deepEqual(b.layers[0].boundsMm, [100, 100, 120, 120]);
});

test("an unmatched external job cannot attach its camera image to the previous running job", async (t) => {
  const { store } = setup(t);
  store.begin("p", {
    ...dispatch,
    expected: {
      heightMm: 80,
      layers: [{ layer: 1, zMm: 4, boundsMm: [1, 1, 20, 20] }],
    },
  });
  store.observe("p", report(1));
  store.observe("p", { ...report(1), subtask_name: "someone-elses-job" });
  let calls = 0;
  await store.sample("p", async () => {
    calls++;
    return { base64: Buffer.from([255, 216, 255, 217]).toString("base64") };
  });
  assert.equal(calls, 0);
  assert.equal(store.read("p").record.frames.length, 0);
});
