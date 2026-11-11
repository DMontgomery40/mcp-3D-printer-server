/** Bounded private per-job evidence. No printer transport, polling, model call or control lives here. */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PrintGeometry } from "./print-geometry.js";
import {
  assessPhysical,
  type EvidenceFrame,
  type HeightMeasurement,
} from "./physical-evidence.js";
export type { PrintGeometry, HeightMeasurement };
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const stem = (value: string) =>
  path.posix
    .basename(value.replace(/\\/g, "/"))
    .replace(/(?:\.gcode)?\.3mf$|\.gcode$/i, "");
export const flightKey = (host: string, serial: string) => `${host}\n${serial}`;
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v)
    ? v
    : typeof v === "string" &&
        /^-?\d+(\.\d+)?$/.test(v) &&
        Number.isFinite(Number(v))
      ? Number(v)
      : null;
const token = (v: unknown): string | null =>
  typeof v === "string" && /^[a-zA-Z0-9 _.-]{1,48}$/.test(v) ? v : null;
const fields = (source: any, keys: string[]) =>
  Object.fromEntries(
    keys
      .filter((k) => source?.[k] !== undefined)
      .map((k) => [k, num(source[k])]),
  );
function tray(value: any): Record<string, unknown> {
  return {
    ...fields(value, [
      "id",
      "state",
      "remain",
      "nozzle_temp_min",
      "nozzle_temp_max",
    ]),
    tray_type: token(value?.tray_type),
    tray_info_idx: token(value?.tray_info_idx),
    tray_color:
      typeof value?.tray_color === "string" &&
      /^[\da-f]{6}([\da-f]{2})?$/i.test(value.tray_color)
        ? value.tray_color
        : null,
  };
}
/** An allowlist, not a recursive dump/redactor. Unknown fields and arbitrary strings never reach disk. */
export function flightSnapshot(
  raw: Record<string, any>,
): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {
    ...fields(raw, [
      "layer_num",
      "total_layer_num",
      "mc_percent",
      "print_error",
      "fail_reason",
      "mc_print_stage",
      "mc_print_sub_stage",
      "stg_cur",
      "ams_status",
      "hw_switch_state",
      "home_flag",
      "nozzle_temper",
      "nozzle_target_temper",
      "bed_temper",
      "bed_target_temper",
    ]),
    gcode_state: token(raw.gcode_state),
  };
  if (raw.observation_source === "adapter-progress")
    snapshot.observation_source = "adapter-progress";
  if (Array.isArray(raw.adapter_problems))
    snapshot.adapter_problems = raw.adapter_problems
      .slice(0, 32)
      .map((p: any) => ({
        code: token(p?.code),
        severity: ["fatal", "error", "warning", "info"].includes(p?.severity)
          ? p.severity
          : null,
      }));
  if (Array.isArray(raw.hms))
    snapshot.hms = raw.hms
      .slice(0, 32)
      .map((h: any) => fields(h, ["attr", "code"]));
  if (Array.isArray(raw.stg)) snapshot.stg = raw.stg.slice(0, 64).map(num);
  if (raw.ams && typeof raw.ams === "object")
    snapshot.ams = {
      ...fields(raw.ams, [
        "tray_now",
        "tray_tar",
        "tray_pre",
        "tray_exist_bits",
      ]),
      ams: Array.isArray(raw.ams.ams)
        ? raw.ams.ams.slice(0, 16).map((a: any) => ({
            ...fields(a, ["id"]),
            tray: Array.isArray(a?.tray) ? a.tray.slice(0, 16).map(tray) : [],
          }))
        : [],
    };
  if (raw.vt_tray) snapshot.vt_tray = tray(raw.vt_tray);
  if (Array.isArray(raw.vir_slot))
    snapshot.vir_slot = raw.vir_slot.slice(0, 4).map(tray);
  if (raw.device?.extruder)
    snapshot.extruder = {
      ...fields(raw.device.extruder, ["state"]),
      info: Array.isArray(raw.device.extruder.info)
        ? raw.device.extruder.info
            .slice(0, 4)
            .map((i: any) =>
              fields(i, ["id", "temp", "snow", "hnow", "hpre", "htar"]),
            )
        : [],
    };
  if (raw.xcam)
    snapshot.xcam = fields(raw.xcam, [
      "cfg",
      "printing_monitor",
      "spaghetti_detector",
      "print_halt",
    ]);
  return snapshot;
}
export interface FlightDispatch {
  sha256: string;
  jobName: string;
  mapping?: number[];
  materials?: string[];
  plate?: { index: number; sha256: string };
  expected?: PrintGeometry;
}
interface StoredDispatch extends Omit<FlightDispatch, "jobName" | "expected"> {
  jobHash: string;
}
export interface FlightRecord {
  version: 1;
  id: string;
  printerKey: string;
  dispatchedAt: string;
  dispatch: StoredDispatch;
  expected?: PrintGeometry;
  reports: Array<{ seq: number; at: string; changes: Record<string, unknown> }>;
  latest: Record<string, unknown>;
  droppedReports: number;
  nextSeq: number;
  frames: EvidenceFrame[];
  skippedCheckpoints: number[];
  storage: "durable" | "volatile";
}
export interface ReadRecordOptions {
  jobId?: string;
  includeFrames?: boolean;
  measurements?: HeightMeasurement[];
}
export class FlightRecords {
  private readonly dir: string;
  private readonly now: () => number;
  private readonly maxEvents: number;
  private readonly maxJobs: number;
  private readonly maxBytes: number;
  private readonly maxCaptureMs: number;
  private readonly cache = new Map<string, FlightRecord>();
  private readonly pending = new Map<string, Promise<void>>();
  private warned = false;
  constructor(
    options: {
      dir?: string;
      now?: () => number;
      maxEvents?: number;
      maxJobs?: number;
      maxBytes?: number;
      maxCaptureMs?: number;
    } = {},
  ) {
    this.dir =
      options.dir ??
      process.env.COUNTERPART_RECORD_DIR ??
      (process.env.BAMBU_RESUME_STATE_DIR
        ? path.join(process.env.BAMBU_RESUME_STATE_DIR, "print-records")
        : path.join(
            os.homedir(),
            ".config",
            "mcp-3d-printer-server",
            "print-records",
          ));
    this.maxCaptureMs = Math.max(
      1,
      Math.min(10000, options.maxCaptureMs ?? 10000),
    );
    this.now = options.now ?? Date.now;
    this.maxEvents = Math.max(2, Math.min(2048, options.maxEvents ?? 2048));
    this.maxJobs = Math.max(1, Math.min(10, options.maxJobs ?? 10));
    this.maxBytes = Math.max(
      4096,
      Math.min(1024 * 1024, options.maxBytes ?? 1024 * 1024),
    );
  }
  begin(key: string, input: FlightDispatch): string {
    if (!/^[a-f\d]{64}$/.test(input.sha256))
      throw Error("A print record requires an inspected artifact SHA-256.");
    const printerKey = hash(key),
      id = randomUUID();
    const record: FlightRecord = {
      version: 1,
      id,
      printerKey,
      dispatchedAt: new Date(this.now()).toISOString(),
      dispatch: {
        sha256: input.sha256,
        jobHash: hash(stem(input.jobName)),
        ...(input.mapping
          ? {
              mapping: input.mapping
                .slice(0, 64)
                .map((n) =>
                  Number.isInteger(n) && n >= -1 && n <= 4095 ? n : -1,
                ),
            }
          : {}),
        ...(input.materials
          ? {
              materials: input.materials
                .slice(0, 64)
                .map((m) => token(m) ?? "unknown"),
            }
          : {}),
        ...(input.plate && /^[a-f\d]{64}$/.test(input.plate.sha256)
          ? { plate: { index: input.plate.index, sha256: input.plate.sha256 } }
          : {}),
      },
      ...(input.expected ? { expected: structuredClone(input.expected) } : {}),
      reports: [],
      latest: {},
      droppedReports: 0,
      nextSeq: 1,
      frames: [],
      skippedCheckpoints: [],
      storage: "durable",
    };
    this.cache.set(printerKey, record);
    this.save(record);
    this.prune();
    return id;
  }
  observe(key: string, raw: Record<string, any>, at = this.now()): void {
    const record = this.get(key);
    if (!record || !Number.isFinite(at) || at < Date.parse(record.dispatchedAt))
      return;
    const names = [raw.subtask_name, raw.gcode_file].filter(
      (n): n is string => typeof n === "string" && !!n,
    );
    if (!names.some((n) => hash(stem(n)) === record.dispatch.jobHash)) return;
    if (
      ["FINISH", "FAILED", "IDLE"].includes(String(record.latest.gcode_state))
    )
      return;
    const previousAt = record.reports[record.reports.length - 1]?.at;
    if (previousAt && at < Date.parse(previousAt)) return;
    const snapshot = flightSnapshot(raw);
    const changes = Object.fromEntries(
      Object.entries(snapshot).filter(
        ([k, v]) => JSON.stringify(v) !== JSON.stringify(record.latest[k]),
      ),
    );
    if (!Object.keys(changes).length) return;
    record.latest = { ...record.latest, ...changes };
    record.reports.push({
      seq: record.nextSeq++,
      at: new Date(at).toISOString(),
      changes,
    });
    while (record.reports.length > this.maxEvents) {
      record.reports.shift();
      record.droppedReports++;
    }
    this.save(record);
  }
  read(key: string, options: ReadRecordOptions = {}) {
    if (
      options.jobId &&
      !/^[a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(options.jobId)
    )
      throw Error("Invalid print record ID.");
    const record = this.get(key, options.jobId);
    if (!record)
      return {
        contract: "counterpart/1" as const,
        status: "unavailable" as const,
        physical: assessPhysical([]),
      };
    const result = structuredClone(record);
    for (const frame of result.frames) {
      if (frame.status !== "captured") continue;
      try {
        const file = this.frameFile(record, frame.id),
          stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.size > 512 * 1024)
          throw Error("saved-frame-unavailable");
        if (options.includeFrames) {
          const bytes = fs.readFileSync(file);
          if (createHash("sha256").update(bytes).digest("hex") !== frame.sha256)
            throw Error("saved-frame-changed");
          frame.base64 = bytes.toString("base64");
        }
      } catch {
        frame.status = "unavailable";
        frame.reason = "saved-frame-unavailable";
      }
    }
    return {
      contract: "counterpart/1" as const,
      status: "recorded" as const,
      record: result,
      physical: assessPhysical(result.frames, options.measurements),
    };
  }
  /** Called only after existing reports/reads, never on a timer; a sample cannot block the print. */
  async sample(
    key: string,
    capture: () => Promise<{ base64?: string; capturedAt?: string }>,
  ): Promise<void> {
    const record = this.get(key),
      layer = num(record?.latest.layer_num);
    if (
      !record ||
      record.latest.gcode_state !== "RUNNING" ||
      !layer ||
      !record.expected?.heightMm ||
      this.pending.has(record.printerKey)
    )
      return;
    const geometry = record.expected.layers.find((l) => l.layer === layer);
    if (!geometry) return;
    const targets = [0.05, 0.3, 0.6, 0.9];
    const due = targets
      .map((ratio, index) => ({ ratio, index }))
      .filter(
        (t) =>
          geometry.zMm >= t.ratio * record.expected!.heightMm! &&
          !record.frames.some((f) => f.checkpoint === t.index) &&
          !record.skippedCheckpoints.includes(t.index),
      );
    if (!due.length || record.frames.length >= 4) return;
    const chosen = due[due.length - 1];
    record.skippedCheckpoints.push(...due.slice(0, -1).map((t) => t.index));
    const frame: EvidenceFrame = {
      id: randomUUID(),
      checkpoint: chosen.index,
      layer,
      expectedHeightMm: geometry.zMm,
      reportAt:
        record.reports[record.reports.length - 1]?.at ?? record.dispatchedAt,
      capturedAt: new Date(this.now()).toISOString(),
      status: "unavailable",
      reason: "capture-pending",
    };
    record.frames.push(frame);
    this.save(record);
    const work = (async () => {
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
          capture(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(Error("camera-deadline")),
              this.maxCaptureMs,
            );
          }),
        ]).finally(() => clearTimeout(timer));
        const capturedAt =
          result.capturedAt === undefined
            ? this.now()
            : Date.parse(result.capturedAt);
        if (
          !Number.isFinite(capturedAt) ||
          Math.abs(capturedAt - Date.parse(frame.reportAt)) > 15000 ||
          capturedAt > this.now() + 1000
        )
          throw Error("stale-frame");
        frame.capturedAt = new Date(capturedAt).toISOString();
        if (this.get(key)?.id !== record.id) throw Error("job-changed");
        if (
          !result.base64 ||
          result.base64.length > Math.ceil((512 * 1024 * 4) / 3) + 4
        )
          throw Error("frame-unavailable");
        const bytes = Buffer.from(result.base64, "base64");
        if (bytes.length > 512 * 1024 || bytes[0] !== 255 || bytes[1] !== 216)
          throw Error("invalid-frame");
        fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(this.frameFile(record, frame.id), bytes, {
          mode: 0o600,
        });
        frame.sha256 = createHash("sha256").update(bytes).digest("hex");
        frame.status = "captured";
        delete frame.reason;
      } catch {
        frame.reason = "camera-unavailable-or-job-changed";
      } finally {
        if (this.get(key)?.id === record.id || fs.existsSync(this.file(record)))
          this.save(record);
        this.pending.delete(record.printerKey);
      }
    })();
    this.pending.set(record.printerKey, work);
    await work;
  }
  private file(record: Pick<FlightRecord, "printerKey" | "id">) {
    return path.join(this.dir, `${record.printerKey}-${record.id}.json`);
  }
  private frameFile(record: FlightRecord, id: string) {
    return path.join(this.dir, `${record.printerKey}-${record.id}-${id}.jpg`);
  }
  private files(): string[] {
    try {
      return fs
        .readdirSync(this.dir)
        .filter((f) => /^[a-f\d]{64}-[a-f\d-]{36}\.json$/.test(f));
    } catch {
      return [];
    }
  }
  private get(key: string, id?: string): FlightRecord | undefined {
    const printerKey = hash(key),
      cached = this.cache.get(printerKey);
    if (cached && (!id || cached.id === id)) return cached;
    let latest: FlightRecord | undefined;
    for (const name of this.files().filter(
      (f) =>
        f.startsWith(printerKey + "-") &&
        (!id || f === `${printerKey}-${id}.json`),
    )) {
      try {
        const file = path.join(this.dir, name),
          stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.size > this.maxBytes) continue;
        const saved = JSON.parse(fs.readFileSync(file, "utf8")) as FlightRecord;
        if (
          saved.version !== 1 ||
          saved.printerKey !== printerKey ||
          this.file(saved) !== file ||
          !saved.dispatch?.sha256 ||
          !Array.isArray(saved.reports) ||
          !Array.isArray(saved.frames)
        )
          continue;
        if (!latest || saved.dispatchedAt > latest.dispatchedAt) latest = saved;
      } catch {
        /* A corrupt/incomplete file is unavailable, never a reason to connect to the printer. */
      }
    }
    if (latest && !id) this.cache.set(printerKey, latest);
    return latest;
  }
  private save(record: FlightRecord): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      record.storage = "durable";
      let text = JSON.stringify(record);
      while (
        Buffer.byteLength(text) > this.maxBytes &&
        record.reports.length > 1
      ) {
        record.reports.shift();
        record.droppedReports++;
        text = JSON.stringify(record);
      }
      if (Buffer.byteLength(text) > this.maxBytes) {
        record.expected = undefined;
        text = JSON.stringify(record);
      }
      if (Buffer.byteLength(text) > this.maxBytes)
        throw Error("record-too-large");
      const file = this.file(record),
        temporary = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, text, { mode: 0o600 });
      fs.renameSync(temporary, file);
      record.storage = "durable";
    } catch {
      record.storage = "volatile";
      if (!this.warned) {
        this.warned = true;
        console.error(
          "Print flight record storage is unavailable; diagnostics may not survive restart.",
        );
      }
    }
  }
  private prune(): void {
    try {
      const files = this.files()
        .map((name) => ({
          name,
          time: fs.statSync(path.join(this.dir, name)).mtimeMs,
        }))
        .sort((a, b) => b.time - a.time);
      for (const { name } of files.slice(this.maxJobs)) {
        const saved = JSON.parse(
          fs.readFileSync(path.join(this.dir, name), "utf8"),
        ) as FlightRecord;
        fs.unlinkSync(path.join(this.dir, name));
        for (const frame of saved.frames ?? [])
          try {
            fs.unlinkSync(this.frameFile(saved, frame.id));
          } catch {}
        if (this.cache.get(saved.printerKey)?.id === saved.id)
          this.cache.delete(saved.printerKey);
      }
    } catch {
      /* Diagnostic retention must never fail a printer operation. */
    }
  }
}
