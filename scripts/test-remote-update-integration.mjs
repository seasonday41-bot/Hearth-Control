import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const trust = require('../electron/update-trust-config.cjs');
const manifestApi = require('../electron/remote-update-manifest.cjs');
const remote = require('../electron/remote-updater.cjs');
const stager = require('../electron/remote-update-stager.cjs');
const updater = require('../electron/updater.cjs');

const mainSource = fs.readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
const preloadSource = fs.readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
const appSource = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const remoteSource = fs.readFileSync(new URL('../electron/remote-updater.cjs', import.meta.url), 'utf8');
const stagerSource = fs.readFileSync(new URL('../electron/remote-update-stager.cjs', import.meta.url), 'utf8');
const remoteStateSource = fs.readFileSync(new URL('../electron/remote-update-state.cjs', import.meta.url), 'utf8');

const TEST_KEY_ID = 'hearth-integration-test';
const { publicKey: testPublicKey, privateKey: testPrivateKey } = crypto.generateKeyPairSync('ed25519');
const testTrustedKeys = Object.freeze({ [TEST_KEY_ID]: testPublicKey });

const MANIFEST_URL = trust.MANIFEST_URL;
const ARTIFACT_NAME = 'Hearth-Control-integration-arm64.dmg';
const ARTIFACT_URL = new URL(ARTIFACT_NAME, trust.ARTIFACT_BASE_URL).href;
const CURRENT_VERSION = '0.4.3';
const CURRENT_BUILT_AT = '2026-09-17T00:00:00.000Z';

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function unsignedManifest({ appSha, artifactBytes, version = '0.4.4', builtAt = '2026-09-19T00:00:00.000Z', overrides = {} }) {
  return {
    schema: manifestApi.SCHEMA_V2,
    version,
    buildId: `${version}-integration-build`,
    builtAt,
    channel: 'stable',
    platform: 'darwin',
    arch: 'arm64',
    appPath: manifestApi.APP_NAME,
    sha256: appSha,
    artifact: {
      kind: 'dmg',
      path: ARTIFACT_NAME,
      size: artifactBytes.length,
      sha256: sha256(artifactBytes),
    },
    releaseNotes: 'integration fixture',
    ...overrides,
  };
}

function signManifest(input) {
  return manifestApi.signRemoteManifest({ manifest: input, privateKey: testPrivateKey, keyId: TEST_KEY_ID });
}

function response(body, { status = 200, headers = {} } = {}) {
  return new Response(body, { status, headers });
}

function mappedFetch(entries, calls = []) {
  return async (url) => {
    calls.push(url);
    const handler = entries[url];
    if (!handler) throw new Error(`Unexpected URL in integration fixture: ${url}`);
    return typeof handler === 'function' ? handler() : handler;
  };
}

async function createAppFixture(root) {
  const appPath = path.join(root, updater.PRODUCT_NAME);
  await fs.promises.mkdir(path.join(appPath, 'Contents', 'MacOS'), { recursive: true });
  await fs.promises.writeFile(path.join(appPath, 'Contents', 'MacOS', 'Hearth Control'), 'integration-binary');
  await fs.promises.mkdir(path.join(appPath, 'Contents', 'Frameworks', 'Example.framework', 'Versions', 'A'), { recursive: true });
  await fs.promises.writeFile(path.join(appPath, 'Contents', 'Frameworks', 'Example.framework', 'Versions', 'A', 'Example'), 'framework-binary');
  await fs.promises.symlink('Versions/A/Example', path.join(appPath, 'Contents', 'Frameworks', 'Example.framework', 'Example'));
  await fs.promises.symlink('A', path.join(appPath, 'Contents', 'Frameworks', 'Example.framework', 'Versions', 'Current'));
  return appPath;
}

async function fixtureAppHash() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hearth-integration-hash-'));
  try {
    return await updater.sha256Directory(await createAppFixture(root));
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

function mockHdiutil() {
  return async (file, args, options) => {
    assert.equal(file, stager.HDIUTIL_BIN);
    assert.equal(options.shell, false);
    if (args[0] === 'attach') {
      const mountPoint = args[args.indexOf('-mountpoint') + 1];
      await createAppFixture(mountPoint);
      return { stdout: '', stderr: '' };
    }
    if (args[0] === 'detach') return { stdout: '', stderr: '' };
    throw new Error('Unexpected hdiutil operation');
  };
}

function productionRemoteOptions(overrides = {}) {
  return {
    manifestUrl: trust.MANIFEST_URL,
    trustedOrigin: trust.TRUSTED_DELIVERY_ORIGINS[0],
    trustedOrigins: trust.TRUSTED_DELIVERY_ORIGINS,
    trustedKeys: testTrustedKeys,
    artifactBaseUrl: trust.ARTIFACT_BASE_URL,
    currentVersion: CURRENT_VERSION,
    currentBuiltAt: CURRENT_BUILT_AT,
    isPackaged: true,
    expectedPlatform: 'darwin',
    expectedArch: 'arm64',
    ...overrides,
  };
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

test('1. production GitHub repo/config authority is main-owned and renderer cannot supply it', () => {
  assert.equal(trust.RELEASE_OWNER, 'seasonday41-bot');
  assert.equal(trust.RELEASE_REPOSITORY, 'Hearth-Control-Releases');
  assert.equal(trust.MANIFEST_URL, 'https://github.com/seasonday41-bot/Hearth-Control-Releases/releases/latest/download/manifest.json');
  assert.equal(preloadSource.includes('update-trust-config'), false);
  assert.equal(appSource.includes('update-trust-config'), false);
  assert.match(preloadSource, /updaterCheck:\s*\(\) => ipcRenderer\.invoke\('updater:check'\)/);
  assert.match(preloadSource, /updaterPrepare:\s*\(\) => ipcRenderer\.invoke\('updater:prepare'\)/);
});

test('2. trusted production Ed25519 public key is embedded local authority', () => {
  assert.equal(trust.SIGNING_KEY_ID, 'hearth-release-2026-01');
  assert.ok(trust.TRUSTED_SIGNING_KEYS[trust.SIGNING_KEY_ID]);
  assert.doesNotThrow(() => crypto.createPublicKey(trust.TRUSTED_SIGNING_KEYS[trust.SIGNING_KEY_ID]));
  assert.equal(Object.isFrozen(trust.TRUSTED_SIGNING_KEYS), true);
});

test('3. unknown manifest keyId fails closed', async () => {
  const bytes = Buffer.from('dmg');
  const appSha = 'a'.repeat(64);
  const signed = signManifest(unsignedManifest({ appSha, artifactBytes: bytes }));
  const unknown = { ...signed, signature: { ...signed.signature, keyId: 'unknown-release-key' } };
  await assert.rejects(
    () => remote.fetchRemoteManifest(productionRemoteOptions({
      fetchFn: mappedFetch({ [MANIFEST_URL]: response(JSON.stringify(unknown)) }),
    })),
    /Unknown or untrusted signing keyId/,
  );
});

test('4. valid newer signed manifest reaches update_available decision', async () => {
  const bytes = Buffer.from('dmg');
  const signed = signManifest(unsignedManifest({ appSha: 'b'.repeat(64), artifactBytes: bytes }));
  const manifest = await remote.fetchRemoteManifest(productionRemoteOptions({
    fetchFn: mappedFetch({ [MANIFEST_URL]: response(JSON.stringify(signed)) }),
  }));
  remote.validatePlatformAndArch(manifest, { expectedPlatform: 'darwin', expectedArch: 'arm64' });
  assert.equal(updater.isManifestNewer({ manifest, currentVersion: CURRENT_VERSION, currentBuiltAt: CURRENT_BUILT_AT }), true);
  const checkHandler = mainSource.slice(mainSource.indexOf("ipcMain.handle('updater:check'"), mainSource.indexOf("ipcMain.handle('updater:prepare'"));
  assert.ok(checkHandler.includes('remoteUpdateState.checkRemoteUpdate({'));
  assert.ok(remoteStateSource.includes("state: 'update_available'"));
});

test('5. verified remote download + staging reaches existing local updater update_ready', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hearth-integration-ready-'));
  try {
    const artifactBytes = Buffer.from('verified-integration-dmg');
    const appSha = await fixtureAppHash();
    const signed = signManifest(unsignedManifest({ appSha, artifactBytes }));
    const fetched = await remote.fetchAndVerifyUpdate(productionRemoteOptions({
      updatesDir: root,
      fetchFn: mappedFetch({
        [MANIFEST_URL]: response(JSON.stringify(signed)),
        [ARTIFACT_URL]: response(artifactBytes),
      }),
    }));
    assert.equal(fetched.updateAvailable, true);
    const staged = await stager.stageVerifiedUpdate({
      manifest: fetched.manifest,
      dmgPath: fetched.dmgPath,
      updatesDir: root,
      execFileFn: mockHdiutil(),
      delayFn: async () => {},
    });
    const check = await updater.inspectUpdate({
      updateDirectory: staged.stagedDir,
      currentVersion: CURRENT_VERSION,
      currentBuildId: 'current-build',
      currentBuiltAt: CURRENT_BUILT_AT,
      isPackaged: true,
      platform: 'darwin',
      arch: 'arm64',
    });
    assert.equal(check.state, updater.UPDATE_STATES.UPDATE_READY);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test('6. equal/older release does not download or prepare an update', async () => {
  const bytes = Buffer.from('dmg');
  const signed = signManifest(unsignedManifest({
    appSha: 'c'.repeat(64),
    artifactBytes: bytes,
    version: CURRENT_VERSION,
    builtAt: CURRENT_BUILT_AT,
  }));
  const calls = [];
  const result = await remote.fetchAndVerifyUpdate(productionRemoteOptions({
    fetchFn: mappedFetch({ [MANIFEST_URL]: response(JSON.stringify(signed)) }, calls),
  }));
  assert.equal(result.updateAvailable, false);
  assert.equal(result.reason, 'not_newer');
  assert.deepEqual(calls, [MANIFEST_URL]);
});

test('7. invalid signature cannot reach artifact download or install preparation', async () => {
  const bytes = Buffer.from('dmg');
  const signed = signManifest(unsignedManifest({ appSha: 'd'.repeat(64), artifactBytes: bytes }));
  const invalid = { ...signed, signature: { ...signed.signature, value: Buffer.alloc(64, 0).toString('base64') } };
  const calls = [];
  await assert.rejects(
    () => remote.fetchAndVerifyUpdate(productionRemoteOptions({
      fetchFn: mappedFetch({ [MANIFEST_URL]: response(JSON.stringify(invalid)) }, calls),
    })),
    /signature verification failed/i,
  );
  assert.deepEqual(calls, [MANIFEST_URL]);
});

test('8. wrong platform or arch fails before staging', async () => {
  const bytes = Buffer.from('dmg');
  const signed = signManifest(unsignedManifest({ appSha: 'e'.repeat(64), artifactBytes: bytes }));
  const wrongPlatform = { ...signed, platform: 'win32' };
  const wrongArch = { ...signed, arch: 'x64' };
  await assert.rejects(
    () => remote.fetchRemoteManifest(productionRemoteOptions({ fetchFn: mappedFetch({ [MANIFEST_URL]: response(JSON.stringify(wrongPlatform)) }) })),
    /Unsupported manifest platform/,
  );
  await assert.rejects(
    () => remote.fetchRemoteManifest(productionRemoteOptions({ fetchFn: mappedFetch({ [MANIFEST_URL]: response(JSON.stringify(wrongArch)) }) })),
    /Unsupported manifest arch/,
  );
});

test('9. bad artifact size or SHA cannot reach staging', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hearth-integration-bad-artifact-'));
  try {
    const bytes = Buffer.from('actual-download');
    const base = unsignedManifest({ appSha: 'f'.repeat(64), artifactBytes: bytes });
    const badSize = signManifest({ ...base, artifact: { ...base.artifact, size: bytes.length + 1 } });
    await assert.rejects(
      () => remote.fetchAndVerifyUpdate(productionRemoteOptions({
        updatesDir: root,
        fetchFn: mappedFetch({ [MANIFEST_URL]: response(JSON.stringify(badSize)), [ARTIFACT_URL]: response(bytes) }),
      })),
      /size mismatch/i,
    );
    const badShaUnsigned = unsignedManifest({ appSha: 'f'.repeat(64), artifactBytes: bytes });
    badShaUnsigned.artifact.sha256 = '0'.repeat(64);
    const badSha = signManifest(badShaUnsigned);
    await assert.rejects(
      () => remote.fetchAndVerifyUpdate(productionRemoteOptions({
        updatesDir: root,
        fetchFn: mappedFetch({ [MANIFEST_URL]: response(JSON.stringify(badSha)), [ARTIFACT_URL]: response(bytes) }),
      })),
      /SHA-256 mismatch/i,
    );
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test('10. staged application tree mismatch cannot become update_ready', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hearth-integration-tree-'));
  try {
    const dmgPath = path.join(root, 'verified.dmg');
    await fs.promises.writeFile(dmgPath, 'fixture');
    const manifest = {
      ...unsignedManifest({ appSha: '0'.repeat(64), artifactBytes: Buffer.from('fixture') }),
      signature: { algorithm: 'ed25519', keyId: TEST_KEY_ID, value: Buffer.alloc(64).toString('base64') },
    };
    await assert.rejects(
      () => stager.stageVerifiedUpdate({
        manifest,
        dmgPath,
        updatesDir: root,
        execFileFn: mockHdiutil(),
        delayFn: async () => {},
      }),
      /checksum does not match/i,
    );
    assert.equal(await fs.promises.stat(path.join(root, manifest.buildId, 'staged')).catch(() => null), null);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test('11. redirect outside explicit GitHub delivery policy fails closed', async () => {
  await assert.rejects(
    () => remote.safeFetchWithRedirects(MANIFEST_URL, {
      trustedOrigin: trust.TRUSTED_DELIVERY_ORIGINS[0],
      trustedOrigins: trust.TRUSTED_DELIVERY_ORIGINS,
      fetchFn: async () => response(null, { status: 302, headers: { location: 'https://evil.example/update' } }),
    }),
    /trusted origin policy/,
  );
});

test('12. explicit github.com -> release-assets.githubusercontent.com redirect policy succeeds', async () => {
  const redirected = 'https://release-assets.githubusercontent.com/github-production-release-asset/example?token=fixture';
  const calls = [];
  const res = await remote.safeFetchWithRedirects(MANIFEST_URL, {
    trustedOrigin: trust.TRUSTED_DELIVERY_ORIGINS[0],
    trustedOrigins: trust.TRUSTED_DELIVERY_ORIGINS,
    fetchFn: mappedFetch({
      [MANIFEST_URL]: response(null, { status: 302, headers: { location: redirected } }),
      [redirected]: response('ok'),
    }, calls),
  });
  assert.equal(await res.text(), 'ok');
  assert.deepEqual(calls, [MANIFEST_URL, redirected]);
});

test('13. remote preparation code never calls installUpdate directly', () => {
  assert.equal(stripComments(remoteSource).includes('installUpdate('), false);
  assert.equal(stripComments(stagerSource).includes('installUpdate('), false);
  assert.equal(stripComments(remoteStateSource).includes('installUpdate('), false);
  const remoteHandlers = mainSource.slice(mainSource.indexOf("ipcMain.handle('updater:check'"), mainSource.indexOf("ipcMain.handle('updater:install'"));
  assert.equal(stripComments(remoteHandlers).includes('installUpdate('), false);
});

test('14. remote renderer payload cannot inject userApproved or trust authority', () => {
  assert.match(preloadSource, /updaterPrepare:\s*\(\) => ipcRenderer\.invoke\('updater:prepare'\)/);
  const prepare = mainSource.slice(mainSource.indexOf("ipcMain.handle('updater:prepare'"), mainSource.indexOf("ipcMain.handle('updater:check-local'"));
  assert.match(prepare, /ipcMain\.handle\('updater:prepare', async \(event\)/);
  assert.equal(prepare.includes('userApproved'), false);
  assert.equal(prepare.includes('manifestUrl ='), false);
  assert.equal(prepare.includes('trustedKeys ='), false);
});

test('15. remote preparation cannot bypass the authoritative runtime preflight', () => {
  const install = mainSource.slice(mainSource.indexOf("ipcMain.handle('updater:install'"), mainSource.indexOf("ipcMain.handle('antigravity:status'"));
  const initial = install.indexOf('getUpdaterRuntimeBlocker()');
  const dialog = install.indexOf('dialog.showMessageBox');
  const late = install.indexOf('getUpdaterRuntimeBlocker({ ignoreUpdaterBusy: true })');
  const installer = install.indexOf('localUpdater.installUpdate(');
  assert.ok(initial >= 0 && initial < dialog);
  assert.ok(late > dialog && late < installer);
});

test('16. local native approval cancellation still prevents installation', async () => {
  const install = mainSource.slice(mainSource.indexOf("ipcMain.handle('updater:install'"), mainSource.indexOf("ipcMain.handle('antigravity:status'"));
  const dialog = install.indexOf('dialog.showMessageBox');
  const cancel = install.indexOf('approval.response !== 0');
  const installer = install.indexOf('localUpdater.installUpdate(');
  assert.ok(dialog >= 0 && cancel > dialog && installer > cancel);
  await assert.rejects(
    () => updater.installUpdate({ manifest: {}, userApproved: false }),
    /Local user approval is required/,
  );
});

test('17. safe runtime + explicit local approval still reaches the existing installer path', () => {
  const install = mainSource.slice(mainSource.indexOf("ipcMain.handle('updater:install'"), mainSource.indexOf("ipcMain.handle('antigravity:status'"));
  assert.ok(install.includes('event.sender.id !== mainWindow.webContents.id'));
  assert.ok(install.includes('userApproved: true'));
  assert.ok(install.includes('localUpdater.readAndValidateManifest(installUpdateDirectory'));
  assert.ok(install.includes('localUpdater.installUpdate({'));
});

test('18. remote verification failure leaves an existing installed application untouched', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hearth-integration-installed-'));
  try {
    const applications = path.join(root, 'Applications');
    const installed = path.join(applications, updater.PRODUCT_NAME, 'sentinel.txt');
    await fs.promises.mkdir(path.dirname(installed), { recursive: true });
    await fs.promises.writeFile(installed, 'keep-me');

    const bytes = Buffer.from('dmg');
    const signed = signManifest(unsignedManifest({ appSha: '1'.repeat(64), artifactBytes: bytes }));
    const invalid = { ...signed, signature: { ...signed.signature, value: Buffer.alloc(64, 3).toString('base64') } };
    await assert.rejects(
      () => remote.fetchAndVerifyUpdate(productionRemoteOptions({
        updatesDir: path.join(root, 'updates'),
        fetchFn: mappedFetch({ [MANIFEST_URL]: response(JSON.stringify(invalid)) }),
      })),
      /signature verification failed/i,
    );
    assert.equal(await fs.promises.readFile(installed, 'utf8'), 'keep-me');
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
