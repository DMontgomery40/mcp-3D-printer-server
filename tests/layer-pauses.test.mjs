import test from "node:test";
import assert from "node:assert/strict";
import { customGcodesWithPauses, layerTops, machinePauseGcode, parsePauseLayers, pausedLayers } from "../dist/slicer/layer-pauses.js";

const gcode = ["; machine_pause_gcode = M400 U1", "; Z_HEIGHT: 0.2", "G1", "; Z_HEIGHT: 0.4", "G1", "; Z_HEIGHT: 0.6", "; PAUSE_PRINTING", "M400 U1", "G1", "; Z_HEIGHT: 0.8"].join("\n");

test("pause layers are whole numbers from 2, deduplicated and sorted", () => {
  assert.deepEqual(parsePauseLayers([5, "3", 5]), [3, 5]);
  assert.deepEqual(parsePauseLayers("4, 2"), [2, 4]);
  assert.equal(parsePauseLayers(undefined), undefined);
  assert.throws(() => parsePauseLayers([1]), /2 or more/);
  assert.throws(() => parsePauseLayers([2.5]), /whole layer numbers/);
});

test("a pause is found in its layer, not in the config block", () => {
  assert.deepEqual(layerTops(gcode), [0.2, 0.4, 0.6, 0.8]);
  assert.deepEqual(pausedLayers(gcode, machinePauseGcode(gcode)), [3]);
});

test("pauses go at the exact layer top and keep the project's colour changes", () => {
  const info = customGcodesWithPauses([0.2, 0.4, 0.6], [3], { mode: "SingleExtruder", gcodes: [{ type: "ColorChange", print_z: 0.4, color: "#FF0000", extruder: 1, extra: "" }] });
  assert.deepEqual(info.gcodes.map(g => [g.type, g.print_z]), [["ColorChange", 0.4], ["PausePrint", 0.6]]);
  assert.throws(() => customGcodesWithPauses([0.2, 0.4], [3]), /has 2 layers/);
});

// Bambu Studio 02.08.02.61 wrote this project itself (CLI --load-custom-gcodes + --export-3mf, Nov 6 2026).
const DESIGNER = new URL("./fixtures/studio-02.08.02.61/designer-colour-change-and-pause.3mf", import.meta.url).pathname;
test("a project's own colour change and pause are read from Studio's custom_gcode_per_layer.xml", async () => {
  const { readProjectCustomGcodes } = await import("../dist/slicer/layer-pauses.js");
  const info = await readProjectCustomGcodes(DESIGNER, 1);
  assert.equal(info.mode, "SingleExtruder");
  assert.deepEqual(info.gcodes.map(g => [g.type, g.print_z, g.color, g.extruder]), [["ColorChange", 0.6, "#FF0000", 1], ["PausePrint", 1, "", 1]]);
  assert.equal(await readProjectCustomGcodes(DESIGNER, 2), undefined);
  const merged = customGcodesWithPauses([0.2, 0.4, 0.6, 0.8, 1.0, 1.2, 1.4, 1.6], [5, 8], info);
  // The requested pause at the project's own pause height is not doubled.
  assert.deepEqual(merged.gcodes.map(g => [g.type, g.print_z]), [["ColorChange", 0.6], ["PausePrint", 1], ["PausePrint", 1.6]]);
});
