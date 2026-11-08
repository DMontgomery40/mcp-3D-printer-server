import {trackedMkdtemp} from './support/temp.mjs';
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
  const temp = await trackedMkdtemp(path.join(os.tmpdir(), "tool-annotations-"));
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
  for (const name of ["inspect_print_file", "list_3mf_plates", "confirm_temperatures", "get_stl_info", "list_templates"]) {
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
  is("get_slice_settings", { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
  is("fusion_mcp_status", { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true });
  // Local STL edits and slices write a new file each call.
  for (const name of ["scale_stl", "lay_flat", "slice_stl", "generate_stl_visualization"]) {
    is(name, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
  }
});

// Counterpart's remote endpoint (/v1/mcp) offers tools to paired devices by what this server declares in
// _meta["counterpart/remote"]: the least scope for each tool, and which arguments its configuration chooses.
test('every listed tool declares its remote scope, and the arguments its configuration chooses', async t => {
  const { REMOTE_SCOPES, CONFIG_ARGUMENTS } = await import('../dist/counterpart/remote.js');
  const tools = await listedTools(t);
  const SCOPES = ['read', 'design', 'control', 'print', 'raw'];
  const KINDS = ['config', 'config-top', 'path', 'output'];
  const byName = {};
  for (const tool of tools) {
    const declared = tool._meta?.['counterpart/remote'];
    assert.ok(declared, `${tool.name} has no remote declaration`);
    assert.ok(SCOPES.includes(declared.scope), `${tool.name} scope ${declared.scope}`);
    const properties = new Set();
    const visit = schema => { for (const [key, child] of Object.entries(schema?.properties ?? {})) { properties.add(key); visit(child); } if (schema?.items) visit(schema.items); };
    visit(tool.inputSchema);
    for (const [key, kind] of Object.entries(declared.arguments ?? {})) {
      assert.ok(KINDS.includes(kind), `${tool.name}.${key}: ${kind}`);
      // Configuration names may be declared for an open object the tool forwards; anything else is one of its arguments.
      assert.ok(properties.has(key) || (kind === 'config' && CONFIG_ARGUMENTS.has(key)), `${tool.name} declares ${key}, which it does not take`);
    }
    // Every configuration name the tool takes is declared, at any depth.
    for (const key of properties) if (CONFIG_ARGUMENTS.has(key) && !(key === 'route' && tool.name === 'counterpart_print_route'))
      assert.equal(declared.arguments?.[key], 'config', `${tool.name}.${key}`);
    for (const [key, scope] of Object.entries(declared.raisedBy ?? {})) {
      assert.ok(properties.has(key), `${tool.name} is raised by ${key}, which it does not take`);
      assert.ok(SCOPES.indexOf(scope) > SCOPES.indexOf(declared.scope), `${tool.name}.${key} raises its scope`);
    }
    // Name floors: whatever the table says, these kinds of tool are never offered below them.
    const at = scope => assert.ok(SCOPES.indexOf(declared.scope) >= SCOPES.indexOf(scope), `${tool.name} is ${declared.scope}, below ${scope}`);
    if (/_call$|_rpc$|gcode|native_control|^blender_mcp_edit_model$/.test(tool.name)) at('raw');
    else if (/^(?:upload_|start_|print_|delete_|process_and_print)/.test(tool.name)) at('print');
    else if (/^(?:set_|clear_|pause_|resume_|cancel_|skip_|reread_)/.test(tool.name)) at('control');
    // A tool that writes anything is never read.
    if (!tool.annotations.readOnlyHint && declared.scope === 'read')
      assert.ok(['camera_snapshot', 'blender_mcp_status', 'fusion_mcp_status', 'blender_mcp_setup', 'fusion_mcp_setup'].includes(tool.name), `${tool.name} changes something but is read`);
    byName[tool.name] = declared;
  }
  assert.deepEqual(Object.keys(REMOTE_SCOPES).sort(), tools.map(tool => tool.name).sort(), 'the scope table names exactly the listed tools');
  for (const tool of tools) for (const key of ["host", "port", "api_key", "bambu_serial", "bambu_token"])
    if (tool.inputSchema?.properties?.[key]) assert.equal(byName[tool.name].arguments?.[key], 'config', `${tool.name}.${key}`);
  for (const name of ['print_3mf', 'start_print']) assert.equal(byName[name].scope, 'print', name);
  for (const name of ['pause_print', 'resume_print', 'cancel_print']) assert.equal(byName[name].scope, 'control', name);
  for (const name of ['blender_mcp_call', 'fusion_mcp_call', 'save_template']) assert.equal(byName[name].scope, 'raw', name);
  // Another server's tool arguments may carry anything: configuration names inside them are declared too.
  assert.equal(byName.blender_mcp_call.arguments.password, 'config');
  assert.deepEqual(byName.fusion_mcp_status.raisedBy, { launch: 'design' });
  assert.deepEqual(byName.blender_mcp_status.raisedBy, { connect: 'design' });
  // Setup checks are reads; changing the person's Blender or Fusion is the highest scope.
  assert.deepEqual(byName.blender_mcp_setup.raisedBy, { update: 'raw' });
  assert.deepEqual(byName.fusion_mcp_setup.raisedBy, { install: 'raw' });
  assert.equal(byName.slice_stl.arguments.stl_path, 'path');
  assert.equal(byName.camera_snapshot.arguments.save_path, 'output');
  assert.equal(byName.counterpart_print_route.arguments?.route, undefined, 'the route tool takes route from the caller');
  // The printer type is chosen by the configuration as a top-level argument only.
  assert.equal(byName.get_printer_status.arguments.type, 'config-top');
});
