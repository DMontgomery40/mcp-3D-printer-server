// Ported from bambu-printer-mcp tests/safety/print-file.test.mjs; print-file.ts is a verbatim port.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import JSZip from 'jszip';
const load = async () => {
  const module = await import('../../dist/safety/print-file.js').catch(() => ({}));
  assert.equal(typeof module.inspectPrintFile, 'function', 'print artifact inspection must exist'); return module;
};
const header = (model='P1S', material='PLA', nozzle='0.4') => `; printer_model = Bambu Lab ${model}\n; nozzle_diameter = ${nozzle}\n; filament_type = ${material}\n`;
async function fixture(t, text, entries) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bambu-file-safety-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const filename=path.join(dir,entries ? 'job.gcode.3mf' : 'job.gcode');let bytes=text;
  if(entries) {const zip=new JSZip();for(const [key,value] of Object.entries(entries)) zip.file(key,typeof value==='string'?value:JSON.stringify(value));bytes=await zip.generateAsync({type:'nodebuffer'});}
  await fs.writeFile(filename,bytes); return filename;
}
async function inspect(t,text,options={model:'p1s'},entries) {const {inspectPrintFile}=await load(); return inspectPrintFile(await fixture(t,text,entries),options);}
test('valid raw Bambu G-code returns identity, materials, peaks and exact artifact hash',async t=>{
  const source=header()+'M104 S250\nM109 R220\nM140 S60\nG1 X20 Y20 E1\nM104 S0\n';const r=await inspect(t,source);
  assert.equal(r.model,'p1s');assert.deepEqual(r.nozzleDiameters,[0.4]);assert.deepEqual(r.materials,['PLA']);assert.deepEqual(r.usedFilamentPositions,[0]);
  assert.equal(r.maxNozzleTemperature,250);assert.equal(r.maxBedTemperature,60);assert.equal(r.sha256,crypto.createHash('sha256').update(source).digest('hex'));
});
test('all late, reordered, numbered and commented heater targets are inspected',async t=>{
  for(const command of ['M104 S400','M109 R400','M104 T0 S400','N123 M109 (wait) R400','m104s400','M140 S101','M190 R101','M104 S220 R400','M104 S220\n'+('G1 X1\n'.repeat(10000))+'M104 S400'])
    await assert.rejects(inspect(t,header()+command+'\n'),/temperature|limit|target/i,command);
});
test('malformed, nonfinite, dynamic and negative thermal targets cannot authorize heat',async t=>{
  for(const command of ['M104 SNaN','M104 SInfinity','M104 S-1','M104 S','M104 S1e309','M104 S{nozzle_temperature}','M109 R[temperature]','M104 S220 S400','M104 S220foo','G1 X0 M104 S400','M104.1 S400','SET_HEATER_TEMPERATURE HEATER=extruder TARGET=400','M303 S400','M145 S0 H400','M149 F','G10 P0 S400'])
    await assert.rejects(inspect(t,header()+command+'\n'),/temperature|unsupported|syntax|target|parameter|command|dynamic/i,command);
});
test('comments cannot authorize heat and ordinary vendor commands survive inspection',async t=>{
  const r=await inspect(t,header()+'; M104 S400\n(M109 S400)\nM1002 gcode_claim_action : 0\nM960 S5 P1\nM400 U1\nG28\nG1 X-20 Y265\nM104 S250 ; M104 S400\nM142 P1 R35 S40\n');assert.equal(r.maxNozzleTemperature,250);
});
test('credible model nozzle and material metadata are mandatory and contradictions reject',async t=>{
  for(const source of ['M104 S220',header().replace(/; printer_model[^\n]*\n/,''),header().replace(/; nozzle_diameter[^\n]*\n/,''),header().replace(/; filament_type[^\n]*\n/,''),header('H2D'),header()+ '; printer_model = A1\n',header('P1S','UnknownBlend')])
    await assert.rejects(inspect(t,source+'\nM104 S220\n'),/metadata|model|material|nozzle|contradict|unknown/i);
  await assert.rejects(inspect(t,header()+'M104 S220\n',{model:'p1s',nozzleDiameters:[0.6]}),/nozzle/i);
  await assert.rejects(inspect(t,header()+'; curr_bed_type = Textured PEI Plate\nM104 S220\n',{model:'p1s',bedType:'Smooth PEI Plate'}),/bed/i);
});
test('selected plate alone is inspected before dispatch and project metadata can supply headers',async t=>{
  const entries={'Metadata/project_settings.config':{printer_model:'Bambu Lab P1S',nozzle_diameter:['0.4'],filament_type:['PLA','PETG']},'Metadata/plate_1.gcode':header()+'M104 S400\n','Metadata/plate_2.gcode':'T1\nM104 S250\nM140 S60\n','Metadata/plate_2.json':{filament_ids:[1]}};
  const r=await inspect(t,'',{model:'p1s',plateIndex:1},entries);assert.equal(r.plateInternalPath,'Metadata/plate_2.gcode');assert.deepEqual(r.usedFilamentPositions,[1]);
  await assert.rejects(inspect(t,'',{model:'p1s',plateIndex:2},entries),/plate.*3|selected plate/i);
  await assert.rejects(inspect(t,'',{model:'p1s',plateIndex:-1},entries),/plate/i);
  await assert.rejects(inspect(t,'',{model:'p1s'},{...entries,'Metadata/project_settings.config':{printer_model:'A1',nozzle_diameter:['0.4'],filament_type:['PLA']}}),/model|contradict/i);
});
test('checksum artifacts and unsliced archives are never printable',async t=>{
  const {inspectPrintFile}=await load();const file=await fixture(t,'d41d8cd98f00b204e9800998ecf8427e');await fs.rename(file,file+'.md5');
  await assert.rejects(inspectPrintFile(file+'.md5',{model:'p1s'}),/checksum|printable/i);
  await assert.rejects(inspect(t,'',{model:'p1s'},{'Metadata/plate_1.gcode.md5':'d41d8cd98f00b204e9800998ecf8427e'}),/selected plate|printable/i);
  await assert.rejects(inspect(t,header()),/command|empty|printable/i);
});
test('independent material ceilings override editable self-reported maxima',async t=>{
  for(const temp of [300,400]) await assert.rejects(inspect(t,header('H2D')+'; nozzle_temperature_range_high = 500\nM104 S'+temp+'\n',{model:'h2d'}),/material|PLA|temperature/i);
  const r=await inspect(t,header('X1E')+'M109 S290\nM106 P1 S0\nG92 E0\nG1 E50 F200\nM400\nM104 S220\n',{model:'x1e'});assert.equal(r.maxNozzleTemperature,290);
});
test('tool changes and Bambu purge parameters retain positional material ceilings',async t=>{
  await assert.rejects(inspect(t,header('H2D','PLA;PA-CF','0.4;0.4')+'T0\nM104 S320\n',{model:'h2d'}),/PLA|material/i);
  const r=await inspect(t,header('H2D','PLA;PA-CF','0.4;0.4')+'T1\nM104 S320\nM620.10 A1 F100 L40 H0.4 T330 P320\n',{model:'h2d'});assert.equal(r.maxNozzleTemperature,330);assert.deepEqual(r.usedFilamentPositions,[1]);
  for(const command of ['T9\nM104 S220','M620.1 E F100 T400','M620.10 A0 F100 L40 H0.4 T400 P220','M620.10 A1 F100 L40 H0.4 T250 P400']) await assert.rejects(inspect(t,header()+command+'\n'),/material|filament|temperature|tool|target|limit/i);
});
test('declared object bounds reject oversize objects while wipe motion is not treated as geometry',async t=>{
  const valid=header('A1 mini')+'; MINX: 10\n; MINY: 10\n; MINZ: 0.2\n; MAXX: 170\n; MAXY: 170\n; MAXZ: 150\nG1 X-12 Y185\nM104 S220\n';await inspect(t,valid,{model:'a1mini'});
  await assert.rejects(inspect(t,valid.replace('MAXX: 170','MAXX: 200'),{model:'a1mini'}),/bounds|volume/i);
});
test('manual temperature validation uses machine component limits and finite numeric targets',async()=>{
  await load();const {validateTemperature,normalizeModel,normalizeMaterial}=await import('../../dist/safety/limits.js');
  assert.equal(normalizeModel('Bambu Lab A1 mini'),'a1mini');assert.equal(normalizeModel('X1 Carbon'),'x1c');assert.equal(normalizeModel('unknown'),undefined);assert.equal(normalizeMaterial('Bambu PLA Basic'),'PLA');assert.equal(normalizeMaterial('PA6-CF'),'PA');
  for(const [model,component,value] of [['p1s','bed',101],['a1mini','bed',81],['h2d','bed',121],['x1c','bed',111],['x1e','chamber',61],['p1s','chamber',1],['p1s','nozzle',301]]) assert.throws(()=>validateTemperature(component,value,model,['PA']),/limit|temperature|chamber/i);
  for(const target of [NaN,Infinity,-1,'NaN','',null,true,{},'2e2']) assert.throws(()=>validateTemperature('nozzle',target,'p1s',['PLA']),/temperature|number|finite|target/i);
  assert.throws(()=>validateTemperature('nozzle',220,'p1s'),/material/i);assert.equal(validateTemperature('nozzle',0,'p1s'),0);assert.equal(validateTemperature('bed','60','p1s'),60);
});
test('H2D vendor startup flags, heater-off targets and unload sentinels remain usable',async t=>{
  const source=header('H2D','PETG','0.4;0.4')+'M620 M\nM620.10 A0 F74.8347 H0.4 T270 P220 S1\nM620 S0A\nT0\nM621 S0A\nM109 S140 A\nM104 S220 A\nM620 S65535\nT65535\nM621 S65535\nM620 S65279\nT65279\nM621 S65279\nM104 S0 T0\nM104 S0 T1\n';
  const result=await inspect(t,source,{model:'h2d',nozzleDiameters:[0.4]});assert.equal(result.maxNozzleTemperature,270);assert.equal(result.selectsAms,true);
});
test('explicit physical heater targets cannot silently select a different filament material',async t=>{
  await assert.rejects(inspect(t,header('H2D','PLA;PA-CF','0.4;0.4')+'M104 T1 S330\n',{model:'h2d'}),/PLA|material|mapping/i);
});
test('switching to a low-temperature material cannot inherit an unsafe high-temperature target',async t=>{
  await assert.rejects(inspect(t,header('H2D','PLA;PA-CF','0.4;0.4')+'T1\nM104 S330\nT0\nG1 E10\n',{model:'h2d'}),/PLA|material|temperature/i);
});
// The fork's installed-profile startup-routine test needs the slicer profile
// flattener (owned by the slicer port), so it is omitted here.
test('zero-padded heater commands and concatenated commands cannot bypass inspection',async t=>{
  for(const command of ['M0104 S400','N5M00109 R400','G1X0M104S400','M00104.0 S400','M620.99 T400']) await assert.rejects(inspect(t,header()+command+'\n'),/temperature|unsupported|command|limit/i);
});
test('physical heater targeting cannot borrow a previously selected high-temperature filament',async t=>{
  await assert.rejects(inspect(t,header('H2D','PLA;PA-CF','0.4;0.4')+'T1\nM104 S320\nM104 T0 S330\n',{model:'h2d'}),/PLA|material|mapping/i);
});
test('optional nozzle type and flow declarations retain per-nozzle positions',async t=>{
  const source=header('H2D','PLA','0.4;0.4')+'; nozzle_type = hardened_steel;stainless_steel\n; nozzle_flow = standard;high_flow\nM104 S220\n';
  const result=await inspect(t,source,{model:'h2d'});assert.deepEqual(result.nozzleTypes,['hardened_steel','stainless_steel']);assert.deepEqual(result.nozzleFlows,['standard','high_flow']);
  await assert.rejects(inspect(t,source.replace('hardened_steel;stainless_steel','hardened_steel'),{model:'h2d'}),/nozzle.*type|metadata/i);
});
test('recognized support-material names remain valid after normalization',async t=>{
  const result=await inspect(t,header('P1S','Support for PLA/PETG')+'M104 S250\n');assert.deepEqual(result.materials,['SUPPORT-PLA']);
});
test('Bambu plate JSON object bounds and bed contradictions are checked',async t=>{
  const entries={'Metadata/plate_1.gcode':header('A1 mini')+'M104 S220\n','Metadata/plate_1.json':{filament_ids:[0],bbox_all:[10,10,200,150],bed_type:'textured_plate'}};
  await assert.rejects(inspect(t,'',{model:'a1mini'},entries),/bounds|volume/i);
  entries['Metadata/plate_1.json'].bbox_all=[10,10,150,150];
  await inspect(t,'',{model:'a1mini',bedType:'textured_plate'},entries);
  await assert.rejects(inspect(t,'',{model:'a1mini',bedType:'hot_plate'},entries),/bed/i);
  entries['Metadata/plate_1.json'].bbox_objects=[{bbox:[0,0,250,100]}];
  await assert.rejects(inspect(t,'',{model:'a1mini'},entries),/bounds|volume/i);
});
test('vendor probing and all-nozzle heating cannot bypass material limits',async t=>{
  await assert.rejects(inspect(t,header()+'G383 O0 M2 T400\n'),/temperature|limit/i);
  await assert.rejects(inspect(t,header('H2D','PLA;PA-CF','0.4;0.4')+'T1\nM104 S330 A\n',{model:'h2d'}),/PLA|material/i);
  await assert.rejects(inspect(t,header('H2D','PA-CF;PLA','0.4;0.4')+'T0\nM104 S220\nT1\nM620.10 A0 F100 L40 H0.4 T320 P220\n',{model:'h2d'}),/PLA|material/i);
});
test('Bambu nozzle_volume_type is retained and conflicting flow aliases reject',async t=>{
  const entries={'Metadata/plate_1.gcode':header('H2D','PLA','0.4;0.4')+'; nozzle_flow = high_flow;High-Flow\nM104 S220\n','Metadata/project_settings.config':{nozzle_volume_type:['High Flow','high_flow']}};
  const result=await inspect(t,'',{model:'h2d'},entries);assert.deepEqual(result.nozzleFlows,['high_flow','high_flow']);
  entries['Metadata/project_settings.config'].nozzle_volume_type=['Standard','High Flow'];
  await assert.rejects(inspect(t,'',{model:'h2d'},entries),/nozzle.*flow|contradict/i);
});
test('selected plate nozzle diameters must match project metadata with float precision tolerance',async t=>{
  const entries={'Metadata/plate_1.gcode':header('H2D','PLA','0.4;0.4')+'M104 S220\n','Metadata/plate_1.json':{nozzle_diameter:0.4000000059604645}};
  await inspect(t,'',{model:'h2d'},entries);
  entries['Metadata/plate_1.json'].nozzle_diameter=0.8;
  await assert.rejects(inspect(t,'',{model:'h2d'},entries),/plate.*nozzle|nozzle.*contradict/i);
  entries['Metadata/plate_1.json'].nozzle_diameter=[0.4,0.6];
  await assert.rejects(inspect(t,'',{model:'h2d'},entries),/plate.*nozzle|nozzle.*contradict/i);
});

async function h2dGuiData() {
  const base=new URL('../fixtures/h2d_gui_sliced/',import.meta.url);
  return {project:JSON.parse(await fs.readFile(new URL('project_settings.config',base),'utf8')),plate:JSON.parse(await fs.readFile(new URL('plate_1.json',base),'utf8'))};
}
function templateLine(template,command) {
  const line=template.split('\n').map(value=>value.trim()).find(value=>value.startsWith(command+' '));
  assert.ok(line,`checked-in H2D template contains ${command}`);return line;
}
test('checked-in H2D G383.3 probing temperature is inspected with its filament position',async t=>{
  const {project}=await h2dGuiData();
  const probe=templateLine(project.machine_start_gcode,'G383.3')
    .replace('{nozzle_temperature_initial_layer[initial_no_support_extruder]}','255').replace('{initial_no_support_extruder}','0');
  const source=header('H2D','PETG','0.4;0.4')+probe+'\n';
  assert.equal((await inspect(t,source,{model:'h2d'})).maxNozzleTemperature,255);
  for(const command of [probe.replace('255','400'),'G383.3 T-1 L0','G383.3 TNaN L0','G383.3 L0','G383.3 T220 L8','G383.4 T400'])
    await assert.rejects(inspect(t,header('H2D','PETG','0.4;0.4')+command+'\n',{model:'h2d'}),/temperature|limit|target|parameter|unsupported|material|filament/i,command);
  await assert.rejects(inspect(t,header('H2D','PA-CF;PLA','0.4;0.4')+'T0\nG383.3 T300 L1\n',{model:'h2d'}),/PLA|material|temperature/i);
});
test('checked-in H2D project variant nozzle types resolve to two selected physical nozzles',async t=>{
  const {project,plate}=await h2dGuiData();
  assert.equal(project.nozzle_type.length,5);assert.equal(project.nozzle_diameter.length,2);
  const entries={'Metadata/project_settings.config':project,'Metadata/plate_1.json':plate,'Metadata/plate_1.gcode':'G1 X100 Y100\n'};
  const result=await inspect(t,'',{model:'h2d'},entries);
  assert.deepEqual(result.nozzleTypes,['hardened_steel','hardened_steel']);
  assert.deepEqual(result.nozzleFlows,['high_flow','high_flow']);assert.deepEqual(result.usedFilamentPositions,[4]);
  project.nozzle_type=['stainless_steel','hardened_steel','hardened_steel','stainless_steel','hardened_steel'];
  assert.deepEqual((await inspect(t,'',{model:'h2d'},entries)).nozzleTypes,['hardened_steel','stainless_steel']);
  delete project.printer_extruder_id;
  await assert.rejects(inspect(t,'',{model:'h2d'},entries),/nozzle.*type|extruder|variant|metadata/i);
});
test('ambiguous H2D nozzle variant selections and contradictory header types reject',async t=>{
  const {project,plate}=await h2dGuiData();
  const entries={'Metadata/project_settings.config':project,'Metadata/plate_1.json':plate,'Metadata/plate_1.gcode':'; nozzle_type = stainless_steel;hardened_steel\nG1 X100 Y100\n'};
  await assert.rejects(inspect(t,'',{model:'h2d'},entries),/contradict/i);
  entries['Metadata/plate_1.gcode']='G1 X100 Y100\n';
  project.printer_extruder_variant[4]='Direct Drive High Flow';project.nozzle_type[4]='stainless_steel';
  await assert.rejects(inspect(t,'',{model:'h2d'},entries),/nozzle.*type|extruder|variant|metadata/i);
});
test('checked-in H2D M620.15 cooling target uses the incoming filament material',async t=>{
  const {project}=await h2dGuiData();
  const cooling=templateLine(project.change_filament_gcode,'M620.15')
    .replace('{new_filament_temp - filament_cooling_before_tower[next_extruder]}','210');
  const source=header('H2D','PA-CF;PLA','0.4;0.4')+'T0\nM620 S1A\n'+cooling+'\nT1\nM621 S1A\n';
  const result=await inspect(t,source,{model:'h2d'});assert.equal(result.maxNozzleTemperature,210);assert.equal(result.selectsAms,true);
  for(const command of ['M620.15 C300','M620.15 C400','M620.15 C-1','M620.15 CNaN','M620.15 C','M620.15 C210 T400','M620.15'])
    await assert.rejects(inspect(t,header('H2D','PA-CF;PLA','0.4;0.4')+'T0\nM620 S1A\n'+command+'\n',{model:'h2d'}),/temperature|limit|target|parameter|unsupported|PLA|material/i,command);
});
test('complete checked-in H2D project and plate metadata accept their expanded probing and cooling commands',async t=>{
  const {project,plate}=await h2dGuiData();const position=plate.first_extruder;
  const probing=project.machine_start_gcode.split('\n').map(value=>value.trim()).filter(value=>/^G383(?:\.3)? /.test(value))
    .map(value=>value.replace('{nozzle_temperature_initial_layer[initial_no_support_extruder]}','255').replace('{initial_no_support_extruder}',String(position)));
  assert.equal(probing.length,3);
  const change=['M620','M620.15','M621'].map(command=>templateLine(project.change_filament_gcode,command)
    .replace('{new_filament_temp - filament_cooling_before_tower[next_extruder]}','245').replace('[next_extruder]',String(position)));
  const entries={'Metadata/project_settings.config':project,'Metadata/plate_1.json':plate,'Metadata/plate_1.gcode':[...probing,...change,'G1 X100 Y100'].join('\n')};
  const result=await inspect(t,'',{model:'h2d',nozzleDiameters:[0.4],bedType:'textured_plate'},entries);
  assert.equal(result.maxNozzleTemperature,255);assert.deepEqual(result.usedFilamentPositions,[4]);assert.deepEqual(result.nozzleTypes,['hardened_steel','hardened_steel']);
});

// Exact common-flush block from the official X1E machine_start_gcode. The
// fixed E50/F200 purge ends with a normal temperature, before the load line.
const x1eCommonFlush='M109 S290\nM106 P1 S0\nG92 E0\nG1 E50 F200\nM400\nM104 S220\n';
test('PLA normal heating rejects sustained high targets but preserves a bounded vendor startup purge',async t=>{
  const {validateTemperature}=await import('../../dist/safety/limits.js');
  assert.equal(validateTemperature('nozzle',260,'x1e',['PLA']),260);
  assert.throws(()=>validateTemperature('nozzle',290,'x1e',['PLA']),/PLA|material|260/i);
  for(const command of ['M104 S290\nG1 X20 Y20 E10\n','M109 S290\n','M104 S261\n'])
    await assert.rejects(inspect(t,header('X1E')+command,{model:'x1e'}),/PLA|material|260|purge/i);
  const result=await inspect(t,header('X1E')+x1eCommonFlush+';LAYER_CHANGE\nG1 X20 Y20 E1\n',{model:'x1e'});
  assert.equal(result.maxNozzleTemperature,290);
});
test('vendor PLA purge exceptions cannot be extended repeated or moved into printing',async t=>{
  for(const program of [x1eCommonFlush.replace('E50 F200','E5000 F1'),x1eCommonFlush.replace('E50 F200','X20 Y20 E50 F200'),x1eCommonFlush.replace('M104 S220','G4 S3600\nM104 S220'),x1eCommonFlush.replace('M104 S220','M104 S290'),x1eCommonFlush+x1eCommonFlush,';LAYER_CHANGE\n'+x1eCommonFlush,'; layer num/total_layer_count: 1/20\n'+x1eCommonFlush,'G1 X20 Y20 E1\n'+x1eCommonFlush])
    await assert.rejects(inspect(t,header('X1E')+program,{model:'x1e'}),/PLA|material|260|purge/i,program);
  await assert.rejects(inspect(t,header()+x1eCommonFlush),/PLA|material|260|purge/i);
  await assert.rejects(inspect(t,header('H2D','PLA','0.4;0.4')+';LAYER_CHANGE\nM620.10 A0 F74.8347 H0.4 T270 P220 S1\n',{model:'h2d'}),/PLA|material|260|purge/i);
  for(const boundary of [';LAYER_CHANGE','G1 X20 Y20 E10']) await assert.rejects(inspect(t,header('X1E')+'M620.1 E F100 T290\n'+boundary+'\n',{model:'x1e'}),/PLA|material|260|purge/i);
});
test('H2D G150 wipe temperatures cannot bypass the hardware or material policy',async t=>{
  const {project}=await h2dGuiData();
  const wipe=templateLine(project.machine_start_gcode,'G150').replace('{nozzle_temperature_initial_layer[initial_no_support_extruder]}','220');
  assert.equal((await inspect(t,header('H2D','PLA','0.4;0.4')+wipe+'\n',{model:'h2d'})).maxNozzleTemperature,220);
  for(const command of ['G150 T400','G150 T290','G150 TNaN','G150 T-1','G150.3 T400'])
    await assert.rejects(inspect(t,header('H2D','PLA','0.4;0.4')+command+'\n',{model:'h2d'}),/temperature|material|limit|unsupported|target|parameter/i);
});
test('non-FFF job declarations and laser activation commands cannot use the FFF print path',async t=>{
  for(const declaration of ['printer_technology = Laser','printer_technology = SLA','job_type = laser_engraving','plate_type = cutting','laser_mode = 1','cutter_enabled = true'])
    await assert.rejects(inspect(t,header('H2D','PLA','0.4;0.4')+'; '+declaration+'\nG1 X20 Y20\n',{model:'h2d'}),/laser|cut|FFF|technology|unsupported/i);
  for(const command of ['M3 S1000','M04 S100','M452','M3.1 S1000'])
    await assert.rejects(inspect(t,header('H2D','PLA','0.4;0.4')+command+'\n',{model:'h2d'}),/laser|cut|FFF|unsupported/i);
  const entries={'Metadata/project_settings.config':{printer_technology:'FFF'},'Metadata/plate_1.json':{job_type:'laser'},'Metadata/plate_1.gcode':header('H2D','PLA','0.4;0.4')+'G1 X20 Y20\n'};
  await assert.rejects(inspect(t,'',{model:'h2d'},entries),/laser|cut|FFF|unsupported/i);
  delete entries['Metadata/plate_1.json'].job_type;
  entries['Metadata/plate_1.gcode']+='M960 S1 P1 ; ordinary FFF lidar/calibration light\nM960 S1 P0\n';
  await inspect(t,'',{model:'h2d'},entries);
});

test('checked-in H2D prime-tower interface M620.13 validates the active filament temperature',async t=>{
  const {project}=await h2dGuiData();
  const prime=templateLine(project.change_filament_gcode,'M620.13')
    .replace('{filament_tower_interface_purge_volume}','10').replace('{filament_tower_interface_print_temp}','320');
  const result=await inspect(t,header('H2D','PLA;PA-CF','0.4;0.4')+'T0\nM620 S1A\nT1\n;LAYER_CHANGE\n'+prime+'\n',{model:'h2d'});
  assert.equal(result.maxNozzleTemperature,320);
  // A pending PA tool change must not relabel a still-active PLA filament.
  await assert.rejects(inspect(t,header('H2D','PLA;PA-CF','0.4;0.4')+'T0\nM620 S1A\n'+prime+'\n',{model:'h2d'}),/PLA|material|temperature/i);
  for(const command of ['M620.13 W0 L10 T400 R0','M620.13 W0 L10 T270 R0','M620.13 W0 L10 TNaN R0','M620.13 W0 L10 T-1 R0','M620.13 W0 L10 R0','M620.13 W1 L10 T220 R0','M620.13 W0 L-1 T220 R0','M620.13 W0 L10 T220 R1','M620.13 W0 L10 T220 R0 S400'])
    await assert.rejects(inspect(t,header('H2D','PLA','0.4;0.4')+command+'\n',{model:'h2d'}),/temperature|unsupported|parameter|limit|material/i,command);
});

const h2dRoutines=['machine_start_gcode','change_filament_gcode','machine_end_gcode'];
function expandH2dFamilyLine(line) {
  const value=expression=>/chamber_temperature/.test(expression)?'40':/bed_temperature/.test(expression)?'60':/nozzle_diameter/.test(expression)?'0.4':
    /(?:temperature|temp)/.test(expression)?'220':/filament_type/.test(expression)?'PLA':
    /(?:volumetric|feedrate)/.test(expression)?'100':
    /(?:initial_no_support_extruder|current_extruder|next_extruder|first_non_support_filaments|first_filaments|filament_id|hotend|nozzle_id)/.test(expression)?'0':'10';
  return line.replace(/\{[^{}]*\}/g,value).replace(/\[[^\[\]]*\]/g,value).split(';')[0].trim();
}
async function inspectH2dFamilyInventory(t,profile) {
  const commands=new Set();const forms=new Set();
  for(const key of h2dRoutines) for(const line of (profile[key]??'').split('\n')) {
    if(!/^\s*(?:M62[01]|G383|G150)(?:\.|\s|$)/.test(line)) continue;
    const expanded=expandH2dFamilyLine(line);const command=expanded.match(/^\S+/)[0];commands.add(command);forms.add(expanded);
  }
  for(const expanded of forms) {
    await assert.doesNotReject(inspect(t,header('H2D','PLA','0.4;0.4')+expanded+'\n',{model:'h2d'}),expanded);
    const command=expanded.match(/^\S+/)[0];
    const thermalKeys=command==='M620.10'?['T','P']:command==='M620.13'?['T']:command==='M620.15'?['C']:command==='M620.17'?['S']:['G383','G383.3','G150'].includes(command)?['T']:[];
    for(const key of thermalKeys) {
      const target=new RegExp(`\\b${key}[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)`);
      if(!target.test(expanded)) continue;
      const unsafe=expanded.replace(target,key+'400');
      await assert.rejects(inspect(t,header('H2D','PLA','0.4;0.4')+unsafe+'\n',{model:'h2d'}),/temperature|limit|material/i,unsafe);
    }
  }
  return [...commands].sort();
}
test('every M620 G383 and G150 form in the checked-in H2D templates is parsed and its thermal targets checked',async t=>{
  const {project}=await h2dGuiData();
  assert.deepEqual(await inspectH2dFamilyInventory(t,project),['G150','G150.1','G150.2','G150.3','G383','G383.3','M620','M620.10','M620.11','M620.13','M620.15','M620.17','M620.6','M621']);
});
test('every M620 G383 and G150 form in installed H2D templates is parsed and its thermal targets checked',async t=>{
  const base='/Applications/BambuStudio.app/Contents/Resources/profiles/BBL/machine';
  let names;try {names=(await fs.readdir(base)).filter(name=>/^Bambu Lab H2D(?: |\.json)/.test(name));}catch {t.skip('installed BambuStudio H2D profiles unavailable');return;}
  if(!names.length) {t.skip('installed BambuStudio H2D profiles unavailable');return;}
  const commands=new Set();
  for(const name of names) for(const command of await inspectH2dFamilyInventory(t,JSON.parse(await fs.readFile(path.join(base,name),'utf8')))) commands.add(command);
  assert.ok(commands.has('G383'));assert.ok(commands.has('M620.10'));assert.ok(commands.has('G150'));
  // G383.4 exists in some releases but is absent from newer installed templates.
  await inspect(t,header('H2D','PLA','0.4;0.4')+'G383.4\n',{model:'h2d'});
  await assert.rejects(inspect(t,header('H2D','PLA','0.4;0.4')+'G383.4 T400\n',{model:'h2d'}),/unsupported/i);
});

test('checked-in H2D SYNC T is a nonnegative duration rather than a heater target',async t=>{
  const {project}=await h2dGuiData();
  const sync=templateLine(project.change_filament_gcode,'SYNC').replace('{ceil(flush_length / 125) * 5}','5');
  const result=await inspect(t,header('H2D','PLA','0.4;0.4')+'M104 S220\n'+sync+'\n',{model:'h2d'});
  assert.equal(result.maxNozzleTemperature,220);
  for(const command of ['SYNC T-1','SYNC TNaN','SYNC TInfinity','SYNC T','SYNC S5','SYNC T5 S400','SYNC T5 T10','SYNC T5 M104 S400'])
    await assert.rejects(inspect(t,header('H2D','PLA','0.4;0.4')+command+'\n',{model:'h2d'}),/syntax|parameter|unsupported|duration|target/i,command);
});
test('all literal H2D startup change and end template commands retain numeric format compatibility',async t=>{
  const {project}=await h2dGuiData();
  const profiles=[project];const base='/Applications/BambuStudio.app/Contents/Resources/profiles/BBL/machine';
  try {for(const name of (await fs.readdir(base)).filter(name=>/^Bambu Lab H2D(?: |\.json)/.test(name))) profiles.push(JSON.parse(await fs.readFile(path.join(base,name),'utf8')));}catch(error) {if(error.code!=='ENOENT') throw error;}
  const nonGmt=new Set();
  for(const profile of profiles) for(const key of h2dRoutines) for(const line of (profile[key]??'').split('\n')) {
    const literal=line.trim().match(/^([A-Za-z][A-Za-z0-9.]*)/);
    if(literal && !/^(?:[GMT]\d|T$)/.test(literal[1])) nonGmt.add(literal[1]);
  }
  assert.deepEqual([...nonGmt].sort(),['SYNC']);
  // This is command-format coverage: substitute safe numeric examples into every
  // literal command, including both conditional branches. It is not macro/firmware
  // execution or a claim that the substituted values reproduce a real sliced job.
  for(const profile of profiles) {
    const lines=h2dRoutines.flatMap(key=>(profile[key]??'').split('\n')).filter(line=>/^\s*(?:[GM]\d|T[\d[{]|SYNC\s)/.test(line)).map(expandH2dFamilyLine);
    if(!lines.length) continue;
    await assert.doesNotReject(inspect(t,header('H2D','PLA','0.4;0.4')+lines.join('\n'),{model:'h2d'}));
    t.diagnostic(`Parsed ${lines.length} literal H2D startup/change/end lines with safe example substitutions`);
  }
});

test('M620 startup setup cannot authorize above-normal PLA heat with dwell repetition or missing cooldown',async t=>{
  const setup=['M620.1 E F100 T290','M620.10 A0 F74.8347 H0.4 T290 P220 S1'];
  for(const command of setup) for(const suffix of ['','\nG4 S3600','\n'+command,'\nM104 S220']) {
    await assert.rejects(inspect(t,header('H2D','PLA','0.4;0.4')+command+suffix+'\n',{model:'h2d'}),/PLA|material|260/i,command+suffix);
  }
});
test('actual H2D startup setup forms preserve declared PLA240 and PETG270 targets without a purge exception',async t=>{
  const {project}=await h2dGuiData();
  const pair=project.machine_start_gcode.split('\n').filter(line=>/^M620\.10 /.test(line)).slice(-2);
  assert.equal(pair.length,2);
  for(const [material,position,normal] of [['PLA',7,220],['PETG',4,245]]) {
    assert.equal(project.filament_type[position],material);
    const target=Number(project.nozzle_temperature_range_high[position]);
    assert.equal(target,material==='PLA'?240:270);
    const program=pair.map(line=>line.replace(/\{[^{}]*\}/g,expression=>/nozzle_diameter/.test(expression)?'0.4':/flush_temperatures/.test(expression)?String(target):/nozzle_temperature_initial_layer/.test(expression)?String(normal):'100')).join('\n');
    const result=await inspect(t,header('H2D',material,'0.4;0.4')+program+'\nM104 S'+normal+'\n',{model:'h2d'});
    assert.equal(result.maxNozzleTemperature,target);
  }
});

test('all-nozzle and physical-heater warmups do not add unused project filament slots',async t=>{
  const project=JSON.parse(await fs.readFile(new URL('../fixtures/h2d_gui_sliced/project_settings.config',import.meta.url),'utf8'));
  const plate=JSON.parse(await fs.readFile(new URL('../fixtures/h2d_gui_sliced/plate_1.json',import.meta.url),'utf8'));
  assert.equal(project.filament_type.length,8);assert.deepEqual(plate.filament_ids,[4]);
  for(const warmup of ['M104 S140 A','M104 S140 T0','M109 S140 T1','M104 S140']) {
    const result=await inspect(t,'',{model:'h2d'},{'Metadata/project_settings.config':project,'Metadata/plate_1.json':plate,'Metadata/plate_1.gcode':warmup+'\nM140 S60\nT4\nM104 S220\n'});
    assert.deepEqual(result.usedFilamentPositions,[4],warmup);
  }
});

test('ambiguous heater candidates still enforce every possible material temperature ceiling',async t=>{
  const entries={'Metadata/project_settings.config':{printer_model:'h2d',nozzle_diameter:['0.4','0.4'],filament_type:['PLA','PA']},'Metadata/plate_1.json':{filament_ids:[1]}};
  for(const heater of ['M104 S300 A','M104 S300 T0','M109 R300 T1'])
    await assert.rejects(inspect(t,'',{model:'h2d'},{...entries,'Metadata/plate_1.gcode':'T1\n'+heater+'\n'}),/PLA|material.*limit/i);
  for(const unknownSelection of ['M104 S300','M104 S140 A\nM104 S300','M104 T0 S140\nM109 R300'])
    await assert.rejects(inspect(t,'',{model:'h2d'},{...entries,'Metadata/plate_1.gcode':unknownSelection+'\n'}),/PLA|material.*limit/i);
  const selected=await inspect(t,'',{model:'h2d'},{...entries,'Metadata/plate_1.gcode':'T1\nM104 S300\n'});
  assert.deepEqual(selected.usedFilamentPositions,[1]);
});

test('A1 and A1 mini M109 H wait limits are accepted while S stays the checked target',async t=>{
  // Official Bambu Studio 02.08 start G-code: A1 emits M109 S25 H140 and M109 S220 H300; A1 mini emits M109 S100 H170.
  const a1=await inspect(t,header('A1')+'M109 S25 H140\nM109 S220 H300\nG1 X10 Y10 E1\n',{model:'a1'});
  assert.equal(a1.maxNozzleTemperature,220);
  assert.equal((await inspect(t,header('A1 mini')+'M109 S100 H170\n',{model:'a1mini'})).maxNozzleTemperature,100);
  for(const command of ['M109 S25 H301','M109 S25 H-1','M109 S25 H','M109 S400 H140','M109 R400 H140','M104 S220 H140','M190 S60 H140','M109 H140'])
    await assert.rejects(inspect(t,header('A1')+command+'\n',{model:'a1'}),/temperature|unsupported|parameter|limit|target/i,command);
  for(const model of ['P1S','X1C','H2D'])
    await assert.rejects(inspect(t,header(model,'PLA',model==='H2D'?'0.4;0.4':'0.4')+'M109 S25 H140\n',{model:model.toLowerCase()}),/temperature parameter H/,model);
});
