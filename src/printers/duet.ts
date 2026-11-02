import fs from "fs";
import { isAxiosError } from "axios";
import { GenericPrinterImplementation, type GenericPrinterState } from "./generic-base.js";
import type { CounterpartProgress, PrinterIdentity } from "../counterpart/contract.js";
import { nonEmptyText } from "../counterpart/contract.js";
import { mapDuet } from "../counterpart/progress.js";

function notFound(error: unknown): boolean {
  return isAxiosError(error) && (error.response?.status === 404 || error.response?.status === 405);
}

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

  /**
   * Object model keys for counterpart_print_progress and identity. Standalone
   * RepRapFirmware and DSF 3.5+ answer rr_model; older DSF only /machine/status
   * (an alias of /machine/model). 'v' (verbose) is required: 'f' omits job.file.
   * Without a machine password no rr_connect is needed; with one, requests get 401.
   * https://github.com/Duet3D/RepRapFirmware/wiki/HTTP-requests
   */
  private async objectModel(host: string, port: string, keys: string[]): Promise<Record<string, any>> {
    const base = `http://${host}:${port}`;
    const model: Record<string, any> = {};
    try {
      // Sequential: standalone boards serve few concurrent HTTP connections.
      for (const key of keys) {
        model[key] = (await this.apiClient.get(`${base}/rr_model?key=${encodeURIComponent(key)}&flags=d99v`)).data?.result;
      }
      return model;
    } catch (error) {
      if (!notFound(error)) throw error;
    }
    const full = (await this.apiClient.get(`${base}/machine/status`)).data;
    const root = full?.result && typeof full.result === "object" ? full.result : full;
    for (const key of keys) model[key] = root?.[key];
    return model;
  }

  async counterpartProgress(host: string, port: string, apiKey: string): Promise<CounterpartProgress> {
    const model = await this.objectModel(host, port, ["state", "job"]);
    if (!model.state || typeof model.state !== "object") throw new Error("Duet did not return state from its object model.");
    return mapDuet(model.state, model.job ?? {}, new Date().toISOString());
  }

  async reportsLayers(): Promise<boolean> {
    return true;
  }

  async counterpartIdentity(host: string, port: string): Promise<PrinterIdentity> {
    const model = await this.objectModel(host, port, ["network", "boards"]);
    const board = Array.isArray(model.boards) ? model.boards[0] : undefined;
    return { name: nonEmptyText(model.network?.name), model: nonEmptyText(board?.name) ?? nonEmptyText(board?.shortName) };
  }

  /** M25 pauses and M24 resumes: rr_gcode on standalone/DSF 3.5+, POST /machine/code on older DSF. */
  protected async rawPauseJob(host: string, port: string) {
    return this.sendGcode(host, port, "M25");
  }

  protected async rawResumeJob(host: string, port: string) {
    return this.sendGcode(host, port, "M24");
  }

  private async sendGcode(host: string, port: string, gcode: string) {
    try {
      return (await this.apiClient.get(`http://${host}:${port}/rr_gcode?gcode=${encodeURIComponent(gcode)}`)).data;
    } catch (error) {
      if (!notFound(error)) throw error;
    }
    return this.code(host, port, gcode);
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
