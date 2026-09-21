// P7 operational-surface boundaries.
//
// These panels used to live together on a dedicated "Console" page. That page
// was removed because every one of its panels duplicated another destination;
// the panels themselves were kept and moved to where the operator already looks:
//
//   Health              -> Connections
//   Pending requests    -> Goals (what is waiting on you)
//   Operational evidence-> System / Activity
//   Live & recent runs  -> Goals / Activity  (mechanism, not a destination)
//
// The boundaries below are unchanged and still apply. Each one is now asserted
// against the panel that owns it rather than against the deleted page, so the
// guarantees survive the panels moving again.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const styles = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const main = fs.readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
const preload = fs.readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');

/** The JSX of one panel, sliced by its stable className and closing </section>. */
const panel = (className) => {
  const start = app.indexOf(`className="soft-panel ${className}"`);
  assert.ok(start >= 0, `the ${className} panel must exist somewhere in the app`);
  const end = app.indexOf('</section>', start);
  assert.ok(end > start, `the ${className} panel must be closed`);
  return app.slice(start, end);
};

const connectionsPanel = panel('console-connections-panel');
const approvalsPanel = panel('console-approvals-panel');
const evidencePanel = panel('console-evidence-panel');
const xRunsPanel = panel('console-x-panel');

const managementStart = app.indexOf('const connectManagedConnection');
const managementEnd = app.indexOf('const navigate', managementStart);
assert.ok(managementStart >= 0 && managementEnd > managementStart, 'P7 connection management handlers must exist');
const managementBlock = app.slice(managementStart, managementEnd);

test('P7.1 the operational panels are reachable from the six destinations, and Console is not one of them', () => {
  assert.match(app, /type NavItem = [^\n]*'Connections'/);
  for (const destination of ['Overview', 'Goals', 'Chat', 'Invest', 'Connections', 'System']) {
    assert.match(app, new RegExp(`\\{ name: '${destination}', icon: '[a-z]+' \\}`), `${destination} must be a nav item`);
  }
  assert.doesNotMatch(app, /\{ name: 'Console', icon: /, 'Console must no longer be a destination');
  assert.doesNotMatch(app, /activeNav === 'Console'/, 'the Console render branch must be gone');

  // Each moved panel is gated by the destination that now owns it.
  assert.ok(app.indexOf('console-connections-panel') > app.indexOf("activeNav === 'Connections' ?"), 'Health belongs to Connections');
  assert.match(app, /activeNav === 'System' && systemTab === 'Activity' && <section className="soft-panel console-evidence-panel"/, 'evidence belongs to System / Activity');
});

test('P7.2 the connections panel uses safe list/refresh plus only the existing local GitHub/Vercel management IPC', () => {
  assert.match(connectionsPanel, /refreshConnections\(\)/);
  assert.match(connectionsPanel, /refreshConnections\(connection\.alias\)/);
  assert.match(app, /window\.controlApp\.connectionsList\(\)/);
  assert.match(app, /window\.controlApp\.connectionsRefresh\(alias\)/);
  assert.match(managementBlock, /window\.controlApp\.githubConnect/);
  assert.match(managementBlock, /window\.controlApp\.githubDisconnect/);
  assert.match(managementBlock, /window\.controlApp\.vercelConnect/);
  assert.match(managementBlock, /window\.controlApp\.vercelDisconnect/);
  assert.doesNotMatch(managementBlock, /publicTasksSaveAnonKey|bridgeSignIn|goalsRun|antigravityStart/);
});

test('P7.2 no operational panel renders provider target/auth/credential/token material', () => {
  for (const [name, block] of [['connections', connectionsPanel], ['approvals', approvalsPanel], ['evidence', evidencePanel], ['x runs', xRunsPanel]]) {
    assert.doesNotMatch(block, /connection\.(?:target|auth|credentialRef|accessToken|refreshToken)/, name);
    assert.doesNotMatch(block, /JSON\.stringify\(connection\)/, name);
    assert.doesNotMatch(block, /Authorization|Bearer/, name);
  }
  assert.match(connectionsPanel, /Stored provider targets, credentials, tokens, and ciphertext are never read back or rendered/);
  assert.match(connectionsPanel, /type="password"/);
  assert.match(connectionsPanel, /autoComplete="new-password"/);
  assert.match(managementBlock, /setConnectionTokenInputs\(\(current\) => \(\{ \.\.\.current, \[connection\.alias\]: '' \}\)\)/);
  assert.doesNotMatch(managementBlock, /localStorage|saveSettings|setLogs/);
});

test('P7.2 Supabase management is not duplicated by the connections panel', () => {
  assert.match(connectionsPanel, /connection\.provider === 'supabase'/);
  assert.match(connectionsPanel, /Remote Bridge \/ Project X surfaces/);
  assert.doesNotMatch(managementBlock, /publicTasksSignIn|bridgeSignIn|supabase.*Connect/i);
});

test('P7.3 pending approvals are visible but the panel has no decision path', () => {
  assert.match(approvalsPanel, /approvalQueue\.map/);
  assert.match(approvalsPanel, /cannot allow or deny requests/);
  assert.doesNotMatch(approvalsPanel, /answerApproval|respondToApproval|Allow once|Deny/);
});

test('P7.4 approval evidence is bounded and records request plus resolution lifecycle', () => {
  assert.match(app, /const APPROVAL_EVIDENCE_LIMIT = 40/);
  assert.match(app, /recordApprovalRequested/);
  assert.match(app, /recordApprovalResolved/);
  assert.match(app, /slice\(-APPROVAL_EVIDENCE_LIMIT\)/);
  assert.match(app, /event\.type === 'approval:resolved'/);
});

test('P7.5 evidence lifetime is explicit: session logs vs durable Goal checkpoints', () => {
  assert.match(evidencePanel, /Current session/);
  assert.match(evidencePanel, /retained only for this open app session/);
  assert.match(evidencePanel, /Durable Goal checkpoints/);
  assert.match(evidencePanel, /Goal Runner checkpoint evidence already persisted by Hearth/);
  assert.match(app, /goal\.checkpoints\.map/);
});

test('P7.6 the panels add no backend authority or parallel Console IPC namespace', () => {
  assert.doesNotMatch(main, /ipcMain\.handle\('console:/);
  assert.doesNotMatch(preload, /ipcRenderer\.invoke\('console:/);
  for (const block of [connectionsPanel, approvalsPanel, evidencePanel, xRunsPanel]) {
    assert.doesNotMatch(block, /goalsRun|goalsResume|goalsReviewResolve|antigravityStart|writeFile|runCommand/);
  }
});

test('P7.6 the X run list stays a read-only projection, never a control surface', () => {
  assert.match(xRunsPanel, /Read-only projection from XRunStore/);
  assert.doesNotMatch(xRunsPanel, /xStart|xStop|xCancel|xRetry|xApprove/);
});

test('P7.7 stale fixed MCP tool-count copy is removed', () => {
  assert.doesNotMatch(app, /8 MCP tools/);
  assert.doesNotMatch(app, /expose 8 workspace tools/);
  assert.match(app, /Hearth MCP tools/);
});

test('P7.8 the panel styles are responsive and reuse the existing panel system', () => {
  assert.match(styles, /\.console-evidence-grid/);
  assert.match(styles, /\.console-status\.status-connected/);
  assert.match(styles, /\.metrics,.dashboard-grid,.console-evidence-grid \{ grid-template-columns: 1fr; \}/);
});
