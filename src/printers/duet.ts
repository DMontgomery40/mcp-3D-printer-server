import { PrinterImplementation } from "../types.js";
import fs from "fs";
import FormData from "form-data";

export class DuetImplementation extends PrinterImplementation {
  async getStatus(host: string, port: string, apiKey: string) {
    const url = `http://${host}:${port}/machine/status`;
    const response = await this.apiClient.get(url);
    return response.data;
  }
  
  async getFiles(host: string, port: string, apiKey: string) {
    const url = `http://${host}:${port}/machine/file-list`;
    const response = await this.apiClient.get(url);
    return response.data;
  }
  
  async getFile(host: string, port: string, apiKey: string, filename: string) {
    const url = `http://${host}:${port}/machine/file/${encodeURIComponent(filename)}`;
    const response = await this.apiClient.get(url);
    return response.data;
  }
  
  async uploadFile(host: string, port: string, apiKey: string, filePath: string, filename: string, print: boolean) {
    const url = `http://${host}:${port}/machine/file-upload`;
    
    const formData = new FormData();
    formData.append("file", fs.createReadStream(filePath));
    formData.append("filename", filename);
    
    const response = await this.apiClient.post(url, formData as any, {
      headers: {
        ...formData.getHeaders()
      }
    });
    
    if (print && response.data.err === 0) {
      await this.startJob(host, port, apiKey, filename);
    }
    
    return response.data;
  }
  
  async startJob(host: string, port: string, apiKey: string, filename: string) {
    const url = `http://${host}:${port}/machine/code`;
    
    const response = await this.apiClient.post(url, {
      code: `M32 "${filename}"`
    } as any);
    
    return response.data;
  }
  
  async cancelJob(host: string, port: string, apiKey: string) {
    const url = `http://${host}:${port}/machine/code`;
    
    const response = await this.apiClient.post(url, {
      code: "M0"
    } as any);
    
    return response.data;
  }
  
  async setTemperature(host: string, port: string, apiKey: string, component: string, temperature: number) {
    const url = `http://${host}:${port}/machine/code`;
    
    let gcode;
    if (component === "bed") {
      gcode = `M140 S${temperature}`;
    } else if (component === "extruder") {
      gcode = `M104 S${temperature}`;
    } else {
      throw new Error(`Unsupported component: ${component}`);
    }
    
    const response = await this.apiClient.post(url, {
      code: gcode
    } as any);
    
    return response.data;
  }
} 