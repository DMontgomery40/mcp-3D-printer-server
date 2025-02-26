import { BambuPrinterStore } from "../types.js";
import { OctoPrintImplementation } from "./octoprint.js";
import { KlipperImplementation } from "./klipper.js";
import { DuetImplementation } from "./duet.js";
import { RepetierImplementation } from "./repetier.js";
import { BambuImplementation } from "./bambu.js";
import { PrusaImplementation } from "./prusa.js";
import { CrealityImplementation } from "./creality.js";
import axios from "axios";
export class PrinterFactory {
    constructor() {
        this.implementations = new Map();
        this.bambuPrinterStore = new BambuPrinterStore();
        this.apiClient = axios.create({ timeout: 10000 });
        this.implementations.set("octoprint", new OctoPrintImplementation(this.apiClient));
        this.implementations.set("klipper", new KlipperImplementation(this.apiClient));
        this.implementations.set("duet", new DuetImplementation(this.apiClient));
        this.implementations.set("repetier", new RepetierImplementation(this.apiClient));
        this.implementations.set("bambu", new BambuImplementation(this.apiClient, this.bambuPrinterStore));
        this.implementations.set("prusa", new PrusaImplementation(this.apiClient));
        this.implementations.set("creality", new CrealityImplementation(this.apiClient));
    }
    getImplementation(type) {
        const implementation = this.implementations.get(type.toLowerCase());
        if (!implementation) {
            throw new Error(`Unsupported printer type: ${type}`);
        }
        return implementation;
    }
    async disconnectAll() {
        await this.bambuPrinterStore.disconnectAll();
    }
}
