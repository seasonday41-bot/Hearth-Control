// Focused tests for Phase B2A's Electron startup reconciliation wiring in
// electron/main.cjs -- the XQueueCoordinator startup block that (a) runs
// getProductionXRuntime() (and its own XRunStore startup reconciliation)
// BEFORE constructing the coordinator, and (b) reconciles every persisted
// `dispatched` queue entry (never `dispatching`) by replaying the existing,
// idempotent XQueueCoordinator.onXRunTerminal({ runId }) once per entry,
// before the initial kick().
//
// electron/main.cjs itself requires the real `electron` module and Electron
// app lifecycle, so it cannot be executed directly in a plain Node test
// process (same constraint scripts/test-updater.mjs already works around).
// This suite:
//  - statically verifies ordering/shape of the actual committed source (the
//    same main.indexOf(...)/slice(...) technique test-updater.mjs already
//    uses on electron/main.cjs), and
//  - extracts the EXACT reconciliation for-loop text from that source and
//    executes it (via `new Function`) against fake doubles, so behavior is
//    proven against the real committed code, never a hand-copied duplicate
//    that could silently drift from it, and
//  - proves the surrounding coordinator-level property (a stuck
//    `dispatching` entry is left alone and still blocks dispatch) against
//    REAL XQueueStore/XQueueCoordinator instances -- no Electron needed.
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { XQueueStore } from '../mcp/x/queue-store.mjs';
import { XQueueCoordinator } from '../mcp/x/queue-coordinator.mjs';
import { XClaimStore } from '../mcp/x/claim-store.mjs';
import { XRunStore } from '../mcp/x/run-store.mjs';
import { X_TASK_VERSION } from '../mcp/x/task-contract.mjs';

const dirs = [];
const stores = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-electron-x-queue-'));
  const dbPath = path.join(root, 'hearth-runtime.sqlite');
  const queuePath = path.join(root, 'x-queue.json');
  const claimStore = new XClaimStore({ storagePath: dbPath });
  const runStore = new XRunStore({ storagePath: dbPath });
  const queueStore = new XQueueStore({ storagePath: queuePath }).load();
  dirs.push(root); stores.push(claimStore, runStore);
  return { root, dbPath, queuePath, claimStore, runStore, queueStore };
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function taskFor(taskId) {
  return {
    version: X_TASK_VERSION, task_id: taskId, parent_task_id: null,
    revision: 1, attempt: 1, based_on_result_id: null,
    objective: 'Electron B2A reconciliation fixture task.',
    problem: 'n/a', expected_behavior: 'n/a', observed_behavior: 'n/a', why_this_matters: 'n/a',
    known_evidence: [], suspected_area: [], workspace: { repo: 'Hearth-Control', root: '/tmp' },
    scope: { allowed_paths: [], preferred_files: [], forbidden_paths: [] },
    constraints: { preserve: [], do_not: [] }, allowed_tools: [],
    acceptance_criteria: [], validation: { required: [], optional: [] },
    verification: null, done_criteria: [], teaching_notes: [],
    uncertainty_policy: { policy: 'bounded_autonomy', stop_conditions: [] },
    repair_budget: { initial_attempts: 1, max_repairs: 2, max_total_rounds: 3 },
    timing: { estimated_minutes: 5, first_check_after_minutes: 1, soft_deadline_minutes: 3, hard_timeout_minutes: 10 },
    commit_policy: { mode: 'never' },
  };
}

const mainSource = fs.readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');

test('ingress main independently validates, fingerprints, authorizes, and gates startup workspace', () => {
  assert.match(mainSource, /xParseTask\(message\.task\)/);
  assert.match(mainSource, /fs\.promises\.realpath\(launchWorkspace\)/);
  assert.match(mainSource, /fs\.promises\.realpath\(message\.workspace\)/);
  assert.match(mainSource, /fs\.promises\.realpath\(readSettings\(\)\.workspace\)/);
  assert.match(mainSource, /fs\.promises\.realpath\(task\.workspace\.root\)/);
  assert.match(mainSource, /computeXTaskFingerprint/);
  assert.match(mainSource, /readSettings\(\)\.permissions\.X \?\? 'Ask'/);
  assert.match(mainSource, /xQueueDispatchEnabled = !xQueueStore\.recoveryRequired && xQueueWorkspaceMatches/);
  assert.match(mainSource, /if \(xQueueDispatchEnabled\) \{\s*for \(const entry of xQueueStore\.listDispatched\(\)\)/);
  assert.match(mainSource, /hasLiveXQueueEntries\(\) && !xQueueWorkspaceMatches\(workspace\)\) throw xQueueError\('workspace_mismatch'\)/);
  assert.match(mainSource, /ipcMain\.handle\('settings:save'[\s\S]*?workspace_locked_by_x_queue/);
  assert.match(mainSource, /ipcMain\.handle\('workspace:choose'[\s\S]*?workspace_locked_by_x_queue/);
});

test('X approval is resolved in Electron main before the existing child relay', () => {
  const handler = mainSource.slice(
    mainSource.indexOf("ipcMain.handle('server:respond-approval'"),
    mainSource.indexOf("ipcMain.handle('workspace:validate'"),
  );
  assert.match(handler, /pendingXApprovals\.has\(response\.requestId\)[\s\S]*?localApprovals\.get\(response\.requestId\)\?\.\(response\.allowed === true\);[\s\S]*?return true;/);
  assert.ok(handler.indexOf('pendingXApprovals.has') < handler.indexOf("serverProcess.send({ type: 'approval:result'"));
});

test('direct X terminal wakes the queue only after coordinator reports not_tracked', () => {
  const terminal = mainSource.slice(mainSource.indexOf("if (message?.type === 'x_run_terminal')"), mainSource.indexOf("if (message?.type === 'x_admission_hint')"));
  assert.match(terminal, /onXRunTerminal\(message\)/);
  assert.match(terminal, /handled\?\.reason === 'not_tracked'\) xQueueCoordinator\?\.kick\(\)/);
  assert.doesNotMatch(terminal, /x_capacity_released_hint/);
});

test('shared-capacity timer is one-shot, claim-kind-agnostic, and defers a null-deadline retry', () => {
  const timerSource = mainSource.slice(mainSource.indexOf('const clearXQueueCapacityWakeup = () => {'), mainSource.indexOf('const getUpdaterInfo = () => ({'));
  assert.doesNotMatch(timerSource, /setInterval/);
  const scheduled = [];
  const immediate = [];
  let deadline = Date.now() + 5000;
  let kicks = 0;
  const factory = new Function('setTimeout', 'clearTimeout', 'setImmediate', 'clearImmediate', 'xQueueStore',
    'xGetQueueCapacityDeadline', 'xQueueCoordinator', 'console', 'Date',
    `let xQueueCapacityTimer = null; let xQueueCapacityImmediate = null; let xQueueDispatchEnabled = true;
     ${timerSource}
     return { armXQueueCapacityWakeup };`);
  const timer = factory((fn, delay) => { const handle = { fn, delay, unref() {} }; scheduled.push(handle); return handle; },
    () => {}, (fn) => { immediate.push(fn); return fn; }, () => {}, { listPending: () => [{}] },
    () => deadline, { kick: () => { kicks += 1; } }, console, Date);
  timer.armXQueueCapacityWakeup();
  assert.equal(scheduled.length, 1);
  scheduled[0].fn();
  assert.equal(kicks, 1);
  deadline = null;
  timer.armXQueueCapacityWakeup();
  assert.equal(immediate.length, 1);
  immediate[0]();
  assert.equal(kicks, 2);
});

// The exact XQueueCoordinator startup block, sliced the same way
// scripts/test-updater.mjs already slices electron/main.cjs sections.
const blockStart = mainSource.indexOf("const { XQueueStore } = await importFromHere('../mcp/x/queue-store.mjs');");
const blockEnd = mainSource.indexOf("} catch (err) {\n    console.error('Failed to initialize XQueueCoordinator:'");
assert.ok(blockStart !== -1 && blockEnd !== -1, 'the XQueueCoordinator startup block must be found in electron/main.cjs');
const startupBlock = mainSource.slice(blockStart, blockEnd);

// ── 9, 13: ordering ─────────────────────────────────────────────────────

test('9 getProductionXRuntime() happens before queue reconciliation', () => {
  const idxRuntime = startupBlock.indexOf('getProductionXRuntime()');
  const idxReconcile = startupBlock.indexOf('xQueueStore.listDispatched()');
  assert.ok(idxRuntime !== -1 && idxReconcile !== -1);
  assert.ok(idxRuntime < idxReconcile, 'getProductionXRuntime() must run before startup queue reconciliation reads listDispatched()');
});

test('13 the final startup kick still happens, after reconciliation', () => {
  const idxReconcile = startupBlock.indexOf('xQueueStore.listDispatched()');
  const idxKick = startupBlock.lastIndexOf('xQueueCoordinator.kick();');
  assert.ok(idxReconcile !== -1 && idxKick !== -1);
  assert.ok(idxReconcile < idxKick, 'the initial kick() must still run, after reconciliation');
});

// ── 10, 11, 12, 14: reconciliation loop behavior (extracted from the real source) ──

const loopStart = startupBlock.indexOf('for (const entry of xQueueStore.listDispatched())');
const loopEnd = startupBlock.indexOf('\n    for (const entry of xQueueStore.listDispatching())');
assert.ok(loopStart !== -1 && loopEnd !== -1, 'the B2A reconciliation for-loop must be found in the startup block, immediately followed by the B2B one');
const loopSource = startupBlock.slice(loopStart, loopEnd);

/** Executes the EXACT B2A reconciliation for-loop text extracted from electron/main.cjs against fake doubles, so behavior is proven against the real committed code, not a hand-copied duplicate. */
function runExtractedLoop({ xQueueStore, xQueueCoordinator, consoleImpl }) {
  const fn = new Function('xQueueStore', 'xQueueCoordinator', 'console', loopSource);
  fn(xQueueStore, xQueueCoordinator, consoleImpl ?? console);
}

// ── B2B: the second (dispatching) reconciliation loop, extracted the same way ──

const loopStartB2B = startupBlock.indexOf('for (const entry of xQueueStore.listDispatching())');
const loopEndB2B = startupBlock.indexOf('\n    xQueueCoordinator.kick();');
assert.ok(loopStartB2B !== -1 && loopEndB2B !== -1, 'the B2B reconciliation for-loop must be found in the startup block, immediately before the final kick()');
const loopSourceB2B = startupBlock.slice(loopStartB2B, loopEndB2B);

/** Executes the EXACT B2B reconciliation for-loop text extracted from electron/main.cjs against fake doubles. */
function runExtractedLoopB2B({ xQueueStore, xQueueCoordinator, consoleImpl }) {
  const fn = new Function('xQueueStore', 'xQueueCoordinator', 'console', loopSourceB2B);
  fn(xQueueStore, xQueueCoordinator, consoleImpl ?? console);
}

test('10 startup iterates listDispatched()', () => {
  const entries = [{ runId: 'run-a' }, { runId: 'run-b' }, { runId: 'run-c' }];
  const calls = [];
  const fakeStore = { listDispatched: () => entries };
  const fakeCoordinator = { onXRunTerminal: (event) => { calls.push(event); } };
  runExtractedLoop({ xQueueStore: fakeStore, xQueueCoordinator: fakeCoordinator });
  assert.equal(calls.length, 3);
});

test('11 each dispatched runId is passed to xQueueCoordinator.onXRunTerminal({ runId })', () => {
  const entries = [{ runId: 'run-a', taskId: 'task-a', extra: 'must not leak' }];
  const calls = [];
  const fakeStore = { listDispatched: () => entries };
  const fakeCoordinator = { onXRunTerminal: (event) => { calls.push(event); } };
  runExtractedLoop({ xQueueStore: fakeStore, xQueueCoordinator: fakeCoordinator });
  assert.deepEqual(calls, [{ runId: 'run-a' }]);
});

test('12 one reconciliation throw is contained and does not stop later entries', () => {
  const entries = [{ runId: 'run-throws' }, { runId: 'run-ok' }];
  const calls = [];
  const loggedErrors = [];
  const fakeStore = { listDispatched: () => entries };
  const fakeCoordinator = {
    onXRunTerminal: (event) => {
      calls.push(event);
      if (event.runId === 'run-throws') throw new Error('simulated reconciliation failure');
    },
  };
  const fakeConsole = { error: (...args) => loggedErrors.push(args) };
  runExtractedLoop({ xQueueStore: fakeStore, xQueueCoordinator: fakeCoordinator, consoleImpl: fakeConsole });
  assert.deepEqual(calls, [{ runId: 'run-throws' }, { runId: 'run-ok' }], 'both entries must be reached despite the first throwing');
  assert.equal(loggedErrors.length, 1);
  assert.equal(loggedErrors[0][0], '[Electron] X startup queue reconciliation failed:');
});

test('14 listDispatching() is never inspected or mutated by the reconciliation loop', () => {
  assert.equal(loopSource.includes('listDispatching'), false, 'the extracted reconciliation loop source must not reference listDispatching at all');

  const entries = [{ runId: 'run-a' }];
  const fakeStore = {
    listDispatched: () => entries,
    listDispatching: () => { throw new Error('listDispatching must never be called by startup reconciliation'); },
  };
  const fakeCoordinator = { onXRunTerminal: () => {} };
  assert.doesNotThrow(() => runExtractedLoop({ xQueueStore: fakeStore, xQueueCoordinator: fakeCoordinator }));
});

// ── 15: a stuck `dispatching` entry is left alone and still blocks dispatch (real coordinator, no Electron needed) ──

test('15 a persisted dispatching entry remains stuck/ambiguous after startup reconciliation, and still blocks dispatch', async () => {
  const item = fixture();

  // A crashed-mid-dispatch LEGACY entry: pending -> dispatching, persisted
  // by the pre-B2B markDispatching(id) shape (runId:null). Seeded by
  // writing the store's own on-disk JSON directly -- the new production
  // markDispatching(id, runId) API cannot produce this state at all once
  // B2B ships. B2A's listDispatched() reconciliation never sees this entry.
  // Phase B2B's listDispatching() pass may delegate it to
  // reconcileDispatchingEntry(), but because runId is null it must remain
  // completely untouched as legacy_ambiguous.
  const legacyPayload = {
    schemaVersion: 1, updatedAt: new Date().toISOString(),
    entries: [{
      id: 'legacy-stuck-1', task: taskFor('task-stuck'), taskId: 'task-stuck', status: 'dispatching',
      createdAt: new Date().toISOString(), dispatchingAt: new Date().toISOString(),
      dispatchedAt: null, runId: null,
    }],
    reviews: [],
  };
  fs.writeFileSync(item.queuePath, JSON.stringify(legacyPayload, null, 2), 'utf8');
  item.queueStore.load();

  // A genuinely-completed dispatched entry, reconciled normally.
  const done = item.queueStore.enqueue(taskFor('task-done'));
  const runIdDone = 'run-task-done';
  item.queueStore.markDispatching(done.id, runIdDone);
  item.runStore.createRun({ runId: runIdDone, taskId: 'task-done' });
  item.runStore.markRunning({ runId: runIdDone, claimLeaseId: 'lease-done' });
  item.runStore.completeRun({
    runId: runIdDone,
    gateResult: { gate_status: 'COMPLETED', hearth_outcome: 'completed' },
    xResult: { task_id: 'task-done', gate_status: 'COMPLETED', hearth_outcome: 'completed' },
  });
  item.queueStore.markDispatched(done.id, runIdDone);

  const coordinator = new XQueueCoordinator({
    queueStore: item.queueStore, claimStore: item.claimStore, runStore: item.runStore,
    modelAdapter: { async generate() { throw new Error('must not be called'); } },
    ownerId: 'owner-electron-b2a',
  });

  // Exactly what Electron's startup block does: reconcile only listDispatched().
  for (const entry of item.queueStore.listDispatched()) {
    coordinator.onXRunTerminal({ runId: entry.runId });
  }

  // The stuck dispatching entry must be completely untouched.
  assert.equal(item.queueStore.listDispatching().length, 1);
  assert.equal(item.queueStore.listDispatching()[0].id, 'legacy-stuck-1');
  assert.equal(item.queueStore.listDispatching()[0].status, 'dispatching');
  assert.equal(item.queueStore.listDispatching()[0].runId, null);

  // The genuinely-done entry was reconciled away.
  assert.equal(item.queueStore.findDispatchedByRunId(runIdDone), null);

  // The coordinator's own existing inflight_or_ambiguous gate still applies:
  // the stuck dispatching entry blocks any further dispatch, exactly as
  // Phase B1 already established -- B2A adds no new behavior here.
  const result = await coordinator.dispatchNext();
  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'inflight_or_ambiguous');
});

// ── B2B: the second (listDispatching) startup reconciliation pass ──────────

test('16 exact startup order: B2A listDispatched() reconciliation, then B2B listDispatching() reconciliation, then the final kick()', () => {
  const idxA = startupBlock.indexOf('xQueueStore.listDispatched()');
  const idxB = startupBlock.indexOf('xQueueStore.listDispatching()');
  const idxKick = startupBlock.lastIndexOf('xQueueCoordinator.kick();');
  assert.ok(idxA !== -1 && idxB !== -1 && idxKick !== -1);
  assert.ok(idxA < idxB, 'B2A listDispatched() reconciliation must run before B2B listDispatching() reconciliation');
  assert.ok(idxB < idxKick, 'B2B listDispatching() reconciliation must run before the final kick()');
});

test('17 each dispatching entry is delegated whole to xQueueCoordinator.reconcileDispatchingEntry(entry)', () => {
  const entries = [{ id: 'e1', status: 'dispatching', runId: 'run-a', taskId: 'task-a' }];
  const calls = [];
  const fakeStore = { listDispatching: () => entries };
  const fakeCoordinator = { reconcileDispatchingEntry: (entry) => { calls.push(entry); } };
  runExtractedLoopB2B({ xQueueStore: fakeStore, xQueueCoordinator: fakeCoordinator });
  assert.deepEqual(calls, entries, 'the entire persisted entry object must be passed through, not a reshaped subset');
});

test('18 one B2B reconciliation throw is contained and does not stop later entries', () => {
  const entries = [{ id: 'e-throws', status: 'dispatching', runId: 'run-throws' }, { id: 'e-ok', status: 'dispatching', runId: 'run-ok' }];
  const calls = [];
  const loggedErrors = [];
  const fakeStore = { listDispatching: () => entries };
  const fakeCoordinator = {
    reconcileDispatchingEntry: (entry) => {
      calls.push(entry);
      if (entry.id === 'e-throws') throw new Error('simulated dispatching reconciliation failure');
    },
  };
  const fakeConsole = { error: (...args) => loggedErrors.push(args) };
  runExtractedLoopB2B({ xQueueStore: fakeStore, xQueueCoordinator: fakeCoordinator, consoleImpl: fakeConsole });
  assert.deepEqual(calls, entries, 'both entries must be reached despite the first throwing');
  assert.equal(loggedErrors.length, 1);
  assert.equal(loggedErrors[0][0], '[Electron] X startup dispatching reconciliation failed:');
});

test('19 Electron itself never inspects runStore directly -- no runStore.<method> call anywhere in the X startup block', () => {
  assert.doesNotMatch(
    startupBlock,
    /\brunStore\.\w+\(/,
    'Electron must delegate all run-state decisions to the coordinator, never call runStore itself',
  );
});

test('20 legacy null-runId policy remains coordinator-owned -- the B2B loop source contains no runId/status decision logic of its own', () => {
  assert.doesNotMatch(
    loopSourceB2B,
    /\.runId\b/,
    'the B2B loop must not itself inspect entry.runId -- that decision belongs entirely to reconcileDispatchingEntry',
  );

  assert.doesNotMatch(
    loopSourceB2B,
    /returnToPending|markDispatched|markInterrupted|failRun/,
    'the B2B loop must not itself mutate queue or run state -- only the coordinator method may',
  );
});
