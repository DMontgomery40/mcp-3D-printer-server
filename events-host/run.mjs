import {createServer} from 'node:http';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve,isAbsolute} from 'node:path';
import {toNodeHandler} from '@modelcontextprotocol/node';
import {EventStore} from '../dist/events/store.js';
import {createPrintEventHost} from './host.mjs';
import {relayOnce} from './relay.mjs';
import {printerConfiguration,createPrinterSource} from './sources.mjs';
import {monitorIteration} from './worker.mjs';

const journal=process.env.MCP_EVENTS_HOST_STORE,authModule=process.env.MCP_EVENTS_AUTH_MODULE;
if(!journal||!isAbsolute(journal)||!authModule||!isAbsolute(authModule))throw new Error('Set absolute private host journal and existing auth-module paths');
const port=Number(process.env.MCP_EVENTS_HOST_PORT??3001);
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid loopback port');
const publicUrl=process.env.MCP_EVENTS_PUBLIC_URL?new URL(process.env.MCP_EVENTS_PUBLIC_URL):undefined;
if(!publicUrl||publicUrl.protocol!=='https:'||publicUrl.pathname!=='/mcp'||publicUrl.username||publicUrl.password||publicUrl.search||publicUrl.hash)throw new Error('Configure the approved HTTPS /mcp URL');
const root=fileURLToPath(new URL('..',import.meta.url)),policy=await import(pathToFileURL(authModule).href);
if(typeof policy.authenticate!=='function'||typeof policy.authorize!=='function'||!policy.oauthMetadata)throw new Error('Existing OAuth verifier, printer authorization and issuer metadata required');
// Configuration failures happen before acquiring any journal lock.
const configurations=printerConfiguration(process.env.MCP_EVENTS_PRINTERS_FILE);
const store=new EventStore(journal),controllers=new Map();
let host,server,deliveryTimer,deliveryWork,stopped=false;
async function close() {
  if(stopped)return;stopped=true;clearTimeout(deliveryTimer);
  for(const controller of controllers.values())clearTimeout(controller.timer);
  try {
    if(server?.listening)await new Promise(resolve=>server.close(resolve));
    await Promise.allSettled([deliveryWork,...[...controllers.values()].map(item=>item.work)].filter(Boolean));
  }finally {
    try {await host?.close();}finally {
      await Promise.allSettled([...controllers.values()].map(item=>item.source.close()));store.close();
    }
  }
}
async function sourceTick(controller) {
  if(stopped)return;
  const refreshStatus=Date.now()-controller.lastRead>=controller.interval;
  if(refreshStatus)controller.lastRead=Date.now();
  controller.work=monitorIteration({source:{...controller.source,readStatus:async()=>{
    const result=await controller.source.readStatus();controller.status=result;controller.sampledAt=new Date().toISOString();return result;
  }},store,service:{deliverPending:async()=>{}},refreshStatus,relay:relayOnce});
  try {await controller.work;}catch {console.error('Printer source worker failed; no cursor skipped.');}
  if(!stopped)controller.timer=setTimeout(()=>void sourceTick(controller),15000);
}
async function deliveryTick() {
  if(stopped)return;
  deliveryWork=host.service.deliverPending();
  try {await deliveryWork;}catch {console.error('Event host journal/delivery failed; stopping for operator repair.');void close();return;}
  if(!stopped)deliveryTimer=setTimeout(()=>void deliveryTick(),15000);
}
try {
  host=createPrintEventHost({store,authenticate:policy.authenticate,authorize:policy.authorize,oauthMetadata:policy.oauthMetadata,
    scopesSupported:policy.scopesSupported,requiredScopes:policy.requiredScopes,resourceServerUrl:publicUrl.href,
    printers:configurations.map(item=>item.id),namesForPrinter:printer=>configurations.find(item=>item.id===printer)?.type==='repetier'?['print.completed']:['print.completed','print.problem'],
    readStatus:async printer=>{const controller=controllers.get(printer);return controller?.status?{...controller.status,_sampledAt:controller.sampledAt}:{isError:true,content:[]};},
    allowedHostnames:['127.0.0.1','localhost','[::1]',publicUrl.hostname]});
  for(const configuration of configurations) {
    const source=await createPrinterSource({entry:resolve(root,'dist/index.js'),cwd:root,journal:`${journal}.printer-${configuration.id}`,configuration});
    controllers.set(configuration.id,{source,lastRead:0,interval:configuration.type==='bambu'?300000:15000});
    await relayOnce(source,store);
  }
  const handle=toNodeHandler(host,{maxRequestBodySize:262144});
  server=createServer((req,res)=>{void handle(req,res).catch(()=>{if(!res.headersSent)res.writeHead(500);res.end();});});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  server.on('error',()=>void close());process.once('SIGINT',()=>void close());process.once('SIGTERM',()=>void close());
  console.error('Authenticated read-only MCP2 events host listening on loopback.');
  for(const controller of controllers.values())void sourceTick(controller);void deliveryTick();
}catch {await close();throw new Error('MCP2 host startup failed; check private configuration and journals');}
