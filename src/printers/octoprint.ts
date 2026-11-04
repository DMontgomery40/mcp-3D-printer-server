import fs from "fs";
import FormData from "form-data";
import { isAxiosError } from "axios";
import { GenericPrinterImplementation, type GenericPrinterState, type HeaterComponent, type SnapshotCandidate, type CameraCandidate } from "./generic-base.js";
import type { CounterpartProgress, PrinterIdentity } from "../counterpart/contract.js";
import { nonEmptyText } from "../counterpart/contract.js";
import { mapOctoPrint } from "../counterpart/progress.js";

const BLOCKING_FLAGS = ["printing", "paused", "pausing", "cancelling", "resuming", "finishing", "error", "closedOrError"];

function encodePath(filename: string): string {
  return filename.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
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
    const base = `http://${host}:${port}`;
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
    return mapOctoPrint({ job, printer, lastPrint }, observedAt);
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
    const settings = (await this.apiClient.get(`http://${host}:${port}/api/settings`, { headers: { "X-Api-Key": apiKey } })).data;
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
    candidates.push({ url: `http://${host}/webcam/?action=snapshot`, source: "octoprint-fallback", configured: false, transport: "http-snapshot" });
    return candidates;
  }

  async counterpartIdentity(host: string, port: string, apiKey: string): Promise<PrinterIdentity> {
    const headers = { "X-Api-Key": apiKey };
    const [profiles, settings] = await Promise.all([
      this.apiClient.get(`http://${host}:${port}/api/printerprofiles`, { headers }).then((r) => r.data).catch(() => undefined),
      this.apiClient.get(`http://${host}:${port}/api/settings`, { headers }).then((r) => r.data).catch(() => undefined),
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
    const response = await this.apiClient.post(`http://${host}:${port}/api/job`, body as any, {
      headers: { "X-Api-Key": apiKey, "Content-Type": "application/json" },
    });
    return response.data;
  }

  async getStatus(host: string, port: string, apiKey: string) {
    const url = `http://${host}:${port}/api/printer`;
    const response = await this.apiClient.get(url, {
      headers: {
        "X-Api-Key": apiKey
      }
    });
    return response.data;
  }

  async getFiles(host: string, port: string, apiKey: string) {
    const url = `http://${host}:${port}/api/files`;
    const response = await this.apiClient.get(url, {
      headers: {
        "X-Api-Key": apiKey
      }
    });
    return response.data;
  }

  async getFile(host: string, port: string, apiKey: string, filename: string) {
    const url = `http://${host}:${port}/api/files/local/${filename}`;
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
      data = (await this.apiClient.get(`http://${host}:${port}/api/printer`, { headers: { "X-Api-Key": apiKey } })).data;
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 409) {
        return { state: "Offline", ready: false, reason: "OctoPrint reports the printer is not operational" };
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
    await this.downloadToFile(`http://${host}:${port}/downloads/files/local/${encodePath(filename)}`, { "X-Api-Key": apiKey }, destination);
  }

  protected async rawUploadFile(host: string, port: string, apiKey: string, filePath: string, filename: string, print: boolean) {
    const url = `http://${host}:${port}/api/files/local`;

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
    const url = `http://${host}:${port}/api/files/local/${filename}`;

    const response = await this.apiClient.post(url, {
      command: "select",
      print: true
    } as any, {
      headers: {
        "X-Api-Key": apiKey,
        "Content-Type": "application/json"
      }
    });

    return response.data;
  }

  protected async rawCancelJob(host: string, port: string, apiKey: string) {
    const url = `http://${host}:${port}/api/job`;

    const response = await this.apiClient.post(url, {
      command: "cancel"
    } as any, {
      headers: {
        "X-Api-Key": apiKey,
        "Content-Type": "application/json"
      }
    });

    return response.data;
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
    let url = `http://${host}:${port}/api/printer/tool`;

    const data: Record<string, any> = {};
    if (component === "bed") {
      data.command = "target";
      data.target = temperature;
      url = `http://${host}:${port}/api/printer/bed`;
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

    return response.data;
  }
}
