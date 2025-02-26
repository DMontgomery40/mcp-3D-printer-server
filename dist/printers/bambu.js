import { PrinterImplementation } from "../types.js";
export class BambuImplementation extends PrinterImplementation {
    constructor(apiClient, bambuPrinterStore) {
        super(apiClient);
        this.bambuPrinterStore = bambuPrinterStore;
    }
    getBambuPrinter(host, serial, token) {
        return this.bambuPrinterStore.get(host, serial, token);
    }
    async getStatus(host, port, apiKey) {
        // Extracting Bambu-specific parameters from apiKey
        // Format should be "serial:token"
        const [serial, token] = this.extractBambuCredentials(apiKey);
        const printer = this.getBambuPrinter(host, serial, token);
        // Connect if not already connected
        if (!printer.isConnected) {
            await printer.connect();
            // Wait for initial state
            await printer.awaitInitialState(10000); // 10 second timeout
        }
        return printer.getState();
    }
    async getFiles(host, port, apiKey) {
        // Extracting Bambu-specific parameters
        const [serial, token] = this.extractBambuCredentials(apiKey);
        const printer = this.getBambuPrinter(host, serial, token);
        // Connect if not already connected
        if (!printer.isConnected) {
            await printer.connect();
        }
        // Using the manipulateFiles API to list files
        const fileList = [];
        await printer.manipulateFiles(async (context) => {
            const files = await context.readDir("gcodes");
            fileList.push(...files);
        });
        return { files: fileList };
    }
    async getFile(host, port, apiKey, filename) {
        // Extracting Bambu-specific parameters
        const [serial, token] = this.extractBambuCredentials(apiKey);
        // Bambu doesn't have a direct API to get file content
        // Instead, this returns metadata about the file by confirming it exists
        const printer = this.getBambuPrinter(host, serial, token);
        // Connect if not already connected
        if (!printer.isConnected) {
            await printer.connect();
        }
        let fileExists = false;
        await printer.manipulateFiles(async (context) => {
            const files = await context.readDir("gcodes");
            fileExists = files.includes(filename);
        });
        if (!fileExists) {
            throw new Error(`File not found: ${filename}`);
        }
        return { name: filename, exists: true };
    }
    async uploadFile(host, port, apiKey, filePath, filename, print) {
        // Extracting Bambu-specific parameters
        const [serial, token] = this.extractBambuCredentials(apiKey);
        const printer = this.getBambuPrinter(host, serial, token);
        // Connect if not already connected
        if (!printer.isConnected) {
            await printer.connect();
        }
        // Upload file via FTP
        await printer.manipulateFiles(async (context) => {
            await context.sendFile(filePath, `gcodes/${filename}`);
        });
        if (print) {
            // To start a print directly, we would need more info
            // This is a placeholder - starting a print needs more details
            throw new Error("Direct printing of uploaded files is not implemented yet");
        }
        return { status: "success", message: `File ${filename} uploaded successfully` };
    }
    async startJob(host, port, apiKey, filename) {
        // Extracting Bambu-specific parameters
        const [serial, token] = this.extractBambuCredentials(apiKey);
        // Starting a job requires more information for Bambu printers
        // This is a simplified implementation - in reality, we need
        // more details about the 3MF project file structure
        throw new Error("Starting a print job on Bambu printers requires more information about the file structure");
    }
    async cancelJob(host, port, apiKey) {
        // Extracting Bambu-specific parameters
        const [serial, token] = this.extractBambuCredentials(apiKey);
        const printer = this.getBambuPrinter(host, serial, token);
        // Connect if not already connected
        if (!printer.isConnected) {
            await printer.connect();
        }
        // Cancel print
        printer.stop();
        return { status: "success", message: "Print job cancelled" };
    }
    async setTemperature(host, port, apiKey, component, temperature) {
        // Bambu API doesn't have direct temperature controls
        // We would need to send custom G-code commands
        throw new Error("Setting temperatures directly is not supported via the Bambu API");
    }
    // Helper method to extract Bambu-specific credentials from apiKey
    extractBambuCredentials(apiKey) {
        const parts = apiKey.split(':');
        if (parts.length !== 2) {
            throw new Error("Invalid Bambu credentials format. Expected 'serial:token'");
        }
        return [parts[0], parts[1]];
    }
}
