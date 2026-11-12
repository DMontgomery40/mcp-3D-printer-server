import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FlightRecords } from "../dist/counterpart/flight-record.js";
import { flightRecordResult } from "../dist/counterpart/flight-tools.js";
const fixture = JSON.parse(
  fs.readFileSync(
    new URL("./fixtures/physical/replay.json", import.meta.url),
    "utf8",
  ),
);
const empty = fs
  .readFileSync(
    new URL("./fixtures/physical/empty-first-layer.jpg", import.meta.url),
  )
  .toString("base64");
const lowered = fs
  .readFileSync(
    new URL("./fixtures/physical/bed-out-of-view.jpg", import.meta.url),
  )
  .toString("base64");
async function replay(t, current = empty, expected = fixture.expected) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "physical-replay-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new FlightRecords({ dir });
  const jobId = store.begin("printer", {
    sha256: fixture.artifactSha256,
    jobName: "offline-air.3mf",
    mapping: [2],
    expected,
  });
  const report = (state, layer) =>
    store.observe("printer", {
      subtask_name: "offline-air",
      gcode_state: state,
      layer_num: layer,
      stg_cur: 2,
    });
  report("PREPARE", 0);
  await store.sample("printer", async () => ({ base64: lowered }));
  report("RUNNING", 1);
  await store.sample("printer", async () => ({ base64: current }));
  const view = store.read("printer"),
    frame = view.record.frames.find((f) => f.role === "first_layer"),
    baseline = view.record.frames.find((f) => f.role === "baseline");
  assert.ok(frame);
  assert.ok(baseline);
  assert.equal(view.physical.assessment.frameId, frame.id);
  return {
    store,
    dir,
    jobId,
    frame,
    baseline,
    report,
    input: {
      jobId,
      artifactSha256: fixture.artifactSha256,
      frameId: frame.id,
      imageSha256: frame.sha256,
      visibility: "clear",
      footprintVisible: true,
      deposition: "absent",
      attempted: true,
      referenceFrameId: baseline.id,
      referenceVisibility: "out_of_view",
      referenceEmpty: false,
    },
  };
}
test("real empty-first-layer replay records suspect_no_extrusion without an usable baseline and survives FINISH/restart", async (t) => {
  const s = await replay(t);
  const result = s.store.submitVisual("printer", s.input);
  assert.equal(result.physical.status, "suspect_no_extrusion");
  assert.deepEqual(result.physical.evidence, [s.frame.id]);
  s.report("RUNNING", 21);
  s.report("FINISH", 265);
  const restarted = new FlightRecords({ dir: s.dir }).read("printer");
  assert.equal(restarted.record.latest.gcode_state, "FINISH");
  assert.equal(restarted.physical.status, "suspect_no_extrusion");
  assert.equal(restarted.record.visualObservations[0].source, "client-vision");
  assert.throws(
    () =>
      s.store.submitVisual("printer", {
        ...s.input,
        imageSha256: "0".repeat(64),
      }),
    /frame|hash/i,
  );
});
test("dark, occluded, unlocated or unknown observations cannot fabricate an extrusion verdict; visible material is not final success", async (t) => {
  const s = await replay(t);
  for (const patch of [
    { visibility: "dark" },
    { visibility: "occluded" },
    { visibility: "out_of_view" },
    { footprintVisible: false },
    { deposition: "unknown" },
    { attempted: false },
    { deposition: "present" },
  ]) {
    assert.equal(
      s.store.submitVisual("printer", { ...s.input, ...patch }).physical.status,
      "unknown",
    );
  }
});
test("a separate worker instance saves observations without overwriting the report owner; standard MCP images are not duplicated", async (t) => {
  const s = await replay(t);
  const worker = new FlightRecords({ dir: s.dir });
  worker.submitVisual("printer", s.input);
  s.report("RUNNING", 11);
  assert.equal(s.store.read("printer").record.latest.layer_num, 11);
  assert.equal(s.store.read("printer").physical.status, "suspect_no_extrusion");
  const view = worker.read("printer", {
    includeFrames: true,
    frameIds: [s.baseline.id, s.frame.id],
  });
  const result = flightRecordResult(view, true);
  assert.equal(result.content.filter((c) => c.type === "image").length, 2);
  assert.ok(result.content.some((c) => c.type === "image" && c.data === empty));
  assert.ok(result.structuredContent.record.frames.every((f) => !f.base64));
  assert.ok(!result.content[0].text.includes(empty));
});
test("first-layer and periodic sampling is bounded and keeps baseline/first-layer evidence", async (t) => {
  const s = await replay(t);
  const expected = {
    heightMm: 70,
    layers: Array.from({ length: 350 }, (_, i) => ({
      layer: i + 1,
      zMm: (i + 1) * 0.2,
      boundsMm: [50, 50, 150, 150],
    })),
  };
  const key = "many";
  s.store.begin(key, {
    sha256: fixture.artifactSha256,
    jobName: "many.3mf",
    expected,
  });
  s.store.observe(key, {
    subtask_name: "many",
    gcode_state: "PREPARE",
    layer_num: 0,
    stg_cur: 2,
  });
  await s.store.sample(key, async () => ({ base64: lowered }));
  for (let layer = 1; layer <= 350; layer += 10) {
    s.store.observe(key, {
      subtask_name: "many",
      gcode_state: "RUNNING",
      layer_num: layer,
    });
    await s.store.sample(key, async () => ({ base64: empty }));
  }
  const frames = s.store.read(key).record.frames;
  assert.ok(frames.length <= 32);
  assert.ok(frames.some((f) => f.role === "baseline"));
  assert.ok(frames.some((f) => f.role === "first_layer"));
  assert.ok(frames.some((f) => f.layer > 300));
});

test("the real lowered-bed frame as current evidence remains unknown", async (t) => {
  const s = await replay(t, lowered);
  assert.equal(
    s.store.submitVisual("printer", {
      ...s.input,
      visibility: "out_of_view",
      footprintVisible: false,
    }).physical.status,
    "unknown",
  );
});
test("pruning a job removes its saved visual observations too", async (t) => {
  const s = await replay(t);
  s.store.submitVisual("printer", s.input);
  s.report("FINISH",265);
  new FlightRecords({dir:s.dir}).observe("printer",{subtask_name:"offline-air",gcode_state:"RUNNING",layer_num:1});
  assert.ok(fs.readdirSync(s.dir).some(f=>f.endsWith(".superseded")));
  const json = fs.readdirSync(s.dir).find((f) => f.endsWith(s.jobId + ".json"));
  fs.utimesSync(path.join(s.dir, json), 0, 0);
  new FlightRecords({ dir: s.dir, maxJobs: 1 }).begin("new", {
    sha256: fixture.artifactSha256,
    jobName: "new.3mf",
  });
  assert.equal(s.store.read("printer").status, "unavailable");
  assert.ok(!fs.readdirSync(s.dir).some(f=>f.endsWith(".superseded")));
  assert.equal(
    fs.readdirSync(s.dir).filter((f) => f.endsWith(".visual.json")).length,
    0,
  );
});

test("preparation images captured before the printing report cannot support a no-extrusion verdict", async (t) => {
  const s = await replay(t);
  const recordFile = fs
    .readdirSync(s.dir)
    .find((f) => f.endsWith(s.jobId + ".json"));
  const record = JSON.parse(
    fs.readFileSync(path.join(s.dir, recordFile), "utf8"),
  );
  const frame = record.frames.find((f) => f.id === s.frame.id);
  frame.capturedAt = new Date(Date.parse(frame.reportAt) - 10000).toISOString();
  fs.writeFileSync(path.join(s.dir, recordFile), JSON.stringify(record));
  const fresh = new FlightRecords({ dir: s.dir });
  assert.equal(
    fresh.submitVisual("printer", s.input).physical.status,
    "unknown",
  );
  assert.equal(fresh.read("printer").physical.assessment, undefined);
});

test("an active camera waits for a post-boundary frame instead of reusing a preparation image", async () => {
  const { snapshotFrame } = await import("../dist/counterpart/fresh-frame.js");
  const calls = [];
  const frames = [
    {
      status: "frame",
      seq: 5,
      capturedAt: new Date(90000).toISOString(),
      base64: lowered,
    },
    {
      status: "frame",
      seq: 6,
      capturedAt: new Date(100001).toISOString(),
      base64: empty,
    },
  ];
  const result = await snapshotFrame(
    {
      frame: async (opts) => {
        calls.push(opts);
        return frames.shift();
      },
    },
    500,
    new Date(100000).toISOString(),
  );
  assert.equal(result.seq, 6);
  assert.equal(result.base64, empty);
  assert.equal(calls[1].sinceSeq, 5);
  const unavailable = await snapshotFrame(
    {
      frame: async () => ({
        status: "frame",
        seq: 5,
        capturedAt: new Date(90000).toISOString(),
        base64: lowered,
      }),
    },
    500,
    new Date(100000).toISOString(),
  );
  assert.equal(unavailable.status, "unavailable");
});


test("progress evidence belongs only to the currently reported job while archived evidence stays readable", async (t) => {
  const s = await replay(t);
  s.store.submitVisual("printer", s.input);
  assert.equal(s.store.physicalForReport("printer", {subtask_name:"offline-air",gcode_state:"RUNNING"}).status,"suspect_no_extrusion");
  for (const raw of [undefined, {}, {subtask_name:"external-next-print",gcode_state:"RUNNING"}]) {
    const physical=s.store.physicalForReport("printer",raw);
    assert.equal(physical.status,"unknown");
    assert.deepEqual(physical.evidence,[]);
    assert.equal(physical.assessment,undefined);
  }
  assert.equal(s.store.read("printer",{jobId:s.jobId}).physical.status,"suspect_no_extrusion");
  const restarted=new FlightRecords({dir:s.dir});
  assert.equal(restarted.physicalForReport("printer",{gcode_file:"cache/offline-air.3mf",gcode_state:"FINISH"}).status,"suspect_no_extrusion");
  assert.equal(restarted.physicalForReport("printer",{gcode_file:"cache/other.3mf"}).status,"unknown");
});


test("a same-filename reprint cannot inherit a previous execution's physical warning", async (t) => {
  const s=await replay(t);
  s.store.submitVisual("printer",s.input);
  const raw=(state,id)=>({subtask_name:"offline-air",gcode_state:state,layer_num:1,...(id?{task_id:id}:{})});
  s.store.observe("printer",raw("RUNNING","private-task-first"));
  s.store.observe("printer",raw("FINISH","private-task-first"));
  assert.equal(s.store.physicalForReport("printer",raw("FINISH","private-task-first")).status,"suspect_no_extrusion");
  assert.equal(s.store.physicalForReport("printer",raw("RUNNING","private-task-second")).status,"unknown");
  s.store.observe("printer",raw("RUNNING","private-task-second"));
  s.store.observe("printer",raw("FINISH","private-task-second"));
  const restarted=new FlightRecords({dir:s.dir});
  assert.equal(restarted.physicalForReport("printer",raw("FINISH","private-task-second")).status,"unknown");
  assert.equal(restarted.read("printer",{jobId:s.jobId}).physical.status,"suspect_no_extrusion");
  assert.ok(!JSON.stringify(restarted.read("printer")).includes("private-task-"));
});
test("ended-to-active reprints without execution IDs and changed active task IDs both invalidate current evidence", async (t) => {
  for (const withIds of [false,true]) {
    const s=await replay(t);s.store.submitVisual("printer",s.input);
    const raw=(state,id)=>({subtask_name:"offline-air",gcode_state:state,layer_num:1,...(withIds?{task_id:id}:{})});
    s.store.observe("printer",raw("RUNNING","first"));
    if(!withIds)s.store.observe("printer",raw("FINISH","first"));
    assert.equal(s.store.physicalForReport("printer",raw("RUNNING","second")).status,"unknown");
    s.store.observe("printer",raw("RUNNING","second"));
    assert.equal(s.store.physicalForReport("printer",raw("RUNNING","second")).status,"unknown");
    assert.equal(new FlightRecords({dir:s.dir}).read("printer",{jobId:s.jobId}).physical.status,"suspect_no_extrusion");
  }
});


test("a separate live observer durably invalidates a reprint without overwriting its dispatch owner's journal",async(t)=>{
  const s=await replay(t);s.store.submitVisual("printer",s.input);s.report("FINISH",265);
  const before=s.store.read("printer").record.reports;
  const observer=new FlightRecords({dir:s.dir});
  observer.observe("printer",{subtask_name:"offline-air",gcode_state:"RUNNING",layer_num:1});
  assert.equal(s.store.physicalForReport("printer",{subtask_name:"offline-air",gcode_state:"FINISH"}).status,"unknown");
  const restarted=new FlightRecords({dir:s.dir});
  assert.equal(restarted.physicalForReport("printer",{subtask_name:"offline-air",gcode_state:"FINISH"}).status,"unknown");
  assert.deepEqual(restarted.read("printer").record.reports,before);
  assert.equal(restarted.read("printer",{jobId:s.jobId}).physical.status,"suspect_no_extrusion");
});


test("unknown first-layer assessment still requests the layer-10 checkpoint and supplies phone-readable problems",async(t)=>{
  const {physicalProblems}=await import('../dist/counterpart/visual-evidence.js');
  const s=await replay(t);
  s.store.submitVisual('printer',{...s.input,visibility:'unknown',deposition:'unknown'});
  assert.equal(s.store.read('printer').physical.status,'unknown');
  s.report('RUNNING',10);
  // A mock later acquisition uses the saved empty-bed image; this is a checkpoint-protocol test, not a claim that the real image was taken at layer10.
  await s.store.sample('printer',async()=>({base64:empty}));
  const view=s.store.read('printer');const frame=view.record.frames.find(f=>f.layer===10);
  assert.ok(frame,'layer10 captured despite the layer1 unknown observation');
  assert.equal(view.physical.assessment.frameId,frame.id);
  const assessed=s.store.submitVisual('printer',{...s.input,frameId:frame.id,imageSha256:frame.sha256});
  assert.equal(assessed.physical.observedLayer,10);
  const active=physicalProblems(assessed.physical)[0].message;
  assert.match(active,/Nothing seems to be coming out of the nozzle/);
  assert.match(active,/layer 10/);assert.match(active,/nozzle and (the )?filament path/);
  const finished=physicalProblems(assessed.physical,true)[0].message;
  assert.match(finished,/printer reports finished/i);assert.match(finished,/layer 10/);
});


test("no-extrusion stays sticky across unknown checkpoints and restart; only clear visible present at a higher layer supersedes it",async(t)=>{
 // Later geometry/acquisitions are synthetic protocol fixtures, not claims about the real photo's capture layer.
 const extra=Array.from({length:40},(_,i)=>({layer:(i+3)*10,zMm:(i+3)*2,boundsMm:fixture.expected.layers.at(-1).boundsMm}));
 const s=await replay(t,empty,{...fixture.expected,heightMm:100,layers:[...fixture.expected.layers,...extra]});
 s.store.submitVisual('printer',s.input);
 // Relabeling the same image cannot erase a previously clear failure observation.
 assert.equal(s.store.submitVisual('printer',{...s.input,deposition:'present'}).physical.status,'suspect_no_extrusion');
 for(const layer of [2,10,21]){
  s.report('RUNNING',layer);await s.store.sample('printer',async()=>({base64:empty}));
  const frame=s.store.read('printer').record.frames.find(f=>f.layer===layer);
  assert.ok(frame);
  const input={...s.input,frameId:frame.id,imageSha256:frame.sha256};
  const patch=layer===2?{visibility:'unknown',deposition:'unknown'}:layer===10?{visibility:'occluded',deposition:'present'}:{deposition:'present',footprintVisible:false};
  assert.equal(s.store.submitVisual('printer',{...input,...patch}).physical.status,'suspect_no_extrusion');
 }
 const restarted=new FlightRecords({dir:s.dir}).read('printer');
 assert.equal(restarted.physical.status,'suspect_no_extrusion');
 assert.deepEqual(restarted.physical.evidence,[s.frame.id]);
 assert.equal(restarted.physical.observedLayer,1);
 const later=restarted.record.frames.find(f=>f.layer===21);
 const cleared=s.store.submitVisual('printer',{...s.input,frameId:later.id,imageSha256:later.sha256,deposition:'present'});
 assert.equal(cleared.physical.status,'unknown','visible material supersedes the empty observation but cannot prove physical success');
 assert.match(cleared.physical.limitations.join(' '),/higher.layer.*supersed/i);
 for(const geometry of extra){
  s.report('RUNNING',geometry.layer);await s.store.sample('printer',async()=>({base64:empty}));
  const frame=s.store.read('printer').record.frames.find(f=>f.layer===geometry.layer);
  assert.ok(frame);
  assert.equal(s.store.submitVisual('printer',{...s.input,frameId:frame.id,imageSha256:frame.sha256,visibility:'unknown',deposition:'unknown'}).physical.status,'unknown');
 }
 s.report('FINISH',500);
 const retained=s.store.read('printer');
 assert.ok(retained.record.frames.length<=32);
 assert.ok(retained.record.frames.some(f=>f.id===later.id),'the superseding evidence must survive bounded frame pruning');
 assert.equal(new FlightRecords({dir:s.dir}).read('printer').physical.status,'unknown');
});
