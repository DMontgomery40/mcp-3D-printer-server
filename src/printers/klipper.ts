import fs from "fs";
import FormData from "form-data";
import { GenericPrinterImplementation, type GenericPrinterState } from "./generic-base.js";

function encodePath(filename: string): string {
  return filename.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
}

export class KlipperImplementation extends GenericPrinterImplementation {
  protected readonly printerLabel = "Klipper/Moonraker";

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
   * complete/cancelled can leave a part on the bed, so they need a human.
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
    return {
      state,
      ready: true,
      finishedJob: job === "standby" ? undefined : JSON.stringify([job, status?.print_stats?.filename ?? null]),
    };
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
