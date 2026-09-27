// A stdio MCP peer; never imports Blender or executes received Python.
import fs from "node:fs";
import readline from "node:readline";

const [mode = "normal", logPath] = process.argv.slice(2);
const log = (value) => logPath && fs.appendFileSync(logPath, `${JSON.stringify(value)}\n`);
const send = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
const fail = (id, code, message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
const sceneTool = { name: "get_scene_info", inputSchema: { type: "object", properties: { user_prompt: { type: "string" } }, required: ["user_prompt"] } };
const codeTool = { name: "execute_blender_code", inputSchema: { type: "object", properties: { code: { type: "string" }, user_prompt: { type: "string" } }, required: ["code"] } };
const reader = readline.createInterface({ input: process.stdin });
log({ event: "spawn", pid: process.pid, printerTokenPresent: Boolean(process.env.BAMBU_TOKEN) });
reader.on("line", (line) => {
  const request = JSON.parse(line);
  log(request);
  if (request.method === "initialize") {
    if (mode === "startup-timeout") return;
    return send(request.id, { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "mock-blender", version: "1" } });
  }
  if (request.method === "tools/list") {
    if (mode === "list-timeout") return;
    if (mode === "list-error") return fail(request.id, -32603, "list failed secret-should-not-leak");
    if (mode === "missing-tool") return send(request.id, { tools: [sceneTool] });
    return send(request.id, request.params?.cursor ? { tools: [codeTool] } : { tools: [sceneTool], nextCursor: "page-two" });
  }
  if (request.method !== "tools/call") return;
  if (mode === "call-timeout") return;
  if (mode === "protocol-error") return fail(request.id, -32602, "failed secret-should-not-leak");
  if (mode === "tool-error") return send(request.id, { content: [{ type: "text", text: "Blender operation failed" }], isError: true, _meta: { details: "kept" } });
  if (mode === "text-error") return send(request.id, { content: [{ type: "text", text: "Error executing code: Blender is not connected" }] });
  if (mode === "scene-text-error") return send(request.id, { content: [{ type: "text", text: "Error getting scene info: Could not connect to Blender" }] });
  const args = request.params.arguments;
  if (request.params.name === "get_scene_info") return send(request.id, { content: [{ type: "text", text: '{"objects":[]}' }] });
  if (typeof args?.code !== "string") return fail(request.id, -32602, "code required");
  const planLine = args.code.split("\n").find((line) => line.startsWith("# BAMBU_EDIT_PLAN "));
  if (planLine) {
    const plan = JSON.parse(planLine.slice("# BAMBU_EDIT_PLAN ".length));
    if (mode !== "no-output") {
      // One triangle in binary STL. A malformed file exercises output validation.
      const stl = Buffer.alloc(134);
      stl.writeUInt32LE(1, 80);
      stl.writeFloatLE(1, 108);
      stl.writeFloatLE(1, 124);
      fs.writeFileSync(plan.stagedOutputPath, mode === "bad-output" ? "not an STL" : stl);
    }
    if (mode === "output-race") fs.writeFileSync(plan.outputPath, "created after preflight");
    const receipt = { requestId: mode === "wrong-receipt" ? "wrong" : plan.requestId, outputPath: plan.stagedOutputPath };
    return send(request.id, { content: [{ type: "text", text: `Code executed successfully: BAMBU_STL_RESULT:${JSON.stringify(receipt)}\n` }] });
  }
  return send(request.id, {
    content: [{ type: "text", text: "Code executed successfully" }, { type: "image", mimeType: "image/png", data: "aGVsbG8=" }],
    structuredContent: { code: args.code, user_prompt: args.user_prompt },
    _meta: { source: "mock-blender" },
  });
});
reader.on("close", () => { log({ event: "closed" }); });
