import { open } from 'node:fs/promises';
import { promisify, TextDecoder } from 'node:util';
import { inflateRaw } from 'node:zlib';
import JSZip from 'jszip';

// Fixed inspection limits, not caller-overridable printer safety options.
export const MAX_PRINT_FILE_BYTES = 256 * 1024 * 1024;
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const inflate = promisify(inflateRaw);
const utf8 = new TextDecoder('utf-8', { fatal: true });
const fail = (message: string): never => { throw new Error(`Print archive safety: ${message}`); };
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

/** Read no more than the fixed print-artifact limit, even if the file grows. */
export async function readBoundedPrintFile(filePath: string): Promise<Buffer> {
  const file = await open(filePath, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile()) return fail('print artifact must be a regular file');
    if (stat.size > MAX_PRINT_FILE_BYTES) return fail('compressed archive or G-code file size exceeds the 256 MiB inspection limit');
    const bytes = Buffer.alloc(stat.size);
    let read = 0;
    while (read < bytes.length) {
      const result = await file.read(bytes, read, bytes.length - read, read);
      if (!result.bytesRead) return fail('file changed while being read');
      read += result.bytesRead;
    }
    if ((await file.read(Buffer.alloc(1), 0, 1, read)).bytesRead) return fail('file size changed while being read');
    return bytes;
  } finally { await file.close(); }
}

interface Entry {
  name: string;
  rawName: Buffer;
  flags: number;
  method: number;
  crc: number;
  compressed: number;
  uncompressed: number;
  local: number;
  data?: Buffer;
}
function decodeName(raw: Buffer): string {
  let name: string;
  try { name = utf8.decode(raw); } catch { return fail('entry name is not valid UTF-8'); }
  const segments = name.replace(/\/$/, '').split('/');
  if (!name || /[\\\x00-\x1f]/.test(name) || segments.some(part => !part || part === '.' || part === '..')) {
    return fail('ambiguous archive entry path');
  }
  return name;
}
function checkExtra(extra: Buffer, rawName: Buffer, name: string): void {
  let offset = 0;
  while (offset < extra.length) {
    if (offset + 4 > extra.length) return fail('malformed ZIP extra field');
    const kind = extra.readUInt16LE(offset);
    const length = extra.readUInt16LE(offset + 2);
    offset += 4;
    if (offset + length > extra.length) return fail('malformed ZIP extra field length');
    if (kind === 0x0001) return fail('ZIP64 archives are unsupported for verified printing');
    if (kind === 0x7075) {
      const field = extra.subarray(offset, offset + length);
      if (length < 5 || field[0] !== 1 || field.readUInt32LE(1) !== crc32(rawName) || decodeName(field.subarray(5)) !== name) {
        return fail('Unicode path metadata disagrees with the archive entry name');
      }
    }
    offset += length;
  }
}

/** Parse every central and local record before decompression. Competing names and
 * orphan local records could cause the firmware to execute a different plate. */
function parseEntries(bytes: Buffer): Entry[] {
  if (bytes.length > MAX_PRINT_FILE_BYTES) return fail('compressed archive size exceeds the 256 MiB inspection limit');
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  }
  if (end < 0) return fail('missing or malformed ZIP central-directory end record');
  const count = bytes.readUInt16LE(end + 10);
  const size = bytes.readUInt32LE(end + 12);
  const start = bytes.readUInt32LE(end + 16);
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff || (end >= 20 && bytes.readUInt32LE(end - 20) === 0x07064b50)) {
    return fail('ZIP64 archives are unsupported for verified printing');
  }
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== count) return fail('multi-disk ZIP archives are unsupported');
  if (start + size !== end) return fail('ambiguous ZIP central-directory extent');
  const entries: Entry[] = [];
  const names = new Set<string>();
  const foldedNames = new Set<string>();
  let offset = start;
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) return fail('malformed ZIP central-directory entry');
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > end) return fail('truncated ZIP central-directory entry');
    const rawName = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const name = decodeName(rawName);
    if (names.has(name)) return fail(`duplicate archive entry '${name}'`);
    if (foldedNames.has(name.toLowerCase())) return fail(`case-colliding archive entry '${name}'`);
    names.add(name); foldedNames.add(name.toLowerCase());
    const entry: Entry = {
      name, rawName, flags: bytes.readUInt16LE(offset + 8), method: bytes.readUInt16LE(offset + 10),
      crc: bytes.readUInt32LE(offset + 16), compressed: bytes.readUInt32LE(offset + 20),
      uncompressed: bytes.readUInt32LE(offset + 24), local: bytes.readUInt32LE(offset + 42),
    };
    if ([entry.compressed, entry.uncompressed, entry.local].includes(0xffffffff)) return fail('ZIP64 archives are unsupported for verified printing');
    if (bytes.readUInt16LE(offset + 34)) return fail('multi-disk ZIP entries are unsupported');
    if (entry.flags & ~0x080e || ![0, 8].includes(entry.method)) return fail('encrypted or unsupported ZIP entry encoding');
    if (entry.uncompressed > MAX_ENTRY_BYTES) return fail(`entry size for '${name}' exceeds the 256 MiB inspection limit`);
    total += entry.uncompressed;
    if (total > MAX_TOTAL_BYTES) return fail('total uncompressed archive size exceeds the 512 MiB inspection limit');
    if (name.endsWith('/') && (entry.compressed || entry.uncompressed)) return fail('directory entry contains hidden file data');
    checkExtra(bytes.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength), rawName, name);
    entries.push(entry); offset = next;
  }
  if (offset !== end) return fail('unaccounted central-directory entries');
  let cursor = 0;
  for (const entry of [...entries].sort((a, b) => a.local - b.local)) {
    if (entry.local !== cursor) return fail('unreferenced, overlapping, or ambiguous local ZIP entries');
    if (cursor + 30 > start || bytes.readUInt32LE(cursor) !== 0x04034b50) return fail('malformed local ZIP entry');
    const nameLength = bytes.readUInt16LE(cursor + 26);
    const extraLength = bytes.readUInt16LE(cursor + 28);
    const dataStart = cursor + 30 + nameLength + extraLength;
    const dataEnd = dataStart + entry.compressed;
    if (dataEnd > start) return fail('local entry extends into the central directory');
    if (bytes.readUInt16LE(cursor + 6) !== entry.flags || bytes.readUInt16LE(cursor + 8) !== entry.method || !bytes.subarray(cursor + 30, cursor + 30 + nameLength).equals(entry.rawName)) {
      return fail('local and central ZIP entry names or encoding disagree');
    }
    checkExtra(bytes.subarray(cursor + 30 + nameLength, dataStart), entry.rawName, entry.name);
    const localFields = [bytes.readUInt32LE(cursor + 14), bytes.readUInt32LE(cursor + 18), bytes.readUInt32LE(cursor + 22)];
    const expected = [entry.crc, entry.compressed, entry.uncompressed];
    if (localFields.some((value, i) => value !== expected[i] && (!(entry.flags & 8) || value !== 0))) return fail('local and central ZIP entry sizes or CRC disagree');
    entry.data = bytes.subarray(dataStart, dataEnd);
    cursor = dataEnd;
    if (entry.flags & 8) {
      if (cursor + 12 > start) return fail('missing ZIP data descriptor');
      if (bytes.readUInt32LE(cursor) === 0x08074b50) cursor += 4;
      if (cursor + 12 > start || expected.some((value, i) => bytes.readUInt32LE(cursor + i * 4) !== value)) return fail('ZIP data descriptor disagrees with central entry');
      cursor += 12;
    }
  }
  if (cursor !== start) return fail('unreferenced local ZIP data before the central directory');
  return entries;
}

/** Bounded native inflation prevents false size fields from making JSZip allocate
 * unbounded output. Populate JSZip only with the verified, uniquely named bytes. */
export async function loadSafe3mfArchive(bytes: Buffer): Promise<JSZip> {
  const entries = parseEntries(bytes);
  const zip = new JSZip();
  for (const entry of entries) {
    let data: Buffer;
    try {
      data = entry.method === 0 ? entry.data! : await inflate(entry.data!, { maxOutputLength: Math.max(1, entry.uncompressed) });
    } catch { return fail(`entry inflation exceeds its declared size or is corrupt: '${entry.name}'`); }
    if (data.length !== entry.uncompressed) return fail(`uncompressed entry size mismatch for '${entry.name}'`);
    if (crc32(data) !== entry.crc) return fail(`entry CRC mismatch for '${entry.name}'`);
    zip.file(entry.name, data, { dir: entry.name.endsWith('/'), createFolders: false });
  }
  return zip;
}

export async function readSafe3mfArchive(filePath: string): Promise<{ bytes: Buffer; zip: JSZip }> {
  const bytes = await readBoundedPrintFile(filePath);
  return { bytes, zip: await loadSafe3mfArchive(bytes) };
}
