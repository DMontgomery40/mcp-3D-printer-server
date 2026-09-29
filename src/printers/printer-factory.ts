import { PrinterImplementation } from "../types.js";
import { OctoPrintImplementation } from "./octoprint.js";
import { KlipperImplementation } from "./klipper.js";
import { DuetImplementation } from "./duet.js";
import { RepetierImplementation } from "./repetier.js";
import { BambuImplementation } from "./bambu.js";
import { PrusaImplementation } from "./prusa.js";
import { CrealityImplementation } from "./creality.js";
import type { ConfirmHardware } from "../safety/confirmation.js";
import type { PrintSafetyOptions } from "../safety/expected-peaks.js";
import axios from "axios";

/** Every adapter accepts trailing safety options on its print and heating mutations. */
export type GuardedPrinterImplementation = PrinterImplementation & {
  uploadFile(host: string, port: string, apiKey: string, filePath: string, filename: string, print: boolean, options?: PrintSafetyOptions): Promise<any>;
  startJob(host: string, port: string, apiKey: string, filename: string, options?: PrintSafetyOptions): Promise<any>;
  setTemperature(host: string, port: string, apiKey: string, component: string, temperature: unknown, options?: PrintSafetyOptions): Promise<any>;
};

export class PrinterFactory {
  private implementations: Map<string, PrinterImplementation> = new Map();
  private apiClient = axios.create({ timeout: 10000 });

  /** confirm is the human (MCP elicitation) confirmation used before prints and positive heating. */
  constructor(confirm?: ConfirmHardware) {
    this.implementations.set("octoprint", new OctoPrintImplementation(this.apiClient, confirm));
    this.implementations.set("klipper", new KlipperImplementation(this.apiClient, confirm));
    this.implementations.set("duet", new DuetImplementation(this.apiClient, confirm));
    this.implementations.set("repetier", new RepetierImplementation(this.apiClient, confirm));
    this.implementations.set("bambu", new BambuImplementation(this.apiClient, confirm));
    this.implementations.set("prusa", new PrusaImplementation(this.apiClient, confirm));
    this.implementations.set("creality", new CrealityImplementation(this.apiClient, confirm));
  }

  getImplementation(type: string): GuardedPrinterImplementation {
    const implementation = this.implementations.get(type.toLowerCase());
    if (!implementation) {
      throw new Error(`Unsupported printer type: ${type}`);
    }
    return implementation as GuardedPrinterImplementation;
  }

  async disconnectAll(): Promise<void> {
    // Disconnect all printers if needed
    const bambuImpl = this.implementations.get("bambu") as BambuImplementation;
    if (bambuImpl) {
      await bambuImpl.disconnectAll();
    }
  }
}
