import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const module = await import("../dist/cad-engine.js").catch(() => ({}));

test("CAD engine exposes a read-only status before setup without starting Python", async (t) => {
  assert.equal(
    typeof module.CadEngine,
    "function",
    "CAD engine is not implemented",
  );
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cad-status-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const engine = new module.CadEngine({
    dataDir: root,
    outputRoots: [root],
    system: {
      platform: "darwin",
      run: async () => {
        throw Error("status must not spawn");
      },
    },
  });
  const status = await engine.status();
  assert.equal(status.ready, false);
  assert.equal(status.configured, false);
  assert.equal(status.platform, "darwin");
});

test("CAD subprocess deadlines kill descendants and do not replay execution", async () => {
  const { runCadProcess } = await import("../dist/cad/process.js");
  await assert.rejects(
    runCadProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      timeoutMs: 60,
      env: { PATH: process.env.PATH },
    }),
    /timed out/,
  );
});

test("CAD confinement has no network or home mounts and refuses unsupported hosts", async () => {
  const { cadSandbox } = await import("../dist/cad/process.js");
  const roots = {
    data: "/srv/cad",
    job: "/work/job",
    assets: "/pkg/src/cad",
    python: "/srv/cad/runtime/bin/python",
    readonly: ["/work/job/a.py", "/work/job/a.parameters.json"],
  };
  const mac = await cadSandbox("darwin", roots);
  assert.equal(mac.command, "/usr/bin/sandbox-exec");
  assert.match(mac.args[1], /deny network/);
  assert.match(mac.args[1], /\(deny file-read\*\)/);
  assert.doesNotMatch(mac.args[1], /\(subpath "\/System"\)/);
  assert.match(mac.args[1], /deny process-fork/);
  assert.match(mac.args[1], /deny file-link/);
  assert.match(mac.args[1], /deny mach-lookup/);
  const linux = await cadSandbox("linux", roots);
  assert.equal(linux.command, "bwrap");
  assert.ok(linux.args.includes("--unshare-all"));
  // the sandbox's own root is read-only: only the job folder and /tmp take writes
  assert.equal(linux.args[linux.args.indexOf("--remount-ro") + 1], "/");
  assert.ok(linux.args.indexOf("--remount-ro") > linux.args.lastIndexOf("--bind"));
  assert.ok(linux.args.includes("--die-with-parent"));
  assert.equal(linux.args.includes("/home"), false);
  await assert.rejects(cadSandbox("win32", roots), /confinement.*unavailable/i);
});

test("CAD run refuses outputs outside configured roots and symlink escapes before execution", async (t) => {
  const { CadEngine } = await import("../dist/cad-engine.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cad-path-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "allowed"));
  await fs.mkdir(path.join(root, "outside"));
  await fs.symlink(
    path.join(root, "outside"),
    path.join(root, "allowed", "escape"),
  );
  const engine = new CadEngine({
    dataDir: path.join(root, "data"),
    outputRoots: [path.join(root, "allowed")],
    system: {
      platform: "darwin",
      run: async () => {
        throw Error("must not execute");
      },
    },
  });
  for (const dir of [
    path.join(root, "outside"),
    path.join(root, "allowed", "escape"),
  ])
    await assert.rejects(
      engine.run({
        script: "P={}\ndef build(): return None",
        output_dir: dir,
        name: "part",
      }),
      /allowed output/,
    );
});

test("CAD setup proves a fresh installation and status uses the verified marker", async (t) => {
  const { CadEngine } = await import("../dist/cad-engine.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cad-setup-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [];
  const engine = new CadEngine({
    dataDir: root,
    outputRoots: [root],
    system: {
      platform: "linux",
      run: async (file, args, options) => {
        calls.push({ file, args, options });
        if (args[0] === "venv") {
          await fs.mkdir(path.join(root, "runtime", "bin"), {
            recursive: true,
          });
          await fs.writeFile(
            path.join(root, "runtime", "bin", "python"),
            "stub",
          );
        }
        if (args.includes("smoke"))
          return {
            stdout: JSON.stringify({
              build123d: "0.13.0",
              python: "3.12",
              watertight: true,
              manifold: true,
              step_valid: true,
              solid_count: 1,
            }),
          };
        return { stdout: "" };
      },
    },
  });
  assert.equal((await engine.setup({})).ready, false);
  assert.equal(calls.length, 0);
  assert.equal((await engine.setup({ install: true })).ready, true);
  const count = calls.length;
  assert.equal((await engine.status()).ready, true);
  assert.equal(calls.length, count);
  assert.ok(calls.some((c) => c.args.includes("--managed-python")));
  assert.ok(calls.some((c) => c.file === "bwrap" && c.args.includes("smoke")));
  for (const c of calls) {
    assert.equal(c.options.env.BAMBU_TOKEN, undefined);
    assert.equal(c.options.env.ANTHROPIC_API_KEY, undefined);
    assert.ok(c.options.env.TMPDIR.startsWith(root));
  }
});

test("CAD setup does not mark a runtime ready when confinement cannot start", async (t) => {
  const { CadEngine } = await import("../dist/cad-engine.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cad-no-sandbox-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const e = new CadEngine({
    dataDir: root,
    outputRoots: [root],
    system: {
      platform: "linux",
      run: async (file) => {
        if (file === "bwrap") throw Error("bwrap denied user namespace");
        return { stdout: "" };
      },
    },
  });
  await assert.rejects(e.setup({ install: true }), /bwrap denied/);
  assert.equal((await e.status()).ready, false);
});

test("CAD parameter edits retain the prior checkpoint and use separate build and inspection processes", async (t) => {
  const { CadEngine } = await import("../dist/cad-engine.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cad-run-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [];
  let engine;
  const system = {
    platform: "linux",
    run: async (file, args) => {
      calls.push({ file, args });
      if (args[0] === "venv") {
        await fs.mkdir(path.join(root, "runtime", "bin"), { recursive: true });
        await fs.writeFile(path.join(root, "runtime", "bin", "python"), "stub");
      }
      if (args.includes("smoke"))
        return {
          stdout: JSON.stringify({
            build123d: "0.13.0",
            watertight: true,
            manifold: true,
            step_valid: true,
            solid_count: 1,
          }),
        };
      if (args.includes("parameters"))
        return {
          stdout: JSON.stringify({
            width: 10,
            height: 20,
            ...JSON.parse(
              await fs.readFile(
                JSON.parse(await fs.readFile(args.at(-1), "utf8")).parameters,
                "utf8",
              ),
            ),
          }),
        };
      if (args.includes("build")) {
        const q = JSON.parse(await fs.readFile(args.at(-1), "utf8"));
        await fs.writeFile(path.join(q.output, q.name + ".stl"), "stl");
        await fs.writeFile(path.join(q.output, q.name + ".step"), "step");
        return { stdout: "user output is NOT a receipt" };
      }
      if (args.includes("inspect"))
        return {
          stdout: JSON.stringify({
            valid: true,
            bounds_mm: [
              [0, 0, 0],
              [10, 20, 30],
            ],
            solid_count: 1,
            checks: { watertight: true, manifold: true },
            renders: {},
          }),
        };
      return { stdout: "" };
    },
  };
  engine = new CadEngine({ dataDir: root, outputRoots: [root], system });
  await engine.setup({ install: true });
  const first = await engine.run({
    script: 'P={"width":10,"height":20}\ndef build(): pass',
    parameters: { width: 11 },
    output_dir: root,
    name: "part",
  });
  const second = await engine.run({
    script_path: first.script,
    parameters: { height: 21 },
    output_dir: root,
    name: "part",
  });
  assert.notEqual(first.script, second.script);
  assert.deepEqual(JSON.parse(await fs.readFile(second.parameters, "utf8")), {
    width: 11,
    height: 21,
  });
  assert.deepEqual(JSON.parse(await fs.readFile(first.parameters, "utf8")), {
    width: 11,
    height: 20,
  });
  assert.equal(calls.filter((c) => c.args.includes("build")).length, 2);
  assert.equal(calls.filter((c) => c.args.includes("inspect")).length, 2);
  // beside the image paths: look before the next change; and the script's own print() output, as its words
  assert.match(first.next, /^Read renders\.perspective before the next cad_run/);
  assert.equal(first.printed, "user output is NOT a receipt");
  assert.equal(JSON.parse(await fs.readFile(first.result_manifest, "utf8")).printed, first.printed);
});

test("cad_check_fit waits for the engine like cad_run, and its own timeout ends the wait (scan-to-make #734)", async (t) => {
  const { CadEngine } = await import("../dist/cad-engine.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cad-fit-queue-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const model = path.join(root, "model.stl");
  await fs.writeFile(model, "fixture");
  let release, running = 0, most = 0;
  const held = new Promise((resolve) => (release = resolve));
  const engine = new CadEngine({
    dataDir: path.join(root, "data"),
    outputRoots: [root],
    system: {
      platform: "linux",
      run: async () => {
        most = Math.max(most, ++running);
        await held;
        running--;
        return { stdout: JSON.stringify({ clear: true }) };
      },
    },
  });
  engine.status = async () => ({ configured: true, ready: true, python: "stub", build123d: "0.13.0", platform: "linux" });
  // four at once, as a design worker sends them: none is refused
  const checks = [1, 2, 3, 4].map(() => engine.checkFit({ model, reference: model, timeout_ms: 10000 }));
  await assert.rejects(
    engine.checkFit({ model, reference: model, timeout_ms: 150 }),
    (e) => e.code === "cad-queue-timeout" && /fit check's timeout expired while waiting/.test(e.message),
  );
  release();
  const results = await Promise.all(checks);
  assert.deepEqual(results.map((r) => r.clear), [true, true, true, true]);
  assert.equal(most, 1, "one operation at a time");
  assert.ok(results.some((r) => r.queue_wait_ms >= 100), JSON.stringify(results.map((r) => r.queue_wait_ms)));
});

test("deadline termination removes an actual spawned descendant PID", async (t) => {
  const { runCadProcess } = await import("../dist/cad/process.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cad-child-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "pid");
  const code = `const {spawn}=require('node:child_process');const p=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync(process.argv[1],String(p.pid));setInterval(()=>{},1000)`;
  await assert.rejects(
    runCadProcess(process.execPath, ["-e", code, file], {
      timeoutMs: 5000,
      env: { PATH: process.env.PATH },
    }),
    /timed out/,
  );
  const pid = Number(await fs.readFile(file, "utf8"));
  assert.ok(
    Number.isInteger(pid) && pid > 1,
    "fixture must record its descendant before the deadline",
  );
  let alive = true;
  for (let i = 0; i < 40; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
      break;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(alive, false, `descendant ${pid} survived`);
});

test("declared CAD input snapshots exclude files outside the allowed roots", async (t) => {
  const { CadEngine } = await import("../dist/cad-engine.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cad-inputs-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "allowed"));
  await fs.writeFile(path.join(root, "private.stl"), "private");
  const engine = new CadEngine({
    dataDir: path.join(root, "data"),
    outputRoots: [path.join(root, "allowed")],
    system: {
      platform: "darwin",
      run: async () => {
        throw Error("must not spawn");
      },
    },
  });
  await assert.rejects(
    engine.run({
      script: "P={}\ndef build(): pass",
      inputs: [{ name: "scan", path: path.join(root, "private.stl") }],
      mode: "mesh",
      output_dir: path.join(root, "allowed"),
      name: "part",
    }),
    /allowed output/,
  );
});

test("macOS setup refuses external, network and ownership-disabled storage before installing", async (t) => {
  const { CadEngine } = await import("../dist/cad-engine.js");
  for (const kind of ["external", "network", "noowners"]) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cad-volume-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const calls = [];
    const engine = new CadEngine({
      dataDir: root,
      outputRoots: [root],
      system: {
        platform: "darwin",
        run: async (file, args) => {
          calls.push(file);
          if (file === "/bin/df")
            return {
              stdout:
                "Filesystem blocks used available capacity mounted\n" +
                (kind === "network" ? "host:/share" : "/dev/disk9s2") +
                " 1 1 1 1% /volume\n",
            };
          if (file === "/usr/sbin/diskutil")
            return {
              stdout: `<plist><dict><key>Internal</key><${kind === "external" ? "false" : "true"}/><key>GlobalPermissionsEnabled</key><${kind === "noowners" ? "false" : "true"}/></dict></plist>`,
            };
          throw Error("packages must not be installed on unsupported storage");
        },
      },
    });
    await assert.rejects(
      engine.setup({ install: true }),
      /internal disk.*ownership/i,
    );
    assert.equal(calls.includes("uv"), false);
    assert.equal((await engine.status()).ready, false);
  }
});

test("fit scratch copies are removed after success and failure", async (t) => {
  const { CadEngine } = await import("../dist/cad-engine.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cad-fit-cleanup-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const model = path.join(root, "model.stl");
  await fs.writeFile(model, "fixture");
  let fail = false;
  const engine = new CadEngine({
    dataDir: path.join(root, "data"),
    outputRoots: [root],
    system: {
      platform: "linux",
      run: async () => {
        if (fail) throw Error("fit failed");
        return { stdout: JSON.stringify({ clear: true }) };
      },
    },
  });
  engine.status = async () => ({
    configured: true,
    ready: true,
    python: "stub",
    build123d: "0.13.0",
    platform: "linux",
  });
  assert.equal(
    (await engine.checkFit({ model, reference: model })).clear,
    true,
  );
  fail = true;
  await assert.rejects(
    engine.checkFit({ model, reference: model }),
    /fit failed/,
  );
  assert.equal(
    (await fs.readdir(path.join(root, "data"))).some((n) =>
      n.startsWith("fit-"),
    ),
    false,
  );
  assert.equal(await fs.readFile(model, "utf8"), "fixture");
});

// #609 (scan-to-make): an MCP update that changes only the engine's sources used to leave the code engine "not set up"
// until someone pressed Set Up. With the installed runtime unchanged, status re-runs setup's proof by itself.
async function staleRuntime(t, { lockDrift = false, smokeOk = true, runtime, smokeMs = 0 } = {}) {
  const { CadEngine } = await import("../dist/cad-engine.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cad-reverify-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lock = await fs.readFile(new URL("../src/cad/requirements.lock", import.meta.url), "utf8");
  const site = path.join(root, "runtime", "lib", "python3.12", "site-packages");
  await fs.mkdir(site, { recursive: true });
  await fs.mkdir(path.join(root, "runtime", "bin"), { recursive: true });
  await fs.writeFile(path.join(root, "runtime", "bin", "python"), "stub");
  await fs.writeFile(path.join(root, "runtime", "pyvenv.cfg"), "home = /x\nversion_info = 3.12.9\n");
  let first = true;
  for (const line of lock.split("\n")) {
    const m = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s;]+)\s*(;.*)?$/);
    if (!m || m[3]) continue; // pins behind environment markers may be absent
    const version = lockDrift && first ? `${m[2]}.post1` : m[2];
    first = false;
    await fs.mkdir(path.join(site, `${m[1].replace(/-/g, "_")}-${version}.dist-info`));
  }
  const calls = [];
  const engine = new CadEngine({
    dataDir: root,
    outputRoots: [root],
    system: {
      platform: "linux",
      run: async (file, args, options) => {
        calls.push({ file, args, options });
        if (args.includes("smoke")) {
          if (smokeMs)
            await new Promise((resolve, reject) => {
              const timer = setTimeout(resolve, smokeMs);
              options.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(options.signal.reason); }, { once: true });
            });
          return { stdout: JSON.stringify({ build123d: "0.13.0", watertight: smokeOk, manifold: true, step_valid: true, solid_count: 1 }) };
        }
        return { stdout: args.includes("fit") ? JSON.stringify({ clear: true }) : "" };
      },
    },
  });
  // The marker an earlier engine (bambu-printer-mcp 1.1.89 / mcp-3D-printer-server 1.2.71) wrote: same runtime and data device, another engine fingerprint, no
  // runtime identity.
  await fs.writeFile(path.join(root, "ready.json"), JSON.stringify({
    build123d: "0.13.0", platform: "linux", verifiedAt: "2026-11-11T00:00:00.000Z",
    fingerprint: "an-earlier-engine", dataDevice: (await fs.stat(root)).dev, storage: { installed_bytes: 1, measured_at: "x" },
    ...(runtime ? { runtime: runtime(lock, await fs.realpath(path.join(root, "runtime", "bin", "python"))) } : {}),
  }));
  return { engine, calls, root };
}

test("after an engine-only update, status re-verifies the unchanged runtime by itself and reports ready (#609)", async (t) => {
  const { engine, calls, root } = await staleRuntime(t);
  assert.equal((await engine.status()).ready, false, "the plain status read never runs anything");
  assert.equal(calls.length, 0);
  const status = await engine.ensureReady();
  assert.equal(status.ready, true);
  assert.match(status.reverified, /runtime was unchanged/);
  assert.ok(calls.some((c) => c.file === "bwrap" && c.args.includes("smoke")), "the confined round trip ran again");
  assert.ok(!calls.some((c) => c.file === "uv"), "nothing was installed or downloaded");
  const marker = JSON.parse(await fs.readFile(path.join(root, "ready.json"), "utf8"));
  assert.notEqual(marker.fingerprint, "an-earlier-engine");
  assert.match(marker.runtime.interpreter, /^3\.12\.9 /);
  const count = calls.length;
  assert.equal((await engine.ensureReady()).ready, true);
  assert.equal(calls.length, count, "once ready, status runs nothing");
  // cad_setup without install is the same read.
  assert.equal((await engine.setup({})).ready, true);
});

test("a runtime that no longer matches requirements.lock still needs a real setup (#609)", async (t) => {
  const { engine, calls } = await staleRuntime(t, { lockDrift: true });
  const status = await engine.ensureReady();
  assert.equal(status.ready, false);
  assert.match(status.error, /cad_setup with install: true/);
  assert.equal(calls.length, 0, "nothing ran: a changed runtime is setup's job");
});

test("a failed automatic re-check is reported once and not retried on every status call (#609)", async (t) => {
  const { engine, calls } = await staleRuntime(t, { smokeOk: false });
  const status = await engine.ensureReady();
  assert.equal(status.ready, false);
  assert.match(status.error, /automatic re-check .* failed .*round trip failed.*cad_setup with install: true/);
  const count = calls.length;
  assert.match((await engine.ensureReady()).error, /automatic re-check/);
  assert.equal(calls.length, count);
});

test("a newer marker's lock hash or interpreter that no longer matches needs a real setup, not a re-check (#609)", async (t) => {
  const { createHash } = await import("node:crypto");
  const sha = (text) => createHash("sha256").update(text).digest("hex");
  for (const [what, runtime] of [
    ["the lock changed", (lock, python) => ({ interpreter: `3.12.9 ${python}`, lock_sha256: sha(lock + "# an older lock\n") })],
    ["the interpreter changed", (lock) => ({ interpreter: "3.12.8 /elsewhere/python3.12", lock_sha256: sha(lock) })],
  ]) {
    const { engine, calls } = await staleRuntime(t, { runtime });
    const status = await engine.ensureReady();
    assert.equal(status.ready, false, what);
    assert.equal(calls.length, 0, `${what}: nothing ran`);
  }
  // The same newer marker with the shipped lock and interpreter re-checks.
  const { engine } = await staleRuntime(t, { runtime: (lock, python) => ({ interpreter: `3.12.9 ${python}`, lock_sha256: sha(lock) }) });
  assert.equal((await engine.ensureReady()).ready, true);
});

test("a re-check that finds another CAD operation running waits for it instead of failing (#609)", async (t) => {
  const { engine, calls, root } = await staleRuntime(t);
  engine.busyWaitMs = 10_000;
  const lock = path.join(root, "operation.lock");
  await fs.writeFile(lock, JSON.stringify({ pid: process.pid, operation: "run" }));
  const release = setTimeout(() => fs.unlink(lock).catch(() => {}), 1200);
  t.after(() => clearTimeout(release));
  const status = await engine.ensureReady();
  assert.equal(status.ready, true, status.error);
  assert.ok(calls.some((c) => c.args.includes("smoke")));
});

test("cad_run says why the engine is not ready when the automatic re-check failed (#609)", async (t) => {
  const { engine } = await staleRuntime(t, { smokeOk: false });
  await assert.rejects(
    engine.run({ script: "P = {}\ndef build():\n  pass\n", output_dir: engine.dataDir, name: "x" }),
    (e) => e.code === "cad-not-ready" && /automatic re-check .* failed/.test(e.message),
  );
});

test("the first cad_run's automatic re-check stays inside its timeout_ms and is not cached when it runs out (#609)", async (t) => {
  const { engine } = await staleRuntime(t, { smokeMs: 5000 });
  const started = performance.now();
  await assert.rejects(
    engine.run({ script: "P = {}\ndef build():\n  pass\n", output_dir: engine.dataDir, name: "x", timeout_ms: 100 }),
    (e) => ["cad-queue-timeout", "cad-not-ready"].includes(e.code),
  );
  // The unbounded re-check waited out the whole 5 s smoke; under any load a bounded one returns well before it.
  assert.ok(performance.now() - started < 2500, `took ${Math.round(performance.now() - started)} ms`);
  // Running out of one call's time is not a failed re-check: the next call without a deadline completes it.
  assert.equal((await engine.ensureReady()).ready, true);
});

test("cad_check_fit's automatic re-check and its fit share one timeout_ms (#609)", async (t) => {
  const { engine, calls, root } = await staleRuntime(t, { smokeMs: 180 });
  const model = path.join(root, "model.stl");
  await fs.writeFile(model, "fixture");
  const result = await engine.checkFit({ model, reference: model, timeout_ms: 2000 });
  assert.equal(result.clear, true);
  const fit = calls.find((c) => c.args.includes("fit"));
  assert.ok(fit, "the fit ran after the re-check");
  assert.ok(fit.options.timeoutMs <= 2000 - 150, `the fit was given ${fit.options.timeoutMs} ms of a 2000 ms call after a 180 ms re-check`);
});

test("final is recorded only when the engine finds the design ready; the designer's word alone no longer selects it (scan-to-make #608)", async (t) => {
  const { CadEngine } = await import("../dist/cad-engine.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cad-final-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let verdict;
  const system = {
    platform: "linux",
    run: async (file, args) => {
      if (args[0] === "venv") {
        await fs.mkdir(path.join(root, "runtime", "bin"), { recursive: true });
        await fs.writeFile(path.join(root, "runtime", "bin", "python"), "stub");
      }
      if (args.includes("smoke"))
        return { stdout: JSON.stringify({ build123d: "0.13.0", watertight: true, manifold: true, step_valid: true, solid_count: 1 }) };
      if (args.includes("parameters")) return { stdout: "{}" };
      if (args.includes("build")) {
        const q = JSON.parse(await fs.readFile(args.at(-1), "utf8"));
        for (const ext of ["stl", "step"]) await fs.writeFile(path.join(q.output, `${q.name}.${ext}`), ext);
        return { stdout: "" };
      }
      if (args.includes("inspect"))
        return { stdout: JSON.stringify({ valid: true, bounds_mm: [[0, 0, 0], [1, 1, 1]], solid_count: 1, checks: {}, renders: {}, ...verdict }) };
      return { stdout: "" };
    },
  };
  const engine = new CadEngine({ dataDir: root, outputRoots: [root], system });
  await engine.setup({ install: true });
  const run = (name) => engine.run({ script: "P={}\ndef build(): pass", output_dir: root, name, final: true });
  verdict = { ready: false, purpose: { blocked: ["faces user (phone): 35 deg off the line to the user's eye (allowed 25)"] } };
  const refused = await run("refused");
  assert.equal(refused.final, false);
  assert.equal(refused.final_requested, true);
  assert.deepEqual(refused.final_refused, verdict.purpose.blocked);
  assert.match(refused.next, /final_refused/);
  const receipt = JSON.parse(await fs.readFile(refused.result_manifest, "utf8"));
  assert.equal(receipt.final, false, "the app collects only final runs, so it never takes this one as the model");
  verdict = { ready: true, purpose: { blocked: [] } };
  const ready = await run("ready");
  assert.equal(ready.final, true);
  assert.equal(ready.final_refused, undefined);
  verdict = {};                                  // mesh mode and 3MF projects carry no verdict: today's path
  assert.equal((await run("mesh")).final, true);
});
