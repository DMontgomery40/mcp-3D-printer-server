# Camera stream tools (planned)

Status: **planned, not released.** This is the agreed contract for Counterpart's printer camera
(Counterpart PRD §8.6.1). `camera_snapshot` is unchanged until these ship.

Goal: one camera connection per printer, only while someone is watching; frames held in memory;
callers get a frame only when the picture changed. Nothing is open when nobody is looking.

## Tools

All three take the usual optional printer overrides (`host`, and for Bambu `bambu_serial`,
`bambu_token`). A stream is keyed per printer (serial, else host), so one server process can stream
several printers without mixing them up.

### `camera_stream_start`
`{fps?: number = 1 (0.2–2), idle_timeout_ms?: number = 30000 (5000–120000)}` plus overrides
(Bambu also `bambu_model`).
Returns `{status: "started" | "running", transport, fps, startedAt}`. Idempotent per printer.

### `camera_frame`
`{since_seq?: number = 0, wait_ms?: number = 0 (≤ 10000), max_width?: number,
  changed_only?: boolean = true, min_change?: number = 0.02}` plus overrides.
Returns `{status: "frame" | "unchanged" | "stopped" | "unavailable", seq, capturedAt, width, height,
format: "image/jpeg", base64?, change, reason?}`.

- Long poll: returns as soon as a frame newer than `since_seq` exists and, with `changed_only`,
  differs from the frame at `since_seq` by `change ≥ min_change`; otherwise after `wait_ms` with
  `unchanged` and no image.
- `change` is the mean absolute difference of 32×18 grayscale thumbnails, 0–1.
- `max_width` downscales (JPEG q≈70).
- Returns `stopped` at once after `camera_stream_stop` or the idle close, so a caller's loop ends.
- `unavailable` carries `reason: "no-camera" | "auth" | "unreachable"` (one reconnect is tried first).
- Every call renews the idle timer.

### `camera_stream_stop`
`{}` plus overrides → `{status: "stopped"}`. Closes the connection immediately.

## Behaviour

- `camera_snapshot` serves the in-memory frame when a stream is running (no new connection).
- The printer info tool reports `camera.stream: true` once these ship.
- Budget: under 5% CPU for the server while streaming one printer at 2 fps; zero connections when idle.

## Sources

- OctoPrint: the MJPEG `webcam.stream` URL, read as one connection while streaming.
- Klipper/Moonraker: the webcam `stream_url` (MJPEG), else polling `snapshot_url` at `fps`.
- PrusaLink, Duet, Repetier, Creality: the printer's snapshot URL polled at `fps` while streaming.

Parity: bambu-printer-mcp exposes the same three tools with the same results.
