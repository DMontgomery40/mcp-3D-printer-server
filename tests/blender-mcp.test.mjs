import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(root, "tests/fixtures/blender-mcp-server.mjs");
const sample = path.join(root, "test/sample_cube.stl");
const data = (result) => result.structuredContent ?? JSON.parse(result.content[0].text);
const errorText = (result) => result.content?.filter((item) => item.type === "text").map((item) => item.text).join("\n") ?? "";

async function start(t, mode = "normal", overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bambu-blender-test-"));
  const logPath = path.join(directory, "peer.jsonl");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "dist/index.js")],
    cwd: directory,
    env: {
      ...process.env, MCP_TRANSPORT: "stdio", BAMBU_MODEL: "", BAMBU_TOKEN: "printer-secret-do-not-forward",
      BLENDER_MCP_COMMAND: process.execPath,
      BLENDER_MCP_ARGS: JSON.stringify([fixture, mode, logPath]),
      BLENDER_MCP_BRIDGE_COMMAND: "", BLENDER_MCP_TIMEOUT_MS: "5000",
      MCP_ALLOW_EXECUTABLE_ARG: "", MCP_ALLOW_BRIDGE_COMMAND_ARG: "",
      ...overrides,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "blender-bridge-tests", version: "1" });
  t.after(async () => { await client.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await client.connect(transport);
  return {
    directory,
    events: () => fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [],
    call: (name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 15000 }),
  };
}

test("Blender status performs MCP initialization and paginated discovery, then closes the child", async (t) => {
  const peer = await start(t);
  const result = await peer.call("blender_mcp_status", { connect: true });
  assert.equal(result.isError, undefined, errorText(result));
  const status = data(result);
  assert.equal(status.connected, true);
  assert.equal(status.server.name, "mock-blender");
  assert.deepEqual(status.tools.map((tool) => tool.name), ["get_scene_info", "execute_blender_code"]);
  const events = peer.events();
  assert.deepEqual(events.filter((event) => event.method).map((event) => event.method), ["initialize", "notifications/initialized", "tools/list", "tools/list"]);
  assert.equal(events[0].printerTokenPresent, false);
  assert.equal(events.at(-1).event, "closed");
});

test("Blender call forwards the actual tool schema and preserves full MCP content and metadata", async (t) => {
  const peer = await start(t);
  const args = { code: "print('hello')", user_prompt: "Please inspect my model" };
  const result = await peer.call("blender_mcp_call", { tool_name: "execute_blender_code", arguments: args });
  assert.equal(result.isError, undefined, errorText(result));
  assert.equal(result.content[1].type, "image");
  assert.deepEqual(result.structuredContent, args);
  assert.deepEqual(result._meta, { source: "mock-blender" });
  assert.deepEqual(peer.events().find((event) => event.method === "tools/call").params.arguments, args);
});

test("Blender discovery validates required arguments before sending a mutation", async (t) => {
  const peer = await start(t);
  const result = await peer.call("blender_mcp_call", { tool_name: "execute_blender_code", arguments: { user_prompt: "inspect" } });
  assert.equal(result.isError, true);
  assert.match(errorText(result), /argument|schema/i);
  assert.equal(peer.events().some((event) => event.method === "tools/call"), false);
});

test("Blender tool failures preserve isError; protocol failures redact peer/config details", async (t) => {
  for (const mode of ["tool-error", "protocol-error", "list-error", "missing-tool"]) {
    await t.test(mode, async (t) => {
      const peer = await start(t, mode);
      const result = await peer.call("blender_mcp_call", { tool_name: "execute_blender_code", arguments: { code: "pass" } });
      assert.equal(result.isError, true);
      assert.doesNotMatch(errorText(result), /secret-should-not-leak|printer-secret-do-not-forward/);
      if (mode === "tool-error") assert.deepEqual(result._meta, { details: "kept" });
      assert.equal(peer.events().at(-1).event, "closed");
    });
  }
});

test("Blender request deadlines cover startup, discovery and calls without replaying mutations", async (t) => {
  for (const mode of ["startup-timeout", "list-timeout", "call-timeout"]) {
    await t.test(mode, async (t) => {
      const peer = await start(t, mode);
      const result = await peer.call("blender_mcp_call", { tool_name: "execute_blender_code", arguments: { code: "pass" }, timeout_ms: 1500 });
      assert.equal(result.isError, true);
      assert.match(errorText(result), /timed out|timeout/i);
      const calls = peer.events().filter((event) => event.method === "tools/call");
      assert.equal(calls.length, mode === "call-timeout" ? 1 : 0);
      assert.equal(peer.events().at(-1).event, "closed");
    });
  }
});

test("Legacy shell commands still receive the original JSON stdin and environment contract", async (t) => {
  const peer = await start(t, "normal", { BLENDER_MCP_COMMAND: "", MCP_ALLOW_BRIDGE_COMMAND_ARG: "1", CUSTOM_BRIDGE_SETTING: "legacy-setting" });
  const script = path.join(peer.directory, "read stdin.mjs");
  fs.writeFileSync(script, `let text = ''; process.stdin.on('data', chunk => text += chunk); process.stdin.on('end', () => process.stdout.write(JSON.stringify({...JSON.parse(text), setting: process.env.CUSTOM_BRIDGE_SETTING})));`);
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const result = await peer.call("blender_mcp_edit_model", {
    stl_path: sample, operations: ["custom-operation"], execute: true,
    bridge_command: `${quote(process.execPath)} ${quote(script)}`,
  });
  assert.equal(result.isError, undefined, errorText(result));
  assert.equal(data(result).bridge_result.modelPath, sample);
  assert.deepEqual(data(result).bridge_result.operations, ["custom-operation"]);
  assert.equal(data(result).bridge_result.source, "mcp-3d-printer-server");
  assert.equal(data(result).bridge_result.setting, "legacy-setting");
  assert.equal(data(result).output_verified, false);
});

test("Blender executable selection remains trusted server configuration", async (t) => {
  const peer = await start(t);
  for (const args of [{ command: "/bad" }, { bridge_command: "/bad" }, { connect: "false" }, { timeout_ms: 0 }]) {
    const result = await peer.call("blender_mcp_status", args);
    assert.equal(result.isError, true);
  }
  assert.deepEqual(peer.events(), []);
});

test("Blender rejects absent or invalid standard command configuration without spawning", async (t) => {
  for (const overrides of [{ BLENDER_MCP_COMMAND: "" }, { BLENDER_MCP_ARGS: "not-json" }, { BLENDER_MCP_ARGS: '[12]' }, { BLENDER_MCP_COMMAND: "/definitely/missing/executable" }]) {
    await t.test(JSON.stringify(overrides), async (t) => {
      const peer = await start(t, "normal", overrides);
      const result = await peer.call("blender_mcp_call", { tool_name: "get_scene_info", arguments: { user_prompt: "inspect" } });
      assert.equal(result.isError, true);
      assert.match(errorText(result), /BLENDER_MCP_COMMAND|BLENDER_MCP_ARGS|start|connect/i);
      assert.deepEqual(peer.events(), []);
    });
  }
});

test("Blender standard edit previews without launching and exports a verified new STL", async (t) => {
  const peer = await start(t);
  const output = path.join(peer.directory, 'edited model "quoted".stl');
  const request = { stl_path: sample, output_path: output, operations: ["decimate:0.5"], user_prompt: "Reduce this mesh", execute: false };
  const preview = await peer.call("blender_mcp_edit_model", request);
  assert.equal(preview.isError, undefined, errorText(preview));
  assert.equal(data(preview).status, "prepared");
  assert.deepEqual(peer.events(), []);
  const result = await peer.call("blender_mcp_edit_model", { ...request, execute: true });
  assert.equal(result.isError, undefined, errorText(result));
  assert.equal(data(result).status, "success");
  assert.equal(data(result).output_path, fs.realpathSync(output));
  assert.equal(data(result).triangles, 1);
  assert.equal(fs.statSync(output).size, 134);
  assert.deepEqual(fs.readdirSync(peer.directory).sort(), [path.basename(output), "peer.jsonl"].sort());
});

test("Blender standard edits reject text errors, missing receipts and invalid output instead of reporting success", async (t) => {
  for (const mode of ["text-error", "wrong-receipt", "no-output", "bad-output"]) {
    await t.test(mode, async (t) => {
      const peer = await start(t, mode);
      const output = path.join(peer.directory, "edited.stl");
      const result = await peer.call("blender_mcp_edit_model", { stl_path: sample, output_path: output, operations: ["decimate:0.5"], execute: true });
      assert.equal(result.isError, true);
      assert.equal(fs.existsSync(output), false);
    });
  }
});

test("Blender edits validate inputs and never overwrite an existing file", async (t) => {
  const peer = await start(t);
  const output = path.join(peer.directory, "existing.stl");
  fs.writeFileSync(output, "preserve me");
  for (const change of [{ execute: "false" }, { operations: [null] }, { operations: [] }, { operations: ["arbitrary:python"] }, { operations: ["decimate:2"] }, { operations: ["remesh"] }, { output_path: output }, { stl_path: "/missing.stl" }]) {
    const result = await peer.call("blender_mcp_edit_model", { stl_path: sample, output_path: path.join(peer.directory, "new.stl"), operations: ["decimate:0.5"], execute: true, ...change });
    assert.equal(result.isError, true, JSON.stringify(change));
  }
  assert.equal(fs.readFileSync(output, "utf8"), "preserve me");
  assert.deepEqual(peer.events(), []);
});

test("Blender execute=true with no standard or legacy configuration errors", async (t) => {
  const peer = await start(t, "normal", { BLENDER_MCP_COMMAND: "" });
  const result = await peer.call("blender_mcp_edit_model", { stl_path: sample, operations: ["remesh"], execute: true });
  assert.equal(result.isError, true);
  assert.match(errorText(result), /BLENDER_MCP_COMMAND|configured/i);
});

test("Blender call marks upstream textual addon failures as errors without losing the response", async (t) => {
  const peer = await start(t, "scene-text-error");
  const result = await peer.call("blender_mcp_call", { tool_name: "get_scene_info", arguments: { user_prompt: "Inspect Blender" } });
  assert.equal(result.isError, true);
  assert.match(errorText(result), /Could not connect to Blender/);
});

test("Blender publishes without replacing output created after preflight", async (t) => {
  const peer = await start(t, "output-race");
  const output = path.join(peer.directory, "raced.stl");
  const result = await peer.call("blender_mcp_edit_model", { stl_path: sample, output_path: output, operations: ["decimate:0.5"], execute: true });
  assert.equal(result.isError, true);
  assert.equal(fs.readFileSync(output, "utf8"), "created after preflight");
});

test("Legacy Blender bridge reports process completion honestly and rejects explicit error payloads", async (t) => {
  for (const stdout of ['', '{"status":"error","message":"secret-should-not-leak"}']) {
    await t.test(stdout ? "error payload" : "empty successful output", async (t) => {
      const peer = await start(t, "normal", { BLENDER_MCP_COMMAND: "", MCP_ALLOW_BRIDGE_COMMAND_ARG: "1" });
      const executable = path.join(peer.directory, "legacy bridge");
      fs.writeFileSync(executable, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(stdout)});\n`, { mode: 0o755 });
      const result = await peer.call("blender_mcp_edit_model", { stl_path: sample, operations: ["remesh"], bridge_command: executable, execute: true });
      if (stdout) {
        assert.equal(result.isError, true);
        assert.doesNotMatch(errorText(result), /secret-should-not-leak/);
      } else {
        assert.equal(result.isError, undefined, errorText(result));
        assert.equal(data(result).mode, "legacy");
        assert.equal(data(result).output_verified, false);
      }
    });
  }
});
