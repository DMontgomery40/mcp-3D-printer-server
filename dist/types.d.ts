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
export interface SectionBounds {
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
}
export interface ThreeMFMetadata {
    [key: string]: string;
}
export interface ThreeMFObject {
    id: string;
    name?: string;
    type?: string;
    mesh?: any;
}
export interface ThreeMFBuildItem {
    objectId: string;
    transform?: string;
}
export interface AMSFilamentMapping {
    [filamentId: string]: number;
}
export interface BambuSlicerConfig {
    layer_height?: number;
    first_layer_height?: number;
    sparse_infill_density?: number;
    sparse_infill_pattern?: string;
    support_enabled?: boolean;
    support_type?: string;
    support_threshold_angle?: number;
    raft_layers?: number;
    brim_width?: number;
    wall_loops?: number;
    top_shell_layers?: number;
    bottom_shell_layers?: number;
    nozzle_temperature?: number[];
    bed_temperature?: number;
    filament_type?: string[];
    flow_ratio?: number[];
    ams_mapping?: AMSFilamentMapping;
    [key: string]: any;
}
export interface ThreeMFData {
    metadata: ThreeMFMetadata;
    objects: ThreeMFObject[];
    build: {
        items: ThreeMFBuildItem[];
    };
    slicerConfig?: Partial<BambuSlicerConfig>;
}
