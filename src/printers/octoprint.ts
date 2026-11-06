import fs from "fs";
import FormData from "form-data";
import { isAxiosError } from "axios";
import { GenericPrinterImplementation, type GenericPrinterState, type HeaterComponent, type SnapshotCandidate, type CameraCandidate } from "./generic-base.js";
import type { CounterpartProblem, CounterpartProgress, PrinterIdentity } from "../counterpart/contract.js";
import { nonEmptyText } from "../counterpart/contract.js";
import { mapOctoPrint } from "../counterpart/progress.js";

/** One entry of OctoPrint's file list, without its analysis tables, links and references. */
function slimFile(entry: any): Record<string, unknown> {
  const out: Record<string, unknown> = { name: entry?.name, path: entry?.path, type: entry?.type };
  if (entry?.display && entry.display !== entry.name) out.display = entry.display;
  if (entry?.origin) out.origin = entry.origin;
  if (typeof entry?.size === "number") out.size = entry.size;
  if (typeof entry?.date === "number") out.date = new Date(entry.date * 1000).toISOString();
  const estimate = entry?.gcodeAnalysis?.estimatedPrintTime;
  if (typeof estimate === "number" && Number.isFinite(estimate)) out.estimatedPrintTimeSec = Math.round(estimate);
  const last = entry?.prints?.last;
  if (last && typeof last.success === "boolean") out.lastPrint = { success: last.success, ...(typeof last.date === "number" ? { date: new Date(last.date * 1000).toISOString() } : {}) };
  if (Array.isArray(entry?.children)) out.children = entry.children.map(slimFile);
  return out;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** What counterpart_print_progress says when OctoPrint answers but isn't connected to the printer. */
function disconnectedProblem(connection: OctoPrintConnection): CounterpartProblem {
  const message = connection.powerOn === false
    ? "OctoPrint is running, but the printer is switched off (PSU Control). connect_printer with power_on switches it on and connects."
    : `OctoPrint is running, but it isn't connected to the printer (${connection.state || "Closed"}). connect_printer connects it with OctoPrint's saved port and baud rate.`;
  return { code: "octoprint.disconnected", severity: "warning", message };
}

const BLOCKING_FLAGS = ["printing", "paused", "pausing", "cancelling", "resuming", "finishing", "error", "closedOrError"];

function encodePath(filename: string): string {
  return filename.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
}

/**
 * OctoPrint's base URL. PRINTER_HOST is a host name or address (http on PRINTER_PORT, as before), or a URL for an
 * OctoPrint behind HTTPS or a reverse proxy at a sub-path ("https://octopi.local", "http://pi.lan/octoprint/").
 * A URL keeps its own port; PRINTER_PORT is added only when the URL has none and it isn't 80 or 443 (the
 * default this server passes), so "https://octopi.local" stays on 443. Sub-path installs are OctoPrint's
 * documented reverse-proxy setup (X-Script-Name): https://community.octoprint.org/t/reverse-proxy-configuration-examples/1107
 */
export function octoPrintBaseUrl(host: string, port: string): string {
  const raw = String(host ?? "").trim();
  if (/^https?:\/\//i.test(raw)) {
    let url: URL;
    try { url = new URL(raw); } catch { throw new Error(`PRINTER_HOST is not a valid URL: ${raw}`); }
    if (url.username || url.password) throw new Error("Put OctoPrint's API key in API_KEY, not in the PRINTER_HOST URL.");
    const extra = String(port ?? "").trim();
    if (!url.port && extra && extra !== "80" && extra !== "443") url.port = extra;
    url.search = ""; url.hash = "";
    return url.toString().replace(/\/+$/, "");
  }
  const portText = String(port ?? "").trim();
  const hostText = raw.includes(":") && !raw.startsWith("[") ? `[${raw}]` : raw;
  return portText ? `http://${hostText}:${portText}` : `http://${hostText}`;
}

/** OctoPi's mjpg-streamer behind haproxy: the web server's root, on port 80 for a plain host (not OctoPrint's own port). */
function webcamFallbackUrl(host: string, port: string): string {
  const raw = String(host ?? "").trim();
  if (/^https?:\/\//i.test(raw)) return `${new URL(octoPrintBaseUrl(raw, port)).origin}/webcam/?action=snapshot`;
  return `${octoPrintBaseUrl(raw, "")}/webcam/?action=snapshot`;
}

/** OctoPrint's connection to the printer (GET /api/connection, docs.octoprint.org/en/master/api/connection.html). */
export interface OctoPrintConnection {
  /** OctoPrint's own words: "Operational", "Closed", "Offline after error: …", "Detecting serial connection", … */
  state: string;
  connected: boolean;
  port?: string;
  baudrate?: number;
  profile?: string;
  ports: string[];
  /** PSU Control plugin (kantlivelong/OctoPrint-PSUControl): whether the printer's power is on; absent without the plugin. */
  powerOn?: boolean;
}

/** OctoPrint's not-connected states (octoprint/util/comm.py getStateString); "Offline after error" carries its reason. */
function disconnectedState(state: string): boolean {
  const text = state.trim().toLowerCase();
  return text === "closed" || text === "offline" || text.startsWith("offline after error") || text === "error" || text.startsWith("error:") || text === "";
}

export class OctoPrintImplementation extends GenericPrinterImplementation {
  protected readonly printerLabel = "OctoPrint";
  // POST /api/files/local with print=true uploads and starts the same bytes.
  protected readonly uploadStartsPrint = true;

  /**
   * GET /api/job plus GET /api/printer (temperatures; 409 when not
   * operational). An Operational job with no progress reads the file's print
   * history so a cancelled job is reported as cancelled.
   * https://docs.octoprint.org/en/master/api/job.html
   */
  async counterpartProgress(host: string, port: string, apiKey: string): Promise<CounterpartProgress> {
    const base = octoPrintBaseUrl(host, port);
    const headers = { "X-Api-Key": apiKey };
    const job = (await this.apiClient.get(`${base}/api/job`, { headers })).data;
    let printer: any;
    try {
      printer = (await this.apiClient.get(`${base}/api/printer`, { headers })).data;
    } catch (error) {
      if (!(isAxiosError(error) && error.response?.status === 409)) throw error;
    }
    const observedAt = new Date().toISOString();
    let lastPrint: { success?: unknown } | undefined;
    const file = job?.job?.file;
    if (String(job?.state ?? "").toLowerCase() === "operational" && typeof file?.path === "string" && file.path &&
        (job?.progress?.completion === null || job?.progress?.completion === undefined)) {
      const origin = file.origin === "sdcard" ? "sdcard" : "local";
      lastPrint = await this.apiClient.get(`${base}/api/files/${origin}/${encodePath(file.path)}`, { headers })
        .then((response) => response.data?.prints?.last)
        .catch(() => undefined);
    }
    const progress = mapOctoPrint({ job, printer, lastPrint }, observedAt);
    if (printer === undefined) {
      // OctoPrint answers, but it isn't connected to the printer: say so, instead of a bare "offline".
      const connection = await this.connection(host, port, apiKey).catch(() => undefined);
      if (connection && !connection.connected) progress.problems.push(disconnectedProblem(connection));
    }
    return progress;
  }

  /** GET /api/connection, and PSU Control's power state when that plugin is installed. */
  async connection(host: string, port: string, apiKey: string): Promise<OctoPrintConnection> {
    const base = octoPrintBaseUrl(host, port);
    const headers = { "X-Api-Key": apiKey };
    const [data, power] = await Promise.all([
      this.apiClient.get(`${base}/api/connection`, { headers }).then(r => r.data),
      this.psuPower(base, apiKey),
    ]);
    const current = data?.current ?? {};
    const state = String(current.state ?? "");
    return {
      state, connected: !disconnectedState(state),
      ...(nonEmptyText(current.port) ? { port: current.port } : {}),
      ...(typeof current.baudrate === "number" ? { baudrate: current.baudrate } : {}),
      ...(nonEmptyText(current.printerProfile) ? { profile: current.printerProfile } : {}),
      ports: Array.isArray(data?.options?.ports) ? data.options.ports.filter((value: unknown) => typeof value === "string") : [],
      ...(power !== undefined ? { powerOn: power } : {}),
    };
  }

  /**
   * GET /api/plugin/psucontrol → {isPSUOn}; undefined when PSU Control isn't installed (404) or can't be read.
   * Source: kantlivelong/OctoPrint-PSUControl octoprint_psucontrol/__init__.py on_api_get / getPSUState.
   */
  private async psuPower(base: string, apiKey: string): Promise<boolean | undefined> {
    try {
      const data = (await this.apiClient.get(`${base}/api/plugin/psucontrol`, { headers: { "X-Api-Key": apiKey } })).data;
      return typeof data?.isPSUOn === "boolean" ? data.isPSUOn : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Connect OctoPrint to the printer: POST /api/connection {command:"connect"} with OctoPrint's own saved port,
   * baud rate and profile unless given (OctoPrint's AUTO detection when none is saved), then wait for it to
   * settle. power_on first turns the printer on through PSU Control (POST /api/plugin/psucontrol
   * {command:"turnPSUOn"}) when that plugin reports it off. Connecting runs no G-code of ours: OctoPrint
   * sends its own "after connection" script, which the person configured. Already connected: nothing is sent.
   * https://docs.octoprint.org/en/master/api/connection.html
   */
  async connectPrinter(host: string, port: string, apiKey: string, options: { serialPort?: string; baudrate?: number; profile?: string; powerOn?: boolean; waitMs?: number } = {}): Promise<OctoPrintConnection & { action: "none" | "connected" | "connecting" | "failed"; poweredOn: boolean; message: string }> {
    const base = octoPrintBaseUrl(host, port);
    const headers = { "X-Api-Key": apiKey, "Content-Type": "application/json" };
    let before = await this.connection(host, port, apiKey);
    if (before.connected) return { ...before, action: "none", poweredOn: false, message: `OctoPrint is already connected to the printer (${before.state}).` };
    let poweredOn = false;
    if (before.powerOn === false) {
      if (!options.powerOn) {
        return { ...before, action: "failed", poweredOn, message: "The printer is switched off (PSU Control). Call again with power_on: true to switch it on and connect." };
      }
      await this.apiClient.post(`${base}/api/plugin/psucontrol`, { command: "turnPSUOn" } as any, { headers });
      poweredOn = true;
      // PSU Control may connect by itself after power-on (its autoConnect setting); give the board time to boot.
      await sleep(3_000);
      before = await this.connection(host, port, apiKey);
      if (before.connected) return { ...before, action: "connected", poweredOn, message: `Switched the printer on; OctoPrint connected (${before.state}).` };
    }
    const body: Record<string, unknown> = { command: "connect" };
    if (options.serialPort) body.port = options.serialPort;
    if (options.baudrate !== undefined) body.baudrate = options.baudrate;
    if (options.profile) body.printerProfile = options.profile;
    await this.apiClient.post(`${base}/api/connection`, body as any, { headers });
    const deadline = Date.now() + Math.min(Math.max(options.waitMs ?? 20_000, 0), 60_000);
    let after = await this.connection(host, port, apiKey);
    while (!/^operational|^printing|^paused/i.test(after.state) && !/error/i.test(after.state) && Date.now() < deadline) {
      await sleep(1_000);
      after = await this.connection(host, port, apiKey);
    }
    if (/^operational|^printing|^paused/i.test(after.state)) {
      return { ...after, action: "connected", poweredOn, message: `OctoPrint connected to the printer${after.port ? ` on ${after.port}` : ""} (${after.state}).` };
    }
    if (after.connected) return { ...after, action: "connecting", poweredOn, message: `OctoPrint is still connecting (${after.state}). Read counterpart_print_progress again in a moment.` };
    return { ...after, action: "failed", poweredOn, message: `OctoPrint couldn't connect to the printer (${after.state || "Closed"}). Check the USB cable and that the printer is on${after.ports.length ? `; OctoPrint sees ${after.ports.join(", ")}` : "; OctoPrint sees no serial port"}.` };
  }

  /**
   * Snapshot URL from GET /api/settings: the bundled Classic Webcam plugin's
   * plugins.classicwebcam.snapshot on 1.9+, webcam.snapshotUrl on 1.8 and
   * earlier (1.9+ still fills it through its compatibility layer), then the
   * OctoPi convention http://host/webcam/?action=snapshot.
   * Source: OctoPrint src/octoprint/server/api/settings.py and
   * src/octoprint/plugins/classicwebcam/__init__.py; checked on 1.8.7 and 1.11.2.
   */
  async snapshotCandidates(host: string, port: string, apiKey: string): Promise<SnapshotCandidate[]> {
    return (await this.cameraCandidates(host, port, apiKey)).filter(candidate => candidate.transport === "http-snapshot");
  }

  async cameraCandidates(host: string, port: string, apiKey: string): Promise<CameraCandidate[]> {
    const settings = (await this.apiClient.get(`${octoPrintBaseUrl(host, port)}/api/settings`, { headers: { "X-Api-Key": apiKey } })).data;
    const candidates: CameraCandidate[] = [];
    if (settings?.webcam?.webcamEnabled !== false) {
      // The settings API maps webcam.stream to streamUrl. Classic Webcam on
      // 1.9+ exposes its own stream field; only configured URLs are used.
      const configured = [
        settings?.plugins?.classicwebcam,
        {stream: settings?.webcam?.streamUrl, snapshot: settings?.webcam?.snapshotUrl},
        ...(Array.isArray(settings?.webcam?.webcams) ? settings.webcam.webcams.map((webcam: any) => webcam?.compat) : []),
      ];
      for (const camera of configured) {
        const stream = nonEmptyText(camera?.stream), snapshot = nonEmptyText(camera?.snapshot);
        if (stream) candidates.push({url: stream, snapshotUrl: snapshot, source: "octoprint-settings", configured: true, transport: "http-mjpeg"});
        if (snapshot) candidates.push({url: snapshot, source: "octoprint-settings", configured: true, transport: "http-snapshot"});
      }
    }
    // OctoPi's mjpg-streamer sits at the web server's root, also when OctoPrint is proxied at a sub-path.
    candidates.push({ url: webcamFallbackUrl(host, port), source: "octoprint-fallback", configured: false, transport: "http-snapshot" });
    return candidates;
  }

  async counterpartIdentity(host: string, port: string, apiKey: string): Promise<PrinterIdentity> {
    const headers = { "X-Api-Key": apiKey };
    const [profiles, settings] = await Promise.all([
      this.apiClient.get(`${octoPrintBaseUrl(host, port)}/api/printerprofiles`, { headers }).then((r) => r.data).catch(() => undefined),
      this.apiClient.get(`${octoPrintBaseUrl(host, port)}/api/settings`, { headers }).then((r) => r.data).catch(() => undefined),
    ]);
    const all = Object.values(profiles?.profiles ?? {}) as any[];
    const profile = all.find((entry) => entry?.current) ?? all.find((entry) => entry?.default);
    return { model: nonEmptyText(profile?.model), name: nonEmptyText(settings?.appearance?.name) ?? nonEmptyText(profile?.name) };
  }

  /** POST /api/job {command:"pause", action:"pause"|"resume"}; 204 on success, 409 without an active job. */
  protected async rawPauseJob(host: string, port: string, apiKey: string) {
    return this.jobCommand(host, port, apiKey, { command: "pause", action: "pause" });
  }

  protected async rawResumeJob(host: string, port: string, apiKey: string) {
    return this.jobCommand(host, port, apiKey, { command: "pause", action: "resume" });
  }

  private async jobCommand(host: string, port: string, apiKey: string, body: Record<string, string>) {
    const response = await this.apiClient.post(`${octoPrintBaseUrl(host, port)}/api/job`, body as any, {
      headers: { "X-Api-Key": apiKey, "Content-Type": "application/json" },
    });
    return response.data;
  }

  async getStatus(host: string, port: string, apiKey: string) {
    const url = `${octoPrintBaseUrl(host, port)}/api/printer`;
    const response = await this.apiClient.get(url, {
      headers: {
        "X-Api-Key": apiKey
      }
    });
    return response.data;
  }

  /**
   * GET /api/files?recursive=true, cut to what a person or a model needs per file (name, path, size, date, OctoPrint's
   * estimate and last print) so a large library fits in a model's context (issue #4: 324 files were 500 KB). A folder
   * keeps its children. https://docs.octoprint.org/en/master/api/files.html
   */
  async getFiles(host: string, port: string, apiKey: string) {
    const url = `${octoPrintBaseUrl(host, port)}/api/files?recursive=true`;
    const response = await this.apiClient.get(url, {
      headers: {
        "X-Api-Key": apiKey
      }
    });
    const data = response.data ?? {};
    return {
      files: Array.isArray(data.files) ? data.files.map(slimFile) : [],
      ...(typeof data.free === "number" ? { free: data.free } : {}),
      ...(typeof data.total === "number" ? { total: data.total } : {}),
    };
  }

  async getFile(host: string, port: string, apiKey: string, filename: string) {
    const url = `${octoPrintBaseUrl(host, port)}/api/files/local/${encodePath(filename)}`;
    const response = await this.apiClient.get(url, {
      headers: {
        "X-Api-Key": apiKey
      }
    });
    return response.data;
  }

  /**
   * GET /api/printer state.flags (OctoPrint REST API). A 409 means the printer
   * is not operational. Informational flags such as sdReady never block.
   */
  protected async readPrinterState(host: string, port: string, apiKey: string): Promise<GenericPrinterState> {
    let data: any;
    try {
      data = (await this.apiClient.get(`${octoPrintBaseUrl(host, port)}/api/printer`, { headers: { "X-Api-Key": apiKey } })).data;
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 409) {
        const connection = await this.connection(host, port, apiKey).catch(() => undefined);
        return { state: connection?.state || "Offline", ready: false, reason: connection && !connection.connected
          ? disconnectedProblem(connection).message
          : "OctoPrint reports the printer is not operational" };
      }
      throw new Error(`Cannot read OctoPrint printer state; nothing was sent: ${(error as Error).message}`);
    }
    const flags = data?.state?.flags;
    if (!flags || typeof flags !== "object") {
      throw new Error("OctoPrint returned no printer state flags; cannot verify the printer is idle.");
    }
    const blocking = BLOCKING_FLAGS.filter((flag) => flags[flag] === true);
    if (flags.operational !== true) blocking.unshift("not operational");
    if (flags.ready === false && !blocking.length) blocking.push("not ready");
    return { state: String(data?.state?.text ?? "unknown"), ready: blocking.length === 0, reason: blocking.join(", ") || undefined };
  }

  /** OctoPrint reports effectivePrint=false when print=true had no effect. */
  protected uploadStartedPrint(data: any): boolean {
    return data?.effectivePrint !== false;
  }

  protected async downloadRemoteFile(host: string, port: string, apiKey: string, filename: string, destination: string): Promise<void> {
    await this.downloadToFile(`${octoPrintBaseUrl(host, port)}/downloads/files/local/${encodePath(filename)}`, { "X-Api-Key": apiKey }, destination);
  }

  protected async rawUploadFile(host: string, port: string, apiKey: string, filePath: string, filename: string, print: boolean) {
    const url = `${octoPrintBaseUrl(host, port)}/api/files/local`;

    const formData = new FormData();
    formData.append("file", fs.createReadStream(filePath));
    formData.append("filename", filename);

    if (print) {
      formData.append("print", "true");
    }

    const response = await this.apiClient.post(url, formData as any, {
      headers: {
        "X-Api-Key": apiKey,
        ...formData.getHeaders()
      }
    });

    return response.data;
  }

  protected async rawStartJob(host: string, port: string, apiKey: string, filename: string) {
    const url = `${octoPrintBaseUrl(host, port)}/api/files/local/${encodePath(filename)}`;

    const response = await this.apiClient.post(url, {
      command: "select",
      print: true
    } as any, {
      headers: {
        "X-Api-Key": apiKey,
        "Content-Type": "application/json"
      }
    });

    return response.data || { status: "started", message: `OctoPrint selected ${filename} and started printing it.` };
  }

  protected async rawCancelJob(host: string, port: string, apiKey: string) {
    const url = `${octoPrintBaseUrl(host, port)}/api/job`;

    const response = await this.apiClient.post(url, {
      command: "cancel"
    } as any, {
      headers: {
        "X-Api-Key": apiKey,
        "Content-Type": "application/json"
      }
    });

    // 204 No Content: OctoPrint accepted the cancel and ends the job on its own.
    return response.data || { status: "cancelling", message: "OctoPrint is cancelling the print." };
  }

  /** OctoPrint tool targets are keyed tool{n} (POST /api/printer/tool, command "target"). */
  protected heaterComponent(component: string): HeaterComponent | undefined {
    const normalized = component.trim().toLowerCase();
    if (normalized === "bed") return { heater: "bed", raw: "bed" };
    if (["extruder", "nozzle", "tool"].includes(normalized)) return { heater: "nozzle", raw: "tool0" };
    const indexed = normalized.match(/^(?:extruder|tool)(\d+)$/);
    if (indexed) return { heater: "nozzle", raw: `tool${Number(indexed[1])}` };
    return undefined;
  }

  protected async rawSetTemperature(host: string, port: string, apiKey: string, component: string, temperature: number) {
    let url = `${octoPrintBaseUrl(host, port)}/api/printer/tool`;

    const data: Record<string, any> = {};
    if (component === "bed") {
      data.command = "target";
      data.target = temperature;
      url = `${octoPrintBaseUrl(host, port)}/api/printer/bed`;
    } else if (/^tool\d+$/.test(component)) {
      data.command = "target";
      data.targets = { [component]: temperature };
    } else {
      throw new Error(`Unsupported component: ${component}`);
    }

    const response = await this.apiClient.post(url, data as any, {
      headers: {
        "X-Api-Key": apiKey,
        "Content-Type": "application/json"
      }
    });

    return response.data || { status: "set", component, target: temperature };
  }
}
