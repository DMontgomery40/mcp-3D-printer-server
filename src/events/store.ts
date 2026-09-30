import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface PrintEvent {
  eventId: string;
  name: "print.completed" | "print.problem";
  timestamp: string;
  data: { printer: "default"; jobId: string; reason?: "print_error" | "hms" | "failed"; codes?: string[] };
  cursor: string;
}
export interface ObservationState {
  fingerprint?: string;
  fingerprintSource?: "subtask_id" | "task_id" | "gcode_file";
  jobId?: string;
  active: boolean;
  cancelled: boolean;
  terminal: boolean;
  problems: string[];
}
export interface Subscription {
  id: string; owner: string; name: PrintEvent["name"]; url: string; secret: string;
  previousSecret?: string; rotateUntil?: number;
  expires: number; position: number; verifiedAt?: number;
  attempts: number; retryAt: number; stopped?: boolean;
}
interface Data {
  version: 1; sequence: number; history: PrintEvent[]; sourceCursor?: string;
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
      this.save();
    } catch (error) { unlinkSync(this.lock); throw error; }
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
  append(event: Omit<PrintEvent, "cursor">): PrintEvent {
    const saved = { ...event, cursor: String(++this.data.sequence) };
    this.data.history.push(saved);
    const removed = this.data.history.slice(0, Math.max(0, this.data.history.length - this.limit));
    for (const subscription of this.data.subscriptions) {
      if (removed.some(item => item.name === subscription.name && Number(item.cursor) > subscription.position)) subscription.stopped = true;
    }
    this.data.history = this.data.history.slice(-this.limit);
    return saved; // Caller commits event and observation atomically with save().
  }
  close(): void {
    if (!this.closed) { this.closed = true; unlinkSync(this.lock); }
  }
}
