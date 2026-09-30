import {randomUUID} from 'node:crypto';
import {isAbsolute,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {EventStore} from '../dist/events/store.js';
export function injectTestCompletion(filename,printer) {
 if(!isAbsolute(filename)||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(printer))throw new Error('Use an absolute host journal and configured printer alias');
 const store=new EventStore(filename);
 try {const event=store.append({eventId:randomUUID(),name:'print.completed',timestamp:new Date().toISOString(),data:{printer,jobId:`test_${randomUUID()}`,test:true}});store.save();return {label:'TEST printer notification; no physical print',eventId:event.eventId,printer};}finally{store.close();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const [filename,printer]=process.argv.slice(2);if(!filename||!printer)throw new Error('Usage: node scripts/inject-test-print-event.mjs ABSOLUTE_HOST_JOURNAL PRINTER_ALIAS (stop the single-writer host first)');
 console.log(JSON.stringify(injectTestCompletion(filename,printer)));
}
