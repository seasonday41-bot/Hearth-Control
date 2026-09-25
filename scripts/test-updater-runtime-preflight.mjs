import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const updater = require('../electron/updater.cjs');

const blocker = (state) => updater.evaluateUpdaterRuntimePreflight(state);

test('1. active X blocks updater install preflight', () => {
  const result = blocker({ xActive: true });
  assert.equal(result.code, updater.UPDATE_RUNTIME_BLOCKERS.X_ACTIVE);
  assert.deepEqual(updater.blockedUpdateResult(result), {
    state: 'update_ready',
    blocked: true,
    blocker: 'X_ACTIVE',
    message: 'Update installation is blocked while X is active.',
  });
});

test('2. active Goal blocks updater install preflight', () => {
  const result = blocker({ goalActive: true });
  assert.equal(result.code, updater.UPDATE_RUNTIME_BLOCKERS.GOAL_ACTIVE);
});

test('3. queued durable job blocks updater install preflight', () => {
  const result = blocker({ queuedJobCount: 1 });
  assert.equal(result.code, updater.UPDATE_RUNTIME_BLOCKERS.DURABLE_JOB_ACTIVE);
});

test('4. running durable job blocks updater install preflight', () => {
  const result = blocker({ runningJobCount: 1 });
  assert.equal(result.code, updater.UPDATE_RUNTIME_BLOCKERS.DURABLE_JOB_ACTIVE);
});

test('5. updater busy blocks a concurrent install attempt', () => {
  const result = blocker({ updaterBusy: true });
  assert.equal(result.code, updater.UPDATE_RUNTIME_BLOCKERS.UPDATER_BUSY);
});

test('6. Electron preflight checks durable generic jobs and MCP server state', async () => {
  const main = await fs.promises.readFile(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  const start = main.indexOf('const getUpdaterRuntimeBlocker =');
  const end = main.indexOf('const startRollbackWatchdog =', start);
  assert.ok(start >= 0 && end > start, 'updater runtime preflight helper must exist');
  const helper = main.slice(start, end);

  assert.ok(helper.includes('queuedJobCount: pendingGenericJobs()'));
  assert.ok(helper.includes('runningJobCount: serverState.running ? 1 : 0'));
  assert.equal(helper.includes('xGetNextWakeupDeadline'), false);
});

test('7. no blocker preserves the existing approval/install path and required ordering', async () => {
  assert.equal(blocker({}), null);

  const main = await fs.promises.readFile(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  const start = main.indexOf("ipcMain.handle('updater:install'");
  const end = main.indexOf('    createWindow();', start);
  assert.ok(start >= 0 && end > start, 'updater install IPC handler must exist');
  const handler = main.slice(start, end);

  const sender = handler.indexOf('event.sender.id !== mainWindow.webContents.id');
  const inspect = handler.indexOf('inspectLocalUpdateDirectory(');
  const helperStart = main.indexOf('const inspectLocalUpdateDirectory =');
  const helperEnd = main.indexOf('const getInstallUpdateDirectory =', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'candidate inspection helper must exist');
  assert.ok(main.slice(helperStart, helperEnd).includes('localUpdater.inspectUpdate({'), 'candidate inspection helper must still use the existing local updater');
  const initialPreflight = handler.indexOf('const initialBlocker = getUpdaterRuntimeBlocker();');
  const acquireBusy = handler.indexOf('updaterInstallInProgress = true;');
  const approval = handler.indexOf('dialog.showMessageBox');
  const revalidate = handler.indexOf('localUpdater.readAndValidateManifest');
  const latePreflight = handler.indexOf('getUpdaterRuntimeBlocker({ ignoreUpdaterBusy: true })');
  const install = handler.indexOf('localUpdater.installUpdate(');

  assert.ok(sender >= 0);
  assert.ok(inspect > sender);
  assert.ok(initialPreflight > inspect);
  assert.ok(acquireBusy > initialPreflight);
  assert.ok(approval > acquireBusy);
  assert.ok(revalidate > approval);
  assert.ok(latePreflight > revalidate);
  assert.ok(install > latePreflight);
  assert.ok(handler.includes('userApproved: true'), 'existing core approval gate must remain enabled');
});

test('8. cancelled native approval exits before revalidation or install', async () => {
  const main = await fs.promises.readFile(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  const start = main.indexOf("ipcMain.handle('updater:install'");
  const end = main.indexOf('    createWindow();', start);
  const handler = main.slice(start, end);

  const approval = handler.indexOf('dialog.showMessageBox');
  const cancel = handler.indexOf('if (approval.response !== 0)');
  const cancelledReturn = handler.indexOf('cancelled: true', cancel);
  const revalidate = handler.indexOf('localUpdater.readAndValidateManifest');
  const install = handler.indexOf('localUpdater.installUpdate(');

  assert.ok(approval >= 0 && cancel > approval);
  assert.ok(cancelledReturn > cancel);
  assert.ok(revalidate > cancelledReturn);
  assert.ok(install > revalidate);
});

test('9. remote/MCP/Goal/X inputs cannot supply a preflight bypass flag', async () => {
  const attemptedBypass = blocker({ xActive: true, bypass: true, ignoreRuntimePreflight: true });
  assert.equal(attemptedBypass.code, updater.UPDATE_RUNTIME_BLOCKERS.X_ACTIVE);

  const preload = await fs.promises.readFile(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
  assert.ok(preload.includes("updaterInstall: () => ipcRenderer.invoke('updater:install')"));
  assert.equal(preload.includes("ipcRenderer.invoke('updater:install',"), false);

  const main = await fs.promises.readFile(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  const start = main.indexOf("ipcMain.handle('updater:install'");
  const end = main.indexOf('    createWindow();', start);
  const handler = main.slice(start, end);
  assert.ok(handler.startsWith("ipcMain.handle('updater:install', async (event) =>"));
  const executableHandler = handler
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  assert.equal(/\b(?:bypass|skipPreflight|ignoreRuntimePreflight)\b/i.test(executableHandler), false);
});
