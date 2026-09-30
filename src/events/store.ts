import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface PrintEvent {
  eventId: string;
  name: "print.completed" | "print.problem";
  timestamp: string;
  data: { printer: string; jobId: string; test?: boolean; reason?: "print_error" | "hms" | "failed"; codes?: string[] };
  cursor: string;
  printerCursor?: string;
}
export interface ObservationState {
  sourceRecord?: string;
  fingerprint?: string;
  fingerprintSource?: "subtask_id" | "task_id" | "gcode_file";
  jobId?: string;
  active: boolean;
  cancelled: boolean;
  terminal: boolean;
  problems: string[];
}
export interface Subscription {
  id: string; owner: string; printer?: string; name: PrintEvent["name"]; url: string; secret: string;
  previousSecret?: string; rotateUntil?: number;
  expires: number; position: number; verifiedAt?: number;
  attempts: number; retryAt: number; stopped?: boolean;
}
interface Data {
  version: 1; journalId?: string; printerSequences?: Record<string, number>; sequence: number; history: PrintEvent[]; sourceCursor?: string; sourceCursors?: Record<string, string>; sourceJournalIds?: Record<string, string>; observations?: Record<string, ObservationState>;
  observation: ObservationState; subscriptions: Subscription[];
}
/** Private, bounded single-writer journal. Never place it inside a repository/package. */
export class EventStore {
  readonly data: Data;
  private readonly lock: string;
  private closed = false;
  constructor(readonly filename: string, readonly limit = 1000) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Invalid event history limit");
    this.filename = resolve(filename);
    this.lock = `${this.filename}.lock`;
    // A retained lock fails closed: the operator must confirm the old process exited.
    const fd = openSync(this.lock, "wx", 0o600);
    closeSync(fd);
    try {
      this.data = existsSync(this.filename) ? JSON.parse(readFileSync(this.filename, "utf8")) : {
        version: 1, sequence: 0, history: [],
        observation: { active: false, cancelled: false, terminal: false, problems: [] }, subscriptions: [],
      };
      if (this.data.version !== 1 || !Number.isSafeInteger(this.data.sequence) || this.data.sequence < 0 ||
          !Array.isArray(this.data.history) || !Array.isArray(this.data.subscriptions) ||
          !this.data.observation || !Array.isArray(this.data.observation.problems)) {
        throw new Error("Invalid print event journal");
      }
      this.data.journalId ??= randomUUID();
      this.data.printerSequences ??= {};
      for (const event of this.data.history) {
        const printer = event.data.printer;
        const previous = Object.prototype.hasOwnProperty.call(this.data.printerSequences, printer) ? this.data.printerSequences[printer] : 0;
        event.printerCursor ??= printer === "default" ? event.cursor : String(previous + 1);
        this.data.printerSequences[printer] = Math.max(previous, Number(event.printerCursor));
      }
      this.save();
    } catch (error) { unlinkSync(this.lock); throw error; }
  }
  observation(printer = "default"): ObservationState {
    if (printer === "default") return this.data.observation;
    this.data.observations ??= {};
    if (!Object.prototype.hasOwnProperty.call(this.data.observations, printer)) this.data.observations[printer] = { active: false, cancelled: false, terminal: false, problems: [] };
    return this.data.observations[printer];
  }
  save(): void {
    if (this.closed) throw new Error("Event journal is closed");
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify(this.data)); fsyncSync(fd); } finally { closeSync(fd); }
    try {
      renameSync(temporary, this.filename);
      if (process.platform !== "win32") {
        const directory = openSync(dirname(this.filename), "r");
        try { fsyncSync(directory); } finally { closeSync(directory); }
      }
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  printerHead(printer: string): number {
    return Object.prototype.hasOwnProperty.call(this.data.printerSequences, printer) ? this.data.printerSequences![printer] : 0;
  }
  append(event: Omit<PrintEvent, "cursor">): PrintEvent {
    const printerSequence = this.printerHead(event.data.printer) + 1;
    this.data.printerSequences![event.data.printer] = printerSequence;
    const saved = { ...event, cursor: String(++this.data.sequence), printerCursor: String(printerSequence) };
    this.data.history.push(saved);
    const removed = this.data.history.slice(0, Math.max(0, this.data.history.length - this.limit));
    for (const subscription of this.data.subscriptions) {
      if (removed.some(item => item.name === subscription.name && item.data.printer === (subscription.printer ?? "default") && Number(item.printerCursor) > subscription.position)) subscription.stopped = true;
    }
    this.data.history = this.data.history.slice(-this.limit);
    return saved; // Caller commits event and observation atomically with save().
  }
  close(): void {
    if (!this.closed) { this.closed = true; unlinkSync(this.lock); }
  }
}
