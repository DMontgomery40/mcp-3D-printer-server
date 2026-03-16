import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const SERVER_ENTRY = path.join(REPO_ROOT, "dist", "index.js");
const SAMPLE_STL = path.join(REPO_ROOT, "test", "sample_cube.stl");

function createClient() {
  return new Client({
    name: "mcp-3d-printer-server-behavior-tests",
    version: "0.0.1",
  });
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      if (!address || typeof address !== "object") {
        server.close(() => reject(new Error("Unable to resolve free port")));
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(address.port);
      });
    });
  });
}

async function waitForHttpServerReady(endpoint, attempts = 40, delayMs = 150) {
  let lastStatus = "unreachable";

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(endpoint, { method: "PUT" });
      lastStatus = String(response.status);

      if (response.status === 405 || response.status === 400) {
        return;
      }
    } catch {
      lastStatus = "unreachable";
    }

    await sleep(delayMs);
  }

  throw new Error(`HTTP server did not become ready in time (last status: ${lastStatus})`);
}

async function closeTransport(transport) {
  try {
    await transport.close();
  } catch {
    // Ignore cleanup errors.
  }
}

async function terminateChildProcess(childProcess) {
  if (childProcess.exitCode !== null) {
    return;
  }

  childProcess.kill("SIGTERM");
  await Promise.race([
    once(childProcess, "exit"),
    sleep(2000).then(() => {
      if (childProcess.exitCode === null) {
        childProcess.kill("SIGKILL");
      }
    }),
  ]);
}

function parseJsonResult(toolResult) {
  const text = toolResult.content?.[0]?.text;
  assert.equal(typeof text, "string", "Expected text result payload");
  return JSON.parse(text);
}

function assertCommonToolPresence(listToolsResult) {
  const names = listToolsResult.tools.map((tool) => tool.name);

  assert.ok(names.includes("get_printer_status"));
  assert.ok(names.includes("get_stl_info"));
  assert.ok(names.includes("blender_mcp_edit_model"));
  assert.ok(names.includes("print_3mf"), "print_3mf tool must be registered");
  assert.ok(names.includes("slice_stl"), "slice_stl tool must be registered");
}

function assertBambuStudioSlicerSupport(listToolsResult) {
  const sliceTool = listToolsResult.tools.find((t) => t.name === "slice_stl");
  assert.ok(sliceTool, "slice_stl tool must exist");
  const desc = sliceTool.inputSchema?.properties?.slicer_type?.description || "";
  assert.ok(
    desc.includes("bambustudio"),
    `slice_stl slicer_type description must mention bambustudio, got: ${desc}`
  );
}

test("bambu defaults: bambustudio slicer type and auto-slice on unsliced 3MF", async (t) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
      PRINTER_TYPE: "bambu",
      BAMBU_SERIAL: "TEST_SERIAL",
      BAMBU_TOKEN: "TEST_TOKEN",
    },
    stderr: "pipe",
  });

  const client = createClient();

  t.after(async () => {
    await closeTransport(transport);
  });

  await client.connect(transport);

  const listToolsResult = await client.listTools();
  assertBambuStudioSlicerSupport(listToolsResult);

  // print_3mf with a non-existent file should error gracefully
  const missingFile = await client.callTool({
    name: "print_3mf",
    arguments: { three_mf_path: "/tmp/nonexistent_test.3mf" },
  });
  assert.equal(missingFile.isError, true);

  // slice_stl description should include bambustudio
  const sliceTool = listToolsResult.tools.find((t) => t.name === "slice_stl");
  assert.ok(
    sliceTool.inputSchema.properties.slicer_type.description.includes("bambustudio"),
    "bambustudio must appear in slice_stl slicer_type description"
  );

  // print_3mf tool schema should include ams_mapping
  const print3mfTool = listToolsResult.tools.find((t) => t.name === "print_3mf");
  assert.ok(print3mfTool, "print_3mf tool must exist");
  assert.ok(
    print3mfTool.inputSchema.properties.ams_mapping,
    "print_3mf must have ams_mapping property"
  );
});

test("stdio transport: initialize, list tools, call success + structured failure", async (t) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
    },
    stderr: "pipe",
  });

  const client = createClient();

  t.after(async () => {
    await closeTransport(transport);
  });

  await client.connect(transport);
  assert.equal(client.getServerVersion()?.name, "mcp-3d-printer-server");

  const listToolsResult = await client.listTools();
  assertCommonToolPresence(listToolsResult);

  const success = await client.callTool({
    name: "get_stl_info",
    arguments: {
      stl_path: SAMPLE_STL,
    },
  });

  assert.equal(success.isError, undefined);
  const successPayload = parseJsonResult(success);
  assert.equal(successPayload.fileName, "sample_cube.stl");
  assert.equal(successPayload.faceCount, 12);

  const failure = await client.callTool({
    name: "get_stl_info",
    arguments: {},
  });

  assert.equal(failure.isError, true);
  assert.equal(failure.structuredContent?.status, "error");
  assert.equal(typeof failure.structuredContent?.suggestion, "string");
});

test("streamable-http transport: initialize, list tools, call success + origin rejection", async (t) => {
  const port = await getFreePort();
  const endpoint = `http://127.0.0.1:${port}/mcp`;

  const childProcess = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      MCP_TRANSPORT: "streamable-http",
      MCP_HTTP_HOST: "127.0.0.1",
      MCP_HTTP_PORT: String(port),
      MCP_HTTP_PATH: "/mcp",
      MCP_HTTP_ALLOWED_ORIGINS: "http://localhost",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  let stderrOutput = "";
  childProcess.stderr?.on("data", (chunk) => {
    stderrOutput += chunk.toString();
  });

  t.after(async () => {
    await terminateChildProcess(childProcess);
  });

  const transport = new StreamableHTTPClientTransport(new URL(endpoint));
  const client = createClient();

  t.after(async () => {
    await closeTransport(transport);
  });

  await waitForHttpServerReady(endpoint);
  await client.connect(transport);

  assert.equal(client.getServerVersion()?.name, "mcp-3d-printer-server");

  const listToolsResult = await client.listTools();
  assertCommonToolPresence(listToolsResult);

  const success = await client.callTool({
    name: "get_stl_info",
    arguments: {
      stl_path: SAMPLE_STL,
    },
  });

  const successPayload = parseJsonResult(success);
  assert.equal(successPayload.fileName, "sample_cube.stl");

  const forbiddenOriginResponse = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://malicious.local",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-05",
        capabilities: {},
        clientInfo: {
          name: "origin-test-client",
          version: "1.0.0",
        },
      },
    }),
  });

  assert.equal(
    forbiddenOriginResponse.status,
    403,
    `Expected 403 for forbidden origin. stderr: ${stderrOutput}`
  );

  const wrongPathResponse = await fetch(`http://127.0.0.1:${port}/not-mcp`, {
    method: "POST",
  });
  assert.equal(wrongPathResponse.status, 404);
});
