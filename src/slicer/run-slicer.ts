import { spawn } from "node:child_process";
import { SlicerError, tailText } from "./slicer-error.js";

/** Bytes of each stream kept for diagnostics; verbose slicers are never truncated into a failure. */
const OUTPUT_TAIL_BYTES = 64 * 1024;

export interface SlicerRunOptions {
  command: string;
  args: string[];
  timeoutMs: number;
  slicerType: string;
  /** Polled while the slicer runs; returning true kills it. */
  isCancelled?: () => boolean;
}

export interface SlicerRunResult {
  stdoutTail: string;
  stderrTail: string;
}

class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > OUTPUT_TAIL_BYTES && this.chunks.length > 1) {
      this.size -= this.chunks.shift()!.length;
    }
  }

  text(): string {
    const all = Buffer.concat(this.chunks);
    return all.subarray(Math.max(0, all.length - OUTPUT_TAIL_BYTES)).toString("utf8");
  }
}

function describeOutput(stdoutTail: string, stderrTail: string): string {
  const stdout = tailText(stdoutTail);
  const stderr = tailText(stderrTail);
  return [
    stdout ? `Slicer stdout (tail):\n${stdout}` : "Slicer stdout: (empty)",
    stderr ? `Slicer stderr (tail):\n${stderr}` : "Slicer stderr: (empty)",
  ].join("\n");
}

/**
 * Run a slicer executable with a timeout and cancellation, keeping bounded
 * stdout/stderr tails. A nonzero exit, signal, spawn failure, timeout, or
 * cancellation rejects with a SlicerError that includes the evidence.
 */
export function runSlicerProcess(options: SlicerRunOptions): Promise<SlicerRunResult> {
  const { command, args, timeoutMs, slicerType, isCancelled } = options;
  return new Promise((resolve, reject) => {
    const stdout = new TailBuffer();
    const stderr = new TailBuffer();
    let settled = false;
    let timedOut = false;
    let cancelled = false;

    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

    const cleanup = () => {
      clearTimeout(timeoutHandle);
      clearInterval(cancelHandle);
    };
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* reported through close/error */ }
    }, timeoutMs);
    const cancelHandle = setInterval(() => {
      if (isCancelled?.()) {
        cancelled = true;
        try { child.kill("SIGKILL"); } catch { /* reported through close/error */ }
      }
    }, 500);

    child.on("error", (error) => {
      settle(() => reject(new SlicerError(
        "execution",
        `Could not start slicer "${command}": ${error.message}. Check SLICER_PATH/slicer_path.`,
        { slicerType, slicerPath: command, stdoutTail: stdout.text(), stderrTail: stderr.text() }
      )));
    });

    child.on("close", (code, signal) => {
      const stdoutTail = stdout.text();
      const stderrTail = stderr.text();
      if (!timedOut && !cancelled && code === 0 && !signal) {
        settle(() => resolve({ stdoutTail, stderrTail }));
        return;
      }
      const reason = timedOut
        ? `Slicer exceeded timeout ${timeoutMs}ms and was killed`
        : cancelled
          ? "Slicing operation cancelled"
          : signal
            ? `Slicer was terminated by signal ${signal}`
            : `Slicer exited with code ${code}`;
      settle(() => reject(new SlicerError(
        "execution",
        `${reason} (${slicerType}: ${command}).\n${describeOutput(stdoutTail, stderrTail)}`,
        {
          slicerType,
          slicerPath: command,
          exitCode: code,
          signal: signal ?? null,
          timedOut,
          cancelled,
          stdoutTail: tailText(stdoutTail),
          stderrTail: tailText(stderrTail),
        }
      )));
    });
  });
}
