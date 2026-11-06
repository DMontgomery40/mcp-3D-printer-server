/**
 * Autodesk Fusion through faust-machines/fusion360-mcp-server (PRD §8.9).
 * An MCP client talks stdio to that server, which talks TCP (localhost:9876)
 * to the Fusion360MCP add-in inside Fusion. Mirrors blender-mcp-bridge.ts:
 * executables come only from server configuration, only FUSION_* settings
 * reach the child process, argument schemas are discovered and enforced, and a
 * request that may have reached Fusion is never replayed. Unlike the Blender
 * bridge, the client stays connected for the life of this server, so a design
 * pass's many calls share one Fusion connection.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { ErrorCode, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { ClosingStdioTransport, editDeadline, regularStl } from "./blender-mcp-bridge.js";
import { FUSION_ADDIN_COMMIT, FUSION_ADDIN_REPOSITORY } from "./design-app-setup.js";

const execFileAsync = promisify(execFile);

/**
 * The server and add-in commit fusion_mcp_setup installs (FUSION_ADDIN_COMMIT, PRD §8.9): David Montgomery's fork
 * of faust-machines/fusion360-mcp-server with document binding, while that change is reviewed upstream, as
 * bambu-printer-mcp pins it. The PyPI 0.1.0 release crashes under mcp 2.x (faust issue #30).
 */
export const FUSION_MCP_PINNED_COMMIT = FUSION_ADDIN_COMMIT.slice(0, 12);
export const FUSION_MCP_DEFAULT_ARGS = [
  "--from", `git+https://github.com/${FUSION_ADDIN_REPOSITORY}@${FUSION_MCP_PINNED_COMMIT}`,
  "fusion360-mcp-server", "--mode", "socket",
];
/** PRD §8.9: Blender's MCP addon holds the add-in's own default, 9876, so Fusion uses 9877. */
export const FUSION_ADDIN_DEFAULT_PORT = 9877;
const DEFAULT_TIMEOUT_MS = 180_000;
const LAUNCH_WAIT_MS = 90_000;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

type Arguments = Record<string, unknown>;
type Session = { client: Client; transport: ClosingStdioTransport; tools: Tool[] };

class FusionError extends Error {}

function allowedArguments(args: Arguments, names: string[]): void {
  if (Object.keys(args).some((name) => !names.includes(name))) {
    throw new FusionError("Unknown Fusion argument. Executables and their arguments must be configured on the server with FUSION_MCP_COMMAND and FUSION_MCP_ARGS.");
  }
}

function textArgument(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new FusionError(`${label} must be a non-empty string without NUL characters.`);
  return value;
}

function booleanArgument(value: unknown, label: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new FusionError(`${label} must be a boolean.`);
  return value;
}

function timeoutMilliseconds(value: unknown): number {
  const timeout = value ?? (process.env.FUSION_MCP_TIMEOUT_MS ? Number(process.env.FUSION_MCP_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS);
  if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 100 || timeout > 600_000) {
    throw new FusionError("timeout_ms / FUSION_MCP_TIMEOUT_MS must be an integer from 100 to 600000.");
  }
  return timeout;
}

function configuration(): { command: string; args: string[] } {
  const command = process.env.FUSION_MCP_COMMAND?.trim();
  if (!command) {
    throw new FusionError(
      "No Fusion MCP server configured. Set FUSION_MCP_COMMAND to the full path of uvx; FUSION_MCP_ARGS defaults to the pinned " +
      `${FUSION_ADDIN_REPOSITORY}@${FUSION_MCP_PINNED_COMMIT} in socket mode. Install the Fusion360MCP add-in from the same commit and set it to Run on Startup, or run fusion_mcp_setup.`
    );
  }
  let args: unknown = FUSION_MCP_DEFAULT_ARGS;
  const raw = process.env.FUSION_MCP_ARGS?.trim();
  if (raw) {
    try { args = JSON.parse(raw); }
    catch { throw new FusionError("FUSION_MCP_ARGS must be a JSON array of strings, not a shell command."); }
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
    throw new FusionError("FUSION_MCP_ARGS must be a JSON array of strings without NUL characters.");
  }
  if (command.includes("\0")) throw new FusionError("FUSION_MCP_COMMAND must be an executable without NUL characters.");
  return { command, args };
}

function fusionEnvironment(): Record<string, string> {
  // The Fusion server needs its add-in address, not printer access codes or other server secrets.
  const env = getDefaultEnvironment();
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("FUSION_") && value !== undefined && !["FUSION_MCP_COMMAND", "FUSION_MCP_ARGS"].includes(key)) env[key] = value;
  }
  // The faust server reads FUSION_MCP_PORT too (src/fusion360_mcp/connection.py), so it dials the port this bridge probes.
  env.FUSION_MCP_PORT = String(addinAddress().port);
  return env;
}

export function addinAddress(): { host: string; port: number } {
  const host = process.env.FUSION_MCP_HOST?.trim() || "localhost";
  const port = Number(process.env.FUSION_MCP_PORT?.trim() || FUSION_ADDIN_DEFAULT_PORT);
  return { host, port: Number.isInteger(port) && port > 0 && port < 65536 ? port : FUSION_ADDIN_DEFAULT_PORT };
}

/** faust reports failures as text ("**tool** ERROR (KIND)") with isError set; treat either as an error. */
function normalizeToolFailure(result: CallToolResult): CallToolResult {
  if (result.isError) return result;
  const failed = result.content.some((entry) => entry.type === "text" && /^\s*\*\*[a-z0-9_]+\*\* ERROR\b|^\s*Error \([a-z0-9_]+\):/i.test(entry.text));
  return failed ? { ...result, isError: true } : result;
}

/** The add-in's error kind from faust's "**tool** ERROR (KIND)" heading (fusion360_mcp/server.py), when it failed with one. */
function errorKind(result: CallToolResult, name: string): string | undefined {
  return new RegExp(`^\\*\\*${name}\\*\\* ERROR \\(([A-Z_]+)\\)`).exec(resultText(result).trimStart())?.[1];
}

function resultText(result: CallToolResult): string {
  return result.content.filter((entry) => entry.type === "text").map((entry) => (entry as { text: string }).text).join("\n");
}

/** execute_code returns its last expression as a "  result: <value>" line; our code returns one JSON line. */
function executeCodeJson(result: CallToolResult, marker: string): Record<string, unknown> {
  const line = resultText(result).split("\n").find((entry) => entry.trimStart().startsWith("result: {"));
  let value: unknown;
  try { value = JSON.parse(line?.trimStart().slice("result: ".length) ?? "null"); } catch { value = undefined; }
  if (!value || typeof value !== "object" || (value as Arguments)[marker] !== true) {
    throw new FusionError("Fusion did not return the expected execute_code result; nothing was published. Check the Fusion360MCP add-in and its faust-machines commit.");
  }
  return value as Record<string, unknown>;
}

function noActiveDesign(result: CallToolResult): boolean {
  return /NO_ACTIVE_DESIGN|No active design/i.test(resultText(result));
}

const NO_ACTIVE_DESIGN_HELP =
  "Fusion has no open design, and at the pinned faust-machines commit no tool can create the first one: every tool, including execute_code, " +
  "needs an active design (faust-machines/fusion360-mcp-server issue #12). Open or create any design in Fusion once (File > New Design), then try again.";

/**
 * True only when the Fusion360MCP add-in answers its ping. A bare TCP connect
 * is not enough: Blender's MCP addon listens on the same default port (9876)
 * and answers "unknown command" to this harmless request.
 * Protocol: newline-delimited JSON, {"type","params"} in (add-in server/socket_server.py).
 * The pinned add-in answers ping on its fast path (event_bridge.py) with
 * {"status":"success","result":{"ok":true,"status":"pong"}}, and through its
 * command handler with {"pong":true}.
 */
function addinAnswers(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let buffer = "";
    let settled = false;
    const done = (value: boolean) => { if (settled) return; settled = true; clearTimeout(deadline); socket.destroy(); resolve(value); };
    // A hard total deadline: socket.setTimeout is an idle timer that a listener sending a trickle of bytes could hold open.
    const deadline = setTimeout(() => done(false), timeoutMs);
    socket.once("connect", () => socket.write(`${JSON.stringify({ type: "ping", params: {} })}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > 65_536) return done(false);
      const line = buffer.includes("\n") ? buffer.slice(0, buffer.indexOf("\n")) : buffer;
      try {
        const reply = JSON.parse(line);
        done(reply?.status === "success" && (reply?.result?.status === "pong" || reply?.result?.pong === true));
      } catch {
        if (buffer.includes("\n")) done(false);
      }
    });
    socket.once("error", () => done(false));
    socket.once("close", () => done(false));
  });
}

/** The Fusion app process on macOS ("Autodesk Fusion", formerly "Autodesk Fusion 360"); undefined elsewhere. */
async function fusionProcessRunning(): Promise<boolean | undefined> {
  if (process.platform !== "darwin") return undefined;
  try {
    await execFileAsync("pgrep", ["-f", "/Contents/MacOS/Autodesk Fusion"], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/** `open --env` applies only when it starts the app, which is the only time this runs. */
export function fusionLaunchArguments(port: number): string[] {
  return ["-a", "Autodesk Fusion", "--env", `FUSION_MCP_PORT=${port}`];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class FusionMcpBridge {
  private session?: Session;
  private connecting?: Promise<Session>;

  /** One client for the life of this server; reconnects on the next call after the transport closes. */
  private async connect(timeout: number, signal?: AbortSignal): Promise<Session> {
    if (this.session) return this.session;
    this.connecting ??= this.open(timeout, signal).finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private async open(timeout: number, signal?: AbortSignal): Promise<Session> {
    const config = configuration();
    const client = new Client({ name: "mcp-3d-printer-server-fusion", version: "1.0.0" });
    const transport = new ClosingStdioTransport({ ...config, env: fusionEnvironment(), stderr: "pipe" });
    // Drain stderr without relaying arbitrary logs into the outer MCP stream.
    transport.stderr?.on("data", () => {});
    const deadline = Date.now() + timeout;
    const options = () => ({ signal, timeout: Math.max(1, deadline - Date.now()) });
    let phase = "initialization";
    try {
      await client.connect(transport, options());
      phase = "tool discovery";
      const tools: Tool[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : {}, options());
        tools.push(...page.tools);
        cursor = page.nextCursor;
        if (cursor && (cursors.has(cursor) || cursors.size >= 99)) throw new FusionError("Fusion MCP returned an invalid or excessive tools/list pagination sequence.");
        if (cursor) cursors.add(cursor);
      } while (cursor);
      const session: Session = { client, transport, tools };
      client.onclose = () => { if (this.session === session) this.session = undefined; };
      this.session = session;
      return session;
    } catch (error) {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
      if (error instanceof FusionError) throw error;
      const code = (error as { code?: unknown })?.code;
      if (code === ErrorCode.RequestTimeout || Date.now() >= deadline) {
        throw new FusionError(`Fusion MCP timed out during ${phase}. The first start downloads the pinned server with uvx; check FUSION_MCP_COMMAND and FUSION_MCP_ARGS, or raise FUSION_MCP_TIMEOUT_MS.`);
      }
      if (signal?.aborted) throw new FusionError("Fusion MCP request cancelled.");
      const safeCode = typeof code === "number" ? ` (RPC ${code})` : ["ENOENT", "EACCES"].includes(String(code)) ? ` (${code})` : "";
      throw new FusionError(`Fusion MCP failed during ${phase}${safeCode}. Check FUSION_MCP_COMMAND and FUSION_MCP_ARGS.`);
    }
  }

  /** Call a discovered tool once; a failure after dispatch is reported, never replayed. */
  private async invoke(name: string, args: Arguments, timeout: number, signal?: AbortSignal): Promise<CallToolResult> {
    const session = await this.connect(timeout, signal);
    const tool = session.tools.find((entry) => entry.name === name);
    if (!tool) throw new FusionError("The requested tool is not advertised by Fusion MCP. Call fusion_mcp_status to list the available tools.");
    let valid: boolean;
    try { valid = new AjvJsonSchemaValidator().getValidator(tool.inputSchema)(args).valid; }
    catch { throw new FusionError("Fusion MCP advertised an unsupported input schema for this tool."); }
    if (!valid) throw new FusionError("Fusion tool arguments do not match its advertised input schema. Call fusion_mcp_status with tool_names: [\"<tool>\"] to read the schema.");
    try {
      return normalizeToolFailure(await session.client.callTool({ name, arguments: args }, undefined, { signal, timeout }) as CallToolResult);
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      if (code === ErrorCode.ConnectionClosed) this.session = undefined;
      const reason = code === ErrorCode.RequestTimeout ? "timed out" : signal?.aborted ? "was cancelled" : "failed";
      throw new FusionError(`Fusion MCP request ${reason}. It may already have reached Fusion; inspect the design before retrying. The request was not replayed.`);
    }
  }

  async close(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    if (!session) return;
    await session.client.close().catch(() => {});
    await session.transport.close().catch(() => {});
  }

  /**
   * {configured, connected, addinReachable, fusionRunning, tools[]}. connected
   * means the server started and the add-in answered its ping. With launch:
   * true and Fusion not running on this Mac, opens Fusion and waits up to 90 s
   * for the add-in port.
   */
  async status(args: Arguments, signal?: AbortSignal): Promise<Record<string, unknown>> {
    allowedArguments(args, ["launch", "timeout_ms"]);
    const launch = booleanArgument(args.launch, "launch");
    const timeout = timeoutMilliseconds(args.timeout_ms);
    const configured = Boolean(process.env.FUSION_MCP_COMMAND?.trim());
    const { host, port } = addinAddress();
    const local = LOCAL_HOSTS.has(host.toLowerCase());
    let addinReachable = await addinAnswers(host, port, 2_000);
    let processRunning = local ? await fusionProcessRunning() : undefined;
    let launched = false;
    if (launch && !addinReachable && processRunning !== true) {
      if (process.platform !== "darwin" || !local) throw new FusionError("launch is supported only for Fusion on this Mac; start Fusion yourself.");
      try {
        // A GUI app gets no shell environment; the add-in reads FUSION_MCP_PORT from Fusion's (addon/Fusion360MCP.py).
        await execFileAsync("open", fusionLaunchArguments(port), { timeout: 30_000 });
        launched = true;
      } catch {
        throw new FusionError(`Could not start Autodesk Fusion with open -a "Autodesk Fusion" --env FUSION_MCP_PORT=${port}. Is it installed?`);
      }
    }
    if (launch && !addinReachable) {
      const until = Date.now() + Math.min(LAUNCH_WAIT_MS, timeout);
      while (!addinReachable && Date.now() < until) {
        if (signal?.aborted) throw new FusionError("Fusion MCP request cancelled while waiting for Fusion to start.");
        await sleep(1_000);
        addinReachable = await addinAnswers(host, port, 2_000);
      }
      if (local) processRunning = await fusionProcessRunning();
    }
    // Off macOS, or with Fusion on another computer, the add-in answering is the evidence that Fusion runs.
    const fusionRunning = processRunning === true || addinReachable;
    const result: Record<string, unknown> = { configured, connected: false, addinReachable, fusionRunning, tools: [], launched, transport: "stdio", pin: FUSION_MCP_PINNED_COMMIT };
    if (!configured) return result;
    try {
      const session = await this.connect(timeout, signal);
      result.tools = session.tools;
      result.server = session.client.getServerVersion();
      // faust's ping answers through the add-in without touching Fusion's API.
      if (addinReachable && session.tools.some((tool) => tool.name === "ping")) {
        result.connected = !(await this.invoke("ping", {}, Math.min(timeout, 15_000), signal)).isError;
      }
      // Whether a design is open, from the add-in itself. get_design_type reads the active document's Design product
      // (the add-in's _design(), as every design command does) and changes nothing; with no design it fails with the
      // add-in's own error kind NO_ACTIVE_DESIGN (its hints.py). Any other answer leaves activeDesign out: unknown.
      if (result.connected === true && session.tools.some((tool) => tool.name === "get_design_type")) {
        let read: CallToolResult;
        // A read that didn't finish (timeout, cancel, lost connection): Fusion isn't usable now, and status says why.
        try { read = await this.invoke("get_design_type", {}, Math.min(timeout, 15_000), signal); }
        catch (error) { result.connected = false; throw error; }
        if (!read.isError) result.activeDesign = true;
        else if (errorKind(read, "get_design_type") === "NO_ACTIVE_DESIGN") result.activeDesign = false;
      }
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
    }
    return result;
  }

  /** Pass a call through to a discovered faust tool with its full content and errors (the blender_mcp_call contract). */
  async call(args: Arguments, signal?: AbortSignal): Promise<CallToolResult> {
    allowedArguments(args, ["tool_name", "arguments", "timeout_ms"]);
    const name = textArgument(args.tool_name, "tool_name");
    const toolArgs = args.arguments ?? {};
    if (!toolArgs || typeof toolArgs !== "object" || Array.isArray(toolArgs)) throw new FusionError("arguments must be an object.");
    const result = await this.invoke(name, toolArgs as Arguments, timeoutMilliseconds(args.timeout_ms), signal);
    // The remote result passes through unchanged; its structuredContent satisfies the open schema.
    return { ...result, structuredContent: result.structuredContent ?? {} };
  }

  /** A new parametric design document, so faust tools have an active design. */
  async newDesign(args: Arguments, signal?: AbortSignal): Promise<Record<string, unknown>> {
    allowedArguments(args, ["timeout_ms"]);
    const timeout = timeoutMilliseconds(args.timeout_ms);
    const code = [
      "import json",
      "doc = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)",
      "new_design = adsk.fusion.Design.cast(doc.products.itemByProductType('DesignProductType'))",
      "new_design.designType = adsk.fusion.DesignTypes.ParametricDesignType",
      "json.dumps({'mcp3d_new_design': True, 'document': doc.name, 'parametric': new_design.designType == adsk.fusion.DesignTypes.ParametricDesignType})",
    ].join("\n");
    const result = await this.invoke("execute_code", { code }, timeout, signal);
    if (result.isError) {
      if (noActiveDesign(result)) throw new FusionError(NO_ACTIVE_DESIGN_HELP);
      throw new FusionError(`Fusion could not create a design: ${resultText(result).slice(0, 600) || "no details"}`);
    }
    const created = executeCodeJson(result, "mcp3d_new_design");
    if (typeof created.document !== "string") throw new FusionError("Fusion did not report the new design document.");
    return { status: "created", document: created.document, parametric: created.parametric === true };
  }

  /**
   * Write <name>.stl (export_stl), <name>.f3d (export_f3d) and
   * <name>.parameters.json into output_dir. Files are staged, verified and
   * then published without ever replacing an existing file.
   */
  async export(args: Arguments, signal?: AbortSignal): Promise<Record<string, unknown>> {
    allowedArguments(args, ["output_dir", "name", "body_name", "timeout_ms"]);
    const timeout = timeoutMilliseconds(args.timeout_ms);
    const deadline = editDeadline(timeout, signal);
    const name = textArgument(args.name, "name");
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}$/.test(name) || name.includes("..")) {
      throw new FusionError("name must be a plain file name of letters, digits, spaces, dots, hyphens or underscores, without a path.");
    }
    const requestedDir = textArgument(args.output_dir, "output_dir");
    if (!path.isAbsolute(requestedDir)) throw new FusionError("output_dir must be an absolute path.");
    const outputDir = await fs.realpath(requestedDir).catch(() => { throw new FusionError("output_dir must be an existing directory."); });
    if (!(await fs.stat(outputDir)).isDirectory()) throw new FusionError("output_dir must be an existing directory.");
    const targets = { stl: path.join(outputDir, `${name}.stl`), f3d: path.join(outputDir, `${name}.f3d`), parameters: path.join(outputDir, `${name}.parameters.json`) };
    for (const target of Object.values(targets)) {
      if (await fs.lstat(target).then(() => true, () => false)) throw new FusionError(`${target} already exists; fusion_mcp_export never overwrites files.`);
    }
    if (args.body_name !== undefined) textArgument(args.body_name, "body_name");

    // The bodies export_stl can resolve by name, in its own order (_body_by_name, addon/server/command_handler.py
    // at the pin): root bodies, then each occurrence's proxies, hidden or not. Sizes are in Fusion's centimetres,
    // in root space like the exported mesh. `component` is the root component in execute_code.
    const probe = await this.invoke("execute_code", { code: [
      "import json",
      "bodies = []",
      "for b in list(component.bRepBodies) + [p for o in component.allOccurrences for p in o.bRepBodies]:",
      "    bb = b.boundingBox",
      "    bodies.append({'name': b.name, 'solid': b.isSolid, 'visible': b.isVisible, 'size_cm': [bb.maxPoint.x - bb.minPoint.x, bb.maxPoint.y - bb.minPoint.y, bb.maxPoint.z - bb.minPoint.z]})",
      "json.dumps({'mcp3d_bodies': True, 'bodies': bodies})",
    ].join("\n") }, deadline.remaining(), signal);
    if (probe.isError) {
      if (noActiveDesign(probe)) throw new FusionError(NO_ACTIVE_DESIGN_HELP);
      throw new FusionError(`Fusion could not list the design's bodies: ${resultText(probe).slice(0, 600) || "no details"}`);
    }
    const everyBody = (executeCodeJson(probe, "mcp3d_bodies").bodies as { name: string; solid: boolean; visible: boolean; size_cm: number[] }[] | undefined) ?? [];
    const bodies = everyBody.filter((entry) => entry.solid === true && entry.visible === true);
    const bodyName = args.body_name as string | undefined;
    const body = bodyName ? bodies.find((entry) => entry.name === bodyName) : bodies.length === 1 ? bodies[0] : undefined;
    if (!body) {
      if (bodyName) throw new FusionError(`No visible solid body named "${bodyName}". Visible bodies: ${bodies.map((entry) => entry.name).join(", ") || "none"}.`);
      throw new FusionError(bodies.length
        ? `The design has ${bodies.length} visible solid bodies (${bodies.map((entry) => entry.name).join(", ")}); pass body_name.`
        : "The design has no visible solid body to export.");
    }
    // export_stl takes the first body with this name, hidden or not, so the name must be unique among all of them.
    // This also refuses copies of an instanced component, which share their bodies' names.
    if (everyBody.filter((entry) => entry.name === body.name).length > 1) {
      throw new FusionError(`Several bodies are named "${body.name}" (including hidden ones and component copies); rename them in Fusion so the export is unambiguous.`);
    }

    const id = randomUUID();
    const staged = { stl: path.join(outputDir, `.mcp3d-${id}.stl`), f3d: path.join(outputDir, `.mcp3d-${id}.f3d`) };
    const published: string[] = [];
    try {
      const stlResult = await this.invoke("export_stl", { body_name: body.name, file_path: staged.stl }, deadline.remaining(), signal);
      if (stlResult.isError) throw new FusionError(`Fusion could not export the STL: ${resultText(stlResult).slice(0, 600) || "no details"}. Nothing was published.`);
      const f3dResult = await this.invoke("export_f3d", { file_path: staged.f3d }, deadline.remaining(), signal);
      if (f3dResult.isError) throw new FusionError(`Fusion could not export the F3D: ${resultText(f3dResult).slice(0, 600) || "no details"}. Nothing was published.`);
      // get_parameters returns a Python repr in text; the same fields come back as JSON through execute_code.
      const parametersResult = await this.invoke("execute_code", { code: [
        "import json",
        "params = [{'name': p.name, 'value': p.value, 'expression': p.expression, 'unit': p.unit, 'comment': p.comment} for p in design.userParameters]",
        "json.dumps({'mcp3d_parameters': True, 'parameters': params, 'count': len(params)})",
      ].join("\n") }, deadline.remaining(), signal);
      if (parametersResult.isError) throw new FusionError(`Fusion could not read the design's parameters: ${resultText(parametersResult).slice(0, 600) || "no details"}. Nothing was published.`);
      const parameters = executeCodeJson(parametersResult, "mcp3d_parameters");

      const missing = async (file: string) => !(await fs.lstat(file).then((stat) => stat.isFile() && stat.size > 0, () => false));
      if (await missing(staged.stl) || await missing(staged.f3d)) {
        throw new FusionError("Fusion reported an export but the files are not in output_dir. fusion_mcp_export needs Fusion and this server on the same computer (FUSION_MCP_HOST local).");
      }
      const metadata = await regularStl(staged.stl, deadline);
      // Fusion measures in centimetres; the STL's own numbers show which unit it was written in.
      const largestCm = Math.max(...body.size_cm);
      const largestStl = Math.max(...metadata.bounding_box.dimensions);
      const ratio = largestCm > 0 ? largestStl / largestCm : NaN;
      const stlUnits = Math.abs(ratio - 10) < 0.5 ? "mm" : Math.abs(ratio - 1) < 0.05 ? "cm" : "unknown";
      const warnings: string[] = [];
      if (stlUnits === "cm") warnings.push("The STL is in centimetres; slicers read STL numbers as millimetres. Scale it by 10 before slicing.");
      if (stlUnits === "unknown") warnings.push("The STL's size does not match the Fusion body's size in mm or cm; check it before slicing.");
      deadline.check();
      await fs.link(staged.stl, targets.stl).catch(() => { throw new FusionError(`Cannot publish ${targets.stl}; it may already exist.`); });
      published.push(targets.stl);
      await fs.link(staged.f3d, targets.f3d).catch(() => { throw new FusionError(`Cannot publish ${targets.f3d}; it may already exist.`); });
      published.push(targets.f3d);
      await fs.writeFile(targets.parameters, `${JSON.stringify({ parameters: parameters.parameters ?? [], count: parameters.count ?? 0 }, null, 2)}\n`, { flag: "wx" })
        .catch(() => { throw new FusionError(`Cannot publish ${targets.parameters}; it may already exist.`); });
      published.push(targets.parameters);
      return {
        status: "exported",
        ...targets,
        body: body.name,
        triangles: metadata.triangles,
        bytes: metadata.bytes,
        parameterCount: Array.isArray(parameters.parameters) ? parameters.parameters.length : 0,
        boundingBox: metadata.bounding_box,
        stlUnits,
        fusionSizeMm: body.size_cm.map((value) => Math.round(value * 10 * 1e4) / 1e4),
        ...(warnings.length ? { warnings } : {}),
      };
    } catch (error) {
      // Remove only what this call published; nothing else in output_dir is touched.
      for (const file of published) await fs.rm(file, { force: true }).catch(() => {});
      throw error;
    } finally {
      await fs.rm(staged.stl, { force: true }).catch(() => {});
      await fs.rm(staged.f3d, { force: true }).catch(() => {});
    }
  }
}

// ---- outputSchemas: the same shapes as bambu-printer-mcp's Fusion bridge ----

export const FUSION_STATUS_OUTPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    configured: { type: "boolean", description: "FUSION_MCP_COMMAND is set." },
    connected: { type: "boolean", description: "The Fusion MCP server started and the add-in answered its ping." },
    addinReachable: { type: "boolean", description: "The Fusion360MCP add-in answered a ping on FUSION_MCP_HOST:FUSION_MCP_PORT (default localhost:9877) within 2 s. Another program on that port, such as Blender's MCP addon, does not count." },
    fusionRunning: { type: "boolean" },
    activeDesign: { type: "boolean", description: "When connected: whether Fusion has a design open, from the add-in's read-only get_design_type (false is its NO_ACTIVE_DESIGN). The pinned add-in refuses every design command, fusion_mcp_new_design included, without one (faust issue #12). Absent when unknown." },
    tools: { type: "array", items: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
    launched: { type: "boolean", description: "This call started Fusion." },
    transport: { type: "string" },
    pin: { type: "string", description: "The faust-machines/fusion360-mcp-server commit this bridge is set up for." },
    server: { type: "object" },
    error: { type: "string" },
  },
  required: ["configured", "connected", "addinReachable", "fusionRunning", "tools"],
};

/** fusion_mcp_call passes the remote result through: its structuredContent, else an empty object. */
export const FUSION_CALL_OUTPUT_SCHEMA = { type: "object" as const };

export const FUSION_NEW_DESIGN_OUTPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    status: { type: "string", const: "created" },
    document: { type: "string" },
    parametric: { type: "boolean" },
  },
  required: ["status", "document", "parametric"],
};

export const FUSION_EXPORT_OUTPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    status: { type: "string", const: "exported" },
    stl: { type: "string", description: "Absolute path of <name>.stl." },
    f3d: { type: "string", description: "Absolute path of <name>.f3d." },
    parameters: { type: "string", description: "Absolute path of <name>.parameters.json." },
    body: { type: "string" },
    triangles: { type: "integer", minimum: 1 },
    bytes: { type: "integer", minimum: 1 },
    parameterCount: { type: "integer", minimum: 0 },
    boundingBox: { type: "object", description: "Measured from the written STL, in its own units." },
    stlUnits: { type: "string", enum: ["mm", "cm", "unknown"], description: "The STL's units, from its size against the Fusion body's." },
    fusionSizeMm: { type: "array", items: { type: "number" }, description: "The Fusion body's bounding-box size in mm." },
    warnings: { type: "array", items: { type: "string" } },
  },
  required: ["status", "stl", "f3d", "parameters", "body", "triangles", "parameterCount"],
};
