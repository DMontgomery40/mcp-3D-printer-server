import { PHYSICAL_EVIDENCE_SCHEMA } from "./physical-evidence.js";
import { validateVisualSubmission, VISIBILITIES } from "./visual-evidence.js";
import type { HeightMeasurement, ReadRecordOptions } from "./flight-record.js";
export const FLIGHT_RECORD_PROPERTIES = {
  view: {
    type: "string",
    enum: ["record", "evidence"],
    description:
      "Full journal (default), or compact vision evidence with omission counts. Image format defaults to evidence view to avoid sending a large journal to the worker.",
  },
  frame_format: {
    type: "string",
    enum: ["base64", "images"],
    description:
      "Return requested JPEGs once as structured base64 (default) or normal MCP image content for a vision worker.",
  },
  frame_ids: {
    type: "array",
    maxItems: 4,
    items: { type: "string" },
    description:
      "At most four saved frame IDs to retrieve; defaults to the pending assessment and baseline candidates, or recent evidence.",
  },
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
  "Counterpart contract (counterpart/1): read a bounded persistent per-job flight record from disk, including dispatched SHA-256, selected mapping, timestamped allowlisted printer-report changes, expected sliced layer geometry and sampled camera evidence. Survives restart. No printer connection, polling or controls. Firmware FINISH is separate from physical unknown/consistent/suspect_no_growth/suspect_no_extrusion. Inspect pending visual assessment requests with the client worker; clear empty-footprint observations can flag no extrusion without an empty-bed reference. Missing history is unavailable, never fetched from the printer.";
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
  if (
    args.view !== undefined &&
    !["record", "evidence"].includes(args.view as string)
  )
    throw Error("view must be record or evidence.");
  if (
    args.frame_format !== undefined &&
    !["base64", "images"].includes(args.frame_format as string)
  )
    throw Error("frame_format must be base64 or images.");
  if (
    args.frame_ids !== undefined &&
    (!Array.isArray(args.frame_ids) ||
      args.frame_ids.length > 4 ||
      args.frame_ids.some((v) => typeof v !== "string"))
  )
    throw Error("frame_ids must contain at most four saved frame IDs.");
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
    evidenceOnly:
      args.view === "evidence" ||
      (args.frame_format === "images" && args.view !== "record"),
    frameIds: args.frame_ids as string[] | undefined,
    jobId: args.job_id as string | undefined,
    listJobs: args.list_jobs as boolean | undefined,
    includeFrames:
      args.frame_format === "images"
        ? true
        : (args.include_frames as boolean | undefined),
    measurements: measurements as HeightMeasurement[] | undefined,
  };
}

/** Image bytes appear once: normal MCP images for vision, or structuredContent base64. */
export function flightRecordResult<
  T extends {
    contract: string;
    record?: { frames: Array<{ base64?: string; imageContentIndex?: number }> };
  },
>(view: T, asImages = false) {
  const metadata = structuredClone(view);
  const content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  > = [{ type: "text", text: "" }];
  for (const frame of metadata.record?.frames ?? []) {
    const bytes = frame.base64;
    delete frame.base64;
    if (asImages && bytes) {
      frame.imageContentIndex = content.length;
      content.push({ type: "image", data: bytes, mimeType: "image/jpeg" });
    }
  }
  content[0] = { type: "text", text: JSON.stringify(metadata) };
  return { content, structuredContent: asImages ? metadata : view };
}
export const PRINT_EVIDENCE_GUIDANCE =
  " When monitoring a print, firmware layer counters do not verify deposition. Follow physical.assessment requests at the first layer and later checkpoints: fetch counterpart_print_record with frame_format images, inspect the expected footprint with the client vision worker, then submit counterpart_print_assess. A clear empty footprint after attempted printing is suspect_no_extrusion; no baseline is required for that direct observation. Dark/occluded/unlocatable views are unknown. Never announce a first layer is down from counters alone. Do not stop or pause automatically.";
export const FLIGHT_ASSESS_DESCRIPTION =
  "Counterpart contract (counterpart/1): save a client vision worker observation against an exact saved job/artifact/frame hash. Local evidence only; no camera request, model call or printer controls. Clear visible empty expected footprint after attempted deposition reports suspect_no_extrusion, even without a usable baseline. Dark/occluded/unknown stays unknown; visible material does not verify success. Persists across restart; repeat observations are idempotent.";
export const FLIGHT_ASSESS_PROPERTIES = {
  job_id: {
    type: "string",
    description: "Saved job UUID returned by counterpart_print_record.",
  },
  artifact_sha256: {
    type: "string",
    description: "Exact dispatch SHA-256 returned in this job record.",
  },
  frame_id: {
    type: "string",
    description: "Saved printing frame ID that the client visually assessed.",
  },
  image_sha256: {
    type: "string",
    description: "Saved JPEG SHA-256 for that exact frame.",
  },
  visibility: {
    type: "string",
    enum: [...VISIBILITIES],
    description:
      "Client visual judgement of illumination and occlusion in the expected deposition region.",
  },
  footprint_visible: {
    type: "boolean",
    description:
      "The client can locate sufficient expected deposition footprint from the sliced geometry to judge whether material is present.",
  },
  deposition: {
    type: "string",
    enum: ["absent", "present", "unknown"],
    description:
      "Client visual observation in that footprint; absent means clearly empty, not merely an unchanged image.",
  },
  attempted: {
    type: "boolean",
    description:
      "The client establishes this image follows attempted object deposition. False or uncertain stays unknown; counters alone do not establish physical success.",
  },
  reference_frame_id: {
    type: "string",
    description:
      "Optional saved preparation-frame ID used as additional empty-bed context.",
  },
  reference_visibility: {
    type: "string",
    enum: [...VISIBILITIES],
    description:
      "Visibility of the expected footprint in the optional reference.",
  },
  reference_empty: {
    type: "boolean",
    description:
      "True only if the client visually confirmed the reference footprint is empty.",
  },
};
export const FLIGHT_ASSESS_REQUIRED = [
  "job_id",
  "artifact_sha256",
  "frame_id",
  "image_sha256",
  "visibility",
  "footprint_visible",
  "deposition",
  "attempted",
];
export function visualSubmission(args: Record<string, unknown> = {}) {
  return validateVisualSubmission({
    jobId: args.job_id as string,
    artifactSha256: args.artifact_sha256 as string,
    frameId: args.frame_id as string,
    imageSha256: args.image_sha256 as string,
    visibility: args.visibility as any,
    footprintVisible: args.footprint_visible as boolean,
    deposition: args.deposition as any,
    attempted: args.attempted as boolean,
    referenceFrameId: args.reference_frame_id as string | undefined,
    referenceVisibility: args.reference_visibility as any,
    referenceEmpty: args.reference_empty as boolean | undefined,
  });
}
