import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const main = await fs.promises.readFile(new URL('../electron/main.cjs', import.meta.url), 'utf8');

const readyStart = main.indexOf('app.whenReady().then(async () => {');
const beforeQuitStart = main.indexOf("app.on('before-quit'", readyStart);
assert.ok(readyStart >= 0 && beforeQuitStart > readyStart, 'Electron startup block must exist');
const startup = main.slice(readyStart, beforeQuitStart);

test('1. startup health marker is written only after the main window is created', () => {
  const createWindowIndex = startup.lastIndexOf('  createWindow();');
  const markerIndex = startup.indexOf("await localUpdater.recordStartupSuccess(app.getPath('userData'));");
  assert.ok(createWindowIndex >= 0, 'startup must create the main window');
  assert.ok(markerIndex > createWindowIndex, 'startup success marker must follow main window creation');
});

test('2. connection infrastructure initializes before window and startup marker', () => {
  const connections = startup.indexOf('await initConnections();');
  const createWindow = startup.lastIndexOf('    createWindow();');
  const marker = startup.indexOf("await localUpdater.recordStartupSuccess(app.getPath('userData'));");
  assert.ok(connections >= 0 && connections < createWindow && createWindow < marker);
  assert.doesNotMatch(startup, /GoalRunner|XQueueCoordinator|InvestMonitor/);
});

test('3. startup health marker has one main-process owner and is not written inside createWindow', () => {
  const markerCall = "localUpdater.recordStartupSuccess(app.getPath('userData'))";
  assert.equal(main.split(markerCall).length - 1, 1, 'main process must have exactly one startup marker call');

  const createWindowStart = main.indexOf('const createWindow = () => {');
  const createWindowEnd = main.indexOf('const getUpdaterInfo =', createWindowStart);
  assert.ok(createWindowStart >= 0 && createWindowEnd > createWindowStart);
  const createWindowBody = main.slice(createWindowStart, createWindowEnd);
  assert.equal(createWindowBody.includes('recordStartupSuccess'), false, 'window creation itself must not mark startup healthy');
});

test('4. window creation failure cannot fall through to the health marker', () => {
  const tailStart = startup.lastIndexOf('    createWindow();');
  const activateIndex = startup.indexOf("app.on('activate'", tailStart);
  assert.ok(tailStart >= 0 && activateIndex > tailStart);
  const tail = startup.slice(tailStart, activateIndex);

  const createWindowIndex = tail.indexOf('createWindow();');
  const markerIndex = tail.indexOf("await localUpdater.recordStartupSuccess(app.getPath('userData'));");
  assert.ok(createWindowIndex >= 0 && markerIndex > createWindowIndex);
  assert.equal(tail.slice(createWindowIndex, markerIndex).includes('catch'), false, 'createWindow failure must not be swallowed before marker');
  assert.equal(tail.slice(createWindowIndex, markerIndex).includes('finally'), false, 'marker must not run from a finally path');
});
