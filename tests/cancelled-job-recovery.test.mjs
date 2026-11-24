import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validatePrinterState } from '../dist/safety/printer-state.js';

const serial = '20PCANCELTEST';
const canceled = (overrides = {}) => ({
  model: 'x2d', gcode_state: 'FAILED', print_error: 0, fail_reason: '50348044', hms: [],
  gcode_file: 'cache/previous.3mf', subtask_name: 'previous', task_id: '1', subtask_id: '0', job_id: '0',
  nozzle_diameter: ['0.4', '0.4'], vir_slot: [{ id: 255, tray_type: 'PETG' }, { id: 254, tray_type: 'PLA' }],
  ...overrides,
});
const fresh = raw => ({
  connected: true, model: raw.model, serial, status: raw.gcode_state, raw: structuredClone(raw),
  observation: { source: 'mqtt', requestedAt: Date.now() - 1, receivedAt: Date.now(), identitySource: 'report' },
});
const requirements = { model: 'x2d', nozzleDiameters: [0.4, 0.4], materials: ['PETG'], useAMS: false, amsMapping: [255], filamentNozzleIndices: [0] };
const inspection = { ...requirements, maxNozzleTemperature: 250, maxBedTemperature: 70, maxChamberTemperature: 0, sha256: 'a'.repeat(64) };

test('only the exact clean X2D cancellation qualifies as terminal', () => {
  assert.doesNotThrow(() => validatePrinterState(fresh(canceled()), requirements));
  for (const overrides of [
    { fail_reason: undefined }, { fail_reason: null }, { fail_reason: '' }, { fail_reason: 0 },
    { fail_reason: 0x0300400d }, { print_error: 123 }, { print_error: null },
    { subtask_name: '', gcode_file: '' }, { gcode_state: 'PAUSE' }, { gcode_state: 'RUNNING' },
    { hms: [{ attr: 1, code: 0x20001 }] }, { hms: undefined },
    { model: 'h2d' }, { nozzle_diameter: ['0.6', '0.4'] }, { vir_slot: [{ id: 255, tray_type: 'PLA' }] },
  ]) assert.throws(() => validatePrinterState(fresh(canceled(overrides)), requirements), JSON.stringify(overrides));
  assert.throws(() => validatePrinterState(fresh(canceled({ gcode_state: 'RUNNING' })), requirements),
    error => /not safely idle/.test(error.message) && error.code === 'printer-not-ready', 'a busy printer refuses with a stable code');
  const stale = fresh(canceled());
  stale.observation.requestedAt -= 60_000;
  assert.throws(() => validatePrinterState(stale, requirements), /fresh|stale/);
});

// H2C (serial prefix 31B) after a Stop sent through this server: gcode_state FAILED,
// print_error 0, fail_reason "50348044" (0300400C), the stopped job's name and file.
test('the exact clean H2C cancellation qualifies as terminal', () => {
  const h2c = overrides => ({ ...fresh(canceled({ model: 'h2c', ...overrides })), serial: '31BCANCELTEST' });
  const required = { ...requirements, model: 'h2c' };
  assert.doesNotThrow(() => validatePrinterState(h2c(), required));
  for (const overrides of [
    { fail_reason: undefined }, { fail_reason: 0 }, { fail_reason: 0x0300400d }, { print_error: 123 },
    { subtask_name: '', gcode_file: '' }, { gcode_state: 'RUNNING' }, { hms: [{ attr: 1, code: 0x20001 }] },
  ]) assert.throws(() => validatePrinterState(h2c(overrides), required), JSON.stringify(overrides));
});

test('the same canceled report from a matching non-X2D printer stays blocked', () => {
  for (const [model, prefix, nozzles] of [['h2d', '094', ['0.4', '0.4']], ['h2dpro', '239', ['0.4', '0.4']], ['p1s', '01P', ['0.4']]]) {
    const status = { ...fresh(canceled({ model, nozzle_diameter: nozzles })), serial: `${prefix}CANCELTEST` };
    const required = { ...requirements, model, nozzleDiameters: nozzles.map(Number) };
    assert.throws(() => validatePrinterState(status, required), /Printer state FAILED is not safely idle/, model);
  }
});


test('terminal recovery keeps every observed job field bound through preflight', async () => {
  const {assertSameTerminalJob}=await import('../dist/safety/printer-state.js');
  for(const model of ['x2d','h2c']) {
    const initial=fresh(canceled({model}));
    assert.doesNotThrow(()=>assertSameTerminalJob(initial,fresh(canceled({model})),model));
    for(const field of ['gcode_file','subtask_name','task_id','subtask_id','job_id'])
      assert.throws(()=>assertSameTerminalJob(initial,fresh(canceled({model,[field]:'changed'})),model),/job changed/i,field);
    assert.throws(()=>assertSameTerminalJob(fresh(canceled({model,gcode_state:'IDLE'})),initial,model),/job changed/i);
  }
});
