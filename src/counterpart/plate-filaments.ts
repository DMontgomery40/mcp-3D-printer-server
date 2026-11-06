/**
 * The project filaments each plate of a Bambu Studio / OrcaSlicer 3MF prints with, worked out the way Bambu Studio
 * does it (v02.08.02.61), so a client asks the person to choose spools only for the filaments that plate uses.
 *
 * - A sliced plate: Studio's own record, Metadata/plate_N.json `filament_ids` (0-based), written from the slice.
 * - An unsliced plate: PartPlate::get_extruders_under_cli (src/slic3r/GUI/PartPlate.cpp:1298-1420) over the objects
 *   with an instance on the plate (model_settings.config <model_instance>; an instance with printable="0" in the
 *   3dmodel.model build is skipped, PartPlate.cpp:1321):
 *   - each volume's ModelVolume::get_extruders (src/libslic3r/Model.cpp:3357-3412): negative parts, support blockers
 *     and enforcers print nothing; the volume's painted states (mmu_segmentation, `paint_color`); the volume's own
 *     extruder (ModelVolume::extruder_id, Model.cpp:3295-3306: the part's, else the object's, else 1) unless paint
 *     covers every facet of a model part; and the volume's wall/solid/sparse infill filaments, else the object's;
 *   - the object's layer-range extruders (Metadata/layer_config_ranges.xml, by 1-based model object index);
 *   - the object's feature filaments when separate_filaments_for_features is on;
 *   - the support and support-interface filaments when the object (or the project) prints support or a raft;
 *   - the plate's tool changes (Metadata/custom_gcode_per_layer.xml, CustomGCode::ToolChange = 2,
 *     PartPlate.cpp:1263-1274).
 * Painting is decoded as FacetsAnnotation::set_triangle_from_string (Model.cpp:4631-4650) and
 * TriangleSelector::deserialize (src/libslic3r/TriangleSelector.cpp:2111-2139) read it; this is a reimplementation
 * from that documented behaviour, not Studio's code.
 *
 * Only bounded metadata and mesh text are read; nothing is extracted or run.
 */
import type JSZip from "jszip";

export interface PlateFilament {
  /** 1-based project filament number: slice_stl's load_filaments/filament_colours position, print_3mf's ams_mapping index + 1. */
  index: number;
  /** As the project declares it (project_settings.config filament_colour), #RRGGBB. */
  colour?: string;
  /** project_settings.config filament_type. */
  material?: string;
  /** project_settings.config filament_ids (Bambu's filament id, e.g. GFA00). */
  filament_id?: string;
  /** The first part (else object) on this plate that prints with it; absent for support, painting or tool changes only. */
  name?: string;
}

const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_MESH_BYTES = 64 * 1024 * 1024;
const MAX_MESH_TOTAL = 256 * 1024 * 1024;
const MAX_FILAMENT = 64;

const words = (value: string) => value
  .replace(/&(?:amp|lt|gt|quot|apos);/g, entity => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&apos;": "'" }[entity]!))
  .replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 256);

type Settings = Map<string, string>;
interface Part { id: string; subtype: string; name: string; settings: Settings }
interface ObjectEntry { id: string; name: string; settings: Settings; parts: Part[] }

const metadataOf = (block: string): Settings => new Map([...block.matchAll(/<metadata\s+key="([^"]+)"\s+value="([^"]*)"\s*\/?>/g)].map(match => [match[1], match[2]]));

/** model_settings.config objects with their own settings and parts (parts never nest). */
export function readModelObjects(settings: string): ObjectEntry[] {
  return [...settings.matchAll(/<object\b[^>]*\bid="(\d+)"[^>]*>([\s\S]*?)<\/object>/g)].map(match => {
    const parts = [...match[2].matchAll(/<part\b([^>]*)>([\s\S]*?)<\/part>/g)].map(part => {
      const own = metadataOf(part[2]);
      return { id: /\bid="(\d+)"/.exec(part[1])?.[1] ?? "", subtype: /\bsubtype="([^"]+)"/.exec(part[1])?.[1] ?? "normal_part", name: words(own.get("name") ?? ""), settings: own };
    });
    const own = metadataOf(match[2].replace(/<part\b[^>]*>[\s\S]*?<\/part>/g, ""));
    return { id: match[1], name: words(own.get("name") ?? ""), settings: own, parts };
  });
}

/** An integer setting (Studio stores "0"/"1"/"3" strings; a project list keeps its first value). */
function intOf(value: unknown): number | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first === "number" && Number.isInteger(first)) return first;
  if (typeof first !== "string" || !/^\s*-?\d+\s*$/.test(first)) return undefined;
  return Number(first);
}
function boolOf(value: unknown): boolean | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first === "boolean") return first;
  if (typeof first !== "string") return undefined;
  if (/^(?:1|true)$/i.test(first.trim())) return true;
  if (/^(?:0|false)$/i.test(first.trim())) return false;
  return undefined;
}

/**
 * The filament states a painted facet string holds (0 is "the volume's own filament"). Studio's string is hex,
 * read last character first, each digit four bits low bit first, so the nibbles are the digits in reverse order.
 * Each node is one nibble: two low bits are the split-side count (children = sides + 1); a leaf's state is the high
 * two bits, or, when both are set, 3 + the next nibble + 15 for every preceding 0b1111 nibble.
 */
export function paintedStates(paint: string): number[] {
  const nibbles: number[] = [];
  for (let i = paint.length - 1; i >= 0; i--) {
    const digit = Number.parseInt(paint[i], 16);
    if (Number.isNaN(digit)) return [];
    nibbles.push(digit);
  }
  const states: number[] = [];
  let at = 0, pending = 1;
  const next = () => (at < nibbles.length ? nibbles[at++] : undefined);
  while (pending > 0) {
    const code = next();
    if (code === undefined) break;
    pending -= 1;
    const sides = code & 0b11;
    if (sides) { pending += sides + 1; continue; }
    if ((code & 0b1100) === 0b1100) {
      let more = 0, value = next();
      while (value === 0b1111) { more += 1; value = next(); }
      if (value === undefined) break;
      states.push(value + 15 * more + 3);
    } else states.push(code >> 2);
  }
  return states;
}

/** What a mesh's painting says: the painted filament states, and whether any facet keeps the volume's own filament. */
interface MeshPaint { states: Set<number>; ownFilament: boolean }

/**
 * Per component file and sub-object id, the painting of that mesh. Only files that contain painting are read in full.
 */
async function readPainting(zip: JSZip, paths: Set<string>): Promise<Map<string, MeshPaint>> {
  const result = new Map<string, MeshPaint>();
  let total = 0;
  for (const path of paths) {
    const file = zip.file(path);
    if (!file) continue;
    const bytes = await file.async("nodebuffer");
    if (bytes.length > MAX_MESH_BYTES || (total += bytes.length) > MAX_MESH_TOTAL) throw new Error("The model's meshes are too large to read its painted colours.");
    if (!bytes.includes("paint_color=\"")) continue;
    const text = bytes.toString("utf8");
    for (const object of text.matchAll(/<object\b[^>]*\bid="(\d+)"[^>]*>([\s\S]*?)<\/object>/g)) {
      const paint: MeshPaint = { states: new Set(), ownFilament: false };
      for (const triangle of object[2].matchAll(/<triangle\b([^>]*)\/?>/g)) {
        const value = /\bpaint_color="([0-9A-Fa-f]*)"/.exec(triangle[1])?.[1];
        if (!value) { paint.ownFilament = true; continue; }
        for (const state of paintedStates(value)) {
          if (state === 0) paint.ownFilament = true;
          else paint.states.add(state);
        }
      }
      result.set(`${path}#${object[1]}`, paint);
    }
  }
  return result;
}

interface ProjectFilaments { colours: string[]; materials: string[]; ids: string[]; config: Record<string, unknown> }

function projectFilaments(config: Record<string, unknown>): ProjectFilaments {
  const list = (key: string): string[] => Array.isArray(config[key]) ? (config[key] as unknown[]).map(String) : [];
  return { colours: list("filament_colour"), materials: list("filament_type"), ids: list("filament_ids"), config };
}

function describe(index: number, project: ProjectFilaments, name?: string): PlateFilament {
  const colour = /^#?([0-9a-fA-F]{6})(?:[0-9a-fA-F]{2})?$/.exec(project.colours[index - 1]?.trim() ?? "");
  const material = project.materials[index - 1]?.trim().replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 64);
  const filamentId = project.ids[index - 1]?.trim().replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 64);
  return { index, ...(colour ? { colour: `#${colour[1].toUpperCase()}` } : {}), ...(material ? { material } : {}),
    ...(filamentId ? { filament_id: filamentId } : {}), ...(name ? { name } : {}) };
}

export interface PlateLayout {
  /** 1-based plate number. */
  number: number;
  /** model_settings.config object ids with an instance on this plate, in plate order. */
  objectIds: string[];
  /** Metadata/plate_N.json filament_ids (0-based) when the file holds this plate's slice. */
  slicedFilamentIds?: number[];
}

/**
 * The filaments each plate prints with, keyed by plate number. `settings` is model_settings.config, `model` the root
 * 3D/3dmodel.model text.
 */
export async function plateFilaments(zip: JSZip, settings: string, model: string, plates: PlateLayout[]): Promise<{ plates: Map<number, PlateFilament[]>; project: PlateFilament[] }> {
  const text = async (name: string) => {
    const file = zip.file(name);
    if (!file) return "";
    const bytes = await file.async("nodebuffer");
    if (bytes.length > MAX_TEXT_BYTES) throw new Error(`${name} is too large to read.`);
    return bytes.toString("utf8");
  };
  let config: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await text("Metadata/project_settings.config") || "{}") as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) config = parsed as Record<string, unknown>;
  } catch { /* a project without readable settings declares no filaments */ }
  const project = projectFilaments(config);
  const declared = Math.min(MAX_FILAMENT, Math.max(project.colours.length, project.materials.length, project.ids.length));
  const valid = (index: number | undefined): index is number => index !== undefined && Number.isInteger(index) && index >= 1 && index <= MAX_FILAMENT && (!declared || index <= declared);

  const objects = new Map(readModelObjects(settings).map(object => [object.id, object]));
  // Root objects' components: which sub-object mesh in which file each part is (part id = component objectid).
  const components = new Map<string, Map<string, string>>();
  for (const object of model.matchAll(/<(?:\w+:)?object\b[^>]*\bid="(\d+)"[^>]*>([\s\S]*?)<\/(?:\w+:)?object>/g)) {
    const parts = new Map<string, string>();
    for (const component of object[2].matchAll(/<(?:\w+:)?component\b([^>]*)\/?>/g)) {
      const path = /\b(?:\w+:)?path="\/?([^"]+)"/.exec(component[1])?.[1];
      const id = /\bobjectid="(\d+)"/.exec(component[1])?.[1];
      if (path && id) parts.set(id, path);
    }
    if (parts.size) components.set(object[1], parts);
  }
  // Model object order (1-based in layer_config_ranges.xml): the build items' order, as Studio creates the objects.
  const buildItems = [...model.matchAll(/<(?:\w+:)?item\b([^>]*)\/?>/g)].map(item => item[1]);
  const order = [...new Set(buildItems.flatMap(item => /\bobjectid="(\d+)"/.exec(item)?.[1] ?? []))];
  // An object none of whose build items is printable prints nothing (PartPlate.cpp:1321 skips each such instance).
  const printableItems = new Map<string, boolean>();
  for (const item of buildItems) {
    const id = /\bobjectid="(\d+)"/.exec(item)?.[1];
    if (id) printableItems.set(id, (printableItems.get(id) ?? false) || !/\bprintable="(?:0|false)"/.test(item));
  }
  const unprintable = new Set([...printableItems].flatMap(([id, printable]) => printable ? [] : [id]));

  const rangeExtruders = new Map<string, number[]>();
  const ranges = await text("Metadata/layer_config_ranges.xml");
  for (const object of ranges.matchAll(/<object\b[^>]*\bid="(\d+)"[^>]*>([\s\S]*?)<\/object>/g)) {
    const objectId = order[Number(object[1]) - 1];
    if (!objectId) continue;
    rangeExtruders.set(objectId, [...object[2].matchAll(/<option\s+opt_key="extruder"\s*>\s*(\d+)\s*<\/option>/g)].map(match => Number(match[1])).filter(id => id > 0));
  }
  const toolChanges = new Map<number, number[]>();
  const custom = await text("Metadata/custom_gcode_per_layer.xml");
  for (const plate of custom.matchAll(/<plate>([\s\S]*?)<\/plate>/g)) {
    const id = Number(/<plate_info\b[^>]*\bid="(\d+)"/.exec(plate[1])?.[1]);
    if (!Number.isInteger(id)) continue;
    toolChanges.set(id, [...plate[1].matchAll(/<layer\b([^>]*)\/?>/g)]
      .filter(layer => /\btype="2"/.test(layer[1]))
      .map(layer => Number(/\bextruder="(\d+)"/.exec(layer[1])?.[1])));
  }

  // Painting only matters for parts on a plate that is not sliced yet.
  const paintPaths = new Set<string>();
  for (const plate of plates) if (!plate.slicedFilamentIds) for (const objectId of plate.objectIds)
    for (const path of components.get(objectId)?.values() ?? []) paintPaths.add(path);
  const painting = await readPainting(zip, paintPaths);

  const global = (key: string) => intOf(config[key]) ?? 0;
  const globalSupport = (boolOf(config.enable_support) ?? false) || (intOf(config.raft_layers) ?? 0) > 0;
  const result = new Map<number, PlateFilament[]>();
  for (const plate of plates) {
    const used = new Map<number, string | undefined>();
    const add = (index: number | undefined, name?: string) => {
      if (!valid(index)) return;
      if (!used.has(index) || (!used.get(index) && name)) used.set(index, name || undefined);
    };
    for (const objectId of plate.objectIds) {
      const object = objects.get(objectId);
      if (!object || unprintable.has(objectId)) continue;
      const objectInt = (key: string) => intOf(object.settings.get(key));
      const parts = object.parts.length ? object.parts : [{ id: "", subtype: "normal_part", name: "", settings: new Map() as Settings }];
      for (const part of parts) {
        if (["negative_part", "support_blocker", "support_enforcer"].includes(part.subtype)) continue;
        const partInt = (key: string) => intOf(part.settings.get(key));
        const ownExtruder = partInt("extruder") || objectInt("extruder") || 1;
        const label = part.name || object.name;
        const path = components.get(objectId)?.get(part.id);
        const paint = path ? painting.get(`${path}#${part.id}`) : undefined;
        for (const state of paint?.states ?? []) if (part.subtype === "normal_part") add(state, label);
        // A modifier's own filament counts whatever its paint (Model.cpp:3384-3390).
        if (part.subtype !== "normal_part" || !paint || paint.ownFilament) add(ownExtruder, label);
        for (const key of ["wall_filament", "solid_infill_filament", "sparse_infill_filament"]) {
          const own = partInt(key);
          if (own !== undefined) { if (own > 0) add(own, label); }
          else if ((objectInt(key) ?? 0) > 0) add(objectInt(key), label);
        }
        // Feature filaments when the object or part separates them (PartPlate.cpp:1338-1381).
        const partSeparate = boolOf(part.settings.get("separate_filaments_for_features"));
        const objectSeparate = boolOf(object.settings.get("separate_filaments_for_features"));
        if (partSeparate || (partSeparate === undefined && objectSeparate)) {
          for (const key of ["wall_filament", "sparse_infill_filament", "solid_infill_filament"]) {
            const own = partInt(key) ?? 0, ofObject = objectInt(key) ?? 0;
            if (own) add(own, label);
            else if (ofObject && partSeparate === undefined && objectSeparate) add(ofObject, label);
            else if (global(key) && partSeparate === undefined && objectSeparate === undefined && global("sparse_infill_filament")) add(global(key), label);
          }
        }
      }
      for (const extruder of rangeExtruders.get(objectId) ?? []) add(extruder, object.name);
      // Support and raft (PartPlate.cpp:1383-1418): the object's own setting, else the project's.
      const objectSupport = boolOf(object.settings.get("enable_support"));
      const objectRaft = objectInt("raft_layers");
      const support = objectSupport !== undefined || objectRaft !== undefined
        ? (objectSupport ?? false) || (objectRaft ?? 0) > 0 : globalSupport;
      if (support) {
        add(objectInt("support_interface_filament") || global("support_interface_filament") || undefined);
        add(objectInt("support_filament") || global("support_filament") || undefined);
      }
    }
    for (const extruder of toolChanges.get(plate.number) ?? []) add(extruder);
    // Objects the settings don't describe (a plain 3MF) print with filament 1, ModelVolume::extruder_id's default.
    if (!used.size && (plate.objectIds.some(id => !objects.has(id)) || (!objects.size && buildItems.length))) add(1);
    if (plate.slicedFilamentIds) {
      // The slice is Studio's own answer: it replaces the derivation, keeping names the derivation found.
      const names = new Map(used);
      used.clear();
      for (const id of plate.slicedFilamentIds) add(id + 1, names.get(id + 1));
    }
    result.set(plate.number, [...used.entries()].sort((a, b) => a[0] - b[0]).map(([index, name]) => describe(index, project, name)));
  }
  // Every filament the project declares, used on a plate or not: slice_stl takes one profile per declared filament.
  return { plates: result, project: Array.from({ length: declared }, (_, i) => describe(i + 1, project)) };
}
