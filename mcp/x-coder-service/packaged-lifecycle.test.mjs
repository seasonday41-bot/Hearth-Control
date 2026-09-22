import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach } from 'node:test';

import { ensureXCoderServiceInstalled } from './packaged-lifecycle.mjs';

const dirs = [];
const tmpDir = (name) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hearth-x-coder-${name}-`));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// Simulates the real, unpacked `Contents/Resources/app.asar.unpacked/mcp`
// tree an installed app would actually have on disk (asarUnpack in
// package.json's build config) -- never inside an asar archive.
const makeFakeAppResources = () => {
  const resourcesPath = tmpDir('resources');
  const mcpDir = path.join(resourcesPath, 'app.asar.unpacked', 'mcp');
  fs.mkdirSync(path.join(mcpDir, 'x-coder-service'), { recursive: true });
  fs.writeFileSync(path.join(mcpDir, 'x-coder-service', 'server.mjs'), '// fake packaged server\n');
  return resourcesPath;
};

const okHealth = async () => ({ ok: true, status: 200 });
const failHealth = async () => ({ ok: false, status: null });

const launchctlSequence = (results) => {
  const calls = [];
  let i = 0;
  const fn = (args, opts) => {
    calls.push({ args, opts });
    const result = results[Math.min(i, results.length - 1)];
    i += 1;
    return result;
  };
  fn.calls = calls;
  return fn;
};

test('L1 dev mode is a strict no-op: no packaged inputs are ever touched or required', async () => {
  const result = await ensureXCoderServiceInstalled({ isPackaged: false });
  assert.deepEqual(result, { ok: true, skipped: true, reason: 'dev_mode' });
});

test('L2 first packaged install stages the real unpacked mcp/ tree and installs the LaunchAgent', async () => {
  const homeDir = tmpDir('home');
  const resourcesPath = makeFakeAppResources();
  const runLaunchctl = launchctlSequence([
    { status: 0, stdout: '', stderr: '' }, // pre-install bootout
    { status: 0, stdout: '', stderr: '' }, // bootstrap
  ]);

  const result = await ensureXCoderServiceInstalled({
    isPackaged: true,
    homeDir,
    resourcesPath,
    appVersion: '1.0.0',
    runLaunchctl,
    waitForHealth: okHealth,
  });

  assert.equal(result.ok, true);
  assert.equal(result.skipped, false);
  assert.match(result.stagedRuntimeRoot, /Application Support\/Hearth Control\/x-coder-service\/1\.0\.0$/);

  const stagedServer = path.join(result.stagedRuntimeRoot, 'mcp', 'x-coder-service', 'server.mjs');
  assert.equal(fs.existsSync(stagedServer), true);
  assert.equal(fs.readFileSync(stagedServer, 'utf8'), '// fake packaged server\n');

  const plistPath = path.join(homeDir, 'Library', 'LaunchAgents', 'com.hearth-control.x-coder-service.plist');
  assert.equal(fs.existsSync(plistPath), true);
  assert.match(fs.readFileSync(plistPath, 'utf8'), /1\.0\.0/);
});

test('L3 an already-current, healthy install is skipped rather than restarted', async () => {
  const homeDir = tmpDir('home');
  const resourcesPath = makeFakeAppResources();
  const install = launchctlSequence([
    { status: 0, stdout: '', stderr: '' },
    { status: 0, stdout: '', stderr: '' },
  ]);

  const first = await ensureXCoderServiceInstalled({
    isPackaged: true,
    homeDir,
    resourcesPath,
    appVersion: '1.0.0',
    runLaunchctl: install,
    waitForHealth: okHealth,
  });
  assert.equal(first.skipped, false);

  const noopLaunchctl = launchctlSequence([]);
  const second = await ensureXCoderServiceInstalled({
    isPackaged: true,
    homeDir,
    resourcesPath,
    appVersion: '1.0.0',
    runLaunchctl: noopLaunchctl,
    waitForHealth: okHealth,
  });

  assert.equal(second.ok, true);
  assert.equal(second.skipped, true);
  assert.equal(second.reason, 'already_current');
  assert.equal(noopLaunchctl.calls.length, 0, 'a matching, healthy install must not bootout/bootstrap again');
});

test('L4 a Hearth Control version change stages the new version and moves the LaunchAgent onto it', async () => {
  const homeDir = tmpDir('home');
  const resourcesPath = makeFakeAppResources();

  const v1 = await ensureXCoderServiceInstalled({
    isPackaged: true,
    homeDir,
    resourcesPath,
    appVersion: '1.0.0',
    runLaunchctl: launchctlSequence([{ status: 0, stdout: '', stderr: '' }, { status: 0, stdout: '', stderr: '' }]),
    waitForHealth: okHealth,
  });
  assert.equal(v1.skipped, false);
  assert.match(v1.stagedRuntimeRoot, /x-coder-service\/1\.0\.0$/);

  // Simulate an app update: the unpacked resources now carry newer content.
  fs.writeFileSync(
    path.join(resourcesPath, 'app.asar.unpacked', 'mcp', 'x-coder-service', 'server.mjs'),
    '// fake v2 packaged server\n',
  );

  const v2Launchctl = launchctlSequence([
    { status: 0, stdout: '', stderr: '' }, // pre-install bootout of the v1 LaunchAgent
    { status: 0, stdout: '', stderr: '' }, // bootstrap the v2 candidate
  ]);
  const v2 = await ensureXCoderServiceInstalled({
    isPackaged: true,
    homeDir,
    resourcesPath,
    appVersion: '2.0.0',
    runLaunchctl: v2Launchctl,
    waitForHealth: okHealth,
  });

  assert.equal(v2.ok, true);
  assert.equal(v2.skipped, false);
  assert.match(v2.stagedRuntimeRoot, /x-coder-service\/2\.0\.0$/);
  assert.notEqual(v2.stagedRuntimeRoot, v1.stagedRuntimeRoot);
  assert.ok(v2Launchctl.calls.length >= 2, 'the version change must actually bootout the old service and bootstrap the new one');

  const v2Server = path.join(v2.stagedRuntimeRoot, 'mcp', 'x-coder-service', 'server.mjs');
  assert.equal(fs.readFileSync(v2Server, 'utf8'), '// fake v2 packaged server\n');

  const plistPath = path.join(homeDir, 'Library', 'LaunchAgents', 'com.hearth-control.x-coder-service.plist');
  const plist = fs.readFileSync(plistPath, 'utf8');
  assert.match(plist, /2\.0\.0/);
  assert.doesNotMatch(plist, /x-coder-service\/1\.0\.0/);
});

test('L5 a health failure on a version update rolls back and reports failure, matching the transactional installer', async () => {
  const homeDir = tmpDir('home');
  const resourcesPath = makeFakeAppResources();

  await ensureXCoderServiceInstalled({
    isPackaged: true,
    homeDir,
    resourcesPath,
    appVersion: '1.0.0',
    runLaunchctl: launchctlSequence([{ status: 0, stdout: '', stderr: '' }, { status: 0, stdout: '', stderr: '' }]),
    waitForHealth: okHealth,
  });

  const failingLaunchctl = launchctlSequence([
    { status: 0, stdout: '', stderr: '' }, // pre-install bootout
    { status: 0, stdout: '', stderr: '' }, // bootstrap candidate succeeds
    { status: 0, stdout: '', stderr: '' }, // bootout the unhealthy candidate
    { status: 0, stdout: '', stderr: '' }, // restore: bootstrap the previous (v1) plist
  ]);
  const result = await ensureXCoderServiceInstalled({
    isPackaged: true,
    homeDir,
    resourcesPath,
    appVersion: '2.0.0',
    runLaunchctl: failingLaunchctl,
    waitForHealth: failHealth,
  });

  assert.equal(result.ok, false);
  assert.equal(result.stage, 'health');
  assert.equal(result.rollback.restored, true);

  const plistPath = path.join(homeDir, 'Library', 'LaunchAgents', 'com.hearth-control.x-coder-service.plist');
  assert.match(fs.readFileSync(plistPath, 'utf8'), /1\.0\.0/, 'the previous, working version must be restored');
});
