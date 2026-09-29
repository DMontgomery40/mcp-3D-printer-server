// MCP-level slicing regressions: the slice_stl / template tools drive a fake
// Bambu-compatible CLI inside a synthetic BBL profile tree. No printer is
// contacted, and the real user profile tree is never searched.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVER_ENTRY = path.join(REPO_ROOT, "dist", "index.js");
const SAMPLE_STL = path.join(REPO_ROOT, "test", "sample_cube.stl");
const P1S = "Bambu Lab P1S 0.4 nozzle";
const REAL_BAMBU_STUDIO = "/Applications/BambuStudio.app/Contents/MacOS/BambuStudio";

async function zipBytes(entries) {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(entries)) zip.file(name, content);
  return zip.generateAsync({ type: "nodebuffer" });
}

/** A P1S-shaped BBL tree whose leaf presets use inherits/include like the real bundle. */
async function createFakeInstall(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "slice-tool-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const app = path.join(root, "BambuStudio.app", "Contents");
  const bbl = path.join(app, "Resources", "profiles", "BBL");
  for (const kind of ["machine", "process", "filament"]) await fs.mkdir(path.join(bbl, kind), { recursive: true });
  const write = async (kind, value) => {
    const file = path.join(bbl, kind, `${value.name}.json`);
    await fs.writeFile(file, JSON.stringify(value));
    return file;
  };
  await fs.writeFile(path.join(bbl, "cli_config.json"), JSON.stringify({
    printer: { "Bambu Lab P1S": { downward_check: { [P1S]: ["Bambu Lab P1P 0.4 nozzle"] } } },
  }));
  await write("machine", { name: "fdm_machine_common", from: "system", instantiation: "false",
    machine_end_gcode: "; generic end", nozzle_diameter: ["0.4"] });
  await write("machine", { name: "fdm_bbl_3dp_001_common", inherits: "fdm_machine_common", from: "system",
    instantiation: "false", default_nozzle_volume_type: ["Standard"], extruder_type: ["Direct Drive"],
    include: ["P1S template change_filament_gcode"] });
  await write("machine", { name: "P1S template change_filament_gcode", from: "system", instantiation: "false",
    change_filament_gcode: "M620 S[next_extruder]A ; P1S AMS" });
  const leaf = await write("machine", { name: P1S, inherits: "fdm_bbl_3dp_001_common", from: "system",
    setting_id: "GM014", instantiation: "true", printer_model: "Bambu Lab P1S", printer_variant: "0.4",
    nozzle_diameter: ["0.4"], default_print_profile: "0.20mm Standard @BBL X1C",
    default_filament_profile: ["Bambu PLA Basic @BBL X1C"], machine_start_gcode: ";===== machine: P1S =====" });
  await write("process", { name: "fdm_process_common", from: "system", instantiation: "false", layer_height: "0.2", wall_loops: "2" });
  await write("process", { name: "0.20mm Standard @BBL X1C", inherits: "fdm_process_common", from: "system",
    instantiation: "true", compatible_printers: ["Bambu Lab X1 Carbon 0.4 nozzle"] });
  await write("filament", { name: "fdm_filament_common", from: "system", instantiation: "false", nozzle_temperature: ["220"] });
  await write("filament", { name: "Bambu PLA Basic @BBL X1C", inherits: "fdm_filament_common", from: "system",
    instantiation: "true", filament_type: ["PLA"], filament_id: "GFA00" });

  const fixtures = path.join(root, "fixtures");
  await fs.mkdir(fixtures);
  await fs.writeFile(path.join(fixtures, "ok.3mf"), await zipBytes({
    "Metadata/plate_1.gcode": ";===== machine: P1S =====\nG28\n", "Metadata/plate_1.gcode.md5": "abc",
  }));
  await fs.writeFile(path.join(fixtures, "md5only.3mf"), await zipBytes({ "Metadata/plate_1.gcode.md5": "abc" }));

  // Mimics the real CLI: an unflattened system preset is "not compatible" (exit 239, stdout only).
  const executable = path.join(app, "MacOS", "BambuStudio");
  const capture = path.join(root, "args.json");
  const modeFile = path.join(root, "mode.txt");
  await fs.mkdir(path.dirname(executable), { recursive: true });
  await fs.writeFile(executable, `#!${process.execPath}
const fs = require("fs"); const path = require("path");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify(args));
const mode = fs.existsSync(${JSON.stringify(modeFile)}) ? fs.readFileSync(${JSON.stringify(modeFile)}, "utf8").trim() : "ok";
const [machinePath] = (args[args.indexOf("--load-settings") + 1] || "").split(";");
const machine = JSON.parse(fs.readFileSync(machinePath, "utf8"));
if (machine.from === "system" || machine.include || !machine.printer_settings_id) {
  console.log("[error]   run 2716: process not compatible with printer.");
  console.log("run found error, exit");
  process.exit(239);
}
const out = path.join(args[args.indexOf("--outputdir") + 1], args[args.indexOf("--export-3mf") + 1]);
if (mode === "exit239") { console.log("[error] plate 1: Nothing to be sliced"); console.error("fatal: slicing failed"); process.exit(239); }
if (mode === "segv") process.kill(process.pid, "SIGSEGV");
if (mode === "nooutput") process.exit(0);
fs.copyFileSync(path.join(${JSON.stringify(fixtures)}, mode === "md5only" ? "md5only.3mf" : "ok.3mf"), out);
`, { mode: 0o755 });

  return { root, bbl, write, leaf, executable, capture, modeFile,
    setMode: (mode) => fs.writeFile(modeFile, mode),
    args: async () => JSON.parse(await fs.readFile(capture, "utf8")),
    resetCapture: () => fs.rm(capture, { force: true }) };
}

async function startServer(t, install, extraEnv = {}) {
  const tempDir = path.join(install.root, "server-temp");
  await fs.mkdir(tempDir, { recursive: true });
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME,
    MCP_TRANSPORT: "stdio", PRINTER_TYPE: "octoprint", PRINTER_HOST: "127.0.0.1",
    SLICER_TYPE: "bambustudio", SLICER_PATH: install.executable, SLICER_PROFILE: "",
    FILAMENT_PROFILE: "", SLICER_FILAMENT_PROFILE: "", BAMBU_MODEL: "", NOZZLE_DIAMETER: "", BAMBU_NOZZLE_TYPE: "",
    BAMBU_PROFILES_ROOT: "", BAMBU_SLICER_PROFILE_DIRS: "", BAMBU_TEMPLATE_3MF_PATH: "",
    BAMBU_TEMPLATE_DIR: path.join(install.root, "templates"), MCP_ALLOW_EXECUTABLE_ARG: "1",
    TEMP_DIR: tempDir, ...extraEnv,
  };
  // cwd outside the repo so a developer .env cannot change the configuration.
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER_ENTRY], cwd: install.root, env, stderr: "pipe" });
  const client = new Client({ name: "slice-tool-tests", version: "1" });
  await client.connect(transport);
  t.after(() => client.close());
  const call = (name, args) => client.callTool({ name, arguments: args }, undefined, { timeout: 60000 });
  return { client, call, tempDir };
}

const text = (result) => result.content?.[0]?.text ?? "";

async function assertSliced(outputPath) {
  assert.ok(outputPath.endsWith("_sliced.3mf"), `expected sliced 3MF path, got ${outputPath}`);
  const zip = await JSZip.loadAsync(await fs.readFile(outputPath));
  assert.ok(zip.file("Metadata/plate_1.gcode"), "sliced output must contain plate G-code");
}

async function assertNotExecuted(install) {
  assert.equal(existsSync(install.capture), false, "the slicer must not run when preparation fails");
}

test("slice_stl never passes the raw inherited machine preset to the CLI (P1S regression)", async (t) => {
  const install = await createFakeInstall(t);
  const { call } = await startServer(t, install);
  const result = await call("slice_stl", { stl_path: SAMPLE_STL, bambu_model: "p1s", nozzle_diameter: "0.4" });
  assert.equal(result.isError, undefined, text(result));
  await assertSliced(text(result));

  const args = await install.args();
  const [machinePath, processPath] = args[args.indexOf("--load-settings") + 1].split(";");
  assert.notEqual(machinePath, install.leaf, "the bundled leaf file must not be loaded directly");
  const machine = JSON.parse(await fs.readFile(machinePath, "utf8"));
  assert.equal(machine.from, "User");
  assert.equal(machine.inherits, P1S);
  assert.equal(machine.printer_settings_id, P1S);
  assert.equal(machine.machine_start_gcode, ";===== machine: P1S =====");
  assert.equal(machine.machine_end_gcode, "; generic end", "grandparent settings are resolved");
  assert.equal(machine.change_filament_gcode, "M620 S[next_extruder]A ; P1S AMS", "include templates are resolved");
  assert.deepEqual(machine.nozzle_volume_type, ["Standard"]);
  assert.equal("include" in machine, false);
  const processConfig = JSON.parse(await fs.readFile(processPath, "utf8"));
  assert.equal(processConfig.layer_height, "0.2");
  assert.ok(processConfig.compatible_printers.includes(P1S));
  assert.equal(processConfig.curr_bed_type, "Textured PEI Plate");
  const filaments = args[args.indexOf("--load-filaments") + 1].split(";");
  assert.equal(filaments.length, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(filaments[0], "utf8")).nozzle_temperature, ["220"]);
  assert.ok(args.includes("--allow-newer-file"));
  assert.equal(args.at(-1), SAMPLE_STL);
});

test("slice_stl writes the installed nozzle type into the machine preset so printing can match the printer", async (t) => {
  const install = await createFakeInstall(t);
  const machineOf = async () => {
    const args = await install.args();
    return JSON.parse(await fs.readFile(args[args.indexOf("--load-settings") + 1].split(";")[0], "utf8"));
  };
  const { call } = await startServer(t, install);
  let result = await call("slice_stl", { stl_path: SAMPLE_STL, bambu_model: "p1s", nozzle_type: "hardened_steel" });
  assert.equal(result.isError, undefined, text(result));
  assert.deepEqual((await machineOf()).nozzle_type, ["hardened_steel"]);
  // Without a choice the preset's stock nozzle is kept.
  await install.resetCapture();
  result = await call("slice_stl", { stl_path: SAMPLE_STL, bambu_model: "p1s" });
  assert.equal(result.isError, undefined, text(result));
  assert.notDeepEqual((await machineOf()).nozzle_type, ["hardened_steel"]);
  // Invalid values stop before the slicer runs.
  await install.resetCapture();
  result = await call("slice_stl", { stl_path: SAMPLE_STL, bambu_model: "p1s", nozzle_type: "diamond" });
  assert.equal(result.isError, true);
  assert.match(text(result), /Invalid nozzle type/);
  await assertNotExecuted(install);
  // BAMBU_NOZZLE_TYPE supplies the default.
  const envServer = await startServer(t, install, { BAMBU_NOZZLE_TYPE: "hardened-steel" });
  await install.resetCapture();
  result = await envServer.call("slice_stl", { stl_path: SAMPLE_STL, bambu_model: "p1s" });
  assert.equal(result.isError, undefined, text(result));
  assert.deepEqual((await machineOf()).nozzle_type, ["hardened_steel"]);
});

test("slice_stl preparation failures stop before the slicer and give slicer-specific advice", async (t) => {
  const install = await createFakeInstall(t);
  const { call } = await startServer(t, install);
  const expectPreparationFailure = async (args, pattern) => {
    await install.resetCapture();
    const result = await call("slice_stl", { stl_path: SAMPLE_STL, ...args });
    assert.equal(result.isError, true, `expected failure for ${JSON.stringify(args)}`);
    assert.match(text(result), pattern);
    assert.doesNotMatch(text(result), /printer connectivity/i);
    assert.equal(result.structuredContent?.retryable, false);
    await assertNotExecuted(install);
    return result;
  };

  // Missing model preset (supported for slicing, absent from this installation).
  const missing = await expectPreparationFailure({ bambu_model: "h2s" }, /Printer profile "Bambu Lab H2S 0\.4 nozzle" was not found/);
  assert.equal(missing.structuredContent?.slicer?.phase, "preparation");
  assert.match(missing.structuredContent?.suggestion ?? "", /BAMBU_PROFILES_ROOT/);
  // Wrong nozzle for an installed model.
  await expectPreparationFailure({ bambu_model: "p1s", nozzle_diameter: "0.5" }, /Bambu Lab P1S 0\.5 nozzle" was not found/);
  // Nozzle values cannot become arbitrary preset names or paths.
  await expectPreparationFailure({ bambu_model: "p1s", nozzle_diameter: "../../x" }, /Invalid nozzle_diameter/);
  // A model outside the slicing list.
  await expectPreparationFailure({ bambu_model: "x9000" }, /Invalid bambu_model/);
  // A machine selection alone cannot replace the machine preset.
  const machineAndProcess = path.join(install.root, "machine.json") + ";" + path.join(install.root, "process.json");
  await expectPreparationFailure({ bambu_model: "p1s", slicer_profile: machineAndProcess }, /takes one process profile\. Set slicer_profile\/SLICER_PROFILE to a process profile only/);
  // A missing process profile fails closed instead of falling back to defaults.
  await expectPreparationFailure({ bambu_model: "p1s", slicer_profile: path.join(install.root, "missing.json") }, /process profile not found/);
  // A missing filament keeps its slot rather than silently shifting.
  await expectPreparationFailure({ bambu_model: "p1s", load_filaments: path.join(install.root, "nope.json") }, /Filament profile not found/);

  // Inheritance cycle.
  await install.write("machine", { name: "fdm_machine_common", inherits: "fdm_bbl_3dp_001_common", from: "system" });
  await expectPreparationFailure({ bambu_model: "p1s" }, /cycle/i);
  await install.write("machine", { name: "fdm_machine_common", from: "system", machine_end_gcode: "; generic end" });
  // Malformed JSON in a parent profile.
  await fs.writeFile(path.join(install.bbl, "machine", "fdm_bbl_3dp_001_common.json"), "{ not json");
  await expectPreparationFailure({ bambu_model: "p1s" }, /fdm_bbl_3dp_001_common" not found.*malformed profile file\(s\): fdm_bbl_3dp_001_common\.json/);
  await install.write("machine", { name: "fdm_bbl_3dp_001_common", inherits: "fdm_machine_common", from: "system",
    default_nozzle_volume_type: ["Standard"], include: ["P1S template change_filament_gcode"] });
  // Missing include dependency.
  await fs.rm(path.join(install.bbl, "machine", "P1S template change_filament_gcode.json"));
  await expectPreparationFailure({ bambu_model: "p1s" }, /includes "P1S template change_filament_gcode"/);
  await install.write("machine", { name: "P1S template change_filament_gcode", from: "system", change_filament_gcode: "M620" });
  // Missing CLI configuration for the model.
  await fs.writeFile(path.join(install.bbl, "cli_config.json"), JSON.stringify({ printer: {} }));
  await expectPreparationFailure({ bambu_model: "p1s" }, /cli_config\.json.*selected model is absent/);
});

test("slice_stl surfaces exit code, signal, and slicer output, and never returns stale or unsliced output", async (t) => {
  const install = await createFakeInstall(t);
  const { call, tempDir } = await startServer(t, install);
  const slice = () => call("slice_stl", { stl_path: SAMPLE_STL, bambu_model: "p1s" });

  await install.setMode("exit239");
  let result = await slice();
  assert.equal(result.isError, true);
  assert.match(text(result), /exited with code 239/);
  assert.match(text(result), /Nothing to be sliced/, "stdout tail must be surfaced");
  assert.match(text(result), /fatal: slicing failed/, "stderr tail must be surfaced");
  assert.doesNotMatch(text(result), /printer connectivity/i);
  assert.equal(result.structuredContent?.slicer?.exitCode, 239);
  assert.equal(result.structuredContent?.slicer?.phase, "execution");

  await install.setMode("segv");
  result = await slice();
  assert.equal(result.isError, true);
  assert.match(text(result), /terminated by signal SIGSEGV/);
  assert.equal(result.structuredContent?.slicer?.signal, "SIGSEGV");

  // A checksum entry is not printable G-code.
  await install.setMode("md5only");
  result = await slice();
  assert.equal(result.isError, true);
  assert.match(text(result), /does not contain any nonempty Metadata\/plate_<n>\.gcode/);
  assert.equal(result.structuredContent?.slicer?.phase, "output");

  // A previous run's output must not be mistaken for this run's result.
  await fs.writeFile(path.join(tempDir, "sample_cube_sliced.3mf"), await zipBytes({ "Metadata/plate_1.gcode": "; stale" }));
  await install.setMode("nooutput");
  result = await slice();
  assert.equal(result.isError, true);
  assert.match(text(result), /did not write/);
  assert.equal(existsSync(path.join(tempDir, "sample_cube_sliced.3mf")), false, "stale output must be removed");

  await install.setMode("ok");
  result = await slice();
  assert.equal(result.isError, undefined, text(result));
  await assertSliced(text(result));
  const leftovers = (await fs.readdir(tempDir)).filter((entry) => entry.includes("-bambu-output-"));
  assert.deepEqual(leftovers, [], "per-run output directories are cleaned up");
});

test("slice_stl maps Bambu CLI options and routes generic OrcaSlicer only with an explicit model", async (t) => {
  const install = await createFakeInstall(t);
  const { call, client } = await startServer(t, install);
  const sliceTool = (await client.listTools()).tools.find((tool) => tool.name === "slice_stl");
  for (const model of ["p1s", "p2s", "h2d", "h2s", "h2c", "a1mini"]) {
    assert.ok(sliceTool.inputSchema.properties.bambu_model.enum.includes(model), `slice_stl must accept ${model}`);
  }
  for (const option of ["bed_type", "load_filaments", "filament_colours", "orient", "arrange", "slice_plate", "template_name"]) {
    assert.ok(sliceTool.inputSchema.properties[option], `slice_stl must expose ${option}`);
  }

  let result = await call("slice_stl", {
    stl_path: SAMPLE_STL, bambu_model: "p1s", bed_type: "cool_plate", orient: true, arrange: false,
    repetitions: 2, scale: 1.5, rotate: 90, slice_plate: 1, filament_colours: "161616", uptodate: true,
  });
  assert.equal(result.isError, undefined, text(result));
  let args = await install.args();
  assert.deepEqual(args.slice(0, 2), ["--slice", "1"]);
  for (const [flag, value] of [["--orient", "1"], ["--arrange", "0"], ["--repetitions", "2"], ["--scale", "1.5"], ["--rotate", "90"]]) {
    assert.equal(args[args.indexOf(flag) + 1], value, `${flag} must be ${value}`);
  }
  assert.ok(args.includes("--uptodate"));
  const processConfig = JSON.parse(await fs.readFile(args[args.indexOf("--load-settings") + 1].split(";")[1], "utf8"));
  assert.equal(processConfig.curr_bed_type, "Cool Plate");
  const filament = JSON.parse(await fs.readFile(args[args.indexOf("--load-filaments") + 1], "utf8"));
  assert.deepEqual(filament.filament_colour, ["#161616"]);

  // Invalid option values are rejected before slicing.
  await install.resetCapture();
  result = await call("slice_stl", { stl_path: SAMPLE_STL, bambu_model: "p1s", repetitions: 0 });
  assert.equal(result.isError, true);
  assert.match(text(result), /Invalid repetitions/);
  await assertNotExecuted(install);

  // Generic OrcaSlicer + explicit bambu_model uses the same resolved-preset path.
  result = await call("slice_stl", { stl_path: SAMPLE_STL, slicer_type: "orcaslicer", slicer_path: install.executable, bambu_model: "p1s" });
  assert.equal(result.isError, undefined, text(result));
  await assertSliced(text(result));
  args = await install.args();
  const orcaMachine = JSON.parse(await fs.readFile(args[args.indexOf("--load-settings") + 1].split(";")[0], "utf8"));
  assert.equal(orcaMachine.printer_settings_id, P1S);
  const orcaProcess = JSON.parse(await fs.readFile(args[args.indexOf("--load-settings") + 1].split(";")[1], "utf8"));
  assert.equal(orcaProcess.use_relative_e_distances, "0", "Orca process normalization still applies");
});

test("template tools save, list, inspect, and slice with a process template", async (t) => {
  const install = await createFakeInstall(t);
  const { call } = await startServer(t, install);
  const templateDir = path.join(install.root, "templates");
  const processTemplate = path.join(install.root, "fine walls.json");
  await fs.writeFile(processTemplate, JSON.stringify({ name: "Fine walls", from: "User",
    inherits: "0.20mm Standard @BBL X1C", wall_loops: "6", layer_height: "0.12" }));

  let result = await call("save_template", { source_path: processTemplate, template_name: "fine walls", template_dir: templateDir });
  assert.equal(result.isError, undefined, text(result));
  const saved = JSON.parse(text(result));
  assert.equal(saved.template_name, "fine_walls");
  assert.equal(saved.destination_path, path.join(templateDir, "fine_walls.json"));

  // Parent-directory names are sanitized into the registry, never outside it.
  result = await call("save_template", { source_path: processTemplate, template_name: "../escape", template_dir: templateDir });
  assert.equal(result.isError, undefined, text(result));
  const escaped = JSON.parse(text(result)).destination_path;
  assert.ok(!path.relative(templateDir, escaped).startsWith(".."), `template saved outside registry: ${escaped}`);
  await fs.rm(path.dirname(escaped), { recursive: true, force: true });
  result = await call("save_template", { source_path: processTemplate, template_name: "///", template_dir: templateDir });
  assert.equal(result.isError, true);
  assert.match(text(result), /Invalid template name/);

  const project = path.join(install.root, "project.3mf");
  await fs.writeFile(project, await zipBytes({
    "3D/3dmodel.model": '<?xml version="1.0"?><model unit="millimeter"><resources/><build/></model>',
    "Metadata/project_settings.config": JSON.stringify({ printer_settings_id: P1S, layer_height: "0.16", sparse_infill_density: "15%", enable_support: "1", brim_width: "5" }),
  }));
  await call("save_template", { source_path: project, template_dir: templateDir });

  result = await call("list_templates", {});
  assert.equal(result.isError, undefined, text(result));
  assert.deepEqual(JSON.parse(text(result)).templates.map((entry) => entry.name), ["fine_walls", "project"]);

  result = await call("get_slice_settings", { template_name: "project" });
  assert.equal(result.isError, undefined, text(result));
  const summary = JSON.parse(text(result)).summary;
  assert.equal(summary.layer_height, 0.16);
  assert.match(summary.sparse_infill_density, /^15%?$/); // parse3MF normalizes percentages
  assert.equal(summary.support_enabled, true);
  assert.equal(summary.brim_width, 5);

  result = await call("slice_with_template", { stl_path: SAMPLE_STL, template_name: "fine walls", bambu_model: "p1s" });
  assert.equal(result.isError, undefined, text(result));
  await assertSliced(text(result));
  const args = await install.args();
  const [machinePath, processPath] = args[args.indexOf("--load-settings") + 1].split(";");
  assert.equal(JSON.parse(await fs.readFile(machinePath, "utf8")).printer_settings_id, P1S, "templates never replace the machine preset");
  const processConfig = JSON.parse(await fs.readFile(processPath, "utf8"));
  assert.equal(processConfig.wall_loops, "6");
  assert.equal(processConfig.layer_height, "0.12");

  result = await call("slice_with_template", { stl_path: SAMPLE_STL, template_name: "absent", bambu_model: "p1s" });
  assert.equal(result.isError, true);
  assert.match(text(result), /Template "absent".*not found/);
  assert.doesNotMatch(text(result), /printer connectivity/i);
});

test("machine settings inside a template or process profile never replace the selected preset", async (t) => {
  const install = await createFakeInstall(t);
  const { call } = await startServer(t, install);
  // A template exported for another printer carries its machine settings in project_settings.
  const foreignTemplate = path.join(install.root, "x1c-project.3mf");
  await fs.writeFile(foreignTemplate, await zipBytes({
    "Metadata/project_settings.config": JSON.stringify({
      printer_model: "Bambu Lab X1 Carbon", printer_settings_id: "Bambu Lab X1 Carbon 0.4 nozzle",
      machine_start_gcode: "; FOREIGN X1C START", machine_end_gcode: "; FOREIGN END", nozzle_diameter: ["0.4"],
      print_settings_id: "0.20mm Standard @BBL X1C", wall_loops: "4",
    }),
  }));
  const standaloneProcess = path.join(install.root, "standalone-process.json");
  await fs.writeFile(standaloneProcess, JSON.stringify({ name: "Mine", from: "User", wall_loops: "5", machine_start_gcode: "; FOREIGN STANDALONE" }));

  for (const [args, wallLoops] of [[{ template_3mf_path: foreignTemplate }, "4"], [{ slicer_profile: standaloneProcess }, "5"]]) {
    const result = await call("slice_stl", { stl_path: SAMPLE_STL, bambu_model: "p1s", ...args });
    assert.equal(result.isError, undefined, text(result));
    const cliArgs = await install.args();
    const [machinePath, processPath] = cliArgs[cliArgs.indexOf("--load-settings") + 1].split(";");
    const machine = JSON.parse(await fs.readFile(machinePath, "utf8"));
    assert.equal(machine.machine_start_gcode, ";===== machine: P1S =====");
    assert.equal(machine.printer_model, "Bambu Lab P1S");
    const processConfig = JSON.parse(await fs.readFile(processPath, "utf8"));
    assert.equal(processConfig.wall_loops, wallLoops, "process settings are kept");
    for (const key of ["machine_start_gcode", "machine_end_gcode", "printer_model", "nozzle_diameter", "printer_settings_id"]) {
      assert.equal(key in processConfig, false, `${key} must not reach the CLI through the process profile`);
    }
  }
  assert.deepEqual(JSON.parse(await fs.readFile(standaloneProcess, "utf8")).machine_start_gcode, "; FOREIGN STANDALONE", "the caller's file is not modified");
});

test("PrusaSlicer, Slic3r, and Cura keep their G-code paths and report failures", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "generic-slicer-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const executable = path.join(root, "fake-slicer");
  const capture = path.join(root, "args.json");
  const modeFile = path.join(root, "mode.txt");
  await fs.writeFile(executable, `#!${process.execPath}
const fs = require("fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify(args));
if (fs.existsSync(${JSON.stringify(modeFile)})) { console.log("Error: unknown option in profile.ini"); process.exit(3); }
const flag = args.includes("--output") ? "--output" : "-o";
fs.writeFileSync(args[args.indexOf(flag) + 1], "; generic gcode\\n");
`, { mode: 0o755 });
  const profile = path.join(root, "profile.ini");
  await fs.writeFile(profile, "layer_height = 0.2\n");
  const { call, tempDir } = await startServer(t, { root, executable }, { SLICER_TYPE: "prusaslicer" });

  for (const slicerType of ["prusaslicer", "slic3r", "cura"]) {
    const result = await call("slice_stl", { stl_path: SAMPLE_STL, slicer_type: slicerType, slicer_profile: profile });
    assert.equal(result.isError, undefined, `${slicerType}: ${text(result)}`);
    assert.equal(text(result), path.join(tempDir, "sample_cube.gcode"));
    assert.equal(await fs.readFile(text(result), "utf8"), "; generic gcode\n");
    const args = JSON.parse(await fs.readFile(capture, "utf8"));
    assert.equal(args.includes("--load-settings"), false, `${slicerType} must not receive Bambu CLI flags`);
    assert.ok(args.includes(profile), `${slicerType} receives its profile unchanged`);
  }

  await fs.writeFile(modeFile, "fail");
  const failed = await call("slice_stl", { stl_path: SAMPLE_STL, slicer_type: "prusaslicer", slicer_profile: profile });
  assert.equal(failed.isError, true);
  assert.match(text(failed), /exited with code 3/);
  assert.match(text(failed), /unknown option in profile\.ini/);
  assert.doesNotMatch(text(failed), /printer connectivity/i);
  assert.equal(existsSync(path.join(tempDir, "sample_cube.gcode")), false, "a failed run cannot return the previous G-code");
});

test("optional: installed BambuStudio slices P1S 0.4 into a 3MF with P1S plate G-code", async (t) => {
  if (process.platform !== "darwin" || !existsSync(REAL_BAMBU_STUDIO)) {
    t.skip("BambuStudio.app is not installed at the default macOS path");
    return;
  }
  if (process.env.SKIP_REAL_SLICER === "1") {
    t.skip("SKIP_REAL_SLICER=1");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "real-bambustudio-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const install = { root, executable: REAL_BAMBU_STUDIO };
  const { call } = await startServer(t, install);
  const result = await call("slice_stl", { stl_path: SAMPLE_STL, bambu_model: "p1s", nozzle_diameter: "0.4" });
  if (result.isError && /Printer profile .* was not found/.test(text(result))) {
    t.skip("Installed BambuStudio profiles do not include the P1S 0.4 preset");
    return;
  }
  assert.equal(result.isError, undefined, text(result));
  const zip = await JSZip.loadAsync(await fs.readFile(text(result)));
  const gcode = await zip.file("Metadata/plate_1.gcode")?.async("string");
  assert.ok(gcode, "real slice must contain Metadata/plate_1.gcode");
  assert.match(gcode, /; printer_model = Bambu Lab P1S/);
  assert.match(gcode, /;===== machine: P1S/);
});
