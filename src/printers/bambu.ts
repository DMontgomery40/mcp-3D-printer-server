import { PrinterImplementation } from "../types.js";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { BambuPrinter } from "bambu-js";
import {
  BambuClient,
  GCodeFileCommand,
  GCodeLineCommand,
  PushAllCommand,
  UpdateStateCommand,
} from "bambu-node";

interface BambuPrintOptionsInternal {
  projectName: string;
  filePath: string;
  useAMS?: boolean;
  plateIndex?: number;
  bedLeveling?: boolean;
  flowCalibration?: boolean;
  vibrationCalibration?: boolean;
  layerInspect?: boolean;
  timelapse?: boolean;
  amsMapping?: number[];
  md5?: string;
}

interface ProjectFileMetadata {
  plateFileName: string;
  plateInternalPath: string;
  md5: string;
}

class BambuClientStore {
  private printers: Map<string, BambuClient> = new Map();
  private initialConnectionPromises: Map<string, Promise<void>> = new Map();

  async getPrinter(host: string, serial: string, token: string): Promise<BambuClient> {
    const key = `${host}-${serial}`;

    if (this.printers.has(key)) {
      return this.printers.get(key)!;
    }

    if (this.initialConnectionPromises.has(key)) {
      await this.initialConnectionPromises.get(key);
      if (this.printers.has(key)) {
        return this.printers.get(key)!;
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

    const connectPromise = printer.connect().then(() => {});
    this.initialConnectionPromises.set(key, connectPromise);

    try {
      await connectPromise;
      return printer;
    } catch (error) {
      this.initialConnectionPromises.delete(key);
      throw error;
    }
  }

  async disconnectAll(): Promise<void> {
    const disconnectPromises: Promise<void>[] = [];

    for (const printer of this.printers.values()) {
      disconnectPromises.push(
        (async () => {
          try {
            await printer.disconnect();
          } catch (error) {
            console.error("Failed to disconnect Bambu client", error);
          }
        })()
      );
    }

    await Promise.allSettled(disconnectPromises);
    this.printers.clear();
    this.initialConnectionPromises.clear();
  }
}

export class BambuImplementation extends PrinterImplementation {
  private printerStore: BambuClientStore;

  constructor(apiClient: any) {
    super(apiClient);
    this.printerStore = new BambuClientStore();
  }

  private async getPrinter(host: string, serial: string, token: string): Promise<BambuClient> {
    return this.printerStore.getPrinter(host, serial, token);
  }

  private async resolveProjectFileMetadata(
    localThreeMfPath: string,
    plateIndex?: number
  ): Promise<ProjectFileMetadata> {
    const archive = await fs.readFile(localThreeMfPath);
    const zip = await JSZip.loadAsync(archive);

    const plateEntries = Object.values(zip.files).filter(
      (entry) => !entry.dir && /^Metadata\/plate_\d+\.gcode$/i.test(entry.name)
    );

    if (plateEntries.length === 0) {
      throw new Error(
        "3MF does not contain any Metadata/plate_<n>.gcode entries. Re-slice and export a printable 3MF."
      );
    }

    let selectedEntry = plateEntries.sort((a, b) => a.name.localeCompare(b.name))[0];

    if (plateIndex !== undefined) {
      const expectedEntryName = `Metadata/plate_${plateIndex + 1}.gcode`;
      const matchedEntry = plateEntries.find(
        (entry) => entry.name.toLowerCase() === expectedEntryName.toLowerCase()
      );

      if (!matchedEntry) {
        const available = plateEntries.map((entry) => entry.name).join(", ");
        throw new Error(
          `Requested plateIndex=${plateIndex} (${expectedEntryName}) not present in 3MF. Available: ${available}`
        );
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

  async getStatus(host: string, port: string, apiKey: string): Promise<any> {
    const [serial, token] = this.extractBambuCredentials(apiKey);

    try {
      const printer = await this.getPrinter(host, serial, token);

      try {
        await printer.executeCommand(new PushAllCommand());
      } catch (error) {
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
    } catch (error) {
      console.error(`Failed to get Bambu status for ${serial}:`, error);
      return { status: "error", connected: false, error: (error as Error).message };
    }
  }

  async print3mf(
    host: string,
    serial: string,
    token: string,
    options: BambuPrintOptionsInternal
  ): Promise<any> {
    if (!options.filePath.toLowerCase().endsWith(".3mf")) {
      throw new Error("print3mf requires a .3mf input file.");
    }

    const projectMetadata = await this.resolveProjectFileMetadata(
      options.filePath,
      options.plateIndex
    );

    const remoteProjectPath = `cache/${path.basename(options.filePath)}`;
    const printer = new BambuPrinter(host, serial, token);

    try {
      await printer.manipulateFiles(async (context) => {
        await context.sendFile(options.filePath, remoteProjectPath);
      });

      await printer.connect();
      await printer.awaitInitialState(10_000).catch(() => undefined);

      printer.printProjectFile(
        remoteProjectPath,
        projectMetadata.plateFileName,
        options.projectName,
        options.md5 ?? projectMetadata.md5,
        {
          bedLeveling: options.bedLeveling,
          flowCalibration: options.flowCalibration,
          vibrationCalibration: options.vibrationCalibration,
          layerInspect: options.layerInspect,
          timelaspe: options.timelapse,
        }
      );

      await new Promise((resolve) => setTimeout(resolve, 300));

      const response: Record<string, unknown> = {
        status: "success",
        message: `Uploaded and started 3MF print: ${options.projectName}`,
        remoteProjectPath,
        plateFile: projectMetadata.plateFileName,
        platePath: projectMetadata.plateInternalPath,
        md5: options.md5 ?? projectMetadata.md5,
      };

      if (options.useAMS === false) {
        response.warning =
          "bambu-js currently always sends use_ams=true in project_file commands.";
      }

      return response;
    } finally {
      if (printer.isConnected) {
        await printer.disconnect().catch(() => undefined);
      }
    }
  }

  async cancelJob(host: string, port: string, apiKey: string): Promise<any> {
    const [serial, token] = this.extractBambuCredentials(apiKey);
    const printer = await this.getPrinter(host, serial, token);

    try {
      await printer.executeCommand(new UpdateStateCommand({ state: "stop" }));
      return { status: "success", message: "Cancel command sent successfully." };
    } catch (error) {
      throw new Error(`Failed to cancel print: ${(error as Error).message}`);
    }
  }

  async setTemperature(
    host: string,
    port: string,
    apiKey: string,
    component: string,
    temperature: number
  ) {
    const [serial, token] = this.extractBambuCredentials(apiKey);
    const printer = await this.getPrinter(host, serial, token);

    const normalizedComponent = component.toLowerCase();
    const targetTemperature = Math.round(temperature);

    if (targetTemperature < 0 || targetTemperature > 300) {
      throw new Error("Temperature must be between 0 and 300°C.");
    }

    let gcode: string;
    if (normalizedComponent === "bed") {
      gcode = `M140 S${targetTemperature}`;
    } else if (
      normalizedComponent === "extruder" ||
      normalizedComponent === "nozzle" ||
      normalizedComponent === "tool" ||
      normalizedComponent === "tool0"
    ) {
      gcode = `M104 S${targetTemperature}`;
    } else {
      throw new Error(
        `Unsupported temperature component: ${component}. Use one of: bed, nozzle, extruder.`
      );
    }

    await printer.executeCommand(new GCodeLineCommand({ gcodes: [gcode] }));
    return {
      status: "success",
      message: `Temperature command sent for ${normalizedComponent}.`,
      command: gcode,
    };
  }

  async getFiles(host: string, port: string, apiKey: string) {
    const [serial, token] = this.extractBambuCredentials(apiKey);
    const printer = new BambuPrinter(host, serial, token);
    const directories = ["cache", "timelapse", "logs"];
    const filesByDirectory: Record<string, string[]> = {};

    await printer.manipulateFiles(async (context) => {
      for (const directory of directories) {
        try {
          filesByDirectory[directory] = await context.readDir(directory);
        } catch {
          filesByDirectory[directory] = [];
        }
      }
    });

    const files = Object.entries(filesByDirectory).flatMap(([directory, names]) =>
      names.map((name) => `${directory}/${name}`)
    );

    return {
      files,
      directories: filesByDirectory,
    };
  }

  async getFile(host: string, port: string, apiKey: string, filename: string) {
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

  async uploadFile(
    host: string,
    port: string,
    apiKey: string,
    filePath: string,
    filename: string,
    print: boolean
  ) {
    await fs.access(filePath);

    const [serial, token] = this.extractBambuCredentials(apiKey);
    const printer = new BambuPrinter(host, serial, token);

    const normalizedFileName = filename.replace(/^\/+/, "");
    const remotePath = normalizedFileName.includes("/")
      ? normalizedFileName
      : `cache/${normalizedFileName}`;

    await printer.manipulateFiles(async (context) => {
      await context.sendFile(filePath, remotePath);
    });

    const response: Record<string, unknown> = {
      status: "success",
      uploaded: true,
      remotePath,
      printRequested: print,
    };

    if (print) {
      if (remotePath.toLowerCase().endsWith(".gcode")) {
        response.startResult = await this.startJob(host, port, apiKey, remotePath);
      } else if (remotePath.toLowerCase().endsWith(".3mf")) {
        response.note =
          "3MF upload complete. Use print_3mf to start a project print with plate and metadata options.";
      } else {
        throw new Error(
          "Automatic print after upload supports .gcode only. Use print_3mf for .3mf project prints."
        );
      }
    }

    return response;
  }

  async startJob(host: string, port: string, apiKey: string, filename: string) {
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

  private extractBambuCredentials(apiKey: string): [string, string] {
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

  async disconnectAll(): Promise<void> {
    await this.printerStore.disconnectAll();
  }
}
