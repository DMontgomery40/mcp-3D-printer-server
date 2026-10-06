import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Client} from 'basic-ftp';
import {BambuImplementation} from '../dist/printers/bambu.js';

test('Bambu file metadata lists read-only through shared FTPS options and closes on failure',async t=>{
 const calls=[];let fail=false;
 const original={access:Client.prototype.access,list:Client.prototype.list,ensureDir:Client.prototype.ensureDir,close:Client.prototype.close};
 Client.prototype.access=async function(options){calls.push(['access',options]);};
 Client.prototype.list=async function(directory){calls.push(['list',directory]);if(fail)throw new Error('listing fixture failed');return [{name:'job.gcode'}];};
 Client.prototype.ensureDir=async()=>{throw new Error('read-only metadata must never create directories');};
 Client.prototype.close=function(){calls.push(['close']);};
 t.after(()=>Object.assign(Client.prototype,original));
 const adapter=new BambuImplementation({});
 assert.deepEqual(await adapter.getFile('127.0.0.1','990','FIXTURE:TOKEN','job.gcode'),{name:'cache/job.gcode',exists:true});
 assert.equal(calls[0][1].port,990);assert.equal(calls[0][1].secure,'implicit');assert.equal(calls[0][1].secureOptions.host,'127.0.0.1');assert.ok(calls.some(c=>c[0]==='list'&&c[1]==='/cache'));
 assert.deepEqual(await adapter.getFile('127.0.0.1','990','FIXTURE:TOKEN','/logs/missing.txt'),{name:'logs/missing.txt',exists:false});
 fail=true;await assert.rejects(adapter.getFile('127.0.0.1','990','FIXTURE:TOKEN','missing.gcode'),/listing fixture failed/);
 assert.equal(calls.filter(c=>c[0]==='close').length,3);
});
