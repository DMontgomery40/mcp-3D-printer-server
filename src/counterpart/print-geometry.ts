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
      (values.X !== undefined || values.Y !== undefined)
    ) {
      if (positionUnknown) return { layers: [] };
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
          Math.min(previous?.[0] ?? x, x, nx),
          Math.min(previous?.[1] ?? y, y, ny),
          Math.max(previous?.[2] ?? x, x, nx),
          Math.max(previous?.[3] ?? y, y, ny),
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
