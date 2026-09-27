import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = fileURLToPath(new URL("../", import.meta.url));
async function server(t, env = {}) {
  const client = new Client({ name: "print-safety-test", version: "1" });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [path.join(root, "dist/index.js")],
    env: { ...process.env, MCP_TRANSPORT: "stdio", PRINTER_TYPE: "bambu", PRINTER_HOST: "127.0.0.1", BAMBU_MODEL: "", BAMBU_SERIAL: "", BAMBU_TOKEN: "", ...env }, stderr: "pipe",
  }));
  return client;
}

test("all raw Bambu print entrypoints require a valid model before upload or MQTT", async (t) => {
  const client = await server(t);
  const tools = (await client.listTools()).tools;
  for (const name of ["start_print", "upload_gcode"]) {
    assert.ok(tools.find((tool) => tool.name === name).inputSchema.properties.bambu_model);
    for (const model of [undefined, "unknown-machine"]) {
      const result = await client.callTool({ name, arguments: {
        filename: "safety-test.gcode", ...(name === "upload_gcode" ? { gcode: "G28", print: true } : {}),
        ...(model === undefined ? {} : { bambu_model: model }),
      } });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /model/i);
      assert.doesNotMatch(result.content[0].text.split("\nSuggestion:")[0], /credentials|connect|ECONNREFUSED/i);
    }
    const validModel = await client.callTool({ name, arguments: {
      filename: "safety-test.gcode", bambu_model: "p1s",
      ...(name === "upload_gcode" ? { gcode: "G28", print: true } : {}),
    } });
    assert.equal(validModel.isError, true);
    assert.match(validModel.content[0].text, /credentials/i);
  }
  const uploadOnly = await client.callTool({ name: "upload_gcode", arguments: { filename: "test.gcode", gcode: "G28", print: false } });
  assert.match(uploadOnly.content[0].text, /credentials/i);
});

test("inline upload filenames cannot overwrite or delete files outside the scratch directory", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "printer-upload-safety-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sentinel = path.join(directory, "keep.gcode");
  await fs.writeFile(sentinel, "user content");
  const temp = path.join(directory, "scratch");
  const client = await server(t, { TEMP_DIR: temp });
  const result = await client.callTool({ name: "upload_gcode", arguments: {
    filename: "../keep.gcode", gcode: "G28", print: false,
  } });
  assert.equal(result.isError, true); // Empty credentials prevent all hardware access.
  assert.equal(await fs.readFile(sentinel, "utf8"), "user content");
  assert.deepEqual(await fs.readdir(temp), []);
});

test("concurrent inline multipart uploads retain distinct requested filenames and bytes", async (t) => {
  const uploads = [];
  const http = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    uploads.push(Buffer.concat(chunks).toString());
    response.writeHead(201, { "Content-Type": "application/json" });
    response.end('{"done":true}');
  });
  t.after(() => new Promise((resolve) => http.close(resolve)));
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const client = await server(t);
  const names = ["one.gcode", "two.gcode"];
  const results = await Promise.all(names.map((filename, i) => client.callTool({ name: "upload_gcode", arguments: {
    type: "octoprint", host: "127.0.0.1", port: String(http.address().port),
    filename, gcode: `G28\n; unique-${i}`, print: false,
  } })));
  for (const result of results) assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(uploads.length, 2);
  for (const [i, filename] of names.entries()) {
    const upload = uploads.find((body) => body.includes(`filename="${filename}"`));
    assert.ok(upload, `file part must carry ${filename}`);
    assert.ok(upload.includes(`unique-${i}`));
  }
});
