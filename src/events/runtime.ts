import { isAbsolute } from "node:path";
import { EventStore } from "./store.js";
import { PrintEventDetector } from "./detector.js";
import { listPrintEvents } from "./service.js";

export type ObservePrinter = (printer: any, host: string, serial: string) => void;
export const PRINT_EVENTS_TOOL = { name: "list_print_events", description: "Read locally recorded Bambu print completion/problem observations. Requires MCP_PRINT_EVENT_STORE; does not create a subscription or wake ChatGPT.",
  inputSchema: { type: "object", properties: { cursor: { type: "string", description: "Resume after the returned cursor; default 0." }, limit: { description: "Maximum observations returned, 1–100 (default 100).", type: "integer", minimum: 1, maximum: 100, default: 100 } }, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } };
/** Opt-in passive capture from existing connections only. Never creates a printer connection. */
export class PrintEventRuntime {
  readonly detector: PrintEventDetector;
  private failed = false;
  constructor(readonly store: EventStore, private readonly host: string, private readonly serial: string) {
    this.detector = new PrintEventDetector(store);
  }
  private safely(operation: () => void): void {
    if (this.failed) return;
    try { operation(); } catch { this.failed = true; console.error("Print event recording stopped: journal write failed. Printer controls remain available."); }
  }
  readonly attach: ObservePrinter = (printer, host, serial) => {
    if (host !== this.host || serial !== this.serial) return;
    printer.on("rawMessage", (topic: string, payload: Buffer) => {
      if (topic !== `device/${serial}/report` || payload.length > 262144) return;
      let report;
      try { report = JSON.parse(payload.toString()).print; } catch { return; }
      if (report && typeof report === "object" && !Array.isArray(report)) this.safely(() => this.detector.observe(report));
    });
    printer.on("client:disconnect", () => this.detector.disconnected());
    printer.on("client:error", () => this.detector.disconnected());
  };
  cancel(host: string, serial: string, persist = true): void {
    if (host === this.host && serial === this.serial) this.safely(() => this.detector.cancel(persist));
  }
  persist(): void { this.safely(() => this.store.save()); }
  list(args: any) {
    if (this.failed) throw new Error("Print event journal failed; restart after repairing storage");
    return listPrintEvents(this.store, args?.cursor ?? "0", args?.limit ?? 100);
  }
  close(): void { this.store.close(); }
}
export function createPrintEventRuntime(host: string, serial: string): PrintEventRuntime | undefined {
  const filename = process.env.MCP_PRINT_EVENT_STORE;
  if (!filename) return undefined;
  try {
    if (!isAbsolute(filename) || !serial.trim()) throw new Error("Invalid event configuration");
    const runtime = new PrintEventRuntime(new EventStore(filename), host, serial);
    process.once("exit", () => runtime.close());
    return runtime;
  } catch {
    console.error("Print event recording disabled: invalid configuration or unavailable journal. Printer controls remain available.");
    return undefined;
  }
}
