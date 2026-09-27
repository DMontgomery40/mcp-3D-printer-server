import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = fileURLToPath(new URL("../", import.meta.url));

test("independent server instances cannot overwrite each other's default model output", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "bambu-server-test-"));
  const inputPath = path.join(cwd, `${path.basename(cwd)}.stl`);
  await fs.copyFile(path.join(root, "test/sample_cube.stl"), inputPath);
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const clients = [];
  const outputs = [];
  t.after(async () => {
    for (const client of clients) await client.close();
    for (const output of outputs) {
      await fs.rm(output, { force: true });
      await fs.rmdir(path.dirname(output)).catch(() => {});
    }
  });
  for (let i = 0; i < 2; i++) {
    const client = new Client({ name: "temp-isolation-test", version: "1" });
    clients.push(client);
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: [path.join(root, "dist/index.js")], cwd,
      env: { ...process.env, MCP_TRANSPORT: "stdio", TEMP_DIR: "" }, stderr: "pipe",
    }));
  }
  const args = { stl_path: inputPath, scale_x: 1 };
  const first = await clients[0].callTool({ name: "scale_stl", arguments: args });
  assert.notEqual(first.isError, true, JSON.stringify(first));
  outputs.push(first.content[0].text);
  const before = await fs.readFile(outputs[0]);
  const second = await clients[1].callTool({ name: "scale_stl", arguments: { ...args, scale_x: 2 } });
  assert.notEqual(second.isError, true, JSON.stringify(second));
  outputs.push(second.content[0].text);
  assert.notEqual(path.dirname(outputs[0]), path.dirname(outputs[1]));
  assert.deepEqual(await fs.readFile(outputs[0]), before);
  assert.notDeepEqual(await fs.readFile(outputs[1]), before);
});
