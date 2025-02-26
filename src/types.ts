import { AxiosInstance } from "axios";
import { BambuPrinter } from "bambu-js";

// Define shared types for the printer implementations
export type BambuFTP = {
  readDir: (path: string) => Promise<string[]>;
  sendFile: (sourcePath: string, destinationPath: string, progressCallback?: (progress: number) => void) => Promise<void>;
  removeFile: (path: string) => Promise<void>;
};

// Base class for printer implementations
export abstract class PrinterImplementation {
  protected apiClient: AxiosInstance;

  constructor(apiClient: AxiosInstance) {
    this.apiClient = apiClient;
  }

  abstract getStatus(host: string, port: string, apiKey: string): Promise<any>;
  abstract getFiles(host: string, port: string, apiKey: string): Promise<any>;
  abstract getFile(host: string, port: string, apiKey: string, filename: string): Promise<any>;
  abstract uploadFile(host: string, port: string, apiKey: string, filePath: string, filename: string, print: boolean): Promise<any>;
  abstract startJob(host: string, port: string, apiKey: string, filename: string): Promise<any>;
  abstract cancelJob(host: string, port: string, apiKey: string): Promise<any>;
  abstract setTemperature(host: string, port: string, apiKey: string, component: string, temperature: number): Promise<any>;
}

// Store for Bambu printers
export class BambuPrinterStore {
  private printers: Map<string, InstanceType<typeof BambuPrinter>> = new Map();

  get(host: string, serial: string, token: string): InstanceType<typeof BambuPrinter> {
    const key = `${host}-${serial}`;
    if (!this.printers.has(key)) {
      const printer = new BambuPrinter(host, serial, token);
      this.printers.set(key, printer);
    }
    return this.printers.get(key)!;
  }

  async disconnectAll(): Promise<void> {
    for (const printer of this.printers.values()) {
      await printer.disconnect();
    }
  }
} 