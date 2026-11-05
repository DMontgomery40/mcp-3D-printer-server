/**
 * counterpart_discover_printers (counterpart/1): printers on the local network. Bambu printers from their own SSDP
 * announcements (NOTIFY on UDP 2021, and the answers to one M-SEARCH); OctoPrint, Moonraker (Klipper) and PrusaLink
 * hosts from their Bonjour adverts (dns-sd on macOS, avahi-browse on Linux). Bounded and never failing: a port another
 * app holds (Bambu Studio) is "unavailable", not "none found". Never fetches a URL, connects to or authenticates with a printer.
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { createSocket, type Socket } from "node:dgram";
import { isIPv4 } from "node:net";
import { networkInterfaces } from "node:os";
import { createInterface } from "node:readline";
import { normalizeModel } from "../safety/limits.js";
import { MODEL_IDS, SERIAL_MODELS } from "../safety/printer-state.js";
import { COUNTERPART_CONTRACT, PRINTER_KINDS } from "./contract.js";

export type FoundPrinter = {
  kind: typeof PRINTER_KINDS[number]; source: "ssdp" | "bonjour"; name: string; host: string;
  port?: number; serial?: string; model?: string; firmware?: string;
};
export type Discovery = { contract: typeof COUNTERPART_CONTRACT; network: "complete" | "unavailable"; printers: FoundPrinter[] };

/** This server's model value (bambu_model) for a serial number's first three characters, when it has one. */
export function modelFromSerial(serial: string | undefined): string | undefined {
  return serial ? normalizeModel(SERIAL_MODELS[serial.trim().slice(0, 3).toUpperCase()] ?? "") : undefined;
}
/**
 * DevModel ids Bambu Studio's machine definitions (profiles/BBL/machine/*.json `model_id`) use that the safety identity
 * table doesn't list, for naming a found printer only. Never identity evidence for a print.
 */
const ANNOUNCED_MODEL_IDS: Record<string, string> = { N1: "A1 Mini", N7: "P2S" };
/** This server's model value for a DevModel id Bambu Studio's printer definitions use (C12 is the P1S). */
export function modelFromDevModel(id: string | undefined): string | undefined {
  const key = id?.trim().toUpperCase();
  return key ? normalizeModel(MODEL_IDS[key] ?? ANNOUNCED_MODEL_IDS[key] ?? "") : undefined;
}

export function privateIPv4(value: string): boolean {
  if (!isIPv4(value)) return false;
  const [a, b] = value.split(".").map(Number) as [number, number];
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/** One SSDP packet from a Bambu printer. The sender must be the printer itself (Location equals its address). */
export function parseBambuAdvert(packet: Buffer, address: string): FoundPrinter | undefined {
  if (packet.length > 8192 || !privateIPv4(address)) return undefined;
  const lines = packet.toString("utf8").split("\r\n");
  if (!["NOTIFY * HTTP/1.1", "HTTP/1.1 200 OK"].includes(lines.shift() ?? "")) return undefined;
  const headers = new Map<string, string>();
  for (const line of lines) {
    if (!line) continue;
    const at = line.indexOf(":");
    if (at < 1) return undefined;
    const key = line.slice(0, at).trim().toLowerCase(), value = line.slice(at + 1).trim();
    if (headers.has(key) || /[\x00-\x1f\x7f]/.test(value)) return undefined;
    headers.set(key, value);
  }
  if (headers.get("location") !== address) return undefined;
  const serial = headers.get("usn"), devModel = headers.get("devmodel.bambu.com");
  if (!serial || !/^[A-Za-z0-9]{1,64}$/.test(serial) || !devModel || devModel.length > 64) return undefined;
  const firmware = headers.get("devversion.bambu.com");
  const model = modelFromDevModel(devModel) ?? modelFromSerial(serial);
  return { kind: "bambu", source: "ssdp", host: address, serial: serial.toUpperCase(), ...(model ? { model } : {}),
    name: (headers.get("devname.bambu.com") || devModel).slice(0, 128),
    ...(firmware && /^\d{2}\.\d{2}\.\d{2}\.\d{2}$/.test(firmware) ? { firmware } : {}) };
}

/** A send completes before the next interface: dgram resolves addresses asynchronously even for IP literals. */
export async function sendDiscoveryProbes(socket: Pick<Socket, "addMembership" | "setMulticastInterface" | "setMulticastTTL" | "send">, addresses: string[], active: () => boolean) {
  for (const address of addresses) {
    if (!active()) return;
    try {
      socket.addMembership("239.255.255.250", address);
      socket.setMulticastInterface(address); socket.setMulticastTTL(1);
      await new Promise<void>((resolve, reject) => socket.send("M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:2021\r\nMAN: \"ssdp:discover\"\r\nMX: 1\r\nST: urn:bambulab-com:device:3dprinter:1\r\n\r\n",
        2021, "239.255.255.250", error => error ? reject(error) : resolve()));
    } catch { /* Other interfaces can still answer. */ }
  }
}

/** Listens on UDP 2021 for `durationMs` (bounded 500–15000 ms). */
export function discoverBambu(durationMs = 4000): Promise<{ state: "complete" | "unavailable"; printers: FoundPrinter[] }> {
  const ms = Number.isFinite(durationMs) ? Math.max(500, Math.min(15_000, Math.round(durationMs))) : 4000;
  return new Promise(resolve => {
    const socket = createSocket({ type: "udp4", reuseAddr: true }), found = new Map<string, FoundPrinter>();
    let finished = false;
    const finish = (state: "complete" | "unavailable") => {
      if (finished) return; finished = true; clearTimeout(timer);
      try { socket.close(); } catch { /* not bound yet */ }
      resolve({ state, printers: [...found.values()].sort((a, b) => (a.serial ?? "").localeCompare(b.serial ?? "")) });
    };
    const timer = setTimeout(() => finish("complete"), ms);
    socket.on("error", () => finish("unavailable"));
    socket.on("message", (data, peer) => { const value = parseBambuAdvert(data, peer.address); if (value && found.size < 64) found.set(`${value.serial}@${value.host}`, value); });
    try {
      socket.bind(2021, "0.0.0.0", () => {
        const interfaces = Object.values(networkInterfaces()).flat().filter(nic => nic && !nic.internal && nic.family === "IPv4" && privateIPv4(nic.address));
        void sendDiscoveryProbes(socket, interfaces.map(nic => nic!.address), () => !finished);
      });
    } catch { finish("unavailable"); }
  });
}


/** Bonjour types other printers' hosts advertise, and this server's PRINTER_TYPE for each. */
export const BONJOUR_TYPES: Record<string, typeof PRINTER_KINDS[number]> = {
  "_octoprint._tcp": "octoprint",
  // Moonraker's zeroconf component (Klipper); PrusaLink's type is best-effort (it may only advertise _http._tcp).
  "_moonraker._tcp": "klipper",
  "_prusalink._tcp": "prusa",
};
const HOSTNAME = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
function bonjourPrinter(type: string, name: string, target: string, port: string): FoundPrinter | undefined {
  const host = target.replace(/\.$/, "");
  const number = Number(port);
  if (!HOSTNAME.test(host) || !/^\d{1,5}$/.test(port) || number < 1 || number > 65535) return undefined;
  return { kind: BONJOUR_TYPES[type] ?? "octoprint", source: "bonjour", name: name.slice(0, 128), host, port: number };
}

/** `dns-sd -Z` zone lines: `<instance>.<type> SRV <priority> <weight> <port> <target>`. */
export function parseZoneLine(line: string, type: string): FoundPrinter | undefined {
  const match = /^(\S+)\s+SRV\s+\d+\s+\d+\s+(\d{1,5})\s+(\S+)/.exec(line.trim());
  if (!match) return undefined;
  const [, instance, port, target] = match as unknown as [string, string, string, string];
  const suffix = `.${type}`;
  const raw = instance.endsWith(suffix) ? instance.slice(0, -suffix.length) : instance;
  // One pass: `\\032` is an escaped backslash followed by "032", not a space.
  const name = raw.replace(/\\(\d{3}|.)/g, (_, code: string) => code.length === 3 ? String.fromCharCode(Number(code)) : code);
  return bonjourPrinter(type, name, target, port);
}

/**
 * `avahi-browse --parsable --resolve` lines for one type:
 * `=;<interface>;<IPv4|IPv6>;<instance>;<type>;<domain>;<host>;<address>;<port>;<txt>`.
 * Only resolved IPv4 rows count, so one service on several interfaces or families is listed once by host and port.
 */
export function parseAvahiLine(line: string, type: string): FoundPrinter | undefined {
  const fields = line.split(";");
  if (fields.length < 9 || fields[0] !== "=" || fields[2] !== "IPv4" || fields[4] !== type) return undefined;
  const [, , , instance, , , target, , port] = fields as [string, string, string, string, string, string, string, string, string];
  const name = instance.replace(/\\(\d{3}|.)/g, (_, code: string) => code.length === 3 ? String.fromCharCode(Number(code)) : code);
  return bonjourPrinter(type, name, target, port);
}

export type Spawn = (command: string, args: string[], options: { stdio: ["ignore", "pipe", "ignore"] }) => ChildProcess;

/**
 * Browses each type for `durationMs`: with mDNSResponder's own `dns-sd -Z` on macOS, and with the Avahi daemon's
 * `avahi-browse` on Linux (`-t` ends once its cache is listed and resolved; the timer bounds both). A missing
 * browser only means nothing was found that way.
 */
export function discoverBonjour(durationMs = 3000, options: { spawn?: Spawn; platform?: NodeJS.Platform } = {}): Promise<FoundPrinter[]> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux") return Promise.resolve([]);
  const spawn = options.spawn ?? (nodeSpawn as Spawn);
  const linux = platform === "linux";
  const ms = Number.isFinite(durationMs) ? Math.max(500, Math.min(15_000, Math.round(durationMs))) : 4000;
  return Promise.all(Object.keys(BONJOUR_TYPES).map(type => new Promise<FoundPrinter[]>(resolve => {
    const found = new Map<string, FoundPrinter>();
    let child: ChildProcess;
    try {
      child = linux
        ? spawn("/usr/bin/avahi-browse", ["--parsable", "--resolve", "--terminate", "--no-db-lookup", type], { stdio: ["ignore", "pipe", "ignore"] })
        : spawn("/usr/bin/dns-sd", ["-Z", type, "local"], { stdio: ["ignore", "pipe", "ignore"] });
    } catch { resolve([]); return; }
    let settled = false;
    const done = () => { if (settled) return; settled = true; clearTimeout(timer); try { child.kill(); } catch { /* gone */ } resolve([...found.values()]); };
    const timer = setTimeout(done, ms);
    child.on("error", done);
    // avahi-browse -t exits once it has listed everything (close: after its output drains); dns-sd never exits on its own.
    if (linux) child.on("close", done);
    if (child.stdout) createInterface({ input: child.stdout }).on("line", line => {
      const service = linux ? parseAvahiLine(line, type) : parseZoneLine(line, type);
      if (service && found.size < 32) found.set(`${service.host}:${service.port}`, service);
    });
  }))).then(lists => lists.flat());
}

/** Both scans at once, for `durationMs` (bounded 500–15000 ms). */
export async function discoverPrinters(durationMs = 4000, options: { bambu?: typeof discoverBambu; bonjour?: typeof discoverBonjour } = {}): Promise<Discovery> {
  const [bambu, others] = await Promise.all([
    (options.bambu ?? discoverBambu)(durationMs).catch(() => ({ state: "unavailable" as const, printers: [] })),
    (options.bonjour ?? discoverBonjour)(durationMs).catch(() => []),
  ]);
  return { contract: COUNTERPART_CONTRACT, network: bambu.state, printers: [...bambu.printers, ...others] };
}

export const DISCOVER_OUTPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    contract: { type: "string", const: COUNTERPART_CONTRACT },
    network: { type: "string", enum: ["complete", "unavailable"] },
    printers: { type: "array", items: { type: "object", properties: {
      kind: { type: "string", enum: [...PRINTER_KINDS] }, source: { type: "string", enum: ["ssdp", "bonjour"] }, name: { type: "string" },
      host: { type: "string" }, port: { type: "integer" }, serial: { type: "string" }, model: { type: "string" }, firmware: { type: "string" },
    }, required: ["kind", "source", "name", "host"] } },
  },
  required: ["contract", "network", "printers"],
};
