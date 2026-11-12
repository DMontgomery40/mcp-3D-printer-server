import {CAD_CAPABILITY} from "../dist/cad/contracts.js";
import {trackedMkdtemp} from './support/temp.mjs';
// counterpart/1 tools over MCP stdio against loopback printer mocks. The SDK
// client validates structuredContent against each tool's outputSchema, so a
// passing call proves the declared schema. No printer is contacted.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import axios from "axios";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cameraNativeAvailable } from "../dist/counterpart/camera-stream.js";
import { CounterpartService } from "../dist/counterpart/service.js";
import { SELF_CHECK_OUTPUT_SCHEMA } from "../dist/counterpart/self-check.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = path.join(ROOT, "tests", "fixtures", "counterpart");
const fixture = async (name) => JSON.parse(await fs.readFile(path.join(FIXTURES, name), "utf8"));
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);
const COUNTERPART_TOOLS = ["counterpart_printer_info", "counterpart_print_progress", "camera_snapshot", "get_printer_filaments", "pause_print", "resume_print"];

/** A loopback HTTP server answering routes from a table; records every request. */
async function mock(t, routes) {
  const requests = [];
  const http = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const record = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() };
    requests.push(record);
    const route = routes.find(([match]) => (typeof match === "string" ? req.url === match || req.url.startsWith(`${match}?`) : match(record)));
    if (!route) { res.writeHead(404, { "Content-Type": "application/json" }); return res.end("{}"); }
    const [, status, body, type = "application/json"] = typeof route[1] === "function" ? [route[0], ...route[1](record)] : route;
    res.writeHead(status, { "Content-Type": type });
    res.end(Buffer.isBuffer(body) ? body : body === undefined ? "" : JSON.stringify(body));
  });
  t.after(() => new Promise((resolve) => http.close(resolve)));
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  return { port: String(http.address().port), requests };
}

async function server(t, env) {
  const temp = await trackedMkdtemp(path.join(os.tmpdir(), "counterpart-tools-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, "dist", "index.js")],
    cwd: temp, // outside the repo, so a developer .env cannot change the configuration
    // An empty HOME: installed slicer profiles on the test machine must not change slots[].profile.
    env: { PATH: process.env.PATH, HOME: path.join(temp, "home"), MCP_TRANSPORT: "stdio", TEMP_DIR: temp, PRINTER_HOST: "127.0.0.1", API_KEY: "KEY", ...env },
    stderr: "pipe",
  });
  const client = new Client({ name: "counterpart-tests", version: "1" });
  await client.connect(transport);
  t.after(() => client.close());
  await client.listTools(); // caches outputSchema validators
  return { client, temp };
}

// What auto-update reads (Counterpart #644): package.json's counterpart field before downloading, then the
// initialize version and counterpart_self_check from the updated server.
test("package.json's counterpart field names the contract, one sentence of notes and the auto-update choice", async () => {
  const { counterpart } = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8"));
  assert.deepEqual(Object.keys(counterpart).sort(), ["autoUpdate", "contract", "notes"]);
  assert.equal(counterpart.contract, "counterpart/1");
  assert.equal(typeof counterpart.autoUpdate, "boolean");
  assert.match(counterpart.notes, /^[A-Z][^\n]*[.!]$/);
  assert.equal(counterpart.notes.split(/[.!?](?:\s|$)/).filter(Boolean).length, 1, "one sentence");
});

test("counterpart_self_check reports each runtime dependency and Web Crypto, and the server's version is the package's", async (t) => {
  const { client } = await server(t, { PRINTER_TYPE: "octoprint" });
  const { version, dependencies, optionalDependencies } = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(client.getServerVersion().version, version, "initialize reports the package version");
  const tool = (await client.listTools()).tools.find((entry) => entry.name === "counterpart_self_check");
  assert.deepEqual(tool?.outputSchema, JSON.parse(JSON.stringify(SELF_CHECK_OUTPUT_SCHEMA)));
  const { contract, server: info, ok, checks } = (await call(client, "counterpart_self_check")).structuredContent;
  assert.deepEqual([contract, info.version, ok], ["counterpart/1", version, true], JSON.stringify(checks.filter((check) => !check.ok)));
  assert.deepEqual(checks.map((check) => check.name), ["package", ...Object.keys(dependencies), ...Object.keys(optionalDependencies), "web crypto"]);
  assert.ok(checks.filter((check) => !check.optional).every((check) => check.ok));
  assert.deepEqual(checks.filter((check) => check.optional).map((check) => check.name), Object.keys(optionalDependencies));
  assert.equal(checks.find((check) => check.name === "bambu-node").version, dependencies["bambu-node"], "the pinned version is the one loaded");
});

test("the self-check judges installed versions against package.json's exact pins, ^ and ~ ranges", async () => {
  const { meetsDeclared } = await import("../dist/counterpart/self-check.js");
  for (const [version, declared, meets] of [["3.22.21", "3.22.21", true], ["3.22.22", "3.22.21", false], ["1.32.2", "^1.32.2", true], ["1.40.0", "^1.32.2", true],
    ["1.10.0", "^1.32.2", false], ["2.0.0", "^1.32.2", false], ["0.173.1", "^0.173.0", true], ["0.174.0", "^0.173.0", false], ["16.3.9", "~16.3.1", true],
    ["16.4.0", "~16.3.1", false], ["3.22.21-beta.1", "3.22.21", false], ["4.6.8-rc.0", "^4.6.7", false], ["1.0.0", ">=1", undefined]]) assert.equal(meetsDeclared(version, declared), meets, `${version} ${declared}`);
});

// A form the check cannot judge is reported, never passed (Muse P2 on #156/#110).
test("the self-check fails a dependency whose declared version it cannot judge", async () => {
  const { versionProblem } = await import("../dist/counterpart/self-check.js");
  assert.equal(versionProblem("dep", "1.40.0", "^1.32.2"), undefined);
  assert.match(versionProblem("dep", "1.10.0", "^1.32.2"), /needs dep \^1\.32\.2; 1\.10\.0 is installed/);
  for (const declared of [">=1.0.0", "*", "1.x", "^1.2", "latest", "npm:other@1.0.0"]) {
    assert.match(versionProblem("dep", "1.0.0", declared) ?? "", /cannot judge/, declared);
  }
  assert.match(versionProblem("dep", undefined, "^1.0.0"), /an unknown version/);
});

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (!result.isError) assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent, "text carries the same JSON");
  return result;
}

test("every counterpart/1 tool declares an outputSchema with an object root", async (t) => {
  const { client } = await server(t, { PRINTER_TYPE: "octoprint" });
  const tools = (await client.listTools()).tools;
  for (const name of COUNTERPART_TOOLS) {
    const tool = tools.find((entry) => entry.name === name);
    assert.ok(tool, name);
    assert.equal(tool.outputSchema?.type, "object", name);
  }
  const slice = tools.find((entry) => entry.name === "slice_stl");
  for (const key of ["quality", "strength", "layer_height", "wall_loops", "sparse_infill_density"]) assert.ok(slice.inputSchema.properties[key], key);
  assert.ok(tools.find((entry) => entry.name === "slice_with_template").inputSchema.properties.layer_height);
});

test("OctoPrint over MCP: info, progress, filaments and a Classic Webcam snapshot from another host", async (t) => {
  const camera = await mock(t, [["/snapshot.jpg", 200, JPEG, "image/jpeg"]]);
  const settings = await fixture("octoprint-1.11-settings.webcam.json");
  const snapshot = `http://localhost:${camera.port}/snapshot.jpg`; // loopback as the Pi sees it
  settings.plugins.classicwebcam.snapshot = snapshot;
  settings.webcam.snapshotUrl = snapshot;
  const printer = await mock(t, [
    ["/api/job", 200, await fixture("octoprint-1.11-job.printing.json")],
    ["/api/printer", 409, { error: "Printer is not operational" }],
    ["/api/settings", 200, settings],
    ["/api/printerprofiles", 200, { profiles: { _default: { name: "Default", model: "Prusa i3", current: true } } }],
  ]);
  const { client, temp } = await server(t, { PRINTER_TYPE: "octoprint", PRINTER_PORT: printer.port });
  const info = (await call(client, "counterpart_printer_info")).structuredContent;
  assert.equal(info.contract, "counterpart/1");
  assert.equal(info.server.name, "mcp-3d-printer-server");
  assert.deepEqual(info.printer, { kind: "octoprint", host: "127.0.0.1", model: "Prusa i3", name: "Default" });
  assert.deepEqual(info.capabilities, { cad: CAD_CAPABILITY, progress: true, layers: false, camera: "http-snapshot", cameraStream: await cameraNativeAvailable(), filaments: "single", pause: true, resume: true, cancel: true, print3mf: false, gcode: true,
    slicing: { supports: false, copies: false, orient: false } }, "PrusaSlicer (the default for OctoPrint) takes none of them here");
  const progress = (await call(client, "counterpart_print_progress")).structuredContent;
  assert.equal(progress.state, "printing");
  assert.equal(progress.job.name, "kan216-long.gcode");
  assert.deepEqual((await call(client, "get_printer_filaments")).structuredContent, { slots: [{ label: "Spool", id: "ext", source: "unknown" }] });
  const savePath = path.join(temp, "frame.jpg");
  const frame = (await call(client, "camera_snapshot", { save_path: savePath, timeout_ms: 3000, bambu_model: "ignored" })).structuredContent;
  assert.equal(frame.format, "image/jpeg");
  assert.equal(frame.source, "octoprint-settings");
  assert.equal(Buffer.from(frame.base64, "base64").compare(JPEG), 0);
  assert.equal(frame.savedTo, savePath);
  assert.equal((await fs.readFile(savePath)).compare(JPEG), 0);
  assert.ok(Date.parse(frame.capturedAt));
  assert.ok(camera.requests.every((request) => request.headers["x-api-key"] === undefined), "the API key never goes to another origin");
});

test("errors from schema tools carry no structuredContent, so clients return them instead of throwing", async (t) => {
  const printer = await mock(t, [["/api/job", 403, { error: "Forbidden" }]]);
  const { client } = await server(t, { PRINTER_TYPE: "octoprint", PRINTER_PORT: printer.port });
  const result = await client.callTool({ name: "counterpart_print_progress", arguments: {} });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent, undefined);
  assert.match(result.content[0].text, /403/);
  // Existing tools keep their structured error.
  const legacy = await client.callTool({ name: "get_printer_status", arguments: {} });
  assert.equal(legacy.isError, true);
  assert.equal(legacy.structuredContent.status, "error");
});

test("an unreachable printer reports offline, and PrusaLink without an override has no camera", async (t) => {
  // Own the failing endpoint: guessing an adjacent unused port can hit another parallel fixture.
  const closed = createServer(request => request.socket.destroy());
  closed.listen(0, "127.0.0.1"); await once(closed, "listening");
  t.after(() => new Promise(resolve => closed.close(resolve)));
  const unusedPort = String(closed.address().port);
  const { client } = await server(t, { PRINTER_TYPE: "klipper", PRINTER_PORT: unusedPort });
  const offline = (await call(client, "counterpart_print_progress", { port: unusedPort })).structuredContent;
  assert.equal(offline.state, "offline");
  assert.deepEqual(offline.problems, []);
  const prusa = await mock(t, [["/api/v1/status", 200, { printer: { state: "IDLE" } }], ["/api/v1/info", 200, { name: "MK4", serial: "SN123" }]]);
  const info = (await call(client, "counterpart_printer_info", { type: "prusa", port: prusa.port })).structuredContent;
  assert.deepEqual(info.printer, { kind: "prusa", host: "127.0.0.1", name: "MK4", serial: "SN123" });
  assert.equal(info.capabilities.camera, "none");
  assert.equal(info.capabilities.layers, false);
  const snapshot = await client.callTool({ name: "camera_snapshot", arguments: { type: "prusa", port: prusa.port } });
  assert.equal(snapshot.isError, true);
  assert.match(snapshot.content[0].text, /PRINTER_CAMERA_SNAPSHOT_URL/);
});

test("PRINTER_CAMERA_SNAPSHOT_URL overrides the source; non-JPEG replies are rejected", async (t) => {
  const camera = await mock(t, [["/still.jpg", 200, JPEG, "image/jpeg"], ["/page", 200, "<html>", "text/html"]]);
  const prusa = await mock(t, [["/api/v1/status", 200, { printer: { state: "IDLE" } }]]);
  const { client } = await server(t, { PRINTER_TYPE: "prusa", PRINTER_PORT: prusa.port, PRINTER_CAMERA_SNAPSHOT_URL: `http://127.0.0.1:${camera.port}/still.jpg` });
  const frame = (await call(client, "camera_snapshot")).structuredContent;
  assert.equal(frame.source, "env-override");
  assert.equal((await call(client, "counterpart_printer_info")).structuredContent.capabilities.camera, "http-snapshot");
  const { client: html } = await server(t, { PRINTER_TYPE: "prusa", PRINTER_PORT: prusa.port, PRINTER_CAMERA_SNAPSHOT_URL: `http://127.0.0.1:${camera.port}/page` });
  const failed = await html.callTool({ name: "camera_snapshot", arguments: { timeout_ms: 2000 } });
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /not a JPEG/);
});

test("Moonraker over MCP: webcam list, Spoolman slot, slicer-estimate remaining time and pause route", async (t) => {
  const camera = await mock(t, [["/webcam/snap", 200, JPEG, "image/jpeg"]]);
  const status = {
    print_stats: { state: "printing", filename: "job.gcode", print_duration: 100, message: "", info: { current_layer: 3, total_layer: 30 } },
    display_status: { progress: 0.1 }, webhooks: { state: "ready" }, extruder: { temperature: 210, target: 210 }, heater_bed: { temperature: 60, target: 60 },
  };
  const printer = await mock(t, [
    ["/printer/objects/query", 200, { result: { status } }],
    ["/server/files/metadata", 200, { result: { estimated_time: 1000 } }],
    ["/server/webcams/list", 200, { result: { webcams: [
      { name: "off", enabled: false, snapshot_url: "/never" },
      { name: "cam", enabled: true, snapshot_url: `http://127.0.0.1:${camera.port}/webcam/snap` },
    ] } }],
    ["/server/spoolman/spool_id", 200, await fixture("moonraker-spoolman-spool_id.json")],
    ["/server/spoolman/proxy", 200, await fixture("moonraker-spoolman-proxy-spool1.json")],
    ["/printer/info", 200, { result: { hostname: "voron" } }],
    ["/printer/print/pause", 200, { result: "ok" }],
  ]);
  const { client } = await server(t, { PRINTER_TYPE: "klipper", PRINTER_PORT: printer.port, API_KEY: "" });
  const progress = (await call(client, "counterpart_print_progress")).structuredContent;
  assert.deepEqual(progress.job, { name: "job.gcode", progress: 10, elapsedSec: 100, remainingSec: 900, layer: 3, totalLayers: 30 });
  await call(client, "counterpart_print_progress");
  assert.equal(printer.requests.filter((r) => r.url.startsWith("/server/files/metadata")).length, 1, "the estimate is cached between polls");
  assert.deepEqual((await call(client, "get_printer_filaments")).structuredContent.slots,
    [{ label: "Spool", id: "ext", material: "PLA", color: "#FF8800", name: "KAN-216 Test PLA Orange", source: "spoolman" }]);
  assert.equal((await call(client, "camera_snapshot")).structuredContent.source, "moonraker-webcam");
  const info = (await call(client, "counterpart_printer_info")).structuredContent;
  assert.equal(info.printer.name, "voron");
  assert.equal(info.capabilities.layers, true);
  assert.equal((await call(client, "pause_print")).structuredContent.action, "pause");
  const resume = await client.callTool({ name: "resume_print", arguments: {} });
  assert.equal(resume.isError, true, "a job this server did not start is not resumed");
  assert.equal(printer.requests.filter((r) => r.url === "/printer/print/resume").length, 0);
});

test("Moonraker without Spoolman reports an unknown slot", async (t) => {
  const printer = await mock(t, [["/server/spoolman/spool_id", 404, { error: { code: 404, message: "Not Found" } }]]);
  const { client } = await server(t, { PRINTER_TYPE: "klipper", PRINTER_PORT: printer.port });
  assert.deepEqual((await call(client, "get_printer_filaments")).structuredContent, { slots: [{ label: "Spool", id: "ext", source: "unknown" }] });
});

test("upload_gcode names the remote job (jobName)", async (t) => {
  const printer = await mock(t, [["/api/files/local", 201, { done: true, files: { local: { name: "part.gcode" } } }]]);
  const { client, temp } = await server(t, { PRINTER_TYPE: "octoprint", PRINTER_PORT: printer.port });
  const gcode = path.join(temp, "part.gcode");
  await fs.writeFile(gcode, "G28\n");
  const result = await client.callTool({ name: "upload_gcode", arguments: { gcode_path: gcode, filename: "part.gcode" } });
  assert.notEqual(result.isError, true, result.content[0].text);
  assert.equal(JSON.parse(result.content[0].text).jobName, "part.gcode");
});

test("snapshot URLs resolve relative paths and loopback hosts against the printer", () => {
  const service = new CounterpartService(() => { throw new Error("unused"); }, axios.create(), { name: "x", version: "0" });
  const target = { type: "klipper", host: "192.0.2.10", port: "7125", apiKey: "" };
  assert.deepEqual(service.resolve("/webcam/?action=snapshot", target), ["http://192.0.2.10/webcam/?action=snapshot", "http://192.0.2.10:7125/webcam/?action=snapshot"]);
  assert.deepEqual(service.resolve("http://127.0.0.1:8080/?action=snapshot", target), ["http://192.0.2.10:8080/?action=snapshot"]);
  assert.deepEqual(service.resolve("http://cam.local/snap.jpg", target), ["http://cam.local/snap.jpg"]);
  assert.throws(() => service.resolve("file:///etc/passwd", target), /Unsupported snapshot URL scheme/);
});

test("get_printer_filaments: slots[].profile is the installed slicer profile for Spoolman's material, else the configured filament", async (t) => {
  const root = await trackedMkdtemp(path.join(os.tmpdir(), "counterpart-profiles-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (file, value) => {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), typeof value === "string" ? value : JSON.stringify(value));
    return path.join(root, file);
  };
  // A fake OrcaSlicer.app: its bundled profiles, plus a machine preset in SLICER_PROFILE.
  const executable = await write("OrcaSlicer.app/Contents/MacOS/OrcaSlicer", "");
  await write("OrcaSlicer.app/Contents/Resources/profiles/OrcaFilamentLibrary/filament/Generic PLA @System.json",
    { name: "Generic PLA @System", filament_type: ["PLA"], instantiation: "true", compatible_printers: [] });
  const vendor = await write("OrcaSlicer.app/Contents/Resources/profiles/Voron/filament/Voron Generic PLA.json",
    { name: "Voron Generic PLA", filament_type: ["PLA"], instantiation: "true", compatible_printers: ["Voron 2.4 350 0.4 nozzle"] });
  const machine = await write("machine.json", { type: "machine", name: "My Voron", inherits: "Voron 2.4 350 0.4 nozzle" });
  const processProfile = await write("process.json", { type: "process", name: "0.2mm" });
  const printer = await mock(t, [
    ["/server/spoolman/spool_id", 200, await fixture("moonraker-spoolman-spool_id.json")],
    ["/server/spoolman/proxy", 200, await fixture("moonraker-spoolman-proxy-spool1.json")],
  ]);
  const { client } = await server(t, { PRINTER_TYPE: "klipper", PRINTER_PORT: printer.port, API_KEY: "",
    SLICER_TYPE: "orcaslicer", SLICER_PATH: executable, SLICER_PROFILE: `${machine};${processProfile}` });
  const [slot] = (await call(client, "get_printer_filaments")).structuredContent.slots;
  assert.equal(slot.material, "PLA");
  // The bundle is found through the executable's real path, as slice_stl finds it.
  assert.equal(slot.profile, await fs.realpath(vendor), "the profile for this printer, over the universal one");

  // No material reported: the filament slice_stl loads by default (PrusaSlicer takes one .ini preset).
  const preset = await write("PLA preset.ini", "filament_type = PLA\n");
  const octoprint = await mock(t, [["/api/printer", 409, "Printer is not operational", "text/plain"]]);
  const configured = await server(t, { PRINTER_TYPE: "octoprint", PRINTER_PORT: octoprint.port, SLICER_TYPE: "prusaslicer", FILAMENT_PROFILE: preset });
  assert.deepEqual((await call(configured.client, "get_printer_filaments")).structuredContent.slots, [{ label: "Spool", id: "ext", source: "unknown", profile: preset }]);
});

// printer-handoff (scan-to-make services/printer-handoff/src/print.ts) chooses a
// filament only when slice_stl has filament_colours and load_filaments and
// print_3mf has ams_slots and use_ams; it passes them with bambu-printer-mcp's names.
test("Bambu: the tool schemas carry the AMS arguments Counterpart's printer handoff sends", async (t) => {
  const { client } = await server(t, { PRINTER_TYPE: "bambu", BAMBU_SERIAL: "S", BAMBU_TOKEN: "T", BAMBU_MODEL: "p1s" });
  const tools = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
  const print = tools.get("print_3mf").inputSchema.properties;
  for (const key of ["ams_slots", "use_ams", "ams_mapping"]) assert.ok(Object.hasOwn(print, key), `print_3mf.${key}`);
  assert.deepEqual(print.ams_slots, { type: "array", items: { type: "number" }, description: print.ams_slots.description });
  assert.deepEqual(print.ams_mapping.anyOf.map((entry) => entry.type), ["array", "object"]);
  const slice = tools.get("slice_stl").inputSchema.properties;
  for (const key of ["filament_colours", "load_filaments"]) assert.ok(Object.hasOwn(slice, key), `slice_stl.${key}`);
  const filaments = tools.get("get_printer_filaments").inputSchema.properties;
  for (const key of ["bambu_model", "nozzle_diameter"]) assert.ok(Object.hasOwn(filaments, key), `get_printer_filaments.${key}`);
});

test("Bambu: counterpart_printer_info reports AMS filaments", async () => {
  const bambu = Object.create((await import("../dist/printers/bambu.js")).BambuImplementation.prototype);
  bambu.getStatus = async () => ({ connected: true, model: "P1S", serial: "01P00A000000000" });
  const service = new CounterpartService(() => bambu, axios.create(), { name: "test", version: "0" });
  const info = await service.printerInfo({ type: "bambu", host: "192.0.2.1", port: "8883", apiKey: "S:T" });
  assert.equal(info.capabilities.filaments, "ams");
  // The model with its maker, as Bambu names it, for a client to show as given (Counterpart #698).
  assert.deepEqual([info.printer.model, info.printer.displayName], ["P1S", "Bambu Lab P1S"]);
  assert.deepEqual(info.capabilities.slicing, { supports: true, copies: true, orient: true }, "the Bambu-compatible CLI route takes all three");
  const orca = new CounterpartService(() => bambu, axios.create(), { name: "test", version: "0" }, undefined, () => ({ slicerType: "orcaslicer" }));
  assert.deepEqual((await orca.printerInfo({ type: "bambu", host: "192.0.2.1", port: "8883", apiKey: "S:T" })).capabilities.slicing,
    { supports: true, copies: true, orient: true }, "OrcaSlicer for a Bambu printer slices on the Bambu route");
});

test("Bambu: the display name comes from the serial's prefix, else the model, and is absent when neither is known", async () => {
  const { bambuDisplayName } = await import("../dist/counterpart/service.js");
  assert.equal(bambuDisplayName("A1M", "03900A000000000"), "Bambu Lab A1", "bambu-node's A1M for a 039 serial is a full-size A1");
  assert.equal(bambuDisplayName("A1", "03000A000000000"), "Bambu Lab A1 Mini");
  assert.equal(bambuDisplayName("h2d_pro", undefined), "Bambu Lab H2D Pro");
  assert.equal(bambuDisplayName("x1c", "S"), "Bambu Lab X1C", "an unknown prefix falls back to the model");
  assert.equal(bambuDisplayName("Unknown", undefined), undefined);
  assert.equal(bambuDisplayName(undefined, undefined), undefined);
});

test("slice capabilities follow the slicer route", async () => {
  const { sliceCapabilities } = await import("../dist/slicer/capabilities.js");
  assert.deepEqual(sliceCapabilities("orcaslicer", false), { supports: true, copies: false, orient: false });
  assert.deepEqual(sliceCapabilities("prusaslicer", false), { supports: false, copies: false, orient: false });
  assert.deepEqual(sliceCapabilities("cura", false), { supports: false, copies: false, orient: false });
  assert.deepEqual(sliceCapabilities("bambustudio", false), { supports: true, copies: true, orient: true });
});
