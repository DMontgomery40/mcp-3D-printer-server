// get_printer_filaments slots[].profile: the installed slicer filament profile
// for a material, resolved from fake OrcaSlicer and PrusaSlicer trees.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveFilamentProfile } from "../../dist/slicer/filament-profiles.js";

async function tree(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "filament-profiles-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(files)) {
    const full = path.join(root, file);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, typeof content === "string" ? content : JSON.stringify(content));
  }
  return (file) => path.join(root, file);
}

const ORCA = {
  "bundle/Prusa/filament/fdm_filament_pla.json": { name: "fdm_filament_pla", instantiation: "false", filament_type: ["PLA"] },
  "bundle/Prusa/filament/Prusa Generic PLA.json": { name: "Prusa Generic PLA", inherits: "fdm_filament_pla", instantiation: "true", compatible_printers: ["Prusa MK4 0.4 nozzle"] },
  "bundle/Creality/filament/Creality PLA.json": { name: "Creality PLA", inherits: "fdm_filament_pla", instantiation: "true", compatible_printers: ["Creality K1 0.4 nozzle"] },
  "bundle/OrcaFilamentLibrary/filament/base/Generic PLA @base.json": { name: "Generic PLA @base", filament_type: ["PLA"], instantiation: "true" },
  "bundle/OrcaFilamentLibrary/filament/Generic PLA @System.json": { name: "Generic PLA @System", inherits: "Generic PLA @base", instantiation: "true", compatible_printers: [] },
  "bundle/OrcaFilamentLibrary/filament/Generic PLA-CF @System.json": { name: "Generic PLA-CF @System", filament_type: ["PLA-CF"], instantiation: "true", compatible_printers: [] },
  "bundle/OrcaFilamentLibrary/filament/Loop A.json": { name: "Loop A", inherits: "Loop B", instantiation: "true" },
  "bundle/OrcaFilamentLibrary/filament/Loop B.json": { name: "Loop B", inherits: "Loop A", instantiation: "true" },
  "bundle/OrcaFilamentLibrary/filament/broken.json": "{ not json",
  "user/default/filament/My PETG.json": { name: "My PETG", inherits: "", filament_type: ["PETG"] },
  "user/default/filament/My PLA.json": { name: "My PLA", inherits: "Generic PLA @System" },
  "machine.json": { type: "machine", name: "My MK4", inherits: "Prusa MK4 0.4 nozzle" },
  "process.json": { type: "process", name: "0.20mm" },
};

test("Orca: the printer's vendor profile wins over a universal one; incompatible, @base and non-instantiable profiles are skipped", async (t) => {
  const at = await tree(t, ORCA);
  const context = { slicerType: "orcaslicer", slicerProfile: `${at("machine.json")};${at("process.json")}`, roots: { system: [at("bundle")], user: [at("user-none")] } };
  assert.equal(await resolveFilamentProfile("pla", context), at("bundle/Prusa/filament/Prusa Generic PLA.json"), "material through inherits, compatible with My MK4's parent");
  // No printer configured: only universal profiles qualify.
  assert.equal(await resolveFilamentProfile("PLA", { ...context, slicerProfile: undefined }), at("bundle/OrcaFilamentLibrary/filament/Generic PLA @System.json"));
  // Exact types only: a PLA spool never gets a PLA-CF profile, and the reverse.
  assert.equal(await resolveFilamentProfile("PLA-CF", context), at("bundle/OrcaFilamentLibrary/filament/Generic PLA-CF @System.json"));
  assert.equal(await resolveFilamentProfile("PLA+", context), undefined);
  assert.equal(await resolveFilamentProfile("TPU", context), undefined, "nothing resolves: absent");
});

test("Orca: a user preset comes before a system one of the same rank", async (t) => {
  const at = await tree(t, ORCA);
  const context = { slicerType: "orcaslicer", roots: { system: [at("bundle")], user: [at("user")] } };
  assert.equal(await resolveFilamentProfile("PLA", context), at("user/default/filament/My PLA.json"));
  assert.equal(await resolveFilamentProfile("petg", context), at("user/default/filament/My PETG.json"));
});

test("PrusaSlicer: filament/*.ini presets, the printer's own before universal ones; condition-only presets rank last", async (t) => {
  const at = await tree(t, {
    "data/filament/Generic PLA.ini": "filament_type = PLA\ncompatible_printers = \ncompatible_printers_condition = \n",
    "data/filament/MK4 PLA.ini": 'filament_type = PLA\ncompatible_printers = "Original Prusa MK4 0.4 nozzle";"Original Prusa MK4S 0.4 nozzle"\n',
    "data/filament/XL PLA.ini": 'filament_type = PLA\ncompatible_printers = "Original Prusa XL 0.4 nozzle"\n',
    "data/filament/Cond PETG.ini": 'filament_type = PETG\ncompatible_printers = \ncompatible_printers_condition = printer_notes=~/.*PRINTER_VENDOR_PRUSA3D.*/\n',
    "data/filament/Plain PETG.ini": "filament_type = PETG\n",
    "data/filament/nested/Hidden PLA.ini": "filament_type = PLA\n",
    "mk4.ini": "printer_settings_id = Original Prusa MK4 0.4 nozzle\nlayer_height = 0.2\n",
    "mini.ini": "printer_settings_id = Original Prusa MINI\n",
  });
  const context = { slicerType: "prusaslicer", slicerProfile: at("mk4.ini"), roots: { system: [], user: [at("data")] } };
  assert.equal(await resolveFilamentProfile("PLA", context), at("data/filament/MK4 PLA.ini"));
  assert.equal(await resolveFilamentProfile("PLA", { ...context, slicerProfile: at("mini.ini") }), at("data/filament/Generic PLA.ini"));
  assert.equal(await resolveFilamentProfile("PETG", context), at("data/filament/Plain PETG.ini"));
});

test("no reported material: the filament slice_stl loads by default, when it exists; other slicers and unreadable trees resolve nothing", async (t) => {
  const at = await tree(t, { "configured.json": { name: "Configured" } });
  const base = { slicerType: "orcaslicer", roots: { system: [at("missing")], user: [at("missing")] } };
  assert.equal(await resolveFilamentProfile(undefined, { ...base, configuredFilaments: [at("configured.json"), "/other.json"] }), at("configured.json"));
  assert.equal(await resolveFilamentProfile(undefined, { ...base, configuredFilaments: [at("gone.json")] }), undefined);
  assert.equal(await resolveFilamentProfile(undefined, base), undefined);
  // A reported material never falls back to a configured profile that may be another material.
  assert.equal(await resolveFilamentProfile("PLA", { ...base, configuredFilaments: [at("configured.json")] }), undefined);
  assert.equal(await resolveFilamentProfile("PLA", { slicerType: "cura", roots: base.roots }), undefined);
  assert.equal(await resolveFilamentProfile("PLA", { slicerType: "orcaslicer", roots: { system: [at("configured.json")], user: ["\0bad"] } }), undefined);
});
