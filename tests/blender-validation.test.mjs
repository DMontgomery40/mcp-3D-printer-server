import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { BlenderMcpBridge } from "../dist/blender-mcp-bridge.js";

async function setup(t, { delay = 0, abortAfterRead } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "blender-validation-"));
  const input = path.join(directory, "input.stl");
  const mesh = Buffer.alloc(84 + 50 * 8192);
  mesh.writeUInt32LE(8192, 80);
  await fs.writeFile(input, mesh);
  const originalCommand = process.env.BLENDER_MCP_COMMAND;
  process.env.BLENDER_MCP_COMMAND = process.execPath;
  t.after(async () => {
    if (originalCommand === undefined) delete process.env.BLENDER_MCP_COMMAND;
    else process.env.BLENDER_MCP_COMMAND = originalCommand;
    await fs.rm(directory, { recursive: true, force: true });
  });
  const open = fs.open.bind(fs);
  const handles = [];
  let reads = 0;
  t.mock.method(fs, "open", async (...args) => {
    const handle = await open(...args);
    handles.push(handle);
    const read = handle.read.bind(handle);
    t.mock.method(handle, "read", async (...args) => {
      reads++;
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      const result = await read(...args);
      abortAfterRead?.();
      return result;
    });
    return handle;
  });
  return {
    edit: (options, signal) => new BlenderMcpBridge().edit({ stl_path: input, operations: ["decimate:0.5"], ...options }, undefined, signal),
    reads: () => reads,
    closed: async () => { for (const handle of handles) await assert.rejects(handle.stat(), { code: "EBADF" }); },
  };
}

test("an already cancelled Blender edit performs no file reads", async (t) => {
  const peer = await setup(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(peer.edit({}, controller.signal), /cancelled/i);
  assert.equal(peer.reads(), 0);
});

test("Blender validation stops after cancellation during a read and closes the file", async (t) => {
  const controller = new AbortController();
  const peer = await setup(t, { abortAfterRead: () => controller.abort() });
  await assert.rejects(peer.edit({}, controller.signal), /cancelled/i);
  assert.equal(peer.reads(), 1);
  await peer.closed();
});

test("Blender validation stops at the total edit deadline and closes the file", async (t) => {
  const peer = await setup(t, { delay: 60 });
  await assert.rejects(peer.edit({ timeout_ms: 100 }), /timed out/i);
  assert.ok(peer.reads() <= 2, "the validator must not continue scanning after the deadline");
  await peer.closed();
});

test("Blender connection receives only the time remaining after validation", async (t) => {
  const peer = await setup(t, { delay: 20 });
  let connectionTimeout;
  t.mock.method(Client.prototype, "connect", async (_transport, options) => {
    connectionTimeout = options.timeout;
    throw new Error("stop before spawning a peer");
  });
  await assert.rejects(peer.edit({ execute: true, timeout_ms: 1000 }));
  assert.ok(connectionTimeout > 0 && connectionTimeout < 900, `remaining timeout was ${connectionTimeout}`);
  await peer.closed();
});
