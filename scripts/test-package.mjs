import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "printer-package-test-"));
let camera;
try {
  const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", directory], { cwd: root, encoding: "utf8" }))[0];
  for (const file of ["dist/index.js", "dist/http-server.js", "dist/sse-server.js", "dist/blender-mcp-bridge.js", "dist/3mf_parser.js",
    "dist/cad-engine.js", "dist/cad/process.js", "dist/cad/contracts.js", "src/cad/worker.py", "src/cad/geometry.py", "src/cad/requirements.lock", "src/cad/requirements.in", "docs/CAD.md",
    "dist/counterpart/camera-stream.js", "dist/counterpart/camera-sources.js", "dist/counterpart/camera-tools.js"]) {
    assert.ok(packed.files.some((entry) => entry.path === file), `Package must contain ${file}`);
  }
  assert.equal(packed.files.some((entry) => /(^|\/)\.env($|\.)|fixtures\/ftps/.test(entry.path)), false);
  await fs.writeFile(path.join(directory, "package.json"), '{"private":true}');
  execFileSync("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", path.join(directory, packed.filename)], { cwd: directory, stdio: "pipe" });
  const installed = path.join(directory, "node_modules", "mcp-3d-printer-server");
  const pkg = JSON.parse(await fs.readFile(path.join(installed, "package.json"), "utf8"));
  for (const file of ['src/cad/worker.py','src/cad/geometry.py','src/cad/requirements.lock','src/cad/requirements.in'])
    assert.equal(await fs.readFile(path.join(installed,file),'utf8'),await fs.readFile(path.join(root,file),'utf8'),`Packed CAD asset differs: ${file}`);
  for (const target of Object.values(pkg.bin)) await fs.access(path.join(installed, target));
  // Resolve the optional native processor from the installed tarball, not this checkout.
  const [major, minor] = process.versions.node.split(".").map(Number);
  const nativeSupported = major > 20 || (major === 20 && minor >= 9);
  const sharp = nativeSupported ? createRequire(path.join(installed, "package.json"))("sharp") : undefined;
  const jpeg = sharp ? await sharp({create: {width: 320, height: 180, channels: 3, background: "#888"}}).jpeg().toBuffer()
    : Buffer.from("/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAT/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKwAf//Z", "base64");
  camera = createServer((_request, response) => { response.writeHead(200, {"Content-Type": "image/jpeg"}); response.end(jpeg); });
  camera.listen(0, "127.0.0.1"); await once(camera, "listening");
  const env = { ...process.env, PRINTER_CAMERA_SNAPSHOT_URL: `http://127.0.0.1:${camera.address().port}/still`, CAD_DATA_DIR: path.join(directory,"cad-data"), MCP_TRANSPORT: "stdio", PRINTER_TYPE: "octoprint", PRINTER_HOST: "127.0.0.1", BLENDER_MCP_COMMAND: "", BLENDER_MCP_BRIDGE_COMMAND: "", TEMP_DIR: path.join(directory, "scratch") };
  async function check(client) {
    assert.equal(client.getServerVersion().version, pkg.version);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    for (const name of ["get_printer_status", "print_3mf", "blender_mcp_status", "blender_mcp_call", "blender_mcp_edit_model"]) assert.ok(names.includes(name));
    for (const name of ["camera_stream_start", "camera_frame", "camera_stream_stop"]) assert.ok(names.includes(name));
    for (const name of ['cad_status','cad_setup','cad_run','cad_check_fit']) assert.ok(names.includes(name));
    assert.equal((await client.callTool({name:'cad_status',arguments:{}})).structuredContent.ready,false);
    assert.match((await client.getPrompt({name:'cad_design'})).messages[0].content.text,/load_scan/);
    const frame = await client.callTool({name: "camera_frame", arguments: {}});
    assert.equal(frame.structuredContent.status, "stopped");
    if (!nativeSupported) {
      const info = await client.callTool({name: "counterpart_printer_info", arguments: {}});
      assert.equal(info.structuredContent.capabilities.cameraStream, false);
      assert.deepEqual((await client.callTool({name: "camera_stream_start", arguments: {}})).structuredContent, {status: "not-supported", reason: "runtime"});
      assert.equal((await client.callTool({name: "camera_snapshot", arguments: {}})).structuredContent.base64, jpeg.toString("base64"));
    } else {
      assert.equal((await client.callTool({name: "camera_stream_start", arguments: {}})).structuredContent.status, "started");
      const live = (await client.callTool({name: "camera_frame", arguments: {wait_ms: 2000, max_bytes: 42000}})).structuredContent;
      assert.equal(live.status, "frame");
      const image = Buffer.from(live.base64, "base64");
      assert.ok(image.length <= 42000);
      assert.equal((await sharp(image).metadata()).format, "jpeg");
      await client.callTool({name: "camera_stream_stop", arguments: {}});
    }
    const status = await client.callTool({ name: "blender_mcp_status", arguments: {} });
    assert.notEqual(status.isError, true);
    assert.equal(JSON.parse(status.content[0].text).configured, false);
  }
  const stdio = new Client({ name: "package-smoke", version: "1" });
  try {
    await stdio.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(installed, pkg.bin[pkg.name])], cwd: directory, env, stderr: "pipe" }));
    await check(stdio);
  } finally { await stdio.close(); }
  for (const entry of ["mcp-3d-printer-server-http", "mcp-3d-printer-server-sse"]) {
    const listener = net.createServer();
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    const port = listener.address().port;
    await new Promise((resolve) => listener.close(resolve));
    const child = spawn(process.execPath, [path.join(installed, pkg.bin[entry])], {
      cwd: directory, env: { ...env, MCP_TRANSPORT: "streamable-http", MCP_HTTP_HOST: "127.0.0.1", MCP_HTTP_PORT: String(port), MCP_HTTP_PATH: "/mcp" }, stdio: "ignore",
    });
    const exit = once(child, "exit");
    const client = new Client({ name: "package-http-smoke", version: "1" });
    try {
      const endpoint = new URL(`http://127.0.0.1:${port}/mcp`);
      let ready = false;
      for (let i = 0; i < 100; i++) {
        try { if ((await fetch(endpoint, { method: "PUT" })).status === 405) { ready = true; break; } } catch {}
        if (child.exitCode !== null) throw new Error(`${entry} exited before initialization`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(ready, `${entry} did not start`);
      await client.connect(new StreamableHTTPClientTransport(endpoint));
      await check(client);
    } finally {
      await client.close();
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
      await exit;
      clearTimeout(timer);
    }
  }
  console.log(`Installed ${pkg.name}@${pkg.version} from its npm tarball: all three entrypoints, MCP version, ${nativeSupported ? "native camera frames" : "snapshot fallback without native processing"}, and Blender discovery passed.`);
} finally {
  if (camera) { camera.closeAllConnections(); await new Promise(resolve => camera.close(resolve)); }
  await fs.rm(directory, { recursive: true, force: true });
}
