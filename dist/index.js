#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListResourcesRequestSchema, ReadResourceRequestSchema, ListToolsRequestSchema, CallToolRequestSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { PrinterFactory } from "./printers/printer-factory.js";
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
        this.server = new Server({
            name: "mcp-3d-printer-server",
            version: "1.0.0"
        }, {
            capabilities: {
                resources: {},
                tools: {}
            }
        });
        this.printerFactory = new PrinterFactory();
        this.setupHandlers();
        this.setupErrorHandling();
    }
    setupErrorHandling() {
        this.server.onerror = (error) => {
            console.error("[MCP Error]", error);
        };
        process.on("SIGINT", async () => {
            // Disconnect all printers
            await this.printerFactory.disconnectAll();
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
                                    description: "Type of printer management system (octoprint, klipper, duet, repetier, bambu, prusa, creality) (default: value from env)"
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
                    // ...other tools with similar structure
                    // Abbreviated for clarity, would include all other tools
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
    // Delegating methods to printer implementations
    async getPrinterStatus(host, port = DEFAULT_PORT, type = DEFAULT_TYPE, apiKey = DEFAULT_API_KEY, bambuSerial = DEFAULT_BAMBU_SERIAL, bambuToken = DEFAULT_BAMBU_TOKEN) {
        const implementation = this.printerFactory.getImplementation(type);
        if (type.toLowerCase() === "bambu") {
            const bambuApiKey = `${bambuSerial}:${bambuToken}`;
            return implementation.getStatus(host, port, bambuApiKey);
        }
        return implementation.getStatus(host, port, apiKey);
    }
    async getPrinterFiles(host, port = DEFAULT_PORT, type = DEFAULT_TYPE, apiKey = DEFAULT_API_KEY, bambuSerial = DEFAULT_BAMBU_SERIAL, bambuToken = DEFAULT_BAMBU_TOKEN) {
        const implementation = this.printerFactory.getImplementation(type);
        if (type.toLowerCase() === "bambu") {
            const bambuApiKey = `${bambuSerial}:${bambuToken}`;
            return implementation.getFiles(host, port, bambuApiKey);
        }
        return implementation.getFiles(host, port, apiKey);
    }
    async getPrinterFile(host, filename, port = DEFAULT_PORT, type = DEFAULT_TYPE, apiKey = DEFAULT_API_KEY, bambuSerial = DEFAULT_BAMBU_SERIAL, bambuToken = DEFAULT_BAMBU_TOKEN) {
        const implementation = this.printerFactory.getImplementation(type);
        if (type.toLowerCase() === "bambu") {
            return implementation.getFile(host, port, apiKey, bambuSerial, bambuToken, filename);
        }
        return implementation.getFile(host, port, apiKey, filename);
    }
    async uploadGcode(host, port, type, apiKey, bambuSerial, bambuToken, filename, gcode, print) {
        const tempFilePath = path.join(TEMP_DIR, filename);
        // Write gcode to temporary file
        fs.writeFileSync(tempFilePath, gcode);
        try {
            const implementation = this.printerFactory.getImplementation(type);
            if (type.toLowerCase() === "bambu") {
                return await implementation.uploadFile(host, port, apiKey, bambuSerial, bambuToken, tempFilePath, filename, print);
            }
            return await implementation.uploadFile(host, port, apiKey, tempFilePath, filename, print);
        }
        finally {
            // Clean up temporary file
            if (fs.existsSync(tempFilePath)) {
                fs.unlinkSync(tempFilePath);
            }
        }
    }
    async startPrint(host, port, type, apiKey, bambuSerial, bambuToken, filename) {
        const implementation = this.printerFactory.getImplementation(type);
        if (type.toLowerCase() === "bambu") {
            return await implementation.startJob(host, port, apiKey, bambuSerial, bambuToken, filename);
        }
        return await implementation.startJob(host, port, apiKey, filename);
    }
    async cancelPrint(host, port, type, apiKey, bambuSerial, bambuToken) {
        const implementation = this.printerFactory.getImplementation(type);
        if (type.toLowerCase() === "bambu") {
            return await implementation.cancelJob(host, port, apiKey, bambuSerial, bambuToken);
        }
        return await implementation.cancelJob(host, port, apiKey);
    }
    async setPrinterTemperature(host, port, type, apiKey, bambuSerial, bambuToken, component, temperature) {
        const implementation = this.printerFactory.getImplementation(type);
        if (type.toLowerCase() === "bambu") {
            return await implementation.setTemperature(host, port, apiKey, bambuSerial, bambuToken, component, temperature);
        }
        return await implementation.setTemperature(host, port, apiKey, component, temperature);
    }
    async run() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error("3D Printer MCP server running on stdio transport");
    }
}
const server = new ThreeDPrinterMCPServer();
server.run().catch(console.error);
