import { createHmac, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { isIP } from "node:net";

export interface CallbackResponse { status: number; body: string }
export type CallbackSender = (url: string, body: string, headers: Record<string, string>) => Promise<CallbackResponse>;
export function signingKey(secret: string): Buffer {
  if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) throw new Error("Invalid webhook secret");
  const encoded = secret.slice(6);
  const key = Buffer.from(encoded, "base64");
  if (key.length < 24 || key.length > 64 || key.toString("base64") !== encoded) throw new Error("Invalid webhook secret");
  return key;
}
export function sign(secret: string, id: string, seconds: number, body: string): string {
  return `v1,${createHmac("sha256", signingKey(secret)).update(`${id}.${seconds}.${body}`).digest("base64")}`;
}
export function sameChallenge(actual: unknown, expected: string): boolean {
  if (typeof actual !== "string") return false;
  const a = Buffer.from(actual); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function callbackUrl(value: unknown): URL {
  if (typeof value !== "string" || value.length > 2048) throw new Error("Invalid callback URL");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443")) throw new Error("Invalid callback URL");
  return url;
}
/** Conservative public-unicast policy; reject mapped IPv6 and special-use ranges. */
export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  // Only ordinary 2000::/3 global addresses; exclude documentation, Teredo, 6to4, benchmarking.
  if (isIP(address) === 6) {
    const first = parseInt(address.split(":")[0], 16);
    return first >= 0x2000 && first <= 0x3fff && !/^(2001:(0*:|db8:|0?2:|10:|20:)|2002:|3fff:)/i.test(address);
  }
  return false;
}
/** Resolve at every connection and pin a validated address; no redirect following or proxy. */
export function createPublicCallbackSender(
  resolver: (hostname: string) => Promise<{ address: string; family: number }[]> = hostname => lookup(hostname, { all: true }),
  httpsRequest: (url: URL, options: RequestOptions, callback: (res: IncomingMessage) => void) => ClientRequest = request,
): CallbackSender { return async (destination, body, headers) => {
  const url = callbackUrl(destination);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] :
    await Promise.race([resolver(hostname), new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("Callback DNS timeout")), 10_000); timer.unref();
    })]);
  if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new Error("Non-public callback destination");
  if (Buffer.byteLength(body) > 262144) throw new Error("Callback body exceeds 256 KiB");
  const pinned = addresses[0];
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { method: "POST", agent: false, family: pinned.family, headers,
      lookup: (_host, _options, done) => done(null, pinned.address, pinned.family) }, res => {
      let text = ""; let size = 0;
      res.on("data", chunk => { size += chunk.length; if (size > 16384) res.destroy(new Error("Callback response too large")); else text += chunk; });
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    const deadline = setTimeout(() => req.destroy(new Error("Callback timeout")), 10_000);
    req.on("close", () => clearTimeout(deadline));
    req.on("error", reject);
    req.end(body);
  });
}; }
export const sendPublicCallback = createPublicCallbackSender();
