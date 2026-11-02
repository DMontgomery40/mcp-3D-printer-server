// Fusion bridge (PRD §8.9) against a stdio peer that answers like the pinned
// faust-machines server. A loopback TCP listener stands in for the Fusion360MCP
// add-in port. No Fusion is launched: no test passes launch: true.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";
import { FUSION_ADDIN_DEFAULT_PORT, FUSION_MCP_DEFAULT_ARGS, FUSION_MCP_PINNED_COMMIT, fusionLaunchArguments } from "../dist/fusion-mcp-bridge.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(ROOT, "tests", "fixtures", "fusion-mcp-server.mjs");

/** A TCP listener answering ping like the Fusion360MCP add-in, or like Blender's addon on the same default port. */
async function addinPort(t, reply = { status: "success", result: { ok: true, status: "pong" } }) {
  const server = net.createServer((socket) => socket.once("data", () => socket.end(`${JSON.stringify(reply)}\n`)));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return String(server.address().port);
}

async function start(t, { mode = "normal", configured = true, port } = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "fusion-mcp-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const logPath = path.join(temp, "fusion.log");
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, MCP_TRANSPORT: "stdio", TEMP_DIR: temp, PRINTER_TYPE: "octoprint",
    BAMBU_TOKEN: "printer-secret", API_KEY: "printer-secret",
    FUSION_MCP_HOST: "127.0.0.1", FUSION_MCP_PORT: port ?? "1",
    ...(configured ? { FUSION_MCP_COMMAND: process.execPath, FUSION_MCP_ARGS: JSON.stringify([FIXTURE, mode, logPath]) } : {}),
  };
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, "dist", "index.js")], cwd: temp, env, stderr: "pipe" });
  const client = new Client({ name: "fusion-tests", version: "1" });
  await client.connect(transport);
  t.after(() => client.close());
  await client.listTools();
  const call = (name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 30000 });
  const requests = () => existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  return { call, temp, requests };
}

const text = (result) => result.content?.find((entry) => entry.type === "text")?.text ?? "";

test("Fusion's add-in port defaults to 9877, off Blender's 9876, and launches pass it to Fusion", () => {
  assert.equal(FUSION_ADDIN_DEFAULT_PORT, 9877);
  assert.deepEqual(fusionLaunchArguments(9877), ["-a", "Autodesk Fusion", "--env", "FUSION_MCP_PORT=9877"]);
});

test("the pinned faust-machines command is the default FUSION_MCP_ARGS", () => {
  assert.equal(FUSION_MCP_PINNED_COMMIT, "19b9f1e95192");
  assert.deepEqual(FUSION_MCP_DEFAULT_ARGS, ["--from", "git+https://github.com/faust-machines/fusion360-mcp-server@19b9f1e95192", "fusion360-mcp-server", "--mode", "socket"]);
});

test("fusion_mcp_status without configuration reports it and starts nothing", async (t) => {
  const { call } = await start(t, { configured: false });
  const result = await call("fusion_mcp_status");
  assert.notEqual(result.isError, true, text(result));
  assert.equal(result.structuredContent.configured, false);
  assert.equal(result.structuredContent.connected, false);
  assert.equal(result.structuredContent.addinReachable, false);
  assert.deepEqual(result.structuredContent.tools, []);
  assert.equal(result.structuredContent.launched, false);
  assert.equal(result.structuredContent.pin, "19b9f1e95192");
  const failed = await call("fusion_mcp_call", { tool_name: "ping" });
  assert.equal(failed.isError, true);
  assert.match(text(failed), /FUSION_MCP_COMMAND/);
  assert.equal(failed.structuredContent, undefined);
});

test("one persistent Fusion session serves status, calls, a new design and an export", async (t) => {
  const port = await addinPort(t);
  const { call, temp, requests } = await start(t, { port });
  const status = (await call("fusion_mcp_status")).structuredContent;
  assert.equal(status.configured, true);
  assert.equal(status.addinReachable, true);
  assert.equal(status.connected, true, "the add-in answered ping");
  assert.equal(status.fusionRunning, true);
  assert.deepEqual([status.launched, status.transport, status.pin], [false, "stdio", "19b9f1e95192"]);
  assert.equal(status.server.name, "fusion360-mcp-server");
  assert.deepEqual(status.tools.find((tool) => tool.name === "export_stl").inputSchema.required, ["body_name"], "tools carry their schemas");
  assert.equal((await call("fusion_mcp_status", { tool_names: ["ping"] })).isError, true, "arguments match bambu-printer-mcp's");

  const sketch = await call("fusion_mcp_call", { tool_name: "create_sketch", arguments: { plane: "xy" } });
  assert.notEqual(sketch.isError, true, text(sketch));
  assert.match(text(sketch), /^\*\*create_sketch\*\* OK/);
  assert.deepEqual(sketch.structuredContent, {}, "the remote structuredContent, else an empty object");
  const mismatch = await call("fusion_mcp_call", { tool_name: "create_sketch", arguments: { plane: "diagonal" } });
  assert.equal(mismatch.isError, true);
  assert.match(text(mismatch), /do not match its advertised input schema/);
  const unknown = await call("fusion_mcp_call", { tool_name: "measure_everything" });
  assert.equal(unknown.isError, true);

  const design = await call("fusion_mcp_new_design");
  assert.deepEqual(design.structuredContent, { status: "created", document: "Untitled", parametric: true });

  const exported = await call("fusion_mcp_export", { output_dir: temp, name: "bracket" });
  assert.notEqual(exported.isError, true, text(exported));
  const files = exported.structuredContent;
  const real = await fs.realpath(temp);
  assert.deepEqual([files.status, files.stl, files.f3d, files.parameters], ["exported", path.join(real, "bracket.stl"), path.join(real, "bracket.f3d"), path.join(real, "bracket.parameters.json")]);
  assert.deepEqual([files.body, files.triangles, files.bytes, files.parameterCount], ["Bracket", 1, 134, 1]);
  assert.equal(files.stlUnits, "mm");
  assert.deepEqual(files.boundingBox.dimensions, [20, 10, 5]);
  assert.deepEqual(files.fusionSizeMm, [20, 10, 5]);
  assert.deepEqual(JSON.parse(await fs.readFile(files.parameters, "utf8")).parameters[0].expression, "20 mm");
  assert.ok((await fs.stat(files.f3d)).size > 0);
  assert.deepEqual((await fs.readdir(real)).filter((name) => name.startsWith(".mcp3d-")), [], "staged files are removed");

  // Never overwrite: a second export with the same name stops before calling Fusion's exporters.
  const exportsBefore = requests().filter((entry) => entry.name === "export_stl").length;
  const again = await call("fusion_mcp_export", { output_dir: temp, name: "bracket" });
  assert.equal(again.isError, true);
  assert.match(text(again), /already exists; fusion_mcp_export never overwrites/);
  assert.equal(requests().filter((entry) => entry.name === "export_stl").length, exportsBefore);

  const log = requests();
  assert.equal(log.filter((entry) => entry.event === "spawn").length, 1, "the client is kept for the life of the server");
  assert.equal(log.find((entry) => entry.event === "spawn").printerSecretPresent, false, "printer credentials never reach Fusion");
  assert.equal(log.find((entry) => entry.event === "spawn").fusionHost, "127.0.0.1", "FUSION_MCP_HOST passes through");
  assert.equal(log.find((entry) => entry.event === "spawn").fusionPort, port, "the faust server dials the port the bridge probes");
  assert.equal(log.filter((entry) => entry.name === "create_sketch").length, 1, "calls are never replayed");
});

test("without an open design, Fusion tools explain the faust-machines bootstrap gap (issue #12)", async (t) => {
  const port = await addinPort(t);
  const { call, temp } = await start(t, { port, mode: "no-design" });
  const design = await call("fusion_mcp_new_design");
  assert.equal(design.isError, true);
  assert.match(text(design), /issue #12/);
  assert.match(text(design), /File > New Design/);
  const exported = await call("fusion_mcp_export", { output_dir: temp, name: "part" });
  assert.equal(exported.isError, true);
  assert.match(text(exported), /issue #12/);
  const passthrough = await call("fusion_mcp_call", { tool_name: "create_sketch", arguments: {} });
  assert.equal(passthrough.isError, true, "remote errors pass through as errors");
  assert.match(text(passthrough), /NO_ACTIVE_DESIGN/);
  assert.deepEqual(passthrough.structuredContent, {});
});

test("fusion_mcp_export needs body_name for several bodies, warns on centimetre STLs, and checks the files arrived", async (t) => {
  const port = await addinPort(t);
  const two = await start(t, { port, mode: "two-bodies" });
  let result = await two.call("fusion_mcp_export", { output_dir: two.temp, name: "case" });
  assert.equal(result.isError, true);
  assert.match(text(result), /2 visible solid bodies \(Bracket, Lid\); pass body_name/);
  result = await two.call("fusion_mcp_export", { output_dir: two.temp, name: "lid", body_name: "Ghost" });
  assert.match(text(result), /No visible solid body named "Ghost"/);
  result = await two.call("fusion_mcp_export", { output_dir: two.temp, name: "../escape" });
  assert.match(text(result), /plain file name/);

  // export_stl would take the hidden root "Bracket" first, so the visible one's name is ambiguous.
  const hidden = await start(t, { port, mode: "hidden-duplicate" });
  result = await hidden.call("fusion_mcp_export", { output_dir: hidden.temp, name: "part" });
  assert.equal(result.isError, true);
  assert.match(text(result), /Several bodies are named "Bracket" \(including hidden ones/);
  assert.equal(hidden.requests().filter((entry) => entry.name === "export_stl").length, 0, "nothing is exported");

  const cm = await start(t, { port, mode: "stl-cm" });
  result = await cm.call("fusion_mcp_export", { output_dir: cm.temp, name: "part" });
  assert.notEqual(result.isError, true, text(result));
  assert.equal(result.structuredContent.stlUnits, "cm");
  assert.match(result.structuredContent.warnings[0], /centimetres/);

  const missing = await start(t, { port, mode: "no-files" });
  result = await missing.call("fusion_mcp_export", { output_dir: missing.temp, name: "part" });
  assert.equal(result.isError, true);
  assert.match(text(result), /same computer/);
  assert.equal(existsSync(path.join(missing.temp, "part.stl")), false);
  assert.equal(existsSync(path.join(missing.temp, "part.parameters.json")), false, "nothing is published on failure");
});

test("fusion_mcp_status reports an unreachable add-in as not connected", async (t) => {
  const { call } = await start(t, { mode: "addin-down" });
  const status = (await call("fusion_mcp_status")).structuredContent;
  assert.equal(status.configured, true);
  assert.equal(status.addinReachable, false);
  assert.equal(status.connected, false);
  assert.ok(status.tools.length > 0, "the server itself still lists its tools");
});

test("the add-in probe accepts both pongs the pinned add-in sends, and nothing else", async (t) => {
  for (const [result, reachable] of [[{ ok: true, status: "pong" }, true], [{ pong: true }, true], [{ ok: true, status: "busy" }, false], [{ ok: true }, false]]) {
    const port = await addinPort(t, { status: "success", result });
    const { call } = await start(t, { port });
    const status = (await call("fusion_mcp_status")).structuredContent;
    assert.equal(status.addinReachable, reachable, JSON.stringify(result));
  }
});

test("Blender's addon on the shared default port is not mistaken for the Fusion add-in", async (t) => {
  const port = await addinPort(t, { status: "error", message: "Unknown command type: ping" });
  const { call } = await start(t, { port, mode: "addin-down" });
  const status = (await call("fusion_mcp_status")).structuredContent;
  assert.equal(status.addinReachable, false);
  assert.equal(status.connected, false);
});

test("a listener that trickles bytes cannot hold the add-in probe past its 2 s deadline", async (t) => {
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    const timer = setInterval(() => { if (!socket.destroyed) socket.write(" "); }, 200);
    socket.on("close", () => clearInterval(timer));
    t.after(() => { clearInterval(timer); socket.destroy(); });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { call } = await start(t, { port: String(server.address().port), configured: false });
  const began = Date.now();
  const status = (await call("fusion_mcp_status")).structuredContent;
  assert.equal(status.addinReachable, false);
  assert.ok(Date.now() - began < 6000, `the probe ended after ${Date.now() - began} ms`);
});

test("closing stdin without a signal shuts the server and its Fusion MCP child down", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "fusion-eof-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const logPath = path.join(temp, "fusion.log");
  const child = spawn(process.execPath, [path.join(ROOT, "dist", "index.js")], {
    cwd: temp,
    stdio: ["pipe", "pipe", "ignore"],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, MCP_TRANSPORT: "stdio", TEMP_DIR: temp, PRINTER_TYPE: "octoprint",
      FUSION_MCP_COMMAND: process.execPath, FUSION_MCP_ARGS: JSON.stringify([FIXTURE, "normal", logPath]), FUSION_MCP_PORT: "1" },
  });
  t.after(() => child.kill("SIGKILL"));
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const reply = async (id) => {
    for (let i = 0; i < 300; i += 1) {
      const line = out.split("\n").find((entry) => entry.includes(`"id":${id}`));
      if (line) return JSON.parse(line);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`no reply ${id}`);
  };
  send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "eof", version: "1" } } });
  await reply(1);
  send({ method: "notifications/initialized" });
  send({ id: 2, method: "tools/call", params: { name: "fusion_mcp_call", arguments: { tool_name: "ping" } } });
  assert.match(JSON.stringify(await reply(2)), /\*\*ping\*\* OK/);
  const fusionPid = JSON.parse(readFileSync(logPath, "utf8").split("\n")[0]).pid;
  const exited = once(child, "exit");
  child.stdin.end();
  const [code] = await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error("server did not exit after stdin EOF")), 10000))]);
  assert.equal(code, 0);
  for (let i = 0; i < 40; i += 1) {
    try { process.kill(fusionPid, 0); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`the Fusion MCP child ${fusionPid} outlived the server`);
});
