import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { CadRefusal, cadFailure } from "./cad/refusal.js";
import { withCadLock } from "./cad/serial.js";
import {
  measureEnvironment,
  snapshotInputs,
  storageInfo,
  type CadStorage,
} from "./cad/storage.js";
import { cadSandbox, defaultCadSystem, type CadSystem } from "./cad/process.js";

const ASSETS = fileURLToPath(new URL("../src/cad/", import.meta.url));
const BUILD123D = "0.13.0";
const PACKAGE_NAME = createRequire(import.meta.url)("../package.json")
  .name as string;
export type CadArguments = Record<string, unknown>;
export interface CadOptions {
  dataDir?: string;
  outputRoots: string[];
  system?: CadSystem;
}
export interface CadStatus {
  configured: boolean;
  ready: boolean;
  python: string | null;
  build123d: string;
  platform: string;
  storage: CadStorage;
  error?: string;
  /** Set when this call re-verified a runtime that only the engine's own sources had changed under. */
  reverified?: string;
}
export class CadEngine {
  private readonly system: CadSystem;
  readonly dataDir: string;
  private reverifyFailure?: { fingerprint: string; error: string };
  /** How long a re-check waits for another CAD operation to let go of the engine (Counterpart reads status with 30 s). */
  busyWaitMs = 25_000;
  /** Within this window a freed engine is re-checked here; later this call only waits for the other call's result, so
   * a wait plus a ~17 s re-check cannot overrun the status deadline. */
  busyRetryMs = 5_000;
  constructor(private readonly options: CadOptions) {
    this.system = options.system ?? defaultCadSystem;
    this.dataDir = path.resolve(
      options.dataDir ??
        process.env.CAD_DATA_DIR ??
        path.join(
          process.platform === "darwin"
            ? path.join(os.homedir(), "Library", "Application Support")
            : (process.env.XDG_DATA_HOME ??
                path.join(os.homedir(), ".local", "share")),
          PACKAGE_NAME,
          "cad",
        ),
    );
  }
  async status(): Promise<CadStatus> {
    const python = path.join(this.dataDir, "runtime", "bin", "python");
    const configured = await fs.stat(python).then(
      (s) => s.isFile(),
      () => false,
    );
    let ready = false;
    let sizeMarker:
      { installed_bytes?: unknown; measured_at?: unknown } | undefined;
    try {
      const marker = JSON.parse(
        await fs.readFile(path.join(this.dataDir, "ready.json"), "utf8"),
      );
      sizeMarker = marker.storage;
      ready =
        configured &&
        marker.build123d === BUILD123D &&
        marker.platform === this.system.platform &&
        marker.fingerprint === (await this.fingerprint()) &&
        marker.dataDevice === (await fs.stat(this.dataDir)).dev;
    } catch {
      /* setup not verified */
    }
    return {
      configured,
      ready,
      python: configured ? python : null,
      build123d: BUILD123D,
      platform: this.system.platform,
      storage: storageInfo(
        sizeMarker,
        configured ||
          (
            await Promise.all(
              ["runtime", "python", "cache"].map((name) =>
                fs.stat(path.join(this.dataDir, name)).then(
                  () => true,
                  () => false,
                ),
              ),
            )
          ).some(Boolean),
      ),
      ...(!ready
        ? {
            error:
              "Run cad_setup with install: true to install and verify the confined CAD runtime.",
          }
        : {}),
    };
  }
  async failure(error: unknown, tool: string) {
    const storage = await this.status().then(
      (status) => status.storage,
      () => storageInfo(undefined, true),
    );
    return { ...cadFailure(error, tool), storage };
  }
  private async allowedDirectory(value: unknown): Promise<string> {
    if (typeof value !== "string" || !value)
      throw new Error(
        "output_dir must be an existing allowed output directory.",
      );
    const dir = await fs.realpath(path.resolve(value)).catch(() => {
      throw new Error(
        "output_dir must be an existing allowed output directory.",
      );
    });
    for (const root of this.options.outputRoots) {
      const real = await fs.realpath(path.resolve(root)).catch(() => undefined);
      if (
        real &&
        (dir === real || dir.startsWith(real + path.sep)) &&
        (await fs.stat(dir)).isDirectory()
      )
        return dir;
    }
    throw new Error(
      "output_dir is outside the allowed output directories (TEMP_DIR or trusted CAD_OUTPUT_DIRS).",
    );
  }
  private environment(home: string): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      TMPDIR: path.join(home, "tmp"),
      TMP: path.join(home, "tmp"),
      TEMP: path.join(home, "tmp"),
      LANG: "en_US.UTF-8",
      PYTHONDONTWRITEBYTECODE: "1",
      MPLCONFIGDIR: path.join(home, "tmp", "mpl"),
      OPENBLAS_NUM_THREADS: "1",
      OMP_NUM_THREADS: "1",
      VECLIB_MAXIMUM_THREADS: "1",
      UV_CACHE_DIR: path.join(this.dataDir, "cache"),
      UV_PYTHON_INSTALL_DIR: path.join(this.dataDir, "python"),
      UV_NO_CONFIG: "1",
    };
  }
  private async exclusive<T>(
    work: (waitedMs: number) => Promise<T>,
    operation: "setup" | "run" | "fit" = "fit",
    signal?: AbortSignal,
    deadline?: number,
  ): Promise<T> {
    return withCadLock(this.dataDir, { operation, signal, deadline }, work);
  }
  private async confined(
    mode: string,
    request: string,
    job: string,
    readonly: string[],
    timeoutMs: number,
    signal?: AbortSignal,
    inputDirectories: string[] = [],
  ): Promise<{ stdout: string; stderr?: string }> {
    const python = path.join(this.dataDir, "runtime", "bin", "python");
    const sandbox = await cadSandbox(this.system.platform, {
      data: this.dataDir,
      job,
      assets: ASSETS,
      python,
      readonly,
      inputs: inputDirectories,
    });
    await fs.mkdir(path.join(job, "tmp"), { recursive: true, mode: 0o700 });
    return this.system.run(
      sandbox.command,
      [
        ...sandbox.args,
        python,
        "-I",
        "-B",
        path.join(ASSETS, "worker.py"),
        mode,
        request,
      ],
      {
        env: this.environment(job),
        cwd: job,
        timeoutMs,
        signal,
      },
    );
  }
  async setup(
    args: CadArguments,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    only(args, ["install"]);
    if (args.install !== undefined && typeof args.install !== "boolean")
      throw new Error("install must be a boolean.");
    if (args.install !== true)
      return {
        supported: ["darwin", "linux"].includes(this.system.platform),
        ...(await this.ensureReady(signal)),
      };
    if (!["darwin", "linux"].includes(this.system.platform))
      throw new CadRefusal(
        "cad-confinement-unavailable",
        `CAD confinement is unavailable on ${this.system.platform}.`,
      );
    return this.exclusive(
      async () => {
        signal?.throwIfAborted();
        const env = this.environment(this.dataDir);
        await this.requireSupportedStorage(env, signal);
        await fs.mkdir(env.TMPDIR!, { recursive: true });
        await fs.unlink(path.join(this.dataDir, "ready.json")).catch(() => {});
        const python = path.join(this.dataDir, "runtime", "bin", "python");
        const opts = { env, cwd: this.dataDir, signal, timeoutMs: 600_000 };
        try {
          if (
            !(await fs.stat(python).then(
              (s) => s.isFile(),
              () => false,
            ))
          )
            await this.system.run(
              "uv",
              [
                "venv",
                "--managed-python",
                "--python",
                "3.12",
                "--no-config",
                path.join(this.dataDir, "runtime"),
              ],
              opts,
            );
          await this.system.run(
            "uv",
            [
              "pip",
              "sync",
              "--python",
              python,
              "--only-binary",
              ":all:",
              "--no-config",
              path.join(ASSETS, "requirements.lock"),
            ],
            opts,
          );
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT")
            throw new CadRefusal(
              "cad-uv-missing",
              "uv is not available on the MCP's PATH. Install uv, then run cad_setup again; no model was run.",
            );
          throw e;
        }
        this.reverifyFailure = undefined;
        await this.verify(opts, signal);
        return {
          supported: true,
          ...(await this.status()),
          installed: true,
          message:
            "CAD is ready; confined import, build, STL and STEP round trip passed. No native files were re-signed.",
        };
      },
      "setup",
      signal,
    );
  }
  /**
   * The proof setup ends with: the runtime's imports, then the confined build, STL and STEP round trip, then the ready
   * marker with the engine fingerprint and the runtime identity it proved. Shared by cad_setup and the automatic
   * re-verification after an update that changed only the engine's sources.
   */
  private async verify(
    opts: { env: NodeJS.ProcessEnv; cwd: string; signal?: AbortSignal; timeoutMs: number },
    signal?: AbortSignal,
    measured?: unknown,
  ): Promise<void> {
    // Setup proves the fresh install's imports outside confinement first; a re-check of an unchanged runtime relies on
    // the confined round trip, which imports the same libraries.
    if (measured === undefined) {
      const python = path.join(this.dataDir, "runtime", "bin", "python");
      await this.system.run(
        python,
        ["-I", "-B", path.join(ASSETS, "worker.py"), "imports"],
        { ...opts, timeoutMs: 120_000 },
      );
    }
    const job = await fs.mkdtemp(path.join(this.dataDir, "verify-"));
    const request = path.join(job, "request.json");
    await fs.writeFile(
      request,
      JSON.stringify({ output: job, home: os.homedir() }),
      { mode: 0o600 },
    );
    const result = JSON.parse(
      (
        await this.confined(
          "smoke",
          request,
          job,
          [request],
          180_000,
          signal,
        )
      ).stdout,
    );
    if (
      result.build123d !== BUILD123D ||
      !result.watertight ||
      !result.manifold ||
      !result.step_valid ||
      result.solid_count !== 1
    )
      throw new Error("CAD setup's confined STL/STEP round trip failed.");
    // A re-check of an unchanged runtime keeps the size setup measured instead of walking 1.4 GB again.
    const storage = measured ?? {
      installed_bytes: await measureEnvironment(this.dataDir),
      measured_at: new Date().toISOString(),
    };
    await fs.writeFile(
      path.join(this.dataDir, "ready.json"),
      JSON.stringify({
        build123d: BUILD123D,
        platform: this.system.platform,
        verifiedAt: new Date().toISOString(),
        fingerprint: await this.fingerprint(),
        runtime: await this.runtimeIdentity(),
        dataDevice: (await fs.stat(this.dataDir)).dev,
        storage,
      }),
      { mode: 0o600 },
    );
  }
  /**
   * Re-verifies without installing when only the engine's own sources changed since the last proof (#609): the
   * marker matches this platform, build123d and data device, its engine fingerprint differs, and the installed
   * runtime still matches requirements.lock exactly with the same interpreter. Anything else, including a changed
   * lock, still needs cad_setup with install: true. A failed re-verification is reported, not retried, until the
   * engine changes again or setup runs.
   */
  async ensureReady(signal?: AbortSignal, deadline?: number): Promise<CadStatus> {
    const status = await this.status();
    if (status.ready || !status.configured) return status;
    const fingerprint = await this.fingerprint();
    if (!(await this.onlyEngineChanged(fingerprint))) return status;
    if (this.reverifyFailure?.fingerprint === fingerprint)
      return { ...status, error: this.reverifyFailure.error };
    const started = performance.now();
    // A cad_run or cad_check_fit passes its own deadline: the re-check, its waiting included, stays inside timeout_ms.
    const outOfTime = {
      ...status,
      error:
        "The automatic re-check after this MCP's update did not finish within this call's timeout_ms; the next call runs it again.",
    };
    if (deadline !== undefined && deadline - started < 1) return outOfTime;
    const limit = deadline === undefined ? undefined : AbortSignal.timeout(Math.ceil(deadline - started));
    const bounded = limit ? (signal ? AbortSignal.any([signal, limit]) : limit) : signal;
    const recheck = () =>
      this.exclusive(
        async () => {
          if ((await this.status()).ready) return;
          const env = this.environment(this.dataDir);
          await fs.mkdir(env.TMPDIR!, { recursive: true });
          const previous = await fs
            .readFile(path.join(this.dataDir, "ready.json"), "utf8")
            .then((text) => JSON.parse(text).storage, () => undefined);
          await this.verify({ env, cwd: this.dataDir, signal: bounded, timeoutMs: 600_000 }, bounded, previous ?? null);
        },
        "setup",
        bounded,
      );
    try {
      // Another call may hold the engine, usually this same re-check from another process (Counterpart reading
      // cad_status while the design worker's first cad_run starts): wait for it and try again, never call it a failure.
      const waited = performance.now();
      for (let attempt = true, until = Math.min(waited + this.busyWaitMs, deadline ?? Infinity); ; ) {
        try {
          if (attempt) {
            await recheck();
            break;
          }
          throw new CadRefusal("cad-setup-busy", "waiting for the other CAD operation's result");
        } catch (e) {
          if (!(e instanceof CadRefusal && e.code === "cad-setup-busy")) throw e;
          signal?.throwIfAborted();
          if (limit?.aborted) return outOfTime;
          if ((await this.status()).ready) break;
          attempt = performance.now() - waited < this.busyRetryMs;
          if (performance.now() >= until)
            return {
              ...(await this.status()),
              error:
                "Another CAD operation is running; this MCP re-checks its unchanged runtime by itself when that finishes. Ask again shortly.",
            };
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    } catch (e) {
      signal?.throwIfAborted();
      if (limit?.aborted) return outOfTime; // ran out of this call's time: not a failed re-check, never cached
      const reason = e instanceof Error ? e.message : String(e);
      this.reverifyFailure = {
        fingerprint,
        error: `The automatic re-check after this MCP's update failed (${reason.slice(0, 300)}). Run cad_setup with install: true.`,
      };
      return { ...(await this.status()), error: this.reverifyFailure.error };
    }
    const after = await this.status();
    return after.ready
      ? {
          ...after,
          reverified: `Re-checked automatically after an update to the engine (${Math.round((performance.now() - started) / 1000)} s): the installed runtime was unchanged; confined import, build, STL and STEP round trip passed.`,
        }
      : after;
  }
  private async onlyEngineChanged(fingerprint: string): Promise<boolean> {
    try {
      const marker = JSON.parse(await fs.readFile(path.join(this.dataDir, "ready.json"), "utf8"));
      if (
        marker.build123d !== BUILD123D ||
        marker.platform !== this.system.platform ||
        marker.dataDevice !== (await fs.stat(this.dataDir)).dev ||
        typeof marker.fingerprint !== "string" ||
        marker.fingerprint === fingerprint
      )
        return false;
      const runtime = await this.runtimeIdentity();
      if (!runtime.matchesLock) return false;
      // Markers from engines without the runtime record (bambu-printer-mcp 1.1.89, mcp-3D-printer-server 1.2.71 and
      // earlier) qualify by the exact package match; the re-run proof decides the rest.
      if (marker.runtime && (marker.runtime.interpreter !== runtime.interpreter || marker.runtime.lock_sha256 !== runtime.lock_sha256))
        return false;
      return true;
    } catch {
      return false;
    }
  }
  /** The interpreter the venv runs and whether its installed distributions are exactly requirements.lock's pins. */
  private async runtimeIdentity(): Promise<{ interpreter: string; lock_sha256: string; matchesLock: boolean }> {
    const lock = await fs.readFile(path.join(ASSETS, "requirements.lock"), "utf8");
    const runtime = path.join(this.dataDir, "runtime");
    const cfg = await fs.readFile(path.join(runtime, "pyvenv.cfg"), "utf8").catch(() => "");
    const field = (name: string) => cfg.match(new RegExp(`^${name}\\s*=\\s*(.+)$`, "m"))?.[1]?.trim() ?? "";
    const interpreter = `${field("version_info") || field("version")} ${await fs.realpath(path.join(runtime, "bin", "python")).catch(() => "")}`;
    const norm = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");
    const installed = new Map<string, string>();
    const lib = path.join(runtime, "lib");
    for (const dir of await fs.readdir(lib).catch(() => [] as string[])) {
      if (!/^python3\.\d+$/.test(dir)) continue;
      for (const entry of await fs.readdir(path.join(lib, dir, "site-packages")).catch(() => [] as string[])) {
        const m = entry.match(/^(.+)-([^-]+)\.dist-info$/);
        if (m) installed.set(norm(m[1]), m[2]);
      }
    }
    let matchesLock = installed.size > 0;
    for (const line of lock.split("\n")) {
      const m = line.match(/^\s*([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s;]+)\s*(;.*)?$/);
      if (!m) continue;
      const have = installed.get(norm(m[1]));
      // A pin behind an environment marker may not apply here: absent is fine, a different version is not.
      if (have === undefined ? !m[3] : have !== m[2]) matchesLock = false;
    }
    return { interpreter, lock_sha256: createHash("sha256").update(lock).digest("hex"), matchesLock };
  }
  private async fingerprint(): Promise<string> {
    const hash = createHash("sha256");
    for (const file of [
      "requirements.lock",
      "worker.py",
      "geometry.py",
      "scan_touchup.py",
      "process.ts",
      "storage.ts",
      "serial.ts",
      "refusal.ts",
      "contracts.ts",
    ])
      hash.update(await fs.readFile(path.join(ASSETS, file)));
    hash.update(
      await fs.readFile(new URL("../src/cad-engine.ts", import.meta.url)),
    );
    for (const file of [
      "process.js",
      "storage.js",
      "serial.js",
      "refusal.js",
      "contracts.js",
    ])
      hash.update(await fs.readFile(new URL(`./cad/${file}`, import.meta.url)));
    hash.update(await fs.readFile(new URL("./cad-engine.js", import.meta.url)));
    return hash.digest("hex");
  }
  private async requireSupportedStorage(
    env: NodeJS.ProcessEnv,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.system.platform !== "darwin") return;
    const error = () =>
      new CadRefusal(
        "cad-data-volume-refused",
        "Code-CAD on macOS requires an internal disk with file ownership enabled. External and network data volumes are unsupported after measured native-import stalls. Set CAD_DATA_DIR to an internal folder and rerun cad_setup; nothing was installed by this attempt.",
      );
    try {
      const opts = { env, cwd: this.dataDir, timeoutMs: 10_000, signal };
      const df = await this.system.run("/bin/df", ["-P", this.dataDir], opts);
      const device = df.stdout
        .trim()
        .split(/\r?\n/)
        .at(-1)
        ?.trim()
        .split(/\s+/)[0];
      if (!device || !/^\/dev\/disk\d+(?:s\d+)*$/.test(device)) throw error();
      const info = await this.system.run(
        "/usr/sbin/diskutil",
        ["info", "-plist", device],
        opts,
      );
      if (
        !/<key>Internal<\/key>\s*<true\s*\/>/.test(info.stdout) ||
        !/<key>GlobalPermissionsEnabled<\/key>\s*<true\s*\/>/.test(info.stdout)
      )
        throw error();
    } catch (e) {
      if (signal?.aborted) throw e;
      throw error();
    }
  }
  private async inputFile(value: unknown, extension: string): Promise<string> {
    if (
      typeof value !== "string" ||
      path.extname(value).toLowerCase() !== extension
    )
      throw new Error(`Expected an allowed ${extension} file.`);
    const file = await fs.realpath(path.resolve(value));
    await this.allowedDirectory(path.dirname(file));
    const st = await fs.stat(file);
    if (!st.isFile() || st.size > 64 * 1024 * 1024)
      throw new Error(
        "CAD input must be a regular file no larger than 64 MiB.",
      );
    return file;
  }
  async run(
    args: CadArguments,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const started = performance.now();
    only(args, [
      "script",
      "script_path",
      "parameters",
      "output_dir",
      "name",
      "timeout_ms",
      "inputs",
      "mode",
      "final",
    ]);
    const root = await this.allowedDirectory(args.output_dir);
    const name = plainName(args.name);
    const timeout = milliseconds(args.timeout_ms),
      deadline = started + timeout;
    if (args.final !== undefined && typeof args.final !== "boolean")
      throw new Error("final must be a boolean.");
    if (root.split(path.sep).includes(".cad-inputs"))
      throw new Error(
        "output_dir cannot be inside the reserved CAD input cache.",
      );
    const remaining = () => {
      const value = Math.floor(deadline - performance.now());
      if (value <= 0) throw new Error("CAD run timed out.");
      return value;
    };
    if ((args.script === undefined) === (args.script_path === undefined))
      throw new Error("Supply exactly one of script or script_path.");
    const source =
      args.script === undefined
        ? await fs.readFile(
            await this.inputFile(args.script_path, ".py"),
            "utf8",
          )
        : args.script;
    if (
      typeof source !== "string" ||
      !source.trim() ||
      Buffer.byteLength(source) > 256 * 1024
    )
      throw new Error(
        "script must be nonempty Python text no larger than 256 KiB.",
      );
    const overrides = args.parameters ?? {};
    if (!overrides || typeof overrides !== "object" || Array.isArray(overrides))
      throw new Error("parameters must be a JSON object.");
    const mode = args.mode ?? "solid";
    if (mode !== "solid" && mode !== "mesh")
      throw new Error("mode must be solid or mesh.");
    let requestedInputs: unknown;
    if (args.inputs !== undefined) {
      if (!Array.isArray(args.inputs) || args.inputs.length > 16)
        throw new Error(
          "inputs must be an array of at most 16 {name, path} files.",
        );
      const named: Record<string, string> = Object.create(null);
      for (const item of args.inputs) {
        if (
          !item ||
          typeof item !== "object" ||
          Array.isArray(item) ||
          Object.keys(item).some((k) => k !== "name" && k !== "path") ||
          typeof item.name !== "string" ||
          typeof item.path !== "string" ||
          Object.prototype.hasOwnProperty.call(named, item.name)
        )
          throw new Error(
            "Each input needs a unique name and an allowed path.",
          );
        named[item.name] = item.path;
      }
      requestedInputs = named;
    }
    if (requestedInputs === undefined && typeof args.script_path === "string") {
      const file = args.script_path.replace(/\.py$/i, ".inputs.json");
      try {
        requestedInputs = JSON.parse(
          await fs.readFile(await this.inputFile(file, ".json"), "utf8"),
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
    const inputs: Record<string, string> = {};
    if (requestedInputs !== undefined) {
      if (
        !requestedInputs ||
        typeof requestedInputs !== "object" ||
        Array.isArray(requestedInputs) ||
        Object.keys(requestedInputs).length > 16
      )
        throw new Error("inputs must name at most 16 local files.");
      for (const [alias, value] of Object.entries(requestedInputs)) {
        if (
          !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(alias) ||
          typeof value !== "string"
        )
          throw new Error(
            "Each input needs a plain alias and an allowed file path.",
          );
        const ext = path.extname(value).toLowerCase();
        inputs[alias] = await this.inputFile(value, ext);
      }
    }
    // Re-check before queueing, inside this run's deadline; a not-ready refusal still comes from inside the queue,
    // after any queue timeout.
    const before = await this.ensureReady(signal, deadline);
    return this.exclusive(
      async (queueWaitMs) => {
        const status = await this.status();
        if (!status.ready) throw new CadRefusal("cad-not-ready", before.error ?? status.error!);
        const job = await fs.mkdtemp(path.join(root, `cad-${name}-`));
        await fs.chmod(job, 0o700);
        const script = path.join(job, `${name}.py`),
          parameters = path.join(job, `${name}.parameters.json`),
          request = path.join(job, ".cad-request.json");
        const resultManifest = path.join(job, "cad-result.json");
        const lineage = createHash("sha256").update(source).digest("hex");
        await fs.writeFile(script, source, { mode: 0o600 });
        let previous: unknown = {};
        if (args.script_path !== undefined) {
          try {
            previous = JSON.parse(
              await fs.readFile(
                await this.inputFile(
                  String(args.script_path).replace(
                    /\.py$/i,
                    ".parameters.json",
                  ),
                  ".json",
                ),
                "utf8",
              ),
            );
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          }
        }
        await fs.writeFile(
          parameters,
          JSON.stringify({ ...(previous as object), ...overrides }),
          { mode: 0o600 },
        );
        await atomicJson(resultManifest, {
          status: "pending",
          final: args.final === true,
          lineage_id: lineage,
        });
        try {
          remaining();
          signal?.throwIfAborted();
          const snapshot = await snapshotInputs(root, inputs, signal, {
            directory: path.join(this.dataDir, "input-index"),
            authorize: (directory) => this.allowedDirectory(directory),
          });
          const snapshots = snapshot.inputs,
            manifest = path.join(job, `${name}.inputs.json`);
          await fs.writeFile(manifest, JSON.stringify(snapshots, null, 2), {
            mode: 0o600,
          });
          const base = {
            output: job,
            name,
            script,
            parameters,
            mode,
            inputs: snapshots,
          };
          await fs.writeFile(request, JSON.stringify(base), { mode: 0o600 });
          const protectedFiles = [
            script,
            parameters,
            request,
            manifest,
            resultManifest,
            ...(snapshot.directory ? [snapshot.directory] : []),
          ];
          const readableInputs = snapshot.directory ? [snapshot.directory] : [];
          const effective = JSON.parse(
            (
              await this.system.run(
                status.python!,
                [
                  "-I",
                  "-B",
                  path.join(ASSETS, "worker.py"),
                  "parameters",
                  request,
                ],
                {
                  env: this.environment(job),
                  cwd: job,
                  timeoutMs: Math.min(10_000, remaining()),
                  signal,
                },
              )
            ).stdout,
          );
          await fs.writeFile(parameters, JSON.stringify(effective, null, 2), {
            mode: 0o600,
          });
          const t = performance.now();
          const built = await this.confined(
            "build",
            request,
            job,
            protectedFiles,
            remaining(),
            signal,
            readableInputs,
          );
          await fs.writeFile(
            path.join(job, "build.log"),
            (built.stdout + "\n" + (built.stderr ?? "")).slice(-200_000),
            { mode: 0o600, flag: "wx" },
          );
          for (const ext of mode === "solid" ? ["stl", "step"] : ["stl"]) {
            const st = await fs.lstat(path.join(job, `${name}.${ext}`));
            if (!st.isFile() || st.size === 0 || st.size > 64 * 1024 * 1024)
              throw new Error(
                `CAD ${ext} export is missing, unsafe or too large.`,
              );
          }
          const checked = JSON.parse(
            (
              await this.confined(
                "inspect",
                request,
                job,
                protectedFiles,
                remaining(),
                signal,
                readableInputs,
              )
            ).stdout,
          );
          const printed = built.stdout.trim();
          const result = {
            ...checked,
            // Beside the image paths, where the next step is decided.
            next: "Read renders.perspective before the next cad_run or any other change: say what it shows is wrong against what you are making (the bought product you named, or the object in the photos), then fix that.",
            // The script's own print() output: its words, not a measurement by this engine.
            ...(printed ? { printed: printed.length > 4000 ? printed.slice(0, 4000) + "\n[cut at 4000 characters; build.log has the rest]" : printed } : {}),
            status: "completed",
            final: args.final === true,
            completed_at: new Date().toISOString(),
            lineage_id: lineage,
            result_manifest: resultManifest,
            script,
            parameters,
            inputs: snapshots,
            input_manifest: manifest,
            input_hashes: snapshot.hashes,
            snapshot_bytes_added: snapshot.added,
            snapshot_bytes_reused: snapshot.reused,
            queue_wait_ms: queueWaitMs,
            stl: path.join(job, `${name}.stl`),
            step: mode === "solid" ? path.join(job, `${name}.step`) : null,
            ...(mode === "mesh"
              ? {
                  step_unavailable:
                    "Mesh mode has no parametric B-rep; STEP export is unavailable.",
                }
              : {}),
            seconds: (performance.now() - t) / 1000,
          };
          await atomicJson(resultManifest, result);
          return result;
        } catch (e) {
          await atomicJson(resultManifest, {
            status: "failed",
            final: false,
            final_requested: args.final === true,
            lineage_id: lineage,
            message: e instanceof Error ? e.message : String(e),
            script,
            parameters,
          }).catch(() => {});
          const message = `${e instanceof Error ? e.message : String(e)} Checkpoint retained: ${script} and ${parameters}.`;
          if (e instanceof CadRefusal) throw new CadRefusal(e.code, message);
          throw new Error(message);
        }
      },
      "run",
      signal,
      deadline,
    );
  }
  async checkFit(
    args: CadArguments,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    only(args, [
      "model",
      "reference",
      "transform",
      "clearance_mm",
      "timeout_ms",
    ]);
    const model = await this.inputFile(args.model, ".stl"),
      reference = await this.inputFile(args.reference, ".stl");
    const clearance = args.clearance_mm ?? 0;
    if (
      typeof clearance !== "number" ||
      !Number.isFinite(clearance) ||
      clearance < 0 ||
      clearance > 100
    )
      throw new Error("clearance_mm must be finite, between 0 and 100.");
    // One deadline for the whole call: the automatic re-check and the fit share timeout_ms.
    const deadline = performance.now() + milliseconds(args.timeout_ms);
    const before = await this.ensureReady(signal, deadline);
    return this.exclusive(
      async (queueWaitMs) => {
        const status = await this.status();
        if (!status.ready) throw new CadRefusal("cad-not-ready", before.error ?? status.error!);
        const job = await fs.mkdtemp(path.join(this.dataDir, "fit-"));
        try {
          await fs.copyFile(model, path.join(job, "model.stl"));
          await fs.copyFile(reference, path.join(job, "reference.stl"));
          const request = path.join(job, "request.json");
          await fs.writeFile(
            request,
            JSON.stringify({
              model: path.join(job, "model.stl"),
              reference: path.join(job, "reference.stl"),
              transform: args.transform ?? {},
              clearance_mm: clearance,
            }),
          );
          return { queue_wait_ms: queueWaitMs, ...JSON.parse(
            (
              await this.confined(
                "fit",
                request,
                job,
                [
                  request,
                  path.join(job, "model.stl"),
                  path.join(job, "reference.stl"),
                ],
                (() => {
                  const left = Math.floor(deadline - performance.now());
                  if (left <= 0) throw new Error("CAD fit timed out.");
                  return left;
                })(),
                signal,
              )
            ).stdout,
          ) };
        } finally {
          await fs.rm(job, { recursive: true, force: true });
        }
      },
      "fit",
      signal,
      deadline,
    );
  }
}
function only(args: CadArguments, keys: string[]): void {
  if (Object.keys(args).some((k) => !keys.includes(k)))
    throw new Error(`CAD accepts only ${keys.join(", ")}.`);
}
function plainName(name: unknown): string {
  if (
    typeof name !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name) ||
    name.includes("..")
  )
    throw new Error(
      "name must be a plain filename stem (up to 64 characters).",
    );
  return name;
}
function milliseconds(value: unknown): number {
  if (value === undefined) return 120_000;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 100 ||
    value > 900_000
  )
    throw new Error("timeout_ms must be an integer from 100 to 900000.");
  return value;
}

async function atomicJson(file: string, value: unknown): Promise<void> {
  const temporary = path.join(
    path.dirname(file),
    `.cad-result-${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
    await fs.rename(temporary, file);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}
