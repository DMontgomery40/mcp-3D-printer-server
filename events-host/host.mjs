import { Server, createMcpHandler, ProtocolError, hostHeaderValidationResponse, oauthMetadataResponse, getOAuthProtectedResourceMetadataUrl, buildOAuthProtectedResourceMetadata } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { PrintEventService, listPrintEvents } from '../dist/events/service.js';

/** Real SDK2 per-request host. Auth is supplied by the operator's OAuth verifier;
 * no default identity, token issuance, listener, process, or worker is created here.
 */
export function createPrintEventHost({ store, authenticate, authorize, readStatus, sender,
  oauthMetadata, resourceServerUrl,
  allowedHostnames = ['127.0.0.1', 'localhost', '[::1]'], now = Date.now }) {
  if (typeof authenticate !== 'function' || typeof authorize !== 'function') throw new Error('An authenticated principal verifier and authorization policy are required');
  const metadataOptions = oauthMetadata && resourceServerUrl ? {
    oauthMetadata, resourceServerUrl: new URL(resourceServerUrl), scopesSupported: ['printer:read'],
  } : undefined;
  if ((oauthMetadata || resourceServerUrl) && !metadataOptions) throw new Error('OAuth metadata and resource URL must be provided together');
  if (metadataOptions) {
    if (metadataOptions.resourceServerUrl.protocol !== 'https:') throw new Error('Public resource URL requires HTTPS');
    buildOAuthProtectedResourceMetadata(metadataOptions);
  }
  const challenge = metadataOptions ? `Bearer resource_metadata="${getOAuthProtectedResourceMetadataUrl(metadataOptions.resourceServerUrl)}", scope="printer:read"` : 'Bearer';
  const service = new PrintEventService(store, authorize, sender, now);
  const handler = createMcpHandler(({ authInfo }) => {
    const principal = authInfo?.extra?.principal;
    if (typeof principal !== 'string' || !principal) throw new Error('Missing authenticated principal');
    const context = { principal };
    const server = new Server({ name: 'printer-events-host', version: '0.0.0' }, { capabilities: { tools: {}, events: {} } });
    server.setRequestHandler('tools/list', () => ({ tools: [
      { name: 'list_print_events', description: 'Read recorded print completion/problem observations.', inputSchema: {type:'object',properties:{cursor:{type:'string'},limit:{type:'integer',minimum:1,maximum:100}},additionalProperties:false}, annotations:{readOnlyHint:true,destructiveHint:false} },
      ...(readStatus ? [{name:'get_printer_status',description:'Read minimal state for the configured default printer; private identifiers are omitted.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false}}] : []),
    ] }));
    server.setRequestHandler('tools/call', async request => {
      if (!(await authorize(context, 'default'))) throw new ProtocolError(-32012, 'Forbidden');
      const args = request.params.arguments ?? {};
      if (request.params.name === 'list_print_events') {
        if (Object.keys(args).some(key=>!['cursor','limit'].includes(key))) throw new ProtocolError(-32602,'Invalid arguments');
        const result = listPrintEvents(store, args.cursor ?? '0', args.limit ?? 100);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      if (request.params.name === 'get_printer_status' && readStatus && Object.keys(args).length===0) {
        const result = await readStatus();
        if (result.isError) return {isError:true,content:[{type:'text',text:'Printer status unavailable'}]};
        let status;
        try { status=JSON.parse(result.content?.find(item=>item.type==='text')?.text); }
        catch { return {isError:true,content:[{type:'text',text:'Printer status unavailable'}]}; }
        const states=new Set(['IDLE','FINISH','PREPARE','RUNNING','PAUSE','FAILED','UNKNOWN','idle','printing','paused','error','offline','operational','complete']);
        const minimal={printer:'default',connected:status?.connected===true,status:states.has(status?.status)?status.status:states.has(status?.raw?.gcode_state)?status.raw.gcode_state:'UNKNOWN'};
        return {content:[{type:'text',text:JSON.stringify(minimal)}]};
      }
      throw new ProtocolError(-32602, 'Unsupported read-only tool');
    });
    for (const method of ['events/list','events/subscribe','events/unsubscribe']) {
      server.setRequestHandler(method, { params: z.object({}).passthrough() }, async params => {
        try { return await service.handle(method,params,context); }
        catch(error) { if (typeof error.code==='number') throw new ProtocolError(error.code,error.message,error.data); throw error; }
      });
    }
    return server;
  }, { legacy: 'reject', responseMode: 'json', maxRequestBodySize: 262144 });
  return {
    service,
    async fetch(request) {
      const hostError=hostHeaderValidationResponse(request,allowedHostnames);
      if(hostError) return hostError;
      // Browser origins are never needed by this machine-to-machine endpoint.
      if(request.headers.has('origin')) return new Response('Browser origins are forbidden',{status:403});
      const metadata = metadataOptions && oauthMetadataResponse(request, metadataOptions);
      if (metadata) return metadata;
      if (new URL(request.url).pathname !== '/mcp') return new Response('Not found', {status:404});
      let identity;
      try { identity=await authenticate(request); } catch { identity=undefined; }
      if (!identity || typeof identity.principal!=='string' || !identity.principal) {
        return new Response('Unauthorized',{status:401,headers:{'WWW-Authenticate':challenge}});
      }
      if (!(await authorize({principal:identity.principal},'default'))) return new Response('Forbidden',{
        status:403,headers:{'WWW-Authenticate':`${challenge}, error="insufficient_scope"`},
      });
      return handler.fetch(request,{authInfo:{token:'verified-upstream',clientId:identity.clientId??'verified-client',scopes:['printer:read'],extra:{principal:identity.principal}}});
    },
    close:()=>handler.close(),
  };
}
