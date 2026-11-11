import { createServer } from "node:http";
import { once } from "node:events";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

async function printerFixture(t) {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        api: "0.1",
        state: { flags: {} },
        webcam: {},
        profiles: {},
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return {
    PRINTER_TYPE: "octoprint",
    PRINTER_HOST: "127.0.0.1",
    PRINTER_PORT: String(server.address().port),
  };
}

test("stdio exposes confined CAD contracts, MCP-owned prompt, scopes and counterpart capability without printer contact", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cad-protocol-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: dir,
    env: {
      HOME: dir,
      PATH: process.env.PATH,
      MCP_TRANSPORT: "stdio",
      ...(await printerFixture(t)),
      BAMBU_MODEL: "",
      TEMP_DIR: dir,
      CAD_DATA_DIR: join(dir, "data"),
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {});
  const c = new Client({ name: "cad-contract-test", version: "1" });
  t.after(() => c.close());
  await c.connect(transport);
  const { tools } = await c.listTools();
  for (const name of ["cad_status", "cad_setup", "cad_run", "cad_check_fit"]) {
    const tool = tools.find((t) => t.name === name);
    assert.ok(tool, name);
    assert.equal(tool.outputSchema.type, "object");
    assert.ok(tool.annotations);
    assert.ok(tool._meta["counterpart/remote"]);
  }
  assert.equal(
    tools.find((t) => t.name === "cad_run")._meta["counterpart/remote"].scope,
    "design",
  );
  assert.equal(
    tools.find((t) => t.name === "cad_check_fit")._meta["counterpart/remote"]
      .arguments.reference,
    "path",
  );
  assert.equal(
    tools.find((t) => t.name === "cad_run")._meta["counterpart/remote"]
      .arguments.path,
    "path",
  );
  const status = (await c.callTool({ name: "cad_status", arguments: {} }))
    .structuredContent;
  assert.equal(status.ready, false);
  const setup = (await c.callTool({ name: "cad_setup", arguments: {} }))
    .structuredContent;
  assert.equal(setup.ready, false);
  const info = (
    await c.callTool({ name: "counterpart_printer_info", arguments: {} })
  ).structuredContent;
  assert.equal(info.capabilities.cad.contract, "cad/1");
  assert.equal(info.capabilities.cad.run, "cad_run");
  const prompt = await c.getPrompt({ name: "cad_design" });
  assert.match(prompt.messages[0].content.text, /P =/);
  assert.match(prompt.messages[0].content.text, /build\(\)/);
  assert.match(prompt.messages[0].content.text, /six/);
  assert.match(prompt.messages[0].content.text, /never scale a screw to clear its hole/);
  assert.match(prompt.messages[0].content.text, /a valid flag alone shows none of them/);
});

test("CAD_ENABLED=0 leaves out every CAD tool, prompt and capability", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cad-disabled-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tr = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: dir,
    env: {
      HOME: dir,
      PATH: process.env.PATH,
      MCP_TRANSPORT: "stdio",
      ...(await printerFixture(t)),
      BAMBU_MODEL: "",
      TEMP_DIR: dir,
      CAD_ENABLED: "0",
    },
    stderr: "pipe",
  });
  tr.stderr?.on("data", () => {});
  const c = new Client({ name: "cad-disabled-test", version: "1" });
  t.after(() => c.close());
  await c.connect(tr);
  assert.equal(
    (await c.listTools()).tools.some((x) => x.name.startsWith("cad_")),
    false,
  );
  assert.equal(
    (await c.listPrompts()).prompts.some((x) => x.name === "cad_design"),
    false,
  );
  const info = (
    await c.callTool({ name: "counterpart_printer_info", arguments: {} })
  ).structuredContent;
  assert.equal(info.capabilities.cad, undefined);
  assert.equal(
    (await c.callTool({ name: "cad_status", arguments: {} })).isError,
    true,
  );
});

test("CAD structured refusals pass the advertised output schema without wording matching", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cad-codes-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const data = join(dir, "data");
  const tr = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: dir,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: dir,
      MCP_TRANSPORT: "stdio",
      BAMBU_MODEL: "",
      PRINTER_TYPE: "octoprint",
      PRINTER_HOST: "127.0.0.1",
      PRINTER_PORT: "1",
      TEMP_DIR: dir,
      CAD_DATA_DIR: data,
    },
    stderr: "pipe",
  });
  tr.stderr?.on("data", () => {});
  const c = new Client({ name: "cad-codes", version: "1" });
  t.after(() => c.close());
  await c.connect(tr);
  await c.listTools();
  const result = await c.callTool({
    name: "cad_setup",
    arguments: { install: true },
  });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.code, "cad-uv-missing");
  assert.equal(result.structuredContent.status, "error");
  assert.ok(result.structuredContent.message);
  assert.ok(result.structuredContent.storage.expected_download_bytes > 0);
  const { writeFile, readdir } = await import("node:fs/promises");
  await writeFile(
    join(data, "operation.lock"),
    JSON.stringify({ pid: process.pid, operation: "setup" }),
  );
  const busy = await c.callTool({
    name: "cad_setup",
    arguments: { install: true },
  });
  assert.equal(busy.structuredContent.code, "cad-setup-busy");
  const expired = await c.callTool({
    name: "cad_run",
    arguments: {
      script: "P={}\ndef build():return None",
      output_dir: dir,
      name: "queued",
      timeout_ms: 100,
    },
  });
  assert.equal(expired.isError, true);
  assert.equal(expired.structuredContent.code, "cad-queue-timeout");
  assert.deepEqual(await readdir(join(data, "queue")), []);
});
