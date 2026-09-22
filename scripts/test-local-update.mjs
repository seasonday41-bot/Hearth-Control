import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildAndStageLocalUpdate, buildAndStageGitUpdate, checkGitMainUpdate, validateSourceManifest } from '../electron/local-update.cjs';
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
const gitManifest = { version: '0.4.24', buildId: '0.4.24-aaaaaaa', builtAt: '2026-09-22T00:00:00.000Z', source: { repository: 'seasonday41-bot/Hearth-Control', commit: 'a'.repeat(40), transport: 'git' } };

after(() => fs.rm(root, { recursive: true, force: true }));

test('LOCAL_UPDATE validates the fixed repository, full commit, archive path and hash', () => {
  assert.equal(validateSourceManifest(manifest, { expectedRepository: 'seasonday41-bot/Hearth-Control' }).commit, 'a'.repeat(40));
  assert.throws(() => validateSourceManifest({ ...manifest, source: { ...manifest.source, repository: 'evil/repo' } }, { expectedRepository: 'seasonday41-bot/Hearth-Control' }), /not trusted/);
  assert.throws(() => validateSourceManifest({ ...manifest, source: { ...manifest.source, commit: 'bad' } }), /commit/);
  assert.equal(validateSourceManifest(gitManifest, { expectedRepository: 'seasonday41-bot/Hearth-Control' }).transport, 'git');
  assert.throws(() => validateSourceManifest({ ...gitManifest, source: { ...gitManifest.source, archivePath: 'evil' } }), /must not carry archive metadata/);
});

test('signed remote manifest schema accepts source metadata and rejects tampered source identity', () => {
  const remote = { schema: 'hearth-update-v2', version: manifest.version, buildId: manifest.buildId, builtAt: manifest.builtAt, channel: 'stable', platform: 'darwin', arch: 'arm64', appPath: 'Hearth Control.app', sha256: 'b'.repeat(64), artifact: { kind: 'dmg', path: 'Hearth-Control.dmg', size: 1, sha256: 'c'.repeat(64) }, releaseNotes: '', source: manifest.source };
  assert.equal(validateRemoteManifestSchema(remote, { requireSignature: false }), true);
  assert.throws(() => validateRemoteManifestSchema({ ...remote, source: { ...remote.source, archivePath: 'https://evil.example/source.tar.gz' } }, { requireSignature: false }), /source metadata/);
  const gitRemote = { ...remote, source: gitManifest.source };
  assert.equal(validateRemoteManifestSchema(gitRemote, { requireSignature: false }), true);
  assert.throws(() => validateRemoteManifestSchema({ ...gitRemote, source: { ...gitRemote.source, archivePath: 'https://evil.example/source.tar.gz' } }, { requireSignature: false }), /source metadata/);
});

test('LOCAL_UPDATE fails closed on source hash mismatch and removes staging', async () => {
  await assert.rejects(() => buildAndStageLocalUpdate({ manifest: { ...manifest, source: { ...manifest.source, sha256: '0'.repeat(64) } }, archivePath: archive, stagingRoot: path.join(root, 'updates'), expectedRepository: manifest.source.repository, sign: false }), /SHA-256 mismatch/);
});

test('LOCAL_UPDATE build failure leaves no staged candidate', async () => {
  const calls = [];
  await assert.rejects(() => buildAndStageLocalUpdate({ manifest, archivePath: archive, stagingRoot: path.join(root, 'updates-fail'), expectedRepository: manifest.source.repository, sign: false, npmPath: '/fixture/npm', execFileFn: async (file, args, options) => { calls.push([file, args]); if (file === '/fixture/npm' && args[0] === 'ci') throw new Error('npm ci failed'); if (file === '/usr/bin/tar') return exec(file, args, options); } }), /npm ci failed/);
  assert.ok(calls.some(([file, args]) => file === '/fixture/npm' && args[0] === 'ci'));
  assert.equal(await fs.stat(path.join(root, 'updates-fail', manifest.buildId)).catch(() => null), null);
});

test('LOCAL_UPDATE successful fixture stages a hashed app and invokes ad-hoc signing checks', async () => {
  const calls = [];
  const result = await buildAndStageLocalUpdate({ manifest, archivePath: archive, stagingRoot: path.join(root, 'updates-ok'), expectedRepository: manifest.source.repository, npmPath: '/fixture/npm', execFileFn: async (file, args, options) => {
    calls.push([file, args, options]);
    if (file === '/usr/bin/tar') return exec(file, args, options);
    if (file === '/fixture/npm' && args[0] === 'ci') return {};
    if (file === '/fixture/npm' && args[1] === 'dist:mac') return {};
    if (file === '/usr/bin/codesign') return {};
    throw new Error(`unexpected command ${file}`);
  } });
  assert.equal(result.localManifest.buildId, manifest.buildId);
  assert.equal((await fs.stat(result.stagedAppPath)).isDirectory(), true);
  assert.ok(calls.some(([file, args]) => file === '/usr/bin/codesign' && args.includes('-')));
  assert.ok(calls.some(([file, args]) => file === '/usr/bin/codesign' && args.includes('--verify')));
  const distCall = calls.find(([file, args]) => file === '/fixture/npm' && args[0] === 'run' && args[1] === 'dist:mac');
  assert.equal(distCall?.[2]?.env?.HEARTH_BUILD_SOURCE_COMMIT, manifest.source.commit, 'archive build must receive the signed source commit identity');
  assert.match(distCall?.[2]?.env?.PATH || '', /\/usr\/local\/bin|\/opt\/homebrew\/bin/, 'archive build must receive a deterministic Node/npm PATH');
});


test('LOCAL_UPDATE private Git mode fetches only the signed exact commit from the fixed repository', async () => {
  const calls = [];
  const stageRoot = path.join(root, 'updates-git-ok');
  const result = await buildAndStageGitUpdate({
    manifest: gitManifest,
    stagingRoot: stageRoot,
    expectedRepository: 'seasonday41-bot/Hearth-Control',
    npmPath: '/fixture/npm',
    execFileFn: async (file, args, options = {}) => {
      calls.push([file, args, options]);
      if (file === '/usr/bin/git' && args[0] === 'init') {
        await fs.mkdir(path.join(args[1], 'electron'), { recursive: true });
        await fs.mkdir(path.join(args[1], 'release', 'mac-arm64', 'Hearth Control.app', 'Contents'), { recursive: true });
        await fs.writeFile(path.join(args[1], 'package.json'), JSON.stringify({ version: '0.4.24' }));
        await fs.writeFile(path.join(args[1], 'electron', 'build-meta.json'), JSON.stringify({ version: '0.4.24', buildId: '0.4.24-aaaaaaa', commit: 'a'.repeat(40), dirty: false }));
        await fs.writeFile(path.join(args[1], 'release', 'mac-arm64', 'Hearth Control.app', 'Contents', 'app.asar'), 'fixture');
        return { stdout: '' };
      }
      if (file === '/usr/bin/git' && args.includes('rev-parse')) return { stdout: 'a'.repeat(40) + '\n' };
      if (file === '/usr/bin/git' && args.includes('get-url')) return { stdout: 'https://github.com/seasonday41-bot/Hearth-Control.git\n' };
      if (file === '/usr/bin/git' || file === '/fixture/npm' || file === '/usr/bin/codesign') return { stdout: '' };
      throw new Error('unexpected command ' + file);
    },
  });
  assert.equal(result.localManifest.buildId, gitManifest.buildId);
  assert.ok(calls.some(([file, args]) => file === '/usr/bin/git' && args.join(' ') === '-C ' + path.join(stageRoot, gitManifest.buildId, 'source') + ' fetch --depth=1 --no-tags origin ' + 'a'.repeat(40)));
  assert.ok(calls.some(([file, args]) => file === '/usr/bin/git' && args.includes('https://github.com/seasonday41-bot/Hearth-Control.git')));
  assert.equal(calls.some(([, args]) => args.some((arg) => String(arg).includes('evil'))), false);
});

test('LOCAL_UPDATE private Git mode rejects a fetched commit that differs from the signed commit', async () => {
  const stageRoot = path.join(root, 'updates-git-mismatch');
  await assert.rejects(() => buildAndStageGitUpdate({
    manifest: gitManifest,
    stagingRoot: stageRoot,
    expectedRepository: 'seasonday41-bot/Hearth-Control',
    sign: false,
    npmPath: '/fixture/npm',
    execFileFn: async (file, args) => {
      if (file === '/usr/bin/git' && args[0] === 'init') return { stdout: '' };
      if (file === '/usr/bin/git' && args.includes('rev-parse')) return { stdout: 'b'.repeat(40) + '\n' };
      if (file === '/usr/bin/git') return { stdout: '' };
      throw new Error('unexpected command');
    },
  }), /does not match the signed source identity/);
  assert.equal(await fs.stat(path.join(stageRoot, gitManifest.buildId)).catch(() => null), null);
});


const gitCheckExec = ({ remoteCommit, version = '0.4.24', committedAt = '2026-09-22T04:00:00.000Z', calls = [] }) => async (file, args, options = {}) => {
  calls.push([file, args, options]);
  assert.equal(file, '/usr/bin/git');
  if (args[0] === 'ls-remote') {
    return { stdout: remoteCommit + '\trefs/heads/main\n' };
  }
  if (args[0] === 'init') return { stdout: '' };
  if (args.includes('rev-parse')) return { stdout: remoteCommit + '\n' };
  if (args.includes('get-url')) return { stdout: 'https://github.com/seasonday41-bot/Hearth-Control.git\n' };
  if (args.includes('FETCH_HEAD:package.json')) return { stdout: JSON.stringify({ version }) };
  if (args.includes('--format=%cI')) return { stdout: committedAt + '\n' };
  if (args.includes('remote') || args.includes('fetch')) return { stdout: '' };
  throw new Error('unexpected git command: ' + args.join(' '));
};

test('LOCAL_UPDATE Check for Update resolves only the fixed private Git main ref and reports up_to_date on the same commit', async () => {
  const calls = [];
  const currentCommit = 'a'.repeat(40);
  const checked = await checkGitMainUpdate({
    currentVersion: '0.4.24',
    currentBuildId: '0.4.24-aaaaaaa',
    currentBuiltAt: '2026-09-22T03:00:00.000Z',
    currentCommit,
    isPackaged: true,
    stagingRoot: path.join(root, 'git-check-same'),
    expectedRepository: 'seasonday41-bot/Hearth-Control',
    expectedBranch: 'main',
    execFileFn: gitCheckExec({ remoteCommit: currentCommit, calls }),
  });
  assert.equal(checked.session, null);
  assert.equal(checked.result.state, 'up_to_date');
  assert.equal(checked.result.latestMain.commit, currentCommit);
  assert.equal(calls.length, 1, 'same commit must stop after ls-remote without fetching source');
  assert.deepEqual(calls[0][1], ['ls-remote', '--exit-code', 'https://github.com/seasonday41-bot/Hearth-Control.git', 'refs/heads/main']);
});

test('LOCAL_UPDATE Check for Update returns a pinned local_git candidate when private main is newer', async () => {
  const calls = [];
  const remoteCommit = 'b'.repeat(40);
  const checked = await checkGitMainUpdate({
    currentVersion: '0.4.24',
    currentBuildId: '0.4.24-aaaaaaa',
    currentBuiltAt: '2026-09-22T03:00:00.000Z',
    currentCommit: 'a'.repeat(40),
    isPackaged: true,
    stagingRoot: path.join(root, 'git-check-newer'),
    expectedRepository: 'seasonday41-bot/Hearth-Control',
    expectedBranch: 'main',
    execFileFn: gitCheckExec({ remoteCommit, calls }),
  });
  assert.equal(checked.result.state, 'update_available');
  assert.equal(checked.session.mode, 'local_git');
  assert.equal(checked.session.manifest.source.commit, remoteCommit);
  assert.equal(checked.session.manifest.source.repository, 'seasonday41-bot/Hearth-Control');
  assert.equal(checked.session.manifest.buildId, '0.4.24-bbbbbbb');
  assert.equal(checked.result.latestMain.commit, remoteCommit);
  assert.ok(calls.some(([, args]) => args.join(' ') === 'fetch --depth=1 --no-tags origin ' + remoteCommit || args.slice(2).join(' ') === 'fetch --depth=1 --no-tags origin ' + remoteCommit));
  assert.equal(calls.some(([, args]) => args.some((arg) => String(arg).includes('refs/heads/dev'))), false);
});

test('LOCAL_UPDATE Check for Update refuses downgrade/non-newer private main', async () => {
  const remoteCommit = 'b'.repeat(40);
  const checked = await checkGitMainUpdate({
    currentVersion: '0.4.24',
    currentBuildId: '0.4.24-aaaaaaa',
    currentBuiltAt: '2026-09-22T05:00:00.000Z',
    currentCommit: 'a'.repeat(40),
    isPackaged: true,
    stagingRoot: path.join(root, 'git-check-older'),
    expectedRepository: 'seasonday41-bot/Hearth-Control',
    expectedBranch: 'main',
    execFileFn: gitCheckExec({ remoteCommit, version: '0.4.23', committedAt: '2026-09-22T04:00:00.000Z' }),
  });
  assert.equal(checked.session, null);
  assert.equal(checked.result.state, 'up_to_date');
  assert.equal(checked.result.latestMain.buildId, '0.4.23-bbbbbbb');
});

test('LOCAL_UPDATE Check for Update rejects branch/ref injection before any Git command', async () => {
  let invoked = false;
  await assert.rejects(() => checkGitMainUpdate({
    currentVersion: '0.4.24',
    currentBuildId: '0.4.24-aaaaaaa',
    currentBuiltAt: '2026-09-22T03:00:00.000Z',
    currentCommit: 'a'.repeat(40),
    isPackaged: true,
    stagingRoot: path.join(root, 'git-check-branch-injection'),
    expectedRepository: 'seasonday41-bot/Hearth-Control',
    expectedBranch: 'feature/evil',
    execFileFn: async () => { invoked = true; return { stdout: '' }; },
  }), /trusted source branch is invalid/);
  assert.equal(invoked, false);
});
