import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import JSZip from "jszip";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const serial = "01PTESTSAFETY";

// Every server runs from an empty directory with every printer variable set
// explicitly, so a developer .env (which may name a real printer) is never read.
async function server(t, env = {}, { preload, elicitation } = {}) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "print-safety-cwd-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const client = new Client({ name: "print-safety-test", version: "1" }, elicitation ? { capabilities: { elicitation: { form: {} } } } : undefined);
  if (elicitation) client.setRequestHandler(ElicitRequestSchema, elicitation);
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [...(preload ? ["--import", preload] : []), path.join(root, "dist/index.js")], cwd,
    env: {
      ...process.env, MCP_TRANSPORT: "stdio", PRINTER_TYPE: "bambu", PRINTER_HOST: "127.0.0.1", API_KEY: "",
      BAMBU_MODEL: "", BAMBU_SERIAL: "", BAMBU_TOKEN: "", BAMBU_REQUIRE_CONFIRMATION: "", PRINT_REQUIRE_CONFIRMATION: "",
      PRINTER_MAX_NOZZLE_TEMP: "", PRINTER_MAX_BED_TEMP: "", PRINTER_MAX_CHAMBER_TEMP: "", ...env,
    },
    stderr: "pipe",
  }));
  return client;
}

/** Replaces every Bambu transport boundary in the server process and records attempts. */
async function bambuBoundaries(t, { status = {}, slice } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bambu-boundaries-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const eventsPath = path.join(dir, "events.jsonl");
  const preload = path.join(dir, "boundaries.mjs");
  const href = (file) => JSON.stringify(pathToFileURL(path.join(root, file)).href);
  await fs.writeFile(preload, `
    import fs from "node:fs";
    import { BambuImplementation } from ${href("dist/printers/bambu.js")};
    import { STLManipulator } from ${href("dist/stl/stl-manipulator.js")};
    const log = (event) => fs.appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify(event) + "\\n");
    BambuImplementation.prototype.ftpUpload = async (_host, _token, file, remote) => log({ action: "upload", remote, bytes: fs.readFileSync(file).toString("base64") });
    BambuImplementation.prototype.ftpDownload = async () => { throw new Error("Remote artifact unavailable for inspection"); };
    BambuImplementation.prototype.getStatus = async () => { throw new Error("unexpected display status read in test"); };
    BambuImplementation.prototype.getPrinter = async () => ({ publish: async (payload) => log({ action: "publish", payload }) });
    BambuImplementation.prototype.getSafetyStatus = async () => {
      log({ action: "status" });
      const now = Date.now();
      return { connected: true, model: "p1s", status: "IDLE", serial: ${JSON.stringify(serial)},
        raw: { model: "p1s", gcode_state: "IDLE", nozzle_diameter: "0.4", print_error: 0, hms: [], ...${JSON.stringify(status)} },
        observation: { source: "mqtt", requestedAt: now, receivedAt: now, identitySource: "report" } };
    };
    STLManipulator.prototype.sliceSTL = async (input) => {
      log({ action: "slice", input });
      ${slice === "fail" ? 'throw new Error("Simulated slicer failure");' : `return ${JSON.stringify(slice ?? "")} || input;`}
    };
  `);
  const events = async () => (await fs.readFile(eventsPath, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { preload, events };
}

async function bambuProject(t, { gcode = "M104 S220\nM140 S60\nG1 X10 Y10 Z1\n", plateEntry = "Metadata/plate_1.gcode", name = "job.3mf" } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bambu-project-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, name);
  const zip = new JSZip();
  zip.file("3D/3dmodel.model", '<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices/><triangles/></mesh></object></resources><build><item objectid="1"/></build></model>');
  if (plateEntry) zip.file(plateEntry, `; printer_model = Bambu Lab P1S\n; nozzle_diameter = 0.4\n; filament_type = PLA\n; curr_bed_type = Textured PEI Plate\n${gcode}`);
  zip.file("Metadata/plate_1.json", JSON.stringify({ filament_ids: [0] }));
  await fs.writeFile(file, await zip.generateAsync({ type: "nodebuffer" }));
  return file;
}

const errorText = (result) => result.content.map((item) => item.text ?? "").join(" ");
const accept = async () => ({ action: "accept", content: { confirmed: true } });
const decline = async () => ({ action: "decline" });
const bambuEnv = { BAMBU_SERIAL: serial, BAMBU_TOKEN: "TEST_TOKEN", BAMBU_MODEL: "p1s" };

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

test("set_printer_temperature rejects nonfinite and string targets before any printer connection", async (t) => {
  const { preload, events } = await bambuBoundaries(t);
  const client = await server(t, bambuEnv, { preload, elicitation: accept });
  for (const temperature of ["not-a-number", "220", -1, null, { value: 220 }]) {
    const result = await client.callTool({ name: "set_printer_temperature", arguments: { component: "nozzle", temperature, material: "PLA" } });
    assert.equal(result.isError, true, JSON.stringify(temperature));
    assert.match(errorText(result), /finite|temperature/i);
  }
  const overBed = await client.callTool({ name: "set_printer_temperature", arguments: { component: "bed", temperature: 300 } });
  assert.match(errorText(overBed), /exceeds the 100 C hardware limit/);
  const noMaterial = await client.callTool({ name: "set_printer_temperature", arguments: { component: "nozzle", temperature: 220 } });
  assert.match(errorText(noMaterial), /material/i);
  assert.deepEqual(await events(), [], "no status read, connection or publish may happen");

  const off = await client.callTool({ name: "set_printer_temperature", arguments: { component: "nozzle", temperature: 0 } });
  assert.notEqual(off.isError, true, errorText(off));
  assert.deepEqual((await events()).map(({ action }) => action), ["publish"], "heater-off is never gated");
});

test("print_3mf asks a human before upload; decline and clients without elicitation send nothing", async (t) => {
  const file = await bambuProject(t);
  for (const [name, options, extraEnv, expectation] of [
    ["accepted", { elicitation: accept }, {}, "print"],
    ["declined", { elicitation: decline }, {}, /confirmation was declined/i],
    ["no elicitation support", {}, {}, /elicitation support.*PRINT_REQUIRE_CONFIRMATION=0/i],
    ["headless opt-out", {}, { PRINT_REQUIRE_CONFIRMATION: "0" }, "print"],
    ["legacy Bambu opt-out", {}, { BAMBU_REQUIRE_CONFIRMATION: "0" }, "print"],
  ]) {
    await t.test(name, async (t) => {
      const { preload, events } = await bambuBoundaries(t);
      const client = await server(t, { ...bambuEnv, ...extraEnv }, { preload, ...options });
      const result = await client.callTool({ name: "print_3mf", arguments: { three_mf_path: file } });
      const actions = (await events()).map(({ action }) => action);
      if (expectation === "print") {
        assert.notEqual(result.isError, true, errorText(result));
        assert.deepEqual(actions, ["status", "status", "upload", "status", "publish"]);
      } else {
        assert.equal(result.isError, true);
        assert.match(errorText(result), expectation);
        assert.deepEqual(actions, ["status"], "only the preflight status read may happen");
      }
    });
  }
});

test("print_3mf never uploads the original project when auto-slicing fails or the selected plate is missing", async (t) => {
  for (const [name, fileOptions, slice, error] of [
    ["slicer failure", { plateEntry: null }, "fail", /Auto-slicing failed; nothing was uploaded/],
    ["stray non-plate G-code", { plateEntry: "Metadata/other.gcode" }, "fail", /Auto-slicing failed/],
    ["slicer output without the selected plate", { plateEntry: "Metadata/plate_2.gcode" }, undefined, /selected plate 1 has no printable/],
  ]) {
    await t.test(name, async (t) => {
      const file = await bambuProject(t, fileOptions);
      const { preload, events } = await bambuBoundaries(t, { slice });
      const client = await server(t, bambuEnv, { preload, elicitation: accept });
      const result = await client.callTool({ name: "print_3mf", arguments: { three_mf_path: file } });
      assert.equal(result.isError, true);
      assert.match(errorText(result), error);
      assert.deepEqual((await events()).filter(({ action }) => action !== "slice"), [], "nothing may reach the printer");
    });
  }
});

test("process_and_print_stl refuses an expected-temperature mismatch before upload (was only a warning)", async (t) => {
  // Original defect: confirmTemperatures missed R targets and a mismatch only logged.
  for (const [name, gcode, args, expectation] of [
    ["audit case S220/S400/R450", "M104 S220\nM104 S400\nM109 R450\nM140 S60\n", { extruder_temp: 220 }, /temperature|limit/i],
    ["R target above the expected peak", "M104 S220\nM109 R240\nM140 S60\n", { extruder_temp: 220 }, /highest nozzle target is 240 C.*220 C was expected/],
    ["bed mismatch", "M104 S220\nM190 R70\n", { bed_temp: 60 }, /highest bed target is 70 C/],
    ["matching peaks", "M104 S220\nM109 R220\nM140 S60\n", { extruder_temp: 220, bed_temp: 60 }, "print"],
  ]) {
    await t.test(name, async (t) => {
      const sliced = await bambuProject(t, { gcode });
      const { preload, events } = await bambuBoundaries(t, { slice: sliced });
      const temp = await fs.mkdtemp(path.join(os.tmpdir(), "process-print-"));
      t.after(() => fs.rm(temp, { recursive: true, force: true }));
      const client = await server(t, { ...bambuEnv, TEMP_DIR: temp }, { preload, elicitation: accept });
      const result = await client.callTool({ name: "process_and_print_stl", arguments: {
        stl_path: path.join(root, "test/sample_cube.stl"), extension_inches: 0, ...args,
      } });
      const actions = (await events()).map(({ action }) => action).filter((action) => action !== "slice");
      if (expectation === "print") {
        assert.notEqual(result.isError, true, errorText(result));
        assert.deepEqual(actions, ["status", "status", "upload", "status", "publish"]);
      } else {
        assert.equal(result.isError, true);
        assert.match(errorText(result), expectation);
        assert.deepEqual(actions, [], "inspection must refuse before any printer connection");
      }
    });
  }
});
