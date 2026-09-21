import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GoalStorage } from '../mcp/goals/storage.mjs';

const app = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const connectors = fs.readFileSync(new URL('../src/components/AIConnectorPanel.tsx', import.meta.url), 'utf8');
const preload = fs.readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
const main = fs.readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
const runner = fs.readFileSync(new URL('../mcp/goals/runner.mjs', import.meta.url), 'utf8');

test('P9.1 Workspace AI Connectors renders X, GPT, Codex, Anti, Claude and global AgentDock is removed', () => {
  assert.match(app, /<AIConnectorPanel connectors=\{connectorItems\}/);
  assert.doesNotMatch(app, /<AgentDock/);
  for (const id of ['x', 'gpt', 'codex', 'anti', 'claude']) {
    assert.match(app, new RegExp("id: '" + id + "'"));
  }
  assert.match(connectors, /Connector switches affect new work only/);
  assert.doesNotMatch(connectors, /token|credential|workspaceRoot|repair_budget/i);
});

test('P9.2 X, Codex and Anti toggles map to real permission settings; GPT maps to Remote Bridge', () => {
  assert.match(app, /name: 'X'/);
  assert.match(app, /name: 'Codex'/);
  assert.match(app, /setPermissionEnabled/);
  assert.match(app, /enabled \? 'Ask' : 'Blocked'/);
  assert.match(app, /setConnectorEnabled/);
  assert.match(app, /setPermissionEnabled\('X', enabled\)/);
  assert.match(app, /setPermissionEnabled\('Codex', enabled\)/);
  assert.match(app, /setPermissionEnabled\('Antigravity', enabled\)/);
  assert.match(app, /void toggleBridge\(\)/);
});

test('P9.3 Codex connector status is read from the real CLI resolver and Blocked prevents dispatch', () => {
  assert.match(preload, /codexStatus: \(\) => ipcRenderer\.invoke\('specialists:codex-status'\)/);
  assert.match(main, /ipcMain\.handle\('specialists:codex-status'/);
  assert.match(main, /resolveCodexBinary/);
  assert.match(main, /permissions\?\.Codex/);
  assert.match(main, /codex_permission_blocked/);
});

test('P9.4 Claude shows CLI availability without claiming a connected session or adding a toggle', () => {
  const start = app.indexOf("id: 'claude'");
  const end = app.indexOf('];', start);
  const block = app.slice(start, end);
  assert.match(preload, /claudeStatus: \(\) => ipcRenderer\.invoke\('specialists:claude-status'\)/);
  assert.match(main, /ipcMain\.handle\('specialists:claude-status'/);
  assert.match(app, /window\.controlApp\.claudeStatus\(\)/);
  assert.match(block, /state: claudeAvailable \? 'Available' : 'Unavailable'/);
  assert.match(block, /Claude CLI detected; Hearth session not verified/);
  assert.doesNotMatch(block, /state:.*'Connected'/);
  assert.match(block, /canToggle: false/);
  assert.match(block, /enabled: false/);
  assert.match(connectors, /status: \$\{connector\.state\}/);
});

test('P9.5 Goal clear-history IPC exists and no generic destructive clear-all IPC is exposed', () => {
  assert.match(preload, /goalsClearHistory: \(\) => ipcRenderer\.invoke\('goals:clear-history'\)/);
  assert.match(main, /ipcMain\.handle\('goals:clear-history'/);
  assert.match(runner, /clear_goal_history\(\)/);
  assert.match(runner, /this\.storage\.clearGoalHistory\(\)/);
  assert.doesNotMatch(preload, /goalsClearAll|goalsDeleteAll/);
});

test('P9.6 GoalStorage clear history removes only completed/error goals', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-p9-goals-'));
  const storage = new GoalStorage({ storagePath: path.join(dir, 'goals.json') });
  storage.load();

  const make = (id, status) => ({
    id,
    title: id,
    objective: 'test',
    workspace: dir,
    status,
    steps: [],
    checkpoints: [],
    constraints: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  for (const [id, status] of [
    ['done', 'completed'],
    ['bad', 'error'],
    ['ready', 'ready'],
    ['running', 'running'],
    ['waiting', 'waiting'],
    ['paused', 'paused'],
    ['draft', 'draft'],
  ]) storage.saveGoal(make(id, status));

  const result = storage.clearGoalHistory();
  assert.deepEqual(result.removedIds.sort(), ['bad', 'done']);
  assert.deepEqual(storage.listGoals().map((goal) => goal.id).sort(), ['draft', 'paused', 'ready', 'running', 'waiting']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('P9.7 Goals UI exposes clear history with confirmation and terminal count only', () => {
  assert.match(app, /terminalGoalCount/);
  assert.match(app, /Clear history/);
  assert.match(app, /showClearGoalsConfirm/);
  assert.match(app, /completed.*error|error.*completed/);
});

test('P9.8 P9 connector component does not create execution/runtime authority', () => {
  assert.doesNotMatch(connectors, /hearth_job_submit|ingestXTask|startAntigravityTask|GoalRunner|JobManager/);
});
