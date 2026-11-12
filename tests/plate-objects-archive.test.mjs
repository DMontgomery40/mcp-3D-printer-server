// list_3mf_plate_objects reads the 3MF through the safe archive reader (review finding on scan-to-make#643):
// names that collide by case, as JSZip would silently collapse, are refused.
import { trackedMkdtempSync } from "./support/temp.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import JSZip from "jszip";
import { analyze3MFPlateObjects } from "../dist/3mf_parser.js";

const SLICE_INFO = `<?xml version="1.0"?><config><plate><metadata key="index" value="1"/><metadata key="label_object_enabled" value="true"/><object identify_id="15" name="cube" skipped="false"/></plate></config>`;

test("list_3mf_plate_objects refuses an archive whose entry names collide by case", async (t) => {
  const directory = trackedMkdtempSync(path.join(os.tmpdir(), "plate-objects-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const zip = new JSZip();
  zip.file("3D/3dmodel.model", `<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources/><build/></model>`);
  zip.file("Metadata/slice_info.config", SLICE_INFO);
  zip.file("Metadata/Slice_Info.config", SLICE_INFO.replace("cube", "other"));
  const file = path.join(directory, "collide.gcode.3mf");
  fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" }));
  await assert.rejects(analyze3MFPlateObjects(file, 0), /Print archive safety/);
  // The same file without the colliding name still lists its objects.
  zip.remove("Metadata/Slice_Info.config");
  fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" }));
  assert.deepEqual((await analyze3MFPlateObjects(file, 0)).objects.map(object => object.id), [15]);
});
