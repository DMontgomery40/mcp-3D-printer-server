/**
 * Setting up the two design apps this server bridges: the MCP for Blender add-on (blender_mcp_setup) and Autodesk
 * Fusion's Fusion360MCP add-in (fusion_mcp_setup). Clients such as Counterpart call these tools instead of keeping
 * their own copy of each app's install layout, which changes whenever Blender, Fusion or their MCP servers do.
 *
 * Neither tool launches, closes or edits a running app. Blender's add-on is installed by its own upstream installer
 * (`mcp-for-blender install-addon`); the Fusion add-in comes from one pinned commit whose every file is checked
 * against its SHA-256 before anything is copied.
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { copyFileSync, constants as fsConstants, readFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeEnvValues } from "./counterpart/route.js";

const execFileAsync = promisify(execFile);

/** What these tools reach outside the server: tests replace every field. */
export type SetupSystem = {
  platform: NodeJS.Platform;
  home: string;
  /** Where staged downloads and installer output go before they are checked. */
  tmp: string;
  uid: number;
  /** The working directory dotenv read `.env` from when the server started. */
  cwd: string;
  run(file: string, args: string[], options?: { env?: NodeJS.ProcessEnv; timeoutMs?: number; cwd?: string; signal?: AbortSignal }): Promise<{ stdout: string }>;
  download(url: string, signal?: AbortSignal): Promise<Buffer>;
  /** Whether something accepts a TCP connection on host:port within a second. */
  listening(host: string, port: number): Promise<boolean>;
  /** Installed Autodesk Fusion apps found by bundle identifier (Spotlight). */
  fusionByBundleId(): Promise<string[]>;
};

/**
 * What a setup subprocess (uvx and the Blender package it runs, tar, launchctl) may see: the basic login
 * environment, uv's own settings and the Blender bridge's, never printer access codes or other server secrets,
 * as the Blender bridge's own environment.
 */
export function setupEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed: NodeJS.ProcessEnv = { ...getDefaultEnvironment() };
  for (const name of ["TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "PATH", "HOME"]) {
    if (env[name] !== undefined) allowed[name] = env[name];
  }
  for (const [key, value] of Object.entries(env)) if (/^(?:BLENDER_|BLENDERMCP_|UV_)/.test(key) && value !== undefined) allowed[key] = value;
  return allowed;
}

export const defaultSetupSystem: SetupSystem = {
  platform: process.platform,
  home: os.homedir(),
  tmp: os.tmpdir(),
  uid: typeof process.getuid === "function" ? process.getuid() : 0,
  cwd: process.cwd(),
  run: async (file, args, options = {}) => {
    const { stdout } = await execFileAsync(file, args, { env: setupEnvironment(options.env ?? process.env), ...(options.cwd ? { cwd: options.cwd } : {}), ...(options.signal ? { signal: options.signal } : {}), timeout: options.timeoutMs ?? 30_000, maxBuffer: 4 * 1024 * 1024 });
    return { stdout: String(stdout) };
  },
  download: async (url, signal) => {
    const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000) });
    if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  },
  listening: (host, port) => new Promise(resolve => {
    const socket = net.createConnection({ host, port });
    const done = (value: boolean) => { socket.destroy(); resolve(value); };
    socket.setTimeout(1_000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  }),
  fusionByBundleId: async () => {
    if (process.platform !== "darwin") return [];
    const found: string[] = [];
    for (const id of FUSION_BUNDLE_IDS) {
      try {
        const { stdout } = await execFileAsync("/usr/bin/mdfind", [`kMDItemCFBundleIdentifier == '${id}'`], { timeout: 10_000 });
        found.push(...String(stdout).split("\n").map(line => line.trim()).filter(Boolean));
      } catch { /* Spotlight off or unavailable: the usual folders are checked too */ }
    }
    return found;
  },
};

async function exists(file: string): Promise<boolean> {
  try { await fs.lstat(file); return true; } catch { return false; }
}

async function regularFile(file: string): Promise<boolean> {
  try { return (await fs.lstat(file)).isFile(); } catch { return false; }
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** The server's own `.env`, when it has one: a client's env block has no file to update. */
function envFile(system: SetupSystem): string { return path.resolve(system.cwd, ".env"); }

// ---------------------------------------------------------------------------------------------------------------
// Blender

/** The add-on's own default port; BLENDER_HOST and BLENDER_PORT move it, as they do for the Blender MCP server. */
export const BLENDER_ADDON_DEFAULT_PORT = 9876;
const MAX_ADDON_BYTES = 4 * 1024 * 1024;
const ADDON_NAME = /["']name["']\s*:\s*["'](?:MCP for Blender|Blender MCP)["']/;
const ADDON_PROTOCOL = /ADDON_PROTOCOL_VERSION\s*=\s*(\d+)/;
const PACKAGE = /^(mcp-for-blender|blender-mcp)(?:(?:@|==)[\w.+-]+)?$/;

/** Asks the configured package itself which add-on protocol it expects and which add-on files Blender has. */
const INSPECT = `import json
from blender_mcp import addon_manager as a
from importlib.metadata import version, requires
import sys
if sys.argv[1] == "blender-mcp" and not any(r.startswith("mcp-for-blender") for r in requires("blender-mcp") or []):
    raise RuntimeError("The configured package is not the upstream compatibility alias")
print(json.dumps({"version":version("mcp-for-blender"),"protocol":a.EXPECTED_ADDON_PROTOCOL_VERSION,"files":[{"path":str(p.absolute()),"protocol":a.read_addon_protocol_version(p)} for p in a.find_existing_addon_installs()]}))`;

/** The running add-on's answer to get_addon_status, as far as setup needs it. */
export type BlenderAddonHandshake = { up_to_date?: boolean; protocol_version?: number | null; expected_protocol_version?: number; blender_version?: string | null };

/** get_addon_status's result, structured or as JSON text; a failed call throws with the add-on's own words. */
export function parseAddonHandshake(reply: { isError?: boolean; structuredContent?: unknown; content?: { type: string; text?: string }[] }): BlenderAddonHandshake | undefined {
  const text = (reply.content ?? []).flatMap(item => item.type === "text" && typeof item.text === "string" ? [item.text] : []).join("\n").trim();
  if (reply.isError) throw new Error(`Blender's add-on could not be checked: ${text || "no details"}`);
  let value: unknown = reply.structuredContent;
  if (!value || typeof value !== "object") { try { value = JSON.parse(text); } catch { return undefined; } }
  if (!value || typeof value !== "object") return undefined;
  const { up_to_date, protocol_version, expected_protocol_version, blender_version } = value as Record<string, unknown>;
  return {
    ...(typeof up_to_date === "boolean" ? { up_to_date } : {}),
    ...(typeof protocol_version === "number" || protocol_version === null ? { protocol_version } : {}),
    ...(typeof expected_protocol_version === "number" ? { expected_protocol_version } : {}),
    ...(typeof blender_version === "string" || blender_version === null ? { blender_version } : {}),
  };
}

/** One change at a time per server: overlapping updates would interleave backups, renames and .env writes. */
class Serial {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    // A request cancelled while it waited never starts.
    const start = () => { signal?.throwIfAborted(); return work(); };
    const next = this.tail.then(start, start);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export type BlenderSetupReport = {
  /** False when the configured bridge isn't the upstream MCP for Blender package run with uvx; see reason. */
  supported: boolean;
  reason?: "not-configured" | "custom-command" | "custom-package";
  package?: string;
  package_version?: string;
  /** The add-on protocol the configured package needs. */
  expected_protocol?: number;
  /** Something answers on the add-on's port: Blender is running with the add-on started. */
  listening: boolean;
  /** The running add-on's handshake; null when it doesn't report one or couldn't be read (see live_error). Only read while listening. */
  live?: BlenderAddonHandshake | null;
  /** Why the running add-on's handshake couldn't be read. */
  live_error?: string;
  /** The add-on file Blender loads, and its protocol (null when the file has none). */
  target?: { path: string; protocol: number | null } | null;
  /** Why there is no target. */
  target_problem?: "not-installed" | "several-modules";
  /** What the person can do, in plain words, when the add-on can't be checked or updated here (reason, target_problem). */
  message?: string;
  /** The installed file's protocol is what the package expects. */
  current?: boolean;
  /** Set by update. */
  replaced?: boolean;
  backup?: string;
};

type Installer = { command: string; packageSpec: string; packageName: string };

const UNSUPPORTED_MESSAGES: Record<NonNullable<BlenderSetupReport["reason"]>, string> = {
  "not-configured": "This printer MCP has no Blender bridge configured (BLENDER_MCP_COMMAND and BLENDER_MCP_ARGS). Set it up for MCP for Blender, then check again.",
  "custom-command": "This Blender bridge uses its own command, so its add-on is updated with that bridge's installer.",
  "custom-package": "This Blender bridge uses its own package, so its add-on is updated with that bridge's installer.",
};
const TARGET_MESSAGES: Record<NonNullable<BlenderSetupReport["target_problem"]>, string> = {
  "not-installed": "The MCP for Blender add-on isn't installed for this Blender. Install it (Edit → Preferences → Add-ons, or uvx mcp-for-blender install-addon), then check again.",
  "several-modules": "More than one MCP for Blender module is installed in this Blender's add-ons folder. Keep the enabled one and remove the others, then check again.",
};

/** uv's uvx, as configured: `uvx`, a full path to it, or Windows' uvx.exe. */
const isUvx = (command: string) => /^uvx(?:\.exe)?$/i.test(path.basename(command.replace(/\\/g, "/")));

/** The configured Blender bridge as an installer: only the upstream package through uvx, as configured. */
function configuredInstaller(env: NodeJS.ProcessEnv): Installer | { reason: NonNullable<BlenderSetupReport["reason"]> } {
  const command = env.BLENDER_MCP_COMMAND?.trim();
  let args: unknown = [];
  try { args = JSON.parse(env.BLENDER_MCP_ARGS?.trim() || "[]"); } catch { args = undefined; /* not JSON: the bridge itself refuses it */ }
  if (!command || !Array.isArray(args) || !args.every(arg => typeof arg === "string")) return { reason: "not-configured" };
  if (!isUvx(command)) return { reason: "custom-command" };
  const from = args.indexOf("--from");
  const spec = from >= 0 ? args[from + 1] : args.find(arg => PACKAGE.test(arg));
  if (typeof spec !== "string" || !PACKAGE.test(spec)) return { reason: "custom-package" };
  return { command, packageSpec: spec, packageName: spec.split(/@|==/)[0]! };
}

/** One add-on module per Blender version folder; other versions are separate installs. */
export function selectBlenderAddonTarget(files: { path?: unknown; protocol?: unknown }[], blenderVersion?: string | null):
  { target: { path: string; protocol: number | null } } | { problem: "not-installed" | "several-modules" } {
  const valid = files.filter((file): file is { path: string; protocol?: unknown } => typeof file.path === "string");
  const version = blenderVersion?.match(/^\d+\.\d+/)?.[0];
  // A Blender version folder in any of Blender's own layouts: macOS and Windows ".../Blender/5.0/...", Linux
  // "~/.config/blender/5.0/...".
  const inVersion = (file: string) => file.split(/[\\/]/).some((part, index, parts) => part === version && parts[index - 1]?.toLowerCase() === "blender");
  const candidates = version ? valid.filter(file => inVersion(file.path)) : valid;
  const first = candidates[0];
  if (!first) return { problem: "not-installed" };
  if (candidates.filter(file => path.dirname(file.path) === path.dirname(first.path)).length !== 1) return { problem: "several-modules" };
  return { target: { path: first.path, protocol: typeof first.protocol === "number" ? first.protocol : null } };
}

function blenderAddress(env: NodeJS.ProcessEnv) {
  const port = Number(env.BLENDER_PORT?.trim() || BLENDER_ADDON_DEFAULT_PORT);
  return { host: env.BLENDER_HOST?.trim() || "localhost", port: Number.isInteger(port) && port > 0 && port < 65536 ? port : BLENDER_ADDON_DEFAULT_PORT };
}

const isAddon = (bytes: Buffer) => ADDON_NAME.test(bytes.toString("utf8"));
const addonProtocol = (bytes: Buffer) => { const match = ADDON_PROTOCOL.exec(bytes.toString("utf8")); return match ? Number(match[1]) : undefined; };

export class BlenderAddonSetup {
  constructor(
    /** The running add-on's get_addon_status through this server's Blender bridge; undefined when it has none. */
    private readonly handshake: () => Promise<BlenderAddonHandshake | undefined>,
    private readonly system: SetupSystem = defaultSetupSystem,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  private async inspect(installer: Installer) {
    const { stdout } = await this.system.run(installer.command, ["--from", installer.packageSpec, "python", "-c", INSPECT, installer.packageName], { env: this.env, cwd: this.system.cwd, timeoutMs: 60_000 });
    let report: { version?: unknown; protocol?: unknown; files?: unknown };
    try { report = JSON.parse(stdout.trim()); } catch { throw new Error("The configured Blender MCP package did not report its add-on files."); }
    if (typeof report.version !== "string" || !/^\d+\.\d+\.\d+[\w.+-]*$/.test(report.version) || typeof report.protocol !== "number"
      || !Number.isInteger(report.protocol) || !Array.isArray(report.files)) throw new Error("The configured Blender MCP package returned an unsupported add-on report.");
    return { version: report.version, protocol: report.protocol, files: report.files as { path?: unknown; protocol?: unknown }[] };
  }

  /** What is installed, what the package expects, and what the running add-on says. Changes nothing. */
  async check(): Promise<BlenderSetupReport> {
    const installer = configuredInstaller(this.env);
    const { host, port } = blenderAddress(this.env);
    const listening = await this.system.listening(host, port);
    if ("reason" in installer) return { supported: false, reason: installer.reason, listening, message: UNSUPPORTED_MESSAGES[installer.reason] };
    let live: BlenderAddonHandshake | null | undefined, liveError: string | undefined;
    if (listening) {
      try { live = (await this.handshake()) ?? null; }
      catch (error) { live = null; liveError = error instanceof Error ? error.message : String(error); }
    }
    const inspected = await this.inspect(installer);
    const selected = selectBlenderAddonTarget(inspected.files, live?.blender_version);
    const report: BlenderSetupReport = { supported: true, package: installer.packageSpec, package_version: inspected.version, expected_protocol: inspected.protocol,
      listening, ...(live !== undefined ? { live } : {}), ...(liveError ? { live_error: liveError } : {}) };
    if ("problem" in selected) return { ...report, target: null, target_problem: selected.problem, current: false, message: TARGET_MESSAGES[selected.problem] };
    return { ...report, target: selected.target, current: selected.target.protocol === inspected.protocol };
  }

  /**
   * Replaces the installed add-on file with the one the configured package's own installer stages, pinned to the
   * inspected version. The existing file must be a regular local MCP for Blender add-on; the staged one must carry
   * the expected protocol. The old file is kept as a backup next to it, and the new one is renamed into place.
   * Blender keeps running the add-on it loaded until it is re-enabled or restarted.
   */
  /** `signal` ends the request: the installer is stopped and nothing is replaced once it is aborted. */
  async update(signal?: AbortSignal): Promise<BlenderSetupReport> { return this.serial.run(() => this.replace(signal), signal); }

  private readonly serial = new Serial();

  private async replace(signal?: AbortSignal): Promise<BlenderSetupReport> {
    const report = await this.check();
    if (!report.supported || !report.target) throw new Error(report.message ?? "The Blender add-on can't be updated here.");
    const target = report.target.path;
    const info = await fs.lstat(target);
    if (!info.isFile() || await fs.realpath(target) !== target) throw new Error("The installed Blender add-on is not a regular local file. Nothing was replaced.");
    const before = await fs.readFile(target);
    if (before.length > MAX_ADDON_BYTES || !isAddon(before)) throw new Error("The installed file is not a recognized MCP for Blender add-on. Nothing was replaced.");
    const installer = configuredInstaller(this.env) as Installer;
    await fs.mkdir(this.system.tmp, { recursive: true });
    const work = await fs.mkdtemp(path.join(this.system.tmp, "blender-addon-"));
    try {
      await this.system.run(installer.command, ["--from", `mcp-for-blender==${report.package_version}`, "mcp-for-blender", "install-addon", "--addons-dir", work],
        { env: this.env, cwd: this.system.cwd, timeoutMs: 120_000, ...(signal ? { signal } : {}) });
      const staged = path.join(work, "blender_mcp.py");
      if (!await regularFile(staged) || !(await fs.realpath(staged)).startsWith(await fs.realpath(work) + path.sep)) throw new Error("The add-on installer did not stage a regular add-on file. Nothing was replaced.");
      const bytes = await fs.readFile(staged);
      if (bytes.length > MAX_ADDON_BYTES || !isAddon(bytes) || addonProtocol(bytes) !== report.expected_protocol) throw new Error("The staged add-on doesn't match the configured Blender MCP package. Nothing was replaced.");
      if (bytes.equals(before)) return { ...report, current: true, replaced: false };
      signal?.throwIfAborted();
      const backup = `${target}.before-update-${randomUUID()}.bak`;
      const saved = await fs.open(backup, "wx", 0o600);
      try { await saved.writeFile(before); await saved.sync(); } finally { await saved.close(); }
      if (!(await fs.readFile(target)).equals(before)) throw new Error("The Blender add-on changed while it was being updated. Nothing was replaced.");
      signal?.throwIfAborted();
      const replacement = path.join(path.dirname(target), `.blender-addon-${randomUUID()}.tmp`);
      try {
        const file = await fs.open(replacement, "wx", info.mode & 0o777);
        try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
        signal?.throwIfAborted();
        await fs.rename(replacement, target);
      } finally { await fs.rm(replacement, { force: true }).catch(() => undefined); }
      const { host, port } = blenderAddress(this.env);
      return { ...report, target: { path: target, protocol: report.expected_protocol ?? null }, current: true, replaced: true, backup,
        listening: await this.system.listening(host, port) };
    } finally {
      await fs.rm(work, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export const BLENDER_SETUP_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    supported: { type: "boolean", description: "The configured bridge is the upstream MCP for Blender package run with uvx, so this tool can check and update its add-on." },
    reason: { type: "string", enum: ["not-configured", "custom-command", "custom-package"] },
    package: { type: "string", description: "The package as BLENDER_MCP_ARGS names it." },
    package_version: { type: "string" },
    expected_protocol: { type: "integer", description: "The add-on protocol the package needs." },
    listening: { type: "boolean", description: "The add-on answers on BLENDER_HOST:BLENDER_PORT (default localhost:9876): Blender is running with it started." },
    live: { type: ["object", "null"], description: "The running add-on's get_addon_status (up_to_date, protocol_version, expected_protocol_version, blender_version); null when it has none or it couldn't be read. Only while listening." },
    live_error: { type: "string", description: "Why the running add-on's handshake couldn't be read." },
    target: { type: ["object", "null"], properties: { path: { type: "string" }, protocol: { type: ["integer", "null"] } }, required: ["path", "protocol"],
      description: "The add-on file Blender loads (for the running Blender's version, when it reports one)." },
    target_problem: { type: "string", enum: ["not-installed", "several-modules"] },
    message: { type: "string", description: "What the person can do, in plain words, when the add-on can't be checked or updated here (with reason or target_problem). Clients show it as it is." },
    current: { type: "boolean", description: "The installed file carries the expected protocol. A running Blender may still have the old add-on loaded: see live." },
    replaced: { type: "boolean", description: "update: the file was replaced. Blender runs the new add-on once it is re-enabled or Blender restarts." },
    backup: { type: "string", description: "update: the previous add-on file, kept next to it." },
  },
  required: ["supported", "listening"],
} as const;

// ---------------------------------------------------------------------------------------------------------------
// Fusion

/** The add-in and server commit Counterpart's Fusion design passes were accepted on (document binding, PRD §8.9). */
export const FUSION_ADDIN_REPOSITORY = "DMontgomery40/fusion360-mcp-server";
export const FUSION_ADDIN_COMMIT = "86a3016a5a5b4a705228acc2f3b75aff7dcfd758";
/** SHA-256 of every file in the add-in (`addon/`) at that commit. Setup installs nothing else. */
export const FUSION_ADDIN_FILES: Readonly<Record<string, string>> = Object.freeze({
  "Fusion360MCP.manifest": "28b50ab54dcc962fba726d1490dafd8d6ff7a78e31bb5011644a68c3f1788afa",
  "Fusion360MCP.py": "f91c44c6ccaa324d7be6ce6bf4fa08d2dceb0dfec599c066e3835f7442a489a5",
  "server/__init__.py": "cfb2ec371f493b437d1029f82a167ff933e59d7660a0b534e7e840a3d84669de",
  "server/command_handler.py": "5f95aa7f2b58ef1458747b29af8eb63598108f22ed4521f0702e2dda91969b19",
  "server/document_scope.py": "2687d370a1a40531c248232e0b1a7c65bbf92c269938e7cb368a78d098c529be",
  "server/event_bridge.py": "a3a8d55a9267e252b5add0e7261fa4f7f216921b265815e5a2451d0dc3246a72",
  "server/hints.py": "981e89c0032223de1c02ef937b3522280c0328933f07ab89912ff522f4544822",
  "server/hole_geometry.py": "872ef1c7d34a21e49e277517cf413322c609fac47e2e64d2c1ed9580af31d25c",
  "server/parameter_units.py": "1fe5bbf505cecc19902c2720d5d53e12944bb61f182c3c0348e971849afa5c00",
  "server/socket_server.py": "758419b11142b9a5068dbc9f1cf339c3d79fc6d5ab77736f4463f8499d053b4d",
});
export type FusionAddinPin = { repository: string; commit: string; files: Readonly<Record<string, string>> };
export const FUSION_ADDIN_PIN: FusionAddinPin = Object.freeze({ repository: FUSION_ADDIN_REPOSITORY, commit: FUSION_ADDIN_COMMIT, files: FUSION_ADDIN_FILES });
const FUSION_BUNDLE_IDS = ["com.autodesk.fusion360", "com.autodesk.mas.fusion360"];
/** A login agent that gives Fusion the add-in's port however Fusion is opened (a GUI app never reads this .env). */
export const FUSION_PORT_AGENT_LABEL = "com.scantomake.mac.fusion-port";
const RUN_ON_STARTUP_OFF = /"runOnStartup"\s*:\s*false/;

export type FusionSetupReport = {
  platform: string;
  /** Setup installs on macOS only. */
  supported: boolean;
  fusion: { installed: boolean; path: string | null };
  pin: { repository: string; commit: string };
  addin: { path: string; installed: boolean; matches_pin: boolean; run_on_startup: boolean };
  port: number;
  port_agent: { path: string; installed: boolean };
  /** FUSION_MCP_COMMAND is set for this server. */
  configured: boolean;
  /** The .env this server read at start, when there is one. */
  env_file: string | null;
  /** Add-in at the pin, port agent installed and the bridge configured. Fusion itself may still need opening. */
  ready: boolean;
  /** When not ready: what is missing and what to do, in plain words clients show as they are. */
  message?: string;
  /** Set by install. */
  installed?: { addin: "installed" | "already-current"; port_agent: "installed" | "already-current"; env: "written" | "already-configured" | "no-env-file"; env_backup?: string };
};

export class FusionAddinSetup {
  constructor(
    /** FUSION_MCP_PORT, as the bridge resolves it. */
    private readonly port: () => number,
    /** The bridge arguments for the pinned server, written with the add-in so the two always match. */
    private readonly serverArgs: readonly string[],
    private readonly system: SetupSystem = defaultSetupSystem,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly pin: FusionAddinPin = FUSION_ADDIN_PIN,
  ) {}

  private get addinsFolder() { return path.join(this.system.home, "Library", "Application Support", "Autodesk", "Autodesk Fusion 360", "API", "AddIns"); }
  private get addinFolder() { return path.join(this.addinsFolder, "Fusion360MCP"); }
  private get portAgent() { return path.join(this.system.home, "Library", "LaunchAgents", `${FUSION_PORT_AGENT_LABEL}.plist`); }

  private async findFusion(): Promise<string | null> {
    for (const found of await this.system.fusionByBundleId()) if (await exists(found)) return found;
    const home = this.system.home;
    const places = [path.join(home, "Library", "Application Support", "Autodesk", "webdeploy", "production", "Autodesk Fusion.app"),
      "/Applications/Autodesk Fusion.app", "/Applications/Autodesk Fusion 360.app",
      path.join(home, "Applications", "Autodesk Fusion.app"), path.join(home, "Applications", "Autodesk Fusion 360.app")];
    for (const place of places) if (await exists(place)) return place;
    return null;
  }

  /** Each pinned file at its pinned bytes; the manifest may carry only setup's runOnStartup change. Fusion's own caches are ignored. */
  private async installedMatchesPin(folder: string): Promise<{ matches: boolean; runOnStartup: boolean }> {
    let runOnStartup = false;
    for (const [relative, expected] of Object.entries(this.pin.files)) {
      const file = path.join(folder, ...relative.split("/"));
      if (!await regularFile(file)) return { matches: false, runOnStartup };
      const bytes = await fs.readFile(file);
      if (relative === "Fusion360MCP.manifest") {
        const text = bytes.toString("utf8");
        runOnStartup = /"runOnStartup"\s*:\s*true/.test(text);
        if (sha256(Buffer.from(text.replace(/"runOnStartup"(\s*):(\s*)true/, '"runOnStartup"$1:$2false'), "utf8")) !== expected) return { matches: false, runOnStartup };
      } else if (sha256(bytes) !== expected) return { matches: false, runOnStartup };
    }
    return { matches: true, runOnStartup };
  }

  private portAgentPlist(): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${FUSION_PORT_AGENT_LABEL}</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>/bin/launchctl</string>
\t\t<string>setenv</string>
\t\t<string>FUSION_MCP_PORT</string>
\t\t<string>${this.port()}</string>
\t</array>
\t<key>RunAtLoad</key>
\t<true/>
</dict>
</plist>
`;
  }

  /**
   * The agent is installed when it sets this port and launchd has it loaded in the login session: a file whose load
   * failed is installed again. An agent written for another port is replaced by install.
   */
  private async portAgentInstalled(): Promise<boolean> {
    if (!await regularFile(this.portAgent)) return false;
    const text = await fs.readFile(this.portAgent, "utf8");
    if (!(text.includes(`<string>${FUSION_PORT_AGENT_LABEL}</string>`) && text.includes("<string>FUSION_MCP_PORT</string>") && text.includes(`<string>${this.port()}</string>`))) return false;
    try { await this.system.run("/bin/launchctl", ["print", `gui/${this.system.uid}/${FUSION_PORT_AGENT_LABEL}`]); return true; } catch { return false; }
  }

  /** What is installed. Changes nothing. */
  async check(): Promise<FusionSetupReport> {
    const supported = this.system.platform === "darwin";
    const fusionPath = supported ? await this.findFusion() : null;
    const addin = await this.installedMatchesPin(this.addinFolder);
    const installed = await regularFile(path.join(this.addinFolder, "Fusion360MCP.py"));
    const portAgent = supported && await this.portAgentInstalled();
    const configured = Boolean(this.env.FUSION_MCP_COMMAND?.trim());
    const env = envFile(this.system);
    const envFound = await regularFile(env);
    const ready = supported && addin.matches && addin.runOnStartup && portAgent && configured;
    const missing = !supported ? ["Fusion setup installs on macOS only. Install the add-in from the repository's addon folder by hand."]
      : [
        ...(fusionPath === null ? ["Autodesk Fusion isn't installed on this Mac. Install it, then set up again."] : []),
        ...(!addin.matches || !addin.runOnStartup ? ["The Fusion360MCP add-in isn't installed at the pinned version, set to run on startup."] : []),
        ...(!portAgent ? ["The login item that gives Fusion its port isn't loaded."] : []),
        ...(!configured ? [envFound ? "This server's Fusion settings (FUSION_MCP_COMMAND) aren't set."
          : "This server has no .env file to add its Fusion settings to: add FUSION_MCP_COMMAND and FUSION_MCP_ARGS to its configuration."] : []),
      ];
    return {
      platform: this.system.platform, supported,
      fusion: { installed: fusionPath !== null, path: fusionPath },
      pin: { repository: this.pin.repository, commit: this.pin.commit },
      addin: { path: this.addinFolder, installed, matches_pin: addin.matches, run_on_startup: addin.runOnStartup },
      port: this.port(),
      port_agent: { path: this.portAgent, installed: portAgent },
      configured,
      env_file: envFound ? env : null,
      ready,
      ...(!ready && missing.length ? { message: missing.join(" ") } : {}),
    };
  }

  /** The pinned add-in, downloaded and checked file by file: every entry a regular file or folder, nothing extra, nothing missing. */
  private async downloadAddin(work: string, signal?: AbortSignal): Promise<string> {
    const archive = path.join(work, "addin.tar.gz");
    let bytes: Buffer;
    try { bytes = await this.system.download(`https://codeload.github.com/${this.pin.repository}/tar.gz/${this.pin.commit}`, signal); }
    catch (error) { throw new Error(`The Fusion add-in couldn't be downloaded (${error instanceof Error ? error.message : String(error)}). Check the internet connection and try again.`); }
    await fs.writeFile(archive, bytes);
    const extracted = path.join(work, "extracted");
    await fs.mkdir(extracted);
    await this.system.run("tar", ["-xzf", archive, "-C", extracted, `${path.basename(this.pin.repository)}-${this.pin.commit}/addon`], { timeoutMs: 60_000, ...(signal ? { signal } : {}) });
    const addon = path.join(extracted, `${path.basename(this.pin.repository)}-${this.pin.commit}`, "addon");
    const found: string[] = [];
    const walk = async (dir: string, prefix: string) => {
      for (const entry of await fs.readdir(dir)) {
        const full = path.join(dir, entry), relative = prefix ? `${prefix}/${entry}` : entry;
        const info = await fs.lstat(full);
        if (info.isDirectory()) { await walk(full, relative); continue; }
        if (!info.isFile()) throw new Error(`The downloaded add-in has ${relative}, which isn't a regular file, so nothing was installed.`);
        if (this.pin.files[relative] !== sha256(await fs.readFile(full))) throw new Error("The downloaded add-in didn't match the pinned version, so nothing was installed.");
        found.push(relative);
      }
    };
    if (!(await fs.lstat(addon).catch(() => undefined))?.isDirectory()) throw new Error("The downloaded archive has no add-in, so nothing was installed.");
    await walk(addon, "");
    if (found.length !== Object.keys(this.pin.files).length) throw new Error("The downloaded add-in didn't match the pinned version, so nothing was installed.");
    return addon;
  }

  private async installAddin(signal?: AbortSignal): Promise<void> {
    await fs.mkdir(this.system.tmp, { recursive: true });
    const work = await fs.mkdtemp(path.join(this.system.tmp, "fusion-addin-"));
    try {
      const addon = await this.downloadAddin(work, signal);
      signal?.throwIfAborted();
      await fs.mkdir(this.addinsFolder, { recursive: true });
      const staging = path.join(this.addinsFolder, `.Fusion360MCP-${randomUUID()}`);
      await fs.cp(addon, staging, { recursive: true, verbatimSymlinks: true });
      const manifest = path.join(staging, "Fusion360MCP.manifest");
      await fs.writeFile(manifest, (await fs.readFile(manifest, "utf8")).replace(RUN_ON_STARTUP_OFF, '"runOnStartup": true'));
      const previous = path.join(this.addinsFolder, `.Fusion360MCP-previous-${randomUUID()}`);
      signal?.throwIfAborted();
      const hadPrevious = await exists(this.addinFolder);
      if (hadPrevious) await fs.rename(this.addinFolder, previous);
      try { await fs.rename(staging, this.addinFolder); }
      catch (error) { if (hadPrevious) await fs.rename(previous, this.addinFolder).catch(() => undefined); throw error; }
      if (hadPrevious) await fs.rm(previous, { recursive: true, force: true });
    } finally {
      await fs.rm(work, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Writes the agent and loads it in the person's login session, where its RunAtLoad sets FUSION_MCP_PORT. */
  private async installPortAgent(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await fs.mkdir(path.dirname(this.portAgent), { recursive: true });
    const temporary = `${this.portAgent}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, this.portAgentPlist(), { mode: 0o644, flag: "wx" });
    await fs.rename(temporary, this.portAgent);
    const domain = `gui/${this.system.uid}`;
    await this.system.run("/bin/launchctl", ["bootout", `${domain}/${FUSION_PORT_AGENT_LABEL}`]).catch(() => undefined); // an earlier copy
    // Loaded in the login session, its RunAtLoad sets the port there; print confirms launchd has it.
    try {
      await this.system.run("/bin/launchctl", ["bootstrap", domain, this.portAgent]);
      await this.system.run("/bin/launchctl", ["print", `${domain}/${FUSION_PORT_AGENT_LABEL}`]);
    } catch { throw new Error(`The login item that gives Fusion its port couldn't be loaded (${this.portAgent}).`); }
  }

  /**
   * Adds the bridge settings this server is missing to its own .env, after a copy of the file. A configured
   * FUSION_MCP_COMMAND is kept with its arguments: it may be a reviewed local runtime. The running server takes
   * the new settings at once.
   */
  private writeSettings(): NonNullable<FusionSetupReport["installed"]>["env"] | { env: "written"; backup: string } {
    const file = envFile(this.system);
    // A setting the process has, or the file gives a value, is the person's: it is never rewritten. An empty one
    // (`FUSION_MCP_COMMAND=` in .env.example) is filled in.
    const inFile = new Set(readFileSync(file, "utf8").split("\n").flatMap(line => {
      const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      return match && match[2]!.replace(/^(['"])(.*)\1$/, "$2").trim() ? [match[1]!] : [];
    }));
    const has = (key: string) => Boolean(this.env[key]?.trim()) || inFile.has(key);
    const values: Record<string, string> = {};
    if (!has("FUSION_MCP_COMMAND")) {
      const blender = this.env.BLENDER_MCP_COMMAND?.trim();
      values.FUSION_MCP_COMMAND = blender && isUvx(blender) ? blender : "uvx";
    }
    // The pinned server, unless the person chose other arguments.
    if (!has("FUSION_MCP_ARGS")) values.FUSION_MCP_ARGS = JSON.stringify(this.serverArgs);
    if (!has("FUSION_MCP_TIMEOUT_MS")) values.FUSION_MCP_TIMEOUT_MS = "180000";
    if (!has("FUSION_MCP_HOST")) values.FUSION_MCP_HOST = "localhost";
    if (!has("FUSION_MCP_PORT")) values.FUSION_MCP_PORT = String(this.port());
    if (!Object.keys(values).length) return "already-configured";
    const quoted = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, key === "FUSION_MCP_ARGS" ? `'${value}'` : value]));
    const backup = path.join(path.dirname(file), `.env.bak-${new Date().toISOString().replace(/[:.]/g, "")}-fusion-setup`);
    try {
      copyFileSync(file, backup, fsConstants.COPYFILE_EXCL);
      writeEnvValues(file, quoted);
    } catch (error) {
      throw new Error(`The Fusion settings couldn't be written to ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    Object.assign(this.env, values);
    return { env: "written", backup };
  }

  /** Installs the pinned add-in set to run on startup, the port login item, and this server's missing bridge settings. */
  /** `signal` ends the request: the download and tar are stopped, and nothing more is written once it is aborted. */
  async install(signal?: AbortSignal): Promise<FusionSetupReport> { return this.serial.run(() => this.installMissing(signal), signal); }

  private readonly serial = new Serial();

  private async installMissing(signal?: AbortSignal): Promise<FusionSetupReport> {
    const before = await this.check();
    if (!before.supported) throw new Error("Fusion setup installs on macOS only. On Windows, install the add-in from the repository's addon folder by hand.");
    const addin = before.addin.matches_pin && before.addin.run_on_startup ? "already-current" : (await this.installAddin(signal), "installed");
    const portAgent = before.port_agent.installed ? "already-current" : (await this.installPortAgent(signal), "installed");
    let env: NonNullable<FusionSetupReport["installed"]>["env"], envBackup: string | undefined;
    if (!before.env_file) env = this.env.FUSION_MCP_COMMAND?.trim() ? "already-configured" : "no-env-file";
    else {
      signal?.throwIfAborted();
      const written = this.writeSettings();
      if (typeof written === "string") env = written;
      else { env = "written"; envBackup = written.backup; }
    }
    return { ...await this.check(), installed: { addin: addin as "installed" | "already-current", port_agent: portAgent as "installed" | "already-current", env, ...(envBackup ? { env_backup: envBackup } : {}) } };
  }
}

export const FUSION_SETUP_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    platform: { type: "string" },
    supported: { type: "boolean", description: "Setup installs on macOS only." },
    fusion: { type: "object", properties: { installed: { type: "boolean" }, path: { type: ["string", "null"] } }, required: ["installed", "path"] },
    pin: { type: "object", properties: { repository: { type: "string" }, commit: { type: "string" } }, required: ["repository", "commit"] },
    addin: { type: "object", properties: { path: { type: "string" }, installed: { type: "boolean" }, matches_pin: { type: "boolean" }, run_on_startup: { type: "boolean" } },
      required: ["path", "installed", "matches_pin", "run_on_startup"] },
    port: { type: "integer" },
    port_agent: { type: "object", properties: { path: { type: "string" }, installed: { type: "boolean" } }, required: ["path", "installed"] },
    configured: { type: "boolean", description: "FUSION_MCP_COMMAND is set for this server." },
    env_file: { type: ["string", "null"], description: "The .env this server read at start, when there is one." },
    ready: { type: "boolean", description: "The add-in is at the pin and runs on startup, the port login item is installed and the bridge is configured. Fusion may still need opening: see fusion_mcp_status." },
    message: { type: "string", description: "When not ready: what is missing and what to do, in plain words. Clients show it as it is." },
    installed: { type: "object", description: "install: what it did.", properties: {
      addin: { type: "string", enum: ["installed", "already-current"] }, port_agent: { type: "string", enum: ["installed", "already-current"] },
      env: { type: "string", enum: ["written", "already-configured", "no-env-file"] }, env_backup: { type: "string" } } },
  },
  required: ["platform", "supported", "fusion", "pin", "addin", "port", "port_agent", "configured", "env_file", "ready"],
} as const;
