import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach } from 'node:test';

import { installXCoderLaunchAgent, uninstallXCoderLaunchAgent, __testing } from './launch-agent-installer.mjs';

const dirs = [];
const tmpPlistPath = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-x-coder-installer-'));
  dirs.push(dir);
  return path.join(dir, 'com.hearth-control.x-coder-service.plist');
};

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

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

const sleep0 = (_ms) => Promise.resolve();

const trackedSleep = () => {
  const calls = [];
  const fn = (ms) => { calls.push(ms); return Promise.resolve(); };
  fn.calls = calls;
  return fn;
};

test('T1 successful upgrade: previous plist is overwritten and no rollback occurs', async () => {
  const plistPath = tmpPlistPath();
  fs.writeFileSync(plistPath, '<old-plist/>', 'utf8');

  const runLaunchctl = launchctlSequence([
    { status: 0, stdout: '', stderr: '' }, // pre-install bootout
    { status: 0, stdout: '', stderr: '' }, // bootstrap candidate
  ]);

  const result = await installXCoderLaunchAgent({
    plistPath,
    plistContent: '<new-plist/>',
    domain: 'gui/501',
    serviceTarget: 'gui/501/label',
    runLaunchctl,
    waitForHealth: okHealth,
    sleep: sleep0,
  });

  assert.equal(result.ok, true);
  assert.equal(result.stage, 'complete');
  assert.equal(result.hadPrevious, true);
  assert.equal(result.rollback, null);
  assert.equal(fs.readFileSync(plistPath, 'utf8'), '<new-plist/>');
});

test('T1b an unexpected pre-install bootout failure aborts before touching the plist or attempting bootstrap', async () => {
  const plistPath = tmpPlistPath();
  fs.writeFileSync(plistPath, '<old-plist/>', 'utf8');

  const runLaunchctl = launchctlSequence([
    { status: 1, stdout: '', stderr: 'Operation not permitted' }, // pre-install bootout: genuinely unexpected
  ]);

  const result = await installXCoderLaunchAgent({
    plistPath,
    plistContent: '<candidate-plist/>',
    domain: 'gui/501',
    serviceTarget: 'gui/501/label',
    runLaunchctl,
    waitForHealth: okHealth,
    sleep: sleep0,
  });

  assert.equal(result.ok, false);
  assert.equal(result.stage, 'pre_install_bootout');
  assert.equal(result.preInstallBootout.stderr, 'Operation not permitted');
  assert.equal(fs.readFileSync(plistPath, 'utf8'), '<old-plist/>', 'the existing plist must be untouched');
  assert.equal(runLaunchctl.calls.length, 1, 'bootstrap must never be attempted once the pre-install bootout is unexplained');
});

test('T2 bootstrap failure rolls back to the previous plist and service', async () => {
  const plistPath = tmpPlistPath();
  fs.writeFileSync(plistPath, '<old-plist/>', 'utf8');

  const runLaunchctl = launchctlSequence([
    { status: 0, stdout: '', stderr: '' },                          // pre-install bootout
    { status: 1, stdout: '', stderr: 'bootstrap failed' },           // bootstrap attempts (x5)
    { status: 1, stdout: '', stderr: 'bootstrap failed' },
    { status: 1, stdout: '', stderr: 'bootstrap failed' },
    { status: 1, stdout: '', stderr: 'bootstrap failed' },
    { status: 1, stdout: '', stderr: 'bootstrap failed' },
    { status: 0, stdout: '', stderr: '' },                          // bootout candidate after failure
    { status: 0, stdout: '', stderr: '' },                          // restore: bootstrap previous plist
  ]);

  const result = await installXCoderLaunchAgent({
    plistPath,
    plistContent: '<candidate-plist/>',
    domain: 'gui/501',
    serviceTarget: 'gui/501/label',
    runLaunchctl,
    waitForHealth: okHealth,
    sleep: sleep0,
  });

  assert.equal(result.ok, false);
  assert.equal(result.stage, 'bootstrap');
  assert.equal(result.hadPrevious, true);
  assert.equal(result.rollback.restored, true);
  assert.equal(fs.readFileSync(plistPath, 'utf8'), '<old-plist/>');
});

test('T3 health failure rolls back to the previous plist and service', async () => {
  const plistPath = tmpPlistPath();
  fs.writeFileSync(plistPath, '<old-plist/>', 'utf8');

  const runLaunchctl = launchctlSequence([
    { status: 0, stdout: '', stderr: '' }, // pre-install bootout
    { status: 0, stdout: '', stderr: '' }, // bootstrap candidate succeeds
    { status: 0, stdout: '', stderr: '' }, // bootout unhealthy candidate
    { status: 0, stdout: '', stderr: '' }, // restore: bootstrap previous plist
  ]);

  const result = await installXCoderLaunchAgent({
    plistPath,
    plistContent: '<candidate-plist/>',
    domain: 'gui/501',
    serviceTarget: 'gui/501/label',
    runLaunchctl,
    waitForHealth: failHealth,
    sleep: sleep0,
  });

  assert.equal(result.ok, false);
  assert.equal(result.stage, 'health');
  assert.equal(result.hadPrevious, true);
  assert.equal(result.rollback.restored, true);
  assert.equal(fs.readFileSync(plistPath, 'utf8'), '<old-plist/>');
});

test('T3b restoring the previous service waits between attempts and recovers from a transient launchd fault', async () => {
  const plistPath = tmpPlistPath();
  fs.writeFileSync(plistPath, '<old-plist/>', 'utf8');

  const runLaunchctl = launchctlSequence([
    { status: 0, stdout: '', stderr: '' }, // pre-install bootout
    { status: 0, stdout: '', stderr: '' }, // bootstrap candidate succeeds
    { status: 0, stdout: '', stderr: '' }, // bootout unhealthy candidate
    { status: 1, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' }, // restore attempt 0: transient
    { status: 0, stdout: '', stderr: '' }, // restore attempt 1: succeeds after the delay
  ]);
  const sleep = trackedSleep();

  const result = await installXCoderLaunchAgent({
    plistPath,
    plistContent: '<candidate-plist/>',
    domain: 'gui/501',
    serviceTarget: 'gui/501/label',
    runLaunchctl,
    waitForHealth: failHealth,
    bootstrapRetryDelayMs: 120,
    sleep,
  });

  assert.equal(result.ok, false);
  assert.equal(result.stage, 'health');
  assert.equal(result.rollback.attempted, true);
  assert.equal(result.rollback.restored, true, 'the transient error 5 must not be reported as a permanent rollback failure');
  assert.equal(fs.readFileSync(plistPath, 'utf8'), '<old-plist/>');
  assert.ok(sleep.calls.includes(120), 'the injected sleep must actually be awaited before the successful restore retry');
});

test('T3c a permanently failing rollback bootstrap is reported as restored:false, not silently swallowed', async () => {
  const plistPath = tmpPlistPath();
  fs.writeFileSync(plistPath, '<old-plist/>', 'utf8');

  const runLaunchctl = launchctlSequence([
    { status: 0, stdout: '', stderr: '' }, // pre-install bootout
    { status: 0, stdout: '', stderr: '' }, // bootstrap candidate succeeds
    { status: 0, stdout: '', stderr: '' }, // bootout unhealthy candidate
    { status: 1, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' }, // every restore attempt fails
  ]);
  const sleep = trackedSleep();

  const result = await installXCoderLaunchAgent({
    plistPath,
    plistContent: '<candidate-plist/>',
    domain: 'gui/501',
    serviceTarget: 'gui/501/label',
    runLaunchctl,
    waitForHealth: failHealth,
    bootstrapAttempts: 3,
    bootstrapRetryDelayMs: 10,
    sleep,
  });

  assert.equal(result.ok, false);
  assert.equal(result.rollback.attempted, true);
  assert.equal(result.rollback.restored, false);
  assert.equal(result.rollback.bootstrap.status, 1);
  assert.equal(sleep.calls.length, 2, 'a delay must occur between each of the 3 restore attempts, but not a trailing one after the last');
});

test('T4 first install failure leaves no plist and no loaded service behind', async () => {
  const plistPath = tmpPlistPath();
  assert.equal(fs.existsSync(plistPath), false);

  const runLaunchctl = launchctlSequence([
    { status: 0, stdout: '', stderr: '' }, // pre-install bootout (no-op, nothing loaded)
    { status: 1, stdout: '', stderr: 'bootstrap failed' },
    { status: 1, stdout: '', stderr: 'bootstrap failed' },
    { status: 1, stdout: '', stderr: 'bootstrap failed' },
    { status: 1, stdout: '', stderr: 'bootstrap failed' },
    { status: 1, stdout: '', stderr: 'bootstrap failed' },
    { status: 0, stdout: '', stderr: '' }, // bootout candidate after failure
  ]);

  const result = await installXCoderLaunchAgent({
    plistPath,
    plistContent: '<candidate-plist/>',
    domain: 'gui/501',
    serviceTarget: 'gui/501/label',
    runLaunchctl,
    waitForHealth: okHealth,
    sleep: sleep0,
  });

  assert.equal(result.ok, false);
  assert.equal(result.hadPrevious, false);
  assert.equal(result.rollback.attempted, false);
  assert.equal(fs.existsSync(plistPath), false);
});

test('T4b an unexpected pre-install bootout failure on a first install leaves no plist behind either', async () => {
  const plistPath = tmpPlistPath();
  assert.equal(fs.existsSync(plistPath), false);

  const runLaunchctl = launchctlSequence([
    { status: 1, stdout: '', stderr: 'Operation not permitted' },
  ]);

  const result = await installXCoderLaunchAgent({
    plistPath,
    plistContent: '<candidate-plist/>',
    domain: 'gui/501',
    serviceTarget: 'gui/501/label',
    runLaunchctl,
    waitForHealth: okHealth,
    sleep: sleep0,
  });

  assert.equal(result.ok, false);
  assert.equal(result.stage, 'pre_install_bootout');
  assert.equal(fs.existsSync(plistPath), false);
  assert.equal(runLaunchctl.calls.length, 1);
});

test('T5 uninstall success removes the plist when bootout succeeds', () => {
  const plistPath = tmpPlistPath();
  fs.writeFileSync(plistPath, '<plist/>', 'utf8');

  const runLaunchctl = launchctlSequence([{ status: 0, stdout: '', stderr: '' }]);
  const result = uninstallXCoderLaunchAgent({ plistPath, serviceTarget: 'gui/501/label', runLaunchctl });

  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(plistPath), false);
});

test('T5b uninstall is idempotent when the service was already not loaded', () => {
  const plistPath = tmpPlistPath();
  fs.writeFileSync(plistPath, '<plist/>', 'utf8');

  const runLaunchctl = launchctlSequence([
    { status: 3, stdout: '', stderr: 'Could not find service "label" in domain for port' },
  ]);
  const result = uninstallXCoderLaunchAgent({ plistPath, serviceTarget: 'gui/501/label', runLaunchctl });

  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(plistPath), false);
});

test('T6 uninstall failure semantics: an unexpected bootout error is not reported as success', () => {
  const plistPath = tmpPlistPath();
  fs.writeFileSync(plistPath, '<plist/>', 'utf8');

  const runLaunchctl = launchctlSequence([
    { status: 1, stdout: '', stderr: 'Operation not permitted' },
  ]);
  const result = uninstallXCoderLaunchAgent({ plistPath, serviceTarget: 'gui/501/label', runLaunchctl });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'bootout_failed');
  assert.equal(fs.existsSync(plistPath), true, 'plist is left in place so the known-loaded state is not silently discarded');
});

test('T7 benign-failure classifier recognizes common already-unloaded launchctl phrasing', () => {
  assert.equal(__testing.isBenignBootoutFailure({ status: 0 }), true);
  assert.equal(__testing.isBenignBootoutFailure({ status: 3, stderr: 'Could not find service' }), true);
  assert.equal(__testing.isBenignBootoutFailure({ status: 3, stdout: 'No such process' }), true);
  assert.equal(__testing.isBenignBootoutFailure({ status: 1, stderr: 'Operation not permitted' }), false);
});
