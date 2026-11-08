import {spawn} from 'node:child_process';
import {once} from 'node:events';
import net from 'node:net';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {trackedMkdtemp} from './support/temp.mjs';
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
  const cwd = await trackedMkdtemp(path.join(os.tmpdir(), "bambu-server-test-"));
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

async function startServer(t, cwd, transportKind, tempDirectory) {
  const env = {
    ...process.env, MCP_TRANSPORT: transportKind, TEMP_DIR: tempDirectory,
    BAMBU_MODEL: "", BAMBU_PRINTER_MODEL: "", BAMBU_SERIAL: "TEST", BAMBU_TOKEN: "TEST",
  };
  const client = new Client({ name: "temp-cleanup-test", version: "1" });
  t.after(() => client.close());
  if (transportKind === "stdio") {
    const transport = new StdioClientTransport({
      command: process.execPath, args: [path.join(root, "dist/index.js")], cwd, env, stderr: "pipe",
    });
    await client.connect(transport);
    return {
      client,
      stop: async (signal) => {
        if (signal === "EOF") return client.close();
        const closed = new Promise((resolve) => { client.onclose = resolve; });
        process.kill(transport.pid, signal);
        await closed;
      },
    };
  }
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const child = spawn(process.execPath, [path.join(root, "dist/index.js")], {
    cwd, env: { ...env, MCP_HTTP_HOST: "127.0.0.1", MCP_HTTP_PORT: String(port), MCP_HTTP_PATH: "/mcp" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const closed = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await closed;
  });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => reject(new Error("HTTP server exited before listening")));
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.includes("MCP server running on http://")) resolve();
    });
  });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  return { client, stop: async (signal) => { child.kill(signal); await closed; } };
}

for (const [transportKind, signal] of [
  ["stdio", "EOF"], ["stdio", "SIGTERM"], ["stdio", "SIGINT"],
  ["streamable-http", "SIGTERM"], ["streamable-http", "SIGINT"],
]) {
  test(`${transportKind} ${signal} cleans only the automatically created temporary root`, {
    timeout: 15_000,
    skip: process.platform === "win32" && signal !== "EOF" ? "Windows process.kill does not deliver graceful POSIX signals" : false,
  }, async (t) => {
    const cwd = await trackedMkdtemp(path.join(os.tmpdir(), "bambu-server-shutdown-"));
    t.after(() => fs.rm(cwd, { recursive: true, force: true }));
    const inputPath = path.join(cwd, "input.stl");
    await fs.copyFile(path.join(root, "test/sample_cube.stl"), inputPath);
    for (const explicit of [false, true]) {
      const tempDirectory = explicit ? path.join(cwd, "user-owned-output") : "";
      if (explicit) {
        await fs.mkdir(tempDirectory);
        await fs.writeFile(path.join(tempDirectory, "keep.txt"), "user-owned content");
      }
      const server = await startServer(t, cwd, transportKind, tempDirectory);
      const result = await server.client.callTool({ name: "scale_stl", arguments: { stl_path: inputPath, scale_x: 2 } });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      const output = result.content[0].text;
      const temporaryRoot = path.dirname(output);
      const contents = await fs.readFile(output);
      t.after(() => explicit ? undefined : fs.rm(temporaryRoot, { recursive: true, force: true }));
      await server.stop(signal);
      if (explicit) {
        assert.deepEqual(await fs.readFile(output), contents);
        assert.equal(await fs.readFile(path.join(tempDirectory, "keep.txt"), "utf8"), "user-owned content");
      } else {
        await assert.rejects(fs.stat(temporaryRoot), { code: "ENOENT" }, "server shutdown must remove its private model output root");
      }
    }
  });
}
