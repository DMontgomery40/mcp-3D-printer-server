import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { cadSandbox, defaultCadSystem, type CadSystem } from "./cad/process.js";

const ASSETS = fileURLToPath(new URL("../src/cad/", import.meta.url));
const BUILD123D = "0.13.0";
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
  error?: string;
}
export class CadEngine {
  private readonly system: CadSystem;
  readonly dataDir: string;
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
          "mcp-3d-printer-server",
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
    try {
      const marker = JSON.parse(
        await fs.readFile(path.join(this.dataDir, "ready.json"), "utf8"),
      );
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
      ...(!ready
        ? {
            error:
              "Run cad_setup with install: true to install and verify the confined CAD runtime.",
          }
        : {}),
    };
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
  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const lock = path.join(this.dataDir, "operation.lock");
    const acquire = () => fs.open(lock, "wx", 0o600);
    let handle;
    try {
      handle = await acquire();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const previous = JSON.parse(await fs.readFile(lock, "utf8"));
        if (!Number.isInteger(previous.pid) || previous.pid < 1)
          throw new Error("invalid lock");
        process.kill(previous.pid, 0);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ESRCH") {
          await fs.unlink(lock);
          handle = await acquire();
        }
      }
      if (!handle)
        throw new Error(
          "A CAD operation is already running. Wait for it to finish; no work was replayed.",
        );
    }
    await handle.writeFile(JSON.stringify({ pid: process.pid }));
    try {
      return await work();
    } finally {
      await handle.close();
      await fs.unlink(lock).catch(() => {});
    }
  }
  private async confined(
    mode: string,
    request: string,
    job: string,
    readonly: string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ stdout: string; stderr?: string }> {
    const python = path.join(this.dataDir, "runtime", "bin", "python");
    const sandbox = await cadSandbox(this.system.platform, {
      data: this.dataDir,
      job,
      assets: ASSETS,
      python,
      readonly,
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
        ...(await this.status()),
      };
    if (!["darwin", "linux"].includes(this.system.platform))
      throw new Error(
        `CAD confinement is unavailable on ${this.system.platform}.`,
      );
    return this.exclusive(async () => {
      signal?.throwIfAborted();
      const env = this.environment(this.dataDir);
      await this.requireSupportedStorage(env, signal);
      await fs.mkdir(env.TMPDIR!, { recursive: true });
      await fs.unlink(path.join(this.dataDir, "ready.json")).catch(() => {});
      const python = path.join(this.dataDir, "runtime", "bin", "python");
      const opts = { env, cwd: this.dataDir, signal, timeoutMs: 600_000 };
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
      await this.system.run(
        python,
        ["-I", "-B", path.join(ASSETS, "worker.py"), "imports"],
        { ...opts, timeoutMs: 120_000 },
      );
      const job = await fs.mkdtemp(path.join(this.dataDir, "verify-"));
      const request = path.join(job, "request.json");
      await fs.writeFile(
        request,
        JSON.stringify({ output: job, home: os.homedir() }),
        { mode: 0o600 },
      );
      const result = JSON.parse(
        (await this.confined("smoke", request, job, [request], 180_000, signal))
          .stdout,
      );
      if (
        result.build123d !== BUILD123D ||
        !result.watertight ||
        !result.manifold ||
        !result.step_valid ||
        result.solid_count !== 1
      )
        throw new Error("CAD setup's confined STL/STEP round trip failed.");
      await fs.writeFile(
        path.join(this.dataDir, "ready.json"),
        JSON.stringify({
          build123d: BUILD123D,
          platform: this.system.platform,
          verifiedAt: new Date().toISOString(),
          fingerprint: await this.fingerprint(),
          dataDevice: (await fs.stat(this.dataDir)).dev,
        }),
        { mode: 0o600 },
      );
      return {
        supported: true,
        ...(await this.status()),
        installed: true,
        message:
          "CAD is ready; confined import, build, STL and STEP round trip passed. No native files were re-signed.",
      };
    });
  }
  private async fingerprint(): Promise<string> {
    return createHash("sha256")
      .update(await fs.readFile(path.join(ASSETS, "requirements.lock")))
      .update(await fs.readFile(path.join(ASSETS, "worker.py")))
      .update(await fs.readFile(path.join(ASSETS, "geometry.py")))
      .update(await fs.readFile(new URL("./cad/process.js", import.meta.url)))
      .digest("hex");
  }
  private async requireSupportedStorage(
    env: NodeJS.ProcessEnv,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.system.platform !== "darwin") return;
    const error = () =>
      new Error(
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
    only(args, [
      "script",
      "script_path",
      "parameters",
      "output_dir",
      "name",
      "timeout_ms",
      "inputs",
      "mode",
    ]);
    const root = await this.allowedDirectory(args.output_dir);
    const name = plainName(args.name);
    const timeout = milliseconds(args.timeout_ms);
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
    return this.exclusive(async () => {
      const status = await this.status();
      if (!status.ready) throw new Error(status.error);
      const job = await fs.mkdtemp(path.join(root, `cad-${name}-`));
      await fs.chmod(job, 0o700);
      const script = path.join(job, `${name}.py`),
        parameters = path.join(job, `${name}.parameters.json`),
        request = path.join(job, ".cad-request.json");
      await fs.writeFile(script, source, { mode: 0o600 });
      let previous: unknown = {};
      if (args.script_path !== undefined) {
        const previousPath = String(args.script_path).replace(
          /\.py$/i,
          ".parameters.json",
        );
        try {
          previous = JSON.parse(
            await fs.readFile(
              await this.inputFile(previousPath, ".json"),
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
      const snapshots: Record<string, string> = {};
      const inputDir = path.join(job, "inputs");
      await fs.mkdir(inputDir, { mode: 0o700 });
      let inputBytes = 0;
      const inputNames = new Set<string>();
      for (const [alias, file] of Object.entries(inputs)) {
        const filename = path.basename(file);
        if (inputNames.has(filename.toLowerCase()))
          throw new Error(
            "CAD input files must have distinct original filenames so linked mesh/texture assets remain unambiguous.",
          );
        inputNames.add(filename.toLowerCase());
        const destination = path.join(inputDir, filename);
        await fs.copyFile(file, destination);
        const bytes = (await fs.stat(destination)).size;
        inputBytes += bytes;
        if (bytes > 64 * 1024 * 1024 || inputBytes > 256 * 1024 * 1024)
          throw new Error(
            "CAD inputs exceed their 64 MiB/file or 256 MiB total limit.",
          );
        snapshots[alias] = destination;
      }
      const manifest = path.join(job, `${name}.inputs.json`);
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
      const effective = JSON.parse(
        (
          await this.system.run(
            status.python!,
            ["-I", "-B", path.join(ASSETS, "worker.py"), "parameters", request],
            { env: this.environment(job), cwd: job, timeoutMs: 10_000, signal },
          )
        ).stdout,
      );
      await fs.writeFile(parameters, JSON.stringify(effective, null, 2), {
        mode: 0o600,
      });
      const t = Date.now(),
        protectedFiles = [script, parameters, request, manifest, inputDir];
      try {
        const built = await this.confined(
          "build",
          request,
          job,
          protectedFiles,
          timeout,
          signal,
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
        const remaining = timeout - (Date.now() - t);
        if (remaining <= 0)
          throw new Error("CAD run timed out before validation.");
        const checked = JSON.parse(
          (
            await this.confined(
              "inspect",
              request,
              job,
              protectedFiles,
              remaining,
              signal,
            )
          ).stdout,
        );
        return {
          ...checked,
          script,
          parameters,
          inputs: snapshots,
          input_manifest: manifest,
          stl: path.join(job, `${name}.stl`),
          step: mode === "solid" ? path.join(job, `${name}.step`) : null,
          ...(mode === "mesh"
            ? {
                step_unavailable:
                  "Mesh mode has no parametric B-rep; STEP export is unavailable.",
              }
            : {}),
          seconds: (Date.now() - t) / 1000,
        };
      } catch (e) {
        throw new Error(
          `${e instanceof Error ? e.message : String(e)} Checkpoint retained: ${script} and ${parameters}.`,
        );
      }
    });
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
    return this.exclusive(async () => {
      const status = await this.status();
      if (!status.ready) throw new Error(status.error);
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
        return JSON.parse(
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
              milliseconds(args.timeout_ms),
              signal,
            )
          ).stdout,
        );
      } finally {
        await fs.rm(job, { recursive: true, force: true });
      }
    });
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
