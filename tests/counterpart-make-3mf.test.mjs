// counterpart_make_3mf (ported from bambu-printer-mcp): STL parts combined into one 3MF assembly, one filament
// per part. Unit tests call the module; the MCP test runs the built server over stdio. No printer is contacted.
import { trackedMkdtempSync } from "./support/temp.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import JSZip from "jszip";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { makeCounterpart3mf } from "../dist/counterpart/make-3mf.js";
import { MAKE_3MF_OUTPUT_SCHEMA } from "../dist/counterpart/contract.js";

// The plate centre follows BAMBU_MODEL; a local .env must not supply one (AGENTS.md).
process.env.BAMBU_MODEL = "";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const validator = new AjvJsonSchemaValidator();
const validate = (schema, value) => {
  const result = validator.getValidator(schema)(value);
  assert.ok(result.valid, result.errorMessage);
};

function boxStl(min, max) {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const t = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const buffer = Buffer.alloc(84 + t.length * 50);
  buffer.writeUInt32LE(t.length, 80);
  t.forEach((triangle, index) => {
    let offset = 84 + index * 50 + 12;
    for (const vertex of triangle) for (const value of v[vertex]) { buffer.writeFloatLE(value, offset); offset += 4; }
  });
  return buffer;
}

function parts(t) {
  const directory = trackedMkdtempSync(path.join(os.tmpdir(), "counterpart-3mf-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const base = path.join(directory, "base.stl"), top = path.join(directory, "top.stl"), side = path.join(directory, "side.stl");
  fs.writeFileSync(base, boxStl([-10, -10, 5], [10, 10, 15]));
  fs.writeFileSync(top, boxStl([-5, -5, 15], [5, 5, 20]));
  fs.writeFileSync(side, boxStl([10, -2.5, 5], [12.25, 2.5, 7.5]));
  return { directory, base, top, side };
}

async function readModel(file) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  return { model: await zip.file("3D/3dmodel.model").async("string"), settings: await zip.file("Metadata/model_settings.config").async("string"), names: Object.keys(zip.files) };
}

test("counterpart_make_3mf writes one assembly with one part per STL and each part's filament", async t => {
  const f = parts(t);
  const out = path.join(f.directory, "assembly.3mf");
  const result = await makeCounterpart3mf({ out_path: out, parts: [{ stl_path: f.base, name: "Body" }, { stl_path: f.top, name: "Lid & <cap>" }, { stl_path: f.side, name: "Tab", filament: 2 }] });
  validate(MAKE_3MF_OUTPUT_SCHEMA, result);
  assert.deepEqual(result, { contract: "counterpart/1", path: fs.realpathSync(out), objects: 1, filaments: 2, parts: [
    { name: "Body", stl_path: f.base, filament: 1, triangles: 12 }, { name: "Lid & <cap>", stl_path: f.top, filament: 2, triangles: 12 }, { name: "Tab", stl_path: f.side, filament: 2, triangles: 12 }] });
  const { model, settings, names } = await readModel(out);
  assert.deepEqual(names.filter(name => !name.endsWith("/")).sort(), ["3D/3dmodel.model", "Metadata/model_settings.config", "[Content_Types].xml", "_rels/.rels"]);
  // Object count: three mesh parts, one assembly referencing them, one build item.
  assert.equal((model.match(/<mesh>/g) ?? []).length, 3);
  assert.equal((model.match(/<component objectid="\d+"\/>/g) ?? []).length, 3);
  assert.equal((model.match(/<item /g) ?? []).length, 1);
  assert.match(model, /<object id="4" type="model">\s*<components>/);
  assert.match(model, /<item objectid="4" /);
  // Meshes are indexed: eight shared vertices per box, never a triangle soup.
  assert.equal((model.match(/<vertex /g) ?? []).length, 24);
  assert.equal((settings.match(/<part id="\d" subtype="normal_part">/g) ?? []).length, 3);
  assert.deepEqual([...settings.matchAll(/<part id="(\d)"[\s\S]*?key="name" value="([^"]*)"[\s\S]*?key="extruder" value="(\d+)"/g)].map(match => match.slice(1)),
    [["1", "Body", "1"], ["2", "Lid &amp; &lt;cap&gt;", "2"], ["3", "Tab", "2"]]);
});

test("counterpart_make_3mf keeps parts' relative positions with one shared plate transform", async t => {
  const f = parts(t);
  const out = path.join(f.directory, "assembly.3mf");
  await makeCounterpart3mf({ out_path: out, parts: [{ stl_path: f.base, name: "Body" }, { stl_path: f.side, name: "Tab" }] });
  const { model } = await readModel(out);
  // Exact source coordinates, including a non-integer one.
  assert.match(model, /<vertex x="12\.25" y="-2\.5" z="7\.5"\/>/);
  assert.match(model, /<vertex x="-10" y="-10" z="5"\/>/);
  // Footprint x -10..12.25 and y -10..10 centred on the default 256 mm plate; the lowest point (z 5) on the bed.
  const transform = /<item objectid="3" transform="([^"]+)"/.exec(model)[1].split(" ").map(Number);
  assert.deepEqual(transform, [1, 0, 0, 0, 1, 0, 0, 0, 1, 128 - 1.125, 128, -5]);
});

test("counterpart_make_3mf refuses overwrites, missing directories, bad parts and unknown arguments", async t => {
  const f = parts(t);
  const existing = path.join(f.directory, "existing.3mf");
  fs.writeFileSync(existing, "keep");
  const part = { stl_path: f.base, name: "Body" };
  await assert.rejects(makeCounterpart3mf({ out_path: existing, parts: [part] }), /already exists/);
  assert.equal(fs.readFileSync(existing, "utf8"), "keep");
  await assert.rejects(makeCounterpart3mf({ out_path: path.join(f.directory, "missing", "a.3mf"), parts: [part] }), /parent directory/);
  await assert.rejects(makeCounterpart3mf({ out_path: path.join(f.directory, "a.stl"), parts: [part] }), /\.3mf/);
  await assert.rejects(makeCounterpart3mf({ out_path: path.join(f.directory, "a.3mf"), parts: [] }), /1 to 64/);
  await assert.rejects(makeCounterpart3mf({ out_path: path.join(f.directory, "a.3mf"), parts: [{ ...part, filament: 0 }] }), /filament/);
  await assert.rejects(makeCounterpart3mf({ out_path: path.join(f.directory, "a.3mf"), parts: [{ ...part, colour: "red" }] }), /accepts only/);
  await assert.rejects(makeCounterpart3mf({ out_path: path.join(f.directory, "a.3mf"), parts: [{ stl_path: f.base }] }), /name/);
  await assert.rejects(makeCounterpart3mf({ out_path: path.join(f.directory, "a.3mf"), parts: [part], arrange: true }), /accepts only/);
  const broken = path.join(f.directory, "broken.stl");
  fs.writeFileSync(broken, Buffer.alloc(84));
  await assert.rejects(makeCounterpart3mf({ out_path: path.join(f.directory, "a.3mf"), parts: [{ stl_path: broken, name: "Broken" }] }), /no valid finite triangle mesh/);
  await assert.rejects(makeCounterpart3mf({ out_path: path.join(f.directory, "a.3mf"), parts: [{ stl_path: path.join(f.directory, "none.stl"), name: "None" }] }), /does not exist/);
  assert.deepEqual(fs.readdirSync(f.directory).filter(name => name.endsWith(".3mf")).sort(), ["existing.3mf"], "nothing is left behind");
});

test("counterpart_make_3mf centres the assembly on the configured Bambu model's bed", async t => {
  const f = parts(t);
  const out = path.join(f.directory, "h2d.3mf");
  process.env.BAMBU_MODEL = "h2d";
  try {
    await makeCounterpart3mf({ out_path: out, parts: [{ stl_path: f.base, name: "Body" }] });
  } finally {
    process.env.BAMBU_MODEL = "";
  }
  const { model } = await readModel(out);
  const transform = /<item objectid="2" transform="([^"]+)"/.exec(model)[1].split(" ").map(Number);
  assert.deepEqual(transform.slice(9), [350 / 2, 320 / 2, -5]);
});

async function server(t) {
  const directory = trackedMkdtempSync(path.join(os.tmpdir(), "counterpart-make-3mf-mcp-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "dist/index.js")],
    cwd: directory, // outside the repo, so a developer .env cannot change the configuration
    env: { PATH: process.env.PATH, HOME: path.join(directory, "home"), MCP_TRANSPORT: "stdio", TEMP_DIR: directory, PRINTER_HOST: "127.0.0.1", PRINTER_TYPE: "octoprint", BAMBU_MODEL: "" },
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {});
  const client = new Client({ name: "counterpart-make-3mf-tests", version: "1" });
  t.after(async () => { await client.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await client.connect(transport);
  // Listing caches each outputSchema, so callTool below validates structuredContent.
  const { tools } = await client.listTools();
  return { client, tools, directory };
}

test("counterpart_make_3mf over MCP declares its outputSchema and returns structuredContent with the same JSON as text", async t => {
  const { client, tools, directory } = await server(t);
  assert.deepEqual(tools.find(tool => tool.name === "counterpart_make_3mf")?.outputSchema, JSON.parse(JSON.stringify(MAKE_3MF_OUTPUT_SCHEMA)));
  const stl = path.join(directory, "body.stl");
  fs.writeFileSync(stl, boxStl([0, 0, 0], [10, 10, 10]));
  const out = path.join(directory, "body.3mf");
  const result = await client.callTool({ name: "counterpart_make_3mf", arguments: { out_path: out, parts: [{ stl_path: stl, name: "Body" }] } });
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.equal(result.structuredContent.path, fs.realpathSync(out));
  assert.equal(result.structuredContent.contract, "counterpart/1");
});

test("counterpart errors are text only, so an MCP client's outputSchema check cannot hide them", async t => {
  const { client, directory } = await server(t);
  const result = await client.callTool({ name: "counterpart_make_3mf", arguments: { out_path: path.join(directory, "missing", "a.3mf"), parts: [{ stl_path: "x.stl", name: "x" }] } });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent, undefined);
  assert.match(result.content[0].text, /parent directory/);
  // Other tools keep their structured error for existing clients.
  const other = await client.callTool({ name: "lay_flat", arguments: {} });
  assert.equal(other.isError, true);
  assert.equal(other.structuredContent.status, "error");
});
