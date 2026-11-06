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
    // A mesh past the read budget is taken as unpainted (its part's own filament), never a failed listing.
    const size = (file as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
    if (size !== undefined && (size > MAX_MESH_BYTES || total + size > MAX_MESH_TOTAL)) continue;
    const bytes = await file.async("nodebuffer");
    if (bytes.length > MAX_MESH_BYTES || (total += bytes.length) > MAX_MESH_TOTAL) continue;
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
  /** Each copy on the plate: its object and that object's instance_id (model_settings.config <model_instance>). */
  instances?: { objectId: string; instanceId: number }[];
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
      // Studio keys a component by (path, objectid); one without p:path names a mesh object in the root model
      // itself, keyed by the root's empty path (bbs_3mf.cpp:4131-4148, 3891).
      if (id) parts.set(id, path || "3D/3dmodel.model");
    }
    if (parts.size) components.set(object[1], parts);
  }
  // Model object order (1-based in layer_config_ranges.xml): the build items' order, as Studio creates the objects.
  const buildItems = [...model.matchAll(/<(?:\w+:)?item\b([^>]*)\/?>/g)].map(item => item[1]);
  const order = [...new Set(buildItems.flatMap(item => /\bobjectid="(\d+)"/.exec(item)?.[1] ?? []))];
  // Each build item adds its object's next instance, with its own printable flag (bbs_3mf.cpp:4183-4185, 4375-4380);
  // a plate names its copies by object_id and instance_id (bbs_3mf.cpp:4717-4719), and the CLI skips each copy that
  // isn't printable (PartPlate.cpp:1311-1322).
  const printableItems = new Map<string, boolean[]>();
  for (const item of buildItems) {
    const id = /\bobjectid="(\d+)"/.exec(item)?.[1];
    if (id) printableItems.set(id, [...(printableItems.get(id) ?? []), !/\bprintable="(?:0|false)"/.test(item)]);
  }
  const printableCopy = (objectId: string, instanceId?: number) => {
    const flags = printableItems.get(objectId);
    if (!flags) return true;
    return instanceId === undefined ? flags.some(Boolean) : flags[instanceId] !== false;
  };


  const rangeExtruders = new Map<string, number[]>();
  const ranges = await text("Metadata/layer_config_ranges.xml");
  for (const object of ranges.matchAll(/<object\b[^>]*\bid="(\d+)"[^>]*>([\s\S]*?)<\/object>/g)) {
    const objectId = order[Number(object[1]) - 1];
    if (!objectId) continue;
    // A range's extruder sets all three feature filaments; a range's own feature filament overrides one
    // (apply_to_print_region_config and resolve_filament_value, PrintObject.cpp:3069-3079, 3134-3137).
    rangeExtruders.set(objectId, [...object[2].matchAll(/<option\s+opt_key="(?:extruder|wall_filament|sparse_infill_filament|solid_infill_filament)"\s*>\s*(\d+)\s*<\/option>/g)].map(match => Number(match[1])).filter(id => id > 0));
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
  const FEATURES = ["wall_filament", "sparse_infill_filament", "solid_infill_filament"] as const;
  const result = new Map<number, PlateFilament[]>();
  for (const plate of plates) {
    const used = new Map<number, string | undefined>();
    const add = (index: number | undefined, name?: string) => {
      if (!valid(index)) return;
      if (!used.has(index) || (!used.get(index) && name)) used.set(index, name || undefined);
    };
    // An object counts once on a plate when any of its copies there prints.
    const printing = plate.instances?.length
      ? [...new Set(plate.instances.filter(copy => printableCopy(copy.objectId, copy.instanceId)).map(copy => copy.objectId))]
      : plate.objectIds.filter(objectId => printableCopy(objectId));
    for (const objectId of printing) {
      const object = objects.get(objectId);
      if (!object) continue;
      const objectInt = (key: string) => intOf(object.settings.get(key));
      const parts = object.parts.length ? object.parts : [{ id: "", subtype: "normal_part", name: "", settings: new Map() as Settings }];
      for (const part of parts) {
        if (["negative_part", "support_blocker", "support_enforcer"].includes(part.subtype)) continue;
        const partInt = (key: string) => intOf(part.settings.get(key));
        // What the slicer prints the part with (region_config_from_model_volume, PrintObject.cpp:3105-3150): the
        // project's feature filaments, replaced by the object's and then the part's extruder when one is set
        // (non-zero), then by a feature filament the part, else the object, sets above 0.
        const extruderSet = (partInt("extruder") ?? 0) > 0 || (objectInt("extruder") ?? 0) > 0;
        const ownExtruder = partInt("extruder") || objectInt("extruder") || 1;
        const label = part.name || object.name;
        const path = components.get(objectId)?.get(part.id);
        const paint = path ? painting.get(`${path}#${part.id}`) : undefined;
        for (const state of paint?.states ?? []) if (part.subtype === "normal_part") add(state, label);
        // A modifier's own filament counts whatever its paint (Model.cpp:3384-3390).
        if (part.subtype !== "normal_part" || !paint || paint.ownFilament) {
          if (extruderSet) add(ownExtruder, label);
          // Neither the part nor its object names an extruder: the project's feature filaments print it (each
          // above 0; a project without them prints with filament 1, ModelVolume::extruder_id's default).
          else for (const key of FEATURES) add(global(key) > 0 ? global(key) : 1, label);
        }
        for (const key of ["wall_filament", "solid_infill_filament", "sparse_infill_filament"]) {
          const own = partInt(key);
          if (own !== undefined) { if (own > 0) add(own, label); }
          else if ((objectInt(key) ?? 0) > 0) add(objectInt(key), label);
        }
        // separate_filaments_for_features gates these only in Studio's plate list (PartPlate.cpp:1338-1381): it isn't
        // a slicer setting in 02.08.02.61 (libslic3r never reads it), and the slice applies the part's or object's
        // feature filaments whatever it says (PrintObject.cpp:3124-3150), as the loop above does.
      }
      for (const extruder of rangeExtruders.get(objectId) ?? []) add(extruder, object.name);
      // Support and raft as the slice resolves them: each setting the object's own, else the project's, one key at a
      // time (PrintObject::object_config_from_model_object, PrintObject.cpp:3052-3063). Studio's plate list resolves
      // the pair together (PartPlate.cpp:1383-1393), which drops support an object with only a raft override prints.
      const setting = (key: string) => object.settings.has(key) ? object.settings.get(key) : config[key];
      const support = (boolOf(setting("enable_support")) ?? false) || (intOf(setting("raft_layers")) ?? 0) > 0;
      if (support) {
        // 0 is "default": the support prints with the object's own filament (Print.cpp:490-501).
        add(intOf(setting("support_interface_filament")) || undefined);
        add(intOf(setting("support_filament")) || undefined);
      }
    }
    for (const extruder of toolChanges.get(plate.number) ?? []) add(extruder);
    // Objects the settings don't describe (a plain 3MF) name no extruder: the project's feature filaments print them,
    // else filament 1 (ModelVolume::extruder_id's default).
    if (!used.size && (plate.objectIds.some(id => !objects.has(id)) || (!objects.size && buildItems.length)))
      for (const key of FEATURES) add(global(key) > 0 ? global(key) : 1);
    // A mixed filament slot prints as its component filaments (PartPlate.cpp:1437-1449, expand_mixed_filaments in
    // FilamentMixer.cpp:460-478; components are 1-based, comma-separated, FilamentMixer.cpp:165-180).
    const mixed = Array.isArray(config.filament_is_mixed) ? (config.filament_is_mixed as unknown[]).map(value => boolOf(value) === true) : [];
    const mixedComponents = Array.isArray(config.filament_mixed_components) ? (config.filament_mixed_components as unknown[]).map(String) : [];
    if (mixed.some(Boolean)) for (const [index, name] of [...used]) {
      if (!mixed[index - 1] || index - 1 >= mixedComponents.length) continue;
      used.delete(index);
      for (const part of mixedComponents[index - 1].split(",")) {
        const component = /^\s*\d+\s*$/.test(part) ? Number(part) : 0;
        if (component >= 1) add(component, name);
      }
    }
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
