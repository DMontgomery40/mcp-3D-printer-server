import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { inspectPrintFile } from '../../dist/safety/print-file.js';
import { BambuImplementation } from '../../dist/printers/bambu.js';

const safe = '; printer_model = P1S\n; nozzle_diameter = 0.4\n; filament_type = PLA\nM104 S220\nG1 X0 Y0\n';
async function fixture(t, entries) {
  const zip = new JSZip();
  for (const [name, value] of entries) zip.file(name, value, { createFolders: false });
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bambu-archive-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'job.3mf');
  await fs.writeFile(file, bytes);
  return { file, bytes };
}
function renameRaw(bytes, previous, next) {
  assert.equal(previous.length, next.length);
  const out = Buffer.from(bytes);
  let offset = 0;
  while ((offset = out.indexOf(previous, offset)) !== -1) {
    out.write(next, offset, 'utf8'); offset += previous.length;
  }
  return out;
}

test('duplicate raw plate names are rejected even when JSZip would keep only the safe last entry', async t => {
  const { file, bytes } = await fixture(t, [
    ['Metadata/plate_1.gcode', safe.replace('S220', 'S400')],
    ['Metadata/plate_2.gcode', safe],
  ]);
  await fs.writeFile(file, renameRaw(bytes, 'Metadata/plate_2.gcode', 'Metadata/plate_1.gcode'));
  await assert.rejects(inspectPrintFile(file, { model: 'p1s' }), /duplicate|ambiguous/i);
});

test('case-colliding plates cannot make inspection and dispatch select different G-code', async t => {
  const { file } = await fixture(t, [
    ['Metadata/Plate_1.gcode', safe.replace('S220', 'S400')],
    ['Metadata/plate_1.gcode', safe],
  ]);
  await assert.rejects(inspectPrintFile(file, { model: 'p1s' }), /case|collision|ambiguous/i);
  await assert.rejects(new BambuImplementation().resolveProjectFileMetadata(file, 0), /case|collision|ambiguous/i);
});

const centralSignature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
function centralOffsets(bytes) {
  const offsets = [];
  let offset = 0;
  while ((offset = bytes.indexOf(centralSignature, offset)) !== -1) { offsets.push(offset); offset += 4; }
  return offsets;
}
function setDeclaredSize(bytes, central, size) {
  bytes.writeUInt32LE(size, central + 24);
  const local = bytes.readUInt32LE(central + 42);
  bytes.writeUInt32LE(size, local + 22);
}

test('oversized declared entry and total sizes are rejected before compressed payloads are inflated', async t => {
  for (const total of [false, true]) {
    const { file, bytes } = await fixture(t, Array.from({ length: total ? 3 : 1 }, (_, i) => [`Metadata/plate_${i + 1}.gcode`, safe]));
    for (const central of centralOffsets(bytes)) {
      setDeclaredSize(bytes, central, (total ? 200 : 257) * 1024 * 1024);
      const local = bytes.readUInt32LE(central + 42);
      const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
      bytes[start] = 0xff; // Invalid deflate must never be reached before rejecting its declared size.
    }
    await fs.writeFile(file, bytes);
    await assert.rejects(inspectPrintFile(file, { model: 'p1s' }), /(?:archive|entry|total).*size|size.*limit/i);
  }
});

test('an entry cannot hide a large inflation behind a small declared uncompressed size', async t => {
  const { file, bytes } = await fixture(t, [['Metadata/plate_1.gcode', safe], ['Metadata/padding.bin', Buffer.alloc(2 * 1024 * 1024)]]);
  setDeclaredSize(bytes, centralOffsets(bytes)[1], 1);
  await fs.writeFile(file, bytes);
  await assert.rejects(inspectPrintFile(file, { model: 'p1s' }), /size|inflation|output|larger/i);
});

test('local and central entry names must identify the same bytes', async t => {
  const { file, bytes } = await fixture(t, [['Metadata/plate_1.gcode', safe]]);
  bytes.write('Metadata/plate_2.gcode', 30, 'utf8');
  await fs.writeFile(file, bytes);
  await assert.rejects(inspectPrintFile(file, { model: 'p1s' }), /local|central|name|ambiguous/i);
});

test('unreferenced local plate entries cannot disagree with firmware first-match lookup', async t => {
  const { file, bytes } = await fixture(t, [['Metadata/plate_2.gcode', safe.replace('S220', 'S400')], ['Metadata/plate_1.gcode', safe]]);
  const offsets = centralOffsets(bytes);
  const eocd = bytes.length - 22;
  const firstLength = offsets[1] - offsets[0];
  const out = Buffer.concat([bytes.subarray(0, offsets[0]), bytes.subarray(offsets[1])]);
  const end = eocd - firstLength;
  out.writeUInt16LE(1, end + 8); out.writeUInt16LE(1, end + 10);
  out.writeUInt32LE(bytes.readUInt32LE(eocd + 12) - firstLength, end + 12);
  await fs.writeFile(file, out);
  await assert.rejects(inspectPrintFile(file, { model: 'p1s' }), /local|unreferenced|gap|ambiguous/i);
});

test('ZIP64 metadata is explicitly rejected instead of being truncated to 32 bits', async t => {
  const { file, bytes } = await fixture(t, [['Metadata/plate_1.gcode', safe]]);
  bytes.writeUInt16LE(0xffff, bytes.length - 22 + 10);
  await fs.writeFile(file, bytes);
  await assert.rejects(inspectPrintFile(file, { model: 'p1s' }), /ZIP64|unsupported/i);
});

test('oversized compressed files are rejected before reading the complete file', async t => {
  const { file } = await fixture(t, [['Metadata/plate_1.gcode', safe]]);
  await fs.truncate(file, 257 * 1024 * 1024);
  await assert.rejects(inspectPrintFile(file, { model: 'p1s' }), /(?:archive|file).*size|size.*limit/i);
});

test('resolver binds its checksum to the exact inspected selected plate', async t => {
  const { file } = await fixture(t, [['Metadata/plate_2.gcode', safe + 'G1 X2\n'], ['Metadata/plate_1.gcode', safe]]);
  const printer = new BambuImplementation();
  const selected = await printer.resolveProjectFileMetadata(file, 1, 'Metadata/plate_2.gcode');
  const { createHash } = await import('node:crypto');
  assert.equal(selected.plateInternalPath, 'Metadata/plate_2.gcode');
  assert.equal(selected.md5, createHash('md5').update(safe + 'G1 X2\n').digest('hex'));
  await assert.rejects(printer.resolveProjectFileMetadata(file, 1, 'Metadata/plate_1.gcode'), /inspected|plate|match/i);
});

test('ordinary stored/deflated archives, streamed descriptors, directories and Unicode names remain inspectable', async t => {
  for (const compression of ['STORE', 'DEFLATE']) {
    for (const streamFiles of [false, true]) {
      const { file } = await fixture(t, []);
      const zip = new JSZip();
      zip.file('Metadata/plate_1.gcode', safe);
      zip.file('3D/模型.model', '<model/>');
      const bytes = await zip.generateAsync({ type: 'nodebuffer', compression, streamFiles, comment: 'Bambu Studio plate fixture' });
      await fs.writeFile(file, bytes);
      const inspection = await inspectPrintFile(file, { model: 'p1s' });
      assert.equal(inspection.plateInternalPath, 'Metadata/plate_1.gcode');
      const metadata = await new BambuImplementation().resolveProjectFileMetadata(file, 0, inspection.plateInternalPath);
      assert.equal(metadata.plateInternalPath, inspection.plateInternalPath);
    }
  }
});

test('a checksum failure in an unused entry still rejects the dispatched archive', async t => {
  const { file, bytes } = await fixture(t, [['Metadata/plate_1.gcode', safe], ['Metadata/other.txt', 'unchecked']]);
  const central = centralOffsets(bytes)[1];
  const local = bytes.readUInt32LE(central + 42);
  bytes.writeUInt32LE(1, central + 16); bytes.writeUInt32LE(1, local + 14);
  await fs.writeFile(file, bytes);
  await assert.rejects(inspectPrintFile(file, { model: 'p1s' }), /CRC|checksum/i);
});
