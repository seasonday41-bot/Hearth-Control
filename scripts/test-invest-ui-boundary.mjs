import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const types = fs.readFileSync(new URL('../src/electron.d.ts', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../src/calm-control.css', import.meta.url), 'utf8');
const main = fs.readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');

test('Invest UI exposes the three bounded modes and kill switch', () => {
  assert.match(app, /name: 'Invest'/);
  assert.match(app, /\['OFF', 'MONITOR', 'DEMO_AUTO'\] as InvestModeName\[\]/);
  assert.match(app, /window\.controlApp\.investModeSet\(mode\)/);
  assert.match(app, /window\.controlApp\.investModeKillSwitch\(\)/);
  assert.match(app, /KILL SWITCH/);
  assert.match(types, /trade_execution_enabled: boolean/);
  assert.match(types, /demo_session_id: string \| null/);
  assert.doesNotMatch(app, /sendOrder|placeOrder|executeTrade|executeDemoOrder/);
});

test('Invest UI separates V1 analysis, V2 setups, explicit Risk, and execution evidence', () => {
  assert.match(app, /demo-only execution boundary/);
  assert.match(app, /A Mac notification will appear after a new signal is saved/);
  assert.match(app, /DEMO EXECUTOR/);
  assert.match(app, /No renderer order button exists/);
  assert.match(app, /V2 TECHNICAL SETUPS/);
  assert.match(app, /H1 context · M15 setup · M5 trigger/);
  assert.match(app, /DEMO RISK RULES/);
  assert.match(app, /Hearth does not create hidden risk defaults/);
  assert.match(app, /V1 ANALYSIS · INFORMATION ONLY/);
  assert.match(app, /EXECUTION JOURNAL/);
  assert.match(app, /investStatus\.signals/);
  assert.match(app, /investStatus\.executions\.map/);
  assert.match(app, /window\.controlApp\.investRiskConfigSet/);
  assert.match(app, /KILL SWITCH blocks new demo orders/);
  assert.match(app, /Live accounts are rejected/);
});

test('Search AI uses dedicated MarketResearch permission, not Browser automation', () => {
  assert.match(app, /name: 'MarketResearch'/);
  assert.match(app, /It does not require Browser automation/);
  assert.match(app, /General browser automation — unavailable and unrelated to Market Research/);
  assert.match(main, /MarketResearch: 'Ask'/);
  assert.match(main, /permissions\?\.MarketResearch/);
  assert.doesNotMatch(main.slice(main.indexOf("if (route === 'market')"), main.indexOf("const fingerprint = computeHearthJobFingerprint", main.indexOf("if (route === 'market')") + 1)), /permissions\?\.Browser/);
});

test('Invest page includes responsive status and controller styling', () => {
  assert.match(css, /\.invest-status-grid/);
  assert.match(css, /\.invest-mode-buttons/);
  assert.match(css, /\.invest-kill-switch/);
  assert.match(css, /\.invest-signal-list/);
  assert.match(css, /\.invest-v2-grid/);
  assert.match(css, /\.invest-risk-grid/);
  assert.match(css, /@media \(max-width: 700px\)/);
});

test('Invest UI shows one latest V1 card by default and keeps older analysis behind History', () => {
  assert.ok(app.includes('showV1History ? investStatus.signals : investStatus.signals.slice(0, 1)'));
  assert.ok(app.includes('History ('));
  assert.ok(app.includes('Hide history'));
});
