import { createHash, randomUUID } from "node:crypto";
import { EventStore, type PrintEvent, type Subscription } from "./store.js";
import { callbackUrl, sameChallenge, sendPublicCallback, sign, signingKey, type CallbackSender } from "./webhook.js";

const NAMES = ["print.completed", "print.problem"] as const;
export class EventProtocolError extends Error {
  constructor(readonly code: number, message: string, readonly data?: Record<string, string>) { super(message); }
}
export interface AuthContext { principal: string }
export type Authorize = (context: AuthContext, printer: string) => boolean | Promise<boolean>;
export const EVENT_DEFINITIONS = NAMES.map(name => ({ name, delivery: ["webhook"],
  description: name === "print.completed" ? "An observed print finishes successfully." : "An observed print reports a failure or actionable error code.",
  inputSchema: { type: "object", properties: { printer: { type: "string", minLength: 1, maxLength: 64 } }, required: ["printer"], additionalProperties: false },
  payloadSchema: { type: "object", properties: { printer: { type: "string", minLength: 1, maxLength: 64 }, jobId: { type: "string" }, test: { type: "boolean", description: "When true this is a labeled synthetic acceptance test, not a physical completion." },
    reason: { type: "string", enum: ["print_error", "hms", "failed"] }, codes: { type: "array", items: { type: "string" } } },
    required: name === "print.completed" ? ["printer", "jobId"] : ["printer", "jobId", "reason", "codes"], additionalProperties: false },
}));
function position(value: unknown, head: number): number {
  if (value === null || value === undefined) return head;
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > head) {
    throw new EventProtocolError(-32602, "Invalid event cursor");
  }
  return Number(value);
}
/** Embedding seam only: host MUST provide real MCP2 transport + authenticated owner.
 * Never register these methods or advertise MCP2 through the legacy SDK 1.x server.
 */
export class PrintEventService {
  private deliveryWork?: Promise<void>;
  private batchOffset = 0;
  constructor(readonly store: EventStore, private readonly authorize: Authorize,
    private readonly sender: CallbackSender = sendPublicCallback, private readonly now = Date.now, readonly printers: readonly string[] = ["default"], private readonly namesForPrinter: (printer: string) => readonly string[] = () => NAMES) {
    if (!printers.length || new Set(printers).size !== printers.length || printers.some(printer => !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(printer))) throw new Error("Invalid printer aliases");
  }
  async handle(method: string, params: any, context: AuthContext): Promise<unknown> {
    return (async () => {
      if (!context?.principal) throw new EventProtocolError(-32012, "Forbidden");
      if (method === "events/list") {
        if (params?.cursor != null) throw new EventProtocolError(-32602, "Invalid catalog cursor");
        const allowed: string[] = [];
        for (const printer of this.printers) if (await this.authorize(context, printer)) allowed.push(printer);
        if (!allowed.length) throw new EventProtocolError(-32012, "Forbidden");
        return { events: EVENT_DEFINITIONS.map(event => ({ ...event, inputSchema: { ...event.inputSchema, properties: { printer: { type: "string", enum: allowed.filter(printer => this.namesForPrinter(printer).includes(event.name)) } } } })).filter(event => event.inputSchema.properties.printer.enum.length > 0) };
      }
      if (method !== "events/subscribe" && method !== "events/unsubscribe") throw new EventProtocolError(-32601, "Method not found");
      if (!NAMES.includes(params?.name) || typeof params?.arguments?.printer !== "string" ||
          Object.keys(params.arguments).length !== 1 || params?.delivery?.mode !== "webhook") throw new EventProtocolError(-32602, "Invalid event subscription");
      const printer = params.arguments.printer as string;
      await this.access(context, printer);
      if (!this.namesForPrinter(printer).includes(params.name)) throw new EventProtocolError(-32602, "Event unavailable for this printer");
      let url: string;
      try { url = callbackUrl(params.delivery.url).href; } catch { throw new EventProtocolError(-32602, "Invalid callback URL"); }
      const id = `sub_${createHash("sha256").update(JSON.stringify([context.principal, url, params.name, { printer }])).digest("hex")}`;
      const existing = this.store.data.subscriptions.find(item => item.id === id);
      if (method === "events/unsubscribe") {
        this.store.data.subscriptions = this.store.data.subscriptions.filter(item => item.id !== id);
        this.store.save(); return {};
      }
      try { signingKey(params.delivery.secret); } catch { throw new EventProtocolError(-32602, "Invalid webhook secret"); }
      const ttl = params.ttlMs === undefined || params.ttlMs === null ? 86400000 : params.ttlMs;
      if (!Number.isSafeInteger(ttl) || ttl < 1) throw new EventProtocolError(-32602, "Invalid subscription lifetime");
      const current = this.now();
      const requested = position(params.cursor, this.store.printerHead(printer));
      // Repeated subscriptions do not skip pending delivery or rewind acknowledged history.
      const start = existing && existing.expires > current ? existing.position : requested;
      if (!existing && this.store.data.subscriptions.filter(item => item.owner === context.principal).length >= 256) throw new EventProtocolError(-32000, "Subscription limit reached");
      const subscription: Subscription = { id, owner: context.principal, printer, name: params.name, url, secret: params.delivery.secret,
        expires: current + Math.min(ttl, 86400000), position: start, attempts: 0, retryAt: 0 };
      if (existing && existing.secret !== subscription.secret) {
        subscription.previousSecret = existing.secret; subscription.rotateUntil = current + 300000;
      } else if (existing?.rotateUntil && existing.rotateUntil > current) {
        subscription.previousSecret = existing.previousSecret; subscription.rotateUntil = existing.rotateUntil;
      }
      const challenge = randomUUID();
      const verified = existing && existing.secret === subscription.secret && (existing.verifiedAt ?? 0) + 300000 > current;
      try {
        if (!verified) {
        const response = await this.post(subscription, `msg_verification_${randomUUID()}`, { type: "verification", challenge });
        if (response.status < 200 || response.status >= 300 || !sameChallenge(JSON.parse(response.body).challenge, challenge)) throw new Error("challenge");
        }
        subscription.verifiedAt = verified ? existing.verifiedAt : current;
      } catch { throw new EventProtocolError(-32015, "Callback verification failed", { reason: "challenge_failed" }); }
      // Access can be revoked while verification is in flight.
      await this.access(context, printer);
      const currentSubscription = this.store.data.subscriptions.find(item => item.id === id);
      if (currentSubscription && currentSubscription.expires > this.now()) subscription.position = Math.max(subscription.position, currentSubscription.position);
      if (!currentSubscription && this.store.data.subscriptions.filter(item => item.owner === context.principal).length >= 256) throw new EventProtocolError(-32000, "Subscription limit reached");
      const previousSubscriptions = this.store.data.subscriptions;
      this.store.data.subscriptions = [...previousSubscriptions.filter(item => item.id !== id), subscription];
      try { this.store.save(); } catch (error) { this.store.data.subscriptions = previousSubscriptions; throw error; }
      return { id, refreshBefore: new Date(subscription.expires).toISOString(), cursor: String(subscription.position), truncated: this.truncated(subscription.position, printer) };
    })();
  }
  private async access(context: AuthContext, printer: string): Promise<void> {
    if (!context || !context.principal || !this.printers.includes(printer) || !(await this.authorize(context, printer))) throw new EventProtocolError(-32012, "Forbidden");
  }
  private truncated(cursor: number, printer: string): boolean {
    return cursor < Number(this.store.data.history.find(item => item.data.printer === printer)?.printerCursor ?? this.store.printerHead(printer) + 1) - 1;
  }
  private post(subscription: Subscription, id: string, event: unknown) {
    const body = JSON.stringify(event); const seconds = Math.floor(this.now() / 1000);
    const signatures = [sign(subscription.secret, id, seconds, body)];
    if (subscription.previousSecret && (subscription.rotateUntil ?? 0) > this.now()) signatures.push(sign(subscription.previousSecret, id, seconds, body));
    return this.sender(subscription.url, body, { "Content-Type": "application/json", "webhook-id": id,
      "webhook-timestamp": String(seconds), "webhook-signature": signatures.join(" "), "X-MCP-Subscription-Id": subscription.id });
  }
  /** Host runs this periodically; no listener, timer, subscription, or outbound work starts on import. */
  async deliverPending(): Promise<void> {
    if (this.deliveryWork) return this.deliveryWork;
    this.deliveryWork = this.deliverBatch().finally(() => { this.deliveryWork = undefined; });
    return this.deliveryWork;
  }
  private async deliverBatch(): Promise<void> {
    const owners = new Map<string, Subscription[]>();
    const snapshot = [...this.store.data.subscriptions];
    let checkIndex = 0;
    await Promise.all(Array.from({length: Math.min(4, snapshot.length)}, async () => {
      while (checkIndex < snapshot.length) {
        const item = snapshot[checkIndex++];
        let allowed = false;
        if (item.expires > this.now() && this.printers.includes(item.printer ?? "default")) {
          try { allowed = await this.authorize({principal:item.owner}, item.printer ?? "default"); } catch { continue; }
        }
        if (this.store.data.subscriptions.find(subscription => subscription.id === item.id) !== item) continue;
        if (!allowed) { this.store.data.subscriptions = this.store.data.subscriptions.filter(subscription => subscription !== item); this.store.save(); continue; }
        const pending = this.store.data.history.some(event => event.data.printer === (item.printer ?? "default") && event.name === item.name && Number(event.printerCursor) > item.position);
        if (!pending || item.stopped || item.retryAt > this.now()) continue;
        const list = owners.get(item.owner) ?? []; list.push(item); owners.set(item.owner, list);
      }
    }));
    // Round-robin owners; cap work so slow callbacks cannot monopolize a worker indefinitely.
    const subscriptions: Subscription[] = [];
    while ([...owners.values()].some(list => list.length)) {
      for (const list of owners.values()) { const item = list.shift(); if (item) subscriptions.push(item); }
    }
    const start = subscriptions.length ? this.batchOffset % subscriptions.length : 0;
    const batch = [...subscriptions.slice(start), ...subscriptions.slice(0, start)].slice(0, 32);
    this.batchOffset = start + batch.length;
    let next = 0;
    await Promise.all(Array.from({length: Math.min(4, batch.length)}, async () => {
      while (next < batch.length) await this.deliverOne(batch[next++]);
    }));
  }
  private async deliverOne(subscription: Subscription): Promise<void> {
        let allowed = false;
        if (subscription.expires > this.now() && this.printers.includes(subscription.printer ?? "default")) {
          try { allowed = await this.authorize({ principal: subscription.owner }, subscription.printer ?? "default"); }
          catch { return; } // Transient verifier failure withholds this owner's delivery, not other owners'.
        }
        if (subscription.expires <= this.now() || !allowed) {
          this.store.data.subscriptions = this.store.data.subscriptions.filter(item => item.id !== subscription.id); this.store.save(); return;
        }
        if (this.store.data.subscriptions.find(item => item.id === subscription.id) !== subscription) return;
        if (subscription.previousSecret && (subscription.rotateUntil ?? 0) <= this.now()) {
          delete subscription.previousSecret; delete subscription.rotateUntil; this.store.save();
        }
        if (subscription.stopped || subscription.retryAt > this.now()) return;
        // Never move the cursor across undelivered events; deliver at most one per subscription per iteration.
        const event = this.store.data.history.find(item => Number(item.printerCursor) > subscription.position && item.name === subscription.name && item.data.printer === (subscription.printer ?? "default"));
        if (!event) return;
        try {
          const deliveryId = `evt_${createHash("sha256").update(JSON.stringify([subscription.id, event.eventId])).digest("hex")}`;
          const response = await this.post(subscription, deliveryId, { eventId: deliveryId, name: event.name, timestamp: event.timestamp, data: event.data, cursor: event.printerCursor });
          if (this.store.data.subscriptions.find(item => item.id === subscription.id) !== subscription) return;
          if (response.status >= 200 && response.status < 300) {
            subscription.position = Number(event.printerCursor); subscription.attempts = 0; subscription.retryAt = 0;
          } else if (response.status === 410 || response.status === 413 || (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429)) {
            subscription.stopped = true;
          } else { this.retry(subscription); }
        } catch { if (this.store.data.subscriptions.find(item => item.id === subscription.id) !== subscription) return; this.retry(subscription); }
        this.store.save();
  }
  private retry(subscription: Subscription): void {
    subscription.attempts++;
    if (subscription.attempts >= 8) subscription.stopped = true;
    else subscription.retryAt = this.now() + Math.min(300000, 1000 * 2 ** (subscription.attempts - 1));
  }
}
/** Read-only legacy surface; these are stored observations, not ChatGPT subscriptions. */
export function listPrintEvents(store: EventStore, cursor: unknown = "0", limit: unknown = 100, printer?: string) {
  const start = position(cursor, store.data.sequence);
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be 1–100");
  const events = store.data.history.filter(item => Number(item.cursor) > start && (!printer || item.data.printer === printer)).slice(0, limit);
  return { journalId: store.data.journalId, events, cursor: events[events.length - 1]?.cursor ?? String(start), truncated: start < Number(store.data.history[0]?.cursor ?? 1) - 1 };
}

/** Remote history never reveals another printer's sequence or retention activity. */
export function listPrinterEvents(store: EventStore, printer: string, cursor: unknown = "0", limit: unknown = 100) {
  const start = position(cursor, store.printerHead(printer));
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be 1–100");
  const history = store.data.history.filter(item => item.data.printer === printer);
  const events = history.filter(item => Number(item.printerCursor) > start).slice(0, limit).map(item => ({eventId:item.eventId, name:item.name, timestamp:item.timestamp, data:item.data, cursor:item.printerCursor}));
  return {events, cursor:events[events.length-1]?.cursor ?? String(start), truncated:start < Number(history[0]?.printerCursor ?? store.printerHead(printer)+1)-1};
}
