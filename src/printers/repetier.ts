import fs from "fs";
import FormData from "form-data";
import { GenericPrinterImplementation, type GenericPrinterState } from "./generic-base.js";

/**
 * Note: Repetier-Server documents printer commands at /printer/api/<slug>;
 * this adapter's slug-less routes are unverified. Remote starts are refused
 * because Repetier documents no complete file download for inspection.
 */
export class RepetierImplementation extends GenericPrinterImplementation {
  protected readonly printerLabel = "Repetier";
  // The upload form's print=1 flag uploads and starts the same bytes.
  protected readonly uploadStartsPrint = true;

  async getStatus(host: string, port: string, apiKey: string) {
    const url = `http://${host}:${port}/printer/api/?a=getPrinterInfo&apikey=${apiKey}`;
    const response = await this.apiClient.get(url);
    return response.data;
  }

  async getFiles(host: string, port: string, apiKey: string) {
    const url = `http://${host}:${port}/printer/api/?a=ls&apikey=${apiKey}`;
    const response = await this.apiClient.get(url);
    return response.data;
  }

  async getFile(host: string, port: string, apiKey: string, filename: string) {
    const url = `http://${host}:${port}/printer/api/?a=getFileInfo&apikey=${apiKey}&filename=${encodeURIComponent(filename)}`;
    const response = await this.apiClient.get(url);
    return response.data;
  }

  /**
   * listPrinter returns one entry per printer (online 0/1, active, job "none").
   * Without a configured slug, more than one printer is ambiguous.
   */
  protected async readPrinterState(host: string, port: string, apiKey: string): Promise<GenericPrinterState> {
    let data: any;
    try {
      data = (await this.apiClient.get(`http://${host}:${port}/printer/api/?a=listPrinter&apikey=${encodeURIComponent(apiKey)}`)).data;
    } catch (error) {
      throw new Error(`Cannot read Repetier printer state; nothing was sent: ${(error as Error).message}`);
    }
    const printers = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : undefined;
    if (!printers) throw new Error("Repetier did not return a printer list; cannot verify the printer is idle.");
    if (printers.length !== 1) {
      throw new Error(`Repetier reports ${printers.length} printers; this adapter cannot tell which one would receive the job.`);
    }
    const [printer] = printers;
    const online = printer?.online === 1 || printer?.online === true;
    const job = typeof printer?.job === "string" ? printer.job : undefined;
    if (job === undefined) throw new Error("Repetier did not report the printer's job state; cannot verify it is idle.");
    const reasons = [
      ...(online ? [] : ["offline"]),
      ...(printer?.active === false ? ["inactive"] : []),
      ...(job !== "none" && job !== "" ? [`job ${job} is active`] : []),
      ...(printer?.paused === true ? ["paused"] : []),
    ];
    return { state: `${online ? "online" : "offline"}, job ${job || "none"}`, ready: reasons.length === 0, reason: reasons.join(", ") || undefined };
  }

  protected async rawUploadFile(host: string, port: string, apiKey: string, filePath: string, filename: string, print: boolean) {
    const url = `http://${host}:${port}/printer/api/`;

    const formData = new FormData();
    formData.append("a", "upload");
    formData.append("apikey", apiKey);
    formData.append("filename", filename);
    formData.append("print", print ? "1" : "0");
    formData.append("file", fs.createReadStream(filePath));

    const response = await this.apiClient.post(url, formData as any, {
      headers: {
        ...formData.getHeaders()
      }
    });

    return response.data;
  }

  protected async rawStartJob(host: string, port: string, apiKey: string, filename: string) {
    const url = `http://${host}:${port}/printer/api/?a=startJob&apikey=${apiKey}&filename=${encodeURIComponent(filename)}`;
    const response = await this.apiClient.get(url);
    return response.data;
  }

  protected async rawCancelJob(host: string, port: string, apiKey: string) {
    const url = `http://${host}:${port}/printer/api/?a=stopJob&apikey=${apiKey}`;
    const response = await this.apiClient.get(url);
    return response.data;
  }

  protected async rawSetTemperature(host: string, port: string, apiKey: string, component: string, temperature: number) {
    let url;
    if (component === "bed") {
      url = `http://${host}:${port}/printer/api/?a=setBedTemp&apikey=${apiKey}&temp=${temperature}`;
    } else if (component === "extruder") {
      url = `http://${host}:${port}/printer/api/?a=setExtruderTemp&apikey=${apiKey}&temp=${temperature}`;
    } else {
      throw new Error(`Unsupported component: ${component}`);
    }

    const response = await this.apiClient.get(url);
    return response.data;
  }
}
