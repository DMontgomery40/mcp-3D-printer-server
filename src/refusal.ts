/**
 * A refusal with a stable code, returned as structuredContent.code on the tool's error, so clients such as
 * Counterpart act on the code instead of matching the message (whose words, HMS numbers, firmware and slicer
 * details change). None of them starts a print.
 *
 * - printer-command-rejected: the printer refused the print command itself (for Bambu, HMS 0500-0500-0001-0007,
 *   MQTT command verification); the file was uploaded and the command sent, but nothing is printing.
 * - printer-not-ready: the printer isn't in a state that can start a print (busy, paused, failed, unknown).
 * - printer-upload-failed: the print file didn't reach the printer, so no print command was sent.
 * - slicer-waiting-on-dialog: the slicer stopped working (no CPU, no output) as it does while a window waits for an
 *   answer, and was stopped; nothing was sliced or sent. Not the slicer's verdict on the model: no slicer_report.
 */
export const REFUSAL_CODES = ["printer-command-rejected", "printer-not-ready", "printer-upload-failed", "slicer-waiting-on-dialog"] as const;
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
