/** Bounded private per-job evidence. No printer transport, polling, model call or control lives here. */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assessVisual,
  assessmentRequest,
  validateVisualSubmission,
  type VisualSubmission,
  type VisualObservation,
} from "./visual-evidence.js";
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
const diagnosticScalar = (value: unknown): number | string | boolean | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  return typeof value === "string" &&
    /^(?:-?\d+(?:\.\d+)?|(?:0x)?[a-f\d]{1,16})$/i.test(value)
    ? value
    : null;
};
const fields = (source: any, keys: string[]) =>
  Object.fromEntries(
    keys
      .filter((k) => source?.[k] !== undefined)
      .map((k) => [k, diagnosticScalar(source[k])]),
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
  outcome: "unconfirmed" | "accepted" | "observed-active";
  acceptedAt?: string;
}
export interface FlightRecord {
  version: 1;
  seenActive: boolean;
  owner?: { pid: number; token: string };
  endedAt?: string;
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
  droppedFrames: number;
  sampledCheckpoints?: number[];
  visualObservations?: VisualObservation[];
  omittedReports?: number;
  omittedGeometryLayers?: number;
  storage: "durable" | "volatile";
}
export interface ReadRecordOptions {
  evidenceOnly?: boolean;
  frameIds?: string[];
  listJobs?: boolean;
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
  private readonly ownerToken = randomUUID();
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
    const printerKey = hash(key);
    const id = randomUUID();
    const record: FlightRecord = {
      version: 1,
      seenActive: false,
      owner: { pid: process.pid, token: this.ownerToken },
      id,
      printerKey,
      dispatchedAt: new Date(this.now()).toISOString(),
      dispatch: {
        sha256: input.sha256,
        jobHash: hash(stem(input.jobName)),
        outcome: "unconfirmed",
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
      droppedFrames: 0,
      sampledCheckpoints: [],
      storage: "durable",
    };
    this.cache.set(printerKey, record);
    this.save(record);
    this.prune();
    return id;
  }
  accept(key: string, jobName: string): boolean {
    const record = this.get(key);
    if (
      !record ||
      record.dispatch.jobHash !== hash(stem(jobName)) ||
      !this.canWrite(record)
    )
      return false;
    if (!record.seenActive) record.dispatch.outcome = "accepted";
    record.dispatch.acceptedAt = new Date(this.now()).toISOString();
    this.save(record);
    return true;
  }
  observe(key: string, raw: Record<string, any>, at = this.now()): void {
    const record = this.get(key);
    if (
      !record ||
      !this.canWrite(record) ||
      !Number.isFinite(at) ||
      at < Date.parse(record.dispatchedAt)
    )
      return;
    const names = [raw.subtask_name, raw.gcode_file].filter(
      (n): n is string => typeof n === "string" && !!n,
    );
    if (!names.some((n) => hash(stem(n)) === record.dispatch.jobHash)) return;
    if (record.endedAt) return;
    const previousAt = record.reports[record.reports.length - 1]?.at;
    if (previousAt && at < Date.parse(previousAt)) return;
    const snapshot = flightSnapshot(raw);
    const changes = Object.fromEntries(
      Object.entries(snapshot).filter(
        ([k, v]) => JSON.stringify(v) !== JSON.stringify(record.latest[k]),
      ),
    );
    if (!Object.keys(changes).length) return;
    const state = String(snapshot.gcode_state);
    if (["PREPARE", "SLICING", "RUNNING", "PAUSE"].includes(state)) {
      record.seenActive = true;
      record.dispatch.outcome = "observed-active";
    }
    if (record.seenActive && ["FINISH", "FAILED", "IDLE"].includes(state))
      record.endedAt = new Date(at).toISOString();
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
    const jobs = options.listJobs ? this.jobSummaries(key) : undefined;
    const record = this.get(key, options.jobId);
    if (!record)
      return {
        contract: "counterpart/1" as const,
        status: "unavailable" as const,
        ...(jobs ? { jobs } : {}),
        physical: assessPhysical([]),
      };
    const result = structuredClone(record);
    delete result.owner;
    const observations = this.visuals(record);
    result.visualObservations = observations;
    if (
      options.frameIds &&
      (options.frameIds.length > 4 ||
        options.frameIds.some((id) => !result.frames.some((f) => f.id === id)))
    )
      throw Error("Requested frame is not part of this job (at most four).");
    const request = assessmentRequest(
      result.frames,
      observations,
      result.expected,
    );
    const selected = new Set(
      options.frameIds ??
        (request
          ? [request.frameId, ...request.referenceFrameIds]
          : observations.length
            ? [
                observations.at(-1)!.frameId,
                ...(observations.at(-1)!.referenceFrameId
                  ? [observations.at(-1)!.referenceFrameId!]
                  : []),
              ]
            : result.frames
                .filter((f) => f.status === "captured")
                .slice(-4)
                .map((f) => f.id)
        ).slice(0, 4),
    );
    const verify = new Set(
      observations
        .slice(-1)
        .flatMap((o) => [
          o.frameId,
          ...(o.referenceFrameId ? [o.referenceFrameId] : []),
        ]),
    );
    for (const frame of result.frames) {
      if (frame.status !== "captured") continue;
      try {
        const file = this.frameFile(record, frame.id),
          stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.size > 512 * 1024)
          throw Error("saved-frame-unavailable");
        if (
          (options.includeFrames && selected.has(frame.id)) ||
          verify.has(frame.id)
        ) {
          const bytes = fs.readFileSync(file);
          if (createHash("sha256").update(bytes).digest("hex") !== frame.sha256)
            throw Error("saved-frame-changed");
          if (options.includeFrames && selected.has(frame.id))
            frame.base64 = bytes.toString("base64");
        }
      } catch {
        frame.status = "unavailable";
        frame.reason = "saved-frame-unavailable";
      }
    }
    const physical = options.measurements?.length
      ? assessPhysical(result.frames, options.measurements)
      : (assessVisual(result.frames, observations, result.expected) ??
        assessPhysical(result.frames));
    physical.assessment = assessmentRequest(
      result.frames,
      observations,
      result.expected,
    );
    if (options.evidenceOnly) {
      result.omittedReports = result.reports.length;
      result.reports = [];
      if (result.expected) {
        const layers = result.expected.layers.filter((l) =>
          result.frames.some((f) => selected.has(f.id) && f.layer === l.layer),
        );
        result.omittedGeometryLayers =
          result.expected.layers.length - layers.length;
        result.expected = { ...result.expected, layers };
      }
    }
    return {
      contract: "counterpart/1" as const,
      status: "recorded" as const,
      ...(jobs ? { jobs } : {}),
      record: result,
      physical,
    };
  }
  /** Persist only the client's frame-bound visual observation, without printer I/O or journal ownership changes. */
  submitVisual(key: string, input: VisualSubmission) {
    const value = validateVisualSubmission(input),
      record = this.get(key, value.jobId);
    if (!record || record.dispatch.sha256 !== value.artifactSha256)
      throw Error("Visual observation does not match the saved job/artifact.");
    const frame = record.frames.find(
      (f) =>
        f.id === value.frameId &&
        f.role !== "baseline" &&
        f.status === "captured" &&
        f.sha256 === value.imageSha256,
    );
    if (!frame)
      throw Error(
        "Visual observation frame/hash is unavailable or mismatched.",
      );
    const image = this.frameFile(record, frame.id),
      stat = fs.lstatSync(image);
    if (!stat.isFile() || stat.size > 512 * 1024)
      throw Error("Saved visual frame is unavailable or too large.");
    const bytes = fs.readFileSync(image);
    if (
      bytes.length > 512 * 1024 ||
      createHash("sha256").update(bytes).digest("hex") !== frame.sha256
    )
      throw Error("Saved visual frame hash changed.");
    if (
      value.referenceFrameId &&
      !record.frames.some(
        (f) =>
          f.id === value.referenceFrameId &&
          f.role === "baseline" &&
          f.status === "captured",
      )
    )
      throw Error(
        "Reference frame is not a saved baseline candidate for this job.",
      );
    const observations = this.visuals(record),
      prior = observations.find((o) => o.frameId === value.frameId);
    if (
      prior &&
      JSON.stringify(validateVisualSubmission(prior)) === JSON.stringify(value)
    )
      return this.read(key, { jobId: record.id });
    const next = [
      ...observations.filter((o) => o.frameId !== value.frameId),
      {
        ...value,
        at: new Date(this.now()).toISOString(),
        source: "client-vision" as const,
      },
    ].slice(-64);
    const text = JSON.stringify({
      version: 1,
      jobId: record.id,
      observations: next,
    });
    if (Buffer.byteLength(text) > 64 * 1024)
      throw Error("Visual observation storage limit exceeded.");
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = this.visualFile(record),
      tmp = file + "." + process.pid + ".tmp";
    if (!fs.existsSync(this.file(record)))
      throw Error("The saved job was pruned; its observation was not stored.");
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, file);
    if (!fs.existsSync(this.file(record))) {
      try {
        fs.unlinkSync(file);
      } catch {}
      throw Error("The saved job was pruned; its observation was not stored.");
    }
    return this.read(key, { jobId: record.id });
  }
  private visualFile(record: FlightRecord) {
    return this.file(record).replace(/\.json$/, ".visual.json");
  }
  private visuals(record: FlightRecord): VisualObservation[] {
    try {
      const file = this.visualFile(record),
        stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > 64 * 1024) return [];
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (
        data.version !== 1 ||
        data.jobId !== record.id ||
        !Array.isArray(data.observations)
      )
        return [];
      return data.observations
        .slice(-64)
        .flatMap((v: any) => {
          try {
            const value = validateVisualSubmission(v);
            if (
              value.jobId !== record.id ||
              value.artifactSha256 !== record.dispatch.sha256 ||
              typeof v.at !== "string" ||
              !Number.isFinite(Date.parse(v.at)) ||
              !record.frames.some(
                (f) => f.id === value.frameId && f.sha256 === value.imageSha256,
              )
            )
              return [];
            return [{ ...value, at: v.at, source: "client-vision" as const }];
          } catch {
            return [];
          }
        })
        .sort((a: VisualObservation, b: VisualObservation) => {
          const x = record.frames.find((f) => f.id === a.frameId)!,
            y = record.frames.find((f) => f.id === b.frameId)!;
          return x.layer - y.layer || x.capturedAt.localeCompare(y.capturedAt);
        });
    } catch {
      return [];
    }
  }
  private trimFrames(record: FlightRecord) {
    const anomaly = this.visuals(record)
      .filter(
        (o) =>
          o.visibility === "clear" &&
          o.footprintVisible &&
          o.attempted &&
          o.deposition === "absent",
      )
      .at(-1)?.frameId;
    while (record.frames.length > 32) {
      const index = record.frames.findIndex(
        (f) =>
          f.role !== "baseline" && f.role !== "first_layer" && f.id !== anomaly,
      );
      if (index < 0) break;
      const [removed] = record.frames.splice(index, 1);
      try {
        fs.unlinkSync(this.frameFile(record, removed.id));
      } catch {}
      record.droppedFrames = (record.droppedFrames ?? 0) + 1;
    }
  }
  /** Called only after existing reports/reads, never on a timer; a sample cannot block the print. */
  async sample(
    key: string,
    capture: () => Promise<{ base64?: string; capturedAt?: string }>,
  ): Promise<void> {
    const record = this.get(key),
      layer = num(record?.latest.layer_num),
      state = record?.latest.gcode_state;
    if (
      !record ||
      !this.canWrite(record) ||
      this.pending.has(record.printerKey)
    )
      return;
    const baseline = state === "PREPARE" || state === "SLICING";
    let checkpoint: number, zMm: number, role: EvidenceFrame["role"];
    const stage = JSON.stringify([
      record.latest.mc_print_stage,
      record.latest.mc_print_sub_stage,
      record.latest.stg_cur,
    ]);
    if (baseline) {
      const existing = record.frames.filter((f) => f.role === "baseline");
      if (existing.length >= 3 || existing.some((f) => f.stage === stage))
        return;
      checkpoint = -100 - existing.length;
      zMm = 0;
      role = "baseline";
    } else {
      if (state !== "RUNNING" || !layer || !record.expected?.heightMm) return;
      const geometry = record.expected.layers.find((l) => l.layer === layer);
      if (!geometry) return;
      const due = [0.05, 0.3, 0.6, 0.9]
        .map((ratio, index) => ({ ratio, index }))
        .filter(
          (t) =>
            geometry.zMm >= t.ratio * record.expected!.heightMm! &&
            !record.frames.some((f) => f.checkpoint === t.index) &&
            !record.skippedCheckpoints.includes(t.index) &&
            !record.sampledCheckpoints?.includes(t.index),
        );
      const attempts = record.frames.filter((f) => f.role === "first_layer");
      const first =
        layer <= 2 &&
        attempts.length < 2 &&
        !attempts.some((f) => f.layer === layer);
      const previous =
        record.frames.filter((f) => f.role !== "baseline").at(-1)?.layer ?? 0;
      const periodic =
        !record.frames.some((f) => f.role !== "baseline") ||
        layer - previous >= 10;
      if (!first && !periodic && !due.length) return;
      const chosen = due.at(-1);
      checkpoint =
        chosen?.index ?? (first ? -10 : 100000 + Math.floor(layer / 10));
      record.skippedCheckpoints.push(...due.slice(0, -1).map((t) => t.index));
      if (chosen) (record.sampledCheckpoints ??= []).push(chosen.index);
      zMm = geometry.zMm;
      role = first ? "first_layer" : periodic ? "periodic" : "height";
    }
    const frame: EvidenceFrame = {
      id: randomUUID(),
      checkpoint,
      role,
      ...(baseline ? { stage } : {}),
      layer: layer ?? 0,
      expectedHeightMm: zMm,
      reportAt:
        record.reports[record.reports.length - 1]?.at ?? record.dispatchedAt,
      capturedAt: new Date(this.now()).toISOString(),
      status: "unavailable",
      reason: "capture-pending",
    };
    record.frames.push(frame);
    this.trimFrames(record);
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
        const current = this.get(key);
        if (
          current?.id !== record.id ||
          current.latest.gcode_state !== state ||
          num(current.latest.layer_num) !== layer ||
          (baseline &&
            JSON.stringify([
              current.latest.mc_print_stage,
              current.latest.mc_print_sub_stage,
              current.latest.stg_cur,
            ]) !== stage)
        )
          throw Error("job-or-layer-changed");
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
  /** One process writes a dispatched job; fresh observations can take over after its process exits. */
  private canWrite(record: FlightRecord): boolean {
    if (record.owner?.token === this.ownerToken) return true;
    if (record.owner) {
      try {
        process.kill(record.owner.pid, 0);
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
      }
    }
    record.owner = { pid: process.pid, token: this.ownerToken };
    return true;
  }
  private jobSummaries(key: string) {
    const prefix = hash(key) + "-";
    return this.files()
      .filter((name) => name.startsWith(prefix))
      .flatMap((name) => {
        const record = this.get(key, name.slice(prefix.length, -5));
        return record
          ? [
              {
                id: record.id,
                dispatchedAt: record.dispatchedAt,
                sha256: record.dispatch.sha256,
                outcome: record.dispatch.outcome,
              },
            ]
          : [];
      })
      .sort((a, b) => b.dispatchedAt.localeCompare(a.dispatchedAt))
      .slice(0, this.maxJobs);
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
    const printerKey = hash(key);
    let cached = this.cache.get(printerKey);
    if (cached?.storage === "durable" && !fs.existsSync(this.file(cached))) {
      this.cache.delete(printerKey);
      cached = undefined;
    }
    if (id && cached?.owner?.token === this.ownerToken && cached.id === id)
      return cached;
    // A latest-job read must discover dispatches made by another MCP process,
    // even while this process still owns a retained older job.
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
    if (
      !id &&
      cached?.storage === "volatile" &&
      (!latest || cached.dispatchedAt >= latest.dispatchedAt)
    )
      latest = cached;
    if (latest && !id) {
      if (cached?.id === latest.id && cached.owner?.token === this.ownerToken)
        return cached;
      this.cache.set(printerKey, latest);
    }
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
    while (this.cache.size > this.maxJobs) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    try {
      const files = this.files()
        .map((name) => ({
          name,
          time: fs.statSync(path.join(this.dir, name)).mtimeMs,
        }))
        .sort((a, b) => b.time - a.time);
      for (const { name } of files.slice(this.maxJobs)) {
        // Retention must not depend on parsing an older, possibly corrupt record.
        const prefix = name.slice(0, -5);
        fs.unlinkSync(path.join(this.dir, name));
        try {
          fs.unlinkSync(path.join(this.dir, prefix + ".visual.json"));
        } catch {}
        for (const file of fs
          .readdirSync(this.dir)
          .filter(
            (file) =>
              file.startsWith(prefix + "-") && /^[a-f\d-]+\.jpg$/.test(file),
          )) {
          try {
            fs.unlinkSync(path.join(this.dir, file));
          } catch {}
        }
        const printerKey = name.slice(0, 64),
          id = name.slice(65, -5);
        if (this.cache.get(printerKey)?.id === id)
          this.cache.delete(printerKey);
      }
    } catch {
      /* Diagnostic retention must never fail a printer operation. */
    }
  }
}
