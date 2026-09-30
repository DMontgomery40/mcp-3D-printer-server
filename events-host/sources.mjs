import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { EventStore } from '../dist/events/store.js';
import { PrintEventDetector } from '../dist/events/detector.js';
import { listPrintEvents } from '../dist/events/service.js';
import { createLegacySource } from './relay.mjs';
import WebSocket from 'ws';

export const CAPABILITIES = Object.freeze({bambu:'mqtt',klipper:'poll',octoprint:'sockjs',duet:'poll',repetier:'websocket',prusa:'unsupported',creality:'unsupported'});
const KEYS=['PRINTER_TYPE','PRINTER_HOST','PRINTER_PORT','API_KEY','BAMBU_SERIAL','BAMBU_TOKEN','BAMBU_MODEL','REPETIER_SLUG'];
export function printerConfiguration(filename, inherited=process.env, capabilities=CAPABILITIES) {
  const entries=filename ? (()=> {
    if(!isAbsolute(filename)) throw new Error('Printer configuration must be an absolute private path');
    if(process.platform!=='win32' && (statSync(filename).mode & 0o077)) throw new Error('Printer configuration must be readable only by its owner');
    return JSON.parse(readFileSync(filename,'utf8'));
  })() : [{id:'default',type:inherited.PRINTER_TYPE??'bambu',environment:Object.fromEntries(KEYS.filter(key=>inherited[key]!==undefined).map(key=>[key,inherited[key]]))}];
  if(!Array.isArray(entries)||!entries.length||entries.length>100) throw new Error('Configure 1–100 printers');
  const ids=new Set();
  return entries.map(entry=> {
    if(!entry || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(entry.id) || ids.has(entry.id)) throw new Error('Printer aliases must be unique and contain only letters, digits, hyphen or underscore');
    ids.add(entry.id);
    if(!Object.hasOwn(capabilities,entry.type)||capabilities[entry.type]==='unsupported') throw new Error(`Native completion events are unavailable for backend ${entry.type}`);
    if(!entry.environment || Object.entries(entry.environment).some(([key,value])=>!KEYS.includes(key)||typeof value!=='string')) throw new Error('Invalid private printer environment');
    if(entry.type==='repetier' && !/^[a-zA-Z0-9_-]+$/.test(entry.environment.REPETIER_SLUG??'')) throw new Error('Repetier requires an explicit printer slug');
    if(entry.type==='bambu' && (!entry.environment.BAMBU_SERIAL?.trim() || !entry.environment.BAMBU_TOKEN?.trim())) throw new Error('Each Bambu printer needs its existing serial and access code');
    if(!entry.environment.PRINTER_HOST?.trim()) throw new Error('Each printer needs its explicit host');
    const env={...inherited};for(const key of KEYS) delete env[key];
    // Empty values override dotenv, preventing one farm entry from inheriting another printer's credentials.
    for(const key of KEYS)env[key]='';Object.assign(env,entry.environment,{PRINTER_TYPE:entry.type});
    return {id:entry.id,type:entry.type,env};
  });
}
function text(value) {return {content:[{type:'text',text:JSON.stringify(value)}]};}
export function observeMoonraker(detector, data) {
  const objects=data?.result?.status, stats=objects?.print_stats;
  if(!stats || typeof stats.state!=='string'||typeof stats.filename!=='string') return;
  const state={printing:'RUNNING',paused:'PAUSE',complete:'FINISH',cancelled:'CANCELLED',standby:'IDLE',error:'FAILED'}[stats.state];
  if(!state)return;
  // Klippy shutdown is a problem, never successful completion. Never transmit free-form error messages or filenames.
  const error=objects.webhooks?.state;
  detector.observe({command:'push_status',gcode_state:error==='shutdown'||error==='error'?'FAILED':state,
    gcode_file:stats.filename,print_error:0,hms:[]});
}
export function observeOctoPrint(detector, message) {
  // History/current can arm an active job, but cannot infer completion from progress or Operational/idle.
  const status=message?.current??message?.history;
  const file=status?.job?.file;
  const identity=(payload)=>typeof payload?.path==='string' && ['local','sdcard'].includes(payload.origin) ? `${payload.origin}:${payload.path}` : undefined;
  if(status) {
    const path=identity(file), flags=status.state?.flags;
    if(path && flags && (flags.printing===true||flags.paused===true)) detector.observe({command:'push_status',gcode_state:flags.paused?'PAUSE':'RUNNING',gcode_file:path,print_error:0,hms:[]});

  }
  const event=message?.event, path=identity(event?.payload);
  if(!path)return;
  const state={PrintStarted:'RUNNING',PrintPaused:'PAUSE',PrintResumed:'RUNNING',PrintDone:'FINISH',PrintCancelling:'CANCELLED',PrintCancelled:'CANCELLED',PrintFailed:event.payload.reason==='cancelled'?'CANCELLED':'FAILED'}[event.type];
  if(!state)return;
  if(event.type==='PrintStarted') detector.observe({command:'push_status',gcode_state:'IDLE'});
  detector.observe({command:'push_status',gcode_state:state,gcode_file:path,print_error:0,hms:[]});
}
export function observeDuet(detector, data) {
  const job=data?.job, status=data?.state?.status;
  if(!job || typeof status!=='string')return;
  const state=detector.store.observation(detector.printer);
  const record=typeof job.lastFileName==='string' && Number.isFinite(job.lastDuration) && job.lastDuration>=0 &&
    [job.lastFileAborted,job.lastFileCancelled,job.lastFileSimulated].every(value=>typeof value==='boolean') ?
    createHash('sha256').update(JSON.stringify([job.lastFileName,job.lastDuration,job.lastFileAborted,job.lastFileCancelled,job.lastFileSimulated])).digest('hex') : undefined;
  const previous=state.sourceRecord;
  if(!previous && job.lastFileName===null && job.lastDuration===null && [job.lastFileAborted,job.lastFileCancelled,job.lastFileSimulated].every(value=>value===false)) {state.sourceRecord='none';detector.store.save();}
  if(record && record!==previous && previous && state.active) {
    detector.observe({command:'push_status',gcode_state:job.lastFileCancelled||job.lastFileSimulated?'CANCELLED':job.lastFileAborted?'FAILED':'FINISH',gcode_file:job.lastFileName,print_error:0,hms:[]});
  }
  if(record && record!==previous){state.sourceRecord=record;detector.store.save();}
  if(['processing','paused','pausing','resuming'].includes(status) && typeof job.file?.fileName==='string') {
    detector.observe({command:'push_status',gcode_state:status==='paused'?'PAUSE':'RUNNING',gcode_file:job.file.fileName,print_error:0,hms:[]});
  }

}
export function observeRepetier(detector,message,slug) {
  if(message?.eventList!==true||!Array.isArray(message.data))return;
  for(const event of message.data) {
    if(event?.printer!==slug || !Number.isFinite(event.data?.start) || event.data.start<=0)continue;
    const status={jobStarted:'RUNNING',jobFinished:'FINISH',jobKilled:'CANCELLED'}[event.event];
    if(!status)continue;
    // start is the documented per-job Unix timestamp; filename/slug never enter the payload.
    detector.observe({command:'push_status',gcode_state:status,task_id:event.data.start,print_error:0,hms:[]});
  }
}
export async function createPrinterSource({entry,cwd,journal,configuration,fetcher=fetch,Socket=WebSocket}) {
  const {id:printer,type,env}=configuration;
  if(type==='bambu')return createLegacySource({entry,cwd,journal,printer,env});
  if(!['klipper','octoprint','duet','repetier'].includes(type))throw new Error('Unsupported native event backend');
  let socket,pingTimer,closed=false,failed=false,connecting;
  const observe=operation=>{if(closed||failed)return;try{operation();}catch{failed=true;socket?.terminate();throw new Error("Printer event journal failed; operator repair required");}};
  const base=new URL(env.PRINTER_HOST.includes('://')?env.PRINTER_HOST:`http://${env.PRINTER_HOST}`);
  if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.search||base.hash) {throw new Error('Invalid printer URL');}
  if(env.PRINTER_PORT)base.port=env.PRINTER_PORT;
  base.pathname=base.pathname.replace(/\/$/,'')+'/';
  const url=(path)=>new URL(path.replace(/^\//,''),base);
  const store=new EventStore(journal), detector=new PrintEventDetector(store,printer);
  const get=async(path,options={})=> {
    const response=await fetcher(url(path),{headers:{'X-Api-Key':env.API_KEY??''},signal:AbortSignal.timeout(10000),redirect:'error',...options});
    if(!response.ok)throw new Error('Printer read failed');return response.json();
  };
  async function connectOctoPrint() {
    if(socket && socket.readyState===Socket.OPEN)return;
    if(connecting)return connecting;
    connecting=(async()=> {
      const session=await get('/api/login',{method:'POST',headers:{'X-Api-Key':env.API_KEY??'','Content-Type':'application/json'},body:JSON.stringify({passive:true})});
      if(typeof session.name!=='string'||!session.name||typeof session.session!=='string'||!session.session)throw new Error('Existing OctoPrint key needs STATUS permission');
      const endpoint=url(`/sockjs/000/${randomUUID().replaceAll('-','')}/websocket`);endpoint.protocol=base.protocol==='https:'?'wss:':'ws:';
      await new Promise((resolve,reject)=> {
        socket=new Socket(endpoint,{maxPayload:262144});
        const timeout=setTimeout(()=>{socket?.terminate();reject(new Error('Printer event socket timed out'));},10000);
        let opened=false;
        socket.on('message',bytes=> {
          try {
            const frame=String(bytes);
            if(frame==='o') {socket.send(JSON.stringify([JSON.stringify({subscribe:{state:{logs:false,messages:false},events:['PrintStarted','PrintPaused','PrintResumed','PrintDone','PrintCancelling','PrintCancelled','PrintFailed']}}),JSON.stringify({auth:`${session.name}:${session.session}`})]));opened=true;clearTimeout(timeout);resolve();return;}
            if(frame.startsWith('a'))for(const item of JSON.parse(frame.slice(1))) {const message=JSON.parse(item);observe(()=>observeOctoPrint(detector,message));}
          }catch {socket?.terminate();}
        });
        const disconnected=()=> {clearTimeout(timeout);if(!closed&&!failed){try{detector.disconnected();}catch{failed=true;}}if(!opened)reject(new Error('Printer event socket unavailable'));};
        socket.on('close',disconnected);socket.on('error',disconnected);
      });
    })().finally(()=>{connecting=undefined;});return connecting;
  }
  async function connectRepetier() {
    if(socket && socket.readyState===Socket.OPEN)return;
    if(connecting)return connecting;
    if(!env.API_KEY)throw new Error('Repetier event connection needs its existing API key');
    connecting=new Promise((resolve,reject)=> {
      const endpoint=url('/socket/');endpoint.protocol=base.protocol==='https:'?'wss:':'ws:';
      // Repetier documents API-key authentication in the websocket query. Never log this URL.
      endpoint.searchParams.set('apikey',env.API_KEY);
      socket=new Socket(endpoint,{maxPayload:262144});
      let sequence=1,authenticated=false;
      const ping=()=>{if(socket?.readyState===Socket.OPEN)socket.send(JSON.stringify({action:'ping',data:{},printer:env.REPETIER_SLUG,callback_id:sequence++}));};
      const timeout=setTimeout(()=>{socket?.terminate();reject(new Error('Repetier event authentication timed out'));},10000);
      socket.on('open',()=>{ping();pingTimer=setInterval(ping,1000);});
      socket.on('message',bytes=> {
        try {
          const message=JSON.parse(String(bytes));
          if(message.eventList===true && message.data?.some(event=>['loginRequired','logout'].includes(event.event)))throw new Error('Unauthorized');
          if(message.session && !authenticated){authenticated=true;clearTimeout(timeout);resolve();}
          if(authenticated)observe(()=>observeRepetier(detector,message,env.REPETIER_SLUG));
        }catch {socket?.terminate();}
      });
      const disconnected=()=>{clearTimeout(timeout);clearInterval(pingTimer);if(!closed&&!failed){try{detector.disconnected();}catch{failed=true;}}if(!authenticated)reject(new Error('Repetier event connection unavailable'));};
      socket.on('error',disconnected);socket.on('close',disconnected);
    }).finally(()=>{connecting=undefined;});return connecting;
  }
  return {printer,type,
    async readStatus() {
      if(closed||failed)throw new Error('Printer source closed or event journal failed');
      try {
        if(type==='klipper') {const data=await get('/printer/objects/query?webhooks&print_stats');observe(()=>observeMoonraker(detector,data));return text({connected:true,status:data?.result?.status?.print_stats?.state??'UNKNOWN'});}
        if(type==='duet'){const data=await get('/machine/status');observe(()=>observeDuet(detector,data));return text({connected:true,status:data?.state?.status??'UNKNOWN'});}
        if(type==='repetier')await connectRepetier();else await connectOctoPrint();return text({connected:true,status:'UNKNOWN'});
      }catch(error){detector.disconnected();throw error;}
    },
    async list(cursor){if(failed)throw new Error("Printer event journal failed");return text(listPrintEvents(store,cursor));},
    async close(){closed=true;clearInterval(pingTimer);socket?.terminate();store.close();},
  };
}
