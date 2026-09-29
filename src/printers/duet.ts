import fs from "fs";
import { GenericPrinterImplementation, type GenericPrinterState } from "./generic-base.js";

/**
 * Duet Software Framework (DuetWebServer) REST routes, verified against
 * DuetSoftwareFramework src/DuetWebServer/Controllers/MachineController.cs:
 * GET status, POST code (raw text body), GET/PUT file/{*filename},
 * GET directory/{*directory}. Standalone RepRapFirmware rr_* routes are not
 * supported by this adapter.
 */
function duetPath(filename: string): string {
  const name = filename.trim();
  if (/^\d+:\//.test(name)) return name;
  if (name.startsWith("/")) return `0:${name}`;
  return `0:/gcodes/${name}`;
}

export class DuetImplementation extends GenericPrinterImplementation {
  protected readonly printerLabel = "Duet";

  private async code(host: string, port: string, code: string) {
    const response = await this.apiClient.post(`http://${host}:${port}/machine/code`, code as any, {
      headers: { "Content-Type": "text/plain" },
    });
    return response.data;
  }

  async getStatus(host: string, port: string, apiKey: string) {
    const url = `http://${host}:${port}/machine/status`;
    const response = await this.apiClient.get(url);
    return response.data;
  }

  async getFiles(host: string, port: string, apiKey: string) {
    const url = `http://${host}:${port}/machine/directory/${encodeURIComponent("0:/gcodes")}`;
    const response = await this.apiClient.get(url);
    return response.data;
  }

  async getFile(host: string, port: string, apiKey: string, filename: string) {
    const url = `http://${host}:${port}/machine/file/${encodeURIComponent(filename)}`;
    const response = await this.apiClient.get(url);
    return response.data;
  }

  /** Object model state.status: only "idle" can start a job or heat. */
  protected async readPrinterState(host: string, port: string, apiKey: string): Promise<GenericPrinterState> {
    let data: any;
    try {
      data = (await this.apiClient.get(`http://${host}:${port}/machine/status`)).data;
    } catch (error) {
      throw new Error(`Cannot read Duet object model state; nothing was sent: ${(error as Error).message}`);
    }
    const status = data?.state?.status ?? data?.result?.state?.status;
    if (typeof status !== "string" || !status) {
      throw new Error("Duet did not report state.status; cannot verify the printer is idle.");
    }
    return { state: status, ready: status === "idle", reason: status === "idle" ? undefined : `state.status is ${status}` };
  }

  protected async downloadRemoteFile(host: string, port: string, apiKey: string, filename: string, destination: string): Promise<void> {
    await this.downloadToFile(`http://${host}:${port}/machine/file/${encodeURIComponent(duetPath(filename))}`, {}, destination);
  }

  protected async rawUploadFile(host: string, port: string, apiKey: string, filePath: string, filename: string, print: boolean) {
    const url = `http://${host}:${port}/machine/file/${encodeURIComponent(duetPath(filename))}`;
    const response = await this.apiClient.put(url, fs.createReadStream(filePath) as any, {
      headers: { "Content-Type": "application/octet-stream", "Content-Length": String((await fs.promises.stat(filePath)).size) },
    });
    // Printing is started by the shared gate only after a fresh state recheck.
    return response.data ?? { uploaded: true };
  }

  protected async rawStartJob(host: string, port: string, apiKey: string, filename: string) {
    return this.code(host, port, `M32 "${duetPath(filename)}"`);
  }

  protected async rawCancelJob(host: string, port: string, apiKey: string) {
    return this.code(host, port, "M0");
  }

  protected async rawSetTemperature(host: string, port: string, apiKey: string, component: string, temperature: number) {
    let gcode;
    if (component === "bed") {
      gcode = `M140 S${temperature}`;
    } else if (component === "extruder") {
      gcode = `M104 S${temperature}`;
    } else {
      throw new Error(`Unsupported component: ${component}`);
    }
    return this.code(host, port, gcode);
  }
}
