/** Tray-value options. `dualNozzle` admits 255, the right/main nozzle external spool that
 * dual-nozzle printers report beside the left/deputy external spool 254 (Bambu Studio
 * VIRTUAL_TRAY_MAIN_ID / VIRTUAL_TRAY_DEPUTY_ID). Single-nozzle printers keep 254 only. */
export interface AmsTrayValueOptions { dualNozzle?: boolean }

export function describeAmsTrayRange(options: AmsTrayValueOptions = {}): string {
  return options.dualNozzle
    ? "[-1, 15] (absolute tray), 128-253 (AMS-HT), 254 (left/deputy external) or 255 (right/main external)"
    : "[-1, 15] (absolute tray) or 128-254 (HT/external)";
}

export function normalizeBridgeAmsTrayValue(value: unknown, label: string, options: AmsTrayValueOptions = {}): number {
  let numeric: number;
  if (typeof value === "number") {
    numeric = value;
  } else if (typeof value === "string" && value.trim() !== "") {
    numeric = Number(value);
  } else {
    throw new Error(`${label} must be an integer tray index; got ${JSON.stringify(value)}`);
  }

  if (
    !Number.isInteger(numeric) ||
    numeric < -1 ||
    (numeric > 15 && numeric < 128) ||
    numeric > (options.dualNozzle ? 255 : 254)
  ) {
    throw new Error(
      `${label} must be an integer in ${describeAmsTrayRange(options)}; got ${JSON.stringify(value)}`
    );
  }

  return numeric;
}

function isNumericMappingKey(key: string): boolean {
  const numeric = Number(key);
  return Number.isInteger(numeric) && numeric >= 0;
}

export function normalizeAmsMappingObject(mapping: Record<string, unknown>, label = "ams_mapping", options: AmsTrayValueOptions = {}): number[] {
  return Object.entries(mapping)
    .sort(([leftKey], [rightKey]) => {
      const leftNumeric = isNumericMappingKey(leftKey);
      const rightNumeric = isNumericMappingKey(rightKey);
      if (leftNumeric && rightNumeric) return Number(leftKey) - Number(rightKey);
      if (leftNumeric) return -1;
      if (rightNumeric) return 1;
      return 0;
    })
    .map(([key, value]) => normalizeBridgeAmsTrayValue(value, `${label}[${key}]`, options));
}

export function hasAmsMappingInput(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return value !== undefined && value !== null;
}

/** Flat wire entries use -1 for dual-nozzle virtual trays; ams_mapping2 identifies their spool. */
export function bridgeAmsMappingValue(value: number, dualNozzle = false): number {
  return dualNozzle && (value === 254 || value === 255) ? -1 : value;
}

/** Select an external spool only from a verified physical nozzle on dual-nozzle printers. */
export function externalTrayForNozzle(nozzle: number | undefined, dualNozzle = false): number {
  if (!dualNozzle) return 254;
  if (nozzle === 0) return 255;
  if (nozzle === 1) return 254;
  throw new Error("External-spool printing requires inspected filament_map and physical_extruder_map nozzle bindings.");
}

/** Virtual trays use slot zero on dual-nozzle printers; retain the historical single-nozzle form. */
export function bridgeAmsMapping2Entry(value: number, dualNozzle = false): { ams_id: number; slot_id: number } {
  if (value < 0) return { ams_id: 255, slot_id: 255 };
  if (value === 255) return dualNozzle ? { ams_id: 255, slot_id: 0 } : { ams_id: 255, slot_id: 255 };
  if (value === 254) return { ams_id: 254, slot_id: dualNozzle ? 0 : 254 };
  if (value >= 128) return { ams_id: 128, slot_id: value - 128 };
  return { ams_id: Math.floor(value / 4), slot_id: value % 4 };
}

/** A project filament as the sliced 3MF's Metadata/project_settings.config declares it. */
export interface ProjectFilament { type: string; filamentId: string; colour: string; nozzle?: number }

/** Read every project filament (not just the plate's used ones) from project_settings.config. */
export function projectFilaments(projectSettings: Record<string, unknown>): ProjectFilament[] {
  const list = (key: string): string[] => Array.isArray(projectSettings[key]) ? (projectSettings[key] as unknown[]).map(String) : [];
  const types = list("filament_type"), ids = list("filament_ids"), colours = list("filament_colour"), nozzles = list("filament_map");
  return types.map((type, index) => ({
    type, filamentId: ids[index] ?? "", colour: colours[index] ?? "",
    ...(nozzles[index] !== undefined && Number.isInteger(Number(nozzles[index])) ? { nozzle: Number(nozzles[index]) } : {}),
  }));
}

/** The colour the printer reports for an absolute tray value (AMS, AMS-HT or external spool). */
export function trayColour(rawStatus: any, tray: number): string | undefined {
  const units: any[] = Array.isArray(rawStatus?.ams?.ams) ? rawStatus.ams.ams : [];
  let colour: unknown;
  if (tray === 254 || tray === 255) {
    const slots: any[] = Array.isArray(rawStatus?.vir_slot) ? rawStatus.vir_slot : [];
    colour = slots.find(slot => Number(slot?.id) === tray)?.tray_color ?? (tray === 254 ? rawStatus?.vt_tray?.tray_color : undefined);
  } else if (tray >= 128) {
    colour = units.find(unit => Number(unit?.id) === tray)?.tray?.[0]?.tray_color;
  } else if (tray >= 0) {
    const unit = units.find(candidate => Number(candidate?.id) === Math.floor(tray / 4));
    colour = (Array.isArray(unit?.tray) ? unit.tray : []).find((slot: any) => Number(slot?.id) === tray % 4)?.tray_color;
  }
  return typeof colour === "string" ? colour : undefined;
}

/**
 * PrintParams.ams_mapping_info exactly as Bambu Studio and FULU's slicer build it
 * (SelectMachineDialog::get_ams_mapping_result) and send it with every print: one entry per
 * project filament. A mapped filament names its tray, its filament id and type, its colour as
 * #RRGGBBAA and the tray's colour as the printer reports it; an unmapped one carries ams -1.
 * Filament-map nozzle 1 (left) is cloud nozzle 1 and 2 (right) is 0 (CloudTaskNozzleId).
 */
export function studioAmsMappingInfo(filaments: ProjectFilament[], mapping: number[], colourOfTray: (tray: number) => string | undefined): Array<Record<string, unknown>> {
  return filaments.map((filament, position) => {
    const tray = mapping[position];
    if (tray === undefined || tray < 0) return { ams: -1, targetColor: "", filamentId: "", filamentType: "" };
    const hex = filament.colour.replace(/^#/, "").toUpperCase();
    return {
      ams: tray,
      targetColor: colourOfTray(tray) ?? "",
      filamentId: filament.filamentId,
      filamentType: filament.type,
      ...(filament.nozzle === 1 ? { nozzleId: 1 } : filament.nozzle === 2 ? { nozzleId: 0 } : {}),
      sourceColor: /^[0-9A-F]{6}$/.test(hex) ? `#${hex}FF` : /^[0-9A-F]{8}$/.test(hex) ? `#${hex}` : "",
    };
  });
}
