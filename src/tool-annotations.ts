/**
 * MCP tool annotations (readOnlyHint, destructiveHint, idempotentHint, openWorldHint) for every tool.
 * They are hints for clients, never a safety gate: the shared checks in src/safety/ still apply.
 *
 * - readOnlyHint: the tool changes nothing (no file, printer, setting, or external application state).
 * - destructiveHint: it may overwrite or end something that already exists (a file, a setting, a job,
 *   an arbitrary remote call). Starting a print and heating are additive: there is no confirmation
 *   prompt for them (AGENTS.md, maintainer decision 2026-11-03), and the printer runs its own checks.
 * - idempotentHint: calling it again with the same arguments has no further effect.
 * - openWorldHint: it reaches outside this server and the local files (a printer, its camera, Bambu's
 *   network, Blender, or Fusion).
 */
export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

const read = (openWorldHint: boolean): ToolAnnotations => ({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint });
const write = (destructiveHint: boolean, idempotentHint: boolean, openWorldHint: boolean): ToolAnnotations =>
  ({ readOnlyHint: false, destructiveHint, idempotentHint, openWorldHint });

export const TOOL_ANNOTATIONS: Readonly<Record<string, ToolAnnotations>> = {
  // Printer reads.
  get_printer_status: read(true),
  list_printer_files: read(true),
  counterpart_printer_info: read(true),
  counterpart_print_progress: read(true),
  camera_snapshot: write(true, false, true), // save_path writes, and replaces, a file of the caller's choosing
  camera_frame: read(true),
  get_printer_filaments: read(true),

  // Printer actions.
  upload_gcode: write(true, false, true), // can replace a file of the same name on the printer
  start_print: write(false, false, true),
  print_3mf: write(false, false, true),
  process_and_print_stl: write(false, false, true),
  cancel_print: write(true, true, true), // ends the job; it cannot be resumed
  pause_print: write(false, true, true),
  resume_print: write(false, true, true),
  set_printer_temperature: write(false, true, true),
  camera_stream_start: write(false, true, true), // "start or renew" one shared connection
  camera_stream_stop: write(false, true, true),
  counterpart_print_route: write(true, true, false), // with route, replaces the saved connection in .env

  // Local files: each STL edit and slice writes a new output file, so a repeat writes another.
  extend_stl_base: write(false, false, false),
  scale_stl: write(false, false, false),
  rotate_stl: write(false, false, false),
  translate_stl: write(false, false, false),
  modify_stl_section: write(false, false, false),
  merge_vertices: write(false, false, false),
  center_model: write(false, false, false),
  lay_flat: write(false, false, false),
  generate_stl_visualization: write(false, false, false), // writes a new SVG file
  get_stl_info: read(false),
  slice_stl: write(false, false, false),
  slice_with_template: write(false, false, false),
  list_templates: read(false),
  save_template: write(true, true, false), // replaces a template of the same name
  get_slice_settings: write(false, true, false), // a 3MF's settings are extracted to a file in TEMP_DIR
  confirm_temperatures: read(false),
  inspect_print_file: read(false),

  // FULU BambuNetwork.
  check_fulu_orca_setup: read(true), // run_bridge_probe starts FULU's bridge host
  fulu_bambu_network_rpc: write(true, false, true), // allow_mutating_methods reaches agent and session setup

  // Blender and Fusion.
  blender_mcp_status: read(true),
  blender_mcp_call: write(true, false, true), // any Blender MCP tool
  blender_mcp_export_stl: write(false, false, true), // never overwrites; leaves the scene unchanged
  blender_mcp_edit_model: write(false, false, true),
  fusion_mcp_status: write(false, true, true), // launch: true opens Fusion
  fusion_mcp_call: write(true, false, true), // any Fusion tool, execute_code included
  fusion_mcp_new_design: write(false, false, true),
  fusion_mcp_export: write(false, false, true), // never overwrites files
};

/** Give each listed tool its annotations. tests/tool-annotations.test.mjs fails for a tool without an entry. */
export function annotateTools<T extends { name: string }>(tools: T[]): Array<T & { annotations?: ToolAnnotations }> {
  return tools.map(tool => (TOOL_ANNOTATIONS[tool.name] ? { ...tool, annotations: TOOL_ANNOTATIONS[tool.name] } : tool));
}
