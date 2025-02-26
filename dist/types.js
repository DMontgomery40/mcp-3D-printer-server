import { BambuPrinter } from "bambu-js";
// Base class for printer implementations
export class PrinterImplementation {
    constructor(apiClient) {
        this.apiClient = apiClient;
    }
}
// Store for Bambu printers
export class BambuPrinterStore {
    constructor() {
        this.printers = new Map();
    }
    get(host, serial, token) {
        const key = `${host}-${serial}`;
        if (!this.printers.has(key)) {
            const printer = new BambuPrinter(host, serial, token);
            this.printers.set(key, printer);
        }
        return this.printers.get(key);
    }
    async disconnectAll() {
        for (const printer of this.printers.values()) {
            await printer.disconnect();
        }
    }
}
