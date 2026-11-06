/**
 * list_3mf_plates: a Bambu Studio / OrcaSlicer project's plates as its designer laid them out, before slicing
 * (Counterpart PRD §5.5 "Plates of an imported 3MF", §8.0 item 9). Bambu Studio shows a downloaded kit as its
 * plates straight away; clients show the same from here instead of parsing the project files themselves.
 *
 * Plates come from Metadata/model_settings.config (`<plate>` with `plater_id`, `plater_name` and the objects it
 * holds) and, for a sliced file, from Metadata/plate_N.json and plate_N.gcode. A plain 3MF with no plate metadata
 * is one plate. Only bounded metadata is read; nothing is extracted or run.
 */
import { readSafe3mfArchive } from "../safety/archive.js";
import { plateFilaments, type PlateFilament, type PlateLayout } from "./plate-filaments.js";

export interface ModelPlate {
  /** Zero-based, as inspect_print_file's plate_index; slice_stl's slice_plate is index + 1. */
  index: number;
  name: string;
  objects: string[];
  /**
   * Each object copy on the plate with its identify_id, from model_settings.config's <model_instance> entries
   * (Bambu Studio 02.08.02.61 bbs_3mf.cpp:8448-8482). These are the ids slice_stl's skip_objects takes: the
   * CLI matches them against each instance's loaded id (BambuStudio.cpp:1785-1789, 6530-6545).
   */
  instances: { identify_id: number; name: string }[];
  /** The file already holds this plate's G-code. */
  sliced: boolean;
  /**
   * The project filaments this plate prints with, and only those (counterpart/1): what a client asks the person to
   * choose spools for. From the slice when the file holds one (plate_N.json filament_ids), otherwise worked out as
   * Bambu Studio does for the objects on this plate (see plate-filaments.ts). Filaments of other plates never appear.
   */
  filaments: PlateFilament[];
  /** The plate's own preview from the file (Metadata/plate_N.png), when asked for and present. */
  thumbnail_png_base64?: string;
}
export interface ModelPlates {
  plate_count: number;
  plates: ModelPlate[];
  title?: string;
  designer?: string;
  licence?: string;
  /**
   * Every filament the project declares (project_settings.config), used on a plate or not, from 1: slice_stl takes one
   * load_filaments profile per declared filament. Empty for a 3MF that declares none.
   */
  project_filaments: PlateFilament[];
}

/** For the settings and plate files; the model file can be large and is only scanned. */
const MAX_METADATA_BYTES = 8 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;
const MAX_PLATES = 1000;
const MAX_INSTANCES_PER_PLATE = 1000;

const words = (value: string) => value
  .replace(/&(?:amp|lt|gt|quot|apos);/g, entity => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&apos;": "'" }[entity]!))
  .replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 256);

export async function listModelPlates(filePath: string, options: { thumbnails?: boolean } = {}): Promise<ModelPlates> {
  const { zip } = await readSafe3mfArchive(filePath);
  const text = async (name: string) => {
    const file = zip.file(name);
    if (!file) return "";
    const bytes = await file.async("nodebuffer");
    if (bytes.length > MAX_METADATA_BYTES) throw new Error(`${name} is too large to read.`);
    return bytes.toString("utf8");
  };
  // The model file can hold the whole mesh (a plain 3MF): scanned as bytes, never made one string.
  const modelBytes = await zip.file("3D/3dmodel.model")?.async("nodebuffer");
  const head = modelBytes?.subarray(0, 1024 * 1024).toString("utf8") ?? "";
  if (!/<(?:\w+:)?model\b/.test(head)) throw new Error("That file is not a 3MF model.");
  // An element named `tag`, plain or with a namespace prefix (<item …>, <p:item …>).
  const has = (tag: string) => !!modelBytes && [" ", ">", "/", "\n", "\r", "\t"].some(end => modelBytes.includes(`<${tag}${end}`) || modelBytes.includes(`:${tag}${end}`));
  const result: ModelPlates = { plate_count: 0, plates: [], project_filaments: [] };
  const metadata = new Map([...head.matchAll(/<metadata\s+name="([^"]+)"[^>]*>([^<]*)<\/metadata>/g)].map(match => [match[1], words(match[2])]));
  if (metadata.get("Title")) result.title = metadata.get("Title");
  if (metadata.get("Designer")) result.designer = metadata.get("Designer");
  if (metadata.get("License")) result.licence = metadata.get("License");

  const settings = await text("Metadata/model_settings.config");
  const objects = new Map([...settings.matchAll(/<object\b[^>]*\bid="(\d+)"[^>]*>([\s\S]*?)<\/object>/g)].map(match => {
    const name = /<metadata\s+key="name"\s+value="([^"]*)"/.exec(match[2]);
    return [match[1], words(name?.[1] ?? "")];
  }));
  const plates = new Map<number, ModelPlate>();
  const layouts = new Map<number, PlateLayout>();
  // A plate number out of range is skipped, as a slicer would not show it.
  const valid = (number: number) => Number.isSafeInteger(number) && number >= 1 && number <= MAX_PLATES;
  for (const match of settings.matchAll(/<plate\b[^>]*>([\s\S]*?)<\/plate>/g)) {
    const id = /<metadata\s+key="plater_id"\s+value="(\d+)"/.exec(match[1]);
    if (!id) continue;
    const number = Number(id[1]);
    if (!valid(number)) continue;
    const name = /<metadata\s+key="plater_name"\s+value="([^"]*)"/.exec(match[1]);
    const instances = [...match[1].matchAll(/<model_instance>([\s\S]*?)<\/model_instance>/g)].flatMap(instance => {
      const object = /<metadata\s+key="object_id"\s+value="(\d+)"/.exec(instance[1])?.[1];
      const identify = Number(/<metadata\s+key="identify_id"\s+value="(\d+)"/.exec(instance[1])?.[1]);
      return object !== undefined && Number.isSafeInteger(identify) && identify > 0
        ? [{ identify_id: identify, name: objects.get(object) ?? "" }] : [];
    }).slice(0, MAX_INSTANCES_PER_PLATE);
    layouts.set(number, { number, objectIds: [...match[1].matchAll(/<metadata\s+key="object_id"\s+value="(\d+)"/g)].map(item => item[1]) });
    plates.set(number, { index: number - 1, name: words(name?.[1] ?? "") || `Plate ${number}`, sliced: false, instances, filaments: [],
      objects: [...match[1].matchAll(/<metadata\s+key="object_id"\s+value="(\d+)"/g)].flatMap(item => objects.get(item[1]) ? [objects.get(item[1])!] : []) });
  }
  for (const name of Object.keys(zip.files)) {
    const match = /^Metadata\/plate_([1-9]\d*)\.(json|gcode)$/.exec(name);
    if (!match) continue;
    const number = Number(match[1]);
    if (!valid(number)) continue;
    const plate = plates.get(number) ?? { index: number - 1, name: `Plate ${number}`, objects: [], instances: [], sliced: false, filaments: [] };
    const layout = layouts.get(number) ?? { number, objectIds: [] };
    layouts.set(number, layout);
    if (match[2] === "gcode") plate.sliced = true;
    else {
      try {
        const value = JSON.parse(await text(name)) as { bbox_objects?: { name?: unknown }[]; filament_ids?: unknown };
        // Studio's record of the filaments this plate's slice uses (0-based project positions).
        if (Array.isArray(value.filament_ids)) layout.slicedFilamentIds = value.filament_ids.filter((id): id is number => Number.isInteger(id) && id >= 0 && id < 64);
        if (Array.isArray(value.bbox_objects)) plate.objects = value.bbox_objects
          .flatMap(object => typeof object.name === "string" && object.name !== "wipe_tower" ? [words(object.name)] : []).slice(0, 200);
      } catch { /* the plate keeps the objects model_settings lists */ }
    }
    plates.set(number, plate);
  }
  result.plates = [...plates.values()].sort((a, b) => a.index - b.index);
  // A standard single-build 3MF has no Bambu plate metadata: it is one plate.
  if (!result.plates.length) {
    result.plates.push({ index: 0, name: "Plate 1", objects: [], instances: [], sliced: false, filaments: [] });
    // Without plates every object is on the one plate.
    layouts.set(1, { number: 1, objectIds: [...settings.matchAll(/<object\b[^>]*\bid="(\d+)"/g)].map(match => match[1]) });
  }
  const geometry = has("item") && (has("mesh") || has("component"));
  if (!geometry) {
    // A sliced-only file (previews and G-code, no model): only its sliced plates can print.
    result.plates = result.plates.filter(plate => plate.sliced);
    if (!result.plates.length) throw new Error("This 3MF has previews and settings but no model or printable plate.");
  }
  // A slice's G-code without its plate_N.json gives no filament list: the derivation stands.
  const filaments = await plateFilaments(zip, settings, modelBytes && modelBytes.length <= 64 * 1024 * 1024 ? modelBytes.toString("utf8") : head,
    result.plates.map(plate => layouts.get(plate.index + 1) ?? { number: plate.index + 1, objectIds: [] }));
  for (const plate of result.plates) plate.filaments = filaments.plates.get(plate.index + 1) ?? [];
  result.project_filaments = filaments.project;
  if (options.thumbnails) for (const plate of result.plates) {
    const file = zip.file(`Metadata/plate_${plate.index + 1}.png`);
    if (!file) continue;
    const bytes = await file.async("nodebuffer");
    if (bytes.length <= MAX_THUMBNAIL_BYTES && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
      plate.thumbnail_png_base64 = bytes.toString("base64");
  }
  result.plate_count = result.plates.length;
  return result;
}
