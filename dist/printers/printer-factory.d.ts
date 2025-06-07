import { PrinterImplementation } from "../types.js";
export declare class PrinterFactory {
    private implementations;
    private apiClient;
    constructor();
    getImplementation(type: string): PrinterImplementation;
    disconnectAll(): Promise<void>;
}
