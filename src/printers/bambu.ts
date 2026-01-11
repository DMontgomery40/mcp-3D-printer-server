import { PrinterImplementation } from "../types.js";
import { BambuPrinter } from "bambu-js"; // Use bambu-js library (supports H2D, has FTP)
import * as path from 'path';

// Define interface for print options
interface BambuPrintOptionsInternal {
    projectName: string;
    filePath: string; // Path to the local .3mf file
    filename?: string; // Target filename on printer
    plateGcode?: string; // e.g., "Metadata/plate_1.gcode"
    useAMS?: boolean;
    plateIndex?: number;
    bedLeveling?: boolean;
    flowCalibration?: boolean;
    vibrationCalibration?: boolean;
    layerInspect?: boolean;
    timelapse?: boolean;
    bedType?: string;
    amsMapping?: { [originalFilamentIndex: string]: number };
    md5Hash?: string; // MD5 hash of the gcode file
}

// Store for bambu-js printer instances
class BambuClientStore {
    private printers: Map<string, BambuPrinter> = new Map();
    private initialConnectionPromises: Map<string, Promise<void>> = new Map();

    async getPrinter(host: string, serial: string, token: string): Promise<BambuPrinter> {
        const key = `${host}-${serial}`;

        // If already connected/connecting, return existing instance or wait for connection
        if (this.printers.has(key)) {
            console.error(`Returning existing BambuPrinter instance for ${key}`);
            return this.printers.get(key)!;
        }
        if (this.initialConnectionPromises.has(key)) {
            console.error(`Waiting for existing initial connection attempt for ${key}...`);
            await this.initialConnectionPromises.get(key);
            if (this.printers.has(key)) {
                return this.printers.get(key)!;
            } else {
                throw new Error(`Existing initial connection attempt for ${key} failed or timed out.`);
            }
        }

        // Create new instance with bambu-js (positional args: host, serial, accessCode)
        console.error(`Creating new BambuPrinter instance for ${key}`);
        const printer = new BambuPrinter(host, serial, token);

        // Setup event listeners for state management (bambu-js uses simpler event names)
        printer.on('connect', () => {
            console.error(`BambuPrinter connected for ${key}`);
            this.printers.set(key, printer);
            this.initialConnectionPromises.delete(key);
        });
        printer.on('error', (err: Error) => {
            console.error(`BambuPrinter connection error for ${key}:`, err);
            this.printers.delete(key);
            this.initialConnectionPromises.delete(key);
        });
        printer.on('disconnect', () => {
            console.error(`BambuPrinter connection closed for ${key}`);
            this.printers.delete(key);
            this.initialConnectionPromises.delete(key);
        });
        printer.on('update', (state) => {
            // Optional: log or update internal state based on data
            // console.error(`BambuPrinter state update for ${key}`);
        });

        // Store promise and initiate connection
        console.error(`Attempting initial connection for BambuPrinter ${key}...`);
        const connectPromise = printer.connect().then(() => {});
        this.initialConnectionPromises.set(key, connectPromise);

        try {
            await connectPromise;
            console.error(`Initial connection successful for ${key}.`);
            return printer;
        } catch (err) {
            console.error(`Initial connection failed for ${key}:`, err);
            this.initialConnectionPromises.delete(key);
            throw err;
        }
    }

    async disconnectAll(): Promise<void> {
        console.error("Disconnecting all BambuPrinter instances...");
        const disconnectPromises: Promise<void>[] = [];
        for (const [key, printer] of this.printers.entries()) {
            disconnectPromises.push(
                printer.disconnect()
                    .then(() => console.error(`Disconnected ${key}`))
                    .catch(err => console.error(`Error disconnecting ${key}:`, err))
            );
        }
        await Promise.allSettled(disconnectPromises);
        this.printers.clear();
        this.initialConnectionPromises.clear();
    }
}

export class BambuImplementation extends PrinterImplementation {
    private printerStore: BambuClientStore;

    constructor(apiClient: any /* Not used */) {
        super(apiClient);
        this.printerStore = new BambuClientStore();
    }

    // Helper to get connected printer instance
    private async getPrinter(host: string, serial: string, token: string): Promise<BambuPrinter> {
        return this.printerStore.getPrinter(host, serial, token);
    }

    // --- getStatus ---
    async getStatus(host: string, port: string, apiKey: string): Promise<any> {
        const [serial, token] = this.extractBambuCredentials(apiKey);
        try {
            const printer = await this.getPrinter(host, serial, token);

            // Wait a moment for status data to populate if needed
            const rawState = printer.getRawState();
            if (!rawState || Object.keys(rawState).length <= 1) { // Only timestamp
                console.error("Waiting for initial state data...");
                await printer.awaitInitialState(5000).catch(() => {
                    console.error("Timeout waiting for initial state, using available data");
                });
            }

            const data = printer.getRawState() as any;

            return {
                status: data.gcode_state || "UNKNOWN",
                connected: printer.isConnected,
                temperatures: {
                    nozzle: {
                        actual: data.nozzle_temper || 0,
                        target: data.nozzle_target_temper || 0
                    },
                    bed: {
                        actual: data.bed_temper || 0,
                        target: data.bed_target_temper || 0
                    },
                    chamber: data.chamber_temper || data.frame_temper || 0
                },
                print: {
                    filename: data.subtask_name || "None",
                    progress: data.mc_percent || 0,
                    timeRemaining: data.mc_remaining_time || 0,
                    currentLayer: data.layer_num || 0,
                    totalLayers: data.total_layer_num || 0
                },
                ams: data.ams || null,
                model: data.model || "Unknown",
                raw: data // Include raw data for debugging
            };
        } catch (error) {
            console.error(`Failed to get BambuPrinter status for ${serial}:`, error);
            return { status: "error", connected: false, error: (error as Error).message };
        }
    }

    // --- print3mf --- NOW SUPPORTED with bambu-js!
    async print3mf(host: string, serial: string, token: string, options: BambuPrintOptionsInternal): Promise<any> {
        console.error(`Starting print3mf for ${options.projectName}...`);
        const printer = await this.getPrinter(host, serial, token);

        const targetFilename = options.filename || path.basename(options.filePath);
        const sdcardPath = `/sdcard/${targetFilename}`;

        try {
            // Upload file via FTP
            console.error(`Uploading ${options.filePath} to ${sdcardPath}...`);
            await printer.manipulateFiles(async (ftp) => {
                await ftp.sendFile(options.filePath, sdcardPath, (progress: number) => {
                    console.error(`Upload progress: ${progress}%`);
                });
            });
            console.error("File upload complete.");

            // Start print using printProjectFile
            const plateGcode = options.plateGcode || "Metadata/plate_1.gcode";
            const md5Hash = options.md5Hash || "00000000000000000000000000000000"; // Placeholder if not provided

            console.error(`Starting print: ${targetFilename}, plate: ${plateGcode}`);
            printer.printProjectFile(
                targetFilename,
                plateGcode,
                options.projectName,
                md5Hash,
                {
                    flowCalibration: options.flowCalibration ?? true,
                    layerInspect: options.layerInspect ?? true,
                    timelaspe: options.timelapse ?? false, // Note: bambu-js has typo in property name
                    vibrationCalibration: options.vibrationCalibration ?? true,
                    bedLeveling: options.bedLeveling ?? true,
                    bedType: options.bedType ?? "textured_plate"
                }
            );

            return {
                status: "success",
                message: `Print started: ${options.projectName}`,
                file: targetFilename
            };
        } catch (error) {
            console.error(`print3mf error:`, error);
            throw new Error(`Failed to print 3mf: ${(error as Error).message}`);
        }
    }

    // --- cancelJob ---
    async cancelJob(host: string, port: string, apiKey: string): Promise<any> {
        const [serial, token] = this.extractBambuCredentials(apiKey);
        const printer = await this.getPrinter(host, serial, token);

        console.error(`Attempting to cancel print via bambu-js...`);
        try {
            // bambu-js uses direct method calls (synchronous)
            printer.stop();
            console.error(`Cancel print command sent via bambu-js.`);
            return { status: "success", message: "Cancel command sent successfully." };
        } catch (cancelError) {
            console.error(`Error sending cancel command via bambu-js:`, cancelError);
            throw new Error(`Failed to cancel print: ${(cancelError as Error).message}`);
        }
    }

    // --- setTemperature --- (bambu-js doesn't have built-in temp control)
    async setTemperature(host: string, port: string, apiKey: string, component: string, temperature: number) {
        console.error("setTemperature is not directly supported by bambu-js library.");
        throw new Error("setTemperature is not supported. Consider using printer's built-in controls.");
    }

    // --- getFiles --- NOW SUPPORTED with bambu-js FTP!
    async getFiles(host: string, port: string, apiKey: string) {
        const [serial, token] = this.extractBambuCredentials(apiKey);
        console.error("Fetching file list via bambu-js FTP...");

        try {
            const printer = await this.getPrinter(host, serial, token);
            let files: any[] = [];

            await printer.manipulateFiles(async (ftp) => {
                // List files in the root sdcard directory
                files = await ftp.readDir("/sdcard");
            });

            console.error(`Found ${files.length} files/folders`);
            return { files };
        } catch (error) {
            console.error("Error listing files:", error);
            return { files: [], error: (error as Error).message };
        }
    }

    // --- getFile --- (Limited support - can check if file exists)
    async getFile(host: string, port: string, apiKey: string, filename: string) {
        const [serial, token] = this.extractBambuCredentials(apiKey);
        console.error(`Checking for file: ${filename}`);

        try {
            const printer = await this.getPrinter(host, serial, token);
            let found = false;
            let fileInfo: any = null;

            await printer.manipulateFiles(async (ftp) => {
                const dirPath = path.dirname(filename) || "/sdcard";
                const baseName = path.basename(filename);
                const files = await ftp.readDir(dirPath);
                fileInfo = files.find((f: any) => f.name === baseName);
                found = !!fileInfo;
            });

            return {
                name: filename,
                exists: found,
                info: fileInfo
            };
        } catch (error) {
            console.error("Error getting file:", error);
            return { name: filename, exists: false, error: (error as Error).message };
        }
    }

    // --- uploadFile --- NOW SUPPORTED with bambu-js FTP!
    async uploadFile(host: string, port: string, apiKey: string, filePath: string, filename: string, print: boolean) {
        const [serial, token] = this.extractBambuCredentials(apiKey);
        console.error(`Uploading file: ${filePath} -> ${filename}`);

        try {
            const printer = await this.getPrinter(host, serial, token);
            const targetPath = `/sdcard/${filename}`;

            await printer.manipulateFiles(async (ftp) => {
                await ftp.sendFile(filePath, targetPath, (progress: number) => {
                    console.error(`Upload progress: ${progress}%`);
                });
            });

            console.error("Upload complete.");

            if (print) {
                // If print requested, use print3mf
                await this.print3mf(host, serial, token, {
                    filePath,
                    filename,
                    projectName: path.basename(filename, path.extname(filename))
                });
                return { status: "success", message: "File uploaded and print started." };
            }

            return { status: "success", message: "File uploaded successfully." };
        } catch (error) {
            console.error("Upload error:", error);
            throw new Error(`Failed to upload file: ${(error as Error).message}`);
        }
    }

    // --- startJob --- (Use print3mf for Bambu printers)
    async startJob(host: string, port: string, apiKey: string, filename: string) {
        console.error("startJob: Using print3mf workflow for Bambu printers");
        const [serial, token] = this.extractBambuCredentials(apiKey);

        // For files already on the printer, we need the MD5 hash
        // This is a simplified version - ideally we'd compute/retrieve the hash
        const printer = await this.getPrinter(host, serial, token);

        printer.printProjectFile(
            filename,
            "Metadata/plate_1.gcode",
            path.basename(filename, path.extname(filename)),
            "00000000000000000000000000000000", // Placeholder hash
            {}
        );

        return { status: "success", message: `Print started for ${filename}` };
    }

    // --- Helper to extract Bambu credentials ---
    private extractBambuCredentials(apiKey: string): [string, string] {
        const parts = apiKey.split(':');
        if (parts.length !== 2) {
            throw new Error("Invalid Bambu credentials format. Expected 'serial:token'");
        }
        return [parts[0], parts[1]];
    }

    // Method required by PrinterFactory, disconnects managed printers
    async disconnectAll(): Promise<void> {
        await this.printerStore.disconnectAll();
    }
}
