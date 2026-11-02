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
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "counterpart-tools-"));
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
  for (const key of ["layer_height", "wall_loops", "sparse_infill_density"]) assert.ok(slice.inputSchema.properties[key], key);
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
  assert.deepEqual(info.capabilities, { progress: true, layers: false, camera: "http-snapshot", cameraStream: await cameraNativeAvailable(), filaments: "single", pause: true, resume: true, cancel: true, print3mf: false, gcode: true });
  const progress = (await call(client, "counterpart_print_progress")).structuredContent;
  assert.equal(progress.state, "printing");
  assert.equal(progress.job.name, "kan216-long.gcode");
  assert.deepEqual((await call(client, "get_printer_filaments")).structuredContent, { slots: [{ id: "ext", source: "unknown" }] });
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
    [{ id: "ext", material: "PLA", color: "#FF8800", name: "KAN-216 Test PLA Orange", source: "spoolman" }]);
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
  assert.deepEqual((await call(client, "get_printer_filaments")).structuredContent, { slots: [{ id: "ext", source: "unknown" }] });
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "counterpart-profiles-"));
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
  assert.deepEqual((await call(configured.client, "get_printer_filaments")).structuredContent.slots, [{ id: "ext", source: "unknown", profile: preset }]);
});
