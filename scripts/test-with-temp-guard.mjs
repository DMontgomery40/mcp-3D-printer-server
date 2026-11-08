#!/usr/bin/env node
// Keep all suite steps private; join the child lifecycle before auditing fixtures.
import {spawn} from 'node:child_process';
import {mkdtemp, readdir, rm} from 'node:fs/promises';
import {tmpdir, constants} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {performance} from 'node:perf_hooks';

const args = process.argv.slice(2);
const before = args[0] === '--before' ? args.splice(0, 2)[1] : undefined;
const directory = await mkdtemp(join(tmpdir(), 'printer-test-tmp-'));
let child;
let interrupted;
const forward = signal => {
  interrupted = signal;
  if (!child?.pid) return;
  // Include test workers and MCP grandchildren when CI signals only the guard.
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
};
const interrupt = () => forward('SIGINT');
const terminate = () => forward('SIGTERM');
process.on('SIGINT', interrupt);
process.on('SIGTERM', terminate);
let code = 1;
async function run(arguments_) {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, arguments_, {
      stdio: 'inherit', detached: process.platform !== 'win32',
      env: {...process.env, TMPDIR: directory, TMP: directory, TEMP: directory},
    });
    child.once('error', reject);
    child.once('close', (value, signal) => {
      child = undefined;
      resolve(value ?? 128 + (constants.signals[signal] ?? 1));
    });
    if (interrupted) forward(interrupted);
  });
}
try {
  code = before ? await run([before]) : 0;
  if (code === 0 && !interrupted) code = await run(['--test', ...args]);
  // Teardown helpers join their processes. This short backstop covers OS scheduling
  // after group cancellation; persistent leaks still fail, with their names intact.
  const deadline = performance.now() + 250;
  let leftovers;
  do {
    leftovers = (await readdir(directory)).filter(name => name !== 'node-compile-cache');
    if (!leftovers.length || performance.now() >= deadline) break;
    await delay(25);
  } while (true);
  if (leftovers.length) {
    console.error(`temp-guard: ${leftovers.length} leftover(s) in the suite's private TMPDIR:`);
    for (const name of leftovers.sort()) console.error(`  ${name}`);
    console.error('Register cleanup immediately after allocation, or use tests/support/temp.mjs.');
    if (code === 0) code = 1;
  }
} finally {
  await rm(directory, {recursive: true, force: true});
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', terminate);
}
process.exitCode = code;
