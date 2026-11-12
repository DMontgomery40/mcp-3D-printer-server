/**
 * counterpart_self_check (counterpart/1): whether this install's own runtime dependencies and its Web Crypto shim
 * loaded, so a client that updated the server can tell a broken install from a working one. Local only: it loads
 * modules from this server's own install and sends nothing to a printer. bambu-printer-mcp reports the same shape.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COUNTERPART_CONTRACT } from "./contract.js";

/** optional: an optional dependency, whose failure does not make ok false (the features it serves say so themselves). */
export type SelfCheck = { name: string; ok: boolean; optional?: boolean; version?: string; message?: string };
export type SelfCheckResult = {
  contract: typeof COUNTERPART_CONTRACT;
  server: { name: string; version: string };
  ok: boolean;
  checks: SelfCheck[];
};

export const SELF_CHECK_OUTPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    contract: { type: "string", const: COUNTERPART_CONTRACT },
    server: { type: "object", properties: { name: { type: "string" }, version: { type: "string" } }, required: ["name", "version"] },
    ok: { type: "boolean", description: "Every check passed, optional dependencies aside." },
    checks: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, ok: { type: "boolean" }, optional: { type: "boolean" }, version: { type: "string" }, message: { type: "string" } },
        required: ["name", "ok"],
      },
    },
  },
  required: ["contract", "server", "ok", "checks"],
};

const PACKAGE_JSON = new URL("../../package.json", import.meta.url);
/** The module each dependency is loaded through, where its package root is not importable on its own. */
const ENTRIES: Record<string, string> = {
  "@modelcontextprotocol/sdk": "@modelcontextprotocol/sdk/server/index.js",
};

/** The version in the package.json of name that contains file, from this install. */
function installedVersion(file: string, name: string): string | undefined {
  for (let dir = path.dirname(file); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const manifest = path.join(dir, "package.json");
    if (!fs.existsSync(manifest)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(manifest, "utf8"));
      if (parsed?.name === name) return typeof parsed.version === "string" ? parsed.version : undefined;
    } catch { /* a malformed manifest is not this package's */ }
  }
  return undefined;
}

/** The file specifier resolves to from this module (import.meta.resolve needs Node.js 18.19 or 20.6; older ones require). */
function resolveFromHere(specifier: string): string {
  return typeof import.meta.resolve === "function"
    ? fileURLToPath(import.meta.resolve(specifier))
    : createRequire(import.meta.url).resolve(specifier);
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * Whether version meets declared, for the forms package.json uses: x.y.z exactly, ^x.y.z (the leftmost non-zero
 * part stays) or ~x.y.z (the minor stays). Other forms are not judged (undefined).
 */
export function meetsDeclared(version: string, declared: string): boolean | undefined {
  const want = /^([~^]?)(\d+)\.(\d+)\.(\d+)$/.exec(declared.trim());
  const have = /^(\d+)\.(\d+)\.(\d+)(-)?/.exec(version);
  if (!want || !have) return undefined;
  // A prerelease (3.22.21-beta.1) meets none of these forms.
  if (have[4]) return false;
  const [w0, w1, w2] = want.slice(2).map(Number), [h0, h1, h2] = have.slice(1, 4).map(Number);
  const order = h0 - w0 || h1 - w1 || h2 - w2;
  if (want[1] === "") return order === 0;
  if (order < 0) return false;
  if (want[1] === "~") return h0 === w0 && h1 === w1;
  return w0 > 0 ? h0 === w0 : w1 > 0 ? h0 === 0 && h1 === w1 : h0 === 0 && h1 === 0 && h2 === w2;
}

/** Why the installed version does not meet package.json's, or undefined when it does. A form not judged is a failure. */
export function versionProblem(name: string, version: string | undefined, declared: string): string | undefined {
  const meets = meetsDeclared(version ?? "", declared);
  if (meets === true) return undefined;
  if (meets === undefined && version !== undefined) return `This check cannot judge ${name}'s declared version "${declared}"; ${version} is installed.`;
  return `This server needs ${name} ${declared}; ${version ?? "an unknown version"} is installed.`;
}

/** One dependency: it resolves from this install, loads, and its installed version meets package.json's. */
async function dependencyCheck(name: string, declared: string): Promise<SelfCheck> {
  const specifier = ENTRIES[name] ?? name;
  try {
    const file = resolveFromHere(specifier);
    const version = installedVersion(file, name);
    await import(specifier);
    const problem = versionProblem(name, version, declared);
    if (problem) return { name, ok: false, ...(version ? { version } : {}), message: problem };
    return { name, ok: true, ...(version ? { version } : {}) };
  } catch (error) {
    return { name, ok: false, message: `${name} did not load: ${message(error)}` };
  }
}

/** ensure-web-crypto.ts gives Node.js 18 the global Web Crypto the SDK's streamable HTTP transport calls. */
function webCryptoCheck(): SelfCheck {
  const name = "web crypto";
  return typeof globalThis.crypto?.subtle?.digest === "function" && typeof globalThis.crypto.getRandomValues === "function"
    ? { name, ok: true }
    : { name, ok: false, message: "The global Web Crypto API is missing, so the streamable HTTP transport cannot run." };
}

export async function selfCheck(server: { name: string; version: string }): Promise<SelfCheckResult> {
  let dependencies: Record<string, string> = {};
  let optional: Record<string, string> = {};
  const checks: SelfCheck[] = [];
  try {
    const manifest = JSON.parse(fs.readFileSync(PACKAGE_JSON, "utf8"));
    dependencies = manifest.dependencies ?? {};
    optional = manifest.optionalDependencies ?? {};
    if (manifest.version !== server.version) checks.push({ name: "package", ok: false, version: String(manifest.version), message: `The running server is ${server.version}, but its install is ${manifest.version}; restart it.` });
    else checks.push({ name: "package", ok: true, version: server.version });
  } catch (error) {
    checks.push({ name: "package", ok: false, message: `Could not read this server's package.json: ${message(error)}` });
  }
  checks.push(...await Promise.all([
    ...Object.entries(dependencies).map(([name, declared]) => dependencyCheck(name, declared)),
    ...Object.entries(optional).map(async ([name, declared]) => ({ ...await dependencyCheck(name, declared), optional: true })),
  ]));
  checks.push(webCryptoCheck());
  return { contract: COUNTERPART_CONTRACT, server, ok: checks.every(check => check.ok || check.optional), checks };
}
