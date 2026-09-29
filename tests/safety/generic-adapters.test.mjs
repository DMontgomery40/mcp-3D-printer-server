import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import axios from "axios";
import { OctoPrintImplementation } from "../../dist/printers/octoprint.js";
import { KlipperImplementation } from "../../dist/printers/klipper.js";
import { DuetImplementation } from "../../dist/printers/duet.js";
import { RepetierImplementation } from "../../dist/printers/repetier.js";
import { PrusaImplementation } from "../../dist/printers/prusa.js";
import { CrealityImplementation } from "../../dist/printers/creality.js";

// Every adapter talks to a loopback HTTP mock; no printer is contacted.
for (const name of ["PRINT_REQUIRE_CONFIRMATION", "BAMBU_REQUIRE_CONFIRMATION", "PRINTER_MAX_NOZZLE_TEMP", "PRINTER_MAX_BED_TEMP", "PRINTER_MAX_CHAMBER_TEMP"]) delete process.env[name];

const SAFE = "; filament_type = PLA\nM140 S60\nM104 S215\nM190 S60\nM109 S215\nG28\nG1 X10 Y10 E1\nM104 S0\n";
const UNSAFE = "; filament_type = PLA\nM104 S220\nM104 S400\nM109 R450\nG1 X10 Y10 E1\n";

/** Per-adapter HTTP contract: state responses and the routes that mutate. */
const ADAPTERS = {
  octoprint: {
    Impl: OctoPrintImplementation,
    states: {
      idle: { status: 200, json: { state: { text: "Operational", flags: { operational: true, ready: true, printing: false, paused: false, error: false, closedOrError: false, sdReady: false } } } },
      busy: { status: 200, json: { state: { text: "Printing", flags: { operational: true, ready: false, printing: true } } } },
      error: { status: 409, json: { error: "Printer is not operational" } },
      unreadable: { status: 200, json: { state: {} } },
    },
    stateRoute: (url) => url.startsWith("/api/printer") && !url.startsWith("/api/printer/"),
    mutation: (req) => req.method === "POST" || req.method === "PUT",
    uploadRoute: "/api/files/local",
    atomic: true,
    download: (url) => url.startsWith("/downloads/files/local/"),
  },
  klipper: {
    Impl: KlipperImplementation,
    states: {
      idle: { status: 200, json: { result: { status: { webhooks: { state: "ready" }, print_stats: { state: "standby", filename: "" } } } } },
      busy: { status: 200, json: { result: { status: { webhooks: { state: "ready" }, print_stats: { state: "printing" } } } } },
      paused: { status: 200, json: { result: { status: { webhooks: { state: "ready" }, print_stats: { state: "paused" } } } } },
      error: { status: 200, json: { result: { status: { webhooks: { state: "shutdown", state_message: "MCU shutdown" }, print_stats: { state: "error" } } } } },
      unreadable: { status: 500, json: {} },
      finished: { status: 200, json: { result: { status: { webhooks: { state: "ready" }, print_stats: { state: "complete", filename: "last.gcode" } } } } },
    },
    stateRoute: (url) => url.startsWith("/printer/objects/query"),
    mutation: (req) => req.method === "POST" || req.method === "PUT",
    uploadRoute: "/server/files/upload",
    uploadResponse: { result: { item: { path: "x.gcode", root: "gcodes" } } },
    startRoute: "/printer/print/start",
    download: (url) => url.startsWith("/server/files/gcodes/"),
  },
  duet: {
    Impl: DuetImplementation,
    states: {
      idle: { status: 200, json: { state: { status: "idle" } } },
      busy: { status: 200, json: { state: { status: "printing" } } },
      paused: { status: 200, json: { state: { status: "paused" } } },
      error: { status: 200, json: { state: { status: "halted" } } },
      unreadable: { status: 200, json: { state: {} } },
    },
    stateRoute: (url) => url === "/machine/status",
    mutation: (req) => req.method === "POST" || req.method === "PUT",
    uploadRoute: "/machine/file/",
    startRoute: "/machine/code",
    download: (url) => url.startsWith("/machine/file/") ,
  },
  repetier: {
    Impl: RepetierImplementation,
    states: {
      idle: { status: 200, json: [{ online: 1, active: true, job: "none", slug: "p" }] },
      busy: { status: 200, json: [{ online: 1, active: true, job: "benchy.gcode", slug: "p" }] },
      error: { status: 200, json: [{ online: 0, active: true, job: "none", slug: "p" }] },
      unreadable: { status: 200, json: [{ online: 1, slug: "a", job: "none" }, { online: 1, slug: "b", job: "none" }] },
    },
    stateRoute: (url) => url.includes("a=listPrinter"),
    mutation: (req) => req.method === "POST" || /a=(?:startJob|setBedTemp|setExtruderTemp|stopJob)/.test(req.url),
    uploadRoute: "/printer/api/",
    atomic: true,
  },
  prusa: {
    Impl: PrusaImplementation,
    states: {
      idle: { status: 200, json: { printer: { state: "IDLE" } } },
      busy: { status: 200, json: { printer: { state: "PRINTING" } } },
      paused: { status: 200, json: { printer: { state: "PAUSED" } } },
      error: { status: 200, json: { printer: { state: "ERROR" } } },
      unreadable: { status: 200, json: { job: {} } },
      finished: { status: 200, json: { printer: { state: "FINISHED" }, job: { id: 7 } } },
    },
    stateRoute: (url) => url === "/api/v1/status",
    mutation: (req) => req.method === "POST" || req.method === "PUT",
    uploadRoute: "/api/v1/storage",
    startRoute: "/api/v1/job",
  },
  creality: {
    Impl: CrealityImplementation,
    states: {
      idle: { status: 200, json: { state: "idle" } },
      busy: { status: 200, json: { state: "printing" } },
      error: { status: 200, json: { state: "error" } },
      unreadable: { status: 200, json: { temperature: 20 } },
      finished: { status: 200, json: { state: "finished" } },
    },
    stateRoute: (url) => url === "/api/device/status",
    mutation: (req) => req.method === "POST" || req.method === "PUT",
    uploadRoute: "/api/storage/upload",
    uploadResponse: { success: true },
    startRoute: "/api/job/start",
  },
};

async function mockPrinter(t, adapter, { state = "idle", download } = {}) {
  const requests = [];
  const current = { state };
  const http = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const record = { method: req.method, url: req.url, body: Buffer.concat(chunks).toString() };
    requests.push(record);
    const send = (status, payload, type = "application/json") => {
      res.writeHead(status, { "Content-Type": type });
      res.end(type === "application/json" ? JSON.stringify(payload) : payload);
    };
    if (req.method === "GET" && adapter.stateRoute(req.url)) {
      const response = adapter.states[current.state];
      return send(response.status, response.json);
    }
    if (req.method === "GET" && adapter.download?.(req.url)) {
      return download === undefined ? send(404, { error: "missing" }) : send(200, download, "application/octet-stream");
    }
    if (req.method === "GET" && adapter === ADAPTERS.prusa && req.url === "/api/printer") return send(404, {});
    return send(req.method === "GET" ? 200 : 201, adapter.uploadResponse ?? { done: true });
  });
  t.after(() => new Promise((resolve) => http.close(resolve)));
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  return { port: String(http.address().port), requests, current };
}

async function gcodeFile(t, content, name = "job.gcode") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "generic-print-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, name);
  await fs.writeFile(file, content);
  return file;
}

function adapterWith(adapter, confirm = async () => true) {
  const prompts = [];
  const impl = new adapter.Impl(axios.create({ timeout: 5000 }), async (message) => { prompts.push(message); return confirm(message); });
  return { impl, prompts };
}

const mutations = (adapter, requests) => requests.filter((req) => adapter.mutation(req));

for (const [name, adapter] of Object.entries(ADAPTERS)) {
  test(`${name}: checked upload-and-print inspects, reads state, confirms, then uploads and starts the same bytes`, async (t) => {
    const printer = await mockPrinter(t, adapter);
    const file = await gcodeFile(t, SAFE);
    const { impl, prompts } = adapterWith(adapter);
    const result = await impl.uploadFile("127.0.0.1", printer.port, "KEY", file, "job.gcode", true, {});
    assert.equal(result.printRequested, true);
    assert.deepEqual(result.peakTemperatures, { nozzle: 215, bed: 60, chamber: 0 });
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /job\.gcode.*PLA.*nozzle 215°C, bed 60°C.*SHA-256/s);
    const writes = mutations(adapter, printer.requests);
    const uploads = writes.filter((req) => req.url.startsWith(adapter.uploadRoute));
    assert.equal(uploads.length, 1);
    assert.ok(uploads[0].body.includes("M109 S215"), "the uploaded body must be the inspected G-code");
    const states = printer.requests.filter((req) => req.method === "GET" && adapter.stateRoute(req.url));
    if (adapter.atomic) {
      assert.equal(writes.length, 1, "atomic upload-and-print sends one request");
      assert.equal(states.length, 2);
    } else {
      assert.equal(states.length, 3, "state is rechecked after upload, before start");
      const start = writes.at(-1);
      assert.ok(start.url.startsWith(adapter.startRoute), `${start.method} ${start.url}`);
      assert.match(start.body, /job\.gcode/);
    }
  });

  test(`${name}: unsafe G-code (audit S400/R450) is refused before any request`, async (t) => {
    const printer = await mockPrinter(t, adapter);
    const file = await gcodeFile(t, UNSAFE);
    const { impl } = adapterWith(adapter);
    await assert.rejects(impl.uploadFile("127.0.0.1", printer.port, "KEY", file, "job.gcode", true, {}), /Print safety/);
    await assert.rejects(impl.uploadFile("127.0.0.1", printer.port, "KEY", await gcodeFile(t, "M104 S215\n"), "job.gcode", true, {}), /declared material/);
    await assert.rejects(impl.uploadFile("127.0.0.1", printer.port, "KEY", file, "job.bgcode", true, {}), /plain-text G-code/);
    await assert.rejects(impl.uploadFile("127.0.0.1", printer.port, "KEY", file, "dir/job.gcode", true, {}), /plain filename/);
    assert.deepEqual(printer.requests, []);
  });

  for (const state of Object.keys(adapter.states).filter((key) => !["idle", "finished"].includes(key))) {
    test(`${name}: ${state} printer state refuses print and heating without mutation`, async (t) => {
      const printer = await mockPrinter(t, adapter, { state });
      const file = await gcodeFile(t, SAFE);
      const { impl, prompts } = adapterWith(adapter);
      await assert.rejects(impl.uploadFile("127.0.0.1", printer.port, "KEY", file, "job.gcode", true, {}), /not safely idle|cannot|Cannot|printers/);
      await assert.rejects(impl.setTemperature("127.0.0.1", printer.port, "KEY", "bed", 60, {}), /not safely idle|cannot|Cannot|printers/);
      assert.equal(prompts.length, 0, "a human is not asked to approve an unready printer");
      assert.deepEqual(mutations(adapter, printer.requests), []);
    });
  }

  test(`${name}: a declined confirmation uploads nothing`, async (t) => {
    const printer = await mockPrinter(t, adapter);
    const { impl } = adapterWith(adapter, async () => false);
    await assert.rejects(impl.uploadFile("127.0.0.1", printer.port, "KEY", await gcodeFile(t, SAFE), "job.gcode", true, {}), /declined/);
    await assert.rejects(impl.setTemperature("127.0.0.1", printer.port, "KEY", "bed", 60, {}), /declined/);
    assert.deepEqual(mutations(adapter, printer.requests), []);
  });

  test(`${name}: printer becoming busy during the confirmation stops the print`, async (t) => {
    const printer = await mockPrinter(t, adapter);
    const { impl } = adapterWith(adapter, async () => { printer.current.state = "busy"; return true; });
    await assert.rejects(impl.uploadFile("127.0.0.1", printer.port, "KEY", await gcodeFile(t, SAFE), "job.gcode", true, {}), /not safely idle/);
    assert.deepEqual(mutations(adapter, printer.requests), []);
  });

  test(`${name}: heater-off is never gated; positive heating is validated before any request`, async (t) => {
    const printer = await mockPrinter(t, adapter, { state: "busy" });
    const { impl, prompts } = adapterWith(adapter, async () => { throw new Error("must not prompt"); });
    for (const [component, temperature] of [["bed", Number.NaN], ["bed", "60"], ["bed", -1], ["bed", 121], ["extruder", 301], ["extruder", 215]]) {
      await assert.rejects(impl.setTemperature("127.0.0.1", printer.port, "KEY", component, temperature, {}), /finite|ceiling|material/, `${component} ${temperature}`);
    }
    await assert.rejects(impl.setTemperature("127.0.0.1", printer.port, "KEY", "extruder", 270, { material: "PLA" }), /260 C/);
    assert.deepEqual(printer.requests, [], "invalid heater requests must not reach the printer");
    await impl.setTemperature("127.0.0.1", printer.port, "KEY", "bed", 0, {});
    await impl.setTemperature("127.0.0.1", printer.port, "KEY", "extruder", 0, {});
    assert.equal(prompts.length, 0);
    assert.equal(printer.requests.filter((req) => req.method === "GET" && adapter.stateRoute(req.url)).length, 0, "heater-off reads no state");
    assert.equal(mutations(adapter, printer.requests).length, 2);
  });

  test(`${name}: positive heating reads state and asks a human first`, async (t) => {
    const printer = await mockPrinter(t, adapter);
    const { impl, prompts } = adapterWith(adapter);
    await impl.setTemperature("127.0.0.1", printer.port, "KEY", "extruder", 215, { material: "PLA" });
    assert.match(prompts[0], /Heat nozzle .* 215°C\? Declared material: PLA/);
    assert.equal(printer.requests.filter((req) => req.method === "GET" && adapter.stateRoute(req.url)).length, 2);
    assert.equal(mutations(adapter, printer.requests).length, 1);
  });

  test(`${name}: remote start inspects the actual remote file or refuses`, async (t) => {
    const printer = await mockPrinter(t, adapter, { download: UNSAFE });
    const { impl } = adapterWith(adapter);
    if (!adapter.download) {
      await assert.rejects(impl.startJob("127.0.0.1", printer.port, "KEY", "remote.gcode", {}), /cannot inspect files already stored.*upload_gcode with print=true/s);
      assert.deepEqual(printer.requests, [], "an uninspectable remote job is refused without contacting the printer");
      return;
    }
    await assert.rejects(impl.startJob("127.0.0.1", printer.port, "KEY", "remote.gcode", {}), /Print safety/);
    assert.deepEqual(mutations(adapter, printer.requests), [], "an unsafe remote file is never started");

    const safePrinter = await mockPrinter(t, adapter, { download: SAFE });
    const result = await impl.startJob("127.0.0.1", safePrinter.port, "KEY", "remote.gcode", {});
    assert.match(result.remotePath, /^checked-[0-9a-f-]+-remote\.gcode$/);
    const writes = mutations(adapter, safePrinter.requests);
    assert.ok(writes.some((req) => req.body.includes("M109 S215")), "the inspected bytes are uploaded as a checked copy");
    assert.ok(writes.every((req) => !/(?:^|[/"=])remote\.gcode/.test(decodeURIComponent(req.url) + req.body.replace(/checked-[0-9a-f-]+-remote\.gcode/g, ""))), "the original remote name is never started");
    assert.match(decodeURIComponent(writes.at(-1).url) + writes.at(-1).body, /checked-[0-9a-f-]+-remote\.gcode/);
  });

  test(`${name}: cancel is never gated`, async (t) => {
    const printer = await mockPrinter(t, adapter, { state: "busy" });
    const { impl } = adapterWith(adapter, async () => { throw new Error("must not prompt"); });
    await impl.cancelJob("127.0.0.1", printer.port, "KEY");
    assert.equal(printer.requests.length, 1);
  });
}

for (const name of ["klipper", "prusa", "creality"]) {
  test(`${name}: a finished-job state needs a human even with PRINT_REQUIRE_CONFIRMATION=0`, async (t) => {
    const adapter = ADAPTERS[name];
    process.env.PRINT_REQUIRE_CONFIRMATION = "0";
    t.after(() => { delete process.env.PRINT_REQUIRE_CONFIRMATION; });
    const idle = await mockPrinter(t, adapter);
    const quiet = adapterWith(adapter, async () => { throw new Error("ordinary prompts are opted out"); });
    assert.equal((await quiet.impl.uploadFile("127.0.0.1", idle.port, "KEY", await gcodeFile(t, SAFE), "job.gcode", true, {})).status, "success");
    const finished = await mockPrinter(t, adapter, { state: "finished" });
    const { impl, prompts } = adapterWith(adapter, async () => false);
    await assert.rejects(impl.uploadFile("127.0.0.1", finished.port, "KEY", await gcodeFile(t, SAFE), "job.gcode", true, {}), /declined/);
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /remove the previous part/);
    assert.deepEqual(mutations(adapter, finished.requests), []);
  });
}

test("OctoPrint nozzle targets use tool{n} keys (OctoPrint REST API) instead of 'extruder'", async (t) => {
  const printer = await mockPrinter(t, ADAPTERS.octoprint);
  const { impl } = adapterWith(ADAPTERS.octoprint);
  await impl.setTemperature("127.0.0.1", printer.port, "KEY", "extruder", 0);
  await impl.setTemperature("127.0.0.1", printer.port, "KEY", "tool1", 0);
  await impl.setTemperature("127.0.0.1", printer.port, "KEY", "extruder", 210, { material: "PLA" });
  await impl.setTemperature("127.0.0.1", printer.port, "KEY", "bed", 55);
  const posts = printer.requests.filter((req) => req.method === "POST").map((req) => ({ url: req.url, body: JSON.parse(req.body) }));
  assert.deepEqual(posts, [
    { url: "/api/printer/tool", body: { command: "target", targets: { tool0: 0 } } },
    { url: "/api/printer/tool", body: { command: "target", targets: { tool1: 0 } } },
    { url: "/api/printer/tool", body: { command: "target", targets: { tool0: 210 } } },
    { url: "/api/printer/bed", body: { command: "target", target: 55 } },
  ]);
  await assert.rejects(impl.setTemperature("127.0.0.1", printer.port, "KEY", "chamber", 0), /Unsupported component/);
});

test("OctoPrint effectivePrint=false is reported as not started instead of success", async (t) => {
  const adapter = { ...ADAPTERS.octoprint, uploadResponse: { done: true, effectivePrint: false } };
  const printer = await mockPrinter(t, adapter);
  const { impl } = adapterWith(adapter);
  await assert.rejects(impl.uploadFile("127.0.0.1", printer.port, "KEY", await gcodeFile(t, SAFE), "job.gcode", true, {}), /did not start printing/);
});

test("Duet uses verified DSF routes: raw-text /machine/code and PUT /machine/file", async (t) => {
  const printer = await mockPrinter(t, ADAPTERS.duet);
  const { impl } = adapterWith(ADAPTERS.duet);
  await impl.uploadFile("127.0.0.1", printer.port, "", await gcodeFile(t, SAFE), "job.gcode", true, {});
  await impl.setTemperature("127.0.0.1", printer.port, "", "bed", 0);
  const writes = printer.requests.filter((req) => req.method !== "GET").map((req) => ({ method: req.method, url: decodeURIComponent(req.url), body: req.method === "PUT" ? "<file>" : req.body }));
  assert.deepEqual(writes, [
    { method: "PUT", url: "/machine/file/0:/gcodes/job.gcode", body: "<file>" },
    { method: "POST", url: "/machine/code", body: 'M32 "0:/gcodes/job.gcode"' },
    { method: "POST", url: "/machine/code", body: "M140 S0" },
  ]);
});

test("stop during a pending generic confirmation prevents the upload", async (t) => {
  const adapter = ADAPTERS.klipper;
  const printer = await mockPrinter(t, adapter);
  let answer;
  let markAsked;
  const asked = new Promise((resolve) => { markAsked = resolve; });
  const { impl } = adapterWith(adapter, () => { markAsked(); return new Promise((resolve) => { answer = resolve; }); });
  const outcome = impl.uploadFile("127.0.0.1", printer.port, "KEY", await gcodeFile(t, SAFE), "job.gcode", true, {}).then((value) => ({ value }), (error) => ({ error }));
  await asked;
  await impl.cancelJob("127.0.0.1", printer.port, "KEY");
  answer(true);
  const completed = await outcome;
  assert.match(completed.error?.message ?? "", /cancelled/i);
  assert.deepEqual(mutations(adapter, printer.requests).map((req) => req.url), ["/printer/print/cancel"]);
});

test("an invalid ceiling override refuses printing and heating before any request", async (t) => {
  const adapter = ADAPTERS.octoprint;
  const printer = await mockPrinter(t, adapter);
  process.env.PRINTER_MAX_BED_TEMP = "9000";
  t.after(() => { delete process.env.PRINTER_MAX_BED_TEMP; });
  const { impl } = adapterWith(adapter);
  await assert.rejects(impl.uploadFile("127.0.0.1", printer.port, "KEY", await gcodeFile(t, SAFE), "job.gcode", true, {}), /PRINTER_MAX_BED_TEMP/);
  await assert.rejects(impl.setTemperature("127.0.0.1", printer.port, "KEY", "bed", 60), /PRINTER_MAX_BED_TEMP/);
  assert.deepEqual(printer.requests, []);
  // Heater-off never depends on ceiling configuration.
  await impl.setTemperature("127.0.0.1", printer.port, "KEY", "bed", 0);
  await impl.setTemperature("127.0.0.1", printer.port, "KEY", "extruder", 0);
  assert.deepEqual(printer.requests.map((req) => `${req.method} ${req.url}`), ["POST /api/printer/bed", "POST /api/printer/tool"]);
  process.env.PRINTER_MAX_BED_TEMP = "55";
  await assert.rejects(impl.setTemperature("127.0.0.1", printer.port, "KEY", "bed", 60), /55 C server ceiling/);
});

test("upload without print stays unguarded and keeps the requested name", async (t) => {
  const adapter = ADAPTERS.klipper;
  const printer = await mockPrinter(t, adapter);
  const { impl, prompts } = adapterWith(adapter);
  await impl.uploadFile("127.0.0.1", printer.port, "KEY", await gcodeFile(t, UNSAFE, "keep.gcode"), "keep.gcode", false);
  assert.equal(prompts.length, 0);
  assert.deepEqual(printer.requests.map((req) => req.url), ["/server/files/upload"]);
});
