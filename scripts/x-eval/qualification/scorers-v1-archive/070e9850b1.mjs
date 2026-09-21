// Hidden scorer: a same-version build that is NOT newer (by builtAt) must never be
// reported as an update or installed; dev mode never offers/installs; a genuinely
// newer build still installs. Independent of the visible test: own fixtures, and
// it goes through inspectUpdate/installUpdate (which exist before and after the fix)
// so parent failure is behavioral, not "function missing".
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createScorer, parseRoot } from './_lib.mjs';

const root = parseRoot();
const s = createScorer();
const require = createRequire(path.join(root, 'x.cjs'));
const updater = require('./electron/updater.cjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xeval-upd-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

const writeApp = (dir, label) => {
  const app = path.join(dir, 'Hearth Control.app');
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'Hearth Control'), label);
  return app;
};
let counter = 0;
const makeUpdate = async ({ version, buildId, builtAt }) => {
  const dir = fs.mkdtempSync(path.join(tmp, `u${counter += 1}-`));
  const app = writeApp(dir, buildId);
  fs.writeFileSync(path.join(dir, 'update-manifest.json'), JSON.stringify({
    version, buildId, builtAt, platform: process.platform, arch: process.arch, appPath: 'Hearth Control.app', sha256: await updater.sha256Directory(app),
  }));
  return dir;
};
const inspect = (dir, running) => updater.inspectUpdate({
  updateDirectory: dir, currentVersion: running.version, currentBuildId: running.buildId, currentBuiltAt: running.builtAt,
  isPackaged: running.isPackaged ?? true, platform: process.platform, arch: process.arch,
});
const install = async (dir, running) => {
  const manifest = await updater.readAndValidateManifest(dir, process.platform, process.arch);
  const applications = fs.mkdtempSync(path.join(tmp, 'Applications-'));
  writeApp(applications, 'old-build');
  let helper = false;
  const promise = updater.installUpdate({
    manifest, currentVersion: running.version, currentBuiltAt: running.builtAt, isPackaged: running.isPackaged ?? true,
    applicationsDirectory: applications, userDataPath: fs.mkdtempSync(path.join(tmp, 'ud-')), userApproved: true,
    launchRollbackHelper: async () => { helper = true; },
  });
  return { promise, applications, helperCalled: () => helper };
};

const RUNNING = { version: '0.5.0', buildId: '0.5.0-20260920100000-aaaaaa', builtAt: '2026-09-20T10:00:00.000Z' };
const STALE = { version: '0.5.0', buildId: '0.5.0-20260919090000-bbbbbb', builtAt: '2026-09-19T09:00:00.000Z' };
const FRESH = { version: '0.5.0', buildId: '0.5.0-20260921090000-cccccc', builtAt: '2026-09-21T09:00:00.000Z' };
const HIGHER = { version: '0.6.0', buildId: '0.6.0-20260901000000-dddddd', builtAt: '2026-09-01T00:00:00.000Z' };
const LOWER = { version: '0.4.9', buildId: '0.4.9-20260930000000-eeeeee', builtAt: '2026-09-30T00:00:00.000Z' };

await s.check('same version, manifest older than the running build (different buildId) -> up_to_date', async () => {
  assert.equal((await inspect(await makeUpdate(STALE), RUNNING)).state, 'up_to_date');
});
await s.check('same version, manifest newer than the running build -> update_ready', async () => {
  assert.equal((await inspect(await makeUpdate(FRESH), RUNNING)).state, 'update_ready');
});
await s.check('same version, running build has no builtAt -> fails closed (up_to_date)', async () => {
  assert.equal((await inspect(await makeUpdate(FRESH), { ...RUNNING, builtAt: null })).state, 'up_to_date');
});
await s.check('higher version is offered even if built earlier', async () => {
  assert.equal((await inspect(await makeUpdate(HIGHER), RUNNING)).state, 'update_ready');
});
await s.check('lower version is never offered, even if built later', async () => {
  assert.equal((await inspect(await makeUpdate(LOWER), RUNNING)).state, 'up_to_date');
});
await s.check('development mode never reports update_ready', async () => {
  assert.notEqual((await inspect(await makeUpdate(HIGHER), { ...RUNNING, isPackaged: false })).state, 'update_ready');
});
await s.check('installUpdate refuses a stale same-version manifest and installs nothing', async () => {
  const { promise, applications, helperCalled } = await install(await makeUpdate(STALE), RUNNING);
  await assert.rejects(promise);
  assert.equal(helperCalled(), false, 'rollback helper must not be scheduled');
  assert.equal(fs.readFileSync(path.join(applications, 'Hearth Control.app', 'Contents', 'MacOS', 'Hearth Control'), 'utf8'), 'old-build', 'installed app must be untouched');
});
await s.check('installUpdate refuses in development mode', async () => {
  const { promise } = await install(await makeUpdate(HIGHER), { ...RUNNING, isPackaged: false });
  await assert.rejects(promise);
});
await s.check('control: installUpdate still installs a genuinely newer build (backup kept, helper scheduled)', async () => {
  const { promise, applications, helperCalled } = await install(await makeUpdate(FRESH), RUNNING);
  const result = await promise;
  assert.equal(result.state, 'restarting');
  assert.equal(helperCalled(), true);
  assert.equal(fs.readFileSync(path.join(applications, 'Hearth Control.previous.app', 'Contents', 'MacOS', 'Hearth Control'), 'utf8'), 'old-build');
});
s.finish();
