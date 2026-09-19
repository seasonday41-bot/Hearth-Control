import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const packageJson = JSON.parse(await fs.readFile(new URL('package.json', root), 'utf8'));
const stable = JSON.parse(await fs.readFile(new URL('electron/stable-build-meta.json', root), 'utf8'));
const scripts = JSON.parse(await fs.readFile(new URL('package.json', root), 'utf8')).scripts;

test('stable metadata is a valid version-matched checkpoint', () => {
  assert.equal(stable.version, packageJson.version);
  assert.match(stable.buildId, /^0\.4\.4-\d{14}-[0-9a-f]{6}$/);
  assert.equal(stable.buildId, '0.4.4-20260919024039-8fcf08');
});

test('dev and start restore the stable checkpoint before Electron loads metadata', () => {
  assert.match(scripts.dev, /restore-stable-build-meta\.cjs/);
  assert.match(scripts.start, /restore:stable-meta/);
  assert.match(scripts.build, /build:metadata/);
});

test('runtime metadata matches the stable checkpoint after restore', async () => {
  const current = JSON.parse(await fs.readFile(new URL('electron/build-meta.json', root), 'utf8'));
  assert.deepEqual(current, stable);
});
