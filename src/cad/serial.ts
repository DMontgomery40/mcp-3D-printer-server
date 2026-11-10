import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { CadRefusal } from "./refusal.js";

function dead(pid: unknown): boolean {
  if (!Number.isInteger(pid) || Number(pid) < 1) return false;
  try {
    process.kill(Number(pid), 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
}
/** One dispatched operation per environment; runs queue across processes and never replay. */
export async function withCadLock<T>(
  data: string,
  options: {
    operation: "setup" | "run" | "fit";
    deadline?: number;
    signal?: AbortSignal;
  },
  work: (waitedMs: number) => Promise<T>,
): Promise<T> {
  await fs.mkdir(data, { recursive: true, mode: 0o700 });
  const lock = path.join(data, "operation.lock"),
    queue = path.join(data, "queue");
  const start = performance.now();
  let ticket: string | undefined, temporary: string | undefined;
  const queued = options.operation === "run";
  if (queued) {
    await fs.mkdir(queue, { recursive: true, mode: 0o700 });
    const name = `${String(Date.now()).padStart(13, "0")}-${process.hrtime.bigint().toString().padStart(20, "0")}-${randomUUID()}.json`;
    ticket = path.join(queue, name);
    temporary = path.join(queue, `.new-${randomUUID()}`);
    await fs.writeFile(temporary, JSON.stringify({ pid: process.pid }), {
      flag: "wx",
      mode: 0o600,
    });
    await fs.rename(temporary, ticket);
  }
  try {
    for (;;) {
      options.signal?.throwIfAborted();
      if (queued && performance.now() >= options.deadline!)
        throw new CadRefusal(
          "cad-queue-timeout",
          "The CAD run's timeout expired while waiting for another operation. This run was not dispatched.",
        );
      const names = (
        await fs.readdir(queue).catch((e) => {
          if (e.code === "ENOENT") return [] as string[];
          throw e;
        })
      )
        .filter((n) => /^\d+-\d+-[a-f0-9-]+\.json$/.test(n))
        .sort();
      const live: string[] = [];
      for (const name of names) {
        const file = path.join(queue, name);
        try {
          const previous = JSON.parse(await fs.readFile(file, "utf8"));
          if (dead(previous.pid)) {
            await fs.unlink(file).catch(() => {});
            continue;
          }
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
        }
        live.push(name);
      }
      const turn = queued
        ? live[0] === path.basename(ticket!)
        : live.length === 0;
      let handle;
      if (turn) {
        try {
          handle = await fs.open(lock, "wx", 0o600);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
          try {
            const previous = JSON.parse(await fs.readFile(lock, "utf8"));
            if (dead(previous.pid)) {
              await fs.unlink(lock).catch(() => {});
              continue;
            }
          } catch {
            /* A partially written live lock stays locked. */
          }
        }
      }
      if (handle) {
        try {
          await handle.writeFile(
            JSON.stringify({ pid: process.pid, operation: options.operation }),
          );
          if (ticket) {
            await fs.unlink(ticket);
            ticket = undefined;
          }
          return await work(Math.round(performance.now() - start));
        } finally {
          await handle.close();
          await fs.unlink(lock).catch(() => {});
        }
      }
      if (!queued)
        throw new CadRefusal(
          options.operation === "setup"
            ? "cad-setup-busy"
            : "cad-operation-busy",
          "Another CAD operation is already running or queued. Wait for it to finish; this request was not dispatched.",
        );
      await delay(
        Math.min(50, Math.max(1, options.deadline! - performance.now())),
        undefined,
        { signal: options.signal },
      );
    }
  } finally {
    if (ticket) await fs.unlink(ticket).catch(() => {});
    if (temporary) await fs.unlink(temporary).catch(() => {});
  }
}
