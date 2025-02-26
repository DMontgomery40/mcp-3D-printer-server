import { AxiosInstance } from "axios";
import { BambuPrinter } from "bambu-js";
export type BambuFTP = {
    readDir: (path: string) => Promise<string[]>;
    sendFile: (sourcePath: string, destinationPath: string, progressCallback?: (progress: number) => void) => Promise<void>;
    removeFile: (path: string) => Promise<void>;
};
export declare abstract class PrinterImplementation {
    protected apiClient: AxiosInstance;
    constructor(apiClient: AxiosInstance);
    abstract getStatus(host: string, port: string, apiKey: string): Promise<any>;
    abstract getFiles(host: string, port: string, apiKey: string): Promise<any>;
    abstract getFile(host: string, port: string, apiKey: string, filename: string): Promise<any>;
    abstract uploadFile(host: string, port: string, apiKey: string, filePath: string, filename: string, print: boolean): Promise<any>;
    abstract startJob(host: string, port: string, apiKey: string, filename: string): Promise<any>;
    abstract cancelJob(host: string, port: string, apiKey: string): Promise<any>;
    abstract setTemperature(host: string, port: string, apiKey: string, component: string, temperature: number): Promise<any>;
}
export declare class BambuPrinterStore {
    private printers;
    get(host: string, serial: string, token: string): InstanceType<typeof BambuPrinter>;
    disconnectAll(): Promise<void>;
}
