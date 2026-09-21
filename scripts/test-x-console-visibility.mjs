import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { rendererSource } from './lib/renderer-source.mjs';
import os from 'node:os';
import path from 'node:path';
import { XRunStore } from '../mcp/x/run-store.mjs';

const app = rendererSource();
const preload = fs.readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
const main = fs.readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
const tools = fs.readFileSync(new URL('../mcp/tools.mjs', import.meta.url), 'utf8');

test('direct x_start obeys the existing X permission boundary before runXTask', () => {
  const start = tools.indexOf("server.registerTool('x_start'");
  const end = tools.indexOf("server.registerTool('x_task'", start);
  const block = tools.slice(start, end);
  const permission = block.indexOf("requirePermission('X'");
  const run = block.indexOf('runXTask(');
  assert.ok(permission >= 0, 'x_start must require X permission');
  assert.ok(run > permission, 'permission check must happen before runXTask');
});

test('XRunStore can list recent runs newest first without mutation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-x-console-'));
  const dbPath = path.join(dir, 'runtime.sqlite');
  const store = new XRunStore({ storagePath: dbPath });
  const originalNow = store.now.bind(store);
  let now = 1000;
  store.now = () => now++;
  store.createRun({ runId: 'run-a', taskId: 'task-a' });
  store.createRun({ runId: 'run-b', taskId: 'task-b' });
  const rows = store.listRecentRuns(10);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].runId, 'run-b');
  assert.equal(rows[1].runId, 'run-a');
  assert.equal(store.getRun('run-a').status, 'queued');
  store.now = originalNow;
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('renderer has a read-only recent X runs IPC and no execution authority on that path', () => {
  assert.match(preload, /xListRuns: \(limit = 20\) => ipcRenderer\.invoke\('x:runs-list', limit\)/);
  assert.match(main, /ipcMain\.handle\('x:runs-list'/);
  const start = main.indexOf("ipcMain.handle('x:runs-list'");
  const end = main.indexOf("ipcMain.handle('invest-mode:get'", start);
  const block = main.slice(start, end);
  assert.match(block, /xRunStore\.listRecentRuns/);
  assert.doesNotMatch(block, /runXTask|ingestXTask|enqueue|dispatch|approve|retry|cancel/);
});

test('Console and X Tasks both render live/recent X run state', () => {
  assert.match(app, /xListRuns\(20\)/);
  assert.match(app, /Live & recent runs/);
  assert.match(app, /Current & recent X runs/);
  assert.match(app, /recentXRuns\.slice\(0, 8\)/);
  assert.match(app, /recentXRuns\.slice\(0, 6\)/);
  assert.match(app, /result\?\.blockers\?\.\[0\]\?\.detail/);
});
