/** Additive stream tools; discovery is the capability check for older clients. */
const routing = {
  port: {type: "string", description: "Printer API port; defaults to PRINTER_PORT."},
  type: {type: "string", description: "Printer backend; defaults to PRINTER_TYPE."},
  api_key: {type: "string", description: "Printer API key; defaults to API_KEY."},
  host: {type: "string", description: "Printer host or IP; defaults to PRINTER_HOST."},
  bambu_serial: {type: "string", description: "Printer serial number; defaults to the configured serial and identifies its shared stream."},
  bambu_token: {type: "string", description: "Printer LAN access code; defaults to the configured access code."},
};
const frameSchema = {
  type: "object" as const, properties: {
    status: {type: "string", enum: ["frame", "unchanged", "stopped", "unavailable"]}, seq: {type: "integer", minimum: 0},
    capturedAt: {type: "string"}, width: {type: "integer"}, height: {type: "integer"},
    format: {type: "string", const: "image/jpeg"}, base64: {type: "string"}, change: {type: "number"},
    reason: {type: "string", enum: ["no-camera", "auth", "unreachable"]},
  }, required: ["status", "seq"],
};
export const CAMERA_STREAM_TOOLS = [
  {name: "camera_stream_start", description: "Start or renew one persistent camera connection for this printer. Call only while watched; it closes automatically after idle_timeout_ms without a viewer request. camera_snapshot then reuses its latest frame. No printer motion or print commands.",
    inputSchema: {type: "object" as const, properties: {...routing, fps: {type: "number", minimum: 0.2, maximum: 2, default: 1, description: "Maximum processed frames per second. The first viewer sets the rate until the stream closes."}, idle_timeout_ms: {type: "integer", minimum: 5000, maximum: 120000, default: 30000, description: "Close the shared connection after this many milliseconds without a viewer request."}}, additionalProperties: false},
    outputSchema: {type: "object" as const, properties: {status: {type: "string", enum: ["started", "running", "not-supported"]}, reason: {type: "string", enum: ["runtime"]}, transport: {type: "string", enum: ["http"]}, fps: {type: "number"}, startedAt: {type: "string"}}, required: ["status"], oneOf: [
      {properties: {status: {enum: ["started", "running"]}}, required: ["transport", "fps", "startedAt"]},
      {properties: {status: {const: "not-supported"}}, required: ["reason"]},
    ]}},
  {name: "camera_frame", description: "Read the shared camera stream, optionally waiting up to 10 seconds. Returns JPEG only when newer than since_seq and visibly changed (32×18 grayscale difference). Retain the last delivered frame's seq on unchanged. max_width resizes JPEG to the viewer. Does not start a stopped stream.",
    inputSchema: {type: "object" as const, properties: {...routing, since_seq: {type: "integer", minimum: 0, default: 0, description: "Sequence of the last delivered JPEG; retain it when a result is unchanged."}, wait_ms: {type: "integer", minimum: 0, maximum: 10000, default: 0, description: "Maximum time to await a newer changed frame; zero returns immediately."}, max_width: {type: "integer", minimum: 1, maximum: 4096, description: "Optional maximum JPEG width in pixels, preserving aspect ratio and never enlarging."}, max_bytes: {type: "integer", minimum: 4096, maximum: 5000000, description: "Optional maximum encoded JPEG bytes. Downscales further at quality 70 when needed; base64 adds about one third plus protocol overhead. Use 42000 for a two-second 30 KB/s viewer budget."}, changed_only: {type: "boolean", default: true, description: "Return JPEG only when its thumbnail differs enough from the last delivered frame."}, min_change: {type: "number", minimum: 0, maximum: 1, default: 0.02, description: "Minimum mean absolute grayscale thumbnail difference, normalized from zero to one."}}, additionalProperties: false}, outputSchema: frameSchema},
  {name: "camera_stream_stop", description: "Close this printer's camera connection and free its cached frames. Other printers keep their own streams. Active viewers may restart it; normally let the idle timeout close a shared stream.",
    inputSchema: {type: "object" as const, properties: routing, additionalProperties: false}, outputSchema: {type: "object" as const, properties: {status: {type: "string", const: "stopped"}}, required: ["status"]}},
];

export function cameraNumber(value: unknown, fallback: number, min: number, max: number, name: string, integer = false): number {
  const n = value === undefined ? fallback : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isSafeInteger(n))) throw new Error(`${name} must be ${integer ? "an integer" : "a number"} from ${min} to ${max}`);
  return n;
}
