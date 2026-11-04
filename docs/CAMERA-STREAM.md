# Camera stream tools

Contract version: **mcp-3d-printer-server 1.2.26 and newer.** The three tools follow
Counterpart PRD §8.6.1. Older published versions expose only `camera_snapshot`; discover tools before use.

Goal: one camera connection per printer, only while someone is watching; frames held in memory;
callers get a frame only when the picture changed. Nothing is open when nobody is looking.

## Tools

All three take the usual optional printer overrides (`host`, and for Bambu `bambu_serial`,
`bambu_token`). A stream is keyed per printer (backend, requested host, API port, and Bambu serial together), so one server process can stream
several printers without mixing them up.

### `camera_stream_start`
`{fps?: number = 1 (0.2–2), idle_timeout_ms?: number = 30000 (5000–120000)}` plus overrides

Returns `{status: "started" | "running", transport, fps, startedAt}`. Idempotent per printer.
When optional native processing is unavailable, returns `{status: "not-supported", reason: "runtime"}`; callers may use existing snapshots. Authentication and network failures are not unsupported-runtime results.

### `camera_frame`
`{since_seq?: number = 0, wait_ms?: number = 0 (≤ 10000), max_width?: number,
  max_bytes?: integer (4096–5000000), changed_only?: boolean = true, min_change?: number = 0.02}` plus overrides.
Returns `{status: "frame" | "unchanged" | "stopped" | "unavailable", seq, capturedAt, width, height,
format: "image/jpeg", base64?, change, reason?}`.

- Long poll: returns as soon as a frame newer than `since_seq` exists and, with `changed_only`,
  differs from the frame at `since_seq` by `change ≥ min_change`; otherwise after `wait_ms` with
  `unchanged` and no image.
- `change` is the mean absolute difference of 32×18 grayscale thumbnails, 0–1.
- `max_width` downscales (JPEG q≈70). `max_bytes` caps the encoded JPEG, with at most four native encodes and a bounded cache. Use 42000 bytes for a full-screen frame every two seconds, or 20000 bytes for a card every ten seconds, leaving room for base64 and protocol overhead. The JPEG occurs only in `structuredContent`; text content carries metadata.
- Returns `stopped` at once after `camera_stream_stop` or the idle close, so a caller's loop ends.
- `unavailable` carries `reason: "no-camera" | "auth" | "unreachable"` (one reconnect is tried first).
- Every call renews the idle timer.

### `camera_stream_stop`
`{}` plus overrides → `{status: "stopped"}`. Closes the connection immediately.

## Behaviour

- `camera_snapshot` serves the in-memory frame when a stream is running (no new connection).
- The printer info tool reports `capabilities.cameraStream: true` when a camera source and the native processor are available. Missing optional dependencies, Node versions below 20.9, or unsupported CPUs make this false; existing snapshots and other tools still work. Patched Sharp 0.35.5 requires Node 20.9+; Node 18 keeps core tools and snapshots without stream processing. Core server requirements remain unchanged.
- Budget: under 2% CPU for the server while streaming one printer at 2 fps; zero connections when idle.

## Sources

- OctoPrint: Classic Webcam `plugins.classicwebcam.stream` or `webcam.streamUrl`, read as one MJPEG response; the same camera’s snapshot is used when its stream format is unsupported.
- Klipper/Moonraker: the webcam `stream_url` (MJPEG), else polling that webcam’s `snapshot_url` at `fps`. Known WebRTC/HLS services use their snapshot directly.
- Duet and Repetier: their existing discovered snapshot URLs, polled at `fps` while streaming.
- Creality: the existing detected Moonraker path, when available.
- PrusaLink and Bambu: the existing `PRINTER_CAMERA_SNAPSHOT_URL` override; this generic server does not gain the Bambu-native TLS/RTSP transport.
- `PRINTER_CAMERA_SNAPSHOT_URL` remains an override for every backend. There is no new camera URL setting.

Transport is `http`, covering a persistent MJPEG response or snapshot polling. Snapshot polling is serialized, uses HTTP keep-alive, and aborts in-flight requests on stop. MJPEG requires a multipart response; HLS/WebRTC streams are not decoded. An unsupported multipart format or HTTP 404/405/415 switches to that camera’s configured snapshot. Authentication failures never trigger fallback; other failures get at most one reconnect. A different camera is never selected to hide a failed source. Relative URLs and printer-local loopback addresses retain the existing resolution behavior. API keys are sent only to the printer API origin, with redirects disabled when authenticated; unauthenticated requests allow at most three redirects. No image files or helper processes are created. JPEG input is limited to 5 MB and 8 million pixels.

Sources: [OctoPrint settings API](https://docs.octoprint.org/en/main/api/settings.html),
[Moonraker webcam API](https://moonraker.readthedocs.io/en/latest/external_api/webcams/).
Validation uses loopback HTTP/MJPEG fixtures and packaged startup; generic hardware performance is unmeasured.

Parity: bambu-printer-mcp exposes the same three tools with the same results.
