import { isAxiosError } from "axios";
import { PrinterImplementation } from "../types.js";
import fs from "fs";
import FormData from "form-data";
export class PrusaImplementation extends PrinterImplementation {
    buildAuthHeaders(apiKey) {
        return {
            "X-Api-Key": apiKey,
            Authorization: `Bearer ${apiKey}`,
        };
    }
    buildBaseUrl(host, port) {
        return `http://${host}:${port}`;
    }
    isFallbackStatus(error) {
        if (!isAxiosError(error)) {
            return false;
        }
        const status = error.response?.status;
        return status === 404 || status === 405 || status === 501;
    }
    async getWithFallback(host, port, apiKey, routes) {
        const baseUrl = this.buildBaseUrl(host, port);
        let lastError;
        for (const route of routes) {
            try {
                return await this.apiClient.get(`${baseUrl}${route}`, {
                    headers: this.buildAuthHeaders(apiKey),
                });
            }
            catch (error) {
                lastError = error;
                if (!this.isFallbackStatus(error)) {
                    throw error;
                }
            }
        }
        throw lastError ?? new Error("No compatible Prusa GET endpoint found.");
    }
    async postWithFallback(host, port, apiKey, candidates, config) {
        const baseUrl = this.buildBaseUrl(host, port);
        let lastError;
        for (const candidate of candidates) {
            try {
                return await this.apiClient.post(`${baseUrl}${candidate.route}`, candidate.data, {
                    ...(config ?? {}),
                    headers: {
                        ...this.buildAuthHeaders(apiKey),
                        ...(config?.headers ?? {}),
                    },
                });
            }
            catch (error) {
                lastError = error;
                if (!this.isFallbackStatus(error)) {
                    throw error;
                }
            }
        }
        throw lastError ?? new Error("No compatible Prusa POST endpoint found.");
    }
    async getStatus(host, port, apiKey) {
        const response = await this.getWithFallback(host, port, apiKey, [
            "/api/v1/printer",
            "/api/printer",
        ]);
        return response.data;
    }
    async getFiles(host, port, apiKey) {
        const response = await this.getWithFallback(host, port, apiKey, [
            "/api/v1/storage",
            "/api/files",
            "/api/files/local",
        ]);
        return response.data;
    }
    async getFile(host, port, apiKey, filename) {
        const encodedFile = encodeURIComponent(filename);
        const response = await this.getWithFallback(host, port, apiKey, [
            `/api/v1/storage/${encodedFile}`,
            `/api/files/local/${encodedFile}`,
        ]);
        return response.data;
    }
    async uploadFile(host, port, apiKey, filePath, filename, print) {
        const formData = new FormData();
        formData.append("file", fs.createReadStream(filePath));
        formData.append("filename", filename);
        const response = await this.postWithFallback(host, port, apiKey, [
            { route: "/api/v1/storage", data: formData },
            { route: "/api/files/local", data: formData },
        ], {
            headers: {
                ...formData.getHeaders(),
            },
        });
        if (print) {
            await this.startJob(host, port, apiKey, filename);
        }
        return response.data;
    }
    async startJob(host, port, apiKey, filename) {
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
    async cancelJob(host, port, apiKey) {
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
    async setTemperature(host, port, apiKey, component, temperature) {
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
