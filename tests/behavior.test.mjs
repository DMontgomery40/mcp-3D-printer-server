import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { PrusaImplementation } from "../dist/printers/prusa.js";

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

function createRecordingApiClient(responseData = { ok: true }) {
  const calls = [];
  return {
    calls,
    async get(url, config) {
      calls.push({ method: "get", url, config });
      return { data: responseData };
    },
    async post(url, data, config) {
      calls.push({ method: "post", url, data, config });
      return { data: responseData };
    },
  };
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

async function readCallToolHandlerNames() {
  const source = await fs.readFile(path.join(REPO_ROOT, "src", "index.ts"), "utf8");
  const switchStart = source.indexOf("switch (name) {");
  assert.notEqual(switchStart, -1, "CallTool switch must exist");
  const defaultStart = source.indexOf("default:", switchStart);
  assert.notEqual(defaultStart, -1, "CallTool switch must have a default case");

  return [...source.slice(switchStart, defaultStart).matchAll(/case "([^"]+)":/g)]
    .map((match) => match[1])
    .sort();
}

function assertCommonToolPresence(listToolsResult) {
  const names = listToolsResult.tools.map((tool) => tool.name);

  assert.ok(names.includes("get_printer_status"));
  assert.ok(names.includes("list_printer_files"), "list_printer_files tool must be registered");
  assert.ok(names.includes("upload_gcode"), "upload_gcode tool must be registered");
  assert.ok(names.includes("start_print"), "start_print tool must be registered");
  assert.ok(names.includes("cancel_print"), "cancel_print tool must be registered");
  assert.ok(names.includes("set_printer_temperature"), "set_printer_temperature tool must be registered");
  assert.ok(names.includes("get_stl_info"));
  assert.ok(names.includes("blender_mcp_edit_model"));
  assert.ok(names.includes("print_3mf"), "print_3mf tool must be registered");
  assert.ok(names.includes("slice_stl"), "slice_stl tool must be registered");
  assert.ok(names.includes("check_fulu_orca_setup"), "check_fulu_orca_setup tool must be registered");
  assert.ok(names.includes("fulu_bambu_network_rpc"), "fulu_bambu_network_rpc tool must be registered");
  assertPrinterControlSchemas(listToolsResult);
}

function assertBambuProjectSlicerSupport(listToolsResult) {
  const sliceTool = listToolsResult.tools.find((t) => t.name === "slice_stl");
  assert.ok(sliceTool, "slice_stl tool must exist");
  const desc = sliceTool.inputSchema?.properties?.slicer_type?.description || "";
  assert.ok(
    desc.includes("bambustudio"),
    `slice_stl slicer_type description must mention bambustudio, got: ${desc}`
  );
  assert.ok(
    desc.includes("orcaslicer-bambulab"),
    `slice_stl slicer_type description must mention orcaslicer-bambulab, got: ${desc}`
  );
  assert.ok(
    sliceTool.inputSchema?.properties?.slicer_type?.enum?.includes("fulu_orca"),
    "slice_stl slicer_type enum must include FULU alias"
  );
  assert.ok(
    sliceTool.inputSchema?.properties?.filament_profile,
    "slice_stl must expose filament_profile for OrcaSlicer"
  );
}

function assertPrinterControlSchemas(listToolsResult) {
  const uploadTool = listToolsResult.tools.find((t) => t.name === "upload_gcode");
  assert.ok(uploadTool, "upload_gcode tool must exist");
  assert.ok(
    uploadTool.inputSchema?.properties?.gcode_path,
    "upload_gcode must expose gcode_path for large local files"
  );
  assert.ok(
    uploadTool.inputSchema?.properties?.gcode,
    "upload_gcode must keep gcode content upload support"
  );

  const startTool = listToolsResult.tools.find((t) => t.name === "start_print");
  assert.deepEqual(startTool?.inputSchema?.required, ["filename"]);

  const setTemperatureTool = listToolsResult.tools.find((t) => t.name === "set_printer_temperature");
  assert.deepEqual(setTemperatureTool?.inputSchema?.required, ["component", "temperature"]);
}

async function createFakeBambuProjectSlicer(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fake-fulu-orca-"));
  const executableDir = path.join(dir, "FakeOrca.app", "Contents", "MacOS");
  const presetDir = path.join(dir, "FakeOrca.app", "Contents", "Resources", "profiles", "BBL", "machine");
  await fs.mkdir(executableDir, { recursive: true });
  await fs.mkdir(presetDir, { recursive: true });
  const executable = path.join(executableDir, "fake-fulu-orca.mjs");
  const presetPath = path.join(presetDir, "Bambu Lab P1S 0.4 nozzle.json");
  await fs.writeFile(presetPath, JSON.stringify({ name: "Bambu Lab P1S 0.4 nozzle" }));

  await fs.writeFile(
    executable,
    `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
function fail(message) {
  console.error(message);
  process.exit(11);
}
if (!args.includes("--slice")) fail("missing --slice");
const exportIndex = args.indexOf("--export-3mf");
if (exportIndex < 0 || !args[exportIndex + 1]) fail("missing --export-3mf output");
const loadSettingsIndex = args.indexOf("--load-settings");
if (loadSettingsIndex < 0 || !args[loadSettingsIndex + 1]?.includes("Bambu Lab P1S")) {
  fail("missing Bambu P1S machine preset");
}
if (!fs.existsSync(args[loadSettingsIndex + 1])) fail("machine preset path does not exist");
fs.writeFileSync(args[exportIndex + 1], "fake sliced 3mf");
`,
    { mode: 0o755 }
  );

  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  return executable;
}

async function createFakeOrcaSlicer(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fake-orcaslicer-"));
  const executable = path.join(dir, "fake-orcaslicer.mjs");

  await fs.writeFile(
    executable,
    `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
function fail(message) {
  console.error(message);
  process.exit(11);
}
if (args.includes("--output")) fail("OrcaSlicer does not support --output");
const sliceIndex = args.indexOf("--slice");
if (sliceIndex < 0 || args[sliceIndex + 1] !== "0") fail("missing --slice 0");
const outputDirIndex = args.indexOf("--outputdir");
if (outputDirIndex < 0 || !args[outputDirIndex + 1]) fail("missing --outputdir");
const hasProcessSettings = args.some((arg, index) => args[index - 1] === "--load-settings" && arg.endsWith("process.json"));
if (!hasProcessSettings) {
  fail("missing process settings");
}
const hasFilament = args.some((arg, index) => args[index - 1] === "--load-filaments" && arg.endsWith("nylon.json"));
if (!hasFilament) {
  fail("missing filament profile");
}
const inputPath = args[args.length - 1];
if (!fs.existsSync(inputPath)) fail("input STL missing");
fs.mkdirSync(args[outputDirIndex + 1], { recursive: true });
fs.writeFileSync(path.join(args[outputDirIndex + 1], "plate_1.gcode"), "; fake orca gcode\\n");
`,
    { mode: 0o755 }
  );

  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  return { dir, executable };
}

async function createFakeFuluBundle(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fake-fulu-bundle-"));
  const pluginDir = path.join(dir, "OrcaSlicer.app", "Contents", "MacOS");
  const runtimeDir = path.join(dir, "runtime");
  const slicerPath = path.join(pluginDir, "OrcaSlicer");
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.mkdir(runtimeDir, { recursive: true });

  const pluginFiles = [
    "install_runtime_macos.sh",
    "verify_runtime_macos.sh",
    "pjarczak_lima_instance.txt",
    "pjarczak-bambu-linux-host-wrapper",
    "libpjarczak_bambu_networking_bridge.dylib",
    "pjarczak_bambu_linux_host",
    "pjarczak_bambu_linux_host_abi1",
    "pjarczak_bambu_linux_host_abi0",
    "libbambu_networking.so",
    "libBambuSource.so",
    "ca-certificates.crt",
    "slicer_base64.cer",
  ];
  const runtimeFiles = [
    "pjarczak_bambu_linux_host",
    "pjarczak_bambu_linux_host_abi1",
    "pjarczak_bambu_linux_host_abi0",
    "libbambu_networking.so",
    "libBambuSource.so",
    "ca-certificates.crt",
    "slicer_base64.cer",
  ];

  for (const name of pluginFiles) {
    await fs.writeFile(path.join(pluginDir, name), `${name}\n`, { mode: 0o755 });
  }
  for (const name of runtimeFiles) {
    await fs.writeFile(path.join(runtimeDir, name), `${name}\n`, { mode: 0o755 });
  }
  await fs.writeFile(slicerPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  return { pluginDir, runtimeDir, slicerPath };
}

async function createFakeFuluBridge(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fake-fulu-bridge-"));
  const executable = path.join(dir, "fake-fulu-bridge.mjs");

  await fs.writeFile(
    executable,
    `#!/usr/bin/env node
const MAGIC = 0x52424a50;
const JSON_RESPONSE = 2;
function writeFrame(id, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.alloc(16);
  header.writeUInt32LE(MAGIC, 0);
  header.writeUInt32LE(JSON_RESPONSE, 4);
  header.writeUInt32LE(id, 8);
  header.writeUInt32LE(body.length, 12);
  process.stdout.write(Buffer.concat([header, body]));
}
const chunks = [];
process.stdin.on("data", chunk => chunks.push(chunk));
process.stdin.on("end", () => {
  const buffer = Buffer.concat(chunks);
  let offset = 0;
  while (offset + 16 <= buffer.length) {
    const magic = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    const id = buffer.readUInt32LE(offset + 8);
    const size = buffer.readUInt32LE(offset + 12);
    const payloadStart = offset + 16;
    const payloadEnd = payloadStart + size;
    if (magic !== MAGIC || type !== 1 || payloadEnd > buffer.length) process.exit(12);
    const request = JSON.parse(buffer.subarray(payloadStart, payloadEnd).toString("utf8"));
    let response = { ok: true, value: 0, method: request.method, payload: request.payload };
    if (request.method === "bridge.handshake") {
      response = { ok: true, protocol_version: 1, bridge_version: "fake-fulu-bridge", network_loaded: true, source_loaded: true };
    } else if (request.method === "bridge.capabilities") {
      response = { ok: true, agent_count: 1, auth_capabilities: ["fake"] };
    } else if (request.method === "bridge.runtime_info") {
      response = { ok: true, plugin_dir: "/fake/plugin", network_so: "/fake/libbambu_networking.so", source_so: "/fake/libBambuSource.so" };
    } else if (request.method === "bridge.ping") {
      response = { ok: true, value: "pong" };
    }
    writeFrame(id, response);
    offset = payloadEnd;
  }
});
`,
    { mode: 0o755 }
  );

  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  return `${process.execPath} ${executable}`;
}

test("bambu defaults: FULU Orca project slicer type and auto-slice on unsliced 3MF", async (t) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
      PRINTER_TYPE: "bambu",
      BAMBU_SERIAL: "TEST_SERIAL",
      BAMBU_TOKEN: "TEST_TOKEN",
      BAMBU_MODEL: "", // Explicitly empty to override dotenv
    },
    stderr: "pipe",
  });

  const client = createClient();

  t.after(async () => {
    await closeTransport(transport);
  });

  await client.connect(transport);

  const listToolsResult = await client.listTools();
  assertBambuProjectSlicerSupport(listToolsResult);

  // print_3mf without bambu_model should error about model, not crash
  const noModelResult = await client.callTool({
    name: "print_3mf",
    arguments: { three_mf_path: "/tmp/nonexistent_test.3mf" },
  });
  assert.equal(noModelResult.isError, true);
  const noModelError = noModelResult.content?.[0]?.text || "";
  assert.ok(
    noModelError.toLowerCase().includes("bambu_model") || noModelError.toLowerCase().includes("model"),
    `Error must mention model is required, got: ${noModelError}`
  );

  // print_3mf with invalid model should reject
  const badModelResult = await client.callTool({
    name: "print_3mf",
    arguments: { three_mf_path: "/tmp/nonexistent_test.3mf", bambu_model: "ender3" },
  });
  assert.equal(badModelResult.isError, true);
  const badModelError = badModelResult.content?.[0]?.text || "";
  assert.ok(
    badModelError.toLowerCase().includes("invalid") || badModelError.toLowerCase().includes("valid models"),
    `Error must reject invalid model, got: ${badModelError}`
  );

  // print_3mf with valid model should get past model validation (error about file instead)
  const validModelResult = await client.callTool({
    name: "print_3mf",
    arguments: { three_mf_path: "/tmp/nonexistent_test.3mf", bambu_model: "p1s" },
  });
  assert.equal(validModelResult.isError, true);
  const validModelError = validModelResult.content?.[0]?.text || "";
  assert.ok(
    !validModelError.toLowerCase().includes("bambu_model"),
    `With valid model, error should be about file not model, got: ${validModelError}`
  );

  // slice_stl description should include both Bambu project slicer paths
  const sliceTool = listToolsResult.tools.find((t) => t.name === "slice_stl");
  assert.ok(
    sliceTool.inputSchema.properties.slicer_type.description.includes("bambustudio"),
    "bambustudio must appear in slice_stl slicer_type description"
  );
  assert.ok(
    sliceTool.inputSchema.properties.slicer_type.description.includes("orcaslicer-bambulab"),
    "orcaslicer-bambulab must appear in slice_stl slicer_type description"
  );

  // print_3mf tool schema should include ams_mapping and bambu_model
  const print3mfTool = listToolsResult.tools.find((t) => t.name === "print_3mf");
  assert.ok(print3mfTool, "print_3mf tool must exist");
  assert.ok(
    print3mfTool.inputSchema.properties.ams_mapping,
    "print_3mf must have ams_mapping property"
  );
  assert.ok(
    print3mfTool.inputSchema.properties.bambu_model,
    "print_3mf must have bambu_model property"
  );
  assert.ok(
    print3mfTool.inputSchema.properties.slicer_type,
    "print_3mf must expose slicer_type for auto-slicing"
  );
  assert.ok(
    print3mfTool.inputSchema.required.includes("bambu_model"),
    "bambu_model must be required in print_3mf schema"
  );
  assert.deepEqual(
    print3mfTool.inputSchema.properties.bambu_model.enum,
    ["p1s", "p1p", "x1c", "x1e", "a1", "a1mini", "h2d"],
    "bambu_model enum must list all valid models"
  );
});

test("FULU Orca slicer aliases export Bambu project 3MF with model preset", async (t) => {
  const fakeSlicer = await createFakeBambuProjectSlicer(t);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
      PRINTER_TYPE: "bambu",
      BAMBU_SERIAL: "TEST_SERIAL",
      BAMBU_TOKEN: "TEST_TOKEN",
      BAMBU_MODEL: "",
    },
    stderr: "pipe",
  });

  const client = createClient();

  t.after(async () => {
    await closeTransport(transport);
  });

  await client.connect(transport);

  for (const slicerType of ["orcaslicer-bambulab", "fulu_orca"]) {
    const result = await client.callTool({
      name: "slice_stl",
      arguments: {
        stl_path: SAMPLE_STL,
        slicer_type: slicerType,
        slicer_path: fakeSlicer,
        bambu_model: "p1s",
      },
    });

    assert.equal(result.isError, undefined, `${slicerType} should slice successfully`);
    const outputPath = result.content?.[0]?.text || "";
    assert.ok(
      outputPath.endsWith("_sliced.3mf"),
      `${slicerType} should export a sliced 3MF, got: ${outputPath}`
    );
  }
});

test("OrcaSlicer slice_stl uses outputdir, filament profile, and plate output rename", async (t) => {
  const { dir, executable } = await createFakeOrcaSlicer(t);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "orca-slice-output-"));
  const machineProfile = path.join(dir, "machine.json");
  const processProfile = path.join(dir, "process.json");
  const filamentProfile = path.join(dir, "nylon.json");
  await fs.writeFile(machineProfile, "{}\n");
  await fs.writeFile(processProfile, "{}\n");
  await fs.writeFile(filamentProfile, "{}\n");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
      TEMP_DIR: tempDir,
    },
    stderr: "pipe",
  });

  const client = createClient();

  t.after(async () => {
    await closeTransport(transport);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  await client.connect(transport);

  for (const [label, profileArgs] of [
    [
      "explicit filament_profile",
      {
        slicer_profile: `${machineProfile};${processProfile}`,
        filament_profile: filamentProfile,
      },
    ],
    [
      "encoded filament profile",
      {
        slicer_profile: `${machineProfile};${processProfile}|${filamentProfile}`,
      },
    ],
  ]) {
    const result = await client.callTool({
      name: "slice_stl",
      arguments: {
        stl_path: SAMPLE_STL,
        slicer_type: "orcaslicer",
        slicer_path: executable,
        ...profileArgs,
      },
    });

    assert.equal(result.isError, undefined, `orcaslicer should slice successfully with ${label}`);
    const outputPath = result.content?.[0]?.text || "";
    assert.equal(path.dirname(outputPath), tempDir);
    assert.equal(path.basename(outputPath), "sample_cube.gcode");
    assert.equal(await fs.readFile(outputPath, "utf8"), "; fake orca gcode\n");
  }

  const tempEntries = await fs.readdir(tempDir);
  assert.ok(
    !tempEntries.some((entry) => entry.endsWith("-orca-output")),
    "temporary OrcaSlicer output directory should be cleaned up"
  );
});

test("tool registry advertises every implemented call handler", async (t) => {
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
  const listToolsResult = await client.listTools();
  const listedNames = listToolsResult.tools.map((tool) => tool.name).sort();
  const handlerNames = await readCallToolHandlerNames();

  assert.deepEqual(
    handlerNames.filter((name) => !listedNames.includes(name)),
    [],
    "Every CallTool handler must be registered in tools/list"
  );
  assert.deepEqual(
    listedNames.filter((name) => !handlerNames.includes(name)),
    [],
    "Every registered tool must have a CallTool handler"
  );
});

test("Prusa adapter normalizes Prusa Connect HTTPS URLs", async () => {
  for (const { host, port, expectedUrl } of [
    {
      host: "connect.prusa3d.com",
      port: "443",
      expectedUrl: "https://connect.prusa3d.com/api/v1/status",
    },
    {
      host: "https://connect.prusa3d.com",
      port: "443",
      expectedUrl: "https://connect.prusa3d.com/api/v1/status",
    },
    {
      host: "connect.prusa3d.com",
      port: "",
      expectedUrl: "https://connect.prusa3d.com/api/v1/status",
    },
    {
      host: "192.168.1.50",
      port: "8080",
      expectedUrl: "http://192.168.1.50:8080/api/v1/status",
    },
  ]) {
    const apiClient = createRecordingApiClient();
    const implementation = new PrusaImplementation(apiClient);

    await implementation.getStatus(host, port, "TEST_KEY");

    assert.equal(apiClient.calls[0].url, expectedUrl);
    assert.equal(apiClient.calls[0].config.headers["X-Api-Key"], "TEST_KEY");
    assert.equal(apiClient.calls[0].config.headers.Authorization, "Bearer TEST_KEY");
    assert.equal(apiClient.calls[0].config.headers.Accept, "application/json");
  }
});

test("FULU setup check validates macOS runtime payload and probes bridge", async (t) => {
  const bundle = await createFakeFuluBundle(t);
  const bridgeCommand = await createFakeFuluBridge(t);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
      BAMBU_MODEL: "",
    },
    stderr: "pipe",
  });

  const client = createClient();

  t.after(async () => {
    await closeTransport(transport);
  });

  await client.connect(transport);

  const result = await client.callTool({
    name: "check_fulu_orca_setup",
    arguments: {
      platform: "darwin",
      slicer_path: bundle.slicerPath,
      plugin_dir: bundle.pluginDir,
      runtime_dir: bundle.runtimeDir,
      bridge_command: bridgeCommand,
      run_bridge_probe: true,
    },
  });

  assert.equal(result.isError, undefined);
  const payload = parseJsonResult(result);
  assert.equal(payload.status, "ready");
  assert.equal(payload.platform, "darwin");
  assert.deepEqual(payload.missingRequiredFiles, []);
  assert.equal(payload.bridgeProbe.ok, true);
  assert.equal(payload.bridgeProbe.handshake.bridge_version, "fake-fulu-bridge");
  assert.ok(
    payload.commands.some((command) => command.command.includes("install_runtime_macos.sh")),
    "macOS setup check should return the concrete install command"
  );
  assert.ok(
    payload.commands.some((command) => command.command.includes("pjarczak-bambu-linux-host-wrapper")),
    "macOS setup check should return the concrete bridge command shape"
  );
  assert.equal(payload.mcpEnv.SLICER_TYPE, "orcaslicer-bambulab");
});

test("FULU bridge RPC allows read-only methods and gates mutating print methods", async (t) => {
  const bridgeCommand = await createFakeFuluBridge(t);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
      PRINTER_TYPE: "bambu",
      BAMBU_MODEL: "",
    },
    stderr: "pipe",
  });

  const client = createClient();

  t.after(async () => {
    await closeTransport(transport);
  });

  await client.connect(transport);

  const ping = await client.callTool({
    name: "fulu_bambu_network_rpc",
    arguments: {
      bridge_command: bridgeCommand,
      method: "bridge.ping",
    },
  });
  assert.equal(ping.isError, undefined);
  const pingPayload = parseJsonResult(ping);
  assert.equal(pingPayload.readOnly, true);
  assert.equal(pingPayload.response.value, "pong");

  const blockedMutation = await client.callTool({
    name: "fulu_bambu_network_rpc",
    arguments: {
      bridge_command: bridgeCommand,
      method: "net.send_message",
      payload: { dev_id: "printer", msg: "{}" },
    },
  });
  assert.equal(blockedMutation.isError, true);
  assert.match(blockedMutation.content?.[0]?.text || "", /allow_mutating_method=true/);

  const missingModel = await client.callTool({
    name: "fulu_bambu_network_rpc",
    arguments: {
      bridge_command: bridgeCommand,
      method: "net.start_print",
      allow_mutating_method: true,
      payload: { params: { dev_id: "printer" } },
    },
  });
  assert.equal(missingModel.isError, true);
  assert.match(missingModel.content?.[0]?.text || "", /bambu_model|model/i);

  const allowedPrintRpc = await client.callTool({
    name: "fulu_bambu_network_rpc",
    arguments: {
      bridge_command: bridgeCommand,
      method: "net.start_print",
      allow_mutating_method: true,
      bambu_model: "p1s",
      payload: { params: { dev_id: "printer" } },
    },
  });
  assert.equal(allowedPrintRpc.isError, undefined);
  const allowedPrintPayload = parseJsonResult(allowedPrintRpc);
  assert.equal(allowedPrintPayload.printMethod, true);
  assert.equal(allowedPrintPayload.bambuModel, "p1s");
  assert.equal(allowedPrintPayload.response.method, "net.start_print");
});

test("printer model safety: BAMBU_MODEL env var accepted as default", async (t) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
      PRINTER_TYPE: "bambu",
      BAMBU_SERIAL: "TEST_SERIAL",
      BAMBU_TOKEN: "TEST_TOKEN",
      BAMBU_MODEL: "p1s",
    },
    stderr: "pipe",
  });

  const client = createClient();

  t.after(async () => {
    await closeTransport(transport);
  });

  await client.connect(transport);

  // With BAMBU_MODEL=p1s env, print_3mf without explicit model should
  // get past model validation (error about file, not model)
  const result = await client.callTool({
    name: "print_3mf",
    arguments: { three_mf_path: "/tmp/nonexistent_test.3mf" },
  });
  assert.equal(result.isError, true);
  const errorText = result.content?.[0]?.text || "";
  assert.ok(
    !errorText.toLowerCase().includes("bambu_model"),
    `With BAMBU_MODEL env, error should be about file not model, got: ${errorText}`
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
