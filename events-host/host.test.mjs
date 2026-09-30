import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { PROTOCOL_VERSION_META_KEY, CLIENT_CAPABILITIES_META_KEY } from '@modelcontextprotocol/server';
import { EventStore } from '../dist/events/store.js';
import { PrintEventDetector } from '../dist/events/detector.js';
import { createPrintEventHost } from './host.mjs';
import { relayOnce } from './relay.mjs';

const secret=`whsec_${Buffer.alloc(32,9).toString('base64')}`;
const token='test-only-not-a-provisioned-credential';
function fixture(t) {
 const dir=mkdtempSync(join(tmpdir(),'mcp2-printer-host-'));const store=new EventStore(join(dir,'journal'));
 t.after(()=> {store.close();rmSync(dir,{recursive:true,force:true});});return store;
}
const subscribe={name:'print.completed',arguments:{printer:'default'},delivery:{mode:'webhook',url:'https://receiver.example.com/events',secret},cursor:'0'};
function request(method,params={},auth=token,version='2026-07-28') {
 return new Request('http://127.0.0.1/mcp',{method:'POST',headers:{host:'127.0.0.1','Mcp-Method':method,...params.name?{'Mcp-Name':encodeURIComponent(params.name)}:{},'content-type':'application/json',accept:'application/json, text/event-stream','MCP-Protocol-Version':version,...auth?{authorization:`Bearer ${auth}`}:{}} ,
 body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:{...params,_meta:{[PROTOCOL_VERSION_META_KEY]:version,[CLIENT_CAPABILITIES_META_KEY]:{}}}})});
}
const authenticate=async req=>req.headers.get('authorization')===`Bearer ${token}`?{principal:'operator',scopes:['printer:read']}:undefined;
test('official SDK2 discovery, tools and full signed event lifecycle use one authenticated endpoint',async t=> {
 const store=fixture(t);let received=[];
 const sender=async (_url,body,headers)=> {
   const data=JSON.parse(body);const expected=createHmac('sha256',Buffer.alloc(32,9)).update(`${headers['webhook-id']}.${headers['webhook-timestamp']}.${body}`).digest('base64');
   assert.equal(headers['webhook-signature'],`v1,${expected}`);
   if(data.type==='verification')return {status:200,body:JSON.stringify({challenge:data.challenge})};
   assert.equal(headers['webhook-id'],data.eventId);received.push(data);return {status:204,body:''};
 };
 const host=createPrintEventHost({store,authenticate,authorize:()=>true,sender,readStatus:async()=>({content:[{type:'text',text:JSON.stringify({status:'RUNNING',connected:true,host:'private-host',serial:'private-serial',raw:{ams:{privateId:'private-ams'}}})}]})});t.after(()=>host.close());
 assert.equal((await host.fetch(request('server/discover',{},null))).status,401);
 const discovery=await (await host.fetch(request('server/discover'))).json();
 assert.ok(!discovery.error,JSON.stringify(discovery));assert.equal(discovery.result.resultType,'complete');
 assert.ok(discovery.result.supportedVersions.includes('2026-07-28'));assert.deepEqual(discovery.result.capabilities.events,{});
 const tools=await (await host.fetch(request('tools/list'))).json();assert.ok(tools.result.tools.some(t=>t.name==='list_print_events'));for(const tool of tools.result.tools)assert.deepEqual(tool.securitySchemes,[{type:'oauth2',scopes:['printer:read']}]);
 const status=await (await host.fetch(request('tools/call',{name:'get_printer_status',arguments:{}}))).json();assert.deepEqual(JSON.parse(status.result.content[0].text),{printer:'default',connected:true,status:'RUNNING'});assert.ok(!JSON.stringify(status).includes('private-'));
 const eventTypes=await (await host.fetch(request('events/list'))).json();assert.equal(eventTypes.result.events.length,2);
 const sub=await (await host.fetch(request('events/subscribe',subscribe))).json();assert.ok(sub.result?.id,JSON.stringify(sub));
 const detector=new PrintEventDetector(store);detector.observe({command:'push_status',gcode_state:'RUNNING',task_id:'synthetic-1',print_error:0,hms:[]});
 detector.observe({command:'push_status',gcode_state:'FINISH'});
 await host.service.deliverPending();assert.equal(received.length,1);assert.equal(received[0].name,'print.completed');
 const stopped=await (await host.fetch(request('events/unsubscribe',subscribe))).json();assert.equal(stopped.result.resultType,'complete');assert.equal(store.data.subscriptions.length,0);
 const mutation=await (await host.fetch(request('tools/call',{name:'start_print',arguments:{}}))).json();assert.ok(mutation.error);
 const old=await host.fetch(request('tools/list',{},token,'2025-11-25'));assert.ok((await old.json()).error);
});
test('host rejects unauthorized origins/principals and never trusts metadata as authentication',async t=> {
 const store=fixture(t),host=createPrintEventHost({store,authenticate,authorize:({principal})=>principal==='operator'});t.after(()=>host.close());
 assert.equal((await host.fetch(request('events/list',{},'wrong'))).status,401);
 const foreign=request('events/list');foreign.headers.set('origin','https://evil.example');assert.equal((await host.fetch(foreign)).status,403);
 const domain=new Request('http://evil.example/mcp',request('server/discover'));domain.headers.set('host','evil.example');assert.equal((await host.fetch(domain)).status,403);
});
test('relay commits source watermark with events, preserves event IDs and fails on lost history',async t=> {
 const store=fixture(t);const event={eventId:'synthetic-stable-id',name:'print.completed',timestamp:new Date().toISOString(),data:{printer:'default',jobId:'synthetic-job'},cursor:'9'};
 const page={events:[event],cursor:'9',truncated:false};const source={list:async()=>({content:[{type:'text',text:JSON.stringify(page)}]})};
 await relayOnce(source,store);await relayOnce(source,store);assert.equal(store.data.history.length,1);assert.equal(store.data.history[0].eventId,event.eventId);assert.equal(store.data.sourceCursor,'9');
 page.truncated=true;await assert.rejects(relayOnce(source,store),/truncated/);assert.equal(store.data.sourceCursor,'9');
});

test('OAuth resource discovery and 401 advertise the actual configured authorization server',async t=> {
 const store=fixture(t);const oauthMetadata={issuer:'https://identity.example.com',authorization_endpoint:'https://identity.example.com/authorize',token_endpoint:'https://identity.example.com/token',response_types_supported:['code']};
 const host=createPrintEventHost({store,authenticate,authorize:()=>true,oauthMetadata,resourceServerUrl:'https://printer.example.com/mcp'});t.after(()=>host.close());
 const response=await host.fetch(new Request('http://127.0.0.1/.well-known/oauth-protected-resource/mcp',{headers:{host:'127.0.0.1'}}));
 assert.equal(response.status,200);const metadata=await response.json();assert.equal(metadata.resource,'https://printer.example.com/mcp');assert.deepEqual(metadata.authorization_servers,['https://identity.example.com']);
 const denied=await host.fetch(request('events/list',{},null));assert.equal(denied.status,401);
 assert.match(denied.headers.get('www-authenticate'),/resource_metadata="https:\/\/printer.example.com\/\.well-known\/oauth-protected-resource\/mcp"/);
});

test('monitoring errors cannot prevent durable delivery and status refresh can be throttled independently',async()=> {
 const { monitorIteration }=await import('./worker.mjs');let deliveries=0,statusReads=0;const messages=[];
 const source={readStatus:async()=>{statusReads++;throw Error('printer offline');}};
 const relay=async()=>{throw Error('history gap');},service={deliverPending:async()=>{deliveries++;}};
 await monitorIteration({source,store:{},service,relay,log:message=>messages.push(message)});
 await monitorIteration({source,store:{},service,relay,refreshStatus:false,log:message=>messages.push(message)});
 assert.equal(statusReads,1);assert.equal(deliveries,2);assert.equal(messages.length,3);
});
test('real legacy child clean shutdown removes its event lock and recording works on restart',async t=> {
 const { createLegacySource }=await import('./relay.mjs');const {existsSync}=await import('node:fs');
 const dir=mkdtempSync(join(tmpdir(),'events-child-restart-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const journal=join(dir,'child-journal'),root=new URL('..',import.meta.url).pathname;
 const env={...process.env,TEMP_DIR:join(dir,'temp'),PRINTER_TYPE:'bambu',PRINTER_HOST:'dummy.invalid',BAMBU_PRINTER_HOST:'dummy.invalid',BAMBU_HOST:'dummy.invalid',BAMBU_SERIAL:'dummy-serial',BAMBU_PRINTER_SERIAL:'dummy-serial',BAMBU_TOKEN:'dummy-token'};
 for(let restart=0;restart<2;restart++) {
  const source=await createLegacySource({entry:join(root,'dist/index.js'),cwd:root,journal,env});
  try {assert.equal((await source.list('0')).isError,undefined);assert.ok(existsSync(`${journal}.lock`));}
  finally {await source.close();}
  assert.equal(existsSync(`${journal}.lock`),false);
 }
});

test('application-policy OAuth declares no invented custom scopes',async t=> {
 const store=fixture(t),oauthMetadata={issuer:'https://printer.example.com',authorization_endpoint:'https://printer.example.com/authorize',token_endpoint:'https://printer.example.com/token',response_types_supported:['code']};
 const host=createPrintEventHost({store,authenticate,authorize:()=>true,oauthMetadata,resourceServerUrl:'https://printer.example.com/mcp',scopesSupported:[]});t.after(()=>host.close());
 const denied=await host.fetch(request('tools/list',{},null));assert.ok(!denied.headers.get('www-authenticate').includes('scope='));
 const tools=await (await host.fetch(request('tools/list'))).json();for(const tool of tools.result.tools)assert.deepEqual(tool.securitySchemes,[{type:'oauth2',scopes:[]}]);
});
test('farm host restricts discovery, history, status, subscriptions and delivery to each owner printer',async t=>{
 const store=fixture(t),received=[];
 for(const printer of ['farm-a','farm-b']){const d=new PrintEventDetector(store,printer);d.observe({command:'push_status',gcode_state:'RUNNING',task_id:'same-private-id',print_error:0,hms:[]});d.observe({command:'push_status',gcode_state:'FINISH'});}
 const host=createPrintEventHost({store,printers:['farm-a','farm-b'],authenticate,authorize:(_context,printer)=>printer==='farm-a',sender:async(_url,body)=>{const data=JSON.parse(body);if(data.type==='verification')return {status:200,body:JSON.stringify({challenge:data.challenge})};received.push(data);return {status:204,body:''};}});t.after(()=>host.close());
 const catalog=await (await host.fetch(request('events/list'))).json();assert.deepEqual(catalog.result.events[0].inputSchema.properties.printer.enum,['farm-a']);
 const tools=await (await host.fetch(request('tools/list'))).json();assert.deepEqual(tools.result.tools[0].inputSchema.properties.printer.enum,['farm-a']);
 const history=await (await host.fetch(request('tools/call',{name:'list_print_events',arguments:{printer:'farm-a'}}))).json();const page=JSON.parse(history.result.content[0].text);assert.equal(page.events.length,1);assert.equal(page.events[0].data.printer,'farm-a');
 const denied=await (await host.fetch(request('tools/call',{name:'list_print_events',arguments:{printer:'farm-b'}}))).json();assert.equal(denied.error.code,-32012);
 const blocked=await (await host.fetch(request('events/subscribe',{...subscribe,arguments:{printer:'farm-b'}}))).json();assert.equal(blocked.error.code,-32012);
 await host.fetch(request('events/subscribe',{...subscribe,arguments:{printer:'farm-a'}}));await host.service.deliverPending();assert.equal(received.length,1);assert.equal(received[0].data.printer,'farm-a');
});

test('host enforces actual granted scopes rather than replacing them with advertised scopes',async t=> {
 const store=fixture(t),host=createPrintEventHost({store,authenticate:async()=>({principal:'operator',scopes:[]}),authorize:()=>true});t.after(()=>host.close());assert.equal((await host.fetch(request('server/discover'))).status,403);
 const optional=createPrintEventHost({store,authenticate,authorize:()=>true,scopesSupported:['printer:read','printer:optional'],requiredScopes:['printer:read']});t.after(()=>optional.close());assert.equal((await optional.fetch(request('server/discover'))).status,200);const tools=await (await optional.fetch(request('tools/list'))).json();assert.deepEqual(tools.result.tools[0].securitySchemes,[{type:'oauth2',scopes:['printer:read']}]);
});
test('relay refuses replaced source journals and malformed private event data without advancing watermarks',async t=> {
 const store=fixture(t),page={journalId:'journal-a',events:[],cursor:'1',truncated:false},source={list:async()=>({content:[{type:'text',text:JSON.stringify(page)}]})};
 await relayOnce(source,store);page.journalId='journal-b';await assert.rejects(relayOnce(source,store),/identity changed/);assert.equal(store.data.sourceCursor,'1');delete page.journalId;await assert.rejects(relayOnce(source,store),/identity missing/);
 page.journalId='journal-a';page.cursor='2';page.events=[{eventId:'private-invalid',name:'print.problem',timestamp:new Date().toISOString(),data:{printer:'default',jobId:'opaque',reason:'failed',codes:[{secret:'private'}]},cursor:'2'}];await assert.rejects(relayOnce(source,store),/alias mismatch/);assert.equal(store.data.sourceCursor,'1');assert.equal(store.data.history.length,0);
});
