import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { BambuImplementation } from '../../dist/printers/bambu.js';

// A raw MQTT transport boundary; never contacts hardware.
test('safety status uses fresh printer report, not configured serial model', async () => {
  const printer = new EventEmitter();
  printer.data = { model: 'H2D', gcode_state: 'IDLE' };
  printer.publish = async payload => {
    if (payload.pushing) queueMicrotask(() => printer.emit('rawMessage', 'device/01PTEST/report', Buffer.from(JSON.stringify({print: {command:'push_status', model_id:'C12', gcode_state:'IDLE', print_error:0, hms:[], nozzle_diameter:'0.4'}}))));
  };
  const impl = new BambuImplementation();
  impl.getPrinter = async () => printer;
  const status = await impl.getSafetyStatus('mock', '01PTEST', 'fake');
  assert.equal(status.model, 'p1s');
  assert.equal(status.observation.source, 'mqtt');
  assert.ok(status.observation.receivedAt >= status.observation.requestedAt);
});

const safety = await import('../../dist/safety/printer-state.js');
const fresh = (raw = {}, extra = {}) => ({
  connected: true, model: 'P1S', serial: '01PTEST', status:'IDLE',
  raw: { model_id:'C12', gcode_state:'IDLE', print_error:0, hms:[], nozzle_diameter:'0.4', nozzle_type:'hardened_steel', ...raw },
  observation:{source:'mqtt',requestedAt:Date.now(),receivedAt:Date.now(),identitySource:'report'}, ...extra,
});
const req = (extra = {}) => ({model:'P1S',nozzleDiameters:[0.4],materials:['PLA'],useAMS:false,...extra});
const check = (status, requirements=req()) => safety.validatePrinterState(status, requirements);
const rawPrinter = (publish) => {
  const printer = new EventEmitter();
  printer.data = {model:'P1S',gcode_state:'IDLE',print_error:0,hms:[],nozzle_diameter:'0.4'};
  printer.publish = async payload => publish(payload, (message, topic='device/01PTEST/report') => printer.emit('rawMessage',topic,Buffer.from(JSON.stringify(message))), printer);
  return printer;
};

test('accepts observed model aliases and a manually declared external material', () => {
  assert.doesNotThrow(() => check(fresh()));
  assert.doesNotThrow(() => check(fresh({model_id:undefined,model:'Bambu Lab A1 mini'}), req({model:'a1mini'})));
  assert.doesNotThrow(() => check(fresh({model_id:undefined,model:'H2D Pro'}), req({model:'h2dpro',nozzleDiameters:[]})));
});
test('rejects missing, stale, future and synthetic telemetry provenance', () => {
  for(const observation of [undefined,{source:'configured',requestedAt:Date.now(),receivedAt:Date.now()}, {source:'mqtt',requestedAt:1,receivedAt:2}, {source:'mqtt',requestedAt:Date.now()+5000,receivedAt:Date.now()+5000}, {source:'mqtt',requestedAt:Date.now(),receivedAt:Date.now()-1}]) {
    assert.throws(() => check(fresh({}, {observation})), /fresh|observ|mqtt|stale/i);
  }
  assert.throws(() => check(fresh({}, {connected:false})), /connect/i);
});
test('configured model or configured serial does not establish observed printer identity', () => {
  assert.throws(() => check(fresh({model_id:undefined}, {model:'P1S'})), /identity|model/i);
  assert.throws(() => check(fresh({model_id:'N2S'})), /model/i);
  assert.throws(() => check(fresh({model_id:'UNRECOGNIZED'})), /identity|model/i);
  assert.throws(() => check(fresh({model_id:undefined,modules:[{name:'ams',sn:'01PTEST'}]})), /identity|model/i);
});
test('a returned ota serial is identity evidence but must match configured printer serial', () => {
  assert.doesNotThrow(() => check(fresh({model_id:undefined,modules:[{name:'ota',sn:'01PTEST'}]})));
  assert.throws(() => check(fresh({modules:[{name:'ota',sn:'01POTHER'}]})), /serial/i);
  assert.throws(() => check(fresh({modules:[{name:'ota',sn:'094OTHER'}]})), /serial|model|identity/i);
});
test('diameter must be reported and match; bed-only state reads may omit diameter', () => {
  for(const nozzle_diameter of [undefined,'unknown',0,'NaN',0.6]) assert.throws(() => check(fresh({nozzle_diameter})), /nozzle|diameter/i);
  assert.doesNotThrow(() => check(fresh({nozzle_diameter:undefined}),req({nozzleDiameters:[]})));
});
test('matches used nozzles by index rather than accepting one matching nozzle among multiple', () => {
  const status = fresh({model_id:'O1D',nozzle_diameter:undefined,device:{nozzle:{info:[{id:0,diameter:0.4,type:'HH01',stat:0},{id:1,diameter:0.6,type:'HS01',stat:0}]}}});
  assert.doesNotThrow(() => check(status,req({model:'h2d',nozzleDiameters:[0.4,0.6]})));
  assert.throws(() => check(status,req({model:'h2d',nozzleDiameters:[0.4,0.4]})), /nozzle|diameter/i);
  assert.throws(() => check(status,req({model:'h2d',nozzleDiameters:[0.4]})), /nozzle|ambiguous/i);
  assert.doesNotThrow(() => check(status,req({model:'h2d',nozzleDiameters:[0.6],usedNozzleIndices:[1],nozzleFlows:['Standard']})));
  assert.throws(() => check(status,req({model:'h2d',nozzleDiameters:[0.6],usedNozzleIndices:[1],nozzleFlows:['High Flow']})), /flow/i);
});
test('reported type, flow, absent or abnormal multi nozzle state cannot contradict job', () => {
  assert.throws(() => check(fresh({nozzle_type:'stainless_steel'}),req({nozzleTypes:['hardened_steel']})), /type/i);
  assert.throws(() => check(fresh({nozzle_type:'HH01'}),req({nozzleFlows:['Standard']})), /flow/i);
  for(const stat of [1,2,4]) assert.throws(() => check(fresh({device:{nozzle:{info:[{id:0,diameter:0.4,type:'HH01',stat}]}}})), /nozzle|reliable|abnormal/i);
});
test('rejects busy, failed, missing or unknown states while allowing IDLE and FINISH', () => {
  for(const gcode_state of ['RUNNING','PAUSE','PREPARE','SLICING','FAILED','OFFLINE','UNKNOWN',undefined]) assert.throws(() => check(fresh({gcode_state})), /state|idle/i);
  assert.doesNotThrow(() => check(fresh({gcode_state:'FINISH'})));
});
test('requires explicit clean print error and valid HMS severity, but permits informative HMS', () => {
  for(const print_error of [undefined,1,'03008004','not-a-number']) assert.throws(() => check(fresh({print_error})), /error/i);
  for(const hms of [undefined,'bad',[{attr:0,code:0x10001}],[{attr:0,code:0x20001}],[{attr:0,code:0x30001}],[{attr:0,code:0x50001}],[{attr:0}],[{severity:'info',code:0x10001}]]) assert.throws(() => check(fresh({hms})), /HMS/i);
  assert.doesNotThrow(() => check(fresh({hms:[{attr:0x03000100,code:0x40001}]})));
  // The refusal names the code so a person can find and dismiss it on the printer.
  assert.throws(() => check(fresh({hms:[{attr:0x05000500,code:0x00010007}]})), /HMS 0500-0500-0001-0007/);
});
const ams = {ams:[{id:'0',tray:[{id:'0',tray_type:'PLA',nozzle_temp_min:'190',nozzle_temp_max:'240'},{id:'1',tray_type:'PETG',nozzle_temp_min:'220',nozzle_temp_max:'270'}]}]};
test('AMS requirements use positional mappings and selected slot material, including external 254', () => {
  assert.doesNotThrow(() => check(fresh({ams}),req({materials:['PLA','PETG'],useAMS:true,amsMapping:[0,1],usedFilamentPositions:[1]})));
  assert.throws(() => check(fresh({ams}),req({useAMS:true,amsMapping:[1]})), /material|PETG/i);
  assert.throws(() => check(fresh({ams}),req({useAMS:true,amsMapping:[2]})), /slot|tray|AMS/i);
  assert.throws(() => check(fresh({ams}),req({useAMS:true,amsMapping:[]})), /mapping/i);
  assert.doesNotThrow(() => check(fresh({ams}),req({useAMS:true,amsMapping:[254]})));
});
test('manual non-RFID spool declaration is allowed but reported material contradictions reject', () => {
  assert.doesNotThrow(() => check(fresh({ams:{ams:[{id:'0',tray:[{id:'0'}]}]}}),req({useAMS:true,amsMapping:[0]})));
  assert.throws(() => check(fresh({vt_tray:{id:'254',tray_type:'PETG'}})), /material/i);
  assert.throws(() => check(fresh(),req({materials:[]})), /material/i);
  assert.throws(() => check(fresh({ams:{...ams,tray_exist_bits:'2'}}),req({useAMS:true,amsMapping:[0]})), /empty|present|slot/i);
});
test('reported spool temperature ranges constrain results and malformed ranges reject', () => {
  const result = check(fresh({ams}),req({useAMS:true,amsMapping:[0]}));
  assert.equal(result.filaments[0].nozzleMax,240);
  assert.throws(() => check(fresh({vt_tray:{tray_type:'PLA',nozzle_temp_min:'280',nozzle_temp_max:'200'}})), /temperature|range/i);
});
test('fresh read ignores cache, pre-request events, acknowledgements and other device topics', async () => {
  const printer = rawPrinter((_payload, emit) => { emit({print:{command:'push_status',gcode_state:'IDLE',model_id:'C12',print_error:0,hms:[]}},'device/OTHER/report'); emit({print:{command:'push_status',sequence_id:'1'}}); });
  await assert.rejects(safety.readFreshPrinterStatus(printer,'01PTEST',20),/fresh|timed out/i);
  assert.equal(printer.listenerCount('rawMessage'),0);
});
test('fresh read obtains missing model from current get_version ota response', async () => {
  const printer = rawPrinter((payload, emit) => {
    if(payload.pushing) emit({print:{command:'push_status',gcode_state:'IDLE',print_error:0,hms:[],nozzle_diameter:'0.4'}});
    if(payload.info) emit({info:{command:'get_version',module:[{name:'ota',sn:'01PTEST'}]}});
  });
  const status = await safety.readFreshPrinterStatus(printer,'01PTEST',50);
  assert.equal(status.model,'p1s'); assert.equal(status.observedSerial,'01PTEST');
  assert.equal(status.observation.identitySource,'module-serial');
  assert.doesNotThrow(() => check(status));
  assert.equal(printer.listenerCount('rawMessage'),0);
});
test('fresh read fails on disconnect or publish failure, and bounds hung request', async () => {
  const disconnected = rawPrinter((_payload,_emit,p) => p.emit('client:disconnect'));
  await assert.rejects(safety.readFreshPrinterStatus(disconnected,'01PTEST',20),/disconnect/i);
  const failed = rawPrinter(() => { throw Error('publish failed'); });
  await assert.rejects(safety.readFreshPrinterStatus(failed,'01PTEST',20),/publish failed/);
  const hung = rawPrinter(() => new Promise(() => {}));
  await assert.rejects(safety.readFreshPrinterStatus(hung,'01PTEST',20),/fresh|timed out/i);
});

test('AMS HT slot128 is addressed as unit128 slot0, preserving its material check', () => {
  const reported = {ams:[{id:'128',tray:[{id:'0',tray_type:'PLA'}]}]};
  assert.doesNotThrow(() => check(fresh({ams:reported}),req({useAMS:true,amsMapping:[128]})));
  assert.throws(() => check(fresh({ams:reported}),req({materials:['PETG'],useAMS:true,amsMapping:[128]})),/material/i);
});
test('known dual-nozzle printers reject a scalar legacy report that cannot establish both nozzles', () => {
  assert.throws(() => check(fresh({model_id:'O1D'}),req({model:'h2d'})),/nozzle|ambiguous/i);
});
test('two external spool reports cannot silently select whichever happens to match', () => {
  assert.throws(() => check(fresh({vir_slot:[{id:'254',tray_type:'PLA'},{id:'255',tray_type:'PETG'}]})),/external|material|ambiguous/i);
});
test('old raw observations and fresh partial error reports cannot satisfy a new request', async () => {
  const printer = rawPrinter((_payload,emit) => emit({print:{command:'push_status',gcode_state:'IDLE',model_id:'C12'}}));
  printer.emit('rawMessage','device/01PTEST/report',Buffer.from(JSON.stringify({print:{command:'push_status',gcode_state:'IDLE',model_id:'C12',print_error:0,hms:[]}})));
  await assert.rejects(safety.readFreshPrinterStatus(printer,'01PTEST',20),/fresh|timed out/i);
});

test('a scalar file diameter is accepted only when every fresh physical nozzle matches', () => {
  const device={nozzle:{info:[{id:0,diameter:0.4,type:'HH01',stat:0},{id:1,diameter:0.4,type:'HH01',stat:0}]}};
  assert.doesNotThrow(() => check(fresh({model_id:'O1D',device}),req({model:'h2d'})));
});
test('modern external spool reports cannot be hidden by a matching legacy tray field', () => {
  assert.throws(() => check(fresh({vt_tray:{tray_type:'PLA'},vir_slot:[{id:'254',tray_type:'PETG'}]})),/material/i);
});

test('manual nozzle heating checks the loaded AMS material instead of an unrelated external spool', () => {
  const status=fresh({ams:{...ams,tray_now:'0'},vt_tray:{tray_type:'PA'}});
  const requirements=safety.manualHeatingRequirements(status,'p1s',0.4,'PA');
  assert.equal(requirements.useAMS,true);
  assert.deepEqual(requirements.amsMapping,[0]);
  assert.deepEqual(requirements.usedNozzleIndices,[0]);
  assert.throws(() => check(status,requirements),/material/i);
  assert.doesNotThrow(() => check(status,safety.manualHeatingRequirements(status,'p1s',0.4,'PLA')));
});
test('manual heating permits declared external or unloaded material and rejects unknown loaded AMS state', () => {
  for(const tray_now of ['254','255']) {
    const status=fresh({ams:{...ams,tray_now}});
    assert.doesNotThrow(() => check(status,safety.manualHeatingRequirements(status,'p1s',0.4,'PLA')));
  }
  for(const tray_now of [undefined,'',NaN,-1,'garbage']) {
    assert.throws(() => safety.manualHeatingRequirements(fresh({ams:{...ams,tray_now}}),'p1s',0.4,'PLA'),/loaded|tray|AMS/i);
  }
  assert.doesNotThrow(() => check(fresh(),safety.manualHeatingRequirements(fresh(),'p1s',0.4,'PLA')));
});
test('manual heating refuses ambiguous multi-nozzle active selection', () => {
  const status=fresh({model_id:'O1D',device:{nozzle:{info:[{id:0,diameter:0.4,type:'HH01',stat:0},{id:1,diameter:0.4,type:'HH01',stat:0}]}}});
  assert.throws(() => safety.manualHeatingRequirements(status,'h2d',0.4,'PLA'),/multi.nozzle|sliced|active/i);
});

test('explicit job nozzle type and flow requirements cannot pass unknown reported configuration', () => {
  for(const [field,value] of [['nozzleTypes','hardened_steel'],['nozzleFlows','High Flow']]) {
    assert.throws(() => check(fresh({nozzle_type:undefined}),req({[field]:[value]})),/nozzle|type|flow/i);
    assert.throws(() => check(fresh(),req({[field]:['unrecognized']})),/nozzle|type|flow/i);
    assert.throws(() => check(fresh(),req({[field]:['']})),/nozzle|type|flow/i);
  }
});

test('legacy nozzle reports use Bambu standard-flow default and flag3 high-flow override', () => {
  assert.doesNotThrow(() => check(fresh(),req({nozzleFlows:['Standard']})));
  assert.throws(() => check(fresh({flag3:1024}),req({nozzleFlows:['Standard']})),/flow/i);
  assert.doesNotThrow(() => check(fresh({flag3:1024}),req({nozzleFlows:['High Flow']})));
  assert.throws(() => check(fresh({flag3:1024}),req({nozzleFlows:['Standard']})),/flow/i);
  assert.throws(() => check(fresh({flag3:2048}),req({nozzleFlows:['Standard']})),/flow|nozzle/i);
});

// mcp-3d-printer-server does not install the fork's bambu-node patch; the
// fresh read publishes the patched wire shape itself.
test('fresh reads publish pushall and get_version with string sequence ids without the fork patch', async () => {
  const published = [];
  const printer = rawPrinter((payload, emit) => {
    published.push(payload);
    if (payload.pushing) emit({print:{command:'push_status',model_id:'C12',gcode_state:'IDLE',print_error:0,hms:[]}});
  });
  const status = await safety.readFreshPrinterStatus(printer,'01PTEST',100);
  assert.equal(status.model,'p1s');
  assert.deepEqual(published.map(payload => Object.keys(payload)[0]).sort(), ['info','pushing']);
  assert.equal(published.find(payload => payload.pushing).pushing.command,'pushall');
  assert.equal(published.find(payload => payload.info).info.command,'get_version');
  for (const payload of published) assert.match(Object.values(payload)[0].sequence_id, /^\d+$/);
});
