// Focused tests for XQueueStore -- the coordinator-owned bookkeeping store
// only (pending/dispatching/dispatched queue entries, and review
// bookkeeping keyed by runId). Proves the three-state lifecycle invariants
// (pending -> dispatching -> dispatched) and the crash-consistency
// guarantee that a stuck `dispatching` entry is never silently discarded,
// reverted, or auto-redispatched by this store.
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { XQueueStore } from '../mcp/x/queue-store.mjs';

const dirs = [];
function tmpStorePath(name = 'x-queue.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-x-queue-store-'));
  dirs.push(dir);
  return path.join(dir, name);
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const taskFor = (taskId = 'task-1') => ({ version: 'x-task-v1', task_id: taskId, objective: 'do the thing' });

// ── enqueue ──────────────────────────────────────────────────────────────

test('enqueue persists a pending entry and rejects a missing/non-string task_id', () => {
  const store = new XQueueStore({ storagePath: tmpStorePath() });
  const entry = store.enqueue(taskFor('task-1'));
  assert.equal(entry.status, 'pending');
  assert.equal(entry.taskId, 'task-1');
  assert.equal(entry.runId, null);
  assert.equal(entry.dispatchingAt, null);
  assert.equal(entry.dispatchedAt, null);
  assert.equal(typeof entry.id, 'string');
  assert.ok(entry.id.length > 0);

  assert.throws(() => store.enqueue({ version: 'x-task-v1' }), TypeError);
  assert.throws(() => store.enqueue({ version: 'x-task-v1', task_id: '' }), TypeError);
  assert.throws(() => store.enqueue({ version: 'x-task-v1', task_id: 42 }), TypeError);
  assert.throws(() => store.enqueue(null), TypeError);
});

test('enqueue never mutates the task payload it is given', () => {
  const store = new XQueueStore({ storagePath: tmpStorePath() });
  const task = taskFor('task-1');
  const snapshot = JSON.stringify(task);
  store.enqueue(task);
  assert.equal(JSON.stringify(task), snapshot);
});

test('nextPending returns the oldest pending entry in insertion order', () => {
  const store = new XQueueStore({ storagePath: tmpStorePath() });
  assert.equal(store.nextPending(), null);
  const first = store.enqueue(taskFor('task-1'));
  store.enqueue(taskFor('task-2'));
  assert.equal(store.nextPending().id, first.id);
});

// ── pending -> dispatching -> dispatched lifecycle ─────────────────────────

test('markDispatching only transitions a pending entry, and only pending -> dispatching', () => {
  const store = new XQueueStore({ storagePath: tmpStorePath() });
  const entry = store.enqueue(taskFor());
  const dispatching = store.markDispatching(entry.id, 'run-pre-1');
  assert.equal(dispatching.status, 'dispatching');
  assert.equal(typeof dispatching.dispatchingAt, 'string');

  // Cannot dispatching -> dispatching again.
  assert.equal(store.markDispatching(entry.id, 'run-pre-2'), null);
  // Unknown id.
  assert.equal(store.markDispatching('does-not-exist', 'run-pre-3'), null);
});

// B2B requirement 1: markDispatching(id, runId) requires a non-empty string runId.
test('markDispatching requires a non-empty string runId', () => {
  const store = new XQueueStore({ storagePath: tmpStorePath() });
  const entry = store.enqueue(taskFor());
  assert.throws(() => store.markDispatching(entry.id, ''), TypeError);
  assert.throws(() => store.markDispatching(entry.id, null), TypeError);
  assert.throws(() => store.markDispatching(entry.id, undefined), TypeError);
  assert.throws(() => store.markDispatching(entry.id, 42), TypeError);

  // Still pending -- the rejected calls above must not have mutated anything.
  assert.equal(store.nextPending().id, entry.id);
  assert.equal(store.nextPending().status, 'pending');
});

// B2B requirement 2: pending -> dispatching persists that exact runId atomically,
// in the SAME transition as the status/dispatchingAt change (one save() call).
test('markDispatching(id, runId) persists status, dispatchingAt, and the exact runId together', () => {
  const store = new XQueueStore({ storagePath: tmpStorePath() });
  const entry = store.enqueue(taskFor());
  const dispatching = store.markDispatching(entry.id, 'run-abc-123');
  assert.equal(dispatching.status, 'dispatching');
  assert.equal(dispatching.runId, 'run-abc-123');
  assert.equal(typeof dispatching.dispatchingAt, 'string');

  // The in-memory store's own view agrees -- one atomic transition, not two.
  assert.equal(store.listDispatching().length, 1);
  assert.equal(store.listDispatching()[0].runId, 'run-abc-123');
});

test('markDispatched only transitions dispatching -> dispatched, requires a real runId', () => {
  const store = new XQueueStore({ storagePath: tmpStorePath() });
  const entry = store.enqueue(taskFor());

  // Cannot dispatch a still-pending entry directly.
  assert.equal(store.markDispatched(entry.id, 'run-1'), null);

  store.markDispatching(entry.id, 'run-pre');
  assert.throws(() => store.markDispatched(entry.id, ''), TypeError);
  assert.throws(() => store.markDispatched(entry.id, null), TypeError);

  const dispatched = store.markDispatched(entry.id, 'run-1');
  assert.equal(dispatched.status, 'dispatched');
  assert.equal(dispatched.runId, 'run-1');
  assert.equal(typeof dispatched.dispatchedAt, 'string');

  // Cannot dispatched -> dispatched again.
  assert.equal(store.markDispatched(entry.id, 'run-2'), null);
});

test('returnToPending only reverts dispatching -> pending, never dispatched or already-pending', () => {
  const store = new XQueueStore({ storagePath: tmpStorePath() });
  const entry = store.enqueue(taskFor());

  // Cannot revert a plain pending entry (nothing to revert from).
  assert.equal(store.returnToPending(entry.id), null);

  store.markDispatching(entry.id, 'run-first-attempt');
  const reverted = store.returnToPending(entry.id);
  assert.equal(reverted.status, 'pending');
  assert.equal(reverted.dispatchingAt, null);
  // B2B requirement 4: returnToPending clears runId back to null.
  assert.equal(reverted.runId, null);
  assert.equal(store.nextPending().id, entry.id);
  assert.equal(store.nextPending().runId, null);

  // Cannot revert an already-pending entry a second time.
  assert.equal(store.returnToPending(entry.id), null);

  // B2B requirement 5: the next dispatch attempt for this same entry can
  // use a fresh, different runId -- the store does not retain or reuse the
  // cleared one.
  const redispatched = store.markDispatching(entry.id, 'run-second-attempt');
  assert.equal(redispatched.runId, 'run-second-attempt');
  assert.notEqual(redispatched.runId, 'run-first-attempt');

  // Cannot revert a fully dispatched entry.
  store.markDispatched(entry.id, 'run-second-attempt');
  assert.equal(store.returnToPending(entry.id), null);
});

test('findDispatchedByRunId only finds an entry that has actually reached dispatched', () => {
  const store = new XQueueStore({ storagePath: tmpStorePath() });
  const entry = store.enqueue(taskFor());
  assert.equal(store.findDispatchedByRunId('run-1'), null);

  store.markDispatching(entry.id, 'run-1');
  // Even though the entry now genuinely carries this runId while merely
  // `dispatching`, it must still not be findable until it actually reaches
  // `dispatched` -- proving findDispatchedByRunId checks status, not just
  // a runId match.
  assert.equal(store.findDispatchedByRunId('run-1'), null, 'a dispatching (not yet dispatched) entry must not be findable by runId');

  store.markDispatched(entry.id, 'run-1');
  assert.equal(store.findDispatchedByRunId('run-1').id, entry.id);
  assert.equal(store.findDispatchedByRunId('unknown-run'), null);
});

// ── markTerminal invariant ───────────────────────────────────────────────

test('markTerminal only deletes an entry that has reached dispatched -- never pending or dispatching', () => {
  const store = new XQueueStore({ storagePath: tmpStorePath() });

  const pendingEntry = store.enqueue(taskFor('task-pending'));
  assert.equal(store.markTerminal(pendingEntry.id), false, 'a pending entry must never be pruned by markTerminal');
  assert.ok(store.nextPending(), 'the pending entry must still be present');

  const dispatchingEntry = store.enqueue(taskFor('task-dispatching'));
  store.markDispatching(dispatchingEntry.id, 'run-dispatching');
  assert.equal(store.markTerminal(dispatchingEntry.id), false, 'a stuck dispatching entry must never be pruned by markTerminal');
  assert.equal(store.listDispatching().length, 1);

  const dispatchedEntry = store.enqueue(taskFor('task-dispatched'));
  store.markDispatching(dispatchedEntry.id, 'run-dispatched');
  store.markDispatched(dispatchedEntry.id, 'run-dispatched');
  assert.equal(store.markTerminal(dispatchedEntry.id), true);
  assert.equal(store.findDispatchedByRunId('run-dispatched'), null);

  assert.equal(store.markTerminal('does-not-exist'), false);
});

// ── review bookkeeping ────────────────────────────────────────────────────

test('recordReview only accepts needs_review, failed, or interrupted, and requires runId + taskId', () => {
  const store = new XQueueStore({ storagePath: tmpStorePath() });
  assert.throws(() => store.recordReview({ runId: 'run-1', taskId: 'task-1', status: 'completed' }), TypeError);
  assert.throws(() => store.recordReview({ runId: '', taskId: 'task-1', status: 'failed' }), TypeError);
  assert.throws(() => store.recordReview({ runId: null, taskId: 'task-1', status: 'failed' }), TypeError);
  assert.throws(() => store.recordReview({ runId: 'run-1', taskId: '', status: 'failed' }), TypeError);
  assert.throws(() => store.recordReview({ runId: 'run-1', taskId: undefined, status: 'needs_review' }), TypeError);

  const record = store.recordReview({ runId: 'run-1', taskId: 'task-1', status: 'needs_review' });
  assert.equal(record.status, 'needs_review');
  assert.equal(store.hasReview('run-1'), true);
});

// B2A: 'interrupted' (XRunStore's own startup-reconciliation outcome for a
// dead/stale claim) must be an accepted review status, kept literally
// 'interrupted' -- never remapped to 'failed'/'needs_review'/'completed'.
test('recordReview accepts interrupted and records it with the exact record shape', () => {
  const store = new XQueueStore({ storagePath: tmpStorePath() });
  const record = store.recordReview({ runId: 'run-int', taskId: 'task-int', status: 'interrupted' });
  assert.equal(record.status, 'interrupted');
  assert.equal(record.runId, 'run-int');
  assert.equal(record.taskId, 'task-int');
  assert.equal(typeof record.recordedAt, 'string');
  assert.deepEqual(Object.keys(record).sort(), ['recordedAt', 'runId', 'status', 'taskId']);
  assert.equal(store.hasReview('run-int'), true);
});

test('recordReview(interrupted) is idempotent: recording the same runId twice returns the original record unchanged', () => {
  const store = new XQueueStore({ storagePath: tmpStorePath() });
  const first = store.recordReview({ runId: 'run-int', taskId: 'task-int', status: 'interrupted' });
  const second = store.recordReview({ runId: 'run-int', taskId: 'task-int', status: 'interrupted' });
  assert.deepEqual(second, first);
  assert.equal(store.listReviews().length, 1);

  // Even a conflicting later call for the same runId does not overwrite.
  const third = store.recordReview({ runId: 'run-int', taskId: 'different-task', status: 'failed' });
  assert.deepEqual(third, first);
});

test('an interrupted review record survives save/load exactly like needs_review/failed', () => {
  const storagePath = tmpStorePath();
  const store = new XQueueStore({ storagePath });
  store.recordReview({ runId: 'run-int', taskId: 'task-int', status: 'interrupted' });

  const reloaded = new XQueueStore({ storagePath }).load();
  assert.equal(reloaded.hasReview('run-int'), true);
  const record = reloaded.listReviews().find((r) => r.runId === 'run-int');
  assert.equal(record.status, 'interrupted');
});

test('recordReview is idempotent: recording the same runId twice returns the original record unchanged', () => {
  const store = new XQueueStore({ storagePath: tmpStorePath() });
  const first = store.recordReview({ runId: 'run-1', taskId: 'task-1', status: 'failed' });
  const second = store.recordReview({ runId: 'run-1', taskId: 'task-1', status: 'failed' });
  assert.deepEqual(second, first);
  assert.equal(store.listReviews().length, 1);

  // Even a conflicting later call for the same runId does not overwrite.
  const third = store.recordReview({ runId: 'run-1', taskId: 'different-task', status: 'needs_review' });
  assert.deepEqual(third, first);
});

// B2A requirement 4: existing needs_review/failed acceptance is unchanged
// by adding 'interrupted' to the accepted set.
test('needs_review and failed remain accepted alongside interrupted, each with independent idempotency', () => {
  const store = new XQueueStore({ storagePath: tmpStorePath() });
  const review = store.recordReview({ runId: 'run-review', taskId: 'task-review', status: 'needs_review' });
  const failed = store.recordReview({ runId: 'run-failed', taskId: 'task-failed', status: 'failed' });
  const interrupted = store.recordReview({ runId: 'run-interrupted', taskId: 'task-interrupted', status: 'interrupted' });
  assert.equal(review.status, 'needs_review');
  assert.equal(failed.status, 'failed');
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(store.listReviews().length, 3);
});

// ── persistence round-trip ───────────────────────────────────────────────

test('save/load round-trips pending, dispatching, dispatched, and review state exactly, without inventing recovery for a stuck dispatching entry', () => {
  const storagePath = tmpStorePath();
  const store = new XQueueStore({ storagePath });

  const pending = store.enqueue(taskFor('task-pending'));
  const stuckDispatching = store.enqueue(taskFor('task-stuck'));
  store.markDispatching(stuckDispatching.id, 'run-stuck');
  const dispatched = store.enqueue(taskFor('task-dispatched'));
  store.markDispatching(dispatched.id, 'run-dispatched');
  store.markDispatched(dispatched.id, 'run-dispatched');
  store.recordReview({ runId: 'run-old', taskId: 'task-old', status: 'needs_review' });

  const reloaded = new XQueueStore({ storagePath }).load();
  assert.equal(reloaded.listPending().length, 1);
  assert.equal(reloaded.listPending()[0].id, pending.id);

  assert.equal(reloaded.listDispatching().length, 1, 'a stuck dispatching entry must survive restart exactly as dispatching, not auto-reverted or auto-redispatched');
  assert.equal(reloaded.listDispatching()[0].id, stuckDispatching.id);
  assert.equal(reloaded.listDispatching()[0].status, 'dispatching');
  // B2B requirement 3: reload preserves dispatching + runId.
  assert.equal(reloaded.listDispatching()[0].runId, 'run-stuck');

  assert.equal(reloaded.listDispatched().length, 1);
  assert.equal(reloaded.findDispatchedByRunId('run-dispatched').id, dispatched.id);

  assert.equal(reloaded.hasReview('run-old'), true);
});

// B2B requirement 6: a LEGACY entry persisted before B2B (dispatching with
// runId:null, written by the pre-B2B markDispatching(id) shape) must remain
// loadable, completely unchanged -- never migrated, never invented a runId.
// Seeded by writing the store's own on-disk JSON shape directly (the same
// technique 'load falls back to the .bak file' below uses for corrupted
// input), never through the new production markDispatching(id, runId) API,
// which cannot produce this state at all once B2B ships.
test('a legacy persisted dispatching entry with runId:null remains loadable, exactly as persisted', () => {
  const storagePath = tmpStorePath();
  const legacyPayload = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    entries: [{
      id: 'legacy-entry-1',
      task: taskFor('task-legacy'),
      taskId: 'task-legacy',
      status: 'dispatching',
      createdAt: new Date().toISOString(),
      dispatchingAt: new Date().toISOString(),
      dispatchedAt: null,
      runId: null,
    }],
    reviews: [],
  };
  fs.mkdirSync(path.dirname(storagePath), { recursive: true });
  fs.writeFileSync(storagePath, JSON.stringify(legacyPayload, null, 2), 'utf8');

  const store = new XQueueStore({ storagePath }).load();
  assert.equal(store.listDispatching().length, 1);
  const legacy = store.listDispatching()[0];
  assert.equal(legacy.id, 'legacy-entry-1');
  assert.equal(legacy.status, 'dispatching');
  assert.equal(legacy.runId, null, 'a legacy entry must load with runId exactly null, never migrated or invented');
  assert.equal(legacy.taskId, 'task-legacy');
});

test('load falls back to the .bak file when the primary store is corrupted', () => {
  const storagePath = tmpStorePath();
  const store = new XQueueStore({ storagePath });
  store.enqueue(taskFor('task-1'));
  // A second save produces a .bak copy of the (valid) first version.
  store.recordReview({ runId: 'run-1', taskId: 'task-1', status: 'failed' });

  // Force one more save so .bak contains the fully-updated valid state.
  store.save();

  fs.writeFileSync(storagePath, '{not valid json', 'utf8');

  const recovered = new XQueueStore({ storagePath }).load();
  assert.equal(recovered.listPending().length, 1);
  assert.equal(recovered.hasReview('run-1'), true);
});
