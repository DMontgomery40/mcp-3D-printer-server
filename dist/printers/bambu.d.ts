import { PrinterImplementation } from "../types.js";
interface BambuPrintOptionsInternal {
    projectName: string;
    filePath: string;
    useAMS?: boolean;
    plateIndex?: number;
    bedLeveling?: boolean;
    flowCalibration?: boolean;
    vibrationCalibration?: boolean;
    layerInspect?: boolean;
    timelapse?: boolean;
    amsMapping?: {
        [originalFilamentIndex: string]: number;
    };
    md5?: string;
}
export declare class BambuImplementation extends PrinterImplementation {
    private printerStore;
    constructor(apiClient: any);
    private getPrinter;
    getStatus(host: string, port: string, apiKey: string): Promise<any>;
    print3mf(host: string, serial: string, token: string, options: BambuPrintOptionsInternal): Promise<any>;
    cancelJob(host: string, port: string, apiKey: string): Promise<any>;
    setTemperature(host: string, port: string, apiKey: string, component: string, temperature: number): Promise<void>;
    getFiles(host: string, port: string, apiKey: string): Promise<{
        files: never[];
        note: string;
    }>;
    getFile(host: string, port: string, apiKey: string, filename: string): Promise<{
        name: string;
        exists: boolean;
        note: string;
    }>;
    uploadFile(host: string, port: string, apiKey: string, filePath: string, filename: string, print: boolean): Promise<void>;
    startJob(host: string, port: string, apiKey: string, filename: string): Promise<void>;
    private extractBambuCredentials;
    disconnectAll(): Promise<void>;
}
export {};
