import { PrinterImplementation } from "../types.js";
import fs from "fs";
import FormData from "form-data";

export class KlipperImplementation extends PrinterImplementation {
  async getStatus(host: string, port: string, apiKey: string) {
    const url = `http://${host}:${port}/printer/info`;
    const response = await this.apiClient.get(url);
    return response.data;
  }

  async getFiles(host: string, port: string, apiKey: string) {
    const url = `http://${host}:${port}/server/files/list`;
    const response = await this.apiClient.get(url);
    return response.data;
  }

  async getFile(host: string, port: string, apiKey: string, filename: string) {
    const url = `http://${host}:${port}/server/files/metadata?filename=${encodeURIComponent(filename)}`;
    const response = await this.apiClient.get(url);
    return response.data;
  }

  async uploadFile(host: string, port: string, apiKey: string, filePath: string, filename: string, print: boolean) {
    const url = `http://${host}:${port}/server/files/upload`;
    
    const formData = new FormData();
    formData.append("file", fs.createReadStream(filePath));
    formData.append("filename", filename);
    
    const response = await this.apiClient.post(url, formData as any, {
      headers: {
        ...formData.getHeaders()
      }
    });
    
    if (print && response.data.result === "success") {
      await this.startJob(host, port, apiKey, filename);
    }
    
    return response.data;
  }

  async startJob(host: string, port: string, apiKey: string, filename: string) {
    const url = `http://${host}:${port}/printer/print/start`;
    
    const response = await this.apiClient.post(url, { filename } as any);
    
    return response.data;
  }

  async cancelJob(host: string, port: string, apiKey: string) {
    const url = `http://${host}:${port}/printer/print/cancel`;
    
    const response = await this.apiClient.post(url, null as any);
    
    return response.data;
  }

  async setTemperature(host: string, port: string, apiKey: string, component: string, temperature: number) {
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
    } as any);
    
    return response.data;
  }
} 