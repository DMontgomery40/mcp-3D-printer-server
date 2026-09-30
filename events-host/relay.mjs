import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/** Local legacy child retains all printer safety code; host only forwards narrow read calls. */
export async function createLegacySource({ entry, cwd, journal, env = process.env, printer = 'default' }) {
  const transport = new StdioClientTransport({ command:process.execPath,args:[entry],cwd,
    env:{...env,MCP_TRANSPORT:'stdio',MCP_PRINT_EVENT_STORE:journal,MCP_PRINT_EVENT_PRINTER_ID:printer},stderr:'pipe' });
  const client = new Client({name:'printer-events-readonly-source',version:'0.0.0'});
  // Never expose raw dependency stderr (it may include printer identifiers/credentials).
  transport.stderr?.resume();
  try { await client.connect(transport); }
  catch(error) { await transport.close(); throw new Error('Printer event source failed to initialize'); }
  return {
    printer,
    readStatus:()=>client.callTool({name:'get_printer_status',arguments:{}},undefined,{timeout:20000}),
    list:cursor=>client.callTool({name:'list_print_events',arguments:{cursor,limit:100}}),
    close:()=>client.close(),
  };
}
export async function relayOnce(source,store) {
  const printer=source.printer ?? 'default';
  const cursor=printer==='default' ? store.data.sourceCursor ?? '0' : (store.data.sourceCursors && Object.hasOwn(store.data.sourceCursors,printer) ? store.data.sourceCursors[printer] : '0');
  const result = await source.list(cursor);
  if(result.isError) throw new Error('Printer event source cannot read history');
  const content=result.content?.find(item=>item.type==='text');
  const page=JSON.parse(content?.text??'null');
  if(!page || !Array.isArray(page.events) || typeof page.cursor!=='string') throw new Error('Invalid printer event page');
  if(store.data.sourceJournalIds && Object.hasOwn(store.data.sourceJournalIds,printer) && !page.journalId)throw new Error('Printer journal identity missing; operator reconciliation is required');
  if(page.journalId) {
    if(typeof page.journalId!=='string')throw new Error('Invalid printer journal identity');
    store.data.sourceJournalIds??={};
    const known=Object.hasOwn(store.data.sourceJournalIds,printer)?store.data.sourceJournalIds[printer]:undefined;
    if(known && known!==page.journalId)throw new Error('Printer journal identity changed; operator reconciliation is required');
    store.data.sourceJournalIds[printer]=page.journalId;
  }
  if(page.truncated) throw new Error('Printer event source history was truncated; operator reconciliation is required');
  if(page.events.some(event=>event?.data?.printer!==printer || !['print.completed','print.problem'].includes(event.name) || typeof event.eventId!=='string' || typeof event.timestamp!=='string' || typeof event.data.jobId!=='string' || (event.data.test!==undefined && typeof event.data.test!=='boolean') || (event.name==='print.problem' && (!['print_error','hms','failed'].includes(event.data.reason)||!Array.isArray(event.data.codes)||event.data.codes.some(code=>typeof code!=='string'))) || Object.keys(event.data).some(key=>!['printer','jobId','reason','codes','test'].includes(key))))throw new Error('Printer source alias mismatch');
  for(const event of page.events) {
    if(store.data.history.some(item=>item.eventId===event.eventId)) continue;
    store.append({eventId:event.eventId,name:event.name,timestamp:event.timestamp,data:event.data});
  }
  // Commit imported events and source progress together so restart cannot skip a pending event.
  if(page.cursor!==cursor) {
    if(printer==='default') store.data.sourceCursor=page.cursor;
    else {store.data.sourceCursors??={};store.data.sourceCursors[printer]=page.cursor;}
    store.save();
  }
}
