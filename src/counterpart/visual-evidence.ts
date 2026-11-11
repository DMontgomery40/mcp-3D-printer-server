/** Visual observations come from the client's worker; this module runs no image model or printer I/O. */
import type { EvidenceFrame, PhysicalEvidence } from "./physical-evidence.js";
import type { PrintGeometry } from "./print-geometry.js";

export const VISIBILITIES = [
  "clear",
  "dark",
  "occluded",
  "out_of_view",
  "unknown",
] as const;
export type Visibility = (typeof VISIBILITIES)[number];
export interface VisualSubmission {
  jobId: string;
  artifactSha256: string;
  frameId: string;
  imageSha256: string;
  visibility: Visibility;
  footprintVisible: boolean;
  deposition: "absent" | "present" | "unknown";
  attempted: boolean;
  referenceFrameId?: string;
  referenceVisibility?: Visibility;
  referenceEmpty?: boolean;
}
export interface VisualObservation extends VisualSubmission {
  at: string;
  source: "client-vision";
}
const uuid = /^[a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}$/i,
  sha = /^[a-f\d]{64}$/i;
export function validateVisualSubmission(
  v: VisualSubmission,
): VisualSubmission {
  if (
    !v ||
    !uuid.test(v.jobId) ||
    !uuid.test(v.frameId) ||
    !sha.test(v.artifactSha256) ||
    !sha.test(v.imageSha256) ||
    !VISIBILITIES.includes(v.visibility) ||
    typeof v.footprintVisible !== "boolean" ||
    typeof v.attempted !== "boolean" ||
    !["absent", "present", "unknown"].includes(v.deposition) ||
    (v.referenceFrameId !== undefined &&
      (!uuid.test(v.referenceFrameId) ||
        !VISIBILITIES.includes(v.referenceVisibility!))) ||
    (v.referenceEmpty !== undefined && typeof v.referenceEmpty !== "boolean")
  )
    throw Error("Invalid visual observation.");
  return {
    jobId: v.jobId,
    artifactSha256: v.artifactSha256,
    frameId: v.frameId,
    imageSha256: v.imageSha256,
    visibility: v.visibility,
    footprintVisible: v.footprintVisible,
    deposition: v.deposition,
    attempted: v.attempted,
    ...(v.referenceFrameId
      ? {
          referenceFrameId: v.referenceFrameId,
          referenceVisibility: v.referenceVisibility,
          referenceEmpty: v.referenceEmpty === true,
        }
      : {}),
  };
}
export function assessVisual(
  frames: EvidenceFrame[],
  observations: VisualObservation[],
  expected?: PrintGeometry,
): PhysicalEvidence | undefined {
  const observation = observations.at(-1);
  if (!observation) return;
  const limitations = [
    "Firmware completion is separate from physical success.",
    "Image interpretation is supplied by the client vision worker; the MCP runs no vision model.",
  ];
  const unknown = (reason: string): PhysicalEvidence => ({
    status: "unknown",
    evidence: [],
    limitations: [...limitations, reason],
  });
  const frame = frames.find(
    (f) =>
      f.id === observation.frameId &&
      f.status === "captured" &&
      f.sha256 === observation.imageSha256 &&
      f.role !== "baseline",
  );
  const footprint = expected?.layers.find(
    (l) => l.layer === frame?.layer,
  )?.boundsMm;
  if (
    !frame ||
    !footprint ||
    !footprint.every(Number.isFinite) ||
    footprint[2] <= footprint[0] ||
    footprint[3] <= footprint[1] ||
    !Number.isFinite(Date.parse(frame.capturedAt)) ||
    !Number.isFinite(Date.parse(frame.reportAt)) ||
    Math.abs(Date.parse(frame.capturedAt) - Date.parse(frame.reportAt)) >
      15000 ||
    !observation.attempted
  )
    return unknown(
      "Saved frame, expected deposition footprint or attempted-layer evidence is unavailable.",
    );
  if (
    observation.visibility !== "clear" ||
    !observation.footprintVisible ||
    observation.deposition === "unknown"
  )
    return unknown(
      "The expected footprint is dark, occluded, out of view, unlocatable or unassessed.",
    );
  if (observation.deposition === "present")
    return unknown(
      "The client reports visible material; height, coverage and final success remain unverified.",
    );
  const reference = frames.find(
    (f) => f.id === observation.referenceFrameId && f.status === "captured",
  );
  const evidence = [frame.id];
  if (
    reference &&
    observation.referenceVisibility === "clear" &&
    observation.referenceEmpty === true
  )
    evidence.unshift(reference.id);
  return {
    status: "suspect_no_extrusion",
    evidence,
    limitations: [
      ...limitations,
      "The client reports a clear expected footprint with no visible deposited material after deposition was attempted. Check the print; the cause is unverified.",
      ...(evidence.length === 1
        ? [
            "No usable empty-bed reference was supplied; the clear empty-footprint observation is direct evidence.",
          ]
        : [
            "The client compared the frame with the saved empty-bed reference.",
          ]),
    ],
  };
}
export function assessmentRequest(
  frames: EvidenceFrame[],
  observations: VisualObservation[],
  expected?: PrintGeometry,
) {
  const pending = frames.filter(
    (f) =>
      f.status === "captured" &&
      f.role !== "baseline" &&
      !observations.some((o) => o.frameId === f.id),
  );
  const frame = pending.find((f) => f.role === "first_layer") ?? pending.at(-1);
  const footprint = expected?.layers.find(
    (l) => l.layer === frame?.layer,
  )?.boundsMm;
  if (!frame || !footprint) return;
  return {
    required: true,
    frameId: frame.id,
    referenceFrameIds: frames
      .filter((f) => f.role === "baseline" && f.status === "captured")
      .map((f) => f.id),
    layer: frame.layer,
    expectedHeightMm: frame.expectedHeightMm,
    expectedFootprintMm: footprint,
    instruction:
      "Fetch this frame (and any usable reference) with counterpart_print_record include_frames:true frame_format:images. Have the client vision worker locate the expected footprint. Record its observation with counterpart_print_assess. A clearly empty footprint after attempted printing is suspect_no_extrusion even without a usable reference. Dark/occluded/unlocatable is unknown. Never infer a first layer is down from counters.",
  };
}

export function physicalProblems(physical: PhysicalEvidence) {
  return physical.status === "suspect_no_extrusion"
    ? [
        {
          code: "physical-no-extrusion",
          severity: "error" as const,
          message:
            "Possible extrusion failure: the expected print area appeared empty. Check the print.",
        },
      ]
    : [];
}
