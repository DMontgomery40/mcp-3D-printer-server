import fs from "fs";
import FormData from "form-data";
import { isAxiosError } from "axios";
import { GenericPrinterImplementation, type GenericPrinterState, type HeaterComponent } from "./generic-base.js";

const BLOCKING_FLAGS = ["printing", "paused", "pausing", "cancelling", "resuming", "finishing", "error", "closedOrError"];

function encodePath(filename: string): string {
  return filename.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
}

export class OctoPrintImplementation extends GenericPrinterImplementation {
  protected readonly printerLabel = "OctoPrint";
  // POST /api/files/local with print=true uploads and starts the same bytes.
  protected readonly uploadStartsPrint = true;

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
