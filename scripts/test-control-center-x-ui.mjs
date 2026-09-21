import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const preload = fs.readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
const main = fs.readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');

test('Control Center Tasks separates X, Antigravity, and Remote surfaces with X first', () => {
  assert.match(app, /useState<'x' \| 'antigravity' \| 'remote'>\('x'\)/);
  assert.match(app, /aria-label="Task execution surfaces"/);
  assert.match(app, />X<\/span>/);
  assert.match(app, />Antigravity<\/span>/);
  assert.match(app, />Remote<\/span>/);
});

test('X and legacy remote requests are split by the existing routedTo authority', () => {
  assert.match(app, /pendingTasks\.filter\(\(task\) => task\.routedTo === 'x'\)/);
  assert.match(app, /pendingTasks\.filter\(\(task\) => task\.routedTo !== 'x'\)/);
  assert.match(app, /xPendingTasks\.map/);
  assert.match(app, /remotePendingTasks\.map/);
});

test('X approval still uses the existing bridge approval path and one-time X approval lifecycle', () => {
  assert.match(app, /window\.controlApp\.bridgeApproveTask\(task\.id\)/);
  assert.match(app, /Approve & Request Access/);
  assert.match(app, /Allow X access\?/);
  assert.match(app, /window\.controlApp\.respondToApproval/);
  assert.doesNotMatch(app, /window\.controlApp\.(?:xStart|xEnqueue)/);
});

test('Renderer X status API is read-only and projects existing durable receipt truth', () => {
  assert.match(preload, /xQueueStatus: \(requestId\) => ipcRenderer\.invoke\('x:queue-status', requestId\)/);
  assert.match(main, /ipcMain\.handle\('x:queue-status'/);
  assert.match(main, /xQueueReceiptStatus\(xQueueStore\?\.getReceipt\(requestId\.trim\(\)\)\)/);
  const start = main.indexOf("ipcMain.handle('x:queue-status'");
  const end = main.indexOf("ipcMain.handle('invest-mode:get'", start);
  const block = main.slice(start, end);
  assert.doesNotMatch(block, /enqueue|dispatchXTask|ingestXTask|requestXApproval/);
});

test('X approval no longer creates an Antigravity-shaped pending task', () => {
  const start = app.indexOf('const handleApproveRemoteTask = async');
  const end = app.indexOf('const handleRejectRemoteTask = async', start);
  const block = app.slice(start, end);
  assert.match(block, /if \(task\.routedTo !== 'x'\)/);
  assert.match(block, /setActiveXRequestId\(res\.taskId\)/);
  assert.match(block, /setTaskCenterTab\('x'\)/);
});
