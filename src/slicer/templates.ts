/**
 * Local slicing-template registry (ported from bambu-printer-mcp).
 *
 * A template is a saved .3mf project whose embedded slicer settings are
 * reused as the process profile, or a .json/.config process profile. Machine
 * presets still come from the selected bambu_model/nozzle; a template never
 * replaces the machine safety gate.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { parse3MF } from "../3mf_parser.js";

export type TemplateSourceType = "3mf" | "json" | "config";

export interface TemplateEntry {
  name: string;
  path: string;
  source_type: TemplateSourceType;
  relative_path: string;
}

export function defaultTemplateDir(): string {
  return process.env.BAMBU_TEMPLATE_DIR?.trim() ||
    path.join(process.env.HOME || os.homedir(), "Sync", "bambu", "templates");
}

function resolveTemplateDir(templateDir?: string): string {
  return templateDir && templateDir.trim().length > 0 ? templateDir : defaultTemplateDir();
}

export function sanitizeTemplateName(templateName: string): string {
  const sanitized = templateName
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9/_-]/g, "_");
  // Nested names are allowed; parent-directory segments are not.
  if (!sanitized || sanitized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`Invalid template name "${templateName}".`);
  }
  return sanitized;
}

export function scanTemplateRegistry(templateDir: string): TemplateEntry[] {
  if (!fs.existsSync(templateDir)) return [];

  const allowedExtensions = new Set([".3mf", ".json", ".config"]);
  const entries: TemplateEntry[] = [];
  const stack = [templateDir];

  while (stack.length > 0) {
    const currentDir = stack.pop()!;
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      const extension = path.extname(entry.name).toLowerCase();
      if (!entry.isFile() || !allowedExtensions.has(extension)) continue;

      const relativePath = path.relative(templateDir, fullPath);
      const templateName = relativePath
        .replace(/\\/g, "/")
        .replace(/(\.gcode)?\.3mf$/i, "")
        .replace(/\.(json|config)$/i, "");
      entries.push({
        name: templateName,
        path: fullPath,
        source_type: extension === ".3mf" ? "3mf" : extension === ".json" ? "json" : "config",
        relative_path: relativePath,
      });
    }
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export function listTemplateRegistry(templateDir?: string): { template_dir: string; templates: TemplateEntry[] } {
  const resolved = resolveTemplateDir(templateDir);
  return { template_dir: resolved, templates: scanTemplateRegistry(resolved) };
}

export function resolveTemplatePath(
  templateName: string | undefined,
  templateDir?: string,
  sourceTypes?: TemplateSourceType[]
): string | undefined {
  if (!templateName || templateName.trim().length === 0) return undefined;

  const registry = listTemplateRegistry(templateDir);
  const normalizedName = sanitizeTemplateName(templateName).toLowerCase();
  const requestedName = templateName.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").toLowerCase();
  const nameMatches = registry.templates.filter((entry) =>
    entry.name.toLowerCase() === requestedName ||
    entry.name.replace(/\s+/g, "_").replace(/[^A-Za-z0-9/_-]/g, "_").toLowerCase() === normalizedName
  );
  const searchTypes: TemplateSourceType[] = sourceTypes && sourceTypes.length > 0 ? sourceTypes : ["3mf", "json", "config"];
  const match = searchTypes
    .map((sourceType) => nameMatches.find((entry) => entry.source_type === sourceType))
    .find((entry): entry is TemplateEntry => Boolean(entry));
  if (!match) {
    const typeHint = sourceTypes && sourceTypes.length > 0 ? ` with source type ${sourceTypes.join("/")}` : "";
    const availableTypes = nameMatches.length > 0
      ? ` Available source types: ${Array.from(new Set(nameMatches.map((entry) => entry.source_type))).join(", ")}.`
      : "";
    throw new Error(`Template "${templateName}"${typeHint} not found in ${registry.template_dir}.${availableTypes}`);
  }
  return match.path;
}

export function saveTemplate(sourcePath: string, templateName?: string, templateDir?: string) {
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    throw new Error(`Template source not found: ${sourcePath}`);
  }

  const resolvedTemplateDir = resolveTemplateDir(templateDir);
  const sourceBaseName = path.basename(sourcePath);
  const extension = path.extname(sourceBaseName).toLowerCase();
  if (![".3mf", ".json", ".config"].includes(extension)) {
    throw new Error("Templates must be .3mf, .json, or .config files.");
  }

  const baseName = templateName && templateName.trim().length > 0
    ? sanitizeTemplateName(templateName)
    : sanitizeTemplateName(sourceBaseName.replace(/(\.gcode)?\.3mf$/i, "").replace(/\.(json|config)$/i, ""));

  const destinationPath = path.join(resolvedTemplateDir, `${baseName}${extension}`);
  const relative = path.relative(resolvedTemplateDir, destinationPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Template name "${templateName}" escapes the template directory.`);
  }
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.copyFileSync(sourcePath, destinationPath);

  const sourceType: TemplateSourceType = extension === ".3mf" ? "3mf" : extension === ".json" ? "json" : "config";
  return {
    saved: true,
    template_name: baseName,
    source_path: sourcePath,
    destination_path: destinationPath,
    template_dir: resolvedTemplateDir,
    resolved_path: resolveTemplatePath(baseName, resolvedTemplateDir, [sourceType]),
  };
}

/** Extract the embedded slicer settings from a Bambu/Orca project 3MF. */
export async function extractBambuTemplateSettings(filePath: string, outputDir: string): Promise<string> {
  const zip = await JSZip.loadAsync(await fs.promises.readFile(filePath));
  const potentialFiles = [
    "Metadata/project_settings.config",
    "Metadata/Slic3r_PE.config",
    "Metadata/model_settings.config",
    "Metadata/slice_info.config",
  ];
  for (const name of potentialFiles) {
    const file = zip.file(name);
    if (!file) continue;
    const content = await file.async("string");
    await fs.promises.mkdir(outputDir, { recursive: true });
    const stem = path.basename(filePath).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 64);
    const outputPath = path.join(outputDir, `${stem}_${name.replace(/\//g, "_")}`);
    await fs.promises.writeFile(outputPath, content, "utf8");
    return outputPath;
  }
  throw new Error(`No slicer settings config found in template 3MF: ${filePath}`);
}

/** A template/profile path becomes the process profile passed to sliceSTL. */
export async function resolveTemplateSlicerProfilePath(templatePath: string, tempDir: string): Promise<string> {
  const extension = path.extname(templatePath).toLowerCase();
  if (extension === ".3mf") return extractBambuTemplateSettings(templatePath, tempDir);
  if (extension === ".json" || extension === ".config") return templatePath;
  throw new Error(`Template profile must be a .3mf, .json, or .config file: ${templatePath}`);
}

export function parseLooseSlicerConfig(content: string): Record<string, any> {
  try {
    return JSON.parse(content);
  } catch {
    const config: Record<string, any> = {};
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex === -1) continue;
      const key = trimmed.slice(0, separatorIndex).trim();
      const value = trimmed.slice(separatorIndex + 1).trim();
      if (key) config[key] = value;
    }
    return config;
  }
}

const numberOrNull = (value: unknown) => (value !== undefined && value !== null ? Number(value) : null);

export function summarizeSliceSettings(config: Record<string, any>) {
  const stringList = (value: unknown) =>
    Array.isArray(value) ? value.filter((entry) => typeof entry === "string" && entry.length > 0) : [];
  return {
    printer_settings_id: typeof config.printer_settings_id === "string" ? config.printer_settings_id : null,
    printer_model: typeof config.printer_model === "string" ? config.printer_model : null,
    default_print_profile: typeof config.default_print_profile === "string" ? config.default_print_profile : null,
    default_filament_profile: Array.isArray(config.default_filament_profile)
      ? config.default_filament_profile
      : typeof config.default_filament_profile === "string"
        ? [config.default_filament_profile]
        : [],
    filament_settings_id: stringList(config.filament_settings_id),
    filament_type: stringList(config.filament_type),
    inherits: typeof config.inherits === "string" ? config.inherits : null,
    print_settings_id: typeof config.print_settings_id === "string" ? config.print_settings_id : null,
    compatible_printers: stringList(config.compatible_printers),
    nozzle_diameter: Array.isArray(config.nozzle_diameter)
      ? config.nozzle_diameter
      : config.nozzle_diameter !== undefined
        ? [config.nozzle_diameter]
        : [],
    layer_height: numberOrNull(config.layer_height),
    first_layer_height: config.initial_layer_print_height !== undefined && config.initial_layer_print_height !== null
      ? Number(config.initial_layer_print_height)
      : numberOrNull(config.first_layer_height),
    sparse_infill_density:
      config.sparse_infill_density !== undefined && config.sparse_infill_density !== null
        ? String(config.sparse_infill_density)
        : null,
    sparse_infill_pattern: typeof config.sparse_infill_pattern === "string" ? config.sparse_infill_pattern : null,
    wall_loops: numberOrNull(config.wall_loops),
    top_shell_layers: numberOrNull(config.top_shell_layers),
    bottom_shell_layers: numberOrNull(config.bottom_shell_layers),
    brim_width: numberOrNull(config.brim_width),
    support_enabled:
      config.enable_support !== undefined
        ? String(config.enable_support) === "1" || String(config.enable_support).toLowerCase() === "true"
        : config.support_enabled !== undefined
          ? Boolean(config.support_enabled)
          : null,
    support_type: typeof config.support_type === "string" ? config.support_type : null,
    bed_type: typeof config.curr_bed_type === "string"
      ? config.curr_bed_type
      : typeof config.bed_type === "string"
        ? config.bed_type
        : null,
    nozzle_temperature: Array.isArray(config.nozzle_temperature)
      ? config.nozzle_temperature
      : config.nozzle_temperature !== undefined
        ? [config.nozzle_temperature]
        : [],
  };
}

/** Inspect settings in a template 3MF or a profile file without slicing. */
export async function inspectSliceSettings(sourcePath: string, tempDir: string) {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Slice settings source not found: ${sourcePath}`);
  }
  const extension = path.extname(sourcePath).toLowerCase();
  const settingsDir = path.join(tempDir, "slice-settings");

  if (extension === ".3mf") {
    const parsed = await parse3MF(sourcePath);
    const extractedSettingsPath = await extractBambuTemplateSettings(sourcePath, settingsDir);
    const config = (parsed.slicerConfig || {}) as Record<string, any>;
    return {
      source_path: sourcePath,
      source_type: "3mf",
      extracted_settings_path: extractedSettingsPath,
      object_count: parsed.objects.length,
      build_item_count: parsed.build.items.length,
      metadata_keys: Object.keys(parsed.metadata),
      summary: summarizeSliceSettings(config),
      raw_key_count: Object.keys(config).length,
    };
  }

  const config = parseLooseSlicerConfig(fs.readFileSync(sourcePath, "utf8"));
  return {
    source_path: sourcePath,
    source_type: extension === ".json" ? "json" : extension === ".config" ? "config" : "text",
    extracted_settings_path: sourcePath,
    summary: summarizeSliceSettings(config),
    raw_key_count: Object.keys(config).length,
  };
}
