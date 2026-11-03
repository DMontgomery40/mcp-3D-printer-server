import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import JSZip from "jszip";
import axios from "axios";
import { BambuImplementation } from "../../dist/printers/bambu.js";
import { CounterpartService } from "../../dist/counterpart/service.js";

// Bambu pause, resume and stop, ported from bambu-printer-mcp
// tests/safety-dispatch.test.mjs. FTPS, MQTT and fresh status are replaced
// in-process; no printer is contacted.
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

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bambu-controls-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "job.3mf");
  const content = "; printer_model = Bambu Lab P1S\n; nozzle_diameter = 0.4\n; filament_type = PLA\n; filament_colour = #FFFFFF\n; curr_bed_type = Textured PEI Plate\nM104 S220\nM140 S60\nG1 X10 Y10 Z1\n";
  const zip = new JSZip();
  zip.file("3D/3dmodel.model", '<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices/><triangles/></mesh></object></resources><build><item objectid="1"/></build></model>');
  zip.file("Metadata/plate_1.gcode", content);
  zip.file("Metadata/plate_1.json", JSON.stringify({ filament_ids: [0] }));
  zip.file("Metadata/project_settings.config", JSON.stringify({ printer_model: "p1s", nozzle_diameter: ["0.4"], filament_type: ["PLA"], curr_bed_type: "Textured PEI Plate" }));
  await fs.writeFile(file, await zip.generateAsync({ type: "nodebuffer" }));
  return file;
}

/** A printer whose FTPS keeps uploaded bytes in `files` and serves them back; prompts are recorded. */
function isolatedPrinter(status = safetyStatus(), { confirm, resumeStateDir, files = new Map() } = {}) {
  const prompts = [];
  const printer = new BambuImplementation({}, confirm ? async (message) => { prompts.push(message); return confirm(message); } : undefined, { resumeStateDir });
  const events = [];
  printer.ftpUpload = async (_host, _token, file, remote) => {
    const bytes = await fs.readFile(file);
    files.set(remote.replace(/^\/+/, ""), bytes);
    events.push({ action: "upload", remote, bytes });
  };
  printer.ftpDownload = async (_host, _token, remote, destination) => {
    events.push({ action: "download", remote });
    const bytes = files.get(remote.replace(/^\/+/, ""));
    if (!bytes) throw new Error("550 no such file");
    await fs.writeFile(destination, bytes);
  };
  printer.getSafetyStatus = async () => { events.push({ action: "status" }); return status; };
  printer.getPrinter = async () => {
    events.push({ action: "connect" });
    return { publish: async (payload) => events.push({ action: "publish", payload }) };
  };
  return { printer, events, files, prompts };
}

/** A checked P1S job started by this server, then reported paused; confirm answers the prompts after the start. */
async function pausedJob(t, { confirm = async () => true, resumeStateDir } = {}) {
  const file = await fixture(t);
  let answer = async () => true;
  const isolated = isolatedPrinter(undefined, { confirm: (message) => answer(message), resumeStateDir });
  const started = await isolated.printer.print3mf(host, serial, token, { projectName: "resume", filePath: file, bambuModel: "p1s", useAMS: false });
  answer = confirm;
  isolated.events.length = 0;
  isolated.prompts.length = 0;
  const job = { ...isolated, file, started, jobName: started.subtaskName, published: () => isolated.events.filter(({ action }) => action === "publish") };
  job.report = { state: "PAUSE", gcode_file: "/data/Metadata/plate_1.gcode", subtask_name: started.subtaskName };
  isolated.printer.getSafetyStatus = async () => {
    isolated.events.push({ action: "status" });
    return safetyStatus(job.report);
  };
  return job;
}

/** Record the job as FULU's plug-in route placed it, with a file the printer cannot give back. */
function unverified(job) {
  const record = job.printer.checkedJobs.get(`${host}\n${serial}`);
  job.printer.recordCheckedJob(host, serial, record.remotePath, record.requirements, record, false);
  job.files.clear();
}

test("a checked print is started under its unique remote name, which the printer reports back", async (t) => {
  const job = await pausedJob(t);
  assert.match(job.started.subtaskName, /^checked-[a-f0-9-]+-job$/);
  assert.equal(job.started.remoteProjectPath, `cache/${job.started.subtaskName}.3mf`);
});

test("resume refuses a job this server has not inspected before connecting", async () => {
  const { printer, events } = isolatedPrinter(safetyStatus({ state: "PAUSE" }));
  await assert.rejects(printer.resumeJob(host, "8883", apiKey), /inspected and started by this server instance/);
  assert.deepEqual(events, []);
});

test("a matching inspected paused job resumes after its bytes are re-read and a fresh check, without a prompt", async (t) => {
  const job = await pausedJob(t, { confirm: async () => false });
  const result = await job.printer.resumeJob(host, "8883", apiKey);
  assert.equal(result.status, "success");
  assert.equal(result.action, "resume");
  assert.equal(result.bytesVerified, true);
  assert.equal(result.jobName, job.jobName);
  assert.deepEqual(job.events.map(({ action }) => action), ["status", "download", "status", "connect", "publish"]);
  assert.equal(job.events[1].remote, job.started.remoteProjectPath);
  assert.equal(job.events[4].payload.print.command, "resume");
  assert.deepEqual(job.prompts, [], "a resume whose bytes were re-read does not ask");
});

/** The same printer, as a new server process sees it after a restart: same storage, same paused report, same record folder. */
function restarted(job, resumeStateDir) {
  const next = isolatedPrinter(undefined, { confirm: async () => true, resumeStateDir, files: job.files });
  next.printer.getSafetyStatus = async () => { next.events.push({ action: "status" }); return safetyStatus(job.report); };
  return next;
}

async function recordFolder(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bambu-resume-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

// Ported from bambu-printer-mcp: a restart during a pause (deploy, crash, reboot) must not strand the print.
test("a server restarted during a pause still resumes the job it started, with every check", async (t) => {
  const dir = await recordFolder(t);
  const job = await pausedJob(t, { resumeStateDir: dir });
  job.printer.printerStore.onReport(host, serial, { gcode_state: "RUNNING", gcode_file: "/data/Metadata/plate_1.gcode", subtask_name: job.started.subtaskName });
  const files = await fs.readdir(dir);
  assert.equal(files.length, 1);
  assert.equal((await fs.stat(path.join(dir, files[0]))).mode & 0o777, 0o600, "the record is private");
  const next = restarted(job, dir);
  const result = await next.printer.resumeJob(host, "8883", apiKey);
  assert.equal(result.status, "success");
  assert.equal(result.bytesVerified, true);
  assert.deepEqual(next.events.map(({ action }) => action), ["status", "download", "status", "connect", "publish"]);
  assert.equal(next.events.at(-1).payload.print.command, "resume");
});

test("after a restart, a job stopped before it or ended while the server was down is not resumed", async (t) => {
  const dir = await recordFolder(t);
  const stopped = await pausedJob(t, { resumeStateDir: dir });
  await stopped.printer.cancelJob(host, "8883", apiKey, async () => ({ status: "success" }));
  assert.deepEqual(await fs.readdir(dir), [], "Stop removes the record");
  const afterStop = restarted(stopped, dir);
  await assert.rejects(afterStop.printer.resumeJob(host, "8883", apiKey), /inspected and started/);

  const ended = await pausedJob(t, { resumeStateDir: dir });
  ended.printer.printerStore.onReport(host, serial, { gcode_state: "RUNNING", gcode_file: "/data/Metadata/plate_1.gcode", subtask_name: ended.started.subtaskName });
  const afterEnd = restarted(ended, dir);
  afterEnd.printer.printerStore.onReport(host, serial, { gcode_state: "FINISH", gcode_file: "/data/Metadata/plate_1.gcode", subtask_name: ended.started.subtaskName });
  await assert.rejects(afterEnd.printer.resumeJob(host, "8883", apiKey), /inspected and started/);
  assert.equal(afterEnd.events.filter(({ action }) => action === "publish").length, 0);
});

test("a damaged or foreign resume record is ignored", async (t) => {
  const dir = await recordFolder(t);
  const job = await pausedJob(t, { resumeStateDir: dir });
  const [name] = await fs.readdir(dir);
  const saved = JSON.parse(await fs.readFile(path.join(dir, name), "utf8"));
  for (const damaged of ["{not json", JSON.stringify({ ...saved, key: "other-host\nother-serial" }), JSON.stringify({ ...saved, job: { ...saved.job, sha256: "nope" } })]) {
    await fs.writeFile(path.join(dir, name), damaged);
    await assert.rejects(restarted(job, dir).printer.resumeJob(host, "8883", apiKey), /inspected and started/);
  }
});

test("a changed printer file refuses the resume and retires the record", async (t) => {
  const job = await pausedJob(t);
  const remote = job.started.remoteProjectPath;
  const original = job.files.get(remote);
  job.files.set(remote, Buffer.concat([original, Buffer.from("\n; changed")]));
  await assert.rejects(job.printer.resumeJob(host, "8883", apiKey), /SHA-256 of .* changed/);
  job.files.set(remote, original);
  await assert.rejects(job.printer.resumeJob(host, "8883", apiKey), /inspected and started/);
  assert.deepEqual(job.published(), []);
});

test("a file this server uploaded that cannot be re-read refuses the resume but keeps the record", async (t) => {
  const job = await pausedJob(t);
  const remote = job.started.remoteProjectPath;
  const original = job.files.get(remote);
  job.files.delete(remote);
  await assert.rejects(job.printer.resumeJob(host, "8883", apiKey), /re-read .* over FTPS/);
  assert.deepEqual(job.published(), []);
  assert.deepEqual(job.prompts, []);
  job.files.set(remote, original);
  assert.equal((await job.printer.resumeJob(host, "8883", apiKey)).status, "success");
});

test("a project the printer replaced with its extracted plate is verified against the inspected plate", async (t) => {
  const job = await pausedJob(t);
  const remote = job.started.remoteProjectPath;
  const zip = await JSZip.loadAsync(job.files.get(remote));
  job.files.delete(remote);
  const plate = remote.replace(/(?:\.gcode)?\.3mf$/i, "_plate_1.gcode");
  job.files.set(plate, await zip.file("Metadata/plate_1.gcode").async("nodebuffer"));
  const result = await job.printer.resumeJob(host, "8883", apiKey);
  assert.equal(result.bytesVerified, true);
  assert.deepEqual(job.events.filter(({ action }) => action === "download").map(({ remote: r }) => r), [remote, plate]);
  assert.equal(job.published().length, 1);
});

for (const [name, after] of [
  ["it was cancelled", async (job) => { await job.printer.cancelJob(host, "8883", apiKey, async () => ({ status: "success" })); }],
  ["it finished after it was seen running", async (job) => {
    job.report = { ...job.report, state: "RUNNING" };
    await assert.rejects(job.printer.resumeJob(host, "8883", apiKey), /paused/i);
    job.report = { ...job.report, state: "FINISH" };
    await assert.rejects(job.printer.resumeJob(host, "8883", apiKey), /no longer the job|paused/i);
  }],
  ["MQTT reported it ended, with nobody polling", async (job) => {
    // The client store hands every merged report to the record.
    job.printer.printerStore.onReport(host, serial, { gcode_state: "RUNNING", subtask_name: job.started.subtaskName });
    job.printer.printerStore.onReport(host, serial, { gcode_state: "FINISH", subtask_name: job.started.subtaskName });
  }],
]) {
  test(`a paused job with the same name is not resumed once ${name}`, async (t) => {
    const job = await pausedJob(t);
    await after(job);
    job.report = { state: "PAUSE", subtask_name: job.started.subtaskName };
    await assert.rejects(job.printer.resumeJob(host, "8883", apiKey), /no longer the job|inspected and started/);
    assert.deepEqual(job.published(), []);
  });
}

test("an unverified plug-in route resume asks a person; a declined prompt sends nothing", async (t) => {
  let answer = false;
  const job = await pausedJob(t, { confirm: async () => answer });
  const saved = new Map(job.files);
  unverified(job);
  await assert.rejects(job.printer.resumeJob(host, "8883", apiKey), /declined|cancelled/i);
  assert.equal(job.prompts.length, 1);
  assert.match(job.prompts[0], /^Resume checked-[a-f0-9-]+-job on P1S \(01PTESTSAFETY\)\?.*could not be re-read over FTPS.*550 no such file.*nozzle 220°C, bed 60°C.*Materials: PLA\./s);
  assert.deepEqual(job.published(), []);
  answer = true;
  assert.equal((await job.printer.resumeJob(host, "8883", apiKey)).bytesVerified, false);
  assert.equal(job.published().length, 1);
  // The same route with readable, matching bytes does not ask.
  for (const [remote, bytes] of saved) job.files.set(remote, bytes);
  assert.equal((await job.printer.resumeJob(host, "8883", apiKey)).bytesVerified, true);
  assert.equal(job.prompts.length, 2, "no prompt when the bytes were verified");
});

test("an unverified resume reads the printer again after the prompt", async (t) => {
  let job;
  job = await pausedJob(t, { confirm: async () => { job.report = { ...job.report, state: "RUNNING" }; return true; } });
  unverified(job);
  await assert.rejects(job.printer.resumeJob(host, "8883", apiKey), /paused/i);
  assert.equal(job.prompts.length, 1);
  assert.deepEqual(job.published(), []);
});

test("an unverified plug-in route resume without an elicitation client is refused", async (t) => {
  const job = await pausedJob(t);
  const record = job.printer.checkedJobs.get(`${host}\n${serial}`);
  const headless = new BambuImplementation({});
  headless.getSafetyStatus = job.printer.getSafetyStatus;
  headless.ftpDownload = async () => { throw new Error("550 no such file"); };
  headless.getPrinter = job.printer.getPrinter;
  headless.recordCheckedJob(host, serial, record.remotePath, record.requirements, record, false);
  await assert.rejects(headless.resumeJob(host, "8883", apiKey), /requires an MCP client with elicitation support/);
  assert.deepEqual(job.published(), []);
});

test("pause and stop are never gated and publish over LAN MQTT", async () => {
  const { printer, events } = isolatedPrinter(safetyStatus({ state: "RUNNING" }));
  const paused = await printer.pauseJob(host, "8883", apiKey);
  assert.deepEqual([paused.status, paused.action], ["success", "pause"]);
  await printer.cancelJob(host, "8883", apiKey);
  assert.deepEqual(events.filter(({ action }) => action === "publish").map(({ payload }) => payload.print.command), ["pause", "stop"]);
  assert.equal(events.some(({ action }) => action === "status"), false, "no state gate before pause or stop");
});

test("a route's dispatch carries pause, resume and stop instead of LAN MQTT", async (t) => {
  const job = await pausedJob(t);
  const sent = [];
  const route = (command) => async (assertActive, beforeDispatch) => {
    if (beforeDispatch) await beforeDispatch();
    sent.push(command);
    return { route: "bambu_network_lan" };
  };
  const paused = await job.printer.pauseJob(host, "8883", apiKey, route("pause"));
  assert.equal(paused.action, "pause");
  const resumed = await job.printer.resumeJob(host, "8883", apiKey, route("resume"));
  assert.deepEqual([resumed.action, resumed.route, resumed.bytesVerified], ["resume", "bambu_network_lan", true]);
  await job.printer.cancelJob(host, "8883", apiKey, route("stop"));
  assert.deepEqual(sent, ["pause", "resume", "stop"]);
  assert.deepEqual(job.published(), [], "nothing went over LAN MQTT");
});

test("Counterpart pause_print and resume_print reach the Bambu adapter and report the counterpart/1 control shape", async (t) => {
  const job = await pausedJob(t);
  const service = new CounterpartService(() => job.printer, axios.create(), { name: "test", version: "0" });
  const target = { type: "bambu", host, port: "8883", apiKey };
  const paused = await service.pause(target);
  assert.deepEqual([paused.status, paused.action, typeof paused.message], ["success", "pause", "string"]);
  const resumed = await service.resume(target);
  assert.deepEqual([resumed.status, resumed.action, resumed.jobName], ["success", "resume", job.jobName]);
  const info = await service.printerInfo({ ...target });
  assert.deepEqual([info.capabilities.pause, info.capabilities.resume, info.capabilities.cancel], [true, true, true]);
});
