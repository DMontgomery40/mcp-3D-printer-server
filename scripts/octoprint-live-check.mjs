#!/usr/bin/env node
/**
 * Opt-in check against a real OctoPrint whose only printer is OctoPrint's bundled Virtual Printer (port "VIRTUAL").
 * It refuses any other connection, so it can never heat, move or print on real hardware.
 *
 *   docker run -d --name octoprint-check -p 5080:80 octoprint/octoprint
 *   # finish the first-run wizard (or `octoprint user add --admin`), enable Settings → Virtual Printer
 *   OCTOPRINT_CHECK_URL=http://localhost:5080 OCTOPRINT_CHECK_USER=… OCTOPRINT_CHECK_PASSWORD=… npm run test:octoprint-live
 *
 * Through this server over stdio, as a client calls it:
 *   1. octoprint_request_api_key: starts a request; the script then approves it the way a browser does (signs in, opens
 *      approve_url, posts the decision with OctoPrint's CSRF token), and the next call returns the new key.
 *   2. Disconnects OctoPrint from the Virtual Printer; counterpart_print_progress reports octoprint.disconnected.
 *   3. connect_printer connects it again; counterpart_print_progress reports idle.
 *   4. list_printer_files returns the trimmed list; counterpart_printer_info reads the printer profile.
 *   5. upload_gcode prints a two-line G-code file that only sets no heater, and cancel_print cancels it (Virtual Printer).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = (process.env.OCTOPRINT_CHECK_URL ?? "").replace(/\/+$/, "");
const user = process.env.OCTOPRINT_CHECK_USER ?? "";
const password = process.env.OCTOPRINT_CHECK_PASSWORD ?? "";
if (!base || !user || !password) {
  console.error("Set OCTOPRINT_CHECK_URL, OCTOPRINT_CHECK_USER and OCTOPRINT_CHECK_PASSWORD (an OctoPrint whose printer is the Virtual Printer).");
  process.exit(2);
}
const url = new URL(base);
const host = url.pathname === "/" && url.protocol === "http:" ? url.hostname : base;
const port = url.pathname === "/" && url.protocol === "http:" ? (url.port || "80") : "";

function check(condition, message, detail) {
  if (!condition) {
    console.error(`FAIL ${message}`, detail === undefined ? "" : JSON.stringify(detail, null, 2));
    process.exit(1);
  }
  console.log(`ok   ${message}`);
}

/** A browser session: OctoPrint's CSRF cookie and header, then the login cookie. */
class Browser {
  cookies = new Map();
  async fetch(pathname, init = {}) {
    const headers = new Headers(init.headers ?? {});
    headers.set("Cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    const csrf = [...this.cookies].find(([k]) => k.startsWith("csrf_token"))?.[1];
    if (csrf && init.method && init.method !== "GET") headers.set("X-CSRF-Token", csrf);
    const response = await fetch(/^https?:/.test(pathname) ? pathname : `${base}${pathname}`, { ...init, headers, redirect: "manual" });
    for (const line of response.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(";");
      const at = pair.indexOf("=");
      this.cookies.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
    }
    return response;
  }
  async login() {
    await this.fetch("/");
    const response = await this.fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user, pass: password, remember: false }) });
    if (!response.ok) throw new Error(`OctoPrint login failed: ${response.status} ${await response.text()}`);
  }
  /** What a person does on OctoPrint's approval page: open it (signed in) and click Allow. */
  async allow(approveUrl) {
    const page = await this.fetch(approveUrl);
    const html = await page.text();
    const token = /USER_TOKEN\s*=\s*"([^"]+)"/.exec(html)?.[1];
    if (!token) throw new Error(`No user token on OctoPrint's approval page (HTTP ${page.status}).`);
    const decision = await this.fetch(`/plugin/appkeys/decision/${encodeURIComponent(token)}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: true }),
    });
    if (decision.status !== 204) throw new Error(`OctoPrint's decision answered ${decision.status}: ${await decision.text()}`);
  }
}

async function startServer(apiKey) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "octoprint-check-"));
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(root, "dist", "index.js")], cwd: temp, stderr: "pipe",
    env: { ...process.env, MCP_TRANSPORT: "stdio", PRINTER_TYPE: "octoprint", PRINTER_HOST: host, PRINTER_PORT: port, API_KEY: apiKey,
      TEMP_DIR: temp, PRINTER_MAX_NOZZLE_TEMP: "260", PRINTER_MAX_BED_TEMP: "110" },
  });
  const client = new Client({ name: "octoprint-live-check", version: "1" });
  await client.connect(transport);
  return { client, temp, call: async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(`${name}: ${result.content?.[0]?.text}`);
    return result.structuredContent ?? JSON.parse(result.content?.[0]?.text ?? "null");
  } };
}

const browser = new Browser();
await browser.login();

// 1. Application Keys, through the server.
let server = await startServer("");
const started = await server.call("octoprint_request_api_key", { app: "octoprint-live-check" });
check(started.status === "pending" && started.request_id && started.approve_url, "octoprint_request_api_key starts a request with OctoPrint's approval page", started);
await new Promise(resolve => setTimeout(resolve, 7_000)); // longer than OctoPrint's 5 s poll timeout: the server must keep it open
await browser.allow(started.approve_url);
const approved = await server.call("octoprint_request_api_key", { request_id: started.request_id, wait_ms: 15_000 });
check(approved.status === "approved" && typeof approved.api_key === "string" && approved.env?.API_KEY === approved.api_key, "the approved request returns the key as API_KEY", { ...approved, api_key: approved.api_key ? "<redacted>" : undefined, env: undefined });
await server.client.close();

// Everything else with the key OctoPrint issued.
server = await startServer(approved.api_key);
const api = (pathname, init = {}) => fetch(`${base}${pathname}`, { ...init, headers: { "X-Api-Key": approved.api_key, "Content-Type": "application/json", ...(init.headers ?? {}) } });
const connection = await (await api("/api/connection")).json();
check(["VIRTUAL", null].includes(connection.current.port) && connection.options.ports.every(p => p === "VIRTUAL"),
  "this OctoPrint's only printer is the Virtual Printer", connection);

// 2. Disconnected.
await api("/api/connection", { method: "POST", body: JSON.stringify({ command: "disconnect" }) });
await new Promise(resolve => setTimeout(resolve, 1_500));
const offline = await server.call("counterpart_print_progress");
check(offline.state === "offline" && offline.problems.some(p => p.code === "octoprint.disconnected"), "a disconnected OctoPrint reports octoprint.disconnected", offline);

// 3. connect_printer.
const connected = await server.call("connect_printer", { serial_port: "VIRTUAL" });
check(connected.action === "connected" && connected.connected === true, "connect_printer connects OctoPrint to the printer", connected);
const again = await server.call("connect_printer");
check(again.action === "none", "connect_printer sends nothing when already connected", again);
const idle = await server.call("counterpart_print_progress");
check(idle.state === "idle" && !idle.problems.some(p => p.code === "octoprint.disconnected"), "progress is idle once connected", idle);

// 4. Files and identity.
const info = await server.call("counterpart_printer_info");
check(info.printer.kind === "octoprint" && info.capabilities.pause === true, "counterpart_printer_info reads the printer", info);

// 5. Upload and print a file that heats nothing, then cancel.
const gcode = path.join(server.temp, "octoprint-live-check.gcode");
fs.writeFileSync(gcode, "; octoprint-live-check\nG4 P2000\nG4 P2000\nG4 P2000\nG4 P2000\nG4 P2000\nG4 P2000\n");
const upload = await server.call("upload_gcode", { filename: "octoprint-live-check.gcode", gcode: fs.readFileSync(gcode, "utf8"), print: true });
check(upload, "upload_gcode with print uploads and starts the file", upload);
let printing;
for (let i = 0; i < 10 && printing?.state !== "printing"; i++) {
  await new Promise(resolve => setTimeout(resolve, 500));
  printing = await server.call("counterpart_print_progress");
}
check(printing.state === "printing" && printing.job?.name, "progress reports the job printing", printing);
const files = await server.call("list_printer_files");
const listed = JSON.stringify(files);
check(listed.includes("octoprint-live-check.gcode") && !listed.includes("\"refs\""), "list_printer_files is the trimmed list", files);
await server.call("cancel_print");
let ended;
for (let i = 0; i < 20 && !["cancelled", "idle"].includes(ended?.state); i++) {
  await new Promise(resolve => setTimeout(resolve, 500));
  ended = await server.call("counterpart_print_progress");
}
check(["cancelled", "idle"].includes(ended.state), "cancel_print ends the job", ended);
await api("/api/files/local/octoprint-live-check.gcode", { method: "DELETE" });
await server.client.close();
console.log("OctoPrint live check passed.");
