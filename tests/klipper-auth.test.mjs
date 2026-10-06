import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import axios from 'axios';
import {KlipperImplementation} from '../dist/printers/klipper.js';

// All HTTP requests use a loopback Moonraker fixture, never a printer.
for (const key of ['fixture-api-key','']) test(`Moonraker authentication covers every request (${key ? 'authenticated' : 'anonymous'})`,async t=>{
  const requests=[];
  const server=createServer((req,res)=>{
    requests.push({url:req.url,method:req.method,headers:req.headers});
    req.resume();
    if ((req.headers['x-api-key']??'')!==key) {res.writeHead(401);res.end('unauthorized');return;}
    if(req.url.startsWith('/server/files/gcodes/')) {res.end('; filament_type = PLA\nM104 S220\n');return;}
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({result:{status:{webhooks:{state:'ready'},print_stats:{state:'standby'}},item:{path:'job.gcode'}}}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'moonraker-auth-'));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(dir,{recursive:true,force:true});});
  const source=path.join(dir,'job.gcode');await fs.writeFile(source,'; filament_type = PLA\nM104 S220\n');
  const adapter=new KlipperImplementation(axios.create());const args=['127.0.0.1',String(server.address().port),key];
  await adapter.getStatus(...args);await adapter.getFiles(...args);await adapter.getFile(...args,'nested/job.gcode');
  assert.equal((await adapter.readPrinterState(...args)).ready,true);
  const downloaded=path.join(dir,'download.gcode');await adapter.downloadRemoteFile(...args,'nested/job.gcode',downloaded);
  assert.match(await fs.readFile(downloaded,'utf8'),/M104 S220/);
  await adapter.rawUploadFile(...args,source,'job.gcode',false);
  await adapter.rawStartJob(...args,'job.gcode');await adapter.rawCancelJob(...args);await adapter.rawSetTemperature(...args,'bed',0);
  assert.equal(requests.length,9);
  assert.ok(requests.every(req=>key ? req.headers['x-api-key']===key : req.headers['x-api-key']===undefined));
  assert.match(requests.find(req=>req.url==='/server/files/upload').headers['content-type'],/multipart\/form-data; boundary=/);
});
