import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildAndStageLocalUpdate, validateSourceManifest } from '../electron/local-update.cjs';
import { validateRemoteManifestSchema } from '../electron/remote-update-manifest.cjs';

const exec = promisify(execFile);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hearth-local-update-'));
const fixture = path.join(root, 'Hearth-Control-' + 'a'.repeat(40));
await fs.mkdir(path.join(fixture, 'electron'), { recursive: true });
await fs.writeFile(path.join(fixture, 'package.json'), JSON.stringify({ version: '0.4.24' }));
await fs.writeFile(path.join(fixture, 'electron', 'build-meta.json'), JSON.stringify({ version: '0.4.24', buildId: '0.4.24-aaaaaaa', commit: 'a'.repeat(40), dirty: false }));
await fs.mkdir(path.join(fixture, 'release', 'mac-arm64', 'Hearth Control.app', 'Contents'), { recursive: true });
await fs.writeFile(path.join(fixture, 'release', 'mac-arm64', 'Hearth Control.app', 'Contents', 'app.asar'), 'fixture');
const archive = path.join(root, 'source.tar.gz');
await exec('/usr/bin/tar', ['-czf', archive, '-C', root, path.basename(fixture)]);
const archiveBytes = await fs.readFile(archive);
const sourceSha = crypto.createHash('sha256').update(archiveBytes).digest('hex');
const manifest = { version: '0.4.24', buildId: '0.4.24-aaaaaaa', builtAt: '2026-09-22T00:00:00.000Z', source: { repository: 'seasonday41-bot/Hearth-Control', commit: 'a'.repeat(40), archivePath: 'seasonday41-bot/Hearth-Control/archive/' + 'a'.repeat(40) + '.tar.gz', sha256: sourceSha } };

after(() => fs.rm(root, { recursive: true, force: true }));

test('LOCAL_UPDATE validates the fixed repository, full commit, archive path and hash', () => {
  assert.equal(validateSourceManifest(manifest, { expectedRepository: 'seasonday41-bot/Hearth-Control' }).commit, 'a'.repeat(40));
  assert.throws(() => validateSourceManifest({ ...manifest, source: { ...manifest.source, repository: 'evil/repo' } }, { expectedRepository: 'seasonday41-bot/Hearth-Control' }), /not trusted/);
  assert.throws(() => validateSourceManifest({ ...manifest, source: { ...manifest.source, commit: 'bad' } }), /commit/);
});

test('signed remote manifest schema accepts source metadata and rejects tampered source identity', () => {
  const remote = { schema: 'hearth-update-v2', version: manifest.version, buildId: manifest.buildId, builtAt: manifest.builtAt, channel: 'stable', platform: 'darwin', arch: 'arm64', appPath: 'Hearth Control.app', sha256: 'b'.repeat(64), artifact: { kind: 'dmg', path: 'Hearth-Control.dmg', size: 1, sha256: 'c'.repeat(64) }, releaseNotes: '', source: manifest.source };
  assert.equal(validateRemoteManifestSchema(remote, { requireSignature: false }), true);
  assert.throws(() => validateRemoteManifestSchema({ ...remote, source: { ...remote.source, archivePath: 'https://evil.example/source.tar.gz' } }, { requireSignature: false }), /source metadata/);
});

test('LOCAL_UPDATE fails closed on source hash mismatch and removes staging', async () => {
  await assert.rejects(() => buildAndStageLocalUpdate({ manifest: { ...manifest, source: { ...manifest.source, sha256: '0'.repeat(64) } }, archivePath: archive, stagingRoot: path.join(root, 'updates'), expectedRepository: manifest.source.repository, sign: false }), /SHA-256 mismatch/);
});

test('LOCAL_UPDATE build failure leaves no staged candidate', async () => {
  const calls = [];
  await assert.rejects(() => buildAndStageLocalUpdate({ manifest, archivePath: archive, stagingRoot: path.join(root, 'updates-fail'), expectedRepository: manifest.source.repository, sign: false, execFileFn: async (file, args, options) => { calls.push([file, args]); if (file === 'npm' && args[0] === 'ci') throw new Error('npm ci failed'); if (file === '/usr/bin/tar') return exec(file, args, options); } }), /npm ci failed/);
  assert.ok(calls.some(([file, args]) => file === 'npm' && args[0] === 'ci'));
  assert.equal(await fs.stat(path.join(root, 'updates-fail', manifest.buildId)).catch(() => null), null);
});

test('LOCAL_UPDATE successful fixture stages a hashed app and invokes ad-hoc signing checks', async () => {
  const calls = [];
  const result = await buildAndStageLocalUpdate({ manifest, archivePath: archive, stagingRoot: path.join(root, 'updates-ok'), expectedRepository: manifest.source.repository, execFileFn: async (file, args, options) => {
    calls.push([file, args, options]);
    if (file === '/usr/bin/tar') return exec(file, args, options);
    if (file === 'npm' && args[0] === 'ci') return {};
    if (file === 'npm' && args[1] === 'dist:mac') return {};
    if (file === '/usr/bin/codesign') return {};
    throw new Error(`unexpected command ${file}`);
  } });
  assert.equal(result.localManifest.buildId, manifest.buildId);
  assert.equal((await fs.stat(result.stagedAppPath)).isDirectory(), true);
  assert.ok(calls.some(([file, args]) => file === '/usr/bin/codesign' && args.includes('-')));
  assert.ok(calls.some(([file, args]) => file === '/usr/bin/codesign' && args.includes('--verify')));
  const distCall = calls.find(([file, args]) => file === 'npm' && args[0] === 'run' && args[1] === 'dist:mac');
  assert.equal(distCall?.[2]?.env?.HEARTH_BUILD_SOURCE_COMMIT, manifest.source.commit, 'archive build must receive the signed source commit identity');
});
