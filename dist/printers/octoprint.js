import { PrinterImplementation } from "../types.js";
import fs from "fs";
import FormData from "form-data";
export class OctoPrintImplementation extends PrinterImplementation {
    async getStatus(host, port, apiKey) {
        const url = `http://${host}:${port}/api/printer`;
        const response = await this.apiClient.get(url, {
            headers: {
                "X-Api-Key": apiKey
            }
        });
        return response.data;
    }
    async getFiles(host, port, apiKey) {
        const url = `http://${host}:${port}/api/files`;
        const response = await this.apiClient.get(url, {
            headers: {
                "X-Api-Key": apiKey
            }
        });
        return response.data;
    }
    async getFile(host, port, apiKey, filename) {
        const url = `http://${host}:${port}/api/files/local/${filename}`;
        const response = await this.apiClient.get(url, {
            headers: {
                "X-Api-Key": apiKey
            }
        });
        return response.data;
    }
    async uploadFile(host, port, apiKey, filePath, filename, print) {
        const url = `http://${host}:${port}/api/files/local`;
        const formData = new FormData();
        formData.append("file", fs.createReadStream(filePath));
        formData.append("filename", filename);
        if (print) {
            formData.append("print", "true");
        }
        const response = await this.apiClient.post(url, formData, {
            headers: {
                "X-Api-Key": apiKey,
                ...formData.getHeaders()
            }
        });
        return response.data;
    }
    async startJob(host, port, apiKey, filename) {
        const url = `http://${host}:${port}/api/files/local/${filename}`;
        const response = await this.apiClient.post(url, {
            command: "select",
            print: true
        }, {
            headers: {
                "X-Api-Key": apiKey,
                "Content-Type": "application/json"
            }
        });
        return response.data;
    }
    async cancelJob(host, port, apiKey) {
        const url = `http://${host}:${port}/api/job`;
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
        let url = `http://${host}:${port}/api/printer/tool`;
        const data = {};
        if (component === "bed") {
            data.command = "target";
            data.target = temperature;
            url = `http://${host}:${port}/api/printer/bed`;
        }
        else if (component.startsWith("extruder")) {
            data.command = "target";
            data.targets = {};
            data.targets[component] = temperature;
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
