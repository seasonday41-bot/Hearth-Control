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

test('runtime metadata is itself a valid identity for this version', async () => {
  // build-meta.json and the checkpoint are equal only immediately after a
  // restore. A real build overwrites build-meta.json with the commit it was
  // built from, which is the point -- what ships must describe its own source,
  // not a checkpoint. So each file is required to be valid on its own terms.
  const current = JSON.parse(await fs.readFile(new URL('electron/build-meta.json', root), 'utf8'));
  assert.equal(current.version, version.currentVersion());
  assert.ok(version.BUILD_ID.test(current.buildId), `buildId '${current.buildId}'`);
  assert.ok(current.buildId.startsWith(`${current.version}-`));
  assert.match(current.commit, /^[0-9a-f]{40}$/);
  for (const field of ['platform', 'arch']) assert.equal(current[field], stable[field], field);
});

test('restoring the checkpoint writes it over the runtime metadata', async () => {
  const restore = await fs.readFile(new URL('scripts/restore-stable-build-meta.cjs', root), 'utf8');
  assert.match(restore, /const stable = readJson\(STABLE_META\)/);
  assert.match(restore, /writeJson\(BUILD_META, stable\)/, 'restore must copy the checkpoint into build metadata');
});

test('the checkpoint is generated, never hand-copied from a build', () => {
  // `set-version` necessarily runs before the commit that records it exists, so
  // the checkpoint names its parent commit and goes one behind as soon as that
  // commit is made. That is fine: this file is the developer-run checkpoint,
  // not a release artifact. What ships is electron/build-meta.json, which is
  // derived at build time from the real HEAD and is what provenance verifies.
  //
  // So the rule here is shape, not equality with whatever HEAD is right now.
  const derived = version.stableMetadataFor({ version: stable.version });
  assert.equal(derived.version, stable.version, 'the checkpoint must carry the canonical version');
  assert.ok(version.BUILD_ID.test(stable.buildId), `'${stable.buildId}' must be a generated identity`);
  assert.match(stable.commit, /^[0-9a-f]{40}$/, 'the checkpoint must name a real commit');
  assert.ok(derived.buildId.startsWith(`${stable.version}-`), 'derivation must agree on the version prefix');
});
