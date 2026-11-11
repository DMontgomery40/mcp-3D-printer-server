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
    if (/^M83(?:\s|$)/.test(line)) relative = true;
    if (/^M82(?:\s|$)/.test(line)) relative = false;
    const command = line.split(";")[0];
    if (/^G92\b/.test(command)) {
      const reset = /\bE(-?[\d.]+)/.exec(command);
      if (reset) e = Number(reset[1]);
    }
    if (!/^G[123]\s/.test(command)) continue;
    const values = Object.fromEntries(
      [...command.matchAll(/\b([XYE])(-?\d*\.?\d+)/g)].map((m) => [
        m[1],
        Number(m[2]),
      ]),
    );
    const nx = values.X ?? x,
      ny = values.Y ?? y;
    const extrusion =
      values.E === undefined ? 0 : relative ? values.E : values.E - e;
    if (
      z !== undefined &&
      extrusion > 0 &&
      (values.X !== undefined || values.Y !== undefined)
    ) {
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
