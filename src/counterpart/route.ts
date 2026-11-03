/** counterpart_print_route: how this server reaches the printer for prints and controls (PRD §8.4). */
import fs from "node:fs";
import path from "node:path";

export type PrintRoute = "lan" | "cloud";
export const PRINT_ROUTES: readonly PrintRoute[] = ["lan", "cloud"];
export interface Connection { mode: string; type: string }

/** Bambu Cloud is FULU's BambuNetwork with connection type cloud; every other route is the local network. */
export function routeOf(connection: Connection): PrintRoute {
  return connection.mode === "bambu_network" && connection.type === "cloud" ? "cloud" : "lan";
}

/**
 * The configured defaults for a route. Cloud needs FULU's BambuNetwork. The local network keeps the
 * configured mode (direct LAN, X2D native, Bambu Connect or BambuNetwork) and, for BambuNetwork, uses its LAN type.
 */
export function connectionForRoute(route: PrintRoute, current: Connection): Connection {
  if (route === "cloud") return { mode: "bambu_network", type: "cloud" };
  return current.mode === "bambu_network" ? { mode: "bambu_network", type: "lan" } : current;
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
