/** Human confirmation for physical printer mutations (print start, positive heating). */
export type ConfirmHardware = (message: string) => Promise<boolean>;
export type ConfirmationScope = "bambu" | "generic";

/**
 * Ordinary print/heat prompts are on by default. Only an explicit "0" opts out.
 * PRINT_REQUIRE_CONFIRMATION applies to every printer type; the older
 * BAMBU_REQUIRE_CONFIRMATION applies to Bambu printers only. If any variable
 * relevant to the scope is set to another value, confirmation stays required.
 */
export function confirmationOptOut(scope: ConfirmationScope): boolean {
  const names = scope === "bambu"
    ? ["BAMBU_REQUIRE_CONFIRMATION", "PRINT_REQUIRE_CONFIRMATION"]
    : ["PRINT_REQUIRE_CONFIRMATION"];
  const values = names
    .map((name) => process.env[name]?.trim())
    .filter((value): value is string => value !== undefined && value !== "");
  return values.length > 0 && values.every((value) => value === "0");
}

/**
 * How long a human has to answer a confirmation prompt. The MCP SDK's default
 * request timeout (60 s) is too short for someone walking to the printer.
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
  "Human hardware confirmation requires an MCP client with elicitation support. For deliberately headless operation, " +
  "PRINT_REQUIRE_CONFIRMATION=0 (or BAMBU_REQUIRE_CONFIRMATION=0 for Bambu printers) disables ordinary print/heat prompts; " +
  "finished-bed clearance still requires elicitation. No command was sent.";

/**
 * physicalCheck marks confirmations that software cannot replace (for example a
 * previous part left on the bed). Those are required even when prompts are opted out.
 */
export async function requireHumanConfirmation(
  confirm: ConfirmHardware | undefined,
  message: string,
  scope: ConfirmationScope,
  physicalCheck = false
): Promise<void> {
  if (!physicalCheck && confirmationOptOut(scope)) return;
  if (!confirm || !(await confirm(message))) {
    throw new Error("Hardware safety confirmation was declined or unavailable. Use an MCP client with elicitation support. No command was sent.");
  }
}
