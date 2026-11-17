import { AsyncLocalStorage } from "node:async_hooks";

/**
 * A refusal with a stable code, returned as structuredContent.code on the tool's error, so clients such as
 * Counterpart act on the code instead of matching the message (whose words, HMS numbers, firmware and slicer
 * details change). None of them starts a print. For whether a print command was sent, Counterpart uses
 * structuredContent.printOutcome (dispatch truth), never these codes or the message.
 *
 * - printer-command-rejected: the printer refused the print command itself (for Bambu, HMS 0500-0500-0001-0007,
 *   MQTT command verification); the file was uploaded and the command sent, but nothing is printing.
 * - printer-not-ready: the printer isn't in a state that can start a print (busy, paused, failed, unknown).
 * - printer-upload-failed: the print file didn't reach the printer, so no print command was sent.
 * - slicer-waiting-on-dialog: the slicer stopped working (no CPU, no output) as it does while a window waits for an
 *   answer, and was stopped; nothing was sliced or sent. Not the slicer's verdict on the model: no slicer_report.
 * - needs-more-filaments: the design is in more colours than there are filaments to slice it with (a two-colour 3MF on
 *   a printer with no AMS loaded); nothing was sliced. structuredContent.filament_slots says how many of each, and
 *   slicer_report.message the plain answer a client shows (scan-to-make #858, the DAD pass).
 */
export const REFUSAL_CODES = ["printer-command-rejected", "printer-not-ready", "printer-upload-failed", "slicer-waiting-on-dialog", "needs-more-filaments"] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];

export class PrinterRefusal extends Error {
  constructor(readonly code: RefusalCode, message: string) {
    super(message);
    this.name = "PrinterRefusal";
  }
}

/** A slicer stopped because it waited on a dialog (src/slicer/slicer-launch.ts); carries slicer-waiting-on-dialog. */
export class SlicerStalled extends PrinterRefusal {
  constructor(message: string) {
    super("slicer-waiting-on-dialog", message);
    this.name = "SlicerStalled";
  }
}

/** counterpart/1 dispatch-tool errors describe dispatch truth independently of firmware-specific codes. */
export type PrintOutcome = "not-sent" | "unknown" | "rejected";
const printDispatch = new AsyncLocalStorage<{ attempted: boolean }>();
export function withPrintDispatch<T>(run: () => T): T {
  return printDispatch.run({ attempted: false }, run);
}
/** Call immediately before handing a print command to a transport. An acknowledgement may then be lost. */
export function markPrintCommandSent(): void {
  const dispatch = printDispatch.getStore();
  if (dispatch) dispatch.attempted = true;
}
export function printOutcome(error: unknown): PrintOutcome {
  if (error instanceof PrinterRefusal && error.code === "printer-command-rejected") return "rejected";
  return printDispatch.getStore()?.attempted === false ? "not-sent" : "unknown";
}

/**
 * More filament colours than filament slots to slice with: the plain answer a person is shown, and the counts. The
 * DAD pass sliced its two-colour 3MF for a P1S with no AMS loaded and got only "2 filament colours were supplied for
 * 1 filament slots".
 */
export class FilamentSlotsError extends PrinterRefusal {
  readonly plain: string;
  /** The filament changes the slice would make, when the slicer reported them (a printer with too few feeds). */
  readonly changes?: number;
  /** The slicer's own words, or this server's when the printer's feeds decided it. */
  readonly detail: string;
  /** The printer's feeds and the slice's colours, when they decided it (slice_stl's filament_feed). */
  feed?: Record<string, unknown>;
  /** The slicer's own result.json for the slice the printer's feeds refused. */
  slicerResult?: unknown;
  /**
   * colours: the colours the design prints with; slots: the filaments there are to feed them (slice slots, or the
   * printer's AMS trays plus external spools). `options` carries the plain sentence when the printer's feeds decide
   * it, and the filament changes the slice would make.
   */
  constructor(readonly colours: number, readonly slots: number, options: { plain?: string; changes?: number } = {}) {
    const plain = options.plain ?? `This design is in ${colours} colours, but only ${slots} filament${slots === 1 ? " is" : "s are"} available to print it. It needs a printer with an AMS loaded with ${colours} colours, or it can print in one colour.`;
    const detail = options.plain
      ? `The design prints in ${colours} filaments and the printer can feed ${slots}${options.changes !== undefined ? `; the slice makes ${options.changes} filament changes` : ""}.`
      : `${colours} filament colours were supplied for ${slots} filament slots.`;
    super("needs-more-filaments", `${plain}\n${options.plain ? "The slice said" : "The slicer setup said"}: ${detail}`);
    this.name = "FilamentSlotsError";
    this.plain = plain;
    this.detail = detail;
    if (options.changes !== undefined) this.changes = options.changes;
  }
}
