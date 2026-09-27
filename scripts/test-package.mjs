import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "printer-package-test-"));
try {
  const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", directory], { cwd: root, encoding: "utf8" }))[0];
  for (const file of ["dist/index.js", "dist/http-server.js", "dist/sse-server.js", "dist/blender-mcp-bridge.js", "dist/3mf_parser.js"]) {
    assert.ok(packed.files.some((entry) => entry.path === file), `Package must contain ${file}`);
  }
  assert.equal(packed.files.some((entry) => /(^|\/)\.env($|\.)|fixtures\/ftps/.test(entry.path)), false);
  await fs.writeFile(path.join(directory, "package.json"), '{"private":true}');
  execFileSync("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", path.join(directory, packed.filename)], { cwd: directory, stdio: "pipe" });
  const installed = path.join(directory, "node_modules", "mcp-3d-printer-server");
  const pkg = JSON.parse(await fs.readFile(path.join(installed, "package.json"), "utf8"));
  for (const target of Object.values(pkg.bin)) await fs.access(path.join(installed, target));
  const env = { ...process.env, MCP_TRANSPORT: "stdio", PRINTER_TYPE: "octoprint", PRINTER_HOST: "127.0.0.1", BLENDER_MCP_COMMAND: "", BLENDER_MCP_BRIDGE_COMMAND: "", TEMP_DIR: path.join(directory, "scratch") };
  async function check(client) {
    assert.equal(client.getServerVersion().version, pkg.version);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    for (const name of ["get_printer_status", "print_3mf", "blender_mcp_status", "blender_mcp_call", "blender_mcp_edit_model"]) assert.ok(names.includes(name));
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
  console.log(`Installed ${pkg.name}@${pkg.version} from its npm tarball: all three entrypoints, MCP version, and Blender discovery passed.`);
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}
