// The real Bambu Studio on macOS, in a throwaway home seeded with crash history that makes AppKit raise its modal
// "reopen windows?" alert (src/slicer/slicer-launch.ts). Skipped where Bambu Studio isn't installed.
//
// AppKit raises the alert when <home>/Library/Application Support/CrashReporter/BambuStudio_<hardware UUID>.plist
// dates a crash inside Bambu Studio's last window restoration, which every launch records in its saved state
// (restorecount.plist: start/end). The test primes that record with a slice of its own, seeds a throwaway home with a
// crash dated at its start, and shows the server still slices with that home in its environment.
//
// BAMBU_MCP_REPRODUCE_DIALOG=1 also launches the slicer the old way, directly in the seeded home, and shows it hang
// in the alert. That alert appears on screen for the few seconds it waits, so it is opt-in; the stalled process is
// killed (it ran in the throwaway home, so the person's own crash history is untouched).
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const STUDIO = "/Applications/BambuStudio.app/Contents/MacOS/BambuStudio";
const available = process.platform === "darwin" && fs.existsSync(STUDIO);

async function slice(home, tempDir) {
  fs.mkdirSync(tempDir, { recursive: true });
  let stderr = "";
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(ROOT, "dist/index.js")], cwd: tempDir, stderr: "pipe",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, MCP_TRANSPORT: "stdio", PRINTER_TYPE: "octoprint", PRINTER_HOST: "127.0.0.1",
      SLICER_TYPE: "bambustudio", SLICER_PATH: STUDIO, SLICER_PROFILE: "", FILAMENT_PROFILE: "", SLICER_FILAMENT_PROFILE: "", BAMBU_MODEL: "",
      BAMBU_PROFILES_ROOT: "", BAMBU_SLICER_PROFILE_DIRS: "", BAMBU_TEMPLATE_3MF_PATH: "", TEMP_DIR: tempDir, SLICE_CACHE: "off",
      ...(home ? { CFFIXED_USER_HOME: home } : {}) },
  });
  transport.stderr?.on("data", chunk => { stderr += chunk; });
  const client = new Client({ name: "macos-dialog-hang-test", version: "1.0.0" });
  await client.connect(transport);
  try {
    const started = Date.now();
    const result = await client.callTool({ name: "slice_stl", arguments: { stl_path: path.join(ROOT, "test/sample_cube.stl"), bambu_model: "p1s", nozzle_diameter: "0.4" } },
      undefined, { timeout: 120_000 });
    return { result, stderr, seconds: (Date.now() - started) / 1000 };
  } finally { await client.close(); }
}

/** Bambu Studio's restorecount.plist written since `since` (ms), and its start (seconds since 2001). */
function restoreStart(since) {
  const containers = path.join(os.homedir(), "Library/Daemon Containers");
  const found = [];
  for (const container of fs.existsSync(containers) ? fs.readdirSync(containers) : []) {
    const states = path.join(containers, container, "Data/Library/Saved Application State");
    for (const state of fs.existsSync(states) ? fs.readdirSync(states) : []) {
      const file = path.join(states, state, "restorecount.plist");
      if (fs.existsSync(file) && fs.statSync(file).mtimeMs >= since) found.push(file);
    }
  }
  if (found.length !== 1) return undefined;
  return Number(execFileSync("/usr/bin/plutil", ["-extract", "start", "raw", found[0]], { encoding: "utf8" }).trim());
}

function seedCrashHistory(home, start) {
  const uuid = /"IOPlatformUUID" = "([^"]+)"/.exec(execFileSync("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8" }))[1];
  const dir = path.join(home, "Library/Application Support/CrashReporter");
  fs.mkdirSync(dir, { recursive: true });
  const date = new Date((start + 978307200) * 1000).toISOString().replace(/\.\d+Z$/, "Z");
  fs.writeFileSync(path.join(dir, `BambuStudio_${uuid}.plist`),
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Date</key><date>${date}</date></dict></plist>\n`);
}

/** Runs the server's own logged command in `home`; resolves "hung" (and kills it) or its exit code. */
function oldLaunch(command, home, seconds) {
  return new Promise(resolve => {
    const [file, ...args] = command.split(" ");
    const child = spawn(file, args, { env: { ...process.env, CFFIXED_USER_HOME: home }, stdio: "ignore" });
    const timer = setTimeout(() => {
      const cpu = execFileSync("/bin/ps", ["-o", "pcpu=", "-p", String(child.pid)], { encoding: "utf8" }).trim();
      child.kill("SIGKILL");
      resolve({ hung: true, cpu: Number(cpu) });
    }, seconds * 1000);
    child.on("exit", code => { clearTimeout(timer); resolve({ hung: false, code }); });
  });
}

test("Bambu Studio slices through the server in a home whose crash history raises AppKit's alert", { skip: !available && "Bambu Studio is not installed (macOS only)" }, async (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "bambu-mcp-dialog-"));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const primedAt = Date.now() - 1000;
  const primed = await slice(undefined, path.join(work, "prime"));
  assert.equal(primed.result.isError, undefined, primed.result.content?.[0]?.text);
  const start = restoreStart(primedAt);
  if (start === undefined) return t.skip("could not identify Bambu Studio's restorecount.plist");
  const home = path.join(work, "home");
  seedCrashHistory(home, start);

  if (process.env.BAMBU_MCP_REPRODUCE_DIALOG === "1") {
    const command = /Executing: (.*)/.exec(primed.stderr)?.[1];
    assert.ok(command, "the server logged its slicer command");
    const old = await oldLaunch(command, home, 10);
    assert.ok(old.hung && old.cpu < 1, `the old launch waits on the alert: ${JSON.stringify(old)}`);
  }

  const fixed = await slice(home, path.join(work, "fixed"));
  assert.equal(fixed.result.isError, undefined, fixed.result.content?.[0]?.text);
  assert.ok(fs.existsSync(fixed.result.content[0].text), "the sliced file exists");
  assert.ok(fixed.seconds < 60, `sliced in ${fixed.seconds} s`);
});
