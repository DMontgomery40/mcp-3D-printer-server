import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, isAbsolute } from 'node:path';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { EventStore } from '../dist/events/store.js';
import { createPrintEventHost } from './host.mjs';
import { createLegacySource, relayOnce } from './relay.mjs';
import { monitorIteration } from './worker.mjs';

// Explicit operator invocation only. No credential issuance or public binding.
const journal=process.env.MCP_EVENTS_HOST_STORE;
const authModule=process.env.MCP_EVENTS_AUTH_MODULE;
if(!journal || !isAbsolute(journal) || !authModule || !isAbsolute(authModule)) throw new Error('Set absolute MCP_EVENTS_HOST_STORE and MCP_EVENTS_AUTH_MODULE paths; no auth or journal is provisioned automatically');
const port=Number(process.env.MCP_EVENTS_HOST_PORT??3001);
if(!Number.isInteger(port)||port<1024||port>65535) throw new Error('Invalid loopback MCP_EVENTS_HOST_PORT');
const publicUrl=process.env.MCP_EVENTS_PUBLIC_URL ? new URL(process.env.MCP_EVENTS_PUBLIC_URL) : undefined;
if(!publicUrl || publicUrl.protocol!=='https:' || publicUrl.pathname!=='/mcp' || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash) throw new Error('Configure the approved public HTTPS /mcp URL');
const root=fileURLToPath(new URL('..',import.meta.url));
const policy=await import(pathToFileURL(authModule).href);
if(typeof policy.authenticate!=='function'||typeof policy.authorize!=='function'||!policy.oauthMetadata) throw new Error('Auth module must export authenticate(request), authorize({principal},printer), and existing-provider oauthMetadata');
const store=new EventStore(journal);
let source,host,server,timer,inflight,stopped=false,lastStatusRead=0;
async function close() {
  if(stopped)return;stopped=true;clearTimeout(timer);
  if(server?.listening) await new Promise(resolve=>server.close(resolve));
  // Let an in-flight status/relay/delivery commit settle before closing its journal.
  await inflight;
  await host?.close();await source?.close();store.close();
}
async function tick() {
  if(stopped)return;
  inflight=(async()=> {
    // MQTT is passive between infrequent connection/status refreshes, even during a print.
    const refreshStatus=Date.now()-lastStatusRead>=300000;
    if(refreshStatus)lastStatusRead=Date.now();
    await monitorIteration({source,store,service:host.service,refreshStatus,relay:relayOnce});
  })();
  await inflight;
  if(!stopped)timer=setTimeout(tick,15000);
}
try {
  // Construct real SDK2 and validate OAuth metadata before opening a printer child.
  host=createPrintEventHost({store,authenticate:policy.authenticate,authorize:policy.authorize,oauthMetadata:policy.oauthMetadata,
    resourceServerUrl:publicUrl.href,readStatus:()=>source.readStatus(),allowedHostnames:['127.0.0.1','localhost','[::1]',publicUrl.hostname]});
  source=await createLegacySource({entry:resolve(root,'dist/index.js'),cwd:root,journal:`${journal}.printer`});
  await relayOnce(source,store); // Disabled/locked source capture must fail startup visibly.
  const handle=toNodeHandler(host,{maxRequestBodySize:262144});
  server=createServer((req,res)=> { void handle(req,res).catch(()=> { if(!res.headersSent)res.writeHead(500);res.end(); }); });
  await new Promise((resolve,reject)=> { server.once('error',reject);server.listen(port,'127.0.0.1',resolve); });
  server.on('error',()=>void close());
  process.once('SIGINT',()=>void close());process.once('SIGTERM',()=>void close());
  console.error('Authenticated read-only MCP2 events host is listening on loopback.');void tick();
} catch {await close();throw new Error('MCP2 events host failed to start; check provisioning and private journals');}
