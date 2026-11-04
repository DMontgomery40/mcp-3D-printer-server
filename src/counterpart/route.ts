/** counterpart_print_route: how this server reaches the printer for prints and controls (PRD §8.4). */
import fs from "node:fs";
import path from "node:path";

/**
 * lan: the local network through FULU's BambuNetwork bridge (or the configured X2D native or Bambu Connect mode).
 * cloud: Bambu Cloud through FULU's bridge.
 * developer: the local network straight to the printer (lan_mqtt_ftps), for a printer in LAN Only + Developer Mode.
 */
export type PrintRoute = "lan" | "cloud" | "developer";
export const PRINT_ROUTES: readonly PrintRoute[] = ["lan", "cloud", "developer"];
export interface Connection { mode: string; type: string }

/** One connection a person can choose, as counterpart_print_route reports it. */
export interface RouteOption {
  id: PrintRoute;
  label: string;
  available: boolean;
  /** Why it can't be chosen here, when it can't. */
  reason?: string;
  /** What Pause, Resume and Stop do on this connection. */
  controls: string;
}

/** Modes that are their own local-network route and stay as configured. */
const OWN_LOCAL_MODES = new Set(["bambu_native", "bambu_connect"]);

export function routeOf(connection: Connection): PrintRoute {
  if (connection.mode === "bambu_network") return connection.type === "cloud" ? "cloud" : "lan";
  if (connection.mode === "lan_mqtt_ftps") return "developer";
  return "lan";
}

/** Every connection, and whether this server can use it (bridgeConfigured: BAMBU_NETWORK_BRIDGE_COMMAND is set). */
export function routeOptions(current: Connection, bridgeConfigured: boolean): RouteOption[] {
  const signedControls = "Uses the configured authenticated connection for Print, Pause, Resume and Stop.";
  const needsBridge = "Needs FULU's BambuNetwork bridge (BAMBU_NETWORK_BRIDGE_COMMAND).";
  const ownLocal = OWN_LOCAL_MODES.has(current.mode);
  return [
    { id: "lan", label: "Local network", available: bridgeConfigured || ownLocal, ...(bridgeConfigured || ownLocal ? {} : { reason: needsBridge }), controls: signedControls },
    { id: "cloud", label: "Bambu Cloud", available: bridgeConfigured, ...(bridgeConfigured ? {} : { reason: needsBridge }), controls: signedControls },
    { id: "developer", label: "Local network, Developer Mode", available: true,
      controls: "Pause, Resume and Stop go straight to the printer. Turn on LAN Only and Developer Mode on the printer first; Bambu Cloud and Bambu Handy then stop working for it." },
  ];
}

/**
 * The configured defaults for a route. Cloud and the local network use FULU's BambuNetwork; an X2D native or
 * Bambu Connect setup keeps its own mode for the local network. Developer Mode is the direct LAN route.
 */
export function connectionForRoute(route: PrintRoute, current: Connection, bridgeConfigured = true): Connection {
  const option = routeOptions(current, bridgeConfigured).find(item => item.id === route);
  if (!option?.available) throw new Error(`The ${option?.label ?? route} connection isn't available here. ${option?.reason ?? ""}`.trim());
  if (route === "cloud") return { mode: "bambu_network", type: "cloud" };
  if (route === "developer") return { mode: "lan_mqtt_ftps", type: "lan" };
  return OWN_LOCAL_MODES.has(current.mode) ? current : { mode: "bambu_network", type: "lan" };
}

/** Set KEY=value lines in a dotenv file, keeping every other line and the file's permissions. */
export function writeEnvValues(file: string, values: Record<string, string>): void {
  const original = fs.readFileSync(file, "utf8");
  const lines = original.split("\n");
  for (const [key, value] of Object.entries(values)) {
    const pattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
    let found = false;
    for (let index = lines.length - 1; index >= 0; index--) {
      if (!pattern.test(lines[index]!)) continue;
      if (!found) { lines[index] = `${key}=${value}`; found = true; }
      // dotenv lets a later line win: keep one line per key, the one written here.
      else lines.splice(index, 1);
    }
    if (!found) {
      if (lines.length && lines[lines.length - 1] === "") lines.splice(lines.length - 1, 0, `${key}=${value}`);
      else lines.push(`${key}=${value}`);
    }
  }
  const mode = fs.statSync(file).mode & 0o777;
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(temporary, lines.join("\n"), { mode });
  fs.chmodSync(temporary, mode);
  fs.renameSync(temporary, file);
}
