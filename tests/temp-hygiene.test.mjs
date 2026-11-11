import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

const guard = new URL('../scripts/test-with-temp-guard.mjs', import.meta.url);
const helper = new URL('./support/temp.mjs', import.meta.url).href;
for (const mode of ['clean', 'leak', 'fail', 'tracked', 'tracked-fail']) {
  test(`temp guard: ${mode}`, t => {
    const root = mkdtempSync(join(tmpdir(), 'guard-regression-'));
    t.after(() => rmSync(root, {recursive: true, force: true}));
    const suite = join(root, 'case.test.mjs');
    // Keep the fixture outside the guarded TMPDIR.
    writeFileSync(suite, `import {test} from 'node:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
${mode.startsWith('tracked') ? `import {trackedMkdtemp, trackedMkdtempSync} from ${JSON.stringify(helper)};` : ''}
test('fixture', async () => {
${mode.startsWith('tracked') ? "await trackedMkdtemp(join(tmpdir(), 'async-')); trackedMkdtempSync(join(tmpdir(), 'sync-'));" : "const dir = mkdtempSync(join(tmpdir(), 'intentional-leak-'));"}
${mode === 'clean' || mode === 'fail' ? 'rmSync(dir, {recursive:true, force:true});' : ''}
${mode.includes('fail') ? "throw new Error('intentional failure');" : ''}
});`);
    const env = {...process.env, TMPDIR: root};
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [guard.pathname, suite], {
      env, encoding: 'utf8', timeout: 30000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, ['leak', 'fail', 'tracked-fail'].includes(mode) ? 1 : 0, result.stdout + result.stderr);
    if (mode === 'leak') assert.match(result.stderr, /temp-guard:.*leftover/s);
    else assert.doesNotMatch(result.stderr, /temp-guard:.*leftover/s);
    assert.deepEqual(readdirSync(root), ['case.test.mjs']);
  });
}

// Shutdown can exit with a snapshot operation still pending, before its finally runs.
test('exit removes an in-flight print snapshot', t => {
  const root = mkdtempSync(join(tmpdir(), 'snapshot-exit-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const source = join(root, 'source.gcode');
  writeFileSync(source, 'G1 X0 Y0\n');
  const artifact = new URL('../dist/safety/artifact.js', import.meta.url).href;
  const script = `import {withPrintSnapshot} from ${JSON.stringify(artifact)};
    await withPrintSnapshot(${JSON.stringify(source)}, async () => process.exit(0), ${JSON.stringify(root)});`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {encoding:'utf8', timeout:30000});
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(root), ['source.gcode']);
});

// Simulate the SDK returning immediately after signalling; close must still join the child.
test('stdio teardown waits for actual process close, including repeated closes', async t => {
  const {StdioClientTransport} = await import('./support/stdio.mjs');
  const {StdioClientTransport: SDKTransport} = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({command: process.execPath, args: ['-e', `
    process.stdin.resume();
    process.on('SIGTERM', () => setTimeout(() => process.exit(0), 80));
    console.log(JSON.stringify({jsonrpc:'2.0',method:'ready',params:{tmp:require('node:os').tmpdir()}}));
  `], stderr: 'pipe'});
  const ready = new Promise(resolve => { transport.onmessage = resolve; });
  t.after(() => transport.close());
  await transport.start();
  const notification = await ready;
  assert.equal(notification.params.tmp, tmpdir(), 'minimal-env servers must stay inside guarded TMPDIR');
  const pid = transport.pid;
  t.mock.method(SDKTransport.prototype, 'close', async function () { process.kill(pid, 'SIGTERM'); });
  const first = transport.close();
  const second = transport.close();
  assert.equal(first, second);
  await Promise.all([first, second]);
  assert.throws(() => process.kill(pid, 0), {code:'ESRCH'});
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`temp guard forwards ${signal}, joins its child and removes TMPDIR`, {
    skip: process.platform === 'win32' && 'POSIX process-group signals', timeout: 15000,
  }, async t => {
    const {spawn} = await import('node:child_process');
    const {once} = await import('node:events');
    const root = mkdtempSync(join(tmpdir(), 'guard-signal-'));
    t.after(() => rmSync(root, {recursive:true, force:true}));
    const fixture = join(root, 'before.mjs');
    writeFileSync(fixture, `import {spawn} from 'node:child_process';
      import {once} from 'node:events';
      import {mkdtempSync, rmSync} from 'node:fs';
      import {tmpdir} from 'node:os';
      import {join} from 'node:path';
      const dir = mkdtempSync(join(tmpdir(), 'signal-fixture-'));
      const nested = spawn(process.execPath, ['-e', "process.on('SIGINT',()=>process.exit(0)); process.on('SIGTERM',()=>process.exit(0)); setInterval(()=>{},1000); console.log('ready')"], {stdio:['ignore','pipe','inherit']});
      const nestedClosed = once(nested, 'close');
      const stop = async () => { await nestedClosed; rmSync(dir,{recursive:true,force:true}); process.exit(23); };
      process.on('SIGINT',stop); process.on('SIGTERM',stop);
      await once(nested.stdout, 'data');
      console.log(JSON.stringify({pid:process.pid,nested:nested.pid,tmp:tmpdir()}));
      setInterval(()=>{},1000);`);
    const env = {...process.env, TMPDIR:root};
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [guard.pathname, '--before', fixture], {env, stdio:['ignore','pipe','pipe']});
    const closed = once(child, 'close');
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await closed;
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const ready = await new Promise((resolve, reject) => {
      let output = '';
      child.stdout.on('data', chunk => {
        output += chunk;
        if (output.includes('\n')) resolve(JSON.parse(output.split('\n')[0]));
      });
      child.once('error', reject);
      child.once('close', () => reject(new Error(`guard exited before ready: ${stderr}`)));
    });
    child.kill(signal);
    const [code] = await closed;
    assert.equal(code, 23, stderr);
    assert.doesNotMatch(stderr, /temp-guard:.*leftover/s);
    for (const pid of [ready.pid, ready.nested]) assert.throws(() => process.kill(pid,0), {code:'ESRCH'});
    assert.deepEqual(readdirSync(root), ['before.mjs']);
  });
}

test('temp guard checks the standalone pre-test script for leaks too', t => {
  const root = mkdtempSync(join(tmpdir(), 'guard-before-'));
  t.after(() => rmSync(root, {recursive:true, force:true}));
  const fixture = join(root, 'leak.mjs');
  const suite = join(root, 'empty.test.mjs');
  writeFileSync(fixture, "import {mkdtempSync} from 'node:fs'; import {tmpdir} from 'node:os'; import {join} from 'node:path'; mkdtempSync(join(tmpdir(),'before-leak-'));");
  writeFileSync(suite, "import {test} from 'node:test'; test('ok',()=>{});");
  const env = {...process.env, TMPDIR:root};
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [guard.pathname, '--before', fixture, suite], {env, encoding:'utf8', timeout:30000});
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /temp-guard:.*before-leak-/s);
  assert.deepEqual(readdirSync(root).sort(), ['empty.test.mjs', 'leak.mjs']);
});
