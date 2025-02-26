import { PrinterImplementation, BambuPrinterStore } from "../types.js";
export declare class BambuImplementation extends PrinterImplementation {
    private bambuPrinterStore;
    constructor(apiClient: any, bambuPrinterStore: BambuPrinterStore);
    private getBambuPrinter;
    getStatus(host: string, port: string, apiKey: string): Promise<import("bambu-js").PrinterState>;
    getFiles(host: string, port: string, apiKey: string): Promise<{
        files: string[];
    }>;
    getFile(host: string, port: string, apiKey: string, filename: string): Promise<{
        name: string;
        exists: boolean;
    }>;
    uploadFile(host: string, port: string, apiKey: string, filePath: string, filename: string, print: boolean): Promise<{
        status: string;
        message: string;
    }>;
    startJob(host: string, port: string, apiKey: string, filename: string): Promise<void>;
    cancelJob(host: string, port: string, apiKey: string): Promise<{
        status: string;
        message: string;
    }>;
    setTemperature(host: string, port: string, apiKey: string, component: string, temperature: number): Promise<void>;
    private extractBambuCredentials;
}
