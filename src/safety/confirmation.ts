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
