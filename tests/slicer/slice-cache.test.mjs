import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { sliceCacheKey } from '../../dist/slicer/slice-cache.js';
import { trackedMkdtemp } from '../support/temp.mjs';

process.env.SLICE_CACHE = 'on';
const CACHE_KEY = /^[0-9a-f]{64}$/;

test('changing a model with a semicolon in its filename changes the slice cache key', async () => {
  const directory = await trackedMkdtemp(path.join(os.tmpdir(), 'slice-cache-'));
  const model = path.join(directory, 'prototype;rev2.stl');
  const run = { command: process.execPath, args: [model], outputs: [] };

  await writeFile(model, 'solid first\nendsolid first\n');
  const first = await sliceCacheKey(run);
  assert.match(first, CACHE_KEY);
  assert.equal(await sliceCacheKey(run), first);

  await writeFile(model, 'solid other\nendsolid other\n');
  const changed = await sliceCacheKey(run);
  assert.match(changed, CACHE_KEY);
  assert.notEqual(changed, first);
});

for (const option of ['--load-settings', '--load-filaments']) {
  test(`changing a profile in ${option} changes the slice cache key`, async () => {
    const directory = await trackedMkdtemp(path.join(os.tmpdir(), 'slice-cache-'));
    const firstProfile = path.join(directory, 'first.json');
    const secondProfile = path.join(directory, 'second.json');
    const run = { command: process.execPath, args: [option, `${firstProfile};${secondProfile}`], outputs: [] };

    await writeFile(firstProfile, '{}');
    await writeFile(secondProfile, '{"version":1}');
    const first = await sliceCacheKey(run);
    assert.match(first, CACHE_KEY);

    const reordered = await sliceCacheKey({ ...run, args: [option, `${secondProfile};${firstProfile}`] });
    assert.match(reordered, CACHE_KEY);
    assert.notEqual(reordered, first);

    await writeFile(secondProfile, '{"version":2}');
    const changed = await sliceCacheKey(run);
    assert.match(changed, CACHE_KEY);
    assert.notEqual(changed, first);
  });
}
