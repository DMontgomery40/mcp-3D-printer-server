#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ErrorCode,
  McpError
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import os from "node:os";
import { BlenderMcpBridge } from "./blender-mcp-bridge.js";
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import * as THREE from 'three';
import { PrinterFactory } from "./printers/printer-factory.js";
import { STLManipulator } from "./stl/stl-manipulator.js";
import { parse3MF, ThreeMFData } from './3mf_parser.js';
import { BambuImplementation } from "./printers/bambu.js";
import {
  inspectFuluOrcaSetup,
  invokeFuluBridgeRpc,
  isFuluPrintRpcMethod,
} from "./fulu-orca.js";

// Load environment variables from .env file
dotenv.config();

// Default values
const DEFAULT_HOST = process.env.PRINTER_HOST || "localhost";
const DEFAULT_PORT = process.env.PRINTER_PORT || "80";
const DEFAULT_API_KEY = process.env.API_KEY || "";
const DEFAULT_TYPE = process.env.PRINTER_TYPE || "octoprint"; // Default to OctoPrint
const TEMP_DIR = process.env.TEMP_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "mcp-3d-printer-server-"));

// Slicer configuration
const CANONICAL_SLICER_TYPES = [
  "prusaslicer",
  "cura",
  "slic3r",
  "orcaslicer",
  "orcaslicer-bambulab",
  "bambustudio",
] as const;
type SlicerType = typeof CANONICAL_SLICER_TYPES[number];

const SLICER_TYPE_ALIASES: Record<string, SlicerType> = {
  prusa: "prusaslicer",
  prusaslicer: "prusaslicer",
  cura: "cura",
  curaengine: "cura",
  slic3r: "slic3r",
  orca: "orcaslicer",
  orcaslicer: "orcaslicer",
  "orca-slicer": "orcaslicer",
  "orcaslicer-bambulab": "orcaslicer-bambulab",
  "orcaslicer_bambulab": "orcaslicer-bambulab",
  "orca-bambulab": "orcaslicer-bambulab",
  "orca_bambulab": "orcaslicer-bambulab",
  "fulu-orca": "orcaslicer-bambulab",
  "fulu_orca": "orcaslicer-bambulab",
  "orca-studio": "orcaslicer-bambulab",
  "orca_studio": "orcaslicer-bambulab",
  orcastudio: "orcaslicer-bambulab",
  bambustudio: "bambustudio",
  "bambu-studio": "bambustudio",
  "bambu_studio": "bambustudio",
};

const SLICER_TYPE_ENUM = [
  ...CANONICAL_SLICER_TYPES,
  "fulu_orca",
  "fulu-orca",
  "orca-studio",
  "orca_bambulab",
] as const;

function normalizeSlicerType(rawValue: string | undefined): SlicerType {
  const normalized = (rawValue || "").trim().toLowerCase();
  const resolved = SLICER_TYPE_ALIASES[normalized];
  if (!resolved) {
    throw new Error(
      `Unsupported slicer type "${rawValue}". Valid types: ${SLICER_TYPE_ENUM.join(", ")}`
    );
  }
  return resolved;
}

function isBambuProjectSlicer(slicerType: SlicerType): boolean {
  return slicerType === "orcaslicer-bambulab" || slicerType === "bambustudio";
}

function firstExistingPath(candidates: string[]): string | undefined {
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function defaultFuluOrcaPath(): string {
  return (
    process.env.FULU_ORCA_PATH ||
    process.env.ORCASLICER_BAMBULAB_PATH ||
    process.env.ORCA_SLICER_BAMBULAB_PATH ||
    firstExistingPath([
      "/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer",
      "/Applications/Orca Studio.app/Contents/MacOS/OrcaSlicer",
      "/Applications/OrcaStudio.app/Contents/MacOS/OrcaStudio",
      "/usr/local/bin/orcaslicer",
      "/usr/bin/orcaslicer",
    ]) ||
    "orcaslicer"
  );
}

function defaultBambuStudioPath(): string {
  return (
    firstExistingPath([
      "/Applications/BambuStudio.app/Contents/MacOS/BambuStudio",
      "/Applications/Bambu Studio.app/Contents/MacOS/BambuStudio",
      "/usr/local/bin/bambustudio",
      "/usr/bin/bambustudio",
    ]) ||
    "bambustudio"
  );
}

const DEFAULT_SLICER_TYPE = normalizeSlicerType(
  process.env.SLICER_TYPE || (DEFAULT_TYPE.toLowerCase() === "bambu" ? "orcaslicer-bambulab" : "prusaslicer")
);
const DEFAULT_SLICER_PATH =
  process.env.SLICER_PATH ||
  (DEFAULT_SLICER_TYPE === "orcaslicer-bambulab"
    ? defaultFuluOrcaPath()
    : DEFAULT_SLICER_TYPE === "bambustudio"
      ? defaultBambuStudioPath()
      : "");
const DEFAULT_SLICER_PROFILE = process.env.SLICER_PROFILE || "";
const DEFAULT_FILAMENT_PROFILE =
  process.env.FILAMENT_PROFILE || process.env.SLICER_FILAMENT_PROFILE || "";

// Bambu-specific default values
const DEFAULT_BAMBU_SERIAL = process.env.BAMBU_SERIAL || "";
const DEFAULT_BAMBU_TOKEN = process.env.BAMBU_TOKEN || "";

// Printer model and bed type (Bambu safety)
const DEFAULT_BAMBU_MODEL = process.env.BAMBU_MODEL?.trim().toLowerCase() || "";
const DEFAULT_BED_TYPE = process.env.BED_TYPE?.trim().toLowerCase() || "textured_plate";
const DEFAULT_NOZZLE_DIAMETER = process.env.NOZZLE_DIAMETER?.trim() || "0.4";

const VALID_BAMBU_MODELS = ["p1s", "p1p", "x1c", "x1e", "a1", "a1mini", "h2d"] as const;
type BambuModel = typeof VALID_BAMBU_MODELS[number];

const VALID_BED_TYPES = ["textured_plate", "cool_plate", "engineering_plate", "hot_plate"] as const;

// Map model IDs to BambuStudio --load-machine preset names
const BAMBU_MODEL_PRESETS: Record<string, (nozzle: string) => string> = {
  p1s: (n) => `Bambu Lab P1S ${n} nozzle`,
  p1p: (n) => `Bambu Lab P1P ${n} nozzle`,
  x1c: (n) => `Bambu Lab X1 Carbon ${n} nozzle`,
  x1e: (n) => `Bambu Lab X1E ${n} nozzle`,
  a1: (n) => `Bambu Lab A1 ${n} nozzle`,
  a1mini: (n) => `Bambu Lab A1 mini ${n} nozzle`,
  h2d: (n) => `Bambu Lab H2D ${n} nozzle`,
};

function validateBambuModel(model: string): BambuModel {
  const normalized = model.trim().toLowerCase();
  if (!(VALID_BAMBU_MODELS as readonly string[]).includes(normalized)) {
    throw new Error(
      `Invalid Bambu printer model "${model}". Valid models: ${VALID_BAMBU_MODELS.join(", ")}`
    );
  }
  return normalized as BambuModel;
}

function resolveBedType(bedType: string | undefined): string {
  const resolved = (bedType || DEFAULT_BED_TYPE).trim().toLowerCase();
  if (!(VALID_BED_TYPES as readonly string[]).includes(resolved)) {
    throw new Error(
      `Invalid bed type "${bedType}". Valid types: ${VALID_BED_TYPES.join(", ")}`
    );
  }
  return resolved;
}

type RuntimeConfig = {
  transport: "stdio" | "streamable-http";
  httpHost: string;
  httpPort: number;
  httpPath: string;
  statefulSession: boolean;
  enableJsonResponse: boolean;
  allowedOrigins: Set<string>;
  blenderBridgeCommand?: string;
  allowExecutableArg: boolean;
  allowBridgeCommandArg: boolean;
};

function parseBooleanEnv(rawValue: string | undefined, fallback: boolean): boolean {
  if (rawValue === undefined) {
    return fallback;
  }

  const value = rawValue.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(value)) {
    return false;
  }
  return fallback;
}

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`Invalid MCP_HTTP_PORT value: ${value}`);
  }
  return parsed;
}

function normalizePath(pathValue: string | undefined): string {
  const value = (pathValue ?? "/mcp").trim();
  if (!value) {
    return "/mcp";
  }
  return value.startsWith("/") ? value : `/${value}`;
}

function parseCsvEnv(value: string | undefined): Set<string> {
  if (!value) {
    return new Set();
  }
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return new Set(entries);
}

function readRuntimeConfig(): RuntimeConfig {
  const rawTransport = process.env.MCP_TRANSPORT?.trim().toLowerCase();
  const transport =
    rawTransport === "streamable-http" || rawTransport === "http"
      ? "streamable-http"
      : "stdio";

  return {
    transport,
    httpHost: process.env.MCP_HTTP_HOST?.trim() || "127.0.0.1",
    httpPort: parsePort(process.env.MCP_HTTP_PORT, 3000),
    httpPath: normalizePath(process.env.MCP_HTTP_PATH),
    statefulSession: parseBooleanEnv(process.env.MCP_HTTP_STATEFUL, true),
    enableJsonResponse: parseBooleanEnv(process.env.MCP_HTTP_JSON_RESPONSE, true),
    allowedOrigins: parseCsvEnv(process.env.MCP_HTTP_ALLOWED_ORIGINS),
    blenderBridgeCommand: process.env.BLENDER_MCP_BRIDGE_COMMAND?.trim() || undefined,
    allowExecutableArg: parseBooleanEnv(process.env.MCP_ALLOW_EXECUTABLE_ARG, false),
    allowBridgeCommandArg: parseBooleanEnv(process.env.MCP_ALLOW_BRIDGE_COMMAND_ARG, false),
  };
}

type StructuredToolError = {
  status: "error";
  retryable: boolean;
  suggestion: string;
  message: string;
  tool: string;
};

// Ensure temp directory exists
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

class ThreeDPrinterMCPServer {
  private server: Server;
  private readonly blender = new BlenderMcpBridge();
  private printerFactory: PrinterFactory;
  private stlManipulator: STLManipulator;
  private readonly runtimeConfig: RuntimeConfig;
  private httpRuntime?: { transport: StreamableHTTPServerTransport; httpServer: HttpServer };

  constructor() {
    this.runtimeConfig = readRuntimeConfig();
    this.server = new Server(
      {
        name: "mcp-3d-printer-server",
        version: JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version
      },
      {
        capabilities: {
          resources: {},
          tools: {}
        }
      }
    );

    this.printerFactory = new PrinterFactory();
    this.stlManipulator = new STLManipulator(TEMP_DIR);

    this.setupHandlers();
    this.setupErrorHandling();
  }

  private async resolveBambuModel(argsModel: string | undefined): Promise<string> {
    const fromArgs = (argsModel || DEFAULT_BAMBU_MODEL).trim().toLowerCase();
    if (fromArgs) {
      return validateBambuModel(fromArgs);
    }

    // No model from args or env — ask the user via elicitation
    try {
      const result = await this.server.elicitInput({
        mode: "form" as const,
        message:
          "Your Bambu Lab printer model is required for safe operation. " +
          "Using the wrong model can cause the bed to crash into the nozzle and damage the printer.",
        requestedSchema: {
          type: "object",
          properties: {
            bambu_model: {
              type: "string",
              title: "Printer Model",
              description: "Which Bambu Lab printer do you have?",
              oneOf: [
                { const: "p1s", title: "P1S" },
                { const: "p1p", title: "P1P" },
                { const: "x1c", title: "X1 Carbon" },
                { const: "x1e", title: "X1E" },
                { const: "a1", title: "A1" },
                { const: "a1mini", title: "A1 Mini" },
                { const: "h2d", title: "H2D" },
              ],
            },
          },
          required: ["bambu_model"],
        },
      });

      if (result.action === "accept" && result.content?.bambu_model) {
        return validateBambuModel(String(result.content.bambu_model));
      }

      throw new Error(
        "Printer model selection was cancelled. Cannot proceed without knowing the printer model."
      );
    } catch (elicitError: any) {
      const msg = elicitError?.message || String(elicitError);
      if (
        elicitError?.code === -32601 || elicitError?.code === -32600 ||
        msg.includes("does not support") || msg.includes("elicitation")
      ) {
        throw new Error(
          "bambu_model is required but your MCP client does not support elicitation. " +
          `Set the BAMBU_MODEL environment variable or pass bambu_model in the tool call. ` +
          `Valid models: ${VALID_BAMBU_MODELS.join(", ")}`
        );
      }
      throw elicitError;
    }
  }

  setupErrorHandling() {
    this.server.onerror = (error) => {
      console.error("[MCP Error]", error);
    };
  }

  setupHandlers() {
    this.setupResourceHandlers();
    this.setupToolHandlers();
  }

  private extractParsedAmsMapping(parsed3MFData: ThreeMFData | undefined): number[] | undefined {
    if (!parsed3MFData?.slicerConfig?.ams_mapping) {
      return undefined;
    }

    const slots = Object.values(parsed3MFData.slicerConfig.ams_mapping).filter(
      (value): value is number => typeof value === "number"
    );

    return slots.length > 0 ? slots.sort((a, b) => a - b) : undefined;
  }

  private resolveAmsPrintOptions(
    parsed3MFData: ThreeMFData | undefined,
    args: Record<string, unknown> | undefined
  ): { useAMS: boolean; amsMapping?: number[] } {
    let finalAmsMapping = this.extractParsedAmsMapping(parsed3MFData);
    let useAMS =
      args?.use_ams !== undefined
        ? Boolean(args.use_ams)
        : !!finalAmsMapping && finalAmsMapping.length > 0;

    const override = args?.ams_mapping;
    if (override !== undefined) {
      let userMappingOverride: number[] | undefined;

      if (Array.isArray(override)) {
        userMappingOverride = override.filter((value): value is number => typeof value === "number");
      } else if (typeof override === "object" && override !== null) {
        userMappingOverride = Object.values(override as Record<string, unknown>)
          .filter((value): value is number => typeof value === "number")
          .sort((a, b) => a - b);
      }

      if (userMappingOverride && userMappingOverride.length > 0) {
        finalAmsMapping = userMappingOverride;
        useAMS = true;
      }
    }

    if (args?.use_ams === false) {
      finalAmsMapping = undefined;
      useAMS = false;
    }

    if (!finalAmsMapping || finalAmsMapping.length === 0) {
      useAMS = false;
    }

    return { useAMS, amsMapping: finalAmsMapping };
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
        } else if (resource === "files") {
          content = await this.getPrinterFiles(host);
        } else if (resource.startsWith("file/")) {
          const filename = resource.substring(5);
          content = await this.getPrinterFile(host, filename);
        } else {
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
      } catch (error) {
        if (axios.isAxiosError(error)) {
          throw new McpError(
            ErrorCode.InternalError,
            `API error: ${error.response?.data?.error || error.message}`
          );
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
          {
            name: "list_printer_files",
            description: "List files available on the 3D printer",
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
          {
            name: "upload_gcode",
            description: "Upload G-code content or a local G-code file path to the printer",
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
                },
                bambu_model: {
                  type: "string",
                  enum: [...VALID_BAMBU_MODELS],
                  description: "Required for Bambu print operations unless BAMBU_MODEL is configured. Must match the printer and pre-sliced G-code."
                },
                filename: {
                  type: "string",
                  description: "Filename to use on the printer. Defaults to the basename of gcode_path when omitted."
                },
                gcode: {
                  type: "string",
                  description: "G-code content, or a local path to a G-code file."
                },
                gcode_path: {
                  type: "string",
                  description: "Local path to a G-code file to upload."
                },
                print: {
                  type: "boolean",
                  description: "Start printing after upload when the printer backend supports it."
                }
              }
            }
          },
          {
            name: "start_print",
            description: "Start printing a file that is already available on the printer",
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
                },
                bambu_model: {
                  type: "string",
                  enum: [...VALID_BAMBU_MODELS],
                  description: "Required for Bambu print operations unless BAMBU_MODEL is configured. Must match the printer and pre-sliced G-code."
                },
                filename: {
                  type: "string",
                  description: "Name/path of the printer-side G-code file to start."
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
                },
                component: {
                  type: "string",
                  description: "Printer component to heat, such as extruder or bed."
                },
                temperature: {
                  type: "number",
                  description: "Target temperature in Celsius."
                }
              },
              required: ["component", "temperature"]
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
            description: "Slice an STL or 3MF file to generate G-code or sliced 3MF",
            inputSchema: {
              type: "object",
              properties: {
                stl_path: {
                  type: "string",
                  description: "Path to the STL or 3MF file to slice"
                },
                bambu_model: {
                  type: "string",
                  enum: ["p1s", "p1p", "x1c", "x1e", "a1", "a1mini", "h2d"],
                  description: "Bambu Lab printer model - required when using Bambu project slicers to ensure correct G-code."
                },
                nozzle_diameter: {
                  type: "string",
                  description: "Nozzle diameter in mm (default: 0.4)."
                },
                slicer_type: {
                  type: "string",
                  enum: [...SLICER_TYPE_ENUM],
                  description: "Type of slicer to use (prusaslicer, cura, slic3r, orcaslicer, orcaslicer-bambulab, bambustudio). Use orcaslicer-bambulab for the FULU fork."
                },
                slicer_path: {
                  type: "string",
                  description: "Path to the slicer executable (default: value from env). Per-call overrides require MCP_ALLOW_EXECUTABLE_ARG=1."
                },
                slicer_profile: {
                  type: "string",
                  description: "Profile to use for slicing (default: value from env). OrcaSlicer also accepts machine/process profiles separated with ';', optionally followed by '|filament.json'."
                },
                filament_profile: {
                  type: "string",
                  description: "OrcaSlicer filament profile path loaded with --load-filaments (default: FILAMENT_PROFILE/SLICER_FILAMENT_PROFILE env)."
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
                },
                bambu_model: {
                  type: "string",
                  enum: ["p1s", "p1p", "x1c", "x1e", "a1", "a1mini", "h2d"],
                  description: "Bambu Lab printer model. Required for Bambu print operations."
                },
                bed_type: {
                  type: "string",
                  enum: ["textured_plate", "cool_plate", "engineering_plate", "hot_plate"],
                  description: "Bed/plate type installed on the printer (default: textured_plate)."
                },
                nozzle_diameter: {
                  type: "string",
                  description: "Nozzle diameter in mm (default: 0.4)."
                },
                slicer_type: {
                  type: "string",
                  enum: [...SLICER_TYPE_ENUM],
                  description: "Type of slicer to use. Use orcaslicer-bambulab for FULU OrcaSlicer-bambulab."
                },
                slicer_path: {
                  type: "string",
                  description: "Path to the slicer executable (default: value from env). Per-call overrides require MCP_ALLOW_EXECUTABLE_ARG=1."
                },
                slicer_profile: {
                  type: "string",
                  description: "Profile to use for slicing (default: value from env). OrcaSlicer also accepts machine/process profiles separated with ';', optionally followed by '|filament.json'."
                },
                filament_profile: {
                  type: "string",
                  description: "OrcaSlicer filament profile path loaded with --load-filaments (default: FILAMENT_PROFILE/SLICER_FILAMENT_PROFILE env)."
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
          {
            name: "print_3mf",
            description: "Print a 3MF file on a Bambu Lab printer, potentially overriding settings.",
            inputSchema: {
              type: "object",
              properties: {
                three_mf_path: {
                  type: "string",
                  description: "Path to the 3MF file to print."
                },
                bambu_model: {
                  type: "string",
                  enum: ["p1s", "p1p", "x1c", "x1e", "a1", "a1mini", "h2d"],
                  description: "REQUIRED: Bambu Lab printer model. Ensures correct G-code generation — wrong model can crash the bed into the nozzle."
                },
                bed_type: {
                  type: "string",
                  enum: ["textured_plate", "cool_plate", "engineering_plate", "hot_plate"],
                  description: "Bed/plate type installed on the printer (default: textured_plate)."
                },
                nozzle_diameter: {
                  type: "string",
                  description: "Nozzle diameter in mm (default: 0.4)."
                },
                host: {
                  type: "string",
                  description: "Hostname or IP address of the Bambu printer (default: value from env)"
                },
                bambu_serial: {
                  type: "string",
                  description: "Serial number for the Bambu Lab printer (default: value from env)"
                },
                bambu_token: {
                  type: "string",
                  description: "Access token for the Bambu Lab printer (default: value from env)"
                },
                layer_height: { type: "number", description: "Override layer height (mm)." },
                nozzle_temperature: { type: "number", description: "Override nozzle temperature (°C)." },
                bed_temperature: { type: "number", description: "Override bed temperature (°C)." },
                support_enabled: { type: "boolean", description: "Override support generation." },
                ams_mapping: {
                  type: "object",
                  description: "Override AMS filament mapping (e.g., {\"Generic PLA\": 0, \"Generic PETG\": 1}).",
                  additionalProperties: { type: "number" }
                },
                slicer_type: {
                  type: "string",
                  enum: [...SLICER_TYPE_ENUM],
                  description: "Slicer to use if the 3MF needs auto-slicing. Use orcaslicer-bambulab for FULU OrcaSlicer-bambulab."
                },
                slicer_path: {
                  type: "string",
                  description: "Path to the slicer executable if auto-slicing is needed. Per-call overrides require MCP_ALLOW_EXECUTABLE_ARG=1."
                },
                slicer_profile: {
                  type: "string",
                  description: "Optional slicer settings/profile path for auto-slicing."
                },
                filament_profile: {
                  type: "string",
                  description: "Optional filament profile path for auto-slicing with OrcaSlicer/Bambu Studio."
                },
                use_ams: {
                  type: "boolean",
                  description: "Whether to use AMS for the print. Defaults from parsed 3MF mapping when present."
                },
                bed_leveling: {
                  type: "boolean",
                  description: "Override bed leveling flag for the Bambu print command."
                },
                flow_calibration: {
                  type: "boolean",
                  description: "Override flow calibration flag for the Bambu print command."
                },
                vibration_calibration: {
                  type: "boolean",
                  description: "Override vibration calibration flag for the Bambu print command."
                },
                layer_inspect: {
                  type: "boolean",
                  description: "Override layer inspection flag for the Bambu print command."
                },
                timelapse: {
                  type: "boolean",
                  description: "Override timelapse flag for the Bambu print command."
                }
              },
              required: ["three_mf_path", "bambu_model"]
            }
          },
          {
            name: "check_fulu_orca_setup",
            description:
              "Inspect a FULU OrcaSlicer-bambulab install, platform runtime payload, setup commands, and optionally probe the BambuNetwork bridge.",
            inputSchema: {
              type: "object",
              properties: {
                slicer_path: {
                  type: "string",
                  description:
                    "Path to the FULU OrcaSlicer executable. Defaults from SLICER_PATH/FULU_ORCA_PATH. " +
                    "When run_bridge_probe=true, requires MCP_ALLOW_EXECUTABLE_ARG=1 to be accepted here."
                },
                plugin_dir: {
                  type: "string",
                  description:
                    "Directory containing the FULU Bambu runtime payload; on macOS this is usually " +
                    "OrcaSlicer.app/Contents/MacOS. When run_bridge_probe=true, requires " +
                    "MCP_ALLOW_EXECUTABLE_ARG=1 to be accepted here."
                },
                runtime_dir: {
                  type: "string",
                  description:
                    "Installed runtime directory. On macOS this defaults to ~/Library/Application " +
                    "Support/OrcaSlicer/macos-bridge/runtime. When run_bridge_probe=true, requires " +
                    "MCP_ALLOW_EXECUTABLE_ARG=1 to be accepted here."
                },
                platform: {
                  type: "string",
                  enum: ["darwin", "macos", "win32", "windows", "linux"],
                  description: "Platform to inspect. Defaults to the current Node.js platform."
                },
                bridge_command: {
                  type: "string",
                  description:
                    "Command that starts the FULU BambuNetwork bridge host for probing. Read from " +
                    "FULU_BAMBU_BRIDGE_COMMAND by default; requires MCP_ALLOW_EXECUTABLE_ARG=1 " +
                    "to be accepted here."
                },
                run_bridge_probe: {
                  type: "boolean",
                  description: "When true, sends bridge.handshake, bridge.capabilities, and bridge.runtime_info to the bridge host."
                },
                probe_timeout_ms: {
                  type: "number",
                  description: "Bridge probe timeout in milliseconds (default: 5000)."
                }
              }
            }
          },
          {
            name: "fulu_bambu_network_rpc",
            description:
              "Advanced FULU bridge RPC for BambuNetwork diagnostics and development. Read-only methods are allowed by default; mutating methods require allow_mutating_method=true, and print methods require bambu_model.",
            inputSchema: {
              type: "object",
              properties: {
                bridge_command: {
                  type: "string",
                  description:
                    "Command that starts the FULU BambuNetwork bridge host. Defaults to " +
                    "FULU_BAMBU_BRIDGE_COMMAND; requires MCP_ALLOW_EXECUTABLE_ARG=1 to be " +
                    "accepted here."
                },
                method: {
                  type: "string",
                  description: "FULU bridge method, e.g. bridge.handshake, bridge.runtime_info, net.get_user_print_info, net.start_print."
                },
                payload: {
                  type: "object",
                  description: "JSON payload sent to the FULU bridge method.",
                  additionalProperties: true
                },
                timeout_ms: {
                  type: "number",
                  description: "Bridge request timeout in milliseconds (default: 5000)."
                },
                allow_mutating_method: {
                  type: "boolean",
                  description: "Required for methods outside the read-only bridge/net allowlist."
                },
                bambu_model: {
                  type: "string",
                  enum: ["p1s", "p1p", "x1c", "x1e", "a1", "a1mini", "h2d"],
                  description: "Required when calling FULU print RPC methods; preserves the Bambu model safety gate."
                }
              },
              required: ["method"]
            }
          },
          {
            name: "merge_vertices",
            description: "Merge vertices in an STL file that are closer than the specified tolerance.",
            inputSchema: {
              type: "object",
              properties: {
                stl_path: {
                  type: "string",
                  description: "Path to the STL file to modify."
                },
                tolerance: {
                  type: "number",
                  description: "Maximum distance between vertices to merge (in mm, default: 0.01)."
                }
              },
              required: ["stl_path"]
            }
          },
          {
            name: "center_model",
            description: "Translate the model so its geometric center is at the origin (0,0,0).",
            inputSchema: {
              type: "object",
              properties: {
                stl_path: {
                  type: "string",
                  description: "Path to the STL file to center."
                }
              },
              required: ["stl_path"]
            }
          },
          {
            name: "lay_flat",
            description: "Attempt to rotate the model so its largest flat face lies on the XY plane (Z=0).",
            inputSchema: {
              type: "object",
              properties: {
                stl_path: {
                  type: "string",
                  description: "Path to the STL file to lay flat."
                }
              },
              required: ["stl_path"]
            }
          },
          {
            name: "blender_mcp_status",
            description: "Inspect Blender MCP configuration or connect and discover the remote server's tools. Lists tool names and summaries; pass tool_names for the full input schemas of the tools you will call. Connecting does not edit the scene; use get_scene_info through blender_mcp_call to check the Blender addon.",
            inputSchema: {
              type: "object",
              properties: {
                connect: { type: "boolean", description: "Initialize the configured stdio MCP server and discover its tools (default false)." },
                tool_names: { type: "array", items: { type: "string" }, maxItems: 64, description: "Return full input schemas for these discovered tools, such as [\"execute_blender_code\"]." },
                include_schemas: { type: "boolean", description: "Return every discovered tool's full definition (large; default false)." },
                timeout_ms: { type: "integer", minimum: 100, maximum: 300000, description: "Total connection and discovery deadline in milliseconds; defaults to BLENDER_MCP_TIMEOUT_MS or 120000." }
              },
              additionalProperties: false
            }
          },
          {
            name: "blender_mcp_call",
            description: "Call a discovered tool on the configured Blender MCP server, preserving its full MCP content and errors. Discover tool schemas with blender_mcp_status first; execute_blender_code accepts Python code and user_prompt. Calls can modify the active Blender scene and are never automatically retried.",
            inputSchema: {
              type: "object",
              properties: {
                tool_name: { type: "string", description: "Exact name advertised by Blender MCP, such as get_scene_info or execute_blender_code." },
                arguments: { type: "object", description: "Arguments matching the remote tool's discovered input schema. Preserve the user's own words in user_prompt when the remote tool requests it." },
                timeout_ms: { type: "integer", minimum: 100, maximum: 300000, description: "Total connection, discovery, and tool deadline in milliseconds; defaults to BLENDER_MCP_TIMEOUT_MS or 120000." }
              },
              required: ["tool_name"],
              additionalProperties: false
            }
          },
          {
            name: "blender_mcp_export_stl",
            description: "Export named objects from the live Blender scene to a new, verified STL for slicing. Writes world-space geometry with modifiers applied, without changing the scene, selection, or mode, and reports triangle count and bounding-box dimensions from the written file. Use this after editing or modelling through blender_mcp_call; Blender MCP's own export_scene writes GLB/FBX only. Requires standard Blender MCP and a shared local filesystem.",
            inputSchema: {
              type: "object",
              properties: {
                object_names: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 64, description: "Blender object names to export together as one STL (mesh, curve, surface, metaball, or text objects)." },
                output_path: { type: "string", description: "New local .stl path. Its parent must exist; existing files are never overwritten." },
                apply_modifiers: { type: "boolean", description: "Export the evaluated geometry with modifiers applied (default true)." },
                scale: { type: "number", exclusiveMinimum: 0, description: "Multiply coordinates before writing (default 1). Slicers read STL units as millimetres, so use 1000 for a scene modelled in metres." },
                user_prompt: { type: "string", description: "The user's own words, passed unchanged to Blender MCP." },
                timeout_ms: { type: "integer", minimum: 100, maximum: 300000, description: "Total Blender request deadline in milliseconds; defaults to BLENDER_MCP_TIMEOUT_MS or 120000." }
              },
              required: ["object_names", "output_path"],
              additionalProperties: false
            }
          },
          {
            name: "blender_mcp_edit_model",
            description: "Import, edit, and export a local STL through standard Blender MCP with verified output and existing scene objects preserved. Requires a shared local filesystem and Blender Object Mode. Also supports a separately configured legacy executable bridge.",
            inputSchema: {
              type: "object",
              properties: {
                stl_path: { type: "string", description: "Path to the local STL file" },
                operations: {
                  type: "array",
                  description: "Ordered operations: decimate:<ratio greater than 0 and at most 1>, remesh:<positive voxel size in STL units>, boolean_union:<STL path>. Legacy custom bridges define their own operations.",
                  minItems: 1,
                  maxItems: 64,
                  items: { type: "string" }
                },
                output_path: { type: "string", description: "New local STL output path for standard MCP editing; defaults to a unique model-edited-<id>.stl beside the input. Its parent must exist and existing files are never overwritten. Reuse the preview's output_path when executing that plan." },
                user_prompt: { type: "string", description: "The user's own words describing the edit, passed unchanged to Blender MCP." },
                timeout_ms: { type: "integer", minimum: 100, maximum: 300000, description: "Total Blender request deadline in milliseconds; defaults to BLENDER_MCP_TIMEOUT_MS or 120000." },
                bridge_command: { type: "string", description: "Legacy custom bridge executable override, not a standard MCP command. Per-call overrides require MCP_ALLOW_EXECUTABLE_ARG=1." },
                execute: { type: "boolean", description: "Apply edits and export (true) or validate and return the prepared request without connecting (false, default)." }
              },
              required: ["stl_path", "operations"],
              additionalProperties: false
            }
          }
        ]
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { name, arguments: args } = request.params;
      
      // Set default values for common parameters
      const host = String(args?.host || DEFAULT_HOST);
      const port = String(args?.port || DEFAULT_PORT);
      const type = String(args?.type || DEFAULT_TYPE);
      const apiKey = String(args?.api_key || DEFAULT_API_KEY);
      const bambuSerial = String(args?.bambu_serial || DEFAULT_BAMBU_SERIAL);
      const bambuToken = String(args?.bambu_token || DEFAULT_BAMBU_TOKEN);
      const slicerType = normalizeSlicerType(String(args?.slicer_type || DEFAULT_SLICER_TYPE));
      const slicerProfile = String(args?.slicer_profile || DEFAULT_SLICER_PROFILE);
      const filamentProfile = String(args?.filament_profile || DEFAULT_FILAMENT_PROFILE);

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
            if (!args?.gcode && !args?.gcode_path) {
              throw new Error("Missing required parameter: gcode or gcode_path");
            }
            if (args?.gcode_path && !fs.existsSync(String(args.gcode_path))) {
              throw new Error(`G-code file not found: ${String(args.gcode_path)}`);
            }
            if (!args?.filename && !args?.gcode_path) {
              throw new Error("Missing required parameter: filename");
            }
            if (args.print !== undefined && typeof args.print !== "boolean") {
              throw new Error("print must be a boolean.");
            }
            if (type.toLowerCase() === "bambu" && args.print === true) {
              await this.resolveBambuModel(args?.bambu_model as string | undefined);
            }
            const uploadFilename = String(args?.filename || path.basename(String(args.gcode_path)));
            const uploadGcodeSource = String(args?.gcode_path || args.gcode);
            result = await this.uploadGcode(
              host, port, type, apiKey, bambuSerial, bambuToken,
              uploadFilename,
              uploadGcodeSource,
              Boolean(args.print || false)
            );
            break;
            
          case "start_print":
            if (!args?.filename) {
              throw new Error("Missing required parameter: filename");
            }
            if (type.toLowerCase() === "bambu") {
              await this.resolveBambuModel(args?.bambu_model as string | undefined);
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
            result = await this.setPrinterTemperature(
              host, port, type, apiKey, bambuSerial, bambuToken,
              String(args.component), 
              Number(args.temperature)
            );
            break;
            
          // New STL manipulation tools
          case "extend_stl_base":
            if (!args?.stl_path || args?.extension_inches === undefined) {
              throw new Error("Missing required parameters: stl_path and extension_inches");
            }
            result = await this.stlManipulator.extendBase(
              String(args.stl_path),
              Number(args.extension_inches)
            );
            break;
            
          case "slice_stl": {
            if (!args?.stl_path) {
              throw new Error("Missing required parameter: stl_path");
            }
            // Resolve printer model for BambuStudio slicer
            let slicePreset: string | undefined;
            if (isBambuProjectSlicer(slicerType)) {
              const sliceModel = await this.resolveBambuModel(args?.bambu_model as string | undefined);
              const nozzleDiam = String(args?.nozzle_diameter || DEFAULT_NOZZLE_DIAMETER);
              slicePreset = BAMBU_MODEL_PRESETS[sliceModel]?.(nozzleDiam);
            }
            result = await this.stlManipulator.sliceSTL(
              String(args.stl_path),
              slicerType,
              this.resolveExecutableSelectorArg(
                args?.slicer_path,
                "slice_stl",
                "slicer_path"
              ) ?? DEFAULT_SLICER_PATH,
              slicerProfile || undefined,
              undefined, // progressCallback
              slicePreset,
              filamentProfile || undefined
            );
            break;
          }
            
          case "confirm_temperatures":
            if (!args?.gcode_path) {
              throw new Error("Missing required parameter: gcode_path");
            }
            result = await this.stlManipulator.confirmTemperatures(
              String(args.gcode_path),
              {
                extruder: args.extruder_temp !== undefined ? Number(args.extruder_temp) : undefined,
                bed: args.bed_temp !== undefined ? Number(args.bed_temp) : undefined
              }
            );
            break;
            
          case "process_and_print_stl":
            if (!args?.stl_path || args?.extension_inches === undefined) {
              throw new Error("Missing required parameters: stl_path and extension_inches");
            }
            
            // Define progress callback for UI updates
            const processProgressCallback = (progress: number, message?: string) => {
              console.log(`Process progress: ${progress}% - ${message || ''}`);
            };
            
            // 1. Extend the base of the STL file
            const extendedStlPath = await this.stlManipulator.extendBase(
              String(args.stl_path),
              Number(args.extension_inches),
              processProgressCallback
            );
            
            // 2. Slice the extended STL file
            let processPreset: string | undefined;
            if (type.toLowerCase() === 'bambu' || isBambuProjectSlicer(slicerType)) {
              const processModel = await this.resolveBambuModel(args?.bambu_model as string | undefined);
              const processNozzle = String(args?.nozzle_diameter || DEFAULT_NOZZLE_DIAMETER);
              if (isBambuProjectSlicer(slicerType)) {
                processPreset = BAMBU_MODEL_PRESETS[processModel]?.(processNozzle);
              }
            }
            const gcodePath = await this.stlManipulator.sliceSTL(
              extendedStlPath,
              slicerType,
              this.resolveExecutableSelectorArg(
                args?.slicer_path,
                "process_and_print_stl",
                "slicer_path"
              ) ?? DEFAULT_SLICER_PATH,
              slicerProfile || undefined,
              processProgressCallback,
              processPreset,
              filamentProfile || undefined
            );

            if (type.toLowerCase() === 'bambu' && gcodePath.toLowerCase().endsWith(".3mf")) {
              if (!bambuSerial || !bambuToken) {
                throw new Error("Bambu serial number and access token are required for Bambu 3MF printing.");
              }

              const factoryImplementation = this.printerFactory.getImplementation('bambu');
              if (!(factoryImplementation instanceof BambuImplementation)) {
                throw new Error("Internal error: Could not get Bambu printer implementation.");
              }

              const printBedType = resolveBedType(args?.bed_type as string | undefined);
              let parsedProcess3MF: ThreeMFData | undefined;
              try {
                parsedProcess3MF = await parse3MF(gcodePath);
              } catch (error) {
                console.warn(
                  `Could not parse AMS metadata from sliced 3MF ${gcodePath}:`,
                  (error as Error).message
                );
              }
              const amsOptions = this.resolveAmsPrintOptions(
                parsedProcess3MF,
                args as Record<string, unknown> | undefined
              );

              result = await factoryImplementation.print3mf(host, bambuSerial, bambuToken, {
                projectName: path.basename(gcodePath).replace(/\.3mf$/i, ''),
                filePath: gcodePath,
                plateIndex: 0,
                ...amsOptions,
                bedType: printBedType,
                bedLeveling: args?.bed_leveling !== undefined ? Boolean(args.bed_leveling) : undefined,
                flowCalibration:
                  args?.flow_calibration !== undefined ? Boolean(args.flow_calibration) : undefined,
                vibrationCalibration:
                  args?.vibration_calibration !== undefined
                    ? Boolean(args.vibration_calibration)
                    : undefined,
                layerInspect: args?.layer_inspect !== undefined ? Boolean(args.layer_inspect) : undefined,
                timelapse: args?.timelapse !== undefined ? Boolean(args.timelapse) : undefined,
              });
              break;
            }

            if (gcodePath.toLowerCase().endsWith(".3mf")) {
              throw new Error(
                "process_and_print_stl produced a sliced 3MF. Direct process-and-print for sliced 3MF is only supported for Bambu printers via print_3mf."
              );
            }
            
            // 3. Confirm temperatures if specified
            if (args.extruder_temp !== undefined || args.bed_temp !== undefined) {
              const tempConfirmation = await this.stlManipulator.confirmTemperatures(
                gcodePath,
                {
                  extruder: args.extruder_temp !== undefined ? Number(args.extruder_temp) : undefined,
                  bed: args.bed_temp !== undefined ? Number(args.bed_temp) : undefined
                },
                processProgressCallback
              );
              
              if (!tempConfirmation.match) {
                console.warn("Temperature mismatch:", tempConfirmation);
              }
            }
            
            // 4. Upload the G-code file to the printer
            const gcodeContent = await fs.promises.readFile(gcodePath, 'utf8');
            const filename = path.basename(gcodePath);
            
            await this.uploadGcode(
              host, port, type, apiKey, bambuSerial, bambuToken,
              filename, 
              gcodeContent, 
              true // Start printing immediately
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
            const scaleProgressCallback = (progress: number, message?: string) => {
              console.log(`Scale progress: ${progress}% - ${message || ''}`);
            };
            
            let scaleFactors: number | [number, number, number];
            
            // Check if we have individual axis scaling factors
            if (args.scale_x !== undefined || args.scale_y !== undefined || args.scale_z !== undefined) {
              // Use individual axis scaling
              scaleFactors = [
                Number(args.scale_x ?? 1.0),
                Number(args.scale_y ?? 1.0),
                Number(args.scale_z ?? 1.0)
              ];
            } else {
              // Use uniform scaling
              scaleFactors = Number(args.scale_factor ?? 1.0);
            }
            
            result = await this.stlManipulator.scaleSTL(
              String(args.stl_path),
              scaleFactors,
              scaleProgressCallback
            );
            break;
            
          case "rotate_stl":
            if (!args?.stl_path) {
              throw new Error("Missing required parameter: stl_path");
            }
            
            // Define progress callback for UI updates
            const rotateProgressCallback = (progress: number, message?: string) => {
              console.log(`Rotate progress: ${progress}% - ${message || ''}`);
            };
            
            // Get rotation angles, defaulting to 0 for any undefined axis
            const rotationAngles: [number, number, number] = [
              Number(args.rotate_x ?? 0),
              Number(args.rotate_y ?? 0),
              Number(args.rotate_z ?? 0)
            ];
            
            result = await this.stlManipulator.rotateSTL(
              String(args.stl_path),
              rotationAngles,
              rotateProgressCallback
            );
            break;
            
          case "translate_stl":
            if (!args?.stl_path) {
              throw new Error("Missing required parameter: stl_path");
            }
            
            // Define progress callback for UI updates
            const translateProgressCallback = (progress: number, message?: string) => {
              console.log(`Translate progress: ${progress}% - ${message || ''}`);
            };
            
            // Get translation values, defaulting to 0 for any undefined axis
            const translationValues: [number, number, number] = [
              Number(args.translate_x ?? 0),
              Number(args.translate_y ?? 0),
              Number(args.translate_z ?? 0)
            ];
            
            result = await this.stlManipulator.translateSTL(
              String(args.stl_path),
              translationValues,
              translateProgressCallback
            );
            break;
            
          case "modify_stl_section":
            if (!args?.stl_path || !args?.section || !args?.transformation_type) {
              throw new Error("Missing required parameters: stl_path, section, and transformation_type");
            }
            
            // Define progress callback for UI updates
            const modifySectionProgressCallback = (progress: number, message?: string) => {
              console.log(`Modify section progress: ${progress}% - ${message || ''}`);
            };
            
            // Determine the section to modify
            let sectionBox: THREE.Box3 | 'top' | 'bottom' | 'center';
            
            if (args.section === 'custom') {
              // Create a custom bounding box from the provided bounds
              if (args.custom_min_x === undefined || args.custom_min_y === undefined || 
                  args.custom_min_z === undefined || args.custom_max_x === undefined || 
                  args.custom_max_y === undefined || args.custom_max_z === undefined) {
                throw new Error("Custom section requires all min/max bounds to be specified");
              }
              
              sectionBox = new THREE.Box3(
                new THREE.Vector3(
                  Number(args.custom_min_x),
                  Number(args.custom_min_y),
                  Number(args.custom_min_z)
                ),
                new THREE.Vector3(
                  Number(args.custom_max_x),
                  Number(args.custom_max_y),
                  Number(args.custom_max_z)
                )
              );
            } else {
              // Use a predefined section
              sectionBox = String(args.section) as 'top' | 'bottom' | 'center';
            }
            
            // Determine the transformation to apply
            const transformationType = String(args.transformation_type) as 'scale' | 'rotate' | 'translate';
            let transformationValue: number | number[];
            
            if (transformationType === 'scale') {
              if (args.value_x !== undefined || args.value_y !== undefined || args.value_z !== undefined) {
                transformationValue = [
                  Number(args.value_x ?? 1.0),
                  Number(args.value_y ?? 1.0),
                  Number(args.value_z ?? 1.0)
                ];
              } else {
                transformationValue = 1.0; // Default scale factor
              }
            } else if (transformationType === 'rotate') {
              transformationValue = [
                Number(args.value_x ?? 0),
                Number(args.value_y ?? 0),
                Number(args.value_z ?? 0)
              ];
            } else { // translate
              transformationValue = [
                Number(args.value_x ?? 0),
                Number(args.value_y ?? 0),
                Number(args.value_z ?? 0)
              ];
            }
            
            result = await this.stlManipulator.modifySection(
              String(args.stl_path),
              sectionBox,
              {
                type: transformationType,
                value: transformationValue
              },
              modifySectionProgressCallback
            );
            break;
            
          case "generate_stl_visualization":
            if (!args?.stl_path) {
              throw new Error("Missing required parameter: stl_path");
            }
            
            // Define progress callback for UI updates
            const visualizationProgressCallback = (progress: number, message?: string) => {
              console.log(`Visualization progress: ${progress}% - ${message || ''}`);
            };
            
            // Get width and height parameters, with defaults
            const width = args.width !== undefined ? Number(args.width) : 300;
            const height = args.height !== undefined ? Number(args.height) : 300;
            
            result = await this.stlManipulator.generateVisualization(
              String(args.stl_path),
              width,
              height,
              visualizationProgressCallback
            );
            break;
            
          case "print_3mf": {
            if (!args?.three_mf_path) {
              throw new Error("Missing required parameter: three_mf_path");
            }
            if (type.toLowerCase() !== 'bambu') {
                throw new Error("The print_3mf tool currently only supports Bambu printers.");
            }
            if (!bambuSerial || !bambuToken) {
                throw new Error("Bambu serial number and access token are required for print_3mf.");
            }

            const printModel = await this.resolveBambuModel(args?.bambu_model as string | undefined);
            const printBedType = resolveBedType(args?.bed_type as string | undefined);
            const printNozzle = String(args?.nozzle_diameter || DEFAULT_NOZZLE_DIAMETER);
            const printPreset = BAMBU_MODEL_PRESETS[printModel]?.(printNozzle);

            let threeMFPath = String(args.three_mf_path);

            let shouldAutoSlice = false;
            try {
              const JSZip = (await import('jszip')).default;
              const zipData = fs.readFileSync(threeMFPath);
              const zip = await JSZip.loadAsync(zipData);
              shouldAutoSlice = !Object.keys(zip.files).some(
                f => f.match(/Metadata\/plate_\d+\.gcode/i) || f.endsWith('.gcode')
              );
            } catch (sliceCheckErr: any) {
              console.warn("Could not check 3MF for embedded gcode, proceeding with original:", sliceCheckErr.message);
            }

            // Only treat slicer_path as an executable selector when a slicer
            // will actually launch. Ready-to-print archives ignore it.
            if (shouldAutoSlice) {
              const printSlicerPath =
                this.resolveExecutableSelectorArg(
                  args?.slicer_path,
                  "print_3mf",
                  "slicer_path"
                ) ?? DEFAULT_SLICER_PATH;
              try {
                console.log(`3MF has no gcode — auto-slicing with ${slicerType} for ${printModel}`);
                threeMFPath = await this.stlManipulator.sliceSTL(
                  threeMFPath,
                  slicerType,
                  printSlicerPath,
                  slicerProfile || undefined,
                  undefined, // progressCallback
                  printPreset,
                  filamentProfile || undefined
                );
                console.log("Auto-sliced to: " + threeMFPath);
              } catch (sliceErr: any) {
                console.warn("Could not auto-slice 3MF, proceeding with original:", sliceErr.message);
              }
            }

            // Define variables needed outside the parse try block
            let implementation: BambuImplementation;
            let threeMfFilename: string;
            let projectName: string;
            let printOptions: any; // Use a more specific type later if possible

            try {
                // --- Parse 3MF --- 
                const parsed3MFData = await parse3MF(threeMFPath);
                console.log(`Successfully parsed 3MF file: ${threeMFPath}`);
                const amsOptions = this.resolveAmsPrintOptions(
                  parsed3MFData,
                  args as Record<string, unknown> | undefined
                );

                // --- Prepare Implementation and Print Options --- 
                const factoryImplementation = this.printerFactory.getImplementation('bambu');
                if (!(factoryImplementation instanceof BambuImplementation)) {
                    throw new Error("Internal error: Could not get Bambu printer implementation.");
                }
                implementation = factoryImplementation; // Assign to outer scope variable

                threeMfFilename = path.basename(threeMFPath); // Assign to outer scope variable
                projectName = threeMfFilename.replace(/\.3mf$/i, ''); // Assign to outer scope variable

                printOptions = { // Assign to outer scope variable
                    ...amsOptions,
                    bedType: printBedType,
                    bedLeveling: args?.bed_leveling !== undefined ? Boolean(args.bed_leveling) : undefined,
                    flowCalibration: args?.flow_calibration !== undefined ? Boolean(args.flow_calibration) : undefined,
                    vibrationCalibration: args?.vibration_calibration !== undefined ? Boolean(args.vibration_calibration) : undefined,
                    layerInspect: args?.layer_inspect !== undefined ? Boolean(args.layer_inspect) : undefined,
                    timelapse: args?.timelapse !== undefined ? Boolean(args.timelapse) : undefined,
                    // md5: parsed3MFData?.metadata?.md5
                };

            } catch (error) { // Catch parsing or setup errors
                console.error(`Error processing 3MF or setting up print:`, error);
                throw new Error(`Failed during 3MF processing: ${(error as Error).message}`);
            }
                
            // --- Call Implementation (Now variables are in scope) --- 
            try {
                result = await implementation.print3mf(host, bambuSerial, bambuToken, {
                    projectName: projectName,
                    filePath: threeMFPath,
                    plateIndex: 0, 
                    ...printOptions // Spread the final options
                });
                result = `Print command for ${threeMfFilename} sent successfully.`;
            } catch (printError) {
                 console.error(`Error starting 3MF print for ${threeMfFilename}:`, printError);
                 throw new Error(`Failed to start print: ${(printError as Error).message}`);
            }

            break;
          }

          case "check_fulu_orca_setup": {
            const runBridgeProbe = Boolean(args?.run_bridge_probe ?? false);
            result = await inspectFuluOrcaSetup({
              slicerPath: this.resolveExecutableSelectorArg(
                args?.slicer_path,
                "check_fulu_orca_setup",
                "slicer_path",
                runBridgeProbe,
                true
              ),
              pluginDir: this.resolveExecutableSelectorArg(
                args?.plugin_dir,
                "check_fulu_orca_setup",
                "plugin_dir",
                runBridgeProbe,
                true
              ),
              runtimeDir: this.resolveExecutableSelectorArg(
                args?.runtime_dir,
                "check_fulu_orca_setup",
                "runtime_dir",
                runBridgeProbe,
                true
              ),
              platform: args?.platform !== undefined ? String(args.platform) : undefined,
              bridgeCommand: this.resolveExecutableSelectorArg(
                args?.bridge_command,
                "check_fulu_orca_setup",
                "bridge_command",
                true,
                true
              ),
              runBridgeProbe,
              probeTimeoutMs:
                args?.probe_timeout_ms !== undefined ? Number(args.probe_timeout_ms) : undefined,
            });
            break;
          }

          case "fulu_bambu_network_rpc": {
            if (!args?.method) {
              throw new Error("Missing required parameter: method");
            }

            const method = String(args.method);
            let rpcBambuModel: string | undefined;
            if (isFuluPrintRpcMethod(method)) {
              rpcBambuModel = await this.resolveBambuModel(args?.bambu_model as string | undefined);
            }

            const payload =
              typeof args.payload === "object" && args.payload !== null && !Array.isArray(args.payload)
                ? (args.payload as Record<string, unknown>)
                : undefined;

            result = await invokeFuluBridgeRpc({
              bridgeCommand: this.resolveExecutableSelectorArg(
                args?.bridge_command,
                "fulu_bambu_network_rpc",
                "bridge_command",
                true,
                true
              ),
              method,
              payload,
              timeoutMs: args?.timeout_ms !== undefined ? Number(args.timeout_ms) : undefined,
              allowMutatingMethod: Boolean(args?.allow_mutating_method ?? false),
              bambuModel: rpcBambuModel,
            });
            break;
          }

          case "merge_vertices":
            if (!args?.stl_path) {
                throw new Error("Missing required parameter: stl_path");
            }
            result = await this.stlManipulator.mergeVertices(
                String(args.stl_path),
                args.tolerance !== undefined ? Number(args.tolerance) : undefined // Pass tolerance if provided
            );
            break;

          case "center_model":
            if (!args?.stl_path) {
                throw new Error("Missing required parameter: stl_path");
            }
            result = await this.stlManipulator.centerModel(String(args.stl_path));
            break;

          case "lay_flat":
            if (!args?.stl_path) {
                throw new Error("Missing required parameter: stl_path");
            }
            result = await this.stlManipulator.layFlat(String(args.stl_path));
            break;

          case "blender_mcp_status":
            result = await this.blender.status(args ?? {}, extra.signal);
            break;

          case "blender_mcp_call":
            return await this.blender.call(args ?? {}, extra.signal);

          case "blender_mcp_export_stl":
            result = await this.blender.exportStl(args ?? {}, extra.signal);
            break;

          case "blender_mcp_edit_model":
            result = await this.blender.edit(
              args ?? {},
              this.resolveExecutableSelectorArg(
                args?.bridge_command,
                "blender_mcp_edit_model",
                "bridge_command",
                true,
                true
              ) ?? (!process.env.BLENDER_MCP_COMMAND?.trim() ? this.runtimeConfig.blenderBridgeCommand : undefined),
              extra.signal
            );
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
      } catch (error: unknown) {
        console.error(`Error calling tool ${name}:`, error);
        
        const errorMessage = error instanceof Error ? error.message : String(error);
        const structuredError = this.toStructuredToolError(name, errorMessage);
        
        return {
          content: [
            {
              type: "text",
              text: `Error: ${errorMessage}\nSuggestion: ${structuredError.suggestion}`
            }
          ],
          structuredContent: structuredError,
          isError: true
        };
      }
    });
  }

  // Delegating methods to printer implementations
  
  async getPrinterStatus(
    host: string, 
    port = DEFAULT_PORT, 
    type = DEFAULT_TYPE, 
    apiKey = DEFAULT_API_KEY,
    bambuSerial = DEFAULT_BAMBU_SERIAL,
    bambuToken = DEFAULT_BAMBU_TOKEN
  ) {
    const implementation = this.printerFactory.getImplementation(type);
    
    if (type.toLowerCase() === "bambu") {
      const bambuApiKey = `${bambuSerial}:${bambuToken}`;
      return implementation.getStatus(host, port, bambuApiKey);
    }
    
    return implementation.getStatus(host, port, apiKey);
  }

  async getPrinterFiles(
    host: string, 
    port = DEFAULT_PORT, 
    type = DEFAULT_TYPE, 
    apiKey = DEFAULT_API_KEY,
    bambuSerial = DEFAULT_BAMBU_SERIAL,
    bambuToken = DEFAULT_BAMBU_TOKEN
  ) {
    const implementation = this.printerFactory.getImplementation(type);
    
    if (type.toLowerCase() === "bambu") {
      const bambuApiKey = `${bambuSerial}:${bambuToken}`;
      return implementation.getFiles(host, port, bambuApiKey);
    }
    
    return implementation.getFiles(host, port, apiKey);
  }

  async getPrinterFile(
    host: string, 
    filename: string, 
    port = DEFAULT_PORT, 
    type = DEFAULT_TYPE, 
    apiKey = DEFAULT_API_KEY,
    bambuSerial = DEFAULT_BAMBU_SERIAL,
    bambuToken = DEFAULT_BAMBU_TOKEN
  ) {
    const implementation = this.printerFactory.getImplementation(type);
    
    if (type.toLowerCase() === "bambu") {
      const bambuApiKey = `${bambuSerial}:${bambuToken}`;
      return implementation.getFile(host, port, bambuApiKey, filename);
    }
    
    return implementation.getFile(host, port, apiKey, filename);
  }

  async uploadGcode(
    host: string, 
    port: string, 
    type: string, 
    apiKey: string,
    bambuSerial: string,
    bambuToken: string, 
    filename: string, 
    gcode: string, 
    print: boolean
  ) {
    const sourceIsFilePath = fs.existsSync(gcode) && fs.statSync(gcode).isFile();
    // The remote filename must never select a local write/delete target.
    const localFilename = path.basename(filename);
    if (!sourceIsFilePath && (!localFilename || localFilename === "." || localFilename === "..")) {
      throw new Error("filename must include a file basename.");
    }
    const scratchDir = sourceIsFilePath ? undefined : fs.mkdtempSync(path.join(TEMP_DIR, "upload-"));
    // Multipart adapters infer their file-part name from this safe basename.
    const tempFilePath = scratchDir ? path.join(scratchDir, localFilename) : gcode;

    try {
      if (scratchDir) fs.writeFileSync(tempFilePath, gcode);
      const implementation = this.printerFactory.getImplementation(type);
      
      if (type.toLowerCase() === "bambu") {
        const bambuApiKey = `${bambuSerial}:${bambuToken}`;
        return await implementation.uploadFile(host, port, bambuApiKey, tempFilePath, filename, print);
      }
      
      return await implementation.uploadFile(host, port, apiKey, tempFilePath, filename, print);
    } finally {
      if (scratchDir) fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  }

  async startPrint(
    host: string, 
    port: string, 
    type: string, 
    apiKey: string,
    bambuSerial: string,
    bambuToken: string, 
    gcodeFilename: string
  ) {
    const implementation = this.printerFactory.getImplementation(type);
    
    if (type.toLowerCase() === "bambu") {
      const bambuApiKey = `${bambuSerial}:${bambuToken}`;
      return await implementation.startJob(host, port, bambuApiKey, gcodeFilename);
    }
    
    return await implementation.startJob(host, port, apiKey, gcodeFilename);
  }

  async cancelPrint(
    host: string, 
    port: string, 
    type: string, 
    apiKey: string,
    bambuSerial: string,
    bambuToken: string
  ) {
    const implementation = this.printerFactory.getImplementation(type);
    
    if (type.toLowerCase() === "bambu") {
      const bambuApiKey = `${bambuSerial}:${bambuToken}`;
      return await implementation.cancelJob(host, port, bambuApiKey);
    }
    
    return await implementation.cancelJob(host, port, apiKey);
  }

  async setPrinterTemperature(
    host: string, 
    port: string, 
    type: string, 
    apiKey: string,
    bambuSerial: string,
    bambuToken: string,
    component: string, 
    temperature: number
  ) {
    const implementation = this.printerFactory.getImplementation(type);
    
    if (type.toLowerCase() === "bambu") {
      const bambuApiKey = `${bambuSerial}:${bambuToken}`;
      return implementation.setTemperature(host, port, bambuApiKey, component, temperature);
    }
    
    return implementation.setTemperature(host, port, apiKey, component, temperature);
  }

  private toStructuredToolError(tool: string, message: string): StructuredToolError {
    const isInputError =
      message.toLowerCase().includes("missing required") ||
      message.toLowerCase().includes("invalid") ||
      message.toLowerCase().includes("unsupported");

    return {
      status: "error",
      retryable: !isInputError,
      suggestion: isInputError
        ? "Fix tool arguments and retry."
        : "Retry the call. If it keeps failing, verify printer connectivity and credentials.",
      message,
      tool,
    };
  }

  private async parseHttpRequestBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    if (chunks.length === 0) {
      return undefined;
    }

    const rawBody = Buffer.concat(chunks).toString("utf8").trim();
    if (!rawBody) {
      return undefined;
    }

    return JSON.parse(rawBody);
  }

  private isAllowedOrigin(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) {
      return true;
    }

    if (this.runtimeConfig.allowedOrigins.size === 0) {
      return false;
    }

    return this.runtimeConfig.allowedOrigins.has(origin);
  }

  private async connectStdio(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("3D Printer MCP server running on stdio transport");
  }

  private async connectStreamableHttp(): Promise<void> {
    if (this.httpRuntime) {
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: this.runtimeConfig.statefulSession ? () => randomUUID() : undefined,
      enableJsonResponse: this.runtimeConfig.enableJsonResponse
    });

    await this.server.connect(transport);

    const requestHandler = async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        if (url.pathname !== this.runtimeConfig.httpPath) {
          res.statusCode = 404;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: "Not Found" }));
          return;
        }

        if (!this.isAllowedOrigin(req)) {
          res.statusCode = 403;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: "Forbidden origin" }));
          return;
        }

        const method = req.method?.toUpperCase() ?? "GET";
        if (!["POST", "GET", "DELETE"].includes(method)) {
          res.statusCode = 405;
          res.setHeader("allow", "POST, GET, DELETE");
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: "Method Not Allowed" }));
          return;
        }

        let parsedBody: unknown;
        if (method === "POST") {
          try {
            parsedBody = await this.parseHttpRequestBody(req);
          } catch {
            res.statusCode = 400;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: "Invalid JSON body" }));
            return;
          }
        }

        await transport.handleRequest(req, res, parsedBody);
      } catch (error) {
        console.error("Error handling streamable-http request:", error);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32603, message: "Internal server error" },
              id: null
            })
          );
        }
      }
    };

    const httpServer = createHttpServer((req, res) => {
      void requestHandler(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(this.runtimeConfig.httpPort, this.runtimeConfig.httpHost, () => resolve());
    });

    this.httpRuntime = { transport, httpServer };
    console.error(
      `3D Printer MCP server running on streamable-http at http://${this.runtimeConfig.httpHost}:${this.runtimeConfig.httpPort}${this.runtimeConfig.httpPath}`
    );
  }

  /**
   * Bridge commands and path-derived bridge executables are machine-local
   * settings. Accepting their selectors as tool arguments means anything that
   * can steer the model — a model description, a README in a downloaded
   * archive, 3MF metadata — can choose the program this server runs. They are
   * read from environment configuration by default and only accepted for
   * execution when MCP_ALLOW_EXECUTABLE_ARG is set. The older
   * MCP_ALLOW_BRIDGE_COMMAND_ARG name remains a compatibility alias only for
   * bridge commands and path selectors used to derive a bridge executable.
   */
  private resolveExecutableSelectorArg(
    rawValue: unknown,
    toolName: string,
    argumentName: string,
    executionRequested = true,
    allowLegacyBridgeArg = false
  ): string | undefined {
    if (rawValue === undefined) {
      return undefined;
    }

    const value = String(rawValue);
    if (value.length === 0) {
      return undefined;
    }

    const isAllowed =
      this.runtimeConfig.allowExecutableArg ||
      (allowLegacyBridgeArg && this.runtimeConfig.allowBridgeCommandArg);
    if (executionRequested && !isAllowed) {
      throw new Error(
        `${toolName}: the ${argumentName} argument cannot select an executable by default. ` +
        "Executable paths and commands are read from server environment configuration. Set " +
        `MCP_ALLOW_EXECUTABLE_ARG=1 to accept ${argumentName} for process execution.`
      );
    }

    return value;
  }

  async close(): Promise<void> {
    await this.printerFactory.disconnectAll();

    if (this.httpRuntime) {
      await this.httpRuntime.transport.close();
      await new Promise<void>((resolve, reject) => {
        this.httpRuntime?.httpServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      this.httpRuntime = undefined;
    } else {
      await this.server.close();
    }
  }

  async run(): Promise<void> {
    if (this.runtimeConfig.transport === "streamable-http") {
      await this.connectStreamableHttp();
      return;
    }

    await this.connectStdio();
  }
}

const server = new ThreeDPrinterMCPServer();

const shutdown = async () => {
  await server.close();
  process.exit(0);
};

process.once("SIGINT", () => {
  void shutdown();
});

process.once("SIGTERM", () => {
  void shutdown();
});

server.run().catch((error) => {
  console.error("[mcp-3d-printer-server] startup failed:", error);
  process.exit(1);
});
