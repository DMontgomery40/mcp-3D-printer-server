/** Reuse a stream, but never relabel a known pre-boundary cached image as a later layer. */
interface StreamFrame {
  status: string;
  seq: number;
  capturedAt?: string;
  base64?: string;
}
interface FrameSource {
  frame(options: {
    sinceSeq?: number;
    waitMs?: number;
    changedOnly?: boolean;
  }): Promise<StreamFrame>;
}
export async function snapshotFrame(
  source: FrameSource,
  timeoutMs: number,
  capturedAfter?: string,
): Promise<StreamFrame> {
  const waitMs = Math.min(timeoutMs, 10000),
    deadline = Date.now() + waitMs;
  if (capturedAfter === undefined)
    return source.frame({ waitMs, changedOnly: false });
  const boundary = Date.parse(capturedAfter);
  if (!Number.isFinite(boundary))
    throw Error("Invalid camera acquisition boundary.");
  const current = await source.frame({ waitMs: 0, changedOnly: false });
  const matches = (frame: StreamFrame) =>
    frame.status === "frame" &&
    !!frame.base64 &&
    frame.capturedAt !== undefined &&
    Number.isFinite(Date.parse(frame.capturedAt)) &&
    Date.parse(frame.capturedAt) >= boundary;
  if (matches(current)) return current;
  if (current.status !== "frame" && current.status !== "unchanged")
    return current;
  const fresh = await source.frame({
    sinceSeq: current.seq,
    waitMs: Math.max(0, deadline - Date.now()),
    changedOnly: false,
  });
  return fresh.seq > current.seq && matches(fresh)
    ? fresh
    : { status: "unavailable", seq: fresh.seq };
}
