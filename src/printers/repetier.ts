import fs from "fs";
import FormData from "form-data";
import { GenericPrinterImplementation, type GenericPrinterState, type SnapshotCandidate } from "./generic-base.js";
import type { CounterpartProgress, PrinterIdentity } from "../counterpart/contract.js";
import { nonEmptyText } from "../counterpart/contract.js";
import { mapRepetier } from "../counterpart/progress.js";

/**
 * Note: Repetier-Server documents printer commands at /printer/api/<slug>;
 * this adapter's slug-less routes are unverified. Remote starts are refused
 * because Repetier documents no complete file download for inspection.
 */
export class RepetierImplementation extends GenericPrinterImplementation {
  protected readonly printerLabel = "Repetier";
  // The upload form's print=1 flag uploads and starts the same bytes.
  protected readonly uploadStartsPrint = true;

  /**
   * The printer the counterpart tools address: REPETIER_SLUG when set,
   * otherwise the only printer listPrinter reports.
   * REST form: /printer/api/<slug>?a=<command>&data=<json>&apikey=<key>
   * (https://www.repetier-server.com/manuals/programming/API/index.html).
   */
  private async selectPrinter(host: string, port: string, apiKey: string): Promise<{ slug: string; entry: any }> {
    const wanted = process.env.REPETIER_SLUG?.trim();
    const route = wanted ? encodeURIComponent(wanted) : "";
    const data = (await this.apiClient.get(`http://${host}:${port}/printer/api/${route}?a=listPrinter&apikey=${encodeURIComponent(apiKey)}`)).data;
    const printers: any[] = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
    if (wanted) {
      const entry = printers.find((printer) => printer?.slug === wanted);
      if (!entry) throw new Error(`Repetier lists no printer with slug "${wanted}" (REPETIER_SLUG).`);
      return { slug: wanted, entry };
    }
    if (printers.length !== 1 || typeof printers[0]?.slug !== "string") {
      throw new Error(`Repetier reports ${printers.length} printers; set REPETIER_SLUG to the printer's slug.`);
    }
    return { slug: printers[0].slug, entry: printers[0] };
  }

  private printerUrl(host: string, port: string, apiKey: string, slug: string, action: string, data?: unknown): string {
    const query = `a=${action}${data === undefined ? "" : `&data=${encodeURIComponent(JSON.stringify(data))}`}&apikey=${encodeURIComponent(apiKey)}`;
    return `http://${host}:${port}/printer/api/${encodeURIComponent(slug)}?${query}`;
  }

  async counterpartProgress(host: string, port: string, apiKey: string): Promise<CounterpartProgress> {
    const { entry } = await this.selectPrinter(host, port, apiKey);
    return mapRepetier(entry, new Date().toISOString());
  }

  async counterpartIdentity(host: string, port: string, apiKey: string): Promise<PrinterIdentity> {
    const { entry, slug } = await this.selectPrinter(host, port, apiKey);
    return { name: nonEmptyText(entry?.name) ?? slug };
  }

  /** getPrinterConfig webcams[].staticUrl (older servers: a single webcam object). */
  async snapshotCandidates(host: string, port: string, apiKey: string): Promise<SnapshotCandidate[]> {
    const { slug } = await this.selectPrinter(host, port, apiKey);
    const config = (await this.apiClient.get(this.printerUrl(host, port, apiKey, slug, "getPrinterConfig"))).data;
    const webcams = Array.isArray(config?.webcams) ? config.webcams : config?.webcam ? [config.webcam] : [];
    return webcams
      .map((webcam: any) => nonEmptyText(webcam?.staticUrl))
      .filter((url: string | undefined): url is string => url !== undefined)
      .map((url: string) => ({ url, source: "repetier-webcam", configured: true }));
  }

  /** Pause sends the @pause host command; resume is the documented continueJob. */
  protected async rawPauseJob(host: string, port: string, apiKey: string) {
    const { slug } = await this.selectPrinter(host, port, apiKey);
    return (await this.apiClient.get(this.printerUrl(host, port, apiKey, slug, "send", { cmd: "@pause" }))).data;
  }

  protected async rawResumeJob(host: string, port: string, apiKey: string) {
    const { slug } = await this.selectPrinter(host, port, apiKey);
    return (await this.apiClient.get(this.printerUrl(host, port, apiKey, slug, "continueJob"))).data;
  }

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
