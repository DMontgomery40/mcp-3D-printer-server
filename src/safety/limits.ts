/** Independent hardware ceilings. Editable slicer profiles never raise these limits.
 * Manufacturer references (verified 2026-09-27):
 * P1P: https://public-cdn.bambulab.com/store/bambulab-P1P-tech-specs.pdf
 * P1S: https://cdn1.bambulab.com/documentation/quick-start-59b0cefdc0fc4/P1S/English%20version-Quick%20Start%20Guide%20for%20P1S.pdf
 * A1: https://bambulab.com/en/a1/tech-specs
 * A1 mini: https://us.store.bambulab.com/products/a1-mini
 * X1/X1C: https://cdn1.bambulab.com/documentation/Quick%20Start%20Guide%20for%20X1%20Combo%26X1-Carbon%20Combo-v1.pdf
 * X1E: https://cdn1.bambulab.com/x1e/spec/Bambu%20Lab%20X1E%20Technical%20Specification.pdf
 * H2D: https://cdn1.bambulab.com/documentation/h2d/en/H2D_Laser_Full_Combo_20250305.pdf
 * H2D Pro: https://bambulab.com/en/h2d-pro/tech-specs
 * H2C: https://csm.bblcdn.com/hub/eca403f48aee405393afc97adbbf6422.pdf
 * H2S: https://bambulab.com/it/support/buying-guide
 * P2S: https://blog.bambulab.com/the-icon-redefined-meet-the-p2s-a-completely-reengineered-version-of-the-ultra-productive-p1-series/
 * X2D: https://csm.bblcdn.com/hub/7c58718aaa2e40edab56efb87419a96a.pdf
 * X1-family bed caps use 110 C: 120 C requires verified 110 V supply, unavailable here.
 * A zero chamber cap means no supported active chamber heater, not ambient temperature.
 */
export const MACHINE_LIMITS: Readonly<Record<string, {nozzle: number; bed: number; chamber: number; volume: readonly number[]}>> = {
  p1p: {nozzle:300,bed:100,chamber:0,volume:[256,256,256]},
  p1s: {nozzle:300,bed:100,chamber:0,volume:[256,256,256]},
  p2s: {nozzle:300,bed:110,chamber:0,volume:[256,256,256]},
  a1: {nozzle:300,bed:100,chamber:0,volume:[256,256,256]},
  a1mini: {nozzle:300,bed:80,chamber:0,volume:[180,180,180]},
  x1: {nozzle:300,bed:110,chamber:0,volume:[256,256,256]},
  x1c: {nozzle:300,bed:110,chamber:0,volume:[256,256,256]},
  x1e: {nozzle:320,bed:110,chamber:60,volume:[256,256,256]},
  h2d: {nozzle:350,bed:120,chamber:65,volume:[350,320,325]},
  h2dpro: {nozzle:350,bed:120,chamber:65,volume:[350,320,325]},
  h2c: {nozzle:350,bed:120,chamber:65,volume:[330,320,325]},
  h2s: {nozzle:350,bed:120,chamber:65,volume:[340,320,340]},
  x2d: {nozzle:300,bed:120,chamber:65,volume:[256,256,260]},
};

export function normalizeModel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  let model = value.trim().toLowerCase().replace(/^bambu\s*(?:lab\s*)?/, '').replace(/[\s_-]/g, '');
  if (model === 'x1carbon') model = 'x1c';
  return Object.prototype.hasOwnProperty.call(MACHINE_LIMITS, model) ? model : undefined;
}

/** Policy ceilings, NOT manufacturer-recommended print temperatures or decomposition
 * thresholds. The normal PLA ceiling of 260 C includes Bambu PLA Aero's bundled
 * range_high=260 (other bundled PLA ranges are lower). A separate 290 C startup
 * allowance is only used by the inspector for the exact one-shot X1E common flush;
 * it must never authorize manual heating or sustained deposition at that target.
 * File/profile nozzle_temperature_range_high and RFID limits cannot raise this policy.
 */
const MATERIAL_LIMITS: Readonly<Record<string, number>> = {
  PLA:260, PETG:300, ABS:300, ASA:300, TPU:290, PVA:290, BVOH:290,
  HIPS:300, PP:300, POM:250, PET:350, PA:350, PC:350, PPA:350, PPS:350,
  'SUPPORT-PLA':290, 'SUPPORT-PA':350,
};
/** Independent nozzle policy ceiling for a declared material, or undefined when unknown. */
export function materialNozzleCeiling(value: unknown): number | undefined {
  const material = normalizeMaterial(value);
  return material ? MATERIAL_LIMITS[material] : undefined;
}
export function normalizeMaterial(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const material = value.trim().toUpperCase().replace(/^BAMBU(?: LAB)?\s+/, '').replace(/^GENERIC\s+/, '');
  if (material === 'SUPPORT-PLA' || material === 'SUPPORT-PA') return material;
  if (/^SUPPORT(?: FOR)? (?:PLA(?:\/PETG)?|W)(?:\b|$)/.test(material)) return 'SUPPORT-PLA';
  if (/^SUPPORT(?: FOR)? (?:PA(?:\/PET)?|G)(?:\b|$)/.test(material)) return 'SUPPORT-PA';
  const match = material.match(/^(PPA|PPS|PETG|PLA|ABS|ASA|TPU|PVA|BVOH|HIPS|PP|POM|PET|PA(?:6|12|HT)?|PC)(?=$|[\s+_/-])/);
  return match ? match[1].replace(/^PA(?:6|12|HT)$/, 'PA') : undefined;
}

function validate(component: 'nozzle'|'bed'|'chamber', value: unknown, model: string, materials: string[]|undefined, startupPurge=false): number {
  if ((typeof value !== 'number' && (typeof value !== 'string' || !/^[+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim()))) || !Number.isFinite(Number(value)) || Number(value) < 0)
    throw new Error(`${component} temperature must be a finite nonnegative number; received ${String(value)}`);
  const temperature = Number(value);
  // Switching a heater off needs no material or machine declaration.
  if (temperature === 0) return 0;
  const normalized = normalizeModel(model);
  if (!normalized) throw new Error(`Unknown printer model '${model}'; cannot establish temperature limits`);
  const maximum = MACHINE_LIMITS[normalized][component];
  if (maximum === undefined || temperature > maximum) throw new Error(`${normalized} ${component} temperature ${temperature} C exceeds the ${maximum ?? 0} C hardware limit`);
  if (component === 'nozzle') {
    if (!materials?.length) throw new Error('Nozzle heating requires a declared material for every affected filament');
    for (const declaration of materials) {
      const material = normalizeMaterial(declaration);
      if (!material) throw new Error(`Unknown material '${declaration}'; cannot authorize positive nozzle temperature`);
      const ceiling = startupPurge && material === 'PLA' ? 290 : MATERIAL_LIMITS[material];
      if (temperature > ceiling) throw new Error(`${material} nozzle temperature ${temperature} C exceeds the independent ${ceiling} C material policy limit`);
    }
  }
  return temperature;
}

export function validateTemperature(component: 'nozzle'|'bed'|'chamber', value: unknown, model: string, materials?: string[]): number {
  return validate(component,value,model,materials);
}

/** Inspector-only exception: the caller must have verified the bounded startup
 * purge form and that no layer/deposition has begun. Never use for manual heat. */
export function validateStartupPurgeTemperature(value: unknown, model: string, materials: string[]): number {
  return validate('nozzle',value,model,materials,true);
}
