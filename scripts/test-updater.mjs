/** Local Updater V1 test suite. All filesystem mutations stay in a temp fixture. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const updater = require('../electron/updater.cjs');
const { packageUpdateBundle } = require('./generate-update-manifest.cjs');
const { createPackage: createAsar } = require('@electron/asar');
const electronExecutable = require('electron');

let passed = 0; let failed = 0;
const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hearth-updater-test-'));
const test = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); passed += 1; }
  catch (error) { console.error(`  FAIL  ${name}: ${error.message}`); failed += 1; }
};
const writeApp = async (directory, label) => {
  const appPath = path.join(directory, 'Hearth Control.app');
  await fs.promises.mkdir(path.join(appPath, 'Contents', 'MacOS'), { recursive: true });
  await fs.promises.writeFile(path.join(appPath, 'Contents', 'MacOS', 'Hearth Control'), label);
  return appPath;
};
const assertNoAbsoluteSymlinks = async (directory) => {
  const walk = async (current) => {
    for (const entry of await fs.promises.readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(entryPath);
      else if (entry.isSymbolicLink()) assert.equal(path.isAbsolute(await fs.promises.readlink(entryPath)), false, `absolute symlink: ${entryPath}`);
    }
  };
  await walk(directory);
};
const runElectron = (script) => new Promise((resolve, reject) => {
  const child = spawn(electronExecutable, ['-e', script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', reject);
  child.on('close', (code) => {
    if (code === 0) resolve(stdout);
    else reject(new Error(`Electron updater fixture failed (${code}): ${stderr}`));
  });
});
const writeTreeFixture = async (directory, reverse = false) => {
  const appPath = await writeApp(directory, 'tree-build');
  const files = [
    ['Contents', 'Resources', 'alpha.txt', 'alpha'],
    ['Contents', 'Resources', 'zeta.txt', 'zeta'],
  ];
  for (const parts of (reverse ? [...files].reverse() : files)) {
    const target = path.join(appPath, ...parts.slice(0, -1));
    await fs.promises.mkdir(target, { recursive: true });
    await fs.promises.writeFile(path.join(target, parts.at(-1)), parts.at(-1) === 'alpha.txt' ? 'alpha' : 'zeta');
  }
  await fs.promises.mkdir(path.join(appPath, 'Contents', 'Resources', 'empty'), { recursive: true });
  await fs.promises.symlink('../MacOS/Hearth Control', path.join(appPath, 'Contents', 'Resources', 'launcher-link'));
  return appPath;
};
const fixture = async ({ version = '0.3.1', buildId = '0.3.1-20260910-aa11bb', sha256, appPath = 'Hearth Control.app' } = {}) => {
  const directory = await fs.promises.mkdtemp(path.join(root, 'update-'));
  const app = await writeApp(directory, buildId);
  const checksum = sha256 ?? await updater.sha256Directory(app);
  await fs.promises.writeFile(path.join(directory, 'update-manifest.json'), JSON.stringify({ version, buildId, builtAt: '2026-09-10T01:02:03.000Z', platform: process.platform, arch: process.arch, appPath, sha256: checksum }));
  return { directory, app, checksum };
};
const current = { currentVersion: '0.3.0', currentBuildId: '0.3.0-20260909-001', platform: process.platform, arch: process.arch };

console.log('\n=== Hearth Local Updater V1 ===\n');
await test('valid newer manifest becomes update_ready', async () => {
  const update = await fixture(); const result = await updater.inspectUpdate({ updateDirectory: update.directory, ...current });
  assert.equal(result.state, 'update_ready'); assert.equal(result.available.version, '0.3.1');
});
await test('app bundle directory with spaces resolves directly under its trusted folder', async () => {
  const update = await fixture(); const manifest = await updater.readAndValidateManifest(update.directory, process.platform, process.arch);
  assert.equal(manifest.appPath, path.join(update.directory, 'Hearth Control.app'));
});
await test('tree hashing is deterministic and covers empty directories and symlinks', async () => {
  const left = await writeTreeFixture(await fs.promises.mkdtemp(path.join(root, 'tree-left-')));
  const right = await writeTreeFixture(await fs.promises.mkdtemp(path.join(root, 'tree-right-')), true);
  const expected = await updater.sha256Directory(left);
  assert.equal(await updater.sha256Directory(right), expected);
  await fs.promises.unlink(path.join(right, 'Contents', 'Resources', 'launcher-link'));
  await fs.promises.symlink('../MacOS/changed-target', path.join(right, 'Contents', 'Resources', 'launcher-link'));
  assert.notEqual(await updater.sha256Directory(right), expected);
});
await test('Electron verifies a spaced .app bundle containing a real app.asar with original-fs', async () => {
  const directory = await fs.promises.mkdtemp(path.join(root, 'electron-asar-'));
  const app = await writeApp(directory, 'electron-build');
  const asarSource = await fs.promises.mkdtemp(path.join(root, 'asar-source-'));
  await fs.promises.writeFile(path.join(asarSource, 'main.js'), 'module.exports = 1;');
  const asarPath = path.join(app, 'Contents', 'Resources', 'app.asar');
  await fs.promises.mkdir(path.dirname(asarPath), { recursive: true });
  await createAsar(asarSource, asarPath);
  const checksum = await updater.sha256Directory(app);
  await fs.promises.writeFile(path.join(directory, 'update-manifest.json'), JSON.stringify({
    version: current.currentVersion,
    buildId: current.currentBuildId,
    builtAt: '2026-09-10T01:02:03.000Z',
    platform: process.platform,
    arch: process.arch,
    appPath: 'Hearth Control.app',
    sha256: checksum,
  }));
  const updaterPath = fileURLToPath(new URL('../electron/updater.cjs', import.meta.url));
  const script = `const u=require(${JSON.stringify(updaterPath)});u.inspectUpdate(${JSON.stringify({ updateDirectory: directory, ...current })}).then((result)=>process.stdout.write(JSON.stringify(result))).catch((error)=>{process.stderr.write(error.stack);process.exitCode=1;});`;
  const result = JSON.parse(await runElectron(script));
  assert.equal(result.state, 'up_to_date');
});
await test('same version and build becomes up_to_date', async () => {
  const update = await fixture({ version: current.currentVersion, buildId: current.currentBuildId });
  const result = await updater.inspectUpdate({ updateDirectory: update.directory, ...current }); assert.equal(result.state, 'up_to_date');
});
await test('malformed manifest is an error', async () => {
  const directory = await fs.promises.mkdtemp(path.join(root, 'bad-')); await fs.promises.writeFile(path.join(directory, 'update-manifest.json'), '{bad');
  assert.equal((await updater.inspectUpdate({ updateDirectory: directory, ...current })).state, 'error');
});
await test('missing application artifact is an error', async () => {
  const update = await fixture(); await fs.promises.rm(update.app, { recursive: true, force: true });
  const result = await updater.inspectUpdate({ updateDirectory: update.directory, ...current });
  assert.equal(result.state, 'error'); assert.equal(result.error, 'Update application artifact is missing.');
});
await test('checksum mismatch is an error', async () => {
  const update = await fixture({ sha256: 'a'.repeat(64) });
  const result = await updater.inspectUpdate({ updateDirectory: update.directory, ...current });
  assert.equal(result.state, 'error'); assert.equal(result.error, 'Update artifact checksum did not match.');
});
await test('path traversal is rejected', async () => {
  const update = await fixture({ appPath: '../Hearth Control.app' });
  const result = await updater.inspectUpdate({ updateDirectory: update.directory, ...current });
  assert.equal(result.state, 'error'); assert.equal(result.error, 'Update artifact location is not trusted.');
});
await test('filesystem errors are sanitized without exposing partial spaced paths', async () => {
  const error = updater.safeReason('ENOENT, not found in /private/update/Hearth Control.app/Contents/Resources/app.asar');
  assert.equal(error, 'The update application artifact is missing.');
  assert.equal(error.includes('Control.app'), false);
});
await test('package update creates a self-contained trusted-folder bundle', async () => {
  const packageRoot = await fs.promises.mkdtemp(path.join(root, 'package-'));
  const releaseApp = await writeApp(path.join(packageRoot, 'release', 'mac-arm64'), 'packaged-build');
  const metadata = { version: '0.3.1', buildId: '0.3.1-20260910-package', builtAt: '2026-09-10T01:02:03.000Z' };
  const dmgName = `Hearth Control-${metadata.version}-arm64.dmg`;
  await fs.promises.writeFile(path.join(packageRoot, 'release', dmgName), 'dmg');
  const { outputDirectory, manifest } = await packageUpdateBundle({ root: packageRoot, metadata });
  const manifestOnDisk = JSON.parse(await fs.promises.readFile(path.join(outputDirectory, 'update-manifest.json'), 'utf8'));
  const appPath = path.resolve(outputDirectory, manifestOnDisk.appPath);
  assert.equal(path.isAbsolute(manifestOnDisk.appPath), false);
  assert.equal(appPath, path.join(outputDirectory, 'Hearth Control.app'));
  assert.equal(await fs.promises.readFile(path.join(appPath, 'Contents', 'MacOS', 'Hearth Control'), 'utf8'), 'packaged-build');
  assert.equal(manifestOnDisk.dmgPath, dmgName);
  assert.equal(await fs.promises.readFile(path.join(outputDirectory, manifestOnDisk.dmgPath), 'utf8'), 'dmg');
  assert.equal(manifestOnDisk.sha256, await updater.sha256Directory(appPath));
  assert.deepEqual(manifestOnDisk, manifest);
  assert.equal(await fs.promises.stat(releaseApp).then((stat) => stat.isDirectory()), true);
});
await test('packaging preserves relative framework symlinks', async () => {
  const packageRoot = await fs.promises.mkdtemp(path.join(root, 'package-symlinks-'));
  const releaseApp = await writeApp(path.join(packageRoot, 'release', 'mac-arm64'), 'packaged-build');
  await fs.promises.mkdir(path.join(releaseApp, 'Contents', 'Frameworks', 'Example.framework', 'Versions', 'A'), { recursive: true });
  await fs.promises.writeFile(path.join(releaseApp, 'Contents', 'Frameworks', 'Example.framework', 'Versions', 'A', 'Example'), 'framework');
  await fs.promises.symlink('Versions/A/Example', path.join(releaseApp, 'Contents', 'Frameworks', 'Example.framework', 'Example'));
  await fs.promises.symlink('A', path.join(releaseApp, 'Contents', 'Frameworks', 'Example.framework', 'Versions', 'Current'));
  const metadata = { version: '0.3.1', buildId: '0.3.1-20260910-symlinks', builtAt: '2026-09-10T01:02:03.000Z' };
  const { outputDirectory } = await packageUpdateBundle({ root: packageRoot, metadata });
  const packagedApp = path.join(outputDirectory, 'Hearth Control.app');
  assert.equal(await fs.promises.readlink(path.join(packagedApp, 'Contents', 'Frameworks', 'Example.framework', 'Example')), 'Versions/A/Example');
  await assertNoAbsoluteSymlinks(packagedApp);
});
await test('packaging failure leaves the previous trusted-folder manifest intact', async () => {
  const packageRoot = await fs.promises.mkdtemp(path.join(root, 'package-failure-'));
  const outputDirectory = path.join(packageRoot, 'outputs');
  await fs.promises.mkdir(outputDirectory, { recursive: true });
  await fs.promises.writeFile(path.join(outputDirectory, 'update-manifest.json'), 'previous-manifest');
  await assert.rejects(() => packageUpdateBundle({ root: packageRoot, metadata: { version: '0.3.1' } }), /output was left unchanged/);
  assert.equal(await fs.promises.readFile(path.join(outputDirectory, 'update-manifest.json'), 'utf8'), 'previous-manifest');
});
await test('arbitrary app names are rejected', async () => {
  const update = await fixture({ appPath: 'Not Hearth.app' });
  assert.equal((await updater.inspectUpdate({ updateDirectory: update.directory, ...current })).state, 'error');
});
await test('install requires explicit user action', async () => {
  const update = await fixture(); const manifest = await updater.readAndValidateManifest(update.directory, process.platform, process.arch);
  await assert.rejects(() => updater.installUpdate({ manifest, applicationsDirectory: path.join(root, 'Applications'), userDataPath: path.join(root, 'user-data'), launchRollbackHelper: async () => {} }), /approval/);
});
await test('install creates backup in fixture and keeps user data untouched', async () => {
  const update = await fixture(); const manifest = await updater.readAndValidateManifest(update.directory, process.platform, process.arch);
  const applications = await fs.promises.mkdtemp(path.join(root, 'Applications-')); const userData = await fs.promises.mkdtemp(path.join(root, 'user-data-'));
  await writeApp(applications, 'old-build'); await fs.promises.writeFile(path.join(userData, 'settings.json'), 'preserve-me');
  let helperCalled = false;
  const installed = await updater.installUpdate({ manifest, applicationsDirectory: applications, userDataPath: userData, userApproved: true, launchRollbackHelper: async () => { helperCalled = true; } });
  assert.equal(helperCalled, true); assert.equal(installed.state, 'restarting');
  assert.equal(await fs.promises.readFile(path.join(applications, 'Hearth Control.previous.app', 'Contents', 'MacOS', 'Hearth Control'), 'utf8'), 'old-build');
  assert.equal(await fs.promises.readFile(path.join(userData, 'settings.json'), 'utf8'), 'preserve-me');
});
await test('install preserves executable permissions and relative symlinks without touching /Applications', async () => {
  const update = await fixture({ buildId: '0.3.1-20260910-permissions' });
  await fs.promises.chmod(path.join(update.app, 'Contents', 'MacOS', 'Hearth Control'), 0o755);
  await fs.promises.mkdir(path.join(update.app, 'Contents', 'Frameworks', 'Example.framework', 'Versions', 'A'), { recursive: true });
  await fs.promises.writeFile(path.join(update.app, 'Contents', 'Frameworks', 'Example.framework', 'Versions', 'A', 'Example'), 'framework');
  await fs.promises.symlink('Versions/A/Example', path.join(update.app, 'Contents', 'Frameworks', 'Example.framework', 'Example'));
  const checksum = await updater.sha256Directory(update.app);
  const manifestPath = path.join(update.directory, 'update-manifest.json');
  const manifestJson = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
  manifestJson.sha256 = checksum;
  await fs.promises.writeFile(manifestPath, JSON.stringify(manifestJson));
  const manifest = await updater.readAndValidateManifest(update.directory, process.platform, process.arch);
  const applications = await fs.promises.mkdtemp(path.join(root, 'Applications-'));
  const userData = await fs.promises.mkdtemp(path.join(root, 'user-data-'));
  const install = await updater.installUpdate({ manifest, applicationsDirectory: applications, userDataPath: userData, userApproved: true, launchRollbackHelper: async () => {} });
  const installedApp = install.target;
  assert.equal((await fs.promises.stat(path.join(installedApp, 'Contents', 'MacOS', 'Hearth Control'))).mode & 0o111, 0o111);
  assert.equal(await fs.promises.readlink(path.join(installedApp, 'Contents', 'Frameworks', 'Example.framework', 'Example')), 'Versions/A/Example');
  await assertNoAbsoluteSymlinks(installedApp);
  assert.notEqual(applications, '/Applications');
});
await test('rollback restores the fixture application', async () => {
  const update = await fixture({ buildId: '0.3.1-20260910-cc22dd' }); const manifest = await updater.readAndValidateManifest(update.directory, process.platform, process.arch);
  const applications = await fs.promises.mkdtemp(path.join(root, 'Applications-')); const userData = await fs.promises.mkdtemp(path.join(root, 'user-data-'));
  await writeApp(applications, 'old-build'); const install = await updater.installUpdate({ manifest, applicationsDirectory: applications, userDataPath: userData, userApproved: true, launchRollbackHelper: async () => {} });
  const rollback = await updater.rollbackPendingUpdate({ userDataPath: userData, token: install.token, target: install.target, backup: install.backup });
  assert.equal(rollback.rolledBack, true); assert.equal(await fs.promises.readFile(path.join(applications, 'Hearth Control.app', 'Contents', 'MacOS', 'Hearth Control'), 'utf8'), 'old-build');
});
await test('rollback after startup failure runs exactly once and restores a launchable previous bundle', async () => {
  const update = await fixture({ buildId: '0.3.1-20260910-rollback-once' }); const manifest = await updater.readAndValidateManifest(update.directory, process.platform, process.arch);
  const applications = await fs.promises.mkdtemp(path.join(root, 'Applications-')); const userData = await fs.promises.mkdtemp(path.join(root, 'user-data-'));
  await writeApp(applications, 'old-build'); await fs.promises.chmod(path.join(applications, 'Hearth Control.app', 'Contents', 'MacOS', 'Hearth Control'), 0o755);
  const install = await updater.installUpdate({ manifest, applicationsDirectory: applications, userDataPath: userData, userApproved: true, launchRollbackHelper: async () => {} });
  const first = await updater.rollbackPendingUpdate({ userDataPath: userData, token: install.token, target: install.target, backup: install.backup });
  assert.equal(first.rolledBack, true);
  await assert.rejects(() => updater.rollbackPendingUpdate({ userDataPath: userData, token: install.token, target: install.target, backup: install.backup }), /previous version was not available/);
  assert.equal((await fs.promises.stat(path.join(install.target, 'Contents', 'MacOS', 'Hearth Control'))).mode & 0o111, 0o111);
  assert.equal(await fs.promises.readFile(path.join(install.target, 'Contents', 'MacOS', 'Hearth Control'), 'utf8'), 'old-build');
});
await test('startup marker prevents rollback', async () => {
  const update = await fixture({ buildId: '0.3.1-20260910-ee22ff' }); const manifest = await updater.readAndValidateManifest(update.directory, process.platform, process.arch);
  const applications = await fs.promises.mkdtemp(path.join(root, 'Applications-')); const userData = await fs.promises.mkdtemp(path.join(root, 'user-data-'));
  await writeApp(applications, 'old-build'); const install = await updater.installUpdate({ manifest, applicationsDirectory: applications, userDataPath: userData, userApproved: true, launchRollbackHelper: async () => {} });
  await updater.recordStartupSuccess(userData); const result = await updater.rollbackPendingUpdate({ userDataPath: userData, token: install.token, target: install.target, backup: install.backup });
  assert.equal(result.healthy, true);
});
await test('remote bridge has no install entry point', async () => {
  const main = await fs.promises.readFile(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  const bridgeSection = main.slice(main.indexOf('// Bridge Initialization'), main.indexOf("ipcMain.handle('bridge:reject-task'"));
  assert.equal(bridgeSection.includes('updater:install'), false);
  assert.equal(bridgeSection.includes('installUpdate('), false);
});
await test('restart state is returned only after helper is scheduled', async () => {
  const update = await fixture({ buildId: `0.3.1-20260910-${crypto.randomBytes(3).toString('hex')}` }); const manifest = await updater.readAndValidateManifest(update.directory, process.platform, process.arch);
  const applications = await fs.promises.mkdtemp(path.join(root, 'Applications-')); const userData = await fs.promises.mkdtemp(path.join(root, 'user-data-'));
  await writeApp(applications, 'old-build'); let helper = false;
  const result = await updater.installUpdate({ manifest, applicationsDirectory: applications, userDataPath: userData, userApproved: true, launchRollbackHelper: async () => { helper = true; } });
  assert.equal(helper, true); assert.equal(result.state, 'restarting');
});
await test('watchdog receives the final installed app path, never staging or backup', async () => {
  const update = await fixture({ buildId: '0.3.1-20260910-relaunch-target' }); const manifest = await updater.readAndValidateManifest(update.directory, process.platform, process.arch);
  const applications = await fs.promises.mkdtemp(path.join(root, 'Applications-')); const userData = await fs.promises.mkdtemp(path.join(root, 'user-data-'));
  await writeApp(applications, 'old-build'); let helperArgs;
  const install = await updater.installUpdate({ manifest, applicationsDirectory: applications, userDataPath: userData, userApproved: true, launchRollbackHelper: async (args) => { helperArgs = args; } });
  assert.equal(helperArgs.target, install.target);
  assert.equal(helperArgs.backup, install.backup);
  assert.equal(path.basename(helperArgs.target), 'Hearth Control.app');
  assert.equal(helperArgs.target.includes('.installing-'), false);
  assert.equal(helperArgs.target.includes('.previous.app'), false);
});
await fs.promises.rm(root, { recursive: true, force: true });
console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
