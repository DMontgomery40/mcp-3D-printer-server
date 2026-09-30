import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { EventStore } from '../dist/events/store.js';
import { PrintEventDetector } from '../dist/events/detector.js';
import { PrintEventRuntime, createPrintEventRuntime } from '../dist/events/runtime.js';
import { PrintEventService, listPrintEvents } from '../dist/events/service.js';
import { callbackUrl, publicAddress, sign, signingKey } from '../dist/events/webhook.js';

const secret = `whsec_${Buffer.alloc(32, 7).toString('base64')}`;
const params = (name='print.completed') => ({ name, arguments: { printer: 'default' }, delivery: { mode: 'webhook', url: 'https://receiver.example.com/events', secret }, cursor: '0' });
function fixture(t, limit=1000) {
  const dir = mkdtempSync(join(tmpdir(), 'print-events-'));
  const filename = join(dir,'journal.json'); let store = new EventStore(filename, limit);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { get store() { return store; }, filename, reopen() { store.close(); store = new EventStore(filename,limit); return store; } };
}
function observe(detector, update) { detector.observe({ command:'push_status', ...update }); }
const running = { gcode_state:'RUNNING', task_id:'task-1', subtask_id:'part-1', gcode_file:'private-file.gcode', print_error:0, hms:[] };

test('only an observed active job followed by FINISH completes; 100% and initial FINISH do not', t => {
  const f=fixture(t); const d=new PrintEventDetector(f.store);
  observe(d,{...running,gcode_state:'FINISH',mc_percent:100}); assert.equal(f.store.data.history.length,0);
  observe(d,running); observe(d,{mc_percent:100}); assert.equal(f.store.data.history.length,0);
  observe(d,{gcode_state:'FINISH'}); observe(d,{gcode_state:'FINISH'});
  assert.equal(f.store.data.history.length,1); assert.equal(f.store.data.history[0].name,'print.completed');
  const result=listPrintEvents(f.store); assert.equal(result.cursor,'1'); assert.equal(listPrintEvents(f.store,'1').events.length,0);
  const saved=readFileSync(f.filename,'utf8'); assert.ok(!saved.includes('private-file') && !saved.includes('task-1'));
  assert.equal(statSync(f.filename).mode & 0o777,0o600);
});
test('same file can be printed again on an observed new active transition', t=> {
  const f=fixture(t); const d=new PrintEventDetector(f.store);
  observe(d,running); observe(d,{gcode_state:'FINISH'}); observe(d,running); observe(d,{gcode_state:'FINISH'});
  assert.equal(f.store.data.history.length,2); assert.notEqual(f.store.data.history[0].data.jobId,f.store.data.history[1].data.jobId);
});
test('cancel request, CANCELLED, IDLE, failures and current errors never become completion', t=> {
  for (const interruption of ['cancel','CANCELLED','IDLE','FAILED','error']) {
    const dir=mkdtempSync(join(tmpdir(),'event-cancel-')); const store=new EventStore(join(dir,'journal')); const d=new PrintEventDetector(store);
    observe(d,running);
    if(interruption==='cancel') d.cancel(); else if(interruption==='error') observe(d,{print_error:123}); else observe(d,{gcode_state:interruption});
    observe(d,{gcode_state:'FINISH', print_error:interruption==='error'?123:0});
    assert.equal(store.data.history.filter(e=>e.name==='print.completed').length,0,interruption);
    store.close(); rmSync(dir,{recursive:true,force:true});
  }
});
test('problem codes are deduplicated per job; clear/reappear and sparse progress do not repeat',t=> {
  const f=fixture(t); const d=new PrintEventDetector(f.store); observe(d,running);
  const a={attr:0,code:0x10001}, b={attr:1,code:0x20001}, info={attr:2,code:0x40001};
  observe(d,{print_error:42,hms:[a,info]}); observe(d,{mc_percent:21}); observe(d,{hms:[a,b],print_error:0});
  observe(d,{hms:[]}); observe(d,{hms:[a,b],print_error:42});
  assert.deepEqual(f.store.data.history.map(e=>[e.data.reason,e.data.codes.length]),[['print_error',1],['hms',1],['hms',1]]);
});
test('reconnect and restart preserve armed jobs but cannot borrow stale identity',t=> {
  const f=fixture(t); let d=new PrintEventDetector(f.store); observe(d,running); d.disconnected();
  observe(d,{gcode_state:'FINISH'}); assert.equal(f.store.data.history.length,0);
  observe(d,{task_id:'task-1',subtask_id:'part-1',gcode_file:'private-file.gcode',print_error:0,hms:[]}); assert.equal(f.store.data.history.length,1);
  const id=f.store.data.history[0].eventId;
  d=new PrintEventDetector(f.reopen()); observe(d,running); observe(d,{gcode_state:'FINISH'});
  assert.equal(f.store.data.history.length,1); assert.equal(f.store.data.history[0].eventId,id);
});
test('restart mid-print can complete the same fully identified job',t=> {
  const f=fixture(t); observe(new PrintEventDetector(f.store),running);
  const d=new PrintEventDetector(f.reopen()); observe(d,{...running,gcode_state:'FINISH'});
  assert.equal(f.store.data.history.length,1);
});
test('changed job identity on terminal report does not complete the old job',t=> {
  const f=fixture(t); const d=new PrintEventDetector(f.store); observe(d,running);
  observe(d,{...running,gcode_state:'FINISH',task_id:'different',subtask_id:'different'}); assert.equal(f.store.data.history.length,0);
});
test('journal locks competing writers and rejects corrupt state',t=> {
  const f=fixture(t); assert.throws(()=>new EventStore(f.filename),/EEXIST/);
  f.store.close(); writeFileSync(f.filename,'{'); assert.throws(()=>new EventStore(f.filename));
  writeFileSync(f.filename,JSON.stringify({version:2})); assert.throws(()=>new EventStore(f.filename),/Invalid/);
  // Restore fixture to a usable journal for cleanup.
  writeFileSync(f.filename,JSON.stringify({version:1,sequence:0,history:[],subscriptions:[],observation:{active:false,cancelled:false,terminal:false,problems:[]}})); f.reopen();
});
test('runtime attaches before connection, filters target/topic, resets reconnect, and cancels passively',t=> {
  const f=fixture(t); const runtime=new PrintEventRuntime(f.store,'dummy-host','dummy-serial'); const printer=new EventEmitter();
  runtime.attach(printer,'dummy-host','dummy-serial');
  const emit=(topic,report)=>printer.emit('rawMessage',topic,Buffer.from(JSON.stringify({print:report})));
  emit('device/other/report',{command:'push_status',...running}); assert.equal(f.store.data.observation.active,false);
  emit('device/dummy-serial/report',{command:'project_file',...running}); assert.equal(f.store.data.observation.active,false);
  emit('device/dummy-serial/report',{command:'push_status',...running}); runtime.cancel('dummy-host','dummy-serial');
  emit('device/dummy-serial/report',{command:'push_status',gcode_state:'FINISH'}); assert.equal(runtime.list({}).events.length,0);
});
test('unsupported clients have no subscriptions and no recording by default',()=> {
  const before=process.env.MCP_PRINT_EVENT_STORE; delete process.env.MCP_PRINT_EVENT_STORE;
  try { assert.equal(createPrintEventRuntime('dummy','dummy'),undefined); } finally { if(before!==undefined) process.env.MCP_PRINT_EVENT_STORE=before; }
});
test('Standard Webhooks signs exact body bytes and validates secret size/canonical encoding',()=> {
  const body='{"eventId":"evt_test"}'; const expected=createHmac('sha256',Buffer.alloc(32,7)).update(`evt_test.123.${body}`).digest('base64');
  assert.equal(sign(secret,'evt_test',123,body),`v1,${expected}`);
  for(const s of ['abc','whsec_YQ==',`${secret}=`]) assert.throws(()=>signingKey(s));
});
test('callback policy blocks local/special IPv4, mapped/private IPv6, credentials and redirects by design',()=> {
  for(const ip of ['127.0.0.1','10.0.0.1','172.16.1.1','192.168.0.1','169.254.1.1','100.64.0.1','0.0.0.0','224.0.0.1','198.18.0.1','192.0.2.1','::1','::ffff:8.8.8.8','fc00::1','fe80::1','2001:db8::1','2002:0808:0808::1']) assert.equal(publicAddress(ip),false,ip);
  for(const ip of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111']) assert.equal(publicAddress(ip),true,ip);
  for(const url of ['http://receiver.example','https://user:password@receiver.example','https://receiver.example:8443/x','https://receiver.example/#x']) assert.throws(()=>callbackUrl(url));
});
test('owner-scoped subscription verifies, survives restart, retries stable IDs and advances only after ACK',async t=> {
  const f=fixture(t); let time=1000000; const calls=[]; let failure=true;
  const sender=async (url,body,headers)=> { const data=JSON.parse(body); calls.push({url,body,headers,data});
    if(data.type==='verification') return {status:200,body:JSON.stringify({challenge:data.challenge})};
    return {status:failure?503:204,body:''}; };
  let service=new PrintEventService(f.store,()=>true,sender,()=>time); const auth={principal:'owner-a'};
  const result=await service.handle('events/subscribe',params(),auth);
  assert.equal((await service.handle('events/subscribe',params(),auth)).id,result.id); assert.equal(calls.length,1);
  const d=new PrintEventDetector(f.store); observe(d,running); observe(d,{gcode_state:'FINISH'});
  await service.deliverPending(); assert.equal(f.store.data.subscriptions[0].position,0);
  const sent=calls.at(-1); time+=1001; failure=false;
  service=new PrintEventService(f.reopen(),()=>true,sender,()=>time); await service.deliverPending();
  assert.equal(calls.at(-1).headers['webhook-id'],sent.headers['webhook-id']); assert.equal(calls.at(-1).body,sent.body);
  assert.notEqual(calls.at(-1).headers['webhook-signature'],sent.headers['webhook-signature']);
  assert.equal(f.store.data.subscriptions[0].position,1);
  await service.handle('events/unsubscribe',params(),{principal:'owner-b'}); assert.equal(f.store.data.subscriptions.length,1);
  await service.handle('events/unsubscribe',params(),auth); await service.handle('events/unsubscribe',params(),auth); assert.equal(f.store.data.subscriptions.length,0);
});
test('expiry, revocation, bad verification, invalid arguments, rotation and nonretryable status',async t=> {
  const f=fixture(t); let time=1000000, allowed=true, status=410; const calls=[];
  const sender=async (_,body,headers)=> { const data=JSON.parse(body); calls.push(headers);
    return data.type==='verification'?{status:200,body:JSON.stringify({challenge:data.challenge})}:{status,body:''}; };
  const service=new PrintEventService(f.store,()=>allowed,sender,()=>time),auth={principal:'owner'};
  await assert.rejects(service.handle('events/list',{},{}),e=>e.code===-32012);
  await assert.rejects(service.handle('events/subscribe',{...params(),arguments:{printer:'other'}},auth),e=>e.code===-32012);
  const bad=new PrintEventService(f.store,()=>true,async()=>({status:200,body:'{"challenge":"wrong"}'}),()=>time);
  await assert.rejects(bad.handle('events/subscribe',params(),auth),e=>e.code===-32015); assert.equal(f.store.data.subscriptions.length,0);
  await service.handle('events/subscribe',params(),auth);
  const rotated=params(); rotated.delivery.secret=`whsec_${Buffer.alloc(32,8).toString('base64')}`;
  await service.handle('events/subscribe',rotated,auth); assert.equal(calls.at(-1)['webhook-signature'].split(' ').length,2);
  const d=new PrintEventDetector(f.store); observe(d,running); observe(d,{gcode_state:'FINISH'}); await service.deliverPending();
  assert.equal(f.store.data.subscriptions[0].stopped,true); assert.equal(f.store.data.subscriptions[0].position,0);
  await service.handle('events/subscribe',{...params(),ttlMs:10},auth); time+=11; await service.deliverPending(); assert.equal(f.store.data.subscriptions.length,0);
  await service.handle('events/subscribe',params(),auth); allowed=false; await service.deliverPending(); assert.equal(f.store.data.subscriptions.length,0);
});
test('replay truncation and retention never pretend a dropped pending event was acknowledged',async t=> {
  const f=fixture(t,1); const service=new PrintEventService(f.store,()=>true,async (_,body)=>({status:200,body:JSON.stringify({challenge:JSON.parse(body).challenge})}));
  await service.handle('events/subscribe',params(),{principal:'owner'});
  const d=new PrintEventDetector(f.store); observe(d,running); observe(d,{gcode_state:'FINISH'}); observe(d,running); observe(d,{gcode_state:'FINISH'});
  assert.equal(f.store.data.subscriptions[0].stopped,true); assert.equal(f.store.data.subscriptions[0].position,0);
  assert.equal(listPrintEvents(f.store,'0').truncated,true);
  assert.equal((await service.handle('events/subscribe',params(),{principal:'owner'})).truncated,true);
});

test('legacy stdio client discovers and reads the opt-in history tool without contacting a printer',async t=> {
  const { Client }=await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport }=await import('@modelcontextprotocol/sdk/client/stdio.js');
  const dir=mkdtempSync(join(tmpdir(),'event-stdio-')); t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const transport=new StdioClientTransport({command:process.execPath,args:[new URL('../dist/index.js',import.meta.url).pathname],
    cwd:new URL('..',import.meta.url).pathname,
    env:{...process.env,MCP_TRANSPORT:'stdio',MCP_PRINT_EVENT_STORE:join(dir,'journal.json'),PRINTER_TYPE:'bambu',
      PRINTER_HOST:'dummy-host',BAMBU_PRINTER_HOST:'dummy-host',BAMBU_SERIAL:'dummy-serial',BAMBU_PRINTER_SERIAL:'dummy-serial',BAMBU_TOKEN:'dummy-token'},stderr:'pipe'});
  const client=new Client({name:'event-tests',version:'0.0.1'}); t.after(()=>client.close());
  await client.connect(transport);
  assert.ok((await client.listTools()).tools.some(tool=>tool.name==='list_print_events'));
  assert.equal(client.getServerCapabilities().events,undefined);
  const result=await client.callTool({name:'list_print_events',arguments:{}});
  const page=JSON.parse(result.content[0].text);assert.ok(page.journalId);delete page.journalId;assert.deepEqual(page,{events:[],cursor:'0',truncated:false});
  await assert.rejects(client.request({method:'server/discover',params:{}},(await import('zod')).z.any()),error=>error.code===-32601);
  await client.close();
});

test('callback transport revalidates DNS each time and pins a public IP without changing the TLS hostname',async()=> {
  const { createPublicCallbackSender }=await import('../dist/events/webhook.js');
  let resolutions=0,requests=0;
  const sender=createPublicCallbackSender(async hostname=> { assert.equal(hostname,'receiver.example.com');
    return [{address: ++resolutions===1?'8.8.8.8':'127.0.0.1',family:4}]; },(url,options,callback)=> {
      requests++; assert.equal(url.hostname,'receiver.example.com'); assert.equal(options.agent,false);assert.equal(options.family,4);
      options.lookup('receiver.example.com',{},(_,address,family)=> {assert.equal(address,'8.8.8.8');assert.equal(family,4);});
      const req=new EventEmitter(); req.destroy=()=>{};
      req.end=()=> {const res=new EventEmitter();res.statusCode=302;res.destroy=()=>{};callback(res);
        queueMicrotask(()=> {res.emit('end');req.emit('close');});}; return req;
  });
  const result=await sender('https://receiver.example.com/events','{}',{}); assert.equal(result.status,302); assert.equal(requests,1);
  await assert.rejects(sender('https://receiver.example.com/events','{}',{}),/Non-public/); assert.equal(requests,1);
});


test('sparse filename enrichment preserves fault deduplication while recovered jobs may finish',t=> {
  const f=fixture(t),d=new PrintEventDetector(f.store);
  observe(d,{...running,gcode_file:undefined}); observe(d,{print_error:123});
  observe(d,{gcode_file:'newly-reported.gcode',print_error:0}); observe(d,{gcode_state:'FINISH'});
  assert.equal(f.store.data.history.filter(e=>e.name==='print.problem').length,1);
  assert.equal(f.store.data.history.filter(e=>e.name==='print.completed').length,1);
});

test('cancelled FAILED closes the job; terminal reconnect baseline permits a new same-file print',t=> {
 const f=fixture(t),d=new PrintEventDetector(f.store);observe(d,running);d.cancel();observe(d,{gcode_state:'FAILED'});
 assert.equal(f.store.data.observation.active,false);assert.equal(f.store.data.history.length,0);
 d.disconnected();observe(d,{...running,gcode_state:'FAILED'});observe(d,running);observe(d,{gcode_state:'FINISH'});
 assert.equal(f.store.data.history.filter(e=>e.name==='print.completed').length,1);
});
test('new job sparse start cannot inherit previous errors and recovered jobs can finish',t=> {
 const f=fixture(t),d=new PrintEventDetector(f.store);observe(d,running);observe(d,{gcode_state:'FAILED',print_error:999,hms:[{attr:0,code:65537}]});
 observe(d,{gcode_state:'RUNNING',subtask_id:'new-task'});observe(d,{gcode_state:'FINISH'});
 assert.equal(f.store.data.history.filter(e=>e.name==='print.completed').length,0);
 observe(d,{print_error:0,hms:[]});
 assert.equal(f.store.data.history.filter(e=>e.name==='print.completed').length,1);
});
test('optional capture startup fails disabled for lock/corruption without blocking printer controls',t=> {
 const f=fixture(t),old=process.env.MCP_PRINT_EVENT_STORE;
 try {process.env.MCP_PRINT_EVENT_STORE=f.filename;assert.equal(createPrintEventRuntime('dummy','dummy'),undefined);
  process.env.MCP_PRINT_EVENT_STORE='relative.json';assert.equal(createPrintEventRuntime('dummy','dummy'),undefined);
 } finally { if(old===undefined)delete process.env.MCP_PRINT_EVENT_STORE;else process.env.MCP_PRINT_EVENT_STORE=old; }
});
test('stopped and backoff subscriptions still expire and lose secrets on revocation',async t=> {
 const f=fixture(t);let now=1000000,allowed=true;const service=new PrintEventService(f.store,()=>allowed,async(_,body)=>({status:200,body:JSON.stringify({challenge:JSON.parse(body).challenge})}),()=>now);
 await service.handle('events/subscribe',{...params(),ttlMs:10},{principal:'owner'});f.store.data.subscriptions[0].stopped=true;
 now+=11;await service.deliverPending();assert.equal(f.store.data.subscriptions.length,0);
 await service.handle('events/subscribe',params(),{principal:'owner'});f.store.data.subscriptions[0].retryAt=now+1000;allowed=false;
 await service.deliverPending();assert.equal(f.store.data.subscriptions.length,0);
});

test('late stronger identity enrichment retains the original observed job and problem history',t=> {
 const f=fixture(t),d=new PrintEventDetector(f.store);observe(d,{command:'push_status',gcode_state:'RUNNING',gcode_file:'synthetic-file',print_error:0,hms:[]});
 const job=f.store.data.observation.jobId;observe(d,{task_id:'late-task',subtask_id:'late-part',print_error:99});
 assert.equal(f.store.data.history[0].data.jobId,job);observe(d,{print_error:0,gcode_state:'FINISH'});
 assert.equal(f.store.data.history.length,2);assert.equal(f.store.data.history[1].data.jobId,job);
});
test('FINISH with missing or malformed fresh fault evidence cannot invent successful completion',t=> {
 const f=fixture(t),d=new PrintEventDetector(f.store);observe(d,running);d.disconnected();
 observe(d,{...running,gcode_state:'FINISH',print_error:undefined,hms:undefined});assert.equal(f.store.data.history.length,0);
 observe(d,{print_error:'0',hms:[{}]});assert.equal(f.store.data.history.length,0);
 observe(d,{print_error:0,hms:[]});assert.equal(f.store.data.history.length,1);
});
test('one owners transient authorization failure cannot starve another owner or collide delivery IDs',async t=> {
 const f=fixture(t);let fail=false;const ids=[];
 const service=new PrintEventService(f.store,({principal})=>{if(fail&&principal==='a')throw Error('verifier unavailable');return true;},async(_,body,headers)=> {
   const event=JSON.parse(body);if(event.type==='verification')return {status:200,body:JSON.stringify({challenge:event.challenge})};
   assert.equal(event.eventId,headers['webhook-id']);ids.push(event.eventId);return {status:204,body:''};
 });
 await service.handle('events/subscribe',params(),{principal:'a'});await service.handle('events/subscribe',params(),{principal:'b'});
 const d=new PrintEventDetector(f.store);observe(d,running);observe(d,{gcode_state:'FINISH'});
 fail=true;await service.deliverPending();assert.equal(ids.length,1);assert.equal(f.store.data.subscriptions[0].position,0);
 fail=false;await service.deliverPending();assert.equal(ids.length,2);assert.notEqual(ids[0],ids[1]);
});
test('farm identities isolate jobs, replay, subscriptions and revoked permissions',async t=> {
 const f=fixture(t),printers=['farm-a','farm-b','constructor'];
 const a=new PrintEventDetector(f.store,'farm-a'),b=new PrintEventDetector(f.store,'farm-b');
 observe(a,running);observe(b,running);observe(a,{gcode_state:'FINISH'});observe(b,{gcode_state:'FAILED'});
 const c=new PrintEventDetector(f.store,'constructor');observe(c,running);observe(c,{gcode_state:'FINISH'});
 assert.deepEqual(f.store.data.history.map(e=>[e.data.printer,e.name]),[['farm-a','print.completed'],['farm-b','print.problem'],['constructor','print.completed']]);
 const received=[];let allowed=true;
 const policy=({principal},printer)=>allowed&&principal==='a'&&printer==='farm-a';
 const service=new PrintEventService(f.store,policy,async(_url,body)=>{const data=JSON.parse(body);if(data.type==='verification')return {status:200,body:JSON.stringify({challenge:data.challenge})};received.push(data);return {status:204,body:''};},Date.now,printers);
 const catalog=await service.handle('events/list',{}, {principal:'a'});assert.deepEqual(catalog.events[0].inputSchema.properties.printer.enum,['farm-a']);
 const p={...params(),arguments:{printer:'farm-a'}};
 await assert.rejects(service.handle('events/subscribe',{...p,arguments:{printer:'farm-b'}},{principal:'a'}),/Forbidden/);
 await service.handle('events/subscribe',p,{principal:'a'});await service.deliverPending();assert.equal(received.length,1);assert.equal(received[0].data.printer,'farm-a');
 await service.deliverPending();assert.equal(received.length,1);
 const restarted=new PrintEventDetector(f.reopen(),'farm-a');observe(restarted,running);observe(restarted,{gcode_state:'FINISH'});assert.equal(f.store.data.history.length,3);
 const resumed=new PrintEventService(f.store,policy,undefined,Date.now,printers);allowed=false;await resumed.deliverPending();assert.equal(f.store.data.subscriptions.length,0);
});


test('remote cursors and retention expose only the selected printer and advertise supported event types',async t=> {
 const {listPrinterEvents}=await import('../dist/events/service.js');const f=fixture(t);
 const append=(printer,id)=>f.store.append({eventId:id,name:'print.completed',timestamp:new Date().toISOString(),data:{printer,jobId:id}});
 append('b','b1');append('a','a1');append('b','b2');append('a','a2');f.store.save();
 const page=listPrinterEvents(f.store,'a');assert.deepEqual(page.events.map(e=>e.cursor),['1','2']);assert.equal(page.cursor,'2');assert.ok(page.events.every(e=>!('printerCursor' in e)));
 const service=new PrintEventService(f.store,(_owner,printer)=>printer==='a',undefined,Date.now,['a','b'],()=>['print.completed']);
 assert.deepEqual((await service.handle('events/list',{}, {principal:'a'})).events.map(e=>e.name),['print.completed']);
 for(const printer of ['b','unknown'])await assert.rejects(service.handle('events/subscribe',{...params(),arguments:{printer}},{principal:'a'}),e=>e.code===-32012);
 await assert.rejects(service.handle('events/subscribe',{...params('print.problem'),arguments:{printer:'a'}},{principal:'a'}),e=>e.code===-32602);
});
test('failed durable subscription save does not activate a callback',async t=> {
 const f=fixture(t),service=new PrintEventService(f.store,()=>true,async(_url,body)=>({status:200,body:JSON.stringify({challenge:JSON.parse(body).challenge})}));
 const save=f.store.save;f.store.save=()=>{throw Error('disk full');};
 try {await assert.rejects(service.handle('events/subscribe',params(),{principal:'a'}),/disk full/);assert.equal(f.store.data.subscriptions.length,0);}finally{f.store.save=save;}
});
test('a slow callback or verification does not block another owners receipt',async t=> {
 const f=fixture(t);let release,waiting;const gate=new Promise(resolve=>{release=resolve;});const started=new Promise(resolve=>{waiting=resolve;});const received=[];
 const service=new PrintEventService(f.store,()=>true,async(url,body)=>{const data=JSON.parse(body);if(data.type==='verification')return {status:200,body:JSON.stringify({challenge:data.challenge})};if(url.endsWith('/slow')){waiting();await gate;}received.push(url);return {status:204,body:''};});
 await service.handle('events/subscribe',{...params(),delivery:{...params().delivery,url:'https://receiver.example.com/slow'}},{principal:'a'});await service.handle('events/subscribe',params(),{principal:'b'});
 const d=new PrintEventDetector(f.store);observe(d,running);observe(d,{gcode_state:'FINISH'});
 const delivery=service.deliverPending();await started;await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(received,['https://receiver.example.com/events']);release();await delivery;assert.equal(received.length,2);
 let verifyRelease;const verifyGate=new Promise(resolve=>{verifyRelease=resolve;});const verificationService=new PrintEventService(f.store,()=>true,async(url,body)=>{const data=JSON.parse(body);if(url.endsWith('/wait'))await verifyGate;return {status:200,body:JSON.stringify({challenge:data.challenge})};});
 const pending=verificationService.handle('events/subscribe',{...params(),delivery:{...params().delivery,url:'https://receiver.example.com/wait'}},{principal:'c'});
 await verificationService.handle('events/subscribe',params(),{principal:'d'});assert.ok(f.store.data.subscriptions.some(s=>s.owner==='d'));verifyRelease();await pending;
});
test('bounded delivery rotates across queued subscriptions rather than starving later subscribers',async t=> {
 const f=fixture(t),service=new PrintEventService(f.store,()=>true,async(_url,body)=>{const data=JSON.parse(body);return data.type==='verification'?{status:200,body:JSON.stringify({challenge:data.challenge})}:{status:204,body:''};});
 for(let i=0;i<35;i++)await service.handle('events/subscribe',{...params(),delivery:{...params().delivery,url:`https://receiver.example.com/${i}`}},{principal:'a'});
 const d=new PrintEventDetector(f.store);for(let i=0;i<2;i++){observe(d,running);observe(d,{gcode_state:'FINISH'});}await service.deliverPending();await service.deliverPending();assert.ok(f.store.data.subscriptions.every(s=>s.position>0));
});
test('refresh keeps an ACK made during challenge verification and returns its actual cursor',async t=> {
 const f=fixture(t);let time=1000000,release,start;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>start=resolve);let wait=false;
 const service=new PrintEventService(f.store,()=>true,async(_url,body)=>{const data=JSON.parse(body);if(data.type==='verification'){if(wait){start();await gate;}return {status:200,body:JSON.stringify({challenge:data.challenge})};}return {status:204,body:''};},()=>time);
 await service.handle('events/subscribe',params(),{principal:'a'});const d=new PrintEventDetector(f.store);observe(d,running);observe(d,{gcode_state:'FINISH'});
 time+=300001;wait=true;const refresh=service.handle('events/subscribe',params(),{principal:'a'});await started;await service.deliverPending();release();const result=await refresh;assert.equal(result.cursor,'1');assert.equal(f.store.data.subscriptions[0].position,1);
});
