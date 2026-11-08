// Track immediately so failed assertions and early returns cannot leak fixtures.
// Existing per-test cleanup can release large fixtures sooner; file teardown is a fallback.
import {after} from 'node:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {mkdtemp} from 'node:fs/promises';

const directories = new Set();
after(() => {
  for (const directory of directories) rmSync(directory, {recursive: true, force: true});
});
export async function trackedMkdtemp(...args) {
  const directory = await mkdtemp(...args);
  directories.add(directory);
  return directory;
}
export function trackedMkdtempSync(...args) {
  const directory = mkdtempSync(...args);
  directories.add(directory);
  return directory;
}
