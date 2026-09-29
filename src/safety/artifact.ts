import fs from "node:fs/promises";
import { rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

// Serialise mutations from this server for a printer. Stop/cancel remain available.
const operations = new Map<string, Promise<unknown>>();
const generations = new Map<string, number>();
export function cancelPendingPrinterOperations(_host: string, serial: string): void {
  generations.set(serial, (generations.get(serial) ?? 0) + 1);
}
const retained = new Set<string>();
process.once("exit", () => {
  for (const directory of retained) {
    try { rmSync(directory, { recursive: true, force: true }); } catch { /* OS temp cleanup remains available. */ }
  }
});
export async function withPrinterOperation<T>(_host: string, serial: string, operation: (assertActive: () => void) => Promise<T>): Promise<T> {
  const key = serial;
  const generation = generations.get(key) ?? 0;
  const assertActive = () => {
    if ((generations.get(key) ?? 0) !== generation) throw new Error("Pending printer operation cancelled by stop or heater-off request.");
  };
  const previous = operations.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => { assertActive(); return operation(assertActive); });
  operations.set(key, next);
  try { return await next; }
  finally { if (operations.get(key) === next) operations.delete(key); }
}

/** Inspect and send a private copy, so changes to the user's source cannot change the job. */
export async function withPrintSnapshot<T>(source: string, operation: (snapshot: string, retainForDispatchedUpload: () => void) => Promise<T>): Promise<T> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bambu-print-"));
  const snapshot = path.join(directory, path.basename(source));
  let retainUntilExit = false;
  try {
    await fs.copyFile(source, snapshot);
    await fs.chmod(snapshot, 0o400);
    return await operation(snapshot, () => { retainUntilExit = true; });
  } finally {
    // Native bridge APIs may return before their asynchronous upload completes.
    if (retainUntilExit) retained.add(directory);
    else await fs.rm(directory, { recursive: true, force: true });
  }
}

export function uniquePrintName(filename: string): string {
  return `checked-${randomUUID()}-${path.basename(filename)}`;
}

export function normalizedRemotePath(filename: string): string {
  const normalized = filename.replace(/^\/+/, "");
  if (!normalized || normalized.includes("\\") || normalized.split("/").some(part => !part || part === "." || part === "..") || /[\r\n\0]/.test(normalized)) {
    throw new Error("Printer filename must be a relative path without traversal or control characters.");
  }
  return normalized.includes("/") ? normalized : `cache/${normalized}`;
}
