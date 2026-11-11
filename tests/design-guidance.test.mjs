import {trackedMkdtempSync} from './support/temp.mjs';
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DESIGN_PROMPTS, FDM_SLICING_PROMPT, slicingGuidance, FDM_AFTER_SLICE, FDM_ASSEMBLY, FDM_CAPABILITY_GUIDANCE, FDM_CAPABILITY_URI, FDM_FIT_GUIDANCE, FDM_FIT_URI, FDM_FLEXURES, FDM_CORE, FDM_MULTICOLOR } from "../dist/design-guidance.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function server(t, env = {}) {
  const directory = trackedMkdtempSync(path.join(os.tmpdir(), "design-guidance-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "dist/index.js")],
    cwd: directory,
    env: { ...process.env, MCP_TRANSPORT: "stdio", BAMBU_MODEL: "p1s", PRINTER_HOST: "127.0.0.1", BAMBU_SERIAL: "01PTESTSERIAL", BAMBU_TOKEN: "printer-secret-never-returned", ...env },
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {});
  const client = new Client({ name: "design-guidance-tests-generic", version: "1" });
  t.after(async () => { await client.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await client.connect(transport);
  return client;
}

test("the FDM design guidance is served as MCP prompts, a resource and the server's instructions", async t => {
  const client = await server(t);
  assert.ok(client.getServerCapabilities()?.prompts, "the server declares prompts");

  const { prompts } = await client.listPrompts();
  assert.deepEqual(prompts.map(prompt => prompt.name), ["cad_design", "fdm_design", "fdm_fit", "fdm_flexures", "fdm_multicolor", "fdm_assembly", "fdm_after_slice", "fdm_slicing"]);
  for (const [name, text] of [["fdm_design", FDM_CORE], ["fdm_fit", FDM_FIT_GUIDANCE], ["fdm_flexures", FDM_FLEXURES], ["fdm_multicolor", FDM_MULTICOLOR], ["fdm_assembly", FDM_ASSEMBLY], ["fdm_after_slice", FDM_AFTER_SLICE]]) {
    const result = await client.getPrompt({ name });
    assert.equal(result.messages.length, 1, name);
    assert.deepEqual(result.messages[0], { role: "user", content: { type: "text", text } }, name);
  }
  await assert.rejects(client.getPrompt({ name: "fdm_unknown" }), /Unknown prompt/);

  const { resources } = await client.listResources();
  assert.ok(resources.some(resource => resource.uri === FDM_CAPABILITY_URI));
  const read = await client.readResource({ uri: FDM_CAPABILITY_URI });
  assert.deepEqual(read.contents, [{ uri: FDM_CAPABILITY_URI, mimeType: "text/markdown", text: FDM_CAPABILITY_GUIDANCE }]);
  assert.ok(resources.some(resource => resource.uri === FDM_FIT_URI));
  const fit = await client.readResource({ uri: FDM_FIT_URI });
  assert.deepEqual(fit.contents, [{ uri: FDM_FIT_URI, mimeType: "text/markdown", text: FDM_FIT_GUIDANCE }]);

  // Any client, not only Counterpart, learns where the guidance is.
  const instructions = client.getInstructions() ?? "";
  for (const prompt of [...DESIGN_PROMPTS, FDM_SLICING_PROMPT]) assert.ok(instructions.includes(prompt.name), prompt.name);
  assert.ok(instructions.includes(FDM_CAPABILITY_URI));
  assert.ok(instructions.includes(FDM_FIT_URI));
  assert.ok(instructions.includes("whenever a part meets a real object or another part"), "when to add the fit prompt");
  assert.ok(instructions.includes("whenever a part must flex, grip, snap, clip, spring"), "when to add the flexures prompt");
  assert.ok(instructions.includes("sufficiently specific measured capability"), "the pack's own condition for the capability reference");
  assert.ok(instructions.includes("before presenting the manufacturing recommendation"), "the review comes before the recommendation");
});

test("the guidance keeps the prompt pack's opening and judgement, with no numeric bans added", () => {
  assert.match(FDM_CORE, /^Design the finished object the user wants, with the manufacturing plan as part of the design\./);
  assert.match(FDM_CORE, /A 45-degree threshold is not a universal support requirement/);
  // When and how to research is in the everyday prompt, so every worker with web tools gets it, whatever its model.
  assert.match(FDM_CORE, /Find out before you design, and before you ask\./);
  assert.match(FDM_CORE, /This takes a few minutes, not an hour, and it works the same with any model that has web tools/);
  assert.match(FDM_CORE, /A search-result snippet is not a source\./);
  assert.match(FDM_CORE, /rephrase before concluding anything/);
  assert.match(FDM_CORE, /Never ask for something a search answers: a photo of their car's dashboard/);
  assert.match(FDM_CORE, /Without web tools, say so in the result/);
  assert.match(FDM_CORE, /confirmed without changing a prefilled number is not a measurement/);
  assert.match(FDM_CORE, /the bare product's size is not the size to design to/);
  assert.match(FDM_CORE, /There is no single fit number\./);
  assert.match(FDM_CORE, /in its stiffest, largest state/);
  assert.match(FDM_CORE, /consider a compliant mechanism first/);
  assert.match(FDM_CORE, /Keep the bending in the layer plane/);
  assert.match(FDM_CORE, /A printed screw, nut, or threaded hole is an ordinary choice/);
  assert.match(FDM_CORE, /Keep threads out of the main load path/);
  assert.match(FDM_CORE, /only when the engine's own checks or the slice show it, and give the number that shows it/);
  assert.match(FDM_ASSEMBLY, /never by scaling the screw/);
  assert.match(FDM_ASSEMBLY, /When the context supplies this printer's own thread fit observation/);
  assert.match(FDM_AFTER_SLICE, /Return a concise decision: keep, revise, or validate one specific uncertainty\./);
  assert.match(FDM_AFTER_SLICE, /A claim without its number comes out or is labelled a prediction/);
  assert.match(FDM_CAPABILITY_GUIDANCE, /`step = h \* tan\(alpha\)`/, "backticks survive the template literal");
  assert.match(FDM_CAPABILITY_GUIDANCE, /All sources inspected 3 November 2026\.$/);
});

// Nov 10: 0.5 mm a side was right for a drop-in bottle holder and would ruin a mic clamp that must grip a pole.
test("the fit guidance chooses each fit by function, keeps size, print correction and fit apart, and cites its numbers", () => {
  assert.match(FDM_FIT_GUIDANCE, /There is no single fit number\./);
  assert.match(FDM_FIT_GUIDANCE, /\*\*The object's true size\*\*.*\n2\. \*\*The print correction\*\*.*\n3\. \*\*The design fit\*\*, which comes only from what the interface has to do/);
  for (const fn of ["Rests in, or drops in and lifts out", "Slides", "Locates without rattle", "Grips so it does not slip or turn", "Clamps closed with a screw", "Snaps over", "Presses in to stay"])
    assert.ok(FDM_FIT_GUIDANCE.includes(`| ${fn} |`), fn);
  for (const mechanism of ["**Crush ribs.**", "**A split with a pinch screw.**", "**A flexure.**", "**A snap.**"]) assert.ok(FDM_FIT_GUIDANCE.includes(mechanism), mechanism);
  assert.match(FDM_FIT_GUIDANCE, /do not answer with a better number/);
  assert.match(FDM_FIT_GUIDANCE, /starting points tied to a function, a feature size and a 0\.4 mm nozzle/);
  assert.match(FDM_FIT_GUIDANCE, /The person's result \("did it fit\?"\) corrects them/);
  assert.match(FDM_FIT_GUIDANCE, /creeps under a constant load/);
  assert.match(FDM_FIT_GUIDANCE, /must work in its stiffest, largest state/);
  assert.match(FDM_FIT_GUIDANCE, /This printer's own readings come first/);
  assert.match(FDM_FIT_GUIDANCE, /In the result, give each interface its function/);
  assert.match(FDM_FIT_GUIDANCE, /app priors?, not (values from )?a (cited|sourced)/, "the uncited bands are labelled as priors");
  // Every citation marker used in the text has a source entry, and every source is used.
  const cited = new Set(FDM_FIT_GUIDANCE.split("## Sources")[0].match(/\[F\d+\]/g));
  const listed = new Set(FDM_FIT_GUIDANCE.split("## Sources")[1].match(/^\[F\d+\]/gm));
  assert.deepEqual([...cited].sort(), [...listed].sort());
  assert.match(FDM_FIT_GUIDANCE, /All sources inspected 10 November 2026\.$/);
});

test("the flexures guidance chooses strain by duty, keeps bending in-plane, and prefers observed values", () => {
  assert.match(FDM_FLEXURES, /one bending piece replaces rigid jaws, a hinge and a clamp bolt/);
  assert.match(FDM_FLEXURES, /A long leaf, band or arch spreads strain over its length/);
  assert.match(FDM_FLEXURES, /hard stop just past the working stroke/);
  assert.match(FDM_FLEXURES, /Judge bite at the opening the object actually forces/);
  assert.match(FDM_FLEXURES, /Keep the bending in the layer plane\./);
  assert.match(FDM_FLEXURES, /Choose strain by duty first, then material/);
  assert.match(FDM_FLEXURES, /held bent for months at room temperature/);
  assert.match(FDM_FLEXURES, /survived 3\.3% once and ten times/);
  assert.match(FDM_FLEXURES, /are not printed fracture limits/);
  assert.match(FDM_FLEXURES, /When the context supplies this printer's own observed values/);
  assert.match(FDM_FLEXURES, /sun-parked dashboard has been documented around 70 C/);
  assert.match(FDM_FLEXURES, /A force without its opening, or a strain without its duty, is not yet a claim/);
});

test("fdm_slicing says how the configured slicer orients, makes supports and checks a slice", async t => {
  const bambu = await server(t, { PRINTER_TYPE: "bambu", SLICER_TYPE: "bambustudio" });
  const text = (await bambu.getPrompt({ name: "fdm_slicing" })).messages[0].content.text;
  assert.equal(text, slicingGuidance("bambustudio", { supports: true, orient: true }));
  assert.match(text, /Its slicer is Bambu Studio\./);
  assert.match(text, /Bambu Studio's own auto-orient .* keeps overhang area low; it does not check cantilevers/);
  assert.match(text, /set enable_support on every slice_stl call/);
  assert.match(text, /left out, the process preset's own setting applies/);
  // print_3mf's auto-slice takes no support settings: the supports a checkpoint checked reach a print only by slicing it the same way.
  assert.match(text, /print the sliced file itself, or slice the print with slice_stl and the same enable_support and support_type/);
  assert.doesNotMatch(text, /only the print's own request/);
  assert.match(text, /slicer_result/);

  const prusa = await server(t, { PRINTER_TYPE: "octoprint", SLICER_TYPE: "prusaslicer" });
  const other = (await prusa.getPrompt({ name: "fdm_slicing" })).messages[0].content.text;
  assert.match(other, /PrusaSlicer doesn't auto-orient here/);
  assert.match(other, /PrusaSlicer takes no support settings from slice_stl here: whether it generates supports is its configured profile's own setting/);
  assert.doesNotMatch(other, /generates none|Model any support/, "a support-enabled profile still generates supports");
  assert.doesNotMatch(other, /Bambu Studio|enable_support true/, "no other slicer's behaviour");

  // Generic OrcaSlicer takes the support keys but doesn't orient (capabilities.slicing says the same).
  const orca = await server(t, { PRINTER_TYPE: "octoprint", SLICER_TYPE: "orcaslicer" });
  const orcaText = (await orca.getPrompt({ name: "fdm_slicing" })).messages[0].content.text;
  assert.match(orcaText, /OrcaSlicer doesn't auto-orient here/);
  assert.match(orcaText, /set enable_support on every slice_stl call/);
});
