/** Stable CAD refusals use the same structuredContent shape as printer refusals. */
export const CAD_REFUSAL_CODES = [
  "cad-uv-missing",
  "cad-data-volume-refused",
  "cad-setup-busy",
  "cad-operation-busy",
  "cad-queue-timeout",
  "cad-not-ready",
  "cad-confinement-unavailable",
  "cad-disabled",
  "cad-failed",
] as const;
export type CadRefusalCode = (typeof CAD_REFUSAL_CODES)[number];
export class CadRefusal extends Error {
  constructor(
    readonly code: CadRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = "CadRefusal";
  }
}
export function cadFailure(error: unknown, tool: string) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    status: "error" as const,
    code: error instanceof CadRefusal ? error.code : "cad-failed",
    message,
    tool,
    retryable: false,
    suggestion:
      "Resolve the reported CAD condition before making another request. Interrupted work is never replayed automatically.",
  };
}
