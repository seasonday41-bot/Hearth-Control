import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const manifestApi = require('../electron/remote-update-manifest.cjs');
const updater = require('../electron/updater.cjs');
const stager = require('../electron/remote-update-stager.cjs');
const updateState = require('../electron/remote-update-state.cjs');

const TEST_KEY_ID = 'update-ready-recovery-test';
const MANIFEST_URL = 'https://updates.example.com/manifest.json';
const TRUSTED_ORIGIN = 'https://updates.example.com';
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const trustedKeys = Object.freeze({ [TEST_KEY_ID]: publicKey });
const current = {
  currentVersion: '0.4.5',
  currentBuildId: '0.4.5-current',
  builtAt: '2026-09-18T00:00:00.000Z',
  isPackaged: true,
};

async function createApp(root, contents = 'prepared-binary') {
  const appPath = path.join(root, updater.PRODUCT_NAME);
  await fs.promises.mkdir(path.join(appPath, 'Contents', 'MacOS'), { recursive: true });
  await fs.promises.writeFile(path.join(appPath, 'Contents', 'MacOS', 'Hearth Control'), contents);
  return appPath;
}

async function appTreeHash(contents = 'prepared-binary') {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hearth-ready-hash-'));
  try {
    return await updater.sha256Directory(await createApp(root, contents));
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

async function signedManifest({
  version = '0.4.6',
  buildId = '0.4.6-20260919142336-fa89da',
  builtAt = '2026-09-19T14:23:36.000Z',
  appSha,
} = {}) {
  const preparedAppSha = appSha || await appTreeHash();
  return manifestApi.signRemoteManifest({
    keyId: TEST_KEY_ID,
    privateKey,
    manifest: {
      schema: manifestApi.SCHEMA_V2,
      version,
      buildId,
      builtAt,
      channel: 'stable',
      platform: 'darwin',
      arch: 'arm64',
      appPath: manifestApi.APP_NAME,
      sha256: preparedAppSha,
      artifact: {
        kind: 'dmg',
        path: `${buildId}/Hearth-Control.dmg`,
        size: 1,
        sha256: crypto.createHash('sha256').update('d').digest('hex'),
      },
      releaseNotes: 'recovery fixture',
    },
  });
}

function remoteOptions(manifest, calls) {
  return {
    manifestUrl: MANIFEST_URL,
    trustedOrigin: TRUSTED_ORIGIN,
    trustedOrigins: [TRUSTED_ORIGIN],
    trustedKeys,
    expectedPlatform: 'darwin',
    expectedArch: 'arm64',
    fetchFn: async (url) => {
      calls.push(url);
      assert.equal(url, MANIFEST_URL, 'recovery checks must fetch only the signed manifest');
      return new Response(JSON.stringify(manifest));
    },
  };
}

function mockHdiutil(contents = 'prepared-binary') {
  return async (file, args, options) => {
    assert.equal(file, stager.HDIUTIL_BIN);
    assert.equal(options.shell, false);
    if (args[0] === 'attach') {
      const mountPoint = args[args.indexOf('-mountpoint') + 1];
      await createApp(mountPoint, contents);
      return { stdout: '', stderr: '' };
    }
    if (args[0] === 'detach') return { stdout: '', stderr: '' };
    throw new Error('Unexpected hdiutil operation.');
  };
}

async function prepare(root, manifest, contents = 'prepared-binary') {
  const dmgPath = path.join(root, 'verified.dmg');
  await fs.promises.writeFile(dmgPath, 'd');
  return stager.stageVerifiedUpdate({
    manifest,
    dmgPath,
    updatesDir: root,
    execFileFn: mockHdiutil(contents),
    delayFn: async () => {},
  });
}

async function snapshotTree(root) {
  const records = [];
  const walk = async (directory, relative = '') => {
    for (const entry of (await fs.promises.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const entryPath = path.join(directory, entry.name);
      const entryRelative = path.join(relative, entry.name);
      const stat = await fs.promises.lstat(entryPath);
      if (entry.isDirectory()) {
        records.push(['directory', entryRelative, stat.mode, stat.mtimeMs]);
        await walk(entryPath, entryRelative);
      } else if (entry.isSymbolicLink()) {
        records.push(['symlink', entryRelative, stat.mode, stat.mtimeMs, await fs.promises.readlink(entryPath)]);
      } else {
        const bytes = await fs.promises.readFile(entryPath);
        records.push(['file', entryRelative, stat.mode, stat.mtimeMs, bytes.length, crypto.createHash('sha256').update(bytes).digest('hex')]);
      }
    }
  };
  await walk(root);
  return records;
}

test('prepared UPDATE_READY survives updater:check polling without download or staged-file mutation', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hearth-ready-preserve-'));
  try {
    const manifest = await signedManifest();
    const staged = await prepare(root, manifest);
    const localCheck = await updater.inspectUpdate({
      updateDirectory: staged.stagedDir,
      ...current,
      currentBuiltAt: current.builtAt,
      platform: 'darwin',
      arch: 'arm64',
    });
    assert.equal(localCheck.state, updater.UPDATE_STATES.UPDATE_READY);
    const readySession = { state: updater.UPDATE_STATES.UPDATE_READY, manifest, stagedDir: staged.stagedDir };
    const before = await snapshotTree(staged.stagedDir);
    const calls = [];

    const first = await updateState.checkRemoteUpdate({
      currentSession: readySession,
      info: current,
      remoteOptions: remoteOptions(manifest, calls),
      updatesDir: root,
    });
    const second = await updateState.checkRemoteUpdate({
      currentSession: first.session,
      info: current,
      remoteOptions: remoteOptions(manifest, calls),
      updatesDir: root,
    });

    assert.equal(first.result.state, updater.UPDATE_STATES.UPDATE_READY);
    assert.equal(first.session, readySession, 'a matching valid in-memory session must not be cleared');
    assert.equal(second.result.state, updater.UPDATE_STATES.UPDATE_READY);
    assert.equal(second.session, readySession);
    assert.deepEqual(calls, [MANIFEST_URL, MANIFEST_URL], 'checks must not request or re-download the artifact');
    assert.deepEqual(await snapshotTree(staged.stagedDir), before, 'repeated checks must not mutate staged files');
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test('updater:check reconstructs UPDATE_READY after in-memory session loss', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hearth-ready-recover-'));
  try {
    const manifest = await signedManifest();
    const staged = await prepare(root, manifest);
    const checked = await updateState.checkRemoteUpdate({
      currentSession: null,
      info: current,
      remoteOptions: remoteOptions(manifest, []),
      updatesDir: root,
    });
    assert.equal(checked.result.state, updater.UPDATE_STATES.UPDATE_READY);
    assert.equal(checked.session.state, updater.UPDATE_STATES.UPDATE_READY);
    assert.equal(checked.session.manifest.buildId, manifest.buildId);
    assert.equal(checked.session.stagedDir, staged.stagedDir);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test('missing staged candidate remains UPDATE_AVAILABLE', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hearth-ready-missing-'));
  try {
    const manifest = await signedManifest();
    const checked = await updateState.checkRemoteUpdate({
      currentSession: null,
      info: current,
      remoteOptions: remoteOptions(manifest, []),
      updatesDir: root,
    });
    assert.equal(checked.result.state, 'update_available');
    assert.equal(checked.session.state, 'update_available');
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test('corrupt staged candidate fails closed and is not reported UPDATE_READY', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hearth-ready-corrupt-'));
  try {
    const manifest = await signedManifest();
    const staged = await prepare(root, manifest);
    const binary = path.join(staged.stagedAppPath, 'Contents', 'MacOS', 'Hearth Control');
    await fs.promises.writeFile(binary, 'corrupt-after-staging');
    const checked = await updateState.checkRemoteUpdate({
      currentSession: { state: updater.UPDATE_STATES.UPDATE_READY, manifest, stagedDir: staged.stagedDir },
      info: current,
      remoteOptions: remoteOptions(manifest, []),
      updatesDir: root,
    });
    assert.equal(checked.result.state, 'update_available');
    assert.notEqual(checked.session.state, updater.UPDATE_STATES.UPDATE_READY);
    assert.equal(await fs.promises.readFile(binary, 'utf8'), 'corrupt-after-staging', 'check must not delete or rewrite corrupt staged data');
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test('candidate for a different buildId remains UPDATE_AVAILABLE', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hearth-ready-stale-'));
  try {
    const staleManifest = await signedManifest();
    const staged = await prepare(root, staleManifest);
    const latestManifest = await signedManifest({
      version: '0.4.7',
      buildId: '0.4.7-20260919150000-bb77cc',
      builtAt: '2026-09-19T15:00:00.000Z',
    });
    const before = await snapshotTree(staged.stagedDir);
    const checked = await updateState.checkRemoteUpdate({
      currentSession: { state: updater.UPDATE_STATES.UPDATE_READY, manifest: staleManifest, stagedDir: staged.stagedDir },
      info: current,
      remoteOptions: remoteOptions(latestManifest, []),
      updatesDir: root,
    });
    assert.equal(checked.result.state, 'update_available');
    assert.equal(checked.session.manifest.buildId, latestManifest.buildId);
    assert.deepEqual(await snapshotTree(staged.stagedDir), before, 'stale staged build must remain untouched');
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
