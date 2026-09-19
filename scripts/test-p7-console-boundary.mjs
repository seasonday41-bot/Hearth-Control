import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const styles = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const main = fs.readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
const preload = fs.readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');

const consoleStart = app.indexOf("activeNav === 'Console'");
const consoleEnd = app.indexOf("activeNav === 'Task Console'", consoleStart);
assert.ok(consoleStart >= 0 && consoleEnd > consoleStart, 'P7 Console render branch must exist');
const consoleBlock = app.slice(consoleStart, consoleEnd);
const managementStart = app.indexOf('const connectManagedConnection');
const managementEnd = app.indexOf('const navigate', managementStart);
assert.ok(managementStart >= 0 && managementEnd > managementStart, 'P7 connection management handlers must exist');
const managementBlock = app.slice(managementStart, managementEnd);

test('P7.1 Console is a first-class navigation surface without replacing existing pages', () => {
  assert.match(app, /type NavItem = [^\n]*'Console'/);
  assert.match(app, /\{ name: 'Console', icon: 'activity' \}/);
  for (const existing of ['Overview', 'Local Chat', 'Storage Audit', 'Task Console', 'Goals', 'Workspace', 'Permissions', 'Logs']) {
    assert.match(app, new RegExp("'" + existing + "'"));
  }
});

test('P7.2 Console uses safe list/refresh plus only the existing local GitHub/Vercel management IPC', () => {
  assert.match(consoleBlock, /refreshConnections\(\)/);
  assert.match(consoleBlock, /refreshConnections\(connection\.alias\)/);
  assert.match(app, /window\.controlApp\.connectionsList\(\)/);
  assert.match(app, /window\.controlApp\.connectionsRefresh\(alias\)/);
  assert.match(managementBlock, /window\.controlApp\.githubConnect/);
  assert.match(managementBlock, /window\.controlApp\.githubDisconnect/);
  assert.match(managementBlock, /window\.controlApp\.vercelConnect/);
  assert.match(managementBlock, /window\.controlApp\.vercelDisconnect/);
  assert.doesNotMatch(managementBlock, /publicTasksSaveAnonKey|bridgeSignIn|goalsRun|antigravityStart/);
});

test('P7.2 Console never renders provider target/auth/credential/token material', () => {
  assert.doesNotMatch(consoleBlock, /connection\.(?:target|auth|credentialRef|accessToken|refreshToken)/);
  assert.doesNotMatch(consoleBlock, /JSON\.stringify\(connection\)/);
  assert.doesNotMatch(consoleBlock, /Authorization|Bearer/);
  assert.match(consoleBlock, /Stored provider targets, credentials, tokens, and ciphertext are never read back or rendered/);
  assert.match(consoleBlock, /type="password"/);
  assert.match(consoleBlock, /autoComplete="new-password"/);
  assert.match(managementBlock, /setConnectionTokenInputs\(\(current\) => \(\{ \.\.\.current, \[connection\.alias\]: '' \}\)\)/);
  assert.doesNotMatch(managementBlock, /localStorage|saveSettings|setLogs/);
});

test('P7.2 Supabase management is not duplicated in Console', () => {
  assert.match(consoleBlock, /connection\.provider === 'supabase'/);
  assert.match(consoleBlock, /Remote Bridge \/ Project X surfaces/);
  assert.doesNotMatch(managementBlock, /publicTasksSignIn|bridgeSignIn|supabase.*Connect/i);
});

test('P7.3 pending approvals are visible but Console has no decision path', () => {
  assert.match(consoleBlock, /approvalQueue\.map/);
  assert.match(consoleBlock, /The Console cannot allow or deny requests/);
  assert.doesNotMatch(consoleBlock, /answerApproval|respondToApproval|Allow once|Deny/);
});

test('P7.4 approval evidence is bounded and records request plus resolution lifecycle', () => {
  assert.match(app, /const APPROVAL_EVIDENCE_LIMIT = 40/);
  assert.match(app, /recordApprovalRequested/);
  assert.match(app, /recordApprovalResolved/);
  assert.match(app, /slice\(-APPROVAL_EVIDENCE_LIMIT\)/);
  assert.match(app, /event\.type === 'approval:resolved'/);
});

test('P7.5 evidence lifetime is explicit: session logs vs durable Goal checkpoints', () => {
  assert.match(consoleBlock, /Current session/);
  assert.match(consoleBlock, /retained only for this open app session/);
  assert.match(consoleBlock, /Durable Goal checkpoints/);
  assert.match(consoleBlock, /Goal Runner checkpoint evidence already persisted by Hearth/);
  assert.match(app, /goal\.checkpoints\.map/);
});

test('P7.6 Console adds no backend authority or parallel Console IPC namespace', () => {
  assert.doesNotMatch(main, /ipcMain\.handle\('console:/);
  assert.doesNotMatch(preload, /ipcRenderer\.invoke\('console:/);
  assert.doesNotMatch(consoleBlock, /goalsRun|goalsResume|goalsReviewResolve|antigravityStart|writeFile|runCommand/);
});

test('P7.7 stale fixed MCP tool-count copy is removed', () => {
  assert.doesNotMatch(app, /8 MCP tools/);
  assert.doesNotMatch(app, /expose 8 workspace tools/);
  assert.match(app, /Hearth MCP tools/);
});

test('P7.8 Console styles are responsive and reuse the existing panel system', () => {
  assert.match(styles, /\.console-grid/);
  assert.match(styles, /\.console-evidence-grid/);
  assert.match(styles, /\.console-status\.status-connected/);
  assert.match(styles, /\.metrics,.dashboard-grid,.console-grid,.console-evidence-grid \{ grid-template-columns: 1fr; \}/);
});
