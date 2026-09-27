import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { ErrorCode, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { exec, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);
const MAX_STL_BYTES = 256 * 1024 * 1024;
const RECEIPT_PREFIX = "BAMBU_STL_RESULT:";
type Arguments = Record<string, unknown>;
type Operation = { type: "decimate"; ratio: number } | { type: "remesh"; voxelSize: number } | { type: "boolean_union"; path: string };
type EditPlan = { requestId: string; stlPath: string; outputPath: string; stagedOutputPath: string; operations: Operation[] };
type Session = { client: Client; tools: Tool[]; options: () => { signal: AbortSignal; timeout: number }; markDispatched: () => void };

class BlenderError extends Error {}

class ClosingStdioTransport extends StdioClientTransport {
  private closing?: Promise<void>;

  override close(): Promise<void> {
    // Client.connect starts a non-awaited close on handshake failure. The SDK
    // clears its process reference immediately, so later close calls otherwise
    // return before that first cleanup has finished.
    return this.closing ??= super.close();
  }
}

function argumentObject(value: unknown, label: string): Arguments {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BlenderError(`${label} must be an object.`);
  return value as Arguments;
}

function allowedArguments(args: Arguments, names: string[]): void {
  if (Object.keys(args).some((name) => !names.includes(name))) {
    throw new BlenderError("Unknown Blender argument. Executables and their arguments must be configured on the server with BLENDER_MCP_COMMAND and BLENDER_MCP_ARGS.");
  }
}

function textArgument(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new BlenderError(`${label} must be a non-empty string without NUL characters.`);
  return value;
}

function booleanArgument(value: unknown, label: string, fallback = false): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new BlenderError(`${label} must be a boolean.`);
  return value;
}

function timeoutMilliseconds(value: unknown): number {
  const timeout = value ?? (process.env.BLENDER_MCP_TIMEOUT_MS ? Number(process.env.BLENDER_MCP_TIMEOUT_MS) : 120_000);
  if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 100 || timeout > 300_000) {
    throw new BlenderError("timeout_ms / BLENDER_MCP_TIMEOUT_MS must be an integer from 100 to 300000.");
  }
  return timeout;
}

function standardConfiguration(): { command: string; args: string[] } {
  const command = process.env.BLENDER_MCP_COMMAND?.trim();
  if (!command) throw new BlenderError("No Blender MCP server configured. Set BLENDER_MCP_COMMAND to an executable and BLENDER_MCP_ARGS to a JSON string array (for example uvx and [\"blender-mcp\"]). Start the matching addon in Blender.");
  let args: unknown;
  try { args = JSON.parse(process.env.BLENDER_MCP_ARGS?.trim() || "[]"); }
  catch { throw new BlenderError("BLENDER_MCP_ARGS must be a JSON array of strings, not a shell command."); }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
    throw new BlenderError("BLENDER_MCP_ARGS must be a JSON array of strings without NUL characters.");
  }
  if (command.includes("\0")) throw new BlenderError("BLENDER_MCP_COMMAND must be an executable without NUL characters.");
  return { command, args };
}

function blenderEnvironment(): Record<string, string> {
  // Blender needs its connection/settings, not printer access codes or other server secrets.
  const env = getDefaultEnvironment();
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("BLENDER_") && value !== undefined && !["BLENDER_MCP_COMMAND", "BLENDER_MCP_ARGS", "BLENDER_MCP_BRIDGE_COMMAND"].includes(key)) env[key] = value;
  }
  return env;
}

function normalizeToolFailure(result: CallToolResult): CallToolResult {
  if (result.isError) return result;
  const failureObject = (value: unknown): boolean => Boolean(value && typeof value === "object" &&
    ((value as Arguments).error || (value as Arguments).status === "error" || (value as Arguments).success === false));
  // Common Blender MCP releases catch addon errors and return ordinary text with isError unset.
  const failed = failureObject(result.structuredContent) || result.content.some((entry) => {
    if (entry.type !== "text") return false;
    if (/^\s*(?:Error(?:\s[^:\n]*)?:|Rejected by safe mode\b)/i.test(entry.text)) return true;
    try { return failureObject(JSON.parse(entry.text)); } catch { return false; }
  });
  return failed ? { ...result, isError: true } : result;
}

async function regularStl(filePath: string): Promise<{ bytes: number; triangles: number }> {
  const stat = await fs.lstat(filePath).catch(() => { throw new BlenderError("STL file does not exist or is not readable."); });
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_STL_BYTES) throw new BlenderError("STL must be a non-empty regular file of at most 256 MiB.");
  const buffer = await fs.readFile(filePath);
  let geometry;
  try {
    geometry = new STLLoader().parse(Uint8Array.from(buffer).buffer);
    const positions = geometry.getAttribute("position");
    if (!positions || positions.count < 3 || positions.count % 3 !== 0 || !Array.from(positions.array).every(Number.isFinite)) throw new Error("invalid vertices");
    return { bytes: stat.size, triangles: positions.count / 3 };
  } catch { throw new BlenderError("STL contains no valid finite triangle mesh."); }
  finally { geometry?.dispose(); }
}

async function inputPath(value: unknown, label: string): Promise<string> {
  const filePath = path.resolve(textArgument(value, label));
  if (path.extname(filePath).toLowerCase() !== ".stl") throw new BlenderError(`${label} must name an STL file.`);
  const resolved = await fs.realpath(filePath).catch(() => { throw new BlenderError(`${label} does not exist.`); });
  await regularStl(resolved);
  return resolved;
}

async function editPlan(args: Arguments): Promise<EditPlan> {
  const stlPath = await inputPath(args.stl_path, "stl_path");
  const requestedOutput = path.resolve(textArgument(args.output_path, "output_path"));
  if (path.extname(requestedOutput).toLowerCase() !== ".stl") throw new BlenderError("output_path must name a new STL file.");
  const directory = await fs.realpath(path.dirname(requestedOutput)).catch(() => { throw new BlenderError("output_path parent directory must already exist."); });
  const outputPath = path.join(directory, path.basename(requestedOutput));
  const existing = await fs.lstat(outputPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw new BlenderError("output_path cannot be accessed.");
    return undefined;
  });
  if (existing) throw new BlenderError("output_path already exists; choose a new file. Input files are never overwritten.");
  const operations: Operation[] = [];
  for (const operation of args.operations as string[]) {
    const separator = operation.indexOf(":");
    const type = operation.slice(0, separator);
    const value = operation.slice(separator + 1);
    if (separator > 0 && type === "boolean_union") {
      operations.push({ type, path: await inputPath(value, "boolean_union operand") });
    } else if (separator > 0 && type === "decimate" && value.trim() && Number.isFinite(Number(value)) && Number(value) > 0 && Number(value) <= 1) {
      operations.push({ type, ratio: Number(value) });
    } else if (separator > 0 && type === "remesh" && value.trim() && Number.isFinite(Number(value)) && Number(value) > 0) {
      operations.push({ type, voxelSize: Number(value) });
    } else {
      throw new BlenderError("Unsupported edit operation. Use decimate:<ratio 0..1>, remesh:<positive voxel size in STL units>, or boolean_union:<STL path>. Use blender_mcp_call for other Blender capabilities.");
    }
  }
  const requestId = randomUUID();
  return { requestId, stlPath, outputPath, stagedOutputPath: path.join(directory, `.bambu-${requestId}.stl`), operations };
}

function editScript(plan: EditPlan): string {
  // JSON is data, never interpolated Python syntax. The comment is also useful in dry runs.
  return `# BAMBU_EDIT_PLAN ${JSON.stringify(plan)}
import bpy
import json

def _bambu_edit():
    plan = json.loads(${JSON.stringify(JSON.stringify(plan))})
    if bpy.context.mode != 'OBJECT':
        raise RuntimeError('Switch Blender to Object Mode before editing an STL')
    objects_before = set(bpy.data.objects)
    meshes_before = set(bpy.data.meshes)
    selected_before = list(bpy.context.selected_objects)
    active_before = bpy.context.view_layer.objects.active

    def select_only(objects):
        for obj in list(bpy.context.selected_objects):
            obj.select_set(False)
        for obj in objects:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = objects[0]

    def import_stl(filepath):
        before = set(bpy.data.objects)
        if bpy.app.version >= (4, 0, 0):
            bpy.ops.wm.stl_import(filepath=filepath, global_scale=1.0, use_scene_unit=False, forward_axis='Y', up_axis='Z')
        else:
            bpy.ops.import_mesh.stl(filepath=filepath, global_scale=1.0, use_scene_unit=False, axis_forward='Y', axis_up='Z')
        imported = [obj for obj in bpy.data.objects if obj not in before and obj.type == 'MESH']
        if not imported:
            raise RuntimeError('STL import produced no mesh objects')
        select_only(imported)
        if len(imported) > 1:
            bpy.ops.object.join()
        return bpy.context.view_layer.objects.active

    try:
        target = import_stl(plan['stlPath'])
        for operation in plan['operations']:
            operand = None
            if operation['type'] == 'boolean_union':
                operand = import_stl(operation['path'])
            select_only([target])
            if operation['type'] == 'decimate':
                modifier = target.modifiers.new('Bambu decimate', 'DECIMATE')
                modifier.ratio = operation['ratio']
            elif operation['type'] == 'remesh':
                modifier = target.modifiers.new('Bambu remesh', 'REMESH')
                modifier.mode = 'VOXEL'
                modifier.voxel_size = operation['voxelSize']
            else:
                modifier = target.modifiers.new('Bambu union', 'BOOLEAN')
                modifier.operation = 'UNION'
                modifier.solver = 'EXACT'
                modifier.object = operand
            bpy.ops.object.modifier_apply(modifier=modifier.name)
            if operand is not None:
                bpy.data.objects.remove(operand, do_unlink=True)
        if len(target.data.polygons) == 0:
            raise RuntimeError('Edits produced an empty mesh')
        select_only([target])
        if bpy.app.version >= (4, 0, 0):
            result = bpy.ops.wm.stl_export(filepath=plan['stagedOutputPath'], check_existing=False, export_selected_objects=True, global_scale=1.0, use_scene_unit=False, forward_axis='Y', up_axis='Z', apply_modifiers=True)
        else:
            result = bpy.ops.export_mesh.stl(filepath=plan['stagedOutputPath'], check_existing=False, use_selection=True, global_scale=1.0, use_scene_unit=False, axis_forward='Y', axis_up='Z', use_mesh_modifiers=True)
        if 'FINISHED' not in result:
            raise RuntimeError('STL export did not finish')
    finally:
        for obj in list(bpy.data.objects):
            if obj not in objects_before:
                bpy.data.objects.remove(obj, do_unlink=True)
        for mesh in list(bpy.data.meshes):
            if mesh not in meshes_before and mesh.users == 0:
                bpy.data.meshes.remove(mesh)
        for obj in selected_before:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = active_before
    print('${RECEIPT_PREFIX}' + json.dumps({'requestId': plan['requestId'], 'outputPath': plan['stagedOutputPath']}))

_bambu_edit()
del _bambu_edit
`;
}

export class BlenderMcpBridge {
  private async session<T>(timeout: number, signal: AbortSignal | undefined, work: (session: Session) => Promise<T>): Promise<T> {
    const config = standardConfiguration();
    const client = new Client({ name: "mcp-3d-printer-server-blender", version: "1.0.0" });
    const transport = new ClosingStdioTransport({ ...config, env: blenderEnvironment(), stderr: "pipe" });
    // Drain stderr without relaying arbitrary logs or credentials into the outer MCP stream.
    transport.stderr?.on("data", () => {});
    const controller = new AbortController();
    let timedOut = false;
    let phase = "initialization";
    let dispatched = false;
    const deadline = Date.now() + timeout;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    const options = () => ({ signal: controller.signal, timeout: Math.max(1, deadline - Date.now()) });
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
        if (cursor && (cursors.has(cursor) || cursors.size >= 99)) throw new BlenderError("Blender MCP returned an invalid or excessive tools/list pagination sequence.");
        if (cursor) cursors.add(cursor);
      } while (cursor);
      phase = "tool request";
      // A request may already have reached Blender when an interruption occurs. Never retry it here.
      return await work({ client, tools, options, markDispatched: () => { dispatched = true; } });
    } catch (error) {
      if (error instanceof BlenderError) throw error;
      const code = (error as { code?: unknown })?.code;
      if (timedOut || code === ErrorCode.RequestTimeout) {
        throw new BlenderError(`Blender MCP timed out during ${phase}.${dispatched ? " Execution status is unknown; inspect Blender before retrying. The request was not replayed." : " Check the configured server command and Blender addon connection."}`);
      }
      if (controller.signal.aborted) throw new BlenderError(`Blender MCP request cancelled.${dispatched ? " Execution may still be running in Blender; inspect it before retrying." : ""}`);
      // Error messages from processes/RPC peers may contain arguments, code, or credentials.
      const safeCode = typeof code === "number" ? ` (RPC ${code})` : ["ENOENT", "EACCES"].includes(String(code)) ? ` (${code})` : "";
      throw new BlenderError(`Blender MCP failed during ${phase}${safeCode}. Check BLENDER_MCP_COMMAND, BLENDER_MCP_ARGS and the running Blender addon.`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }
  }

  private async invoke(session: Session, name: string, args: Arguments): Promise<CallToolResult> {
    const tool = session.tools.find((tool) => tool.name === name);
    if (!tool) throw new BlenderError("The requested tool is not advertised by Blender MCP. Call blender_mcp_status with connect:true to inspect available tools.");
    let valid: boolean;
    try { valid = new AjvJsonSchemaValidator().getValidator(tool.inputSchema)(args).valid; }
    catch { throw new BlenderError("Blender MCP advertised an unsupported input schema for this tool."); }
    if (!valid) throw new BlenderError("Blender tool arguments do not match its advertised input schema. Inspect blender_mcp_status before calling the tool.");
    session.markDispatched();
    return normalizeToolFailure(await session.client.callTool({ name, arguments: args }, undefined, session.options()) as CallToolResult);
  }

  async status(args: Arguments, signal?: AbortSignal): Promise<unknown> {
    allowedArguments(args, ["connect", "timeout_ms"]);
    const connect = booleanArgument(args.connect, "connect");
    const timeout = timeoutMilliseconds(args.timeout_ms);
    if (!connect) return { configured: Boolean(process.env.BLENDER_MCP_COMMAND?.trim()), legacy_configured: Boolean(process.env.BLENDER_MCP_BRIDGE_COMMAND?.trim()), connected: false, transport: "stdio" };
    return this.session(timeout, signal, async ({ client, tools }) => ({ configured: true, connected: true, transport: "stdio", server: client.getServerVersion(), capabilities: client.getServerCapabilities(), tools }));
  }

  async call(args: Arguments, signal?: AbortSignal): Promise<CallToolResult> {
    allowedArguments(args, ["tool_name", "arguments", "timeout_ms"]);
    const name = textArgument(args.tool_name, "tool_name");
    const toolArgs = argumentObject(args.arguments ?? {}, "arguments");
    return this.session(timeoutMilliseconds(args.timeout_ms), signal, (session) => this.invoke(session, name, toolArgs));
  }

  async edit(args: Arguments, legacyCommand?: string, signal?: AbortSignal): Promise<unknown> {
    allowedArguments(args, ["stl_path", "operations", "output_path", "user_prompt", "execute", "bridge_command", "timeout_ms"]);
    const stlPath = textArgument(args.stl_path, "stl_path");
    if (!Array.isArray(args.operations) || args.operations.length === 0 || args.operations.length > 64 || args.operations.some((entry) => typeof entry !== "string" || !entry.trim() || entry.includes("\0"))) throw new BlenderError("operations must contain 1 to 64 non-empty strings.");
    const execute = booleanArgument(args.execute, "execute");
    const timeout = timeoutMilliseconds(args.timeout_ms);
    if (args.user_prompt !== undefined && typeof args.user_prompt !== "string") throw new BlenderError("user_prompt must be a string.");
    const command = legacyCommand || (!process.env.BLENDER_MCP_COMMAND?.trim() ? process.env.BLENDER_MCP_BRIDGE_COMMAND?.trim() : undefined);
    if (command || !process.env.BLENDER_MCP_COMMAND?.trim()) {
      const payload = { stlPath, modelPath: stlPath, source: "mcp-3d-printer-server", operations: args.operations, ...(args.output_path !== undefined ? { outputPath: textArgument(args.output_path, "output_path") } : {}) };
      if (!execute) return { status: "prepared", mode: "legacy", bridgeCommand: command ?? null, payload, note: "Legacy bridge payload only. Configure BLENDER_MCP_COMMAND and BLENDER_MCP_ARGS for standard MCP, or BLENDER_MCP_BRIDGE_COMMAND for a custom executable." };
      if (!command) throw new BlenderError("No Blender connection configured. Set BLENDER_MCP_COMMAND and BLENDER_MCP_ARGS, or a legacy BLENDER_MCP_BRIDGE_COMMAND executable.");
      await inputPath(stlPath, "stl_path");
      let output;
      try {
        const serialized = JSON.stringify(payload);
        const options = { env: { ...process.env, MCP_BLENDER_PAYLOAD: serialized }, timeout, signal, maxBuffer: 8 * 1024 * 1024 };
        // Preserve this server's trusted legacy shell-command + stdin contract.
        // Bare executable paths (including spaces) also work as in the Bambu fork.
        const isFile = await fs.stat(command).then((stat) => stat.isFile(), () => false);
        const pending = isFile ? execFileAsync(command, [], options) : execAsync(command, options);
        pending.child.stdin?.on("error", () => {});
        pending.child.stdin?.end(serialized);
        output = await pending;
      }
      catch { throw new BlenderError("Legacy Blender bridge failed, timed out, or was cancelled. Check its executable and logs; execution may have partially completed."); }
      let parsed: any;
      try { parsed = JSON.parse(output.stdout); } catch { /* Legacy executables may return plain text. */ }
      if (parsed?.isError === true || parsed?.ok === false || parsed?.success === false || parsed?.status === "error" || /^\s*(Error\b|Traceback\b)/i.test(output.stdout)) throw new BlenderError("Legacy Blender bridge reported an error; no edited output was verified.");
      return { status: "executed", mode: "legacy", output_verified: false, stdout: output.stdout.trim(), stderr: output.stderr.trim(), ...(parsed !== undefined ? { bridge_result: parsed } : {}) };
    }
    const plan = await editPlan(args);
    const code = editScript(plan);
    if (!execute) return { status: "prepared", mode: "mcp", output_path: plan.outputPath, payload: plan, code };
    try {
      const result = await this.session(timeout, signal, (session) => this.invoke(session, "execute_blender_code", { code, user_prompt: args.user_prompt ?? "" }));
      if (result.isError) throw new BlenderError("Blender MCP reported an editing error. No output was published.");
      const text = result.content.filter((entry) => entry.type === "text").map((entry) => entry.text).join("\n");
      const receipts = [...text.matchAll(/BAMBU_STL_RESULT:(\{[^\n]*\})/g)];
      let receipt: any;
      try { receipt = JSON.parse(receipts.at(-1)?.[1] ?? "null"); } catch { /* Invalid receipt is a failure. */ }
      if (receipt?.requestId !== plan.requestId || receipt?.outputPath !== plan.stagedOutputPath) throw new BlenderError("Blender did not return a matching export receipt. Inspect its connection and tool result; no output was published.");
      const metadata = await regularStl(plan.stagedOutputPath);
      // link() publishes without replacing a file created since preflight; staging is on the same filesystem.
      await fs.link(plan.stagedOutputPath, plan.outputPath).catch(() => { throw new BlenderError("Cannot publish the edited STL; output_path may already exist or be unwritable."); });
      return { status: "success", mode: "mcp", output_path: plan.outputPath, ...metadata, output_verified: true, blender_result: result };
    } finally {
      await fs.rm(plan.stagedOutputPath, { force: true }).catch(() => {});
    }
  }
}
