// Focused tests for the NEW Remote Bridge -> X approval path in
// electron/main.cjs: approveRemotePublicXTask (Slice 1B/1C), and
// syncTerminalReceiptToPublicTasks / resyncTerminalPublicXTasks (Slice 1D).
// Proves R5, R6, R7, R12, R13 against the EXACT committed source, executed
// via the same source-extraction + new Function technique already used by
// scripts/test-electron-x-approval-lifecycle.mjs and
// scripts/test-x-queue-ingress.mjs -- never a hand-copied duplicate.
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { XQueueStore } from '../mcp/x/queue-store.mjs';
import { canonicalJson, canonicalizeXTask, computeXTaskFingerprint } from '../mcp/x/fingerprint.mjs';

const mainSource = fs.readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');

// ── extraction: syncTerminalReceiptToPublicTasks / resyncTerminalPublicXTasks ──

const terminalSyncStart = mainSource.indexOf('const xQueueReceiptStatus = (receipt) => {');
const terminalSyncEnd = mainSource.indexOf('const requestXApproval = (record, child, action, options = {}) => new Promise((resolve) => {');
assert.ok(terminalSyncStart !== -1 && terminalSyncEnd !== -1, 'terminal-sync helpers must be found in electron/main.cjs');
const terminalSyncSource = mainSource.slice(terminalSyncStart, terminalSyncEnd);

function buildTerminalSyncHarness({ updateTaskFromXRun } = {}) {
  const calls = [];
  const fakePublicTasksClient = updateTaskFromXRun
    ? { updateTaskFromXRun: (...args) => { calls.push(args); return updateTaskFromXRun(...args); } }
    : null;
  const factorySource = `
    const xQueueRequests = new Map();
    const pendingXApprovals = new Map();
    ${terminalSyncSource}
    return { syncTerminalReceiptToPublicTasks, resyncTerminalPublicXTasks, xQueueReceiptStatus };
  `;
  const factory = new Function('xRunStore', 'xQueueStore', 'publicTasksClientInstance', factorySource);
  const api = factory({ getRun: () => null }, { recoveryRequired: false }, fakePublicTasksClient);
  return { ...api, calls };
}

test('R8-R11 terminal sync maps each terminal status and syncs only the SAME supabase: row id', async () => {
  const cases = [
    ['completed', 'completed'],
    ['needs_review', 'waiting'],
    ['failed', 'failed'],
    ['interrupted', 'waiting'],
  ];
  for (const [xStatus] of cases) {
    const h = buildTerminalSyncHarness({ updateTaskFromXRun: async () => true });
    await h.syncTerminalReceiptToPublicTasks({
      requestId: 'supabase:row-42', runId: 'run-1', queueStatus: 'terminal', terminalStatus: xStatus,
    });
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0][0].id, 'row-42');
    assert.equal(h.calls[0][0].xStatus, xStatus);
  }
});

test('a non-terminal receipt, a non-supabase requestId, or no publicTasksClientInstance never syncs', async () => {
  const live = buildTerminalSyncHarness({ updateTaskFromXRun: async () => true });
  await live.syncTerminalReceiptToPublicTasks({ requestId: 'supabase:row-1', runId: 'run-1', queueStatus: 'dispatched', terminalStatus: null });
  assert.equal(live.calls.length, 0, 'a non-terminal receipt must never sync');

  const local = buildTerminalSyncHarness({ updateTaskFromXRun: async () => true });
  await local.syncTerminalReceiptToPublicTasks({ requestId: 'request-1', runId: 'run-1', queueStatus: 'terminal', terminalStatus: 'completed' });
  assert.equal(local.calls.length, 0, 'a local (non-supabase:) requestId must never sync -- R14 isolation');

  const unconfigured = buildTerminalSyncHarness(); // publicTasksClientInstance is null
  await unconfigured.syncTerminalReceiptToPublicTasks({ requestId: 'supabase:row-1', runId: 'run-1', queueStatus: 'terminal', terminalStatus: 'completed' });
  assert.equal(unconfigured.calls.length, 0);
});

test('R12 a sync failure is swallowed -- it never throws and never touches X queue/run state', async () => {
  const h = buildTerminalSyncHarness({ updateTaskFromXRun: async () => { throw new Error('network down'); } });
  await assert.doesNotReject(h.syncTerminalReceiptToPublicTasks({
    requestId: 'supabase:row-9', runId: 'run-9', queueStatus: 'terminal', terminalStatus: 'failed',
  }));
  assert.equal(h.calls.length, 1, 'the sync attempt still happened -- only its failure is swallowed');
});

test('R13 resyncTerminalPublicXTasks retries every unsynced terminal supabase: receipt still held by the store, and skips everything else', async () => {
  const attempted = [];
  const h = buildTerminalSyncHarness({ updateTaskFromXRun: async (args) => { attempted.push(args.id); return true; } });
  const receipts = new Map([
    ['supabase:row-1', { requestId: 'supabase:row-1', runId: 'run-1', queueStatus: 'terminal', terminalStatus: 'completed' }],
    ['supabase:row-2', { requestId: 'supabase:row-2', runId: 'run-2', queueStatus: 'terminal', terminalStatus: 'failed' }],
    ['request-local', { requestId: 'request-local', runId: 'run-3', queueStatus: 'terminal', terminalStatus: 'completed' }],
    ['supabase:row-4', { requestId: 'supabase:row-4', runId: 'run-4', queueStatus: 'dispatched', terminalStatus: null }],
  ]);
  const factory = new Function('xRunStore', 'xQueueStore', 'publicTasksClientInstance',
    `const xQueueRequests = new Map(); const pendingXApprovals = new Map(); ${terminalSyncSource}
     return { resyncTerminalPublicXTasks };`);
  const api = factory({ getRun: () => null }, { recoveryRequired: false, receipts },
    { updateTaskFromXRun: async (args) => { attempted.push(args.id); return true; } });
  await api.resyncTerminalPublicXTasks();
  assert.deepEqual(attempted.sort(), ['row-1', 'row-2'], 'only the two unsynced supabase: terminal receipts are retried');
});

// ── extraction: syncPublicXTasks + approveRemotePublicXTask ────────────

const syncStart = mainSource.indexOf('const syncPublicXTasks = async () => {');
const syncEnd = mainSource.indexOf('\n    const syncBridgeTasks = async (tasks) => {');
assert.ok(syncStart !== -1 && syncEnd !== -1);
const syncPublicXTasksSource = mainSource.slice(syncStart, syncEnd);

const approveStart = mainSource.indexOf('const approveRemotePublicXTask = async (taskId) => {');
const approveEnd = mainSource.indexOf("\n    ipcMain.handle('bridge:approve-task'");
assert.ok(approveStart !== -1 && approveEnd !== -1);
const approveRemotePublicXTaskSource = mainSource.slice(approveStart, approveEnd);

function buildRemoteApprovalHarness({ ingestXTask, claimQueuedTask, updateTaskFromXRun, fetchQueuedTasks, ready = true } = {}) {
  const events = [];
  const bridgeState = { activeRemoteTaskId: null, pendingTasks: [] };
  const fakeClient = {
    claimQueuedTask: claimQueuedTask || (async () => ({ claimed: true })),
    updateTaskFromXRun: updateTaskFromXRun || (async () => true),
    fetchQueuedTasks: fetchQueuedTasks || (async () => []),
  };
  const factorySource = `
    let publicXTaskRowsById = new Map();
    ${syncPublicXTasksSource}
    ${approveRemotePublicXTaskSource}
    return { syncPublicXTasks, approveRemotePublicXTask, getRows: () => publicXTaskRowsById, setRows: (m) => { publicXTaskRowsById = m; } };
  `;
  const factory = new Function(
    'publicTasksClientInstance', 'publicTasksReady', 'bridgeState', 'sendEvent', 'ingestXTask', 'SUPABASE_REQUEST_ID_PREFIX',
    'publicTasksSession', 'ensurePublicTasksSession',
    factorySource,
  );
  const api = factory(
    fakeClient, () => ready, bridgeState, (event) => events.push(event),
    ingestXTask || (async () => ({ queue_id: 'queue-1' })), 'supabase:',
    null, async () => { throw new Error('must not be called when publicTasksSession is null'); },
  );
  return { ...api, events, bridgeState, fakeClient };
}

const xTaskRow = (id, overrides = {}) => ({
  id, createdAt: '2026-01-01T00:00:00.000Z',
  task: { task_id: `task-${id}`, objective: 'Do the thing', problem: 'It is not done', workspace: { root: '/w' } },
  ...overrides,
});

test('R2 syncPublicXTasks is a pure read -- it never claims/executes, and returns [] when not ready', async () => {
  const h = buildRemoteApprovalHarness({ ready: false, fetchQueuedTasks: async () => { throw new Error('must not be called'); } });
  assert.deepEqual(await h.syncPublicXTasks(), []);

  const ready = buildRemoteApprovalHarness({ fetchQueuedTasks: async () => [xTaskRow('row-1')] });
  const summaries = await ready.syncPublicXTasks();
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].id, 'row-1');
  assert.equal(summaries[0].routedTo, 'x');
  assert.equal(summaries[0].requestId, 'supabase:row-1');
  assert.equal(ready.getRows().get('row-1').id, 'row-1');
});

test('R5 one manual approval claims the row exactly once and calls ingestXTask exactly once with requestId supabase:<row-id> -- R7', async () => {
  const ingestCalls = [];
  const claimCalls = [];
  const h = buildRemoteApprovalHarness({
    claimQueuedTask: async (args) => { claimCalls.push(args); return { claimed: true }; },
    ingestXTask: async (args) => { ingestCalls.push(args); return { queue_id: 'queue-1', accepted: true }; },
  });
  h.setRows(new Map([['row-1', xTaskRow('row-1')]]));
  h.bridgeState.pendingTasks = [{ id: 'row-1' }];

  const result = await h.approveRemotePublicXTask('row-1');

  assert.equal(claimCalls.length, 1);
  assert.equal(claimCalls[0].id, 'row-1');
  assert.equal(ingestCalls.length, 1, 'exactly one X ingress call for one approval');
  assert.equal(ingestCalls[0].requestId, 'supabase:row-1', 'R7: requestId is exactly supabase:<row-id>');
  assert.equal(ingestCalls[0].task.task_id, 'task-row-1');
  assert.equal(result.success, true);
  assert.equal(result.routedTo, 'x');
  assert.equal(h.bridgeState.activeRemoteTaskId, null, 'cleared after a successful commit');
  assert.equal(h.getRows().has('row-1'), false, 'the row is removed from the local pending map once committed');
  assert.equal(h.bridgeState.pendingTasks.length, 0);
});

test('R6 a race-lost claim (already claimed elsewhere) never calls ingestXTask and fails cleanly', async () => {
  const ingestCalls = [];
  const h = buildRemoteApprovalHarness({
    claimQueuedTask: async () => ({ claimed: false }),
    ingestXTask: async (args) => { ingestCalls.push(args); return { queue_id: 'queue-1' }; },
  });
  h.setRows(new Map([['row-1', xTaskRow('row-1')]]));
  h.bridgeState.pendingTasks = [{ id: 'row-1' }];

  await assert.rejects(h.approveRemotePublicXTask('row-1'), /already claimed or cancelled/);
  assert.equal(ingestCalls.length, 0, 'a lost claim race must never reach X ingress -- exactly one run per Supabase row');
  assert.equal(h.getRows().has('row-1'), false);
  assert.equal(h.bridgeState.pendingTasks.length, 0);
});

test('approving an unknown taskId (not in the local pending map) throws without claiming or ingesting', async () => {
  const claimCalls = [];
  const h = buildRemoteApprovalHarness({ claimQueuedTask: async (a) => { claimCalls.push(a); return { claimed: true }; } });
  await assert.rejects(h.approveRemotePublicXTask('unknown-row'), /not found in pending inbox/);
  assert.equal(claimCalls.length, 0);
});

test('a duplicate/replayed approval for the same already-committed row reuses the SAME durable receipt (R6 at the ingress layer)', async () => {
  // ingestXTask itself already guarantees requestId idempotency (proven in
  // test-x-queue-ingress.mjs); here we only prove approveRemotePublicXTask
  // passes the SAME deterministic requestId both times, so a second claim
  // attempt (which PublicTasksClient's claimQueuedTask already makes
  // fail-safe on a race) can never fan out into a second X run.
  const requestIds = [];
  const h = buildRemoteApprovalHarness({
    ingestXTask: async (args) => { requestIds.push(args.requestId); return { queue_id: 'queue-1' }; },
  });
  h.setRows(new Map([['row-1', xTaskRow('row-1')]]));
  h.bridgeState.pendingTasks = [{ id: 'row-1' }];
  await h.approveRemotePublicXTask('row-1');

  h.setRows(new Map([['row-1', xTaskRow('row-1')]])); // simulate a fresh poll re-surfacing the same row id
  h.bridgeState.pendingTasks = [{ id: 'row-1' }];
  await h.approveRemotePublicXTask('row-1');

  assert.equal(requestIds.length, 2);
  assert.equal(requestIds[0], requestIds[1], 'both attempts use the exact same supabase:<row-id> requestId');
});

test('ingestXTask failure (e.g. workspace_mismatch) marks the already-claimed row failed on public.tasks, preserves it for review, and rethrows -- never reruns X', async () => {
  const updateCalls = [];
  const h = buildRemoteApprovalHarness({
    ingestXTask: async () => { const e = new Error('workspace mismatch'); e.code = 'workspace_mismatch'; throw e; },
    updateTaskFromXRun: async (args) => { updateCalls.push(args); return true; },
  });
  h.setRows(new Map([['row-1', xTaskRow('row-1')]]));
  h.bridgeState.pendingTasks = [{ id: 'row-1' }];

  await assert.rejects(h.approveRemotePublicXTask('row-1'), /workspace mismatch/);
  assert.equal(h.bridgeState.activeRemoteTaskId, null, 'the active-remote lock is always released, even on failure');
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].id, 'row-1');
  assert.equal(updateCalls[0].xStatus, 'failed');
  assert.match(updateCalls[0].error, /workspace mismatch/);
});

test('a failure to even mark the row failed on public.tasks (double failure) still rethrows the original ingestXTask error', async () => {
  const h = buildRemoteApprovalHarness({
    ingestXTask: async () => { throw new Error('permission_denied'); },
    updateTaskFromXRun: async () => { throw new Error('network down'); },
  });
  h.setRows(new Map([['row-1', xTaskRow('row-1')]]));
  h.bridgeState.pendingTasks = [{ id: 'row-1' }];
  await assert.rejects(h.approveRemotePublicXTask('row-1'), /permission_denied/);
});

// ── Slice 1C integration: the REAL ingestXTask, wired to the REAL
// approveRemotePublicXTask (not a mock), proving workspace authority is the
// CURRENT Hearth settings workspace, never the remote payload's own claim ──

const ingressStart = mainSource.indexOf('const xQueueError = (code) =>');
const ingressEnd = mainSource.indexOf('// Fast-restart X liveness:', ingressStart);
assert.ok(ingressStart !== -1 && ingressEnd !== -1);
const ingressSource = mainSource.slice(ingressStart, ingressEnd);

const integrationDirs = [];
afterEach(() => { for (const dir of integrationDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function buildIntegrationHarness({ settingsWorkspace, permission = 'Allow', claimQueuedTask, updateTaskFromXRun } = {}) {
  const events = [];
  const bridgeState = { activeRemoteTaskId: null, pendingTasks: [] };
  const settings = { workspace: settingsWorkspace, permissions: { X: permission } };
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-remote-x-integration-'));
  integrationDirs.push(storeDir);
  const store = new XQueueStore({ storagePath: path.join(storeDir, 'x-queue.json') }).load();
  let enqueueCount = 0;
  const coordinator = { enqueue: (task, identity) => { enqueueCount += 1; return store.enqueueWithReceipt(task, identity); } };
  const fakeClient = {
    claimQueuedTask: claimQueuedTask || (async () => ({ claimed: true })),
    updateTaskFromXRun: updateTaskFromXRun || (async () => true),
  };
  const factorySource = `
    const xQueueInflight = new Map(); const xQueueRequests = new Map(); const pendingXApprovals = new Map();
    ${ingressSource}
    let publicXTaskRowsById = new Map();
    ${approveRemotePublicXTaskSource}
    return { approveRemotePublicXTask, setRows: (m) => { publicXTaskRowsById = m; } };
  `;
  const factory = new Function(
    'fs', 'crypto', 'xQueueStore', 'xQueueCoordinator', 'xParseTask', 'xRunStore',
    'readSettings', 'sendEvent', 'serverProcess', 'xQueueDispatchEnabled', 'xShuttingDown', 'localApprovals', 'setTimeout', 'clearTimeout',
    'publicTasksClientInstance', 'publicTasksReady', 'bridgeState',
    'canonicalJson', 'canonicalizeXTask', 'computeXTaskFingerprint',
    factorySource,
  );
  const localApprovals = new Map();
  const api = factory(
    fs, crypto, store, coordinator, null, { getRun: () => null },
    () => settings, (event) => events.push(event), null, true, false, localApprovals, setTimeout, clearTimeout,
    fakeClient, () => true, bridgeState,
    canonicalJson, canonicalizeXTask, computeXTaskFingerprint,
  );
  return { ...api, events, bridgeState, enqueueCount: () => enqueueCount };
}

test('Slice 1C: an x-task-v1 whose own workspace.root matches CURRENT settings is dispatched to the real X queue', async () => {
  const h = buildIntegrationHarness({ settingsWorkspace: process.cwd() });
  h.setRows(new Map([['row-1', xTaskRow('row-1', { task: { task_id: 'task-1', objective: 'x', problem: 'y', workspace: { root: process.cwd() } } })]]));
  h.bridgeState.pendingTasks = [{ id: 'row-1' }];

  const result = await h.approveRemotePublicXTask('row-1');
  assert.equal(result.success, true);
  assert.equal(h.enqueueCount(), 1, 'exactly one real X queue enqueue for one remote approval');
});

// ── Slice 1D regression guard: the terminal-sync hook must fire for a LIVE
// completion discovered via xQueueCoordinator's OWN internal path, not only
// via the serverProcess x_run_terminal message relay. This is exactly the
// wiring gap that let REMOTE-X-SMOKE-002 complete locally (terminal receipt,
// released claim) while its public.tasks row stayed stuck at status=running
// forever -- the sync call had only ever been added inside the message
// relay, which a coordinator-internal completion never reaches. ──

const wrapStart = mainSource.indexOf('    {\n      const baseOnXRunTerminal = xQueueCoordinator.onXRunTerminal.bind(xQueueCoordinator);');
const wrapEnd = mainSource.indexOf('\n    onAntigravityAdmissionReleased(');
assert.ok(wrapStart !== -1 && wrapEnd !== -1, 'the onXRunTerminal wrapper must be found in electron/main.cjs');
const wrapSource = mainSource.slice(wrapStart, wrapEnd);

function buildWrapHarness({ handledResult = { handled: true }, receipt, updateTaskFromXRun } = {}) {
  const calls = [];
  const baseOnXRunTerminalCalls = [];
  let xQueueCoordinator = {
    onXRunTerminal: (event) => { baseOnXRunTerminalCalls.push(event); return handledResult; },
  };
  const fakeXQueueStore = { findReceiptByRunId: (runId) => (receipt && receipt.runId === runId ? receipt : null) };
  const factorySource = `
    ${wrapSource}
    return { onXRunTerminal: xQueueCoordinator.onXRunTerminal };
  `;
  const factory = new Function('xQueueCoordinator', 'xQueueStore', 'syncTerminalReceiptToPublicTasks', factorySource);
  const api = factory(
    xQueueCoordinator, fakeXQueueStore,
    (r) => { calls.push(r); return (updateTaskFromXRun || (async () => true))(r); },
  );
  return { ...api, calls, baseOnXRunTerminalCalls };
}

test('onXRunTerminal wrapper syncs to public.tasks when called via ANY caller (not only the message relay), proving the live coordinator-internal completion path is covered', () => {
  const receipt = { requestId: 'supabase:row-live', runId: 'run-live', queueStatus: 'terminal', terminalStatus: 'completed' };
  const h = buildWrapHarness({ handledResult: { handled: true }, receipt });
  // Simulates xQueueCoordinator's OWN internal dispatchNext().done.then()
  // call -- not the serverProcess message relay at all.
  const result = h.onXRunTerminal({ runId: 'run-live' });
  assert.deepEqual(result, { handled: true }, 'the original onXRunTerminal return value must pass through unchanged');
  assert.equal(h.baseOnXRunTerminalCalls.length, 1);
  assert.equal(h.calls.length, 1, 'the terminal sync must fire for this call, regardless of who called onXRunTerminal');
  assert.equal(h.calls[0].requestId, 'supabase:row-live');
});

test('onXRunTerminal wrapper does not sync when the underlying call reports not handled (e.g. not_tracked/task_mismatch)', () => {
  const receipt = { requestId: 'supabase:row-x', runId: 'run-x', queueStatus: 'terminal', terminalStatus: 'completed' };
  const h = buildWrapHarness({ handledResult: { handled: false, reason: 'not_tracked' }, receipt });
  const result = h.onXRunTerminal({ runId: 'run-x' });
  assert.deepEqual(result, { handled: false, reason: 'not_tracked' });
  assert.equal(h.calls.length, 0, 'an unhandled/untracked event must never trigger a sync attempt');
});

test('onXRunTerminal wrapper is a no-op sync-wise for a local (non-supabase:) task -- no receipt match needed to prove this, findReceiptByRunId itself is still consulted safely', () => {
  const h = buildWrapHarness({ handledResult: { handled: true }, receipt: null });
  const result = h.onXRunTerminal({ runId: 'run-unknown' });
  assert.deepEqual(result, { handled: true });
  assert.equal(h.calls.length, 0, 'no receipt found by runId means no sync call is attempted');
});

test('Slice 1C: an x-task-v1 whose workspace.root does NOT match CURRENT settings is refused -- never runs, never redesigns X, and marks the row failed for review', async () => {
  const updateCalls = [];
  const h = buildIntegrationHarness({
    settingsWorkspace: process.cwd(),
    updateTaskFromXRun: async (args) => { updateCalls.push(args); return true; },
  });
  h.setRows(new Map([['row-1', xTaskRow('row-1', { task: { task_id: 'task-1', objective: 'x', problem: 'y', workspace: { root: '/some/other/remote-claimed/workspace' } } })]]));
  h.bridgeState.pendingTasks = [{ id: 'row-1' }];

  await assert.rejects(h.approveRemotePublicXTask('row-1'), { code: 'workspace_mismatch' });
  assert.equal(h.enqueueCount(), 0, 'a workspace-authority mismatch must never reach the real X queue');
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].xStatus, 'failed');
  assert.match(updateCalls[0].error, /workspace_mismatch/);
});

// ── Phase 2 security-boundary canary ────────────────────────────────────
// Phase 2 (trusted, click-free Chat-authored execution) was AUDITED and
// deliberately NOT implemented: no existing mechanism (Project X session,
// conversation_id, origin_device_id, the legacy bridge's pairing secret,
// safeStorage, device identity) lets Hearth verify WHO authored a
// public.tasks row as opposed to WHOM it belongs to -- every row with a
// given user_id is equally "authenticated," so a self-asserted field like
// metadata.preauthorized would be exactly as forgeable by any other holder
// of that same user's JWT as by a legitimate trusted author. These tests
// are a regression guard against that self-asserted bypass ever being
// added later without a deliberate, reviewed design change.

test('Phase 2 canary: no code path anywhere reads a self-asserted preauthorized/pre_authorized/metadata-trusted flag to gate X execution', () => {
  for (const source of [mainSource, fs.readFileSync(new URL('../mcp/bridge/public-tasks-client.mjs', import.meta.url), 'utf8')]) {
    assert.doesNotMatch(source, /preauthoriz|pre_authoriz|metadata\s*\.\s*trusted|is_trusted|trustedChat/i);
  }
});

test('Phase 2 canary: syncPublicXTasks (the poll) never itself calls claim/ingest/approve -- fetching queued rows can never execute X', () => {
  assert.doesNotMatch(syncPublicXTasksSource, /claimQueuedTask|ingestXTask|approveRemotePublicXTask/);
});

test('Phase 2 canary: the ONLY way a public.tasks row reaches X is bridge:approve-task -> approveRemotePublicXTask, requiring an explicit taskId from a user click', () => {
  // approveRemotePublicXTask itself is never invoked from anywhere except
  // the bridge:approve-task IPC handler (the renderer's Approve button).
  // (Its own definition site uses `= async (taskId) =>`, not `(taskId)`,
  // so this pattern only matches actual CALLS, never the definition.)
  const callSites = [...mainSource.matchAll(/approveRemotePublicXTask\(/g)].length;
  assert.equal(callSites, 1, 'approveRemotePublicXTask must have exactly one production call site (bridge:approve-task)');
});
