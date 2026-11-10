import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

// Budget estimates for the shipped pins, including managed Python and retained uv cache.
export const CAD_SIZE_ESTIMATE = {
  expected_download_bytes: 350 * 1024 ** 2,
  expected_installed_bytes: 1536 * 1024 ** 2,
};
export interface CadStorage {
  expected_download_bytes: number;
  expected_installed_bytes: number;
  installed_bytes: number | null;
  measurement: "allocated-last-setup";
  measured_at?: string;
}
export function storageInfo(
  marker: { installed_bytes?: unknown; measured_at?: unknown } | undefined,
  exists: boolean,
): CadStorage {
  return {
    ...CAD_SIZE_ESTIMATE,
    installed_bytes:
      typeof marker?.installed_bytes === "number" &&
      Number.isFinite(marker.installed_bytes) &&
      marker.installed_bytes >= 0
        ? marker.installed_bytes
        : exists
          ? null
          : 0,
    measurement: "allocated-last-setup",
    ...(typeof marker?.measured_at === "string"
      ? { measured_at: marker.measured_at }
      : {}),
  };
}
/** Allocated filesystem bytes, like du; no symlink traversal or double-counted hardlinks. */
export async function measureEnvironment(data: string): Promise<number> {
  const seen = new Set<string>();
  let bytes = 0;
  async function walk(file: string): Promise<void> {
    const stat = await fs.lstat(file).catch((e) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    if (!stat) return;
    const key = `${stat.dev}:${stat.ino}`;
    if (seen.has(key)) return;
    seen.add(key);
    bytes += stat.blocks * 512;
    if (stat.isDirectory())
      for (const name of await fs.readdir(file))
        await walk(path.join(file, name));
  }
  for (const name of ["runtime", "python", "cache"])
    await walk(path.join(data, name));
  return bytes;
}
async function digest(
  file: string,
  signal?: AbortSignal,
): Promise<{ hash: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  signal?.throwIfAborted();
  const stream = createReadStream(file);
  const abort = () => {
    const error = new Error("CAD input snapshot cancelled.");
    error.name = "AbortError";
    stream.destroy(error);
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      bytes += chunk.length;
      if (bytes > 64 * 1024 ** 2) throw new Error("CAD input exceeds 64 MiB.");
      hash.update(chunk);
    }
    return { hash: hash.digest("hex"), bytes };
  } finally {
    signal?.removeEventListener("abort", abort);
    stream.destroy();
  }
}
/** Each immutable bundle contains exactly the declared files, retaining linked asset basenames. */
export async function snapshotInputs(
  root: string,
  files: Record<string, string>,
  signal?: AbortSignal,
  index?: {
    directory: string;
    authorize: (directory: string) => Promise<string>;
  },
) {
  const entries: {
    alias: string;
    file: string;
    name: string;
    hash: string;
    bytes: number;
  }[] = [];
  let bytes = 0;
  const names = new Set<string>();
  for (const [alias, file] of Object.entries(files)) {
    const name = path.basename(file);
    if (names.has(name.toLowerCase()))
      throw new Error(
        "CAD input files must have distinct original filenames so linked mesh/texture assets remain unambiguous.",
      );
    names.add(name.toLowerCase());
    const content = await digest(file, signal);
    bytes += content.bytes;
    if (bytes > 256 * 1024 ** 2)
      throw new Error("CAD inputs exceed their 256 MiB total limit.");
    entries.push({ alias, file, name, ...content });
  }
  const inputs: Record<string, string> = {},
    hashes: Record<string, string> = {};
  if (!entries.length)
    return { inputs, hashes, directory: null, added: 0, reused: 0 };
  const identity = entries
    .map(({ name, hash, bytes }) => ({ name, hash, bytes }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const id = createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex");
  const cache = path.join(root, ".cad-inputs"),
    directory = path.join(cache, id);
  async function verify(directory: string): Promise<void> {
    if (!(await fs.lstat(directory)).isDirectory())
      throw new Error("CAD input bundle must be a directory, not a link.");
    const found = await fs.readdir(directory);
    if (
      found.length !== entries.length ||
      found.some((n) => !entries.some((e) => e.name === n))
    )
      throw new Error("CAD input bundle contains undeclared files.");
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (!(await fs.lstat(file)).isFile())
        throw new Error("CAD cached input is not a regular file.");
      const actual = await digest(file, signal);
      if (actual.hash !== entry.hash || actual.bytes !== entry.bytes)
        throw new Error("CAD input cache failed its content hash check.");
    }
  }
  const candidates = new Set(
    Object.values(files).map((file) => path.dirname(file)),
  );
  if (index) {
    try {
      const known = JSON.parse(
        await fs.readFile(path.join(index.directory, id + ".json"), "utf8"),
      );
      if (typeof known.directory === "string") candidates.add(known.directory);
    } catch {
      /* An absent/stale index is rebuilt from declared content. */
    }
  }
  for (const candidate of candidates) {
    if (
      path.basename(candidate) !== id ||
      path.basename(path.dirname(candidate)) !== ".cad-inputs"
    )
      continue;
    try {
      if (index) await index.authorize(candidate);
      await verify(candidate);
      for (const entry of entries) {
        inputs[entry.alias] = path.join(candidate, entry.name);
        hashes[entry.alias] = entry.hash;
      }
      return { inputs, hashes, directory: candidate, added: 0, reused: bytes };
    } catch {
      /* Do not expose a stale, out-of-policy or incomplete bundle. */
    }
  }
  await fs.mkdir(cache, { recursive: true, mode: 0o700 });
  if ((await fs.lstat(cache)).isSymbolicLink())
    throw new Error("CAD input cache must not be a symlink.");
  let added = 0;
  try {
    await verify(directory);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    const stage = await fs.mkdtemp(path.join(cache, ".stage-"));
    try {
      for (const entry of entries) {
        const file = path.join(stage, entry.name);
        await fs.copyFile(entry.file, file);
        const copied = await digest(file, signal);
        if (copied.hash !== entry.hash || copied.bytes !== entry.bytes)
          throw new Error(
            "CAD input changed while snapshotting; no run was dispatched.",
          );
        await fs.chmod(file, 0o444);
      }
      try {
        await fs.rename(stage, directory);
        added = bytes;
      } catch (e) {
        if (
          !["EEXIST", "ENOTEMPTY"].includes((e as NodeJS.ErrnoException).code!)
        )
          throw e;
        await verify(directory);
      }
    } finally {
      await fs.rm(stage, { recursive: true, force: true });
    }
  }
  if (index) {
    await fs.mkdir(index.directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(index.directory, ".new-" + randomUUID());
    try {
      await fs.writeFile(temporary, JSON.stringify({ directory }), {
        flag: "wx",
        mode: 0o600,
      });
      await fs.rename(temporary, path.join(index.directory, id + ".json"));
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
  }
  for (const entry of entries) {
    inputs[entry.alias] = path.join(directory, entry.name);
    hashes[entry.alias] = entry.hash;
  }
  return { inputs, hashes, directory, added, reused: bytes - added };
}
