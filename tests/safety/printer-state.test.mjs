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
// bambu-printer-mcp #67: a stock H2D reports stat 1 (Bambu Studio DevNozzle:
// information unreliable) on both HS01 nozzles, which have no identity chip (sn "N/A").
test('stock nozzles without an identity chip pass bit 0 while abnormal, unknown and chipped unreliable nozzles still block', (t) => {
  const logged = [];
  t.mock.method(console, 'error', (...args) => logged.push(args.join(' ')));
  const h2dReport = (overrides = {}, serial = '094H2DSTOCK') => fresh({model_id:'O1D', nozzle_diameter:undefined, device:{nozzle:{exist:3, hc:0, src_id:0, state:4096, tar_id:0, info:[
    {id:0, diameter:0.4, type:'HS01', stat:1, sn:'N/A', color_m:'00000000', fila_id:'', p_t:0, tm:0, wear:0, ...overrides},
    {id:1, diameter:0.4, type:'HS01', stat:1, sn:'N/A', color_m:'00000000', fila_id:'', p_t:0, tm:0, wear:0},
  ]}}}, {serial});
  const job = req({model:'h2d', nozzleDiameters:[0.4,0.4], nozzleTypes:['hardened_steel','hardened_steel'], nozzleFlows:['standard','standard'], verifyMaterials:false});
  assert.doesNotThrow(() => check(h2dReport(), job));
  assert.doesNotThrow(() => check(h2dReport(), job));
  assert.deepEqual(safety.unchippedNozzles(h2dReport().raw), [0, 1]);
  // Accepted unchipped nozzles are recorded once per printer, for headless setups without a prompt.
  assert.deepEqual(logged.filter(line => /identity chip/.test(line)), [
    "Printer 094H2DSTOCK nozzle 0 reports no identity chip; its diameter and type are the printer's configured settings.",
    "Printer 094H2DSTOCK nozzle 1 reports no identity chip; its diameter and type are the printer's configured settings.",
  ]);
  // The file-to-hardware comparison is unchanged.
  assert.throws(() => check(h2dReport({diameter:0.6}), job), /nozzle 0 diameter/i);
  assert.throws(() => check(h2dReport({type:'HS00'}), job), /nozzle 0 type/i);
  // Bits 1-2 are abnormal or unknown regardless of the chip.
  for (const stat of [2, 3, 4, 5, 6, 7]) assert.throws(() => check(h2dReport({stat}), job), /unreliable, abnormal or unknown/, `stat ${stat}`);
  // A chipped nozzle whose information is unreliable must be refreshed first.
  for (const sn of ['B0123456789', '', undefined]) {
    assert.throws(() => check(h2dReport({sn}), job), /nozzle 0 information is unreliable; refresh the nozzle information on the printer/, `sn ${sn}`);
    assert.deepEqual(safety.unchippedNozzles(h2dReport({sn}).raw), [1]);
  }
  // A rejected check logs nothing for that printer.
  const rejectedSerial = '094H2DREJECT';
  assert.throws(() => check(h2dReport({diameter:0.6}, rejectedSerial), job), /diameter/);
  assert.equal(logged.filter(line => line.includes(rejectedSerial)).length, 0);
  assert.deepEqual(safety.unchippedNozzles(h2dReport({stat:0}).raw), [1]);
  assert.deepEqual(safety.unchippedNozzles({}), []);
});
// bambu-printer-mcp 1.1.34: the first push after connecting can be a sparse
// hello; get_printer_status returned UNKNOWN when the full status arrived later.
test('get_printer_status waits for the full report that follows a sparse first push, within its bound', async () => {
  const statusAfter = async (fullAfterMs) => {
    const printer = { data: {model:'P1S', modules:[]}, executeCommand: async () => {} };
    if (fullAfterMs !== undefined) setTimeout(() => { printer.data = {...printer.data, gcode_state:'IDLE', nozzle_temper:27}; }, fullAfterMs);
    const impl = new BambuImplementation();
    impl.getPrinter = async () => printer;
    const started = Date.now();
    const status = await impl.getStatus('mock', '', '01PTEST:fake');
    return {status, elapsed: Date.now() - started};
  };
  const delayed = await statusAfter(600);
  assert.equal(delayed.status.status, 'IDLE');
  assert.equal(delayed.status.temperatures.nozzle.actual, 27);
  assert.ok(delayed.elapsed < 1400, `returns once the full status has merged (${delayed.elapsed} ms)`);
  const silent = await statusAfter(undefined);
  assert.equal(silent.status.status, 'UNKNOWN', 'a printer that never sends the full status still returns');
  assert.ok(silent.elapsed >= 1400 && silent.elapsed < 2500, `within the existing 1.5 s bound (${silent.elapsed} ms)`);
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

test('fresh A1 returned serials distinguish full-size 039 from mini 030',async()=>{
  for(const [prefix,expected] of [['039','a1'],['030','a1mini']]) {
    const serial=prefix+'FIXTURE';
    const printer=rawPrinter((payload,emit)=>{
      if(payload.pushing) emit({print:{command:'push_status',gcode_state:'IDLE',print_error:0,hms:[],nozzle_diameter:'0.4'}},`device/${serial}/report`);
      if(payload.info) emit({info:{command:'get_version',module:[{name:'ota',sn:serial}]}},`device/${serial}/report`);
    });
    const result=await safety.readFreshPrinterStatus(printer,serial,50);
    assert.equal(result.model,expected);assert.equal(result.observedSerial,serial);
  }
});

test('ignores a print-job id in model_id when model or returned serial identifies X2D', () => {
  const requirements = req({model:'x2d',nozzleDiameters:[],verifyMaterials:false});
  assert.doesNotThrow(() => check(fresh({model_id:'USb5974ce12ab89d',model:'X2D'}), requirements));
  assert.doesNotThrow(() => check(fresh({model_id:'USb5974ce12ab89d',modules:[{name:'ota',sn:'20PTEST'}]}, {serial:'20PTEST'}), requirements));
  assert.throws(() => check(fresh({model_id:'N6',model:'P1S'}), requirements), /contradictory/i);
  assert.throws(() => check(fresh({model_id:undefined,model:'P1S',modules:[{name:'ota',sn:'20PTEST'}]}, {serial:'20PTEST'}), requirements), /contradictory/i);
  assert.throws(() => check(fresh({model_id:'USb5974ce12ab89d',model:'X2D',printer_type:'unknown'}), requirements), /unknown model identity/i);
});

test('official H2C and H2D Pro returned serials agree with declared identity and reject conflicts', () => {
  for(const [prefix,model,modelId,other] of [['31B','h2c','O1C2','O1E'],['239','h2dpro','O1E','O1C2']]) {
    const serial=prefix+'TEST';
    const status=fresh({model_id:modelId,modules:[{name:'ota',sn:serial}]},{serial});
    assert.doesNotThrow(()=>check(status,req({model,serial,nozzleDiameters:[]})));
    assert.throws(()=>check(fresh({model_id:other,modules:[{name:'ota',sn:serial}]},{serial}),req({model,serial,nozzleDiameters:[]})),/identity|conflict|model/i);
    assert.throws(()=>check(fresh({model_id:undefined}),req({model,serial,nozzleDiameters:[]})),/identity|model/i);
  }
});
