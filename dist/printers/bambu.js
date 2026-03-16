import { PrinterImplementation } from "../types.js";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { Client as FTPClient } from "basic-ftp";
import { BambuPrinter } from "bambu-js";
import { BambuClient, GCodeFileCommand, GCodeLineCommand, PushAllCommand, UpdateStateCommand, } from "bambu-node";
class BambuClientStore {
    constructor() {
        this.printers = new Map();
        this.initialConnectionPromises = new Map();
    }
    async getPrinter(host, serial, token) {
        const key = `${host}-${serial}`;
        if (this.printers.has(key)) {
            return this.printers.get(key);
        }
        if (this.initialConnectionPromises.has(key)) {
            await this.initialConnectionPromises.get(key);
            if (this.printers.has(key)) {
                return this.printers.get(key);
            }
            throw new Error(`Existing Bambu client connection for ${key} failed.`);
        }
        const printer = new BambuClient({
            host,
            serialNumber: serial,
            accessToken: token,
        });
        printer.on("client:connect", () => {
            this.printers.set(key, printer);
            this.initialConnectionPromises.delete(key);
        });
        printer.on("client:error", () => {
            this.printers.delete(key);
            this.initialConnectionPromises.delete(key);
        });
        printer.on("client:disconnect", () => {
            this.printers.delete(key);
            this.initialConnectionPromises.delete(key);
        });
        const connectPromise = printer.connect().then(() => { });
        this.initialConnectionPromises.set(key, connectPromise);
        try {
            await connectPromise;
            return printer;
        }
        catch (error) {
            this.initialConnectionPromises.delete(key);
            throw error;
        }
    }
    async disconnectAll() {
        const disconnectPromises = [];
        for (const printer of this.printers.values()) {
            disconnectPromises.push((async () => {
                try {
                    await printer.disconnect();
                }
                catch (error) {
                    console.error("Failed to disconnect Bambu client", error);
                }
            })());
        }
        await Promise.allSettled(disconnectPromises);
        this.printers.clear();
        this.initialConnectionPromises.clear();
    }
}
export class BambuImplementation extends PrinterImplementation {
    constructor(apiClient) {
        super(apiClient);
        this.printerStore = new BambuClientStore();
    }
    async getPrinter(host, serial, token) {
        return this.printerStore.getPrinter(host, serial, token);
    }
    async resolveProjectFileMetadata(localThreeMfPath, plateIndex) {
        const archive = await fs.readFile(localThreeMfPath);
        const zip = await JSZip.loadAsync(archive);
        const plateEntries = Object.values(zip.files).filter((entry) => !entry.dir && /^Metadata\/plate_\d+\.gcode$/i.test(entry.name));
        if (plateEntries.length === 0) {
            throw new Error("3MF does not contain any Metadata/plate_<n>.gcode entries. Re-slice and export a printable 3MF.");
        }
        let selectedEntry = plateEntries.sort((a, b) => a.name.localeCompare(b.name))[0];
        if (plateIndex !== undefined) {
            const expectedEntryName = `Metadata/plate_${plateIndex + 1}.gcode`;
            const matchedEntry = plateEntries.find((entry) => entry.name.toLowerCase() === expectedEntryName.toLowerCase());
            if (!matchedEntry) {
                const available = plateEntries.map((entry) => entry.name).join(", ");
                throw new Error(`Requested plateIndex=${plateIndex} (${expectedEntryName}) not present in 3MF. Available: ${available}`);
            }
            selectedEntry = matchedEntry;
        }
        const gcodeBuffer = await selectedEntry.async("nodebuffer");
        const md5 = createHash("md5").update(gcodeBuffer).digest("hex");
        return {
            plateFileName: path.posix.basename(selectedEntry.name),
            plateInternalPath: selectedEntry.name,
            md5,
        };
    }
    async getStatus(host, port, apiKey) {
        const [serial, token] = this.extractBambuCredentials(apiKey);
        try {
            const printer = await this.getPrinter(host, serial, token);
            try {
                await printer.executeCommand(new PushAllCommand());
            }
            catch (error) {
                console.warn("PushAllCommand failed, continuing with cached status", error);
            }
            if (!printer.data || Object.keys(printer.data).length === 0) {
                await new Promise((resolve) => setTimeout(resolve, 1500));
            }
            const data = printer.data;
            return {
                status: data.gcode_state || "UNKNOWN",
                connected: true,
                temperatures: {
                    nozzle: {
                        actual: data.nozzle_temper || 0,
                        target: data.nozzle_target_temper || 0,
                    },
                    bed: {
                        actual: data.bed_temper || 0,
                        target: data.bed_target_temper || 0,
                    },
                    chamber: data.chamber_temper || data.frame_temper || 0,
                },
                print: {
                    filename: data.subtask_name || data.gcode_file || "None",
                    progress: data.mc_percent || 0,
                    timeRemaining: data.mc_remaining_time || 0,
                    currentLayer: data.layer_num || 0,
                    totalLayers: data.total_layer_num || 0,
                },
                ams: data.ams || null,
                model: data.model || "Unknown",
                serial,
                raw: data,
            };
        }
        catch (error) {
            console.error(`Failed to get Bambu status for ${serial}:`, error);
            return { status: "error", connected: false, error: error.message };
        }
    }
    async print3mf(host, serial, token, options) {
        if (!options.filePath.toLowerCase().endsWith(".3mf")) {
            throw new Error("print3mf requires a .3mf input file.");
        }
        const projectMetadata = await this.resolveProjectFileMetadata(options.filePath, options.plateIndex);
        const remoteFileName = path.basename(options.filePath);
        const remoteProjectPath = `cache/${remoteFileName}`;
        // Upload via basic-ftp directly (bypasses bambu-js double-path bug)
        await this.ftpUpload(host, token, options.filePath, `/cache/${remoteFileName}`);
        // Send project_file command via bambu-node MQTT (bypasses bambu-js
        // hardcoded use_ams=true and missing ams_mapping support)
        const printer = await this.getPrinter(host, serial, token);
        const md5 = options.md5 ?? projectMetadata.md5;
        // Build AMS mapping per OpenBambuAPI spec: 5-element array
        // [-1,-1,-1,-1,0] means slot 0 only; pad unused slots with -1
        let amsMapping;
        if (options.amsMapping && options.amsMapping.length > 0) {
            amsMapping = Array.from({ length: 5 }, (_, i) => i < options.amsMapping.length ? options.amsMapping[i] : -1);
        }
        else {
            amsMapping = [-1, -1, -1, -1, 0];
        }
        const projectFileCmd = {
            print: {
                command: "project_file",
                param: `Metadata/${projectMetadata.plateFileName}`,
                url: `file:///sdcard/${remoteProjectPath}`,
                subtask_name: options.projectName,
                md5,
                flow_cali: options.flowCalibration ?? true,
                layer_inspect: options.layerInspect ?? true,
                vibration_cali: options.vibrationCalibration ?? true,
                bed_leveling: options.bedLeveling ?? true,
                bed_type: options.bedType || "textured_plate",
                timelapse: options.timelapse ?? false,
                use_ams: options.useAMS !== false,
                ams_mapping: amsMapping,
                profile_id: "0",
                project_id: "0",
                sequence_id: "0",
                subtask_id: "0",
                task_id: "0",
            },
        };
        await printer.publish(projectFileCmd);
        await new Promise((resolve) => setTimeout(resolve, 300));
        return {
            status: "success",
            message: `Uploaded and started 3MF print: ${options.projectName}`,
            remoteProjectPath,
            plateFile: projectMetadata.plateFileName,
            platePath: projectMetadata.plateInternalPath,
            md5,
            amsMapping,
        };
    }
    async cancelJob(host, port, apiKey) {
        const [serial, token] = this.extractBambuCredentials(apiKey);
        const printer = await this.getPrinter(host, serial, token);
        try {
            await printer.executeCommand(new UpdateStateCommand({ state: "stop" }));
            return { status: "success", message: "Cancel command sent successfully." };
        }
        catch (error) {
            throw new Error(`Failed to cancel print: ${error.message}`);
        }
    }
    async setTemperature(host, port, apiKey, component, temperature) {
        const [serial, token] = this.extractBambuCredentials(apiKey);
        const printer = await this.getPrinter(host, serial, token);
        const normalizedComponent = component.toLowerCase();
        const targetTemperature = Math.round(temperature);
        if (targetTemperature < 0 || targetTemperature > 300) {
            throw new Error("Temperature must be between 0 and 300°C.");
        }
        let gcode;
        if (normalizedComponent === "bed") {
            gcode = `M140 S${targetTemperature}`;
        }
        else if (normalizedComponent === "extruder" ||
            normalizedComponent === "nozzle" ||
            normalizedComponent === "tool" ||
            normalizedComponent === "tool0") {
            gcode = `M104 S${targetTemperature}`;
        }
        else {
            throw new Error(`Unsupported temperature component: ${component}. Use one of: bed, nozzle, extruder.`);
        }
        await printer.executeCommand(new GCodeLineCommand({ gcodes: [gcode] }));
        return {
            status: "success",
            message: `Temperature command sent for ${normalizedComponent}.`,
            command: gcode,
        };
    }
    async getFiles(host, port, apiKey) {
        const [serial, token] = this.extractBambuCredentials(apiKey);
        const printer = new BambuPrinter(host, serial, token);
        const directories = ["cache", "timelapse", "logs"];
        const filesByDirectory = {};
        await printer.manipulateFiles(async (context) => {
            for (const directory of directories) {
                try {
                    filesByDirectory[directory] = await context.readDir(directory);
                }
                catch {
                    filesByDirectory[directory] = [];
                }
            }
        });
        const files = Object.entries(filesByDirectory).flatMap(([directory, names]) => names.map((name) => `${directory}/${name}`));
        return {
            files,
            directories: filesByDirectory,
        };
    }
    async getFile(host, port, apiKey, filename) {
        const [serial, token] = this.extractBambuCredentials(apiKey);
        const printer = new BambuPrinter(host, serial, token);
        const normalized = filename.replace(/^\/+/, "");
        const directory = path.posix.dirname(normalized) === "." ? "cache" : path.posix.dirname(normalized);
        const baseName = path.posix.basename(normalized);
        let exists = false;
        await printer.manipulateFiles(async (context) => {
            const entries = await context.readDir(directory);
            exists = entries.includes(baseName);
        });
        return {
            name: `${directory}/${baseName}`,
            exists,
        };
    }
    async uploadFile(host, port, apiKey, filePath, filename, print) {
        await fs.access(filePath);
        const [serial, token] = this.extractBambuCredentials(apiKey);
        const normalizedFileName = filename.replace(/^\/+/, "");
        const remotePath = normalizedFileName.includes("/")
            ? normalizedFileName
            : `cache/${normalizedFileName}`;
        // Use direct FTP upload (bypasses bambu-js double-path bug)
        await this.ftpUpload(host, token, filePath, `/${remotePath}`);
        const response = {
            status: "success",
            uploaded: true,
            remotePath,
            printRequested: print,
        };
        if (print) {
            if (remotePath.toLowerCase().endsWith(".gcode")) {
                response.startResult = await this.startJob(host, port, apiKey, remotePath);
            }
            else if (remotePath.toLowerCase().endsWith(".3mf")) {
                response.note =
                    "3MF upload complete. Use print_3mf to start a project print with plate and metadata options.";
            }
            else {
                throw new Error("Automatic print after upload supports .gcode only. Use print_3mf for .3mf project prints.");
            }
        }
        return response;
    }
    async startJob(host, port, apiKey, filename) {
        if (filename.toLowerCase().endsWith(".3mf")) {
            throw new Error("Use print_3mf for .3mf project files.");
        }
        const [serial, token] = this.extractBambuCredentials(apiKey);
        const printer = await this.getPrinter(host, serial, token);
        const normalizedFileName = filename.replace(/^\/+/, "");
        const remoteFile = normalizedFileName.includes("/")
            ? normalizedFileName
            : `cache/${normalizedFileName}`;
        await printer.executeCommand(new GCodeFileCommand({ fileName: remoteFile }));
        return {
            status: "success",
            message: `Start command sent for ${remoteFile}.`,
            file: remoteFile,
        };
    }
    /**
     * Upload a file to the printer via FTP using basic-ftp directly.
     * Bypasses bambu-js's sendFile which has a double-path bug (ensureDir CDs
     * into the target directory, then uploadFrom uses the full relative path
     * again, resulting in e.g. /cache/cache/file.3mf).
     */
    async ftpUpload(host, token, localPath, remotePath) {
        const client = new FTPClient(15000);
        try {
            await client.access({
                host,
                port: 990,
                user: "bblp",
                password: token,
                secure: "implicit",
                secureOptions: { rejectUnauthorized: false },
            });
            // Use absolute path to avoid CWD side-effects
            const absoluteRemote = remotePath.startsWith("/") ? remotePath : `/${remotePath}`;
            const remoteDir = path.posix.dirname(absoluteRemote);
            await client.ensureDir(remoteDir);
            // uploadFrom with just the basename since we're already in the right dir
            await client.uploadFrom(localPath, path.posix.basename(absoluteRemote));
        }
        finally {
            client.close();
        }
    }
    extractBambuCredentials(apiKey) {
        const separatorIndex = apiKey.indexOf(":");
        if (separatorIndex <= 0 || separatorIndex === apiKey.length - 1) {
            throw new Error("Invalid Bambu credentials format. Expected 'serial:token'.");
        }
        const serial = apiKey.slice(0, separatorIndex).trim();
        const token = apiKey.slice(separatorIndex + 1).trim();
        if (!serial || !token) {
            throw new Error("Invalid Bambu credentials format. Expected 'serial:token'.");
        }
        return [serial, token];
    }
    async disconnectAll() {
        await this.printerStore.disconnectAll();
    }
}
