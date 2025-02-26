#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListResourcesRequestSchema, ReadResourceRequestSchema, ListToolsRequestSchema, CallToolRequestSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import * as THREE from 'three';
import { PrinterFactory } from "./printers/printer-factory.js";
import { STLManipulator } from "./stl/stl-manipulator.js";
// Load environment variables from .env file
dotenv.config();
// Default values
const DEFAULT_HOST = process.env.PRINTER_HOST || "localhost";
const DEFAULT_PORT = process.env.PRINTER_PORT || "80";
const DEFAULT_API_KEY = process.env.API_KEY || "";
const DEFAULT_TYPE = process.env.PRINTER_TYPE || "octoprint"; // Default to OctoPrint
const TEMP_DIR = process.env.TEMP_DIR || path.join(process.cwd(), "temp");
// Slicer configuration
const DEFAULT_SLICER_TYPE = process.env.SLICER_TYPE || "prusaslicer";
const DEFAULT_SLICER_PATH = process.env.SLICER_PATH || "";
const DEFAULT_SLICER_PROFILE = process.env.SLICER_PROFILE || "";
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
        this.stlManipulator = new STLManipulator(TEMP_DIR);
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
                    // New STL manipulation tools
                    {
                        name: "extend_stl_base",
                        description: "Extend the base of an STL file by a specified amount",
                        inputSchema: {
                            type: "object",
                            properties: {
                                stl_path: {
                                    type: "string",
                                    description: "Path to the STL file to modify"
                                },
                                extension_inches: {
                                    type: "number",
                                    description: "Amount to extend the base in inches"
                                }
                            },
                            required: ["stl_path", "extension_inches"]
                        }
                    },
                    {
                        name: "slice_stl",
                        description: "Slice an STL file to generate G-code",
                        inputSchema: {
                            type: "object",
                            properties: {
                                stl_path: {
                                    type: "string",
                                    description: "Path to the STL file to slice"
                                },
                                slicer_type: {
                                    type: "string",
                                    description: "Type of slicer to use (prusaslicer, cura, slic3r) (default: value from env)"
                                },
                                slicer_path: {
                                    type: "string",
                                    description: "Path to the slicer executable (default: value from env)"
                                },
                                slicer_profile: {
                                    type: "string",
                                    description: "Profile to use for slicing (default: value from env)"
                                }
                            },
                            required: ["stl_path"]
                        }
                    },
                    {
                        name: "confirm_temperatures",
                        description: "Confirm temperature settings in a G-code file",
                        inputSchema: {
                            type: "object",
                            properties: {
                                gcode_path: {
                                    type: "string",
                                    description: "Path to the G-code file"
                                },
                                extruder_temp: {
                                    type: "number",
                                    description: "Expected extruder temperature"
                                },
                                bed_temp: {
                                    type: "number",
                                    description: "Expected bed temperature"
                                }
                            },
                            required: ["gcode_path"]
                        }
                    },
                    {
                        name: "process_and_print_stl",
                        description: "Process an STL file (extend base), slice it, confirm temperatures, and start printing",
                        inputSchema: {
                            type: "object",
                            properties: {
                                stl_path: {
                                    type: "string",
                                    description: "Path to the STL file to process"
                                },
                                extension_inches: {
                                    type: "number",
                                    description: "Amount to extend the base in inches"
                                },
                                extruder_temp: {
                                    type: "number",
                                    description: "Expected extruder temperature"
                                },
                                bed_temp: {
                                    type: "number",
                                    description: "Expected bed temperature"
                                },
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
                                    description: "Type of printer management system (default: value from env)"
                                },
                                api_key: {
                                    type: "string",
                                    description: "API key for authentication (default: value from env)"
                                }
                            },
                            required: ["stl_path", "extension_inches"]
                        }
                    },
                    // New STL manipulation tools
                    {
                        name: "get_stl_info",
                        description: "Get detailed information about an STL file",
                        inputSchema: {
                            type: "object",
                            properties: {
                                stl_path: {
                                    type: "string",
                                    description: "Path to the STL file"
                                }
                            },
                            required: ["stl_path"]
                        }
                    },
                    {
                        name: "scale_stl",
                        description: "Scale an STL model uniformly or along specific axes",
                        inputSchema: {
                            type: "object",
                            properties: {
                                stl_path: {
                                    type: "string",
                                    description: "Path to the STL file"
                                },
                                scale_factor: {
                                    type: "number",
                                    description: "Uniform scaling factor to apply"
                                },
                                scale_x: {
                                    type: "number",
                                    description: "X-axis scaling factor (overrides scale_factor for X axis)"
                                },
                                scale_y: {
                                    type: "number",
                                    description: "Y-axis scaling factor (overrides scale_factor for Y axis)"
                                },
                                scale_z: {
                                    type: "number",
                                    description: "Z-axis scaling factor (overrides scale_factor for Z axis)"
                                }
                            },
                            required: ["stl_path"]
                        }
                    },
                    {
                        name: "rotate_stl",
                        description: "Rotate an STL model around specific axes",
                        inputSchema: {
                            type: "object",
                            properties: {
                                stl_path: {
                                    type: "string",
                                    description: "Path to the STL file"
                                },
                                rotate_x: {
                                    type: "number",
                                    description: "Rotation around X-axis in degrees"
                                },
                                rotate_y: {
                                    type: "number",
                                    description: "Rotation around Y-axis in degrees"
                                },
                                rotate_z: {
                                    type: "number",
                                    description: "Rotation around Z-axis in degrees"
                                }
                            },
                            required: ["stl_path"]
                        }
                    },
                    {
                        name: "translate_stl",
                        description: "Move an STL model along specific axes",
                        inputSchema: {
                            type: "object",
                            properties: {
                                stl_path: {
                                    type: "string",
                                    description: "Path to the STL file"
                                },
                                translate_x: {
                                    type: "number",
                                    description: "Translation along X-axis in millimeters"
                                },
                                translate_y: {
                                    type: "number",
                                    description: "Translation along Y-axis in millimeters"
                                },
                                translate_z: {
                                    type: "number",
                                    description: "Translation along Z-axis in millimeters"
                                }
                            },
                            required: ["stl_path"]
                        }
                    },
                    {
                        name: "modify_stl_section",
                        description: "Apply a specific transformation to a selected section of an STL file",
                        inputSchema: {
                            type: "object",
                            properties: {
                                stl_path: {
                                    type: "string",
                                    description: "Path to the STL file"
                                },
                                section: {
                                    type: "string",
                                    description: "Section to modify: 'top', 'bottom', 'center', or custom bounds",
                                    enum: ["top", "bottom", "center", "custom"]
                                },
                                transformation_type: {
                                    type: "string",
                                    description: "Type of transformation to apply",
                                    enum: ["scale", "rotate", "translate"]
                                },
                                value_x: {
                                    type: "number",
                                    description: "Transformation value for X axis"
                                },
                                value_y: {
                                    type: "number",
                                    description: "Transformation value for Y axis"
                                },
                                value_z: {
                                    type: "number",
                                    description: "Transformation value for Z axis"
                                },
                                custom_min_x: {
                                    type: "number",
                                    description: "Minimum X for custom section bounds"
                                },
                                custom_min_y: {
                                    type: "number",
                                    description: "Minimum Y for custom section bounds"
                                },
                                custom_min_z: {
                                    type: "number",
                                    description: "Minimum Z for custom section bounds"
                                },
                                custom_max_x: {
                                    type: "number",
                                    description: "Maximum X for custom section bounds"
                                },
                                custom_max_y: {
                                    type: "number",
                                    description: "Maximum Y for custom section bounds"
                                },
                                custom_max_z: {
                                    type: "number",
                                    description: "Maximum Z for custom section bounds"
                                }
                            },
                            required: ["stl_path", "section", "transformation_type"]
                        }
                    },
                    {
                        name: "generate_stl_visualization",
                        description: "Generate an SVG visualization of an STL file from multiple angles",
                        inputSchema: {
                            type: "object",
                            properties: {
                                stl_path: {
                                    type: "string",
                                    description: "Path to the STL file"
                                },
                                width: {
                                    type: "number",
                                    description: "Width of each view in pixels (default: 300)"
                                },
                                height: {
                                    type: "number",
                                    description: "Height of each view in pixels (default: 300)"
                                }
                            },
                            required: ["stl_path"]
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
            const slicerType = String(args?.slicer_type || DEFAULT_SLICER_TYPE);
            const slicerPath = String(args?.slicer_path || DEFAULT_SLICER_PATH);
            const slicerProfile = String(args?.slicer_profile || DEFAULT_SLICER_PROFILE);
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
                    // New STL manipulation tools
                    case "extend_stl_base":
                        if (!args?.stl_path || args?.extension_inches === undefined) {
                            throw new Error("Missing required parameters: stl_path and extension_inches");
                        }
                        result = await this.stlManipulator.extendBase(String(args.stl_path), Number(args.extension_inches));
                        break;
                    case "slice_stl":
                        if (!args?.stl_path) {
                            throw new Error("Missing required parameter: stl_path");
                        }
                        result = await this.stlManipulator.sliceSTL(String(args.stl_path), slicerType, slicerPath, slicerProfile || undefined);
                        break;
                    case "confirm_temperatures":
                        if (!args?.gcode_path) {
                            throw new Error("Missing required parameter: gcode_path");
                        }
                        result = await this.stlManipulator.confirmTemperatures(String(args.gcode_path), {
                            extruder: args.extruder_temp !== undefined ? Number(args.extruder_temp) : undefined,
                            bed: args.bed_temp !== undefined ? Number(args.bed_temp) : undefined
                        });
                        break;
                    case "process_and_print_stl":
                        if (!args?.stl_path || args?.extension_inches === undefined) {
                            throw new Error("Missing required parameters: stl_path and extension_inches");
                        }
                        // Define progress callback for UI updates
                        const processProgressCallback = (progress, message) => {
                            console.log(`Process progress: ${progress}% - ${message || ''}`);
                        };
                        // 1. Extend the base of the STL file
                        const extendedStlPath = await this.stlManipulator.extendBase(String(args.stl_path), Number(args.extension_inches), processProgressCallback);
                        // 2. Slice the extended STL file
                        const gcodePath = await this.stlManipulator.sliceSTL(extendedStlPath, slicerType, slicerPath, slicerProfile || undefined, processProgressCallback);
                        // 3. Confirm temperatures if specified
                        if (args.extruder_temp !== undefined || args.bed_temp !== undefined) {
                            const tempConfirmation = await this.stlManipulator.confirmTemperatures(gcodePath, {
                                extruder: args.extruder_temp !== undefined ? Number(args.extruder_temp) : undefined,
                                bed: args.bed_temp !== undefined ? Number(args.bed_temp) : undefined
                            }, processProgressCallback);
                            if (!tempConfirmation.match) {
                                console.warn("Temperature mismatch:", tempConfirmation);
                            }
                        }
                        // 4. Upload the G-code file to the printer
                        const gcodeContent = await fs.promises.readFile(gcodePath, 'utf8');
                        const filename = path.basename(gcodePath);
                        await this.uploadGcode(host, port, type, apiKey, bambuSerial, bambuToken, filename, gcodeContent, true // Start printing immediately
                        );
                        result = {
                            extended_stl_path: extendedStlPath,
                            gcode_path: gcodePath,
                            filename,
                            status: "Print job started"
                        };
                        break;
                    // New STL manipulation tool handlers
                    case "get_stl_info":
                        if (!args?.stl_path) {
                            throw new Error("Missing required parameter: stl_path");
                        }
                        result = await this.stlManipulator.getSTLInfo(String(args.stl_path));
                        break;
                    case "scale_stl":
                        if (!args?.stl_path) {
                            throw new Error("Missing required parameter: stl_path");
                        }
                        // Define progress callback for UI updates
                        const scaleProgressCallback = (progress, message) => {
                            console.log(`Scale progress: ${progress}% - ${message || ''}`);
                        };
                        let scaleFactors;
                        // Check if we have individual axis scaling factors
                        if (args.scale_x !== undefined || args.scale_y !== undefined || args.scale_z !== undefined) {
                            // Use individual axis scaling
                            scaleFactors = [
                                Number(args.scale_x ?? 1.0),
                                Number(args.scale_y ?? 1.0),
                                Number(args.scale_z ?? 1.0)
                            ];
                        }
                        else {
                            // Use uniform scaling
                            scaleFactors = Number(args.scale_factor ?? 1.0);
                        }
                        result = await this.stlManipulator.scaleSTL(String(args.stl_path), scaleFactors, scaleProgressCallback);
                        break;
                    case "rotate_stl":
                        if (!args?.stl_path) {
                            throw new Error("Missing required parameter: stl_path");
                        }
                        // Define progress callback for UI updates
                        const rotateProgressCallback = (progress, message) => {
                            console.log(`Rotate progress: ${progress}% - ${message || ''}`);
                        };
                        // Get rotation angles, defaulting to 0 for any undefined axis
                        const rotationAngles = [
                            Number(args.rotate_x ?? 0),
                            Number(args.rotate_y ?? 0),
                            Number(args.rotate_z ?? 0)
                        ];
                        result = await this.stlManipulator.rotateSTL(String(args.stl_path), rotationAngles, rotateProgressCallback);
                        break;
                    case "translate_stl":
                        if (!args?.stl_path) {
                            throw new Error("Missing required parameter: stl_path");
                        }
                        // Define progress callback for UI updates
                        const translateProgressCallback = (progress, message) => {
                            console.log(`Translate progress: ${progress}% - ${message || ''}`);
                        };
                        // Get translation values, defaulting to 0 for any undefined axis
                        const translationValues = [
                            Number(args.translate_x ?? 0),
                            Number(args.translate_y ?? 0),
                            Number(args.translate_z ?? 0)
                        ];
                        result = await this.stlManipulator.translateSTL(String(args.stl_path), translationValues, translateProgressCallback);
                        break;
                    case "modify_stl_section":
                        if (!args?.stl_path || !args?.section || !args?.transformation_type) {
                            throw new Error("Missing required parameters: stl_path, section, and transformation_type");
                        }
                        // Define progress callback for UI updates
                        const modifySectionProgressCallback = (progress, message) => {
                            console.log(`Modify section progress: ${progress}% - ${message || ''}`);
                        };
                        // Determine the section to modify
                        let sectionBox;
                        if (args.section === 'custom') {
                            // Create a custom bounding box from the provided bounds
                            if (args.custom_min_x === undefined || args.custom_min_y === undefined ||
                                args.custom_min_z === undefined || args.custom_max_x === undefined ||
                                args.custom_max_y === undefined || args.custom_max_z === undefined) {
                                throw new Error("Custom section requires all min/max bounds to be specified");
                            }
                            sectionBox = new THREE.Box3(new THREE.Vector3(Number(args.custom_min_x), Number(args.custom_min_y), Number(args.custom_min_z)), new THREE.Vector3(Number(args.custom_max_x), Number(args.custom_max_y), Number(args.custom_max_z)));
                        }
                        else {
                            // Use a predefined section
                            sectionBox = String(args.section);
                        }
                        // Determine the transformation to apply
                        const transformationType = String(args.transformation_type);
                        let transformationValue;
                        if (transformationType === 'scale') {
                            if (args.value_x !== undefined || args.value_y !== undefined || args.value_z !== undefined) {
                                transformationValue = [
                                    Number(args.value_x ?? 1.0),
                                    Number(args.value_y ?? 1.0),
                                    Number(args.value_z ?? 1.0)
                                ];
                            }
                            else {
                                transformationValue = 1.0; // Default scale factor
                            }
                        }
                        else if (transformationType === 'rotate') {
                            transformationValue = [
                                Number(args.value_x ?? 0),
                                Number(args.value_y ?? 0),
                                Number(args.value_z ?? 0)
                            ];
                        }
                        else { // translate
                            transformationValue = [
                                Number(args.value_x ?? 0),
                                Number(args.value_y ?? 0),
                                Number(args.value_z ?? 0)
                            ];
                        }
                        result = await this.stlManipulator.modifySection(String(args.stl_path), sectionBox, {
                            type: transformationType,
                            value: transformationValue
                        }, modifySectionProgressCallback);
                        break;
                    case "generate_stl_visualization":
                        if (!args?.stl_path) {
                            throw new Error("Missing required parameter: stl_path");
                        }
                        // Define progress callback for UI updates
                        const visualizationProgressCallback = (progress, message) => {
                            console.log(`Visualization progress: ${progress}% - ${message || ''}`);
                        };
                        // Get width and height parameters, with defaults
                        const width = args.width !== undefined ? Number(args.width) : 300;
                        const height = args.height !== undefined ? Number(args.height) : 300;
                        result = await this.stlManipulator.generateVisualization(String(args.stl_path), width, height, visualizationProgressCallback);
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
