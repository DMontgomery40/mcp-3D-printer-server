import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { flattenForCli, detectProfilesRoot } from "../../dist/slicer/profile-flatten.js";
import { STLManipulator } from "../../dist/stl/stl-manipulator.js";
import JSZip from "jszip";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const FIXTURES = path.join(REPO_ROOT, "tests", "fixtures");
const SAMPLE_STL = path.join(REPO_ROOT, "test", "sample_cube.stl");

/* --- Synthetic profile tree helpers -------------------------------------- */

async function makeSyntheticTree() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "flatten-test-"));
  const bbl = path.join(root, "BBL");
  for (const sub of ["machine", "process", "filament"]) {
    await fs.mkdir(path.join(bbl, sub), { recursive: true });
  }
  await writeCliConfig(bbl);
  return { root, bbl };
}

async function writeCliConfig(bbl) {
  await fs.writeFile(path.join(bbl, "cli_config.json"), JSON.stringify({ printer: {
    "Bambu Lab TEST": { machine_limits: { cli_safe_acceleration_x: "6000,6000" } },
    "Bambu Lab TESTDUAL": { machine_limits: { cli_safe_acceleration_x: "6000,6000" } },
  } }));
}

async function writeProfile(dir, kind, data) {
  const p = path.join(dir, kind, `${data.name}.json`);
  await fs.writeFile(p, JSON.stringify(data, null, 2), "utf8");
  return p;
}

function shQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/* --- Tests --------------------------------------------------------------- */

test("flattenForCli rejects non-BBL vendor explicitly", async () => {
  const { root } = await makeSyntheticTree();
  await assert.rejects(
    flattenForCli({
      machineLeaf: "x",
      processLeaf: "y",
      filamentLeaves: ["z"],
      profilesRoot: root,
      tempDir: os.tmpdir(),
      vendor: "Voron",
    }),
    /only BBL vendor is supported/i
  );
});

test("flattenForCli errors clearly when profilesRoot is wrong", async () => {
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), "empty-"));
  await assert.rejects(
    flattenForCli({
      machineLeaf: "x",
      processLeaf: "y",
      filamentLeaves: ["z"],
      profilesRoot: empty,
      tempDir: os.tmpdir(),
    }),
    /does not contain "BBL\/machine"/
  );
});

test("STLManipulator flattening uses the active slicer_path profile root", async (t) => {
  if (process.platform === "win32") {
    t.skip("fake BambuStudio executable is a POSIX shell shim");
    return;
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "active-slicer-root-"));
  const activeApp = path.join(tempDir, "ActiveBambuStudio.app");
  const activeProfilesRoot = path.join(activeApp, "Contents", "Resources", "profiles");
  const activeBbl = path.join(activeProfilesRoot, "BBL");
  const activeBin = path.join(activeApp, "Contents", "MacOS");
  const activeSlicerPath = path.join(activeBin, "BambuStudio");
  const wrongSlicerPath = path.join(tempDir, "WrongBambuStudio.app", "Contents", "MacOS", "BambuStudio");
  const argsFile = path.join(tempDir, "slicer-args.txt");
  const originalEnv = {
    BAMBU_CLI_FLATTEN: process.env.BAMBU_CLI_FLATTEN,
    BAMBU_SLICER_PROFILE_DIRS: process.env.BAMBU_SLICER_PROFILE_DIRS,
    BAMBU_PROFILES_ROOT: process.env.BAMBU_PROFILES_ROOT,
    SLICER_PATH: process.env.SLICER_PATH,
  };
  t.after(async () => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  for (const sub of ["machine", "process", "filament"]) {
    await fs.mkdir(path.join(activeBbl, sub), { recursive: true });
  }
  await writeCliConfig(activeBbl);
  await fs.mkdir(activeBin, { recursive: true });

  await writeProfile(activeBbl, "machine", {
    name: "Bambu Lab TEST 0.4 nozzle",
    inherits: null,
    printer_model: "Bambu Lab TEST",
    printer_settings_id: "Bambu Lab TEST 0.4 nozzle",
    default_print_profile: "0.20mm @TEST",
    default_filament_profile: ["PLA @TEST"],
    nozzle_diameter: ["0.4"],
    default_nozzle_volume_type: ["Standard"],
  });
  await writeProfile(activeBbl, "process", {
    name: "0.20mm @TEST",
    inherits: null,
    layer_height: 0.2,
  });
  await writeProfile(activeBbl, "filament", {
    name: "PLA @TEST",
    inherits: null,
    filament_type: ["PLA"],
  });

  // The shell shim copies a real sliced-project archive (plate G-code present).
  const slicedZip = new JSZip();
  slicedZip.file("Metadata/plate_1.gcode", "; fake plate gcode\n");
  const slicedFixture = path.join(tempDir, "fixture_sliced.3mf");
  await fs.writeFile(slicedFixture, await slicedZip.generateAsync({ type: "nodebuffer" }));

  await fs.writeFile(
    activeSlicerPath,
    [
      "#!/bin/sh",
      `: > ${shQuote(argsFile)}`,
      "outdir=''",
      "export_name=''",
      "while [ \"$#\" -gt 0 ]; do",
      `  printf '%s\\n' "$1" >> ${shQuote(argsFile)}`,
      "  if [ \"$1\" = \"--outputdir\" ]; then",
      "    shift",
      "    outdir=\"$1\"",
      "  elif [ \"$1\" = \"--export-3mf\" ]; then",
      "    shift",
      "    export_name=\"$1\"",
      "  fi",
      "  shift",
      "done",
      "mkdir -p \"$outdir\"",
      `cp ${shQuote(slicedFixture)} "$outdir/$export_name"`,
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
  await fs.chmod(activeSlicerPath, 0o755);

  process.env.BAMBU_CLI_FLATTEN = "true";
  process.env.BAMBU_SLICER_PROFILE_DIRS = activeBbl;
  delete process.env.BAMBU_PROFILES_ROOT;
  process.env.SLICER_PATH = wrongSlicerPath;

  const manipulator = new STLManipulator(path.join(tempDir, "slice-out"));
  await manipulator.sliceSTL(
    SAMPLE_STL,
    "bambustudio",
    activeSlicerPath,
    undefined,
    undefined,
    "Bambu Lab TEST 0.4 nozzle",
    undefined, // legacy filamentProfile argument
    { uptodate: true }
  );

  const args = (await fs.readFile(argsFile, "utf8")).trim().split("\n");
  const loadSettingsIndex = args.indexOf("--load-settings");
  assert.notEqual(loadSettingsIndex, -1, "slicer should receive flattened load-settings");
  const loadSettings = args[loadSettingsIndex + 1];
  assert.match(loadSettings, /flat-machine-/);
  assert.match(loadSettings, /flat-process-/);
  assert.doesNotMatch(loadSettings, /Contents\/Resources\/profiles\/BBL\/machine/);
});

test("inherits chain: child wins on key collision, root parent fills the rest", async () => {
  const { root, bbl } = await makeSyntheticTree();

  // Three-level chain: leaf -> mid -> root.
  await writeProfile(bbl, "machine", {
    name: "root_common",
    inherits: null,
    instantiation: "false",
    nozzle_diameter: ["0.4"],
    extruder_type: ["Direct Drive"],
    default_nozzle_volume_type: ["Standard"],
    only_in_root: "yes",
  });
  await writeProfile(bbl, "machine", {
    name: "mid_common",
    inherits: "root_common",
    instantiation: "false",
    only_in_mid: "mid_value",
    nozzle_diameter: ["0.4"], // identical -- merge no-op
  });
  await writeProfile(bbl, "machine", {
    name: "Bambu Lab TEST 0.4 nozzle",
    inherits: "mid_common",
    instantiation: "true",
    printer_model: "Bambu Lab TEST",
    printer_settings_id: "Bambu Lab TEST 0.4 nozzle",
    only_in_leaf: "leaf_value",
    extruder_type: ["Bowden"], // child wins
  });

  // Minimal process + filament so flattenForCli completes.
  await writeProfile(bbl, "process", {
    name: "0.20mm @TEST",
    inherits: null,
    layer_height: 0.2,
  });
  await writeProfile(bbl, "filament", {
    name: "PLA @TEST",
    inherits: null,
    filament_type: ["PLA"],
  });

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "flat-out-"));
  const result = await flattenForCli({
    machineLeaf: "Bambu Lab TEST 0.4 nozzle",
    processLeaf: "0.20mm @TEST",
    filamentLeaves: ["PLA @TEST"],
    profilesRoot: root,
    tempDir,
  });

  const flat = JSON.parse(await fs.readFile(result.machinePath, "utf8"));

  // Inheritance merging
  assert.equal(flat.only_in_root, "yes", "root key inherited");
  assert.equal(flat.only_in_mid, "mid_value", "mid key inherited");
  assert.equal(flat.only_in_leaf, "leaf_value", "leaf key kept");
  assert.deepEqual(flat.extruder_type, ["Bowden"], "child wins on collision");

  // GUI-only keys stripped (instantiation, setting_id) but inherits is
  // kept and rewritten to the leaf name -- the CLI's compat check uses
  // it as the system_name when from=="User".
  assert.equal(flat.inherits, "Bambu Lab TEST 0.4 nozzle", "inherits rewritten to leaf name");
  assert.ok(!("instantiation" in flat), "instantiation stripped");
  assert.equal(flat.from, "User", "from rewritten to User for CLI");
  assert.equal(flat.printer_settings_id, "Bambu Lab TEST 0.4 nozzle");

  // nozzle_volume_type derived as array from default_nozzle_volume_type
  assert.deepEqual(flat.nozzle_volume_type, ["Standard"]);
});

test("inherits cycle is detected and reported", async () => {
  const { root, bbl } = await makeSyntheticTree();

  await writeProfile(bbl, "machine", {
    name: "A",
    inherits: "B",
    nozzle_diameter: ["0.4"],
  });
  await writeProfile(bbl, "machine", {
    name: "B",
    inherits: "A",
  });
  await writeProfile(bbl, "process", { name: "p", inherits: null });
  await writeProfile(bbl, "filament", { name: "f", inherits: null });

  await assert.rejects(
    flattenForCli({
      machineLeaf: "A",
      processLeaf: "p",
      filamentLeaves: ["f"],
      profilesRoot: root,
      tempDir: os.tmpdir(),
    }),
    /inheritance cycle detected/i
  );
});

test("missing parent name produces a useful error", async () => {
  const { root, bbl } = await makeSyntheticTree();
  await writeProfile(bbl, "machine", {
    name: "leaf",
    inherits: "ghost_parent",
    nozzle_diameter: ["0.4"],
  });
  await writeProfile(bbl, "process", { name: "p", inherits: null });
  await writeProfile(bbl, "filament", { name: "f", inherits: null });

  await assert.rejects(
    flattenForCli({
      machineLeaf: "leaf",
      processLeaf: "p",
      filamentLeaves: ["f"],
      profilesRoot: root,
      tempDir: os.tmpdir(),
    }),
    /Profile "ghost_parent" not found/
  );
});

test("include templates are applied per inherits level, under the profile's own keys", async () => {
  const { root, bbl } = await makeSyntheticTree();

  await writeProfile(bbl, "machine", {
    name: "root_common",
    inherits: null,
    instantiation: "false",
    nozzle_diameter: ["0.4"],
    machine_start_gcode: "generic start",
    machine_end_gcode: "generic end",
    change_filament_gcode: "generic change",
  });
  for (const [name, key, value] of [
    ["TEST 0.4 template machine_start_gcode", "machine_start_gcode", "TEST 0.4 start"],
    ["TEST 0.4 template machine_end_gcode", "machine_end_gcode", "TEST 0.4 end"],
    ["TEST 0.4 template change_filament_gcode", "change_filament_gcode", "TEST 0.4 change"],
    ["TEST 0.2 template machine_start_gcode", "machine_start_gcode", "TEST 0.2 start"],
  ]) {
    await writeProfile(bbl, "machine", { name, instantiation: "false", [key]: value });
  }
  await writeProfile(bbl, "machine", {
    name: "Bambu Lab TEST 0.4 nozzle",
    inherits: "root_common",
    instantiation: "true",
    include: [
      "TEST 0.4 template machine_start_gcode",
      "TEST 0.4 template machine_end_gcode",
      "TEST 0.4 template change_filament_gcode",
    ],
    change_filament_gcode: "leaf own change", // own key beats its include
  });
  // Like "Bambu Lab P1S 0.2 nozzle": only re-includes the start template,
  // the rest comes from the 0.4 parent's includes. String form, as the GUI
  // also accepts it.
  await writeProfile(bbl, "machine", {
    name: "Bambu Lab TEST 0.2 nozzle",
    inherits: "Bambu Lab TEST 0.4 nozzle",
    instantiation: "true",
    include: "TEST 0.2 template machine_start_gcode",
    nozzle_diameter: ["0.2"],
  });
  await writeProfile(bbl, "process", { name: "0.20mm @TEST", inherits: null, layer_height: 0.2 });
  await writeProfile(bbl, "filament", { name: "PLA @TEST", inherits: null, filament_type: ["PLA"] });

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "flat-include-"));
  const flatten = async (machineLeaf) => {
    const result = await flattenForCli({
      machineLeaf,
      processLeaf: "0.20mm @TEST",
      filamentLeaves: ["PLA @TEST"],
      profilesRoot: root,
      tempDir,
    });
    return JSON.parse(await fs.readFile(result.machinePath, "utf8"));
  };

  const leaf04 = await flatten("Bambu Lab TEST 0.4 nozzle");
  assert.equal(leaf04.machine_start_gcode, "TEST 0.4 start", "include replaces inherited generic G-code");
  assert.equal(leaf04.machine_end_gcode, "TEST 0.4 end");
  assert.equal(leaf04.change_filament_gcode, "leaf own change", "profile's own key wins over its include");
  assert.equal(leaf04.name, "Bambu Lab TEST 0.4 nozzle", "template name must not leak");
  assert.equal("include" in leaf04, false, "include is consumed by the flattener");

  const leaf02 = await flatten("Bambu Lab TEST 0.2 nozzle");
  assert.equal(leaf02.machine_start_gcode, "TEST 0.2 start", "child include overrides parent include");
  assert.equal(leaf02.machine_end_gcode, "TEST 0.4 end", "parent's includes are inherited");
  assert.equal(leaf02.change_filament_gcode, "leaf own change");
});

test("missing include template is an error, not a silent fallback", async () => {
  const { root, bbl } = await makeSyntheticTree();
  await writeProfile(bbl, "machine", {
    name: "Bambu Lab TEST 0.4 nozzle",
    inherits: null,
    instantiation: "true",
    nozzle_diameter: ["0.4"],
    include: ["TEST 0.4 template machine_start_gcode"],
  });
  await writeProfile(bbl, "process", { name: "0.20mm @TEST", inherits: null, layer_height: 0.2 });
  await writeProfile(bbl, "filament", { name: "PLA @TEST", inherits: null, filament_type: ["PLA"] });

  await assert.rejects(
    flattenForCli({
      machineLeaf: "Bambu Lab TEST 0.4 nozzle",
      processLeaf: "0.20mm @TEST",
      filamentLeaves: ["PLA @TEST"],
      profilesRoot: root,
      tempDir: await fs.mkdtemp(path.join(os.tmpdir(), "flat-include-missing-")),
    }),
    /includes "TEST 0\.4 template machine_start_gcode"/
  );
});

test("end-to-end against real BBL tree: P2S 0.4 nozzle gets its own G-code templates", async (t) => {
  const profilesRoot = detectProfilesRoot();
  const leafPath = path.join(profilesRoot, "BBL", "machine", "Bambu Lab P2S 0.4 nozzle.json");
  let leaf;
  try {
    leaf = JSON.parse(await fs.readFile(leafPath, "utf8"));
  } catch {
    t.skip("Installed BambuStudio profiles do not include the P2S preset");
    return;
  }
  if (!Array.isArray(leaf.include) || leaf.include.length === 0) {
    t.skip("Installed P2S preset does not use include templates");
    return;
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "flat-p2s-"));
  const result = await flattenForCli({
    machineLeaf: "Bambu Lab P2S 0.4 nozzle",
    processLeaf: "0.20mm Standard @BBL P2S",
    filamentLeaves: ["Bambu PLA Basic @BBL P2S"],
    profilesRoot,
    tempDir,
  });
  const flat = JSON.parse(await fs.readFile(result.machinePath, "utf8"));

  assert.match(flat.machine_start_gcode, /P2S start gcode/, "P2S start G-code, not the generic inherited one");
  assert.match(flat.machine_start_gcode, /M620 S/, "start G-code must load filament from the AMS");
  assert.equal("include" in flat, false);
});

test("nozzleVolumeType override produces matching-length array", async () => {
  const { root, bbl } = await makeSyntheticTree();

  // Dual-nozzle synthetic machine.
  await writeProfile(bbl, "machine", {
    name: "Bambu Lab TESTDUAL 0.4 nozzle",
    inherits: null,
    instantiation: "true",
    nozzle_diameter: ["0.4", "0.4"],
    extruder_type: ["Direct Drive", "Direct Drive"],
    default_nozzle_volume_type: ["Standard", "Standard"],
    printer_model: "Bambu Lab TESTDUAL",
  });
  await writeProfile(bbl, "process", { name: "p", inherits: null });
  await writeProfile(bbl, "filament", { name: "f", inherits: null });

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "flat-out-"));
  const result = await flattenForCli({
    machineLeaf: "Bambu Lab TESTDUAL 0.4 nozzle",
    processLeaf: "p",
    filamentLeaves: ["f"],
    profilesRoot: root,
    tempDir,
    nozzleVolumeType: "High Flow",
  });

  const flat = JSON.parse(await fs.readFile(result.machinePath, "utf8"));
  assert.deepEqual(flat.nozzle_volume_type, ["High Flow", "High Flow"]);
});

test("bedType override stamps the flattened process profile", async () => {
  const { root, bbl } = await makeSyntheticTree();

  await writeProfile(bbl, "machine", {
    name: "Bambu Lab TEST 0.4 nozzle",
    inherits: null,
    instantiation: "true",
    nozzle_diameter: ["0.4"],
    default_nozzle_volume_type: ["Standard"],
  });
  await writeProfile(bbl, "process", {
    name: "0.20mm @TEST",
    inherits: null,
    curr_bed_type: "Cool Plate",
  });
  await writeProfile(bbl, "filament", { name: "PETG @TEST", inherits: null });

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "flat-bed-"));
  const result = await flattenForCli({
    machineLeaf: "Bambu Lab TEST 0.4 nozzle",
    processLeaf: "0.20mm @TEST",
    filamentLeaves: ["PETG @TEST"],
    profilesRoot: root,
    tempDir,
    bedType: "Textured PEI Plate",
  });

  const process = JSON.parse(await fs.readFile(result.processPath, "utf8"));
  assert.equal(process.curr_bed_type, "Textured PEI Plate");
});

test("machine-model bed metadata is copied onto flattened machine profile", async () => {
  const { root, bbl } = await makeSyntheticTree();

  await writeProfile(bbl, "machine", {
    name: "Bambu Lab TEST",
    inherits: null,
    type: "machine_model",
    default_bed_type: "Textured PEI Plate",
    image_bed_type: "o",
    not_support_bed_type: "Cool Plate",
  });
  await writeProfile(bbl, "machine", {
    name: "Bambu Lab TEST 0.4 nozzle",
    inherits: null,
    instantiation: "true",
    nozzle_diameter: ["0.4"],
    default_nozzle_volume_type: ["Standard"],
    printer_model: "Bambu Lab TEST",
  });
  await writeProfile(bbl, "process", { name: "0.20mm @TEST", inherits: null });
  await writeProfile(bbl, "filament", { name: "PETG @TEST", inherits: null });

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "flat-bed-meta-"));
  const result = await flattenForCli({
    machineLeaf: "Bambu Lab TEST 0.4 nozzle",
    processLeaf: "0.20mm @TEST",
    filamentLeaves: ["PETG @TEST"],
    profilesRoot: root,
    tempDir,
  });

  const machine = JSON.parse(await fs.readFile(result.machinePath, "utf8"));
  assert.equal(machine.default_bed_type, "Textured PEI Plate");
  assert.equal(machine.image_bed_type, "o");
  assert.equal(machine.not_support_bed_type, "Cool Plate");
});

test("mismatched nozzle_volume_type entries throw (hardware invariant)", async () => {
  const { root, bbl } = await makeSyntheticTree();

  await writeProfile(bbl, "machine", {
    name: "bad",
    inherits: null,
    instantiation: "true",
    nozzle_diameter: ["0.4", "0.4"],
    nozzle_volume_type: ["Standard", "High Flow"], // illegal: must match
  });
  await writeProfile(bbl, "process", { name: "p", inherits: null });
  await writeProfile(bbl, "filament", { name: "f", inherits: null });

  await assert.rejects(
    flattenForCli({
      machineLeaf: "bad",
      processLeaf: "p",
      filamentLeaves: ["f"],
      profilesRoot: root,
      tempDir: os.tmpdir(),
    }),
    /must all match.*hardware invariant/i
  );
});

test("end-to-end against real BBL tree: H2S 0.4 nozzle flattens to a populated profile", async (t) => {
  const profilesRoot = detectProfilesRoot();
  // Skip if the BambuStudio install isn't present on this machine.
  try {
    await fs.access(path.join(profilesRoot, "BBL", "machine"));
  } catch {
    t.skip("BambuStudio profiles tree not present on this machine");
    return;
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "flat-h2s-"));
  let result;
  try {
    result = await flattenForCli({
      machineLeaf: "Bambu Lab H2S 0.4 nozzle",
      processLeaf: "0.20mm Standard @BBL H2S",
      filamentLeaves: ["Bambu PLA Basic @BBL H2S"],
      profilesRoot,
      tempDir,
    });
  } catch (error) {
    if (/not found in index/i.test(error?.message || "")) {
      t.skip("Installed BambuStudio profiles do not include H2S presets");
      return;
    }
    throw error;
  }

  const flat = JSON.parse(await fs.readFile(result.machinePath, "utf8"));

  // Critical keys the CLI asserts on must be present and well-formed.
  assert.ok(Array.isArray(flat.nozzle_volume_type), "nozzle_volume_type must be an array");
  assert.ok(flat.nozzle_volume_type.length >= 1);
  assert.ok(typeof flat.nozzle_volume_type[0] === "string");
  assert.equal(
    flat.inherits,
    "Bambu Lab H2S 0.4 nozzle",
    "inherits should be rewritten to leaf name for CLI compat check"
  );

  // Sanity: should be richer than the leaf alone (~69 keys). After full
  // inheritance + cli overlay merge we expect well above 100.
  const keyCount = Object.keys(flat).length;
  assert.ok(
    keyCount > 100,
    `flattened machine profile should have >100 keys after inherits walk; got ${keyCount}`
  );
});

test("end-to-end: H2D matches GUI-sliced ground-truth shape for nozzle_volume_type", async (t) => {
  const profilesRoot = detectProfilesRoot();
  try {
    await fs.access(path.join(profilesRoot, "BBL", "machine"));
  } catch {
    t.skip("BambuStudio profiles tree not present on this machine");
    return;
  }

  const groundTruthPath = path.join(FIXTURES, "h2d_gui_sliced", "project_settings.config");
  let groundTruth;
  try {
    groundTruth = JSON.parse(await fs.readFile(groundTruthPath, "utf8"));
  } catch {
    t.skip("H2D ground-truth fixture not present");
    return;
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "flat-h2d-"));
  const result = await flattenForCli({
    machineLeaf: "Bambu Lab H2D 0.4 nozzle",
    processLeaf: "0.20mm Standard @BBL H2D",
    filamentLeaves: ["Bambu PETG HF @BBL H2D 0.4 nozzle"],
    profilesRoot,
    tempDir,
  });

  const flat = JSON.parse(await fs.readFile(result.machinePath, "utf8"));

  // GUI ground truth has nozzle_volume_type length 2 (dual-nozzle).
  assert.ok(Array.isArray(flat.nozzle_volume_type));
  assert.equal(
    flat.nozzle_volume_type.length,
    groundTruth.nozzle_volume_type.length,
    "nozzle_volume_type length must match GUI output"
  );

  // Both entries identical (hardware invariant).
  assert.equal(
    new Set(flat.nozzle_volume_type).size,
    1,
    "all nozzles must have matching flow type"
  );

  // printer_model must agree.
  assert.equal(flat.printer_model, "Bambu Lab H2D");
});
