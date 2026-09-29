import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  DEFAULT_GENERIC_CEILINGS,
  genericCeilings,
  inspectGcodeThermal,
  scanGcodeThermal,
  validateGenericTemperature,
} from "../../dist/safety/gcode-thermal.js";
import { STLManipulator } from "../../dist/stl/stl-manipulator.js";

for (const name of ["PRINTER_MAX_NOZZLE_TEMP", "PRINTER_MAX_BED_TEMP", "PRINTER_MAX_CHAMBER_TEMP"]) delete process.env[name];

const PLA = "; filament_type = PLA\n";
const inspect = (gcode, options) => inspectGcodeThermal(gcode, options);

test("default generic ceilings are nozzle 300, bed 120, chamber 60 and only server env changes them", () => {
  assert.deepEqual(genericCeilings({}), { nozzle: 300, bed: 120, chamber: 60 });
  assert.deepEqual(DEFAULT_GENERIC_CEILINGS, { nozzle: 300, bed: 120, chamber: 60 });
  assert.deepEqual(genericCeilings({ PRINTER_MAX_NOZZLE_TEMP: "285", PRINTER_MAX_BED_TEMP: "100", PRINTER_MAX_CHAMBER_TEMP: "0" }), { nozzle: 285, bed: 100, chamber: 0 });
  for (const value of ["abc", "-5", "600", "1e3", "NaN", "Infinity"]) {
    assert.throws(() => genericCeilings({ PRINTER_MAX_NOZZLE_TEMP: value }), /PRINTER_MAX_NOZZLE_TEMP/, value);
  }
});

test("manual targets must be finite nonnegative numbers; heater-off needs nothing", () => {
  for (const value of [Number.NaN, Infinity, -1, "220", "not-a-number", null, undefined, {}]) {
    assert.throws(() => validateGenericTemperature("nozzle", value, ["PLA"]), /finite/, String(value));
  }
  for (const heater of ["nozzle", "bed", "chamber"]) assert.equal(validateGenericTemperature(heater, 0, undefined), 0);
});

test("independent nozzle, bed and chamber ceilings and material limits reject over-temperature targets", () => {
  assert.throws(() => validateGenericTemperature("nozzle", 301, ["PC"]), /300 C server ceiling/);
  assert.throws(() => validateGenericTemperature("bed", 121, undefined), /120 C server ceiling/);
  assert.throws(() => validateGenericTemperature("chamber", 61, undefined), /60 C server ceiling/);
  assert.throws(() => validateGenericTemperature("nozzle", 270, ["PLA"]), /PLA nozzle temperature 270 C exceeds the independent 260 C/);
  assert.throws(() => validateGenericTemperature("nozzle", 200, undefined), /declared material/);
  assert.throws(() => validateGenericTemperature("nozzle", 200, ["UnknownBlend"]), /unknown material/);
  assert.equal(validateGenericTemperature("nozzle", 250, ["PETG"]), 250);
  assert.equal(validateGenericTemperature("bed", 110, undefined), 110);
  const lowered = { nozzle: 240, bed: 80, chamber: 0 };
  assert.throws(() => validateGenericTemperature("nozzle", 245, ["PETG"], lowered), /240 C server ceiling/);
  assert.throws(() => validateGenericTemperature("chamber", 1, undefined, lowered), /0 C server ceiling/);
});

test("every heater command form is inspected: S and R, late targets, tool changes and firmware dialects", () => {
  for (const command of [
    "M104 S400", "M109 R400", "M104 T0 S400", "M104 S220 R400", "N12 M109 R400*77", "m104s400", "M0104 S400",
    "M104 B400 F1", "M140 S130", "M190 R130", "M141 S80", "M191 R80", "M140 P0 H0 S130",
    "G10 P0 S400 R150", "G10 P0 S220:400", "M568 P0 S220 R400",
    "SET_HEATER_TEMPERATURE HEATER=extruder TARGET=400", "SET_HEATER_TEMPERATURE HEATER=heater_bed TARGET=130",
    "SET_HEATER_TEMPERATURE HEATER=chamber TARGET=80", "PRINT_START BED_TEMP=130 EXTRUDER_TEMP=215",
    "PRINT_START BED=60 EXTRUDER=400", "START_PRINT CHAMBER_TEMP=80",
    "M104 S220\n" + "G1 X1 Y1\n".repeat(5000) + "M109 R400",
  ]) {
    assert.throws(() => inspect(PLA + command + "\n"), /exceeds|limit|ceiling/, command);
  }
});

test("RepRapFirmware M568 activation needs a target this file set for that tool", () => {
  // Activation-only commands heat to a stored printer-side value the inspector cannot see.
  for (const command of ["M568 P0 A2", "M568 A2", "M568 P0 A1", "G10 P0 R150\nM568 P0 A2", "G10 P1 S215\nM568 P0 A2", "M568 P0 S215\nM568 P0 A1"]) {
    assert.throws(() => inspect(PLA + command + "\n"), /M568 A[12] activates/, command);
  }
  for (const command of ["G10 P0 S215 R150\nM568 P0 A2", "M568 P0 S215 A2", "G10 P0 S215 R150\nM568 P0 A1", "T0\nM104 S215\nM568 A2", "M568 P0 A0"]) {
    assert.doesNotThrow(() => inspect(PLA + command + "\n"), command);
  }
});

test("dynamic, malformed, ambiguous and program-altering thermal syntax fails closed", () => {
  for (const command of [
    "M104 SNaN", "M104 S", "M104 S-1", "M104 S1e309", "M104 S{nozzle_temperature}", "M109 R[first_layer_temperature]",
    "M104 S220 S230", "M104 S220 X1", "M104 I1", "M140 I0", "M104.1 S200", "M109.2 S200", "G1 X0 M104 S400", "G1 X0 Y0 G10 S400",
    "SET_HEATER_TEMPERATURE HEATER=heater_generic_foo TARGET=50", "SET_HEATER_TEMPERATURE HEATER=extruder TARGET={t}",
    "PRINT_START TEMP=200", "PRINT_START BED_TEMP=[first_layer_bed_temperature]",
    "M303 E0 S210 C8", "M143 H1 S400", "M149 F", "M98 P\"heat.g\"", "M32 \"other.gcode\"", "M28 evil.gcode", "M570 H1 P5",
    "M950 H3 C\"out3\"", "M301 P1 I2 D3", "M144", "M144 S1", "M144 P0 S0",
  ]) {
    assert.throws(() => inspect(PLA + command + "\n"), /Print safety/, command);
  }
  assert.throws(() => inspect(Buffer.from([0x47, 0x31, 0x00, 0x0a])), /binary|malformed/);
  assert.throws(() => inspect(PLA), /no printable commands/);
});

test("comments, display text and non-thermal vendor commands do not create or hide targets", () => {
  const result = inspect(PLA + "; M104 S400\nM117 Heating to M104 S400\nRESPOND MSG=\"M104 S400\"\nM104 S215 ; M104 S400\nG28\nM302 S160\nM862.3 P \"MK4S\"\nEXCLUDE_OBJECT_DEFINE NAME=a CENTER=1,1 POLYGON=[[0,0],[1,1]]\nG10 L2 P1 X0 Y0\nTEMPERATURE_WAIT SENSOR=extruder MINIMUM=200\nBED_MESH_CALIBRATE ADAPTIVE=1\nM104 T0 S0\n");
  assert.equal(result.peaks.nozzle, 215);
  assert.equal(result.materials[0], "PLA");
});

test("positional materials follow tool changes and tool parameters", () => {
  const two = "; filament_type = PLA;PETG\n";
  assert.throws(() => inspect(two + "T0\nM104 S270\n"), /PLA nozzle temperature 270/);
  assert.equal(inspect(two + "T1\nM104 S270\n").peaks.nozzle, 270);
  assert.equal(inspect(two + "M104 T1 S270\n").peaks.nozzle, 270);
  assert.throws(() => inspect(two + "M104 T0 S270\n"), /PLA/);
  // An unknown active tool must satisfy every candidate material.
  assert.throws(() => inspect(two + "M104 S270\n"), /PLA/);
  assert.throws(() => inspect(two + "T5\nM104 S220\n"), /tool 5 has no declared material/);
  assert.throws(() => inspect(two + "SET_HEATER_TEMPERATURE HEATER=extruder TARGET=270\n"), /PLA/);
  assert.equal(inspect(two + "SET_HEATER_TEMPERATURE HEATER=extruder1 TARGET=270\n").peaks.nozzle, 270);
  assert.equal(inspect(two + "G10 P1 S270 R180\n").peaks.nozzle, 270);
});

test("material declarations: file metadata, caller declaration, contradictions and missing materials", () => {
  assert.throws(() => inspect("M104 S215\n"), /declared material/);
  assert.equal(inspect("M104 S215\n", { material: "PLA" }).materialSource, "declared");
  assert.equal(inspect("M140 S60\nG28\n").peaks.bed, 60, "bed-only jobs need no material");
  assert.throws(() => inspect(PLA + "M104 S215\n", { material: "PETG" }), /contradicts/);
  assert.throws(() => inspect("; filament_type = PLA\n; filament_type = ABS\nM104 S215\n"), /contradictory/);
  assert.throws(() => inspect("; filament_type = FLEX\nM104 S220\n"), /unknown material 'FLEX'/);
  assert.equal(inspect("; filament_type = FLEX\nM104 S220\n", { material: "TPU" }).peaks.nozzle, 220);
  assert.throws(() => inspect("M104 S215\n", { material: "Mystery" }), /unknown declared material/);
  assert.throws(() => inspect(PLA + "M104 S270\n", { material: "PLA" }), /260 C/);
});

test("inspection reports the exact byte hash and every peak", () => {
  const source = PLA + "M140 S60\nM104 S200\nM109 R215\nM190 R65\nM141 S40\n";
  const result = inspect(source);
  assert.deepEqual(result.peaks, { nozzle: 215, bed: 65, chamber: 40 });
  assert.match(result.sha256, /^[0-9a-f]{64}$/);
  assert.equal(scanGcodeThermal(source).targets.length, 5);
});

test("confirm_temperatures reports R targets and only matches the true peak (audit repro)", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "confirm-temps-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "audit.gcode");
  await fs.writeFile(file, "M104 S220\nM104 S400\nM109 R450\nM140 S60\nM104 T0 S230\n");
  const manipulator = new STLManipulator(dir);
  const result = await manipulator.confirmTemperatures(file, { extruder: 220, bed: 60 });
  assert.equal(result.match, false, "a later 400 and an R450 target must not match an expected 220");
  assert.deepEqual(result.allTemperatures.extruder, [220, 400, 450, 230]);
  assert.equal(result.peak.extruder, 450);
  assert.equal(result.actual.extruder, 220);
  const peakOnly = await manipulator.confirmTemperatures(file, { extruder: 450 });
  assert.equal(peakOnly.match, true);
});
