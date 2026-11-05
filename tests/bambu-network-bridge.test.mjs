// FULU BambuNetwork bridge, ported from bambu-printer-mcp tests/behavior.test.mjs.
// The bridge runs a real child process: tests/fixtures/fake-fulu-host.mjs, which
// speaks FULU's framed protocol and reproduces what the real v1.0.0 host and
// plug-in did on a P1S. No printer, plug-in or Bambu Cloud is contacted.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { BambuNetworkBridge, LOCAL_PRINT_TIMING } from "../dist/bambu-network-bridge.js";
import { linuxPluginLibraryEnv } from "../dist/fulu-orca.js";
import { BAMBU_NETWORK_CERTIFICATES } from "../dist/bambu-network-certs.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, "..", "dist", "index.js");
// Every server these tests start runs outside the repo (no developer .env) as a Bambu server.
const SERVER_CWD = fs.mkdtempSync(path.join(os.tmpdir(), "fulu-mcp-cwd-"));
process.on("exit", () => fs.rmSync(SERVER_CWD, { recursive: true, force: true }));
const createClient = () => new Client({ name: "bambu-network-bridge-tests", version: "0.0.1" });
async function closeTransport(transport) { try { await transport.close(); } catch { } }
function parseJsonResult(toolResult) {
  const text = toolResult.content?.[0]?.text;
  assert.equal(typeof text, "string", "Expected text result payload");
  return JSON.parse(text);
}
/** A Bambu server over stdio whose BambuImplementation is patched by preload, in its own working directory. */
function bambuServer(preload, env) {
  return new StdioClientTransport({
    command: process.execPath,
    args: ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, SERVER_ENTRY],
    cwd: SERVER_CWD,
    env: { ...process.env, MCP_TRANSPORT: "stdio", PRINTER_TYPE: "bambu", BAMBU_DEFAULT_CONNECTION_MODE: "", BAMBU_DEFAULT_CONNECTION_TYPE: "", ...env },
    stderr: "pipe",
  });
}

const FAKE_FULU_HOST = path.join(__dirname, "fixtures", "fake-fulu-host.mjs");
const FAST_LOCAL_PRINT = Object.freeze({ connectTimeoutMs: 2000, pollMs: 10, settleMs: 20, retryWaitMs: 20 });
const FAST_CONTROL = Object.freeze({ ...FAST_LOCAL_PRINT, certificateWaitMs: 100, attempts: 3, deliveryMs: 50 });
const LOCAL_PRINTER = Object.freeze({ devId: "01PTEST", devIp: "192.0.2.10", username: "bblp", password: "SECRET", useSsl: true });
const shellQuoteArg = value => `'${String(value).replace(/'/g, "'\\''")}'`;

// Every variable the fake bridge touches, restored once per test so several bridges in one test
// cannot restore each other's values out of order.
const FAKE_FULU_ENV = ["FAKE_FULU_WITH_RECORD_RESULT", "FAKE_FULU_START_PRINT_RESULT", "BAMBU_NETWORK_BRIDGE_COMMAND", "BAMBU_NETWORK_CONFIG_DIR", "FAKE_FULU_LOG", "PJARCZAK_BAMBU_PLUGIN_DIR",
  "BAMBU_NETWORK_USER_INFO", "BAMBU_NETWORK_CERT_DIR", "PJARCZAK_BAMBU_NETWORK_SO", "PJARCZAK_BAMBU_SOURCE_SO",
  "FAKE_FULU_EXIT_CODE", "FAKE_FULU_PUBLISH_FAILURES", "FAKE_FULU_UNSUPPORTED", "FAKE_FULU_CONNECT_STATUS", "FAKE_FULU_CONTROL_RESULT",
  "FAKE_FULU_CERT_EVENT", "FAKE_FULU_CERT_DELAY_MS", "FAKE_FULU_REQUIRE_CERT_READY", "FAKE_FULU_CONTROL_FAILURES",
  "FAKE_FULU_REFUSE", "FAKE_FULU_LOGGED_IN", "FAKE_FULU_CLOUD_CERT_ON_INSTALL", "FAKE_FULU_CLOUD_REQUIRE_CERT",
  "BAMBU_NETWORK_BRIDGE_IMAGE", "BAMBU_NETWORK_BRIDGE_DOCKER", "BAMBU_NETWORK_BRIDGE_DOCKER_HOST", "BAMBU_NETWORK_BRIDGE_COLIMA",
  "BAMBU_NETWORK_BRIDGE_COLIMA_PROFILE", "BAMBU_NETWORK_BRIDGE_COLIMA_HOME", "FAKE_DOCKER_DIR", "TMPDIR",
  "FULU_BAMBU_BRIDGE_COMMAND", "FULU_BAMBU_NETWORK_BRIDGE_COMMAND", "PJARCZAK_BAMBU_BRIDGE_COMMAND"];
const fakeFuluEnvSnapshots = new WeakSet();

async function fakeFuluBridge(t, env = {}, { wrapped = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-fulu-"));
  const logPath = path.join(dir, "host.jsonl");
  let command = `${shellQuoteArg(process.execPath)} ${shellQuoteArg(FAKE_FULU_HOST)}`;
  if (wrapped) {
    const wrapper = path.join(dir, "fulu-host-wrapper.sh");
    fs.writeFileSync(wrapper, `#!/bin/sh\n${command} "$@" | cat\n`, { mode: 0o755 });
    command = shellQuoteArg(wrapper);
  }
  if (!fakeFuluEnvSnapshots.has(t)) {
    fakeFuluEnvSnapshots.add(t);
    const saved = Object.fromEntries(FAKE_FULU_ENV.map(name => [name, process.env[name]]));
    t.after(() => { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  }
  const vars = { ...Object.fromEntries(FAKE_FULU_ENV.map(name => [name, undefined])),
    BAMBU_NETWORK_BRIDGE_COMMAND: command, BAMBU_NETWORK_CONFIG_DIR: path.join(dir, "config"), FAKE_FULU_LOG: logPath, PJARCZAK_BAMBU_PLUGIN_DIR: path.join(dir, "plugins"), ...env };
  for (const [name, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  const bridge = new BambuNetworkBridge();
  t.after(async () => {
    await bridge.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const calls = () => fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  return { bridge, dir, calls, methods: () => calls().filter(entry => entry.method).map(entry => entry.method) };
}

const controlSends = (calls, command = "stop") => calls().filter(c => c.method === "net.send_message_to_printer" && JSON.parse(c.payload.msg).print?.command === command);


// A stand-in for `docker` (and `colima`): logs its arguments, answers `info` once Colima has started,
// and runs the fake host for `run`, with the container's -e settings and only after every -v folder exists.
function fakeContainerTools(dir) {
  const docker = path.join(dir, "docker"), colima = path.join(dir, "colima");
  fs.writeFileSync(docker, `#!${process.execPath}
// CommonJS: an extensionless script is CommonJS on Node 18.
const fs = require("node:fs"), path = require("node:path"), { spawn } = require("node:child_process");
const dir = process.env.FAKE_DOCKER_DIR, args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "docker.jsonl"), JSON.stringify(args) + "\\n");
const at = args[0] === "--host" ? 2 : 0;
if (args[at] === "info") process.exit(fs.existsSync(path.join(dir, "up")) ? 0 : 1);
if (args[at] === "rm" || args[at] === "stop") process.exit(0);
const env = { ...process.env };
for (let i = at; i < args.length; i++) {
  if (args[i] === "-v" && !fs.existsSync(args[i + 1].split(":")[0])) process.exit(125);
  if (args[i] === "-e") { const [name, ...value] = args[i + 1].split("="); env[name] = value.length ? value.join("=") : process.env[name]; }
}
const child = spawn(process.execPath, [${JSON.stringify(FAKE_FULU_HOST)}], { env, stdio: "inherit" });
child.on("exit", code => process.exit(code ?? 1));
`, { mode: 0o755 });
  fs.writeFileSync(colima, `#!/bin/sh\nprintf '%s|%s\\n' "$COLIMA_HOME" "$*" >> "$FAKE_DOCKER_DIR/colima.log"\ntouch "$FAKE_DOCKER_DIR/up"\n`, { mode: 0o755 });
  return { docker, colima };
}

test("the FULU host runs in its Docker image, mounting this server's own config folder, where print snapshots go", async t => {
  const tools = fs.mkdtempSync(path.join(os.tmpdir(), "fake-docker-"));
  t.after(() => fs.rmSync(tools, { recursive: true, force: true }));
  const { docker, colima } = fakeContainerTools(tools);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "fulu-container-"));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  // The VM shares neither /tmp nor /var/folders, so the server's TMPDIR is never mounted.
  const tmp = path.join(work, "tmp"), config = path.join(work, "home", ".config", "mcp-3d-printer-server", "bambu-network");
  fs.mkdirSync(tmp);
  const { bridge, methods, calls } = await fakeFuluBridge(t, {
    BAMBU_NETWORK_BRIDGE_COMMAND: undefined, PJARCZAK_BAMBU_PLUGIN_DIR: undefined, BAMBU_NETWORK_CONFIG_DIR: config, TMPDIR: tmp,
    BAMBU_NETWORK_BRIDGE_IMAGE: "bpm-fulu-e2e:runtime", BAMBU_NETWORK_BRIDGE_DOCKER: docker, BAMBU_NETWORK_BRIDGE_DOCKER_HOST: "unix:///colima/bambu-fulu/docker.sock",
    BAMBU_NETWORK_BRIDGE_COLIMA: colima, BAMBU_NETWORK_BRIDGE_COLIMA_PROFILE: "bambu-fulu", BAMBU_NETWORK_BRIDGE_COLIMA_HOME: "/Volumes/Spillover/colima", FAKE_DOCKER_DIR: tools,
  });

  const status = bridge.getStatus();
  assert.equal(status.configured, true);
  assert.match(status.command, /^'[^']*docker' '--host' 'unix:\/\/\/colima\/bambu-fulu\/docker.sock' 'run'/);

  await bridge.ensureAgent();
  assert.ok(methods().includes("net.create_agent"));
  assert.equal(calls().find(c => c.method === "net.create_agent").payload.log_dir, config, "the host writes to the folder the server mounted");
  // Docker didn't answer, so the profile was started once, in its own COLIMA_HOME, without taking over Docker's context.
  assert.deepEqual(fs.readFileSync(path.join(tools, "colima.log"), "utf8").trim().split("\n"), ["/Volumes/Spillover/colima|start --profile bambu-fulu --activate=false"]);
  const runs = fs.readFileSync(path.join(tools, "docker.jsonl"), "utf8").trim().split("\n").map(JSON.parse).filter(args => args.includes("run"));
  assert.equal(runs.length, 1);
  const run = runs[0];
  const mounts = run.flatMap((arg, i) => arg === "-v" ? [run[i + 1]] : []);
  // The real folder, mounted at the path the host is told about (on macOS, /var is a link to /private/var).
  assert.deepEqual(mounts, [`${fs.realpathSync(config)}:${config}:rw`],
    "this server's config folder (mcp-3d-printer-server's own, here), which holds the print snapshots too");
  const { bridgeSnapshotRoot } = await import("../dist/bambu-network-bridge.js");
  assert.equal(bridgeSnapshotRoot(), path.join(config, "print-snapshots"), "print snapshots go where the host can read them");
  assert.ok(fs.statSync(path.join(config, "print-snapshots")).isDirectory());
  for (const value of ["PJARCZAK_BAMBU_PLUGIN_DIR=/plugins", "PJARCZAK_BAMBU_NETWORK_SO=/plugins/libbambu_networking.so", "SSL_CERT_FILE=/fulu/ca-certificates.crt",
    "PJARCZAK_BAMBU_COUNTRY_CODE", "PJARCZAK_EXPECTED_BAMBU_NETWORK_VERSION"]) {
    assert.ok(run.some((arg, i) => arg === "-e" && run[i + 1] === value), value);
  }
  assert.deepEqual(run.slice(-4), ["bpm-fulu-e2e:runtime", "/bin/sh", "-c", "/fulu/pjarczak_bambu_linux_host | cat"]);
  assert.deepEqual(run.slice(0, 3), ["--host", "unix:///colima/bambu-fulu/docker.sock", "run"]);
  // An init process forwards stop's SIGTERM to the host, and stop removes the container by its own name.
  assert.ok(run.includes("--init"));
  const name = run[run.indexOf("--name") + 1];
  assert.match(name, /^bambu-fulu-host-\d+-[0-9a-f]{8}$/);
  await bridge.stop();
  const removed = fs.readFileSync(path.join(tools, "docker.jsonl"), "utf8").trim().split("\n").map(JSON.parse).filter(args => args.includes("rm"));
  // Once before run (a container a dropped client left under this name), once on stop.
  assert.deepEqual(removed, [["--host", "unix:///colima/bambu-fulu/docker.sock", "rm", "-f", name], ["--host", "unix:///colima/bambu-fulu/docker.sock", "rm", "-f", name]]);
  const stopped = fs.readFileSync(path.join(tools, "docker.jsonl"), "utf8").trim().split("\n").map(JSON.parse).filter(args => args.includes("stop"));
  assert.equal(stopped.length, 2, "each removal stops the host first, with time to exit");
});

test("the FULU container mounts a symlinked config folder at the path the host is given, uses the Colima profile's socket, and clears stale snapshots", async t => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "fulu-container-paths-"));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const real = path.join(work, "real-config"), linked = path.join(work, "linked-config");
  fs.mkdirSync(real);
  fs.symlinkSync(real, linked);
  const { bridgeContainer, bridgeContainerMounts, bridgeContainerArgs, bridgeSnapshotRoot } = await import("../dist/bambu-network-bridge.js");
  const env = { BAMBU_NETWORK_BRIDGE_IMAGE: "fulu:runtime", BAMBU_NETWORK_CONFIG_DIR: linked, BAMBU_NETWORK_BRIDGE_COLIMA_PROFILE: "fulu", BAMBU_NETWORK_BRIDGE_COLIMA_HOME: "/colima-home" };
  // A profile started with --activate=false doesn't become Docker's default, so its own socket is used.
  const container = bridgeContainer(env);
  assert.equal(container.dockerHost, "unix:///colima-home/fulu/docker.sock");
  assert.equal(bridgeContainer({ ...env, BAMBU_NETWORK_BRIDGE_DOCKER_HOST: "tcp://elsewhere:2375" }).dockerHost, "tcp://elsewhere:2375", "an explicit host wins");
  assert.equal(bridgeContainer({ BAMBU_NETWORK_BRIDGE_IMAGE: "fulu:runtime" }).dockerHost, undefined, "no profile, no host: Docker's own default");
  // A snapshot a killed server left more than a day ago is removed; a recent one (an upload in flight) stays.
  const snapshots = path.join(real, "print-snapshots");
  fs.mkdirSync(path.join(snapshots, "bambu-print-old"), { recursive: true });
  fs.mkdirSync(path.join(snapshots, "bambu-print-new"));
  const dayAgo = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(path.join(snapshots, "bambu-print-old"), dayAgo, dayAgo);
  // The host is told the linked path (log_dir, snapshots), so the real folder is mounted there.
  const mounts = bridgeContainerMounts(linked, env);
  assert.deepEqual(mounts, [`${fs.realpathSync(real)}:${linked}`]);
  const args = bridgeContainerArgs(container, mounts, "bambu-fulu-host-test");
  assert.ok(args.some((arg, i) => args[i - 1] === "-v" && arg === `${fs.realpathSync(real)}:${linked}:rw`));
  assert.equal(bridgeSnapshotRoot(env), path.join(linked, "print-snapshots"));
  assert.deepEqual(fs.readdirSync(snapshots), ["bambu-print-new"], "the first look at the folder cleared it");
});

test("concurrent calls on a cold Docker-backed bridge start one container", async t => {
  const tools = fs.mkdtempSync(path.join(os.tmpdir(), "fake-docker-"));
  t.after(() => fs.rmSync(tools, { recursive: true, force: true }));
  const { docker } = fakeContainerTools(tools);
  fs.writeFileSync(path.join(tools, "up"), "");
  const { bridge, methods } = await fakeFuluBridge(t, { BAMBU_NETWORK_BRIDGE_COMMAND: undefined, PJARCZAK_BAMBU_PLUGIN_DIR: undefined,
    BAMBU_NETWORK_BRIDGE_IMAGE: "bpm-fulu-e2e:runtime", BAMBU_NETWORK_BRIDGE_DOCKER: docker, FAKE_DOCKER_DIR: tools });
  // A status probe and a print reaching the bridge at once: each would otherwise remove the other's container.
  await Promise.all([bridge.ensureAgent(), bridge.ensureAgent(), bridge.ensureAgent()]);
  const logged = fs.readFileSync(path.join(tools, "docker.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(logged.filter(args => args.includes("run")).length, 1, "one container");
  assert.equal(logged.filter(args => args.includes("rm")).length, 1, "removed once, before it started, never while it ran");
  assert.equal(logged.filter(args => args.includes("stop")).length, 1);
  assert.ok(methods().includes("net.create_agent"));
});

test("stop returns even when a descendant of the bridge's shell keeps its pipes open", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fulu-stop-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // A descendant of the shell (as a docker client can be) keeps the bridge's stdout and stderr open after the host
  // has gone, so the shell's "close" never comes. Before, stop waited for it for ever.
  const pidFile = path.join(dir, "holder.pid");
  const { bridge } = await fakeFuluBridge(t, { BAMBU_NETWORK_BRIDGE_COMMAND: `sleep 30 < /dev/null & echo $! > ${shellQuoteArg(pidFile)}; ${shellQuoteArg(process.execPath)} ${shellQuoteArg(FAKE_FULU_HOST)}` });
  await bridge.ensureAgent();
  const holder = Number(fs.readFileSync(pidFile, "utf8"));
  t.after(() => { try { process.kill(holder, "SIGKILL"); } catch { /* gone */ } });
  const started = Date.now();
  await bridge.stop();
  assert.ok(Date.now() - started < 8000, `stop is bounded (${Date.now() - started} ms)`);
  assert.doesNotThrow(() => process.kill(holder, 0), "the pipes were still held, so close never came");
  // A bridge started afterwards works: nothing from the old one reaches it.
  await bridge.ensureAgent();
});

test("a relative config folder reaches the containerized host as the absolute path that was mounted", async t => {
  const tools = fs.mkdtempSync(path.join(os.tmpdir(), "fake-docker-"));
  t.after(() => fs.rmSync(tools, { recursive: true, force: true }));
  const { docker } = fakeContainerTools(tools);
  fs.writeFileSync(path.join(tools, "up"), "");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "fulu-relative-"));
  const previous = process.cwd();
  process.chdir(work);
  t.after(() => { process.chdir(previous); fs.rmSync(work, { recursive: true, force: true }); });
  const { bridge, calls } = await fakeFuluBridge(t, { BAMBU_NETWORK_BRIDGE_COMMAND: undefined, PJARCZAK_BAMBU_PLUGIN_DIR: undefined,
    BAMBU_NETWORK_CONFIG_DIR: "relative-config", BAMBU_NETWORK_CERT_DIR: "relative-certs",
    BAMBU_NETWORK_BRIDGE_IMAGE: "bpm-fulu-e2e:runtime", BAMBU_NETWORK_BRIDGE_DOCKER: docker, FAKE_DOCKER_DIR: tools });
  await bridge.ensureAgent();
  const config = path.join(fs.realpathSync(work), "relative-config");
  const agent = calls().find(c => c.method === "net.create_agent").payload;
  assert.equal(path.isAbsolute(agent.log_dir), true, agent.log_dir);
  assert.equal(fs.realpathSync(agent.log_dir), config, "the folder the host is told about is the one mounted");
  const run = fs.readFileSync(path.join(tools, "docker.jsonl"), "utf8").trim().split("\n").map(JSON.parse).find(args => args.includes("run"));
  const mounts = run.flatMap((arg, i) => arg === "-v" ? [run[i + 1].split(":")[1]] : []);
  assert.ok(mounts.includes(agent.log_dir), `${agent.log_dir} is mounted: ${mounts}`);
  const certs = calls().find(c => c.method === "net.set_cert_file")?.payload.folder;
  if (certs) assert.ok(path.isAbsolute(certs) && mounts.some(dir => certs === dir || certs.startsWith(dir + path.sep)), certs);
});

test("the FULU container says plainly when Docker isn't running and no Colima profile is set", async t => {
  const tools = fs.mkdtempSync(path.join(os.tmpdir(), "fake-docker-"));
  t.after(() => fs.rmSync(tools, { recursive: true, force: true }));
  const { docker } = fakeContainerTools(tools);
  const { bridge } = await fakeFuluBridge(t, { BAMBU_NETWORK_BRIDGE_COMMAND: undefined, BAMBU_NETWORK_BRIDGE_IMAGE: "bpm-fulu-e2e:runtime",
    BAMBU_NETWORK_BRIDGE_DOCKER: docker, FAKE_DOCKER_DIR: tools });
  await assert.rejects(bridge.ensureAgent(), /Docker didn't answer .* Start Docker, or set BAMBU_NETWORK_BRIDGE_COLIMA_PROFILE/);
  const logged = fs.readFileSync(path.join(tools, "docker.jsonl"), "utf8");
  assert.doesNotMatch(logged, /"run"/, "nothing ran");
  assert.equal(fs.existsSync(path.join(tools, "colima.log")), false);
});

test("an explicit bridge command still wins over the Docker image", async t => {
  const { bridge } = await fakeFuluBridge(t, { BAMBU_NETWORK_BRIDGE_IMAGE: "bpm-fulu-e2e:runtime", BAMBU_NETWORK_BRIDGE_DOCKER: "/nonexistent/docker" });
  assert.doesNotMatch(bridge.getStatus().command, /docker/);
  const { bridgeSnapshotRoot } = await import("../dist/bambu-network-bridge.js");
  assert.equal(bridgeSnapshotRoot(), undefined, "a native host reads snapshots from the system temporary folder");
  await bridge.ensureAgent();
});

// P1S 01.10, Nov 3: valid RSA signatures with IDs outside Studio's 20000–29999
// window receive 0502400A. Numeric IDs fail too. Exercise the actual LAN/cloud sends.
test("FULU controls keep unique string IDs in the Studio window, including wrap and retry", async t => {
  const {bridge, calls} = await fakeFuluBridge(t, {FAKE_FULU_CONTROL_FAILURES: "1", FAKE_FULU_LOGGED_IN: "1"});
  for (const command of ["pause", "resume", "stop"]) {
    assert.equal((await bridge.sendLocalPrintCommand(LOCAL_PRINTER, command, {}, undefined, FAST_CONTROL)).confirmed, true);
    assert.equal((await bridge.sendCloudPrintCommand("01PTEST", command, {}, undefined, FAST_CONTROL)).confirmed, true);
  }
  const ids = calls().filter(c => ["net.send_message", "net.send_message_to_printer"].includes(c.method))
    .map(c => JSON.parse(c.payload.msg).print?.sequence_id).filter(v => v !== undefined);
  assert.equal(new Set(ids).size, ids.length, "every send, including retries, has a fresh ID");
  for (const id of ids) assert.match(id, /^2[0-9]{4}$/);

  // Skip transport/session time to drive the real dispatch through a full counter wrap.
  const wrapping = new BambuNetworkBridge();
  let messages = [], sent = [];
  wrapping.withLocalSession = async (_p, _o, _a, _t, body) => {
    messages = [];
    return body({certificateReadyWithin: async () => true, settle: async () => {}, controlMessages: messages});
  };
  wrapping.callWithAgent = async (_method, payload) => {
    const print = JSON.parse(payload.msg).print;
    sent.push(print.sequence_id);
    messages.push(JSON.stringify({print: {...print, result: "success"}}));
    return {ok: true, value: 0};
  };
  for (let i = 0; i < 10001; i++) {
    assert.equal((await wrapping.sendLocalPrintCommand(LOCAL_PRINTER, "pause", {trace: () => {}}, undefined, FAST_CONTROL)).confirmed, true);
  }
  for (const id of sent) assert.match(id, /^2[0-9]{4}$/);
  assert.equal(new Set(sent.slice(0, 10000)).size, 10000);
  assert.equal(sent[0], sent[10000], "wrap stays inside the accepted window");
});

test("an accepted control keeps the connection open while it reaches the printer, then disconnects", async t => {
  const {bridge, calls} = await fakeFuluBridge(t, {});
  await bridge.sendLocalPrintCommand(LOCAL_PRINTER, "stop", {}, undefined, {...FAST_CONTROL, deliveryMs: 200});
  const recorded = calls(), sent = recorded.findIndex(c => c.method === "net.send_message_to_printer" && JSON.parse(c.payload.msg).print?.command === "stop");
  const disconnect = recorded.findIndex(c => c.method === "net.disconnect_printer");
  assert.ok(sent >= 0 && disconnect > sent);
  assert.ok(recorded.slice(sent + 1, disconnect).filter(c => c.method === "bridge.poll_events").length >= 2, "still connected and reading the printer before disconnecting");
});

test("FULU Stop sends once when this printer's certificate is reported ready", async t => {
  const {bridge, calls} = await fakeFuluBridge(t, {FAKE_FULU_REQUIRE_CERT_READY: "1", FAKE_FULU_CERT_DELAY_MS: "30"});
  const result = await bridge.sendLocalPrintCommand(LOCAL_PRINTER, "stop", {}, undefined, FAST_CONTROL);
  assert.equal(result.attempts, 1);
  assert.equal(controlSends(calls).length, 1);
});

// Nov 3 on the real P1S: FULU never sent device_cert_installed for a control session, and the
// previous wait refused to send at all. FULU's own app just sends; a bridge that never says ready still gets one try.
for (const event of ["missing", "other-printer"]) test(`FULU Stop still sends when no certificate message arrives (${event})`, async t => {
  const {bridge, calls} = await fakeFuluBridge(t, {FAKE_FULU_CERT_EVENT: event});
  const result = await bridge.sendLocalPrintCommand(LOCAL_PRINTER, "stop", {}, undefined, FAST_CONTROL);
  assert.equal(result.status, "success");
  assert.equal(controlSends(calls).length, 1);
});

test("a control refused with SEND_MSG_FAILED is retried only after the certificate is reinstalled", async t => {
  const {bridge, calls} = await fakeFuluBridge(t, {FAKE_FULU_CONTROL_FAILURES: "1"});
  const result = await bridge.sendLocalPrintCommand(LOCAL_PRINTER, "pause", {}, undefined, FAST_CONTROL);
  assert.equal(result.attempts, 2);
  const recorded = calls();
  const sends = recorded.map((c, i) => [c, i]).filter(([c]) => c.method === "net.send_message_to_printer" && JSON.parse(c.payload.msg).print?.command === "pause").map(([, i]) => i);
  assert.equal(sends.length, 2);
  assert.ok(recorded.slice(sends[0], sends[1]).some(c => c.method === "net.install_device_cert"), "reinstalled between the two sends");
});

test("a control that keeps failing stops after three tries with the plug-in code", async t => {
  const {bridge, calls} = await fakeFuluBridge(t, {FAKE_FULU_CONTROL_FAILURES: "9"});
  await assert.rejects(bridge.sendLocalPrintCommand(LOCAL_PRINTER, "stop", {}, undefined, FAST_CONTROL), /did not accept stop .*plug-in code -4/);
  assert.equal(controlSends(calls).length, 3);
});

test("any other plug-in return is final: the control is never replayed", async t => {
  const {bridge, calls} = await fakeFuluBridge(t, {FAKE_FULU_CONTROL_RESULT: "-1"});
  await assert.rejects(bridge.sendLocalPrintCommand(LOCAL_PRINTER, "stop", {}, undefined, FAST_CONTROL), /plug-in code -1/);
  assert.equal(controlSends(calls).length, 1);
});

// Nov 3, the real P1S (cloud-bound, Developer Mode off): every LAN Stop/Pause got a signed reply
// with err_code 84033546 and Counterpart still said "Stop sent." The refusal must reach the caller.
test("a refused control reports verification failure without claiming third-party controls are impossible", async t => {
  const {bridge} = await fakeFuluBridge(t, {FAKE_FULU_REFUSE: "84033546"});
  await assert.rejects(bridge.sendLocalPrintCommand(LOCAL_PRINTER, "stop", {}, undefined, FAST_CONTROL),
    /refused Stop \(error 0502400A\): .*command verification failed/);
});

test("any other refusal keeps the printer's own error code", async t => {
  const {bridge} = await fakeFuluBridge(t, {FAKE_FULU_REFUSE: "50348044"});
  await assert.rejects(bridge.sendLocalPrintCommand(LOCAL_PRINTER, "stop", {}, undefined, FAST_CONTROL), /refused Stop over the local network \(error 0300400C\)\. Nothing changed/);
});

test("a control the printer answers is reported as accepted, sent with flag 0", async t => {
  const {bridge, calls} = await fakeFuluBridge(t, {});
  const result = await bridge.sendLocalPrintCommand(LOCAL_PRINTER, "pause", {}, undefined, FAST_CONTROL);
  assert.equal(result.confirmed, true);
  assert.match(result.message, /accepted Pause/);
  assert.equal(controlSends(calls, "pause")[0].payload.flag, 0);
});

test("a cloud control is sent the way Bambu Studio sends it to a cloud-bound printer, held open for the answer", async t => {
  const {bridge, calls} = await fakeFuluBridge(t, {FAKE_FULU_LOGGED_IN: "1"});
  const result = await bridge.sendCloudPrintCommand("01PTEST", "stop", {}, undefined, FAST_CONTROL);
  assert.equal(result.confirmed, true);
  const recorded = calls().filter(c => c.method);
  const send = recorded.findIndex(c => c.method === "net.send_message" && JSON.parse(c.payload.msg).print?.command === "stop");
  const before = method => recorded.findIndex(c => c.method === method);
  assert.ok(before("net.set_user_selected_machine") < send && before("net.add_subscribe") < send);
  assert.ok(recorded.findIndex(c => c.method === "net.install_device_cert" && c.payload.lan_only === false) < send, "cloud certificate before the control");
  assert.ok(recorded.findIndex(c => c.method === "net.send_message" && JSON.parse(c.payload.msg).pushing?.command === "pushall") < send, "printer state requested first");
  const sent = recorded[send].payload;
  assert.deepEqual([sent.dev_id, sent.qos, sent.flag], ["01PTEST", 1, 0]);
  assert.equal(recorded.some(c => c.method === "net.connect_printer"), false, "no LAN session for a cloud control");
});

// Nov 3, the real P1S: net.start_print returned -3140 (ENC_FLAG_NOT_READY) when called with no cloud session.
test("a cloud print starts only after the printer's cloud session and certificate, as Bambu Studio does", async t => {
  const {bridge, calls} = await fakeFuluBridge(t, {FAKE_FULU_LOGGED_IN: "1"});
  await bridge.startCloudPrint("01PTEST", "net.start_print", {client_job_id: 7, params: {dev_id: "01PTEST"}}, {}, () => {}, {connectTimeoutMs: 2000, pollMs: 10, settleMs: 20, certificateWaitMs: 500});
  const recorded = calls().filter(c => c.method);
  const print = recorded.findIndex(c => c.method === "net.start_print");
  assert.ok(print > recorded.findIndex(c => c.method === "net.install_device_cert" && c.payload.lan_only === false));
  assert.ok(recorded.slice(0, print).some(c => c.method === "bridge.poll_events"));
});

// Nov 4: net.start_print on the real P1S always returned -3120 (HTTP 403 "internal blocking"). Bambu Studio
// sends a cloud-bound printer it can reach on the LAN with record first (PrintJob.cpp), then start_print.
const FAST_CLOUD = {connectTimeoutMs: 2000, pollMs: 10, settleMs: 20, certificateWaitMs: 500};
const cloudJob = {client_job_id: 7, params: {dev_id: "01PTEST", comments: ""}};
test("a cloud print goes with record first and stops there when it works, as Bambu Studio does", async t => {
  const {bridge, calls} = await fakeFuluBridge(t, {FAKE_FULU_LOGGED_IN: "1"});
  const sent = await bridge.startCloudPrint("01PTEST", "net.start_local_print_with_record", cloudJob, {}, () => {}, FAST_CLOUD, "net.start_print");
  assert.equal(sent.result.value, 0);
  assert.equal(sent.firstFailure, undefined);
  const recorded = calls().filter(c => c.method);
  assert.ok(recorded.findIndex(c => c.method === "net.start_local_print_with_record") > recorded.findIndex(c => c.method === "net.install_device_cert" && c.payload.lan_only === false));
  assert.equal(recorded.some(c => c.method === "net.start_print"), false);
  assert.equal(recorded.some(c => c.method === "net.connect_printer"), false, "sent in the cloud session, not a LAN session");
});

test("a cloud print whose recorded send fails is sent once through the cloud, marked as Studio marks it", async t => {
  const {bridge, calls} = await fakeFuluBridge(t, {FAKE_FULU_LOGGED_IN: "1", FAKE_FULU_WITH_RECORD_RESULT: "-2120"});
  const checked = [];
  const sent = await bridge.startCloudPrint("01PTEST", "net.start_local_print_with_record", cloudJob,
    {beforeDispatch: async method => { checked.push(method); }}, () => {}, FAST_CLOUD, "net.start_print");
  assert.equal(sent.firstFailure, -2120);
  assert.equal(sent.result.value, 0);
  const prints = calls().filter(c => c.method === "net.start_print");
  assert.equal(prints.length, 1);
  assert.equal(prints[0].payload.params.comments, "failed(-2120)");
  assert.deepEqual(checked.filter(m => m.includes("start_")), ["net.start_local_print_with_record", "net.start_print"], "the printer is checked again before the second send");
});

test("a cloud print sends no second job after a failure that may have reached the printer, or one Studio stops on", async t => {
  for (const failure of ["-26", "-4030", "-1", "-2100", "-2040"]) {
    const {bridge, calls} = await fakeFuluBridge(t, {FAKE_FULU_LOGGED_IN: "1", FAKE_FULU_WITH_RECORD_RESULT: failure});
    const sent = await bridge.startCloudPrint("01PTEST", "net.start_local_print_with_record", cloudJob, {}, () => {}, FAST_CLOUD, "net.start_print");
    assert.equal(sent.result.value, Number(failure));
    assert.equal(calls().some(c => c.method === "net.start_print"), false, `no second job after ${failure}`);
    await bridge.stop();
  }
});

test("a cloud print sends nothing when the plug-in is not signed in", async t => {
  const {bridge, calls} = await fakeFuluBridge(t, {});
  await assert.rejects(bridge.startCloudPrint("01PTEST", "net.start_print", {client_job_id: 7, params: {}}, {}, () => {}), /not signed in to Bambu Cloud/);
  assert.equal(calls().some(c => c.method === "net.start_print"), false);
});

test("a cloud control refused by the printer fails with its error code", async t => {
  const {bridge} = await fakeFuluBridge(t, {FAKE_FULU_LOGGED_IN: "1", FAKE_FULU_REFUSE: "84033546"});
  await assert.rejects(bridge.sendCloudPrintCommand("01PTEST", "pause", {}, undefined, FAST_CONTROL), /refused Pause \(error 0502400A\): .*command verification failed/);
});

// Nov 3, the real P1S over Bambu Cloud: pause returned -2 while the certificate was still installing;
// the second send after device_cert_installed was accepted.
test("a cloud control sent before the certificate is installed is sent again once it is", async t => {
  const {bridge, calls} = await fakeFuluBridge(t, {FAKE_FULU_LOGGED_IN: "1", FAKE_FULU_CLOUD_REQUIRE_CERT: "1", FAKE_FULU_CLOUD_CERT_ON_INSTALL: "2"});
  const result = await bridge.sendCloudPrintCommand("01PTEST", "pause", {}, undefined, FAST_CONTROL);
  assert.equal(result.attempts, 2);
  assert.equal(result.confirmed, true);
  const recorded = calls().filter(c => c.method);
  const sends = recorded.filter(c => c.method === "net.send_message" && JSON.parse(c.payload.msg).print?.command === "pause");
  assert.equal(sends.length, 2);
  assert.equal(recorded.filter(c => c.method === "net.install_device_cert").length, 2, "the certificate is installed again before the second send");
});

test("a cloud control is not resent after a final plug-in error", async t => {
  const {bridge, calls} = await fakeFuluBridge(t, {FAKE_FULU_LOGGED_IN: "1", FAKE_FULU_CLOUD_REQUIRE_CERT: "1", FAKE_FULU_CLOUD_CERT_ON_INSTALL: "99"});
  await assert.rejects(bridge.sendCloudPrintCommand("01PTEST", "stop", {}, undefined, FAST_CONTROL), /Bambu Cloud did not accept stop .*plug-in code -2/);
  assert.equal(calls().filter(c => c.method === "net.send_message" && JSON.parse(c.payload.msg).print?.command === "stop").length, FAST_CONTROL.attempts);
});

test("control diagnostics go to control-trace.log without the access code", async t => {
  const {bridge, dir} = await fakeFuluBridge(t, {});
  await bridge.sendLocalPrintCommand(LOCAL_PRINTER, "stop", {}, undefined, FAST_CONTROL);
  const trace = fs.readFileSync(path.join(dir, "config", "control-trace.log"), "utf8");
  assert.match(trace, /"step":"send","command":"stop","attempt":1,"code":0/);
  assert.match(trace, /"step":"certificate"/);
  assert.doesNotMatch(trace, new RegExp(LOCAL_PRINTER.password));
});

for (const [connection, stopResult] of [["0", "0"], ["1", "0"], ["0", "-4030"], ["0", "-4"]]) {
  test(`cancel_print uses the configured authenticated FULU session (connection ${connection}, stop ${stopResult})`, async t => {
    const { calls } = await fakeFuluBridge(t, { FAKE_FULU_CONNECT_STATUS: connection, FAKE_FULU_CONTROL_RESULT: stopResult });
    const module = new URL("../dist/printers/bambu.js", import.meta.url).href;
    const preload = `import { BambuImplementation } from ${JSON.stringify(module)}; BambuImplementation.prototype.getPrinter = async () => { throw new Error("Legacy MQTT must not be used"); };`;
    const transport = bambuServer(preload, {PRINTER_HOST: "127.0.0.1", BAMBU_SERIAL: "01PTEST", BAMBU_TOKEN: "DUMMY", BAMBU_MODEL: "p1s" });
    t.after(async () => { await closeTransport(transport); });
    const client = createClient();
    await client.connect(transport);
    const result = await client.callTool({ name: "cancel_print", arguments: { connection_mode: "bambu_network", connection_type: "lan" } });
    const recorded = calls();
    const commands = recorded.filter(c => c.method === "net.send_message_to_printer" && JSON.parse(c.payload.msg).print?.command === "stop");
    if (connection === "0" && stopResult === "0") {
      assert.notEqual(result.isError, true, JSON.stringify(result));
      assert.equal(commands.length, 1);
      assert.equal(commands[0].payload.qos, 1);
      assert.equal(commands[0].payload.dev_id, "01PTEST");
      assert.equal(commands[0].payload.flag, 0);
      assert.equal(JSON.parse(commands[0].payload.msg).print.param, "");
      assert.ok(recorded.findIndex(c => c.method === "net.install_device_cert") < recorded.indexOf(commands[0]));
    } else {
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result), connection === "1" ? /LAN connection/ : /did not accept stop over the authenticated FULU LAN connection/);
      // -4 and -4030 mean the plug-in sent nothing: retried after a certificate reinstall, three tries in all.
      assert.equal(commands.length, connection === "1" ? 0 : 3);
    }
  });
}

// The bug this guards: print_3mf honoured BAMBU_DEFAULT_CONNECTION_MODE while
// every control ignored it, so a FULU-authenticated print got plain-MQTT Stop
// and Pause that the printer rejected (HMS 0500_0500_0001_0007).
for (const [tool, command] of [["cancel_print", "stop"], ["pause_print", "pause"]]) {
  test(`${tool} follows the server's configured print route with no route arguments`, async t => {
    const { calls } = await fakeFuluBridge(t);
    const module = new URL("../dist/printers/bambu.js", import.meta.url).href;
    const preload = `import { BambuImplementation } from ${JSON.stringify(module)}; BambuImplementation.prototype.getPrinter = async () => { throw new Error("Legacy MQTT must not be used"); };`;
    const transport = bambuServer(preload, {PRINTER_HOST: "127.0.0.1", BAMBU_SERIAL: "01PTEST", BAMBU_TOKEN: "DUMMY", BAMBU_MODEL: "p1s",
        BAMBU_DEFAULT_CONNECTION_MODE: "bambu_network", BAMBU_DEFAULT_CONNECTION_TYPE: "lan"});
    t.after(async () => { await closeTransport(transport); });
    const client = createClient(); await client.connect(transport);
    const result = await client.callTool({name: tool, arguments: {}});
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const sent = calls().filter(c => c.method === "net.send_message_to_printer" && JSON.parse(c.payload.msg).print?.command === command);
    assert.equal(sent.length, 1, "one authenticated control, never replayed");
  });
}

test("a configured FULU cloud route sends nothing when the plug-in is not signed in, and never plain MQTT", async t => {
  const { calls } = await fakeFuluBridge(t);
  const module = new URL("../dist/printers/bambu.js", import.meta.url).href;
  const preload = `import { BambuImplementation } from ${JSON.stringify(module)}; BambuImplementation.prototype.getPrinter = async () => { throw new Error("Legacy MQTT must not be used"); };`;
  const transport = bambuServer(preload, {PRINTER_HOST: "127.0.0.1", BAMBU_SERIAL: "01PTEST", BAMBU_TOKEN: "DUMMY", BAMBU_MODEL: "p1s",
      BAMBU_DEFAULT_CONNECTION_MODE: "bambu_network"});
  t.after(async () => { await closeTransport(transport); });
  const client = createClient(); await client.connect(transport);
  for (const tool of ["cancel_print", "pause_print"]) {
    const result = await client.callTool({name: tool, arguments: {}});
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /not signed in to Bambu Cloud/);
    assert.doesNotMatch(JSON.stringify(result), /Legacy MQTT/);
  }
  assert.equal(calls().filter(c => c.method === "net.send_message_to_printer" || c.method === "net.send_message").length, 0);
});

test("an optional FULU install does not change default or explicitly direct Stop", async t => {
  const { calls } = await fakeFuluBridge(t);
  const module = new URL("../dist/printers/bambu.js", import.meta.url).href;
  const preload = `import { BambuImplementation } from ${JSON.stringify(module)}; BambuImplementation.prototype.cancelJob = async (_h, _s, _t, dispatch) => dispatch ? dispatch() : {status: "success", route: "direct"};`;
  const transport = bambuServer(preload, {PRINTER_HOST: "127.0.0.1", BAMBU_SERIAL: "01PTEST", BAMBU_TOKEN: "DUMMY", BAMBU_MODEL: "p1s"});
  t.after(async () => { await closeTransport(transport); });
  const client = createClient(); await client.connect(transport);
  for (const args of [{}, {connection_mode: "lan_mqtt_ftps"}]) {
    const result = parseJsonResult(await client.callTool({name: "cancel_print", arguments: args}));
    assert.equal(result.route, "direct");
  }
  assert.equal(calls().length, 0);
});

test("FULU host plug-in library paths are named in PJARCZAK_BAMBU_PLUGIN_DIR on Linux only", () => {
  assert.deepEqual(linuxPluginLibraryEnv({ PJARCZAK_BAMBU_PLUGIN_DIR: "/opt/fulu/plugins" }, "linux"), {
    PJARCZAK_BAMBU_NETWORK_SO: path.resolve("/opt/fulu/plugins", "libbambu_networking.so"),
    PJARCZAK_BAMBU_SOURCE_SO: path.resolve("/opt/fulu/plugins", "libBambuSource.so"),
  });
  assert.deepEqual(linuxPluginLibraryEnv({ PJARCZAK_BAMBU_PLUGIN_DIR: "plugins" }, "linux").PJARCZAK_BAMBU_NETWORK_SO, path.resolve("plugins", "libbambu_networking.so"));
  assert.deepEqual(linuxPluginLibraryEnv({ PJARCZAK_BAMBU_PLUGIN_DIR: "/opt/fulu/plugins", PJARCZAK_BAMBU_NETWORK_SO: "/custom/net.so" }, "linux"), {
    PJARCZAK_BAMBU_SOURCE_SO: path.resolve("/opt/fulu/plugins", "libBambuSource.so"),
  });
  // macOS wrappers run the host in a Linux guest that may not see host paths.
  assert.deepEqual(linuxPluginLibraryEnv({ PJARCZAK_BAMBU_PLUGIN_DIR: "/opt/fulu/plugins" }, "darwin"), {});
  assert.deepEqual(linuxPluginLibraryEnv({}, "linux"), {});
});

test("FULU host exit 101 names the socket-stdout bug and its wrapper", async (t) => {
  const { bridge } = await fakeFuluBridge(t, { FAKE_FULU_EXIT_CODE: "101" });
  await assert.rejects(bridge.ensureAgent(), error => {
    assert.match(error.message, /exited \(code=101/);
    assert.match(error.message, /could not reopen its stdout/);
    assert.match(error.message, /OrcaSlicer-bambulab\/issues\/50/);
    assert.match(error.message, /docs\/FULU\.md#linux/);
    return true;
  });
});

test("a FULU host that cannot open its networking library stops before agent creation with the fix", async (t) => {
  const { bridge, methods } = await fakeFuluBridge(t, { PJARCZAK_BAMBU_PLUGIN_DIR: undefined });
  await assert.rejects(bridge.ensureAgent(), /could not open its networking library \(validate failed: file open failed\)\. Set PJARCZAK_BAMBU_PLUGIN_DIR/);
  assert.deepEqual(methods(), ["bridge.handshake"]);
});

test("FULU agent setup passes Bambu's pinned certificates, works through a cat wrapper and stops cleanly", async (t) => {
  const { bridge, dir, calls } = await fakeFuluBridge(t, {}, { wrapped: true });
  const { agent } = await bridge.ensureAgent();
  assert.equal(agent, 1);
  const entries = calls();
  const methods = entries.filter(entry => entry.method).map(entry => entry.method);
  assert.ok(methods.indexOf("net.set_cert_file") > methods.indexOf("net.init_log"));
  assert.ok(methods.indexOf("net.set_cert_file") < methods.indexOf("net.start"));
  for (const callback of ["net.set_queue_on_main_fn", "net.set_on_local_connect_fn"]) assert.ok(methods.includes(callback), callback);
  // FULU's GUI identifies itself (init_http_extra_header) after set_cert_file and before start.
  assert.ok(methods.indexOf("net.set_extra_http_header") > methods.indexOf("net.set_cert_file"));
  assert.ok(methods.indexOf("net.set_extra_http_header") < methods.indexOf("net.start"));
  const { headers } = entries.find(entry => entry.method === "net.set_extra_http_header").payload;
  assert.equal(headers["X-BBL-Client-Name"], "BambuStudio");
  assert.equal(headers["X-BBL-Client-Version"], "02.05.02.51");
  assert.equal(headers["X-BBL-Client-Type"], "slicer");
  assert.equal(headers["X-BBL-OS-Type"], "linux");
  assert.match(headers["X-BBL-Device-ID"], /^[0-9a-f-]{36}$/);
  assert.equal(fs.readFileSync(path.join(dir, "config", "client-device-id"), "utf8").trim(), headers["X-BBL-Device-ID"]);
  const certFolder = entries.find(entry => entry.method === "net.set_cert_file").payload;
  assert.deepEqual({ folder: certFolder.folder, filename: certFolder.filename }, { folder: path.join(dir, "config", "cert"), filename: "slicer_base64.cer" });
  for (const [name, { sha256 }] of Object.entries(BAMBU_NETWORK_CERTIFICATES)) {
    assert.equal(createHash("sha256").update(fs.readFileSync(path.join(certFolder.folder, name))).digest("hex"), sha256, name);
  }
  if (process.platform === "linux") {
    assert.deepEqual(entries[0].env, {
      PJARCZAK_BAMBU_PLUGIN_DIR: path.join(dir, "plugins"),
      PJARCZAK_BAMBU_NETWORK_SO: path.join(dir, "plugins", "libbambu_networking.so"),
      PJARCZAK_BAMBU_SOURCE_SO: path.join(dir, "plugins", "libBambuSource.so"),
    });
  }
  const pid = bridge.getStatus().pid;
  const started = Date.now();
  await bridge.stop();
  assert.ok(Date.now() - started < 1500, "stop must not wait for the SIGKILL fallback");
  await sleep(100);
  assert.equal(fs.readFileSync(path.join(dir, "host.jsonl"), "utf8").includes('"start":true'), true);
  assert.throws(() => process.kill(pid, 0), /ESRCH/, "the wrapper shell must not outlive stop()");
});

test("bridge status reports the certificate folder and keeps macOS discovery hints on macOS", async (t) => {
  const { bridge, dir } = await fakeFuluBridge(t);
  const status = bridge.getStatus();
  assert.equal(status.runtime.certDir, path.join(dir, "config", "cert"));
  if (process.platform === "darwin") assert.equal(typeof status.runtime.macosRuntimeDir, "string");
  else assert.equal(status.runtime.macosRuntimeDir, undefined, "macOS paths are not Linux or Windows requirements");
  if (process.platform === "linux") assert.equal(status.runtime.pluginLibraries.PJARCZAK_BAMBU_NETWORK_SO, path.join(dir, "plugins", "libbambu_networking.so"));
  assert.equal(status.runtime.suggestedMacCommand, undefined, "a wrapper command is only suggested when the wrapper exists");
});

test("FULU LAN prints open the plug-in's own session and install the printer certificate before printing", async (t) => {
  const { bridge, methods } = await fakeFuluBridge(t);
  const { result, jobUpdates } = await bridge.startLocalPrint(LOCAL_PRINTER, "net.start_local_print", { client_job_id: 7, params: { dev_id: "01PTEST" } }, {}, () => {}, FAST_LOCAL_PRINT);
  assert.deepEqual(result, { ok: true, value: 0, job_id: 7 });
  assert.deepEqual(jobUpdates, [{ status: 1, code: 100, msg: "0.0M/0.0M" }]);
  const order = methods();
  const at = method => order.indexOf(method);
  assert.ok(at("net.set_cert_file") < at("net.connect_printer"));
  assert.ok(at("net.connect_printer") < at("net.install_device_cert"));
  assert.ok(at("net.install_device_cert") < order.indexOf("net.send_message_to_printer"));
  assert.ok(order.indexOf("net.send_message_to_printer") < at("net.start_local_print"));
  assert.equal(order.filter(method => method === "net.start_local_print").length, 1);
  assert.equal(order.at(-2), "net.disconnect_printer", "the session closes after the print");
});

test("a synchronous -4030 is retried once after the certificate exchange and then reported", async (t) => {
  const once = await fakeFuluBridge(t, { FAKE_FULU_PUBLISH_FAILURES: "1" });
  const recovered = await once.bridge.startLocalPrint(LOCAL_PRINTER, "net.start_local_print", { client_job_id: 8, params: {} }, {}, () => {}, FAST_LOCAL_PRINT);
  assert.equal(recovered.result.value, 0);
  assert.equal(once.methods().filter(method => method === "net.start_local_print").length, 2);

  const twice = await fakeFuluBridge(t, { FAKE_FULU_PUBLISH_FAILURES: "2" });
  const dispatched = [];
  const failed = await twice.bridge.startLocalPrint(LOCAL_PRINTER, "net.start_local_print", { client_job_id: 9, params: {} }, {
    beforeDispatch: async method => { if (method === "net.start_local_print") dispatched.push(method); },
  }, () => {}, FAST_LOCAL_PRINT);
  assert.equal(failed.result.value, -4030);
  assert.equal(twice.methods().filter(method => method === "net.start_local_print").length, 2, "never more than one retry");
  assert.equal(dispatched.length, 2, "each attempt passes the caller's fresh pre-dispatch check");
  assert.deepEqual(failed.jobUpdates.filter(update => update.code === -4030).map(update => update.msg), ["send msg failed", "send msg failed"]);
});

// Codex review on #69: the plug-in has one LAN connection and the host one event queue,
// so concurrent sessions for different printers must not consume each other's reports.
test("concurrent LAN prints to different printers run one session at a time on a shared bridge", async (t) => {
  const { bridge, calls } = await fakeFuluBridge(t);
  const printers = ["01PFIRST", "01PSECOND"].map(devId => ({ ...LOCAL_PRINTER, devId }));
  const results = await Promise.all(printers.map((printer, index) =>
    bridge.startLocalPrint(printer, "net.start_local_print", { client_job_id: 20 + index, params: { dev_id: printer.devId } }, {}, () => {}, FAST_LOCAL_PRINT)));
  assert.deepEqual(results.map(({ result }) => result.value), [0, 0]);
  const sequence = calls().filter(entry => ["net.connect_printer", "net.start_local_print", "net.disconnect_printer"].includes(entry.method))
    .map(entry => `${entry.method}:${entry.payload.dev_id ?? entry.payload.params?.dev_id ?? ""}`);
  assert.deepEqual(sequence, [
    "net.connect_printer:01PFIRST", "net.start_local_print:01PFIRST", "net.disconnect_printer:",
    "net.connect_printer:01PSECOND", "net.start_local_print:01PSECOND", "net.disconnect_printer:",
  ]);
});

test("a LAN printer the plug-in cannot verify stops before any print or disconnect", async (t) => {
  const emptyCertDir = fs.mkdtempSync(path.join(os.tmpdir(), "fulu-no-printer-cert-"));
  t.after(() => fs.rmSync(emptyCertDir, { recursive: true, force: true }));
  const { bridge, methods } = await fakeFuluBridge(t, { BAMBU_NETWORK_CERT_DIR: emptyCertDir });
  await assert.rejects(
    bridge.startLocalPrint(LOCAL_PRINTER, "net.start_local_print", { client_job_id: 10, params: {} }, {}, () => {}, FAST_LOCAL_PRINT),
    /LAN connection to printer 01PTEST at 192\.0\.2\.10 failed\. .*No print command was sent/
  );
  assert.equal(methods().includes("net.start_local_print"), false);
  assert.equal(methods().includes("net.disconnect_printer"), false, "the real host crashes when disconnecting a session that never connected");
});

test("cancellation during a LAN session stops before the print command", async (t) => {
  const { bridge, methods } = await fakeFuluBridge(t);
  let active = true;
  await assert.rejects(bridge.startLocalPrint(LOCAL_PRINTER, "net.start_local_print", { client_job_id: 11, params: {} }, {
    beforeDispatch: async method => { if (method === "net.send_message_to_printer") active = false; },
  }, () => { if (!active) throw new Error("cancelled by stop"); }, FAST_LOCAL_PRINT), /cancelled by stop/);
  assert.equal(methods().includes("net.start_local_print"), false);
  assert.ok(methods().includes("net.disconnect_printer"), "an established session is still closed");
});

test("a host without the LAN-session calls still serves cloud and probes, and refuses LAN prints before connecting", async (t) => {
  const { bridge, methods } = await fakeFuluBridge(t, { FAKE_FULU_UNSUPPORTED: "net.set_cert_file" });
  const { agent } = await bridge.ensureAgent();
  assert.equal(agent, 1, "cloud jobs and status probes keep working");
  await assert.rejects(
    bridge.startLocalPrint(LOCAL_PRINTER, "net.start_local_print", { client_job_id: 12, params: {} }, {}, () => {}, FAST_LOCAL_PRINT),
    /did not accept the certificate folder or local-connection callbacks a LAN print needs\. .*no print command was sent/
  );
  assert.equal(methods().includes("net.connect_printer"), false, "the real host crashes connecting without a certificate folder");
});

// Opt-in: the real FULU host and plug-in. FULU_HOST_DIR holds pjarczak_bambu_linux_host
// (x86-64 Linux), FULU_PLUGIN_DIR the 02.05.02.5x plug-in. With FULU_TEST_PRINTER_HOST,
// FULU_TEST_PRINTER_SERIAL and FULU_TEST_PRINTER_ACCESS_CODE it also opens and closes a
// real LAN session. It never prints.
const realFulu = process.env.FULU_HOST_DIR && process.env.FULU_PLUGIN_DIR && process.platform === "linux" && process.arch === "x64";
test("real FULU host: agent setup and LAN session through the documented cat wrapper", { skip: !realFulu && "set FULU_HOST_DIR and FULU_PLUGIN_DIR on x86-64 Linux" }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "real-fulu-"));
  const wrapper = path.join(dir, "fulu-host-wrapper.sh");
  fs.writeFileSync(wrapper, `#!/bin/sh\n${shellQuoteArg(path.join(process.env.FULU_HOST_DIR, "pjarczak_bambu_linux_host"))} "$@" | cat\n`, { mode: 0o755 });
  const { bridge } = await fakeFuluBridge(t, {
    BAMBU_NETWORK_BRIDGE_COMMAND: shellQuoteArg(wrapper), PJARCZAK_BAMBU_PLUGIN_DIR: process.env.FULU_PLUGIN_DIR,
    BAMBU_NETWORK_CONFIG_DIR: path.join(dir, "config"), FAKE_FULU_LOG: undefined,
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { handshake } = await bridge.ensureAgent();
  assert.equal(handshake.network_loaded, true, JSON.stringify(handshake));
  const { FULU_TEST_PRINTER_HOST: devIp, FULU_TEST_PRINTER_SERIAL: devId, FULU_TEST_PRINTER_ACCESS_CODE: password } = process.env;
  if (!devIp || !devId || !password) return t.diagnostic("no FULU_TEST_PRINTER_* configured; skipped the LAN session");
  const connected = await bridge.withLocalSession({ devId, devIp, username: "bblp", password, useSsl: true }, {}, () => {}, LOCAL_PRINT_TIMING, async () => "connected");
  assert.equal(connected, "connected");
});
