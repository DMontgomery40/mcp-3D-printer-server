import { AxiosInstance } from "axios";

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



export interface SectionBounds {
    minX: number; minY: number; minZ: number;
    maxX: number; maxY: number; maxZ: number;
}

// New types for 3MF support
export interface ThreeMFMetadata {
    // Basic metadata often found in 3dmodel.model
    [key: string]: string; // Example: unit, title, etc.
}

export interface ThreeMFObject {
    id: string;
    name?: string;
    type?: string; // e.g., model, support, modifier
    mesh?: any; // Placeholder for parsed mesh data if needed later
    // Add other relevant object properties
}

export interface ThreeMFBuildItem {
    objectId: string;
    transform?: string; // Matrix transform
    // Add other relevant build item properties
}

export interface AMSFilamentMapping {
    [filamentId: string]: number; // e.g., { "PLA_1": 0, "SUPPORT_W": 3 } maps filament ID to AMS slot (0-indexed)
}

// Represents the Bambu-specific slicer settings often found in a separate config file within the 3MF
export interface BambuSlicerConfig {
    // Common slicing parameters (add more as needed)
    layer_height?: number;
    first_layer_height?: number;
    sparse_infill_density?: number; // Percentage
    sparse_infill_pattern?: string;
    support_enabled?: boolean;
    support_type?: string; // e.g., 'normal', 'tree'
    support_threshold_angle?: number;
    raft_layers?: number;
    brim_width?: number;
    wall_loops?: number;
    top_shell_layers?: number;
    bottom_shell_layers?: number;
    // Temperatures and filament settings
    nozzle_temperature?: number[]; // Array for multiple extruders/tools if applicable
    bed_temperature?: number;
    filament_type?: string[]; // Array of filament types used
    flow_ratio?: number[]; // Array of flow ratios
    ams_mapping?: AMSFilamentMapping; // Mapping of filament profiles to AMS slots
    // Add other relevant Bambu settings: speeds, cooling, etc.
    [key: string]: any; // Allow for arbitrary key-value pairs found in the config
}

// Main structure for parsed 3MF data
export interface ThreeMFData {
    metadata: ThreeMFMetadata;
    objects: ThreeMFObject[];
    build: { items: ThreeMFBuildItem[] }; // Structure might vary based on 3dmodel.model parsing
    slicerConfig?: Partial<BambuSlicerConfig>; // Slicer-specific settings (optional, may not be present)
    // Raw XML data if needed for debugging or complex scenarios?
    // rawModelXml?: any;
    // rawSlicerConfig?: string;
} 