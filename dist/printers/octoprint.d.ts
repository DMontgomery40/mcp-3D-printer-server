import { PrinterImplementation } from "../types.js";
export declare class OctoPrintImplementation extends PrinterImplementation {
    getStatus(host: string, port: string, apiKey: string): Promise<any>;
    getFiles(host: string, port: string, apiKey: string): Promise<any>;
    getFile(host: string, port: string, apiKey: string, filename: string): Promise<any>;
    uploadFile(host: string, port: string, apiKey: string, filePath: string, filename: string, print: boolean): Promise<any>;
    startJob(host: string, port: string, apiKey: string, filename: string): Promise<any>;
    cancelJob(host: string, port: string, apiKey: string): Promise<any>;
    setTemperature(host: string, port: string, apiKey: string, component: string, temperature: number): Promise<any>;
}
