import { isAxiosError, type AxiosRequestConfig, type AxiosResponse } from "axios";
import { GenericPrinterImplementation, type GenericPrinterState, type HeaterComponent } from "./generic-base.js";
import fs from "fs";
import FormData from "form-data";

type RequestCandidate = {
  route: string;
  data?: unknown;
};

const PRUSALINK_READY_STATES = new Set(["IDLE", "READY", "FINISHED", "STOPPED"]);
const OCTOPRINT_BLOCKING_FLAGS = ["printing", "paused", "pausing", "cancelling", "resuming", "finishing", "error", "closedOrError"];

export class PrusaImplementation extends GenericPrinterImplementation {
  protected readonly printerLabel = "Prusa";
  private buildAuthHeaders(apiKey: string): Record<string, string> {
    return {
      Accept: "application/json",
      "X-Api-Key": apiKey,
      Authorization: `Bearer ${apiKey}`,
    };
  }

  private buildBaseUrl(host: string, port: string): string {
    const trimmedHost = host.trim();
    const trimmedPort = port.trim();
    if (!trimmedHost) {
      throw new Error("Prusa host is required.");
    }

    const rawBaseUrl = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmedHost)
      ? trimmedHost
      : `${this.defaultProtocolFor(trimmedHost, trimmedPort)}://${trimmedHost}`;
    const parsed = new URL(rawBaseUrl);

    if (trimmedPort && !parsed.port && !this.isDefaultPort(parsed.protocol, trimmedPort)) {
      parsed.port = trimmedPort;
    }

    return parsed.toString().replace(/\/$/, "");
  }

  private defaultProtocolFor(host: string, port: string): "http" | "https" {
    if (port === "443" || this.isPrusaConnectCloudHost(host)) {
      return "https";
    }
    return "http";
  }

  private isDefaultPort(protocol: string, port: string): boolean {
    return (protocol === "https:" && port === "443") || (protocol === "http:" && port === "80");
  }

  private isPrusaConnectCloudHost(host: string): boolean {
    try {
      const parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(host) ? host : `https://${host}`);
      return parsed.hostname.toLowerCase() === "connect.prusa3d.com";
    } catch {
      return host.toLowerCase().split(":")[0] === "connect.prusa3d.com";
    }
  }

  private isFallbackStatus(error: unknown): boolean {
    if (!isAxiosError(error)) {
      return false;
    }

    const status = error.response?.status;
    return status === 404 || status === 405 || status === 501;
  }

  private async getWithFallback(
    host: string,
    port: string,
    apiKey: string,
    routes: string[]
  ): Promise<AxiosResponse> {
    const baseUrl = this.buildBaseUrl(host, port);
    let lastError: unknown;

    for (const route of routes) {
      try {
        return await this.apiClient.get(`${baseUrl}${route}`, {
          headers: this.buildAuthHeaders(apiKey),
        });
      } catch (error) {
        lastError = error;
        if (!this.isFallbackStatus(error)) {
          throw error;
        }
      }
    }

    throw lastError ?? new Error("No compatible Prusa GET endpoint found.");
  }

  private async postWithFallback(
    host: string,
    port: string,
    apiKey: string,
    candidates: RequestCandidate[],
    config?: AxiosRequestConfig
  ): Promise<AxiosResponse> {
    const baseUrl = this.buildBaseUrl(host, port);
    let lastError: unknown;

    for (const candidate of candidates) {
      try {
        return await this.apiClient.post(`${baseUrl}${candidate.route}`, candidate.data as any, {
          ...(config ?? {}),
          headers: {
            ...this.buildAuthHeaders(apiKey),
            ...(config?.headers ?? {}),
          },
        });
      } catch (error) {
        lastError = error;
        if (!this.isFallbackStatus(error)) {
          throw error;
        }
      }
    }

    throw lastError ?? new Error("No compatible Prusa POST endpoint found.");
  }

  async getStatus(host: string, port: string, apiKey: string) {
    const response = await this.getWithFallback(host, port, apiKey, [
      "/api/v1/status",
      "/api/v1/printer",
      "/api/printer",
    ]);
    return response.data;
  }

  async getFiles(host: string, port: string, apiKey: string) {
    const response = await this.getWithFallback(host, port, apiKey, [
      "/api/v1/storage",
      "/api/files",
      "/api/files/local",
    ]);
    return response.data;
  }

  async getFile(host: string, port: string, apiKey: string, filename: string) {
    const encodedFile = encodeURIComponent(filename);
    const response = await this.getWithFallback(host, port, apiKey, [
      `/api/v1/storage/${encodedFile}`,
      `/api/files/local/${encodedFile}`,
    ]);
    return response.data;
  }

  /**
   * PrusaLink /api/v1/status printer.state, falling back to the legacy
   * OctoPrint-compatible /api/printer flags. FINISHED and STOPPED are idle but
   * may leave a part on the bed, so they require a human confirmation.
   */
  protected async readPrinterState(host: string, port: string, apiKey: string): Promise<GenericPrinterState> {
    let response: AxiosResponse;
    try {
      response = await this.getWithFallback(host, port, apiKey, ["/api/v1/status", "/api/printer"]);
    } catch (error) {
      throw new Error(`Cannot read Prusa printer state; nothing was sent: ${(error as Error).message}`);
    }
    const data: any = response.data;
    const v1State = data?.printer?.state;
    if (typeof v1State === "string" && v1State) {
      const state = v1State.toUpperCase();
      const ready = PRUSALINK_READY_STATES.has(state);
      return {
        state,
        ready,
        reason: ready ? undefined : `printer.state is ${state}`,
        finishedJob: ready && (state === "FINISHED" || state === "STOPPED") ? JSON.stringify([state, data?.job?.id ?? null]) : undefined,
      };
    }
    const flags = data?.state?.flags;
    if (flags && typeof flags === "object") {
      const blocking = OCTOPRINT_BLOCKING_FLAGS.filter((flag) => flags[flag] === true);
      if (flags.operational !== true) blocking.unshift("not operational");
      return { state: String(data?.state?.text ?? "unknown"), ready: blocking.length === 0, reason: blocking.join(", ") || undefined };
    }
    throw new Error("Prusa did not report printer.state or state flags; cannot verify the printer is idle.");
  }

  protected async rawUploadFile(
    host: string,
    port: string,
    apiKey: string,
    filePath: string,
    filename: string,
    print: boolean
  ) {
    const formData = new FormData();
    formData.append("file", fs.createReadStream(filePath));
    formData.append("filename", filename);

    const response = await this.postWithFallback(
      host,
      port,
      apiKey,
      [
        { route: "/api/v1/storage", data: formData },
        { route: "/api/files/local", data: formData },
      ],
      {
        headers: {
          ...formData.getHeaders(),
        },
      }
    );

    // Printing is started by the shared gate only after a fresh state recheck.
    return response.data;
  }

  protected async rawStartJob(host: string, port: string, apiKey: string, filename: string) {
    const response = await this.postWithFallback(host, port, apiKey, [
      {
        route: "/api/v1/job",
        data: {
          command: "start",
          file: filename,
        },
      },
      {
        route: "/api/v1/job",
        data: {
          command: "start",
          path: filename,
        },
      },
      {
        route: "/api/job",
        data: {
          command: "start",
          file: filename,
        },
      },
      {
        route: "/api/job",
        data: {
          command: "start",
          path: filename,
        },
      },
    ]);

    return response.data;
  }

  protected async rawCancelJob(host: string, port: string, apiKey: string) {
    const response = await this.postWithFallback(host, port, apiKey, [
      {
        route: "/api/v1/job",
        data: {
          command: "cancel",
        },
      },
      {
        route: "/api/job",
        data: {
          command: "cancel",
        },
      },
    ]);

    return response.data;
  }

  protected heaterComponent(component: string): HeaterComponent | undefined {
    const normalized = component.trim().toLowerCase();
    if (normalized === "bed") return { heater: "bed", raw: "bed" };
    if (normalized.startsWith("extruder") || normalized === "nozzle" || normalized === "tool0" || normalized === "tool") {
      return { heater: "nozzle", raw: "nozzle" };
    }
    return undefined;
  }

  protected async rawSetTemperature(
    host: string,
    port: string,
    apiKey: string,
    component: string,
    temperature: number
  ) {
    const normalized = component.toLowerCase();

    if (normalized === "bed") {
      const response = await this.postWithFallback(host, port, apiKey, [
        {
          route: "/api/v1/printer/temperature",
          data: {
            command: "set",
            target: { bed: temperature },
          },
        },
        {
          route: "/api/printer/bed",
          data: {
            command: "target",
            target: temperature,
          },
        },
      ]);

      return response.data;
    }

    if (normalized.startsWith("extruder") || normalized === "nozzle" || normalized === "tool0") {
      const response = await this.postWithFallback(host, port, apiKey, [
        {
          route: "/api/v1/printer/temperature",
          data: {
            command: "set",
            target: { tool0: temperature },
          },
        },
        {
          route: "/api/printer/tool",
          data: {
            command: "target",
            targets: { tool0: temperature },
          },
        },
      ]);

      return response.data;
    }

    throw new Error(`Unsupported component: ${component}`);
  }
}
