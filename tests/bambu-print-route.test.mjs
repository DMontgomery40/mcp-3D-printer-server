// The Bambu print route over MCP: counterpart_print_route (ported from
// bambu-printer-mcp tests/counterpart.test.mjs) and print_3mf through FULU's
// authenticated LAN session, with tests/fixtures/fake-fulu-host.mjs as the
// bridge host and fresh printer state patched in. No printer is contacted.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, "..", "dist", "index.js");
const FAKE_FULU_HOST = path.join(__dirname, "fixtures", "fake-fulu-host.mjs");
const shellQuoteArg = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;

async function server(t, env = {}, { files = {}, preload } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bambu-route-mcp-"));
  for (const [name, { text, mode }] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), text, { mode });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...(preload ? ["--import", `data:text/javascript,${encodeURIComponent(preload)}`] : []), SERVER_ENTRY],
    // The server's working directory holds the only .env it can read or write.
    cwd: directory,
    env: {
      PATH: process.env.PATH, HOME: path.join(directory, "home"), MCP_TRANSPORT: "stdio", PRINTER_TYPE: "bambu", PRINTER_HOST: "192.0.2.10",
      BAMBU_SERIAL: "01PTESTSERIAL", BAMBU_TOKEN: "printer-secret-never-returned", BAMBU_MODEL: "p1s", BAMBU_STUDIO_CONFIG: "",
      ...env,
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {});
  const client = new Client({ name: "bambu-route-tests", version: "1" });
  t.after(async () => { await client.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await client.connect(transport);
  await client.listTools();
  return { client, directory };
}

const route = async (client, args = {}) => JSON.parse((await client.callTool({ name: "counterpart_print_route", arguments: args })).content[0].text);

test("counterpart_print_route reads the route and changes it in the running server and its .env", async (t) => {
  const dotenv = "# printer\nBAMBU_SERIAL=01PTESTSERIAL\nBAMBU_DEFAULT_CONNECTION_MODE=bambu_network\nBAMBU_DEFAULT_CONNECTION_TYPE=lan\nBAMBU_REQUIRE_X=1\n";
  const { client, directory } = await server(t, {}, { files: { ".env": { text: dotenv, mode: 0o600 } } });
  assert.deepEqual(await route(client), { route: "lan", mode: "bambu_network", type: "lan", choices: ["lan", "cloud"], savedTo: null });

  const cloud = await route(client, { route: "cloud" });
  assert.deepEqual([cloud.route, cloud.mode, cloud.type], ["cloud", "bambu_network", "cloud"]);
  const file = path.join(fs.realpathSync(directory), ".env");
  assert.equal(fs.realpathSync(cloud.savedTo), file);
  assert.equal(fs.readFileSync(file, "utf8"), dotenv.replace("CONNECTION_TYPE=lan", "CONNECTION_TYPE=cloud"), "only the route line changes");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, "the file keeps its permissions");
  assert.equal((await route(client)).route, "cloud", "the running server uses the new route");

  assert.equal((await route(client, { route: "lan" })).type, "lan");
  assert.equal(fs.readFileSync(file, "utf8"), dotenv);
});

test("counterpart_print_route on direct LAN: cloud switches to FULU's bridge, lan keeps the configured mode, no .env is created", async (t) => {
  const { client, directory } = await server(t, { BAMBU_DEFAULT_CONNECTION_MODE: "lan_mqtt_ftps" });
  assert.deepEqual([(await route(client)).route, (await route(client)).mode], ["lan", "lan_mqtt_ftps"]);
  assert.equal((await route(client, { route: "lan" })).mode, "lan_mqtt_ftps");
  const cloud = await route(client, { route: "cloud" });
  assert.deepEqual([cloud.route, cloud.mode, cloud.savedTo], ["cloud", "bambu_network", null]);
  assert.equal(fs.existsSync(path.join(directory, ".env")), false);
  const refused = await client.callTool({ name: "counterpart_print_route", arguments: { route: "wifi" } });
  assert.equal(refused.isError, true);
});

test("bambu-printer-mcp's native and Bambu Connect routes are refused, not sent over another connection", async (t) => {
  const preload = `import { BambuImplementation } from ${JSON.stringify(new URL("../dist/printers/bambu.js", import.meta.url).href)};
    BambuImplementation.prototype.getPrinter = async () => { throw new Error("Legacy MQTT must not be used"); };`;
  const { client } = await server(t, {}, { preload });
  for (const mode of ["bambu_native", "bambu_connect"]) {
    const result = await client.callTool({ name: "pause_print", arguments: { connection_mode: mode } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, new RegExp(`${mode} is not available in mcp-3D-printer-server`));
  }
});

async function twoFilamentProject(directory) {
  const file = path.join(directory, "two.3mf");
  const zip = new JSZip();
  zip.file("3D/3dmodel.model", '<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices/><triangles/></mesh></object></resources><build><item objectid="1"/></build></model>');
  zip.file("Metadata/plate_1.gcode", "; printer_model = Bambu Lab P1S\n; nozzle_diameter = 0.4\n; filament_type = PLA;PETG\n; filament_colour = #FFFFFF;#000000\n; curr_bed_type = Textured PEI Plate\nM104 S240\nM140 S70\nG1 X10 Y10 Z1\n");
  zip.file("Metadata/plate_1.json", JSON.stringify({ filament_ids: [1] }));
  zip.file("Metadata/project_settings.config", JSON.stringify({ printer_model: "p1s", nozzle_diameter: ["0.4"], filament_type: ["PLA", "PETG"], filament_colour: ["#FFFFFF", "#000000"], filament_ids: ["GFL99", "GFG99"], curr_bed_type: "Textured PEI Plate" }));
  fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" }));
  return file;
}

test("print_3mf on FULU's LAN route sends the checked job with Bambu Studio's AMS fields, never plain MQTT", { timeout: 120_000 }, async (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "fulu-print-"));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const log = path.join(work, "host.jsonl");
  const preload = `import { BambuImplementation } from ${JSON.stringify(new URL("../dist/printers/bambu.js", import.meta.url).href)};
    BambuImplementation.prototype.getPrinter = async () => { throw new Error("Legacy MQTT must not be used"); };
    BambuImplementation.prototype.getSafetyStatus = async () => ({ connected: true, model: "p1s", status: "IDLE", serial: "01PTESTSERIAL",
      raw: { model: "p1s", gcode_state: "IDLE", nozzle_diameter: "0.4", print_error: 0, hms: [],
        ams: { ams: [{ id: "0", tray: [{ id: "0", tray_type: "PLA" }, { id: "1", tray_type: "PLA" }, { id: "2", tray_type: "PLA" }, { id: "3", tray_type: "PETG", tray_color: "000000FF" }] }] } },
      observation: { source: "mqtt", receivedAt: Date.now(), requestedAt: Date.now() - 1, identitySource: "report" } });`;
  const { client } = await server(t, {
    BAMBU_NETWORK_BRIDGE_COMMAND: `${shellQuoteArg(process.execPath)} ${shellQuoteArg(FAKE_FULU_HOST)}`,
    BAMBU_NETWORK_CONFIG_DIR: path.join(work, "config"), PJARCZAK_BAMBU_PLUGIN_DIR: path.join(work, "plugins"), FAKE_FULU_LOG: log,
    BAMBU_DEFAULT_CONNECTION_MODE: "bambu_network", BAMBU_DEFAULT_CONNECTION_TYPE: "lan",
  }, { preload });
  const file = await twoFilamentProject(work);
  const result = await client.callTool({ name: "print_3mf", arguments: { three_mf_path: file, ams_slots: [3], use_ams: true } }, undefined, { timeout: 110_000 });
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  const printed = JSON.parse(result.content[0].text);
  assert.equal(printed.bridgeMethod, "net.start_local_print");
  assert.match(printed.printerJobName, /^checked-[a-f0-9-]+-two$/);
  assert.deepEqual(printed.amsMapping, [-1, 3]);
  assert.equal(printed.params.password, "[redacted]");
  assert.doesNotMatch(result.content[0].text, /printer-secret-never-returned/);

  const calls = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((entry) => entry.method);
  const methods = calls.map((entry) => entry.method);
  const print = calls.filter((entry) => entry.method === "net.start_local_print").at(-1);
  assert.ok(methods.indexOf("net.connect_printer") < methods.indexOf("net.start_local_print"), "the plug-in's own LAN session opens first");
  const params = print.payload.params;
  assert.equal(params.task_name, printed.printerJobName);
  assert.equal(params.task_use_ams, true);
  assert.equal(params.ams_mapping, "[-1,3]");
  assert.equal(params.ams_mapping2, JSON.stringify([{ ams_id: 255, slot_id: 255 }, { ams_id: 0, slot_id: 3 }]));
  assert.deepEqual(JSON.parse(params.ams_mapping_info), [
    { ams: -1, targetColor: "", filamentId: "", filamentType: "" },
    { ams: 3, targetColor: "000000FF", filamentId: "GFG99", filamentType: "PETG", sourceColor: "#000000FF" },
  ]);
  assert.equal(params.connection_type, "lan");
  assert.equal(params.plate_index, 1);
});

test("print_3mf on FULU's route still refuses a tray of the wrong material before the bridge starts", async (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "fulu-refuse-"));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const log = path.join(work, "host.jsonl");
  const preload = `import { BambuImplementation } from ${JSON.stringify(new URL("../dist/printers/bambu.js", import.meta.url).href)};
    BambuImplementation.prototype.getSafetyStatus = async () => ({ connected: true, model: "p1s", status: "IDLE", serial: "01PTESTSERIAL",
      raw: { model: "p1s", gcode_state: "IDLE", nozzle_diameter: "0.4", print_error: 0, hms: [], ams: { ams: [{ id: "0", tray: [{ id: "0", tray_type: "PLA" }] }] } },
      observation: { source: "mqtt", receivedAt: Date.now(), requestedAt: Date.now() - 1, identitySource: "report" } });`;
  const { client } = await server(t, {
    BAMBU_NETWORK_BRIDGE_COMMAND: `${shellQuoteArg(process.execPath)} ${shellQuoteArg(FAKE_FULU_HOST)}`,
    BAMBU_NETWORK_CONFIG_DIR: path.join(work, "config"), FAKE_FULU_LOG: log,
  }, { preload });
  const file = await twoFilamentProject(work);
  const result = await client.callTool({ name: "print_3mf", arguments: { three_mf_path: file, ams_slots: [0], connection_mode: "bambu_network", connection_type: "lan" } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /PETG|PLA|material/i);
  assert.equal(fs.existsSync(log), false, "the bridge host never started");
});
