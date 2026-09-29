import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import JSZip from "jszip";
import { BambuImplementation } from "../../dist/printers/bambu.js";

// Adapted from bambu-printer-mcp tests/safety-dispatch.test.mjs. Every
// transport boundary (FTPS, MQTT, fresh status) is replaced in-process; no
// printer is contacted. Acceptance at a mocked boundary proves server-side
// validation only, not firmware behavior.
const host = "192.0.2.10";
const serial = "01PTESTSAFETY";
const token = "TEST_TOKEN";
const apiKey = `${serial}:${token}`;

function safetyStatus({ model = "p1s", nozzle = "0.4", state = "IDLE", ...raw } = {}) {
  return {
    connected: true, model, status: state, serial,
    raw: { model, gcode_state: state, nozzle_diameter: nozzle, print_error: 0, hms: [], ...raw },
    observation: { source: "mqtt", receivedAt: Date.now(), requestedAt: Date.now() - 1, identitySource: "report" },
  };
}

async function fixture(t, { model = "p1s", nozzle = "0.4", material = "PLA", gcode = "M104 S220\nM140 S60\nG1 X10 Y10 Z1\n", raw = false, bed = "Textured PEI Plate" } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bambu-safety-dispatch-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, raw ? "job.gcode" : "job.gcode.3mf");
  const content = `; printer_model = Bambu Lab ${model === "a1mini" ? "A1 mini" : model.toUpperCase()}\n; nozzle_diameter = ${nozzle}\n; filament_type = ${material}\n; filament_colour = #FFFFFF\n; curr_bed_type = ${bed}\n${gcode}`;
  if (raw) await fs.writeFile(file, content);
  else {
    const zip = new JSZip();
    zip.file("3D/3dmodel.model", '<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices/><triangles/></mesh></object></resources><build><item objectid="1"/></build></model>');
    zip.file("Metadata/plate_1.gcode", content);
    zip.file("Metadata/plate_1.json", JSON.stringify({ filament_ids: [0] }));
    zip.file("Metadata/project_settings.config", JSON.stringify({ printer_model: model, nozzle_diameter: [nozzle], filament_type: [material], curr_bed_type: bed }));
    await fs.writeFile(file, await zip.generateAsync({ type: "nodebuffer" }));
  }
  return file;
}

function isolatedPrinter(status = safetyStatus(), confirm = async () => true) {
  const printer = new BambuImplementation({}, confirm);
  const events = [];
  printer.ftpUpload = async (_host, _token, file, remote) => events.push({ action: "upload", file, remote, bytes: await fs.readFile(file) });
  printer.ftpDownload = async () => { throw new Error("test download not configured"); };
  printer.getSafetyStatus = async () => { events.push({ action: "status" }); return status; };
  printer.getPrinter = async () => {
    events.push({ action: "connect" });
    return { publish: async (payload) => events.push({ action: "publish", payload }) };
  };
  return { printer, events };
}

function assertNoDispatch(events) {
  assert.deepEqual(events.filter(({ action }) => action === "upload" || action === "publish"), [], "rejected print must not upload bytes or publish a command");
}

const print3mf = (printer, file, options = {}) =>
  printer.print3mf(host, serial, token, { projectName: "job", filePath: file, bambuModel: "p1s", useAMS: false, ...options });

for (const [name, gcode] of [
  ["declared PLA at 400 C", "M104 S400\n"],
  ["bed at 300 C", "M140 S300\n"],
  ["nonfinite nozzle target", "M104 SNaN\n"],
  ["R-form waiting nozzle target", "M109 R400\n"],
  ["a tool-addressed nozzle target", "M104 T0 S400\n"],
  ["the audit's late R target after safe S targets", "M104 S220\nM104 S250\nM109 R450\n"],
]) {
  test(`print3mf rejects ${name} before upload or publish`, async (t) => {
    const file = await fixture(t, { gcode });
    const { printer, events } = isolatedPrinter();
    await assert.rejects(print3mf(printer, file), /temperature|thermal|finite|target|limit/i);
    assertNoDispatch(events);
    assert.equal(events.length, 0, "file inspection must fail before any printer connection");
  });
}

for (const [name, fileOptions, status, options, error] of [
  ["file model mismatch", { model: "h2d" }, safetyStatus(), {}, /model|P1S|H2D/i],
  ["requested nozzle mismatch", { nozzle: "0.8" }, safetyStatus(), { nozzleDiameters: [0.4] }, /nozzle|diameter/i],
  ["live model mismatch", {}, safetyStatus({ model: "a1mini" }), {}, /model|identity/i],
  ["live nozzle mismatch", {}, safetyStatus({ nozzle: "0.6" }), {}, /nozzle|diameter/i],
  ["busy printer", {}, safetyStatus({ state: "RUNNING" }), {}, /state|busy|RUNNING/i],
  ["paused printer", {}, safetyStatus({ state: "PAUSE" }), {}, /state|PAUSE/i],
  ["active printer error", {}, safetyStatus({ print_error: 1234 }), {}, /error|fault/i],
  ["actionable HMS error", {}, safetyStatus({ hms: [{ attr: 0, code: 0x10001 }] }), {}, /HMS/i],
  ["reported external-spool material contradicting PLA", {}, safetyStatus({ vt_tray: { tray_type: "ABS", nozzle_temp_min: "240", nozzle_temp_max: "270" } }), {}, /material|contradict/i],
  ["missing selected plate", {}, safetyStatus(), { plateIndex: 98 }, /plate|present|missing/i],
  ["bed type contradicting the sliced file", {}, safetyStatus(), { bedType: "cool_plate" }, /bed/i],
  ["a used filament without a physical AMS mapping", {}, safetyStatus(), { useAMS: true, amsMapping: [] }, /mapping/i],
  ["an out-of-range AMS tray", {}, safetyStatus(), { useAMS: true, amsMapping: [99] }, /ams_mapping|tray/i],
]) {
  test(`print3mf rejects ${name} before upload or publish`, async (t) => {
    const file = await fixture(t, fileOptions);
    const { printer, events } = isolatedPrinter(status);
    await assert.rejects(print3mf(printer, file, options), error);
    assertNoDispatch(events);
  });
}

test("low-level print3mf requires a model before connecting", async (t) => {
  const file = await fixture(t);
  const { printer, events } = isolatedPrinter();
  await assert.rejects(printer.print3mf(host, serial, token, { projectName: "missing-model", filePath: file, useAMS: false }), /model.*required/i);
  assert.deepEqual(events, []);
});

test("a project AMS mapping cannot bypass a reported material mismatch", async (t) => {
  const file = await fixture(t);
  const { printer, events } = isolatedPrinter(safetyStatus({ ams: { ams: [{ id: "0", tray: [{ id: "1", tray_type: "ABS" }] }] } }));
  await assert.rejects(print3mf(printer, file, { useAMS: true, amsMapping: [1] }), /material|contradict/i);
  assertNoDispatch(events);
});

test("expected peak temperatures must match the inspected plate before any connection", async (t) => {
  const file = await fixture(t, { gcode: "M104 S220\nM109 R240\nM140 S60\n" });
  const { printer, events } = isolatedPrinter();
  await assert.rejects(print3mf(printer, file, { expectedPeaks: { nozzle: 220 } }), /highest nozzle target is 240/i);
  await assert.rejects(print3mf(printer, file, { expectedPeaks: { bed: 55 } }), /highest bed target is 60/i);
  await assert.rejects(print3mf(printer, file, { expectedPeaks: { nozzle: Number.NaN } }), /finite/i);
  assert.deepEqual(events, []);
  const accepted = await print3mf(printer, file, { expectedPeaks: { nozzle: 240, bed: 60 } });
  assert.equal(accepted.status, "success");
});

test("printer becoming busy during upload stops the final print command", async (t) => {
  const file = await fixture(t);
  const { printer, events } = isolatedPrinter();
  let reads = 0;
  printer.getSafetyStatus = async () => safetyStatus({ state: ++reads <= 2 ? "IDLE" : "RUNNING" });
  await assert.rejects(print3mf(printer, file), /state|busy|RUNNING/i);
  assert.equal(events.filter(({ action }) => action === "upload").length, 1);
  assert.equal(events.filter(({ action }) => action === "publish").length, 0);
});

test("a declined human confirmation stops before upload", async (t) => {
  const file = await fixture(t);
  const prompts = [];
  const { printer, events } = isolatedPrinter(safetyStatus(), async (message) => { prompts.push(message); return false; });
  await assert.rejects(print3mf(printer, file), /confirmation was declined/i);
  assertNoDispatch(events);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /P1S.*PLA.*nozzle 220°C, bed 60°C.*SHA-256/s);
});

test("confirmation opt-out skips ordinary prompts but a finished bed still needs a human", async (t) => {
  const file = await fixture(t);
  for (const [name, value] of [["BAMBU_REQUIRE_CONFIRMATION", "0"], ["PRINT_REQUIRE_CONFIRMATION", "0"]]) {
    const previous = { BAMBU_REQUIRE_CONFIRMATION: process.env.BAMBU_REQUIRE_CONFIRMATION, PRINT_REQUIRE_CONFIRMATION: process.env.PRINT_REQUIRE_CONFIRMATION };
    delete process.env.BAMBU_REQUIRE_CONFIRMATION;
    delete process.env.PRINT_REQUIRE_CONFIRMATION;
    process.env[name] = value;
    try {
      let prompts = 0;
      const idle = isolatedPrinter(safetyStatus(), async () => { prompts++; return false; });
      assert.equal((await print3mf(idle.printer, file)).status, "success", `${name}=0 opts out of ordinary prompts`);
      assert.equal(prompts, 0);
      const finished = isolatedPrinter(safetyStatus({ state: "FINISH" }), async () => { prompts++; return false; });
      await assert.rejects(print3mf(finished.printer, file), /confirmation/i);
      assert.equal(prompts, 1, "finished-bed clearance is a physical check");
      assertNoDispatch(finished.events);
    } finally {
      for (const [key, old] of Object.entries(previous)) {
        if (old === undefined) delete process.env[key];
        else process.env[key] = old;
      }
    }
  }
});

test("an inspected print uploads its private copy when the caller's file changes", async (t) => {
  const file = await fixture(t);
  const expected = await fs.readFile(file);
  const { printer, events } = isolatedPrinter();
  let reads = 0;
  printer.getSafetyStatus = async () => {
    if (++reads === 1) await fs.writeFile(file, "M104 S400\n");
    return safetyStatus();
  };
  const result = await print3mf(printer, file);
  assert.equal(result.status, "success");
  const upload = events.find(({ action }) => action === "upload");
  assert.notEqual(upload.file, file);
  assert.deepEqual(upload.bytes, expected, "uploaded bytes must be the file that passed inspection");
  assert.match(upload.remote, /^\/cache\/checked-[a-f0-9-]+-job\.gcode\.3mf$/);
  const publish = events.find(({ action }) => action === "publish").payload.print;
  assert.equal(publish.command, "project_file");
  assert.equal(publish.param, "Metadata/plate_1.gcode");
  assert.equal(publish.url, `file:///sdcard${upload.remote}`);
  assert.equal(publish.use_ams, false);
  assert.equal(result.sha256.length, 64);
});

test("a checked AMS mapping is dispatched in full rather than truncated", async (t) => {
  const file = await fixture(t);
  const { printer, events } = isolatedPrinter(safetyStatus({ ams: { ams: [{ id: "0", tray: [{ id: "2", tray_type: "PLA" }] }] } }));
  const mapping = [2, -1, -1, -1, -1, -1];
  await print3mf(printer, file, { useAMS: true, amsMapping: mapping });
  const publish = events.find(({ action }) => action === "publish").payload.print;
  assert.deepEqual(publish.ams_mapping, mapping);
  assert.equal(publish.use_ams, true);
});

for (const action of ["stop", "heater-off"]) {
  test(`${action} during upload is immediate and prevents pending print dispatch`, async (t) => {
    const file = await fixture(t);
    const { printer, events } = isolatedPrinter();
    let releaseUpload;
    const uploadGate = new Promise((resolve) => { releaseUpload = resolve; });
    let markUploadStarted;
    const uploadStarted = new Promise((resolve) => { markUploadStarted = resolve; });
    printer.ftpUpload = async () => { events.push({ action: "upload" }); markUploadStarted(); await uploadGate; };
    const pendingPrint = print3mf(printer, file);
    const outcome = pendingPrint.then((value) => ({ value }), (error) => ({ error }));
    await uploadStarted;
    const safetyAction = action === "stop" ? printer.cancelJob(host, "", apiKey) : printer.setTemperature(host, "", apiKey, "nozzle", 0);
    let timeout;
    try {
      await Promise.race([safetyAction, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`${action} waited behind a pending upload`)), 1500); })]);
      const publishes = events.filter((event) => event.action === "publish");
      assert.equal(publishes.length, 1, "stop/off must publish while the upload is blocked");
      if (action === "stop") assert.equal(publishes[0].payload.print.command, "stop");
      else assert.equal(publishes[0].payload.print.param, "M104 S0\n");
      assert.equal(typeof publishes[0].payload.print.sequence_id, "string");
    } finally {
      clearTimeout(timeout);
      releaseUpload();
      await safetyAction;
    }
    const completed = await outcome;
    assert.match(completed.error?.message ?? "", /cancelled|canceled|stop|heater-off/i, "the pending print must be cancelled");
    assert.equal(events.filter((event) => event.action === "publish").length, 1, "no print command may follow stop/off");
  });
}

test("stop and heater-off are also immediate while a human confirmation is pending", async (t) => {
  const file = await fixture(t);
  let answer;
  let markAsked;
  const asked = new Promise((resolve) => { markAsked = resolve; });
  const { printer, events } = isolatedPrinter(safetyStatus(), () => { markAsked(); return new Promise((resolve) => { answer = resolve; }); });
  const outcome = print3mf(printer, file).then((value) => ({ value }), (error) => ({ error }));
  await asked;
  await printer.cancelJob(host, "", apiKey);
  assert.equal(events.filter(({ action }) => action === "publish").length, 1);
  answer(true);
  const completed = await outcome;
  assert.match(completed.error?.message ?? "", /cancelled/i);
  assertNoDispatch(events.filter(({ action, payload }) => !(action === "publish" && payload.print.command === "stop")));
});

test("upload-and-print inspects raw G-code, starts a unique checked copy, and refuses unsafe bytes", async (t) => {
  const unsafe = await fixture(t, { raw: true, gcode: "M104 S400\n" });
  const rejected = isolatedPrinter();
  await assert.rejects(rejected.printer.uploadFile(host, "", apiKey, unsafe, "unsafe.gcode", true, { bambuModel: "p1s" }), /temperature|limit/i);
  assertNoDispatch(rejected.events);

  const file = await fixture(t, { raw: true });
  const expected = await fs.readFile(file);
  const { printer, events } = isolatedPrinter();
  const result = await printer.uploadFile(host, "", apiKey, file, "job.gcode", true, { bambuModel: "p1s" });
  assert.equal(result.printRequested, true);
  const upload = events.find(({ action }) => action === "upload");
  assert.deepEqual(upload.bytes, expected);
  assert.match(upload.remote, /^\/cache\/checked-[a-f0-9-]+-job\.gcode$/);
  const publish = events.find(({ action }) => action === "publish").payload.print;
  assert.equal(publish.command, "gcode_file");
  assert.equal(publish.param, upload.remote.slice(1));
  assert.equal(typeof publish.sequence_id, "string");
});

test("upload-and-print requires a model and .gcode, and upload-only keeps working without a model", async (t) => {
  const file = await fixture(t, { raw: true });
  const { printer, events } = isolatedPrinter();
  await assert.rejects(printer.uploadFile(host, "", apiKey, file, "job.gcode", true, {}), /model/i);
  const project = await fixture(t);
  await assert.rejects(printer.uploadFile(host, "", apiKey, project, "job.3mf", true, { bambuModel: "p1s" }), /print_3mf|\.gcode/i);
  await assert.rejects(printer.uploadFile(host, "", apiKey, file, "../escape.gcode", false), /relative path|traversal/i);
  assertNoDispatch(events);
  const uploadOnly = await printer.uploadFile(host, "", apiKey, file, "plain.gcode", false);
  assert.equal(uploadOnly.remotePath, "cache/plain.gcode");
  assert.deepEqual(events.map(({ action }) => action), ["upload"]);
});

for (const route of ["raw upload-and-print", "remote start"]) {
  test(`${route} rejects an explicitly unloaded nozzle before upload or dispatch`, async (t) => {
    const file = await fixture(t, { raw: true });
    const { printer, events } = isolatedPrinter(safetyStatus({ ams: { tray_now: "255", ams: [] } }));
    printer.ftpDownload = async (_host, _token, _remote, destination) => fs.copyFile(file, destination);
    const print = route === "raw upload-and-print"
      ? printer.uploadFile(host, "", apiKey, file, "unloaded.gcode", true, { bambuModel: "p1s" })
      : printer.startJob(host, "", apiKey, "unloaded.gcode", { bambuModel: "p1s" });
    await assert.rejects(print, /no filament|unloaded|load.*filament/i);
    assertNoDispatch(events);
  });

  test(`${route} checks the loaded AMS material instead of an unused external-spool declaration`, async (t) => {
    const file = await fixture(t, { raw: true, material: "PA", gcode: "M104 S300\nM140 S60\nG1 X10 Y10 Z1\n" });
    const { printer, events } = isolatedPrinter(safetyStatus({
      ams: { tray_now: "0", ams: [{ id: "0", tray: [{ id: "0", tray_type: "PLA", nozzle_temp_min: "190", nozzle_temp_max: "240" }] }] },
      vt_tray: { tray_type: "PA", nozzle_temp_min: "250", nozzle_temp_max: "300" },
    }));
    printer.ftpDownload = async (_host, _token, _remote, destination) => fs.copyFile(file, destination);
    const print = route === "raw upload-and-print"
      ? printer.uploadFile(host, "", apiKey, file, "wrong-material.gcode", true, { bambuModel: "p1s" })
      : printer.startJob(host, "", apiKey, "wrong-material.gcode", { bambuModel: "p1s" });
    await assert.rejects(print, /material|contradict|PLA|loaded/i);
    assertNoDispatch(events);
  });
}

test("remote start refuses an artifact that cannot be downloaded, a .3mf, or a missing model", async () => {
  const { printer, events } = isolatedPrinter();
  printer.ftpDownload = async () => { throw new Error("remote artifact unavailable for inspection"); };
  await assert.rejects(printer.startJob(host, "", apiKey, "uninspected.gcode", { bambuModel: "p1s" }), /inspect|download|unavailable/i);
  await assert.rejects(printer.startJob(host, "", apiKey, "project.3mf", { bambuModel: "p1s" }), /print_3mf/i);
  await assert.rejects(printer.startJob(host, "", apiKey, "job.gcode", {}), /model/i);
  assertNoDispatch(events);
});

test("remote start rejects downloaded PLA at 400 C before reupload or print", async (t) => {
  const file = await fixture(t, { raw: true, gcode: "M104 S400\n" });
  const { printer, events } = isolatedPrinter();
  printer.ftpDownload = async (_host, _token, _remote, destination) => fs.copyFile(file, destination);
  await assert.rejects(printer.startJob(host, "", apiKey, "unsafe.gcode", { bambuModel: "p1s" }), /temperature|thermal|limit/i);
  assertNoDispatch(events);
});

test("remote start uploads and starts a uniquely named copy of the inspected download", async (t) => {
  const file = await fixture(t, { raw: true });
  const expected = await fs.readFile(file);
  const { printer, events } = isolatedPrinter();
  const downloads = [];
  printer.ftpDownload = async (targetHost, targetToken, remote, destination) => {
    downloads.push({ targetHost, targetToken, remote });
    await fs.copyFile(file, destination);
  };
  const result = await printer.startJob(host, "", apiKey, "old-job.gcode", { bambuModel: "p1s" });
  assert.equal(result.status, "success");
  assert.deepEqual(downloads, [{ targetHost: host, targetToken: token, remote: "cache/old-job.gcode" }]);
  const upload = events.find(({ action }) => action === "upload");
  assert.deepEqual(upload.bytes, expected);
  assert.match(upload.remote, /^\/cache\/checked-[a-f0-9-]+-old-job\.gcode$/);
  assert.equal(events.find(({ action }) => action === "publish").payload.print.param, upload.remote.slice(1));
});

for (const [component, target, material] of [
  ["nozzle", Number.NaN, "PLA"], ["nozzle", "not-a-number", "PLA"], ["nozzle", "220", "PLA"], ["bed", Infinity, undefined],
  ["bed", -1, undefined], ["bed", 300, undefined], ["bed", 101, undefined], ["nozzle", 301, "PETG"], ["nozzle", 270, "PLA"], ["nozzle", 220, undefined],
  ["nozzle", 220, "UnknownBlend"],
]) {
  test(`manual ${component} target ${String(target)} ${material ?? "without material"} rejects before connection`, async () => {
    const { printer, events } = isolatedPrinter();
    await assert.rejects(
      printer.setTemperature(host, "", apiKey, component, target, { bambuModel: "p1s", material, nozzleDiameter: 0.4 }),
      /temperature|finite|material|limit/i
    );
    assert.deepEqual(events, [], "invalid heater requests must not connect or publish");
  });
}

test("positive manual heating needs a model, then fresh state and a human confirmation", async () => {
  const noModel = isolatedPrinter();
  await assert.rejects(noModel.printer.setTemperature(host, "", apiKey, "bed", 60, {}), /bambu_model/i);
  assert.deepEqual(noModel.events, []);

  const prompts = [];
  const { printer, events } = isolatedPrinter(safetyStatus(), async (message) => { prompts.push(message); return true; });
  const result = await printer.setTemperature(host, "", apiKey, "nozzle", 220, { bambuModel: "p1s", material: "PLA", nozzleDiameter: 0.4 });
  assert.equal(result.command, "M104 T0 S220");
  assert.deepEqual(events.map(({ action }) => action), ["status", "status", "connect", "publish"]);
  assert.equal(events.at(-1).payload.print.param, "M104 T0 S220\n");
  assert.match(prompts[0], /Heat nozzle on P1S.*220°C.*PLA/);

  const declined = isolatedPrinter(safetyStatus(), async () => false);
  await assert.rejects(declined.printer.setTemperature(host, "", apiKey, "bed", 60, { bambuModel: "p1s" }), /declined/i);
  assertNoDispatch(declined.events);

  const busy = isolatedPrinter(safetyStatus({ state: "RUNNING" }));
  await assert.rejects(busy.printer.setTemperature(host, "", apiKey, "bed", 60, { bambuModel: "p1s" }), /state|idle/i);
  assertNoDispatch(busy.events);
});

test("heater-off remains available without model, material, state or confirmation", async () => {
  const { printer, events } = isolatedPrinter(safetyStatus({ state: "FAILED", print_error: 1 }), async () => { throw new Error("must not prompt"); });
  for (const component of ["nozzle", "bed"]) {
    const result = await printer.setTemperature(host, "", apiKey, component, 0);
    assert.equal(result.status, "success");
  }
  assert.deepEqual(events.map(({ action }) => action), ["connect", "publish", "connect", "publish"]);
  assert.equal(events[1].payload.print.param, "M104 S0\n");
  assert.equal(events[3].payload.print.param, "M140 S0\n");
});

test("manual nozzle heating cannot relabel a loaded AMS PLA spool as PA", async () => {
  const { printer, events } = isolatedPrinter(safetyStatus({
    ams: { tray_now: "0", ams: [{ id: "0", tray: [{ id: "0", tray_type: "PLA", nozzle_temp_min: "190", nozzle_temp_max: "240" }] }] },
  }));
  await assert.rejects(printer.setTemperature(host, "", apiKey, "nozzle", 300, { bambuModel: "p1s", material: "PA", nozzleDiameter: 0.4 }), /material|contradict|PLA/i);
  assertNoDispatch(events);
});

test("cancel publishes stop immediately with a string sequence id", async () => {
  const { printer, events } = isolatedPrinter(safetyStatus({ state: "RUNNING" }));
  await printer.cancelJob(host, "", apiKey);
  assert.deepEqual(events.map(({ action }) => action), ["connect", "publish"]);
  assert.equal(events[1].payload.print.command, "stop");
  assert.match(events[1].payload.print.sequence_id, /^\d+$/);
});
