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

test('2. essential local runtime initialization completes before window creation and health marker', () => {
  const taskStoreIndex = startup.indexOf('taskStore = new TaskStore(');
  const jobManagerIndex = startup.indexOf('jobManager = new JobManager(');
  const goalRunnerIndex = startup.indexOf('goalRunner = new GoalRunner(');
  const xRuntimeIndex = startup.indexOf('xQueueCoordinator = new XQueueCoordinator(');
  const createWindowIndex = startup.lastIndexOf('  createWindow();');
  const markerIndex = startup.indexOf("await localUpdater.recordStartupSuccess(app.getPath('userData'));");

  for (const [name, index] of [
    ['TaskStore', taskStoreIndex],
    ['JobManager', jobManagerIndex],
    ['GoalRunner', goalRunnerIndex],
    ['X runtime', xRuntimeIndex],
  ]) {
    assert.ok(index >= 0, `${name} initialization must exist`);
    assert.ok(index < createWindowIndex, `${name} initialization must precede main window creation`);
    assert.ok(index < markerIndex, `${name} initialization must precede startup success marker`);
  }
});

test('3. startup health marker has one main-process owner and is not written inside createWindow', () => {
  const markerCall = "localUpdater.recordStartupSuccess(app.getPath('userData'))";
  assert.equal(main.split(markerCall).length - 1, 1, 'main process must have exactly one startup marker call');

  const createWindowStart = main.indexOf('const createWindow = () => {');
  const createWindowEnd = main.indexOf('const hasSingleInstanceLock', createWindowStart);
  assert.ok(createWindowStart >= 0 && createWindowEnd > createWindowStart);
  const createWindowBody = main.slice(createWindowStart, createWindowEnd);
  assert.equal(createWindowBody.includes('recordStartupSuccess'), false, 'window creation itself must not mark startup healthy');
});

test('4. window creation failure cannot fall through to the health marker', () => {
  const tailStart = startup.lastIndexOf('// The updater watchdog accepts this main-process marker');
  const activateIndex = startup.indexOf("app.on('activate'", tailStart);
  assert.ok(tailStart >= 0 && activateIndex > tailStart);
  const tail = startup.slice(tailStart, activateIndex);

  const createWindowIndex = tail.indexOf('createWindow();');
  const markerIndex = tail.indexOf("await localUpdater.recordStartupSuccess(app.getPath('userData'));");
  assert.ok(createWindowIndex >= 0 && markerIndex > createWindowIndex);
  assert.equal(tail.slice(createWindowIndex, markerIndex).includes('catch'), false, 'createWindow failure must not be swallowed before marker');
  assert.equal(tail.slice(createWindowIndex, markerIndex).includes('finally'), false, 'marker must not run from a finally path');
});
