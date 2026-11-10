import {trackedMkdtempSync} from './support/temp.mjs';
// OctoPrint adapter: base URLs, the Application Keys flow, the printer connection, the file list, and plain G-code
// from PrusaSlicer. A fake OctoPrint on a local port answers as OctoPrint 1.11 does (src/octoprint/server/api/*.py,
// src/octoprint/plugins/appkeys/__init__.py); scripts/octoprint-live-check.mjs runs the same flows against a real one.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import axios from "axios";
import { OctoPrintImplementation, octoPrintBaseUrl } from "../dist/printers/octoprint.js";
import { OctoPrintAppKeys } from "../dist/printers/octoprint-appkeys.js";
import { genericSetupFields } from "../dist/counterpart/setup.js";
import { isBinaryGcode, prusaSlicerPlainGcodeArgs } from "../dist/stl/stl-manipulator.js";

async function fakeOctoPrint(handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = { method: req.method, url: req.url, headers: req.headers, body: body ? (() => { try { return JSON.parse(body); } catch { return body; } })() : undefined };
    requests.push(request);
    const answer = await handler(request);
    if (!answer) { res.writeHead(404); return res.end(); }
    const [status, data] = answer;
    res.writeHead(status, data === undefined ? {} : { "Content-Type": "application/json" });
    res.end(data === undefined ? undefined : JSON.stringify(data));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { port: String(server.address().port), requests, close: () => new Promise(resolve => server.close(resolve)) };
}

test("octoPrintBaseUrl: host and port, or a URL for HTTPS and reverse-proxy sub-paths", () => {
  assert.equal(octoPrintBaseUrl("octopi.local", "80"), "http://octopi.local:80");
  assert.equal(octoPrintBaseUrl("192.168.1.20", "5000"), "http://192.168.1.20:5000");
  assert.equal(octoPrintBaseUrl("https://octopi.local", "80"), "https://octopi.local");
  assert.equal(octoPrintBaseUrl("https://octopi.local/", ""), "https://octopi.local");
  assert.equal(octoPrintBaseUrl("http://pi.lan/octoprint/", "80"), "http://pi.lan/octoprint");
  assert.equal(octoPrintBaseUrl("http://pi.lan:8080/octoprint", "5000"), "http://pi.lan:8080/octoprint", "a URL keeps its own port");
  assert.equal(octoPrintBaseUrl("http://pi.lan/octoprint", "5000"), "http://pi.lan:5000/octoprint", "a URL without a port takes PRINTER_PORT");
  assert.equal(octoPrintBaseUrl("fd00::5", "5000"), "http://[fd00::5]:5000");
  assert.equal(octoPrintBaseUrl("octopi.local", ""), "http://octopi.local");
  assert.throws(() => octoPrintBaseUrl("https://user:secret@octopi.local", "80"), /API_KEY/);
});

test("requests go to the sub-path, with names encoded", async (t) => {
  const fake = await fakeOctoPrint((request) => {
    if (request.url === "/octoprint/api/files/local/My%20Part%20v2.gcode") return [200, { name: "My Part v2.gcode" }];
    return undefined;
  });
  t.after(fake.close);
  const octoprint = new OctoPrintImplementation(axios.create());
  const file = await octoprint.getFile(`http://127.0.0.1:${fake.port}/octoprint/`, "80", "k", "My Part v2.gcode");
  assert.equal(file.name, "My Part v2.gcode");
  assert.equal(fake.requests[0].headers["x-api-key"], "k");
});

test("the file list keeps what a person needs per file", async (t) => {
  const analysis = { estimatedPrintTime: 3725.4, filament: { tool0: { length: 1234, volume: 9 } }, dimensions: {}, printingArea: {} };
  const fake = await fakeOctoPrint((request) => {
    assert.equal(request.url, "/api/files?recursive=true");
    return [200, { free: 1000, total: 2000, files: [
      { name: "cube.gcode", display: "cube.gcode", path: "cube.gcode", type: "machinecode", typePath: ["machinecode", "gcode"], origin: "local",
        size: 4096, date: 1730851200, gcodeAnalysis: analysis, prints: { success: 2, failure: 1, last: { success: false, date: 1730851300 } },
        refs: { resource: "x", download: "y" }, hash: "abc", statistics: { averagePrintTime: {} } },
      { name: "parts", path: "parts", type: "folder", typePath: ["folder"], origin: "local", children: [
        { name: "gear.gcode", path: "parts/gear.gcode", type: "machinecode", origin: "local", size: 10, refs: {} },
      ] },
    ] }];
  });
  t.after(fake.close);
  const list = await new OctoPrintImplementation(axios.create()).getFiles("127.0.0.1", fake.port, "k");
  assert.deepEqual(list, { free: 1000, total: 2000, files: [
    { name: "cube.gcode", path: "cube.gcode", type: "machinecode", origin: "local", size: 4096, date: "2024-11-06T00:00:00.000Z",
      estimatedPrintTimeSec: 3725, lastPrint: { success: false, date: "2024-11-06T00:01:40.000Z" } },
    { name: "parts", path: "parts", type: "folder", origin: "local", children: [
      { name: "gear.gcode", path: "parts/gear.gcode", type: "machinecode", origin: "local", size: 10 },
    ] },
  ] });
});

function connectionApi(state, { psu } = {}) {
  const current = { state: state.value, port: state.value === "Closed" ? null : "/dev/ttyACM0", baudrate: 115200, printerProfile: "_default" };
  return (request) => {
    if (request.url === "/api/connection" && request.method === "GET") return [200, { current: { ...current, state: state.value }, options: { ports: ["/dev/ttyACM0"], baudrates: [115200] } }];
    if (request.url === "/api/connection" && request.method === "POST") { state.value = "Operational"; return [204]; }
    if (request.url === "/api/plugin/psucontrol" && psu) {
      if (request.method === "POST" && request.body?.command === "turnPSUOn") { psu.on = true; return [204]; }
      return [200, { isPSUOn: psu.on }];
    }
    if (request.url === "/api/printer") return state.value === "Operational" ? [200, { state: { text: "Operational", flags: { operational: true, ready: true } }, temperature: {} }] : [409, { error: "Printer is not operational" }];
    if (request.url === "/api/job") return [200, { state: state.value === "Closed" ? "Offline" : state.value, job: { file: {} }, progress: {} }];
    return undefined;
  };
}

test("a disconnected OctoPrint says so, and connect_printer connects it with OctoPrint's saved settings", async (t) => {
  const state = { value: "Closed" };
  const fake = await fakeOctoPrint(connectionApi(state));
  t.after(fake.close);
  const octoprint = new OctoPrintImplementation(axios.create());
  const offline = await octoprint.counterpartProgress("127.0.0.1", fake.port, "k");
  assert.equal(offline.state, "offline");
  assert.deepEqual(offline.problems.map(p => p.code), ["octoprint.disconnected"]);
  assert.match(offline.problems[0].message, /isn't connected to the printer \(Closed\)/);

  const connected = await octoprint.connectPrinter("127.0.0.1", fake.port, "k", { waitMs: 2_000 });
  assert.equal(connected.action, "connected");
  const post = fake.requests.find(r => r.method === "POST" && r.url === "/api/connection");
  assert.deepEqual(post.body, { command: "connect" }, "no port or baud rate unless given: OctoPrint's own saved choice");

  const before = fake.requests.length;
  const again = await octoprint.connectPrinter("127.0.0.1", fake.port, "k");
  assert.equal(again.action, "none");
  assert.ok(!fake.requests.slice(before).some(r => r.method === "POST"), "nothing is sent when already connected");
});

test("connect_printer reports a connection still settling, and one that failed, in OctoPrint's words", async (t) => {
  const steps = { value: [] };
  const fake = await fakeOctoPrint((request) => {
    if (request.url === "/api/connection" && request.method === "POST") return [204];
    if (request.url === "/api/connection") {
      const state = steps.value.length > 1 ? steps.value.shift() : steps.value[0];
      return [200, { current: { state, port: null, baudrate: null }, options: { ports: ["/dev/ttyUSB0"] } }];
    }
    return undefined;
  });
  t.after(fake.close);
  const octoprint = new OctoPrintImplementation(axios.create());
  steps.value = ["Closed", "Detecting serial connection", "Connecting", "Offline after error"];
  const failed = await octoprint.connectPrinter("127.0.0.1", fake.port, "k", { waitMs: 10_000 });
  assert.equal(failed.action, "failed");
  assert.match(failed.message, /Offline after error/);
  assert.match(failed.message, /\/dev\/ttyUSB0/);
  steps.value = ["Closed", "Detecting serial connection"];
  const settling = await octoprint.connectPrinter("127.0.0.1", fake.port, "k", { waitMs: 1_500 });
  assert.equal(settling.action, "connecting");
});

test("camera URLs: OctoPi's webcam on port 80 for a plain host, the URL's own server for a URL host", async () => {
  const octoprint = new OctoPrintImplementation({ get: async () => ({ data: { webcam: { webcamEnabled: true } } }) });
  const plain = await octoprint.cameraCandidates("octopi.local", "5000", "k");
  assert.equal(plain.at(-1).url, "http://octopi.local/webcam/?action=snapshot", "not OctoPrint's own port 5000");
  const proxied = await octoprint.cameraCandidates("https://pi.example.com/octoprint/", "80", "k");
  assert.equal(proxied.at(-1).url, "https://pi.example.com/webcam/?action=snapshot");
  const v6 = await octoprint.cameraCandidates("fd00::5", "80", "k");
  assert.equal(v6.at(-1).url, "http://[fd00::5]/webcam/?action=snapshot");

  const { CounterpartService } = await import("../dist/counterpart/service.js");
  const service = new CounterpartService(() => octoprint, axios.create(), { name: "t", version: "0" });
  const target = { type: "octoprint", host: "https://pi.example.com/octoprint", port: "80", apiKey: "k" };
  assert.deepEqual(service.resolve("/webcam/?action=stream", target), ["https://pi.example.com/webcam/?action=stream"]);
  assert.deepEqual(service.resolve("webcam/?action=snapshot", target), ["https://pi.example.com/octoprint/webcam/?action=snapshot"], "a path without a leading slash stays under OctoPrint's sub-path");
  assert.deepEqual(service.resolve("http://127.0.0.1:8080/?action=snapshot", target), ["http://pi.example.com:8080/?action=snapshot"]);
});

test("a printer switched off through PSU Control is switched on only with power_on", async (t) => {
  const state = { value: "Closed" };
  const psu = { on: false };
  const fake = await fakeOctoPrint(connectionApi(state, { psu }));
  t.after(fake.close);
  const octoprint = new OctoPrintImplementation(axios.create());
  const progress = await octoprint.counterpartProgress("127.0.0.1", fake.port, "k");
  assert.match(progress.problems[0].message, /switched off \(PSU Control\)/);
  const refused = await octoprint.connectPrinter("127.0.0.1", fake.port, "k");
  assert.equal(refused.action, "failed");
  assert.equal(psu.on, false);
  assert.ok(!fake.requests.some(r => r.method === "POST"));
  const connected = await octoprint.connectPrinter("127.0.0.1", fake.port, "k", { powerOn: true, waitMs: 2_000 });
  assert.equal(psu.on, true);
  assert.equal(connected.poweredOn, true);
  assert.equal(connected.action, "connected");
});

test("Application Keys: the server keeps polling, so an answer after OctoPrint's 5 s poll timeout still arrives", async (t) => {
  // Like OctoPrint's PendingDecision: dropped when not polled for 5 s (POLL_TIMEOUT), and the key is handed out once.
  let polls = 0, decided = false, lastPoll = 0, dropped = false, handedOut = false;
  const fake = await fakeOctoPrint((request) => {
    if (request.url === "/plugin/appkeys/probe") return [204];
    if (request.url === "/plugin/appkeys/request" && request.method === "POST") {
      assert.deepEqual(request.body, { app: "Counterpart" });
      lastPoll = Date.now();
      return [201, { app_token: "tok/1", auth_dialog: "http://octopi.local/plugin/appkeys/auth/tok" }];
    }
    if (request.url === "/plugin/appkeys/request/tok%2F1") {
      if (Date.now() - lastPoll > 5_000) dropped = true;
      lastPoll = Date.now();
      polls++;
      if (dropped || handedOut) return undefined;
      if (decided) { handedOut = true; return [200, { api_key: "NEWKEY" }]; }
      return [202, { message: "Awaiting decision" }];
    }
    return undefined;
  });
  t.after(fake.close);
  const keys = new OctoPrintAppKeys(axios.create());
  t.after(() => keys.close());
  const started = await keys.request({ host: "127.0.0.1", port: fake.port, app: "Counterpart" });
  assert.equal(started.status, "pending");
  assert.equal(started.approve_url, "http://octopi.local/plugin/appkeys/auth/tok");
  await new Promise(resolve => setTimeout(resolve, 7_000)); // longer than OctoPrint's poll timeout, between two calls
  assert.ok(polls >= 3, "polled in the background between calls");
  assert.equal(dropped, false, "never left unpolled for 5 s");
  decided = true;
  const approved = await keys.request({ host: "127.0.0.1", port: fake.port, app: "Counterpart", requestId: started.request_id, waitMs: 5_000 });
  assert.equal(approved.status, "approved");
  assert.equal(approved.api_key, "NEWKEY");
  assert.deepEqual(approved.env, { API_KEY: "NEWKEY" });
  const gone = await keys.request({ host: "127.0.0.1", port: fake.port, app: "Counterpart", requestId: started.request_id });
  assert.equal(gone.status, "expired", "an answered request is read once");
});

test("Application Keys: denied, unsupported and rate-limited answers", async (t) => {
  let mode = "deny";
  const fake = await fakeOctoPrint((request) => {
    if (request.url === "/plugin/appkeys/probe") return mode === "old" ? undefined : [204];
    if (request.url === "/plugin/appkeys/request") return mode === "busy" ? [429, { error: "too many" }] : [201, { app_token: "t", auth_dialog: "u" }];
    if (request.url === "/plugin/appkeys/request/t") return undefined; // 404: denied or lapsed
    return undefined;
  });
  t.after(fake.close);
  const keys = new OctoPrintAppKeys(axios.create());
  t.after(() => keys.close());
  const denied = await keys.request({ host: "127.0.0.1", port: fake.port, app: "x", waitMs: 5_000 });
  assert.equal(denied.status, "denied");
  mode = "old";
  assert.equal((await keys.request({ host: "127.0.0.1", port: fake.port, app: "x" })).status, "unsupported");
  mode = "busy";
  assert.equal((await keys.request({ host: "127.0.0.1", port: fake.port, app: "x" })).status, "rate-limited");
  assert.equal((await keys.request({ host: "127.0.0.1", port: "1", app: "x" })).status, "unreachable");
});

test("counterpart_setup_fields offers the OctoPrint key through Application Keys", () => {
  const fields = genericSetupFields({ server: { name: "s", version: "1" }, models: [] });
  const octoprint = fields.kinds.find(kind => kind.kind === "octoprint");
  const secret = octoprint.fields.find(field => field.name === "secret");
  assert.deepEqual(secret.obtain?.tool, "octoprint_request_api_key");
  assert.equal(secret.env, "API_KEY");
  const hostField = octoprint.fields.find(field => field.name === "host");
  assert.match(hostField.hint, /https:\/\//);
  assert.equal(hostField.input, "url", "a client accepts a URL for OctoPrint's address");
  for (const other of fields.kinds.filter(kind => kind.kind !== "octoprint")) {
    assert.equal(other.fields.find(field => field.name === "host").input, undefined, `${other.kind} takes a host name or address only`);
  }
});

test("PrusaSlicer: a config with binary G-code on gets --no-binary-gcode; bgcode output is recognised", () => {
  const dir = trackedMkdtempSync(path.join(os.tmpdir(), "prusa-binary-"));
  const binary = path.join(dir, "mk4s.ini"), text = path.join(dir, "mk3s.ini"), gcode = path.join(dir, "out.gcode"), bgcode = path.join(dir, "out.bgcode");
  fs.writeFileSync(binary, "# generated by PrusaSlicer 2.8.1\nbinary_gcode = 1\nprinter_model = MK4S\n");
  fs.writeFileSync(text, "binary_gcode = 0\n");
  assert.deepEqual(prusaSlicerPlainGcodeArgs("prusaslicer", [binary]), ["--no-binary-gcode"]);
  assert.deepEqual(prusaSlicerPlainGcodeArgs("prusaslicer", [text]), []);
  assert.deepEqual(prusaSlicerPlainGcodeArgs("prusaslicer", [binary, text]), [], "the last loaded config wins, as with --load");
  assert.deepEqual(prusaSlicerPlainGcodeArgs("slic3r", [binary]), [], "Slic3r has no such option");
  fs.writeFileSync(gcode, "; generated by PrusaSlicer\nG28\n");
  fs.writeFileSync(bgcode, Buffer.concat([Buffer.from("GCDE"), Buffer.from([1, 0, 0, 0])]));
  assert.equal(isBinaryGcode(gcode), false);
  assert.equal(isBinaryGcode(bgcode), true);
});
