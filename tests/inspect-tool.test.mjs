import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import JSZip from 'jszip';

const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const preload = fileURLToPath(new URL('./fixtures/inspection-no-network.mjs', import.meta.url));
const header = (material = 'PLA') => `; printer_model = Bambu Lab P1S\n; nozzle_diameter = 0.4\n; filament_type = ${material}\n; curr_bed_type = Textured PEI Plate\n`;
async function server(t) {
  const dir = await mkdtemp(join(tmpdir(), 'offline-mcp-inspection-'));
  const networkLog = join(dir, 'network.log');
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', preload, entry], cwd: dir, stderr: 'pipe',
    env: { HOME: dir, MCP_TRANSPORT: 'stdio', BAMBU_MODEL: '', BAMBU_PRINTER_MODEL: '',
      PRINTER_TYPE: 'bambu', BAMBU_PRINTER_HOST: '127.0.0.1', PRINTER_HOST: '127.0.0.1', BAMBU_SERIAL: '', BAMBU_PRINTER_SERIAL: '',
      BAMBU_TOKEN: '', BAMBU_PRINTER_ACCESS_TOKEN: '', BAMBU_REQUIRE_CONFIRMATION: '1', INSPECTION_NETWORK_LOG: networkLog } });
  transport.stderr.on('data', () => {});
  const client = new Client({ name: 'offline-inspection-test', version: '1' }, { capabilities: {} });
  t.after(async () => { await client.close(); await transport.close(); await rm(dir, { recursive: true, force: true }); });
  await client.connect(transport);
  const call = args => client.callTool({ name: 'inspect_print_file', arguments: args });
  const decode = result => result.structuredContent ?? JSON.parse(result.content[0].text);
  return { dir, call, decode, client, networkLog };
}
async function raw(s, text = header() + 'M104 S230\nM140 S60\nG1 X20 Y20 E1\n', name = 'job.gcode') {
  const path = join(s.dir, name); await writeFile(path, text); return { path, bytes: Buffer.from(text) };
}
async function archive(s, entries) {
  const zip = new JSZip(); for (const [name, value] of Object.entries(entries)) zip.file(name, typeof value === 'string' ? value : JSON.stringify(value));
  const bytes = await zip.generateAsync({ type: 'nodebuffer' }); const path = join(s.dir, 'job.gcode.3mf'); await writeFile(path, bytes); return { path, bytes };
}

test('advertises additive read-only inspection with explicit required model', async t => {
  const s = await server(t); const tools = (await s.client.listTools()).tools;
  const tool = tools.find(x => x.name === 'inspect_print_file'); assert.ok(tool);
  assert.deepEqual(tool.inputSchema.required, ['file_path', 'bambu_model']);
  assert.equal(tool.inputSchema.properties.plate_index.minimum, 0);
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.destructiveHint, false);
  assert.ok(tools.some(x => x.name === 'print_3mf'));
  await assert.rejects(access(s.networkLog), { code: 'ENOENT' });
});

test('inspect_print_file returns a generic versioned file-only receipt for exact raw bytes without network I/O', async t => {
  const s = await server(t); const f = await raw(s);
  const result = await s.call({ file_path: f.path, bambu_model: 'p1s', nozzle_diameters: [0.4], plate_index: 0, bed_type: 'textured_plate' });
  assert.equal(result.isError, undefined); const r = s.decode(result);
  assert.equal(r.receipt_version, '1'); assert.equal(r.evidence, 'file-only'); assert.equal(r.dispatch_authorized, false);
  assert.deepEqual(r.artifact, { sha256: createHash('sha256').update(f.bytes).digest('hex'), byte_length: f.bytes.length, file_format: 'gcode' });
  assert.equal(r.selection.plate_index, 0); assert.equal(r.selection.bambu_model, 'p1s');
  assert.deepEqual(r.selection.nozzle_diameters, [0.4]); assert.equal(r.selection.bed_type, 'textured_plate');
  assert.equal(r.inspection.sha256, r.artifact.sha256); assert.equal(r.inspection.maxNozzleTemperature, 230);
  assert.equal(r.inspection.maxBedTemperature, 60); assert.deepEqual(r.inspection.materials, ['PLA']);
  assert.deepEqual(r.inspection.nozzleDiameters, [0.4]); assert.equal(r.printer_state, undefined);
  await writeFile(f.path, 'changed after receipt'); assert.notEqual(createHash('sha256').update(await readFile(f.path)).digest('hex'), r.artifact.sha256);
  assert.ok(!JSON.stringify(r).includes(s.dir), 'ephemeral snapshot/source paths are not a reusable dispatch capability');
  await assert.rejects(access(s.networkLog), { code: 'ENOENT' });
});

test('selected 3MF plate is bound to the receipt; another unsafe plate is not mistaken for the selected one', async t => {
  const s = await server(t); const f = await archive(s, {
    'Metadata/plate_1.gcode': header('PLA;PETG') + 'M104 S400\n',
    'Metadata/plate_2.gcode': header('PLA;PETG') + 'T1\nM104 S250\nM140 S60\nG1 X20 Y20 E1\n',
    'Metadata/plate_2.json': { filament_ids: [1] },
  });
  const r = s.decode(await s.call({ file_path: f.path, bambu_model: 'p1s', plate_index: 1 }));
  assert.equal(r.receipt_version, '1'); assert.equal(r.selection.plate_index, 1);
  assert.equal(r.inspection.plateInternalPath, 'Metadata/plate_2.gcode');
  assert.deepEqual(r.inspection.usedFilamentPositions, [1]); assert.equal(r.artifact.byte_length, f.bytes.length);
  assert.equal(r.artifact.sha256, createHash('sha256').update(f.bytes).digest('hex'));
  for (const plate_index of [0, 2]) assert.equal((await s.call({ file_path: f.path, bambu_model: 'p1s', plate_index })).isError, true);
  await assert.rejects(access(s.networkLog), { code: 'ENOENT' });
});

test('wrong model/nozzles/bed and unsafe material temperatures fail through the existing inspector', async t => {
  const s = await server(t); const f = await raw(s);
  for (const selection of [{ bambu_model: 'a1' }, { nozzle_diameters: [0.6] }, { bed_type: 'hot_plate' }]) {
    assert.equal((await s.call({ file_path: f.path, bambu_model: 'p1s', ...selection })).isError, true);
  }
  const hot = await raw(s, header('PLA') + 'M104 S290\n', 'hot.gcode');
  const result = await s.call({ file_path: hot.path, bambu_model: 'p1s' });
  assert.equal(result.isError, true); assert.match(s.decode(result).message, /PLA|material|temperature/i);
  await assert.rejects(access(s.networkLog), { code: 'ENOENT' });
});

test('schema violations reject at runtime without default model inference or hidden overrides', async t => {
  const s = await server(t); const f = await raw(s);
  for (const args of [
    { file_path: f.path }, { file_path: f.path, bambu_model: '' },
    { file_path: f.path, bambu_model: 'p1s', plate_index: -1 }, { file_path: f.path, bambu_model: 'p1s', plate_index: 0.5 },
    { file_path: f.path, bambu_model: 'p1s', plate_index: '0' },
    { file_path: f.path, bambu_model: 'p1s', nozzle_diameters: ['0.4'] },
    { file_path: f.path, bambu_model: 'p1s', nozzle_diameters: [] },
    { file_path: f.path, bambu_model: 'p1s', bed_type: 1 },
    { file_path: f.path, bambu_model: 'p1s', bridge_command: 'never-run' },
    { file_path: f.path, bambu_model: 'p1s', host: 'never-contact' },
  ]) assert.equal((await s.call(args)).isError, true, JSON.stringify(args));
  await assert.rejects(access(s.networkLog), { code: 'ENOENT' });
});

test('unsliced/checksum/case-colliding archives never return inspection evidence', async t => {
  const s = await server(t);
  const checksum = await raw(s, 'not G-code', 'job.gcode.md5');
  assert.equal((await s.call({ file_path: checksum.path, bambu_model: 'p1s' })).isError, true);
  const unsliced = await archive(s, { 'Metadata/plate_1.gcode.md5': 'checksum only' });
  assert.equal((await s.call({ file_path: unsliced.path, bambu_model: 'p1s' })).isError, true);
  const duplicate = await archive(s, { 'Metadata/plate_1.gcode': header() + 'M104 S220\n', 'metadata/PLATE_1.GCODE': header() + 'M104 S400\n' });
  assert.equal((await s.call({ file_path: duplicate.path, bambu_model: 'p1s' })).isError, true);
  await assert.rejects(access(s.networkLog), { code: 'ENOENT' });
});

