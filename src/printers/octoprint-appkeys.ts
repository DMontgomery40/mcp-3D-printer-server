/**
 * OctoPrint's Application Keys flow: the person approves this app in OctoPrint's own web page instead of copying an
 * API key by hand. OctoPrint bundles the plugin since 1.5 (src/octoprint/plugins/appkeys/__init__.py; workflow at
 * https://docs.octoprint.org/en/master/bundledplugins/appkeys.html):
 *
 *   GET  /plugin/appkeys/probe                → 204 when the plugin is enabled
 *   POST /plugin/appkeys/request {app, user?} → 201 {app_token, auth_dialog}; 429 beyond 3 a minute, 5 in 10 minutes, 10 an hour
 *   GET  /plugin/appkeys/request/<app_token>  → 202 while pending, 200 {api_key} once allowed, 404 when denied or expired
 *
 * OctoPrint drops a pending request when it isn't polled for 5 seconds (POLL_TIMEOUT), so this server keeps polling
 * every 2 seconds between tool calls and holds the outcome for the client's next call. A request no one answers ends
 * after 10 minutes. Every logged-in OctoPrint page shows the Allow/Deny prompt; auth_dialog opens it directly.
 */
import { isAxiosError, type AxiosInstance } from "axios";
import { randomUUID } from "node:crypto";
import { octoPrintBaseUrl } from "./octoprint.js";

export type AppKeyStatus = "pending" | "approved" | "denied" | "expired" | "unsupported" | "unreachable" | "rate-limited";
export interface AppKeyResult {
  status: AppKeyStatus;
  request_id?: string;
  /** OctoPrint's page that asks the person to allow this app (OctoPrint's auth_dialog). */
  approve_url?: string;
  /** What to tell the person, in plain words. */
  message: string;
  /** Once approved: the key, and the setting it goes in, by this server's own name. */
  api_key?: string;
  env?: Record<string, string>;
}

const POLL_MS = 2_000;
const LIFETIME_MS = 10 * 60_000;
const MAX_WAIT_MS = 120_000;

interface Pending {
  base: string;
  token: string;
  approveUrl: string;
  outcome?: Exclude<AppKeyStatus, "pending">;
  apiKey?: string;
  timer?: NodeJS.Timeout;
  expires: number;
  waiters: Array<() => void>;
}

/** Node's codes for a TLS certificate it won't trust (self-signed, unknown issuer, wrong name). */
function untrustedCertificate(error: unknown): boolean {
  const code = String((error as { code?: unknown })?.code ?? "");
  return /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/.test(code);
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export class OctoPrintAppKeys {
  private readonly pending = new Map<string, Pending>();
  private closed = false;

  constructor(private readonly http: AxiosInstance) {}

  /**
   * Start a request (no request_id) or read one; wait_ms waits up to that long for the person's answer.
   * Starting and waiting in one call works for a client that keeps no process between calls.
   */
  async request(options: { host: string; port: string; app: string; user?: string; requestId?: string; waitMs?: number }): Promise<AppKeyResult> {
    const waitMs = Math.min(Math.max(Number.isFinite(options.waitMs) ? Number(options.waitMs) : 0, 0), MAX_WAIT_MS);
    if (options.requestId) {
      const entry = this.pending.get(options.requestId);
      if (!entry) return { status: "expired", request_id: options.requestId, message: "This approval request is no longer open. Start a new one." };
      return this.answer(options.requestId, entry, waitMs);
    }
    const base = octoPrintBaseUrl(options.host, options.port);
    try {
      await this.http.get(`${base}/plugin/appkeys/probe`, { validateStatus: status => status === 204 });
    } catch (error) {
      if (isAxiosError(error) && error.response) {
        return { status: "unsupported", message: "This OctoPrint can't approve apps (its Application Keys plugin is off or it's older than 1.5). Copy the API key from OctoPrint: Settings → Application Keys (or Settings → API) instead." };
      }
      return { status: "unreachable", message: untrustedCertificate(error)
        ? `${base} has a certificate this computer doesn't trust (OctoPi's own is self-signed). Use its http:// address on your local network instead.`
        : `OctoPrint didn't answer at ${base}. Check the address and port.` };
    }
    let data: any;
    try {
      data = (await this.http.post(`${base}/plugin/appkeys/request`, { app: options.app, ...(options.user ? { user: options.user } : {}) }, {
        headers: { "Content-Type": "application/json" }, validateStatus: status => status === 201,
      })).data;
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 429) {
        return { status: "rate-limited", message: "OctoPrint limits approval requests (3 a minute, 5 in 10 minutes, 10 an hour). Wait a few minutes and try again." };
      }
      throw new Error(`OctoPrint refused the approval request: ${(error as Error).message}`);
    }
    const token = typeof data?.app_token === "string" ? data.app_token : "";
    if (!token) throw new Error("OctoPrint's approval request returned no app_token.");
    const approveUrl = typeof data?.auth_dialog === "string" && data.auth_dialog ? data.auth_dialog : `${base}/`;
    const id = randomUUID();
    const entry: Pending = { base, token, approveUrl, expires: Date.now() + LIFETIME_MS, waiters: [] };
    this.pending.set(id, entry);
    this.poll(id, entry);
    return this.answer(id, entry, waitMs);
  }

  /** Stop polling every open request (server shutdown). */
  close(): void {
    this.closed = true;
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
  }

  private async answer(id: string, entry: Pending, waitMs: number): Promise<AppKeyResult> {
    if (!entry.outcome && waitMs > 0) {
      await Promise.race([sleep(waitMs), new Promise<void>(resolve => entry.waiters.push(resolve))]);
    }
    const result: AppKeyResult = { status: entry.outcome ?? "pending", request_id: id, approve_url: entry.approveUrl, message: "" };
    switch (result.status) {
      case "pending":
        result.message = "Open OctoPrint in a browser, signed in as the user who will print, and click Allow on the access request.";
        break;
      case "approved":
        result.api_key = entry.apiKey;
        result.env = { API_KEY: entry.apiKey! };
        result.message = "OctoPrint allowed this app. Its key is saved as API_KEY.";
        break;
      case "denied":
        result.message = "OctoPrint said no, or the request lapsed there. Start a new one to try again.";
        break;
      default:
        result.message = "No one answered the request in OctoPrint in time. Start a new one.";
    }
    // A finished request is read once, then forgotten (the key isn't kept in memory longer than needed).
    if (result.status !== "pending") { clearTimeout(entry.timer); this.pending.delete(id); }
    return result;
  }

  private poll(id: string, entry: Pending): void {
    const settle = (outcome: Exclude<AppKeyStatus, "pending">, apiKey?: string) => {
      entry.outcome = outcome;
      if (apiKey) entry.apiKey = apiKey;
      for (const wake of entry.waiters.splice(0)) wake();
      // An outcome nobody reads is dropped after a while too.
      entry.timer = setTimeout(() => this.pending.delete(id), LIFETIME_MS);
      entry.timer.unref?.();
    };
    const tick = async () => {
      if (this.closed || this.pending.get(id) !== entry) return;
      if (Date.now() > entry.expires) return settle("expired");
      try {
        const response = await this.http.get(`${entry.base}/plugin/appkeys/request/${encodeURIComponent(entry.token)}`, {
          validateStatus: status => status === 200 || status === 202 || status === 404,
        });
        if (response.status === 200 && typeof response.data?.api_key === "string" && response.data.api_key) return settle("approved", response.data.api_key);
        if (response.status === 404) return settle("denied");
      } catch {
        // A dropped poll is retried; OctoPrint keeps the request for 5 s between polls.
      }
      if (this.closed || this.pending.get(id) !== entry) return;
      entry.timer = setTimeout(tick, POLL_MS);
      entry.timer.unref?.();
    };
    entry.timer = setTimeout(tick, POLL_MS);
    entry.timer.unref?.();
  }
}
