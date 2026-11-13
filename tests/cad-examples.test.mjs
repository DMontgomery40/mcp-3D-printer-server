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

// Its own switch, not CAD_E2E_DATA_DIR: the nineteen builds hold the engine's one execution slot for about two minutes,
// which would starve cad-real.test.mjs's deadline checks if both ran against the same runtime at once.
const data = process.env.CAD_COOKBOOK_DATA_DIR;
const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

test("every cookbook example carries its whole record and a script the engine accepts in form", () => {
  const all = cadExamples();
  assert.deepEqual(all.map((e) => e.name), CAD_EXAMPLE_ORDER);
  for (const e of all) {
    for (const field of ["title", "use_for", "pattern", "modelled_on", "published_sizes", "concept", "what_makes_this_good"])
      assert.ok(e[field] && !/TODO/.test(e[field]), `${e.name}: ${field}`);
    // a concept names what it is for, how it prints, and the bought product has a source to read
    assert.match(e.concept, /print/i, e.name);
    // the purpose line is one line a worker can choose by, not the mechanism again
    assert.ok(e.use_for.length >= 40 && e.use_for.length <= 220, `${e.name}: use_for is ${e.use_for.length} characters`);
    assert.match(e.modelled_on + e.published_sizes, /https?:\/\//, `${e.name}: cites a page`);
    assert.equal((e.script.match(/^P = \{/gm) ?? []).length, 1, `${e.name}: one literal P`);
    assert.match(e.script, /^def build\(\):/m, e.name);
    // use() returns the design as used, a labelled Compound of the part, what it holds and what it meets
    assert.doesNotMatch(e.script.split(/^def use\(\):/m)[0], /__main__|export_st|children=/, e.name);
    assert.doesNotMatch(e.script, /__main__|export_st/, e.name);
    assert.ok(e.script.length < 12000, `${e.name}: short enough to hand to a worker (${e.script.length} bytes)`);
  }
});

test("the engine prompt names every example by purpose in one line each, and the tool returns the list or one script", () => {
  const lines = cadExampleLines().split("\n");
  assert.equal(lines.length, CAD_EXAMPLE_ORDER.length);
  for (const e of cadExamples()) assert.ok(CAD_DESIGN_PROMPT.text.includes(`\n${e.name}: ${e.use_for}\n`), e.name);
  // the order the Sonnet test asked for: the bought product, then the cookbook by purpose, then the mechanism
  const text = CAD_DESIGN_PROMPT.text;
  const at = (s) => { const i = text.indexOf(s); assert.ok(i >= 0, s); return i; };
  assert.ok(at("A new design starts from the product") < at("name two or three products a person would buy"));
  assert.ok(at("name two or three products a person would buy") < at("choose from the cookbook by purpose"));
  assert.ok(at("choose from the cookbook by purpose") < at("only then, choose the mechanism"));
  assert.ok(at("only then, choose the mechanism") < at("Form first:"));
  // the product is named where a reviewer can see it: in the script's header, as the cookbook's are
  assert.match(text, /write the concept as the script's opening docstring, the way every cookbook example does: what it is, then "Modelled on:" the bought product you named/);
  assert.match(text, /After every cad_run, Read its perspective view \(renders\.perspective/);
  assert.match(text, /Before the final run, list what the views show is wrong against the bought product you named \(for a scan, the object in its photos\)/);
  assert.match(text, /print\(\) it in the script: the result returns it as printed/);
  assert.match(CAD_DESIGN_PROMPT.text, /Form first: build the product's shape, not a profile pushed up\./);
  assert.match(CAD_DESIGN_PROMPT.text, /perspective view/);
  // the purpose as data and the design as used, before geometry; final only when ready (scan-to-make #608)
  assert.ok(at("only then, choose the mechanism") < at("Then state the purpose as data, before any geometry: a literal PURPOSE = {...}"));
  assert.match(text, /define use\(\) beside build\(\)/);
  assert.match(text, /"held:<body>"/);
  assert.match(text, /"world:<body>"/);
  assert.match(text, /final: true is recorded only when ready is true/);
  // the examples that teach it carry both, one per kind of interface the engine models
  for (const name of ["desk_edge_cable_holder", "desk_clamp_hook", "phone_stand"]) {
    const { script } = cadExamples().find((e) => e.name === name);
    assert.match(script, /^PURPOSE = \{/m, name);
    assert.match(script, /^def use\(\):/m, name);
  }
  // the cost of the cookbook in the prompt stays a line per example
  assert.ok(cadExampleLines().length < 3200, `purpose lines are ${cadExampleLines().length} bytes`);
  const list = cadExamplesTool({});
  assert.deepEqual(list.examples.map((e) => e.name), CAD_EXAMPLE_ORDER);
  assert.ok(!("script" in list.examples[0]));
  for (const e of list.examples) assert.ok(e.use_for, `${e.name}: the list reads by purpose`);
  assert.match(list.examples.find((e) => e.name === "desk_clamp_hook").use_for, /headphones/);
  assert.match(list.usage, /^Choose by use_for/);
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
  { skip: !data && "set CAD_COOKBOOK_DATA_DIR to an installed, verified CAD runtime (run it on its own)", timeout: 900000 },
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
      assert.match(s.next, /^Read renders\.perspective/, e.name);
      // a design reports a number it computed through print(), without failing the run to read it
      if (e.name === "broom_grip") assert.match(s.printed, /arm strain while the handle passes the mouth: \d\.\d %/);
    }
    // A printed screw in its nut is 0.28 mm clear at every opening. The exact B-rep distance called it "inside" the
    // frame at opening 31 and reported a touch (scan-to-make #734, Sonnet re-run); the surfaces are measured instead.
    const hook = cadExamples().find((e) => e.name === "desk_clamp_hook");
    const clamped = (await c.callTool({ name: "cad_run", arguments: { script: hook.script, parameters: { pose: "assembled", opening: 31 },
      output_dir: dir, name: "hook_clamped", timeout_ms: 240000 } }, undefined, { timeout: 300000 })).structuredContent;
    assert.equal(clamped.valid, true);
    assert.ok(clamped.bodies.closest.gap_mm > 0.2 && clamped.bodies.closest.gap_mm < 0.4, JSON.stringify(clamped.bodies.closest));
    assert.ok(!clamped.problems.some((p) => /touch or overlap/.test(p)), clamped.problems.join("; "));
  });
