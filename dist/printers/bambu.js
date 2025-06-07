import { PrinterImplementation } from "../types.js";
import { BambuClient, UpdateStateCommand,
// State, // Removed as using string literal
// TempUpdatePartType // Removed as likely unusable type
 } from "bambu-node"; // Use bambu-node library
// Store for bambu-node printer instances
class BambuClientStore {
    constructor() {
        this.printers = new Map();
        this.initialConnectionPromises = new Map();
    }
    async getPrinter(host, serial, token) {
        const key = `${host}-${serial}`;
        // If already connected/connecting, return existing instance or wait for connection
        if (this.printers.has(key)) {
            console.log(`Returning existing BambuClient instance for ${key}`);
            return this.printers.get(key);
        }
        if (this.initialConnectionPromises.has(key)) {
            console.log(`Waiting for existing initial connection attempt for ${key}...`);
            // Don't await here; if promise exists, listeners will handle map update
            // await this.initialConnectionPromises.get(key); 
            // Throw error immediately if we know a connection is pending but not resolved yet
            // Or rely on the promise rejection propagating if it fails
            await this.initialConnectionPromises.get(key); // Await necessary to ensure connection completes or fails
            if (this.printers.has(key)) {
                return this.printers.get(key);
            }
            else {
                throw new Error(`Existing initial connection attempt for ${key} failed or timed out.`);
            }
        }
        // Create new instance and attempt connection
        console.log(`Creating new BambuClient instance for ${key}`);
        const printer = new BambuClient({
            host: host,
            serialNumber: serial,
            accessToken: token,
        });
        // Setup event listeners for state management
        printer.on('client:connect', () => {
            console.log(`BambuClient connected for ${key}`);
            this.printers.set(key, printer);
            this.initialConnectionPromises.delete(key);
        });
        printer.on('client:error', (err) => {
            console.error(`BambuClient connection error for ${key}:`, err);
            this.printers.delete(key);
            this.initialConnectionPromises.delete(key);
        });
        printer.on('client:disconnect', () => {
            console.log(`BambuClient connection closed for ${key}`);
            this.printers.delete(key);
            this.initialConnectionPromises.delete(key);
        });
        printer.on('printer:dataUpdate', (data) => {
            // Optional: log or update internal state based on data
            // console.log(`BambuClient data update for ${key}`);
        });
        // Store promise and initiate connection
        console.log(`Attempting initial connection for BambuClient ${key}...`);
        const connectPromise = printer.connect().then(() => { });
        this.initialConnectionPromises.set(key, connectPromise);
        try {
            await connectPromise;
            console.log(`Initial connection successful for ${key}.`);
            // Redundant set, already handled by 'client:connect' listener
            // this.printers.set(key, printer); 
            return printer;
        }
        catch (err) {
            console.error(`Initial connection failed for ${key}:`, err);
            this.initialConnectionPromises.delete(key); // Clean up promise map on failure
            throw err; // Rethrow the error
        }
    }
    async disconnectAll() {
        console.log("Disconnecting all BambuClient instances...");
        const disconnectPromises = [];
        for (const [key, printer] of this.printers.entries()) {
            disconnectPromises.push(printer.disconnect()
                .then(() => console.log(`Disconnected ${key}`))
                .catch(err => console.error(`Error disconnecting ${key}:`, err)));
        }
        await Promise.allSettled(disconnectPromises);
        this.printers.clear();
        this.initialConnectionPromises.clear();
    }
}
export class BambuImplementation extends PrinterImplementation {
    constructor(apiClient /* Not used */) {
        super(apiClient);
        this.printerStore = new BambuClientStore();
    }
    // Helper to get connected printer instance
    async getPrinter(host, serial, token) {
        return this.printerStore.getPrinter(host, serial, token);
    }
    // --- getStatus ---
    async getStatus(host, port, apiKey) {
        const [serial, token] = this.extractBambuCredentials(apiKey);
        try {
            const printer = await this.getPrinter(host, serial, token);
            // Wait a moment for status data to populate if needed
            if (!printer.data || Object.keys(printer.data).length === 0) {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
            const data = printer.data;
            return {
                status: data.gcode_state || "UNKNOWN",
                connected: true,
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
        }
        catch (error) {
            console.error(`Failed to get BambuClient status for ${serial}:`, error);
            return { status: "error", connected: false, error: error.message };
        }
    }
    // --- print3mf ---
    async print3mf(host, serial, token, options) {
        console.error("print3mf error: bambu-node library does not directly support the required FTPS file upload for .3mf files.");
        throw new Error("Printing .3mf files is not supported with the current bambu-node library integration due to missing FTPS capability.");
    }
    // --- cancelJob ---
    async cancelJob(host, port, apiKey) {
        const [serial, token] = this.extractBambuCredentials(apiKey);
        const printer = await this.getPrinter(host, serial, token);
        console.log(`Attempting to cancel print via bambu-node...`);
        try {
            // Use UpdateStateCommand with string literal state
            const command = new UpdateStateCommand({ state: 'stop' });
            await printer.executeCommand(command);
            console.log(`Cancel print command successful via bambu-node.`);
            return { status: "success", message: "Cancel command sent successfully." };
        }
        catch (cancelError) {
            console.error(`Error sending cancel command via bambu-node:`, cancelError);
            throw new Error(`Failed to cancel print: ${cancelError.message}`);
        }
    }
    // --- setTemperature --- (Commenting out due to type issues)
    async setTemperature(host, port, apiKey, component, temperature) {
        // const [serial, token] = this.extractBambuCredentials(apiKey);
        // const printer = await this.getPrinter(host, serial, token);
        // console.log(`Attempting to set temperature for ${component} to ${temperature}°C via bambu-node...`);
        // try {
        //     let command;
        //     const partArg = component.toLowerCase();
        //     if (partArg === 'extruder' || partArg === 'nozzle') {
        //         // Use string literal for part. Cast temp due to strict lib types.
        //         console.warn("Casting temperature to 'any' for UpdateTempCommand.");
        //         command = new UpdateTempCommand({ part: 'nozzle', temperature: temperature as any });
        //     } else if (partArg === 'bed') {
        //         // Use string literal for part. Cast temp due to strict lib types.
        //          console.warn("Casting temperature to 'any' for UpdateTempCommand.");
        //         command = new UpdateTempCommand({ part: 'bed', temperature: temperature as any });
        //     } else {
        //          throw new Error(`Unsupported temperature component: ${component}. Use 'extruder' or 'bed'.`);
        //     }
        //     await printer.executeCommand(command);
        //     console.log(`Set temperature command successful for ${component}.`);
        //     return { status: "success", message: `Temperature set command for ${component} sent.` };
        // } catch (tempError) {
        //     console.error(`Error sending set temperature command via bambu-node:`, tempError);
        //     throw new Error(`Failed to set temperature: ${(tempError as Error).message}`);
        // }
        console.warn("setTemperature is currently disabled due to type inconsistencies in the bambu-node library.");
        throw new Error("setTemperature is disabled.");
    }
    // --- getFiles --- (Library doesn't seem to expose direct file listing)
    async getFiles(host, port, apiKey) {
        console.warn("File listing is not directly supported by bambu-node. Returning empty list.");
        return { files: [], note: "Not supported by bambu-node library" };
    }
    // --- getFile --- (Library doesn't seem to expose direct file metadata/download)
    async getFile(host, port, apiKey, filename) {
        console.warn("Getting individual file metadata/content is not directly supported by bambu-node.");
        return { name: filename, exists: false, note: "Not supported by bambu-node library" };
    }
    // --- uploadFile (Handled by print method if supported) ---
    async uploadFile(host, port, apiKey, filePath, filename, print) {
        console.warn("Use the 'print_3mf' tool. Direct upload without print is not the primary use case.");
        if (print) {
            // Cannot directly call print3mf as it's not supported by this library
            throw new Error("Cannot initiate print via uploadFile as print_3mf is not supported by bambu-node.");
            // const [serial, token] = this.extractBambuCredentials(apiKey);
            // await this.print3mf(host, serial, token, { 
            //     filePath: filePath, 
            //     projectName: path.basename(filePath, path.extname(filePath))
            // });
            // return { status: "success", message: "Upload and print initiated via print_3mf." };
        }
        else {
            throw new Error("Uploading without printing is not supported. Use print_3mf (if supported).");
        }
    }
    // --- startJob (Use print method via print_3mf if supported) ---
    async startJob(host, port, apiKey, filename) {
        console.warn("startJob is deprecated for Bambu. Use the 'print_3mf' tool (if supported).");
        throw new Error("startJob is deprecated for Bambu printers. Use print_3mf (if supported).");
    }
    // --- Helper to extract Bambu credentials ---
    extractBambuCredentials(apiKey) {
        const parts = apiKey.split(':');
        if (parts.length !== 2) {
            throw new Error("Invalid Bambu credentials format. Expected 'serial:token'");
        }
        return [parts[0], parts[1]];
    }
    // Method required by PrinterFactory, disconnects managed printers
    async disconnectAll() {
        await this.printerStore.disconnectAll();
    }
}
