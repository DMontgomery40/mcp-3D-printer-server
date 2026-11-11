import { arcCentre } from "../safety/print-preview.js";

/** Expected geometry from the exact selected plate's sliced commands, never printer progress. */
export interface LayerGeometry {
  layer: number;
  zMm: number;
  boundsMm?: [number, number, number, number];
}
export interface PrintGeometry {
  heightMm?: number;
  layers: LayerGeometry[];
}

export function geometryFromGcode(gcode: string): PrintGeometry {
  const layers: LayerGeometry[] = [];
  let z: number | undefined, layer: LayerGeometry | undefined;
  let markerCount = 0,
    currentIndex = 0,
    previousMarkerZ: number | undefined;
  let x = 0,
    y = 0,
    e = 0,
    relative = false,
    absoluteXY = true,
    positionUnknown = false,
    changingFilament = false,
    feature = "",
    executableEnded = false;
  for (const line of gcode.split(/\r?\n/)) {
    if (line === "; EXECUTABLE_BLOCK_END") executableEnded = true;
    if (executableEnded) break;
    const marker = /^;\s*(?:Z_HEIGHT:|Z:)\s*([\d.]+)/.exec(line);
    if (marker) {
      z = Number(marker[1]);
      if (z !== previousMarkerZ) markerCount++;
      previousMarkerZ = z;
      currentIndex = markerCount;
      layer = undefined;
      if (!Number.isFinite(z) || z <= 0 || z > 10000) z = undefined;
    }
    const declared = /^;\s*layer num\/total_layer_count:\s*(\d+)\/\d+/.exec(
      line,
    );
    if (declared) currentIndex = Number(declared[1]);
    const featureMatch = /^;\s*(?:FEATURE|TYPE):\s*(.*)/i.exec(line);
    if (featureMatch) feature = featureMatch[1].trim().toLowerCase();
    const command = line
      .split(";")[0]
      .trim()
      .toUpperCase()
      .replace(/^N\d+\s*/, "")
      .replace(/\*\d+\s*$/, "");
    const parsed = /^([GMT])(\d+(?:\.\d+)?)/.exec(command);
    if (!parsed) continue;
    const word = parsed[1] + String(Number(parsed[2]));
    const values: Record<string, number> = {};
    for (const match of command
      .slice(parsed[0].length)
      .matchAll(/([A-Z])\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))/g)) {
      if (values[match[1]] === undefined) values[match[1]] = Number(match[2]);
    }
    if (word === "G90") {
      absoluteXY = true;
      continue;
    }
    if (word === "G91") {
      absoluteXY = false;
      continue;
    }
    if (word === "M83") {
      relative = true;
      continue;
    }
    if (word === "M82") {
      relative = false;
      continue;
    }
    // Do not invent bed-coordinate footprints for unsupported unit/work-coordinate changes.
    if (
      word === "G20" ||
      word === "G18" || word === "G19" || word === "G90.1" ||
      word === "G53" ||
      (word === "G92" && (values.X !== undefined || values.Y !== undefined))
    )
      return { layers: [] };
    if (word === "G28") {
      positionUnknown = true;
      continue;
    }
    if (Object.values(values).some((v) => !Number.isFinite(v)))
      return { layers: [] };
    if (word === "G92") {
      if (values.E !== undefined) e = values.E;
      continue;
    }
    if (word === "M620" && values.S !== undefined) {
      changingFilament = true;
      continue;
    }
    if (word === "M621" && values.S !== undefined) {
      changingFilament = false;
      continue;
    }
    if (!["G0", "G1", "G2", "G3"].includes(word)) continue;
    const nx =
      values.X === undefined ? x : absoluteXY ? values.X : x + values.X;
    const ny =
      values.Y === undefined ? y : absoluteXY ? values.Y : y + values.Y;
    const extrusion =
      values.E === undefined ? 0 : relative ? values.E : values.E - e;
    if (
      z !== undefined &&
      extrusion > 0 &&
      word !== "G0" &&
      !changingFilament &&
      feature !== "custom" &&
      (values.X !== undefined || values.Y !== undefined || word === "G2" || word === "G3")
    ) {
      if (positionUnknown) return { layers: [] };
      const bounds = motionBounds(x, y, nx, ny, word, values);
      if (!bounds) return { layers: [] };
      if (!layer) {
        // Repeated Z values do not create fictitious additional layers.
        layer =
          layers.at(-1)?.zMm === z
            ? layers.at(-1)
            : { layer: currentIndex, zMm: z };
        if (layer && layers.at(-1) !== layer) layers.push(layer);
        if (layers.length > 10000) return { layers: [] };
      }
      if (layer) {
        const previous = layer.boundsMm;
        layer.boundsMm = [
          Math.min(previous?.[0] ?? bounds[0], bounds[0]),
          Math.min(previous?.[1] ?? bounds[1], bounds[1]),
          Math.max(previous?.[2] ?? bounds[2], bounds[2]),
          Math.max(previous?.[3] ?? bounds[3], bounds[3]),
        ];
      }
    }
    if (absoluteXY && values.X !== undefined && values.Y !== undefined)
      positionUnknown = false;
    x = nx;
    y = ny;
    if (values.E !== undefined) e = relative ? e + values.E : values.E;
  }
  return {
    ...(layers.length
      ? { heightMm: Math.max(...layers.map((l) => l.zMm)) }
      : {}),
    layers,
  };
}

/** Include the cardinal extrema actually swept by an XY arc, including I/J full circles. */
function motionBounds(x: number, y: number, nx: number, ny: number, word: string, values: Record<string, number>): [number, number, number, number] | undefined {
  const bounds: [number, number, number, number] = [Math.min(x,nx),Math.min(y,ny),Math.max(x,nx),Math.max(y,ny)];
  if (!bounds.every(Number.isFinite)) return;
  if (word !== "G2" && word !== "G3") return bounds;
  const clockwise = word === "G2";
  const centre = arcCentre(x,y,nx,ny,clockwise,values.I,values.J,values.R);
  if (!centre || !centre.every(Number.isFinite)) return;
  const [cx,cy] = centre, radius = Math.hypot(x-cx,y-cy);
  if (!Number.isFinite(radius) || radius <= 0 || Math.abs(Math.hypot(nx-cx,ny-cy)-radius) > Math.max(0.01,radius*0.001)) return;
  const turn = 2*Math.PI;
  const normal = (angle:number) => ((angle % turn)+turn)%turn;
  const start = Math.atan2(y-cy,x-cx), end = Math.atan2(ny-cy,nx-cx);
  const sweep = normal(clockwise ? start-end : end-start);
  const full = x === nx && y === ny;
  for (const angle of [0,Math.PI/2,Math.PI,3*Math.PI/2]) {
    const distance = normal(clockwise ? start-angle : angle-start);
    if (!full && distance > sweep+1e-10) continue;
    const px = cx+radius*Math.cos(angle), py = cy+radius*Math.sin(angle);
    bounds[0]=Math.min(bounds[0],px); bounds[1]=Math.min(bounds[1],py);
    bounds[2]=Math.max(bounds[2],px); bounds[3]=Math.max(bounds[3],py);
  }
  return bounds;
}

/** Best-effort diagnostics only: an unreadable/oversize file cannot fail an already dispatched print. */
export async function geometryFromFile(
  filePath: string,
): Promise<PrintGeometry | undefined> {
  try {
    const fs = await import("node:fs/promises");
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024) return undefined;
    return geometryFromGcode(await fs.readFile(filePath, "utf8"));
  } catch {
    return undefined;
  }
}
