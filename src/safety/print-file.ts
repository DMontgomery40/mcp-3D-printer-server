import { createHash } from 'node:crypto';
import { readBoundedPrintFile, loadSafe3mfArchive } from './archive.js';
import { MACHINE_LIMITS, normalizeMaterial, normalizeModel, validateStartupPurgeTemperature, validateTemperature } from './limits.js';

export interface PrintFileInspection {
  model: string;
  nozzleDiameters: number[];
  materials: string[];
  usedFilamentPositions: number[];
  plateInternalPath?: string;
  sha256: string;
  maxNozzleTemperature: number;
  maxBedTemperature: number;
  maxChamberTemperature: number;
  bedType?: string;
  selectsAms: boolean;
  nozzleTypes?: string[];
  nozzleFlows?: string[];
}
type Metadata = Record<string, unknown>;
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const fail = (message: string): never => { throw new Error(`Print safety: ${message}`); };
function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map(s => s.trim().replace(/^"|"$/g,''));
  if (typeof value === 'string') return value.split(/[;,]/).map(s=>s.trim().replace(/^"|"$/g,''));
  return [];
}
function normalizeBed(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const text = value.trim().toLowerCase().replace(/[_-]/g,' ').replace(/\s+/g,' ');
  if (['textured pei plate','textured plate'].includes(text)) return 'textured pei plate';
  if (['supertack plate','cool plate supertack'].includes(text)) return 'cool plate supertack';
  if (['smooth pei plate','high temp plate','high temperature plate','hot plate'].includes(text)) return 'smooth pei plate';
  return text;
}
function metadataValues(metadata: Metadata[], keys: string[]): unknown[] {
  return metadata.flatMap(data=>keys.filter(key=>data[key] !== undefined).map(key=>data[key]));
}
function consistent<T>(values: unknown[], convert: (v: unknown)=>T|undefined, field: string): T {
  if (!values.length) return fail(`missing ${field} metadata; export a fully sliced Bambu job with machine, nozzle and filament settings`);
  const converted = values.map(convert);
  if (converted.some(value=>value === undefined)) return fail(`unknown or malformed ${field} metadata`);
  if (converted.some(value=>JSON.stringify(value)!==JSON.stringify(converted[0]))) return fail(`contradictory ${field} metadata`);
  return converted[0]!;
}
function stripComments(line: string): string {
  let clean=''; let depth=0;
  for(const char of line) {
    if (char === ';' && depth === 0) break;
    if (char === '(') { if(depth) fail('unsupported nested comment syntax'); depth=1; }
    else if (char === ')') { if(!depth) fail('unbalanced comment syntax'); depth=0; clean+=' '; }
    else if (!depth) clean+=char;
  }
  if(depth) fail('unclosed comment syntax');
  return clean.trim();
}
/** A deliberately narrow parameter lexer for commands affecting heat/material selection.
 * Unknown nonthermal vendor commands do not require a global G-code allowlist.
 */
function parameters(text: string, flags = ''): Map<string,number> {
  const result=new Map<string,number>();let rest=text.trim();
  while(rest) {
    const token=rest.match(/^([A-Z])\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))?/i);
    if(!token) return fail(`unsupported temperature command parameter syntax '${rest}'`);
    const key=token[1].toUpperCase();
    if(result.has(key)) return fail(`duplicate ${key} temperature command parameter`);
    if(!token[2] && !flags.includes(key)) return fail(`missing numeric ${key} temperature target or parameter`);
    result.set(key,token[2] === undefined ? NaN : Number(token[2])); rest=rest.slice(token[0].length).trimStart();
  }
  return result;
}
// Layer comments only close a startup exception; they can never enable one.
const isLayerMarker=(line:string):boolean=>/^\s*;\s*(?:LAYER_CHANGE|CHANGE_LAYER|LAYER\s*:|layer num\/total_layer_count\s*:)/i.test(line);
function boundedX1ePurge(lines:string[],index:number):boolean {
  // Official X1E common flush: 50 mm at 200 mm/min, followed immediately by
  // lowering the target. No dwell, XY extrusion, repeated block or open-ended
  // high-temperature program receives this exception. This bounds command form,
  // not firmware heating time, which cannot be predicted from a file.
  const expected:[string,Record<string,number>][]=[['M106',{P:1,S:0}],['G92',{E:0}],['G1',{E:50,F:200}],['M400',{}],['M104',{}]];
  let next=0;
  for(let cursor=index+1;cursor<lines.length;cursor++) {
    if(isLayerMarker(lines[cursor])) return false;
    const line=stripComments(lines[cursor]).replace(/^N\d+\s*/i,'').replace(/\*\d+\s*$/,'');
    if(!line) continue;
    const match=line.match(/^([GM])(\d+)(?=$|\s|[A-Z+-])/i);
    if(!match || match[1].toUpperCase()+Number(match[2])!==expected[next][0]) return false;
    const args=parameters(line.slice(match[0].length));
    if(next===4) return args.size===1 && args.has('S') && args.get('S')!>=0 && args.get('S')!<=260;
    const entries=Object.entries(expected[next][1]);
    if(args.size!==entries.length || entries.some(([key,value])=>args.get(key)!==value)) return false;
    next++;
  }
  return false;
}
function validateFffJob(metadata:Metadata[]):void {
  for(const data of metadata) for(const [key,value] of Object.entries(data)) {
    if(key==='printer_technology' && (typeof value!=='string' || value.trim().toUpperCase()!=='FFF')) fail('only FFF printing is supported; non-FFF printer technology is not permitted');
    const text=typeof value==='string'?value.trim().toLowerCase():String(value);
    if((/(?:^|_)(?:type|mode|technology)$/.test(key) && /(?:^|[ _-])(?:laser|cutting|cutter|engraving|engrave|plotter)(?:$|[ _-])/.test(text)) ||
       (/^(?:laser|cutting|cutter|engraving)_(?:enabled|mode|power)$/.test(key) && !['','0','false','off','disabled','none'].includes(text))) {
      fail(`laser/cutting job metadata '${key}' is unsupported by the FFF print path`);
    }
  }
}
function validateBounds(headers: Metadata[], model: string, plate: Metadata): void {
  const volume=MACHINE_LIMITS[model].volume;
  const boxes:unknown[]=[];
  if(plate.bbox_all!==undefined) boxes.push(plate.bbox_all);
  if(plate.bbox_objects!==undefined) {
    if(!Array.isArray(plate.bbox_objects)) fail('malformed declared object bounds');
    for(const object of plate.bbox_objects as unknown[]) {
      if(!object || typeof object!=='object') fail('malformed declared object bounds');
      const box=(object as Metadata).bbox;if(box!==undefined) boxes.push(box);
    }
  }
  for(const box of boxes) {
    if(!Array.isArray(box) || box.length!==4 || box.some(value=>typeof value!=='number'||!Number.isFinite(value))) fail('malformed declared object bounds');
    const [minX,minY,maxX,maxY]=box as number[];
    if(minX<0 || minY<0 || maxX<minX || maxY<minY || maxX>volume[0] || maxY>volume[1]) fail(`declared object bounds exceed ${model} printable volume`);
  }
  for(let axis=0;axis<3;axis++) {
    const name='xyz'[axis];
    const minimum=metadataValues(headers,[`min${name}`]); const maximum=metadataValues(headers,[`max${name}`]);
    if(!minimum.length && !maximum.length) continue;
    const number=(v:unknown)=> typeof v==='string' && NUMBER.test(v) && Number.isFinite(Number(v)) ? Number(v):undefined;
    const low=consistent(minimum,number,`object bounds min${name}`);const high=consistent(maximum,number,`object bounds max${name}`);
    if(low<0 || high<low || high>volume[axis]) fail(`declared object bounds ${name}=${low}..${high} exceed ${model} printable volume 0..${volume[axis]} mm`);
  }
}

/** Inspect the exact selected plate. This does not simulate firmware or arbitrary motion:
 * only declared object bounds are checked, never purge/homing/wipe travel coordinates.
 * It also cannot authenticate self-declared metadata or the physical spool/nozzle.
 */
export async function inspectPrintFile(filePath: string, options: {model:string; nozzleDiameters?:number[]; plateIndex?:number; bedType?:string}): Promise<PrintFileInspection> {
  const model=normalizeModel(options.model);
  if(!model) return fail(`unknown or missing printer model '${options.model}'`);
  const plateIndex=options.plateIndex ?? 0;
  if(!Number.isInteger(plateIndex)||plateIndex<0) return fail('selected plate index must be a nonnegative integer');
  if(/\.md5$/i.test(filePath)) return fail('a checksum file is not a printable artifact');
  const bytes=await readBoundedPrintFile(filePath);const sha256=createHash('sha256').update(bytes).digest('hex');
  let source:string;let project:Metadata={};let plate:Metadata={};let plateInternalPath:string|undefined;
  if(/\.3mf$/i.test(filePath)) {
    const zip=await loadSafe3mfArchive(bytes);plateInternalPath=`Metadata/plate_${plateIndex+1}.gcode`;
    const entry=zip.file(plateInternalPath);
    if(!entry) return fail(`selected plate ${plateIndex+1} has no printable ${plateInternalPath}; slice that plate first`);
    source=await entry.async('string');
    for(const [name,assign] of [["Metadata/project_settings.config",(data:Metadata)=>project=data],[`Metadata/plate_${plateIndex+1}.json`,(data:Metadata)=>plate=data]] as const) {
      const config=zip.file(name);if(!config) continue;
      try {const data=JSON.parse(await config.async('string'));if(!data || Array.isArray(data) || typeof data!=='object') throw new Error('expected object');assign(data);}
      catch {return fail(`malformed ${name} metadata`);}
    }
  } else if (/\.gcode$/i.test(filePath)) {
    if(plateIndex!==0) return fail('raw G-code has only plate index 0');source=bytes.toString('utf8');
  } else return fail('unsupported printable artifact; use a sliced .3mf or textual .gcode file');
  if(/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffd]/.test(source)) return fail('binary or malformed G-code is not supported');
  const lines=source.split(/\r\n|\n|\r/);const metadata:Metadata[]=[project];
  for(const line of lines) {
    const match=line.match(/^\s*;\s*([a-z_][a-z0-9_]*(?:\s+used\s+\[(?:g|mm)\])?)\s*(?:=|:)\s*(.*?)\s*$/i);
    if(match) metadata.push({[match[1].toLowerCase()]:match[2]});
  }
  validateFffJob([...metadata,plate]);
  const declaredModel=consistent(metadataValues(metadata,['printer_model']),normalizeModel,'printer model');
  if(declaredModel!==model) return fail(`file model ${declaredModel} contradicts requested model ${model}`);
  const nozzleDiameters=consistent(metadataValues(metadata,['nozzle_diameter']),value=>{
    const values=list(value);return values.length && values.every(v=>NUMBER.test(v) && [0.2,0.4,0.6,0.8].includes(Number(v)))?values.map(Number):undefined;
  },'nozzle diameter');
  if(options.nozzleDiameters && (options.nozzleDiameters.length===1 ? !nozzleDiameters.every(value=>value===options.nozzleDiameters![0]) : JSON.stringify(options.nozzleDiameters)!==JSON.stringify(nozzleDiameters))) return fail('file nozzle diameters contradict the requested nozzle diameters');
  if(plate.nozzle_diameter!==undefined) {
    const values=typeof plate.nozzle_diameter==='number' ? [String(plate.nozzle_diameter)] : list(plate.nozzle_diameter);
    if(!values.length || values.some(value=>!NUMBER.test(value) || !Number.isFinite(Number(value))) ||
       (values.length===1 ? nozzleDiameters.some(diameter=>Math.abs(diameter-Number(values[0]))>1e-6) :
        values.length!==nozzleDiameters.length || values.some((value,index)=>Math.abs(Number(value)-nozzleDiameters[index])>1e-6))) {
      fail('selected plate nozzle diameter metadata contradicts the sliced project nozzles');
    }
  }
  const normalizedEntries=(value:unknown):string[]|undefined=>{
    const entries=list(value).map(entry=>entry.toLowerCase().replace(/[\s_-]+/g,'_'));
    return entries.length && entries.every(Boolean)?entries:undefined;
  };
  const nozzleMetadata=(keys:string[],variantRows=false):string[]|undefined=>{
    const values=metadataValues(metadata,keys);
    return values.length ? consistent(values,value=>{
      const entries=normalizedEntries(value);
      if(!entries) return undefined;
      if(entries.length===nozzleDiameters.length) return entries;
      if(!variantRows) return undefined;
      // Bambu GUI projects may store nozzle types per extruder variant, while
      // diameters and selected flow types are per physical extruder. Never truncate
      // that variant table or mistake its rows for filament/nozzle positions.
      const ids=consistent(metadataValues(metadata,['printer_extruder_id']),value=>{
        const ids=list(value);return ids.length===entries.length && ids.every(id=>/^[1-9]\d*$/.test(id) && Number(id)<=nozzleDiameters.length)?ids.map(Number):undefined;
      },'printer extruder id');
      const resolved:string[]=[];
      for(let index=0;index<nozzleDiameters.length;index++) {
        const rows=ids.flatMap((id,row)=>id===index+1?[row]:[]);
        if(!rows.length) return undefined;
        if(rows.every(row=>entries[row]===entries[rows[0]])) {resolved.push(entries[rows[0]]);continue;}
        const variants=consistent(metadataValues(metadata,['printer_extruder_variant']),normalizedEntries,'printer extruder variant');
        const extruders=consistent(metadataValues(metadata,['extruder_type']),normalizedEntries,'extruder type');
        if(variants.length!==entries.length || extruders.length!==nozzleDiameters.length || !nozzleFlows) return undefined;
        const selected=rows.filter(row=>variants[row]===`${extruders[index]}_${nozzleFlows[index]}`);
        if(selected.length!==1) return undefined;
        resolved.push(entries[selected[0]]);
      }
      return resolved;
    },keys[0].replace(/_/g,' ')) : undefined;
  };
  const nozzleFlows=nozzleMetadata(['nozzle_flow','nozzle_volume_type']);
  const nozzleTypes=nozzleMetadata(['nozzle_type'],true);
  const materials=consistent(metadataValues(metadata,['filament_type']),value=>{
    const values=list(value);return values.length && values.every(v=>!!normalizeMaterial(v))?values.map(v=>normalizeMaterial(v)!):undefined;
  },'filament material');
  const bedValues=metadataValues([...metadata,plate],['curr_bed_type','bed_type']);
  const bedType=bedValues.length?consistent(bedValues,normalizeBed,'bed type'):undefined;
  if(options.bedType && (!bedType || normalizeBed(options.bedType)!==bedType)) return fail('selected bed type cannot be verified or contradicts the sliced file; re-slice with the intended bed');
  validateBounds(metadata,model,plate);
  const used=new Set<number>();
  const requirePosition=(position:number):number=>{
    if(!Number.isInteger(position)||position<0||position>=materials.length) return fail(`filament/tool position ${position} has no declared material`);
    used.add(position);return position;
  };
  if(plate.filament_ids !== undefined) {
    if(!Array.isArray(plate.filament_ids)||!plate.filament_ids.length) return fail('malformed selected plate filament_ids metadata');
    for(const value of plate.filament_ids) {if(typeof value!=='number' || !Number.isInteger(value)) return fail('malformed selected plate filament position');requirePosition(value);}
  }
  let active: number|undefined = materials.length===1 ? 0 : undefined;
  let nozzleTarget=0;let selectsAms=false;let pending: number|undefined;let previous: number|undefined;
  let maxNozzleTemperature=0,maxBedTemperature=0,maxChamberTemperature=0,commandCount=0;
  let depositionStarted=false,commonFlushUsed=false;
  const heat=(component:'nozzle'|'bed'|'chamber',value:number,position?:number,allMaterials=false,startupPurge=false)=>{
    const affected=allMaterials || position===undefined ? materials.map((_,index)=>index) : [requirePosition(position)];
    if(component==='nozzle' && startupPurge) validateStartupPurgeTemperature(value,model,affected.map(index=>materials[index]));
    else validateTemperature(component,value,model,affected.map(index=>materials[index]));
    // Candidate materials constrain heat, but only plate metadata and explicit
    // filament selections establish physical spool use. Heating a nozzle is not
    // evidence that every project filament must be mapped into the AMS.
    if(component==='nozzle') {nozzleTarget=value;maxNozzleTemperature=Math.max(maxNozzleTemperature,value);}
    else if(component==='bed') maxBedTemperature=Math.max(maxBedTemperature,value);
    else maxChamberTemperature=Math.max(maxChamberTemperature,value);
  };
  const closeStartupWindow=()=>{
    depositionStarted=true;
    const affected=active===undefined ? (used.size?[...used].map(position=>materials[position]):materials) : [materials[active]];
    validateTemperature('nozzle',nozzleTarget,model,affected);
  };
  for(let index=0;index<lines.length;index++) {
    try {
      if(isLayerMarker(lines[index])) closeStartupWindow();
      let line=stripComments(lines[index]);if(!line||line==='%') continue;
      line=line.replace(/^N\d+\s*/i,'').replace(/\*\d+\s*$/,'');
      if(/[{}\[\]#]/.test(line)) fail('unresolved dynamic command syntax');
      if(/^SYNC(?=$|\s)/i.test(line)) {
        // H2D change_filament_gcode emits SYNC T{ceil(flush_length / 125) * 5}.
        // T is a synchronization duration here, not a nozzle temperature. The
        // vendor template establishes no independent maximum duration.
        const args=parameters(line.slice(4));
        if(args.size!==1 || !args.has('T') || !Number.isFinite(args.get('T')) || args.get('T')!<0) fail('unsupported SYNC duration parameters');
        commandCount++;continue;
      }
      const command=line.match(/^([GMT])(\d+(?:\.\d+)?)(?=$|\s|[A-Z+-])/i);
      if(!command) fail(`unsupported G-code command syntax '${line.slice(0,100)}'`);
      const [base,subcode]=command![2].split('.');
      const code=command![1].toUpperCase()+String(Number(base))+(subcode===undefined?'':'.'+subcode);const argumentsText=line.slice(command![0].length).trim();commandCount++;
      if(!['M117','M118','M1002','M1006','M900','M970','M983.1','G383'].includes(code) && /[GM]\s*\d/i.test(argumentsText)) fail('multiple commands on one line are unsupported');
      // Coordinated extrusion closes the startup-only allowance even when the
      // source omits layer comments. Retraction also closes it conservatively.
      if(['G0','G1','G2','G3'].includes(code) && /E/i.test(argumentsText) && /[XY]/i.test(argumentsText)) closeStartupWindow();
      if(/^M(?:3|4|452)(?:\.|$)/.test(code)) fail(`laser/cutter command ${code} is unsupported by the FFF print path`);
      if(/^T\d+$/.test(code)) {
        const position=Number(code.slice(1));
        if([254,255,1000,1001,1100,65279,65535].includes(position)) {previous=active;active=undefined;}
        else {validateTemperature('nozzle',nozzleTarget,model,[materials[requirePosition(position)]]);selectsAms=true;previous=active;active=position;}
        continue;
      }
      if(['M104','M109','M140','M190','M141','M191'].includes(code)) {
        const args=parameters(argumentsText,'A');
        for(const key of args.keys()) if(!'SRTA'.includes(key)) fail(`unsupported ${code} temperature parameter ${key}`);
        if(!args.has('S')&&!args.has('R')) fail(`missing ${code} temperature target`);
        const component= ['M104','M109'].includes(code)?'nozzle': ['M140','M190'].includes(code)?'bed':'chamber';
        // Heater T is a physical nozzle, unlike standalone remapped T filament selection.
        // Without a verified per-filament nozzle map, apply all possible materials.
        if(args.has('T') && (!Number.isInteger(args.get('T')) || args.get('T')!<0 || args.get('T')!>=nozzleDiameters.length)) fail('physical heater target has no declared nozzle');
        const position= args.has('T') ? undefined : active;
        const commonFlush=code==='M109' && args.size===1 && args.get('S')===290 && model==='x1e' && !depositionStarted && !commonFlushUsed && boundedX1ePurge(lines,index);
        if(commonFlush) commonFlushUsed=true;
        for(const key of ['S','R']) if(args.has(key)) heat(component,args.get(key)!,position,args.has('T') || args.has('A'),commonFlush);
      } else if(code==='M620' || code==='M621') {
        const args=parameters(argumentsText,'MA');
        if(args.has('S')) {
          const position=args.get('S')!;
          if([254,255,65279,65535].includes(position)) {if(code==='M621') {previous=active;active=undefined;}pending=undefined;}
          else {selectsAms=true;requirePosition(position);if(code==='M620') pending=position;else {validateTemperature('nozzle',nozzleTarget,model,[materials[position]]);previous=active;active=position;pending=undefined;}}
        }
      } else if(code==='M620.1' || code==='M620.10') {
        const args=parameters(argumentsText,'E');
        const position=code==='M620.10' && args.get('A')===1 ? pending ?? active : code==='M620.10' && args.get('A')===0 ? active : undefined;
        // Setup commands are thermal-affecting too. Startup placement or a P
        // target cannot establish a bounded purge, so no elevated PLA allowance.
        for(const key of code==='M620.10'?['T','P']:['T']) if(args.has(key)) heat('nozzle',args.get(key)!,position);
      } else if(code==='G150') {
        // Official H2D nozzle-wipe routine carries the temperature in T.
        const args=parameters(argumentsText);
        if(args.has('T')) heat('nozzle',args.get('T')!,active);
      } else if(/^G150\./.test(code) && /T/i.test(argumentsText)) {
        fail(`unsupported thermal-affecting wipe command ${code}`);
      } else if(code==='G383' || code==='G383.3') {
        // Bambu probing routines carry nozzle temperature in T and optionally
        // the project filament position in L (including the H2D G383.3 form).
        const args=parameters(argumentsText);
        if(code==='G383.3' && (!args.has('T') || [...args.keys()].some(key=>!'TL'.includes(key)))) fail('unsupported G383.3 temperature parameters');
        const position=args.has('L')?requirePosition(args.get('L')!):active;
        if(args.has('T')) heat('nozzle',args.get('T')!,position);
      } else if(code==='G383.4' && !argumentsText) {
        // Official H2D startup: left-extruder load status detection, no target.
      } else if(/^G383\./.test(code)) {
        fail(`unsupported thermal-affecting probing command ${code}`);
      } else if(code==='M620.13') {
        // Verified H2D prime-tower interface form, after T[next_extruder]: L is
        // purge volume, T is the active filament's temperature, W/R are zero.
        const args=parameters(argumentsText);
        if(args.size!==4 || args.get('W')!==0 || args.get('R')!==0 || !args.has('T') ||
           !args.has('L') || !Number.isFinite(args.get('L')) || args.get('L')!<0) fail('unsupported M620.13 prime-tower temperature parameters');
        heat('nozzle',args.get('T')!,active);
      } else if(code==='M620.15') {
        // H2D change_filament_gcode supplies the incoming filament's cooling
        // temperature as C{new_filament_temp - filament_cooling_before_tower}.
        const args=parameters(argumentsText);
        if(args.size!==1 || !args.has('C')) fail('unsupported M620.15 cooling temperature parameters');
        heat('nozzle',args.get('C')!,pending ?? active);
      } else if(code==='M620.17') {
        const args=parameters(argumentsText);
        if(!args.has('S') || !args.has('L') || !args.has('T') || !Number.isInteger(args.get('T')) || args.get('T')!<0 || args.get('T')!>=nozzleDiameters.length) fail('unsupported M620.17 nozzle/material temperature mapping');
        for(const key of args.keys()) if(!'SLT'.includes(key)) fail(`unsupported M620.17 parameter ${key}`);
        heat('nozzle',args.get('S')!,requirePosition(args.get('L')!));
      } else if((/^M620\./.test(code) && !['M620.3','M620.6','M620.11'].includes(code)) || /^M621\./.test(code)) {
        fail(`unsupported thermal-affecting filament command ${code}`);
      } else if(code==='M145') {
        const args=parameters(argumentsText);
        if(args.size!==1 || !args.has('P') || ![0,1].includes(args.get('P')!) || !['h2d','h2dpro','h2c','h2s','x2d'].includes(model)) fail('unsupported thermal-affecting M145 parameters');
      } else if(code==='M142') {
        // Bambu chamber fan regulation thresholds, not an active heater command.
        const args=parameters(argumentsText);for(const key of ['S','R']) if(args.has(key) && (!Number.isFinite(args.get(key)) || args.get(key)!<0 || args.get(key)!>65)) fail('unsupported chamber fan temperature threshold');
      } else if(/^(?:M(?:104|109|140|190|141|191)\.|M(?:143|144|145|149|301|302|303|304|306|307|568|570|950|98|32)$)/.test(code) || (code==='G10' && /[SR]/i.test(argumentsText))) {
        fail(`unsupported thermal-affecting or external program command ${code}; re-slice with standard Bambu heater commands`);
      }
    } catch(error) {throw new Error(`Print safety line ${index+1}: ${error instanceof Error?error.message:String(error)}`);}
  }
  if(!commandCount) return fail('selected G-code contains no printable commands');
  if(!used.size) materials.forEach((_,index)=>used.add(index));
  return {model,nozzleDiameters,materials,usedFilamentPositions:[...used].sort((a,b)=>a-b),plateInternalPath,sha256,maxNozzleTemperature,maxBedTemperature,maxChamberTemperature,bedType,selectsAms,nozzleTypes,nozzleFlows};
}
