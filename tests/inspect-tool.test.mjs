import {trackedMkdtemp} from './support/temp.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from './support/stdio.mjs';
import JSZip from 'jszip';

const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const preload = fileURLToPath(new URL('./fixtures/inspection-no-network.mjs', import.meta.url));
const header = (material = 'PLA') => `; printer_model = Bambu Lab P1S\n; nozzle_diameter = 0.4\n; filament_type = ${material}\n; curr_bed_type = Textured PEI Plate\n`;
async function server(t) {
  const dir = await trackedMkdtemp(join(tmpdir(), 'offline-mcp-inspection-'));
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


test("include_preview draws the exact file's G-code, never its thumbnails (the Nov 4 caliper card)", async t => {
  // 2026-11-04: the app showed a design render and the sliced file carried the designer's old plate PNGs,
  // while the G-code had lost the card's fine markings. The preview reads only the G-code.
  const { encodePng } = await import('../dist/safety/print-preview.js');
  const s = await server(t);
  const square = (x, y, size, z, e = 0.05) => [`G1 Z${z}`, `G1 X${x} Y${y}`, `G1 X${x + size} Y${y} E${e}`, `G1 X${x + size} Y${y + size} E${e}`, `G1 X${x} Y${y + size} E${e}`, `G1 X${x} Y${y} E${e}`].join('\n');
  const job = (marking) => header().replace('filament_type = PLA', 'filament_type = PLA;PLA') + 'M104 S220\nM140 S60\nG90\nM83\n'
    + '; FEATURE: Custom\nG1 X5 Y1 E2\nG1 X250 Y1 E10\n'           // start-up prime line: never drawn
    + '; CHANGE_LAYER\n; FEATURE: Outer wall\nT0\n' + square(100, 100, 40, 0.2)
    + (marking ? '\nT1\n' + square(110, 110, 10, 0.2) : '')         // a marking only the G-code knows about
    + '\n; CHANGE_LAYER\nT0\n' + square(100, 100, 40, 0.4) + '\n';
  // A thumbnail that shows the marking even when the G-code has none: a preview must not trust it.
  const staleThumbnail = encodePng(1, 1, new Uint8Array([255, 255, 0]));
  const sliced = async (marking) => archive(s, {
    'Metadata/plate_1.gcode': job(marking), 'Metadata/plate_1.png': staleThumbnail,
    'Metadata/project_settings.config': { printer_model: 'Bambu Lab P1S', nozzle_diameter: ['0.4'], filament_type: ['PLA', 'PLA'], filament_colour: ['#000000', '#FFFF00'], curr_bed_type: 'Textured PEI Plate' },
  });
  const inspect = async (path, extra = {}) => { const result = await s.call({ file_path: path, bambu_model: 'p1s', ...extra }); assert.equal(result.isError, undefined, JSON.stringify(result.content)); return s.decode(result); };
  const withMarking = await sliced(true);
  assert.equal((await inspect(withMarking.path)).preview, undefined, 'no preview unless asked: agents never get the pictures');
  const r = await inspect(withMarking.path, { include_preview: true });
  assert.equal(r.preview.artifact_sha256, r.artifact.sha256, 'the preview names the exact bytes it was drawn from');
  assert.deepEqual(r.preview.views.map(v => v.name), ['top', 'bed_side']);
  assert.deepEqual(r.preview.filaments_used, [0, 1]);
  assert.ok(r.preview.extent_mm[0] > 90 && r.preview.extent_mm[2] < 150, `the prime line is not drawn: ${r.preview.extent_mm}`);
  const yellowPixels = async (view) => {
    const { inflateSync } = await import('node:zlib');
    const png = Buffer.from(view.png_base64, 'base64');
    let offset = 8, idat = [];
    while (offset < png.length) { const len = png.readUInt32BE(offset); const type = png.toString('ascii', offset + 4, offset + 8); if (type === 'IDAT') idat.push(png.subarray(offset + 8, offset + 8 + len)); offset += 12 + len; }
    const raw = inflateSync(Buffer.concat(idat)); let count = 0;
    for (let y = 0; y < view.height; y++) for (let x = 0; x < view.width; x++) {
      const o = y * (view.width * 3 + 1) + 1 + x * 3; if (raw[o] > 200 && raw[o + 1] > 200 && raw[o + 2] < 120) count++;
    }
    return count;
  };
  const bed = r.preview.views.find(v => v.name === 'bed_side');
  assert.ok(await yellowPixels(bed) > 50, 'the marking on the bed side shows');
  const missing = await inspect((await sliced(false)).path, { include_preview: true });
  assert.equal(await yellowPixels(missing.preview.views.find(v => v.name === 'bed_side')), 0, 'a marking missing from the G-code is missing from the preview, whatever the thumbnail says');
  const bare = await archive(s, { 'Metadata/plate_1.gcode': job(true) });
  assert.ok((await inspect(bare.path, { include_preview: true })).preview, 'a sliced file with no thumbnails still previews');
});

test('the preview reads PrusaSlicer/Cura ;TYPE: features, full and radius arcs, and skips Bambu filament-change flushing', async () => {
  const { extrusionSegments } = await import('../dist/safety/print-preview.js');
  const prusa = extrusionSegments('G90\nM83\n;TYPE:Custom\nG1 X0 Y0 E5\n;TYPE:External perimeter\nG1 X10 Y10\nG1 X20 Y10 E1\n');
  assert.equal(prusa.segments.length, 1, 'PrusaSlicer features are read; its start-up purge is not drawn');
  const bare = extrusionSegments('G90\nM83\nG1 X10 Y10\nG1 X20 Y10 E1\n');
  assert.equal(bare.segments.length, 1, 'G-code naming no features is drawn whole');
  const circle = extrusionSegments('G90\nM83\n; FEATURE: Outer wall\nG1 X20 Y10\nG2 X20 Y10 I-10 J0 E3\n').segments;
  const xs = circle.map(s => s.x1);
  assert.ok(circle.length > 10 && Math.min(...xs) < 1 && Math.max(...xs) > 19, 'a full-circle arc is drawn round');
  const radius = extrusionSegments('G90\nM83\n; FEATURE: Outer wall\nG1 X0 Y0\nG3 X10 Y0 R5 E1\n').segments;
  assert.ok(radius.length > 2 && Math.min(...radius.map(s => s.y1)) < -4, 'a radius arc bulges, it is not a straight line');
  const flush = extrusionSegments('G90\nM83\n; FEATURE: Outer wall\nG1 X10 Y10\nG1 X20 Y10 E1\nM620 S1A\nT1\nG1 X-20 Y200 E30\nM621 S1A\nG1 X20 Y10\nG1 X20 Y20 E1\n').segments;
  assert.deepEqual(flush.map(s => s.tool), [0, 1], 'the flush inside M620..M621 is not part of the print; the next filament is');
  assert.ok(flush.every(s => s.x0 >= 0 && s.x1 >= 0));
});

test('the preview reads the G-code syntax file inspection accepts: compact, numbered, zero-padded and signed moves', async () => {
  const { extrusionSegments } = await import('../dist/safety/print-preview.js');
  const spaced = extrusionSegments('G90\nM83\n; FEATURE: Outer wall\nG1 X10 Y10\nG1 X20 Y20 E1\n').segments;
  for (const [name, gcode] of [
    ['compact', 'G90\nM83\n; FEATURE: Outer wall\nG1X10Y10\nG1X20Y20E1\n'],
    ['numbered with checksum', 'N1 G90*12\nN2 M83\n; FEATURE: Outer wall\nN3 G1 X10 Y10*45\nN4 G1 X20 Y20 E1*77\n'],
    ['zero-padded', 'G90\nM83\n; FEATURE: Outer wall\nG01 X10 Y10\nG01 X20 Y20 E1\n'],
    ['signed', 'G90\nM83\n; FEATURE: Outer wall\nG1 X+10 Y+10\nG1 X+20 Y+20 E+1\n'],
    ['tool word touching nothing', 'G90\nM83\n; FEATURE: Outer wall\nT0\nG1 X10 Y10\nG1 X20 Y20 E1\n'],
  ]) assert.deepEqual(extrusionSegments(gcode).segments, spaced, name);
});

test('a later filament on the same layer shows over an earlier one at any layer height (no float32 depth)', async () => {
  const { renderPrintPreview } = await import('../dist/safety/print-preview.js');
  const { inflateSync } = await import('node:zlib');
  const gcode = 'G90\nM83\n; FEATURE: Outer wall\nT0\nG1 Z0.2\nG1 X10 Y10\nG1 X30 Y10 E1\nT1\nG1 X10 Y10\nG1 X30 Y10 E1\n';
  const top = renderPrintPreview(gcode, ['#FF0000', '#0000FF']).views.find(v => v.name === 'top');
  const png = Buffer.from(top.png_base64, 'base64'); let offset = 8; const idat = [];
  while (offset < png.length) { const len = png.readUInt32BE(offset); if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') idat.push(png.subarray(offset + 8, offset + 8 + len)); offset += 12 + len; }
  const raw = inflateSync(Buffer.concat(idat)); let red = 0, blue = 0;
  for (let y = 0; y < top.height; y++) for (let x = 0; x < top.width; x++) {
    const o = y * (top.width * 3 + 1) + 1 + x * 3;
    if (raw[o] > 200 && raw[o + 2] < 120) red++; if (raw[o + 2] > 200 && raw[o] < 120) blue++;
  }
  assert.ok(blue > 0 && red === 0, `the later filament shows: red ${red}, blue ${blue}`);
});

test('only a material-switch M620 (with S) starts the flush the preview leaves out; setup M620 O1 does not hide the part', async () => {
  const { extrusionSegments } = await import('../dist/safety/print-preview.js');
  const setup = extrusionSegments('G90\nM83\nM620 O1\n; FEATURE: Outer wall\nG1 X10 Y10\nG1 X20 Y10 E1\n').segments;
  assert.equal(setup.length, 1, 'the H2C start template\'s M620 O1 is not a filament change');
  const flush = extrusionSegments('G90\nM83\n; FEATURE: Outer wall\nG1 X10 Y10\nG1 X20 Y10 E1\nM620 S1A\nT1\nG1 X-20 Y200 E30\nM621 S1A\nG1 X20 Y10\nG1 X20 Y20 E1\n').segments;
  assert.equal(flush.length, 2, 'the flush between M620 S1A and M621 S1A is left out');
});

// What a client shows about the sliced file comes from here (Counterpart PRD §8.0 item 9): the plate's estimate
// and slice settings, and the file's plate count, so no client parses slice_info.config or G-code headers.
test('inspect_print_file reports the plate estimate, slice settings and plate count of the exact file', async t => {
  const s = await server(t);
  const plate = header() + '; total layer number: 183\nM104 S220\nM140 S60\nG1 X20 Y20 E1\n';
  const info = '<config><plate><metadata key="index" value="1"/><metadata key="prediction" value="3420"/><metadata key="weight" value="19.20"/></plate>'
    + '<plate><metadata key="index" value="2"/><metadata key="prediction" value="60"/><metadata key="weight" value="1"/></plate></config>';
  const f = await archive(s, {
    'Metadata/plate_1.gcode': plate, 'Metadata/plate_2.gcode': plate, 'Metadata/slice_info.config': info,
    'Metadata/project_settings.config': { layer_height: '0.12', sparse_infill_density: '25%', wall_loops: '4' },
  });
  const r = s.decode(await s.call({ file_path: f.path, bambu_model: 'p1s', plate_index: 0 }));
  assert.deepEqual(r.sliced, { plate_count: 2, estimate: { seconds: 3420, grams: 19.2 },
    settings: { layer_height_mm: 0.12, sparse_infill_percent: 25, wall_loops: 4, layer_count: 183 } });
  assert.deepEqual(s.decode(await s.call({ file_path: f.path, bambu_model: 'p1s', plate_index: 1 })).sliced.estimate, { seconds: 60, grams: 1 });
  // A G-code file: its own header and footer comments, one plate, no estimate it doesn't state.
  const g = await raw(s, header() + '; layer_height = 0.2\n; sparse_infill_density = 15%\n; wall_loops = 2\nM104 S220\nM140 S60\nG1 X20 Y20 E1\n', 'plain.gcode');
  assert.deepEqual(s.decode(await s.call({ file_path: g.path, bambu_model: 'p1s' })).sliced,
    { plate_count: 1, settings: { layer_height_mm: 0.2, sparse_infill_percent: 15, wall_loops: 2 } });
  await assert.rejects(access(s.networkLog), { code: 'ENOENT' });
});
