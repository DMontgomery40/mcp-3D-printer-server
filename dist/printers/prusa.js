import { PrinterImplementation } from "../types.js";
import fs from "fs";
import FormData from "form-data";
export class PrusaImplementation extends PrinterImplementation {
    async getStatus(host, port, apiKey) {
        const url = `http://${host}:${port}/api/v1/printer`;
        const response = await this.apiClient.get(url, {
            headers: {
                "X-Api-Key": apiKey
            }
        });
        return response.data;
    }
    async getFiles(host, port, apiKey) {
        const url = `http://${host}:${port}/api/v1/storage`;
        const response = await this.apiClient.get(url, {
            headers: {
                "X-Api-Key": apiKey
            }
        });
        return response.data;
    }
    async getFile(host, port, apiKey, filename) {
        const url = `http://${host}:${port}/api/v1/storage/${encodeURIComponent(filename)}`;
        const response = await this.apiClient.get(url, {
            headers: {
                "X-Api-Key": apiKey
            }
        });
        return response.data;
    }
    async uploadFile(host, port, apiKey, filePath, filename, print) {
        const url = `http://${host}:${port}/api/v1/storage`;
        const formData = new FormData();
        formData.append("file", fs.createReadStream(filePath));
        formData.append("filename", filename);
        const response = await this.apiClient.post(url, formData, {
            headers: {
                "X-Api-Key": apiKey,
                ...formData.getHeaders()
            }
        });
        if (print && response.data.success) {
            await this.startJob(host, port, apiKey, filename);
        }
        return response.data;
    }
    async startJob(host, port, apiKey, filename) {
        const url = `http://${host}:${port}/api/v1/job`;
        const response = await this.apiClient.post(url, {
            command: "start",
            file: filename
        }, {
            headers: {
                "X-Api-Key": apiKey,
                "Content-Type": "application/json"
            }
        });
        return response.data;
    }
    async cancelJob(host, port, apiKey) {
        const url = `http://${host}:${port}/api/v1/job`;
        const response = await this.apiClient.post(url, {
            command: "cancel"
        }, {
            headers: {
                "X-Api-Key": apiKey,
                "Content-Type": "application/json"
            }
        });
        return response.data;
    }
    async setTemperature(host, port, apiKey, component, temperature) {
        const url = `http://${host}:${port}/api/v1/printer/temperature`;
        let data = { command: "set" };
        if (component === "bed") {
            data.target = { bed: temperature };
        }
        else if (component.startsWith("extruder")) {
            data.target = { tool0: temperature }; // Prusa typically uses tool0 for the extruder
        }
        else {
            throw new Error(`Unsupported component: ${component}`);
        }
        const response = await this.apiClient.post(url, data, {
            headers: {
                "X-Api-Key": apiKey,
                "Content-Type": "application/json"
            }
        });
        return response.data;
    }
}
