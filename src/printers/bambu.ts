import { PrinterImplementation } from "../types.js";
import {
    PrinterController,
    FileController,
    H2DCommands,
    type H2DReportState
} from "bambu-js";
import * as path from 'path';

// Define interface for print options
interface BambuPrintOptionsInternal {
    projectName: string;
    filePath: string;
    filename?: string;
    plateGcode?: string;
    useAMS?: boolean;
    plateIndex?: number;
    bedLeveling?: boolean;
    flowCalibration?: boolean;
    vibrationCalibration?: boolean;
    layerInspect?: boolean;
    timelapse?: boolean;
    bedType?: string;
    amsMapping?: { [originalFilamentIndex: string]: number };
    md5Hash?: string;
}

// Store for printer and file controller instances
class BambuControllerStore {
    private printers: Map<string, PrinterController<any>> = new Map();
    private fileControllers: Map<string, FileController> = new Map();
    private latestState: Map<string, any> = new Map();
    private initialConnectionPromises: Map<string, Promise<void>> = new Map();

    async getPrinter(host: string, serial: string, token: string): Promise<PrinterController<any>> {
        const key = `${host}-${serial}`;

        if (this.printers.has(key)) {
            console.error(`Returning existing PrinterController for ${key}`);
            return this.printers.get(key)!;
        }

        if (this.initialConnectionPromises.has(key)) {
            console.error(`Waiting for existing connection attempt for ${key}...`);
            await this.initialConnectionPromises.get(key);
            if (this.printers.has(key)) {
                return this.printers.get(key)!;
            }
            throw new Error(`Connection attempt for ${key} failed.`);
        }

        console.error(`Creating new PrinterController for ${key} (model: H2D)`);

        const printer = PrinterController.create({
            model: "H2D",
            host: host,
            accessCode: token,
            serial: serial,
            options: {
                connectionTimeout: 15000,
                autoReconnect: false
            }
        });

        // Store latest state from reports
        printer.on('report', (data: { print: H2DReportState }) => {
            if (data.print) {
                this.latestState.set(key, data.print);
            }
        });

        printer.on('connect', () => {
            console.error(`PrinterController connected for ${key}`);
            this.printers.set(key, printer);
            this.initialConnectionPromises.delete(key);
        });

        printer.on('error', (err: Error) => {
            console.error(`PrinterController error for ${key}:`, err.message);
        });

        printer.on('disconnect', () => {
            console.error(`PrinterController disconnected for ${key}`);
            this.printers.delete(key);
            this.latestState.delete(key);
        });

        printer.on('end', () => {
            console.error(`PrinterController connection ended for ${key}`);
            this.printers.delete(key);
            this.initialConnectionPromises.delete(key);
        });

        const connectPromise = printer.connect().then(() => {
            // Request initial state after connection
            const pushAllCmd = { pushing: { sequence_id: "0", command: "pushall" } };
            printer.sendCommand(pushAllCmd).catch((err: Error) => {
                console.error(`Failed to request initial state: ${err.message}`);
            });
        });
        this.initialConnectionPromises.set(key, connectPromise);

        try {
            await connectPromise;
            console.error(`Connection successful for ${key}`);
            return printer;
        } catch (err) {
            console.error(`Connection failed for ${key}:`, err);
            this.initialConnectionPromises.delete(key);
            throw err;
        }
    }

    async getFileController(host: string, token: string): Promise<FileController> {
        const key = `ftp-${host}`;

        if (this.fileControllers.has(key) && this.fileControllers.get(key)!.isConnected) {
            return this.fileControllers.get(key)!;
        }

        console.error(`Creating new FileController for ${host}`);
        const fileController = FileController.create({
            host: host,
            accessCode: token,
            options: { timeout: 30000 }
        });

        await fileController.connect();
        this.fileControllers.set(key, fileController);
        console.error(`FileController connected for ${host}`);
        return fileController;
    }

    getLatestState(host: string, serial: string): any {
        const key = `${host}-${serial}`;
        return this.latestState.get(key) || {};
    }

    async disconnectAll(): Promise<void> {
        console.error("Disconnecting all controllers...");

        for (const [key, printer] of this.printers.entries()) {
            try {
                await printer.disconnect();
                console.error(`Disconnected printer ${key}`);
            } catch (err) {
                console.error(`Error disconnecting printer ${key}:`, err);
            }
        }

        for (const [key, fc] of this.fileControllers.entries()) {
            try {
                await fc.disconnect();
                console.error(`Disconnected file controller ${key}`);
            } catch (err) {
                console.error(`Error disconnecting file controller ${key}:`, err);
            }
        }

        this.printers.clear();
        this.fileControllers.clear();
        this.latestState.clear();
        this.initialConnectionPromises.clear();
    }
}

export class BambuImplementation extends PrinterImplementation {
    private controllerStore: BambuControllerStore;

    constructor(apiClient: any) {
        super(apiClient);
        this.controllerStore = new BambuControllerStore();
    }

    private async getPrinter(host: string, serial: string, token: string) {
        return this.controllerStore.getPrinter(host, serial, token);
    }

    private async getFileController(host: string, token: string) {
        return this.controllerStore.getFileController(host, token);
    }

    // --- getStatus ---
    async getStatus(host: string, port: string, apiKey: string): Promise<any> {
        const [serial, token] = this.extractBambuCredentials(apiKey);
        try {
            const printer = await this.getPrinter(host, serial, token);

            // Wait for state data
            await new Promise(resolve => setTimeout(resolve, 2000));

            const data = this.controllerStore.getLatestState(host, serial);

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
                model: "H2D",
                raw: data
            };
        } catch (error) {
            console.error(`Failed to get status for ${serial}:`, error);
            return { status: "error", connected: false, error: (error as Error).message };
        }
    }

    // --- print3mf ---
    async print3mf(host: string, serial: string, token: string, options: BambuPrintOptionsInternal): Promise<any> {
        console.error(`Starting print3mf for ${options.projectName}...`);

        const printer = await this.getPrinter(host, serial, token);
        const fileController = await this.getFileController(host, token);

        const targetFilename = options.filename || path.basename(options.filePath);
        const remotePath = `/${targetFilename}`;

        try {
            // Upload file via FTP
            console.error(`Uploading ${options.filePath} to ${remotePath}...`);
            await fileController.uploadFile(options.filePath, remotePath);
            console.error("Upload complete.");

            // Start print using H2D command
            const plateGcode = options.plateGcode || "Metadata/plate_1.gcode";
            const md5Hash = options.md5Hash || "00000000000000000000000000000000";

            console.error(`Starting print: ${targetFilename}`);
            const printCommand = H2DCommands.printProjectCommand(
                targetFilename,
                plateGcode,
                options.projectName,
                md5Hash,
                {
                    flowCalibration: options.flowCalibration ?? true,
                    layerInspect: options.layerInspect ?? true,
                    timelapse: options.timelapse ?? false,
                    vibrationCalibration: options.vibrationCalibration ?? true,
                    bedLeveling: options.bedLeveling ?? true,
                    bedType: options.bedType ?? "textured_plate"
                }
            );

            await printer.sendCommand(printCommand);

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

        console.error(`Cancelling print...`);
        try {
            const stopCommand = H2DCommands.stopCommand();
            await printer.sendCommand(stopCommand);
            console.error(`Cancel command sent.`);
            return { status: "success", message: "Cancel command sent." };
        } catch (error) {
            console.error(`Error cancelling:`, error);
            throw new Error(`Failed to cancel: ${(error as Error).message}`);
        }
    }

    // --- setTemperature ---
    async setTemperature(host: string, port: string, apiKey: string, component: string, temperature: number) {
        console.error("setTemperature is not directly supported.");
        throw new Error("setTemperature is not supported.");
    }

    // --- getFiles ---
    async getFiles(host: string, port: string, apiKey: string) {
        const [serial, token] = this.extractBambuCredentials(apiKey);
        console.error("Fetching file list via FTP...");

        try {
            const fileController = await this.getFileController(host, token);
            const rawFiles = await fileController.listDir("/");

            const files = rawFiles.map(f => ({
                name: f.name,
                type: f.type === 2 ? 'directory' : 'file',
                size: f.size,
                modifiedAt: f.modifiedAt
            }));

            console.error(`Found ${files.length} files/folders`);
            return { files };
        } catch (error) {
            console.error("Error listing files:", error);
            return { files: [], error: (error as Error).message };
        }
    }

    // --- getFile ---
    async getFile(host: string, port: string, apiKey: string, filename: string) {
        const [serial, token] = this.extractBambuCredentials(apiKey);
        console.error(`Checking for file: ${filename}`);

        try {
            const fileController = await this.getFileController(host, token);
            const dirPath = path.dirname(filename) || "/";
            const baseName = path.basename(filename);
            const files = await fileController.listDir(dirPath === "." ? "/" : dirPath);

            const found = files.some(f => f.name === baseName);

            return { name: filename, exists: found };
        } catch (error) {
            console.error("Error getting file:", error);
            return { name: filename, exists: false, error: (error as Error).message };
        }
    }

    // --- downloadFile --- NEW in v3!
    async downloadFile(host: string, port: string, apiKey: string, remotePath: string, localPath: string) {
        const [serial, token] = this.extractBambuCredentials(apiKey);
        console.error(`Downloading ${remotePath} to ${localPath}...`);

        try {
            const fileController = await this.getFileController(host, token);
            await fileController.downloadFile(remotePath, localPath);
            console.error("Download complete.");
            return { status: "success", message: `Downloaded to ${localPath}` };
        } catch (error) {
            console.error("Download error:", error);
            throw new Error(`Failed to download: ${(error as Error).message}`);
        }
    }

    // --- uploadFile ---
    async uploadFile(host: string, port: string, apiKey: string, filePath: string, filename: string, print: boolean) {
        const [serial, token] = this.extractBambuCredentials(apiKey);
        console.error(`Uploading file: ${filePath} -> ${filename}`);

        try {
            const fileController = await this.getFileController(host, token);
            const targetPath = `/${filename}`;

            await fileController.uploadFile(filePath, targetPath);
            console.error("Upload complete.");

            if (print) {
                await this.print3mf(host, serial, token, {
                    filePath,
                    filename,
                    projectName: path.basename(filename, path.extname(filename))
                });
                return { status: "success", message: "File uploaded and print started." };
            }

            return { status: "success", message: "File uploaded." };
        } catch (error) {
            console.error("Upload error:", error);
            throw new Error(`Failed to upload: ${(error as Error).message}`);
        }
    }

    // --- startJob ---
    async startJob(host: string, port: string, apiKey: string, filename: string) {
        console.error("startJob: Using print command");
        const [serial, token] = this.extractBambuCredentials(apiKey);

        const printer = await this.getPrinter(host, serial, token);
        const printCommand = H2DCommands.printProjectCommand(
            filename,
            "Metadata/plate_1.gcode",
            path.basename(filename, path.extname(filename)),
            "00000000000000000000000000000000",
            {}
        );

        await printer.sendCommand(printCommand);
        return { status: "success", message: `Print started for ${filename}` };
    }

    // --- Helper ---
    private extractBambuCredentials(apiKey: string): [string, string] {
        const parts = apiKey.split(':');
        if (parts.length !== 2) {
            throw new Error("Invalid credentials format. Expected 'serial:token'");
        }
        return [parts[0], parts[1]];
    }

    async disconnectAll(): Promise<void> {
        await this.controllerStore.disconnectAll();
    }
}
