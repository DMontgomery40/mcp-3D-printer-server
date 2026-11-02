// counterpart_print_progress firmware mappings (PRD §8.4). Pure mappers over
// recorded responses: no printer is contacted.
//
// Fixture provenance:
// - octoprint-*.json, moonraker-*.json: recorded from OctoPrint 1.11.2 / 1.8.7
//   (virtual printer) and Klipper + Moonraker 1.5.0 on simulavr (KAN-216 simulators).
// - PrusaLink objects below follow the OpenAPI spec:
//   https://github.com/prusa3d/Prusa-Link-Web/blob/master/spec/openapi.yaml
// - Duet objects follow the RepRapFirmware object model:
//   https://github.com/Duet3D/RepRapFirmware/wiki/Object-Model-Documentation
// - Repetier objects follow current listPrinter responses; done/printTime/
//   printedTimeComp/paused are not in the official API manual.
// - Bambu encodings match bambu-printer-mcp's counterpart_print_progress.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import {
  mapBambu, mapCrealityDevice, mapDuet, mapMoonraker, mapOctoPrint, mapPrusaLink, mapRepetier, octoPrintState,
} from "../dist/counterpart/progress.js";
import { PRINT_PROGRESS_OUTPUT_SCHEMA, compact, remoteJobName } from "../dist/counterpart/contract.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "counterpart");
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"));
const AT = "2026-11-01T12:00:00.000Z";
const validate = new AjvJsonSchemaValidator().getValidator(PRINT_PROGRESS_OUTPUT_SCHEMA);

/** Every result must satisfy the declared outputSchema and never carry null. */
function valid(result) {
  const check = validate(result);
  assert.ok(check.valid, `${JSON.stringify(result)}: ${check.errorMessage}`);
  assert.ok(!JSON.stringify(result).includes("null"), `null in ${JSON.stringify(result)}`);
  return result;
}

test("OctoPrint: recorded idle and printing jobs (1.11 and 1.8)", () => {
  // The recorded /api/printer capture excluded temperatures; this block is the simulator's live reading,
  // with OctoPrint's documented null target (printer.rst) on the bed.
  const printer = { ...fixture("octoprint-1.11-printer.idle.json"),
    temperature: { tool0: { actual: 21.3, offset: 0, target: 0.0 }, bed: { actual: 21.3, offset: 0, target: null } } };
  const idle = valid(mapOctoPrint({ job: fixture("octoprint-1.11-job.idle.json"), printer }, AT));
  assert.equal(idle.state, "idle");
  assert.equal(idle.job, undefined);
  assert.deepEqual(idle.temps, { nozzle: { actual: 21.3, target: 0 }, bed: { actual: 21.3, target: 0 } });
  for (const name of ["octoprint-1.11-job.printing.json", "octoprint-1.8-job.printing.json"]) {
    const printing = valid(mapOctoPrint({ job: fixture(name) }, AT));
    assert.equal(printing.state, "printing");
    assert.equal(printing.job.name, "kan216-long.gcode");
    assert.ok(printing.job.progress > 0 && printing.job.progress < 100, "completion is a 0-100 percentage");
    assert.equal(printing.temps, undefined, "a 409 from /api/printer omits temperatures");
  }
});

test("OctoPrint: finished at 100%, cancelled from print history, errors and every state string", () => {
  const file = { name: "checked-1-part.gcode", path: "checked-1-part.gcode", origin: "local" };
  const finished = valid(mapOctoPrint({ job: { state: "Operational", job: { file }, progress: { completion: 100, printTime: 600, printTimeLeft: 0 } } }, AT));
  assert.equal(finished.state, "finished");
  assert.deepEqual(finished.job, { name: "checked-1-part.gcode", progress: 100, elapsedSec: 600, remainingSec: 0 });
  const nullProgress = { completion: null, printTime: null, printTimeLeft: null };
  const cancelled = valid(mapOctoPrint({ job: { state: "Operational", job: { file }, progress: nullProgress }, lastPrint: { success: false } }, AT));
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.job.name, "checked-1-part.gcode");
  assert.equal(valid(mapOctoPrint({ job: { state: "Operational", job: { file }, progress: nullProgress }, lastPrint: { success: true } }, AT)).state, "idle");
  const failed = valid(mapOctoPrint({ job: { state: "Error", error: "Thermal runaway", job: { file }, progress: { completion: 42 } } }, AT));
  assert.equal(failed.state, "failed");
  assert.deepEqual(failed.problems, [{ code: "octoprint.error", severity: "error", message: "Thermal runaway" }]);
  const expected = {
    Operational: "idle", Printing: "printing", "Printing from SD": "printing", Finishing: "printing", Resuming: "printing",
    Starting: "preparing", "Starting print from SD": "preparing", Pausing: "paused", Paused: "paused", Cancelling: "cancelled",
    Error: "failed", Offline: "offline", "Opening serial connection": "busy", Connecting: "busy",
    "Detecting serial connection": "busy", "Sending file to SD": "busy", "Transferring file to SD": "busy", "Unknown State (x)": "busy",
  };
  for (const [text, state] of Object.entries(expected)) assert.equal(octoPrintState(text, undefined, true), state, text);
  const pausing = valid(mapOctoPrint({ job: { state: "Pausing", job: { file }, progress: { completion: 8 } } }, AT));
  assert.deepEqual([pausing.state, pausing.job.stage], ["paused", "Pausing"]);
  assert.equal(valid(mapOctoPrint({ job: { state: "Paused", job: { file }, progress: { completion: 8 } } }, AT)).job.stage, undefined);
  assert.equal(octoPrintState("Offline after error", undefined, true), "failed");
  assert.equal(octoPrintState("Offline after error", undefined, false), "offline");
});

test("Klipper: recorded idle, printing, paused and cancelled object queries", () => {
  const status = (name) => fixture(`moonraker-objects-query.${name}.json`).result.status;
  const idle = valid(mapMoonraker(status("idle"), undefined, AT));
  assert.equal(idle.state, "idle");
  assert.equal(idle.job, undefined);
  const printing = valid(mapMoonraker(status("printing"), undefined, AT));
  assert.equal(printing.state, "printing");
  assert.equal(printing.job.name, "kan216-long.gcode");
  assert.equal(printing.job.progress, 8.2, "display_status.progress x 100");
  assert.equal(valid(mapMoonraker(status("paused"), undefined, AT)).state, "paused");
  const cancelled = valid(mapMoonraker(status("cancelled"), undefined, AT));
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.job.name, "kan216-long.gcode");
  assert.equal(cancelled.job.progress, 0, "falls back to virtual_sdcard.progress when display_status is absent");
});

test("Klipper: layers, remaining from the slicer estimate, complete, error and Klippy shutdown", () => {
  const base = {
    print_stats: { state: "printing", filename: "parts/checked-1-bracket.gcode", print_duration: 1200, message: "", info: { current_layer: 12, total_layer: 80 } },
    display_status: { progress: 0.25 }, webhooks: { state: "ready" },
    extruder: { temperature: 214.96, target: 215 }, heater_bed: { temperature: 60, target: 60 },
  };
  const printing = valid(mapMoonraker(base, 4800, AT));
  assert.deepEqual(printing.job, { name: "checked-1-bracket.gcode", progress: 25, elapsedSec: 1200, remainingSec: 3600, layer: 12, totalLayers: 80 });
  assert.deepEqual(printing.temps, { nozzle: { actual: 215, target: 215 }, bed: { actual: 60, target: 60 } });
  assert.equal(valid(mapMoonraker(base, 600, AT)).job.remainingSec, 0, "an estimate below elapsed time clamps to 0");
  const complete = valid(mapMoonraker({ ...base, print_stats: { ...base.print_stats, state: "complete" } }, 4800, AT));
  assert.equal(complete.state, "finished");
  assert.equal(complete.job.progress, 100);
  const error = valid(mapMoonraker({ ...base, print_stats: { ...base.print_stats, state: "error", message: "Heater extruder not heating at expected rate" } }, undefined, AT));
  assert.equal(error.state, "failed");
  assert.deepEqual(error.problems, [{ code: "klipper.print_stats", severity: "error", message: "Heater extruder not heating at expected rate" }]);
  const shutdown = valid(mapMoonraker({ ...base, webhooks: { state: "shutdown", state_message: "MCU 'mcu' shutdown: Timer too close" } }, undefined, AT));
  assert.equal(shutdown.state, "busy", "webhooks.state other than ready is busy (PRD §8.4)");
  assert.deepEqual(shutdown.problems, [{ code: "klipper.shutdown", severity: "fatal", message: "MCU 'mcu' shutdown: Timer too close" }]);
});

test("PrusaLink: every printer.state, long file names, job id and ATTENTION/ERROR problems", () => {
  const job = { id: 42, state: "PRINTING", progress: 37.5, time_remaining: 1800, time_printing: 1080,
    file: { name: "CHECKE~1.GCO", display_name: "checked-1-bracket.gcode", path: "/usb" } };
  const status = (state) => ({ printer: { state, temp_nozzle: 214.8, target_nozzle: 215, temp_bed: 59.9, target_bed: 60 },
    job: { id: 42, progress: 37.5, time_remaining: 1800, time_printing: 1080 } });
  const printing = valid(mapPrusaLink(status("PRINTING"), job, AT));
  assert.deepEqual(printing.job, { name: "checked-1-bracket.gcode", id: "42", progress: 37.5, elapsedSec: 1080, remainingSec: 1800 });
  assert.deepEqual(printing.temps, { nozzle: { actual: 214.8, target: 215 }, bed: { actual: 59.9, target: 60 } });
  const expected = { PRINTING: "printing", PAUSED: "paused", FINISHED: "finished", STOPPED: "cancelled", ERROR: "failed", ATTENTION: "paused", IDLE: "idle", READY: "idle", BUSY: "busy" };
  for (const [state, mapped] of Object.entries(expected)) assert.equal(valid(mapPrusaLink(status(state), job, AT)).state, mapped, state);
  assert.equal(valid(mapPrusaLink(status("ATTENTION"), job, AT)).problems[0].code, "prusalink.attention");
  assert.equal(valid(mapPrusaLink(status("ERROR"), job, AT)).problems[0].severity, "error");
  assert.equal(valid(mapPrusaLink(status("PRINTING"), { ...job, file: { name: "SHORT~1.GCO" } }, AT)).job.name, "SHORT~1.GCO");
  assert.equal(valid(mapPrusaLink({ printer: { state: "IDLE" } }, undefined, AT)).job, undefined);
});

test("Duet: processing, paused, last-file outcomes, halted, message boxes and null estimates", () => {
  const active = { file: { fileName: "0:/gcodes/checked-1-bracket.gcode", size: 4000, numLayers: 80 }, filePosition: 1000, duration: 900,
    layer: 20, timesLeft: { file: 2800, filament: null, slicer: 2700 } };
  const printing = valid(mapDuet({ status: "processing" }, active, AT));
  assert.deepEqual(printing.job, { name: "checked-1-bracket.gcode", progress: 25, elapsedSec: 900, remainingSec: 2700, layer: 20, totalLayers: 80 });
  assert.equal(valid(mapDuet({ status: "processing" }, { ...active, timesLeft: { file: 2800, slicer: null } }, AT)).job.remainingSec, 2800);
  assert.equal(valid(mapDuet({ status: "processing" }, { ...active, timesLeft: { file: null, slicer: null } }, AT)).job.remainingSec, undefined);
  assert.equal(valid(mapDuet({ status: "pausing" }, active, AT)).state, "paused");
  const last = { file: { fileName: null }, lastFileName: "0:/gcodes/checked-1-bracket.gcode", lastDuration: 3600,
    lastFileAborted: false, lastFileCancelled: false, lastFileSimulated: false };
  const finished = valid(mapDuet({ status: "idle" }, last, AT));
  assert.equal(finished.state, "finished");
  assert.deepEqual(finished.job, { name: "checked-1-bracket.gcode", progress: 100, elapsedSec: 3600, remainingSec: 0 });
  assert.equal(valid(mapDuet({ status: "idle" }, { ...last, lastFileCancelled: true }, AT)).state, "cancelled");
  assert.equal(valid(mapDuet({ status: "idle" }, { ...last, lastFileAborted: true }, AT)).state, "failed");
  assert.equal(valid(mapDuet({ status: "idle" }, { ...last, lastFileSimulated: true }, AT)).state, "idle");
  assert.equal(valid(mapDuet({ status: "idle" }, { file: {}, lastFileName: null }, AT)).state, "idle");
  const halted = valid(mapDuet({ status: "halted" }, active, AT));
  assert.equal(halted.state, "failed");
  assert.equal(halted.problems[0].severity, "fatal");
  const box = valid(mapDuet({ status: "paused", messageBox: { mode: 2, title: "Filament", message: "Load new filament", seq: 3 }, displayMessage: "Changing filament" }, active, AT));
  assert.deepEqual(box.problems, [
    { code: "duet.messageBox", severity: "warning", message: "Filament: Load new filament" },
    { code: "duet.displayMessage", severity: "info", message: "Changing filament" },
  ]);
  for (const status of ["off", "disconnected"]) assert.equal(valid(mapDuet({ status }, {}, AT)).state, "offline");
  for (const status of ["starting", "updating", "simulating"]) assert.equal(valid(mapDuet({ status }, {}, AT)).state, "busy");
});

test("Repetier: listPrinter printing, paused, idle and offline; remaining = printTime - printedTimeComp", () => {
  const entry = { slug: "mk3", name: "MK3", online: 1, active: true, job: "checked-1-bracket.gcode", jobid: 17, done: 33.333,
    paused: false, printTime: 5400, printedTimeComp: 1800 };
  const printing = valid(mapRepetier(entry, AT));
  assert.deepEqual(printing.job, { name: "checked-1-bracket.gcode", id: "17", progress: 33.3, elapsedSec: 1800, remainingSec: 3600 });
  assert.equal(valid(mapRepetier({ ...entry, paused: true }, AT)).state, "paused");
  assert.equal(valid(mapRepetier({ ...entry, job: "none" }, AT)).state, "idle");
  assert.equal(valid(mapRepetier({ ...entry, job: "none" }, AT)).job, undefined);
  assert.equal(valid(mapRepetier({ ...entry, online: 0 }, AT)).state, "offline");
  assert.equal(valid(mapRepetier({ slug: "mk3", online: 1, job: "a.gcode" }, AT)).job.remainingSec, undefined);
});

test("Bambu: gcode_state map, cancel as 0300400C, HMS codes, severities, urls and AMS tray", () => {
  const raw = { gcode_state: "RUNNING", subtask_name: "bracket", task_id: "123456", mc_percent: 40, mc_remaining_time: 25,
    layer_num: 10, total_layer_num: 100, print_error: 0, hms: [{ attr: 0x03001800, code: 0x00010003 }, { attr: 0x07000300, code: 0x00030001 }],
    nozzle_temper: 220.1, nozzle_target_temper: 220, bed_temper: 60, bed_target_temper: 60, chamber_temper: 5,
    ams: { tray_now: "5", ams: [{ id: "1", tray: [{ id: "1", tray_type: "PETG", tray_color: "FF8800FF" }] }] } };
  const printing = valid(mapBambu(raw, AT, { connected: true, model: "p1s" }));
  // A raw G-code print reports only gcode_file; job.name is its basename, the jobName that upload/start return.
  const { subtask_name: _project, ...rawGcode } = raw;
  assert.equal(valid(mapBambu({ ...rawGcode, gcode_file: "cache/checked-123-part.gcode" }, AT, { connected: true })).job.name, "checked-123-part.gcode");
  assert.equal(printing.state, "printing");
  assert.deepEqual(printing.job, { name: "bracket", id: "123456", progress: 40, remainingSec: 1500, layer: 10, totalLayers: 100 });
  assert.equal(printing.temps.chamber, undefined, "P1S reports a constant chamber value");
  assert.deepEqual(printing.activeFilament, { slot: "5", material: "PETG", color: "#FF8800" });
  assert.deepEqual(printing.problems, [
    { code: "0300_1800_0001_0003", severity: "fatal", message: "HMS 0300_1800_0001_0003", url: "https://e.bambulab.com/index.php?e=0300180000010003&s=device_hms&lang=en" },
    { code: "0700_0300_0003_0001", severity: "warning", message: "HMS 0700_0300_0003_0001", url: "https://e.bambulab.com/index.php?e=0700030000030001&s=device_hms&lang=en" },
  ]);
  const cancelled = valid(mapBambu({ ...raw, gcode_state: "FAILED", print_error: 0x0300400c, hms: [] }, AT, { connected: true }));
  assert.equal(cancelled.state, "cancelled");
  assert.deepEqual(cancelled.problems, []);
  assert.equal(valid(mapBambu({ ...raw, gcode_state: "FAILED", print_error: 0, fail_reason: "50348044", hms: [] }, AT, { connected: true })).state, "cancelled");
  const failed = valid(mapBambu({ ...raw, gcode_state: "FAILED", print_error: 0x0500c010, hms: [] }, AT, { connected: true }));
  assert.equal(failed.state, "failed");
  assert.deepEqual(failed.problems, [{ code: "0500C010", severity: "error", message: "Printer error 0500C010" }]);
  for (const [state, mapped] of Object.entries({ IDLE: "idle", PREPARE: "preparing", SLICING: "preparing", PAUSE: "paused", FINISH: "finished", INIT: "busy" })) {
    assert.equal(valid(mapBambu({ ...raw, gcode_state: state }, AT, { connected: true })).state, mapped, state);
  }
  assert.equal(valid(mapBambu({ ...raw, gcode_state: "IDLE" }, AT, { connected: true })).job, undefined);
  assert.equal(valid(mapBambu({ ...raw, task_id: "0" }, AT, { connected: true })).job.id, undefined);
  assert.deepEqual(valid(mapBambu({ ...raw, ams: { tray_now: "254" }, vt_tray: { tray_type: "PLA", tray_color: "000000FF" } }, AT, { connected: true })).activeFilament, { slot: "ext", material: "PLA", color: "#000000" });
  assert.deepEqual(valid(mapBambu(undefined, AT, { connected: false })), { contract: "counterpart/1", observedAt: AT, state: "offline", problems: [] });
  // AMS-HT, dual-nozzle external spools and V2 device.extruder reports (Bambu Studio DevExtruderSystem.cpp ParseV2_0).
  const ht = { ...raw, ams: { tray_now: "128", ams: [{ id: "128", tray: [{ id: "0", tray_type: "PA-CF", tray_color: "222222FF" }] }] } };
  assert.deepEqual(valid(mapBambu(ht, AT, { connected: true })).activeFilament, { slot: "128", material: "PA-CF", color: "#222222" });
  const v2 = { ...raw, nozzle_temper: 1, nozzle_target_temper: 1,
    vir_slot: [{ id: "254", tray_type: "TPU", tray_color: "00FF00FF" }, { id: "255", tray_type: "PLA", tray_color: "FFFFFFFF" }],
    device: { extruder: { state: 0x10, info: [{ id: 0, temp: (220 << 16) | 215, snow: 0x0002 }, { id: 1, temp: (250 << 16) | 249, snow: (254 << 8) }] } } };
  const right = valid(mapBambu(v2, AT, { connected: true }));
  assert.deepEqual(right.temps.nozzle, { actual: 249, target: 250 }, "active extruder (state >> 4) & 0xF is 1");
  assert.deepEqual(right.activeFilament, { slot: "254", material: "TPU", color: "#00FF00" });
  const left = valid(mapBambu({ ...v2, device: { extruder: { ...v2.device.extruder, state: 0x00 } } }, AT, { connected: true }));
  assert.deepEqual(left.temps.nozzle, { actual: 215, target: 220 });
  assert.deepEqual(left.activeFilament, { slot: "2" }, "AMS 0 tray 2; no tray data in this report");
  assert.equal(valid(mapBambu({ ...v2, device: { extruder: { state: 0x00, info: [{ id: 0, temp: 0, snow: 0xffff }, { id: 1 }] } } }, AT, { connected: true })).activeFilament, undefined);
});

test("Creality device API fallback reads only recognized states and numeric progress", () => {
  assert.equal(valid(mapCrealityDevice({ state: "printing", filename: "/usb/part.gcode", progress: 12 }, AT)).job.name, "part.gcode");
  assert.equal(valid(mapCrealityDevice({ status: "paused" }, AT)).state, "paused");
  assert.equal(valid(mapCrealityDevice({ temperature: 20 }, AT)).state, "busy");
});

test("helpers: job names are file names, and compact drops null, NaN and empty objects", () => {
  assert.equal(remoteJobName("0:/gcodes/sub/x.gcode"), "x.gcode");
  assert.equal(remoteJobName("folder\\y.gcode"), "y.gcode");
  assert.equal(remoteJobName("  "), undefined);
  assert.deepEqual(compact({ a: null, b: NaN, c: { d: undefined }, e: [], f: 0, g: "" }), { e: [], f: 0, g: "" });
});
