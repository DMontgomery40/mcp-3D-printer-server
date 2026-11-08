import { AsyncLocalStorage } from "node:async_hooks";

/**
 * A printer refusal with a stable diagnostic code, retained for existing clients.
 * Counterpart uses structuredContent.printOutcome for dispatch truth, never
 * these firmware-specific codes or the message.
 *
 * - printer-command-rejected: the printer refused the print command itself (for Bambu, HMS 0500-0500-0001-0007,
 *   MQTT command verification); the file was uploaded and the command sent, but nothing is printing.
 * - printer-not-ready: the printer isn't in a state that can start a print (busy, paused, failed, unknown).
 * - printer-upload-failed: the print file didn't reach the printer, so no print command was sent.
 */
export const REFUSAL_CODES = ["printer-command-rejected", "printer-not-ready", "printer-upload-failed"] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];

export class PrinterRefusal extends Error {
  constructor(readonly code: RefusalCode, message: string) {
    super(message);
    this.name = "PrinterRefusal";
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
