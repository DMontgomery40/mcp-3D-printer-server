import {trackedMkdtemp} from './support/temp.mjs';
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Ported from bambu-printer-mcp tests/filament-inventory.test.mjs. The printer
// report is a fixture (BambuImplementation.getStatus is replaced before the
// server starts); profiles come from a fixture slicer tree. No printer is contacted.
const serverEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const printerModule = new URL("../dist/printers/bambu.js", import.meta.url).href;

const ONE_TRAY = {
  connected: true, model: "P1S", status: "IDLE",
  ams: { tray_now: "255", ams: [{ id: "0", tray: [{ id: "0", state: 11, tray_info_idx: "GFL99", tray_type: "PLA", tray_color: "FFFFFFFF", remain: -1 }] }] },
};

async function inventoryFixture(t, { binary, profiles, slicerType = "bambustudio", override = false, missing = false, invalidDirectory = false, status = ONE_TRAY, colourCodes, tool = "get_printer_filaments", args = {} }) {
  const root = await trackedMkdtemp(path.join(os.tmpdir(), "bambu-filament-inventory-"));
  const client = new Client({ name: "filament-inventory-test", version: "1" });
  t.after(async () => {
    await client.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const executable = path.join(root, binary);
  const profilesRoot = path.join(root, profiles);
  const filamentDir = path.join(profilesRoot, "BBL", "filament");
  await fs.mkdir(path.dirname(executable), { recursive: true });
  await fs.writeFile(executable, "fixture executable; must never be launched");
  await fs.mkdir(path.join(profilesRoot, "BBL", "machine"), { recursive: true });
  await fs.mkdir(filamentDir, { recursive: true });
  if (colourCodes) await fs.writeFile(path.join(filamentDir, "filaments_color_codes.json"), JSON.stringify({ data: colourCodes }));
  await fs.writeFile(path.join(filamentDir, "Generic PLA @base.json"), JSON.stringify({ name: "Generic PLA @base", filament_id: "GFL99" }));
  await fs.writeFile(path.join(filamentDir, "Generic PETG @base.json"), JSON.stringify({ name: "Generic PETG @base", filament_id: "GFG99" }));
  const expectedProfile = path.join(filamentDir, "Generic PLA @BBL P1S.json");
  await fs.writeFile(expectedProfile, JSON.stringify({ name: "Generic PLA @BBL P1S", inherits: "Generic PLA @base" }));
  if (invalidDirectory) {
    await fs.rm(filamentDir, { recursive: true });
    await fs.writeFile(filamentDir, "not a profile directory");
  }
  const preload = `
    import { BambuImplementation } from ${JSON.stringify(printerModule)};
    BambuImplementation.prototype.getStatus = async () => (${JSON.stringify({ ...status, raw: { ...status.raw, ams: status.ams } })});
  `;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", `data:text/javascript;base64,${Buffer.from(preload).toString("base64")}`, serverEntry],
    cwd: root,
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio", PRINTER_TYPE: "bambu", PRINTER_HOST: "127.0.0.1",
      BAMBU_SERIAL: "TEST_SERIAL", BAMBU_TOKEN: "TEST_TOKEN", BAMBU_MODEL: "p1s",
      SLICER_TYPE: slicerType, SLICER_PATH: executable,
      BAMBU_PROFILES_ROOT: missing ? path.join(root, "missing-profiles") : override ? profilesRoot : "",
    },
    stderr: "pipe",
  });
  await client.connect(transport);
  const result = await client.callTool({ name: tool, arguments: args });
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return { inventory: result.structuredContent, text: JSON.parse(result.content[0].text), expectedProfile };
}

for (const [name, options] of [
  ["Windows installation", { binary: "Bambu Studio/bambu-studio.exe", profiles: "Bambu Studio/resources/profiles" }],
  ["macOS bundle", { binary: "BambuStudio.app/Contents/MacOS/BambuStudio", profiles: "BambuStudio.app/Contents/Resources/profiles" }],
  ["Linux installation", { binary: "prefix/bin/bambu-studio", profiles: "prefix/share/BambuStudio/profiles" }],
  ["selected Orca installation", { binary: "OrcaSlicer/OrcaSlicer.exe", profiles: "OrcaSlicer/resources/profiles", slicerType: "orcaslicer" }],
  ["explicit profile root", { binary: "selected/bambu-studio.exe", profiles: "custom profiles", override: true }],
]) {
  test(`Bambu filament inventory resolves profiles from the ${name}`, async t => {
    const { inventory, text, expectedProfile } = await inventoryFixture(t, options);
    assert.deepEqual(inventory, text, "structuredContent and the text are the same result");
    assert.equal(inventory.summary.loaded_slots, 1);
    assert.equal(inventory.summary.resolved_profile_slots, 1);
    assert.equal(await fs.realpath(inventory.trays[0].resolved_profile_path), await fs.realpath(expectedProfile));
    assert.equal(inventory.trays[0].profile_resolution, "model");
    assert.equal(inventory.trays[0].slot, 0);
    assert.equal(inventory.trays[0].tray_color, "FFFFFFFF");
    assert.equal(inventory.recommended.load_filaments, inventory.trays[0].resolved_profile_path);
    assert.deepEqual(inventory.slots, [{ id: "0", material: "PLA", color: "#FFFFFF", name: "PLA", label: "A1", filamentId: "GFL99", source: "printer", profile: inventory.trays[0].resolved_profile_path }]);
  });
}

test("Bambu filament inventory does not borrow profiles when its explicit root is missing", async t => {
  const { inventory } = await inventoryFixture(t, { binary: "Bambu Studio/bambu-studio.exe", profiles: "Bambu Studio/resources/profiles", missing: true });
  assert.equal(inventory.summary.loaded_slots, 1);
  assert.equal(inventory.summary.resolved_profile_slots, 0);
  assert.equal(inventory.trays[0].resolved_profile_path, null);
  assert.equal(inventory.recommended, null);
  assert.equal(inventory.slots[0].profile, undefined, "slots never carry null");
});

test("Bambu filament inventory remains available when the profile directory cannot be read", async t => {
  const { inventory } = await inventoryFixture(t, { binary: "Bambu Studio/bambu-studio.exe", profiles: "Bambu Studio/resources/profiles", invalidDirectory: true });
  assert.equal(inventory.summary.loaded_slots, 1);
  assert.equal(inventory.trays[0].resolved_profile_path, null);
});

test("Bambu filament inventory reports every AMS unit, empty trays, and the external spool", async t => {
  const status = {
    connected: true, model: "P1S", status: "IDLE",
    ams: {
      tray_now: "5",
      ams: [
        { id: "0", tray: [{ id: "0", state: 11, tray_info_idx: "GFL99", tray_type: "PLA", tray_color: "000000FF" }, { id: "1", state: 0 }] },
        { id: "1", tray: [{ id: "1", state: 11, tray_info_idx: "GFG99", tray_type: "PETG", tray_sub_brands: "PETG HF", tray_color: "FF0000FF", remain: 80 }] },
      ],
    },
    raw: { vt_tray: { id: "254", tray_type: "TPU", tray_info_idx: "GFU99", tray_color: "00FF00FF" } },
  };
  const { inventory } = await inventoryFixture(t, { binary: "Bambu Studio/bambu-studio.exe", profiles: "Bambu Studio/resources/profiles", status });
  assert.deepEqual(inventory.trays.map(tray => [tray.slot, tray.loaded]), [[0, true], [1, false], [5, true]], "trays are bambu-printer-mcp's AMS list");
  assert.equal(inventory.current_slot, 5);
  assert.equal(inventory.current_source, "ams");
  assert.equal(inventory.summary.empty_slots, 1);
  assert.equal(inventory.trays[2].display_name, "PETG HF PETG #ff0000");
  assert.equal(inventory.trays[2].remain_percent, 80);
  assert.equal(inventory.trays[2].profile_resolution, "generic");
  assert.deepEqual(inventory.slots.map(slot => [slot.id, slot.material, slot.color]), [["0", "PLA", "#000000"], ["5", "PETG", "#FF0000"], ["254", "TPU", "#00FF00"]]);
  assert.deepEqual(inventory.slots.map(slot => [slot.label, slot.name]), [["A1", "PLA"], ["B2", "PETG HF"], ["External", "TPU"]], "labels and names a person reads");
});

test("an AMS-HT slot is the unit id print_3mf takes (128), not ams_id × 4 + tray", async t => {
  const status = { connected: true, model: "H2D", status: "IDLE", ams: { ams: [{ id: "128", tray: [{ id: "0", state: 11, tray_info_idx: "GFL99", tray_type: "PLA", tray_color: "FFFFFFFF" }] }] } };
  const { inventory } = await inventoryFixture(t, { binary: "Bambu Studio/bambu-studio.exe", profiles: "Bambu Studio/resources/profiles", status });
  assert.deepEqual(inventory.slots.map(slot => [slot.id, slot.label]), [["128", "AMS HT A"]]);
});

test("Bambu filament inventory reports both external spools of a dual-nozzle printer", async t => {
  const status = {
    connected: true, model: "H2D", status: "IDLE", ams: { ams: [{ id: "0", tray: [{ id: "0", state: 11, tray_info_idx: "GFL99", tray_type: "PLA", tray_color: "FFFFFFFF" }] }] },
    raw: { vir_slot: [{ id: "255", tray_type: "PLA", tray_info_idx: "GFL99", tray_color: "FFFFFFFF" }, { id: "254", tray_type: "" }] },
  };
  const { inventory } = await inventoryFixture(t, { binary: "Bambu Studio/bambu-studio.exe", profiles: "Bambu Studio/resources/profiles", status });
  assert.deepEqual(inventory.slots.map(slot => slot.id), ["0", "255"], "an external spool of unknown type is not loaded");
  assert.deepEqual(inventory.slots.map(slot => slot.label), ["A1", "Right external"], "255 feeds the right nozzle");
});

test("counterpart_propose_filaments: Bambu spools with Studio's colour names, the AMS and the external spool as separate feeds", async t => {
  const status = {
    connected: true, model: "P1S", status: "IDLE",
    ams: { ams: [{ id: "0", tray: [{ id: "0", state: 11, tray_info_idx: "GFL99", tray_type: "PLA", tray_color: "000000FF" }, { id: "1", state: 11, tray_info_idx: "GFL99", tray_type: "PLA", tray_color: "FEC600FF" }] }] },
    raw: { vt_tray: { tray_type: "PLA", tray_info_idx: "GFL99", tray_color: "FFFFFFFF" } },
  };
  const colourCodes = [
    { fila_id: "GFL99", fila_color: ["#000000FF"], fila_color_name: { en: "Black" } },
    { fila_id: "GFL99", fila_color: ["#FEC600FF"], fila_color_name: { en: "Sunflower Yellow" } },
    { fila_id: "GFL99", fila_color: ["#FFFFFFFF"], fila_color_name: { en: "White" } },
  ];
  const { inventory: proposal } = await inventoryFixture(t, { binary: "Bambu Studio/bambu-studio.exe", profiles: "Bambu Studio/resources/profiles", status, colourCodes,
    tool: "counterpart_propose_filaments", args: { filaments: [{ index: 1, name: "body", colour: "#000000", material: "PLA" }, { index: 2, name: "markings", colour: "#FFFFFF", material: "PLA" }] } });
  assert.deepEqual(proposal.trays.map(tray => [tray.slot, tray.label, tray.name, tray.feed]),
    [[0, "A1", "Black PLA", "ams"], [1, "A2", "Sunflower Yellow PLA", "ams"], [254, "External", "White PLA", "external"]]);
  assert.ok(proposal.trays.every(tray => tray.sliceable && tray.profile), "each spool carries the profile slice_stl takes");
  assert.deepEqual(proposal.proposal.map(row => [row.slot, row.verdict]), [[0, "same-colour"], [1, "closest"]]);
  assert.equal(proposal.proposal[1].note, "White is loaded on External, but one print feeds from one source. Closest here: A2 Sunflower Yellow PLA.");
  assert.deepEqual(proposal.mapping, [{ index: 1, slot: 0 }, { index: 2, slot: 1 }]);
});

test("counterpart_propose_filaments never offers a sliced file's colours on a dual-nozzle printer's two external spools as printable", async t => {
  const status = {
    connected: true, model: "H2D", status: "IDLE", ams: { ams: [] },
    raw: { vir_slot: [{ id: "255", tray_type: "PLA", tray_info_idx: "GFL99", tray_color: "FFFFFFFF" }, { id: "254", tray_type: "PLA", tray_info_idx: "GFL99", tray_color: "000000FF" }] },
  };
  const { inventory: proposal } = await inventoryFixture(t, { binary: "Bambu Studio/bambu-studio.exe", profiles: "Bambu Studio/resources/profiles", status,
    tool: "counterpart_propose_filaments", args: { sliced: true, filaments: [{ index: 1, colour: "#FFFFFF", material: "PLA" }] } });
  assert.deepEqual(proposal.trays.map(tray => [tray.slot, tray.label]), [[255, "Right external"], [254, "Left external"]]);
  assert.equal(proposal.mapping, undefined);
  assert.deepEqual(proposal.problems.map(problem => problem.code), ["external-nozzle-unverified"]);
});
