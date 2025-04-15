import { PrinterImplementation, BambuPrinterStore } from "../types.js";
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
    amsMapping?: number[];
    md5?: string;
}
export declare class BambuImplementation extends PrinterImplementation {
    private bambuPrinterStore;
    private mqttClients;
    private mqttConnectionPromises;
    constructor(apiClient: any, bambuPrinterStore: BambuPrinterStore);
    private getBambuPrinterForFTP;
    private getMqttClient;
    disconnectAllMqtt(): Promise<void>;
    getStatus(host: string, port: string, apiKey: string): Promise<any>;
    print3mf(host: string, serial: string, token: string, options: BambuPrintOptionsInternal): Promise<any>;
    cancelJob(host: string, port: string, apiKey: string): Promise<any>;
    setTemperature(host: string, port: string, apiKey: string, component: string, temperature: number): Promise<void>;
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
    private publishMqttCommand;
    private extractBambuCredentials;
}
export {};
