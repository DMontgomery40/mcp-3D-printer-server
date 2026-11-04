import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BAMBU_NETWORK_CERTIFICATES } from "./bambu-network-certs.js";
import { discoveredFuluBridgeCommand, linuxPluginLibraryEnv } from "./fulu-orca.js";
import { controlReply, refusedControlMessage } from "./control-reply.js";

// Ported from bambu-printer-mcp src/bambu-network-bridge.ts (FULU's authenticated
// BambuNetwork route). Differences: the bridge command also reads this server's
// FULU_BAMBU_BRIDGE_COMMAND and its FULU install discovery (fulu-orca.ts), and the
// config folder is this server's own.

const FRAME_MAGIC = 0x52424a50;
const FRAME_HEADER_SIZE = 16;
const FRAME_TYPE_JSON_REQUEST = 1;
const FRAME_TYPE_JSON_RESPONSE = 2;
const FRAME_TYPE_BINARY_DATA = 3;
const FRAME_TYPE_LOG = 4;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
// bambu_networking.hpp ConnectStatus.
const LOCAL_CONNECT_STATUS = ["ok", "failed", "lost"];
// bambu_networking.hpp BAMBU_NETWORK_ERR_PRINT_LP_PUBLISH_MSG_FAILED.
const LOCAL_PRINT_PUBLISH_FAILED = -4030;
// bambu_networking.hpp print errors that name a recoverable cause.
const BAMBU_NETWORK_PRINT_ERRORS: Record<number, string> = {
  [-4010]: "the file exceeds the 1 GB upload limit",
  [-4020]: "FTPS upload to the printer failed",
  [LOCAL_PRINT_PUBLISH_FAILED]: "the networking plug-in could not send the print command to the printer over MQTT",
};

/** A parenthesized explanation of a plug-in print result, or "" when it names no known cause. */
export function describeBambuNetworkPrintError(value: number): string {
  return BAMBU_NETWORK_PRINT_ERRORS[value] ? ` (${BAMBU_NETWORK_PRINT_ERRORS[value]})` : "";
}
/** Waits from native/bambu-native-print.cpp, which prints through the same plug-in calls. */
export type LocalTiming = { connectTimeoutMs: number; pollMs: number; settleMs: number; retryWaitMs: number };
export const LOCAL_PRINT_TIMING: Readonly<LocalTiming> = Object.freeze({ connectTimeoutMs: 30_000, pollMs: 250, settleMs: 3_000, retryWaitMs: 8_000 });
/** A control waits briefly for the certificate message, then sends; -4/-4030 returns are retried after a reinstall. */
export type LocalControlTiming = LocalTiming & { certificateWaitMs: number; attempts: number; deliveryMs: number };
export const LOCAL_CONTROL_TIMING: Readonly<LocalControlTiming> = Object.freeze({ ...LOCAL_PRINT_TIMING, settleMs: 1_000, retryWaitMs: 1_500, certificateWaitMs: 5_000, attempts: 3, deliveryMs: 5_000 });

/** Bounded event text for diagnostics, with any access code removed. */
function traceText(text: string): string {
  const clean = text.replace(/("?access_code"?\s*[:=]\s*"?)[^",}\s]*/gi, "$1[redacted]");
  // A signed printer reply (a header, then its payload) is the printer's answer to a command: keep it whole.
  return clean.startsWith('{"header"') ? clean.slice(0, 4000) : clean.slice(0, 160);
}

export { controlReply, isAuthorizationRefusal } from "./control-reply.js";

/** Result of a sent control from the printer's answer during the hold; a refusal throws. */
function controlResult(command: string, route: string, reply: { accepted: boolean; errCode: number } | undefined, attempts: number): Record<string, unknown> {
  const word = `${command[0].toUpperCase()}${command.slice(1)}`;
  if (reply && !reply.accepted) throw new Error(refusedControlMessage(command, route, reply.errCode));
  return { status: "success", attempts, confirmed: Boolean(reply),
    message: reply ? `The printer accepted ${word}.` : `${word} submitted over ${route}. Check printer status to confirm it took effect.` };
}

/** Cloud session waits: connection and printer subscription, certificate, settle after the state requests. */
export type CloudTiming = { connectTimeoutMs: number; pollMs: number; settleMs: number; certificateWaitMs: number };
export const CLOUD_PRINT_TIMING: Readonly<CloudTiming> = Object.freeze({ connectTimeoutMs: 30_000, pollMs: 250, settleMs: 3_000, certificateWaitMs: 10_000 });
export type CloudSession = {
  settle: (ms: number) => Promise<void>;
  /** Ask the plug-in to install the printer's certificate again, as Bambu Studio does after a failed send. */
  installCertificate: () => Promise<void>;
  /** Wait up to ms for device_cert_installed; true once it has arrived. */
  certificateReadyWithin: (ms: number) => Promise<boolean>;
  /** This printer's cloud messages, as they arrive. */
  messages: string[];
  jobUpdates: BridgeJobUpdate[];
};
let stateSequence = 0;
const nextSequence = () => String(++stateSequence);
// The signed Studio channel on P1S 01.10 accepts string IDs in [20000, 29999].
// Larger IDs receive 0502400A even when the RSA signature is valid. Share the
// counter across LAN/cloud controls and retries; never derive IDs from wall time.
let controlSequence = 19_999;
const nextControlSequence = () => String(controlSequence = controlSequence >= 29_999 ? 20_000 : controlSequence + 1);


export type LocalPrinter = { devId: string; devIp: string; username: string; password: string; useSsl: boolean };
export type BridgeJobUpdate = { status: unknown; code: unknown; msg: unknown };
export type LocalSession = {
  installCertificate: () => Promise<void>;
  settle: (ms: number) => Promise<void>;
  /** Waits up to ms for FULU's certificate-installed message for this printer; false if it never came. */
  certificateReadyWithin: (ms: number) => Promise<boolean>;
  /** This printer's messages about stop/pause/resume, as they arrive. */
  controlMessages: string[];
  jobUpdates: BridgeJobUpdate[];
};
/** One line per FULU event or control send, for diagnosing controls. Never includes access codes. */
export type BridgeTrace = (entry: Record<string, unknown>) => void;

type JsonObject = Record<string, unknown>;

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export type BambuNetworkBridgeOptions = {
  bridgeCommand?: string;
  configDir?: string;
  countryCode?: string;
  userInfo?: string;
  timeoutMs?: number;
  /** Trusted in-process preflight; never populated from tool arguments. */
  beforeDispatch?: (method: string) => Promise<void>;
  assertDispatchAllowed?: (method: string) => void;
  /** Diagnostics for a print control: every FULU event and send in its session. */
  trace?: BridgeTrace;
  onDispatched?: (method: string) => void;
};

export type BambuNetworkBridgeStatus = {
  configured: boolean;
  command: string;
  platform: NodeJS.Platform;
  running: boolean;
  pid?: number;
  configDir: string;
  countryCode: string;
  agentReady: boolean;
  lastStderr: string;
  recentLogs: string[];
  runtime: {
    /** Folder passed to the plug-in's set_cert_file. */
    certDir: string;
    /** Linux only: absolute plug-in library paths passed to FULU's host. */
    pluginLibraries?: Record<string, string>;
    /** macOS only: conventional FULU runtime discovery. */
    macosRuntimeDir?: string;
    macosRuntimeDirExists?: boolean;
    macosPluginDir?: string;
    macosPluginDirExists?: boolean;
    macosMissingRuntimeFiles?: string[];
    macosMissingPluginFiles?: string[];
    suggestedMacCommand?: string;
  };
  note?: string;
};

/**
 * The plug-in's certificate folder: BAMBU_NETWORK_CERT_DIR when set, else
 * Bambu's pinned public certificates written to the agent's config folder,
 * which the host must already be able to read.
 */
export function bambuNetworkCertDir(configDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return trimEnv(env.BAMBU_NETWORK_CERT_DIR) || path.join(configDir, "cert");
}

export function prepareBambuNetworkCertDir(configDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const certDir = bambuNetworkCertDir(configDir, env);
  if (trimEnv(env.BAMBU_NETWORK_CERT_DIR)) return certDir;
  fs.mkdirSync(certDir, { recursive: true });
  for (const [name, { sha256, base64 }] of Object.entries(BAMBU_NETWORK_CERTIFICATES)) {
    const content = Buffer.from(base64, "base64");
    if (createHash("sha256").update(content).digest("hex") !== sha256) throw new Error(`Bundled Bambu certificate ${name} does not match its pinned SHA-256.`);
    const target = path.join(certDir, name);
    if (!fileExists(target) || !fs.readFileSync(target).equals(content)) fs.writeFileSync(target, content);
  }
  return certDir;
}

export function defaultBambuNetworkConfigDir(): string {
  return path.join(os.homedir(), ".config", "mcp-3d-printer-server", "bambu-network");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function trimEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * The client identity FULU's GUI gives the plug-in before agent start
 * (GUI_App::init_http_extra_header). Through the Linux bridge FULU presents
 * itself as Bambu Studio at the version its plug-in ABI belongs to
 * (PJarczakLinuxBridgeConfig.cpp forced_client_version, "02.05.02.51").
 * Bambu's cloud issues the printer-control certificate and creates print
 * tasks for this client, so an agent started without it is an unknown client.
 * The device id is kept in the config folder so it stays the same per install.
 * Ported from bambu-printer-mcp src/bambu-network-bridge.ts.
 */
export function bambuNetworkClientHeaders(configDir: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const idFile = path.join(configDir, "client-device-id");
  let deviceId = "";
  try { deviceId = fs.readFileSync(idFile, "utf8").trim(); } catch { /* first start */ }
  if (!deviceId) {
    deviceId = randomUUID();
    try { fs.mkdirSync(configDir, { recursive: true }); fs.writeFileSync(idFile, `${deviceId}\n`, { mode: 0o600 }); } catch { /* still send this run's id */ }
  }
  return {
    "X-BBL-Client-Type": "slicer",
    "X-BBL-Client-Name": trimEnv(env.BAMBU_NETWORK_CLIENT_NAME) ?? "BambuStudio",
    "X-BBL-Client-Version": trimEnv(env.BAMBU_NETWORK_CLIENT_VERSION) ?? "02.05.02.51",
    "X-BBL-OS-Type": "linux",
    "X-BBL-OS-Version": os.release(),
    "X-BBL-Device-ID": deviceId,
    "X-BBL-Language": "en",
  };
}

function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function resolveFirstExistingDirectory(candidates: string[]): string | undefined {
  return candidates.find((candidate) => fileExists(candidate) && fs.statSync(candidate).isDirectory());
}

function resolveFirstDirectoryWithFile(candidates: string[], requiredFile: string): string | undefined {
  return candidates.find(
    (candidate) =>
      fileExists(candidate) &&
      fs.statSync(candidate).isDirectory() &&
      fileExists(path.join(candidate, requiredFile))
  );
}

function collectMissingFiles(baseDir: string | undefined, files: string[]): string[] {
  if (!baseDir) return files;
  return files.filter((file) => !fileExists(path.join(baseDir, file)));
}

/**
 * FULU's Linux host opens its network and source libraries by bare name from
 * its working directory instead of PJARCZAK_BAMBU_PLUGIN_DIR
 * (FULU-Foundation/OrcaSlicer-bambulab#51), so name them in that directory
 * unless they are already set. macOS wrappers run the host in a Linux guest
 * that may not see host paths, so they are left alone.
 */

/** FULU's Linux host exits 101 when it cannot reopen a socket stdout (FULU-Foundation/OrcaSlicer-bambulab#50). */
const STDOUT_SOCKET_HINT =
  "Exit code 101 means FULU's Linux host could not reopen its stdout, which fails when stdout is a socket, as Node.js provides " +
  "(https://github.com/FULU-Foundation/OrcaSlicer-bambulab/issues/50). Launch the host through a wrapper that pipes its output through cat: " +
  "https://github.com/DMontgomery40/mcp-3D-printer-server/blob/main/docs/FULU.md#linux";

/** Conventional FULU macOS runtime locations; the wrapper command is suggested only when it exists. */
function macosRuntimeHints(): Partial<BambuNetworkBridgeStatus["runtime"]> {
  const macosRuntimeDir =
    trimEnv(process.env.PJARCZAK_MAC_RUNTIME_DIR) ||
    path.join(os.homedir(), "Library", "Application Support", "OrcaSlicer", "macos-bridge", "runtime");
  const macosPluginDir =
    trimEnv(process.env.BAMBU_NETWORK_PLUGIN_DIR) ||
    trimEnv(process.env.PJARCZAK_BAMBU_PLUGIN_DIR) ||
    resolveFirstDirectoryWithFile([
      path.join(os.homedir(), "Library", "Application Support", "OrcaSlicer", "plugins"),
      "/Applications/Orca Studio.app/Contents/MacOS",
      "/Applications/OrcaSlicer.app/Contents/MacOS",
      "/Applications/OrcaSlicer-BMCU.app/Contents/MacOS",
      "/Applications/Orca Studio.app/Contents/Resources",
      "/Applications/OrcaSlicer.app/Contents/Resources",
      "/Applications/OrcaSlicer-BMCU.app/Contents/Resources",
      macosRuntimeDir,
    ], "pjarczak-bambu-linux-host-wrapper") ||
    resolveFirstExistingDirectory([macosRuntimeDir]);
  const runtimeRequiredFiles = [
    "libbambu_networking.so",
    "libBambuSource.so",
    "pjarczak_bambu_linux_host",
    "pjarczak_bambu_linux_host_abi1",
    "pjarczak_bambu_linux_host_abi0",
    "ca-certificates.crt",
    "slicer_base64.cer",
  ];
  const pluginRequiredFiles = [
    "pjarczak-bambu-linux-host-wrapper",
    "install_runtime_macos.sh",
    "verify_runtime_macos.sh",
  ];
  const wrapper = macosPluginDir ? path.join(macosPluginDir, "pjarczak-bambu-linux-host-wrapper") : undefined;
  return {
    macosRuntimeDir,
    macosRuntimeDirExists: fileExists(macosRuntimeDir),
    macosPluginDir,
    macosPluginDirExists: macosPluginDir ? fileExists(macosPluginDir) : undefined,
    macosMissingRuntimeFiles: collectMissingFiles(macosRuntimeDir, runtimeRequiredFiles),
    macosMissingPluginFiles: collectMissingFiles(macosPluginDir, pluginRequiredFiles),
    suggestedMacCommand: wrapper && fileExists(wrapper)
      ? `PJARCZAK_BAMBU_PLUGIN_DIR=${shellQuote(macosRuntimeDir)} ${shellQuote(wrapper)} ${shellQuote(path.join(macosRuntimeDir, "pjarczak_bambu_linux_host"))}`
      : undefined,
  };
}

function readFrameJson(payload: Buffer): unknown {
  const text = payload.toString("utf8");
  return text.length > 0 ? JSON.parse(text) : {};
}

function isBridgeFailure(value: unknown): value is { ok: false; error?: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { ok?: unknown }).ok === false
  );
}

function bridgeValueAsNumber(value: unknown, method: string): number {
  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { value?: unknown }).value === "number"
  ) {
    return (value as { value: number }).value;
  }

  throw new Error(`FULU BambuNetwork bridge method ${method} did not return a numeric value.`);
}

function bridgeNumericResult(value: unknown): number | undefined {
  return typeof value === "object" && value !== null && typeof (value as { value?: unknown }).value === "number"
    ? (value as { value: number }).value
    : undefined;
}

function bridgeValueIsTrue(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as { value?: unknown }).value === true;
}

function assertBridgeOk(value: unknown, method: string): void {
  if (isBridgeFailure(value)) {
    const errorText = value.error === undefined ? "unknown bridge error" : String(value.error);
    throw new Error(`FULU BambuNetwork bridge method ${method} failed: ${errorText}`);
  }
}

export class BambuNetworkBridge {
  private child?: ChildProcessWithoutNullStreams;
  private commandLine?: string;
  private stdoutBuffer = Buffer.alloc(0);
  private pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private agentId?: number;
  private agentKey?: string;
  private handshake?: unknown;
  private lastStderr = "";
  private recentLogs: string[] = [];
  private inferredExpectedNetworkVersion?: string;
  /** Whether the host accepted the certificate folder and callbacks a LAN session needs. */
  private localSessionReady = false;
  /**
   * The plug-in holds one LAN printer connection and the host one event queue,
   * so LAN sessions run one at a time, as Bambu Studio connects one printer.
   */
  private localSessionTail: Promise<void> = Promise.resolve();

  resolveBridgeCommand(override?: string): string {
    return (
      trimEnv(override) ||
      trimEnv(process.env.BAMBU_NETWORK_BRIDGE_COMMAND) ||
      trimEnv(process.env.FULU_BAMBU_NETWORK_BRIDGE_COMMAND) ||
      trimEnv(process.env.PJARCZAK_BAMBU_BRIDGE_COMMAND) ||
      trimEnv(process.env.FULU_BAMBU_BRIDGE_COMMAND) ||
      discoveredFuluBridgeCommand() ||
      ""
    );
  }

  resolveConfigDir(override?: string): string {
    return (
      trimEnv(override) ||
      trimEnv(process.env.BAMBU_NETWORK_CONFIG_DIR) ||
      trimEnv(process.env.PJARCZAK_BAMBU_PROBE_LOG_DIR) ||
      defaultBambuNetworkConfigDir()
    );
  }

  resolveCountryCode(override?: string): string {
    return (
      trimEnv(override) ||
      trimEnv(process.env.BAMBU_NETWORK_COUNTRY_CODE) ||
      trimEnv(process.env.PJARCZAK_BAMBU_COUNTRY_CODE) ||
      "US"
    );
  }

  getStatus(options: BambuNetworkBridgeOptions = {}): BambuNetworkBridgeStatus {
    const command = this.resolveBridgeCommand(options.bridgeCommand);
    const configDir = this.resolveConfigDir(options.configDir);
    const countryCode = this.resolveCountryCode(options.countryCode);

    const runtime: BambuNetworkBridgeStatus["runtime"] = { certDir: bambuNetworkCertDir(configDir) };
    if (process.platform === "linux") {
      const pluginLibraries = {
        ...Object.fromEntries(["PJARCZAK_BAMBU_NETWORK_SO", "PJARCZAK_BAMBU_SOURCE_SO"].flatMap(name => {
          const value = trimEnv(process.env[name]);
          return value ? [[name, value]] : [];
        })),
        ...linuxPluginLibraryEnv(process.env, process.platform),
      };
      if (Object.keys(pluginLibraries).length) runtime.pluginLibraries = pluginLibraries;
    }
    if (process.platform === "darwin") Object.assign(runtime, macosRuntimeHints());

    return {
      configured: command.length > 0,
      command,
      platform: process.platform,
      running: Boolean(this.child && this.child.exitCode === null),
      pid: this.child?.pid,
      configDir,
      countryCode,
      agentReady: this.agentId !== undefined,
      lastStderr: this.lastStderr,
      recentLogs: this.recentLogs.slice(-10),
      runtime,
      note: command
        ? undefined
        : "Set BAMBU_NETWORK_BRIDGE_COMMAND to the FULU OrcaSlicer-bambulab Linux host or macOS/WSL wrapper command.",
    };
  }

  async request(method: string, payload: JsonObject = {}, options: BambuNetworkBridgeOptions = {}): Promise<unknown> {
    if (!method.trim()) {
      throw new Error("BambuNetwork bridge method is required.");
    }

    await this.ensureStarted(options.bridgeCommand);
    await options.beforeDispatch?.(method);

    const id = this.nextRequestId++;
    const requestPayload = Buffer.from(JSON.stringify({ method, payload }), "utf8");
    const frame = Buffer.alloc(FRAME_HEADER_SIZE + requestPayload.length);
    frame.writeUInt32LE(FRAME_MAGIC, 0);
    frame.writeUInt32LE(FRAME_TYPE_JSON_REQUEST, 4);
    frame.writeUInt32LE(id, 8);
    frame.writeUInt32LE(requestPayload.length, 12);
    requestPayload.copy(frame, FRAME_HEADER_SIZE);

    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for FULU BambuNetwork bridge method ${method}.`));
      }, options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);

      this.pending.set(id, { method, resolve, reject, timer });

      try {
        options.assertDispatchAllowed?.(method);
        this.child!.stdin.write(frame, (error) => {
          if (error) {
            const pending = this.pending.get(id);
            if (pending) {
              clearTimeout(pending.timer);
              this.pending.delete(id);
              pending.reject(error);
            }
          }
        });
        options.onDispatched?.(method);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async ensureAgent(options: BambuNetworkBridgeOptions = {}): Promise<{
    agent: number;
    handshake: unknown;
  }> {
    const command = this.resolveBridgeCommand(options.bridgeCommand);
    const configDir = this.resolveConfigDir(options.configDir);
    const countryCode = this.resolveCountryCode(options.countryCode);
    const userInfo = trimEnv(options.userInfo) || trimEnv(process.env.BAMBU_NETWORK_USER_INFO) || "";
    const certDir = bambuNetworkCertDir(configDir);
    const key = `${command}\n${configDir}\n${countryCode}\n${userInfo}\n${certDir}`;

    if (this.agentId !== undefined && this.agentKey === key) {
      return { agent: this.agentId, handshake: this.handshake };
    }

    fs.mkdirSync(configDir, { recursive: true });
    prepareBambuNetworkCertDir(configDir);

    this.handshake = await this.request("bridge.handshake", {}, options);
    assertBridgeOk(this.handshake, "bridge.handshake");
    if (this.needsExpectedVersionRetry(this.handshake) && !trimEnv(process.env.PJARCZAK_EXPECTED_BAMBU_NETWORK_VERSION)) {
      this.inferredExpectedNetworkVersion = this.handshake.network_actual_abi_version;
      await this.stop();
      this.handshake = await this.request("bridge.handshake", {}, options);
      assertBridgeOk(this.handshake, "bridge.handshake");
    }
    const loaded = this.handshake as { network_loaded?: unknown; network_status?: unknown } | undefined;
    if (loaded?.network_loaded === false && typeof loaded.network_status === "string" && /file open failed/i.test(loaded.network_status)) {
      throw new Error(
        `FULU BambuNetwork bridge could not open its networking library (${loaded.network_status}). ` +
        "Set PJARCZAK_BAMBU_PLUGIN_DIR to the directory containing libbambu_networking.so and libBambuSource.so, " +
        "or set PJARCZAK_BAMBU_NETWORK_SO and PJARCZAK_BAMBU_SOURCE_SO to their absolute paths: " +
        "https://github.com/DMontgomery40/mcp-3D-printer-server/blob/main/docs/FULU.md#linux"
      );
    }

    const created = await this.request("net.create_agent", { log_dir: configDir, country_code: countryCode }, options);
    assertBridgeOk(created, "net.create_agent");
    const agent = bridgeValueAsNumber(created, "net.create_agent");

    const withAgent = async (method: string, payload: JsonObject = {}, hardFail = true): Promise<unknown> => {
      const response = await this.request(method, { ...payload, agent }, options);
      if (hardFail) assertBridgeOk(response, method);
      return response;
    };

    await withAgent("net.set_config_dir", { config_dir: configDir });
    await withAgent("net.init_log");
    // Bambu Studio and FULU's GUI set this before starting the agent. The
    // plug-in verifies a LAN printer with printer.cer from this folder, and
    // FULU's host crashes on connect_printer when no folder was ever set.
    const certificates = await withAgent("net.set_cert_file", { folder: certDir, filename: "slicer_base64.cer" }, false);
    // FULU's GUI order: set_cert_file, then the client headers, then start.
    await withAgent("net.set_extra_http_header", { headers: bambuNetworkClientHeaders(configDir) }, false);
    await withAgent("net.set_country_code", { country_code: countryCode });
    await withAgent("net.start");
    // The plug-in runs callbacks through queue_on_main; FULU's host executes
    // them on its own dispatcher and queues on_local_connect for poll_events.
    // Cloud jobs and probes do not depend on these, so a host without them
    // still starts; a LAN session refuses before connecting instead.
    const callbacks = [await withAgent("net.set_queue_on_main_fn", {}, false), await withAgent("net.set_on_local_connect_fn", {}, false)];
    const localSessionReady = ![certificates, ...callbacks].some(isBridgeFailure);
    await withAgent("net.connect_server", {}, false);

    if (userInfo) {
      await withAgent("net.change_user", { user_info: userInfo });
    }

    this.agentId = agent;
    this.agentKey = key;
    this.localSessionReady = localSessionReady;
    return { agent, handshake: this.handshake };
  }

  /**
   * Open the plug-in's own LAN MQTT session with a printer, in the order Bambu
   * Studio and native/bambu-native-print.cpp use: connect, install the
   * printer's application certificate (again on each "wait_info"), wait for
   * the local connection, request the printer's state and let the key
   * exchange settle. Without the certificate the plug-in uploads a job but
   * cannot encrypt or publish project_file (-4030). The session is closed
   * after `run`, so printer reports stop accumulating in the host's queue.
   */
  async withLocalSession<T>(
    printer: LocalPrinter,
    options: BambuNetworkBridgeOptions,
    assertActive: () => void,
    timing: Readonly<LocalTiming>,
    run: (session: LocalSession) => Promise<T>
  ): Promise<T> {
    const previous = this.localSessionTail;
    let release!: () => void;
    this.localSessionTail = new Promise<void>(resolve => { release = resolve; });
    try {
      await previous;
      return await this.runLocalSession(printer, options, assertActive, timing, run);
    } finally {
      release();
    }
  }

  private async runLocalSession<T>(
    printer: LocalPrinter,
    options: BambuNetworkBridgeOptions,
    assertActive: () => void,
    timing: Readonly<LocalTiming>,
    run: (session: LocalSession) => Promise<T>
  ): Promise<T> {
    const jobUpdates: BridgeJobUpdate[] = [];
    const controlMessages: string[] = [];
    let certificateReady = false;
    const installCertificate = async () => {
      await this.callWithAgent("net.install_device_cert", { dev_id: printer.devId, lan_only: true }, options);
      await this.callWithAgent("net.update_cert", {}, options);
    };
    // Drain queued events: collect job reports, return this printer's
    // local-connect statuses, and reinstall the certificate on "wait_info".
    const pump = async (): Promise<unknown[]> => {
      const polled = await this.request("bridge.poll_events", { limit: 1024 }, options) as { events?: unknown };
      assertBridgeOk(polled, "bridge.poll_events");
      const statuses: unknown[] = [];
      let waitInfo = false;
      for (const event of Array.isArray(polled?.events) ? polled.events : []) {
        options.trace?.({ event: event?.name, devMatch: event?.payload?.dev_id === undefined ? "none" : event.payload.dev_id === printer.devId,
          ...(event?.payload?.status !== undefined ? { status: event.payload.status } : {}), ...(typeof event?.payload?.msg === "string" ? { msg: traceText(event.payload.msg) } : {}) });
        if (event?.name === "job.update_status") jobUpdates.push({ status: event.payload?.status, code: event.payload?.code, msg: event.payload?.msg });
        const eventDev = event?.payload?.dev_id;
        if (eventDev !== undefined && eventDev !== "" && eventDev !== printer.devId) continue;
        // FULU v1.0.0 GUI_App's certificate-state callback. A connect callback
        // alone does not establish that protected controls can be encrypted.
        if (eventDev === printer.devId && (event?.name === "on_local_message" || event?.name === "on_message")) {
          if (event.payload?.msg === "device_cert_installed") certificateReady = true;
          if (event.payload?.msg === "device_cert_uninstalled") certificateReady = false;
          if (typeof event.payload?.msg === "string" && /"command":"(stop|pause|resume)"/.test(event.payload.msg)) controlMessages.push(event.payload.msg);
        }
        if (event?.name === "on_local_connect") statuses.push(event.payload.status);
        if ((event?.name === "on_local_message" || event?.name === "on_message") && event.payload?.msg === "wait_info") waitInfo = true;
      }
      if (waitInfo) await installCertificate();
      return statuses;
    };
    const settle = async (ms: number) => {
      for (const deadline = Date.now() + ms; Date.now() < deadline;) {
        assertActive();
        await pump();
        await new Promise(resolve => setTimeout(resolve, timing.pollMs));
      }
    };
    const certificateReadyWithin = async (ms: number) => {
      const deadline = Date.now() + ms;
      do {
        assertActive();
        await pump();
        if (certificateReady) return true;
        await new Promise(resolve => setTimeout(resolve, timing.pollMs));
      } while (Date.now() < deadline);
      return certificateReady;
    };

    await this.ensureAgent(options);
    assertActive();
    if (!this.localSessionReady) {
      throw new Error("FULU BambuNetwork bridge host did not accept the certificate folder or local-connection callbacks a LAN print needs. Update the FULU runtime; no print command was sent.");
    }
    for (const callback of ["net.set_on_printer_connected_fn", "net.set_on_message_fn", "net.set_on_local_message_fn"]) {
      assertBridgeOk(await this.callWithAgent(callback, {}, options), callback);
    }
    await this.callWithAgent("net.update_cert", {}, options);
    await pump();
    certificateReady = false; // Ignore completion queued by an earlier session.
    assertActive();
    const requested = await this.callWithAgent("net.connect_printer", {
      dev_id: printer.devId, dev_ip: printer.devIp, username: printer.username, password: printer.password, use_ssl: printer.useSsl,
    }, options);
    assertBridgeOk(requested, "net.connect_printer");
    const connectResult = bridgeValueAsNumber(requested, "net.connect_printer");
    if (connectResult !== 0) {
      throw new Error(`FULU BambuNetwork bridge could not start a LAN connection to printer ${printer.devId} (net.connect_printer returned ${connectResult}). No print command was sent.`);
    }

    let connected = false;
    try {
      await installCertificate();
      const deadline = Date.now() + timing.connectTimeoutMs;
      while (!connected) {
        assertActive();
        for (const status of await pump()) {
          if (status === 0) {
            connected = true;
            continue;
          }
          const reason = typeof status === "number" && LOCAL_CONNECT_STATUS[status] ? LOCAL_CONNECT_STATUS[status] : `reported status ${status}`;
          throw new Error(`FULU BambuNetwork bridge LAN connection to printer ${printer.devId} at ${printer.devIp} ${reason}. Check the printer IP, LAN access code and LAN mode. No print command was sent.`);
        }
        if (connected) break;
        if (Date.now() >= deadline) {
          throw new Error(`FULU BambuNetwork bridge did not connect to printer ${printer.devId} at ${printer.devIp} over LAN within ${Math.round(timing.connectTimeoutMs / 1000)} s. No print command was sent.`);
        }
        await new Promise(resolve => setTimeout(resolve, timing.pollMs));
      }
      // Bambu Studio asks a newly connected printer for its full state and
      // security metadata before building the encrypted project_file message.
      for (const [message, qos] of [
        [{ pushing: { sequence_id: "1", command: "pushall", version: 1, push_target: 1 } }, 0],
        [{ info: { sequence_id: "2", command: "get_version" } }, 1],
        [{ system: { sequence_id: "3", command: "get_access_code" } }, 0],
      ] as const) {
        await this.callWithAgent("net.send_message_to_printer", { dev_id: printer.devId, msg: JSON.stringify(message), qos, flag: 0 }, options);
      }
      await settle(timing.settleMs);
      const result = await run({ installCertificate, settle, certificateReadyWithin, controlMessages, jobUpdates });
      await pump();
      return result;
    } finally {
      const cleanupFailed = (step: string) => (error: unknown) => console.error(`FULU BambuNetwork bridge ${step} after the LAN session failed: ${error instanceof Error ? error.message : error}`);
      if (connected) await this.callWithAgent("net.disconnect_printer", {}, options).catch(cleanupFailed("disconnect"));
      await this.request("bridge.poll_events", { limit: 4096 }, options).catch(cleanupFailed("event cleanup"));
    }
  }

  /**
   * Run a LAN print method in a local session. A synchronous -4030 means the
   * plug-in published nothing, so it is retried once after the certificate
   * exchange, as the native helper does; each attempt passes the caller's
   * fresh pre-dispatch checks.
   */
  async startLocalPrint(
    printer: LocalPrinter,
    method: string,
    payload: JsonObject,
    options: BambuNetworkBridgeOptions = {},
    assertActive: () => void = () => {},
    timing: Readonly<LocalTiming> = LOCAL_PRINT_TIMING
  ): Promise<{ result: unknown; jobUpdates: BridgeJobUpdate[] }> {
    return await this.withLocalSession(printer, options, assertActive, timing, async session => {
      let result = await this.callWithAgent(method, payload, options);
      if (bridgeNumericResult(result) === LOCAL_PRINT_PUBLISH_FAILED) {
        await session.settle(timing.retryWaitMs);
        await session.installCertificate();
        await session.settle(timing.settleMs);
        result = await this.callWithAgent(method, payload, options);
      }
      return { result, jobUpdates: session.jobUpdates };
    });
  }

  /**
   * A print control (stop, pause, resume) through the same authenticated LAN
   * session as a FULU print. FULU's own app sends controls exactly this way
   * (send_message_to_printer, qos 1, flag 0) on a connection whose certificate
   * is installed. A fresh connection can report SEND_MSG_FAILED (-4) or
   * LP_PUBLISH_MSG_FAILED (-4030) while that exchange finishes: those returns
   * mean nothing was sent, so the certificate is reinstalled and the control
   * tried again, as the native X2D helper does. Any other return is final.
   * beforeDispatch runs before every send, so a resume re-checks the paused job.
   */
  async sendLocalPrintCommand(printer: LocalPrinter, command: "stop" | "pause" | "resume", options: BambuNetworkBridgeOptions = {},
    beforeDispatch?: () => Promise<void>, timing: Readonly<LocalControlTiming> = LOCAL_CONTROL_TIMING): Promise<Record<string, unknown>> {
    const assertActive = () => options.assertDispatchAllowed?.("net.send_message_to_printer");
    const trace = options.trace ?? this.controlTrace(options);
    const traced = { ...options, trace };
    return this.withLocalSession(printer, traced, assertActive, timing, async session => {
      const ready = await session.certificateReadyWithin(timing.certificateWaitMs);
      trace({ step: "certificate", ready });
      const method = "net.send_message_to_printer";
      let code = 0;
      for (let attempt = 1; attempt <= timing.attempts; attempt++) {
        await beforeDispatch?.();
        assertActive();
        const sequenceId = nextControlSequence();
        const result = await this.callWithAgent(method, {
          dev_id: printer.devId,
          msg: JSON.stringify({ print: { command, param: "", sequence_id: sequenceId } }),
          qos: 1, flag: 0,
        }, traced);
        assertBridgeOk(result, method);
        code = bridgeValueAsNumber(result, method);
        trace({ step: "send", command, attempt, code });
        if (code === 0) {
          // The plug-in queues the publish; disconnecting at once dropped it (Nov 3: five accepted
          // controls, printer never paused or stopped). Stay connected while it reaches the printer.
          await session.settle(timing.deliveryMs);
          trace({ step: "delivered", command, heldMs: timing.deliveryMs });
          const reply = session.controlMessages.map(msg => controlReply(msg, command, sequenceId)).find(Boolean);
          return controlResult(command, "the local network", reply, attempt);
        }
        if ((code !== -4 && code !== -4030) || attempt === timing.attempts) break;
        await session.settle(timing.retryWaitMs);
        await session.installCertificate();
        await session.certificateReadyWithin(timing.certificateWaitMs);
      }
      throw new Error(`The printer did not accept ${command} over the authenticated FULU LAN connection (plug-in code ${code}).`);
    });
  }

  /**
   * Open the plug-in's Bambu Cloud session with a printer bound to the account, in the order
   * Bambu Studio uses (GUI_App.cpp on_server_connected / on_printer_connected): wait for the
   * cloud connection, select and subscribe to the printer, and when it connects request its
   * state (pushall, get_version, get_access_code) and install its certificate for cloud use.
   * Without that state the plug-in refuses a cloud print with -3140 (ENC_FLAG_NOT_READY).
   * Shares the LAN session queue: one reader of the plug-in's events at a time.
   */
  async withCloudSession<T>(
    devId: string,
    options: BambuNetworkBridgeOptions,
    assertActive: () => void,
    timing: Readonly<CloudTiming>,
    run: (session: CloudSession) => Promise<T>
  ): Promise<T> {
    const previous = this.localSessionTail;
    let release!: () => void;
    this.localSessionTail = new Promise<void>(resolve => { release = resolve; });
    try {
      await previous;
      await this.ensureAgent(options);
      assertActive();
      if (!bridgeValueIsTrue(await this.callWithAgent("net.is_user_login", {}, options))) {
        throw new Error("FULU's networking plug-in is not signed in to Bambu Cloud, so nothing was sent to the printer.");
      }
      for (const callback of ["net.set_on_printer_connected_fn", "net.set_on_message_fn", "net.set_on_server_connected_fn"]) {
        assertBridgeOk(await this.callWithAgent(callback, {}, options), callback);
      }
      const messages: string[] = [];
      const jobUpdates: BridgeJobUpdate[] = [];
      let printerConnected = false;
      let certificateReady = false;
      const pump = async () => {
        const polled = await this.request("bridge.poll_events", { limit: 1024 }, options) as { events?: any[] };
        assertBridgeOk(polled, "bridge.poll_events");
        for (const event of Array.isArray(polled?.events) ? polled.events : []) {
          const eventDev = event?.payload?.dev_id ?? (typeof event?.payload?.topic_str === "string" ? event.payload.topic_str.replace(/^tunnel\//, "") : undefined);
          options.trace?.({ event: event?.name, devMatch: eventDev === undefined ? "none" : eventDev === devId, ...(typeof event?.payload?.msg === "string" ? { msg: traceText(event.payload.msg) } : {}) });
          if (event?.name === "job.update_status") jobUpdates.push({ status: event.payload?.status, code: event.payload?.code, msg: event.payload?.msg });
          if (eventDev !== devId) continue;
          if (event?.name === "on_printer_connected") printerConnected = true;
          if (event?.name === "on_message" && typeof event.payload?.msg === "string") {
            if (event.payload.msg === "device_cert_installed") certificateReady = true;
            else if (event.payload.msg === "device_cert_uninstalled") certificateReady = false;
            else messages.push(event.payload.msg);
          }
        }
      };
      const waitFor = async (done: () => boolean, ms: number) => {
        for (const deadline = Date.now() + ms; !done() && Date.now() < deadline;) {
          assertActive();
          await pump();
          if (!done()) await new Promise(resolve => setTimeout(resolve, timing.pollMs));
        }
        return done();
      };
      const settle = async (ms: number) => { await waitFor(() => false, ms); };
      for (const deadline = Date.now() + timing.connectTimeoutMs; !bridgeValueIsTrue(await this.callWithAgent("net.is_server_connected", {}, options));) {
        if (Date.now() >= deadline) throw new Error(`FULU's networking plug-in could not reach Bambu Cloud within ${Math.round(timing.connectTimeoutMs / 1000)} s, so nothing was sent to the printer.`);
        assertActive();
        await new Promise(resolve => setTimeout(resolve, timing.pollMs));
      }
      await this.callWithAgent("net.set_user_selected_machine", { dev_id: devId }, options);
      await this.callWithAgent("net.add_subscribe", { devs: [devId] }, options);
      if (!await waitFor(() => printerConnected, timing.connectTimeoutMs)) {
        throw new Error(`Bambu Cloud did not connect to printer ${devId} within ${Math.round(timing.connectTimeoutMs / 1000)} s. Check that the printer is online and bound to this account. Nothing was sent to the printer.`);
      }
      for (const [message, qos] of [
        [{ pushing: { sequence_id: nextSequence(), command: "pushall", version: 1, push_target: 1 } }, 0],
        [{ info: { sequence_id: nextSequence(), command: "get_version" } }, 1],
        [{ system: { sequence_id: nextSequence(), command: "get_access_code" } }, 0],
      ] as const) {
        await this.callWithAgent("net.send_message", { dev_id: devId, msg: JSON.stringify(message), qos, flag: 0 }, options);
      }
      const installCertificate = async () => { await this.callWithAgent("net.install_device_cert", { dev_id: devId, lan_only: false }, options); };
      const certificateReadyWithin = (ms: number) => waitFor(() => certificateReady, ms);
      await installCertificate();
      const ready = await certificateReadyWithin(timing.certificateWaitMs);
      options.trace?.({ step: "certificate", route: "cloud", ready });
      await settle(timing.settleMs);
      const result = await run({ settle, messages, jobUpdates, installCertificate, certificateReadyWithin });
      await pump();
      return result;
    } finally {
      release();
    }
  }

  /** A cloud print method (start_print) in a cloud session, so the plug-in has the printer's state. */
  async startCloudPrint(devId: string, method: string, payload: JsonObject, options: BambuNetworkBridgeOptions = {},
    assertActive: () => void = () => {}, timing: Readonly<CloudTiming> = CLOUD_PRINT_TIMING): Promise<{ result: unknown; jobUpdates: BridgeJobUpdate[] }> {
    return await this.withCloudSession(devId, options, assertActive, timing, async session => ({ result: await this.callWithAgent(method, payload, options), jobUpdates: session.jobUpdates }));
  }

  /**
   * A print control over Bambu Cloud: how Bambu Studio and FULU's slicer control a printer
   * bound to the account (MachineObject::publish_json → cloud_publish_json: send_message,
   * qos 1, flag 0), in a cloud session. Held open like the LAN control.
   */
  async sendCloudPrintCommand(devId: string, command: "stop" | "pause" | "resume", options: BambuNetworkBridgeOptions = {},
    beforeDispatch?: () => Promise<void>, timing: Readonly<LocalControlTiming> = LOCAL_CONTROL_TIMING): Promise<Record<string, unknown>> {
    const method = "net.send_message";
    const assertActive = () => options.assertDispatchAllowed?.(method);
    const trace = options.trace ?? this.controlTrace(options);
    const traced = { ...options, trace };
    return this.withCloudSession(devId, traced, assertActive, timing, async session => {
      let code = 0;
      for (let attempt = 1; attempt <= timing.attempts; attempt++) {
        await beforeDispatch?.();
        assertActive();
        const sequenceId = nextControlSequence();
        const result = await this.callWithAgent(method, {
          dev_id: devId, msg: JSON.stringify({ print: { command, param: "", sequence_id: sequenceId } }), qos: 1, flag: 0,
        }, traced);
        assertBridgeOk(result, method);
        code = bridgeValueAsNumber(result, method);
        trace({ step: "send", route: "cloud", command, attempt, code });
        if (code === 0) {
          await session.settle(timing.deliveryMs);
          trace({ step: "delivered", route: "cloud", command, heldMs: timing.deliveryMs });
          return controlResult(command, "Bambu Cloud", session.messages.map(msg => controlReply(msg, command, sequenceId)).find(Boolean), attempt);
        }
        // Before the printer's certificate is installed the plug-in sends nothing and returns
        // CONNECT_FAILED (-2) or SEND_MSG_FAILED (-4), as on the LAN route (Nov 3: cloud pause -2
        // with the certificate not yet installed). Reinstall it, wait, and send again.
        if ((code !== -2 && code !== -4) || attempt === timing.attempts) break;
        await session.settle(timing.retryWaitMs);
        await session.installCertificate();
        trace({ step: "certificate", route: "cloud", attempt, ready: await session.certificateReadyWithin(timing.certificateWaitMs) });
      }
      throw new Error(`Bambu Cloud did not accept ${command} for printer ${devId} (plug-in code ${code}).`);
    });
  }

  /** Appends control diagnostics to control-trace.log in the bridge's config folder. */
  private controlTrace(options: BambuNetworkBridgeOptions): BridgeTrace {
    const file = path.join(this.resolveConfigDir(options.configDir), "control-trace.log");
    return entry => {
      try { fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", { mode: 0o600 }); } catch { /* diagnostics only */ }
    };
  }

  async callWithAgent(
    method: string,
    payload: JsonObject = {},
    options: BambuNetworkBridgeOptions = {}
  ): Promise<unknown> {
    const { agent } = await this.ensureAgent(options);
    return await this.request(method, { ...payload, agent }, options);
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.commandLine = undefined;
    this.agentId = undefined;
    this.agentKey = undefined;
    this.handshake = undefined;
    this.stdoutBuffer = Buffer.alloc(0);

    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`FULU BambuNetwork bridge stopped before ${pending.method} completed.`));
      this.pending.delete(id);
    }

    if (child && child.exitCode === null) {
      await new Promise<void>((resolve) => {
        const forceTimer = setTimeout(() => {
          if (child.exitCode === null) {
            child.kill("SIGKILL");
          }
        }, 2000);
        child.once("close", () => {
          clearTimeout(forceTimer);
          resolve();
        });
        child.kill("SIGTERM");
      });
    }
  }

  private async ensureStarted(commandOverride?: string): Promise<void> {
    const command = this.resolveBridgeCommand(commandOverride);
    if (!command) {
      throw new Error(
        "BAMBU_NETWORK_BRIDGE_COMMAND is required for FULU BambuNetwork support. " +
        "Point it at pjarczak_bambu_linux_host or the OrcaSlicer-bambulab macOS/WSL wrapper."
      );
    }

    if (this.child && this.child.exitCode === null && this.commandLine === command) {
      return;
    }

    if (this.child && this.commandLine !== command) {
      await this.stop();
    }

    const shell = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
    const shellArgs = process.platform === "win32"
      ? ["/d", "/s", "/c", command]
      : ["-lc", command];

    this.child = spawn(shell, shellArgs, {
      env: {
        ...process.env,
        ...linuxPluginLibraryEnv(process.env, process.platform),
        PJARCZAK_BAMBU_COUNTRY_CODE: this.resolveCountryCode(),
        PJARCZAK_EXPECTED_BAMBU_NETWORK_VERSION:
          this.inferredExpectedNetworkVersion ||
          process.env.PJARCZAK_EXPECTED_BAMBU_NETWORK_VERSION ||
          "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.commandLine = command;

    const spawnedChild = this.child;
    spawnedChild.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk));
    spawnedChild.stderr.on("data", (chunk: Buffer) => this.rememberStderr(chunk.toString("utf8")));
    spawnedChild.on("error", (error) => {
      if (this.child === spawnedChild) {
        this.rejectAllPending(error);
      }
    });
    spawnedChild.on("close", (code, signal) => {
      if (this.child !== spawnedChild) {
        return;
      }
      this.rejectAllPending(
        new Error(`FULU BambuNetwork bridge exited (code=${code ?? "null"}, signal=${signal ?? "null"}). ${this.lastStderr}`.trim() +
          (code === 101 ? ` ${STDOUT_SOCKET_HINT}` : ""))
      );
      this.child = undefined;
      this.commandLine = undefined;
      this.agentId = undefined;
      this.agentKey = undefined;
      this.handshake = undefined;
    });
  }

  private handleStdout(chunk: Buffer): void {
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);

    while (this.stdoutBuffer.length >= FRAME_HEADER_SIZE) {
      const magic = this.stdoutBuffer.readUInt32LE(0);
      if (magic !== FRAME_MAGIC) {
        const preview = this.stdoutBuffer.subarray(0, Math.min(this.stdoutBuffer.length, 120)).toString("utf8");
        this.rejectAllPending(new Error(`Invalid FULU BambuNetwork bridge frame magic. Output began with: ${preview}`));
        this.stdoutBuffer = Buffer.alloc(0);
        return;
      }

      const type = this.stdoutBuffer.readUInt32LE(4);
      const id = this.stdoutBuffer.readUInt32LE(8);
      const size = this.stdoutBuffer.readUInt32LE(12);
      if (this.stdoutBuffer.length < FRAME_HEADER_SIZE + size) {
        return;
      }

      const payload = this.stdoutBuffer.subarray(FRAME_HEADER_SIZE, FRAME_HEADER_SIZE + size);
      this.stdoutBuffer = this.stdoutBuffer.subarray(FRAME_HEADER_SIZE + size);

      if (type === FRAME_TYPE_JSON_RESPONSE) {
        this.resolvePendingJson(id, payload);
      } else if (type === FRAME_TYPE_LOG) {
        this.rememberLog(payload.toString("utf8"));
      } else if (type === FRAME_TYPE_BINARY_DATA) {
        this.rememberLog(`received ${payload.length} bytes of bridge binary data for request ${id}`);
      } else {
        this.rememberLog(`ignored bridge frame type ${type} for request ${id}`);
      }
    }
  }

  private resolvePendingJson(id: number, payload: Buffer): void {
    const pending = this.pending.get(id);
    if (!pending) {
      this.rememberLog(`received response for unknown bridge request ${id}`);
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(id);

    try {
      pending.resolve(readFrameJson(payload));
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private rememberLog(message: string): void {
    const trimmed = message.trim();
    if (!trimmed) return;
    this.recentLogs.push(trimmed);
    if (this.recentLogs.length > 25) {
      this.recentLogs = this.recentLogs.slice(-25);
    }
  }

  private rememberStderr(message: string): void {
    const combined = `${this.lastStderr}${message}`;
    this.lastStderr = combined.length > 4000 ? combined.slice(-4000) : combined;
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private needsExpectedVersionRetry(handshake: unknown): handshake is {
    network_actual_abi_version: string;
    network_loaded?: boolean;
    network_status?: string;
  } {
    if (typeof handshake !== "object" || handshake === null) {
      return false;
    }

    const value = handshake as {
      network_actual_abi_version?: unknown;
      network_loaded?: unknown;
      network_status?: unknown;
    };

    return (
      value.network_loaded === false &&
      typeof value.network_actual_abi_version === "string" &&
      value.network_actual_abi_version.length > 0 &&
      typeof value.network_status === "string" &&
      value.network_status.toLowerCase().includes("expected abi version")
    );
  }
}
