import { promises as fs } from "node:fs";

/**
 * Where a slice's "floating regions" warning comes from. Bambu Studio and OrcaSlicer say only that an object "has
 * floating regions" (a layer island with nothing under it); a design worker then rebuilt and re-sliced six times
 * chasing specks it could not see (scan-to-make #859, pass B). This finds them in the STL itself: each downward-facing
 * low point of the surface that starts above the plate, with how far its surface hangs below the point where it joins
 * something lower (its depth). The same mesh, the same places, so one fix can be aimed.
 *
 * Coordinates are the STL's own, in millimetres, with z measured from the model's lowest point (where the slicer
 * puts the plate). Shared by bambu-printer-mcp and mcp-3D-printer-server.
 */
/** One floating region: z where it starts (its lowest point), how far it hangs, and the box of what hangs (STL x, y; z from the model's lowest point). */
export interface FloatingRegion { z: number; depth_mm: number; box_mm: { min: [number, number, number]; max: [number, number, number] } }
export interface FloatingRegions {
  /** The deepest regions first, at most `limit`; z from the model's lowest point. */
  regions: FloatingRegion[];
  /** All the low points found, before the limit. */
  count: number;
  /** The STL's lowest z, which the slicer moves to the plate. */
  model_min_z: number;
}

/** About 500k binary triangles: the search runs between slicer calls, on the server's own thread. */
const MAX_BYTES = 25 * 1024 * 1024;

/** Triangles of a binary or ASCII STL, as a flat array of 9 numbers each. */
export function stlTriangles(bytes: Buffer): Float64Array {
  const ascii = /^\s*solid\b/.test(bytes.subarray(0, 256).toString("latin1")) && bytes.includes("facet");
  if (bytes.length >= 84) {
    const n = bytes.readUInt32LE(80);
    // Binary: exactly sized, or sized with trailing bytes some exporters add, unless it reads as ASCII.
    if (84 + n * 50 === bytes.length || (84 + n * 50 < bytes.length && !ascii)) {
      const out = new Float64Array(n * 9);
      for (let i = 0; i < n; i++) for (let k = 0; k < 9; k++) out[i * 9 + k] = bytes.readFloatLE(84 + i * 50 + 12 + k * 4);
      return out;
    }
  }
  const text = bytes.toString("latin1");
  if (!/^\s*solid/.test(text)) throw new Error("not an STL file");
  const values: number[] = [];
  for (const match of text.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)) values.push(Number(match[1]), Number(match[2]), Number(match[3]));
  if (!values.length || values.length % 9 || values.some(v => !Number.isFinite(v))) throw new Error("malformed ASCII STL");
  return Float64Array.from(values);
}

/**
 * The floating low points of a triangle mesh. A sweep from the bottom up joins vertices into connected pieces of the
 * surface below each height; a piece that starts above `plate_mm` is a low point, and its depth is how far up it
 * reaches before it joins a piece that started lower (or the whole of it, if it never does: a body in mid-air).
 * Only low points whose surface faces down count (the floor of a bowl or of a closed void faces up), and only
 * those deeper than `min_depth_mm` (about one layer: shallower bumps fall inside the layer that already has material).
 */
export function floatingRegions(triangles: Float64Array, options: { plate_mm?: number; min_depth_mm?: number; merge_mm?: number; limit?: number } = {}): FloatingRegions {
  const plate = options.plate_mm ?? 0.3, minDepth = options.min_depth_mm ?? 0.2, merge = options.merge_mm ?? 2, limit = options.limit ?? 12;
  const nTri = Math.floor(triangles.length / 9);
  // Weld the triangle soup by position.
  const index = new Map<string, number>();
  const xyz: number[] = [];
  const corner = new Int32Array(nTri * 3);
  for (let i = 0; i < nTri * 3; i++) {
    const x = triangles[i * 3], y = triangles[i * 3 + 1], z = triangles[i * 3 + 2];
    const key = `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
    let v = index.get(key);
    if (v === undefined) { v = xyz.length / 3; index.set(key, v); xyz.push(x, y, z); }
    corner[i] = v;
  }
  const nV = xyz.length / 3;
  if (!nV) return { regions: [], count: 0, model_min_z: 0 };
  let minZ = Infinity;
  for (let v = 0; v < nV; v++) minZ = Math.min(minZ, xyz[v * 3 + 2]);
  // Neighbours, and each vertex's area-weighted normal z (downward-facing where negative).
  const neighbours: number[][] = Array.from({ length: nV }, () => []);
  const normalZ = new Float64Array(nV);
  for (let t = 0; t < nTri; t++) {
    const a = corner[t * 3], b = corner[t * 3 + 1], c = corner[t * 3 + 2];
    if (a === b || b === c || a === c) continue;
    const ux = xyz[b * 3] - xyz[a * 3], uy = xyz[b * 3 + 1] - xyz[a * 3 + 1];
    const vx = xyz[c * 3] - xyz[a * 3], vy = xyz[c * 3 + 1] - xyz[a * 3 + 1];
    const nz = ux * vy - uy * vx; // twice the area times the normal's z
    for (const [p, q] of [[a, b], [b, c], [c, a]]) { neighbours[p].push(q); neighbours[q].push(p); }
    normalZ[a] += nz; normalZ[b] += nz; normalZ[c] += nz;
  }
  // Union-find over vertices in rising z; each piece remembers its lowest vertex.
  const order = Array.from({ length: nV }, (_, i) => i).sort((p, q) => xyz[p * 3 + 2] - xyz[q * 3 + 2] || p - q);
  const parent = new Int32Array(nV).fill(-1);
  const lowest = new Int32Array(nV);
  const lo = new Float64Array(nV * 3), hi = new Float64Array(nV * 3);
  const find = (v: number): number => { while (parent[v] !== v) { parent[v] = parent[parent[v]]; v = parent[v]; } return v; };
  const z = (v: number) => xyz[v * 3 + 2];
  const found: { v: number; depth: number; lo: number[]; hi: number[] }[] = [];
  const consider = (root: number, depth: number) => {
    const low = lowest[root];
    if (z(low) - minZ > plate && depth >= minDepth && normalZ[low] < 0)
      found.push({ v: low, depth, lo: Array.from(lo.subarray(root * 3, root * 3 + 3)), hi: Array.from(hi.subarray(root * 3, root * 3 + 3)) });
  };
  for (const v of order) {
    parent[v] = v; lowest[v] = v;
    for (let k = 0; k < 3; k++) lo[v * 3 + k] = hi[v * 3 + k] = xyz[v * 3 + k];
    for (const n of neighbours[v]) {
      if (parent[n] < 0) continue;
      const a = find(v), b = find(n);
      if (a === b) continue;
      // The piece that started higher ends here: it hung down by the height climbed to reach this join.
      const [keep, end] = z(lowest[a]) <= z(lowest[b]) ? [a, b] : [b, a];
      consider(end, z(v) - z(lowest[end]));
      parent[end] = keep;
      for (let k = 0; k < 3; k++) { lo[keep * 3 + k] = Math.min(lo[keep * 3 + k], lo[end * 3 + k]); hi[keep * 3 + k] = Math.max(hi[keep * 3 + k], hi[end * 3 + k]); }
    }
  }
  // Pieces that never joined a lower one: separate bodies; the one holding the lowest point sits on the plate.
  const tops = new Map<number, number>();
  for (let v = 0; v < nV; v++) { const r = find(v); tops.set(r, Math.max(tops.get(r) ?? -Infinity, z(v))); }
  for (const [root, top] of tops) consider(root, top - z(lowest[root]));
  // Merge low points within merge_mm of a deeper one; deepest first.
  found.sort((p, q) => q.depth - p.depth);
  const kept: typeof found = [];
  for (const f of found) {
    const near = kept.some(k => Math.hypot(xyz[k.v * 3] - xyz[f.v * 3], xyz[k.v * 3 + 1] - xyz[f.v * 3 + 1], z(k.v) - z(f.v)) <= merge);
    if (!near) kept.push(f);
  }
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    regions: kept.slice(0, limit).map(({ v, depth, lo: l, hi: h }) => ({
      z: r2(z(v) - minZ), depth_mm: r2(depth),
      box_mm: { min: [r2(l[0]), r2(l[1]), r2(l[2] - minZ)] as [number, number, number], max: [r2(h[0]), r2(h[1]), r2(h[2] - minZ)] as [number, number, number] },
    })),
    count: kept.length,
    model_min_z: r2(minZ),
  };
}

/** The slicer said a model has floating regions or small islands: a cosmetic warning this rule bounds. */
export function isFloatingWarning(message: string | undefined): boolean {
  return !!message && /floating regions?|small islands?|isolated islands?/i.test(message);
}

export const SLICE_WARNING_RULE = "A cosmetic warning (floating regions, small islands) gets one targeted fix and one re-slice, then stops: if it remains, report it in the result or slice with supports on. Do not rebuild and re-slice to chase it.";

/**
 * What slice_stl adds to a slice that worked but warned about floating regions: the rule above, and where the
 * regions are when the input is an STL the slicer did not turn (orient, rotate). Never throws: a location it
 * cannot find is left out, with why.
 */
export async function floatingWarningFacts(
  report: { failed: boolean; message?: string } | undefined,
  modelPath: string,
  turned: boolean,
): Promise<Record<string, unknown>> {
  if (!report || report.failed || !isFloatingWarning(report.message)) return {};
  const base = { next: SLICE_WARNING_RULE };
  if (!/\.stl$/i.test(modelPath)) return { ...base, floating_regions_unlocated: "Only an STL input is located; this was a 3MF." };
  if (turned) return { ...base, floating_regions_unlocated: "The slicer turned or scaled the model (orient, rotate or scale), so the STL's own coordinates would mislead." };
  try {
    const stat = await fs.stat(modelPath);
    if (stat.size > MAX_BYTES) return { ...base, floating_regions_unlocated: "The STL is too large to search." };
    const located = floatingRegions(stlTriangles(await fs.readFile(modelPath)));
    return {
      ...base,
      floating_regions: {
        ...located,
        frame: "Each region starts at z and hangs depth_mm below where it joins the rest; box_mm bounds what hangs. x and y are the STL's own millimetres; z is millimetres above its lowest point, which the slicer puts on the plate.",
      },
    };
  } catch (error) {
    return { ...base, floating_regions_unlocated: `Could not read the STL: ${error instanceof Error ? error.message : String(error)}` };
  }
}
