import assert from "node:assert/strict";
import { test } from "node:test";
import { uploadProgressReporter, UPLOAD_STAGE_META } from "../dist/upload-progress.js";
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ProgressNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

test("upload progress is bytes sent of the file's bytes, marked as the upload stage, once per whole percent", () => {
  const sent = [];
  const report = uploadProgressReporter(params => sent.push(params));
  const total = 18_362_734;
  for (let bytes = 0; bytes <= total; bytes += 65_536) report(bytes, total);
  report(total, total);
  assert.equal(sent.length, 101, "0% through 100%, each once");
  assert.deepEqual(sent.map(p => Math.floor(p.progress * 100 / p.total)), Array.from({ length: 101 }, (_, i) => i));
  assert.ok(sent.every(p => p.total === total && p._meta["counterpart/stage"] === "upload"));
  assert.deepEqual(UPLOAD_STAGE_META, { "counterpart/stage": "upload" });
  assert.equal(sent.at(-1).progress, total);
});

// The process runs the real MCP handler; only dispatch and delivery latency are mocked.
// Each case: which progress sends fail, whether dispatch throws after uploading, and what the client sees, in order.
const cases = [
  { failing: '', dispatchFails: false, events: [0, 100, 'result'] },
  { failing: '0', dispatchFails: false, events: [100, 'result'] },
  { failing: '100', dispatchFails: false, events: [0, 'result'] },
  { failing: '', dispatchFails: true, events: [0, 100, 'result'] },
  { failing: '100', dispatchFails: true, events: [0, 'result'] },
];
for (const { failing, dispatchFails, events: expected } of cases) {
  test(`print_3mf delivers queued upload progress before its result (failing sends: ${failing || 'none'}, dispatch fails: ${dispatchFails})`, async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'upload-progress-order-'));
    const file = path.join(dir, 'job.3mf');
    const zip = new JSZip();
    zip.file('3D/3dmodel.model', '<model><resources/><build/></model>');
    zip.file('Metadata/plate_1.gcode', '; fixture gcode');
    await fs.writeFile(file, await zip.generateAsync({ type: 'nodebuffer' }));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', fileURLToPath(new URL('./fixtures/upload-progress-spy.mjs', import.meta.url)), fileURLToPath(new URL('../dist/index.js', import.meta.url))],
      cwd: dir, stderr: 'pipe',
      env: { HOME: dir, MCP_TRANSPORT: 'stdio', PRINTER_TYPE: 'bambu', BAMBU_SERIAL: 'TEST', BAMBU_TOKEN: 'TEST', FAIL_UPLOAD_NOTIFICATION: failing, FAIL_UPLOAD_DISPATCH: dispatchFails ? '1' : '0' },
    });
    let stderr = '';
    transport.stderr.on('data', data => { stderr += data; });
    const client = new Client({ name: 'progress-order-test', version: '1' });
    t.after(async () => { await client.close(); await transport.close(); await fs.rm(dir, { recursive: true, force: true }); });
    const events = [];
    client.setNotificationHandler(ProgressNotificationSchema, notification => { events.push(notification.params.progress); });
    await client.connect(transport);
    const result = await client.callTool({
      name: 'print_3mf', arguments: { three_mf_path: file, bambu_model: 'p1s' }, _meta: { progressToken: 'upload-order' },
    });
    events.push('result');
    assert.deepEqual(events, expected);
    if (dispatchFails) {
      // A failed progress send never masks the dispatch error.
      assert.equal(result.isError, true, JSON.stringify(result));
      assert.match(result.content[0].text, /mock dispatch failure/);
    } else assert.equal(result.isError, undefined, JSON.stringify(result));
    if (failing) assert.match(stderr, /upload progress.*mock progress send failure/i);
  });
}
