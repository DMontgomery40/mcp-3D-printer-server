import { isAxiosError, type AxiosRequestConfig, type AxiosResponse } from "axios";
import { PrinterImplementation } from "../types.js";
import fs from "fs";
import FormData from "form-data";

type RequestCandidate = {
  route: string;
  data?: unknown;
};

export class PrusaImplementation extends PrinterImplementation {
  private buildAuthHeaders(apiKey: string): Record<string, string> {
    return {
      "X-Api-Key": apiKey,
      Authorization: `Bearer ${apiKey}`,
    };
  }

  private buildBaseUrl(host: string, port: string): string {
    return `http://${host}:${port}`;
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

  async uploadFile(
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

    if (print) {
      await this.startJob(host, port, apiKey, filename);
    }

    return response.data;
  }

  async startJob(host: string, port: string, apiKey: string, filename: string) {
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

  async cancelJob(host: string, port: string, apiKey: string) {
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

  async setTemperature(
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
