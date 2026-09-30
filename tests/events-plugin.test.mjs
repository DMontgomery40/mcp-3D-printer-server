import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {preparePlugin} from '../scripts/prepare-events-plugin.mjs';
import {injectTestCompletion} from '../scripts/inject-test-print-event.mjs';
import {EventStore} from '../dist/events/store.js';
test('portable plugin packaging uses explicit approved endpoint without registration or overwrite',t=>{
 const root=mkdtempSync(join(tmpdir(),'printer-plugin-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const dir=join(root,'plugin');
 for(const url of ['http://farm.example/mcp','https://secret@farm.example/mcp','https://farm.example/mcp?secret=x'])assert.throws(()=>preparePlugin(url,dir),/approved/);
 const result=preparePlugin('https://farm.example/mcp',dir);assert.ok(result.name);assert.deepEqual(JSON.parse(readFileSync(join(dir,'mcp.json'),'utf8')).mcpServers['printer-events'],{type:'streamable-http',url:'https://farm.example/mcp'});assert.throws(()=>preparePlugin('https://farm.example/mcp',dir),/already exists/);
});
test('test completion is labeled synthetic, preserves subscriptions and respects active journal lock',t=>{
 const root=mkdtempSync(join(tmpdir(),'test-event-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const file=join(root,'journal');let store=new EventStore(file);store.save();assert.throws(()=>injectTestCompletion(file,'farm-a'),/EEXIST/);store.close();
 const result=injectTestCompletion(file,'farm-a');assert.match(result.label,/TEST/);store=new EventStore(file);assert.equal(store.data.history[0].data.test,true);assert.match(store.data.history[0].data.jobId,/^test_/);store.close();
});
