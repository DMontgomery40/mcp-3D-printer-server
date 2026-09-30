import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {EventEmitter} from 'node:events';
import {EventStore} from '../dist/events/store.js';
import {PrintEventDetector} from '../dist/events/detector.js';
import {printerConfiguration,observeMoonraker,observeOctoPrint,observeDuet,observeRepetier,createPrinterSource} from './sources.mjs';
import {relayOnce} from './relay.mjs';
function fixture(t,id='farm-a'){const dir=mkdtempSync(join(tmpdir(),'farm-source-')),store=new EventStore(join(dir,'journal'));t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return {dir,store,detector:new PrintEventDetector(store,id)};}
const moon=(state,filename='private.gcode')=>({result:{status:{webhooks:{state:'ready'},print_stats:{state,filename}}}});
test('Moonraker explicit states, cancellation, errors, reconnect and same-file repeat',t=>{
 const {store,detector:d}=fixture(t);observeMoonraker(d,moon('complete'));assert.equal(store.data.history.length,0);
 observeMoonraker(d,moon('printing'));observeMoonraker(d,moon('complete'));d.disconnected();observeMoonraker(d,moon('printing'));observeMoonraker(d,moon('complete'));assert.equal(store.data.history.length,1);
 observeMoonraker(d,moon('standby'));observeMoonraker(d,moon('printing'));observeMoonraker(d,moon('cancelled'));observeMoonraker(d,moon('complete'));assert.equal(store.data.history.length,1);
 observeMoonraker(d,moon('printing'));observeMoonraker(d,moon('error'));observeMoonraker(d,moon('complete'));assert.deepEqual(store.data.history.map(e=>e.name),['print.completed','print.problem']);
 assert.ok(!JSON.stringify(store.data.history).includes('private.gcode'));
});
const octo=(type,reason)=>({event:{type,payload:{path:'private.gcode',origin:'local',reason}}});
test('OctoPrint explicit PrintDone follows active job even after idle status; cancellation is never completion',t=>{
 const {store,detector:d}=fixture(t);observeOctoPrint(d,octo('PrintDone'));assert.equal(store.data.history.length,0);
 observeOctoPrint(d,octo('PrintStarted'));observeOctoPrint(d,{current:{job:{file:{path:'private.gcode',origin:'local'}},state:{flags:{printing:false,paused:false}},progress:{completion:100}}});assert.equal(store.data.history.length,0);
 observeOctoPrint(d,octo('PrintDone'));observeOctoPrint(d,octo('PrintDone'));assert.equal(store.data.history.length,1);
 observeOctoPrint(d,octo('PrintStarted'));observeOctoPrint(d,octo('PrintFailed','cancelled'));observeOctoPrint(d,octo('PrintDone'));assert.equal(store.data.history.length,1);
 observeOctoPrint(d,octo('PrintStarted'));observeOctoPrint(d,octo('PrintFailed','error'));assert.equal(store.data.history[1].name,'print.problem');
});
const duet=(status,extra={})=>({state:{status},job:{file:{fileName:'private.gcode'},lastFileName:'old.gcode',lastDuration:10,lastFileAborted:false,lastFileCancelled:false,lastFileSimulated:false,...extra}});
test('Duet requires changed explicit last-job record and rejects cancellation, simulation and missing flags',t=>{
 const {store,detector:d}=fixture(t);observeDuet(d,duet('idle'));observeDuet(d,duet('processing'));observeDuet(d,duet('idle'));assert.equal(store.data.history.length,0);
 observeDuet(d,duet('idle',{lastFileName:'private.gcode',lastDuration:20}));assert.equal(store.data.history.length,1);
 for(const flag of ['lastFileCancelled','lastFileSimulated','lastFileAborted']){observeDuet(d,duet('processing',{lastFileName:'private.gcode',lastDuration:20}));observeDuet(d,duet('idle',{lastFileName:'private.gcode',lastDuration:30,[flag]:true}));}
 assert.equal(store.data.history.filter(e=>e.name==='print.completed').length,1);
 observeDuet(d,duet('processing'));observeDuet(d,duet('idle',{lastFileName:'private.gcode',lastDuration:40,lastFileCancelled:undefined}));assert.equal(store.data.history.filter(e=>e.name==='print.completed').length,1);
});
test('Repetier native per-slug job timestamps do not mix printers or treat killed jobs as finished',t=>{
 const {store,detector:d}=fixture(t);const event=(name,start=100,printer='real-slug')=>({eventList:true,data:[{event:name,printer,data:{start}}]});
 observeRepetier(d,event('jobStarted',100,'another-slug'),'real-slug');observeRepetier(d,event('jobFinished'),'real-slug');assert.equal(store.data.history.length,0);
 observeRepetier(d,event('jobStarted'),'real-slug');observeRepetier(d,event('jobFinished'),'real-slug');observeRepetier(d,event('jobFinished'),'real-slug');assert.equal(store.data.history.length,1);
 observeRepetier(d,event('jobStarted',101),'real-slug');observeRepetier(d,event('jobKilled',101),'real-slug');observeRepetier(d,event('jobFinished',101),'real-slug');assert.equal(store.data.history.length,1);
});
test('farm config isolates credentials and refuses unsupported adapters and ambiguous Repetier slugs',t=>{
 const {dir}=fixture(t);const path=join(dir,'printers.json');const put=value=>writeFileSync(path,JSON.stringify(value),{mode:0o600});
 put([{id:'a',type:'klipper',environment:{PRINTER_HOST:'dummy-a'}},{id:'b',type:'bambu',environment:{PRINTER_HOST:'dummy-b',BAMBU_SERIAL:'dummy-serial',BAMBU_TOKEN:'dummy-token'}}]);
 const entries=printerConfiguration(path,{API_KEY:'inherited-secret',BAMBU_TOKEN:'inherited-token'});assert.equal(entries[0].env.API_KEY,'');assert.equal(entries[0].env.BAMBU_TOKEN,'');assert.equal(entries[1].env.API_KEY,'');assert.equal(entries[1].env.BAMBU_TOKEN,'dummy-token');
 for(const type of ['prusa','creality']){put([{id:'a',type,environment:{PRINTER_HOST:'dummy'}}]);assert.throws(()=>printerConfiguration(path),/unavailable/);}
 put([{id:'a',type:'repetier',environment:{PRINTER_HOST:'dummy'}}]);assert.throws(()=>printerConfiguration(path),/slug/);
 put([{id:'a',type:'bambu',environment:{PRINTER_HOST:'dummy',BAMBU_SERIAL:'dummy',BAMBU_TOKEN:'dummy'}},{id:'a',type:'bambu',environment:{PRINTER_HOST:'dummy',BAMBU_SERIAL:'dummy',BAMBU_TOKEN:'dummy'}}]);assert.throws(()=>printerConfiguration(path),/unique/);
});
test('farm source relay cursors are independent and mismatch leaves cursor untouched',async t=>{
 const {store}=fixture(t);const source=(printer,name)=>({printer,list:async cursor=>({content:[{type:'text',text:JSON.stringify({events:cursor==='0'?[{eventId:`id-${printer}`,name:'print.completed',timestamp:new Date().toISOString(),data:{printer:name??printer,jobId:'opaque'},cursor:'1'}]:[],cursor:'1',truncated:false})}]})});
 await relayOnce(source('a'),store);await relayOnce(source('b'),store);await relayOnce(source('a'),store);assert.equal(store.data.history.length,2);assert.deepEqual(store.data.sourceCursors,{a:'1',b:'1'});
 await assert.rejects(relayOnce(source('c','wrong'),store),/alias/);assert.equal(store.data.sourceCursors.c,undefined);
});
test('source polling uses only documented GET and same alias; failed read preserves event journal',async t=>{
 const {dir}=fixture(t);let requested=[],state='printing',fail=false;
 const source=await createPrinterSource({journal:join(dir,'source'),configuration:{id:'farm-b',type:'klipper',env:{PRINTER_HOST:'dummy',API_KEY:'dummy-key'}},fetcher:async(url,options)=>{requested.push([url.pathname,url.search,options]);if(fail)throw new Error('offline');return {ok:true,json:async()=>moon(state)};}});
 await source.readStatus();state='complete';await source.readStatus();fail=true;await assert.rejects(source.readStatus());
 const page=JSON.parse((await source.list('0')).content[0].text);assert.equal(page.events.length,1);assert.equal(page.events[0].data.printer,'farm-b');assert.ok(requested.every(([path])=>path==='/printer/objects/query'));assert.ok(requested.every(([, ,options])=>!options.method));await source.close();
});
test('OctoPrint socket framing authenticates with existing STATUS session and never uses cached idle as completion',async t=>{
 const {dir}=fixture(t);const sent=[];let live;
 class Socket extends EventEmitter {static OPEN=1;readyState=1;constructor(endpoint){super();assert.match(endpoint.pathname,/\/sockjs\/000\/[a-f0-9]+\/websocket$/);live=this;queueMicrotask(()=>this.emit('message',Buffer.from('o')));}send(value){sent.push(JSON.parse(value).map(JSON.parse));}terminate(){this.readyState=3;this.emit('close');}}
 const source=await createPrinterSource({journal:join(dir,'socket-source'),configuration:{id:'farm-b',type:'octoprint',env:{PRINTER_HOST:'dummy',API_KEY:'existing-key'}},Socket,fetcher:async(url,options)=>{assert.equal(url.pathname,'/api/login');assert.equal(options.method,'POST');assert.deepEqual(JSON.parse(options.body),{passive:true});assert.equal(options.headers['X-Api-Key'],'existing-key');return {ok:true,json:async()=>({name:'existing-user',session:'existing-status-session'})};}});
 try {await source.readStatus();assert.ok(sent[0][0].subscribe.events.includes('PrintDone'));assert.equal(sent[0][1].auth,'existing-user:existing-status-session');const emit=message=>live.emit('message',Buffer.from(`a${JSON.stringify([JSON.stringify(message)])}`));emit(octo('PrintStarted'));emit(octo('PrintDone'));emit(octo('PrintDone'));assert.equal(JSON.parse((await source.list('0')).content[0].text).events.length,1);}finally{await source.close();}
});

test('Duet consumes a completed last-job record before arming the next active file',t=> {
 const {store,detector:d}=fixture(t);observeDuet(d,duet('idle'));observeDuet(d,duet('processing'));observeDuet(d,duet('processing',{file:{fileName:'next.gcode'},lastFileName:'private.gcode',lastDuration:20}));assert.equal(store.data.history.length,1);assert.equal(store.data.history[0].name,'print.completed');assert.equal(store.observation('farm-a').active,true);
});
test('invalid source URL fails before acquiring a journal lock',async t=> {
 const {dir}=fixture(t);const {existsSync}=await import('node:fs');const journal=join(dir,'invalid-url');await assert.rejects(createPrinterSource({journal,configuration:{id:'farm-a',type:'klipper',env:{PRINTER_HOST:'ftp://dummy'}}}),/URL/);assert.equal(existsSync(`${journal}.lock`),false);
});
test('malformed OctoPrint frames disconnect and reconnect without permanently disabling journal writes',async t=> {
 const {dir}=fixture(t);let live,connections=0;
 class Socket extends EventEmitter {static OPEN=1;readyState=1;constructor(){super();live=this;connections++;queueMicrotask(()=>this.emit('message',Buffer.from('o')));}send(){}terminate(){this.readyState=3;this.emit('close');}}
 const source=await createPrinterSource({journal:join(dir,'malformed-socket'),configuration:{id:'farm-b',type:'octoprint',env:{PRINTER_HOST:'dummy',API_KEY:'existing-key'}},Socket,fetcher:async()=>({ok:true,json:async()=>({name:'existing-user',session:'session'})})});
 try {await source.readStatus();live.emit('message',Buffer.from('a{broken'));await source.readStatus();assert.equal(connections,2);const emit=data=>live.emit('message',Buffer.from(`a${JSON.stringify([JSON.stringify(data)])}`));emit(octo('PrintStarted'));emit(octo('PrintDone'));assert.equal(JSON.parse((await source.list('0')).content[0].text).events.length,1);}finally{await source.close();}
});
