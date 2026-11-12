import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import JSZip from 'jszip';
import { BambuImplementation } from '../dist/printers/bambu.js';

process.env.BAMBU_DISPATCH_CHECK_MS = '0';
process.env.BAMBU_STUDIO_CONFIG = '';

async function capture(t, options = {}, suffix = '.3mf') {
  t.mock.method(net.Socket.prototype, 'connect', () => { throw new Error('Network forbidden in payload test'); });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'calibration-payload-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, `plate${suffix}`);
  const zip = new JSZip();
  zip.file('Metadata/plate_1.gcode', '; printer_model = p1s\n; nozzle_diameter = 0.4\n; filament_type = PLA\n; filament_colour = #FFFFFF\nM104 S220\nM140 S60\nG1 X0 Y0\n');
  zip.file('Metadata/plate_1.json', JSON.stringify({ filament_ids: [0] }));
  await fs.writeFile(file, await zip.generateAsync({ type: 'nodebuffer' }));
  const printer = new BambuImplementation(async () => true);
  const packets = [];
  let uploads = 0;
  printer.ftpUpload = async () => { uploads++; };
  printer.getSafetyStatus = async () => {
    const now = Date.now();
    return { connected: true, model: 'p1s', serial: '01PTEST', status: 'IDLE',
      raw: { model: 'p1s', serial: '01PTEST', gcode_state: 'IDLE', nozzle_diameter: '0.4',
        vt_tray: { id: '254', tray_type: 'PLA' }, nozzle_type: 'hardened_steel', print_error: 0, hms: [],
        ams: { tray_now: '254', ams: [{ id: '0', tray: [{ id: '2', tray_type: 'PLA' }] }] } },
      observation: { source: 'mqtt', requestedAt: now, receivedAt: now, identitySource: 'report' } };
  };
  printer.getPrinter = async () => ({ publish: async packet => packets.push(typeof packet === 'string' ? JSON.parse(packet) : packet),
    executeCommand: async command => packets.push(command) });
  const result = await printer.print3mf('127.0.0.1', '01PTEST', 'DUMMY', {
    projectName: 'plate', filePath: file, bambuModel: 'p1s', nozzleDiameters: [0.4],
    useAMS: true, amsSlots: [2], ...options,
  });
  assert.equal(uploads, 1);
  assert.equal(packets.length, 1, 'a start is never replayed');
  return { packet: packets[0].print, result };
}

test('P1S project_file uses Studio boolean defaults and exact positional AMS selection', async t => {
  const { packet, result } = await capture(t);
  assert.equal(packet.flow_cali, false);
  assert.equal(packet.vibration_cali, false);
  assert.equal(packet.bed_leveling, true);
  assert.equal(packet.layer_inspect, true);
  assert.deepEqual(packet.ams_mapping, [2, -1, -1, -1, -1]);
  assert.equal(result.calibration.resolved.auto_flow_cali, 2);
  assert.equal(result.calibration.transmitted.auto_flow_cali, null);
  assert.equal(result.calibration.transmitted.task_flow_cali, false);
  assert.deepEqual(result.calibration.requested, {});
  assert.equal('auto_flow_cali' in packet, false, 'no guessed SDK wire fields');
});

for (const enabled of [false, true]) {
  test(`P1S preserves explicit calibration booleans ${enabled}`, async t => {
    const { packet, result } = await capture(t, {
      flowCalibration: enabled, vibrationCalibration: enabled, bedLeveling: enabled, layerInspect: enabled,
    });
    assert.equal(packet.flow_cali, enabled);
    assert.equal(packet.vibration_cali, enabled);
    assert.equal(packet.bed_leveling, enabled);
    assert.equal(packet.layer_inspect, enabled);
    assert.equal(result.calibration.requested.flowCalibration, enabled);
  });
}

for (const [key, values] of Object.entries({ autoFlowCali: [0, 2], autoOffsetCali: [0, 2], extruderCaliManualMode: [0, 1] })) {
  for (const value of values) {
    test(`P1S explicitly reports unsupported ${key}=${value}`, async t => {
      const { packet, result } = await capture(t, { [key]: value });
      assert.equal(result.calibration.requested[key], value);
      assert.ok(result.calibration.unsupported.includes(key));
      assert.match(result.calibration.warning, /not transmitted.*not equivalent/i);
      assert.equal('auto_flow_cali' in packet, false);
    });
  }
}

test('P1S external-spool payload preserves Studio defaults and disables AMS', async t => {
  const { packet, result } = await capture(t, { useAMS: false, amsSlots: undefined });
  assert.equal(packet.use_ams, false);
  assert.equal(packet.flow_cali, false);
  assert.equal(packet.vibration_cali, false);
  assert.equal(result.calibration.transmitted.auto_flow_cali, null);
});
