import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Runs the real, unpatched bambu-node 3.22.21 message parser in a child
// process. No MQTT connection is opened and no printer is contacted.
const root = fileURLToPath(new URL("../..", import.meta.url));
const guard = pathToFileURL(`${root}/dist/printers/bambu-node-guard.js`).href;

function run(body) {
  const script = `
    import { BambuClient } from "bambu-node";
    import { installBambuNodeRejectionGuard } from ${JSON.stringify(guard)};
    installBambuNodeRejectionGuard();
    const client = new BambuClient({ host: "192.0.2.1", serialNumber: "094TESTONLY", accessToken: "unused" });
    const topic = "device/094TESTONLY/report";
    ${body}
    setTimeout(() => { console.log("alive"); process.exit(0); }, 100);
  `;
  return spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: root, encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 * 1024 });
}

test("unpatched bambu-node terminates Node from its async parser for an H2D serial", () => {
  // Without the guard the same inputs terminate Node with an unhandled rejection.
  const script = `
    import { BambuClient } from "bambu-node";
    const client = new BambuClient({ host: "192.0.2.1", serialNumber: "094TESTONLY", accessToken: "unused" });
    void client.onMessage(JSON.stringify({ info: { command: "get_version", module: [{ name: "ota", sn: "094TESTONLY" }] } }), "device/094TESTONLY/report");
    setTimeout(() => { console.log("alive"); process.exit(0); }, 100);
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: root, encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 * 1024 });
  // Node truncates fatal output to a pipe, so assert the termination itself.
  assert.notEqual(result.status, 0, "unguarded rejection must terminate the process");
  assert.doesNotMatch(result.stdout, /alive/);
});

test("the guard keeps the server alive for known bambu-node internal parser errors", () => {
  const result = run(`
    void client.onMessage(JSON.stringify({ info: { command: "get_version", module: [{ name: "ota", sn: "094TESTONLY" }] } }), topic);
    const noOta = new BambuClient({ host: "192.0.2.1", serialNumber: "01PTESTONLY", accessToken: "unused" });
    void noOta.onMessage(JSON.stringify({ info: { command: "get_version", module: [{ name: "ams", sn: "X" }] } }), topic);
    const paused = new BambuClient({ host: "192.0.2.1", serialNumber: "01PTESTONLY", accessToken: "unused" });
    paused._printerStatus = "PAUSE";
    void paused.onMessage(JSON.stringify({ print: { command: "push_status", gcode_state: "IDLE" } }), topic);
  `);
  assert.equal(result.status, 0, result.stderr.slice(-2000));
  assert.match(result.stdout, /alive/);
  for (const message of ["Printer model not supported!", "OTA module version data not found", "Edge case detected"]) {
    assert.ok(result.stderr.includes(`Ignored internal status-tracking error: ${message}`), message);
  }
});

test("the guard rethrows unrelated rejections and look-alike errors from outside bambu-node", () => {
  for (const body of [
    'void Promise.reject(new Error("unrelated failure"));',
    'void Promise.reject(new Error("Printer model not supported!"));',
    'void Promise.reject("not an error");',
  ]) {
    const result = run(body);
    assert.notEqual(result.status, 0, body);
    assert.doesNotMatch(result.stdout, /alive/, body);
  }
});
