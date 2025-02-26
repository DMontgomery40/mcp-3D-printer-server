import { PrinterImplementation } from "../types.js";
import fs from "fs";
import FormData from "form-data";

export class CrealityImplementation extends PrinterImplementation {
  async getStatus(host: string, port: string, apiKey: string) {
    const url = `http://${host}:${port}/api/device/status`;
    const response = await this.apiClient.get(url, {
      headers: {
        "Authorization": `Bearer ${apiKey}`
      }
    });
    return response.data;
  }

  async getFiles(host: string, port: string, apiKey: string) {
    const url = `http://${host}:${port}/api/storage/list`;
    const response = await this.apiClient.get(url, {
      headers: {
        "Authorization": `Bearer ${apiKey}`
      }
    });
    return response.data;
  }

  async getFile(host: string, port: string, apiKey: string, filename: string) {
    const url = `http://${host}:${port}/api/storage/info?filename=${encodeURIComponent(filename)}`;
    const response = await this.apiClient.get(url, {
      headers: {
        "Authorization": `Bearer ${apiKey}`
      }
    });
    return response.data;
  }

  async uploadFile(host: string, port: string, apiKey: string, filePath: string, filename: string, print: boolean) {
    const url = `http://${host}:${port}/api/storage/upload`;
    
    const formData = new FormData();
    formData.append("file", fs.createReadStream(filePath));
    formData.append("filename", filename);
    
    const response = await this.apiClient.post(url, formData as any, {
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        ...formData.getHeaders()
      }
    });
    
    if (print && response.data.success) {
      await this.startJob(host, port, apiKey, filename);
    }
    
    return response.data;
  }

  async startJob(host: string, port: string, apiKey: string, filename: string) {
    const url = `http://${host}:${port}/api/job/start`;
    
    const response = await this.apiClient.post(url, {
      filename: filename
    } as any, {
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      }
    });
    
    return response.data;
  }

  async cancelJob(host: string, port: string, apiKey: string) {
    const url = `http://${host}:${port}/api/job/cancel`;
    
    const response = await this.apiClient.post(url, {} as any, {
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      }
    });
    
    return response.data;
  }

  async setTemperature(host: string, port: string, apiKey: string, component: string, temperature: number) {
    const url = `http://${host}:${port}/api/printer/temperature`;
    
    let data: Record<string, any> = {};
    if (component === "bed") {
      data.bed = temperature;
    } else if (component === "extruder") {
      data.hotend = temperature;
    } else {
      throw new Error(`Unsupported component: ${component}`);
    }
    
    const response = await this.apiClient.post(url, data as any, {
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      }
    });
    
    return response.data;
  }
} 