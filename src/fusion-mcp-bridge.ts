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

const execFileAsync = promisify(execFile);

/** The pinned faust-machines commit (PRD §8.9). The PyPI 0.1.0 release crashes under mcp 2.x (issue #30). */
export const FUSION_MCP_PINNED_COMMIT = "19b9f1e95192";
export const FUSION_MCP_DEFAULT_ARGS = [
  "--from", `git+https://github.com/faust-machines/fusion360-mcp-server@${FUSION_MCP_PINNED_COMMIT}`,
  "fusion360-mcp-server", "--mode", "socket",
];
export const FUSION_ADDIN_DEFAULT_PORT = 9876;
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
      `faust-machines/fusion360-mcp-server@${FUSION_MCP_PINNED_COMMIT} in socket mode. Install the Fusion360MCP add-in from the same commit and set it to Run on Startup.`
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
  return env;
}

function addinAddress(): { host: string; port: number } {
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
 * Protocol: newline-delimited JSON, {"type","params"} in and
 * {"status":"success","result":{"pong":true}} out (add-in server/socket_server.py).
 */
function addinAnswers(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let buffer = "";
    let settled = false;
    const done = (value: boolean) => { if (settled) return; settled = true; socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => socket.write(`${JSON.stringify({ type: "ping", params: {} })}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > 65_536) return done(false);
      const line = buffer.includes("\n") ? buffer.slice(0, buffer.indexOf("\n")) : buffer;
      try {
        const reply = JSON.parse(line);
        done(reply?.status === "success" && reply?.result?.pong === true);
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
    allowedArguments(args, ["launch", "timeout_ms", "tool_names"]);
    const launch = booleanArgument(args.launch, "launch");
    const timeout = timeoutMilliseconds(args.timeout_ms);
    const requested = args.tool_names;
    if (requested !== undefined && (!Array.isArray(requested) || requested.length > 64 || requested.some((name) => typeof name !== "string" || !name.trim()))) {
      throw new FusionError("tool_names must be an array of up to 64 tool names.");
    }
    const configured = Boolean(process.env.FUSION_MCP_COMMAND?.trim());
    const { host, port } = addinAddress();
    const local = LOCAL_HOSTS.has(host.toLowerCase());
    let addinReachable = await addinAnswers(host, port, 2_000);
    let processRunning = local ? await fusionProcessRunning() : undefined;
    let launched = false;
    if (launch && !addinReachable && local && process.platform === "darwin" && processRunning !== true) {
      try {
        await execFileAsync("open", ["-a", "Autodesk Fusion"], { timeout: 15_000 });
        launched = true;
      } catch {
        throw new FusionError("Could not open Autodesk Fusion with `open -a \"Autodesk Fusion\"`. Install Fusion, or open it yourself and start the Fusion360MCP add-in.");
      }
    }
    if (launch && !addinReachable) {
      const until = Date.now() + Math.min(LAUNCH_WAIT_MS, timeout);
      while (!addinReachable && Date.now() < until) {
        if (signal?.aborted) throw new FusionError("fusion_mcp_status cancelled while waiting for Fusion.");
        await sleep(1_000);
        addinReachable = await addinAnswers(host, port, 1_500);
      }
      if (local) processRunning = await fusionProcessRunning();
    }
    // Off macOS, or with Fusion on another computer, the add-in answering is the evidence that Fusion runs.
    const fusionRunning = processRunning ?? addinReachable;
    const base = { configured, addinReachable, fusionRunning, ...(launched ? { launched } : {}), addin: `${host}:${port}`, pinnedCommit: FUSION_MCP_PINNED_COMMIT };
    if (!configured) return { ...base, connected: false, tools: [] };
    const session = await this.connect(timeout, signal);
    let connected = false;
    if (addinReachable && session.tools.some((tool) => tool.name === "ping")) {
      connected = !(await this.invoke("ping", {}, Math.min(timeout, 15_000), signal).catch(() => ({ isError: true } as CallToolResult))).isError;
    }
    const wanted = new Set(requested as string[] | undefined);
    const summary = (tool: Tool) => ({ name: tool.name, description: tool.description?.trim().split(/\n\s*\n/)[0].replace(/\s+/g, " ").slice(0, 300) });
    return {
      ...base,
      connected,
      server: session.client.getServerVersion(),
      tools: session.tools.map((tool) => wanted.has(tool.name) ? tool : summary(tool)),
    };
  }

  /** Pass a call through to a discovered faust tool with its full content and errors (the blender_mcp_call contract). */
  async call(args: Arguments, signal?: AbortSignal): Promise<CallToolResult> {
    allowedArguments(args, ["tool_name", "arguments", "timeout_ms"]);
    const name = textArgument(args.tool_name, "tool_name");
    const toolArgs = args.arguments ?? {};
    if (!toolArgs || typeof toolArgs !== "object" || Array.isArray(toolArgs)) throw new FusionError("arguments must be an object.");
    const result = await this.invoke(name, toolArgs as Arguments, timeoutMilliseconds(args.timeout_ms), signal);
    return {
      ...result,
      structuredContent: {
        tool_name: name,
        isError: result.isError === true,
        text: resultText(result),
        ...(result.structuredContent ? { structured: result.structuredContent } : {}),
      },
    };
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
      "json.dumps({'mcp3d_new_design': True, 'name': doc.name, 'parametric': new_design.designType == adsk.fusion.DesignTypes.ParametricDesignType})",
    ].join("\n");
    const result = await this.invoke("execute_code", { code }, timeout, signal);
    if (result.isError) {
      if (noActiveDesign(result)) throw new FusionError(NO_ACTIVE_DESIGN_HELP);
      throw new FusionError(`Fusion could not create a design: ${resultText(result).slice(0, 600) || "no details"}`);
    }
    const created = executeCodeJson(result, "mcp3d_new_design");
    return { status: "success", design: String(created.name ?? ""), parametric: created.parametric === true };
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

    // Bodies and their bounding boxes in Fusion's internal centimetres.
    const probe = await this.invoke("execute_code", { code: [
      "import json",
      "bodies = []",
      "for comp in design.allComponents:",
      "    for b in comp.bRepBodies:",
      "        if b.isSolid and b.isVisible:",
      "            bb = b.boundingBox",
      "            bodies.append({'name': b.name, 'size_cm': [bb.maxPoint.x - bb.minPoint.x, bb.maxPoint.y - bb.minPoint.y, bb.maxPoint.z - bb.minPoint.z]})",
      "json.dumps({'mcp3d_bodies': True, 'bodies': bodies})",
    ].join("\n") }, deadline.remaining(), signal);
    if (probe.isError) {
      if (noActiveDesign(probe)) throw new FusionError(NO_ACTIVE_DESIGN_HELP);
      throw new FusionError(`Fusion could not list the design's bodies: ${resultText(probe).slice(0, 600) || "no details"}`);
    }
    const bodies = (executeCodeJson(probe, "mcp3d_bodies").bodies as { name: string; size_cm: number[] }[] | undefined) ?? [];
    const bodyName = args.body_name as string | undefined;
    const body = bodyName ? bodies.find((entry) => entry.name === bodyName) : bodies.length === 1 ? bodies[0] : undefined;
    if (!body) {
      if (bodyName) throw new FusionError(`No visible solid body named "${bodyName}". Visible bodies: ${bodies.map((entry) => entry.name).join(", ") || "none"}.`);
      throw new FusionError(bodies.length
        ? `The design has ${bodies.length} visible solid bodies (${bodies.map((entry) => entry.name).join(", ")}); pass body_name.`
        : "The design has no visible solid body to export.");
    }
    if (bodies.filter((entry) => entry.name === body.name).length > 1) throw new FusionError(`Several bodies are named "${body.name}"; rename them in Fusion so the export is unambiguous.`);

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
        status: "success",
        files: targets,
        body: body.name,
        triangles: metadata.triangles,
        bounding_box: metadata.bounding_box,
        stl_units: stlUnits,
        fusion_size_mm: body.size_cm.map((value) => Math.round(value * 10 * 1e4) / 1e4),
        parameter_count: Number(parameters.count ?? 0),
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

// ---- outputSchemas for the four Fusion tools ----

export const FUSION_STATUS_OUTPUT_SCHEMA = {
  type: "object",
  required: ["configured", "connected", "addinReachable", "fusionRunning", "tools"],
  properties: {
    configured: { type: "boolean" },
    connected: { type: "boolean" },
    addinReachable: { type: "boolean" },
    fusionRunning: { type: "boolean" },
    launched: { type: "boolean" },
    addin: { type: "string" },
    pinnedCommit: { type: "string" },
    server: { type: "object" },
    tools: { type: "array", items: { type: "object", required: ["name"], properties: { name: { type: "string" } } } },
  },
} as const;

export const FUSION_CALL_OUTPUT_SCHEMA = {
  type: "object",
  required: ["tool_name", "isError", "text"],
  properties: {
    tool_name: { type: "string" },
    isError: { type: "boolean" },
    text: { type: "string" },
    structured: { type: "object" },
  },
} as const;

export const FUSION_NEW_DESIGN_OUTPUT_SCHEMA = {
  type: "object",
  required: ["status", "design", "parametric"],
  properties: { status: { type: "string" }, design: { type: "string" }, parametric: { type: "boolean" } },
} as const;

export const FUSION_EXPORT_OUTPUT_SCHEMA = {
  type: "object",
  required: ["status", "files", "body", "triangles", "bounding_box", "stl_units"],
  properties: {
    status: { type: "string" },
    files: {
      type: "object",
      required: ["stl", "f3d", "parameters"],
      properties: { stl: { type: "string" }, f3d: { type: "string" }, parameters: { type: "string" } },
    },
    body: { type: "string" },
    triangles: { type: "number" },
    bounding_box: { type: "object" },
    stl_units: { type: "string", enum: ["mm", "cm", "unknown"] },
    fusion_size_mm: { type: "array", items: { type: "number" } },
    parameter_count: { type: "number" },
    warnings: { type: "array", items: { type: "string" } },
  },
} as const;
