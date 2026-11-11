import { PHYSICAL_EVIDENCE_SCHEMA } from "./physical-evidence.js";
import type { HeightMeasurement, ReadRecordOptions } from "./flight-record.js";
export const FLIGHT_RECORD_PROPERTIES = {
  job_id: {
    type: "string",
    description:
      "Saved record UUID; omit for the latest dispatched job on this printer.",
  },
  include_frames: {
    type: "boolean",
    description:
      "Include up to four saved JPEGs (512 KiB each). Reads disk only.",
  },
  measurements: {
    type: "array",
    maxItems: 4,
    description:
      "Optional calibrated client height measurements for saved frames; no image interpretation or printer control is performed.",
    items: {
      type: "object",
      properties: {
        frameId: {
          type: "string",
          description: "The saved frame UUID returned in this job record.",
        },
        visible: {
          type: "boolean",
          description:
            "The expected printed region and its maximum height are visible, unoccluded and in view.",
        },
        observedHeightMm: {
          type: "number",
          minimum: 0,
          description:
            "Client-calibrated maximum deposited Z height of this plate in the visible expected object region; use the same region across frames.",
        },
        uncertaintyMm: {
          type: "number",
          minimum: 0,
          description:
            "Estimated plus/minus error of the calibrated physical height measurement, in millimetres.",
        },
        method: {
          type: "string",
          enum: ["calibrated-height"],
          description:
            "An explicit calibrated height measurement from the client, never a pixel-change guess.",
        },
      },
      required: [
        "frameId",
        "visible",
        "observedHeightMm",
        "uncertaintyMm",
        "method",
      ],
      additionalProperties: false,
    },
  },
} as const;
export const FLIGHT_RECORD_DESCRIPTION =
  "Counterpart contract (counterpart/1): read a bounded persistent per-job flight record from disk, including dispatched SHA-256, selected mapping, timestamped allowlisted printer-report changes, expected selected-plate layer geometry and sampled camera evidence. Survives restart. No printer connection, polling or controls. Firmware FINISH is separate from physical unknown/consistent/suspect_no_growth. Without usable calibrated client measurements physical stays unknown. Missing history is unavailable, never fetched from the printer.";
export const FLIGHT_RECORD_OUTPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    contract: { type: "string", const: "counterpart/1" },
    status: { type: "string", enum: ["recorded", "unavailable"] },
    record: { type: "object", additionalProperties: true },
    physical: PHYSICAL_EVIDENCE_SCHEMA,
  },
  required: ["contract", "status", "physical"],
};
export function flightReadOptions(
  args: Record<string, unknown> = {},
): ReadRecordOptions {
  if (args.job_id !== undefined && typeof args.job_id !== "string")
    throw Error("job_id must be a saved record UUID.");
  if (
    args.include_frames !== undefined &&
    typeof args.include_frames !== "boolean"
  )
    throw Error("include_frames must be boolean.");
  if (
    args.measurements !== undefined &&
    (!Array.isArray(args.measurements) || args.measurements.length > 4)
  )
    throw Error("measurements must contain at most four entries.");
  const measurements = args.measurements as unknown[] | undefined;
  if (
    measurements?.some(
      (v) =>
        !v ||
        typeof v !== "object" ||
        typeof (v as any).frameId !== "string" ||
        typeof (v as any).visible !== "boolean" ||
        typeof (v as any).observedHeightMm !== "number" ||
        typeof (v as any).uncertaintyMm !== "number" ||
        typeof (v as any).method !== "string",
    )
  )
    throw Error("Invalid frame measurement.");
  return {
    jobId: args.job_id as string | undefined,
    includeFrames: args.include_frames as boolean | undefined,
    measurements: measurements as HeightMeasurement[] | undefined,
  };
}
