/**
 * Unpatched bambu-node 3.22.21 parses every MQTT report in an async listener and
 * throws from it for printers or state transitions it does not model: H2S/H2D/
 * H2C/H2D Pro/P2S serial prefixes, a get_version reply without an ota module, and
 * transitions such as PAUSE -> IDLE after a cancel. It also sends a PushAll
 * request on connect and leaves its 5 s timeout unhandled, which rejects when a
 * printer ignores third-party commands (LAN Only Mode without Developer Mode on
 * firmware 01.08.05 and later) but still broadcasts reports. Those throws become
 * unhandled promise rejections, which terminate Node by default.
 * bambu-printer-mcp avoids this with a postinstall patch; this package does not
 * install one.
 *
 * Safety checks here never rely on bambu-node's model or job tracking: they read
 * fresh raw MQTT reports. Only these exact internal errors originating inside
 * bambu-node are logged and ignored. Every other unhandled rejection is rethrown,
 * preserving Node's default crash behavior.
 */
const KNOWN_INTERNAL_ERRORS = new Set([
  "Printer model not supported!",
  "OTA module version data not found, unable to determine printer model!",
  "Edge case detected while updating printer status!",
  "Command execution timed out after 5 seconds.",
]);

let installed = false;

export function isKnownBambuNodeInternalError(reason: unknown): boolean {
  return (
    reason instanceof Error &&
    KNOWN_INTERNAL_ERRORS.has(reason.message) &&
    typeof reason.stack === "string" &&
    /[\\/]bambu-node[\\/]/.test(reason.stack)
  );
}

export function installBambuNodeRejectionGuard(): void {
  if (installed) return;
  installed = true;
  process.on("unhandledRejection", (reason) => {
    if (isKnownBambuNodeInternalError(reason)) {
      console.error(
        `[bambu-node] Ignored internal status-tracking error: ${(reason as Error).message} ` +
        "Safety checks use fresh raw MQTT reports instead."
      );
      return;
    }
    throw reason;
  });
}
