import { PrinterImplementation } from "../types.js";
import fs from "fs";
import FormData from "form-data";

export class PrusaImplementation extends PrinterImplementation {
  async getStatus(host: string, port: string, apiKey: string) {
    const url = `http://${host}:${port}/api/v1/printer`;
    const response = await this.apiClient.get(url, {
      headers: {
        "X-Api-Key": apiKey
      }
    });
    return response.data;
  }

  async getFiles(host: string, port: string, apiKey: string) {
    const url = `http://${host}:${port}/api/v1/storage`;
    const response = await this.apiClient.get(url, {
      headers: {
        "X-Api-Key": apiKey
      }
    });
    return response.data;
  }

  async getFile(host: string, port: string, apiKey: string, filename: string) {
    const url = `http://${host}:${port}/api/v1/storage/${encodeURIComponent(filename)}`;
    const response = await this.apiClient.get(url, {
      headers: {
        "X-Api-Key": apiKey
      }
    });
    return response.data;
  }

  async uploadFile(host: string, port: string, apiKey: string, filePath: string, filename: string, print: boolean) {
    const url = `http://${host}:${port}/api/v1/storage`;
    
    const formData = new FormData();
    formData.append("file", fs.createReadStream(filePath));
    formData.append("filename", filename);
    
    const response = await this.apiClient.post(url, formData as any, {
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

  async startJob(host: string, port: string, apiKey: string, filename: string) {
    const url = `http://${host}:${port}/api/v1/job`;
    
    const response = await this.apiClient.post(url, {
      command: "start",
      file: filename
    } as any, {
      headers: {
        "X-Api-Key": apiKey,
        "Content-Type": "application/json"
      }
    });
    
    return response.data;
  }

  async cancelJob(host: string, port: string, apiKey: string) {
    const url = `http://${host}:${port}/api/v1/job`;
    
    const response = await this.apiClient.post(url, {
      command: "cancel"
    } as any, {
      headers: {
        "X-Api-Key": apiKey,
        "Content-Type": "application/json"
      }
    });
    
    return response.data;
  }

  async setTemperature(host: string, port: string, apiKey: string, component: string, temperature: number) {
    const url = `http://${host}:${port}/api/v1/printer/temperature`;
    
    let data: Record<string, any> = { command: "set" };
    if (component === "bed") {
      data.target = { bed: temperature };
    } else if (component.startsWith("extruder")) {
      data.target = { tool0: temperature }; // Prusa typically uses tool0 for the extruder
    } else {
      throw new Error(`Unsupported component: ${component}`);
    }
    
    const response = await this.apiClient.post(url, data as any, {
      headers: {
        "X-Api-Key": apiKey,
        "Content-Type": "application/json"
      }
    });
    
    return response.data;
  }
} 