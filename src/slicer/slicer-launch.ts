import { execFile, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { SlicerStalled } from "../refusal.js";

/**
 * How a Bambu-compatible slicer CLI is launched so that it can't block on per-user AppKit launch state, and how a
 * slicer that blocks anyway is noticed.
 *
 * Bambu Studio's command line opens a hidden GLFW window to draw plate thumbnails for --export-3mf (Bambu Studio
 * 02.08.02.61 src/BambuStudio.cpp:6231-6259; OrcaSlicer and FULU's OrcaSlicer-bambulab inherit that code). The
 * window starts NSApplication, and AppKit's window restoration then reads the person's crash history from
 * ~/Library/Application Support/CrashReporter/<executable>_<hardware UUID>.plist. When that history says the app
 * crashed while restoring windows, AppKit raises its modal "reopen windows?" alert, and the slicer waits on it at 0%
 * CPU forever. Stopping it never answers the alert, so the next slice waits again.
 *
 * The CLI reads nothing else from the home folder: it takes its profiles from its own bundle (resources_dir(),
 * BambuStudio.cpp:8325-8328) or from the files this server passes, its temporary files from TMPDIR
 * (BambuStudio.cpp:1558-1559), and it sets no data directory unless --datadir is given (BambuStudio.cpp:8363-8367).
 * So each slice gets a fresh, empty home of its own through CFFIXED_USER_HOME, under this server's TEMP_DIR, which
 * AppKit honours for that history. Its preferences still come from the person's own (cfprefsd ignores
 * CFFIXED_USER_HOME) and HOME is unchanged, so nothing else the slicer or this server reads moves.
 */

/** Slicer types launched from a local Bambu-compatible CLI binary. */
const BAMBU_CLI_TYPES = new Set(["bambustudio", "orcaslicer", "orcaslicer-bambulab"]);

export interface SlicerLaunch {
  /** The environment for the slicer process (undefined: inherit this server's). */
  env?: NodeJS.ProcessEnv;
  /** Seconds without CPU or output after which the slice is stopped and reported (watchForStall); 0: never. */
  stallSeconds: number;
  /** Removes this launch's home folder. */
  cleanup(): Promise<void>;
}

/**
 * The launch for one slice. On macOS a Bambu-compatible CLI gets its own empty home folder (always: an inherited
 * CFFIXED_USER_HOME is replaced, since a home that held a stalled slice may hold the history that stalled it), and
 * is watched for stalls. A new folder each slice, not one kept in the data folder, so no crash history can build up
 * in it. Elsewhere nothing changes: no AppKit, and a slicer there may run behind a wrapper (AppImage, Flatpak) whose
 * own CPU says nothing about the slicer's.
 */
export async function prepareSlicerLaunch(slicerType: string, tempDir: string, platform: NodeJS.Platform = process.platform): Promise<SlicerLaunch> {
  if (!BAMBU_CLI_TYPES.has(slicerType) || platform !== "darwin") return { stallSeconds: 0, cleanup: async () => {} };
  await fs.promises.mkdir(tempDir, { recursive: true });
  const home = await fs.promises.mkdtemp(path.join(tempDir, "slicer-home-"));
  return {
    env: { ...process.env, CFFIXED_USER_HOME: home },
    stallSeconds: slicerStallSeconds(),
    cleanup: () => fs.promises.rm(home, { recursive: true, force: true }).catch(() => undefined),
  };
}

const DEFAULT_STALL_SECONDS = 20;

/**
 * Seconds a slicer may use no CPU and write nothing before it is treated as waiting on a dialog
 * (SLICER_STALL_SECONDS, 1-3600; 0 turns the check off). A slice is never idle that long: it computes or writes.
 */
export function slicerStallSeconds(raw = process.env.SLICER_STALL_SECONDS): number {
  const text = raw?.trim();
  if (!text) return DEFAULT_STALL_SECONDS;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 && value <= 3600 ? value : DEFAULT_STALL_SECONDS;
}

/** "[[dd-]hh:]mm:ss[.cc]" from ps -o time= (macOS: m:ss.cc; Linux: [dd-]hh:mm:ss), in seconds. */
export function parseCpuTime(text: string): number | undefined {
  const match = /^\s*(?:(\d+)-)?((?:\d+:){0,2}\d+(?:\.\d+)?)\s*$/.exec(text);
  if (!match) return undefined;
  const seconds = match[2].split(":").reduce((total, part) => total * 60 + Number(part), 0);
  return (match[1] ? Number(match[1]) * 86400 : 0) + seconds;
}

/** The process's CPU time so far, in seconds, or undefined when it can't be read (Windows, an exited process). */
async function cpuSeconds(pid: number): Promise<number | undefined> {
  if (process.platform === "win32") return undefined;
  if (process.platform === "linux") {
    try {
      // utime and stime, fields 14 and 15, after the parenthesised command name (which may hold spaces).
      const stat = await fs.promises.readFile(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return (Number(fields[11]) + Number(fields[12])) / 100;
    } catch { return undefined; }
  }
  return new Promise(resolve => {
    execFile("/bin/ps", ["-o", "time=", "-p", String(pid)], { timeout: 5_000 }, (error, stdout) => {
      resolve(error ? undefined : parseCpuTime(stdout));
    });
  });
}

/** CPU seconds under which a poll counts as idle: a slicing CLI uses far more, a blocked one none. */
const IDLE_CPU_SECONDS = 0.05;

/**
 * Calls onStall once when the child has used no CPU and written nothing to stdout or stderr for `seconds`, counted
 * in consecutive polls (so a Mac that sleeps meanwhile doesn't count the sleep). It starts counting only after the
 * child has shown it is running (output or CPU), and does nothing where CPU time can't be read. Returns a stop
 * function; it also stops when the child exits.
 */
export function watchForStall(child: ChildProcess, seconds: number, onStall: () => void): () => void {
  if (!seconds || child.pid === undefined || process.platform === "win32") return () => {};
  const pid = child.pid;
  const pollMs = Math.min(2_000, (seconds * 1000) / 4);
  const pollsNeeded = Math.ceil((seconds * 1000) / pollMs);
  let output = false, started = false, idlePolls = 0, lastCpu: number | undefined, stopped = false, polling = false;
  const sawOutput = () => { output = true; };
  child.stdout?.on("data", sawOutput);
  child.stderr?.on("data", sawOutput);
  const timer = setInterval(async () => {
    if (polling || stopped) return;
    polling = true;
    try {
      const cpu = await cpuSeconds(pid);
      if (stopped || cpu === undefined) return;
      const busy = output || lastCpu === undefined || cpu - lastCpu >= IDLE_CPU_SECONDS;
      if (output || cpu >= IDLE_CPU_SECONDS) started = true;
      output = false;
      lastCpu = cpu;
      idlePolls = busy || !started ? 0 : idlePolls + 1;
      // A slicer that exited meanwhile finished; its exit, not a stall, is reported.
      if (idlePolls >= pollsNeeded && child.exitCode === null && child.signalCode === null) { stop(); onStall(); }
    } finally { polling = false; }
  }, pollMs);
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    child.stdout?.off("data", sawOutput);
    child.stderr?.off("data", sawOutput);
  };
  child.once("exit", stop);
  child.once("error", stop);
  return stop;
}

const SLICER_NAMES: Record<string, string> = { bambustudio: "Bambu Studio", orcaslicer: "OrcaSlicer", "orcaslicer-bambulab": "OrcaSlicer" };

/** The failure for a slicer stopped by watchForStall. */
export function stalledSlicerError(slicerType: string, seconds: number): SlicerStalled {
  const name = SLICER_NAMES[slicerType] ?? "The slicer";
  return new SlicerStalled(
    `${name} stopped slicing: it used no processor time and wrote nothing for ${seconds} seconds, which is what it does ` +
    `while it waits on a window nobody can answer, such as a question it asks after a crash. It was stopped, and nothing ` +
    `was sent to the printer. Open ${name} once, answer any question it shows, quit it, then slice again.`
  );
}
