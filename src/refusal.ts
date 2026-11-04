/**
 * A printer refusal with a stable code, returned as structuredContent.code on the tool's error, so clients
 * such as Counterpart act on the code instead of matching the message (whose words, HMS numbers and
 * firmware details change with the printer). Nothing was sent to the printer when one of these is thrown.
 *
 * - printer-command-rejected: the printer refused the print command itself (for Bambu, HMS 0500-0500-0001-0007,
 *   MQTT command verification); the file is on the printer, nothing is printing.
 * - printer-not-ready: the printer isn't in a state that can start a print (busy, paused, failed, unknown).
 */
export const REFUSAL_CODES = ["printer-command-rejected", "printer-not-ready"] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];

export class PrinterRefusal extends Error {
  constructor(readonly code: RefusalCode, message: string) {
    super(message);
    this.name = "PrinterRefusal";
  }
}
