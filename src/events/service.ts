import { createHash, randomUUID } from "node:crypto";
import { EventStore, type PrintEvent, type Subscription } from "./store.js";
import { callbackUrl, sameChallenge, sendPublicCallback, sign, signingKey, type CallbackSender } from "./webhook.js";

const NAMES = ["print.completed", "print.problem"] as const;
export class EventProtocolError extends Error {
  constructor(readonly code: number, message: string, readonly data?: Record<string, string>) { super(message); }
}
export interface AuthContext { principal: string }
export type Authorize = (context: AuthContext, printer: "default") => boolean | Promise<boolean>;
export const EVENT_DEFINITIONS = NAMES.map(name => ({ name, delivery: ["webhook"],
  description: name === "print.completed" ? "An observed Bambu print finishes successfully." : "An observed Bambu print reports a failure or actionable error code.",
  inputSchema: { type: "object", properties: { printer: { type: "string", enum: ["default"] } }, required: ["printer"], additionalProperties: false },
  payloadSchema: { type: "object", properties: { printer: { type: "string", enum: ["default"] }, jobId: { type: "string" },
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
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly store: EventStore, private readonly authorize: Authorize,
    private readonly sender: CallbackSender = sendPublicCallback, private readonly now = Date.now) {}
  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation); this.queue = next.catch(() => {}); return next;
  }
  async handle(method: string, params: any, context: AuthContext): Promise<unknown> {
    return this.serialized(async () => {
      await this.access(context);
      if (method === "events/list") {
        if (params?.cursor != null) throw new EventProtocolError(-32602, "Invalid catalog cursor");
        return { events: EVENT_DEFINITIONS };
      }
      if (method !== "events/subscribe" && method !== "events/unsubscribe") throw new EventProtocolError(-32601, "Method not found");
      if (!NAMES.includes(params?.name) || params?.arguments?.printer !== "default" ||
          Object.keys(params.arguments).length !== 1 || params?.delivery?.mode !== "webhook") throw new EventProtocolError(-32602, "Invalid event subscription");
      let url: string;
      try { url = callbackUrl(params.delivery.url).href; } catch { throw new EventProtocolError(-32602, "Invalid callback URL"); }
      const id = `sub_${createHash("sha256").update(JSON.stringify([context.principal, url, params.name, { printer: "default" }])).digest("hex")}`;
      const existing = this.store.data.subscriptions.find(item => item.id === id);
      if (method === "events/unsubscribe") {
        this.store.data.subscriptions = this.store.data.subscriptions.filter(item => item.id !== id);
        this.store.save(); return {};
      }
      try { signingKey(params.delivery.secret); } catch { throw new EventProtocolError(-32602, "Invalid webhook secret"); }
      const ttl = params.ttlMs === undefined || params.ttlMs === null ? 86400000 : params.ttlMs;
      if (!Number.isSafeInteger(ttl) || ttl < 1) throw new EventProtocolError(-32602, "Invalid subscription lifetime");
      const current = this.now();
      const requested = position(params.cursor, this.store.data.sequence);
      // Repeated subscriptions do not skip pending delivery or rewind acknowledged history.
      const start = existing && existing.expires > current ? existing.position : requested;
      const subscription: Subscription = { id, owner: context.principal, name: params.name, url, secret: params.delivery.secret,
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
      await this.access(context);
      this.store.data.subscriptions = this.store.data.subscriptions.filter(item => item.id !== id);
      this.store.data.subscriptions.push(subscription); this.store.save();
      return { id, refreshBefore: new Date(subscription.expires).toISOString(), cursor: String(start), truncated: this.truncated(start) };
    });
  }
  private async access(context: AuthContext): Promise<void> {
    if (!context || !context.principal || !(await this.authorize(context, "default"))) throw new EventProtocolError(-32012, "Forbidden");
  }
  private truncated(cursor: number): boolean {
    return cursor < (Number(this.store.data.history[0]?.cursor ?? this.store.data.sequence + 1) - 1);
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
    return this.serialized(async () => {
      for (const subscription of [...this.store.data.subscriptions]) {
        let allowed = false;
        if (subscription.expires > this.now()) {
          try { allowed = await this.authorize({ principal: subscription.owner }, "default"); }
          catch { continue; } // Transient verifier failure withholds this owner's delivery, not other owners'.
        }
        if (subscription.expires <= this.now() || !allowed) {
          this.store.data.subscriptions = this.store.data.subscriptions.filter(item => item.id !== subscription.id); this.store.save(); continue;
        }
        if (subscription.previousSecret && (subscription.rotateUntil ?? 0) <= this.now()) {
          delete subscription.previousSecret; delete subscription.rotateUntil; this.store.save();
        }
        if (subscription.stopped || subscription.retryAt > this.now()) continue;
        // Never move the cursor across undelivered events; deliver at most one per subscription per iteration.
        const event = this.store.data.history.find(item => Number(item.cursor) > subscription.position && item.name === subscription.name);
        if (!event) continue;
        try {
          const deliveryId = `evt_${createHash("sha256").update(JSON.stringify([subscription.id, event.eventId])).digest("hex")}`;
          const response = await this.post(subscription, deliveryId, { ...event, eventId: deliveryId });
          if (response.status >= 200 && response.status < 300) {
            subscription.position = Number(event.cursor); subscription.attempts = 0; subscription.retryAt = 0;
          } else if (response.status === 410 || response.status === 413 || (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429)) {
            subscription.stopped = true;
          } else { this.retry(subscription); }
        } catch { this.retry(subscription); }
        this.store.save();
      }
    });
  }
  private retry(subscription: Subscription): void {
    subscription.attempts++;
    if (subscription.attempts >= 8) subscription.stopped = true;
    else subscription.retryAt = this.now() + Math.min(300000, 1000 * 2 ** (subscription.attempts - 1));
  }
}
/** Read-only legacy surface; these are stored observations, not ChatGPT subscriptions. */
export function listPrintEvents(store: EventStore, cursor: unknown = "0", limit: unknown = 100) {
  const start = position(cursor, store.data.sequence);
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be 1–100");
  const events = store.data.history.filter(item => Number(item.cursor) > start).slice(0, limit);
  return { events, cursor: events[events.length - 1]?.cursor ?? String(start), truncated: start < Number(store.data.history[0]?.cursor ?? 1) - 1 };
}
