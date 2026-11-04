import fs from "fs";
import FormData from "form-data";
import { isAxiosError } from "axios";
import { GenericPrinterImplementation, type GenericPrinterState, type SnapshotCandidate, type CameraCandidate } from "./generic-base.js";
import type { CounterpartProgress, FilamentSlot, PrinterIdentity } from "../counterpart/contract.js";
import { finiteNumber, nonEmptyText } from "../counterpart/contract.js";
import { mapMoonraker } from "../counterpart/progress.js";

const PROGRESS_QUERY = "print_stats&virtual_sdcard&display_status&extruder&heater_bed&webhooks";
const ESTIMATE_TTL_MS = 10 * 60_000;
export const MACRO_TIMEOUT_MS = 60_000;

function encodePath(filename: string): string {
  return filename.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
}

export class KlipperImplementation extends GenericPrinterImplementation {
  protected readonly printerLabel: string = "Klipper/Moonraker";
  /** Slicer estimates by host:port:filename, so a poll does not re-read file metadata. */
  private readonly estimates = new Map<string, { value?: number; at: number }>();

  /**
   * One object query; remaining time is the file's slicer estimate minus
   * print_duration. https://moonraker.readthedocs.io/en/latest/external_api/printer/
   * and .../external_api/file_manager/ (estimated_time, seconds).
   */
  async counterpartProgress(host: string, port: string, apiKey: string): Promise<CounterpartProgress> {
    const data = (await this.apiClient.get(`http://${host}:${port}/printer/objects/query?${PROGRESS_QUERY}`, this.authHeaders(apiKey))).data;
    const observedAt = new Date().toISOString();
    const status = data?.result?.status;
    if (!status || typeof status !== "object") throw new Error("Moonraker returned no printer object status.");
    const stats = status.print_stats ?? {};
    const filename = nonEmptyText(stats.filename);
    const estimate = filename && (stats.state === "printing" || stats.state === "paused")
      ? await this.estimatedTime(host, port, apiKey, filename)
      : undefined;
    return mapMoonraker(status, estimate, observedAt);
  }

  private async estimatedTime(host: string, port: string, apiKey: string, filename: string): Promise<number | undefined> {
    const key = `${host}:${port}:${filename}`;
    const cached = this.estimates.get(key);
    if (cached && Date.now() - cached.at < ESTIMATE_TTL_MS) return cached.value;
    let value: number | undefined;
    try {
      const metadata = (await this.apiClient.get(
        `http://${host}:${port}/server/files/metadata?filename=${encodeURIComponent(filename)}`,
        this.authHeaders(apiKey)
      )).data;
      const estimate = finiteNumber(metadata?.result?.estimated_time ?? metadata?.estimated_time);
      value = estimate !== undefined && estimate > 0 ? estimate : undefined;
    } catch {
      value = undefined;
    }
    if (this.estimates.size > 64) this.estimates.clear();
    this.estimates.set(key, { value, at: Date.now() });
    return value;
  }

  async reportsLayers(): Promise<boolean> {
    return true;
  }

  /**
   * GET /server/webcams/list: enabled webcams' snapshot_url, which may be a
   * path relative to the host. https://moonraker.readthedocs.io/en/latest/external_api/webcams/
   */
  async snapshotCandidates(host: string, port: string, apiKey: string): Promise<SnapshotCandidate[]> {
    return (await this.cameraCandidates(host, port, apiKey)).filter(candidate => candidate.transport === "http-snapshot");
  }

  async cameraCandidates(host: string, port: string, apiKey: string): Promise<CameraCandidate[]> {
    const data = (await this.apiClient.get(`http://${host}:${port}/server/webcams/list`, this.authHeaders(apiKey))).data;
    const webcams = Array.isArray(data?.result?.webcams) ? data.result.webcams : [];
    return webcams
      .filter((webcam: any) => webcam?.enabled !== false)
      .flatMap((webcam: any) => [
        ...(nonEmptyText(webcam?.stream_url)
          ? [{url: String(webcam.stream_url).trim(), snapshotUrl: nonEmptyText(webcam?.snapshot_url), unsupportedStream: /webrtc|hls/i.test(String(webcam?.service ?? "")), transport: "http-mjpeg" as const}] : []),
        ...(nonEmptyText(webcam?.snapshot_url) ? [{url: String(webcam.snapshot_url).trim(), transport: "http-snapshot" as const}] : []),
      ].map(candidate => ({...candidate, source: "moonraker-webcam", configured: true})));
  }

  /**
   * Spoolman through Moonraker: GET /server/spoolman/spool_id, then the proxy
   * for /v1/spool/<id>. https://moonraker.readthedocs.io/en/latest/external_api/integrations/
   * Spoolman color_hex has no '#'. Without Spoolman (404, null id) the slot is unknown.
   */
  async counterpartFilaments(host: string, port: string, apiKey: string): Promise<FilamentSlot[]> {
    const unknown: FilamentSlot[] = [{ id: "ext", source: "unknown" }];
    let spoolId: number | undefined;
    try {
      const active = (await this.apiClient.get(`http://${host}:${port}/server/spoolman/spool_id`, this.authHeaders(apiKey))).data;
      spoolId = finiteNumber(active?.result?.spool_id);
    } catch (error) {
      if (isAxiosError(error) && error.response) return unknown;
      throw error;
    }
    if (spoolId === undefined) return unknown;
    const proxied = (await this.apiClient.post(
      `http://${host}:${port}/server/spoolman/proxy`,
      { request_method: "GET", path: `/v1/spool/${spoolId}` } as any,
      this.authHeaders(apiKey)
    )).data;
    // v1 responses return the spool directly; use_v2_response wraps it in {response, error}.
    const spool = proxied?.result?.response ?? proxied?.result;
    const filament = spool?.filament ?? {};
    const hex = nonEmptyText(filament.color_hex)?.replace(/^#/, "");
    return [{
      id: "ext",
      material: nonEmptyText(filament.material),
      color: hex && /^[0-9a-f]{6}$/i.test(hex) ? `#${hex.toUpperCase()}` : undefined,
      name: nonEmptyText(filament.name),
      source: "spoolman",
    }];
  }

  async counterpartIdentity(host: string, port: string, apiKey: string): Promise<PrinterIdentity> {
    const info = (await this.apiClient.get(`http://${host}:${port}/printer/info`, this.authHeaders(apiKey))).data;
    return { name: nonEmptyText(info?.result?.hostname) };
  }

  /**
   * POST /printer/print/pause and /printer/print/resume (Moonraker printer API).
   * Moonraker answers after the PAUSE/RESUME macro finishes (parking, retract),
   * which can exceed the shared 10 s client timeout.
   */
  protected async rawPauseJob(host: string, port: string, apiKey: string) {
    return (await this.apiClient.post(`http://${host}:${port}/printer/print/pause`, null as any, { ...this.authHeaders(apiKey), timeout: MACRO_TIMEOUT_MS })).data;
  }

  protected async rawResumeJob(host: string, port: string, apiKey: string) {
    return (await this.apiClient.post(`http://${host}:${port}/printer/print/resume`, null as any, { ...this.authHeaders(apiKey), timeout: MACRO_TIMEOUT_MS })).data;
  }

  protected authHeaders(apiKey: string): Record<string, unknown> {
    return apiKey ? { headers: { "X-Api-Key": apiKey } } : {};
  }

  async getStatus(host: string, port: string, apiKey: string) {
    const url = `http://${host}:${port}/printer/info`;
    const response = await this.apiClient.get(url, this.authHeaders(apiKey));
    return response.data;
  }

  async getFiles(host: string, port: string, apiKey: string) {
    const url = `http://${host}:${port}/server/files/list`;
    const response = await this.apiClient.get(url, this.authHeaders(apiKey));
    return response.data;
  }

  async getFile(host: string, port: string, apiKey: string, filename: string) {
    const url = `http://${host}:${port}/server/files/metadata?filename=${encodeURIComponent(filename)}`;
    const response = await this.apiClient.get(url, this.authHeaders(apiKey));
    return response.data;
  }

  /**
   * Moonraker object query: webhooks.state must be "ready" (not startup,
   * shutdown or error) and print_stats.state standby/complete/cancelled.
   * complete/cancelled print like standby: the printer detects an occupied bed itself.
   */
  protected async readPrinterState(host: string, port: string, apiKey: string): Promise<GenericPrinterState> {
    let data: any;
    try {
      data = (await this.apiClient.get(
        `http://${host}:${port}/printer/objects/query?webhooks&print_stats`,
        this.authHeaders(apiKey)
      )).data;
    } catch (error) {
      throw new Error(`Cannot read Klipper/Moonraker printer state; nothing was sent: ${(error as Error).message}`);
    }
    const status = data?.result?.status;
    const klippy = status?.webhooks?.state;
    const job = status?.print_stats?.state;
    if (typeof klippy !== "string" || typeof job !== "string") {
      throw new Error("Moonraker did not report webhooks.state and print_stats.state; cannot verify the printer is idle.");
    }
    const state = `klippy ${klippy}, print ${job}`;
    if (klippy !== "ready") {
      return { state, ready: false, reason: status?.webhooks?.state_message ? String(status.webhooks.state_message) : "Klipper is not ready" };
    }
    if (!["standby", "complete", "cancelled"].includes(job)) {
      return { state, ready: false, reason: `print_stats.state is ${job}` };
    }
    return { state, ready: true };
  }

  protected async downloadRemoteFile(host: string, port: string, apiKey: string, filename: string, destination: string): Promise<void> {
    await this.downloadToFile(
      `http://${host}:${port}/server/files/gcodes/${encodePath(filename)}`,
      apiKey ? { "X-Api-Key": apiKey } : {},
      destination
    );
  }

  /** Current Moonraker returns {result:{item}}; older releases returned result "success". */
  protected uploadSucceeded(data: any): boolean {
    return data?.result === "success" || !!data?.result?.item || !!data?.item;
  }

  protected async rawUploadFile(host: string, port: string, apiKey: string, filePath: string, filename: string, print: boolean) {
    const url = `http://${host}:${port}/server/files/upload`;

    const formData = new FormData();
    formData.append("file", fs.createReadStream(filePath));
    formData.append("filename", filename);

    const response = await this.apiClient.post(url, formData as any, {
      headers: {
        ...formData.getHeaders(),
        ...(apiKey ? { "X-Api-Key": apiKey } : {})
      }
    });

    return response.data;
  }

  protected async rawStartJob(host: string, port: string, apiKey: string, filename: string) {
    const url = `http://${host}:${port}/printer/print/start`;

    const response = await this.apiClient.post(url, { filename } as any, this.authHeaders(apiKey));

    return response.data;
  }

  protected async rawCancelJob(host: string, port: string, apiKey: string) {
    const url = `http://${host}:${port}/printer/print/cancel`;

    const response = await this.apiClient.post(url, null as any, this.authHeaders(apiKey));

    return response.data;
  }

  protected async rawSetTemperature(host: string, port: string, apiKey: string, component: string, temperature: number) {
    const url = `http://${host}:${port}/printer/gcode/script`;

    let gcode;
    if (component === "bed") {
      gcode = `SET_HEATER_TEMPERATURE HEATER=heater_bed TARGET=${temperature}`;
    } else if (component === "extruder") {
      gcode = `SET_HEATER_TEMPERATURE HEATER=extruder TARGET=${temperature}`;
    } else {
      throw new Error(`Unsupported component: ${component}`);
    }

    const response = await this.apiClient.post(url, {
      script: gcode
    } as any, this.authHeaders(apiKey));

    return response.data;
  }
}
