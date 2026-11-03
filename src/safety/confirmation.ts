/**
 * Human confirmation through MCP elicitation. Ordinary print starts, positive
 * heating and resumes of a re-read job do not ask: the client's own action is
 * the approval. Only a check that software cannot make asks a person, such as
 * resuming a job whose file the printer cannot hand back for re-reading.
 */
export type ConfirmHardware = (message: string) => Promise<boolean>;

/**
 * How long a person has to answer a prompt from the server (a resume of a job
 * that could not be re-read, or the Bambu printer-model prompt). The MCP SDK's
 * default request timeout (60 s) is too short for someone walking to the printer.
 */
export function confirmationTimeoutMs(): number {
  const raw = process.env.PRINT_CONFIRMATION_TIMEOUT_MS?.trim();
  const value = raw ? Number(raw) : 600_000;
  return Number.isInteger(value) && value >= 1_000 && value <= 3_600_000 ? value : 600_000;
}

export function confirmationTimedOut(timeoutMs: number): string {
  const minutes = timeoutMs / 60_000;
  return `No confirmation was received within ${minutes >= 1 ? `${Number(minutes.toFixed(1))} minute(s)` : `${timeoutMs / 1000} seconds`}; ` +
    "nothing was sent to the printer. Ask again when you are at the printer, or raise PRINT_CONFIRMATION_TIMEOUT_MS.";
}

export const CONFIRMATION_UNAVAILABLE =
  "This step needs a person to confirm a check at the printer, which requires an MCP client with elicitation support. No command was sent.";

/** Ask a person to accept a physical check that software cannot replace. */
export async function requireHumanConfirmation(confirm: ConfirmHardware | undefined, message: string): Promise<void> {
  if (!confirm) throw new Error(CONFIRMATION_UNAVAILABLE);
  if (!(await confirm(message))) {
    throw new Error(
      "Hardware safety confirmation was declined or cancelled in the MCP client. No command was sent. " +
      "This confirmation covers a physical check at the printer and always needs a person to accept it."
    );
  }
}
