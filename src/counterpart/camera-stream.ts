/** One camera source per printer; bounded frames and native thumbnail processing. */
// Keep the core server and existing snapshots usable when the optional native addon
// cannot load (for example early Node 18 or an unsupported CPU).
// This narrow optional boundary also lets a Node 18 checkout build after npm omits Sharp.
// Runtime/package tests exercise these methods against the pinned native module.
interface NativeImage {
  metadata(): Promise<{width?: number; height?: number}>;
  resize(width: number, height: number, options: {fit: "fill"}): NativeImage;
  resize(options: {width: number; withoutEnlargement: boolean}): NativeImage;
  greyscale(): NativeImage;
  raw(): NativeImage;
  jpeg(options: {quality: number}): NativeImage;
  toBuffer(): Promise<Buffer>;
  toBuffer(options: {resolveWithObject: true}): Promise<{data: Buffer; info: {width: number; height: number}}>;
}
type NativeProcessor = ((input: Buffer, options: {limitInputPixels: number}) => NativeImage) & {
  cache(options: {memory: number; files: number; items: number}): void;
};
let native: Promise<NativeProcessor> | undefined;
async function nativeSharp() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 20 || (major === 20 && minor < 9)) throw new Error("Native camera processing requires Node 20.9+");
  const optionalPackage: string = "sharp";
  native ??= import(optionalPackage).then(module => {
    const processor = module.default as NativeProcessor;
    processor.cache({memory: 8, files: 0, items: 32});
    return processor;
  });
  return native;
}
export async function cameraNativeAvailable(): Promise<boolean> {
  try { await nativeSharp(); return true; } catch { return false; }
}

export type CameraTransport = "http";
export type CameraSource = { close(): void };
export type OpenCameraSource = (handlers: { onFrame(bytes: Buffer): void; onError(error: Error): void; onEnd(): void }) => CameraSource;
export type FrameOptions = { sinceSeq?: number; waitMs?: number; maxWidth?: number; maxBytes?: number; changedOnly?: boolean; minChange?: number; signal?: AbortSignal };
export type StreamFrameResult = { status: "frame" | "unchanged" | "stopped" | "unavailable"; seq: number; capturedAt?: string; width?: number; height?: number; format?: "image/jpeg"; base64?: string; change?: number; reason?: "auth" | "unreachable" | "no-camera" };
type Frame = { seq: number; bytes: Buffer; thumb: Buffer; at: number; width: number; height: number; scaled: Map<string, Promise<{data: Buffer; info: {width: number; height: number}}>> };
export type StreamOptions = { transport: CameraTransport; fps: number; idleTimeoutMs: number; open: OpenCameraSource; skipFirstFrame: boolean };

export function thumbnailChange(a: Uint8Array, b: Uint8Array): number {
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]);
  return total / (a.length * 255);
}

export class CameraStream {
  readonly startedAt = new Date().toISOString();
  readonly transport: CameraTransport;
  readonly fps: number;
  #source?: CameraSource;
  #timer?: ReturnType<typeof setTimeout>;
  #generation = 0;
  #processing = false;
  #lastAccepted = -Infinity;
  #latest?: Frame;
  // Keep thumbnails of frames actually delivered, not every camera frame. A quiet view may keep
  // comparing with its first frame for hours; a rolling JPEG history would repeatedly resend it.
  #references = new Map<number, Buffer>();
  #waiters = new Set<() => void>();
  #stopped = false;
  #reconnected = false;
  #reason?: StreamFrameResult["reason"];
  #seq = 0;
  constructor(private options: StreamOptions, private nextSeq: () => number, private now: () => number = Date.now) {
    this.transport = options.transport; this.fps = options.fps;
  }
  get stopped(): boolean { return this.#stopped; }
  start(): void { this.touch(); this.#connect(); }
  touch(idleTimeoutMs?: number): void {
    if (this.#stopped) return;
    if (idleTimeoutMs !== undefined) this.options.idleTimeoutMs = idleTimeoutMs;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.stop(), this.options.idleTimeoutMs);
    this.#timer.unref();
  }
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true; this.#generation++;
    clearTimeout(this.#timer);
    this.#source?.close(); this.#source = undefined;
    this.#latest = undefined; this.#references.clear(); this.#wake();
  }
  #wake(): void { for (const wake of [...this.#waiters]) wake(); }
  #connect(): void {
    const generation = ++this.#generation;
    let buffered: Buffer | undefined, live = !this.options.skipFirstFrame;
    const current = () => !this.#stopped && generation === this.#generation;
    try {
      const source = this.options.open({
        onFrame: bytes => {
          if (!current()) return;
          // P1/A1 replay their stale buffered frame, sometimes more than once.
          if (!live) { if (!buffered) { buffered = bytes; return; } if (bytes.equals(buffered)) return; buffered = undefined; live = true; }
          if (this.#processing || this.now() - this.#lastAccepted < 1000 / this.fps) return;
          this.#lastAccepted = this.now(); this.#processing = true;
          void this.#accept(bytes, generation).catch(() => { if (current()) this.#lost("unreachable"); })
            .finally(() => { this.#processing = false; });
        },
        onError: error => { if (current()) this.#lost(/auth|payload size|401|403/i.test(error.message) ? "auth" : "unreachable"); },
        onEnd: () => { if (current()) this.#lost("unreachable"); },
      });
      // A transport may fail synchronously. Never keep its abandoned source after reconnect/stop.
      if (current()) this.#source = source; else source.close();
    } catch { if (current()) this.#lost("unreachable"); }
  }
  #lost(reason: NonNullable<StreamFrameResult["reason"]>): void {
    this.#generation++;
    this.#source?.close(); this.#source = undefined;
    if (!this.#reconnected && reason !== "auth") { this.#reconnected = true; this.#connect(); return; }
    this.#reason = reason; this.stop();
  }
  async #accept(bytes: Buffer, generation: number): Promise<void> {
    if (bytes.length > 5_000_000) throw Error("Camera JPEG too large");
    const decoder = (await nativeSharp())(bytes, {limitInputPixels: 8_000_000});
    const metadata = await decoder.metadata();
    const thumb = await decoder.resize(32, 18, {fit: "fill"}).greyscale().raw().toBuffer();
    if (this.#stopped || generation !== this.#generation) return;
    this.#latest = {seq: this.#seq = this.nextSeq(), bytes, thumb, at: this.now(), width: metadata.width!, height: metadata.height!, scaled: new Map()};
    this.#wake();
  }
  async frame(options: FrameOptions = {}): Promise<StreamFrameResult> {
    const since = options.sinceSeq ?? 0, deadline = Date.now() + (options.waitMs ?? 0);
    this.touch();
    for (;;) {
      options.signal?.throwIfAborted();
      if (this.#reason) return {status: "unavailable", seq: this.#seq, reason: this.#reason};
      if (this.#stopped) return {status: "stopped", seq: this.#seq};
      const latest = this.#latest;
      if (latest && latest.seq > since) {
        const reference = this.#references.get(since);
        const change = reference ? thumbnailChange(latest.thumb, reference) : 1;
        if (options.changedOnly === false || change >= (options.minChange ?? 0.02)) return this.#result(latest, change, options.maxWidth, options.maxBytes);
      }
      const left = deadline - Date.now();
      if (left <= 0) return {status: "unchanged", seq: since, ...(latest ? {capturedAt: new Date(latest.at).toISOString()} : {})};
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); this.#waiters.delete(done); options.signal?.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, left);
        this.#waiters.add(done); options.signal?.addEventListener("abort", done, {once: true});
      });
    }
  }
  async latest(waitMs: number): Promise<Buffer | undefined> {
    const result = await this.frame({waitMs, changedOnly: false});
    return result.status === "frame" ? Buffer.from(result.base64!, "base64") : undefined;
  }
  async #encoded(frame: Frame, width: number, maxBytes?: number): Promise<{data: Buffer; info: {width: number; height: number}}> {
    // Start near the byte target instead of always encoding a full-size frame that will be
    // discarded. Source JPEG density is a cheap conservative estimate, not a size guarantee.
    if (maxBytes && frame.bytes.length > maxBytes) width = Math.min(width, Math.max(1, Math.floor(frame.width * Math.sqrt(maxBytes / frame.bytes.length) * 0.8)));
    // At most four native encodes. The final 1-pixel fallback guarantees a bounded result
    // even for pathological entropy; quality stays 70 and aspect ratio is preserved.
    for (let attempt = 0; attempt < 4; attempt++) {
      const encoded = await (await nativeSharp())(frame.bytes, {limitInputPixels: 8_000_000}).resize({width, withoutEnlargement: true}).jpeg({quality: 70}).toBuffer({resolveWithObject: true});
      if (!maxBytes || encoded.data.length <= maxBytes) return encoded;
      width = attempt === 2 ? 1 : Math.max(1, Math.floor(width * Math.min(0.8, Math.sqrt(maxBytes / encoded.data.length) * 0.9)));
    }
    throw new Error("Camera frame could not fit max_bytes");
  }
  async #result(frame: Frame, change: number, maxWidth?: number, maxBytes?: number): Promise<StreamFrameResult> {
    let bytes = frame.bytes, width = frame.width, height = frame.height;
    if ((maxWidth && width > maxWidth) || (maxBytes && bytes.length > maxBytes)) {
      const key = `${maxWidth ?? width}:${maxBytes ?? 0}`;
      let scaled = frame.scaled.get(key);
      if (!scaled) {
        scaled = this.#encoded(frame, Math.min(width, maxWidth ?? width), maxBytes);
        if (frame.scaled.size < 4) frame.scaled.set(key, scaled);
      }
      const resized = await scaled; bytes = resized.data; width = resized.info.width; height = resized.info.height;
    }
    if (this.#stopped) return this.#reason ? {status: "unavailable", seq: this.#seq, reason: this.#reason} : {status: "stopped", seq: this.#seq};
    this.#references.set(frame.seq, frame.thumb);
    if (this.#references.size > 256) this.#references.delete(this.#references.keys().next().value!);
    return {status: "frame", seq: frame.seq, capturedAt: new Date(frame.at).toISOString(), width, height, format: "image/jpeg", base64: bytes.toString("base64"), change};
  }
}

export class CameraStreams {
  #streams = new Map<string, CameraStream>();
  #sequence = 0;
  constructor(private now: () => number = Date.now) {}
  get(key: string): CameraStream | undefined { return this.#streams.get(key); }
  start(key: string, options: StreamOptions): {stream: CameraStream; status: "started" | "running"} {
    const existing = this.get(key);
    if (existing && !existing.stopped) { existing.touch(options.idleTimeoutMs); return {stream: existing, status: "running"}; }
    const stream = new CameraStream(options, () => ++this.#sequence, this.now);
    this.#streams.set(key, stream); stream.start();
    return {stream, status: "started"};
  }
  stop(key: string): void { this.get(key)?.stop(); }
  stopAll(): void { for (const stream of this.#streams.values()) stream.stop(); this.#streams.clear(); }
}
