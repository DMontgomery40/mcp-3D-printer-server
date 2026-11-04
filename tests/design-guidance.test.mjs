import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DESIGN_PROMPTS, FDM_AFTER_SLICE, FDM_ASSEMBLY, FDM_CAPABILITY_GUIDANCE, FDM_CAPABILITY_URI, FDM_CORE, FDM_MULTICOLOR } from "../dist/design-guidance.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function server(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "design-guidance-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "dist/index.js")],
    cwd: directory,
    env: { ...process.env, MCP_TRANSPORT: "stdio", BAMBU_MODEL: "p1s", PRINTER_HOST: "127.0.0.1", BAMBU_SERIAL: "01PTESTSERIAL", BAMBU_TOKEN: "printer-secret-never-returned" },
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
  assert.deepEqual(prompts.map(prompt => prompt.name), ["fdm_design", "fdm_multicolor", "fdm_assembly", "fdm_after_slice"]);
  for (const [name, text] of [["fdm_design", FDM_CORE], ["fdm_multicolor", FDM_MULTICOLOR], ["fdm_assembly", FDM_ASSEMBLY], ["fdm_after_slice", FDM_AFTER_SLICE]]) {
    const result = await client.getPrompt({ name });
    assert.equal(result.messages.length, 1, name);
    assert.deepEqual(result.messages[0], { role: "user", content: { type: "text", text } }, name);
  }
  await assert.rejects(client.getPrompt({ name: "fdm_unknown" }), /Unknown prompt/);

  const { resources } = await client.listResources();
  assert.ok(resources.some(resource => resource.uri === FDM_CAPABILITY_URI));
  const read = await client.readResource({ uri: FDM_CAPABILITY_URI });
  assert.deepEqual(read.contents, [{ uri: FDM_CAPABILITY_URI, mimeType: "text/markdown", text: FDM_CAPABILITY_GUIDANCE }]);

  // Any client, not only Counterpart, learns where the guidance is.
  const instructions = client.getInstructions() ?? "";
  for (const prompt of DESIGN_PROMPTS) assert.match(instructions, new RegExp(prompt.name));
  assert.match(instructions, new RegExp(FDM_CAPABILITY_URI));
});

test("the guidance is the prompt pack's own words, with no numeric bans added", () => {
  assert.match(FDM_CORE, /^Design the finished object the user wants, with the manufacturing plan as part of the design\./);
  assert.match(FDM_CORE, /A 45-degree threshold is not a universal support requirement/);
  assert.match(FDM_AFTER_SLICE, /Return a concise decision: keep, revise, or validate one specific uncertainty\./);
  assert.match(FDM_CAPABILITY_GUIDANCE, /`step = h \* tan\(alpha\)`/, "backticks survive the template literal");
  assert.match(FDM_CAPABILITY_GUIDANCE, /All sources inspected 3 November 2026\.$/);
});
