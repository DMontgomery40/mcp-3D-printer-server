#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListResourcesRequestSchema, ReadResourceRequestSchema, ListToolsRequestSchema, CallToolRequestSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import FormData from "form-data";
import { BambuPrinter } from "bambu-js";
// Load environment variables from .env file
dotenv.config();
// Default values
const DEFAULT_HOST = process.env.PRINTER_HOST || "localhost";
const DEFAULT_PORT = process.env.PRINTER_PORT || "80";
const DEFAULT_API_KEY = process.env.API_KEY || "";
const DEFAULT_TYPE = process.env.PRINTER_TYPE || "octoprint"; // Default to OctoPrint
const TEMP_DIR = process.env.TEMP_DIR || path.join(process.cwd(), "temp");
// Bambu-specific default values
const DEFAULT_BAMBU_SERIAL = process.env.BAMBU_SERIAL || "";
const DEFAULT_BAMBU_TOKEN = process.env.BAMBU_TOKEN || "";
// Ensure temp directory exists
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}
class ThreeDPrinterMCPServer {
    constructor() {
        this.bambuPrinters = new Map();
        this.server = new Server({
            name: "mcp-3d-printer-server",
            version: "1.0.0"
        }, {
            capabilities: {
                resources: {},
                tools: {}
            }
        });
        // Create axios instance with default configuration
        this.apiClient = axios.create({
            timeout: 10000,
        });
        this.setupHandlers();
        this.setupErrorHandling();
    }
    setupErrorHandling() {
        this.server.onerror = (error) => {
            console.error("[MCP Error]", error);
        };
        process.on("SIGINT", async () => {
            // Disconnect all Bambu printers
            for (const printer of this.bambuPrinters.values()) {
                await printer.disconnect();
            }
            await this.server.close();
            process.exit(0);
        });
    }
    setupHandlers() {
        this.setupResourceHandlers();
        this.setupToolHandlers();
    }
    setupResourceHandlers() {
        // List available resources
        this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
            return {
                resources: [
                    {
                        uri: `printer://${DEFAULT_HOST}/status`,
                        name: "3D Printer Status",
                        mimeType: "application/json",
                        description: "Current status of the 3D printer including temperatures, print progress, and more"
                    },
                    {
                        uri: `printer://${DEFAULT_HOST}/files`,
                        name: "3D Printer Files",
                        mimeType: "application/json",
                        description: "List of files available on the 3D printer"
                    }
                ],
                templates: [
                    {
                        uriTemplate: "printer://{host}/status",
                        name: "3D Printer Status",
                        mimeType: "application/json"
                    },
                    {
                        uriTemplate: "printer://{host}/files",
                        name: "3D Printer Files",
                        mimeType: "application/json"
                    },
                    {
                        uriTemplate: "printer://{host}/file/{filename}",
                        name: "3D Printer File Content",
                        mimeType: "application/gcode"
                    }
                ]
            };
        });
        // Read resource
        this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
            const uri = request.params.uri;
            const match = uri.match(/^printer:\/\/([^\/]+)\/(.+)$/);
            if (!match) {
                throw new McpError(ErrorCode.InvalidRequest, `Invalid resource URI: ${uri}`);
            }
            const [, host, resource] = match;
            let content;
            try {
                if (resource === "status") {
                    content = await this.getPrinterStatus(host);
                }
                else if (resource === "files") {
                    content = await this.getPrinterFiles(host);
                }
                else if (resource.startsWith("file/")) {
                    const filename = resource.substring(5);
                    content = await this.getPrinterFile(host, filename);
                }
                else {
                    throw new McpError(ErrorCode.InvalidRequest, `Unknown resource: ${resource}`);
                }
                return {
                    contents: [
                        {
                            uri,
                            mimeType: resource.startsWith("file/") ? "application/gcode" : "application/json",
                            text: typeof content === "string" ? content : JSON.stringify(content, null, 2)
                        }
                    ]
                };
            }
            catch (error) {
                if (axios.isAxiosError(error)) {
                    throw new McpError(ErrorCode.InternalError, `API error: ${error.response?.data?.error || error.message}`);
                }
                throw error;
            }
        });
    }
    setupToolHandlers() {
        // List available tools
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            return {
                tools: [
                    {
                        name: "get_printer_status",
                        description: "Get the current status of the 3D printer",
                        inputSchema: {
                            type: "object",
                            properties: {
                                host: {
                                    type: "string",
                                    description: "Hostname or IP address of the printer (default: value from env)"
                                },
                                port: {
                                    type: "string",
                                    description: "Port of the printer API (default: value from env)"
                                },
                                type: {
                                    type: "string",
                                    description: "Type of printer management system (octoprint, klipper, duet, repetier, bambu) (default: value from env)"
                                },
                                api_key: {
                                    type: "string",
                                    description: "API key for authentication (default: value from env)"
                                },
                                bambu_serial: {
                                    type: "string",
                                    description: "Serial number for Bambu Lab printers (default: value from env)"
                                },
                                bambu_token: {
                                    type: "string",
                                    description: "Access token for Bambu Lab printers (default: value from env)"
                                }
                            }
                        }
                    },
                    {
                        name: "list_printer_files",
                        description: "List files available on the printer",
                        inputSchema: {
                            type: "object",
                            properties: {
                                host: {
                                    type: "string",
                                    description: "Hostname or IP address of the printer (default: value from env)"
                                },
                                port: {
                                    type: "string",
                                    description: "Port of the printer API (default: value from env)"
                                },
                                type: {
                                    type: "string",
                                    description: "Type of printer management system (octoprint, klipper, duet, repetier, bambu) (default: value from env)"
                                },
                                api_key: {
                                    type: "string",
                                    description: "API key for authentication (default: value from env)"
                                },
                                bambu_serial: {
                                    type: "string",
                                    description: "Serial number for Bambu Lab printers (default: value from env)"
                                },
                                bambu_token: {
                                    type: "string",
                                    description: "Access token for Bambu Lab printers (default: value from env)"
                                }
                            }
                        }
                    },
                    {
                        name: "upload_gcode",
                        description: "Upload a G-code file to the printer",
                        inputSchema: {
                            type: "object",
                            properties: {
                                host: {
                                    type: "string",
                                    description: "Hostname or IP address of the printer (default: value from env)"
                                },
                                port: {
                                    type: "string",
                                    description: "Port of the printer API (default: value from env)"
                                },
                                type: {
                                    type: "string",
                                    description: "Type of printer management system (octoprint, klipper, duet, repetier, bambu) (default: value from env)"
                                },
                                api_key: {
                                    type: "string",
                                    description: "API key for authentication (default: value from env)"
                                },
                                bambu_serial: {
                                    type: "string",
                                    description: "Serial number for Bambu Lab printers (default: value from env)"
                                },
                                bambu_token: {
                                    type: "string",
                                    description: "Access token for Bambu Lab printers (default: value from env)"
                                },
                                filename: {
                                    type: "string",
                                    description: "Name of the file to upload"
                                },
                                gcode: {
                                    type: "string",
                                    description: "G-code content to upload"
                                },
                                print: {
                                    type: "boolean",
                                    description: "Whether to start printing the file after upload (default: false)"
                                }
                            },
                            required: ["filename", "gcode"]
                        }
                    },
                    {
                        name: "start_print",
                        description: "Start printing a file that is already on the printer",
                        inputSchema: {
                            type: "object",
                            properties: {
                                host: {
                                    type: "string",
                                    description: "Hostname or IP address of the printer (default: value from env)"
                                },
                                port: {
                                    type: "string",
                                    description: "Port of the printer API (default: value from env)"
                                },
                                type: {
                                    type: "string",
                                    description: "Type of printer management system (octoprint, klipper, duet, repetier, bambu) (default: value from env)"
                                },
                                api_key: {
                                    type: "string",
                                    description: "API key for authentication (default: value from env)"
                                },
                                bambu_serial: {
                                    type: "string",
                                    description: "Serial number for Bambu Lab printers (default: value from env)"
                                },
                                bambu_token: {
                                    type: "string",
                                    description: "Access token for Bambu Lab printers (default: value from env)"
                                },
                                filename: {
                                    type: "string",
                                    description: "Name of the file to print"
                                }
                            },
                            required: ["filename"]
                        }
                    },
                    {
                        name: "cancel_print",
                        description: "Cancel the current print job",
                        inputSchema: {
                            type: "object",
                            properties: {
                                host: {
                                    type: "string",
                                    description: "Hostname or IP address of the printer (default: value from env)"
                                },
                                port: {
                                    type: "string",
                                    description: "Port of the printer API (default: value from env)"
                                },
                                type: {
                                    type: "string",
                                    description: "Type of printer management system (octoprint, klipper, duet, repetier, bambu) (default: value from env)"
                                },
                                api_key: {
                                    type: "string",
                                    description: "API key for authentication (default: value from env)"
                                },
                                bambu_serial: {
                                    type: "string",
                                    description: "Serial number for Bambu Lab printers (default: value from env)"
                                },
                                bambu_token: {
                                    type: "string",
                                    description: "Access token for Bambu Lab printers (default: value from env)"
                                }
                            }
                        }
                    },
                    {
                        name: "set_printer_temperature",
                        description: "Set the temperature of a printer component",
                        inputSchema: {
                            type: "object",
                            properties: {
                                host: {
                                    type: "string",
                                    description: "Hostname or IP address of the printer (default: value from env)"
                                },
                                port: {
                                    type: "string",
                                    description: "Port of the printer API (default: value from env)"
                                },
                                type: {
                                    type: "string",
                                    description: "Type of printer management system (octoprint, klipper, duet, repetier, bambu) (default: value from env)"
                                },
                                api_key: {
                                    type: "string",
                                    description: "API key for authentication (default: value from env)"
                                },
                                bambu_serial: {
                                    type: "string",
                                    description: "Serial number for Bambu Lab printers (default: value from env)"
                                },
                                bambu_token: {
                                    type: "string",
                                    description: "Access token for Bambu Lab printers (default: value from env)"
                                },
                                component: {
                                    type: "string",
                                    description: "Component to set temperature for (e.g., 'extruder', 'bed')"
                                },
                                temperature: {
                                    type: "number",
                                    description: "Temperature to set in degrees Celsius"
                                }
                            },
                            required: ["component", "temperature"]
                        }
                    }
                ]
            };
        });
        // Handle tool calls
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;
            // Set default values for common parameters
            const host = String(args?.host || DEFAULT_HOST);
            const port = String(args?.port || DEFAULT_PORT);
            const type = String(args?.type || DEFAULT_TYPE);
            const apiKey = String(args?.api_key || DEFAULT_API_KEY);
            const bambuSerial = String(args?.bambu_serial || DEFAULT_BAMBU_SERIAL);
            const bambuToken = String(args?.bambu_token || DEFAULT_BAMBU_TOKEN);
            try {
                let result;
                switch (name) {
                    case "get_printer_status":
                        result = await this.getPrinterStatus(host, port, type, apiKey, bambuSerial, bambuToken);
                        break;
                    case "list_printer_files":
                        result = await this.getPrinterFiles(host, port, type, apiKey, bambuSerial, bambuToken);
                        break;
                    case "upload_gcode":
                        if (!args?.filename || !args?.gcode) {
                            throw new Error("Missing required parameters: filename and gcode");
                        }
                        result = await this.uploadGcode(host, port, type, apiKey, bambuSerial, bambuToken, String(args.filename), String(args.gcode), Boolean(args.print || false));
                        break;
                    case "start_print":
                        if (!args?.filename) {
                            throw new Error("Missing required parameter: filename");
                        }
                        result = await this.startPrint(host, port, type, apiKey, bambuSerial, bambuToken, String(args.filename));
                        break;
                    case "cancel_print":
                        result = await this.cancelPrint(host, port, type, apiKey, bambuSerial, bambuToken);
                        break;
                    case "set_printer_temperature":
                        if (!args?.component || args?.temperature === undefined) {
                            throw new Error("Missing required parameters: component and temperature");
                        }
                        result = await this.setPrinterTemperature(host, port, type, apiKey, bambuSerial, bambuToken, String(args.component), Number(args.temperature));
                        break;
                    default:
                        throw new Error(`Unknown tool: ${name}`);
                }
                return {
                    content: [
                        {
                            type: "text",
                            text: typeof result === "string" ? result : JSON.stringify(result, null, 2)
                        }
                    ]
                };
            }
            catch (error) {
                console.error(`Error calling tool ${name}:`, error);
                const errorMessage = error instanceof Error ? error.message : String(error);
                return {
                    content: [
                        {
                            type: "text",
                            text: `Error: ${errorMessage}`
                        }
                    ],
                    isError: true
                };
            }
        });
    }
    // Get or create a Bambu printer
    getBambuPrinter(host, serial, token) {
        const key = `${host}-${serial}`;
        if (!this.bambuPrinters.has(key)) {
            const printer = new BambuPrinter(host, serial, token);
            this.bambuPrinters.set(key, printer);
        }
        return this.bambuPrinters.get(key);
    }
    // Resource and Tool Implementation Methods
    async getPrinterStatus(host, port = DEFAULT_PORT, type = DEFAULT_TYPE, apiKey = DEFAULT_API_KEY, bambuSerial = DEFAULT_BAMBU_SERIAL, bambuToken = DEFAULT_BAMBU_TOKEN) {
        switch (type.toLowerCase()) {
            case "octoprint":
                return this.getOctoPrintStatus(host, port, apiKey);
            case "klipper":
                return this.getKlipperStatus(host, port, apiKey);
            case "duet":
                return this.getDuetStatus(host, port, apiKey);
            case "repetier":
                return this.getRepetierStatus(host, port, apiKey);
            case "bambu":
                return this.getBambuStatus(host, bambuSerial, bambuToken);
            default:
                throw new Error(`Unsupported printer type: ${type}`);
        }
    }
    async getPrinterFiles(host, port = DEFAULT_PORT, type = DEFAULT_TYPE, apiKey = DEFAULT_API_KEY, bambuSerial = DEFAULT_BAMBU_SERIAL, bambuToken = DEFAULT_BAMBU_TOKEN) {
        switch (type.toLowerCase()) {
            case "octoprint":
                return this.getOctoPrintFiles(host, port, apiKey);
            case "klipper":
                return this.getKlipperFiles(host, port, apiKey);
            case "duet":
                return this.getDuetFiles(host, port, apiKey);
            case "repetier":
                return this.getRepetierFiles(host, port, apiKey);
            case "bambu":
                return this.getBambuFiles(host, bambuSerial, bambuToken);
            default:
                throw new Error(`Unsupported printer type: ${type}`);
        }
    }
    async getPrinterFile(host, filename, port = DEFAULT_PORT, type = DEFAULT_TYPE, apiKey = DEFAULT_API_KEY, bambuSerial = DEFAULT_BAMBU_SERIAL, bambuToken = DEFAULT_BAMBU_TOKEN) {
        switch (type.toLowerCase()) {
            case "octoprint":
                return this.getOctoPrintFile(host, port, apiKey, filename);
            case "klipper":
                return this.getKlipperFile(host, port, apiKey, filename);
            case "duet":
                return this.getDuetFile(host, port, apiKey, filename);
            case "repetier":
                return this.getRepetierFile(host, port, apiKey, filename);
            case "bambu":
                return this.getBambuFile(host, bambuSerial, bambuToken, filename);
            default:
                throw new Error(`Unsupported printer type: ${type}`);
        }
    }
    async uploadGcode(host, port, type, apiKey, bambuSerial, bambuToken, filename, gcode, print) {
        const tempFilePath = path.join(TEMP_DIR, filename);
        // Write gcode to temporary file
        fs.writeFileSync(tempFilePath, gcode);
        try {
            switch (type.toLowerCase()) {
                case "octoprint":
                    return await this.uploadToOctoPrint(host, port, apiKey, tempFilePath, filename, print);
                case "klipper":
                    return await this.uploadToKlipper(host, port, apiKey, tempFilePath, filename, print);
                case "duet":
                    return await this.uploadToDuet(host, port, apiKey, tempFilePath, filename, print);
                case "repetier":
                    return await this.uploadToRepetier(host, port, apiKey, tempFilePath, filename, print);
                case "bambu":
                    return await this.uploadToBambu(host, bambuSerial, bambuToken, tempFilePath, filename, print);
                default:
                    throw new Error(`Unsupported printer type: ${type}`);
            }
        }
        finally {
            // Clean up temporary file
            if (fs.existsSync(tempFilePath)) {
                fs.unlinkSync(tempFilePath);
            }
        }
    }
    async startPrint(host, port, type, apiKey, bambuSerial, bambuToken, filename) {
        switch (type.toLowerCase()) {
            case "octoprint":
                return await this.startOctoPrintJob(host, port, apiKey, filename);
            case "klipper":
                return await this.startKlipperJob(host, port, apiKey, filename);
            case "duet":
                return await this.startDuetJob(host, port, apiKey, filename);
            case "repetier":
                return await this.startRepetierJob(host, port, apiKey, filename);
            case "bambu":
                return await this.startBambuJob(host, bambuSerial, bambuToken, filename);
            default:
                throw new Error(`Unsupported printer type: ${type}`);
        }
    }
    async cancelPrint(host, port, type, apiKey, bambuSerial, bambuToken) {
        switch (type.toLowerCase()) {
            case "octoprint":
                return await this.cancelOctoPrintJob(host, port, apiKey);
            case "klipper":
                return await this.cancelKlipperJob(host, port, apiKey);
            case "duet":
                return await this.cancelDuetJob(host, port, apiKey);
            case "repetier":
                return await this.cancelRepetierJob(host, port, apiKey);
            case "bambu":
                return await this.cancelBambuJob(host, bambuSerial, bambuToken);
            default:
                throw new Error(`Unsupported printer type: ${type}`);
        }
    }
    async setPrinterTemperature(host, port, type, apiKey, bambuSerial, bambuToken, component, temperature) {
        switch (type.toLowerCase()) {
            case "octoprint":
                return await this.setOctoPrintTemperature(host, port, apiKey, component, temperature);
            case "klipper":
                return await this.setKlipperTemperature(host, port, apiKey, component, temperature);
            case "duet":
                return await this.setDuetTemperature(host, port, apiKey, component, temperature);
            case "repetier":
                return await this.setRepetierTemperature(host, port, apiKey, component, temperature);
            case "bambu":
                return await this.setBambuTemperature(host, bambuSerial, bambuToken, component, temperature);
            default:
                throw new Error(`Unsupported printer type: ${type}`);
        }
    }
    // Bambu Labs API Implementation
    async getBambuStatus(host, serial, token) {
        const printer = this.getBambuPrinter(host, serial, token);
        // Connect if not already connected
        if (!printer.isConnected) {
            await printer.connect();
            // Wait for initial state
            await printer.awaitInitialState(10000); // 10 second timeout
        }
        return printer.getState();
    }
    async getBambuFiles(host, serial, token) {
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
    async getBambuFile(host, serial, token, filename) {
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
    async uploadToBambu(host, serial, token, filePath, filename, print) {
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
    async startBambuJob(host, serial, token, filename) {
        // Starting a job requires more information for Bambu printers
        // This is a simplified implementation - in reality, we need
        // more details about the 3MF project file structure
        throw new Error("Starting a print job on Bambu printers requires more information about the file structure");
    }
    async cancelBambuJob(host, serial, token) {
        const printer = this.getBambuPrinter(host, serial, token);
        // Connect if not already connected
        if (!printer.isConnected) {
            await printer.connect();
        }
        // Cancel print
        printer.stop();
        return { status: "success", message: "Print job cancelled" };
    }
    async setBambuTemperature(host, serial, token, component, temperature) {
        // Bambu API doesn't have direct temperature controls
        // We would need to send custom G-code commands
        throw new Error("Setting temperatures directly is not supported via the Bambu API");
    }
    // OctoPrint API Implementation
    async getOctoPrintStatus(host, port, apiKey) {
        const url = `http://${host}:${port}/api/printer`;
        const response = await this.apiClient.get(url, {
            headers: {
                "X-Api-Key": apiKey
            }
        });
        return response.data;
    }
    async getOctoPrintFiles(host, port, apiKey) {
        const url = `http://${host}:${port}/api/files`;
        const response = await this.apiClient.get(url, {
            headers: {
                "X-Api-Key": apiKey
            }
        });
        return response.data;
    }
    async getOctoPrintFile(host, port, apiKey, filename) {
        const url = `http://${host}:${port}/api/files/local/${filename}`;
        const response = await this.apiClient.get(url, {
            headers: {
                "X-Api-Key": apiKey
            }
        });
        return response.data;
    }
    async uploadToOctoPrint(host, port, apiKey, filePath, filename, print) {
        const url = `http://${host}:${port}/api/files/local`;
        const formData = new FormData();
        formData.append("file", fs.createReadStream(filePath));
        formData.append("filename", filename);
        if (print) {
            formData.append("print", "true");
        }
        const response = await this.apiClient.post(url, formData, {
            headers: {
                "X-Api-Key": apiKey,
                ...formData.getHeaders()
            }
        });
        return response.data;
    }
    async startOctoPrintJob(host, port, apiKey, filename) {
        const url = `http://${host}:${port}/api/files/local/${filename}`;
        const response = await this.apiClient.post(url, {
            command: "select",
            print: true
        }, {
            headers: {
                "X-Api-Key": apiKey,
                "Content-Type": "application/json"
            }
        });
        return response.data;
    }
    async cancelOctoPrintJob(host, port, apiKey) {
        const url = `http://${host}:${port}/api/job`;
        const response = await this.apiClient.post(url, {
            command: "cancel"
        }, {
            headers: {
                "X-Api-Key": apiKey,
                "Content-Type": "application/json"
            }
        });
        return response.data;
    }
    async setOctoPrintTemperature(host, port, apiKey, component, temperature) {
        let url = `http://${host}:${port}/api/printer/tool`;
        const data = {};
        if (component === "bed") {
            data.command = "target";
            data.target = temperature;
            url = `http://${host}:${port}/api/printer/bed`;
        }
        else if (component.startsWith("extruder")) {
            data.command = "target";
            data.targets = {};
            data.targets[component] = temperature;
        }
        else {
            throw new Error(`Unsupported component: ${component}`);
        }
        const response = await this.apiClient.post(url, data, {
            headers: {
                "X-Api-Key": apiKey,
                "Content-Type": "application/json"
            }
        });
        return response.data;
    }
    // Klipper API Implementation (via Moonraker)
    async getKlipperStatus(host, port, apiKey) {
        const url = `http://${host}:${port}/printer/info`;
        const response = await this.apiClient.get(url);
        return response.data;
    }
    async getKlipperFiles(host, port, apiKey) {
        const url = `http://${host}:${port}/server/files/list`;
        const response = await this.apiClient.get(url);
        return response.data;
    }
    async getKlipperFile(host, port, apiKey, filename) {
        const url = `http://${host}:${port}/server/files/metadata?filename=${encodeURIComponent(filename)}`;
        const response = await this.apiClient.get(url);
        return response.data;
    }
    async uploadToKlipper(host, port, apiKey, filePath, filename, print) {
        const url = `http://${host}:${port}/server/files/upload`;
        const formData = new FormData();
        formData.append("file", fs.createReadStream(filePath));
        formData.append("filename", filename);
        const response = await this.apiClient.post(url, formData, {
            headers: {
                ...formData.getHeaders()
            }
        });
        if (print && response.data.result === "success") {
            await this.startKlipperJob(host, port, apiKey, filename);
        }
        return response.data;
    }
    async startKlipperJob(host, port, apiKey, filename) {
        const url = `http://${host}:${port}/printer/print/start`;
        const response = await this.apiClient.post(url, { filename });
        return response.data;
    }
    async cancelKlipperJob(host, port, apiKey) {
        const url = `http://${host}:${port}/printer/print/cancel`;
        const response = await this.apiClient.post(url, null);
        return response.data;
    }
    async setKlipperTemperature(host, port, apiKey, component, temperature) {
        const url = `http://${host}:${port}/printer/gcode/script`;
        let gcode;
        if (component === "bed") {
            gcode = `SET_HEATER_TEMPERATURE HEATER=heater_bed TARGET=${temperature}`;
        }
        else if (component === "extruder") {
            gcode = `SET_HEATER_TEMPERATURE HEATER=extruder TARGET=${temperature}`;
        }
        else {
            throw new Error(`Unsupported component: ${component}`);
        }
        const response = await this.apiClient.post(url, {
            script: gcode
        });
        return response.data;
    }
    // Duet API Implementation
    async getDuetStatus(host, port, apiKey) {
        const url = `http://${host}:${port}/machine/status`;
        const response = await this.apiClient.get(url);
        return response.data;
    }
    async getDuetFiles(host, port, apiKey) {
        const url = `http://${host}:${port}/machine/file-list`;
        const response = await this.apiClient.get(url);
        return response.data;
    }
    async getDuetFile(host, port, apiKey, filename) {
        const url = `http://${host}:${port}/machine/file/${encodeURIComponent(filename)}`;
        const response = await this.apiClient.get(url);
        return response.data;
    }
    async uploadToDuet(host, port, apiKey, filePath, filename, print) {
        const url = `http://${host}:${port}/machine/file-upload`;
        const formData = new FormData();
        formData.append("file", fs.createReadStream(filePath));
        formData.append("filename", filename);
        const response = await this.apiClient.post(url, formData, {
            headers: {
                ...formData.getHeaders()
            }
        });
        if (print && response.data.err === 0) {
            await this.startDuetJob(host, port, apiKey, filename);
        }
        return response.data;
    }
    async startDuetJob(host, port, apiKey, filename) {
        const url = `http://${host}:${port}/machine/code`;
        const response = await this.apiClient.post(url, {
            code: `M32 "${filename}"`
        });
        return response.data;
    }
    async cancelDuetJob(host, port, apiKey) {
        const url = `http://${host}:${port}/machine/code`;
        const response = await this.apiClient.post(url, {
            code: "M0"
        });
        return response.data;
    }
    async setDuetTemperature(host, port, apiKey, component, temperature) {
        const url = `http://${host}:${port}/machine/code`;
        let gcode;
        if (component === "bed") {
            gcode = `M140 S${temperature}`;
        }
        else if (component === "extruder") {
            gcode = `M104 S${temperature}`;
        }
        else {
            throw new Error(`Unsupported component: ${component}`);
        }
        const response = await this.apiClient.post(url, {
            code: gcode
        });
        return response.data;
    }
    // Repetier API Implementation
    async getRepetierStatus(host, port, apiKey) {
        const url = `http://${host}:${port}/printer/api/?a=getPrinterInfo&apikey=${apiKey}`;
        const response = await this.apiClient.get(url);
        return response.data;
    }
    async getRepetierFiles(host, port, apiKey) {
        const url = `http://${host}:${port}/printer/api/?a=ls&apikey=${apiKey}`;
        const response = await this.apiClient.get(url);
        return response.data;
    }
    async getRepetierFile(host, port, apiKey, filename) {
        const url = `http://${host}:${port}/printer/api/?a=getFileInfo&apikey=${apiKey}&filename=${encodeURIComponent(filename)}`;
        const response = await this.apiClient.get(url);
        return response.data;
    }
    async uploadToRepetier(host, port, apiKey, filePath, filename, print) {
        const url = `http://${host}:${port}/printer/api/`;
        const formData = new FormData();
        formData.append("a", "upload");
        formData.append("apikey", apiKey);
        formData.append("filename", filename);
        formData.append("print", print ? "1" : "0");
        formData.append("file", fs.createReadStream(filePath));
        const response = await this.apiClient.post(url, formData, {
            headers: {
                ...formData.getHeaders()
            }
        });
        return response.data;
    }
    async startRepetierJob(host, port, apiKey, filename) {
        const url = `http://${host}:${port}/printer/api/?a=startJob&apikey=${apiKey}&filename=${encodeURIComponent(filename)}`;
        const response = await this.apiClient.get(url);
        return response.data;
    }
    async cancelRepetierJob(host, port, apiKey) {
        const url = `http://${host}:${port}/printer/api/?a=stopJob&apikey=${apiKey}`;
        const response = await this.apiClient.get(url);
        return response.data;
    }
    async setRepetierTemperature(host, port, apiKey, component, temperature) {
        let url;
        if (component === "bed") {
            url = `http://${host}:${port}/printer/api/?a=setBedTemp&apikey=${apiKey}&temp=${temperature}`;
        }
        else if (component === "extruder") {
            url = `http://${host}:${port}/printer/api/?a=setExtruderTemp&apikey=${apiKey}&temp=${temperature}`;
        }
        else {
            throw new Error(`Unsupported component: ${component}`);
        }
        const response = await this.apiClient.get(url);
        return response.data;
    }
    async run() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error("3D Printer MCP server running on stdio transport");
    }
}
const server = new ThreeDPrinterMCPServer();
server.run().catch(console.error);
