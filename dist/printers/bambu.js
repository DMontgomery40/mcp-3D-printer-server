import { PrinterImplementation } from "../types.js";
import * as mqtt from 'mqtt'; // Import MQTT library
import * as path from 'path';
export class BambuImplementation extends PrinterImplementation {
    constructor(apiClient, bambuPrinterStore) {
        super(apiClient);
        this.mqttClients = {}; // Store connected MQTT clients
        this.mqttConnectionPromises = {}; // Track connection attempts
        this.bambuPrinterStore = bambuPrinterStore;
    }
    // Get BambuPrinter instance for FTP
    getBambuPrinterForFTP(host, serial, token) {
        // This still uses bambu-js just for the FTP part
        return this.bambuPrinterStore.get(host, serial, token);
    }
    // Get or establish MQTT connection
    async getMqttClient(host, serial, token) {
        const clientKey = `${host}-${serial}`;
        if (this.mqttClients[clientKey] && this.mqttClients[clientKey].connected) {
            return this.mqttClients[clientKey];
        }
        // If a connection attempt is already in progress, wait for it
        if (this.mqttConnectionPromises[clientKey] !== undefined) {
            console.log(`Waiting for existing MQTT connection attempt to ${clientKey}...`);
            return this.mqttConnectionPromises[clientKey];
        }
        console.log(`Attempting to establish new MQTT connection to ${host} for ${serial}...`);
        const connectPromise = new Promise((resolve, reject) => {
            // Use port 8883 and TLS
            const mqttOptions = {
                port: 8883,
                host: host,
                protocol: 'mqtts',
                username: 'bblp', // As per OpenBambuAPI docs
                password: token,
                clientId: `mcp_client_${serial}_${Date.now()}`,
                rejectUnauthorized: false, // Might be needed for self-signed certs? Test carefully.
                // ca: [fs.readFileSync('path/to/ca_cert.pem')], // Add CA cert if needed
                connectTimeout: 10000, // 10 seconds
                reconnectPeriod: 5000 // Try reconnecting every 5 seconds
            };
            const client = mqtt.connect(mqttOptions);
            client.on('connect', () => {
                console.log(`MQTT connected successfully to ${host} for ${serial}`);
                this.mqttClients[clientKey] = client;
                // Subscribe to necessary topics (e.g., responses/status)
                client.subscribe(`device/${serial}/report`, (err) => {
                    if (err) {
                        console.error(`Failed to subscribe to report topic for ${serial}:`, err);
                    }
                });
                delete this.mqttConnectionPromises[clientKey]; // Clear promise tracker on success
                resolve(client);
            });
            client.on('error', (err) => {
                console.error(`MQTT connection error for ${serial} on ${host}:`, err);
                delete this.mqttClients[clientKey]; // Remove potentially bad client
                delete this.mqttConnectionPromises[clientKey]; // Clear promise tracker on error
                reject(err);
            });
            client.on('close', () => {
                console.log(`MQTT connection closed for ${serial} on ${host}`);
                delete this.mqttClients[clientKey]; // Remove client on close
            });
            // Handle status messages from the report topic
            client.on('message', (topic, message) => {
                try {
                    const data = JSON.parse(message.toString());
                    // Processing logic for status updates would go here
                    // For now, we just acknowledge receiving it (optional logging)
                    // console.log(`MQTT message received on ${topic}:`, data?.print?.subtask_name ?? data?.print?.command ?? 'Unknown message type');
                }
                catch (e) {
                    console.error('Failed to parse MQTT message:', e);
                }
            });
        });
        this.mqttConnectionPromises[clientKey] = connectPromise; // Store the promise
        return connectPromise;
    }
    // Disconnect MQTT clients on shutdown
    async disconnectAllMqtt() {
        console.log("Disconnecting all MQTT clients...");
        for (const key in this.mqttClients) {
            const client = this.mqttClients[key];
            if (client) {
                await new Promise((resolve, reject) => {
                    client.end(false, {}, (err) => {
                        if (err) {
                            console.error(`Error ending MQTT client ${key}:`, err);
                            reject(err);
                        }
                        else {
                            console.log(`MQTT client ${key} disconnected.`);
                            resolve();
                        }
                    });
                });
            }
        }
        this.mqttClients = {};
        this.mqttConnectionPromises = {};
    }
    // --- getStatus (Limited Implementation) ---
    async getStatus(host, port, apiKey) {
        const [serial, token] = this.extractBambuCredentials(apiKey);
        try {
            // Ensure MQTT connection is attempted/established
            const client = await this.getMqttClient(host, serial, token);
            // Return minimal status indicating connection success
            // Full status requires implementing state storage based on /report topic messages
            return {
                status: client.connected ? "connected" : "connecting",
                serial: serial,
                note: "Full status details require MQTT state tracking implementation."
            };
        }
        catch (error) {
            console.error(`Failed to get MQTT client/status for ${serial}:`, error);
            return { status: "error", error: error.message };
        }
    }
    // --- Refactored print3mf using direct MQTT ---
    async print3mf(host, serial, token, options) {
        // Still use bambu-js for FTP upload
        const printerFTP = this.getBambuPrinterForFTP(host, serial, token);
        const remoteFilename = path.basename(options.filePath);
        // Ensure path uses forward slashes for printer consistency
        const remotePath = `gcodes/${remoteFilename}`.replace(/\\/g, '/');
        // 1. Connect FTP if necessary (via bambu-js helper)
        if (!printerFTP.isConnected) {
            console.log(`Connecting Bambu FTP ${host} (${serial}) before uploading...`);
            await printerFTP.connect(); // Connects MQTT and FTP
            // await printerFTP.awaitInitialState(10000); // Might not be needed just for FTP
            console.log(`Connected Bambu FTP.`);
        }
        // 2. Upload the file via FTP
        console.log(`Uploading ${options.filePath} to ${remotePath} via FTP...`);
        try {
            await printerFTP.manipulateFiles(async (context) => {
                await context.sendFile(options.filePath, remotePath);
            });
            console.log(`File ${remoteFilename} uploaded successfully.`);
        }
        catch (uploadError) {
            console.error(`FTP Upload Error:`, uploadError);
            throw new Error(`Failed to upload 3MF file via FTP: ${uploadError.message}`);
        }
        // 3. Get MQTT Client
        const mqttClient = await this.getMqttClient(host, serial, token);
        // 4. Construct the MQTT Print Command Payload based on OpenBambuAPI
        const commandPayload = {
            sequence_id: Date.now().toString(),
            command: "project_file",
            param: remotePath, // Path on SD card
            project_name: options.projectName,
            use_ams: options.amsMapping && options.amsMapping.length > 0 ? true : (options.useAMS ?? false),
            plate_idx: options.plateIndex ?? 0,
            bed_levelling: options.bedLeveling ?? true,
            flow_cali: options.flowCalibration ?? false,
            vibration_cali: options.vibrationCalibration ?? false,
            layer_inspect: options.layerInspect ?? false,
            timelapse: options.timelapse ?? false,
            ams_mapping: options.amsMapping,
            md5: options.md5
        };
        // Remove ams_mapping if not provided or empty
        if (!commandPayload.ams_mapping || commandPayload.ams_mapping.length === 0) {
            delete commandPayload.ams_mapping;
            // Also ensure use_ams is false if no mapping exists
            commandPayload.use_ams = false;
        }
        // Remove md5 if not provided
        if (!commandPayload.md5) {
            delete commandPayload.md5;
        }
        // 5. Publish the command
        return this.publishMqttCommand(mqttClient, serial, 'print', commandPayload);
    }
    // --- Refactored cancelJob using MQTT ---
    async cancelJob(host, port, apiKey) {
        const [serial, token] = this.extractBambuCredentials(apiKey);
        const mqttClient = await this.getMqttClient(host, serial, token);
        // Command structure from OpenBambuAPI (assuming 'stop_print' is correct)
        const payload = { sequence_id: Date.now().toString(), command: "stop_print" };
        return this.publishMqttCommand(mqttClient, serial, 'print', payload);
    }
    // --- setTemperature (still not directly possible via MQTT command) ---
    async setTemperature(host, port, apiKey, component, temperature) {
        console.warn("Setting temperatures directly is not supported via known Bambu MQTT commands. Use G-code.");
        // We could potentially implement a tool to send custom G-code?
        throw new Error("Direct temperature setting via MQTT is not supported.");
    }
    // --- Other methods (getFiles, getFile, uploadFile, startJob) need review/refactoring ---
    // For now, keep using bambu-js FTP for file ops, but MQTT for commands
    async getFiles(host, port, apiKey) {
        const [serial, token] = this.extractBambuCredentials(apiKey);
        const printerFTP = this.getBambuPrinterForFTP(host, serial, token);
        if (!printerFTP.isConnected)
            await printerFTP.connect();
        const fileList = [];
        await printerFTP.manipulateFiles(async (context) => {
            const files = await context.readDir("gcodes");
            fileList.push(...files);
        });
        return { files: fileList };
    }
    async getFile(host, port, apiKey, filename) {
        // Still relies on checking existence via FTP
        const [serial, token] = this.extractBambuCredentials(apiKey);
        const printerFTP = this.getBambuPrinterForFTP(host, serial, token);
        if (!printerFTP.isConnected)
            await printerFTP.connect();
        let fileExists = false;
        await printerFTP.manipulateFiles(async (context) => {
            const files = await context.readDir("gcodes");
            fileExists = files.includes(filename);
        });
        if (!fileExists)
            throw new Error(`File not found: ${filename}`);
        return { name: filename, exists: true };
    }
    async uploadFile(host, port, apiKey, filePath, filename, print) {
        // This method just uploads now, doesn't handle printing
        const [serial, token] = this.extractBambuCredentials(apiKey);
        const printerFTP = this.getBambuPrinterForFTP(host, serial, token);
        const remotePath = `gcodes/${filename}`.replace(/\\/g, '/');
        if (!printerFTP.isConnected)
            await printerFTP.connect();
        console.log(`Uploading ${filePath} to ${remotePath} via FTP...`);
        try {
            await printerFTP.manipulateFiles(async (context) => {
                await context.sendFile(filePath, remotePath);
            });
            console.log(`File ${filename} uploaded successfully.`);
            if (print) {
                console.warn("'print=true' ignored in uploadFile for Bambu. Use print_3mf tool instead.");
            }
            return { status: "success", message: `File ${filename} uploaded successfully` };
        }
        catch (uploadError) {
            console.error(`FTP Upload Error:`, uploadError);
            throw new Error(`Failed to upload file via FTP: ${uploadError.message}`);
        }
    }
    async startJob(host, port, apiKey, filename) {
        // This should likely be deprecated or only work for G-code files via a different MQTT command?
        console.warn("startJob is not recommended for Bambu .3mf files. Use print_3mf tool.");
        throw new Error("startJob is not implemented for Bambu printers using MQTT commands yet.");
    }
    // --- Helper to publish MQTT commands ---
    async publishMqttCommand(client, serial, commandType, payload) {
        const topic = `device/${serial}/request`;
        const message = JSON.stringify({ [commandType]: payload });
        console.log(`Publishing MQTT to ${topic}: ${message}`);
        return new Promise((resolve, reject) => {
            client.publish(topic, message, { qos: 1 }, (err) => {
                if (err) {
                    console.error(`MQTT Publish Error to ${topic}:`, err);
                    reject(new Error(`Failed to publish MQTT command: ${err.message}`));
                }
                else {
                    console.log(`MQTT command published successfully to ${topic}`);
                    // Note: We don't wait for a response here. Status updates come via /report topic.
                    resolve({ status: "success", message: "Command sent successfully via MQTT." });
                }
            });
        });
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
