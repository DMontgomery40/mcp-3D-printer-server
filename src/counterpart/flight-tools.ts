import { PHYSICAL_EVIDENCE_SCHEMA } from "./physical-evidence.js";
import type { HeightMeasurement, ReadRecordOptions } from "./flight-record.js";
export const FLIGHT_RECORD_PROPERTIES = {
  list_jobs: {
    type: "boolean",
    description:
      "Include the retained job IDs, dispatch times, artifact hashes and outcomes for this printer, so an older job can be selected.",
  },
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
    jobs: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          dispatchedAt: { type: "string" },
          sha256: { type: "string" },
          outcome: { type: "string" },
        },
        required: ["id", "dispatchedAt", "sha256", "outcome"],
      },
    },
    physical: PHYSICAL_EVIDENCE_SCHEMA,
  },
  required: ["contract", "status", "physical"],
};
export function flightReadOptions(
  args: Record<string, unknown> = {},
): ReadRecordOptions {
  if (args.list_jobs !== undefined && typeof args.list_jobs !== "boolean")
    throw Error("list_jobs must be boolean.");
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
    listJobs: args.list_jobs as boolean | undefined,
    includeFrames: args.include_frames as boolean | undefined,
    measurements: measurements as HeightMeasurement[] | undefined,
  };
}

/** Keep saved JPEG bytes only in structuredContent, like the existing camera_frame tool. */
export function flightRecordResult<
  T extends {
    contract: string;
    record?: { frames: Array<{ base64?: string }> };
  },
>(view: T) {
  const metadata = {
    ...view,
    ...(view.record
      ? {
          record: {
            ...view.record,
            frames: view.record.frames.map(
              ({ base64: _image, ...frame }) => frame,
            ),
          },
        }
      : {}),
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(metadata) }],
    structuredContent: view,
  };
}
