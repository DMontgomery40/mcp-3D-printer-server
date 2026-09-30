import { createHash, randomUUID } from "node:crypto";
import { EventStore } from "./store.js";

function fingerprint(raw: Record<string, unknown>, preferred?: "subtask_id" | "task_id" | "gcode_file") {
  const meaningful = (value: unknown) => (typeof value === "string" && value.trim() !== "" && value !== "0") ||
    (typeof value === "number" && Number.isFinite(value) && value > 0);
  const source = preferred ?? (["subtask_id", "task_id", "gcode_file"] as const).find(key => meaningful(raw[key]));
  if (!source || !meaningful(raw[source])) return undefined;
  const label = {subtask_id:"subtask",task_id:"task",gcode_file:"file"}[source];
  return { digest: createHash("sha256").update(JSON.stringify([label, raw[source]])).digest("hex"), source };
}
function positiveCode(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 0xffffffff ? value : undefined;
}
/** Consumes internal normalized lifecycle reports; each source verifies its native signal. Never infers completion from progress. */
export class PrintEventDetector {
  private report: Record<string, unknown> = {};
  private connectedEpoch = false;
  constructor(readonly store: EventStore, readonly printer = "default") {}
  disconnected(): void { this.report = {}; this.connectedEpoch = false; }
  cancel(persist = true): void {
    if (this.store.observation(this.printer).active) {
      this.store.observation(this.printer).cancelled = true;
      if (persist) this.store.save();
    }
  }
  observe(update: Record<string, unknown>): void {
    if (update.command !== "push_status") return;
    // A fresh connection cannot borrow a job identity from the previous connection.
    this.report = { ...this.report, ...update };
    const state = this.store.observation(this.printer);
    const before = JSON.stringify(state);
    // Keep the originally observed identity field for this job. Late enrichment must not change it.
    const observed = fingerprint(this.report, state.active || (state.terminal && !this.connectedEpoch) ? state.fingerprintSource : undefined);
    const identity = observed?.digest;
    const status = this.report.gcode_state;
    const active = status === "RUNNING" || status === "PAUSE" || status === "PREPARE";
    if (status === "IDLE" || status === "CANCELLED" || status === "CANCELED") {
      state.active = false;
      state.cancelled = true;
      state.terminal = false;
    }
    if (active && identity && (update.gcode_state === "RUNNING" || update.gcode_state === "PAUSE" || update.gcode_state === "PREPARE") && (!state.active || state.fingerprint !== identity)) {
      // Do not re-arm an already terminal job from a reconnect's replayed RUNNING.
      if (!(state.terminal && state.fingerprint === identity && !this.connectedEpoch)) {
        // New jobs must not inherit the previous job's sparse fault fields.
        if (!Object.prototype.hasOwnProperty.call(update, "print_error")) delete this.report.print_error;
        if (!Object.prototype.hasOwnProperty.call(update, "hms")) delete this.report.hms;
        Object.assign(state, { fingerprint: identity, fingerprintSource: observed!.source, jobId: randomUUID(), active: true,
          cancelled: false, terminal: false, problems: [] });
      }
    }
    const event = (name: "print.completed" | "print.problem", reason?: "print_error" | "hms" | "failed", codes?: string[]) => {
      this.store.append({ eventId: randomUUID(), name, timestamp: new Date().toISOString(),
        data: { printer: this.printer, jobId: state.jobId!, ...(reason ? { reason, codes } : {}) } });
    };
    if (state.active && identity === state.fingerprint && state.jobId && !state.cancelled) {
      const error = positiveCode(this.report.print_error);
      const codes = Array.isArray(this.report.hms) ? this.report.hms.flatMap(entry => {
        if (!entry || typeof entry !== "object") return [];
        const code = positiveCode(entry.code);
        const attr = typeof entry.attr === "number" && Number.isInteger(entry.attr) && entry.attr >= 0 && entry.attr <= 0xffffffff ? entry.attr : undefined;
        // Same actionable/warning distinction as the print safety gate: severity 4 is informational.
        return code && attr !== undefined && Math.floor(code / 65536) !== 4 ? [`${attr.toString(16).padStart(8, "0")}-${code.toString(16).padStart(8, "0")}`] : [];
      }).sort() : [];
      for (const [reason, values] of [["print_error", error ? [String(error)] : []], ["hms", codes], ["failed", status === "FAILED" ? ["failed"] : []]] as const) {
        const fresh = values.filter(code => !state.problems.includes(`${reason}:${code}`));
        if (fresh.length) {
          state.problems.push(...fresh.map(code => `${reason}:${code}`));
          event("print.problem", reason, reason === "failed" ? [] : fresh);
        }
      }
      if (status === "FAILED") { state.active = false; state.terminal = true; }
      if (status === "FINISH") {
        // A failed or cancelled job never becomes a successful completion, even at 100%.
        const knownFaultState = this.report.print_error === 0 && Array.isArray(this.report.hms) && this.report.hms.every(entry =>
          entry && typeof entry === "object" && typeof entry.code === "number" && Number.isInteger(entry.code) && entry.code >= 0 && entry.code <= 0xffffffff &&
          typeof entry.attr === "number" && Number.isInteger(entry.attr) && entry.attr >= 0 && entry.attr <= 0xffffffff);
        if (knownFaultState && !error && !codes.length) event("print.completed");
        if (knownFaultState || error || codes.length) { state.active = false; state.terminal = true; }
      }
    }
    // Cancellation suppresses events, but terminal reports still close the observed job.
    if (state.active && identity === state.fingerprint && (status === "FAILED" || (status === "FINISH" && state.cancelled))) {
      state.active = false; state.terminal = true;
    }
    // Mark the epoch only after a terminal/idle baseline or a genuinely armed job.
    if (status === "FINISH" || status === "FAILED" || status === "IDLE" || state.active) this.connectedEpoch = true;
    if (before !== JSON.stringify(state)) this.store.save();
  }
}
