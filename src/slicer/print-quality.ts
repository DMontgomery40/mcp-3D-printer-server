/**
 * slice_stl's `quality` and `strength` (PRD §8.4): a client's print-sheet choice, mapped here to the
 * slicer's own numbers so no client carries layer heights, wall counts or infill. Draft and Fine set
 * the layer height for the nozzle in use (0.28 and 0.12 mm on a 0.4 mm nozzle, scaled with it); Strong
 * and Max set walls and infill. Standard sends nothing: the resolved preset decides. An explicit
 * layer_height, wall_loops or sparse_infill_density in the same call wins over these.
 */
export const PRINT_QUALITIES = ["draft", "standard", "fine"] as const;
export const PRINT_STRENGTHS = ["standard", "strong", "max"] as const;

const LAYER_MM_AT_04: Record<string, number> = { draft: 0.28, fine: 0.12 };
const STRENGTH: Record<string, { wall_loops: number; sparse_infill_density: string }> = {
  strong: { wall_loops: 4, sparse_infill_density: "25%" },
  max: { wall_loops: 6, sparse_infill_density: "40%" },
};

/** The call's arguments with `quality` and `strength` written out as slicer settings. */
export function withPrintQuality<T extends Record<string, unknown> | undefined>(args: T, nozzleDiameter?: number): T {
  if (!args || (args.quality === undefined && args.strength === undefined)) return args;
  const quality = args.quality ?? "standard";
  const strength = args.strength ?? "standard";
  if (typeof quality !== "string" || !(PRINT_QUALITIES as readonly string[]).includes(quality)) {
    throw new Error(`quality must be one of ${PRINT_QUALITIES.join(", ")}.`);
  }
  if (typeof strength !== "string" || !(PRINT_STRENGTHS as readonly string[]).includes(strength)) {
    throw new Error(`strength must be one of ${PRINT_STRENGTHS.join(", ")}.`);
  }
  const out: Record<string, unknown> = { ...args };
  const scale = typeof nozzleDiameter === "number" && Number.isFinite(nozzleDiameter) && nozzleDiameter > 0 ? nozzleDiameter / 0.4 : 1;
  if (quality in LAYER_MM_AT_04 && out.layer_height === undefined) {
    out.layer_height = Math.round(LAYER_MM_AT_04[quality] * scale * 100) / 100;
  }
  if (strength in STRENGTH) {
    if (out.wall_loops === undefined) out.wall_loops = STRENGTH[strength].wall_loops;
    if (out.sparse_infill_density === undefined) out.sparse_infill_density = STRENGTH[strength].sparse_infill_density;
  }
  return out as T;
}

/** slice_stl input-schema properties for both arguments. */
export const PRINT_QUALITY_PROPERTIES = {
  quality: {
    type: "string", enum: [...PRINT_QUALITIES],
    description: "Print quality: draft (thicker layers, faster), standard (the preset's own layer height) or fine (thinner layers). The server picks the layer height for the nozzle in use; an explicit layer_height wins.",
  },
  strength: {
    type: "string", enum: [...PRINT_STRENGTHS],
    description: "Part strength: standard (the preset's walls and infill), strong or max (more walls and denser infill). The server picks the values; explicit wall_loops or sparse_infill_density win.",
  },
} as const;
