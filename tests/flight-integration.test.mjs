import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { BambuImplementation, checkedFile } from "../dist/printers/bambu.js";
import { FlightRecords, flightKey } from "../dist/counterpart/flight-record.js";
const root = path.dirname(
  fileURLToPath(new URL("../package.json", import.meta.url)),
);
const hash = "b".repeat(64);
const file = {
  sha256: hash,
  model: "p1s",
  materials: ["PLA"],
  maxNozzleTemperature: 220,
  maxBedTemperature: 55,
  maxChamberTemperature: 0,
};
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flight-integration-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test("checked-dispatch hook captures existing report callbacks independently of the resume lifecycle", (t) => {
  const dir = fixture(t);
  const bambu = new BambuImplementation({});
  Object.defineProperty(bambu, "flightRecords", {
    value: new FlightRecords({ dir }),
  });
  bambu.getPrinter = () => {
    throw Error("no network allowed");
  };
  bambu.recordCheckedJob(
    "fixture",
    "01PFIXTURE",
    "cache/checked-shaft.3mf",
    {
      model: "p1s",
      nozzleDiameters: [0.4],
      materials: ["PLA"],
      useAMS: true,
      amsMapping: [0],
    },
    file,
  );
  for (const [state, layer] of [
    ["RUNNING", 2],
    ["RUNNING", 40],
    ["FINISH", 100],
  ])
    bambu.observeReport("fixture", "01PFIXTURE", {
      subtask_name: "checked-shaft",
      gcode_state: state,
      layer_num: layer,
      total_layer_num: 100,
      print_error: 0,
      hms: [],
    });
  const view = new FlightRecords({ dir }).read(
    flightKey("fixture", "01PFIXTURE"),
  );
  assert.equal(view.record.latest.gcode_state, "FINISH");
  assert.equal(view.record.reports.length, 3);
  assert.equal(view.physical.status, "unknown");
});
test("checked-file expected geometry uses only the selected plate", async (t) => {
  const dir = fixture(t),
    source = path.join(dir, "fixture.3mf"),
    zip = new JSZip();
  zip.file(
    "Metadata/plate_1.gcode",
    "M83\n; Z_HEIGHT: 10\nG1 X1 Y1\nG1 X2 Y2 E1",
  );
  zip.file(
    "Metadata/plate_2.gcode",
    "M83\n; Z_HEIGHT: 50\nG1 X1 Y1\nG1 X2 Y2 E1",
  );
  fs.writeFileSync(source, await zip.generateAsync({ type: "nodebuffer" }));
  const inspected = {
    ...file,
    nozzleDiameters: [0.4],
    usedFilamentPositions: [0],
    selectsAms: true,
    plateInternalPath: "Metadata/plate_2.gcode",
  };
  const checked = await checkedFile(inspected, source);
  assert.equal(checked.expected.heightMm, 50);
  assert.equal(checked.plate.index, 2);
});
test("public counterpart_print_record retrieves a persisted record without any network capability", async (t) => {
  const dir = fixture(t),
    log = path.join(dir, "network.log");
  const store = new FlightRecords({ dir: path.join(dir, "records") });
  store.begin(flightKey("127.0.0.1", "01PFIXTURE"), {
    sha256: hash,
    jobName: "checked-fixture.3mf",
    mapping: [0],
  });
  store.observe(flightKey("127.0.0.1", "01PFIXTURE"), {
    subtask_name: "checked-fixture",
    gcode_state: "FINISH",
    layer_num: 400,
  });
  const preload = path.join(root, "tests/fixtures/inspection-no-network.mjs");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", preload, path.join(root, "dist/index.js")],
    cwd: dir,
    stderr: "pipe",
    env: {
      HOME: dir,
      COUNTERPART_RECORD_DIR: path.join(dir, "records"),
      MCP_TRANSPORT: "stdio",
      PRINTER_TYPE: "bambu",
      PRINTER_HOST: "127.0.0.1",
      BAMBU_SERIAL: "01PFIXTURE",
      BAMBU_TOKEN: "fixture-token",
      BAMBU_MODEL: "p1s",
      INSPECTION_NETWORK_LOG: log,
    },
  });
  transport.stderr.on("data", () => {});
  const client = new Client(
    { name: "flight-read-test", version: "1" },
    { capabilities: {} },
  );
  t.after(async () => {
    await client.close();
    await transport.close();
  });
  await client.connect(transport);
  const tool = (await client.listTools()).tools.find(
    (t) => t.name === "counterpart_print_record",
  );
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.openWorldHint, false);
  const response = await client.callTool({
    name: "counterpart_print_record",
    arguments: { list_jobs: true },
  });
  assert.equal(response.isError, undefined, JSON.stringify(response));
  assert.equal(response.structuredContent.record.dispatch.sha256, hash);
  assert.equal(response.structuredContent.physical.status, "unknown");
  assert.equal(response.structuredContent.jobs.length, 1);
  assert.equal(response.structuredContent.jobs[0].sha256, hash);
  assert.equal(
    fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim() : "",
    "",
  );
});

test("generic dispatch and existing progress reads preserve adapter problems without extra printer reads", async (t) => {
  const { KlipperImplementation } = await import("../dist/printers/klipper.js");
  const dir = fixture(t),
    implementation = new KlipperImplementation({});
  Object.defineProperty(implementation, "flightRecords", {
    value: new FlightRecords({ dir: path.join(dir, "records") }),
  });
  implementation.readPrinterState = async () => ({
    state: "ready",
    ready: true,
  });
  implementation.rawUploadFile = async () => ({
    result: { item: { path: "fixture.gcode", root: "gcodes" } },
  });
  implementation.rawStartJob = async () => ({ result: "ok" });
  const filePath = path.join(dir, "fixture.gcode");
  fs.writeFileSync(
    filePath,
    "; filament_type = PLA\nM104 S210\nM83\n; Z_HEIGHT: 1\nG1 X1 Y1\nG1 X2 Y2 E1\n",
  );
  const dispatched = await implementation.uploadFile(
    "fixture",
    "7125",
    "never-used",
    filePath,
    "fixture.gcode",
    true,
    { material: "PLA" },
  );
  let reads = 0;
  implementation.counterpartProgress = async () => {
    reads++;
    return {
      contract: "counterpart/1",
      observedAt: new Date().toISOString(),
      state: "printing",
      job: { name: dispatched.jobName, layer: 1, totalLayers: 100 },
      problems: [
        {
          code: "klipper.print_error",
          severity: "error",
          message: "private-host-and-secret",
        },
      ],
    };
  };
  await implementation.observedProgress("fixture", "7125", "never-used");
  const view = implementation.flightRecords.read(
    implementation.flightRecordKey("fixture", "7125"),
  );
  assert.equal(reads, 1);
  assert.equal(view.record.latest.observation_source, "adapter-progress");
  assert.equal(
    view.record.latest.adapter_problems[0].code,
    "klipper.print_error",
  );
  assert.ok(!JSON.stringify(view).includes("private-host-and-secret"));
  assert.equal(view.record.expected.heightMm, 1);
});

test("generic lost start response leaves an unconfirmed durable dispatched artifact record", async (t) => {
  const { KlipperImplementation } = await import("../dist/printers/klipper.js");
  const dir = fixture(t),
    implementation = new KlipperImplementation({});
  Object.defineProperty(implementation, "flightRecords", {
    value: new FlightRecords({ dir: path.join(dir, "records") }),
  });
  implementation.readPrinterState = async () => ({
    state: "ready",
    ready: true,
  });
  implementation.rawUploadFile = async () => ({
    result: { item: { path: "lost.gcode", root: "gcodes" } },
  });
  implementation.rawStartJob = async () => {
    throw Error("reply lost after send");
  };
  const input = path.join(dir, "lost.gcode");
  fs.writeFileSync(input, "; filament_type = PLA\nM104 S210\nG1 X1 Y1 E1");
  await assert.rejects(
    implementation.uploadFile(
      "fixture",
      "7125",
      "unused",
      input,
      "lost.gcode",
      true,
      { material: "PLA" },
    ),
    /reply lost/,
  );
  const persisted = new FlightRecords({ dir: path.join(dir, "records") }).read(
    implementation.flightRecordKey("fixture", "7125"),
  );
  assert.equal(persisted.status, "recorded");
  assert.equal(persisted.record.dispatch.outcome, "unconfirmed");
  assert.match(persisted.record.dispatch.sha256, /^[a-f0-9]{64}$/);
});

test("dispatch authorization keeps durable hash/mapping if the transport response is lost; acceptance reuses the record", (t) => {
  const dir = fixture(t),
    bambu = new BambuImplementation({});
  Object.defineProperty(bambu, "flightRecords", {
    value: new FlightRecords({ dir }),
  });
  const requirements = {
    model: "p1s",
    nozzleDiameters: [0.4],
    materials: ["PLA"],
    useAMS: true,
    amsMapping: [0],
  };
  bambu.recordFlightDispatch(
    "fixture",
    "01PFIXTURE",
    "checked-lost.3mf",
    requirements,
    file,
  );
  const pending = new FlightRecords({ dir }).read(
    flightKey("fixture", "01PFIXTURE"),
  );
  assert.equal(pending.record.dispatch.sha256, hash);
  assert.equal(pending.record.dispatch.outcome, "unconfirmed");
  bambu.observeReport("fixture", "01PFIXTURE", {
    subtask_name: "checked-lost",
    gcode_state: "RUNNING",
    layer_num: 1,
  });
  bambu.recordCheckedJob(
    "fixture",
    "01PFIXTURE",
    "checked-lost.3mf",
    requirements,
    file,
  );
  const accepted = bambu.flightRecords.read(flightKey("fixture", "01PFIXTURE"));
  assert.equal(accepted.record.id, pending.record.id);
  assert.equal(accepted.record.reports.length, 1);
});
