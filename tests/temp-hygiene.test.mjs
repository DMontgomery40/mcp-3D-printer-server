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
