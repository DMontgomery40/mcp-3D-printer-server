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
  // Known secrets go before the cut, so one straddling the cut leaves no part of itself.
  const clean = removeKnownSecrets(line);
  lines.push(clean.length > LINE_LIMIT ? clean.slice(0, LINE_LIMIT) + " [line cut]" : clean);
  if (lines.length > limit) lines.splice(0, lines.length - limit);
}

/** A logged value as text, redacted by its structure first when it is an object (redactValue). */
function describe(value: unknown): string {
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  try { return JSON.stringify(redactValue(value)) ?? String(value); } catch { return "[a value that could not be read safely]"; }
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
    if (depth > 32 || value === null || value === undefined) return;
    if (typeof value === "string" || typeof value === "number") {
      const text = String(value).trim();
      if (isSecretName(key) && text.length >= MIN_SECRET_LENGTH && !PLAIN_VALUE.test(text) && seenSecrets.size < SEEN_SECRET_LIMIT) seenSecrets.add(text);
      return;
    }
    // An array's elements are held under the key that owns the array ({tokens: ["…"]}).
    if (Array.isArray(value)) { for (const item of value) visit(item, key, depth + 1); return; }
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
const STRONG_WORDS = /pass(?:word|wd|code|phrase|key)|secret|token|apikey|accesscode|accesskey|authkey|privatekey|cookie|session|credential|signature|bearer|e-?mail|username|userinfo|login|ticket|authoriz|(?:lan|pair|pairing|device|unlock|auth|verification|security|otp)code/;
const WHOLE_WORDS = new Set(["key", "keys", "pin", "otp", "pwd", "pass", "passwd", "auth", "account", "sid"]);
const CODE_OWNERS = new Set(["access", "lan", "pair", "pairing", "auth", "verification", "security", "otp", "device", "unlock"]);
/** Text with \\uXXXX, \\xXX and %XX escapes read, so "\\x70assword" and "pass%77ord" are seen as "password". */
export function decodeEscapes(text: string): string {
  return text.replace(/\\{1,2}u\{([0-9a-fA-F]{1,6})\}|\\{1,2}u([0-9a-fA-F]{4})|\\{1,2}x([0-9a-fA-F]{2})|%([0-9a-fA-F]{2})|&#[xX]([0-9a-fA-F]{1,6});?|&#(\d{1,7});?|\\\//g,
    (match, brace, u, x, p, hexEntity, decEntity) => {
      if (match.endsWith("/") && match.startsWith("\\")) return "/";
      const code = decEntity !== undefined ? parseInt(decEntity, 10) : parseInt(brace ?? u ?? x ?? p ?? hexEntity, 16);
      return code <= 0x10ffff ? String.fromCodePoint(code) : match;
    });
}
export function isSecretName(name: string): boolean {
  const plain = decodeEscapes(name);
  // The whole name first, lowercased and joined: "PaSsWoRd" and "AcCeSsCoDe" are not split into nonsense words.
  if (STRONG_WORDS.test(plain.toLowerCase().replace(/[^a-z0-9]/g, ""))) return true;
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

const PAIR_NAME = /"(?:name|key|env|variable|var|field|id)"\s*:\s*"([^"\\\n]{1,96})"/gi;
const PAIR_VALUE = /("(?:value|val|secret|data)"\s*:\s*)("(?:[^"\\\n]|\\.){0,65536}"|[^\s,}\]]{1,4096})/gi;
/**
 * {"name":"BAMBU_ACCESS_CODE","scope":"lan","value":"…"}: in each flat JSON object (no object inside it), when a
 * name/key field names a secret, its value fields go, wherever they are in the object and in either order.
 */
function redactNamedValues(text: string): string {
  return text.replace(/\{[^{}]{0,16384}\}/g, object => {
    const names = [...object.matchAll(PAIR_NAME)].map(m => m[1]);
    if (!names.some(isSecretName)) return object;
    return object.replace(PAIR_VALUE, (m, head, value) => SAFE_VALUE.test(value) ? m : `${head}"${MARK}"`);
  });
}

/** Where the quoted string starting at `start` ends (after its closing quote), or its line's end if it is cut. */
function stringEnd(text: string, start: number, quote: string): number {
  const limit = Math.min(text.length, start + 1_048_576);
  for (let i = start + quote.length; i < limit; i++) {
    if (text.startsWith(quote, i)) return i + quote.length;
    if (text[i] === "\\" && quote === '"') i++;
    else if (text[i] === "\n") return i;
  }
  return limit;
}

/** A bare "code" whose value is a random run of mixed case and digits (a pairing code), unlike a printer's error code. */
const randomCode = (key: string, value: string) => /(?:^|[^A-Za-z])code$/i.test(key.replace(/["'\\]/g, "")) && (() => {
  const plain = value.replace(/^\\?["']|\\?["']$/g, "");
  return /^[A-Za-z0-9_-]{16,256}$/.test(plain) && /[a-z]/.test(plain) && /[A-Z]/.test(plain) && /\d/.test(plain);
})();

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
    // A quoted value longer than the lookahead reads goes to its closing quote, not to its first space.
    else if (value?.startsWith('"') || value?.startsWith('\\"')) {
      const quote = value.startsWith('"') ? '"' : '\\"';
      if (value.length <= quote.length || !value.endsWith(quote)) value = text.slice(start, stringEnd(text, start, quote));
    }
    // An empty value, a safe one, or an authorization scheme ("authorization: bearer …", replaced after the scheme) stays.
    if (!(isSecretName(key) || randomCode(key, value)) || !value || SAFE_VALUE.test(value) || AUTH_SCHEME.test(value)) continue;
    // A bare number under a measure's name (tokenCount: 5, sessionTimeoutSec=30) is not a secret.
    if (/^-?\d+(?:\.\d+)?$/.test(value) && MEASURE_NAME.test(key.replace(/["'\\]/g, ""))) continue;
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
  (text: string) => removePem(text),
  // Cookie headers: every cookie on the line.
  [/\b((?:set-)?cookie\s*[:=]\s*)[^\r\n]*/gi, `$1${MARK}`],
  // An Authorization or Proxy-Authorization header line goes whole, past its scheme (a Digest username goes with it).
  [/(?<![\w"'\\-])((?:proxy-)?authorization[ \t]*:[ \t]*)(?:(bearer|basic|digest|negotiate|ntlm|token)[ \t]+)?[^\r\n]*/gi,
    (_m, head, scheme) => `${head}${scheme ? `${scheme} ` : ""}${MARK}`],
  // A secret named by a JSON object's name and given in its value: {"name":"BAMBU_ACCESS_CODE","value":"…"}, either order.
  redactNamedValues,
  // Digest credentials written bare (Digest username="…", response="…"): the whole list, to the line's end.
  [/\b(Digest)([ \t]+)(?=[A-Za-z_-]{1,32}[ \t]*=)[^\r\n]*/gi, `$1$2${MARK}`],
  // Two-word labels: "access code: 12345678", "pairing code = …".
  [/\b((?:access|lan|pair|pairing|auth|verification|security|otp)[ \t]+code)([ \t]*[:=][ \t]*)(?!\[redacted|\[set\])("[^"\n]{1,4096}"|'[^'\n]{1,4096}'|[^\s,;&}\])"']+)/gi,
    (_m, label, sep, value) => `${label}${sep}${value.startsWith('"') ? `"${MARK}"` : value.startsWith("'") ? `'${MARK}'` : MARK}`],
  // Secrets in XML and plists: <password>…</password>, <key>apiToken</key><string>…</string>.
  [/(<key>([^<]{1,96})<\/key>\s*<(string|data|integer)>)([^<]{1,65536})(<\/\3>)/g,
    (m, head, name, _tag, value, tail) => isSecretName(name) ? `${head}${MARK}${tail}` : m],
  [/<([A-Za-z_][A-Za-z0-9_.:-]{0,95})((?:\s[^<>]{0,1024})?)>([^<]{1,65536})<\/\1>/g,
    (m, tag, attributes, value) => tag !== "key" && isSecretName(tag) && !SAFE_VALUE.test(value) ? `<${tag}${attributes}>${MARK}</${tag}>` : m],
  // Authorization schemes, in any case.
  // A state word after the scheme ("token expired", "token refresh failed") is not a credential: it stays.
  [/\b(Bearer|Basic|Digest|Token|Negotiate|NTLM)(\s+)([A-Za-z0-9._~+/=-]{4,})/gi,
    (m, scheme, space, value) => AUTH_STATE.has(value.toLowerCase()) ? m : `${scheme}${space}${MARK}`],
  // user:password@ in URLs.
  [/(?<![A-Za-z0-9+.-])([a-z][a-z0-9+.-]{0,30}:\/\/)[^\s/@:]{1,256}(?::[^\s/@]{0,256})?@/gi, `$1${MARK}@`],
  // key=value, key: value, "key": "value", \"key\":\"value\", ?key=value& (redactKeyValues).
  redactKeyValues,
  // --api-key VALUE, -password VALUE.
  [new RegExp(String.raw`(\s--?)(${NAME_BODY})(\s+)(?!--?\w)(\S+)`, "gi"),
    (match, dash, key, space, value) => isSecretName(key) && !SAFE_VALUE.test(value) ? `${dash}${key}${space}${MARK}` : match],
  // Email addresses with a URL-encoded @ (name%40example.com).
  [/(?<![A-Za-z0-9._%+-])[A-Za-z0-9._+-]{1,64}%40[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}(?![A-Za-z0-9-])/gi, "[redacted-email]"],
  // Email addresses (account logins).
  [/(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}(?![A-Za-z0-9-])/g, "[redacted-email]"],
  // JSON Web Tokens.
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]*)?/g, "[redacted-token]"],
  // Tokens with a known prefix, bare: GitHub, AWS access key ids, Google API keys, sk-/pk- keys, Slack, Hugging Face.
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{30,64}|(?:sk|pk|rk)-[A-Za-z0-9_-]{16,256}|xox[abposr]-[A-Za-z0-9-]{10,256}|hf_[A-Za-z0-9]{20,255})(?![A-Za-z0-9_-])/g, "[redacted-token]"],
  // An AWS secret access key, bare: 40 characters of mixed case, digits and / or +, not a path.
  [/(?<![A-Za-z0-9/+=._-])[A-Za-z0-9][A-Za-z0-9/+]{39}(?![A-Za-z0-9/+=._-])/g,
    run => /[/+]/.test(run) && /[a-z]/.test(run) && /[A-Z]/.test(run) && /\d/.test(run) && (run.match(/[/+]/g) ?? []).length <= 4 && !/\/\//.test(run) ? "[redacted-token]" : run],
  // Home folders: other people's names in /Users/<name>, /home/<name>, C:\Users\<name> and ~name, slashes escaped or not.
  [/((?:^|[^A-Za-z0-9_.-])(?:\\{0,2}\/)(?:Users|home)\\{0,2}\/)(?!Shared\b|\[user\])([^\\/\s"'<>:*?|]{1,64})/g, "$1[user]"],
  [/(\b[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/))(?!Public\b|\[user\])([^\\/\s"'<>:*?|]{1,64})/gi, "$1[user]"],
  [/(?<![A-Za-z0-9_~])~(?!\[user\])[A-Za-z][A-Za-z0-9._-]{0,31}(?=\\{0,2}\/)/g, "~[user]"],
];

/** Long mixed-case-and-digit runs (API keys, session tokens) and 32-digit uppercase hex keys; lowercase hashes stay. */
function redactTokens(text: string): string {
  return text.replace(/[A-Za-z0-9_+=-]{32,1024}(?!\.[A-Za-z][A-Za-z0-9]{1,5}\b)/g, run =>
    (/[a-z]/.test(run) && /[A-Z]/.test(run) && /\d/.test(run)) || /^[0-9A-F]{32,1024}$/.test(run) && /[A-F]/.test(run) && /\d/.test(run)
      ? "[redacted-token]" : run);
}

/** The values of this environment's secret-named variables. */
export function environmentSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(env).filter(([name, value]) => isSecretName(name) && typeof value === "string")
    .map(([, value]) => value!.trim()).filter(value => value.length >= MIN_SECRET_LENGTH && !PLAIN_VALUE.test(value));
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The forms a known secret can take in a log: as is, URL-encoded, JSON-escaped, and base64 at any byte offset. */
function encodedForms(secret: string): string[] {
  const forms = new Set([secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]);
  const bytes = Buffer.from(secret, "utf8");
  for (const before of [0, 1, 2]) {
    // The base64 characters that only this secret's bytes decide, wherever it sits in an encoded run ("bblp:<code>").
    const encoded = Buffer.concat([Buffer.alloc(before), bytes]).toString("base64");
    const start = before ? 4 : 0, end = Math.floor((before + bytes.length) / 3) * 4;
    if (end - start >= 4) forms.add(encoded.slice(start, end));
    if (!before) { forms.add(encoded); forms.add(encoded.replace(/=+$/, "")); forms.add(encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")); }
  }
  return [...forms].filter(form => form.length >= 4);
}

/** Base64 characters around a removed core: the group before and after it mix the secret's bytes with its neighbours'. */
const B64_EDGE = /[A-Za-z0-9+/_-]{1,4}\[redacted\][A-Za-z0-9+/_-]{0,4}={0,2}|\[redacted\][A-Za-z0-9+/_-]{1,4}={0,2}/g;

/** text with every known secret (configured, in this environment, or seen in tool arguments) removed in each encoded form. */
export function removeKnownSecrets(text: string, secrets: Iterable<string> = []): string {
  const known = [...new Set([...secrets, ...environmentSecrets(), ...seenSecrets])].filter(value => value.length >= MIN_SECRET_LENGTH);
  if (!known.length) return text.replace(/\u0000/g, "");
  let out = text.replace(/\u0000/g, "");
  // Other encoders' spellings (form-url `+`, lowercase %-hex, Go's \u003c, a lone \u escape, \/, HTML entities): a copy
  // of each line is decoded, and a line whose decoded copy holds a known secret is withheld whole.
  out = out.split("\n").map(line => {
    if (!/[%+\\&]/.test(line)) return line;
    const decoded = decodeEscapes(line);
    const spaced = decodeEscapes(line.replace(/\+/g, " "));
    return known.some(value => decoded.includes(value) || spaced.includes(value)) ? (LINE_PREFIX.exec(line)?.[0] ?? "") + WITHHELD : line;
  }).join("\n");
  for (const value of known) {
    const plain = encodedForms(value).filter(form => form.length >= MIN_SECRET_LENGTH || /^[A-Za-z0-9+/_-]+$/.test(form));
    for (const form of plain.sort((a, b) => b.length - a.length)) out = out.split(form).join(MARK);
  }
  // A base64 core leaves the mixed groups either side of it; they go too (a small over-redaction of innocent base64).
  return out.replace(B64_EDGE, MARK);
}

/**
 * Words that make a line suspect, looked for in the line lowercased, its escapes read and everything but letters and
 * digits removed (so "pass word", "Pa_Ss-WoRd", "\x70assword" and "pass%77ord" all read "password"); WORDS only as
 * a whole word of the line ("mqtt pass=…", not "compass").
 */
const LINE_SECRETS = /pass(?:word|wd|code|phrase|key)|secret|token|apikey|accesscode|accesskey|(?:lan|pair|pairing|device|unlock|auth|verification|security|otp)code|authoriz|authkey|cookie|session|credential|privatekey|signature|bearer|userinfo|ticket/;
const LINE_WORDS = new Set(["pass", "passwd", "pwd", "pin", "otp", "auth", "sid", "key", "keys", "digest", "negotiate", "ntlm"]);
/** A name whose bare number is a measure, not a secret: tokenCount, sessionTimeoutSec, passwordMinLength. */
const MEASURE_NAME = /(?:count|counts|total|num|number|sec|secs|seconds|ms|millis|minutes|length|len|size|bytes|timeout|ttl|max|min|limit|retries|attempts|index|level|version)$/i;
const NUMBER = /^-?\d+(?:\.\d+)?$/;
/** A value that says nothing secret: a marker, empty, a boolean, a firmware version or a printer error (HMS) code. */
const SAFE_SHAPE = String.raw`\[set\]|\[redacted(?:-[a-z]+)?\]|true|false|null|none|""|''|\d{1,3}(?:\.\d{1,3}){2,3}|[0-9A-Fa-f]{4}(?:[-_][0-9A-Fa-f]{4}){1,3}`;
const SAFE_PAIR = new RegExp(String.raw`^[\s"'{\[,]*([A-Za-z0-9_.\-]{1,96})["']?\s*[:=]\s*["']?(${SAFE_SHAPE}|-?\d+(?:\.\d+)?)["']?[\s,}\]]*$`);
/** A log line's leading time and level ("2026-11-14T10:00:00.000Z error"), kept on a withheld line. */
const LINE_PREFIX = /^(?:\[?\d{4}-\d\d-\d\d[T ][\d:.,]+(?:Z|[+-]\d\d:?\d\d)?\]?\s+(?:\[?(?:error|warn(?:ing)?|info|debug|trace|fatal|notice)\]?:?\s+)?|\[?(?:error|warn(?:ing)?|info|debug|trace|fatal|notice)\]?:?\s+)/i;
export const WITHHELD = "[line withheld: may contain a secret]";

/** Whether a line may carry a secret: a secret word anywhere in it, in any spelling or encoding. */
export function suspectLine(line: string): boolean {
  const plain = decodeEscapes(line).toLowerCase();
  if (LINE_SECRETS.test(plain.replace(/[^a-z0-9]/g, ""))) return true;
  return plain.split(/[^a-z0-9]+/).some(word => LINE_WORDS.has(word));
}

/** Quotes and brackets left open so far, read on through a line (a value that goes on to the next line). */
type Open = { depth: number; quote: string };
/**
 * The quotes and brackets a line leaves open. On a suspect line a single quote counts too, opening only where a value
 * starts (`password='…`), not inside a word (`don't`).
 */
function readOpen(state: Open, line: string, single = false): Open {
  let { depth, quote } = state;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = ""; continue; }
    if (c === '"') quote = c;
    else if (single && c === "'" && !/[A-Za-z0-9]/.test(line[i - 1] ?? "")) quote = c;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth = Math.max(0, depth - 1);
  }
  return { depth, quote };
}
const isOpen = (open: Open) => open.depth > 0 || open.quote !== "";

/** Whether a suspect line is only a name and a value that says nothing secret, closing all it opens ("accessCodeSet": true). */
function safeLine(line: string): boolean {
  const body = line.replace(LINE_PREFIX, "");
  const m = SAFE_PAIR.exec(body);
  if (!m || isOpen(readOpen({ depth: 0, quote: "" }, body, true))) return false;
  return !NUMBER.test(m[2]) || MEASURE_NAME.test(m[1]);
}

/**
 * Auth-state lines: "login expired", "token refresh failed", "Access code is wrong", "401 Unauthorized". Their secret
 * words say a credential's state, never its value, and they are the most useful failure a bug report carries. An
 * allowlist: a suspect line is kept only when every secret word in it sits by one of these state words or phrases, or
 * is a setting's name (CLAUDE_CODE_OAUTH_TOKEN) with nothing after it, and nothing value-shaped is anywhere near.
 */
const AUTH_STATE = new Set(["expired", "expires", "expire", "expiring", "refresh", "refreshed", "failed", "failure", "fails", "invalid",
  "incorrect", "wrong", "rejected", "revoked", "missing", "required", "denied", "unauthorized", "unauthorised", "unauthenticated",
  "forbidden", "authstate"]);
/** Phrases read as one state word: their own secret words ("auth login", "setup-token") name a command, not a value. */
const AUTH_PHRASES = /\bnot\s+(?:set|authenticated|authori[sz]ed|logged\s+in|signed\s+in|valid|configured)\b|\b(?:sign|log)\s+in\s+again\b|\bauth\s+(?:login|logout|status)\b|\bsetup-token\b/gi;
/** A word that could be a secret's value: digits in a run of four or more, a long run, or a token's shape. */
const valueShaped = (word: string) => (/\d/.test(word) && word.length >= 4) || word.length >= 16 || /^eyJ/.test(word);
const SETTING_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
const FILLER = new Set(["the", "a", "an", "your", "this", "that", "its", "has", "have", "been", "is", "was", "for", "to", "and", "or", "of"]);

/** Whether a suspect line only says a credential's state (see AUTH_STATE), with no value of one anywhere in it. */
function authStateLine(line: string): boolean {
  const body = decodeEscapes(line.replace(LINE_PREFIX, ""));
  // No quoted value, no URL credentials, nothing left open.
  if (body.includes('"') || /(?:^|[^A-Za-z0-9])'/.test(body) || /[^\s:/@]+:[^\s@/]*@|:\/\/[^\s/]*@/.test(body)) return false;
  if (isOpen(readOpen({ depth: 0, quote: "" }, body, true))) return false;
  const items = body.replace(AUTH_PHRASES, " authstate ").match(/[A-Za-z0-9_.+/-]+|[:=@]/g) ?? [];
  // A separator anywhere followed by something value-shaped ("expired: eyJ…", "=abc123…").
  if (items.some((item, i) => (item === ":" || item === "=" || item === "@") && items[i + 1] !== undefined && valueShaped(items[i + 1]))) return false;
  const words = items.map(item => item.replace(/[.+/]+$/g, ""));
  const plain = (w: string) => w.toLowerCase().replace(/[^a-z0-9]/g, "");
  const hit = (i: number) => {
    const w = words[i];
    if (!/[A-Za-z]/.test(w) || plain(w) === "authstate") return false;
    if (LINE_SECRETS.test(plain(w)) || w.toLowerCase().split(/[^a-z0-9]+/).some(part => LINE_WORDS.has(part))) return true;
    // Two words that spell one ("access code", "pass word").
    const next = words[i + 1] ?? "", prev = words[i - 1] ?? "";
    return LINE_SECRETS.test(plain(w) + plain(next)) || LINE_SECRETS.test(plain(prev) + plain(w));
  };
  const state = (w: string | undefined) => w !== undefined && AUTH_STATE.has(w.toLowerCase());
  for (let i = 0; i < words.length; i++) {
    if (!hit(i)) continue;
    const w = words[i], next = items[i + 1], prev = items[i - 1];
    if (next === ":" || next === "=" || next === "@" || prev === "@" || prev === "=") return false;
    if (prev === ":" && i >= 2 && hit(i - 2)) return false;                       // user:pass
    // Next and previous real words: never value-shaped; after "is"/"was", only a state ("Access code is wrong").
    const after = words.slice(i + 1).filter(x => /[A-Za-z0-9]/.test(x)), before = words.slice(0, i).filter(x => /[A-Za-z0-9]/.test(x)).reverse();
    if ((after[0] && valueShaped(after[0]) && !hit(i + 1)) || (before[0] && valueShaped(before[0]) && !hit(i - 1))) return false;
    if (/^(?:is|was|are|were)$/i.test(after[0] ?? "") && !(state(after[1]) || /^not$/i.test(after[1] ?? ""))) return false;
    if (state(w)) continue;                                                        // "Unauthorized" says its own state
    if (SETTING_NAME.test(w)) continue;                                            // a setting's name, nothing after it
    // A state word within three real words either side (filler words skipped).
    const near = [...after.filter(x => !FILLER.has(x.toLowerCase())).slice(0, 3), ...before.filter(x => !FILLER.has(x.toLowerCase())).slice(0, 3)];
    if (!near.some(state)) return false;
  }
  return true;
}

/** A rescued auth-state line with any secret-shaped run (long base64, hex, a JWT, a random run with digits) replaced. */
const scrubRuns = (line: string) => line.replace(/\beyJ[\w-]*\.[\w-]*(?:\.[\w-]*)?|[A-Za-z0-9+/=_-]{16,}/g, run => /\d/.test(run) || /^eyJ/.test(run) ? MARK : run);

/** Most lines a heuristic continuation (indented lines, a YAML block, a single quote) takes, so it stays bounded. */
const CONTINUATION_LIMIT = 200;
const indent = (line: string) => /^[ \t]*/.exec(line)![0].length;

/**
 * How many lines after lines[i] (a suspect line) continue it: while a double quote or a bracket it opened is verifiably
 * still open, however many; lines indented deeper than it, a YAML block scalar it starts (blank lines included), or
 * a single-quoted value, up to CONTINUATION_LIMIT; a multipart part named like a secret, to its next boundary; and
 * an Authorization or Bearer line that ends mid-token, its wrapped next line.
 */
function continuation(lines: string[], i: number): number {
  const line = lines[i];
  if (/^\s*content-disposition\s*:/i.test(line)) {
    let j = i + 1;
    while (j < lines.length && !/^--\S/.test(lines[j])) j++;
    return j - i - 1;
  }
  let open = readOpen({ depth: 0, quote: "" }, line, true);
  const block = /[:=]\s*[>|][-+]?\d?\s*$/.test(line), base = indent(line);
  let taken = 0, heuristic = 0;
  while (i + taken + 1 < lines.length) {
    const next = lines[i + taken + 1];
    const verified = open.depth > 0 || open.quote === '"';
    if (!verified) {
      const deeper = /\S/.test(next) && indent(next) > base && !LINE_PREFIX.test(next.trimStart());
      const inBlock = block && (!/\S/.test(next) || indent(next) > base);
      if (!(open.quote === "'" || deeper || inBlock) || ++heuristic > CONTINUATION_LIMIT) break;
    }
    open = readOpen(open, next, true);
    taken++;
  }
  // A blank line closing a YAML block is not part of it.
  while (block && taken > 0 && !/\S/.test(lines[i + taken])) taken--;
  if (taken === 0 && /\b(?:authorization|bearer)\b/i.test(line) && /[A-Za-z0-9._~+/=-]$/.test(line)) {
    const next = lines[i + 1];
    if (next !== undefined && /^[A-Za-z0-9._~+/=-]/.test(next) && !LINE_PREFIX.test(next)) return 1;
  }
  return taken;
}

/**
 * Free text with each suspect line withheld whole, with the lines that continue it; its time and level stay. A suspect
 * line that is only a name and a safe value stays, but what continues it is withheld all the same.
 */
export function withholdSuspectLines(text: string): string {
  const lines = text.split("\n"), out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!suspectLine(line)) { out.push(line); continue; }
    const taken = continuation(lines, i);
    if (safeLine(line)) {
      out.push(line);
      if (taken) out.push(WITHHELD);
    } else if (!taken && authStateLine(line)) {
      out.push(scrubRuns(line));
    } else {
      out.push((LINE_PREFIX.exec(line)?.[0] ?? "") + WITHHELD);
    }
    i += taken;
  }
  return out.join("\n");
}

/**
 * text with every secret this module can recognise replaced, failing closed: known secret values in every encoded
 * form; then the named patterns (values of secret-named keys, cookies, authorization headers, URL credentials,
 * emails, JWTs, bare tokens, PEM blocks, other people's home folders); then every line that still names a secret
 * withheld whole. Serial numbers, hosts, error codes and lowercase hashes stay.
 */
export function redactText(text: string, secrets: Iterable<string> = []): string {
  // Lines are judged as written (a pattern's replacement could close a quote the secret left open); PEM blocks span
  // lines with no secret word in them, so they go first.
  const known = [...secrets];
  return redactPatterns(withholdSuspectLines(removePem(removeKnownSecrets(text, known))), known);
}

const PEM = /-----BEGIN ([A-Z0-9 ]{1,64})-----[\s\S]*?(?:-----END \1-----|$)/g;
const removePem = (text: string) => text.replace(PEM, MARK);

/** The pattern rules alone (redactText without withholding lines): what each named form becomes. */
export function redactPatterns(text: string, secrets: Iterable<string> = []): string {
  let out = removeKnownSecrets(text, secrets);
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

/**
 * A logged or composed value with its secrets removed, by its structure: a secret-named key's value goes (a bare
 * measure such as tokenCount stays); an object where any field names a secret ({"name":"BAMBU_ACCESS_CODE", …})
 * loses its other scalars; a string holding JSON is read and walked; any other string is redacted as text, one
 * value per line, so a string that names a secret is withheld.
 */
export function redactValue(value: unknown, secrets: Iterable<string> = [], depth = 0): unknown {
  const known = [...secrets];
  if (depth > 32) return WITHHELD;
  if (typeof value === "string") {
    const t = value.trim();
    if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
      try { return JSON.stringify(redactValue(JSON.parse(t), known, depth + 1)); } catch { /* not JSON */ }
    }
    return redactText(value, known);
  }
  return redactStructure(value, known, depth);
}

/** Fields that hold a setting's name, whose secret-sounding value is a name, not a secret: {"name":"BAMBU_TOKEN"}. */
/** Fields that hold a setting's name, in the order one is chosen as an object's name: {"name":"BAMBU_TOKEN"}. */
const NAME_FIELDS = ["name", "key", "env", "envname", "env_name", "variable", "var", "field", "setting", "setting_name", "settingname", "property", "label", "id"];
/** A name as people write one: an identifier, or a few words ("Access Code"). */
const LABEL = /^[A-Za-z_][\w.\-]*(?: [\w.\-]+){0,3}$/;
const safeScalar = (v: unknown) => typeof v === "boolean" || v === null || v === undefined || v === "" || v === "[set]";

function redactStructure(value: unknown, known: string[], depth: number): unknown {
  if (Array.isArray(value)) {
    // A pair, as Object.entries writes one: ["BAMBU_TOKEN", "…"]. Its second item goes when the first names a secret.
    if (value.length === 2 && typeof value[0] === "string" && value[0].length <= 96 && isSecretName(value[0])) {
      return [LABEL.test(value[0]) ? value[0] : redactValue(value[0], known, depth + 1), safeScalar(value[1]) ? value[1] : MARK];
    }
    return value.map(item => redactValue(item, known, depth + 1));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    // The one field naming this object: the first name field, in NAME_FIELDS' order, whose whole string names a secret.
    const candidates = entries.filter(([k, v]) => NAME_FIELDS.includes(k.toLowerCase()) && typeof v === "string" && v.length <= 96 && isSecretName(v));
    const chosen = candidates.sort(([a], [b]) => NAME_FIELDS.indexOf(a.toLowerCase()) - NAME_FIELDS.indexOf(b.toLowerCase()))[0]?.[0];
    return Object.fromEntries(entries.map(([k, v]) => {
      // The chosen name field keeps its name ({"name":"BAMBU_TOKEN"}, {"name":"Access Code"}).
      if (k === chosen) return [k, LABEL.test(v as string) ? v : redactValue(v, known, depth + 1)];
      if (isSecretName(k)) return [k, safeScalar(v) || (typeof v === "number" && MEASURE_NAME.test(k)) ? v : MARK];
      // An object that names a secret ({"name":"BAMBU_ACCESS_CODE","note":…,"value":…}) loses every other value.
      if (chosen !== undefined) return [k, safeScalar(v) ? v : MARK];
      return [k, redactValue(v, known, depth + 1)];
    }));
  }
  return value;
}

/** A JSON file's text with its values redacted by structure (it stays valid JSON); other text as free text. */
export function redactJsonText(text: string, secrets: Iterable<string> = []): string {
  try { return JSON.stringify(redactValue(JSON.parse(text), secrets), null, 2) + "\n"; } catch { return redactText(text, secrets); }
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
export function buildDiagnostics(options: { package: string; version: string; sources: DiagnosticsSource[]; notes?: string[]; fixedNotes?: string[]; maxBytes?: number; secrets?: string[] }): DiagnosticsResult {
  const maxBytes = diagnosticsBudget(options.maxBytes);
  // Notes are redacted as any text is; fixedNotes are this server's own sentences built only from constants (setting
  // names it reads), whose secret words name settings: the patterns and known secrets go, the words stay.
  const notes = [...(options.fixedNotes ?? []).map(note => redactPatterns(note, options.secrets)), ...(options.notes ?? []).map(note => redactText(note, options.secrets))];
  const redact = (name: string, text: string) => name.endsWith(".json") ? redactJsonText(text, options.secrets) : redactText(text, options.secrets);
  const entries: Array<{ name: string; text: string; cut: boolean }> = [];
  for (const source of options.sources) {
    checkName(source.name);
    if ("text" in source) {
      entries.push({ name: source.name, text: redact(source.name, source.text), cut: false });
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
    entries.push({ name: source.name, text: redact(source.name, read.text), cut: read.cut });
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

/**
 * Settings whose values are known not to be secret (paths, hosts, ports, modes, models, timeouts). Any other setting
 * shows only whether it is set: commands and their arguments, URLs and anything else can carry a credential.
 */
export const SAFE_SETTINGS = new Set(`BAMBU_CONFIRMATION_TIMEOUT_MS BAMBU_CONTROL_REPLY_MS BAMBU_DEFAULT_CONNECTION_MODE BAMBU_DEFAULT_CONNECTION_TYPE
  BAMBU_DISPATCH_CHECK_MS BAMBU_EMERGENCY_MQTT_TIMEOUT_MS BAMBU_MODEL BAMBU_NATIVE_ALLOW_UNPINNED_PLUGIN BAMBU_NATIVE_CERT_DIR
  BAMBU_NATIVE_CERT_FILE BAMBU_NATIVE_CONFIG_DIR BAMBU_NATIVE_HELPER BAMBU_NATIVE_HOME BAMBU_NATIVE_PLUGIN BAMBU_NATIVE_TRY_EMMC_PRINT
  BAMBU_NETWORK_CONFIG_DIR BAMBU_NETWORK_COUNTRY_CODE BAMBU_NETWORK_PLUGIN_DIR BAMBU_NOZZLE_TYPE BAMBU_NOZZLE_VOLUME_TYPE BAMBU_PRINTER_HOST
  BAMBU_PRINTER_MODEL BAMBU_PRINTER_SERIAL BAMBU_PROFILES_ROOT BAMBU_RESUME_STATE_DIR BAMBU_SERIAL BAMBU_SLICER_PROFILE
  BAMBU_SLICER_PROFILE_DIRS BAMBU_STOP_ACK_MS BAMBU_STUDIO_CONFIG BAMBU_STUDIO_PATH BAMBU_TEMPLATE_3MF_PATH BAMBU_TEMPLATE_DIR BED_TYPE
  BLENDER_MCP_TIMEOUT_MS CAD_DATA_DIR CAD_OUTPUT_DIRS FILAMENT_PROFILE FULU_ORCA_PATH FULU_ORCA_PLUGIN_DIR FUSION_MCP_HOST FUSION_MCP_PORT
  FUSION_MCP_TIMEOUT_MS MCP_HTTP_HOST MCP_HTTP_JSON_RESPONSE MCP_HTTP_PATH MCP_HTTP_PORT MCP_HTTP_STATEFUL MCP_TRANSPORT NOZZLE_DIAMETER
  ORCASLICER_BAMBULAB_PATH ORCASLICER_BAMBULAB_PLUGIN_DIR ORCA_SLICER_BAMBULAB_PATH PJARCZAK_BAMBU_COUNTRY_CODE PJARCZAK_BAMBU_PLUGIN_DIR
  PJARCZAK_EXPECTED_BAMBU_NETWORK_VERSION PJARCZAK_MAC_RUNTIME_DIR PRINTER_HOST PRINTER_PORT PRINTER_TYPE PRINT_CONFIRMATION_TIMEOUT_MS
  REPETIER_SLUG SLICER_API_MODE SLICER_API_TIMEOUT_MS SLICER_FILAMENT_PROFILE SLICER_PATH SLICER_PROFILE SLICER_STALL_SECONDS
  SLICER_TIMEOUT_MS SLICER_TYPE TEMP_DIR`.split(/\s+/));

/** The environment settings whose names match, sorted: a known non-secret one with its value, any other only "[set]" (or ""). */
export function settingsSnapshot(names: RegExp, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(Object.entries(env)
    .filter((entry): entry is [string, string] => names.test(entry[0]) && typeof entry[1] === "string")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => [name, SAFE_SETTINGS.has(name) || !value ? value : "[set]"]));
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
