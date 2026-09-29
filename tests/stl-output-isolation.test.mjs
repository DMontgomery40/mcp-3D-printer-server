import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sample = path.join(root, "test/sample_cube.stl");

// Concurrent requests for same-named inputs must never share an output file:
// process_and_print_stl extends, slices, and prints whatever that path holds.
test("concurrent STL edits of same-named inputs write separate outputs", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "stl-isolation-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const client = new Client({ name: "stl-isolation", version: "1" });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [path.join(root, "dist/index.js")], cwd: temp,
    env: { ...process.env, MCP_TRANSPORT: "stdio", PRINTER_TYPE: "octoprint", PRINTER_HOST: "127.0.0.1", TEMP_DIR: temp },
    stderr: "pipe",
  }));
  t.after(() => client.close());
  const inputs = [];
  for (const folder of ["a", "b"]) {
    await fs.mkdir(path.join(temp, folder));
    inputs.push(path.join(temp, folder, "bracket.stl"));
    await fs.copyFile(sample, inputs.at(-1));
  }
  const text = (result) => result.content?.[0]?.text ?? "";
  const outputs = (await Promise.all(inputs.map((stl_path, index) =>
    client.callTool({ name: "extend_stl_base", arguments: { stl_path, extension_inches: index === 0 ? 0.1 : 0.4 } }))))
    .map((result) => { assert.notEqual(result.isError, true, text(result)); return text(result).match(/\/\S+_extended\.stl/)?.[0] ?? text(result); });
  assert.notEqual(outputs[0], outputs[1], "each request must get its own file");
  const heights = [];
  for (const output of outputs) {
    const info = JSON.parse(text(await client.callTool({ name: "get_stl_info", arguments: { stl_path: output } })));
    heights.push(info.boundingBox.dimensions);
  }
  // STL is Z-up: the base goes under the model, and X/Y stay the same.
  assert.ok(Math.abs(heights[0].z - (10 + 2.54)) < 0.01 && Math.abs(heights[1].z - (10 + 10.16)) < 0.01, `each output keeps its own base (${JSON.stringify(heights)})`);
  for (const size of heights) assert.deepEqual([size.x, size.y], [10, 10]);
});
