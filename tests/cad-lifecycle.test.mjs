import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CadEngine } from "../dist/cad-engine.js";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cad-lifecycle-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [];
  let entered, release;
  const engine = new CadEngine({
    dataDir: path.join(root, "data"),
    outputRoots: [root],
    system: {
      platform: "linux",
      run: async (file, args, opts) => {
        calls.push({ file, args, opts });
        if (file === "uv" && args[0] === "venv") {
          await fs.mkdir(path.join(root, "data/runtime/bin"), {
            recursive: true,
          });
          await fs.writeFile(
            path.join(root, "data/runtime/bin/python"),
            "stub",
          );
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
        const mode = args.includes("parameters")
          ? "parameters"
          : args.includes("build")
            ? "build"
            : args.includes("inspect")
              ? "inspect"
              : null;
        if (!mode) return { stdout: "" };
        const req = JSON.parse(await fs.readFile(args.at(-1), "utf8"));
        if (mode === "parameters") return { stdout: JSON.stringify({ w: 10 }) };
        if (mode === "build") {
          entered?.();
          if (release) await new Promise((r) => release(r));
          await fs.writeFile(path.join(req.output, req.name + ".stl"), "stl");
          await fs.writeFile(path.join(req.output, req.name + ".step"), "step");
          return { stdout: "" };
        }
        return {
          stdout: JSON.stringify({
            valid: true,
            units: "mm",
            bounds_mm: [
              [0, 0, 0],
              [10, 2, 3],
            ],
            size_mm: [10, 2, 3],
            volume_mm3: 60,
            solid_count: 1,
            checks: { watertight: true, manifold: true },
            renders: { front: path.join(req.output, "front.png") },
          }),
        };
      },
    },
  });
  await engine.setup({ install: true });
  return {
    root,
    engine,
    calls,
    hold() {
      return new Promise((resolve) => {
        entered = resolve;
        release = (r) => {
          release = undefined;
          this.unblock = r;
        };
      });
    },
    unblock: undefined,
  };
}
const source = 'P={"w":10}\ndef build(): return None';
test("status carries estimates and cached measured installation bytes without spawning", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cad-size-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const e = new CadEngine({
    dataDir: root,
    outputRoots: [root],
    system: {
      platform: "linux",
      run: async () => {
        throw Error("must not spawn");
      },
    },
  });
  const before = await e.status();
  assert.ok(before.storage.expected_download_bytes > 0);
  assert.ok(before.storage.expected_installed_bytes > 0);
  const f = await fixture(t);
  const n = f.calls.length;
  const after = await f.engine.status();
  assert.ok(after.storage.installed_bytes > 0);
  assert.equal(f.calls.length, n);
  assert.equal(after.storage.measurement, "allocated-last-setup");
});
test("setup failures expose stable codes for missing uv, volume and busy operation", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(
    path.join(f.engine.dataDir, "operation.lock"),
    JSON.stringify({ pid: process.pid, operation: "setup" }),
  );
  await assert.rejects(
    f.engine.setup({ install: true }),
    (e) => e.code === "cad-setup-busy",
  );
  await fs.unlink(path.join(f.engine.dataDir, "operation.lock"));
  const e = new CadEngine({
    dataDir: path.join(f.root, "no-uv"),
    outputRoots: [f.root],
    system: {
      platform: "linux",
      run: async () => {
        throw Object.assign(Error("spawn uv ENOENT"), { code: "ENOENT" });
      },
    },
  });
  await assert.rejects(
    e.setup({ install: true }),
    (e) => e.code === "cad-uv-missing",
  );
  const volume = new CadEngine({
    dataDir: path.join(f.root, "volume"),
    outputRoots: [f.root],
    system: {
      platform: "darwin",
      run: async () => ({
        stdout:
          "Filesystem 512-blocks Used Available Capacity Mounted on\nserver:/share 2 1 1 50% /share",
      }),
    },
  });
  await assert.rejects(
    volume.setup({ install: true }),
    (e) => e.code === "cad-data-volume-refused",
  );
});
test("completed final receipt persists trusted checks and source lineage on disk", async (t) => {
  const f = await fixture(t);
  const out = await f.engine.run({
    script: source,
    output_dir: f.root,
    name: "chosen",
    final: true,
  });
  const saved = JSON.parse(await fs.readFile(out.result_manifest, "utf8"));
  assert.equal(saved.final, true);
  assert.equal(saved.status, "completed");
  assert.deepEqual(saved.checks, out.checks);
  assert.deepEqual(saved.bounds_mm, out.bounds_mm);
  assert.equal(saved.solid_count, 1);
  assert.equal(saved.lineage_id, out.lineage_id);
  assert.ok(saved.completed_at);
  assert.ok(saved.queue_wait_ms >= 0);
});
test("runs queue FIFO, include wait duration and refuse an expired queued request without dispatch", async (t) => {
  const f = await fixture(t);
  const waiting = f.hold();
  const first = f.engine.run({
    script: source,
    output_dir: f.root,
    name: "first",
    timeout_ms: 10000,
  });
  await waiting;
  const second = f.engine.run({
    script: source,
    output_dir: f.root,
    name: "second",
    timeout_ms: 10000,
  });
  await assert.rejects(
    f.engine.run({
      script: source,
      output_dir: f.root,
      name: "expired",
      timeout_ms: 100,
    }),
    (e) => e.code === "cad-queue-timeout",
  );
  f.unblock();
  const [a, b] = await Promise.all([first, second]);
  assert.ok(b.queue_wait_ms >= 80);
  assert.ok(a.queue_wait_ms < b.queue_wait_ms);
  assert.equal(f.calls.filter((c) => c.args.includes("build")).length, 2);
});
test("unchanged linked input bundles reuse bytes and keep the cache out of the writable job", async (t) => {
  const f = await fixture(t);
  const input = path.join(f.root, "scan.obj");
  const texture = path.join(f.root, "texture.png");
  await fs.writeFile(input, "mesh");
  await fs.writeFile(texture, "texture");
  const one = await f.engine.run({
    script: source,
    inputs: [
      { name: "scan", path: input },
      { name: "texture", path: texture },
    ],
    output_dir: f.root,
    name: "one",
  });
  const two = await f.engine.run({
    script_path: one.script,
    parameters: { w: 11 },
    output_dir: f.root,
    name: "two",
  });
  assert.equal(one.snapshot_bytes_added, 11);
  assert.equal(two.snapshot_bytes_added, 0);
  assert.equal(two.snapshot_bytes_reused, 11);
  assert.deepEqual(one.inputs, two.inputs);
  assert.equal(path.basename(one.inputs.scan), "scan.obj");
  assert.notEqual(path.dirname(one.inputs.scan), path.dirname(one.script));
  const linux = f.calls.find(
    (c) => c.file === "bwrap" && c.args.includes("build"),
  );
  assert.ok(linux.args.includes(path.dirname(one.inputs.scan)));
  assert.ok(linux.args.includes("--ro-bind"));
  await fs.appendFile(input, "changed");
  const three = await f.engine.run({
    script: source,
    inputs: [{ name: "scan", path: input }],
    output_dir: f.root,
    name: "three",
  });
  assert.ok(three.snapshot_bytes_added > 0);
  assert.notEqual(three.inputs.scan, one.inputs.scan);
});

test("input bundles reuse across output directories but a subset never exposes undeclared files", async (t) => {
  const f = await fixture(t);
  const a = path.join(f.root, "a.obj"),
    b = path.join(f.root, "b.png");
  await fs.writeFile(a, "mesh");
  await fs.writeFile(b, "image");
  const first = await f.engine.run({
    script: source,
    inputs: [
      { name: "a", path: a },
      { name: "b", path: b },
    ],
    output_dir: f.root,
    name: "original",
  });
  const other = path.join(f.root, "revision");
  await fs.mkdir(other);
  const next = await f.engine.run({
    script_path: first.script,
    output_dir: other,
    name: "revision",
  });
  assert.equal(next.snapshot_bytes_added, 0);
  assert.deepEqual(next.inputs, first.inputs);
  const subset = await f.engine.run({
    script: source,
    inputs: [{ name: "a", path: first.inputs.a }],
    output_dir: other,
    name: "subset",
  });
  assert.notEqual(path.dirname(subset.inputs.a), path.dirname(first.inputs.a));
  assert.deepEqual(await fs.readdir(path.dirname(subset.inputs.a)), ["a.obj"]);
});

test("cancelled queued calls remove their tickets and are never dispatched", async (t) => {
  const f = await fixture(t);
  const entered = f.hold();
  const first = f.engine.run({
    script: source,
    output_dir: f.root,
    name: "active",
  });
  await entered;
  const controller = new AbortController();
  const queued = f.engine.run(
    { script: source, output_dir: f.root, name: "cancelled" },
    controller.signal,
  );
  controller.abort();
  await assert.rejects(queued, (e) => e.name === "AbortError");
  assert.deepEqual(await fs.readdir(path.join(f.engine.dataDir, "queue")), []);
  f.unblock();
  await first;
  assert.equal(f.calls.filter((c) => c.args.includes("build")).length, 1);
});
