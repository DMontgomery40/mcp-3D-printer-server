import type { AxiosInstance } from "axios";
import { GenericPrinterImplementation, type GenericPrinterState, type SnapshotCandidate, type CameraCandidate } from "./generic-base.js";
import { KlipperImplementation, MACRO_TIMEOUT_MS } from "./klipper.js";
import type { ConfirmHardware } from "../safety/confirmation.js";
import type { CounterpartProgress, FilamentSlot, PrinterIdentity } from "../counterpart/contract.js";
import { mapCrealityDevice } from "../counterpart/progress.js";
import fs from "fs";
import FormData from "form-data";

/**
 * K1/K2-series printers can run Moonraker: 7125 is Moonraker's own port and
 * 4408 the Fluidd nginx front end that proxies its API. Neither is documented
 * by Creality; stock firmware may run neither, so this is probed, never assumed.
 */
export const CREALITY_MOONRAKER_PORTS = ["7125", "4408"];
const MOONRAKER_PROBE_TTL_MS = 5 * 60_000;

const IDLE_STATES = new Set(["idle", "ready", "standby", "operational"]);
const FINISHED_STATES = new Set(["complete", "completed", "finished", "finish", "cancelled", "canceled", "stopped"]);

/**
 * Note: this adapter's /api/device, /api/storage and /api/job routes are not a
 * documented Creality API. Readiness fails closed unless the response carries
 * a recognized idle state; remote starts are refused because no download
 * route is verified.
 */
export class CrealityImplementation extends GenericPrinterImplementation {
  protected readonly printerLabel = "Creality";
  private readonly moonraker: KlipperImplementation;
  private readonly probes = new Map<string, { port?: string; at: number }>();
  /** Ports probed for Moonraker, in order. */
  moonrakerPorts: string[] = [...CREALITY_MOONRAKER_PORTS];

  constructor(apiClient: AxiosInstance, confirm?: ConfirmHardware) {
    super(apiClient, confirm);
    this.moonraker = new KlipperImplementation(apiClient, confirm);
  }

  /** The Moonraker port that answers /server/info on this host, if any. */
  async moonrakerPort(host: string): Promise<string | undefined> {
    const cached = this.probes.get(host);
    if (cached && Date.now() - cached.at < MOONRAKER_PROBE_TTL_MS) return cached.port;
    let found: string | undefined;
    for (const port of this.moonrakerPorts) {
      try {
        const info = (await this.apiClient.get(`http://${host}:${port}/server/info`, { timeout: 2_000 })).data;
        if (info?.result && typeof info.result === "object") { found = port; break; }
      } catch {
        // Try the next port.
      }
    }
    this.probes.set(host, { port: found, at: Date.now() });
    return found;
  }

  async counterpartProgress(host: string, port: string, apiKey: string): Promise<CounterpartProgress> {
    const moonraker = await this.moonrakerPort(host);
    if (moonraker) return this.moonraker.counterpartProgress(host, moonraker, "");
    const data = (await this.apiClient.get(`http://${host}:${port}/api/device/status`, { headers: { "Authorization": `Bearer ${apiKey}` } })).data;
    return mapCrealityDevice(data, new Date().toISOString());
  }

  async reportsLayers(host: string): Promise<boolean> {
    return (await this.moonrakerPort(host)) !== undefined;
  }

  async supportsPauseResume(host: string): Promise<boolean> {
    return (await this.moonrakerPort(host)) !== undefined;
  }

  async snapshotCandidates(host: string): Promise<SnapshotCandidate[]> {
    const moonraker = await this.moonrakerPort(host);
    return moonraker ? this.moonraker.snapshotCandidates(host, moonraker, "") : [];
  }

  async cameraCandidates(host: string): Promise<CameraCandidate[]> {
    const moonraker = await this.moonrakerPort(host);
    return moonraker ? this.moonraker.cameraCandidates(host, moonraker, "") : [];
  }

  async counterpartFilaments(host: string, port: string, apiKey: string): Promise<FilamentSlot[]> {
    const moonraker = await this.moonrakerPort(host);
    return moonraker ? this.moonraker.counterpartFilaments(host, moonraker, "") : super.counterpartFilaments(host, port, apiKey);
  }

  async counterpartIdentity(host: string): Promise<PrinterIdentity> {
    const moonraker = await this.moonrakerPort(host);
    return moonraker ? this.moonraker.counterpartIdentity(host, moonraker, "") : {};
  }

  /** Pause and resume only through a detected Moonraker; the device API has no verified route. */
  protected async rawPauseJob(host: string) {
    const moonraker = await this.moonrakerPort(host);
    if (!moonraker) throw new Error("Unsupported: this Creality printer has no Moonraker API for pause.");
    return (await this.apiClient.post(`http://${host}:${moonraker}/printer/print/pause`, null as any, { timeout: MACRO_TIMEOUT_MS })).data;
  }

  protected async rawResumeJob(host: string) {
    const moonraker = await this.moonrakerPort(host);
    if (!moonraker) throw new Error("Unsupported: this Creality printer has no Moonraker API for resume.");
    // The Creality adapter already checked the job identity; send the raw resume.
    return (await this.apiClient.post(`http://${host}:${moonraker}/printer/print/resume`, null as any, { timeout: MACRO_TIMEOUT_MS })).data;
  }

  protected async readPrinterState(host: string, port: string, apiKey: string): Promise<GenericPrinterState> {
    let data: any;
    try {
      data = (await this.apiClient.get(`http://${host}:${port}/api/device/status`, { headers: { "Authorization": `Bearer ${apiKey}` } })).data;
    } catch (error) {
      throw new Error(`Cannot read Creality printer state; nothing was sent: ${(error as Error).message}`);
    }
    const candidates = [data?.state, data?.status, data?.printStatus, data?.print_state, data?.data?.state, data?.data?.status];
    const raw = candidates.find((value) => typeof value === "string" && value.trim());
    if (typeof raw !== "string") {
      throw new Error("Creality did not report a recognizable printer state; cannot verify the printer is idle.");
    }
    const state = raw.trim().toLowerCase();
    if (IDLE_STATES.has(state)) return { state, ready: true };
    if (FINISHED_STATES.has(state)) return { state, ready: true };
    return { state, ready: false, reason: `state is ${state}` };
  }

  async getStatus(host: string, port: string, apiKey: string) {
    const url = `http://${host}:${port}/api/device/status`;
    const response = await this.apiClient.get(url, {
      headers: {
        "Authorization": `Bearer ${apiKey}`
      }
    });
    return response.data;
  }

  async getFiles(host: string, port: string, apiKey: string) {
    const url = `http://${host}:${port}/api/storage/list`;
    const response = await this.apiClient.get(url, {
      headers: {
        "Authorization": `Bearer ${apiKey}`
      }
    });
    return response.data;
  }

  async getFile(host: string, port: string, apiKey: string, filename: string) {
    const url = `http://${host}:${port}/api/storage/info?filename=${encodeURIComponent(filename)}`;
    const response = await this.apiClient.get(url, {
      headers: {
        "Authorization": `Bearer ${apiKey}`
      }
    });
    return response.data;
  }

  protected uploadSucceeded(data: any): boolean {
    return !!data?.success;
  }

  protected async rawUploadFile(host: string, port: string, apiKey: string, filePath: string, filename: string, print: boolean) {
    const url = `http://${host}:${port}/api/storage/upload`;
    
    const formData = new FormData();
    formData.append("file", fs.createReadStream(filePath));
    formData.append("filename", filename);
    
    const response = await this.apiClient.post(url, formData as any, {
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        ...formData.getHeaders()
      }
    });
    
    // Printing is started by the shared gate only after a fresh state recheck.
    
    return response.data;
  }

  protected async rawStartJob(host: string, port: string, apiKey: string, filename: string) {
    const url = `http://${host}:${port}/api/job/start`;
    
    const response = await this.apiClient.post(url, {
      filename: filename
    } as any, {
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      }
    });
    
    return response.data;
  }

  protected async rawCancelJob(host: string, port: string, apiKey: string) {
    const url = `http://${host}:${port}/api/job/cancel`;
    
    const response = await this.apiClient.post(url, {} as any, {
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      }
    });
    
    return response.data;
  }

  protected async rawSetTemperature(host: string, port: string, apiKey: string, component: string, temperature: number) {
    const url = `http://${host}:${port}/api/printer/temperature`;
    
    let data: Record<string, any> = {};
    if (component === "bed") {
      data.bed = temperature;
    } else if (component === "extruder") {
      data.hotend = temperature;
    } else {
      throw new Error(`Unsupported component: ${component}`);
    }
    
    const response = await this.apiClient.post(url, data as any, {
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      }
    });
    
    return response.data;
  }
}
