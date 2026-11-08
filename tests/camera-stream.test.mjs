import {trackedMkdtemp} from './support/temp.mjs';
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import axios from 'axios';
const sharp = await cameraNativeAvailable() ? (await import('sharp')).default : undefined;
const test = (name, run) => nodeTest(name, {skip: !sharp && 'Optional native streaming requires Node 20.9+'}, run);
import {randomBytes} from 'node:crypto';
import {CameraStreams, cameraNativeAvailable} from '../dist/counterpart/camera-stream.js';
import {CounterpartService} from '../dist/counterpart/service.js';
import {OctoPrintImplementation} from '../dist/printers/octoprint.js';
import {KlipperImplementation} from '../dist/printers/klipper.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from './support/stdio.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let n = 0; n < 200; n++) { if (await check()) return; await pause(10); } assert.fail('timed out'); }
const picture = value => sharp({create: {width: 640, height: 360, channels: 3, background: {r: value, g: value, b: value}}}).jpeg().toBuffer();
async function endpoint(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return {port: String(server.address().port), url: `http://127.0.0.1:${server.address().port}`};
}
function service(type) {
  const http = axios.create({timeout: 300});
  const implementation = type === 'klipper' ? new KlipperImplementation(http) : new OctoPrintImplementation(http);
  return new CounterpartService(() => implementation, http, {name: 'test', version: '1'});
}
const target = (port, type = 'octoprint') => ({host: '127.0.0.1', port, type, apiKey: 'API_SECRET'});

async function mcp(t, env, withoutNative = false) {
  const directory = await trackedMkdtemp(path.join(os.tmpdir(), 'generic-camera-mcp-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const args = [];
  if (withoutNative) {
    const loader = path.join(directory, 'no-native.mjs');
    await fs.writeFile(loader, 'export async function resolve(name, context, next) { if (name === "sharp") throw Error("unsupported native runtime"); return next(name, context); }');
    args.push('--experimental-loader', loader);
  }
  args.push(fileURLToPath(new URL('../dist/index.js', import.meta.url)));
  const client = new Client({name: 'generic-camera-test', version: '1'});
  await client.connect(new StdioClientTransport({command: process.execPath, args, cwd: directory,
    env: {PATH: process.env.PATH, HOME: directory, TEMP_DIR: directory, MCP_TRANSPORT: 'stdio', PRINTER_TYPE: 'octoprint', PRINTER_HOST: '127.0.0.1', API_KEY: 'API_SECRET', ...env}, stderr: 'pipe'}));
  t.after(() => client.close());
  await client.listTools();
  return client;
}

test('MCP validates stream limits and sends the bounded JPEG only once', async t => {
  const jpeg = await picture(80);
  const api = await endpoint(t, (req, res) => {
    if (req.url === '/still') { res.writeHead(200, {'Content-Type': 'image/jpeg'}); return res.end(jpeg); }
    res.end(JSON.stringify({webcam: {snapshotUrl: `http://127.0.0.1:${api.port}/still`}}));
  });
  const client = await mcp(t, {PRINTER_PORT: api.port});
  const call = (name, args = {}) => client.callTool({name, arguments: args});
  for (const name of ['camera_stream_start', 'camera_frame', 'camera_stream_stop']) {
    assert.ok((await client.listTools()).tools.some(tool => tool.name === name && tool.outputSchema));
  }
  for (const max_bytes of [0, 4095, 5000001, 42000.5]) assert.equal((await call('camera_frame', {max_bytes})).isError, true);
  assert.equal((await call('camera_stream_start', {fps: 5})).isError, true);
  assert.equal((await call('camera_frame')).structuredContent.status, 'stopped');
  assert.equal((await call('camera_stream_start')).structuredContent.status, 'started');
  const result = await call('camera_frame', {wait_ms: 2000, max_bytes: 42000});
  assert.equal(result.structuredContent.status, 'frame');
  assert.equal(JSON.stringify(result).split(result.structuredContent.base64).length - 1, 1);
  assert.equal((await call('camera_stream_stop')).structuredContent.status, 'stopped');
});

test('missing optional native runtime disables stream capability without breaking snapshots', async t => {
  const jpeg = await picture(60);
  const api = await endpoint(t, (req, res) => {
    if (req.url === '/still') { res.writeHead(200, {'Content-Type': 'image/jpeg'}); return res.end(jpeg); }
    res.end(JSON.stringify({webcam: {snapshotUrl: `http://127.0.0.1:${api.port}/still`}}));
  });
  const client = await mcp(t, {PRINTER_PORT: api.port}, true);
  const info = await client.callTool({name: 'counterpart_printer_info', arguments: {}});
  assert.equal(info.structuredContent.capabilities.camera, 'http-snapshot');
  assert.equal(info.structuredContent.capabilities.cameraStream, false);
  assert.deepEqual((await client.callTool({name: 'camera_stream_start', arguments: {}})).structuredContent, {status: 'not-supported', reason: 'runtime'});
  const snapshot = await client.callTool({name: 'camera_snapshot', arguments: {}});
  assert.equal(snapshot.structuredContent.base64, jpeg.toString('base64'));
});

test('OctoPrint shares one MJPEG response and snapshots reuse it, then stop closes it', async t => {
  let opened = 0, active = 0, snapshots = 0, current = await picture(20);
  const camera = await endpoint(t, (req, res) => {
    assert.equal(req.headers['x-api-key'], undefined, 'printer API key never reaches another origin');
    if (req.url === '/snapshot') { snapshots++; res.writeHead(200, {'Content-Type': 'image/jpeg'}); return res.end(current); }
    opened++; active++;
    res.writeHead(200, {'Content-Type': 'multipart/x-mixed-replace; boundary=frame'});
    const send = () => res.write(Buffer.concat([Buffer.from('--frame\r\nContent-Type: image/jpeg\r\n\r\n'), current, Buffer.from('\r\n')]));
    send(); const timer = setInterval(send, 30);
    req.on('close', () => { clearInterval(timer); active--; });
  });
  const api = await endpoint(t, (_req, res) => res.end(JSON.stringify({plugins: {classicwebcam: {stream: `${camera.url}/stream`, snapshot: `${camera.url}/snapshot`}}})));
  const s = service('octoprint'), printer = target(api.port); t.after(() => s.close());
  const starts = await Promise.all([s.cameraStreamStart(printer, {fps: 2}), s.cameraStreamStart(printer, {fps: 2})]);
  assert.deepEqual(starts.map(result => result.status).sort(), ['running', 'started']);
  const first = await s.cameraStreamFrame(printer, {waitMs: 2000, maxWidth: 300});
  assert.equal(first.status, 'frame'); assert.equal(first.width, 300); assert.equal(opened, 1);
  assert.equal((await s.cameraSnapshot(printer)).base64, current.toString('base64')); assert.equal(snapshots, 0);
  await pause(550);
  const same = await s.cameraStreamFrame(printer, {sinceSeq: first.seq, waitMs: 30});
  assert.equal(same.status, 'unchanged'); assert.equal(same.seq, first.seq);
  current = await picture(200);
  assert.equal((await s.cameraStreamFrame(printer, {sinceSeq: first.seq, waitMs: 1500})).status, 'frame');
  s.cameraStreamStop(printer); await until(() => active === 0);
  assert.equal((await s.cameraStreamFrame(printer)).status, 'stopped');
});

test('Moonraker uses enabled snapshot fallback with no overlapping fetches, and stop aborts requests', async t => {
  const jpeg = await picture(70); let reads = 0, active = 0, peak = 0;
  const api = await endpoint(t, (req, res) => {
    if (req.url === '/server/webcams/list') return res.end(JSON.stringify({result: {webcams: [{enabled: false, stream_url: '/never'}, {enabled: true, snapshot_url: `http://127.0.0.1:${api.port}/still`} ]}}));
    assert.equal(req.url, '/still'); assert.equal(req.headers['x-api-key'], 'API_SECRET');
    reads++; active++; peak = Math.max(peak, active);
    const timer = setTimeout(() => { res.writeHead(200, {'Content-Type': 'image/jpeg'}); res.end(jpeg); }, 75);
    req.on('close', () => { clearTimeout(timer); active--; });
  });
  const s = service('klipper'), printer = target(api.port, 'klipper'); t.after(() => s.close());
  await s.cameraStreamStart(printer, {fps: 2});
  assert.equal((await s.cameraStreamFrame(printer, {waitMs: 2000})).status, 'frame');
  await until(() => reads >= 2);
  s.cameraStreamStop(printer); await until(() => active === 0);
  const stoppedAt = reads; await pause(600); assert.equal(reads, stoppedAt); assert.equal(peak, 1);
});

test('camera discovery and source reads do not follow authenticated redirects or retry rejected credentials', async t => {
  let leaked = 0, attempts = 0, snapshots = 0;
  const outside = await endpoint(t, (_req, res) => { leaked++; res.end(); });
  const api = await endpoint(t, (req, res) => {
    if (req.url === '/api/settings') return res.end(JSON.stringify({webcam: {streamUrl: `http://127.0.0.1:${api.port}/stream`, snapshotUrl: '/still'}}));
    if (req.url === '/still') { snapshots++; return res.end(); }
    attempts++; res.writeHead(401, {'Location': outside.url}); res.end();
  });
  const s = service('octoprint'), printer = target(api.port); t.after(() => s.close());
  await s.cameraStreamStart(printer);
  const frame = await s.cameraStreamFrame(printer, {waitMs: 2000});
  assert.equal(frame.status, 'unavailable'); assert.equal(frame.reason, 'auth'); assert.equal(attempts, 1); assert.equal(leaked, 0); assert.equal(snapshots, 0);
});

test('an authenticated redirect never reaches the redirected camera origin', async t => {
  let leaked = 0;
  const outside = await endpoint(t, (_req, res) => { leaked++; res.end(); });
  const api = await endpoint(t, (req, res) => {
    if (req.url === '/api/settings') return res.end(JSON.stringify({webcam: {streamUrl: `http://127.0.0.1:${api.port}/stream`}}));
    res.writeHead(302, {'Location': outside.url}); res.end();
  });
  const s = service('octoprint'), printer = target(api.port); t.after(() => s.close());
  await s.cameraStreamStart(printer);
  assert.equal((await s.cameraStreamFrame(printer, {waitMs: 2000})).status, 'unavailable');
  assert.equal(leaked, 0);
});

test('host overrides remain separate even when the configured Bambu serial is inherited', async t => {
  const jpeg = await picture(70);
  const api = await endpoint(t, (_req, res) => { res.writeHead(200, {'Content-Type': 'image/jpeg'}); res.end(jpeg); });
  const http = axios.create(), implementation = new OctoPrintImplementation(http);
  implementation.cameraCandidates = async () => [{url: api.url, source: 'fixture', configured: true, transport: 'http-snapshot'}];
  const s = new CounterpartService(() => implementation, http, {name: 'test', version: '1'}); t.after(() => s.close());
  const first = {...target(api.port, 'bambu'), host: '127.0.0.1', apiKey: 'SERIAL:TOKEN'};
  const second = {...first, host: 'localhost'};
  assert.equal((await s.cameraStreamStart(first)).status, 'started');
  assert.equal((await s.cameraStreamStart(second)).status, 'started');
  s.cameraStreamStop(first);
  assert.equal((await s.cameraStreamFrame(second, {waitMs: 2000})).status, 'frame');
});

test('stop during source discovery prevents a late camera connection', async t => {
  let release, entered = false, requests = 0;
  const api = await endpoint(t, (_req, res) => { requests++; res.end(); });
  const http = axios.create(), implementation = new OctoPrintImplementation(http);
  implementation.cameraCandidates = () => { entered = true; return new Promise(resolve => { release = resolve; }); };
  const s = new CounterpartService(() => implementation, http, {name: 'test', version: '1'}); t.after(() => s.close());
  const printer = target(api.port), starting = s.cameraStreamStart(printer);
  await until(() => entered); s.cameraStreamStop(printer);
  release([{url: api.url, source: 'fixture', configured: true, transport: 'http-snapshot'}]);
  await assert.rejects(starting, /cancelled/); assert.equal(requests, 0);
});

function coreFixture(t, {skipFirstFrame=false, idleTimeoutMs=10000, open}={}) {
  let now=1000, opened=0, closed=0, handlers;
  const streams=new CameraStreams(()=>now);
  t.after(()=>streams.stopAll());
  const options={transport:'http',fps:2,idleTimeoutMs,skipFirstFrame,open:open??(h=>{opened++;handlers=h;return {close(){closed++;}};})};
  const {stream}=streams.start('one',options);
  return {streams,stream,options,get opened(){return opened},get closed(){return closed},get handlers(){return handlers},
    async put(bytes, target=stream){
      const before=await target.frame({changedOnly:false});
      now+=501;handlers.onFrame(bytes);
      assert.equal((await target.frame({sinceSeq:before.seq,waitMs:2000,changedOnly:false})).status,'frame','native decode completed');
    }};
}


test('one source per printer, stable unchanged cursor beyond16 frames, resize, and restart sequence',async t=>{
  const f=coreFixture(t);
  assert.equal(f.streams.start('one',f.options).status,'running');assert.equal(f.opened,1);
  const first=await picture(10), changed=await picture(160);
  await f.put(first);
  const one=await f.stream.frame({maxWidth:300});
  assert.deepEqual([one.status,one.width,one.height],['frame',300,169]);
  for(let i=0;i<25;i++)await f.put(first);
  const same=await f.stream.frame({sinceSeq:one.seq,waitMs:5});
  assert.deepEqual([same.status,same.seq,same.base64],['unchanged',one.seq,undefined]);
  const pending=f.stream.frame({sinceSeq:one.seq,waitMs:1000});
  await f.put(changed);
  const two=await pending;assert.equal(two.status,'frame');assert.ok(two.seq>one.seq);assert.ok(two.change>.5);
  f.streams.stop('one');assert.equal(f.closed,1);assert.equal((await f.stream.frame()).status,'stopped');
  const restart=f.streams.start('one',f.options);assert.equal(restart.status,'started');
  await f.put(changed,restart.stream);assert.ok((await restart.stream.frame()).seq>two.seq);
});


test('idle closes source and wakes a blocked viewer; other printer stays open',async t=>{
  const f=coreFixture(t,{idleTimeoutMs:40});
  const other=f.streams.start('two',{...f.options,idleTimeoutMs:10000});
  const pending=f.stream.frame({waitMs:1000});
  assert.equal((await pending).status,'stopped');assert.equal(f.closed,1);assert.equal(other.stream.stopped,false);
});

test('one reconnect, no auth retry, and synchronous source failure cannot leak a handle',async t=>{
  const f=coreFixture(t);f.handlers.onError(Error('connection dropped'));assert.equal(f.opened,2);
  f.handlers.onEnd();assert.equal((await f.stream.frame()).reason,'unreachable');assert.equal(f.closed,2);
  let closed=0,opened=0;
  const auth=coreFixture(t,{open:h=>{opened++;h.onError(Error('authentication failed'));return {close(){closed++;}};}});
  assert.equal((await auth.stream.frame()).reason,'auth');assert.equal(opened,1);assert.equal(closed,1);
});

test('abort only cancels its viewer; explicit stop releases every waiter',async t=>{
  const f=coreFixture(t),controller=new AbortController();
  const waiting=f.stream.frame({waitMs:1000,signal:controller.signal});controller.abort();
  await assert.rejects(waiting,{name:'AbortError'});assert.equal(f.closed,0);
  const others=[f.stream.frame({waitMs:1000}),f.stream.frame({waitMs:1000})];f.stream.stop();
  assert.deepEqual((await Promise.all(others)).map(x=>x.status),['stopped','stopped']);assert.equal(f.closed,1);
});


test('a high-entropy frame respects the JPEG byte budget with bounded cached adaptive resizing', async t => {
  const f = coreFixture(t);
  const noisy = await sharp(randomBytes(1280 * 720 * 3), {raw: {width: 1280, height: 720, channels: 3}}).jpeg({quality: 95}).toBuffer();
  await f.put(noisy);
  const normal = await f.stream.frame({maxWidth: 1200});
  assert.ok(Buffer.from(normal.base64, 'base64').length > 42000);
  const limited = await f.stream.frame({maxWidth: 1200, maxBytes: 42000});
  assert.equal(limited.status, 'frame');
  assert.ok(Buffer.from(limited.base64, 'base64').length <= 42000);
  assert.ok(limited.width < 1200);
  assert.ok(limited.base64.length <= 56000, 'leaves 4 KB per two-second result for protocol overhead');
  assert.deepEqual(await f.stream.frame({maxWidth: 1200, maxBytes: 42000}), limited, 'repeat viewers share the cached encoding');
  const smallest = await f.stream.frame({maxBytes: 4096});
  assert.ok(Buffer.from(smallest.base64, 'base64').length <= 4096);
});


test('unsupported OctoPrint stream uses only its paired snapshot, never another camera', async t => {
  const jpeg = await picture(70); let own = 0, other = 0;
  const api = await endpoint(t, (req, res) => {
    if (req.url === '/api/settings') return res.end(JSON.stringify({plugins: {classicwebcam: {stream: '/stream', snapshot: '/still'}}, webcams: [{compat: {snapshot: '/other'}}]}));
    if (req.url === '/stream') { res.writeHead(200, {'Content-Type': 'text/html'}); return res.end('<html>WebRTC viewer</html>'); }
    if (req.url === '/still') own++; else other++;
    assert.equal(req.headers['x-api-key'], 'API_SECRET');
    res.writeHead(200, {'Content-Type': 'image/jpeg'}); res.end(jpeg);
  });
  const s = service('octoprint'), printer = target(api.port); t.after(() => s.close());
  assert.equal((await s.cameraStreamStart(printer)).transport, 'http');
  assert.equal((await s.cameraStreamFrame(printer, {waitMs: 2000})).status, 'frame');
  assert.equal(own, 1); assert.equal(other, 0);
});

test('unsupported stream without a paired snapshot never switches to a different camera', async t => {
  let other = 0;
  const api = await endpoint(t, (req, res) => {
    if (req.url === '/api/settings') return res.end(JSON.stringify({plugins: {classicwebcam: {stream: '/stream'}}, webcams: [{compat: {snapshot: '/other'}}]}));
    if (req.url !== '/stream') other++;
    res.writeHead(200, {'Content-Type': 'text/html'}); res.end('unsupported');
  });
  const s = service('octoprint'), printer = target(api.port); t.after(() => s.close());
  await s.cameraStreamStart(printer);
  assert.equal((await s.cameraStreamFrame(printer, {waitMs: 2000})).status, 'unavailable');
  assert.equal(other, 0);
});

test('Moonraker WebRTC and HLS metadata use that webcam snapshot without opening unsupported streams', async t => {
  const jpeg = await picture(80);
  for (const serviceName of ['webrtc-camerastreamer', 'hls']) {
    let unsupported = 0, own = 0;
    const api = await endpoint(t, (req, res) => {
      if (req.url === '/server/webcams/list') return res.end(JSON.stringify({result: {webcams: [{service: serviceName, stream_url: '/stream', snapshot_url: '/still'}, {snapshot_url: '/other'}]}}));
      if (req.url === '/still') own++; else unsupported++;
      res.writeHead(200, {'Content-Type': 'image/jpeg'}); res.end(jpeg);
    });
    const s = service('klipper'), printer = target(api.port, 'klipper'); t.after(() => s.close());
    await s.cameraStreamStart(printer);
    assert.equal((await s.cameraStreamFrame(printer, {waitMs: 2000})).status, 'frame');
    assert.equal(own, 1); assert.equal(unsupported, 0); s.close();
  }
});


test('a known unsupported camera without a snapshot does not advertise a different camera', async t => {
  let reads = 0;
  const api = await endpoint(t, (req, res) => {
    if (req.url === '/server/webcams/list') return res.end(JSON.stringify({result: {webcams: [{service: 'webrtc', stream_url: '/stream'}, {snapshot_url: '/other'}]}}));
    reads++; res.end();
  });
  const s = service('klipper'), printer = target(api.port, 'klipper'); t.after(() => s.close());
  await assert.rejects(s.cameraStreamStart(printer), /No camera/);
  assert.equal(reads, 0);
  assert.equal((await s.printerInfo(printer)).capabilities.cameraStream, false);
});

test('snapshot streams reject non-JPEG images instead of labeling their bytes as JPEG', async t => {
  const png = await sharp({create: {width: 100, height: 100, channels: 3, background: '#888'}}).png().toBuffer();
  const api = await endpoint(t, (req, res) => {
    if (req.url === '/api/settings') return res.end(JSON.stringify({webcam: {snapshotUrl: '/still'}}));
    res.writeHead(200, {'Content-Type': 'image/png'}); res.end(png);
  });
  const s = service('octoprint'), printer = target(api.port); t.after(() => s.close());
  await s.cameraStreamStart(printer);
  assert.equal((await s.cameraStreamFrame(printer, {waitMs: 2000})).status, 'unavailable');
});


test('unsupported HLS or RTSP URL uses only its paired snapshot', async t => {
  const jpeg = await picture(80);
  for (const stream of ['/camera.m3u8', 'rtsp://127.0.0.1/live']) {
    let own = 0, other = 0;
    const api = await endpoint(t, (req, res) => {
      if (req.url === '/api/settings') return res.end(JSON.stringify({plugins: {classicwebcam: {stream, snapshot: '/still'}}, webcams: [{compat: {snapshot: '/other'}}]}));
      if (req.url === '/still') own++; else other++;
      res.writeHead(200, {'Content-Type': 'image/jpeg'}); res.end(jpeg);
    });
    const s = service('octoprint'), printer = target(api.port); t.after(() => s.close());
    await s.cameraStreamStart(printer);
    assert.equal((await s.cameraStreamFrame(printer, {waitMs: 2000})).status, 'frame');
    assert.equal(own, 1); assert.equal(other, 0); s.close();
  }
});
