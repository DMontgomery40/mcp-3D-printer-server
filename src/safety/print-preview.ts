/**
 * A picture of what the printer will lay down, drawn from the exact sliced G-code (never from a
 * thumbnail: Bambu Studio's CLI copies a project's old plate PNGs into the sliced file unchanged).
 * Every extruding move on the selected plate is drawn in its filament's colour, except the slicer's
 * start-up purge and prime lines (feature "Custom"). Two views: the top as it sits on the bed, and
 * the bed side as you see it after turning the part over toward you (top to bottom), so text on
 * that face reads as it will.
 * Deterministic: the same bytes always give the same pictures.
 */
import { deflateSync } from "zlib";

export interface PreviewView { name: "top" | "bed_side"; label: string; png_base64: string; width: number; height: number }
export interface PrintPreview {
  views: PreviewView[];
  /** Millimetres per pixel in both views. */
  mm_per_pixel: number;
  /** The drawn area on the bed, in millimetres: [minX, minY, maxX, maxY]. */
  extent_mm: [number, number, number, number];
  layers: number;
  /** Filament slots (0-based, as the G-code's T numbers) that extrude on this plate. */
  filaments_used: number[];
}

const BACKGROUND = [245, 245, 247];
const MAX_PIXELS = 1400;

function parseColour(value: unknown): [number, number, number] | undefined {
  const match = typeof value === "string" ? /^#?([0-9a-f]{6})/i.exec(value.trim()) : null;
  if (!match) return undefined;
  const n = parseInt(match[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Buffer {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(data)]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
/** RGB pixels (row-major) as a PNG. */
export function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(raw, y * (width * 3 + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2; header[10] = 0; header[11] = 0; header[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", new Uint8Array())]);
}

interface Segment { x0: number; y0: number; x1: number; y1: number; z: number; tool: number; width: number }

/** Extruding moves of one plate's G-code, start-up purge excluded. */
export function extrusionSegments(gcode: string): { segments: Segment[]; layers: number } {
  const segments: Segment[] = [];
  let x = 0, y = 0, z = 0, e = 0, absoluteXY = true, relativeE = false, tool = 0, feature = "", layers = 0, width = 0.42;
  const lines = gcode.split(/\r\n|\n|\r/);
  for (const raw of lines) {
    const comment = raw.indexOf(";");
    if (comment >= 0) {
      const note = raw.slice(comment + 1).trim();
      const featureMatch = /^FEATURE:\s*(.*)$/i.exec(note);
      if (featureMatch) feature = featureMatch[1].trim().toLowerCase();
      else if (/^(CHANGE_LAYER|LAYER_CHANGE)$/i.test(note)) layers++;
      else { const w = /^(?:LINE_WIDTH|WIDTH)\s*:\s*([\d.]+)/i.exec(note); if (w && Number(w[1]) > 0 && Number(w[1]) < 5) width = Number(w[1]); }
    }
    const line = (comment >= 0 ? raw.slice(0, comment) : raw).trim().toUpperCase();
    if (!line) continue;
    const word = line.split(/\s+/)[0];
    const toolMatch = /^T(\d+)$/.exec(word);
    if (toolMatch) { const t = Number(toolMatch[1]); if (t < 255) tool = t; continue; }
    if (word === "G90") { absoluteXY = true; continue; }
    if (word === "G91") { absoluteXY = false; continue; }
    if (word === "M82") { relativeE = false; continue; }
    if (word === "M83") { relativeE = true; continue; }
    if (word === "G92") { const m = /\bE(-?[\d.]+)/.exec(line); if (m) e = Number(m[1]); continue; }
    if (word !== "G0" && word !== "G1" && word !== "G2" && word !== "G3") continue;
    const value = (axis: string) => { const m = new RegExp(`\\b${axis}(-?[\\d.]+)`).exec(line); return m ? Number(m[1]) : undefined; };
    const nx = value("X"), ny = value("Y"), nz = value("Z"), ne = value("E");
    const tx = nx === undefined ? x : absoluteXY ? nx : x + nx;
    const ty = ny === undefined ? y : absoluteXY ? ny : y + ny;
    if (nz !== undefined) z = absoluteXY ? nz : z + nz;
    let extruding = false;
    if (ne !== undefined) {
      const delta = relativeE ? ne : ne - e;
      e = relativeE ? e + ne : ne;
      extruding = delta > 0 && word !== "G0";
    }
    if (extruding && feature && feature !== "custom" && (tx !== x || ty !== y)) {
      if ((word === "G2" || word === "G3") && (value("I") !== undefined || value("J") !== undefined)) {
        // Arc: centre at the current point plus I/J, swept clockwise (G2) or counter-clockwise (G3).
        const cx = x + (value("I") ?? 0), cy = y + (value("J") ?? 0);
        const r = Math.hypot(x - cx, y - cy);
        let a0 = Math.atan2(y - cy, x - cx), a1 = Math.atan2(ty - cy, tx - cx);
        if (word === "G2") { while (a1 >= a0) a1 -= 2 * Math.PI; } else { while (a1 <= a0) a1 += 2 * Math.PI; }
        const steps = Math.max(2, Math.ceil(Math.abs(a1 - a0) * r / 0.2));
        let px = x, py = y;
        for (let i = 1; i <= steps; i++) {
          const a = a0 + (a1 - a0) * i / steps;
          const qx = i === steps ? tx : cx + r * Math.cos(a), qy = i === steps ? ty : cy + r * Math.sin(a);
          segments.push({ x0: px, y0: py, x1: qx, y1: qy, z, tool, width });
          px = qx; py = qy;
        }
      } else segments.push({ x0: x, y0: y, x1: tx, y1: ty, z, tool, width });
    }
    x = tx; y = ty;
  }
  return { segments, layers };
}

/** The top and bed-side pictures of one plate's G-code. `colours` are the project's filament colours by slot. */
export function renderPrintPreview(gcode: string, colours: unknown[] = []): PrintPreview | undefined {
  const { segments, layers } = extrusionSegments(gcode);
  if (!segments.length) return undefined;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const s of segments) {
    minX = Math.min(minX, s.x0, s.x1); maxX = Math.max(maxX, s.x0, s.x1);
    minY = Math.min(minY, s.y0, s.y1); maxY = Math.max(maxY, s.y0, s.y1);
    minZ = Math.min(minZ, s.z); maxZ = Math.max(maxZ, s.z);
  }
  const margin = 2;
  minX -= margin; minY -= margin; maxX += margin; maxY += margin;
  const span = Math.max(maxX - minX, maxY - minY);
  // Fine enough for 0.3 mm ruler ticks (at least 4 px/mm) whenever the plate's drawn area allows.
  const ppm = Math.min(8, Math.max(1, MAX_PIXELS / span));
  const width = Math.max(1, Math.ceil((maxX - minX) * ppm)), height = Math.max(1, Math.ceil((maxY - minY) * ppm));
  const palette = (tool: number) => parseColour(colours[tool]) ?? [40, 40, 40];
  const used = new Set<number>();
  const draw = (top: boolean) => {
    const depth = new Float32Array(width * height).fill(top ? -Infinity : Infinity);
    const toolAt = new Int16Array(width * height).fill(-1);
    for (const s of segments) {
      used.add(s.tool);
      const ax = (s.x0 - minX) * ppm, ay = (maxY - s.y0) * ppm, bx = (s.x1 - minX) * ppm, by = (maxY - s.y1) * ppm;
      // Each line at its extrusion width, so a surface's lines meet as they do on the part.
      const radius = Math.max(0.5, s.width * ppm / 2), r2 = radius * radius, reach = Math.ceil(radius);
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / Math.max(0.5, radius / 2)));
      for (let i = 0; i <= steps; i++) {
        const cx = ax + (bx - ax) * i / steps, cy = ay + (by - ay) * i / steps;
        for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) {
          if (dx * dx + dy * dy > r2) continue;
          const px = Math.floor(cx + dx), py = Math.floor(cy + dy);
          if (px < 0 || py < 0 || px >= width || py >= height) continue;
          const k = py * width + px;
          if (top ? s.z >= depth[k] : s.z <= depth[k]) { depth[k] = s.z; toolAt[k] = s.tool; }
        }
      }
    }
    const rgb = new Uint8Array(width * height * 3);
    const zRange = Math.max(1e-6, maxZ - minZ);
    for (let py = 0; py < height; py++) for (let px = 0; px < width; px++) {
      // The bed side is the part turned over top to bottom, so its text reads as it will on the part.
      const sy = top ? py : height - 1 - py;
      const k = sy * width + px, o = (py * width + px) * 3, t = toolAt[k];
      if (t < 0) { rgb[o] = BACKGROUND[0]; rgb[o + 1] = BACKGROUND[1]; rgb[o + 2] = BACKGROUND[2]; continue; }
      const [r, g, b] = palette(t);
      // Height shading, toward white so it shows on dark filament too: on the top view the highest
      // lines (raised tabs, top surfaces) are lightest; on the bed side the face on the bed is.
      const h = (depth[k] - minZ) / zRange, lift = 0.4 * (top ? h : 1 - h);
      rgb[o] = Math.round(r + (255 - r) * lift);
      rgb[o + 1] = Math.round(g + (255 - g) * lift);
      rgb[o + 2] = Math.round(b + (255 - b) * lift);
    }
    return encodePng(width, height, rgb).toString("base64");
  };
  const top = draw(true), bed = draw(false);
  return {
    views: [
      { name: "top", label: "Top, as it sits on the bed", png_base64: top, width, height },
      { name: "bed_side", label: "Bed side, turned over toward you", png_base64: bed, width, height },
    ],
    mm_per_pixel: Math.round(1e6 / ppm) / 1e6,
    extent_mm: [minX, minY, maxX, maxY].map(v => Math.round(v * 100) / 100) as [number, number, number, number],
    layers,
    filaments_used: [...used].sort((a, b) => a - b),
  };
}

/** The preview of one plate of a sliced .3mf or a .gcode file, or undefined when it has no extruding moves. */
export async function previewPrintFile(source: { gcode: string; projectColours?: unknown[] }): Promise<PrintPreview | undefined> {
  let colours = source.projectColours;
  if (!colours?.length) {
    // A bare .gcode file carries its colours in its header: "; filament_colour = #000000;#FFFFFF".
    const header = /^\s*;\s*filament_colou?r\s*[=:]\s*(.+)$/im.exec(source.gcode);
    colours = header ? header[1].split(/[;,]/).map(v => v.trim()) : [];
  }
  return renderPrintPreview(source.gcode, colours);
}
