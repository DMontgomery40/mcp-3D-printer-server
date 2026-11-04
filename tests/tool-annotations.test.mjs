// Every tool this server lists carries all four MCP tool annotations, from one table.
// Discovery over stdio only; no printer, Blender or Fusion is contacted.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { TOOL_ANNOTATIONS } from "../dist/tool-annotations.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];

async function listedTools(t, env) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "tool-annotations-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, "dist", "index.js")],
    cwd: temp, // outside the repo, so a developer .env cannot change the configuration
    env: { PATH: process.env.PATH, HOME: path.join(temp, "home"), MCP_TRANSPORT: "stdio", TEMP_DIR: temp, PRINTER_HOST: "127.0.0.1", ...env },
    stderr: "pipe",
  });
  const client = new Client({ name: "tool-annotations-test", version: "1" });
  await client.connect(transport);
  t.after(() => client.close());
  return (await client.listTools()).tools;
}

for (const type of ["bambu", "octoprint"]) {
  test(`every tool listed for PRINTER_TYPE=${type} has all four annotations, and the table has no stale entries`, async (t) => {
    const tools = await listedTools(t, { PRINTER_TYPE: type, BAMBU_MODEL: "" });
    assert.ok(tools.length >= 40, `expected the full tool list, got ${tools.length}`);
    for (const tool of tools) {
      assert.ok(tool.annotations, `${tool.name} has no annotations`);
      for (const hint of HINTS) assert.equal(typeof tool.annotations[hint], "boolean", `${tool.name}.${hint}`);
      // A read-only tool is never destructive.
      if (tool.annotations.readOnlyHint) assert.equal(tool.annotations.destructiveHint, false, tool.name);
    }
    const listed = new Set(tools.map(tool => tool.name));
    assert.deepEqual(Object.keys(TOOL_ANNOTATIONS).filter(name => !listed.has(name)), [], "annotations for tools that are not listed");
  });
}

test("annotations follow what each tool does", () => {
  const is = (name, expected) => assert.deepEqual(
    Object.fromEntries(Object.entries(expected).map(([hint]) => [hint, TOOL_ANNOTATIONS[name][hint]])), expected, name);
  for (const name of ["get_printer_status", "counterpart_print_progress", "get_printer_filaments", "check_fulu_orca_setup", "blender_mcp_status"]) {
    is(name, { readOnlyHint: true, openWorldHint: true });
  }
  for (const name of ["inspect_print_file", "confirm_temperatures", "get_stl_info", "list_templates"]) {
    is(name, { readOnlyHint: true, openWorldHint: false });
  }
  // Ending a job, replacing a file or setting, and arbitrary remote calls are destructive.
  for (const name of ["cancel_print", "upload_gcode", "camera_snapshot", "save_template", "counterpart_print_route", "fulu_bambu_network_rpc", "blender_mcp_call", "fusion_mcp_call"]) {
    is(name, { readOnlyHint: false, destructiveHint: true });
  }
  // Starting a print and heating are additive (no confirmation prompt by maintainer decision); pause and resume too.
  for (const name of ["print_3mf", "start_print", "process_and_print_stl", "set_printer_temperature", "pause_print", "resume_print"]) {
    is(name, { readOnlyHint: false, destructiveHint: false, openWorldHint: true });
  }
  // An optional argument that writes a file or opens an application makes the tool not read-only.
  is("get_slice_settings", { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  is("fusion_mcp_status", { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true });
  // Local STL edits and slices write a new file each call.
  for (const name of ["scale_stl", "lay_flat", "slice_stl", "generate_stl_visualization"]) {
    is(name, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
  }
});
