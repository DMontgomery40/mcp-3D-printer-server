/**
 * counterpart/1 tools for every printer type this server drives. Generic
 * adapters supply firmware reads; this module turns them into the shared
 * results, detects capabilities, and fetches camera snapshots.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { isAxiosError, type AxiosInstance } from "axios";
import type { PrinterImplementation } from "../types.js";
import { GenericPrinterImplementation, type SnapshotCandidate } from "../printers/generic-base.js";
import { BambuImplementation } from "../printers/bambu.js";
import {
  COUNTERPART_CONTRACT,
  PRINTER_KINDS,
  compact,
  progressResult,
  type CameraSnapshotResult,
  type CounterpartCapabilities,
  type CounterpartPrinterInfo,
  type CounterpartProgress,
  type FilamentSlot,
  type PrinterIdentity,
  type PrinterKind,
} from "./contract.js";
import { mapBambu } from "./progress.js";
import {
  counterpartSlots,
  externalSpools,
  normalizePrinterFilamentInventory,
  type FilamentProfileSource,
  type PrinterFilamentInventory,
} from "../printers/bambu-filaments.js";

/** Bambu inventory hints: the model and nozzle select model-specific filament profiles. */
export interface BambuFilamentOptions {
  bambuModel?: string;
  nozzleDiameter?: string;
}

export const DEFAULT_SNAPSHOT_TIMEOUT_MS = 8_000;
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

export interface PrinterTarget {
  type: string;
  host: string;
  port: string;
  /** API key for generic printers, "serial:token" for Bambu. */
  apiKey: string;
}

export interface SnapshotOptions {
  savePath?: string;
  timeoutMs?: number;
}

/** No HTTP response at all (refused, timed out, unreachable): the printer is offline, not erroring. */
function unreachable(error: unknown): boolean {
  return isAxiosError(error) && !error.response;
}

function kindOf(type: string): PrinterKind {
  const kind = type.trim().toLowerCase();
  if (!(PRINTER_KINDS as readonly string[]).includes(kind)) throw new Error(`Unsupported printer type: ${type}`);
  return kind as PrinterKind;
}

function overrideSnapshotUrl(): string | undefined {
  return process.env.PRINTER_CAMERA_SNAPSHOT_URL?.trim() || undefined;
}

export class CounterpartService {
  constructor(
    private readonly implementation: (type: string) => PrinterImplementation,
    private readonly http: AxiosInstance,
    private readonly server: { name: string; version: string },
    /** The slicer filament profile for a slot's material (undefined: the configured default). */
    private readonly filamentProfile?: (material: string | undefined) => Promise<string | undefined>,
    /** The slicer whose BBL/filament profiles resolve Bambu trays by tray_info_idx. */
    private readonly bambuProfileSource: () => FilamentProfileSource = () => ({})
  ) {}

  private generic(target: PrinterTarget): GenericPrinterImplementation | undefined {
    const implementation = this.implementation(target.type);
    return implementation instanceof GenericPrinterImplementation ? implementation : undefined;
  }

  private bambu(target: PrinterTarget): BambuImplementation {
    const implementation = this.implementation(target.type);
    if (!(implementation instanceof BambuImplementation)) throw new Error(`Unsupported printer type: ${target.type}`);
    return implementation;
  }

  async printProgress(target: PrinterTarget): Promise<CounterpartProgress> {
    const generic = this.generic(target);
    if (!generic) {
      const status = await this.bambu(target).getStatus(target.host, target.port, target.apiKey);
      return mapBambu(status?.raw, new Date().toISOString(), { connected: status?.connected === true, model: process.env.BAMBU_MODEL });
    }
    try {
      return await generic.observedProgress(target.host, target.port, target.apiKey);
    } catch (error) {
      if (unreachable(error)) return progressResult(new Date().toISOString(), "offline", { problems: [] });
      throw error;
    }
  }

  async printerInfo(target: PrinterTarget): Promise<CounterpartPrinterInfo> {
    const kind = kindOf(target.type);
    const generic = this.generic(target);
    let identity: PrinterIdentity = {};
    let capabilities: CounterpartCapabilities;
    if (!generic) {
      const status = await this.bambu(target).getStatus(target.host, target.port, target.apiKey).catch(() => undefined);
      const model = typeof status?.model === "string" && status.model !== "Unknown" ? status.model : process.env.BAMBU_MODEL?.trim();
      identity = { model: model || undefined, serial: typeof status?.serial === "string" && status.serial ? status.serial : undefined };
      // This server has no Bambu camera path; bambu-printer-mcp does.
      capabilities = {
        progress: true, layers: true, camera: overrideSnapshotUrl() ? "http-snapshot" : "none", filaments: "ams",
        pause: false, resume: false, cancel: true, print3mf: true, gcode: true,
      };
    } else {
      const { host, port, apiKey } = target;
      identity = await generic.counterpartIdentity(host, port, apiKey).catch(() => ({}));
      const [layers, pauseResume, camera] = await Promise.all([
        generic.reportsLayers(host, port, apiKey).catch(() => false),
        generic.supportsPauseResume(host, port, apiKey).catch(() => false),
        this.cameraCapability(generic, target),
      ]);
      capabilities = {
        progress: true, layers, camera, filaments: "single",
        pause: pauseResume, resume: pauseResume, cancel: true, print3mf: false, gcode: true,
      };
    }
    return compact({
      contract: COUNTERPART_CONTRACT,
      server: this.server,
      printer: { kind, host: target.host, ...identity },
      capabilities,
    }) as CounterpartPrinterInfo;
  }

  /** http-snapshot when the firmware names a snapshot URL, or a conventional fallback answers with a JPEG. */
  private async cameraCapability(generic: GenericPrinterImplementation, target: PrinterTarget): Promise<"http-snapshot" | "none"> {
    if (overrideSnapshotUrl()) return "http-snapshot";
    const candidates = await generic.snapshotCandidates(target.host, target.port, target.apiKey).catch(() => []);
    if (candidates.some((candidate) => candidate.configured)) return "http-snapshot";
    for (const candidate of candidates) {
      try {
        await this.fetchJpeg(this.resolve(candidate.url, target)[0], target, 3_000);
        return "http-snapshot";
      } catch {
        // Not a camera.
      }
    }
    return "none";
  }

  /**
   * bambu-printer-mcp's get_printer_filaments for Bambu: the live AMS inventory
   * from MQTT. The first push from an idle printer can be sparse (model and
   * modules); AMS data follows, so an empty live inventory is read once more.
   */
  async bambuFilaments(target: PrinterTarget, options: BambuFilamentOptions = {}): Promise<PrinterFilamentInventory & { slots: FilamentSlot[] }> {
    const bambu = this.bambu(target);
    const source = this.bambuProfileSource();
    const read = async () => {
      const status = await bambu.getStatus(target.host, target.port, target.apiKey);
      if (status?.connected === false) throw new Error(`Could not read the printer's filament: ${status?.error ?? "not connected"}`);
      return { status, inventory: normalizePrinterFilamentInventory(status, source, options.bambuModel, options.nozzleDiameter) };
    };
    let { status, inventory } = await read();
    if (inventory.trays.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      ({ status, inventory } = await read());
    }
    const external = externalSpools(status, source, options.bambuModel, options.nozzleDiameter);
    return { slots: counterpartSlots(inventory, external), ...inventory };
  }

  async filaments(target: PrinterTarget, options: BambuFilamentOptions = {}): Promise<{ slots: FilamentSlot[] }> {
    const generic = this.generic(target);
    if (!generic) return this.bambuFilaments(target, options);
    const slots = await generic.counterpartFilaments(target.host, target.port, target.apiKey);
    const profiled = await Promise.all(slots.map(async (slot) => {
      const profile = await this.filamentProfile?.(slot.material).catch(() => undefined);
      return profile ? { ...slot, profile } : slot;
    }));
    return compact({ slots: profiled });
  }

  async pause(target: PrinterTarget) {
    const generic = this.generic(target);
    if (!generic) throw new Error("Unsupported: pause_print for Bambu printers is provided by bambu-printer-mcp.");
    return generic.pauseJob(target.host, target.port, target.apiKey);
  }

  async resume(target: PrinterTarget) {
    const generic = this.generic(target);
    if (!generic) throw new Error("Unsupported: resume_print for Bambu printers is provided by bambu-printer-mcp.");
    return generic.resumeJob(target.host, target.port, target.apiKey);
  }

  async cameraSnapshot(target: PrinterTarget, options: SnapshotOptions = {}): Promise<CameraSnapshotResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_SNAPSHOT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw new Error("Invalid timeout_ms: expected 100 to 120000.");
    if (options.savePath !== undefined && (!path.isAbsolute(options.savePath) || options.savePath.includes("\0"))) {
      throw new Error("Invalid save_path: expected an absolute file path.");
    }
    const deadline = Date.now() + timeoutMs;
    const override = overrideSnapshotUrl();
    let candidates: SnapshotCandidate[];
    if (override) {
      candidates = [{ url: override, source: "env-override", configured: true }];
    } else {
      const generic = this.generic(target);
      if (!generic) throw new Error("Unsupported: this server has no Bambu camera path. Use bambu-printer-mcp's camera_snapshot, or set PRINTER_CAMERA_SNAPSHOT_URL.");
      candidates = await generic.snapshotCandidates(target.host, target.port, target.apiKey);
      if (!candidates.length) {
        throw new Error(`Unsupported: ${kindOf(target.type)} exposes no camera snapshot URL. Set PRINTER_CAMERA_SNAPSHOT_URL to a JPEG snapshot URL for this printer.`);
      }
    }
    const urls = [...new Set(candidates.flatMap((candidate) => this.resolve(candidate.url, target).map((url) => `${candidate.source}\n${url}`)))];
    const failures: string[] = [];
    for (const entry of urls) {
      const [source, url] = entry.split("\n");
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        const jpeg = await this.fetchJpeg(url, target, remaining);
        const capturedAt = new Date().toISOString();
        let savedTo: string | undefined;
        if (options.savePath) {
          await fs.writeFile(options.savePath, jpeg);
          savedTo = options.savePath;
        }
        return compact({ status: "success", format: "image/jpeg", sizeBytes: jpeg.length, base64: jpeg.toString("base64"), savedTo, capturedAt, source }) as CameraSnapshotResult;
      } catch (error) {
        failures.push(`${new URL(url).origin}${new URL(url).pathname}: ${(error as Error).message}`);
      }
    }
    throw new Error(`No camera snapshot within ${timeoutMs} ms. Tried ${failures.length ? failures.join("; ") : "no URL before the deadline"}.`);
  }

  /**
   * Snapshot URLs are written from the printer host's point of view: relative
   * paths and loopback hosts mean the printer itself.
   */
  resolve(raw: string, target: PrinterTarget): string[] {
    const host = target.host.includes(":") && !target.host.startsWith("[") ? `[${target.host}]` : target.host;
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      // Relative to the printer host: the web front end on port 80, then the API port.
      const pathPart = raw.startsWith("/") ? raw : `/${raw}`;
      return [...new Set([`http://${host}${pathPart}`, `http://${host}:${target.port}${pathPart}`])];
    }
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(`Unsupported snapshot URL scheme: ${parsed.protocol}`);
    if (LOOPBACK.has(parsed.hostname) && !LOOPBACK.has(target.host)) parsed.hostname = target.host;
    // "localhost" can resolve to ::1 first, and Node 18 has no IPv4 fallback for it: try both loopbacks.
    if (parsed.hostname === "localhost") {
      const v4 = new URL(parsed.toString()); v4.hostname = "127.0.0.1";
      const v6 = new URL(parsed.toString()); v6.hostname = "[::1]";
      return [v4.toString(), v6.toString()];
    }
    return [parsed.toString()];
  }

  private async fetchJpeg(url: string, target: PrinterTarget, timeout: number): Promise<Buffer> {
    const parsed = new URL(url);
    // The API key goes only to the printer's own API origin, never to another host.
    const sameOrigin = parsed.origin === new URL(`http://${target.host}:${target.port}`).origin;
    const headers: Record<string, string> = sameOrigin && target.apiKey && target.type.toLowerCase() !== "bambu" ? { "X-Api-Key": target.apiKey } : {};
    const response = await this.http.get(url, {
      headers,
      responseType: "arraybuffer",
      timeout: Math.max(1, Math.round(timeout)),
      maxContentLength: MAX_SNAPSHOT_BYTES,
      maxRedirects: Object.keys(headers).length ? 0 : 3,
    });
    const bytes = Buffer.from(response.data as ArrayBuffer);
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
      throw new Error(`not a JPEG (${String(response.headers?.["content-type"] ?? "unknown type")}, ${bytes.length} bytes)`);
    }
    return bytes;
  }
}
