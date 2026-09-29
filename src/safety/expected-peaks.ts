export interface ExpectedPeakTemperatures {
  /** Expected highest positive nozzle target (S and R forms, every tool). */
  nozzle?: number;
  /** Expected highest positive bed target (S and R forms). */
  bed?: number;
}

/** Caller-declared options for guarded print and heating mutations. */
export interface PrintSafetyOptions {
  /** Bambu printer model (validated against the file and the live printer). */
  bambuModel?: string;
  /** Declared material for positive nozzle heating or G-code without slicer material metadata. */
  material?: string;
  /** Installed nozzle diameter for Bambu manual nozzle heating. */
  nozzleDiameter?: number;
  /** process_and_print_stl expectations; any mismatch refuses before upload. */
  expectedPeaks?: ExpectedPeakTemperatures;
}

/** Validate caller expectations before any network use. */
export function validateExpectedPeaks(expected: ExpectedPeakTemperatures | undefined): void {
  if (!expected) return;
  for (const component of ["nozzle", "bed"] as const) {
    const value = expected[component];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
      throw new Error(`Expected ${component} temperature must be a finite nonnegative number.`);
    }
  }
}

/** A requested expected peak must equal the inspected peak; a mismatch stops before upload. */
export function assertExpectedPeaks(
  expected: ExpectedPeakTemperatures | undefined,
  actual: { nozzle: number; bed: number }
): void {
  validateExpectedPeaks(expected);
  if (!expected) return;
  for (const component of ["nozzle", "bed"] as const) {
    const value = expected[component];
    if (value !== undefined && actual[component] !== value) {
      throw new Error(
        `Print safety: the job's highest ${component} target is ${actual[component]} C (S and R forms, every tool), ` +
        `but ${value} C was expected. Re-slice or correct the expected temperature. Nothing was uploaded or started.`
      );
    }
  }
}
