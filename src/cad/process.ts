import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export interface CadProcessOptions {
  env: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}
export interface CadSystem {
  platform: NodeJS.Platform;
  run(
    file: string,
    args: string[],
    options: CadProcessOptions,
  ): Promise<{ stdout: string; stderr?: string }>;
}

/** No shell, no inherited printer/provider environment, bounded output, and kill the entire dispatched group. */
export function runCadProcess(
  file: string,
  args: string[],
  options: CadProcessOptions,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    options.signal?.throwIfAborted();
    const child = spawn(file, args, {
      env: options.env,
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "",
      stderr = "",
      failure: Error | undefined;
    const kill = () => {
      try {
        if (child.pid)
          process.kill(
            process.platform === "win32" ? child.pid : -child.pid,
            "SIGKILL",
          );
      } catch {
        /* already exited */
      }
    };
    const stop = (error: Error) => {
      failure ??= error;
      kill();
    };
    const timer = setTimeout(
      () =>
        stop(
          new Error(
            `CAD process timed out after ${options.timeoutMs} ms; execution was stopped, not replayed.`,
          ),
        ),
      options.timeoutMs,
    );
    const abort = () =>
      stop(
        new Error(
          "CAD operation cancelled; execution was stopped, not replayed.",
        ),
      );
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (b) => {
      stdout += b.toString();
      if (Buffer.byteLength(stdout) > 2 * 1024 * 1024)
        stop(new Error("CAD process exceeded its output limit."));
    });
    child.stderr.on("data", (b) => {
      stderr += b.toString();
      if (Buffer.byteLength(stderr) > 2 * 1024 * 1024)
        stop(new Error("CAD diagnostics exceeded their output limit."));
    });
    child.once("error", (e) => {
      failure = e;
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      kill();
      if (failure) reject(failure);
      else if (code !== 0)
        reject(
          new Error(
            `CAD process failed (${code}): ${(stderr || stdout).slice(-6000)}`,
          ),
        );
      else resolve({ stdout, stderr });
    });
  });
}
export const defaultCadSystem: CadSystem = {
  platform: process.platform,
  run: runCadProcess,
};
export interface CadSandboxRoots {
  data: string;
  job: string;
  assets: string;
  python: string;
  readonly: string[];
  inputs?: string[];
}
const sb = (s: string) => JSON.stringify(s);

/** Linux uses an empty mount tree and fresh user/PID/network namespaces. A missing/blocked bwrap is fatal. */
export async function cadSandbox(
  platform: NodeJS.Platform,
  r: CadSandboxRoots,
): Promise<{ command: string; args: string[] }> {
  if (platform === "darwin") {
    // Runtime system files remain readable, but personal data, IPC, network and process spawning do not.
    const variants = (p: string) => [
      p,
      ...(/^\/(?:Users|private|Volumes)(?:\/|$)/.test(p)
        ? ["/System/Volumes/Data" + p]
        : []),
    ];
    const systemReads = [
      "/System/Library",
      "/System/Cryptexes",
      "/System/Volumes/Preboot",
      "/private/preboot",
      "/Library/Fonts",
      "/usr/lib",
      "/usr/share",
      "/usr/bin",
      "/bin",
      "/sbin",
      "/dev",
      "/private/etc/localtime",
      "/etc/localtime",
    ];
    const readable = [
      ...systemReads,
      path.join(r.data, "runtime"),
      path.join(r.data, "python"),
      r.assets,
      r.job,
      ...(r.inputs ?? []),
    ].flatMap(variants);
    const profile = `(version 1)(allow default)
(deny process-info*)(allow process-info* (target self))
(deny sysctl-read)
(allow sysctl-read (sysctl-name-prefix "hw.") (sysctl-name-prefix "machdep.cpu.")
 (sysctl-name-prefix "kern.os") (sysctl-name "kern.ostype") (sysctl-name "kern.hostname") (sysctl-name "kern.domainname")
 (sysctl-name "kern.version") (sysctl-name "kern.maxfiles") (sysctl-name "kern.maxfilesperproc"))
(deny file-link)(deny network*)(deny appleevent-send)(deny mach-lookup)(deny signal)(deny process-fork)
(deny process-exec)(allow process-exec (literal ${sb(await fs.realpath(r.python).catch(() => r.python))}))
(deny file-read*)
(allow file-read-metadata)(deny file-write*)
(allow file-read* (literal "/") (literal "/System") (literal "/System/Volumes") (literal "/System/Volumes/Data") (literal "/private"))
(allow file-read* ${readable.map((p) => `(subpath ${sb(p)})`).join(" ")})
(allow file-write* ${variants(r.job)
      .map((p) => `(subpath ${sb(p)})`)
      .join(" ")} (literal "/dev/null"))
${r.readonly
  .flatMap(variants)
  .map((p) => `(deny file-write* (subpath ${sb(p)}))`)
  .join("\n")}`;
    return { command: "/usr/bin/sandbox-exec", args: ["-p", profile] };
  }
  if (platform === "linux") {
    const args = [
      "--unshare-all",
      "--die-with-parent",
      "--new-session",
      "--cap-drop",
      "ALL",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
    ];
    for (const dir of ["/usr", "/bin", "/lib", "/lib64", "/sbin"])
      if (
        await fs.stat(dir).then(
          () => true,
          () => false,
        )
      )
        args.push("--ro-bind", dir, dir);
    for (const file of ["/etc/ld.so.cache", "/etc/localtime", "/etc/fonts"]) {
      if (
        await fs.stat(file).then(
          () => true,
          () => false,
        )
      )
        args.push("--ro-bind", file, file);
    }
    for (const dir of [
      path.join(r.data, "runtime"),
      path.join(r.data, "python"),
      r.assets,
      ...(r.inputs ?? []),
    ])
      args.push("--ro-bind", dir, dir);
    args.push("--bind", r.job, r.job);
    for (const file of r.readonly.filter(
      (file) => !(r.inputs ?? []).includes(file),
    ))
      args.push("--ro-bind", file, file);
    args.push("--chdir", r.job);
    return { command: "bwrap", args };
  }
  throw new Error(
    `CAD confinement is unavailable on ${platform}; no unconfined execution is permitted.`,
  );
}
