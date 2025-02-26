import { PrinterImplementation } from "../types.js";
import fs from "fs";
import FormData from "form-data";
export class KlipperImplementation extends PrinterImplementation {
    async getStatus(host, port, apiKey) {
        const url = `http://${host}:${port}/printer/info`;
        const response = await this.apiClient.get(url);
        return response.data;
    }
    async getFiles(host, port, apiKey) {
        const url = `http://${host}:${port}/server/files/list`;
        const response = await this.apiClient.get(url);
        return response.data;
    }
    async getFile(host, port, apiKey, filename) {
        const url = `http://${host}:${port}/server/files/metadata?filename=${encodeURIComponent(filename)}`;
        const response = await this.apiClient.get(url);
        return response.data;
    }
    async uploadFile(host, port, apiKey, filePath, filename, print) {
        const url = `http://${host}:${port}/server/files/upload`;
        const formData = new FormData();
        formData.append("file", fs.createReadStream(filePath));
        formData.append("filename", filename);
        const response = await this.apiClient.post(url, formData, {
            headers: {
                ...formData.getHeaders()
            }
        });
        if (print && response.data.result === "success") {
            await this.startJob(host, port, apiKey, filename);
        }
        return response.data;
    }
    async startJob(host, port, apiKey, filename) {
        const url = `http://${host}:${port}/printer/print/start`;
        const response = await this.apiClient.post(url, { filename });
        return response.data;
    }
    async cancelJob(host, port, apiKey) {
        const url = `http://${host}:${port}/printer/print/cancel`;
        const response = await this.apiClient.post(url, null);
        return response.data;
    }
    async setTemperature(host, port, apiKey, component, temperature) {
        const url = `http://${host}:${port}/printer/gcode/script`;
        let gcode;
        if (component === "bed") {
            gcode = `SET_HEATER_TEMPERATURE HEATER=heater_bed TARGET=${temperature}`;
        }
        else if (component === "extruder") {
            gcode = `SET_HEATER_TEMPERATURE HEATER=extruder TARGET=${temperature}`;
        }
        else {
            throw new Error(`Unsupported component: ${component}`);
        }
        const response = await this.apiClient.post(url, {
            script: gcode
        });
        return response.data;
    }
}
