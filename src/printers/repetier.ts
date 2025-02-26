import { PrinterImplementation } from "../types.js";
import fs from "fs";
import FormData from "form-data";

export class RepetierImplementation extends PrinterImplementation {
  async getStatus(host: string, port: string, apiKey: string) {
    const url = `http://${host}:${port}/printer/api/?a=getPrinterInfo&apikey=${apiKey}`;
    const response = await this.apiClient.get(url);
    return response.data;
  }
  
  async getFiles(host: string, port: string, apiKey: string) {
    const url = `http://${host}:${port}/printer/api/?a=ls&apikey=${apiKey}`;
    const response = await this.apiClient.get(url);
    return response.data;
  }
  
  async getFile(host: string, port: string, apiKey: string, filename: string) {
    const url = `http://${host}:${port}/printer/api/?a=getFileInfo&apikey=${apiKey}&filename=${encodeURIComponent(filename)}`;
    const response = await this.apiClient.get(url);
    return response.data;
  }
  
  async uploadFile(host: string, port: string, apiKey: string, filePath: string, filename: string, print: boolean) {
    const url = `http://${host}:${port}/printer/api/`;
    
    const formData = new FormData();
    formData.append("a", "upload");
    formData.append("apikey", apiKey);
    formData.append("filename", filename);
    formData.append("print", print ? "1" : "0");
    formData.append("file", fs.createReadStream(filePath));
    
    const response = await this.apiClient.post(url, formData as any, {
      headers: {
        ...formData.getHeaders()
      }
    });
    
    return response.data;
  }
  
  async startJob(host: string, port: string, apiKey: string, filename: string) {
    const url = `http://${host}:${port}/printer/api/?a=startJob&apikey=${apiKey}&filename=${encodeURIComponent(filename)}`;
    const response = await this.apiClient.get(url);
    return response.data;
  }
  
  async cancelJob(host: string, port: string, apiKey: string) {
    const url = `http://${host}:${port}/printer/api/?a=stopJob&apikey=${apiKey}`;
    const response = await this.apiClient.get(url);
    return response.data;
  }
  
  async setTemperature(host: string, port: string, apiKey: string, component: string, temperature: number) {
    let url;
    if (component === "bed") {
      url = `http://${host}:${port}/printer/api/?a=setBedTemp&apikey=${apiKey}&temp=${temperature}`;
    } else if (component === "extruder") {
      url = `http://${host}:${port}/printer/api/?a=setExtruderTemp&apikey=${apiKey}&temp=${temperature}`;
    } else {
      throw new Error(`Unsupported component: ${component}`);
    }
    
    const response = await this.apiClient.get(url);
    return response.data;
  }
} 