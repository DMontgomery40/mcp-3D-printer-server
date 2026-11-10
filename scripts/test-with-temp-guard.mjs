#!/usr/bin/env node
// Keep suite output private and detect leaks before removing the guard directory.
import {spawn} from 'node:child_process';
import {mkdtemp, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'printer-test-tmp-'));
let code = 1;
try {
  code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', ...process.argv.slice(2)], {
      stdio: 'inherit', env: {...process.env, TMPDIR: directory, TMP: directory, TEMP: directory},
    });
    child.once('error', reject);
    child.once('close', value => resolve(value ?? 1));
  });
  // Node itself may create this cache; fixture directories are never exempt.
  const leftovers = (await readdir(directory)).filter(name => name !== 'node-compile-cache');
  if (leftovers.length) {
    console.error(`temp-guard: ${leftovers.length} leftover(s) in the suite's private TMPDIR:`);
    for (const name of leftovers.sort()) console.error(`  ${name}`);
    console.error('Register cleanup immediately after allocation, or use tests/support/temp.mjs.');
    code = 1;
  }
} finally {
  await rm(directory, {recursive: true, force: true});
}
process.exitCode = code;
