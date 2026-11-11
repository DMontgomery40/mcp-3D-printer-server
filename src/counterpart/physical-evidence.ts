/** Pure assessment of explicit client measurements, not an embedded vision model or success gate. */
export interface EvidenceFrame {
  role?: "baseline" | "first_layer" | "periodic" | "height";
  stage?: string;
  imageContentIndex?: number;
  id: string;
  capturedAt: string;
  reportAt: string;
  layer: number;
  expectedHeightMm: number;
  checkpoint: number;
  status: "captured" | "unavailable";
  reason?: string;
  sha256?: string;
  base64?: string;
}
export interface HeightMeasurement {
  frameId: string;
  visible: boolean;
  observedHeightMm: number;
  uncertaintyMm: number;
  method: string;
}
export interface PhysicalEvidence {
  assessment?: {
    required: boolean;
    frameId: string;
    referenceFrameIds: string[];
    layer: number;
    expectedHeightMm: number;
    expectedFootprintMm: [number, number, number, number];
    instruction: string;
  };
  status:
    | "unknown"
    | "consistent"
    | "suspect_no_growth"
    | "suspect_no_extrusion";
  evidence: string[];
  limitations: string[];
}
export function assessPhysical(
  frames: EvidenceFrame[],
  measurements: HeightMeasurement[] = [],
): PhysicalEvidence {
  const limitations = [
    "Firmware completion is separate from physical success.",
    "Layer Z and extrusion bounds are commanded geometry, not measured deposited plastic.",
    "Measurements are supplied by the client; this server does not interpret images.",
  ];
  const unknown = (reason: string): PhysicalEvidence => ({
    status: "unknown",
    evidence: [],
    limitations: [...limitations, reason],
  });
  if (measurements.length < 2 || measurements.length > 4)
    return unknown(
      "At least two usable calibrated frame measurements are required.",
    );
  const seen = new Set<string>();
  const usable: Array<{
    frame: EvidenceFrame;
    measurement: HeightMeasurement;
  }> = [];
  for (const measurement of measurements) {
    const frame = frames.find(
      (f) =>
        f.id === measurement.frameId &&
        f.status === "captured" &&
        f.role !== "baseline",
    );
    if (
      !frame ||
      seen.has(frame.id) ||
      !measurement.visible ||
      measurement.method !== "calibrated-height" ||
      !Number.isFinite(measurement.observedHeightMm) ||
      measurement.observedHeightMm < 0 ||
      !Number.isFinite(measurement.uncertaintyMm) ||
      measurement.uncertaintyMm < 0 ||
      measurement.uncertaintyMm > Math.max(2, frame.expectedHeightMm * 0.05) ||
      Math.abs(Date.parse(frame.capturedAt) - Date.parse(frame.reportAt)) >
        15000
    )
      return unknown(
        "A frame is unmatched, occluded/out of view, uncalibrated, too uncertain or too far from its report time.",
      );
    seen.add(frame.id);
    usable.push({ frame, measurement });
  }
  usable.sort((a, b) => a.frame.layer - b.frame.layer);
  const first = usable[0],
    last = usable[usable.length - 1];
  if (last.frame.expectedHeightMm - first.frame.expectedHeightMm < 5)
    return unknown("Expected height changed too little to assess growth.");
  if (
    usable.some(
      ({ frame, measurement: m }) =>
        m.observedHeightMm >
        frame.expectedHeightMm + Math.max(2, 3 * m.uncertaintyMm),
    ) ||
    usable.some(
      (b, i) =>
        i > 0 &&
        usable[i - 1].measurement.observedHeightMm -
          b.measurement.observedHeightMm >
          usable[i - 1].measurement.uncertaintyMm +
            b.measurement.uncertaintyMm +
            1,
    )
  )
    return unknown(
      "Calibrated heights contradict the expected extent or decrease between frames.",
    );
  const evidence = usable.map(({ frame }) => frame.id);
  const agrees = usable.every(
    ({ frame, measurement: m }) =>
      Math.abs(m.observedHeightMm - frame.expectedHeightMm) <=
      m.uncertaintyMm + 1,
  );
  if (agrees)
    return {
      status: "consistent",
      evidence,
      limitations: [
        ...limitations,
        "Consistent height in these frames only; shape, strength and final completion are unverified.",
      ],
    };
  // Two later frames must show an unchanged short part; a healthy earlier frame must not hide that plateau.
  for (let i = 1; i < usable.length; i++) {
    const a = usable[i - 1],
      b = usable[i];
    if (
      b.frame.expectedHeightMm - a.frame.expectedHeightMm >= 5 &&
      Math.abs(
        b.measurement.observedHeightMm - a.measurement.observedHeightMm,
      ) <=
        a.measurement.uncertaintyMm + b.measurement.uncertaintyMm + 0.5 &&
      b.measurement.observedHeightMm <
        b.frame.expectedHeightMm - Math.max(2, 3 * b.measurement.uncertaintyMm)
    )
      return {
        status: "suspect_no_growth",
        evidence: [a.frame.id, b.frame.id],
        limitations: [
          ...limitations,
          "Visible measured height plateaued while expected Z increased; cause is unverified.",
        ],
      };
  }
  return unknown(
    "The measurements do not establish either consistent growth or a no-growth plateau.",
  );
}

export const PHYSICAL_EVIDENCE_SCHEMA = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: [
        "unknown",
        "consistent",
        "suspect_no_growth",
        "suspect_no_extrusion",
      ],
    },
    assessment: { type: "object", additionalProperties: true },
    evidence: { type: "array", items: { type: "string" } },
    limitations: { type: "array", items: { type: "string" } },
  },
  required: ["status", "evidence", "limitations"],
};
