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
const MAX_ASCII_STL_BYTES = 4 * 1024 * 1024;
const RECEIPT_PREFIX = "BAMBU_STL_RESULT:";
const EXPORT_RECEIPT_PREFIX = "MCP3D_STL_EXPORT:";
type Arguments = Record<string, unknown>;
type Operation = { type: "decimate"; ratio: number } | { type: "remesh"; voxelSize: number } | { type: "boolean_union"; path: string };
type EditPlan = { requestId: string; stlPath: string; outputPath: string; stagedOutputPath: string; operations: Operation[] };
type Session = { client: Client; tools: Tool[]; options: () => { signal: AbortSignal; timeout: number }; markDispatched: () => void };
type EditDeadline = { check: () => void; remaining: () => number };
type ExportPlan = { requestId: string; objectNames: string[]; outputPath: string; stagedOutputPath: string; applyModifiers: boolean; scale: number };
type BoundingBox = { min: [number, number, number]; max: [number, number, number]; dimensions: [number, number, number] };
type StlMetadata = { bytes: number; triangles: number; bounding_box: BoundingBox };

class BlenderError extends Error {}

function editDeadline(timeout: number, signal?: AbortSignal): EditDeadline {
  const deadline = performance.now() + timeout;
  const check = () => {
    if (signal?.aborted) throw new BlenderError("Blender edit cancelled. If execution started, inspect Blender before retrying.");
    if (performance.now() >= deadline) throw new BlenderError("Blender edit timed out. If execution started, inspect Blender before retrying.");
  };
  return { check, remaining: () => { check(); return Math.max(1, Math.ceil(deadline - performance.now())); } };
}

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
  if (!command) throw new BlenderError("No Blender MCP server configured. Set BLENDER_MCP_COMMAND to an executable and BLENDER_MCP_ARGS to a JSON string array (for example uvx and [\"mcp-for-blender\"]; the older blender-mcp package name still works). Open Blender with the matching addon connected; the addon does not run in background mode.");
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

function boundingBox(min: number[], max: number[]): BoundingBox {
  const round = (value: number) => Math.round(value * 1e4) / 1e4;
  return {
    min: [round(min[0]), round(min[1]), round(min[2])],
    max: [round(max[0]), round(max[1]), round(max[2])],
    dimensions: [round(max[0] - min[0]), round(max[1] - min[1]), round(max[2] - min[2])],
  };
}

async function regularStl(filePath: string, deadline: EditDeadline): Promise<StlMetadata> {
  deadline.check();
  const stat = await fs.lstat(filePath).catch(() => { throw new BlenderError("STL file does not exist or is not readable."); });
  deadline.check();
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_STL_BYTES) throw new BlenderError("STL must be a non-empty regular file of at most 256 MiB.");
  const file = await fs.open(filePath, "r");
  let geometry;
  try {
    // Read a fixed number of bytes, even if the file grows during validation.
    const read = async (buffer: Buffer, position: number, length = buffer.length): Promise<void> => {
      let offset = 0;
      while (offset < length) {
        deadline.check();
        const { bytesRead } = await file.read(buffer, offset, length - offset, position + offset);
        deadline.check();
        if (!bytesRead) throw new Error("truncated STL");
        offset += bytesRead;
      }
    };
    const current = await file.stat();
    if (!current.isFile() || current.size !== stat.size) throw new Error("STL changed during validation");
    const header = Buffer.alloc(Math.min(84, stat.size));
    await read(header, 0);
    const triangles = header.length === 84 ? header.readUInt32LE(80) : 0;
    if (triangles > 0 && 84 + triangles * 50 === stat.size) {
      // Validate binary records directly; constructing a Three.js geometry would
      // expand a 256 MiB input into hundreds of MiB of positions/normals/colors.
      const chunk = Buffer.alloc(50 * 1024);
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (let position = 84; position < stat.size; position += chunk.length) {
        const length = Math.min(chunk.length, stat.size - position);
        await read(chunk, position, length);
        for (let face = 0; face < length; face += 50) {
          for (let coordinate = 12; coordinate < 48; coordinate += 4) {
            const value = chunk.readFloatLE(face + coordinate);
            if (!Number.isFinite(value)) throw new Error("invalid vertices");
            const axis = ((coordinate - 12) / 4) % 3;
            if (value < min[axis]) min[axis] = value;
            if (value > max[axis]) max[axis] = value;
          }
        }
      }
      deadline.check();
      return { bytes: stat.size, triangles, bounding_box: boundingBox(min, max) };
    }
    // Reject malformed binary headers before a parser can allocate arrays from
    // an untrusted triangle count. ASCII parsing has its own smaller bound.
    // Match STLLoader's ASCII detection, including short prefixes/BOMs and the
    // common "solidName" spelling, so it cannot fall back to binary allocation.
    if (![0, 1, 2, 3, 4].some((offset) => header.toString("latin1", offset, offset + 5) === "solid")) throw new Error("invalid STL header");
    if (stat.size > MAX_ASCII_STL_BYTES) throw new BlenderError("ASCII STL files must be at most 4 MiB; export binary STL for larger meshes.");
    const buffer = Buffer.alloc(stat.size);
    await read(buffer, 0);
    if (!buffer.subarray(0, header.length).equals(header)) throw new Error("STL changed during validation");
    geometry = new STLLoader().parse(buffer.buffer as ArrayBuffer);
    const positions = geometry.getAttribute("position");
    if (!positions || positions.count < 3 || positions.count % 3 !== 0 || !positions.array.every(Number.isFinite)) throw new Error("invalid vertices");
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    deadline.check();
    return { bytes: stat.size, triangles: positions.count / 3, bounding_box: boundingBox(box.min.toArray(), box.max.toArray()) };
  } catch (error) {
    if (error instanceof BlenderError) throw error;
    throw new BlenderError("STL contains no valid finite triangle mesh.");
  } finally {
    geometry?.dispose();
    await file.close();
  }
}

async function inputPath(value: unknown, label: string, deadline: EditDeadline): Promise<string> {
  deadline.check();
  const filePath = path.resolve(textArgument(value, label));
  if (path.extname(filePath).toLowerCase() !== ".stl") throw new BlenderError(`${label} must name an STL file.`);
  const resolved = await fs.realpath(filePath).catch(() => { throw new BlenderError(`${label} does not exist.`); });
  await regularStl(resolved, deadline);
  return resolved;
}

async function editPlan(args: Arguments, deadline: EditDeadline): Promise<EditPlan> {
  const stlPath = await inputPath(args.stl_path, "stl_path", deadline);
  const { outputPath, directory } = await newStlOutput(args.output_path ?? path.join(path.dirname(stlPath), `model-edited-${randomUUID()}.stl`), deadline);
  const operations: Operation[] = [];
  for (const operation of args.operations as string[]) {
    deadline.check();
    const separator = operation.indexOf(":");
    const type = operation.slice(0, separator);
    const value = operation.slice(separator + 1);
    if (separator > 0 && type === "boolean_union") {
      operations.push({ type, path: await inputPath(value, "boolean_union operand", deadline) });
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

async function newStlOutput(value: unknown, deadline: EditDeadline): Promise<{ outputPath: string; directory: string }> {
  deadline.check();
  const requestedOutput = path.resolve(textArgument(value, "output_path"));
  if (path.extname(requestedOutput).toLowerCase() !== ".stl") throw new BlenderError("output_path must name a new STL file.");
  const directory = await fs.realpath(path.dirname(requestedOutput)).catch(() => { throw new BlenderError("output_path parent directory must already exist."); });
  const outputPath = path.join(directory, path.basename(requestedOutput));
  const existing = await fs.lstat(outputPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw new BlenderError("output_path cannot be accessed.");
    return undefined;
  });
  if (existing) throw new BlenderError("output_path already exists; choose a new file. Existing files are never overwritten.");
  return { outputPath, directory };
}

async function exportPlan(args: Arguments, deadline: EditDeadline): Promise<ExportPlan> {
  const names = args.object_names;
  if (!Array.isArray(names) || names.length === 0 || names.length > 64 ||
      names.some((name) => typeof name !== "string" || !name.trim() || name.length > 256 || name.includes("\0")) ||
      new Set(names).size !== names.length) {
    throw new BlenderError("object_names must list 1 to 64 distinct Blender object names.");
  }
  const scale = args.scale ?? 1;
  if (typeof scale !== "number" || !Number.isFinite(scale) || scale <= 0 || scale > 1_000_000) throw new BlenderError("scale must be a finite number greater than 0.");
  const { outputPath, directory } = await newStlOutput(args.output_path, deadline);
  const requestId = randomUUID();
  return { requestId, objectNames: names as string[], outputPath, stagedOutputPath: path.join(directory, `.mcp3d-${requestId}.stl`),
    applyModifiers: booleanArgument(args.apply_modifiers, "apply_modifiers", true), scale };
}

function exportScript(plan: ExportPlan): string {
  // Writes world-space triangles directly instead of calling an exporter, so the
  // user's selection, active object and mode are never changed. JSON is data only.
  return `# MCP3D_EXPORT_PLAN ${JSON.stringify(plan)}
import bpy
import json
import math
import os
import struct

def _mcp3d_export():
    plan = json.loads(${JSON.stringify(JSON.stringify(plan))})
    if bpy.context.mode != 'OBJECT':
        raise RuntimeError('Switch Blender to Object Mode before exporting an STL')
    objects = []
    for name in plan['objectNames']:
        obj = bpy.data.objects.get(name)
        if obj is None:
            raise RuntimeError('No Blender object named ' + json.dumps(name))
        if obj.type not in {'MESH', 'CURVE', 'SURFACE', 'META', 'FONT'}:
            raise RuntimeError(json.dumps(name) + ' is a ' + obj.type + ' object, not printable geometry')
        if not plan['applyModifiers'] and obj.type != 'MESH':
            raise RuntimeError(json.dumps(name) + ' needs apply_modifiers to be converted to a mesh')
        objects.append(obj)
    depsgraph = bpy.context.evaluated_depsgraph_get()
    scale = float(plan['scale'])
    lower = [math.inf] * 3
    upper = [-math.inf] * 3
    triangles = 0
    exported = []
    finished = False
    try:
        with open(plan['stagedOutputPath'], 'xb') as handle:
            handle.write(b'mcp-3d-printer-server Blender STL export'.ljust(80, b' '))
            handle.write(struct.pack('<I', 0))
            for obj in objects:
                evaluated = obj.evaluated_get(depsgraph)
                matrix = evaluated.matrix_world
                owner = evaluated if plan['applyModifiers'] else None
                mesh = evaluated.to_mesh() if owner else obj.data.copy()
                try:
                    mesh.calc_loop_triangles()
                    mirrored = matrix.determinant() < 0
                    count = 0
                    for tri in mesh.loop_triangles:
                        points = [matrix @ mesh.vertices[index].co * scale for index in tri.vertices]
                        if mirrored:
                            points = [points[0], points[2], points[1]]
                        for point in points:
                            for axis in range(3):
                                value = point[axis]
                                if not math.isfinite(value):
                                    raise RuntimeError('Non-finite vertex in ' + json.dumps(obj.name))
                                lower[axis] = min(lower[axis], value)
                                upper[axis] = max(upper[axis], value)
                        normal = (points[1] - points[0]).cross(points[2] - points[0])
                        normal = normal.normalized() if normal.length > 0 else normal
                        handle.write(struct.pack('<12fH', *normal, *points[0], *points[1], *points[2], 0))
                        count += 1
                    triangles += count
                    exported.append({'name': obj.name, 'type': obj.type, 'triangles': count})
                finally:
                    if owner:
                        owner.to_mesh_clear()
                    else:
                        bpy.data.meshes.remove(mesh)
            if triangles == 0:
                raise RuntimeError('The selected objects contain no triangles')
            handle.seek(80)
            handle.write(struct.pack('<I', triangles))
        finished = True
    finally:
        if not finished and os.path.exists(plan['stagedOutputPath']):
            os.remove(plan['stagedOutputPath'])
    units = bpy.context.scene.unit_settings
    print('${EXPORT_RECEIPT_PREFIX}' + json.dumps({'requestId': plan['requestId'], 'outputPath': plan['stagedOutputPath'],
        'triangles': triangles, 'min': lower, 'max': upper, 'objects': exported,
        'sceneUnits': {'system': units.system, 'scaleLength': units.scale_length, 'lengthUnit': units.length_unit}}))

_mcp3d_export()
del _mcp3d_export
`;
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
    if (!valid) throw new BlenderError("Blender tool arguments do not match its advertised input schema. Call blender_mcp_status with connect: true and tool_names: [\"<tool>\"] to read the schema.");
    session.markDispatched();
    return normalizeToolFailure(await session.client.callTool({ name, arguments: args }, undefined, session.options()) as CallToolResult);
  }

  async status(args: Arguments, signal?: AbortSignal): Promise<unknown> {
    allowedArguments(args, ["connect", "timeout_ms", "tool_names", "include_schemas"]);
    const connect = booleanArgument(args.connect, "connect");
    const timeout = timeoutMilliseconds(args.timeout_ms);
    const includeSchemas = booleanArgument(args.include_schemas, "include_schemas");
    const requested = args.tool_names;
    if (requested !== undefined && (!Array.isArray(requested) || requested.length > 64 || requested.some((name) => typeof name !== "string" || !name.trim()))) {
      throw new BlenderError("tool_names must be an array of up to 64 tool names.");
    }
    if (!connect) return { configured: Boolean(process.env.BLENDER_MCP_COMMAND?.trim()), legacy_configured: Boolean(process.env.BLENDER_MCP_BRIDGE_COMMAND?.trim()), connected: false, transport: "stdio" };
    return this.session(timeout, signal, async ({ client, tools }) => {
      // Full Blender MCP schemas are tens of kilobytes; list names by default and
      // return complete definitions only for the tools an agent is about to call.
      const wanted = new Set(requested as string[] | undefined);
      const unknown = [...wanted].filter((name) => !tools.some((tool) => tool.name === name));
      const summary = (tool: Tool) => ({ name: tool.name, description: tool.description?.trim().split(/\n\s*\n/)[0].replace(/\s+/g, " ").slice(0, 300) });
      return {
        configured: true, connected: true, transport: "stdio", server: client.getServerVersion(), capabilities: client.getServerCapabilities(),
        tools: tools.map((tool) => includeSchemas || wanted.has(tool.name) ? tool : summary(tool)),
        schemas_included: includeSchemas ? "all" : [...wanted].filter((name) => !unknown.includes(name)),
        ...(unknown.length ? { unknown_tool_names: unknown } : {}),
        note: "Pass tool_names (or include_schemas: true) to receive full input schemas. Verified STL export: blender_mcp_export_stl.",
      };
    });
  }

  async exportStl(args: Arguments, signal?: AbortSignal): Promise<unknown> {
    allowedArguments(args, ["object_names", "output_path", "apply_modifiers", "scale", "user_prompt", "timeout_ms"]);
    const timeout = timeoutMilliseconds(args.timeout_ms);
    const deadline = editDeadline(timeout, signal);
    if (args.user_prompt !== undefined && typeof args.user_prompt !== "string") throw new BlenderError("user_prompt must be a string.");
    standardConfiguration();
    const plan = await exportPlan(args, deadline);
    const code = exportScript(plan);
    try {
      const result = await this.session(deadline.remaining(), signal, (session) => this.invoke(session, "execute_blender_code", { code, user_prompt: args.user_prompt ?? "" }));
      if (result.isError) {
        const detail = result.content.filter((entry) => entry.type === "text").map((entry) => entry.text).join("\n");
        // mcp-for-blender wraps the Python exception as JSON; lead with its message.
        let reason = "";
        try { reason = JSON.parse(`"${detail.match(/"message":\s*"((?:[^"\\]|\\.)*)"/)?.[1] ?? ""}"`); } catch { /* Fall back to the raw text. */ }
        throw new BlenderError(`Blender could not export the requested objects: ${reason || detail.slice(0, 600) || "no details"}. No output was published.`);
      }
      const text = result.content.filter((entry) => entry.type === "text").map((entry) => entry.text).join("\n");
      const receipts = [...text.matchAll(/MCP3D_STL_EXPORT:(\{[^\n]*\})/g)];
      let receipt: any;
      try { receipt = JSON.parse(receipts.at(-1)?.[1] ?? "null"); } catch { /* Invalid receipt is a failure. */ }
      if (receipt?.requestId !== plan.requestId || receipt?.outputPath !== plan.stagedOutputPath) throw new BlenderError("Blender did not return a matching export receipt. Inspect its connection and tool result; no output was published.");
      const metadata = await regularStl(plan.stagedOutputPath, deadline);
      if (metadata.triangles !== receipt.triangles) throw new BlenderError("The exported STL does not match Blender's export receipt; no output was published.");
      deadline.check();
      await fs.link(plan.stagedOutputPath, plan.outputPath).catch(() => { throw new BlenderError("Cannot publish the exported STL; output_path may already exist or be unwritable."); });
      const largest = Math.max(...metadata.bounding_box.dimensions);
      const warnings: string[] = [];
      if (largest < 1) warnings.push("The model is under 1 unit across. Slicers read STL coordinates as millimetres; if it was modelled in metres, export again with scale: 1000.");
      if (largest > 2000) warnings.push("The model is over 2000 units across. Slicers read STL coordinates as millimetres; check the scene units and scale.");
      return {
        status: "success", mode: "mcp", output_path: plan.outputPath, ...metadata, units: "STL coordinates (slicers treat 1 unit as 1 mm)",
        scale: plan.scale, objects: receipt.objects, scene_units: receipt.sceneUnits, output_verified: true, ...(warnings.length ? { warnings } : {}),
      };
    } finally {
      await fs.rm(plan.stagedOutputPath, { force: true }).catch(() => {});
    }
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
    const deadline = editDeadline(timeout, signal);
    deadline.check();
    if (args.user_prompt !== undefined && typeof args.user_prompt !== "string") throw new BlenderError("user_prompt must be a string.");
    const command = legacyCommand || (!process.env.BLENDER_MCP_COMMAND?.trim() ? process.env.BLENDER_MCP_BRIDGE_COMMAND?.trim() : undefined);
    if (command || !process.env.BLENDER_MCP_COMMAND?.trim()) {
      const payload = { stlPath, modelPath: stlPath, source: "mcp-3d-printer-server", operations: args.operations, ...(args.output_path !== undefined ? { outputPath: textArgument(args.output_path, "output_path") } : {}) };
      if (!execute) return { status: "prepared", mode: "legacy", bridgeCommand: command ?? null, payload, note: "Legacy bridge payload only. Configure BLENDER_MCP_COMMAND and BLENDER_MCP_ARGS for standard MCP, or BLENDER_MCP_BRIDGE_COMMAND for a custom executable." };
      if (!command) throw new BlenderError("No Blender connection configured. Set BLENDER_MCP_COMMAND and BLENDER_MCP_ARGS, or a legacy BLENDER_MCP_BRIDGE_COMMAND executable.");
      await inputPath(stlPath, "stl_path", deadline);
      let output;
      try {
        const serialized = JSON.stringify(payload);
        // Preserve this server's trusted legacy shell-command + stdin contract.
        // Bare executable paths (including spaces) also work as in the Bambu fork.
        const isFile = await fs.stat(command).then((stat) => stat.isFile(), () => false);
        const options = { env: { ...process.env, MCP_BLENDER_PAYLOAD: serialized }, timeout: deadline.remaining(), signal, maxBuffer: 8 * 1024 * 1024 };
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
    const plan = await editPlan(args, deadline);
    const code = editScript(plan);
    deadline.check();
    if (!execute) return { status: "prepared", mode: "mcp", output_path: plan.outputPath, payload: plan, code };
    try {
      const result = await this.session(deadline.remaining(), signal, (session) => this.invoke(session, "execute_blender_code", { code, user_prompt: args.user_prompt ?? "" }));
      if (result.isError) throw new BlenderError("Blender MCP reported an editing error. No output was published.");
      const text = result.content.filter((entry) => entry.type === "text").map((entry) => entry.text).join("\n");
      const receipts = [...text.matchAll(/BAMBU_STL_RESULT:(\{[^\n]*\})/g)];
      let receipt: any;
      try { receipt = JSON.parse(receipts.at(-1)?.[1] ?? "null"); } catch { /* Invalid receipt is a failure. */ }
      if (receipt?.requestId !== plan.requestId || receipt?.outputPath !== plan.stagedOutputPath) throw new BlenderError("Blender did not return a matching export receipt. Inspect its connection and tool result; no output was published.");
      const metadata = await regularStl(plan.stagedOutputPath, deadline);
      deadline.check();
      // link() publishes without replacing a file created since preflight; staging is on the same filesystem.
      await fs.link(plan.stagedOutputPath, plan.outputPath).catch(() => { throw new BlenderError("Cannot publish the edited STL; output_path may already exist or be unwritable."); });
      return { status: "success", mode: "mcp", output_path: plan.outputPath, ...metadata, output_verified: true, blender_result: result };
    } finally {
      await fs.rm(plan.stagedOutputPath, { force: true }).catch(() => {});
    }
  }
}
