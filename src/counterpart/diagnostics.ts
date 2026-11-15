/**
 * counterpart_diagnostics (counterpart/1): this server's own diagnostics bundle for a tester's bug report. The client
 * adds the files it returns to its own export and needs to know no log path here. Every byte is redacted on the way
 * out, the tail of each source is kept, and the bundle (file names, contents and notes) never exceeds max_bytes.
 * A missing source is listed in notes, never an error. Local only: it reads this server's own files and memory and
 * sends nothing to a printer.
 *
 * This file is shared verbatim between bambu-printer-mcp and mcp-3D-printer-server; each server lists its own sources.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DIAGNOSTICS_DEFAULT_BYTES = 4_194_304;
export const DIAGNOSTICS_MAX_BYTES = 8_388_608;

export type DiagnosticsFile = { name: string; content: string; truncated: boolean };
export type DiagnosticsResult = { package: string; version: string; files: DiagnosticsFile[]; notes: string[] };

/** A file on disk, whose tail goes in, or text the server composes. `missing` is the note when the file is absent. */
export type DiagnosticsSource = { name: string; file: string; missing?: string } | { name: string; text: string };

export const DIAGNOSTICS_INPUT_PROPERTIES = {
  printer: { type: "string", description: "Only this configured printer (its serial number or host, as this server's other tools take them). Default: every configured printer." },
  max_bytes: { type: "integer", minimum: 1, maximum: DIAGNOSTICS_MAX_BYTES, description: `Most bytes the whole bundle may hold (default ${DIAGNOSTICS_DEFAULT_BYTES}, at most ${DIAGNOSTICS_MAX_BYTES}).` },
};

export const DIAGNOSTICS_OUTPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    package: { type: "string", description: "This server's npm package name." },
    version: { type: "string", description: "This server's npm package version." },
    files: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Relative path for the file in the client's export; never absolute, never '..'." },
          content: { type: "string", description: "UTF-8 text, redacted." },
          truncated: { type: "boolean", description: "Only the tail of the source is here." },
        },
        required: ["name", "content", "truncated"],
      },
    },
    notes: { type: "array", items: { type: "string" }, description: "What is missing or left out, and why." },
  },
  required: ["package", "version", "files", "notes"],
};

/** The max_bytes a call asks for, checked. */
export function diagnosticsBudget(value: unknown): number {
  if (value === undefined) return DIAGNOSTICS_DEFAULT_BYTES;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > DIAGNOSTICS_MAX_BYTES) {
    throw new Error(`max_bytes must be an integer from 1 to ${DIAGNOSTICS_MAX_BYTES}.`);
  }
  return value;
}

// ---------------------------------------------------------------------------------------------------------------------
// What this process said and which tools failed, kept in memory for the bundle (raw; redacted only on the way out).

const LINE_LIMIT = 4000;
const SERVER_LOG_LINES = 2000;
const TOOL_ERROR_LINES = 200;
const serverLog: string[] = [];
const toolErrors: string[] = [];
/** Secret values this process has seen in tool arguments, so they are redacted even where nothing names them. */
const seenSecrets = new Set<string>();
const SEEN_SECRET_LIMIT = 200;

function remember(lines: string[], limit: number, line: string): void {
  lines.push(line.length > LINE_LIMIT ? line.slice(0, LINE_LIMIT) + " [line cut]" : line);
  if (lines.length > limit) lines.splice(0, lines.length - limit);
}

function describe(value: unknown): string {
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}

let captured = false;
/**
 * Keeps what this server writes through console.error and console.warn (its stderr diagnostics: MQTT, connection,
 * bridge and slicer messages) in memory as well. Writing to stderr is unchanged. Idempotent.
 */
export function captureServerLog(): void {
  if (captured) return;
  captured = true;
  for (const level of ["error", "warn"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      try { remember(serverLog, SERVER_LOG_LINES, `${new Date().toISOString()} ${level} ${args.map(describe).join(" ")}`); } catch { /* diagnostics only */ }
      original(...args);
    };
  }
}

/** Records a failed tool call: its name and error, not its arguments. */
export function recordToolError(tool: string, error: unknown): void {
  remember(toolErrors, TOOL_ERROR_LINES, `${new Date().toISOString()} ${tool}: ${describe(error)}`);
}

/** Remembers the values of a tool call's secret-named arguments (access codes, API keys, tokens) for redaction. */
export function rememberSecretArguments(args: unknown): void {
  const visit = (value: unknown, key: string, depth: number): void => {
    if (depth > 4 || value === null || value === undefined) return;
    if (typeof value === "string") {
      if (isSecretName(key) && value.trim().length >= MIN_SECRET_LENGTH && !PLAIN_VALUE.test(value.trim()) && seenSecrets.size < SEEN_SECRET_LIMIT) seenSecrets.add(value.trim());
      return;
    }
    if (typeof value === "object") for (const [k, v] of Object.entries(value as Record<string, unknown>)) visit(v, k, depth + 1);
  };
  visit(args, "", 0);
}

export const serverLogText = () => serverLog.join("\n") + (serverLog.length ? "\n" : "");
export const toolErrorsText = () => toolErrors.join("\n") + (toolErrors.length ? "\n" : "");

/** For tests: forgets what was recorded. */
export function resetDiagnosticsMemory(): void {
  serverLog.length = 0;
  toolErrors.length = 0;
  seenSecrets.clear();
}

// ---------------------------------------------------------------------------------------------------------------------
// Redaction.

/**
 * Whether a name says its value is a secret. The name is split into words at _ . - spaces and camelCase
 * ("sessionId", "SCAN_TO_MAKE_AI_KEY", "X-Api-Key"); \uXXXX escapes are read first ("\u0070assword").
 * STRONG words count inside a longer word too ("mytoken", "apikey"); WHOLE words only alone ("PAIRING_PIN", not
 * "spinner"); "code" only after a word that makes it one (access, lan, pair, pairing, auth, verification, security).
 */
const STRONG_WORDS = /pass(?:word|wd|code|phrase|key)|secret|token|apikey|accesscode|accesskey|authkey|privatekey|cookie|session|credential|signature|bearer|e-?mail|username|userinfo|login|ticket|authoriz/;
const WHOLE_WORDS = new Set(["key", "keys", "pin", "otp", "pwd", "auth", "account", "sid"]);
const CODE_OWNERS = new Set(["access", "lan", "pair", "pairing", "auth", "verification", "security", "otp"]);
export function isSecretName(name: string): boolean {
  const plain = name.replace(/\\{1,2}u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  const words = plain.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return words.some((word, i) => STRONG_WORDS.test(word) || WHOLE_WORDS.has(word) || (word === "code" && i > 0 && CODE_OWNERS.has(words[i - 1]))
    || (i > 0 && STRONG_WORDS.test(words[i - 1] + word)));
}
/** A name in key=value or JSON: letters, digits, _ . - and \uXXXX escapes, starting a word. */
// Only a name with a word that can make it a secret is taken (the lookahead), so "https://…?token=…" is read from "token".
const NAME_BODY = String.raw`(?=(?:[A-Za-z0-9_.-]|\\{1,2}u[0-9A-Fa-f]{4}){0,96}?(?:pass|pwd|secret|token|key|cookie|session|credential|signature|bearer|mail|user|login|ticket|auth|pin|otp|code|account|sid|\\{1,2}u))(?:[A-Za-z0-9_.-]|\\{1,2}u[0-9A-Fa-f]{4}){1,96}`;
const NAME = String.raw`(?<![A-Za-z0-9_.\\-])${NAME_BODY}`;
// Every pattern below starts at a word's start and bounds its runs, so a long log line costs linear time.
/** Values too common to replace wherever they appear. */
const PLAIN_VALUE = /^(?:true|false|yes|no|null|none|undefined|on|off)$/i;
const MIN_SECRET_LENGTH = 5;
const MARK = "[redacted]";
/**
 * An empty value, one already replaced, or a bare true/false/null says only whether it is set ("accessCodeSet": true):
 * it stays. Only as the whole value: "[set]hunter2" and "true-secret" are secrets.
 */
const SAFE_VALUE = /^(?:(?:\\?["'])?(?:\[set\]|\[redacted(?:-[a-z]+)?\])?(?:\\?["'])?|true|false|null)$/;
const AUTH_SCHEME = /^(?:\\?["'])?(?:bearer|basic|digest|token|negotiate|ntlm)$/i;

/**
 * key=value, key: value, "key": "value", \"key\":\"value\", ?key=value&. Each name's value is read ahead without being taken,
 * so a name that is not a secret ("https:", "?code=1") leaves what follows it to be read again ("#id_token=…").
 */
const KEY_VALUE = new RegExp(String.raw`(\\?["']?)(${NAME})(\\?["']?)(\s*[:=]\s*)(?=(\\"(?:(?!\\")[^\n]){0,4096}\\"|"(?:[^"\\\n]|\\.){0,4096}"|'[^'\n]{0,4096}'|["']?(?:\[[a-z-]{1,16}\])?[^\s,;&}\])"'\\]*))`, "gi");
/** Where the JSON object or array starting at `start` ends (after its closing bracket), or its line's end if it is cut. */
function structureEnd(text: string, start: number): number {
  let depth = 0, inString = false;
  const limit = Math.min(text.length, start + 65536);
  for (let i = start; i < limit; i++) {
    const c = text[i];
    if (inString) { if (c === "\\") i++; else if (c === '"') inString = false; continue; }
    if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") { if (--depth === 0) return i + 1; }
  }
  const line = text.indexOf("\n", start);
  return line < 0 || line > limit ? limit : line;
}

const PAIR_NAME = String.raw`"(?:name|key|env|variable|var|field|id)"\s*:\s*"([^"\\\n]{1,96})"`;
const PAIR_VALUE = String.raw`"(?:value|val|secret|data)"\s*:\s*`;
const PAIR_VALUE_TEXT = String.raw`("(?:[^"\\\n]|\\.){0,4096}"|[^\s,}\]]{1,4096})`;
const NAME_THEN_VALUE = new RegExp(String.raw`(${PAIR_NAME}\s*,\s*${PAIR_VALUE})${PAIR_VALUE_TEXT}`, "gi");
const VALUE_THEN_NAME = new RegExp(String.raw`(${PAIR_VALUE})${PAIR_VALUE_TEXT}(\s*,\s*${PAIR_NAME})`, "gi");
/** {"name":"BAMBU_ACCESS_CODE","value":"…"} and {"value":"…","key":"API_TOKEN"}: the value goes when the name is a secret's. */
function redactNamedValues(text: string): string {
  const safe = (value: string) => SAFE_VALUE.test(value);
  return text
    .replace(NAME_THEN_VALUE, (m, head, name, value) => isSecretName(name) && !safe(value) ? `${head}"${MARK}"` : m)
    .replace(VALUE_THEN_NAME, (m, head, value, tail, name) => isSecretName(name) && !safe(value) ? `${head}"${MARK}"${tail}` : m);
}

function redactKeyValues(text: string): string {
  let out = "", last = 0;
  KEY_VALUE.lastIndex = 0;
  for (let m = KEY_VALUE.exec(text); m; m = KEY_VALUE.exec(text)) {
    const [head, q1, key, q2, sep] = m;
    let value = m[5];
    const start = m.index + head.length;
    // An object or array under a secret's name ({"password":{"value":…}}, {"tokens":[…]}) goes whole, to its closing bracket.
    // Only after a quoted JSON key: token=[set]hunter2 is a value, not an array.
    if (q2 && (text[start] === "{" || text[start] === "[") && isSecretName(key)) value = text.slice(start, structureEnd(text, start));
    // An empty value, a safe one, or an authorization scheme ("authorization: bearer …", replaced after the scheme) stays.
    if (!isSecretName(key) || !value || SAFE_VALUE.test(value) || AUTH_SCHEME.test(value)) continue;
    const quote = value.startsWith('\\"') ? '\\"' : value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : "";
    // A JSON key's bare value (a number) is replaced by a string, so the JSON still parses.
    const json = quote ? quote : q2 === '"' ? '"' : q2 === '\\"' ? '\\"' : "";
    out += text.slice(last, m.index) + `${q1}${key}${q2}${sep}${json}${MARK}${json}`;
    last = KEY_VALUE.lastIndex = m.index + head.length + value.length;
  }
  return out + text.slice(last);
}

const RULES: Array<[RegExp, string | ((...m: string[]) => string)] | ((text: string) => string)> = [
  // PEM blocks of every type (private keys, certificates, requests), whole.
  [/-----BEGIN ([A-Z0-9 ]{1,64})-----[\s\S]*?(?:-----END \1-----|$)/g, MARK],
  // Cookie headers: every cookie on the line.
  [/\b((?:set-)?cookie\s*[:=]\s*)[^\r\n]*/gi, `$1${MARK}`],
  // An Authorization or Proxy-Authorization header line goes whole, past its scheme (a Digest username goes with it).
  [/(?<![\w"'\\-])((?:proxy-)?authorization[ \t]*:[ \t]*)(?:(bearer|basic|digest|negotiate|ntlm|token)[ \t]+)?[^\r\n]*/gi,
    (_m, head, scheme) => `${head}${scheme ? `${scheme} ` : ""}${MARK}`],
  // A secret named by a JSON object's name and given in its value: {"name":"BAMBU_ACCESS_CODE","value":"…"}, either order.
  redactNamedValues,
  // Authorization schemes, in any case.
  [/\b(Bearer|Basic|Digest|Token|Negotiate|NTLM)(\s+)[A-Za-z0-9._~+/=-]{4,}/gi, `$1$2${MARK}`],
  // user:password@ in URLs.
  [/(?<![A-Za-z0-9+.-])([a-z][a-z0-9+.-]{0,30}:\/\/)[^\s/@:]{1,256}(?::[^\s/@]{0,256})?@/gi, `$1${MARK}@`],
  // key=value, key: value, "key": "value", \"key\":\"value\", ?key=value& (redactKeyValues).
  redactKeyValues,
  // --api-key VALUE, -password VALUE.
  [new RegExp(String.raw`(\s--?)(${NAME_BODY})(\s+)(?!--?\w)(\S+)`, "gi"),
    (match, dash, key, space, value) => isSecretName(key) && !SAFE_VALUE.test(value) ? `${dash}${key}${space}${MARK}` : match],
  // Email addresses (account logins).
  [/(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}(?![A-Za-z0-9-])/g, "[redacted-email]"],
  // JSON Web Tokens.
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]*)?/g, "[redacted-token]"],
  // Tokens with a known prefix, bare: GitHub, AWS access key ids, Google API keys, sk-/pk- keys, Slack.
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{30,64}|(?:sk|pk|rk)-[A-Za-z0-9_-]{16,256}|xox[abposr]-[A-Za-z0-9-]{10,256})(?![A-Za-z0-9_-])/g, "[redacted-token]"],
  // Home folders: other people's names in /Users/<name>, /home/<name>, C:\Users\<name> and ~name, slashes escaped or not.
  [/((?:^|[^A-Za-z0-9_.-])(?:\\{0,2}\/)(?:Users|home)\\{0,2}\/)(?!Shared\b|\[user\])([^\\/\s"'<>:*?|]{1,64})/g, "$1[user]"],
  [/(\b[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/))(?!Public\b|\[user\])([^\\/\s"'<>:*?|]{1,64})/gi, "$1[user]"],
  [/(?<![A-Za-z0-9_~])~(?!\[user\])[A-Za-z][A-Za-z0-9._-]{0,31}(?=\\{0,2}\/)/g, "~[user]"],
];

/** Long mixed-case-and-digit runs (API keys, session tokens) and 32-digit uppercase hex keys; lowercase hashes stay. */
function redactTokens(text: string): string {
  return text.replace(/[A-Za-z0-9_+=-]{32,1024}/g, run =>
    (/[a-z]/.test(run) && /[A-Z]/.test(run) && /\d/.test(run)) || /^[0-9A-F]{32,1024}$/.test(run) && /[A-F]/.test(run) && /\d/.test(run)
      ? "[redacted-token]" : run);
}

/** The values of this environment's secret-named variables. */
export function environmentSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(env).filter(([name, value]) => isSecretName(name) && typeof value === "string")
    .map(([, value]) => value!.trim()).filter(value => value.length >= MIN_SECRET_LENGTH && !PLAIN_VALUE.test(value));
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * text with every secret this module can recognise replaced: values of secret-named keys and arguments, the known
 * secret values anywhere (configured access codes, API keys, tokens and passwords, and any seen in tool arguments),
 * cookies, authorization headers, URL credentials, emails, JWTs, PEM private keys and long random tokens. Serial
 * numbers, hosts and lowercase hashes stay.
 */
export function redactText(text: string, secrets: Iterable<string> = []): string {
  let out = text.replace(/\u0000/g, "");
  const known = [...new Set([...secrets, ...environmentSecrets(), ...seenSecrets])]
    .filter(value => value.length >= MIN_SECRET_LENGTH).sort((a, b) => b.length - a.length);
  for (const value of known) out = out.replace(new RegExp(escapeRegExp(value), "g"), MARK);
  // This server's own home folder reads ~ (also with JSON's escaped slashes and Windows' doubled backslashes).
  const home = os.homedir();
  if (home && home.length > 1) {
    for (const form of new Set([home, home.replace(/\//g, "\\/"), home.replace(/\\/g, "\\\\")])) {
      out = out.replace(new RegExp(escapeRegExp(form) + "(?![A-Za-z0-9._-])", "g"), "~");
    }
  }
  for (const rule of RULES) out = typeof rule === "function" ? rule(out) : out.replace(rule[0], rule[1] as any);
  return redactTokens(out);
}

// ---------------------------------------------------------------------------------------------------------------------
// The bundle.

const byteLength = (text: string) => Buffer.byteLength(text, "utf8");

/** The last `bytes` of text, starting at a whole line where one starts inside it. */
export function tailText(text: string, bytes: number): { text: string; cut: boolean } {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= bytes) return { text, cut: false };
  if (bytes <= 0) return { text: "", cut: true };
  let tail = buffer.subarray(buffer.length - bytes).toString("utf8").replace(/^�+/, "");
  const newline = tail.indexOf("\n");
  if (newline >= 0 && newline < tail.length - 1) tail = tail.slice(newline + 1);
  while (byteLength(tail) > bytes) tail = tail.slice(1);
  return { text: tail, cut: true };
}

/** The tail of a file, at most `bytes` read, from its first whole line. */
function readTail(file: string, bytes: number): { text: string; cut: boolean } {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const n = fs.readSync(fd, buffer, read, length - read, size - length + read);
      if (n <= 0) break;
      read += n;
    }
    let text = buffer.subarray(0, read).toString("utf8");
    if (length < size) {
      // The first line may start mid-secret ("…ode=12345678"): drop it.
      const newline = text.indexOf("\n");
      text = newline >= 0 ? text.slice(newline + 1) : "";
    }
    return { text, cut: length < size };
  } finally {
    fs.closeSync(fd);
  }
}

function checkName(name: string): void {
  const parts = name.split(/[\\/]/);
  if (!name || path.isAbsolute(name) || /^[A-Za-z]:/.test(name) || parts.some(part => part === ".." || part === "" || part === ".")) {
    throw new Error(`Diagnostics file name ${JSON.stringify(name)} is not a plain relative path.`);
  }
}

/**
 * The bundle from sources, in their order: each file's tail, redacted. Small sources go in whole; the rest share what
 * is left equally, keeping their newest lines. Names, contents and notes together stay within maxBytes.
 */
export function buildDiagnostics(options: { package: string; version: string; sources: DiagnosticsSource[]; notes?: string[]; maxBytes?: number; secrets?: string[] }): DiagnosticsResult {
  const maxBytes = diagnosticsBudget(options.maxBytes);
  const notes = (options.notes ?? []).map(note => redactText(note, options.secrets));
  const entries: Array<{ name: string; text: string; cut: boolean }> = [];
  for (const source of options.sources) {
    checkName(source.name);
    if ("text" in source) {
      entries.push({ name: source.name, text: redactText(source.text, options.secrets), cut: false });
      continue;
    }
    let read: { text: string; cut: boolean };
    try {
      if (!fs.statSync(source.file).isFile()) throw Object.assign(new Error("not a file"), { code: "ENOTFILE" });
      read = readTail(source.file, maxBytes);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      notes.push(redactText(source.missing && code === "ENOENT" ? source.missing
        : `${source.name}: not included (${code === "ENOENT" ? "no such file" : code ?? (error instanceof Error ? error.message : String(error))}).`, options.secrets));
      continue;
    }
    entries.push({ name: source.name, text: redactText(read.text, options.secrets), cut: read.cut });
  }

  // Notes first: the client shows them even when nothing else fits.
  const kept: string[] = [];
  let left = maxBytes;
  for (const note of notes) {
    const size = byteLength(note);
    if (size > left) { left = 0; break; }
    kept.push(note);
    left -= size;
  }
  for (const entry of entries) left -= byteLength(entry.name);
  left = Math.max(0, left);

  const allowed = new Map<number, number>();
  const order = entries.map((entry, index) => ({ index, size: byteLength(entry.text) })).sort((a, b) => a.size - b.size);
  order.forEach(({ index, size }, position) => {
    const share = Math.floor(left / (order.length - position));
    const take = Math.min(size, share);
    allowed.set(index, take);
    left -= take;
  });

  const files: DiagnosticsFile[] = [];
  let total = kept.reduce((sum, note) => sum + byteLength(note), 0);
  entries.forEach((entry, index) => {
    const fitted = tailText(entry.text, allowed.get(index) ?? 0);
    const size = byteLength(entry.name) + byteLength(fitted.text);
    if (total + size > maxBytes) return;
    total += size;
    files.push({ name: entry.name, content: fitted.text, truncated: entry.cut || fitted.cut });
  });
  return { package: options.package, version: options.version, files, notes: kept };
}

/** The environment settings whose names match, sorted; a secret-named one shows only "[set]". */
export function settingsSnapshot(names: RegExp, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(Object.entries(env)
    .filter((entry): entry is [string, string] => names.test(entry[0]) && typeof entry[1] === "string")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => [name, isSecretName(name) && value ? "[set]" : value]));
}

/** The text of a JSON value for a bundle file. */
export const jsonText = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

/** The newest `count` *.log files directly in each folder, newest first; absent folders are skipped. */
export function newestLogs(folders: string[], count: number, exclude: string[] = []): string[] {
  const found: Array<{ file: string; mtime: number }> = [];
  for (const folder of folders) {
    let names: string[];
    try { names = fs.readdirSync(folder); } catch { continue; }
    for (const name of names) {
      if (!/\.log(?:\.\d+)?$/i.test(name) || exclude.includes(name)) continue;
      const file = path.join(folder, name);
      try {
        const stat = fs.statSync(file);
        if (stat.isFile()) found.push({ file, mtime: stat.mtimeMs });
      } catch { /* gone */ }
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, count).map(entry => entry.file);
}

/**
 * The version of the app an executable belongs to, read without running it: a macOS bundle's Info.plist
 * (CFBundleShortVersionString, else CFBundleVersion), else a version in the file's own name (AppImage). Undefined
 * when neither says.
 */
export function appVersion(executable: string | undefined): string | undefined {
  if (!executable) return undefined;
  const bundle = /^(.*?\.app)(?:[\\/]|$)/i.exec(executable)?.[1];
  if (bundle) {
    try {
      const plist = fs.readFileSync(path.join(bundle, "Contents", "Info.plist"), "utf8");
      for (const key of ["CFBundleShortVersionString", "CFBundleVersion"]) {
        const value = new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`).exec(plist)?.[1]?.trim();
        if (value) return value;
      }
    } catch { /* not readable */ }
  }
  return /(?:^|[_\-\sv])(\d+\.\d+\.\d+(?:\.\d+)?)(?=[_\-.\s]|$)/i.exec(path.basename(executable))?.[1];
}
