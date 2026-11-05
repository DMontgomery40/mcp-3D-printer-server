/**
 * How Counterpart's remote endpoint (`/v1/mcp`) offers each tool to a paired device, declared by this server so a
 * new tool or argument needs no Counterpart release. Sent as each listed tool's `_meta["counterpart/remote"]`:
 *
 * - `scope`: the least device scope that may call the tool: read < design < control < print < raw. The table keeps
 *   the classes Counterpart gave these tools by hand before this version, so no paired device gained or lost a tool;
 *   `tests/tool-annotations.test.mjs` holds the name floors (a print start is at least print, a raw call raw).
 * - `raisedBy`: boolean arguments that, when true, need a higher scope (`launch` starts Fusion).
 * - `arguments`: argument names that are not plain values, matched at any depth of a call's arguments:
 *   `config`: this server's configuration chooses it (the printer it targets, its account, hardware and programs),
 *   so a device may not set it; `config-top`: the same, as a top-level argument only (`type`, the printer type);
 *   `path`: a local file or folder the tool reads; `output`: one it writes. Any other argument is a plain value.
 *   A tool that forwards an open object (an arbitrary RPC payload or another server's tool arguments) declares every
 *   configuration name, since any of them may appear inside it.
 */
export type RemoteScope = "read" | "design" | "control" | "print" | "raw";
export type ArgumentKind = "config" | "config-top" | "path" | "output";
export interface RemoteDeclaration {
  scope: RemoteScope;
  raisedBy?: Record<string, RemoteScope>;
  arguments?: Record<string, ArgumentKind>;
}
export const REMOTE_META_KEY = "counterpart/remote";

export const REMOTE_SCOPES: Readonly<Record<string, RemoteScope>> = {
  // read
  counterpart_discover_printers: "read",
  counterpart_setup_fields: "read",
  counterpart_propose_filaments: "read",
  get_printer_status: "read",
  list_printer_files: "read",
  camera_frame: "read",
  counterpart_printer_info: "read",
  counterpart_print_progress: "read",
  camera_snapshot: "read",
  get_printer_filaments: "read",
  list_templates: "read",
  confirm_temperatures: "read",
  get_stl_info: "read",
  inspect_print_file: "read",
  check_fulu_orca_setup: "read",
  blender_mcp_status: "read",
  fusion_mcp_status: "read",
  blender_mcp_setup: "read", // checks only; update raises it
  fusion_mcp_setup: "read", // checks only; install raises it
  // design
  extend_stl_base: "design",
  slice_stl: "design",
  slice_with_template: "design",
  scale_stl: "design",
  rotate_stl: "design",
  translate_stl: "design",
  modify_stl_section: "design",
  generate_stl_visualization: "design",
  merge_vertices: "design",
  center_model: "design",
  lay_flat: "design",
  // control
  cancel_print: "control",
  camera_stream_start: "control",
  camera_stream_stop: "control",
  counterpart_print_route: "control",
  pause_print: "control",
  resume_print: "control",
  set_printer_temperature: "control",
  blender_mcp_export_stl: "control",
  fusion_mcp_new_design: "control",
  fusion_mcp_export: "control",
  // print
  start_print: "print",
  get_slice_settings: "print",
  process_and_print_stl: "print",
  print_3mf: "print",
  // raw
  upload_gcode: "raw",
  save_template: "raw",
  fulu_bambu_network_rpc: "raw",
  blender_mcp_call: "raw",
  blender_mcp_edit_model: "raw",
  fusion_mcp_call: "raw",
};

const RAISED_BY: Readonly<Record<string, Record<string, RemoteScope>>> = {
  fusion_mcp_status: { launch: "design" }, // starts Fusion on this computer
  blender_mcp_status: { connect: "design" }, // connects to Blender
  blender_mcp_setup: { update: "raw" }, // replaces the add-on in the person's Blender
  fusion_mcp_setup: { install: "raw" }, // installs into the person's Fusion, a login item and this server's .env
};

/**
 * Overrides of a server's own configuration (both printer MCPs use the same names): the printer it targets, its
 * account and credentials, its hardware, and the programs it runs.
 */
export const CONFIG_ARGUMENTS: ReadonlySet<string> = new Set([
  "host", "port", "api_key", "username", "password", "dev_ip", "dev_id", "bambu_serial", "bambu_token", "user_info",
  "country_code", "connection_type", "connection_mode", "route", "bambu_model", "nozzle_diameter", "nozzle_diameters",
  "bridge_command", "slicer_path", "slicer_type", "ffmpeg_path", "plugin_dir", "runtime_dir", "template_dir",
  "config_filename", "bambu_network_method", "use_ssl_for_mqtt", "use_ssl_for_ftp", "extra_options",
  "allow_mutating_method",
]);
/** Top-level only: the printer type (`type`); a nested `type` is a plain value. */
const TOP_LEVEL_CONFIG: ReadonlySet<string> = new Set(["type"]);
/** Files read whose names don't end in path, dir or file. */
const FILE_ARGUMENTS: ReadonlySet<string> = new Set(["filament_profile", "slicer_profile", "load_filaments", "source_f3d"]);

const isPath = (key: string) => /(?:path|dir|directory|_file)$/.test(key) || FILE_ARGUMENTS.has(key);

function kindOf(tool: string, key: string, depth: number): ArgumentKind | undefined {
  // counterpart_print_route's own `route` is the connection the caller chooses.
  if ((CONFIG_ARGUMENTS.has(key) && !(key === "route" && tool === "counterpart_print_route")) || /config_dir$/.test(key)) return "config";
  if (depth === 0 && TOP_LEVEL_CONFIG.has(key)) return "config-top";
  if (!isPath(key)) return undefined;
  return /^output_|^out_path$|^save_path$/.test(key) ? "output" : "path";
}

/** The argument kinds of one tool, read from its own input schema. */
export function remoteArguments(tool: { name: string; inputSchema?: unknown }): Record<string, ArgumentKind> {
  const kinds: Record<string, ArgumentKind> = {};
  let open = false;
  const visit = (schema: unknown, depth: number): void => {
    if (!schema || typeof schema !== "object") return;
    const node = schema as { type?: unknown; properties?: Record<string, unknown>; additionalProperties?: unknown; items?: unknown; anyOf?: unknown[]; oneOf?: unknown[] };
    // An object whose keys the schema doesn't name (beyond the top level) may carry any argument.
    if (depth > 0 && node.type === "object" && (node.additionalProperties === true || node.additionalProperties === undefined && !node.properties)) open = true;
    if (depth > 0 && node.additionalProperties && typeof node.additionalProperties === "object") open = true;
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      const kind = kindOf(tool.name, key, depth);
      if (kind && !(kinds[key] === "config" && kind === "config-top")) kinds[key] = kind;
      visit(child, depth + 1);
    }
    visit(node.items, depth);
    for (const option of [...(node.anyOf ?? []), ...(node.oneOf ?? [])]) visit(option, depth);
  };
  visit(tool.inputSchema, 0);
  if (open) for (const key of CONFIG_ARGUMENTS) if (!(key === "route" && tool.name === "counterpart_print_route")) kinds[key] ??= "config";
  return kinds;
}

/** The declaration for one tool; a tool missing from REMOTE_SCOPES (a bug the tests catch) is raw. */
export function remoteDeclaration(tool: { name: string; inputSchema?: unknown }): RemoteDeclaration {
  const args = remoteArguments(tool);
  return {
    scope: REMOTE_SCOPES[tool.name] ?? "raw",
    ...(RAISED_BY[tool.name] ? { raisedBy: RAISED_BY[tool.name] } : {}),
    ...(Object.keys(args).length ? { arguments: args } : {}),
  };
}

/** The tool with its declaration in `_meta`. */
export function withRemote<T extends { name: string; inputSchema?: unknown; _meta?: Record<string, unknown> }>(tool: T): T & { _meta: Record<string, unknown> } {
  return { ...tool, _meta: { ...(tool._meta ?? {}), [REMOTE_META_KEY]: remoteDeclaration(tool) } };
}
