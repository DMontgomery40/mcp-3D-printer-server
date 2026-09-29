import { GenericPrinterImplementation, type GenericPrinterState } from "./generic-base.js";
import fs from "fs";
import FormData from "form-data";

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
    if (FINISHED_STATES.has(state)) return { state, ready: true, finishedJob: JSON.stringify([state]) };
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