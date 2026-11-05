import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Finished slices kept for reuse: slicing the same model the same way again (Print Again, or Print after a
 * client's estimate) restores the slicer's outputs instead of running it. A slicer run is identified by exactly
 * what it was given: the slicer executable (its path, size and modification time, so an update slices again),
 * this server's version, and its full argument list, with every input file replaced by its content hash and every
 * output location by a placeholder. Profiles, filament files, the model and generated override files are all
 * arguments, so editing any of them slices again. A run whose arguments name any other directory (its contents
 * can't be hashed) is never cached, nor is a failed slice. Presets the slicer finds by itself, not named in its
 * arguments (its own bundled system presets), count through the executable: a slicer update slices again.
 *
 * SLICE_CACHE=off turns it off; SLICE_CACHE_DIR moves it (default ~/.cache/<package name>/slices). The newest
 * SLICE_CACHE_ENTRIES (default 16) slices are kept.
 */
export interface SlicerRun {
  command: string;
  args: string[];
  /** What the slicer writes, kept and restored: files, or directories it fills. */
  outputs: string[];
  /** Folders it writes into that aren't kept as a whole (an --outputdir shared with other files). */
  locations?: string[];
}

const KEY_VERSION = 1;
/** This server's package name and version: a new release slices again. */
const PACKAGE = (() => {
  try {
    const value = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { name?: unknown; version?: unknown };
    return { name: String(value.name ?? "printer-mcp"), version: String(value.version ?? "") };
  } catch {
    return { name: "printer-mcp", version: "" };
  }
})();

function enabled(): boolean {
  return !/^(?:off|0|false|no)$/i.test(process.env.SLICE_CACHE ?? "");
}

export function sliceCacheRoot(): string {
  return process.env.SLICE_CACHE_DIR || path.join(os.homedir(), ".cache", PACKAGE.name, "slices");
}

function entriesKept(): number {
  const value = Number(process.env.SLICE_CACHE_ENTRIES);
  return Number.isInteger(value) && value > 0 ? value : 16;
}

async function fileHash(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function onPath(command: string): string | undefined {
  if (path.isAbsolute(command) || command.includes("/") || command.includes("\\")) return path.resolve(command);
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* next */ }
  }
  return undefined;
}

/** The run's cache key, or undefined when it can't be identified exactly (then it is never cached). */
export async function sliceCacheKey(run: SlicerRun): Promise<string | undefined> {
  if (!enabled()) return undefined;
  // Never a reason for a slice to fail: anything unreadable means this run isn't kept.
  try { return await keyOf(run); } catch { return undefined; }
}

async function keyOf(run: SlicerRun): Promise<string | undefined> {
  const executable = onPath(run.command);
  if (!executable) return undefined;
  let binary: fs.Stats;
  try { binary = await fs.promises.stat(executable); } catch { return undefined; }
  const outputs = run.outputs.map(output => path.resolve(output));
  const places = [...outputs, ...(run.locations ?? []).map(location => path.resolve(location))];
  const part = async (value: string): Promise<string | undefined> => {
    if (!value || value.startsWith("-")) return value;
    // A relative path is a file to the slicer too (resolved against this process's directory, as it is).
    const resolved = path.resolve(value);
    // An output or output folder itself: where this run writes, whatever it is called.
    const exact = places.indexOf(resolved);
    if (exact >= 0) return `<output ${exact}>`;
    // A file staged inside an output folder (a generated profile, a transformed mesh) is an input: its bytes count.
    const root = places.findIndex(place => resolved.startsWith(place + path.sep));
    let info: fs.Stats | undefined;
    try { info = await fs.promises.stat(resolved); } catch { info = undefined; }
    const named = root >= 0 ? `<output ${root}>${resolved.slice(places[root].length)}` : path.isAbsolute(value) ? resolved : value;
    // A file is its bytes (and its extension, which tells the slicer what it is), not its often random name.
    if (info?.isFile()) return `file${path.extname(resolved).toLowerCase()}#${await fileHash(resolved)}`;
    // A folder's contents can't be hashed: such a run is never cached.
    if (info?.isDirectory()) return undefined;
    return named;
  };
  const args: string[] = [];
  for (const arg of run.args) {
    const parts: string[] = [];
    for (const piece of arg.split(";")) {
      const value = await part(piece);
      if (value === undefined) return undefined;
      parts.push(value);
    }
    args.push(parts.join(";"));
  }
  return createHash("sha256").update(JSON.stringify({ v: KEY_VERSION, server: PACKAGE,
    slicer: { path: fs.realpathSync(executable), size: binary.size, mtimeMs: binary.mtimeMs }, args })).digest("hex");
}

async function touch(target: string, at: Date): Promise<void> {
  const info = await fs.promises.stat(target);
  if (info.isDirectory()) for (const name of await fs.promises.readdir(target)) await touch(path.join(target, name), at);
  await fs.promises.utimes(target, at, at);
}

/** Puts a kept slice's outputs where this run would write them; false when there is none. */
export async function restoreSlice(key: string, run: SlicerRun): Promise<boolean> {
  const entry = path.join(sliceCacheRoot(), key);
  try {
    const meta = JSON.parse(await fs.promises.readFile(path.join(entry, "meta.json"), "utf8")) as { outputs?: unknown; saved?: unknown };
    if (meta.outputs !== run.outputs.length || !Array.isArray(meta.saved)) return false;
    const saved = new Set(meta.saved.filter((index): index is number => typeof index === "number"));
    // Every output the slicer wrote must still be there, or this is no slice at all.
    for (const index of saved) if (!fs.existsSync(path.join(entry, String(index)))) return false;
    const now = new Date();
    for (const [index, output] of run.outputs.entries()) {
      if (!saved.has(index)) continue; // the slicer didn't write this one
      await fs.promises.mkdir(path.dirname(output), { recursive: true });
      await fs.promises.cp(path.join(entry, String(index)), output, { recursive: true, force: true });
      // Fresh timestamps on every restored file: a result.json must read as written by this run.
      await touch(output, now);
    }
    await fs.promises.utimes(entry, now, now);
    return true;
  } catch {
    return false;
  }
}

/** Keeps a finished slice's outputs, whole or not at all; a failure to keep it never fails the slice. */
export async function keepSlice(key: string, run: SlicerRun): Promise<void> {
  const root = sliceCacheRoot();
  try {
    await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
    const staging = await fs.promises.mkdtemp(path.join(root, ".staging-"));
    try {
      const saved: number[] = [];
      for (const [index, output] of run.outputs.entries()) {
        if (!fs.existsSync(output)) continue;
        await fs.promises.cp(output, path.join(staging, String(index)), { recursive: true });
        saved.push(index);
      }
      await fs.promises.writeFile(path.join(staging, "meta.json"), JSON.stringify({ outputs: run.outputs.length, saved, keptAt: new Date().toISOString() }));
      await fs.promises.rm(path.join(root, key), { recursive: true, force: true });
      await fs.promises.rename(staging, path.join(root, key));
    } finally {
      await fs.promises.rm(staging, { recursive: true, force: true });
    }
    const entries = await Promise.all((await fs.promises.readdir(root)).filter(name => /^[0-9a-f]{64}$/.test(name))
      .map(async name => ({ name, at: (await fs.promises.stat(path.join(root, name))).mtimeMs })));
    for (const old of entries.sort((a, b) => b.at - a.at).slice(entriesKept())) {
      await fs.promises.rm(path.join(root, old.name), { recursive: true, force: true });
    }
  } catch (error) {
    console.error(`Could not keep this slice for reuse: ${error instanceof Error ? error.message : String(error)}`);
  }
}
