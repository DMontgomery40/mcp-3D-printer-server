import {Agent as HttpAgent, type IncomingMessage} from "node:http";
import {Agent as HttpsAgent} from "node:https";
import {isAxiosError, type AxiosInstance} from "axios";
import type {OpenCameraSource} from "./camera-stream.js";

type Handlers = Parameters<OpenCameraSource>[0];
export type CameraUrl = {url: string; headers: Record<string, string>};
const MAX_BYTES = 5_000_000;

/** Same bounded JPEG framing as the Bambu stream; native code decodes pixels. */
export function mjpegParser(onFrame: (bytes: Buffer) => void, onError: (error: Error) => void): (chunk: Buffer) => void {
  let buffer = Buffer.alloc(0), failed = false;
  return chunk => {
    if (failed) return;
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const start = buffer.indexOf(Buffer.from([0xff, 0xd8]));
      if (start < 0) { buffer = buffer.subarray(Math.max(0, buffer.length - 1)); return; }
      if (start) buffer = buffer.subarray(start);
      const end = buffer.indexOf(Buffer.from([0xff, 0xd9]), 2);
      if ((end >= 0 ? end + 2 : buffer.length) > MAX_BYTES) {
        failed = true; onError(new Error("Camera JPEG too large")); return;
      }
      if (end < 0) return;
      onFrame(Buffer.from(buffer.subarray(0, end + 2))); buffer = buffer.subarray(end + 2);
    }
  };
}

/** One persistent MJPEG response, or serialized snapshot requests on one keep-alive socket. */
export function openHttpCameraSource(http: AxiosInstance, plan: {urls: CameraUrl[]; snapshots?: CameraUrl[]; mode: "http-mjpeg" | "http-snapshot"}, fps: number, handlers: Handlers): ReturnType<OpenCameraSource> {
  const controller = new AbortController();
  const httpAgent = new HttpAgent({keepAlive: true, maxSockets: 1});
  const httpsAgent = new HttpsAgent({keepAlive: true, maxSockets: 1});
  let closed = false, response: IncomingMessage | undefined, selected: CameraUrl | undefined;
  let mode = plan.mode;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fail = (error: unknown) => {
    if (!closed) handlers.onError(new Error(isAxiosError(error) && [401, 403].includes(error.response?.status ?? 0) ? "Camera authentication failed" : "Camera unavailable"));
  };
  const close = () => {
    closed = true; clearTimeout(timer); controller.abort(); response?.destroy(); httpAgent.destroy(); httpsAgent.destroy();
  };
  const useSnapshot = () => { mode = "http-snapshot"; selected = undefined; };
  const request = async (): Promise<IncomingMessage | undefined> => {
    for (const candidate of selected ? [selected] : mode === "http-snapshot" && plan.snapshots?.length ? plan.snapshots : plan.urls) {
      try {
        const result = await http.get<IncomingMessage>(candidate.url, {
          headers: candidate.headers, responseType: "stream", timeout: 8000,
          maxRedirects: Object.keys(candidate.headers).length ? 0 : 3,
          httpAgent, httpsAgent, signal: controller.signal,
        });
        response = result.data;
        if (closed) { response.destroy(); return undefined; }
        const contentType = String(result.headers["content-type"] ?? "");
        if (mode === "http-mjpeg" && !/^multipart\/x-mixed-replace\b/i.test(contentType)) {
          response.destroy();
          if (plan.snapshots?.length) { useSnapshot(); return request(); }
          throw new Error("Camera did not return MJPEG");
        }
        selected = candidate;
        return response;
      } catch (error) {
        // Error responses are streams too; always release their socket before trying another URL.
        if (isAxiosError(error)) error.response?.data?.destroy?.();
        if (closed || (isAxiosError(error) && [401, 403].includes(error.response?.status ?? 0))) throw error;
        if (mode === "http-mjpeg" && plan.snapshots?.length && isAxiosError(error) && [404, 405, 415].includes(error.response?.status ?? 0)) {
          useSnapshot(); return request();
        }
      }
    }
    throw new Error("No camera URL answered");
  };
  const run = async () => {
    const began = Date.now(), body = await request();
    if (!body || closed) return;
    if (mode === "http-mjpeg") {
      const arm = () => { clearTimeout(timer); timer = setTimeout(() => fail(new Error("Camera timed out")), 15000); timer.unref(); };
      arm();
      const parse = mjpegParser(bytes => { arm(); if (!closed) handlers.onFrame(bytes); }, fail);
      for await (const chunk of body) { if (closed) return; parse(Buffer.from(chunk)); }
      if (!closed) handlers.onEnd();
    } else {
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of body) {
        if (closed) return;
        const bytes = Buffer.from(chunk); size += bytes.length;
        if (size > MAX_BYTES) { body.destroy(); throw new Error("Camera JPEG too large"); }
        chunks.push(bytes);
      }
      if (closed) return;
      const jpeg = Buffer.concat(chunks);
      if (jpeg.length < 3 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[2] !== 0xff) throw new Error("Camera did not return JPEG");
      handlers.onFrame(jpeg);
      if (closed) return;
      timer = setTimeout(() => { void run().catch(fail); }, Math.max(0, 1000 / fps - (Date.now() - began)));
      timer.unref();
    }
  };
  void run().catch(fail);
  return {close};
}
