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
const loopEnd = startupBlock.indexOf('\n    xQueueCoordinator.kick();');
assert.ok(loopStart !== -1 && loopEnd !== -1, 'the reconciliation for-loop must be found in the startup block');
const loopSource = startupBlock.slice(loopStart, loopEnd);

/** Executes the EXACT reconciliation for-loop text extracted from electron/main.cjs against fake doubles, so behavior is proven against the real committed code, not a hand-copied duplicate. */
function runExtractedLoop({ xQueueStore, xQueueCoordinator, consoleImpl }) {
  const fn = new Function('xQueueStore', 'xQueueCoordinator', 'console', loopSource);
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

  // A crashed-mid-dispatch entry: pending -> dispatching, never reached
  // dispatched. B2A must never inspect or mutate this.
  const stuck = item.queueStore.enqueue(taskFor('task-stuck'));
  item.queueStore.markDispatching(stuck.id);

  // A genuinely-completed dispatched entry, reconciled normally.
  const done = item.queueStore.enqueue(taskFor('task-done'));
  item.queueStore.markDispatching(done.id);
  const runIdDone = 'run-task-done';
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
  assert.equal(item.queueStore.listDispatching()[0].id, stuck.id);
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
