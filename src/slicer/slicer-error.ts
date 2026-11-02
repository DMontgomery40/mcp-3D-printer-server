/**
 * Slicer failures carry their own phase and actionable suggestion so the MCP
 * error handler never falls back to printer-connectivity advice for a local
 * profile or slicer problem.
 */

export type SlicerFailurePhase = "preparation" | "execution" | "output";

export interface SlicerFailureDetails {
  slicerType?: string;
  slicerPath?: string;
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  cancelled?: boolean;
  stdoutTail?: string;
  stderrTail?: string;
}

const BAMBU_COMPATIBLE = new Set(["bambustudio", "orcaslicer", "orcaslicer-bambulab"]);

export function slicerSuggestion(phase: SlicerFailurePhase, slicerType?: string): string {
  const bambu = slicerType !== undefined && BAMBU_COMPATIBLE.has(slicerType);
  switch (phase) {
    case "preparation":
      return bambu
        ? "Slicer profile preparation failed before the slicer ran. Check that bambu_model and nozzle_diameter " +
            "match an installed machine preset in the selected slicer's BBL profile tree (set BAMBU_PROFILES_ROOT " +
            "for non-standard installs), that slicer_profile/filament paths exist and are valid JSON, and that " +
            "BAMBU_SLICER_PROFILE_DIRS points at directories containing any custom parents. Otherwise slice in the " +
            "GUI and print the exported .gcode.3mf."
        : "Slicer setup failed before the slicer ran. Check slicer_path, slicer_profile, and filament_profile.";
    case "execution":
      return "The slicer process failed. Read the exit code and slicer output above: fix the reported profile, " +
        "model, or flag problem (or raise SLICER_TIMEOUT_MS for a timeout), or slice in the GUI and print the " +
        "exported file. Nothing was uploaded or printed.";
    case "output":
      return "The slicer exited without producing a printable result. Check the slicer output above, confirm the " +
        "model fits the selected printer's plate, or slice in the GUI and export the sliced plate. Nothing was " +
        "uploaded or printed.";
  }
}

/** Bambu Studio's or OrcaSlicer's own result.json, parsed verbatim. */
export type SlicerResult = Record<string, unknown>;

/** The slicer's own words: error_string, then each plate's warning_message. */
export function slicerResultText(result: SlicerResult): string {
  const plates = Array.isArray(result.sliced_plates) ? result.sliced_plates : [];
  return [
    result.error_string,
    ...plates.map((plate) => plate && typeof plate === "object" ? (plate as Record<string, unknown>).warning_message : undefined),
  ].filter((text): text is string => typeof text === "string" && text.trim() !== "").map((text) => text.trim()).join("\n");
}

export class SlicerError extends Error {
  readonly phase: SlicerFailurePhase;
  readonly suggestion: string;
  readonly details: SlicerFailureDetails;
  /** The slicer's own words from `slicerResult`; the message starts with them. */
  readonly slicerText: string;

  constructor(phase: SlicerFailurePhase, message: string, details: SlicerFailureDetails = {}, readonly slicerResult?: SlicerResult) {
    const slicerText = slicerResult ? slicerResultText(slicerResult) : "";
    super(slicerText ? `${slicerText}\n${message}` : message);
    this.name = "SlicerError";
    this.phase = phase;
    this.details = details;
    this.slicerText = slicerText;
    this.suggestion = slicerSuggestion(phase, details.slicerType);
  }
}

/** Keep the last lines of slicer output; the actionable line is usually at the end. */
export function tailText(text: string, maxLines = 25, maxChars = 4000): string {
  const trimmed = text.replace(/\s+$/, "");
  if (!trimmed) return "";
  let tail = trimmed.split(/\r?\n/).slice(-maxLines).join("\n");
  if (tail.length > maxChars) tail = `...${tail.slice(-maxChars)}`;
  return tail;
}

/** Wrap a preparation failure (profile lookup, flattening, arguments) without losing its message. */
export function asPreparationError(error: unknown, details: SlicerFailureDetails): SlicerError {
  if (error instanceof SlicerError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new SlicerError("preparation", `Slicer preparation failed: ${message}`, details);
}
