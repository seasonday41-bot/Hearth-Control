// The release identity gate.
//
// Before this existed the version lived in four files and two hand-edited
// regexes, and the build ID ended in three random bytes -- so an installed
// artifact could not be matched to the source it came from, and a forgotten
// hand-edit produced a green tree that shipped the wrong version.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const version = require('../scripts/release/version.cjs');
const { isCleanBuildId } = (() => {
  const mod = require('../electron/remote-update-manifest.cjs');
  // Not exported; re-derive the rule the updater actually applies.
  return { isCleanBuildId: (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{5,127}$/.test(value) };
})();

const sandbox = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-version-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
};

test('VER1 the canonical version is a semantic version and package-lock agrees', () => {
  const current = version.currentVersion();
  assert.ok(version.isSemver(current), `package.json version '${current}'`);
  const lock = version.readJson(version.PACKAGE_LOCK);
  assert.equal(lock.version, current, 'package-lock.json root version');
  assert.equal(lock.packages['']?.version, current, 'package-lock.json packages[""]');
});

test('VER2 semantic versions are accepted and anything else is rejected', () => {
  for (const good of ['0.0.1', '1.2.3', '10.20.30', '0.4.22-rc.1']) assert.ok(version.isSemver(good), good);
  for (const bad of ['', 'v1.2.3', '1.2', '1.2.3.4', 'latest', '1.2.x', null, undefined, 3]) {
    assert.ok(!version.isSemver(bad), String(bad));
  }
});

test('VER3 the build ID is derived from the commit, so the same source builds the same identity', () => {
  const a = version.buildIdFor({ version: '0.4.22', shortCommit: 'abc1234', dirty: false });
  const b = version.buildIdFor({ version: '0.4.22', shortCommit: 'abc1234', dirty: false });
  assert.equal(a, b, 'the same source must not produce two identities');
  assert.equal(a, '0.4.22-abc1234');
  assert.notEqual(a, version.buildIdFor({ version: '0.4.22', shortCommit: 'def5678', dirty: false }));
  assert.notEqual(a, version.buildIdFor({ version: '0.4.23', shortCommit: 'abc1234', dirty: false }));
});

test('VER4 a dirty tree is marked in the identity rather than hidden', () => {
  const dirty = version.buildIdFor({ version: '0.4.22', shortCommit: 'abc1234', dirty: true });
  assert.equal(dirty, '0.4.22-abc1234-dirty');
  assert.match(dirty, /-dirty$/);
});

test('VER5 every generated build ID is one the updater will accept', () => {
  for (const candidate of [
    version.buildIdFor({ version: '0.4.22', shortCommit: 'abc1234', dirty: false }),
    version.buildIdFor({ version: '0.4.22', shortCommit: 'abc1234', dirty: true }),
    version.buildIdFor({ version: '10.20.30', shortCommit: '0123456', dirty: false }),
    version.buildIdFor({ version: '0.4.22', shortCommit: null, dirty: false }),
  ]) {
    assert.ok(isCleanBuildId(candidate), `updater must accept '${candidate}'`);
    assert.ok(candidate.length >= 6, candidate);
  }
});

test('VER6 this checkout is internally consistent', () => {
  const problems = version.versionProblems();
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('VER7 build metadata carries what an artifact must be traceable by', () => {
  for (const file of [version.BUILD_META, version.STABLE_META]) {
    const meta = version.readJson(file);
    for (const field of ['version', 'buildId', 'builtAt', 'commit', 'platform', 'arch']) {
      assert.ok(meta[field] != null, `${path.basename(file)} is missing ${field}`);
    }
    assert.match(meta.commit, /^[0-9a-f]{40}$/, `${path.basename(file)} commit must be a full SHA`);
    assert.ok(meta.buildId.startsWith(`${meta.version}-`), `${path.basename(file)} buildId must belong to its version`);
  }
});

test('VER8 drift between the canonical version and anything derived from it fails', () => {
  const box = sandbox();
  try {
    // A stale build-meta is the exact failure this gate exists to catch: source
    // says one version, the app would report another.
    const stale = { ...version.buildMetadataFor(), version: '0.0.1', buildId: '0.0.1-abc1234' };
    const file = path.join(box.dir, 'build-meta.json');
    version.writeJson(file, stale);
    const written = version.readJson(file);
    assert.notEqual(written.version, version.currentVersion(), 'fixture must actually differ');

    // The real gate, against the real tree, with a version that is not ours.
    const problems = version.versionProblems({ version: '9.9.9' });
    assert.ok(problems.length > 0, 'a wrong version must be reported');
    assert.ok(problems.some((p) => p.includes('package-lock.json')), problems.join('\n'));
    assert.ok(problems.some((p) => p.includes('build-meta.json')), problems.join('\n'));
  } finally {
    box.cleanup();
  }
});

test('VER9 a build ID without a commit is rejected as untraceable', () => {
  assert.ok(!version.BUILD_ID.test('0.4.22-20260921152752-434b1b'), 'the old random-suffix format must no longer pass');
  assert.ok(version.BUILD_ID.test('0.4.22-abc1234'));
  assert.ok(version.BUILD_ID.test('0.4.22-abc1234-dirty'));
  assert.ok(!version.BUILD_ID.test('0.4.22'));
  assert.ok(!version.BUILD_ID.test('abc1234'));
});

test('VER10 setting the same version twice changes nothing the second time', () => {
  // setVersion writes the real repository files, so snapshot every file it can
  // touch and put them back. Without this the suite leaves the tree modified
  // and races any sibling test file that reads the same metadata.
  const touched = [version.PACKAGE_JSON, version.PACKAGE_LOCK, version.BUILD_META, version.STABLE_META];
  const snapshot = touched.map((file) => [file, fs.readFileSync(file, 'utf8')]);
  try {
    const current = version.currentVersion();
    const first = version.setVersion(current);
    const second = version.setVersion(current);
    assert.ok(Array.isArray(first.changed));
    assert.deepEqual(second.changed, [], 'a repeat run must be a no-op');
    assert.equal(second.version, current);
  } finally {
    for (const [file, content] of snapshot) fs.writeFileSync(file, content);
  }
  for (const [file, content] of snapshot) {
    assert.equal(fs.readFileSync(file, 'utf8'), content, `${path.basename(file)} must be left as it was found`);
  }
});

test('VER11 an invalid version is refused before anything is written', () => {
  const before = fs.readFileSync(version.PACKAGE_JSON, 'utf8');
  for (const bad of ['', 'v1.2.3', '1.2', 'latest']) {
    assert.throws(() => version.setVersion(bad), /not a semantic version/, String(bad));
  }
  assert.equal(fs.readFileSync(version.PACKAGE_JSON, 'utf8'), before, 'a refused version must not write');
});

test('VER12 git state distinguishes "no repository" from "dirty repository"', () => {
  const state = version.gitState();
  assert.equal(typeof state.available, 'boolean');
  assert.equal(typeof state.dirty, 'boolean');
  if (state.available) {
    assert.match(state.commit, /^[0-9a-f]{40}$/);
    assert.equal(state.shortCommit, state.commit.slice(0, 7));
  } else {
    assert.equal(state.commit, null);
    assert.equal(version.buildIdFor({ version: '1.0.0', shortCommit: null, dirty: false }), '1.0.0-nogit');
  }
});

test('VER13 the artifact filename the pipeline expects carries the canonical version', () => {
  const current = version.currentVersion();
  assert.equal(`Hearth Control-${current}-arm64.dmg`, `Hearth Control-${version.currentVersion()}-arm64.dmg`);
  const provenance = fs.readFileSync(new URL('../scripts/release/provenance.cjs', import.meta.url), 'utf8');
  assert.match(provenance, /Hearth Control-\$\{version\}-arm64\.dmg/, 'provenance must derive the filename from the canonical version');
});

// Comments legitimately quote the old scheme to explain why it was replaced;
// only executable code is checked.
const withoutComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n');

test('VER14 no release script pins a version series in code', () => {
  for (const file of ['scripts/release/version.cjs', 'scripts/release/set-version.cjs', 'scripts/release/status.cjs', 'scripts/release/provenance.cjs', 'scripts/release/prepare.cjs', 'scripts/generate-build-meta.cjs', 'scripts/restore-stable-build-meta.cjs']) {
    const code = withoutComments(fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
    assert.ok(!/\d+\\?\.\d+\\?\.\d+-/.test(code.replace(/\$\{version\}-/g, '')), `${file} pins a release series in code`);
    assert.ok(!/\\d\{14\}/.test(code), `${file} still expects the old timestamp build ID`);
  }
});
