#!/usr/bin/env node
// Opt-in end-to-end check against a real Blender and a real Blender MCP server.
//
// Launches a separate Blender with factory settings (never your open scene),
// loads the mcp-for-blender addon on a spare port, then drives this server's
// Blender tools over stdio exactly as an MCP client would:
//   blender_mcp_status -> blender_mcp_call(execute_blender_code) -> blender_mcp_export_stl
// and checks the exported STL's measured size. Blender quits when the check ends.
//
// Usage (build first):
//   BLENDER_EXECUTABLE=/Applications/Blender.app/Contents/MacOS/Blender \
//   BLENDER_ADDON_PATH=/path/to/mcp-for-blender/addon.py \
//   node scripts/blender-live-check.mjs
// Optional: BLENDER_PORT (default 9878), BLENDER_MCP_COMMAND (default uvx),
// BLENDER_MCP_ARGS (default ["mcp-for-blender"]).

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const blender = process.env.BLENDER_EXECUTABLE;
const addon = process.env.BLENDER_ADDON_PATH;
const port = Number(process.env.BLENDER_PORT ?? 9878);
if (!blender || !addon || !fs.existsSync(addon)) {
  console.error("Set BLENDER_EXECUTABLE to the Blender binary and BLENDER_ADDON_PATH to mcp-for-blender's addon.py.");
  process.exit(2);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mcp3d-blender-live-"));
fs.copyFileSync(addon, path.join(scratch, "mcp3d_live_addon.py"));
fs.writeFileSync(path.join(scratch, "startup.py"), `import sys, bpy
sys.path.insert(0, ${JSON.stringify(scratch)})
import mcp3d_live_addon as addon
addon.register()
bpy.context.scene.blendermcp_port = ${port}
`);

const listening = () => new Promise((resolve) => {
  const socket = net.connect(port, "127.0.0.1", () => { socket.end(); resolve(true); });
  socket.on("error", () => resolve(false));
});
if (await listening()) {
  console.error(`Port ${port} is already in use; choose another BLENDER_PORT so the check cannot touch an existing Blender.`);
  process.exit(2);
}

const child = spawn(blender, ["--factory-startup", "--python", path.join(scratch, "startup.py")], { stdio: "ignore" });
let cleaned = false;
const cleanup = () => {
  if (cleaned) return;
  cleaned = true;
  child.kill();
  fs.rmSync(scratch, { recursive: true, force: true });
};
process.on("exit", cleanup);

const summary = { blender: null, steps: [] };
const step = (name, value) => { summary.steps.push({ name, ...value }); };
try {
  const started = Date.now();
  while (!(await listening())) {
    if (Date.now() - started > 60_000) throw new Error("Blender addon did not start listening within 60 s");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "dist/index.js")],
    cwd: scratch,
    env: {
      ...process.env, MCP_TRANSPORT: "stdio", PRINTER_HOST: "127.0.0.1", PRINTER_TYPE: "octoprint", BLENDER_PORT: String(port),
      BLENDER_MCP_COMMAND: process.env.BLENDER_MCP_COMMAND ?? "uvx",
      BLENDER_MCP_ARGS: process.env.BLENDER_MCP_ARGS ?? JSON.stringify(["mcp-for-blender"]),
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "blender-live-check", version: "1" });
  await client.connect(transport);
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
    const text = result.content?.find((entry) => entry.type === "text")?.text ?? "";
    if (result.isError) throw new Error(`${name} failed: ${text.slice(0, 500)}`);
    return { result, text };
  };

  const status = JSON.parse((await call("blender_mcp_status", { connect: true, tool_names: ["execute_blender_code"] })).text);
  summary.blender = status.server;
  step("status", { tools: status.tools.length, has_execute_blender_code: status.tools.some((tool) => tool.name === "execute_blender_code") });

  const code = `import bpy, bmesh
bm = bmesh.new()
bmesh.ops.create_cube(bm, size=1.0)
mesh = bpy.data.meshes.new("LiveCheckBox")
bm.to_mesh(mesh); bm.free()
box = bpy.data.objects.new("LiveCheckBox", mesh)
bpy.context.collection.objects.link(box)
box.scale = (40.0, 20.0, 10.0)
box.location = (100.0, 50.0, 5.0)
print("created", box.name, bpy.app.version_string)`;
  const created = await call("blender_mcp_call", { tool_name: "execute_blender_code", arguments: { code, user_prompt: "live check" } });
  step("execute_blender_code", { output: created.text.trim().slice(0, 120) });

  const output = path.join(scratch, "live-check-box.stl");
  const exported = JSON.parse((await call("blender_mcp_export_stl", { object_names: ["LiveCheckBox"], output_path: output, user_prompt: "live check" })).text);
  const expected = [40, 20, 10];
  const sizeOk = exported.bounding_box.dimensions.every((value, axis) => Math.abs(value - expected[axis]) < 1e-3);
  step("blender_mcp_export_stl", { triangles: exported.triangles, dimensions: exported.bounding_box.dimensions, output_verified: exported.output_verified, size_ok: sizeOk });

  await client.close();
  summary.ok = sizeOk && exported.output_verified === true && exported.triangles === 12;
} catch (error) {
  summary.ok = false;
  summary.error = error instanceof Error ? error.message : String(error);
}
console.log(JSON.stringify(summary, null, 2));
// The Blender child keeps the event loop alive; quit it explicitly.
cleanup();
process.exit(summary.ok ? 0 : 1);
