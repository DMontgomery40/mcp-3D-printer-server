import {trackedMkdtemp} from './support/temp.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import JSZip from 'jszip';
async function fixture(t, readyPlate) {
 const dir=await trackedMkdtemp(join(tmpdir(),'plate-routing-')),file=join(dir,'original.3mf'),network=join(dir,'network.log');
 const zip=new JSZip();zip.file('3D/3dmodel.model','<model><resources/><build/></model>');
 if(readyPlate!==undefined)zip.file(`Metadata/plate_${readyPlate+1}.gcode`,'; fixture gcode');
 await writeFile(file,await zip.generateAsync({type:'nodebuffer'}));
 const transport=new StdioClientTransport({command:process.execPath,args:['--import',fileURLToPath(new URL('./fixtures/print-plate-spy.mjs',import.meta.url)),fileURLToPath(new URL('../dist/index.js',import.meta.url))],cwd:dir,stderr:'pipe',env:{HOME:dir,MCP_TRANSPORT:'stdio',PRINTER_TYPE:'bambu',BAMBU_SERIAL:'TEST',BAMBU_TOKEN:'TEST',INSPECTION_NETWORK_LOG:network}});
 transport.stderr.on('data',()=>{});const client=new Client({name:'plate-routing-test',version:'1'});
 t.after(async()=>{await client.close();await transport.close();await rm(dir,{recursive:true,force:true});});await client.connect(transport);
 const call=plate_index=>client.callTool({name:'print_3mf',arguments:{three_mf_path:file,bambu_model:'p1s',plate_index}});
 return{client,call,network};
}
test('public selected ready plate reaches existing dispatch unchanged and does not auto-slice',async t=>{
 const s=await fixture(t,1),tool=(await s.client.listTools()).tools.find(x=>x.name==='print_3mf');
 assert.equal(tool.inputSchema.properties.plate_index?.minimum,0);
 const r=await s.call(1);assert.equal(r.isError,undefined,JSON.stringify(r));assert.deepEqual(JSON.parse(r.content[0].text),{mock:true,plateIndex:1});await assert.rejects(access(s.network),{code:'ENOENT'});
});
test('missing selected plate auto-slices that plate, never silently uses another ready plate',async t=>{
 const s=await fixture(t,0),r=await s.call(1);assert.equal(r.isError,undefined,JSON.stringify(r));const value=JSON.parse(r.content[0].text);assert.equal(value.plateIndex,1);assert.equal(value.sliced.slicePlate,2);await assert.rejects(access(s.network),{code:'ENOENT'});
});
test('invalid selected plate rejects before slicing or dispatch',async t=>{
 const s=await fixture(t,0);for(const value of [-1,0.5,'1',null])assert.equal((await s.call(value)).isError,true,JSON.stringify(value));await assert.rejects(access(s.network),{code:'ENOENT'});
});
