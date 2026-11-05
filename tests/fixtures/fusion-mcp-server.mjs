// A stdio MCP peer that answers like faust-machines/fusion360-mcp-server@19b9f1e95192 (the fork the bridge pins adds document binding).
// Text formats were recorded from that commit's --mode mock (KAN-216): success is
// "**<tool>** OK" then "  key: value" lines; failures are "**<tool>** ERROR (<KIND>)"
// with isError. It never imports Fusion or executes received Python.
import fs from "node:fs";
import readline from "node:readline";

const [mode = "normal", logPath] = process.argv.slice(2);
const log = (value) => logPath && fs.appendFileSync(logPath, `${JSON.stringify(value)}\n`);
const send = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
const ok = (name, fields) => ({ content: [{ type: "text", text: [`**${name}** OK`, ...Object.entries(fields).map(([k, v]) => `  ${k}: ${v}`)].join("\n") }], isError: false });
const error = (name, kind, message) => ({ content: [{ type: "text", text: `**${name}** ERROR (${kind})\n  ${message}\n  hints:\n    - Open or create a design in Fusion before calling mutation tools.` }], isError: true });
const tools = [
  { name: "ping", description: "Health check — returns immediately without touching Fusion API", inputSchema: { type: "object", properties: {} } },
  { name: "execute_code", description: "Run arbitrary Python in Fusion 360.", inputSchema: { type: "object", required: ["code"], properties: { code: { type: "string" } } } },
  { name: "export_stl", description: "Export a named body as an STL file", inputSchema: { type: "object", required: ["body_name"], properties: { body_name: { type: "string" }, file_path: { type: "string" } } } },
  { name: "export_f3d", description: "Export the design as a native Fusion 360 archive (.f3d)", inputSchema: { type: "object", properties: { file_path: { type: "string" } } } },
  { name: "create_sketch", description: "Create a new sketch on a plane", inputSchema: { type: "object", properties: { plane: { type: "string", enum: ["xy", "xz", "yz"] } } } },
];
log({ event: "spawn", pid: process.pid, printerSecretPresent: Boolean(process.env.BAMBU_TOKEN || process.env.API_KEY), fusionHost: process.env.FUSION_MCP_HOST ?? null, fusionPort: process.env.FUSION_MCP_PORT ?? null });

/** One-triangle binary STL spanning 20 x 10 x 5 (mm), or 2 x 1 x 0.5 when written in cm. */
function stl(scale) {
  const bytes = Buffer.alloc(134);
  bytes.writeUInt32LE(1, 80);
  [[0, 0, 0], [20, 0, 0], [0, 10, 5]].forEach((vertex, index) => vertex.forEach((value, axis) => bytes.writeFloatLE(value * scale, 96 + index * 12 + axis * 4)));
  return bytes;
}

function call(name, args) {
  if (name === "ping") return mode === "addin-down" ? error(name, "CONNECTION", "Not connected to Fusion 360.") : ok(name, { status: "pong" });
  if (name === "create_sketch") return mode === "no-design" ? error(name, "NO_ACTIVE_DESIGN", "No active design") : ok(name, { sketch_name: "Sketch1", plane: args.plane ?? "xy" });
  if (mode === "no-design") return error(name, "NO_ACTIVE_DESIGN", "No active design");
  if (name === "export_stl") {
    if (args.body_name !== "Bracket" && args.body_name !== "Lid") return error(name, "NOT_FOUND", `Body '${args.body_name}' not found`);
    if (mode !== "no-files") fs.writeFileSync(args.file_path, stl(mode === "stl-cm" ? 0.1 : 1));
    return ok(name, { exported: "True", body: args.body_name, file_path: args.file_path });
  }
  if (name === "export_f3d") {
    if (mode !== "no-files") fs.writeFileSync(args.file_path, Buffer.from("PK\u0003\u0004 mock f3d archive"));
    return ok(name, { exported: "True", file_path: args.file_path });
  }
  if (name === "execute_code") {
    const code = String(args.code);
    let result = "None";
    if (code.includes("'mcp3d_new_design'")) result = JSON.stringify({ mcp3d_new_design: true, document: "Untitled", parametric: true });
    if (code.includes("'mcp3d_bodies'")) {
      // The probe must list export_stl's own population: root bodies, then occurrence proxies, hidden or not.
      if (!code.includes("component.bRepBodies") || !code.includes("component.allOccurrences")) throw new Error("probe does not match _body_by_name");
      const bodies = [{ name: "Bracket", solid: true, visible: true, size_cm: [2, 1, 0.5] }, { name: "Sketch body", solid: false, visible: true, size_cm: [1, 1, 0] }];
      if (mode === "two-bodies") bodies.push({ name: "Lid", solid: true, visible: true, size_cm: [2, 1, 0.2] });
      if (mode === "hidden-duplicate") bodies.unshift({ name: "Bracket", solid: true, visible: false, size_cm: [9, 9, 9] });
      result = JSON.stringify({ mcp3d_bodies: true, bodies });
    }
    if (code.includes("'mcp3d_parameters'")) result = JSON.stringify({ mcp3d_parameters: true, parameters: [{ name: "width", value: 2, expression: "20 mm", unit: "mm", comment: "" }], count: 1 });
    // The real add-in returns {executed, result, output}; the server prints the deltas below.
    return { content: [{ type: "text", text: `**execute_code** OK\n  executed: True\n  result: ${result}\n  output: \n  deltas:\n    body_count: 1 → 1 (Δ+0)` }], isError: false };
  }
  return error(name, "UNKNOWN", `Unknown tool: ${name}`);
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  log({ method: request.method, name: request.params?.name, arguments: request.params?.arguments });
  if (request.method === "initialize") {
    return send(request.id, { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fusion360-mcp-server", version: "1.30.0" } });
  }
  if (request.method === "tools/list") return send(request.id, { tools });
  if (request.method === "tools/call") return send(request.id, call(request.params.name, request.params.arguments ?? {}));
});
