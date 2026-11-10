// MCP-level slicing regressions: the slice_stl / template tools drive a fake
// Bambu-compatible CLI inside a synthetic BBL profile tree. No printer is
// contacted, and the real user profile tree is never searched.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
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
const STUDIO_RESULTS = path.join(REPO_ROOT, "tests", "fixtures", "studio-result");
const studioResult = async (name) => JSON.parse(await fs.readFile(path.join(STUDIO_RESULTS, name), "utf8"));

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
  const inputCapture = path.join(root, "input-model");
  const modeFile = path.join(root, "mode.txt");
  await fs.mkdir(path.dirname(executable), { recursive: true });
  await fs.writeFile(executable, `#!${process.execPath}
const fs = require("fs"); const path = require("path");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify(args));
// The server deletes a transformed mesh after slicing; keep the model the CLI received.
if (fs.existsSync(args.at(-1))) fs.copyFileSync(args.at(-1), ${JSON.stringify(inputCapture)});
const mode = fs.existsSync(${JSON.stringify(modeFile)}) ? fs.readFileSync(${JSON.stringify(modeFile)}, "utf8").trim() : "ok";
const [machinePath] = (args[args.indexOf("--load-settings") + 1] || "").split(";");
const machine = JSON.parse(fs.readFileSync(machinePath, "utf8"));
if (machine.from === "system" || machine.include || !machine.printer_settings_id) {
  console.log("[error]   run 2716: process not compatible with printer.");
  console.log("run found error, exit");
  process.exit(239);
}
const out = path.join(args[args.indexOf("--outputdir") + 1], args[args.indexOf("--export-3mf") + 1]);
fs.writeFileSync(${JSON.stringify(path.join(root, "launch.json"))}, JSON.stringify({ home: process.env.CFFIXED_USER_HOME ?? null, homeExists: !!process.env.CFFIXED_USER_HOME && fs.existsSync(process.env.CFFIXED_USER_HOME) }));
// "stall": Bambu Studio behind AppKit's modal "reopen windows?" alert logs once and then waits at 0% CPU.
if (mode === "stall") { console.log("[trace]   Initializing StaticPrintConfigs"); setInterval(() => {}, 1 << 30); return; }
// "busy": computes silently for 2.5 s, then writes its output.
if (mode === "busy") for (const end = Date.now() + 2500; Date.now() < end;) Math.sqrt(Math.random());
if (mode === "exit239") { console.log("[error] plate 1: Nothing to be sliced"); console.error("fatal: slicing failed"); process.exit(239); }
if (mode === "segv") process.kill(process.pid, "SIGSEGV");
// Linux CLIs record handled errors in result.json; the process exits with the code's low byte.
if (mode === "resultjson") {
  fs.writeFileSync(path.join(path.dirname(out), "result.json"), JSON.stringify({ error_string: "Some objects are outside the plate boundary.", return_code: -52 }));
  process.exit(204);
}
// Real Bambu Studio 02.08.02.61 result.json files: "studio:<fixture>[:<exit code>]".
if (mode.startsWith("studio:")) {
  const [, fixture, exitCode] = mode.split(":");
  fs.copyFileSync(path.join(${JSON.stringify(STUDIO_RESULTS)}, fixture), path.join(path.dirname(out), "result.json"));
  if (exitCode) process.exit(Number(exitCode));
}
if (mode === "exit206") process.exit(206);
if (mode === "nooutput") process.exit(0);
fs.copyFileSync(path.join(${JSON.stringify(fixtures)}, mode === "md5only" ? "md5only.3mf" : "ok.3mf"), out);
`, { mode: 0o755 });

  return { root, bbl, write, leaf, executable, capture, inputCapture, modeFile,
    setMode: (mode) => fs.writeFile(modeFile, mode),
    args: async () => JSON.parse(await fs.readFile(capture, "utf8")),
    resetCapture: () => Promise.all([fs.rm(capture, { force: true }), fs.rm(inputCapture, { force: true })]) };
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
    // This stand-in slicer changes behaviour through its mode file, not its bytes: slices are never reused here
    // unless a test asks (src/slicer/slice-cache.ts).
    TEMP_DIR: tempDir, SLICE_CACHE: "off", ...extraEnv,
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
  assert.equal(existsSync(path.join(install.root, "args.json")), false, "the slicer must not run when preparation fails");
}

// Slicing the same model the same way again reuses the kept slice: the slicer doesn't run, and the result,
// Studio's result.json included, is the first slice's. A changed input slices again.
test("slice_stl reuses an identical earlier slice, and slices again when an input changes", async (t) => {
  const install = await createFakeInstall(t);
  const cache = { SLICE_CACHE: "on", SLICE_CACHE_DIR: path.join(install.root, "cache") };
  const model = path.join(install.root, "model.stl");
  await fs.copyFile(SAMPLE_STL, model);
  await install.setMode("studio:p1s-floating-cantilever.json");
  const slice = async (extra = cache) => {
    const { call } = await startServer(t, install, extra);
    return call("slice_stl", { stl_path: model, bambu_model: "p1s", nozzle_diameter: "0.4" });
  };
  const ran = async () => { const yes = existsSync(install.capture); await install.resetCapture(); return yes; };
  const first = await slice();
  assert.equal(first.isError, undefined, text(first));
  assert.equal(await ran(), true);
  // A new server process (an MCP restart) still has it.
  const again = await slice();
  assert.equal(again.isError, undefined, text(again));
  assert.equal(await ran(), false, "the slicer did not run again");
  await assertSliced(again.structuredContent?.path ?? text(again));
  assert.deepEqual(again.structuredContent?.slicer_result, first.structuredContent?.slicer_result, "Studio's words come back with it");
  await fs.appendFile(model, " ");
  assert.equal((await slice()).isError, undefined);
  assert.equal(await ran(), true, "a changed model slices again");
  assert.equal((await slice({ ...cache, SLICE_CACHE: "off" })).isError, undefined);
  assert.equal(await ran(), true, "SLICE_CACHE=off always slices");
});

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

test("slice_stl writes enable_support, support_type and support_threshold_angle over the process preset", async (t) => {
  const install = await createFakeInstall(t);
  const { call, client } = await startServer(t, install);
  const { tools } = await client.listTools();
  const schema = tools.find(tool => tool.name === "slice_stl").inputSchema.properties;
  assert.deepEqual([schema.enable_support.type, schema.support_type.enum, schema.support_threshold_angle.type],
    ["boolean", ["normal(auto)", "tree(auto)", "normal(manual)", "tree(manual)"], "integer"]);
  const result = await call("slice_stl", { stl_path: SAMPLE_STL, bambu_model: "p1s", nozzle_diameter: "0.4",
    enable_support: true, support_type: "tree(auto)", support_threshold_angle: 35 });
  assert.equal(result.isError, undefined, text(result));
  const args = await install.args();
  const processPath = args[args.indexOf("--load-settings") + 1].split(";")[1];
  const processConfig = JSON.parse(await fs.readFile(processPath, "utf8"));
  assert.deepEqual([processConfig.enable_support, processConfig.support_type, processConfig.support_threshold_angle, processConfig.layer_height],
    ["1", "tree(auto)", "35", "0.2"], "only the support keys change");
  for (const bad of [{ support_type: "organic" }, { enable_support: "yes" }, { support_threshold_angle: 120 }]) {
    const refused = await call("slice_stl", { stl_path: SAMPLE_STL, bambu_model: "p1s", nozzle_diameter: "0.4", ...bad });
    assert.equal(refused.isError, true, JSON.stringify(bad));
  }
});

test("support overrides use Studio's keys and forms, and PrusaSlicer refuses them", async () => {
  const { orcaProcessOverrides, prusaSlicerOverrideArgs } = await import("../../dist/stl/stl-manipulator.js");
  assert.deepEqual(orcaProcessOverrides({ enableSupport: true, supportType: "tree(auto)", supportThresholdAngle: 35 }),
    { enable_support: "1", support_type: "tree(auto)", support_threshold_angle: "35" });
  assert.deepEqual(orcaProcessOverrides({ enableSupport: false }), { enable_support: "0" });
  assert.throws(() => prusaSlicerOverrideArgs({ enableSupport: true }), /Bambu Studio and OrcaSlicer only/);
  assert.deepEqual(prusaSlicerOverrideArgs({ layerHeight: 0.2 }), ["--layer-height", "0.2"]);
});

test("a Bambu printer with no SLICER_TYPE slices with Bambu Studio, as bambu-printer-mcp does", async (t) => {
  // FULU OrcaSlicer-bambulab v1.0.0's CLI segfaults on every slice (FULU #56/#57), so it is no longer the default.
  const install = await createFakeInstall(t);
  const { call } = await startServer(t, install, { PRINTER_TYPE: "bambu", SLICER_TYPE: "" });
  const result = await call("slice_stl", { stl_path: SAMPLE_STL, bambu_model: "p1s", nozzle_diameter: "0.4", scale: 2 });
  assert.equal(result.isError, undefined, text(result));
  await assertSliced(text(result));
  // Bambu Studio receives every flag unchanged; the Orca route would scale a copy of the mesh and drop --scale.
  const args = await install.args();
  assert.equal(args.at(-1), SAMPLE_STL, "the Bambu Studio CLI received the original model");
  assert.equal(args[args.indexOf("--scale") + 1], "2");
});

test("a relative TEMP_DIR reaches the slicer as an absolute output folder (Bambu Studio fails relative ones)", async (t) => {
  const install = await createFakeInstall(t);
  const { call } = await startServer(t, install, { TEMP_DIR: "server-temp" });
  const result = await call("slice_stl", { stl_path: SAMPLE_STL, bambu_model: "p1s", nozzle_diameter: "0.4" });
  assert.equal(result.isError, undefined, text(result));
  await assertSliced(text(result));
  const args = await install.args();
  const outputDir = args[args.indexOf("--outputdir") + 1];
  assert.ok(path.isAbsolute(outputDir), `--outputdir ${outputDir} must be absolute`);
  assert.ok(outputDir.startsWith(path.join(realpathSync(install.root), "server-temp")), outputDir);
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

test("concurrent slices of same-named inputs never share an output path", async (t) => {
  const install = await createFakeInstall(t);
  const { call } = await startServer(t, install);
  const inputs = [];
  for (const folder of ["first", "second"]) {
    const dir = path.join(install.root, folder);
    await fs.mkdir(dir, { recursive: true });
    const input = path.join(dir, "bracket.stl");
    await fs.copyFile(SAMPLE_STL, input);
    inputs.push(input);
  }
  const results = await Promise.all(inputs.map((stl_path) => call("slice_stl", { stl_path, bambu_model: "p1s" })));
  for (const result of results) assert.equal(result.isError, undefined, text(result));
  const [first, second] = results.map(text);
  assert.notEqual(first, second, "each operation must return its own file");
  assert.ok(first.endsWith("bracket_sliced.3mf") && second.endsWith("bracket_sliced.3mf"));
  for (const output of [first, second]) await assertSliced(output);
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

  // The CLI's own reason: result.json from this run's output directory, else the exit-code table.
  await install.setMode("resultjson");
  result = await slice();
  assert.equal(result.isError, true);
  assert.match(text(result), /exited with code 204 \(bambustudio: [^)]*\): Some objects are outside the plate boundary\. \[-52\]\./);
  await install.setMode("exit206");
  result = await slice();
  assert.equal(result.isError, true);
  assert.match(text(result), /exited with code 206 \(bambustudio: [^)]*\): a plate is empty or has no object fully inside it; arrange the model or place it on the plate \[-50\]/);
  assert.doesNotMatch(text(result), /outside the plate boundary/, "an earlier run's result.json never explains this one");

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
  // Each run writes into its own folder, so an older file can never be returned as this run's result.
  assert.doesNotMatch(text(result), /sample_cube_sliced\.3mf$/m);

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
  for (const option of ["bed_type", "load_filaments", "filament_colours", "orient", "arrange", "slice_plate", "template_name", "pause_at_layers"]) {
    assert.ok(sliceTool.inputSchema.properties[option], `slice_stl must expose ${option}`);
  }

  let result = await call("slice_stl", {
    stl_path: SAMPLE_STL, bambu_model: "p1s", bed_type: "cool_plate", orient: true, arrange: false,
    repetitions: 2, scale: 1.5, rotate: 90, slice_plate: 1, filament_colours: "161616", uptodate: true,
  });
  assert.equal(result.isError, undefined, text(result));
  let args = await install.args();
  assert.deepEqual(args.slice(0, 2), ["--slice", "1"]);
  for (const [flag, value] of [["--orient", "1"], ["--arrange", "0"], ["--clone-objects", "2"], ["--scale", "1.5"], ["--rotate", "90"]]) {
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

/** An axis-aligned box as ASCII STL, so rotation order shows in the received dimensions. */
/** One closed box's 12 binary STL facets (no header), at x, y on the bed. */
function boxStlAt(x0, y0, w, d, h) {
  const c = [[x0, y0, 0], [x0 + w, y0, 0], [x0 + w, y0 + d, 0], [x0, y0 + d, 0], [x0, y0, h], [x0 + w, y0, h], [x0 + w, y0 + d, h], [x0, y0 + d, h]];
  const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const out = Buffer.alloc(faces.length * 50);
  faces.forEach((face, i) => face.forEach((vertex, k) => c[vertex].forEach((value, axis) => out.writeFloatLE(value, i * 50 + 12 + k * 12 + axis * 4))));
  return out;
}
function binaryStl(facets) {
  const header = Buffer.alloc(84);
  header.writeUInt32LE(facets.length / 50, 80);
  return Buffer.concat([header, facets]);
}

function boxStl(x, y, z) {
  const v = (i) => [i & 1 ? x : 0, i & 2 ? y : 0, i & 4 ? z : 0];
  const faces = [[0, 2, 1], [1, 2, 3], [4, 5, 6], [5, 7, 6], [0, 1, 4], [1, 5, 4], [2, 6, 3], [3, 6, 7], [0, 4, 2], [2, 4, 6], [1, 3, 5], [3, 7, 5]];
  return `solid box\n${faces.map((face) => `facet normal 0 0 0\nouter loop\n${face.map((i) => `vertex ${v(i).join(" ")}`).join("\n")}\nendloop\nendfacet`).join("\n")}\nendsolid box\n`;
}

async function stlSize(file) {
  const vertices = (await fs.readFile(file, "utf8")).match(/vertex\s+\S+\s+\S+\s+\S+/g).map((line) => line.split(/\s+/).slice(1).map(Number));
  return [0, 1, 2].map((axis) => Math.round((Math.max(...vertices.map((p) => p[axis])) - Math.min(...vertices.map((p) => p[axis]))) * 1000) / 1000);
}

// OrcaSlicer 2.4.2's CLI segfaults in PartPlate::check_outside when --scale or
// --rotate-x/-y move an object below the bed while arranging (bambu-printer-mcp 1.1.34).
test("Orca STL transforms are applied to a mesh copy in Orca's order; BambuStudio keeps its flags", async (t) => {
  const install = await createFakeInstall(t);
  const { call, tempDir } = await startServer(t, install);
  const box = path.join(install.root, "box.stl");
  await fs.writeFile(box, boxStl(10, 20, 30));
  const transformFlags = ["--scale", "--rotate", "--rotate-x", "--rotate-y"];

  for (const slicerType of ["orcaslicer-bambulab", "orcaslicer"]) {
    await install.resetCapture();
    // Orca composes Rz*Ry*Rx after scaling, whatever the argument order: Z then X would leave it 10 mm tall.
    let result = await call("slice_stl", { stl_path: box, slicer_type: slicerType, slicer_path: install.executable, bambu_model: "p1s", rotate: 90, rotate_x: 90 });
    assert.equal(result.isError, undefined, text(result));
    let args = await install.args();
    assert.deepEqual(args.filter((arg) => transformFlags.includes(arg)), [], `${slicerType} must not receive transform flags`);
    assert.notEqual(args.at(-1), box, "the CLI receives a transformed copy");
    assert.deepEqual(await stlSize(install.inputCapture), [30, 10, 20]);
    assert.equal(existsSync(args.at(-1)), false, "the transformed copy is deleted after slicing");

    await install.resetCapture();
    result = await call("slice_stl", { stl_path: box, slicer_type: slicerType, slicer_path: install.executable, bambu_model: "p1s", scale: 2, rotate_y: 90 });
    assert.equal(result.isError, undefined, text(result));
    assert.deepEqual(await stlSize(install.inputCapture), [60, 40, 20]);

    // A Z rotation alone cannot move the object below the bed, so the flag is kept.
    await install.resetCapture();
    result = await call("slice_stl", { stl_path: box, slicer_type: slicerType, slicer_path: install.executable, bambu_model: "p1s", rotate: 45, repetitions: 3 });
    assert.equal(result.isError, undefined, text(result));
    args = await install.args();
    assert.equal(args.at(-1), box);
    assert.equal(args[args.indexOf("--rotate") + 1], "45");
    // Orca rejects --repetitions for one STL and copies the loaded model with --clone-objects.
    assert.equal(args[args.indexOf("--clone-objects") + 1], "3");
    assert.equal(args.includes("--repetitions"), false);

    await install.resetCapture();
    result = await call("slice_stl", { stl_path: box, slicer_type: slicerType, slicer_path: install.executable, bambu_model: "p1s", repetitions: 2, clone_objects: "2" });
    assert.equal(result.isError, true);
    assert.match(text(result), /either repetitions or clone_objects/);
    await assertNotExecuted(install);
  }
  assert.deepEqual((await fs.readdir(tempDir, { recursive: true })).filter((entry) => entry.includes("_transformed")), [], "no transformed mesh is left behind");

  // A 3MF keeps its objects, so the crashing combination is refused before the slicer runs.
  const project = path.join(install.root, "plate.3mf");
  await fs.writeFile(project, await zipBytes({ "3D/3dmodel.model": '<?xml version="1.0"?><model unit="millimeter"><resources/><build/></model>' }));
  for (const transform of [{ scale: 1.5 }, { rotate_x: 30 }, { rotate_y: 30 }]) {
    await install.resetCapture();
    const result = await call("slice_stl", { stl_path: project, slicer_type: "orcaslicer-bambulab", slicer_path: install.executable, bambu_model: "p1s", arrange: true, ...transform });
    assert.equal(result.isError, true, JSON.stringify(transform));
    assert.match(text(result), /crashes when scale above 1, rotate_x or rotate_y moves a 3MF object below the bed while arranging\. Set arrange to false/);
    await assertNotExecuted(install);
  }

  // BambuStudio routes keep every flag, including on the same STL.
  await install.resetCapture();
  const result = await call("slice_stl", { stl_path: box, bambu_model: "p1s", scale: 2, rotate: 90, rotate_x: 90, rotate_y: 45, repetitions: 2 });
  assert.equal(result.isError, undefined, text(result));
  const args = await install.args();
  assert.equal(args.at(-1), box);
  for (const [flag, value] of [["--scale", "2"], ["--rotate", "90"], ["--rotate-x", "90"], ["--rotate-y", "45"], ["--clone-objects", "2"]]) {
    assert.equal(args[args.indexOf(flag) + 1], value, `${flag} must be ${value}`);
  }
  assert.equal(args.includes("--repetitions"), false);
});

test("Bambu Studio copies STL with clone-objects but preserves selected 3MF repetitions", async t => {
  const install = await createFakeInstall(t);
  const { call } = await startServer(t, install);
  let result = await call("slice_stl", { stl_path: SAMPLE_STL, bambu_model: "p1s", repetitions: 2, slice_plate: 0 });
  assert.equal(result.isError, undefined, text(result));
  let args = await install.args();
  assert.equal(args[args.indexOf("--clone-objects") + 1], "2");
  assert.equal(args.includes("--repetitions"), false);
  await install.resetCapture();
  result = await call("slice_stl", { stl_path: SAMPLE_STL, bambu_model: "p1s", repetitions: 2, clone_objects: "2" });
  assert.equal(result.isError, true); await assertNotExecuted(install);
  const project = path.join(install.root, "original.3mf");
  await fs.writeFile(project, await zipBytes({ "3D/3dmodel.model": '<?xml version="1.0"?><model unit="millimeter"><resources/><build/></model>' }));
  result = await call("slice_stl", { stl_path: project, bambu_model: "p1s", repetitions: 2, slice_plate: 1 });
  assert.equal(result.isError, undefined, text(result));
  args = await install.args();
  assert.equal(args[args.indexOf("--repetitions") + 1], "2");
  assert.equal(args.includes("--clone-objects"), false);
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

test("a designer's 3MF slices with its own process; strength never weakens it; a bare 3MF keeps the preset", async (t) => {
  // 2026-11-04: a designer's caliper card (0.16 mm, 100% infill, 2 walls) was sliced at the preset's values,
  // and Strong lowered its infill to 25%: its fold hinges and snaps no longer worked.
  const install = await createFakeInstall(t);
  const { call } = await startServer(t, install);
  const model = '<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="10" z="0"/><vertex x="0" y="0" z="10"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="0" v2="3" v3="2"/><triangle v1="1" v2="2" v3="3"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>';
  const designer = path.join(install.root, "designer.3mf");
  await fs.writeFile(designer, await zipBytes({ "3D/3dmodel.model": model, "Metadata/project_settings.config": JSON.stringify({
    layer_height: "0.16", sparse_infill_density: "100%", wall_loops: "2", print_settings_id: "Designer",
    filament_settings_id: ["Bambu PLA Basic @BBL X1C"], filament_type: ["PLA"], filament_colour: ["#000000"] }) }));
  const bare = path.join(install.root, "bare.3mf");
  await fs.writeFile(bare, await zipBytes({ "3D/3dmodel.model": model }));
  const sliceWith = async (file, extra = {}) => {
    const result = await call("slice_stl", { stl_path: file, bambu_model: "p1s", nozzle_diameter: "0.4", slice_plate: 1, arrange: false, orient: false, ...extra });
    assert.equal(result.isError, undefined, text(result));
    const args = await install.args();
    const { layer_height, wall_loops, sparse_infill_density } = JSON.parse(await fs.readFile(args[args.indexOf("--load-settings") + 1].split(";")[1], "utf8"));
    return { layer_height, wall_loops, sparse_infill_density };
  };
  assert.deepEqual(await sliceWith(designer), { layer_height: "0.16", wall_loops: "2", sparse_infill_density: "100%" }, "the designer's own process");
  assert.deepEqual(await sliceWith(designer, { strength: "strong" }), { layer_height: "0.16", wall_loops: "4", sparse_infill_density: "100%" },
    "strong adds walls but keeps the designer's denser infill");
  assert.equal((await sliceWith(designer, { quality: "fine" })).layer_height, "0.12", "a chosen quality still applies");
  assert.equal((await sliceWith(designer, { sparse_infill_density: "20%" })).sparse_infill_density, "20%", "an explicit value is written as given");
  assert.equal((await sliceWith(bare)).layer_height, "0.2", "a 3MF without its own process keeps the preset");
  // get_slice_settings says which of the two slice_stl just did, so a client never reads the 3MF itself.
  const settingsOf = async (file, extra = {}) => JSON.parse(text(await call("get_slice_settings", { source_path: file, ...extra })));
  assert.equal((await settingsOf(designer)).own_process, true, "the designer's 3MF slices with its own process");
  const machineOnly = path.join(install.root, "machine-only.3mf");
  await fs.writeFile(machineOnly, await zipBytes({ "3D/3dmodel.model": model, "Metadata/project_settings.config": JSON.stringify({ printer_model: "Bambu Lab P1S" }) }));
  assert.equal((await settingsOf(machineOnly)).own_process, false, "settings without a process slice with the preset");
  assert.equal((await settingsOf(designer, { slicer_type: "prusaslicer" })).own_process, false, "PrusaSlicer never takes a 3MF's Bambu process");
  assert.equal((await settingsOf(designer, { slicer_type: "orcaslicer" })).own_process, false, "generic OrcaSlicer keeps its own profile without a bambu_model");
  assert.equal((await settingsOf(designer, { slicer_type: "orcaslicer", bambu_model: "p1s" })).own_process, true);
  // A 3MF with no settings says so, so a client can tell "none to keep" from a file it couldn't read.
  const none = await settingsOf(bare);
  assert.equal(none.raw_key_count, 0);
  assert.equal(none.own_process, false);
  assert.equal(none.extracted_settings_path, undefined);
  const unreadable = path.join(install.root, "unreadable.3mf");
  await fs.writeFile(unreadable, "not a zip");
  assert.equal((await call("get_slice_settings", { source_path: unreadable })).isError, true, "a file that can't be read is an error, not a file without settings");
  const corrupt = path.join(install.root, "corrupt.3mf");
  await fs.writeFile(corrupt, await zipBytes({ "3D/3dmodel.model": model, "Metadata/project_settings.config": '{"layer_height": "0.16", "sparse_infill_dens' }));
  assert.equal((await call("get_slice_settings", { source_path: corrupt })).isError, true, "settings that can't be read are an error, not a file without settings");
  // A PrusaSlicer project's settings are read too, not refused as unreadable.
  const prusa = path.join(install.root, "prusa.3mf");
  await fs.writeFile(prusa, await zipBytes({ "3D/3dmodel.model": model, "Metadata/Slic3r_PE.config": "; generated by PrusaSlicer\nlayer_height = 0.15\nfill_density = 20%\n" }));
  const prusaSettings = await settingsOf(prusa);
  assert.equal(prusaSettings.raw_key_count, 2);
  assert.ok(existsSync(prusaSettings.extracted_settings_path));
  // Each slice extracted the designer's settings to its own directory and removed it when the call ended;
  // get_slice_settings hands its path back, so that one stays.
  assert.ok(existsSync((await settingsOf(designer)).extracted_settings_path));
  const extractions = path.join(install.root, "server-temp", "templates");
  const left = existsSync(extractions) ? await fs.readdir(extractions) : [];
  assert.deepEqual(left.filter(entry => /settings/.test(entry)), [], "no slice leaves its extraction behind");
  // The slice's own arguments, as slice_stl takes them: own_process is what that slice does, decided here.
  assert.equal((await settingsOf(designer, { quality: "standard", strength: "standard" })).own_process, true, "standard changes nothing");
  assert.equal((await settingsOf(designer, { layer_height: 0.42, nozzle_diameter: "0.6" })).own_process, false, "a layer height valid for the slice's own nozzle is checked against it");
  for (const extra of [{ slicer_profile: path.join(install.root, "mine.json") }, { template_3mf_path: bare }, { layer_height: 0.2 }, { wall_loops: 3 },
    { sparse_infill_density: "20%" }, { quality: "fine" }, { strength: "strong" }, { enable_support: false }])
    assert.equal((await settingsOf(designer, extra)).own_process, false, `${Object.keys(extra)[0]} replaces or changes the designer's process`);
  // With source_path, template_name is the slice's template, as slice_stl takes it, never the file read.
  await fs.mkdir(path.join(install.root, "templates"), { recursive: true });
  await fs.writeFile(path.join(install.root, "templates", "house.json"), JSON.stringify({ layer_height: "0.2" }));
  assert.equal((await settingsOf(designer, { template_name: "house" })).own_process, false, "a named template replaces the designer's process");
  assert.equal((await call("get_slice_settings", { source_path: designer, template_name: "nowhere" })).isError, true, "an unknown template is refused, as slice_stl refuses it");
  for (const invalid of [{ quality: "bogus" }, { layer_height: -1 }, { sparse_infill_density: "200%" }, { support_type: "organic" },
    { slicer_profile: path.join(install.root, "mine.json"), layer_height: -1 }])
    assert.equal((await call("get_slice_settings", { source_path: designer, ...invalid })).isError, true, `${JSON.stringify(invalid)} is refused, as slice_stl refuses it`);
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

// A slicer that waits on a dialog (no CPU, no output) is stopped after SLICER_STALL_SECONDS and reported with the stable
// code slicer-waiting-on-dialog, not after SLICER_TIMEOUT_MS, and never as the slicer's verdict on the model.
test("slice_stl stops a slicer that waits on a dialog and reports slicer-waiting-on-dialog", { skip: process.platform !== "darwin" && "the stall check runs on macOS only" }, async (t) => {
  const install = await createFakeInstall(t);
  const { call } = await startServer(t, install, { SLICER_STALL_SECONDS: "1" });
  await install.setMode("stall");
  const started = Date.now();
  const stalled = await call("slice_stl", { stl_path: SAMPLE_STL, bambu_model: "p1s" });
  assert.equal(stalled.isError, true);
  assert.equal(stalled.structuredContent.code, "slicer-waiting-on-dialog");
  assert.equal(stalled.structuredContent.slicer_report, undefined, "a stalled slicer gave no verdict on the model");
  assert.match(text(stalled), /nothing was sent to the printer/i);
  assert.ok(Date.now() - started < 15_000, `reported in ${Date.now() - started} ms`);
  // Computing without writing is not a stall.
  await install.setMode("busy");
  const busy = await call("slice_stl", { stl_path: SAMPLE_STL, bambu_model: "p1s" });
  assert.equal(busy.isError, undefined, text(busy));
});

// On macOS each Bambu-compatible slice runs with a fresh, empty CFFIXED_USER_HOME of its own under TEMP_DIR (replacing
// one the server inherited), removed after the slice, so AppKit can't find crash history that raises its alert.
test("slice_stl gives a Bambu-compatible slicer its own home folder on macOS", async (t) => {
  const install = await createFakeInstall(t);
  const inherited = path.join(install.root, "inherited-home");
  await fs.mkdir(inherited);
  const { call, tempDir } = await startServer(t, install, { CFFIXED_USER_HOME: inherited });
  const result = await call("slice_stl", { stl_path: SAMPLE_STL, bambu_model: "p1s" });
  assert.equal(result.isError, undefined, text(result));
  const launch = JSON.parse(await fs.readFile(path.join(install.root, "launch.json"), "utf8"));
  if (process.platform !== "darwin") {
    assert.equal(launch.home, inherited, "only macOS slicers get a home of their own");
    return;
  }
  assert.ok(launch.homeExists, "the slicer's home existed while it ran");
  assert.ok(launch.home.startsWith(path.resolve(tempDir) + path.sep), launch.home);
  assert.deepEqual(await fs.readdir(inherited), []);
  assert.equal(existsSync(launch.home), false, "the home is removed after the slice");
});

// watchForStall itself, on every platform with ps or /proc: an idle child is reported, a computing one and one that
// exits are not.
test("watchForStall reports an idle child, not a computing or finished one", async () => {
  const { spawn } = await import("node:child_process");
  const { watchForStall } = await import("../../dist/slicer/slicer-launch.js");
  const run = (script, ms) => new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let stalled = false;
    watchForStall(child, 1, () => { stalled = true; child.kill("SIGKILL"); });
    const timer = setTimeout(() => child.kill("SIGKILL"), ms);
    child.on("exit", () => { clearTimeout(timer); resolve(stalled); });
  });
  assert.equal(await run('console.log("started"); setInterval(() => {}, 1 << 30)', 10_000), true, "idle after starting");
  assert.equal(await run("for (const end = Date.now() + 2500; Date.now() < end;) Math.sqrt(Math.random())", 10_000), false, "computing");
  assert.equal(await run('console.log("done")', 10_000), false, "finished");
});

test("slicer stall settings and CPU times parse as ps writes them", async () => {
  const { parseCpuTime, slicerStallSeconds } = await import("../../dist/slicer/slicer-launch.js");
  assert.equal(parseCpuTime("   0:03.11\n"), 3.11);
  assert.equal(parseCpuTime("61:02.50"), 3662.5);
  assert.equal(parseCpuTime("00:01:02"), 62);
  assert.equal(parseCpuTime("2-01:00:00"), 2 * 86400 + 3600);
  assert.equal(parseCpuTime(""), undefined);
  assert.equal(slicerStallSeconds(undefined), 20);
  assert.equal(slicerStallSeconds("0"), 0);
  assert.equal(slicerStallSeconds("-1"), 20);
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
    assert.equal(path.basename(text(result)), "sample_cube.gcode");
    assert.ok(text(result).startsWith(tempDir + path.sep), "output stays inside TEMP_DIR");
    assert.equal(await fs.readFile(text(result), "utf8"), "; generic gcode\n");
    const args = JSON.parse(await fs.readFile(capture, "utf8"));
    assert.equal(args.includes("--load-settings"), false, `${slicerType} must not receive Bambu CLI flags`);
    assert.ok(args.includes(profile), `${slicerType} receives its profile unchanged`);
  }

  // PrusaSlicer and Slic3r load one filament preset after the main config; later --load files override earlier ones.
  const filament = path.join(root, "PLA preset.ini");
  await fs.writeFile(filament, "filament_type = PLA\ntemperature = 215\n");
  for (const slicerType of ["prusaslicer", "slic3r"]) {
    const sliced = await call("slice_stl", { stl_path: SAMPLE_STL, slicer_type: slicerType, slicer_profile: profile, load_filaments: filament });
    assert.equal(sliced.isError, undefined, `${slicerType}: ${text(sliced)}`);
    const argv = JSON.parse(await fs.readFile(capture, "utf8"));
    assert.deepEqual(argv.slice(0, 7), ["--slice", "--output", text(sliced), "--load", profile, "--load", filament]);
    assert.equal(argv.at(-1), SAMPLE_STL);
  }
  for (const [loadFilaments, pattern] of [[`${filament};${filament}`, /takes one filament preset/], [path.join(root, "pla.json"), /as \.ini files/]]) {
    const refused = await call("slice_stl", { stl_path: SAMPLE_STL, slicer_type: "prusaslicer", slicer_profile: profile, load_filaments: loadFilaments });
    assert.equal(refused.isError, true);
    assert.match(text(refused), pattern);
  }

  await fs.writeFile(modeFile, "fail");
  const failed = await call("slice_stl", { stl_path: SAMPLE_STL, slicer_type: "prusaslicer", slicer_profile: profile });
  assert.equal(failed.isError, true);
  assert.match(text(failed), /exited with code 3/);
  assert.match(text(failed), /unknown option in profile\.ini/);
  assert.doesNotMatch(text(failed), /printer connectivity/i);
  assert.doesNotMatch(text(failed), /sample_cube\.gcode$/m, "a failed run cannot return a previous G-code");
});

test("print-sheet overrides: layer_height, wall_loops and sparse_infill_density map to each slicer", async (t) => {
  // Bambu-compatible CLI: written over the resolved process, winning over a template.
  const install = await createFakeInstall(t);
  const { call } = await startServer(t, install);
  const template = path.join(install.root, "strong.json");
  await fs.writeFile(template, JSON.stringify({ name: "Strong", from: "User", inherits: "0.20mm Standard @BBL X1C", wall_loops: "6", layer_height: "0.12" }));
  let result = await call("slice_stl", { stl_path: SAMPLE_STL, bambu_model: "p1s", slicer_profile: template,
    layer_height: 0.28, wall_loops: 4, sparse_infill_density: "25%" });
  assert.equal(result.isError, undefined, text(result));
  let args = await install.args();
  const processConfig = JSON.parse(await fs.readFile(args[args.indexOf("--load-settings") + 1].split(";")[1], "utf8"));
  assert.equal(processConfig.layer_height, "0.28");
  assert.equal(processConfig.wall_loops, "4");
  assert.equal(processConfig.sparse_infill_density, "25%");
  assert.equal(JSON.parse(await fs.readFile(template, "utf8")).wall_loops, "6", "the caller's profile is not modified");
  // A bare number is a percentage; invalid values stop before the slicer runs.
  await install.resetCapture();
  result = await call("slice_stl", { stl_path: SAMPLE_STL, bambu_model: "p1s", sparse_infill_density: 15 });
  assert.equal(result.isError, undefined, text(result));
  args = await install.args();
  assert.equal(JSON.parse(await fs.readFile(args[args.indexOf("--load-settings") + 1].split(";")[1], "utf8")).sparse_infill_density, "15%");
  for (const [bad, pattern] of [[{ layer_height: 0 }, /layer_height/], [{ wall_loops: 2.5 }, /wall_loops/], [{ sparse_infill_density: "150%" }, /sparse_infill_density/], [{ layer_height: "0.2" }, /layer_height/]]) {
    await install.resetCapture();
    result = await call("slice_stl", { stl_path: SAMPLE_STL, bambu_model: "p1s", ...bad });
    assert.equal(result.isError, true, JSON.stringify(bad));
    assert.match(text(result), pattern);
    await assertNotExecuted(install);
  }

  // PrusaSlicer/Slic3r flags, generic OrcaSlicer process copy, Cura refused.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "override-slicers-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const capture = path.join(root, "args.json");
  const executable = path.join(root, "fake-slicer");
  await fs.writeFile(executable, `#!${process.execPath}
const fs = require("fs"); const path = require("path");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify(args));
if (args.includes("--outputdir")) {
  const settings = args.flatMap((arg, i) => args[i - 1] === "--load-settings" ? [arg] : []);
  fs.writeFileSync(${JSON.stringify(capture)} + ".process", fs.readFileSync(settings.at(-1), "utf8"));
  const filaments = args.flatMap((arg, i) => args[i - 1] === "--load-filaments" ? [fs.readFileSync(arg, "utf8")] : []);
  fs.writeFileSync(${JSON.stringify(capture)} + ".filaments", JSON.stringify(filaments));
  fs.writeFileSync(path.join(args[args.indexOf("--outputdir") + 1], "plate_1.gcode"), "; orca\\n");
} else {
  const flag = args.includes("--output") ? "--output" : "-o";
  fs.writeFileSync(args[args.indexOf(flag) + 1], "; generic gcode\\n");
}
`, { mode: 0o755 });
  // HOME is the test root, so only this fake slicer's bundled profiles are installed.
  const generic = await startServer(t, { root, executable }, { SLICER_TYPE: "prusaslicer", HOME: root });
  const overrides = { layer_height: 0.12, wall_loops: 2, sparse_infill_density: "15%" };
  for (const slicerType of ["prusaslicer", "slic3r"]) {
    result = await generic.call("slice_stl", { stl_path: SAMPLE_STL, slicer_type: slicerType, ...overrides });
    assert.equal(result.isError, undefined, `${slicerType}: ${text(result)}`);
    args = JSON.parse(await fs.readFile(capture, "utf8"));
    assert.deepEqual(args.slice(args.indexOf("--layer-height"), args.indexOf("--layer-height") + 6),
      ["--layer-height", "0.12", "--perimeters", "2", "--fill-density", "15%"]);
    assert.equal(args.at(-1), SAMPLE_STL);
  }
  // quality and strength: the server owns the numbers, for PrusaSlicer as for Bambu-compatible slicers.
  result = await generic.call("slice_stl", { stl_path: SAMPLE_STL, slicer_type: "prusaslicer", quality: "draft", strength: "max", nozzle_diameter: "0.6" });
  assert.equal(result.isError, undefined, text(result));
  args = JSON.parse(await fs.readFile(capture, "utf8"));
  assert.deepEqual(args.slice(args.indexOf("--layer-height"), args.indexOf("--layer-height") + 6),
    ["--layer-height", "0.42", "--perimeters", "6", "--fill-density", "40%"], "draft scales with a 0.6 mm nozzle");
  result = await generic.call("slice_stl", { stl_path: SAMPLE_STL, slicer_type: "prusaslicer", repetitions: 3 });
  assert.equal(result.isError, true, "PrusaSlicer would slice one copy without a word");
  assert.match(text(result), /Copies \(repetitions\) need the Bambu Studio or OrcaSlicer CLI/);
  result = await generic.call("slice_stl", { stl_path: SAMPLE_STL, slicer_type: "prusaslicer", quality: "standard", strength: "standard" });
  assert.equal(result.isError, undefined, text(result));
  assert.equal(JSON.parse(await fs.readFile(capture, "utf8")).includes("--layer-height"), false, "standard leaves the preset alone");
  const machine = path.join(root, "machine.json");
  const processProfile = path.join(root, "process.json");
  await fs.writeFile(machine, JSON.stringify({ type: "machine", name: "My printer" }));
  await fs.writeFile(processProfile, JSON.stringify({ type: "process", name: "My process", layer_height: "0.2", wall_loops: "3" }));
  result = await generic.call("slice_stl", { stl_path: SAMPLE_STL, slicer_type: "orcaslicer", slicer_profile: `${machine};${processProfile}`, ...overrides });
  assert.equal(result.isError, undefined, text(result));
  const orcaProcess = JSON.parse(await fs.readFile(`${capture}.process`, "utf8"));
  assert.deepEqual([orcaProcess.name, orcaProcess.layer_height, orcaProcess.wall_loops, orcaProcess.sparse_infill_density], ["My process", "0.12", "2", "15%"]);
  assert.equal(JSON.parse(await fs.readFile(processProfile, "utf8")).layer_height, "0.2", "the caller's profile is not modified");
  // Generic OrcaSlicer takes load_filaments (get_printer_filaments' slots[].profile) as --load-filaments.
  const orcaFilament = path.join(root, "Generic PLA.json");
  await fs.writeFile(orcaFilament, JSON.stringify({ name: "Generic PLA", filament_type: ["PLA"] }));
  result = await generic.call("slice_stl", { stl_path: SAMPLE_STL, slicer_type: "orcaslicer", slicer_profile: `${machine};${processProfile}`, load_filaments: orcaFilament });
  assert.equal(result.isError, undefined, text(result));
  args = JSON.parse(await fs.readFile(capture, "utf8"));
  assert.equal(args[args.indexOf("--load-filaments") + 1], orcaFilament);
  result = await generic.call("slice_stl", { stl_path: SAMPLE_STL, slicer_type: "orcaslicer", slicer_profile: `${machine};${processProfile}`, load_filaments: orcaFilament, filament_profile: machine });
  assert.match(text(result), /either load_filaments or filament_profile/);
  // A bundled preset inherits its settings; the CLI gets them merged in, and the bundled file is untouched.
  const bundle = path.join(root, "resources", "profiles", "OrcaFilamentLibrary", "filament");
  await fs.mkdir(bundle, { recursive: true });
  await fs.writeFile(path.join(bundle, "fdm_filament_petg.json"), JSON.stringify({ name: "fdm_filament_petg", instantiation: "false", filament_type: ["PETG"], nozzle_temperature: ["240"], hot_plate_temp: ["70"] }));
  const petg = path.join(bundle, "Generic PETG @System.json");
  await fs.writeFile(petg, JSON.stringify({ name: "Generic PETG @System", inherits: "fdm_filament_petg", from: "system", instantiation: "true", hot_plate_temp: ["80"], compatible_printers: [] }));
  // An explicit filament also replaces the "|filament" default in the profile setting.
  result = await generic.call("slice_stl", { stl_path: SAMPLE_STL, slicer_type: "orcaslicer", slicer_profile: `${machine};${processProfile}|${orcaFilament}`, load_filaments: petg });
  assert.equal(result.isError, undefined, text(result));
  const loaded = JSON.parse(await fs.readFile(`${capture}.filaments`, "utf8")).map((content) => JSON.parse(content));
  assert.equal(loaded.length, 1, "the chosen filament is the only slot");
  assert.deepEqual([loaded[0].name, loaded[0].filament_type, loaded[0].nozzle_temperature, loaded[0].hot_plate_temp, loaded[0].inherits, loaded[0].from],
    ["Generic PETG @System", ["PETG"], ["240"], ["80"], "", "User"], "inherited temperatures reach the CLI; the leaf's own values win");
  assert.equal(JSON.parse(await fs.readFile(petg, "utf8")).inherits, "fdm_filament_petg");
  result = await generic.call("slice_stl", { stl_path: SAMPLE_STL, slicer_type: "orcaslicer", slicer_profile: machine, ...overrides });
  assert.equal(result.isError, true);
  assert.match(text(result), /need a readable process profile/);
  result = await generic.call("slice_stl", { stl_path: SAMPLE_STL, slicer_type: "cura", ...overrides });
  assert.equal(result.isError, true);
  assert.match(text(result), /not mapped for Cura/);
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
  // Studio's own result.json for this run, verbatim: a cube slices cleanly.
  assert.equal(result.structuredContent.slicer_result.return_code, 0);
  assert.deepEqual(result.structuredContent.slicer_result.sliced_plates.map((plate) => plate.warning_message), [""]);
});

// Bambu Studio's own checks: its result.json, verbatim, from the Scan to Make
// stove gap filler sliced for a P1S. slice_stl used to drop the warnings.
test("slice_stl returns Bambu Studio's result.json, warnings and errors included", async (t) => {
  const install = await createFakeInstall(t);
  const { call } = await startServer(t, install, { BAMBU_PROFILES_ROOT: path.dirname(install.bbl) });
  const slice = () => call("slice_stl", { stl_path: SAMPLE_STL, bambu_model: "p1s" });

  await install.setMode("studio:p1s-floating-cantilever.json");
  let result = await slice();
  assert.equal(result.isError, undefined, text(result));
  assert.equal(result.content.length, 1);
  assert.equal(text(result), result.structuredContent.path);
  await assertSliced(result.structuredContent.path);
  assert.deepEqual(result.structuredContent.slicer_result, await studioResult("p1s-floating-cantilever.json"));
  // Its verdict and words, so a client never reads result.json's format (Counterpart PRD §8.0 item 9).
  assert.equal(result.structuredContent.slicer_report.failed, false);
  assert.match(result.structuredContent.slicer_report.message, /floating cantilever/);

  // Studio's auto-orient failure: return code -100, exit 156, five empty-layer lines.
  const failed = await studioResult("p1s-empty-layers.json");
  await install.setMode("studio:p1s-empty-layers.json:156");
  result = await slice();
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent.slicer_result, failed);
  assert.equal(result.structuredContent.slicer_report.failed, true);
  // A person is told a plain sentence; Studio's own words follow it, and stay whole in slicer_message.
  const plain = "The slicer couldn't slice this model. Its own message is kept for the log.";
  assert.equal(result.structuredContent.slicer_report.message, plain);
  assert.ok(result.structuredContent.slicer_report.slicer_message.startsWith(failed.error_string));
  assert.ok(text(result).startsWith(`${plain}\nThe slicer said: ${failed.error_string}\n${failed.sliced_plates[0].warning_message.trim()}\n`), text(result));
  assert.match(text(result), /exited with code 156 \(bambustudio: [^)]*\): Failed slicing the model\./);
  assert.equal(result.structuredContent.slicer.phase, "execution");

  // The CLI's return code fails the slice even when the process exits 0.
  await install.setMode("studio:p1s-empty-layers.json");
  result = await slice();
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent.slicer_result, failed);
  assert.ok(text(result).startsWith(`${plain}\nThe slicer said: ${failed.error_string}\n`), text(result));
  assert.match(text(result), /exited with code 0, but its result\.json reports return_code -100\./);

  // No result.json: the path alone; a refusal without one still leads with its plain sentence (exit 206 is -50, the empty plate).
  await install.setMode("ok");
  result = await slice();
  assert.equal(result.isError, undefined, text(result));
  assert.deepEqual(result.structuredContent, { path: text(result) });
  await install.setMode("exit206");
  result = await slice();
  const empty = "Nothing on this plate can be printed: no part sits fully on the bed. A part is off the plate or across its edge, or the model is bigger than the bed.";
  assert.ok(text(result).startsWith(`${empty}\nThe slicer said: `), text(result));
  assert.equal(result.structuredContent.slicer_result, undefined);
  assert.equal(result.structuredContent.slicer_report.failed, true);
  assert.equal(result.structuredContent.slicer_report.message, empty);
});

test("unsupported slicers refuse pause_at_layers before running rather than ignoring them", async t => {
  const install = await createFakeInstall(t);
  const { call } = await startServer(t, install);
  const result = await call('slice_stl', {stl_path: SAMPLE_STL, slicer_type: 'prusaslicer', pause_at_layers: [3]});
  assert.equal(result.isError, true);
  assert.match(text(result), /Pausing at a layer needs the Bambu Studio or OrcaSlicer CLI/);
  assert.equal(existsSync(path.join(install.root, "args.json")), false);
});

test("quality and strength map to slicer settings; explicit values win; bad values are refused", async () => {
  const { withPrintQuality } = await import("../../dist/slicer/print-quality.js");
  assert.deepEqual(withPrintQuality({ quality: "fine", strength: "strong" }, 0.4), { quality: "fine", strength: "strong", layer_height: 0.12, wall_loops_floor: 4, sparse_infill_density_floor: "25%" }, "strength only raises the process's own walls and infill");
  assert.equal(withPrintQuality({ quality: "fine", layer_height: 0.16 }, 0.4).layer_height, 0.16);
  assert.deepEqual(withPrintQuality({ stl_path: "x" }, 0.4), { stl_path: "x" });
  assert.throws(() => withPrintQuality({ quality: "ultra" }, 0.4), /quality must be one of/);
  assert.throws(() => withPrintQuality({ quality: null }, 0.4), /quality must be one of/, "null is not Standard");
});

test("PrusaSlicer strength floors keep a loaded config's own higher walls and infill", async () => {
  const { prusaSlicerOverrideArgs } = await import("../../dist/stl/stl-manipulator.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "prusa-floor-"));
  const dense = path.join(dir, "dense.ini"), light = path.join(dir, "light.ini");
  await fs.writeFile(dense, "perimeters = 2\nfill_density = 100%\n");
  await fs.writeFile(light, "perimeters = 2\nfill_density = 15%\n");
  const strong = { wallLoopsFloor: 4, sparseInfillDensityFloor: "25%" };
  assert.deepEqual(prusaSlicerOverrideArgs(strong, [dense]), ["--perimeters", "4", "--fill-density", "100%"]);
  assert.deepEqual(prusaSlicerOverrideArgs(strong, [light]), ["--perimeters", "4", "--fill-density", "25%"]);
  assert.deepEqual(prusaSlicerOverrideArgs({ ...strong, sparseInfillDensity: "10%" }, [dense]), ["--perimeters", "4", "--fill-density", "10%"], "an explicit value is written as given");
  assert.deepEqual(prusaSlicerOverrideArgs(strong), ["--perimeters", "4", "--fill-density", "25%"], "no config: the minimum");
  await fs.rm(dir, { recursive: true, force: true });
});

test("two same-named projects' settings extract to distinct files, so concurrent slices can't swap processes", async () => {
  const { extractBambuTemplateSettings } = await import("../../dist/slicer/templates.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "template-extract-"));
  const write = async (sub, layer) => {
    await fs.mkdir(path.join(dir, sub));
    const file = path.join(dir, sub, "model.3mf");
    await fs.writeFile(file, await zipBytes({ "Metadata/project_settings.config": JSON.stringify({ layer_height: layer }) }));
    return file;
  };
  const out = path.join(dir, "out");
  const [a, b] = await Promise.all([write("a", "0.16"), write("b", "0.28")].map(async p => extractBambuTemplateSettings(await p, out)));
  assert.notEqual(a, b);
  assert.equal(JSON.parse(await fs.readFile(a, "utf8")).layer_height, "0.16");
  assert.equal(JSON.parse(await fs.readFile(b, "utf8")).layer_height, "0.28");
  await fs.rm(dir, { recursive: true, force: true });
});

test("every extraction has its own path, even of the same project, and an operation removes what it extracted", async (t) => {
  const { extractBambuTemplateSettings, withExtractedSettingsCleanup } = await import("../../dist/slicer/templates.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "template-extract-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const project = path.join(dir, "model.3mf");
  await fs.writeFile(project, await zipBytes({ "Metadata/project_settings.config": JSON.stringify({ layer_height: "0.16" }) }));
  const out = path.join(dir, "out");
  const exists = file => fs.access(file).then(() => true, () => false);
  // The same project sliced twice at once: one call's write can't truncate the file the other is reading.
  const same = await Promise.all([1, 2, 3].map(() => extractBambuTemplateSettings(project, out)));
  assert.equal(new Set(same).size, 3);
  let during, kept;
  await withExtractedSettingsCleanup(async () => {
    during = await Promise.all([1, 2].map(() => extractBambuTemplateSettings(project, out)));
    kept = await Promise.all([1, 2].map(() => extractBambuTemplateSettings(project, out, { keep: true })));
    for (const file of during) assert.ok(await exists(file), "present while the operation runs");
  });
  for (const file of during) assert.equal(await exists(path.dirname(file)), false, "removed when it settles");
  assert.equal(kept[0], kept[1], "a path handed back to the caller is named by content, so repeat calls reuse one file");
  assert.equal(JSON.parse(await fs.readFile(kept[0], "utf8")).layer_height, "0.16", "and it stays");
  assert.deepEqual((await fs.readdir(out)).filter(entry => entry.endsWith(".partial")), []);
  await assert.rejects(withExtractedSettingsCleanup(async () => {
    during = [await extractBambuTemplateSettings(project, out)];
    throw new Error("slice failed");
  }), /slice failed/);
  assert.equal(await exists(during[0]), false, "removed when the operation fails too");
});
