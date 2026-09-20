import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const main = fs.readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
const preload = fs.readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
const tools = fs.readFileSync(new URL('../mcp/tools.mjs', import.meta.url), 'utf8');

const start = main.indexOf("if (route === 'market')");
const end = main.indexOf("\n  const fingerprint = computeHearthJobFingerprint(job);", start + 1);
assert.ok(start >= 0 && end > start, 'market route block must exist');
const market = main.slice(start, end);

test('Market Main V1.1 market route uses its dedicated MarketResearch permission boundary', () => {
  assert.match(market, /readSettings\(\)\.permissions\?\.MarketResearch \?\? 'Ask'/);
  assert.match(market, /requestHearthJobPermissionApproval\(/);
  assert.match(market, /'MarketResearch'/);
  assert.match(market, /shared\.abort\.signal\.aborted/);
  assert.match(market, /shared\.waiters\.size === 0/);
  assert.match(market, /serverProcess !== child/);
});

test('Market Main V1.2 market route reuses TaskStore and no new runtime/store', () => {
  assert.match(market, /taskStore\.getTask\(taskId\)/);
  assert.match(market, /taskStore\.saveTask\(runningTask\)/);
  assert.match(market, /taskStore\.saveTask\(\{/);
  assert.match(market, /resolvedRoute: 'mcp'/);
  assert.doesNotMatch(market, /new TaskStore|new JobManager|new XQueueStore|new XRunStore/);
});

test('Market Main V1.3 market route calls live Search and Invest pipelines', () => {
  assert.match(market, /runLiveXauSearch/);
  assert.match(market, /runLiveXauInvestment/);
  assert.match(market, /job\.kind === 'market_search'/);
  assert.match(market, /route: 'market'/);
  assert.match(market, /publicHearthMarketStatus/);
});

test('Market Main V1.4 market inflight cancellation is bounded', () => {
  assert.match(main, /const hearthJobMarketInflight = new Map\(\)/);
  assert.match(main, /waiter\.marketInflight\.waiters\.delete\(transportId\)/);
  assert.match(main, /!waiter\.marketInflight\.committed && waiter\.marketInflight\.waiters\.size === 0/);
  assert.match(main, /marketInflight: null/);
});

test('Market Main V1.5 universal tool descriptions expose market route without caller worker selection', () => {
  assert.match(tools, /XAU\/USD Market Specialist/);
  const submitStart = tools.indexOf("server.registerTool('hearth_job_submit'");
  const submitEnd = tools.indexOf("server.registerTool('hearth_job_status'", submitStart);
  const submit = tools.slice(submitStart, submitEnd);
  assert.doesNotMatch(submit, /worker\s*:/);
  assert.doesNotMatch(submit, /provider\s*:/);
});

test('Market Main V1.6 Invest Mode Controller restores before exposing bounded local controls', () => {
  assert.match(main, /new InvestModeFileStore\(\{ storagePath: investModePath \}\)/);
  assert.match(main, /investModeController\.restore\(\)/);
  assert.match(main, /ipcMain\.handle\('invest-mode:get'/);
  assert.match(main, /ipcMain\.handle\('invest-mode:set'/);
  assert.match(main, /ipcMain\.handle\('invest-mode:kill-switch'/);
  assert.match(preload, /investModeGet: \(\) => ipcRenderer\.invoke\('invest-mode:get'\)/);
  assert.match(preload, /investModeSet: \(mode\) => ipcRenderer\.invoke\('invest-mode:set', mode\)/);
  assert.match(preload, /investModeKillSwitch: \(\) => ipcRenderer\.invoke\('invest-mode:kill-switch'\)/);
  assert.match(main, /ipcMain\.handle\('invest-status:get'/);
  assert.match(main, /mt5BridgeServer\?\.status\?\.\(\)/);
  assert.match(preload, /investStatusGet: \(\) => ipcRenderer\.invoke\('invest-status:get'\)/);
});
