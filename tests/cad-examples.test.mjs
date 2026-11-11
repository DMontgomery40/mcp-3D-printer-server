import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cadExamples, cadExampleLines, cadExamplesTool, CAD_EXAMPLE_ORDER } from "../dist/cad/examples.js";
import { CAD_DESIGN_PROMPT } from "../dist/cad/contracts.js";
import { designGuidance, FDM_FIT_GUIDANCE, FDM_FLEXURES, FDM_CORE } from "../dist/design-guidance.js";

const data = process.env.CAD_E2E_DATA_DIR;
const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

test("every cookbook example carries its whole record and a script the engine accepts in form", () => {
  const all = cadExamples();
  assert.deepEqual(all.map((e) => e.name), CAD_EXAMPLE_ORDER);
  for (const e of all) {
    for (const field of ["title", "pattern", "modelled_on", "published_sizes", "concept", "what_makes_this_good"])
      assert.ok(e[field] && !/TODO/.test(e[field]), `${e.name}: ${field}`);
    // a concept names what it is for, how it prints, and the bought product has a source to read
    assert.match(e.concept, /print/i, e.name);
    assert.match(e.modelled_on + e.published_sizes, /https?:\/\//, `${e.name}: cites a page`);
    assert.equal((e.script.match(/^P = \{/gm) ?? []).length, 1, `${e.name}: one literal P`);
    assert.match(e.script, /^def build\(\):/m, e.name);
    assert.doesNotMatch(e.script, /__main__|export_st|children=/, e.name);
    assert.ok(e.script.length < 12000, `${e.name}: short enough to hand to a worker (${e.script.length} bytes)`);
  }
});

test("the engine prompt names every example in one line each, and the tool returns the list or one script", () => {
  const lines = cadExampleLines().split("\n");
  assert.equal(lines.length, CAD_EXAMPLE_ORDER.length);
  for (const name of CAD_EXAMPLE_ORDER) assert.ok(CAD_DESIGN_PROMPT.text.includes(`\n${name}: `), name);
  assert.match(CAD_DESIGN_PROMPT.text, /Form first: build the product's shape, not a profile pushed up\./);
  assert.match(CAD_DESIGN_PROMPT.text, /perspective view/);
  // the cost of the cookbook in the prompt stays a line per example
  assert.ok(cadExampleLines().length < 3200, `pattern lines are ${cadExampleLines().length} bytes`);
  const list = cadExamplesTool({});
  assert.deepEqual(list.examples.map((e) => e.name), CAD_EXAMPLE_ORDER);
  assert.ok(!("script" in list.examples[0]));
  const capo = cadExamplesTool({ name: "trigger_capo" });
  assert.match(capo.script, /def build\(\):/);
  assert.match(capo.concept, /pivot/);
  assert.throws(() => cadExamplesTool({ name: "nope" }), /No example named "nope"\. Examples: cable_clip/);
  assert.throws(() => cadExamplesTool({ path: "/etc/passwd" }), /accepts only name/);
});

test("fit and flexure guidance reach a worker that has only tools", () => {
  assert.equal(designGuidance({ name: "fdm_fit" }).text, FDM_FIT_GUIDANCE);
  assert.equal(designGuidance({ name: "fdm_flexures" }).text, FDM_FLEXURES);
  assert.throws(() => designGuidance({ name: "fdm_design" }), /design_guidance takes one name/);
  assert.throws(() => designGuidance({}), /design_guidance takes one name/);
  // both prompts the app sends say how to get them
  assert.match(FDM_CORE, /read them with this MCP's design_guidance tool/);
  assert.match(CAD_DESIGN_PROMPT.text, /read them with the design_guidance tool/);
  assert.match(FDM_CORE, /Give it the product's form as well as its function\./);
});

test("stdio lists cad_examples and design_guidance as read-only tools and serves them without a CAD runtime", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cad-examples-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const c = new Client({ name: "cad-examples-test", version: "1" });
  const tr = new StdioClientTransport({ command: process.execPath, args: [entry], cwd: dir, stderr: "pipe",
    env: { PATH: process.env.PATH, HOME: dir, MCP_TRANSPORT: "stdio", BAMBU_MODEL: "", TEMP_DIR: dir, CAD_DATA_DIR: path.join(dir, "no-cad") } });
  tr.stderr?.on("data", () => {});
  t.after(() => c.close());
  await c.connect(tr);
  const { tools } = await c.listTools();
  for (const name of ["cad_examples", "design_guidance"]) {
    const tool = tools.find((x) => x.name === name);
    assert.ok(tool, name);
    assert.equal(tool.annotations.readOnlyHint, true, name);
    assert.equal(tool._meta["counterpart/remote"].scope, "read", name);
  }
  const list = (await c.callTool({ name: "cad_examples", arguments: {} })).structuredContent;
  assert.equal(list.examples.length, CAD_EXAMPLE_ORDER.length);
  const one = (await c.callTool({ name: "cad_examples", arguments: { name: "wall_hook" } })).structuredContent;
  assert.match(one.script, /from build123d import/);
  const missing = await c.callTool({ name: "cad_examples", arguments: { name: "nope" } });
  assert.equal(missing.isError, true);
  const fit = await c.callTool({ name: "design_guidance", arguments: { name: "fdm_fit" } });
  assert.match(JSON.stringify(fit), /Choosing a fit by function/);
});

test("every cookbook example builds valid through cad_run, with the bodies its concept names",
  { skip: !data && "set CAD_E2E_DATA_DIR to an installed, verified CAD runtime", timeout: 900000 },
  async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cad-cookbook-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const c = new Client({ name: "cad-cookbook-test", version: "1" });
    const tr = new StdioClientTransport({ command: process.execPath, args: [entry], cwd: dir, stderr: "pipe",
      env: { PATH: process.env.PATH, HOME: process.env.HOME, MCP_TRANSPORT: "stdio", BAMBU_MODEL: "", TEMP_DIR: dir, CAD_DATA_DIR: data } });
    tr.stderr?.on("data", () => {});
    t.after(() => c.close());
    await c.connect(tr);
    const status = (await c.callTool({ name: "cad_status", arguments: {} })).structuredContent;
    if (!status.ready) { t.skip("CAD runtime exists but is not ready: run cad_setup first"); return; }
    for (const e of cadExamples()) {
      const r = await c.callTool({ name: "cad_run", arguments: { script: e.script, output_dir: dir, name: e.name, timeout_ms: 240000 } }, undefined, { timeout: 300000 });
      assert.notEqual(r.isError, true, `${e.name}: ${JSON.stringify(r).slice(0, 600)}`);
      const s = r.structuredContent;
      assert.equal(s.valid, true, `${e.name}: ${JSON.stringify(s.checks)}`);
      assert.ok(s.solid_count >= 1 && s.solid_count === s.mesh_components, `${e.name}: ${s.solid_count} solids, ${s.mesh_components} mesh components`);
      assert.ok(s.seconds < 60, `${e.name}: ${s.seconds} s`);
      await fs.access(s.renders.perspective);
    }
  });
