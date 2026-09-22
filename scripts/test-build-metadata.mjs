// The stable checkpoint `npm run dev` and `npm start` restore.
//
// This used to pin one exact build ID and one release series by hand
// (`assert.equal(stable.buildId, '0.4.22-20260921152752-434b1b')`), which meant
// every release required editing this file and scripts/restore-stable-build-meta.cjs
// in step. Both now derive from the canonical version instead, so the assertions
// below describe the rule rather than one release's values.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const version = require('../scripts/release/version.cjs');

const root = new URL('../', import.meta.url);
const scripts = JSON.parse(await fs.readFile(new URL('package.json', root), 'utf8')).scripts;
const stable = JSON.parse(await fs.readFile(new URL('electron/stable-build-meta.json', root), 'utf8'));

test('stable metadata is a valid version-matched checkpoint', () => {
  assert.equal(stable.version, version.currentVersion());
  assert.ok(version.BUILD_ID.test(stable.buildId), `buildId '${stable.buildId}' must be <version>-<commit>[-dirty]`);
  assert.ok(stable.buildId.startsWith(`${stable.version}-`), 'buildId must belong to its own version');
  assert.match(stable.commit, /^[0-9a-f]{40}$/, 'the checkpoint must name the commit it describes');
});

test('dev and start restore the stable checkpoint before Electron loads metadata', () => {
  assert.match(scripts.dev, /restore-stable-build-meta\.cjs/);
  assert.match(scripts.start, /restore:stable-meta/);
  assert.match(scripts.build, /build:metadata/);
});

test('runtime metadata carries the same identity as the stable checkpoint', async () => {
  const current = JSON.parse(await fs.readFile(new URL('electron/build-meta.json', root), 'utf8'));
  // `builtAt` differs by design: the checkpoint carries the commit date, a real
  // build carries the moment it ran. What must never differ is the identity --
  // the version, the build ID and the commit the app would report.
  for (const field of ['version', 'buildId', 'commit', 'platform', 'arch']) {
    assert.equal(current[field], stable[field], field);
  }
});

test('the checkpoint is derivable, so preparing a release never hand-copies it', () => {
  const derived = version.stableMetadataFor({ version: stable.version });
  assert.equal(derived.buildId, stable.buildId);
  assert.equal(derived.commit, stable.commit);
  assert.equal(derived.version, stable.version);
});
