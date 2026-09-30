import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/** Local legacy child retains all printer safety code; host only forwards narrow read calls. */
export async function createLegacySource({ entry, cwd, journal, env = process.env }) {
  const transport = new StdioClientTransport({ command:process.execPath,args:[entry],cwd,
    env:{...env,MCP_TRANSPORT:'stdio',MCP_PRINT_EVENT_STORE:journal},stderr:'pipe' });
  const client = new Client({name:'printer-events-readonly-source',version:'0.0.0'});
  // Never expose raw dependency stderr (it may include printer identifiers/credentials).
  transport.stderr?.resume();
  try { await client.connect(transport); }
  catch(error) { await transport.close(); throw new Error('Printer event source failed to initialize'); }
  return {
    readStatus:()=>client.callTool({name:'get_printer_status',arguments:{}},undefined,{timeout:20000}),
    list:cursor=>client.callTool({name:'list_print_events',arguments:{cursor,limit:100}}),
    close:()=>client.close(),
  };
}
export async function relayOnce(source,store) {
  const result = await source.list(store.data.sourceCursor ?? '0');
  if(result.isError) throw new Error('Printer event source cannot read history');
  const content=result.content?.find(item=>item.type==='text');
  const page=JSON.parse(content?.text??'null');
  if(!page || !Array.isArray(page.events) || typeof page.cursor!=='string') throw new Error('Invalid printer event page');
  if(page.truncated) throw new Error('Printer event source history was truncated; operator reconciliation is required');
  for(const event of page.events) {
    if(store.data.history.some(item=>item.eventId===event.eventId)) continue;
    store.append({eventId:event.eventId,name:event.name,timestamp:event.timestamp,data:event.data});
  }
  // Commit imported events and source progress together so restart cannot skip a pending event.
  if(page.cursor!==(store.data.sourceCursor??'0')) {store.data.sourceCursor=page.cursor;store.save();}
}
