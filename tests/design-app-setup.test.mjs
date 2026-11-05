// blender_mcp_setup and fusion_mcp_setup, against stand-ins for uvx, launchctl, tar's input and the network:
// temporary Blender add-on and Fusion AddIns folders, never the person's own apps.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BlenderAddonSetup, FusionAddinSetup, FUSION_ADDIN_PIN, FUSION_PORT_AGENT_LABEL, defaultSetupSystem, selectBlenderAddonTarget } from "../dist/design-app-setup.js";
import { FUSION_MCP_DEFAULT_ARGS, FUSION_MCP_PINNED_COMMIT as FUSION_MCP_PIN } from "../dist/fusion-mcp-bridge.js";
import { TOOL_ANNOTATIONS } from "../dist/tool-annotations.js";

const sha = text => createHash("sha256").update(text).digest("hex");
const temp = (t, prefix) => { const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const addon = protocol => `bl_info = {\n    "name": "MCP for Blender",\n    "version": (1, 2, 0),\n}\nADDON_PROTOCOL_VERSION = ${protocol}\n`;

/** A stand-in uvx: `python -c` prints the inspect report; `install-addon --addons-dir` stages blender_mcp.py. */
function blenderSystem(root, { files, staged = addon(15), protocol = 15, listening = false } = {}) {
  const runs = [];
  return {
    runs,
    system: { ...defaultSetupSystem, platform: "darwin", home: root, tmp: root, cwd: root, uid: 501,
      listening: async () => listening,
      run: async (file, args, options) => {
        runs.push([file, ...args]);
        assert.equal(options?.cwd, root, "uvx runs where the server does");
        if (args.includes("python")) return { stdout: JSON.stringify({ version: "2.2.7", protocol, files }) + "\n" };
        if (args.includes("install-addon")) { fs.writeFileSync(path.join(args[args.indexOf("--addons-dir") + 1], "blender_mcp.py"), staged); return { stdout: "" }; }
        throw new Error(`unexpected ${file} ${args.join(" ")}`);
      } },
  };
}
const uvxEnv = { BLENDER_MCP_COMMAND: "/opt/homebrew/bin/uvx", BLENDER_MCP_ARGS: '["blender-mcp"]' };

function blenderFolders(root) {
  const v50 = path.join(root, "Library", "Application Support", "Blender", "5.0", "scripts", "addons");
  const v44 = path.join(root, "Library", "Application Support", "Blender", "4.4", "scripts", "addons");
  fs.mkdirSync(v50, { recursive: true });
  fs.mkdirSync(v44, { recursive: true });
  return { v50: path.join(v50, "addon.py"), v44: path.join(v44, "addon.py") };
}

test("blender_mcp_setup reports the add-on Blender loads, the expected protocol and the running add-on, changing nothing", async t => {
  const root = temp(t, "blender-setup-");
  const { v50, v44 } = blenderFolders(root);
  fs.writeFileSync(v50, addon(14));
  fs.writeFileSync(v44, addon(15));
  const files = [{ path: v50, protocol: 14 }, { path: v44, protocol: 15 }];
  // Not listening: the handshake is never asked for, and the first install is the one reported.
  let asked = 0;
  const quiet = blenderSystem(root, { files });
  const report = await new BlenderAddonSetup(async () => { asked++; return undefined; }, quiet.system, uvxEnv).check();
  assert.equal(asked, 0);
  assert.deepEqual(report, { supported: true, package: "blender-mcp", package_version: "2.2.7", expected_protocol: 15, listening: false,
    target: { path: v50, protocol: 14 }, current: false });
  assert.deepEqual(quiet.runs[0].slice(0, 4), ["/opt/homebrew/bin/uvx", "--from", "blender-mcp", "python"]);
  // Listening: the running Blender's version picks its own folder.
  const live = blenderSystem(root, { files, listening: true });
  const running = await new BlenderAddonSetup(async () => ({ up_to_date: true, protocol_version: 15, blender_version: "4.4.3" }), live.system, uvxEnv).check();
  assert.deepEqual(running.target, { path: v44, protocol: 15 });
  assert.equal(running.current, true);
  assert.deepEqual(running.live, { up_to_date: true, protocol_version: 15, blender_version: "4.4.3" });
  // A bridge without a handshake reports live null; one whose handshake fails says why, and the rest is still reported.
  assert.equal((await new BlenderAddonSetup(async () => undefined, live.system, uvxEnv).check()).live, null);
  const failing = await new BlenderAddonSetup(async () => { throw new Error("Blender's add-on could not be checked: busy"); }, live.system, uvxEnv).check();
  assert.equal(failing.live, null);
  assert.equal(failing.live_error, "Blender's add-on could not be checked: busy");
  assert.deepEqual(failing.target, { path: v50, protocol: 14 });
  assert.equal(fs.readFileSync(v50, "utf8"), addon(14), "check changes nothing");
});

test("blender_mcp_setup says plainly when the bridge isn't the upstream package run with uvx", async t => {
  const root = temp(t, "blender-setup-");
  const { system, runs } = blenderSystem(root, { files: [] });
  const check = env => new BlenderAddonSetup(async () => undefined, system, env).check();
  const none = await check({});
  assert.deepEqual({ ...none, message: undefined }, { supported: false, reason: "not-configured", listening: false, message: undefined });
  assert.match(none.message, /no Blender bridge configured/, "the person is told what to do, in words a client shows as they are");
  assert.equal((await check({ BLENDER_MCP_COMMAND: "/usr/local/bin/my-bridge", BLENDER_MCP_ARGS: "[]" })).reason, "custom-command");
  assert.equal((await check({ BLENDER_MCP_COMMAND: "uvx", BLENDER_MCP_ARGS: '["--from","git+https://example.com/fork","blender-mcp"]' })).reason, "custom-package");
  assert.equal((await check({ BLENDER_MCP_COMMAND: "uvx", BLENDER_MCP_ARGS: "not json" })).reason, "not-configured");
  assert.equal((await check({ BLENDER_MCP_COMMAND: "uvx", BLENDER_MCP_ARGS: '["--from","mcp-for-blender==2.2.7","mcp-for-blender"]' })).supported, true);
  // Windows' uv installs uvx.exe.
  assert.equal((await check({ BLENDER_MCP_COMMAND: "C:\\Users\\a\\.local\\bin\\uvx.exe", BLENDER_MCP_ARGS: '["blender-mcp"]' })).supported, true);
  assert.equal((await check({ BLENDER_MCP_COMMAND: "/usr/local/bin/my-bridge", BLENDER_MCP_ARGS: "[]" })).message, "This Blender bridge uses its own command, so its add-on is updated with that bridge's installer.");
  assert.equal(runs.filter(run => run.includes("install-addon")).length, 0);
  await assert.rejects(new BlenderAddonSetup(async () => undefined, system, { BLENDER_MCP_COMMAND: "/usr/local/bin/my-bridge" }).update(), /that bridge's installer/);
});

test("setup subprocesses get the login environment, uv's and Blender's settings, never the server's secrets", async () => {
  const env = { PATH: process.env.PATH, HOME: "/home/a", BAMBU_TOKEN: "printer-secret", BAMBU_SERIAL: "01P00A", NPM_TOKEN: "npm-secret",
    GITHUB_PAT: "ghp-secret", BLENDER_PORT: "9876", BLENDERMCP_ADDONS_DIR: "/addons", UV_CACHE_DIR: "/uv-cache", TMPDIR: "/tmp/x" };
  const { stdout } = await defaultSetupSystem.run(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.env))"], { env });
  const seen = JSON.parse(stdout);
  for (const secret of ["BAMBU_TOKEN", "BAMBU_SERIAL", "NPM_TOKEN", "GITHUB_PAT"]) assert.equal(seen[secret], undefined, secret);
  for (const [name, value] of [["HOME", "/home/a"], ["BLENDER_PORT", "9876"], ["BLENDERMCP_ADDONS_DIR", "/addons"], ["UV_CACHE_DIR", "/uv-cache"], ["TMPDIR", "/tmp/x"]]) assert.equal(seen[name], value, name);
});

test("blender_mcp_setup picks one module per Blender folder and refuses a folder with several", () => {
  const folder = "/Users/a/Library/Application Support/Blender/5.0/scripts/addons";
  assert.deepEqual(selectBlenderAddonTarget([{ path: `${folder}/addon.py`, protocol: 15 }], "5.0.1"), { target: { path: `${folder}/addon.py`, protocol: 15 } });
  assert.deepEqual(selectBlenderAddonTarget([{ path: `${folder}/addon.py` }, { path: `${folder}/blender_mcp.py` }]), { problem: "several-modules" });
  assert.deepEqual(selectBlenderAddonTarget([{ path: `${folder}/addon.py` }], "4.2.0"), { problem: "not-installed" });
  assert.deepEqual(selectBlenderAddonTarget([]), { problem: "not-installed" });
  // Linux keeps Blender's folders under ~/.config/blender, Windows under Blender Foundation\\Blender.
  const linux = "/home/a/.config/blender/5.0/scripts/addons/blender_mcp.py";
  assert.deepEqual(selectBlenderAddonTarget([{ path: linux, protocol: 15 }], "5.0.1"), { target: { path: linux, protocol: 15 } });
  const windows = "C:\\Users\\a\\AppData\\Roaming\\Blender Foundation\\Blender\\4.4\\scripts\\addons\\addon.py";
  assert.deepEqual(selectBlenderAddonTarget([{ path: linux, protocol: 15 }, { path: windows, protocol: 14 }], "4.4.3"), { target: { path: windows, protocol: 14 } });
  assert.deepEqual(selectBlenderAddonTarget([{ path: "/home/a/Documents/5.0/addon.py" }], "5.0.1"), { problem: "not-installed" }, "a 5.0 folder that isn't Blender's");
});

test("blender_mcp_setup update replaces the add-on with the package's own, at the inspected version, keeping a backup", async t => {
  const root = temp(t, "blender-setup-");
  const { v50 } = blenderFolders(root);
  fs.writeFileSync(v50, addon(14), { mode: 0o640 });
  const { system, runs } = blenderSystem(root, { files: [{ path: v50, protocol: 14 }] });
  const report = await new BlenderAddonSetup(async () => undefined, system, uvxEnv).update();
  assert.equal(report.replaced, true);
  assert.equal(fs.readFileSync(v50, "utf8"), addon(15));
  assert.equal(fs.statSync(v50).mode & 0o777, 0o640, "the file keeps its permissions");
  assert.equal(fs.readFileSync(report.backup, "utf8"), addon(14));
  assert.equal(path.dirname(report.backup), path.dirname(v50));
  const install = runs.find(run => run.includes("install-addon"));
  assert.deepEqual(install.slice(0, 5), ["/opt/homebrew/bin/uvx", "--from", "mcp-for-blender==2.2.7", "mcp-for-blender", "install-addon"]);
  assert.ok(!fs.existsSync(install[install.indexOf("--addons-dir") + 1]), "the staging folder is removed");
  assert.deepEqual(fs.readdirSync(path.dirname(v50)).filter(name => name.endsWith(".tmp")), []);
  // Already the package's add-on: nothing is replaced or backed up.
  const again = blenderSystem(root, { files: [{ path: v50, protocol: 15 }] });
  const second = await new BlenderAddonSetup(async () => undefined, again.system, uvxEnv).update();
  assert.equal(second.replaced, false);
  assert.equal(fs.readdirSync(path.dirname(v50)).filter(name => name.endsWith(".bak")).length, 1);
});

test("overlapping blender_mcp_setup updates run one after the other: one replacement, one backup", async t => {
  const root = temp(t, "blender-setup-");
  const { v50 } = blenderFolders(root);
  fs.writeFileSync(v50, addon(14));
  // The inspect report follows the file, as the real package's does.
  const { system } = blenderSystem(root, { files: [] });
  const run = system.run;
  system.run = async (file, args, options) => args.includes("python")
    ? { stdout: JSON.stringify({ version: "2.2.7", protocol: 15, files: [{ path: v50, protocol: Number(/ADDON_PROTOCOL_VERSION = (\d+)/.exec(fs.readFileSync(v50, "utf8"))[1]) }] }) }
    : run(file, args, options);
  const setup = new BlenderAddonSetup(async () => undefined, system, uvxEnv);
  const results = await Promise.all([setup.update(), setup.update(), setup.update()]);
  assert.deepEqual(results.map(result => result.replaced), [true, false, false]);
  assert.equal(fs.readdirSync(path.dirname(v50)).filter(name => name.endsWith(".bak")).length, 1);
  assert.equal(fs.readFileSync(v50, "utf8"), addon(15));
});

test("blender_mcp_setup update replaces nothing it can't vouch for", async t => {
  const root = temp(t, "blender-setup-");
  const { v50 } = blenderFolders(root);
  const update = (options, env = uvxEnv) => new BlenderAddonSetup(async () => undefined, blenderSystem(root, { files: [{ path: v50, protocol: 14 }], ...options }).system, env).update();
  const untouched = () => { assert.equal(fs.readFileSync(v50, "utf8"), addon(14)); assert.deepEqual(fs.readdirSync(path.dirname(v50)).filter(name => name !== "addon.py"), []); };
  fs.writeFileSync(v50, addon(14));
  await assert.rejects(update({ staged: addon(14) }), /doesn't match the configured Blender MCP package/, "the staged add-on carries another protocol");
  untouched();
  await assert.rejects(update({ staged: "print('not an add-on')\n" }), /doesn't match/);
  untouched();
  // A file that isn't an MCP for Blender add-on is never overwritten.
  fs.writeFileSync(v50, "bl_info = {'name': 'Someone else'}\n");
  await assert.rejects(update({}), /not a recognized MCP for Blender add-on/);
  assert.equal(fs.readFileSync(v50, "utf8"), "bl_info = {'name': 'Someone else'}\n");
  // A symlinked add-on belongs to whoever linked it.
  const elsewhere = path.join(root, "elsewhere.py");
  fs.writeFileSync(elsewhere, addon(14));
  fs.rmSync(v50);
  fs.symlinkSync(elsewhere, v50);
  await assert.rejects(update({}), /not a regular local file/);
  assert.equal(fs.readFileSync(elsewhere, "utf8"), addon(14));
  // No add-on for this Blender: the report and the refusal say what to do.
  fs.rmSync(v50);
  assert.match((await new BlenderAddonSetup(async () => undefined, blenderSystem(root, { files: [] }).system, uvxEnv).check()).message, /isn't installed for this Blender/);
  await assert.rejects(new BlenderAddonSetup(async () => undefined, blenderSystem(root, { files: [] }).system, uvxEnv).update(), /isn't installed/);
});

/** A synthetic pin: an add-in archive laid out like codeload's tarball, with its files' hashes. */
function fusionPin(root, { tamper, symlink } = {}) {
  const repository = "example/fusion360-mcp-server", commit = "0123456789abcdef0123456789abcdef01234567";
  const files = {
    "Fusion360MCP.manifest": '{\n  "type": "addin",\n  "runOnStartup": false,\n  "supportedOS": "windows|mac"\n}\n',
    "Fusion360MCP.py": "import adsk.core\n",
    "server/socket_server.py": "PORT = 9876\n",
  };
  const pin = { repository, commit, files: Object.fromEntries(Object.entries(files).map(([name, text]) => [name, sha(text)])) };
  const source = path.join(root, "archive-source"), top = path.join(source, `fusion360-mcp-server-${commit}`);
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(top, "addon", name)), { recursive: true });
    fs.writeFileSync(path.join(top, "addon", name), tamper === name ? text + "# changed\n" : text);
  }
  fs.writeFileSync(path.join(top, "README.md"), "not part of the add-in\n");
  if (symlink) fs.symlinkSync("/etc/hosts", path.join(top, "addon", "server", "hosts"));
  const archive = path.join(root, "archive.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", source, `fusion360-mcp-server-${commit}`]);
  return { pin, files, archive: fs.readFileSync(archive) };
}

function fusionSystem(root, archive, { platform = "darwin", fusionApp, failBootstrap = 0 } = {}) {
  const launchctl = [], downloads = [];
  // launchd's own state: print answers only for an agent a bootstrap loaded.
  let loaded = false, failures = failBootstrap;
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  return {
    home, launchctl, downloads,
    system: { ...defaultSetupSystem, platform, home, tmp: root, cwd: path.join(root, "server"), uid: 501,
      download: async url => { downloads.push(url); return archive; },
      fusionByBundleId: async () => fusionApp ? [fusionApp] : [],
      run: async (file, args, options) => {
        if (file === "/bin/launchctl") {
          if (args[0] === "print" && !loaded) throw new Error("Could not find service");
          launchctl.push(args);
          if (args[0] === "bootstrap") { if (failures-- > 0) throw new Error("Bootstrap failed: 5: Input/output error"); loaded = true; }
          return { stdout: "" };
        }
        return defaultSetupSystem.run(file, args, options);
      } },
  };
}

test("fusion_mcp_setup installs the pinned add-in to run on startup, the port login item and only the missing settings", async t => {
  const root = temp(t, "fusion-setup-");
  const { pin, archive } = fusionPin(root);
  const fusionApp = path.join(root, "Autodesk Fusion.app");
  fs.mkdirSync(fusionApp);
  const { system, home, launchctl, downloads } = fusionSystem(root, archive, { fusionApp });
  fs.mkdirSync(system.cwd);
  const envPath = path.join(system.cwd, ".env");
  fs.writeFileSync(envPath, "PRINTER_HOST=192.0.2.1\nBLENDER_MCP_COMMAND=/opt/homebrew/bin/uvx\nBLENDER_MCP_ARGS=[\"blender-mcp\"]\n");
  const env = { BLENDER_MCP_COMMAND: "/opt/homebrew/bin/uvx" };
  const setup = new FusionAddinSetup(() => 9877, ["--from", "git+https://github.com/example/fusion360-mcp-server@0123456789ab", "fusion360-mcp-server", "--mode", "socket"], system, env, pin);

  const before = await setup.check();
  assert.equal(before.ready, false);
  assert.deepEqual(before.fusion, { installed: true, path: fusionApp });
  assert.equal(before.env_file, envPath);
  assert.equal(launchctl.length + downloads.length, 0, "check changes nothing and downloads nothing");

  const report = await setup.install();
  assert.deepEqual(report.installed, { addin: "installed", port_agent: "installed", env: "written", env_backup: report.installed.env_backup });
  assert.equal(report.ready, true);
  assert.deepEqual(downloads, [`https://codeload.github.com/${pin.repository}/tar.gz/${pin.commit}`]);
  const addins = path.join(home, "Library", "Application Support", "Autodesk", "Autodesk Fusion 360", "API", "AddIns");
  assert.deepEqual(fs.readdirSync(addins), ["Fusion360MCP"], "no staging or previous copies are left");
  assert.match(fs.readFileSync(path.join(addins, "Fusion360MCP", "Fusion360MCP.manifest"), "utf8"), /"runOnStartup": true/);
  assert.ok(!fs.existsSync(path.join(addins, "Fusion360MCP", "README.md")), "only the add-in folder is installed");
  // The login item sets the port in the person's session.
  const agent = path.join(home, "Library", "LaunchAgents", `${FUSION_PORT_AGENT_LABEL}.plist`);
  assert.match(fs.readFileSync(agent, "utf8"), /<string>setenv<\/string>\s*<string>FUSION_MCP_PORT<\/string>\s*<string>9877<\/string>/);
  const loads = () => launchctl.filter(args => args[0] !== "print");
  assert.deepEqual(loads(), [["bootout", `gui/501/${FUSION_PORT_AGENT_LABEL}`], ["bootstrap", "gui/501", agent]]);
  assert.ok(launchctl.some(args => args[0] === "print"), "launchd is asked whether it has the agent");
  // The settings it was missing, next to the old file, and live for this server at once.
  const written = fs.readFileSync(envPath, "utf8");
  assert.match(written, /^PRINTER_HOST=192\.0\.2\.1$/m);
  assert.match(written, /^FUSION_MCP_COMMAND=\/opt\/homebrew\/bin\/uvx$/m, "the uvx the Blender bridge already uses");
  assert.match(written, /^FUSION_MCP_ARGS='\["--from","git\+https:\/\/github.com\/example\/fusion360-mcp-server@0123456789ab","fusion360-mcp-server","--mode","socket"\]'$/m);
  assert.match(written, /^FUSION_MCP_PORT=9877$/m);
  assert.equal(fs.readFileSync(report.installed.env_backup, "utf8"), "PRINTER_HOST=192.0.2.1\nBLENDER_MCP_COMMAND=/opt/homebrew/bin/uvx\nBLENDER_MCP_ARGS=[\"blender-mcp\"]\n");
  assert.equal(env.FUSION_MCP_COMMAND, "/opt/homebrew/bin/uvx");
  assert.equal(env.FUSION_MCP_TIMEOUT_MS, "180000");

  // Fusion's own Python cache in the add-in doesn't make it look changed; a second install does nothing.
  fs.mkdirSync(path.join(addins, "Fusion360MCP", "server", "__pycache__"));
  fs.writeFileSync(path.join(addins, "Fusion360MCP", "server", "__pycache__", "socket_server.cpython-312.pyc"), "cache");
  const again = await setup.install();
  assert.deepEqual(again.installed, { addin: "already-current", port_agent: "already-current", env: "already-configured" });
  assert.equal(downloads.length, 1);
  assert.equal(loads().length, 2, "a loaded agent isn't loaded again");
  assert.ok(fs.existsSync(path.join(addins, "Fusion360MCP", "server", "__pycache__")), "a current add-in is left in place");
  assert.equal(fs.readdirSync(system.cwd).filter(name => name.startsWith(".env.bak-")).length, 1);
});

test("fusion_mcp_setup keeps a configured Fusion command and replaces an add-in that isn't at the pin", async t => {
  const root = temp(t, "fusion-setup-");
  const { pin, archive } = fusionPin(root);
  const { system, home } = fusionSystem(root, archive);
  fs.mkdirSync(system.cwd);
  const runtime = "'/Users/a/Library/Application Support/Scan to Make/fusion/runtime-86a3016/bin/fusion360-mcp-server'";
  fs.writeFileSync(path.join(system.cwd, ".env"), `FUSION_MCP_COMMAND=${runtime}\nFUSION_MCP_ARGS='["--mode","socket"]'\n`);
  const env = { FUSION_MCP_COMMAND: runtime, FUSION_MCP_ARGS: '["--mode","socket"]', FUSION_MCP_TIMEOUT_MS: "180000", FUSION_MCP_HOST: "localhost" };
  const addin = path.join(home, "Library", "Application Support", "Autodesk", "Autodesk Fusion 360", "API", "AddIns", "Fusion360MCP");
  fs.mkdirSync(addin, { recursive: true });
  fs.writeFileSync(path.join(addin, "Fusion360MCP.py"), "an older add-in\n");
  const setup = new FusionAddinSetup(() => 9877, ["--from", "x"], system, env, pin);
  assert.deepEqual((await setup.check()).addin, { path: addin, installed: true, matches_pin: false, run_on_startup: false });
  const report = await setup.install();
  assert.equal(report.installed.env, "written");
  const text = fs.readFileSync(path.join(system.cwd, ".env"), "utf8");
  assert.ok(text.startsWith(`FUSION_MCP_COMMAND=${runtime}\nFUSION_MCP_ARGS='["--mode","socket"]'\n`), "the reviewed runtime and its arguments are kept");
  assert.match(text, /^FUSION_MCP_PORT=9877$/m, "only the missing port is added");
  assert.equal(fs.readFileSync(path.join(addin, "Fusion360MCP.py"), "utf8"), "import adsk.core\n");
  assert.equal(report.addin.matches_pin, true);
});

test("fusion_mcp_setup never rewrites a Fusion setting the .env already names, even when the process doesn't have it", async t => {
  const root = temp(t, "fusion-setup-");
  const { pin, archive } = fusionPin(root);
  const { system } = fusionSystem(root, archive);
  fs.mkdirSync(system.cwd);
  const original = "FUSION_MCP_COMMAND=/reviewed/runtime/bin/fusion360-mcp-server\nFUSION_MCP_ARGS='[\"--mode\",\"socket\"]'\n";
  fs.writeFileSync(path.join(system.cwd, ".env"), original);
  const report = await new FusionAddinSetup(() => 9877, ["--from", "x"], system, {}, pin).install();
  const text = fs.readFileSync(path.join(system.cwd, ".env"), "utf8");
  assert.ok(text.startsWith(original), "the file's own command and arguments stay");
  assert.equal(text.match(/^FUSION_MCP_COMMAND=/gm).length, 1);
  assert.equal(text.match(/^FUSION_MCP_ARGS=/gm).length, 1);
  assert.match(text, /^FUSION_MCP_PORT=9877$/m);
  assert.equal(report.installed.env, "written");
});

test("fusion_mcp_setup loads a login item again when an earlier load failed, though its file is in place", async t => {
  const root = temp(t, "fusion-setup-");
  const { pin, archive } = fusionPin(root);
  const { system, home, launchctl } = fusionSystem(root, archive, { failBootstrap: 1 });
  fs.mkdirSync(system.cwd);
  fs.writeFileSync(path.join(system.cwd, ".env"), "PRINTER_HOST=192.0.2.1\n");
  const setup = new FusionAddinSetup(() => 9877, ["--from", "x"], system, {}, pin);
  await assert.rejects(setup.install(), /couldn't be loaded/);
  assert.ok(fs.existsSync(path.join(home, "Library", "LaunchAgents", `${FUSION_PORT_AGENT_LABEL}.plist`)), "the file was written before the load failed");
  assert.equal((await setup.check()).port_agent.installed, false, "a file launchd doesn't have isn't installed");
  const report = await setup.install();
  assert.equal(report.installed.port_agent, "installed");
  assert.equal(report.port_agent.installed, true);
  assert.equal(launchctl.filter(args => args[0] === "bootstrap").length, 2);
});

test("fusion_mcp_setup fills in empty Fusion settings and keeps arguments the person chose", async t => {
  const root = temp(t, "fusion-setup-");
  const { pin, archive } = fusionPin(root);
  const { system } = fusionSystem(root, archive);
  fs.mkdirSync(system.cwd);
  // .env.example's empty command, with arguments naming another server revision.
  fs.writeFileSync(path.join(system.cwd, ".env"), "FUSION_MCP_COMMAND=\nFUSION_MCP_ARGS='[\"--from\",\"git+https://example.com/my-fork@abc\",\"fusion360-mcp-server\"]'\nFUSION_MCP_HOST=\"\"\n");
  const env = { FUSION_MCP_ARGS: '["--from","git+https://example.com/my-fork@abc","fusion360-mcp-server"]' };
  const report = await new FusionAddinSetup(() => 9877, ["--from", "pinned"], system, env, pin).install();
  const text = fs.readFileSync(path.join(system.cwd, ".env"), "utf8");
  assert.equal(report.installed.env, "written");
  assert.match(text, /^FUSION_MCP_COMMAND=uvx$/m, "an empty command is filled in");
  assert.equal(text.match(/^FUSION_MCP_COMMAND=/gm).length, 1);
  assert.match(text, /^FUSION_MCP_ARGS='\["--from","git\+https:\/\/example.com\/my-fork@abc","fusion360-mcp-server"\]'$/m, "the chosen arguments stay");
  assert.equal(text.match(/^FUSION_MCP_ARGS=/gm).length, 1);
  assert.match(text, /^FUSION_MCP_HOST=localhost$/m, "an empty quoted value is filled in too");
  assert.equal(env.FUSION_MCP_ARGS, '["--from","git+https://example.com/my-fork@abc","fusion360-mcp-server"]');
  assert.equal(report.configured, true);
});

test("a cancelled setup request changes nothing it hadn't already finished", async t => {
  // Blender: cancelled while the package's installer runs, the add-on is neither backed up nor replaced.
  const root = temp(t, "blender-setup-");
  const { v50 } = blenderFolders(root);
  fs.writeFileSync(v50, addon(14));
  const blender = blenderSystem(root, { files: [{ path: v50, protocol: 14 }] });
  const controller = new AbortController();
  const run = blender.system.run;
  blender.system.run = async (file, args, options) => {
    if (args.includes("install-addon")) { assert.equal(options.signal, controller.signal, "the installer is given the request's signal"); controller.abort(); }
    return run(file, args, options);
  };
  await assert.rejects(new BlenderAddonSetup(async () => undefined, blender.system, uvxEnv).update(controller.signal), { name: "AbortError" });
  assert.equal(fs.readFileSync(v50, "utf8"), addon(14));
  assert.deepEqual(fs.readdirSync(path.dirname(v50)), ["addon.py"]);
  // A request cancelled while it waited its turn never starts.
  const setup = new BlenderAddonSetup(async () => undefined, blenderSystem(root, { files: [{ path: v50, protocol: 14 }] }).system, uvxEnv);
  const waiting = new AbortController();
  const first = setup.update(), second = setup.update(waiting.signal);
  waiting.abort();
  assert.equal((await first).replaced, true);
  await assert.rejects(second, { name: "AbortError" });
  assert.equal(fs.readdirSync(path.dirname(v50)).filter(name => name.endsWith(".bak")).length, 1);

  // Fusion: cancelled during the download, nothing is installed, loaded or written.
  const froot = temp(t, "fusion-setup-");
  const { pin, archive } = fusionPin(froot);
  const fusion = fusionSystem(froot, archive);
  fs.mkdirSync(fusion.system.cwd);
  fs.writeFileSync(path.join(fusion.system.cwd, ".env"), "PRINTER_HOST=192.0.2.1\n");
  const cancel = new AbortController();
  fusion.system.download = async (url, signal) => { assert.equal(signal, cancel.signal); cancel.abort(); return archive; };
  await assert.rejects(new FusionAddinSetup(() => 9877, ["--from", "x"], fusion.system, {}, pin).install(cancel.signal), { name: "AbortError" });
  assert.ok(!fs.existsSync(path.join(fusion.home, "Library", "Application Support", "Autodesk", "Autodesk Fusion 360", "API", "AddIns", "Fusion360MCP")));
  assert.equal(fusion.launchctl.filter(args => args[0] !== "print").length, 0);
  assert.equal(fs.readFileSync(path.join(fusion.system.cwd, ".env"), "utf8"), "PRINTER_HOST=192.0.2.1\n");
});

test("fusion_mcp_setup installs nothing from an archive that doesn't match the pin", async t => {
  for (const [label, options, message] of [["a changed file", { tamper: "Fusion360MCP.py" }, /didn't match the pinned version/],
    ["a symlink", { symlink: true }, /isn't a regular file/]]) {
    const root = temp(t, "fusion-setup-");
    const { pin, archive } = fusionPin(root, options);
    const { system, home, launchctl } = fusionSystem(root, archive);
    fs.mkdirSync(system.cwd);
    fs.writeFileSync(path.join(system.cwd, ".env"), "PRINTER_HOST=192.0.2.1\n");
    await assert.rejects(new FusionAddinSetup(() => 9877, [], system, {}, pin).install(), message, label);
    assert.ok(!fs.existsSync(path.join(home, "Library", "Application Support", "Autodesk", "Autodesk Fusion 360", "API", "AddIns", "Fusion360MCP")), label);
    assert.equal(launchctl.length, 0, label);
    assert.equal(fs.readFileSync(path.join(system.cwd, ".env"), "utf8"), "PRINTER_HOST=192.0.2.1\n", label);
  }
});

test("fusion_mcp_setup installs on macOS only and reports a server without a .env", async t => {
  const root = temp(t, "fusion-setup-");
  const { pin, archive } = fusionPin(root);
  const linux = fusionSystem(root, archive, { platform: "linux" });
  const report = await new FusionAddinSetup(() => 9877, [], linux.system, {}, pin).check();
  assert.equal(report.supported, false);
  assert.equal(report.ready, false);
  assert.equal(report.env_file, null);
  await assert.rejects(new FusionAddinSetup(() => 9877, [], linux.system, {}, pin).install(), /macOS only/);
  const mac = fusionSystem(root, archive);
  const installed = await new FusionAddinSetup(() => 9877, [], mac.system, {}, pin).install();
  assert.equal(installed.installed.env, "no-env-file");
  assert.equal(installed.ready, false, "the bridge still needs its settings");
  assert.match(installed.message, /no \.env file to add its Fusion settings to/, "what is missing, in words a client shows as they are");
  assert.match(report.message, /macOS only/);
});

test("the Fusion bridge's default server and the add-in setup installs come from one pinned commit", () => {
  assert.equal(FUSION_ADDIN_PIN.commit.slice(0, 12), FUSION_MCP_PIN);
  assert.deepEqual(FUSION_MCP_DEFAULT_ARGS, ["--from", `git+https://github.com/${FUSION_ADDIN_PIN.repository}@${FUSION_MCP_PIN}`, "fusion360-mcp-server", "--mode", "socket"]);
  assert.equal(Object.keys(FUSION_ADDIN_PIN.files).length, 10);
  for (const name of ["blender_mcp_setup", "fusion_mcp_setup"]) {
    assert.equal(TOOL_ANNOTATIONS[name].readOnlyHint, false, `${name} writes files`);
    assert.equal(TOOL_ANNOTATIONS[name].destructiveHint, true, `${name} replaces an add-on`);
  }
});
