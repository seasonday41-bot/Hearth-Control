// Focused tests for XQueueCoordinator: the deterministic runtime queue
// coordinator that dispatches already-authored X tasks one at a time and
// reacts to x_run_terminal notifications by re-reading XRunStore (never
// trusting the event's own status/taskId fields).
//
// Uses REAL XClaimStore/XRunStore (temp SQLite), REAL XQueueStore (temp
// JSON), and the REAL runXTask -- only the ModelAdapter is a deterministic
// fake (no live Ollama), matching this repo's established "real pipeline,
// fake leaf" convention.
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { XQueueCoordinator } from '../mcp/x/queue-coordinator.mjs';
import { XQueueStore } from '../mcp/x/queue-store.mjs';
import { XClaimStore } from '../mcp/x/claim-store.mjs';
import { XRunStore } from '../mcp/x/run-store.mjs';
import { X_TASK_VERSION } from '../mcp/x/task-contract.mjs';
import { runXTask } from '../mcp/x/run-x-task.mjs';
import { createTestXCoderClient } from './lib/test-x-coder-client.mjs';

const dirs = [];
const stores = [];
const fixtureItems = [];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-x-queue-coord-'));
  const dbPath = path.join(root, 'hearth-runtime.sqlite');
  const queuePath = path.join(root, 'x-queue.json');
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'scripts/test-pass.mjs'), "import test from 'node:test';\ntest('passes', () => {});\n");
  dirs.push(root);
  const claimStore = new XClaimStore({ storagePath: dbPath });
  const runStore = new XRunStore({ storagePath: dbPath });
  const queueStore = new XQueueStore({ storagePath: queuePath }).load();
  stores.push(claimStore, runStore);
  const item = { root, dbPath, queuePath, claimStore, runStore, queueStore, xCoderRuntimes: [] };
  fixtureItems.push(item);
  return item;
}

afterEach(() => {
  for (const item of fixtureItems.splice(0)) {
    for (const runtime of item.xCoderRuntimes.splice(0)) {
      try { runtime.client.close(); } catch {}
    }
  }
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function taskFor(item, taskId = 'task-1', { allowedTools = ['repo_read'] } = {}) {
  return {
    version: X_TASK_VERSION, task_id: taskId, parent_task_id: null,
    revision: 1, attempt: 1, based_on_result_id: null,
    objective: 'Run one X task via the queue coordinator.',
    problem: 'The coordinator needs a durable, fenced runner.',
    expected_behavior: 'The coordinator dispatches this already-authored task unchanged.',
    observed_behavior: 'No coordinator wiring existed yet.',
    why_this_matters: 'The coordinator must never author or edit task content.',
    known_evidence: [], suspected_area: [], workspace: { repo: 'Hearth-Control', root: item.root },
    scope: { allowed_paths: ['src'], preferred_files: [], forbidden_paths: [] },
    constraints: { preserve: [], do_not: [] }, allowed_tools: allowedTools,
    acceptance_criteria: ['The run is fenced.'],
    validation: { required: ['node --test scripts/test-pass.mjs'], optional: [] },
    verification: null, done_criteria: ['Required validation passes.'], teaching_notes: [],
    uncertainty_policy: { policy: 'bounded_autonomy', stop_conditions: [] },
    repair_budget: { initial_attempts: 1, max_repairs: 2, max_total_rounds: 3 },
    timing: { estimated_minutes: 5, first_check_after_minutes: 1, soft_deadline_minutes: 3, hard_timeout_minutes: 10 },
    commit_policy: { mode: 'never' },
  };
}

const create = (pathName = 'src/ok.js') => ({ type: 'create', path: pathName, content: 'ok\n' });
const fastModel = (actions = []) => ({
  async generate() {
    return { ok: true, provider: 'fake', model: 'fake', text: JSON.stringify({ actions }), finishReason: 'stop', usage: null, error: null };
  },
});
/** A model whose generate() pauses until externally released, then resolves normally (including on any later call, since `released` stays resolved). */
function controllableModel(actions = []) {
  let resolveRelease;
  const released = new Promise((r) => { resolveRelease = r; });
  let resolveEntered;
  const entered = new Promise((r) => { resolveEntered = r; });
  return {
    entered,
    release: () => resolveRelease(),
    async generate() {
      resolveEntered();
      await released;
      return { ok: true, provider: 'fake', model: 'fake', text: JSON.stringify({ actions }), finishReason: 'stop', usage: null, error: null };
    },
  };
}
/** A model that pauses on its first generate() call until releaseFirst(), then pauses again on its second call until releaseSecond(); later calls resolve immediately. Lets a test deterministically observe two sequential dispatches from one coordinator/model. */
function twoStageControllableModel(actions = []) {
  let resolveFirstEntered, resolveReleaseFirst;
  let resolveSecondEntered, resolveReleaseSecond;
  const firstEntered = new Promise((r) => { resolveFirstEntered = r; });
  const releaseFirstGate = new Promise((r) => { resolveReleaseFirst = r; });
  const secondEntered = new Promise((r) => { resolveSecondEntered = r; });
  const releaseSecondGate = new Promise((r) => { resolveReleaseSecond = r; });
  let callCount = 0;
  return {
    firstEntered,
    releaseFirst: () => resolveReleaseFirst(),
    secondEntered,
    releaseSecond: () => resolveReleaseSecond(),
    async generate() {
      callCount += 1;
      if (callCount === 1) {
        resolveFirstEntered();
        await releaseFirstGate;
      } else if (callCount === 2) {
        resolveSecondEntered();
        await releaseSecondGate;
      }
      return { ok: true, provider: 'fake', model: 'fake', text: JSON.stringify({ actions }), finishReason: 'stop', usage: null, error: null };
    },
  };
}

function coordinatorFor(item, overrides = {}) {
  const modelAdapter = overrides.modelAdapter ?? fastModel([create()]);
  if (!modelAdapter.xCoderClient) {
    const runtime = createTestXCoderClient({ root: item.root, modelAdapter });
    item.xCoderRuntimes.push(runtime);
    Object.defineProperty(modelAdapter, 'xCoderClient', {
      value: runtime.client,
      enumerable: false,
      configurable: true,
    });
  }
  return new XQueueCoordinator({
    queueStore: item.queueStore, claimStore: item.claimStore, runStore: item.runStore,
    modelAdapter,
    ownerId: overrides.ownerId ?? ('owner-' + Math.random().toString(36).slice(2)),
    leaseDurationMs: overrides.leaseDurationMs,
    onAdmissionAccepted: overrides.onAdmissionAccepted,
    onCapacityBlocked: overrides.onCapacityBlocked,
  });
}

test('ingress receipt dispatches once and blocked notification follows return to pending', async () => {
  const item = fixture();
  const blocker = item.claimStore.claim({ taskId: 'other-task', ownerId: 'other-owner' });
  let observed;
  const coordinator = coordinatorFor(item, { onCapacityBlocked: () => {
    observed = item.queueStore.getReceipt('request-1');
  } });
  const identity = { requestId: 'request-1', fingerprint: 'hash-1', workspaceRoot: item.root };
  const first = coordinator.enqueue(taskFor(item), identity);
  assert.ok(['pending', 'dispatching'].includes(first.receipt.queueStatus));
  assert.equal(coordinator.enqueue(taskFor(item), identity).receipt.queueId, first.receipt.queueId);
  await waitUntil(() => observed != null);
  assert.equal(observed.queueStatus, 'pending');
  assert.equal(observed.runId, null);
  item.claimStore.release({ taskId: blocker.taskId, ownerId: blocker.ownerId, leaseId: blocker.leaseId });
  coordinator.kick();
  await waitUntil(() => item.queueStore.getReceipt('request-1').queueStatus === 'terminal');
  assert.equal(item.queueStore.getReceipt('request-1').terminalStatus, 'completed');
});

async function waitUntil(conditionFn, { timeoutMs = 3000, intervalMs = 10, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await conditionFn()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(intervalMs);
  }
}
function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs)),
  ]);
}
/** Fully-drained queue: nothing pending, nothing mid-dispatch, nothing tracked as dispatched. */
function isFullyIdle(item) {
  return item.queueStore.listPending().length === 0
    && item.queueStore.listDispatching().length === 0
    && item.queueStore.listDispatched().length === 0;
}

// ── 1-3: basic enqueue/dispatch lifecycle ───────────────────────────────────

test('1 enqueue dispatches one already-authored task', async () => {
  const item = fixture();
  const controlled = controllableModel([create()]);
  const coordinator = coordinatorFor(item, { modelAdapter: controlled });
  coordinator.enqueue(taskFor(item, 'task-1'));

  await controlled.entered;
  await waitUntil(() => item.queueStore.listDispatched().length === 1, { label: 'the entry to reach dispatched' });
  const runId = item.queueStore.listDispatched()[0].runId;

  controlled.release();
  await waitUntil(() => isFullyIdle(item), { label: 'the task to reach a terminal outcome' });

  const run = item.runStore.getRun(runId);
  assert.ok(run);
  assert.equal(run.status, 'completed');
});

test('2 only one task runs at a time', async () => {
  const item = fixture();
  const controlled = controllableModel([create()]);
  const coordinator = coordinatorFor(item, { modelAdapter: controlled });

  coordinator.enqueue(taskFor(item, 'task-1'));
  await controlled.entered;
  await waitUntil(() => item.queueStore.listDispatched().length === 1, { label: 'the first entry to reach dispatched' });
  coordinator.enqueue(taskFor(item, 'task-2'));

  assert.equal(item.queueStore.listDispatched().length, 1, 'only one entry may be dispatched at a time');
  assert.equal(item.queueStore.listPending().length, 1, 'the second task must remain queued, not dispatched');

  const result = await coordinator.dispatchNext();
  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'inflight_or_ambiguous');

  controlled.release();
  await waitUntil(() => isFullyIdle(item), { label: 'both tasks to fully finish' });
});

test('3 pending -> dispatching -> dispatched ordering is observed in sequence', async () => {
  const item = fixture();
  const controlled = controllableModel([create()]);
  const coordinator = coordinatorFor(item, { modelAdapter: controlled });

  // Enqueue directly on the store (not via coordinator.enqueue, which would
  // itself schedule a dispatch attempt before we can observe the starting
  // `pending` state deterministically).
  const entry = item.queueStore.enqueue(taskFor(item, 'task-1'));
  assert.equal(item.queueStore.listPending()[0]?.id, entry.id, 'the entry begins pending before dispatchNext() is ever called');

  let markDispatchingCalled = false;
  const originalMarkDispatching = item.queueStore.markDispatching.bind(item.queueStore);
  item.queueStore.markDispatching = (id, runId) => {
    const result = originalMarkDispatching(id, runId);
    if (result) markDispatchingCalled = true;
    return result;
  };

  const dispatchPromise = coordinator.dispatchNext();
  await controlled.entered;
  // By construction dispatchNext() calls queueStore.markDispatching(...)
  // synchronously before ever calling runXTask -- and runXTask cannot reach
  // modelAdapter.generate() without first completing its own admission,
  // which only happens after markDispatching already ran. Observing
  // `entered` therefore already proves the ordering; this instrumented flag
  // makes that explicit rather than merely trusted.
  assert.equal(markDispatchingCalled, true, 'markDispatching must have been called before generate() was entered');

  await waitUntil(() => item.queueStore.listDispatched().length === 1, { label: 'dispatched to follow dispatching' });
  assert.equal(item.queueStore.listDispatched()[0].id, entry.id);
  assert.ok(item.queueStore.listDispatched()[0].runId);

  await dispatchPromise;
  controlled.release();
  await waitUntil(() => isFullyIdle(item), { label: 'terminal cleanup' });
});

// ── 4-5: definite non-admission vs ambiguous throw ──────────────────────────

test('4 accepted:false (no_capacity) returns the task to pending, never drops it', async () => {
  const item = fixture();
  const blocker = new XClaimStore({ storagePath: item.dbPath });
  stores.push(blocker);
  blocker.claim({ taskId: 'blocking-task', ownerId: 'blocker-owner' });

  const coordinator = coordinatorFor(item, { modelAdapter: fastModel([create()]) });
  const entry = item.queueStore.enqueue(taskFor(item, 'task-1'));

  const result = await coordinator.dispatchNext();
  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'no_capacity');
  assert.equal(item.queueStore.listPending().length, 1);
  assert.equal(item.queueStore.listPending()[0].id, entry.id);
  assert.equal(item.queueStore.listDispatching().length, 0);
  assert.equal(item.queueStore.listDispatched().length, 0);
});

test('5 runXTask throwing leaves the entry in dispatching, ambiguous, never guessed at', async () => {
  const item = fixture();
  const coordinator = coordinatorFor(item, { modelAdapter: fastModel([create()]) });

  // An invalid task makes runXTask's own parseXTask throw synchronously,
  // before runXTask returns any {accepted,...} shape -- a REAL throw from
  // the real, unmodified runXTask.
  const invalidTask = { version: X_TASK_VERSION, task_id: 'task-invalid' };
  const entry = item.queueStore.enqueue(invalidTask);

  const result = await coordinator.dispatchNext();
  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'ambiguous_throw');
  assert.equal(result.entryId, entry.id);
  assert.ok(coordinator.lastDispatchError);
  assert.equal(coordinator.lastDispatchError.entryId, entry.id);

  const reloaded = item.queueStore.listDispatching();
  assert.equal(reloaded.length, 1);
  assert.equal(reloaded[0].id, entry.id, 'the entry must remain dispatching, not reverted to pending and not dropped');
});

// ── 6-8: terminal outcomes ───────────────────────────────────────────────

test('6 COMPLETED prunes the tracked entry and dispatches the next already-queued task', async () => {
  const item = fixture();
  const model = twoStageControllableModel([create()]);
  const coordinator = coordinatorFor(item, { modelAdapter: model });

  coordinator.enqueue(taskFor(item, 'task-1'));
  await model.firstEntered;
  await waitUntil(() => item.queueStore.listDispatched().length === 1, { label: 'task-1 queue entry to reach dispatched' });
  const runId1 = item.queueStore.listDispatched()[0].runId;

  const entry2 = coordinator.enqueue(taskFor(item, 'task-2'));
  assert.equal(item.queueStore.listPending().some((e) => e.id === entry2.id), true, 'task-2 must remain pending while task-1 occupies the slot');
  assert.equal(item.queueStore.listDispatched().length, 1);

  model.releaseFirst();
  await withTimeout(model.secondEntered, 2000, 'terminal handling of task-1 to dispatch the already-pending task-2');
  await waitUntil(() => item.queueStore.listDispatched().some((e) => e.id === entry2.id), { label: 'task-2 queue entry to reach dispatched' });

  assert.equal(item.queueStore.findDispatchedByRunId(runId1), null, 'task-1 runId is no longer tracked');
  assert.equal(item.queueStore.listReviews().length, 0, 'no review exists for task-1');

  model.releaseSecond();
  await waitUntil(() => isFullyIdle(item), { label: 'task-2 to fully finish' });
});

test('7 NEEDS_REVIEW records review before pruning, and still dispatches the next task', async () => {
  const item = fixture();
  const model = twoStageControllableModel([create('src/.env')]);
  const coordinator = coordinatorFor(item, { modelAdapter: model });

  // Write authority is required here: a read-only task's actions are
  // discarded by the read-only authority boundary before this deliberately
  // protected-path action could ever reach PROTECTED_PATH/NEEDS_REVIEW --
  // see mcp/x/local-executor.mjs's enforceReadOnlyActionBoundary.
  coordinator.enqueue(taskFor(item, 'task-review', { allowedTools: ['repo_read', 'repo_edit'] }));
  await model.firstEntered;
  await waitUntil(() => item.queueStore.listDispatched().length === 1, { label: 'task-review to reach dispatched' });

  const entry2 = coordinator.enqueue(taskFor(item, 'task-2'));
  assert.equal(item.queueStore.listPending().some((e) => e.id === entry2.id), true);

  model.releaseFirst();
  await withTimeout(model.secondEntered, 2000, 'terminal handling of task-review to dispatch the already-pending task-2');
  await waitUntil(() => item.queueStore.listDispatched().some((e) => e.id === entry2.id), { label: 'task-2 queue entry to reach dispatched' });

  const reviews = item.queueStore.listReviews();
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].status, 'needs_review');
  assert.equal(reviews[0].taskId, 'task-review');
  assert.equal(item.queueStore.findDispatchedByRunId(reviews[0].runId), null, 'the entry must already be pruned once its review is recorded');

  model.releaseSecond();
  await waitUntil(() => isFullyIdle(item), { label: 'task-2 to fully finish' });
});

test('8 FAILED records review before pruning, and still dispatches the next task', async () => {
  const item = fixture();
  const model = twoStageControllableModel([create('outside/no.js')]);
  const coordinator = coordinatorFor(item, { modelAdapter: model });

  // Write authority required so this deliberately out-of-scope action
  // actually reaches PATH_REJECTED instead of being discarded by the
  // read-only authority boundary.
  coordinator.enqueue(taskFor(item, 'task-failed', { allowedTools: ['repo_read', 'repo_edit'] }));
  await model.firstEntered;
  await waitUntil(() => item.queueStore.listDispatched().length === 1, { label: 'task-failed to reach dispatched' });

  const entry2 = coordinator.enqueue(taskFor(item, 'task-2'));
  assert.equal(item.queueStore.listPending().some((e) => e.id === entry2.id), true);

  model.releaseFirst();
  await withTimeout(model.secondEntered, 2000, 'terminal handling of task-failed to dispatch the already-pending task-2');
  await waitUntil(() => item.queueStore.listDispatched().some((e) => e.id === entry2.id), { label: 'task-2 queue entry to reach dispatched' });

  const reviews = item.queueStore.listReviews();
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].status, 'failed');
  assert.equal(reviews[0].taskId, 'task-failed');

  model.releaseSecond();
  await waitUntil(() => isFullyIdle(item), { label: 'task-2 to fully finish' });
});

// ── 9-11: idempotency, notification-only re-read ────────────────────────────

test('9 duplicate terminal event for the same runId does not dispatch twice or re-record review', async () => {
  const item = fixture();
  const controlled = controllableModel([create('src/.env')]);
  const coordinator = coordinatorFor(item, { modelAdapter: controlled });
  // Write authority required so this deliberately protected-path action
  // actually reaches PROTECTED_PATH/NEEDS_REVIEW instead of being discarded
  // by the read-only authority boundary.
  coordinator.enqueue(taskFor(item, 'task-1', { allowedTools: ['repo_read', 'repo_edit'] }));
  await controlled.entered;
  await waitUntil(() => item.queueStore.listDispatched().length === 1, { label: 'the entry to reach dispatched' });
  const runId = item.queueStore.listDispatched()[0].runId;

  controlled.release();
  await waitUntil(() => item.queueStore.listReviews().length === 1, { label: 'first reaction' });
  // NEEDS_REVIEW ordering is intentionally recordReview() then
  // markTerminal() -- there is a valid tiny window where the review exists
  // but the entry has not yet been pruned. Wait for pruning explicitly so
  // the duplicate below is unambiguously replayed AFTER the first reaction
  // has fully completed, not racing the tail end of it.
  await waitUntil(() => item.queueStore.findDispatchedByRunId(runId) === null, { label: 'first terminal reaction to prune the tracked entry' });
  const dispatchCallsBefore = item.queueStore.listDispatched().length;

  const replay = coordinator.onXRunTerminal({ type: 'x_run_terminal', runId, taskId: 'task-1', status: 'needs_review' });
  assert.equal(replay.handled, false);
  assert.equal(replay.reason, 'not_tracked');
  assert.equal(item.queueStore.listReviews().length, 1, 'no second review record');
  assert.equal(item.queueStore.listDispatched().length, dispatchCallsBefore, 'no extra dispatch triggered by the duplicate');
});

test('10 persisted run still running -> persisted_not_terminal, no writes', async () => {
  const item = fixture();
  const controlled = controllableModel([create()]);
  const coordinator = coordinatorFor(item, { modelAdapter: controlled });
  coordinator.enqueue(taskFor(item, 'task-1'));
  await controlled.entered;
  await waitUntil(() => item.queueStore.listDispatched().length === 1, { label: 'the entry to reach dispatched' });
  const runId = item.queueStore.listDispatched()[0].runId;

  assert.equal(item.runStore.getRun(runId).status, 'running');

  const result = coordinator.onXRunTerminal({ type: 'x_run_terminal', runId, taskId: 'task-1', status: 'completed' });
  assert.equal(result.handled, false);
  assert.equal(result.reason, 'persisted_not_terminal');
  assert.equal(item.queueStore.listDispatched().length, 1, 'still tracked, unchanged');
  assert.equal(item.queueStore.listReviews().length, 0);

  controlled.release();
  await waitUntil(() => isFullyIdle(item), { label: 'cleanup' });
});

test('11 a real, terminal X run this coordinator never dispatched is untracked -- no review, no queue mutation, no dispatch-next', async () => {
  const item = fixture();
  const coordinator = coordinatorFor(item, { modelAdapter: fastModel([create()]) });

  // A run started entirely outside this coordinator (test-only direct use
  // of the real, unmodified runXTask), proving the B1 invariant against a
  // genuinely real, persisted terminal run -- not merely a nonexistent
  // runId -- that this coordinator simply never tracked.
  const externalModel = fastModel([create('outside/no.js')]);
  const externalRuntime = createTestXCoderClient({ root: item.root, modelAdapter: externalModel });
  item.xCoderRuntimes.push(externalRuntime);
  const externalAdmitted = await runXTask(
    taskFor(item, 'external-task', { allowedTools: ['repo_read', 'repo_edit'] }),
    externalModel,
    {
      claimStore: item.claimStore,
      runStore: item.runStore,
      ownerId: 'external-owner-not-this-coordinator',
      xCoderClient: externalRuntime.client,
      xCoderPollIntervalMs: 1,
    },
  );
  assert.equal(externalAdmitted.accepted, true);

  const externalOutcome = await externalAdmitted.done;
  assert.ok(externalOutcome.run);
  assert.equal(externalOutcome.run.runId, externalAdmitted.runId);
  assert.equal(externalOutcome.run.taskId, 'external-task');
  assert.equal(externalOutcome.run.status, 'failed');

  const externalRun = item.runStore.getRun(externalAdmitted.runId);
  assert.equal(externalRun.status, 'failed');
  assert.equal(externalOutcome.run.runId, externalRun.runId);
  assert.equal(externalOutcome.run.status, externalRun.status);

  assert.equal(item.queueStore.findDispatchedByRunId(externalAdmitted.runId), null, 'this coordinator never tracked this run');

  const result = coordinator.onXRunTerminal({
    type: 'x_run_terminal', runId: externalAdmitted.runId, status: 'failed', taskId: 'forged',
  });
  assert.equal(result.handled, false);
  assert.equal(result.reason, 'not_tracked');
  assert.equal(item.queueStore.listReviews().length, 0);
  assert.equal(item.queueStore.listPending().length, 0);
  assert.equal(item.queueStore.listDispatching().length, 0);
  assert.equal(item.queueStore.listDispatched().length, 0);
});

// ── 12: serial blocking ──────────────────────────────────────────────────

test('12 a dispatching or dispatched entry blocks dispatchNext', async () => {
  const item = fixture();
  const controlled = controllableModel([create()]);
  const coordinator = coordinatorFor(item, { modelAdapter: controlled });
  coordinator.enqueue(taskFor(item, 'task-1'));
  coordinator.enqueue(taskFor(item, 'task-2'));

  await waitUntil(() => item.queueStore.listDispatching().length === 1 || item.queueStore.listDispatched().length === 1, { label: 'first task to occupy the slot' });
  const blocked = await coordinator.dispatchNext();
  assert.equal(blocked.dispatched, false);
  assert.equal(blocked.reason, 'inflight_or_ambiguous');

  controlled.release();
  await waitUntil(() => isFullyIdle(item), { label: 'both tasks to fully finish' });
});

// ── 13-15: kick() ────────────────────────────────────────────────────────

test('13 kick() retries a pending task after a prior no_capacity denial', async () => {
  const item = fixture();
  const blocker = new XClaimStore({ storagePath: item.dbPath });
  stores.push(blocker);
  const blockClaim = blocker.claim({ taskId: 'blocking-task', ownerId: 'blocker-owner' });
  assert.ok(blockClaim);

  const controlled = controllableModel([create()]);
  const coordinator = coordinatorFor(item, { modelAdapter: controlled });
  const entry = item.queueStore.enqueue(taskFor(item, 'task-1'));

  const denied = await coordinator.dispatchNext();
  assert.equal(denied.dispatched, false);
  assert.equal(denied.reason, 'no_capacity');
  assert.equal(item.queueStore.listPending().length, 1);
  assert.equal(item.queueStore.listPending()[0].id, entry.id);

  assert.equal(blocker.release({ taskId: 'blocking-task', ownerId: 'blocker-owner', leaseId: blockClaim.leaseId }), true);

  coordinator.kick();
  await controlled.entered;
  await waitUntil(() => item.queueStore.listDispatched().some((e) => e.id === entry.id), { label: 'kick() to dispatch the same still-queued task once capacity frees up' });
  assert.equal(item.queueStore.listDispatched().length, 1);

  controlled.release();
  await waitUntil(() => isFullyIdle(item), { label: 'full cleanup' });
});

test('14 kick() cannot bypass an inflight/ambiguous entry', async () => {
  const item = fixture();
  const controlled = controllableModel([create()]);
  const coordinator = coordinatorFor(item, { modelAdapter: controlled });
  coordinator.enqueue(taskFor(item, 'task-1'));
  await controlled.entered;
  await waitUntil(() => item.queueStore.listDispatched().length === 1, { label: 'the entry to reach dispatched' });

  // dispatchNext()'s reentrancy/inflight checks run synchronously before any
  // await, so by the time kick() (a synchronous call into
  // _scheduleDispatch -> dispatchNext) returns control here, the decision
  // to block is already fully settled -- no wait is needed to observe it.
  coordinator.kick();
  assert.equal(item.queueStore.listDispatched().length, 1, 'kick() must not start a second dispatch while one is in flight');
  assert.equal(item.queueStore.listDispatching().length, 0);

  controlled.release();
  await waitUntil(() => isFullyIdle(item), { label: 'full cleanup' });
});

test('15 repeated/overlapping kick() calls cannot double-dispatch', async () => {
  const item = fixture();
  const controlled = controllableModel([create()]);
  const coordinator = coordinatorFor(item, { modelAdapter: controlled });
  coordinator.enqueue(taskFor(item, 'task-1'));
  await controlled.entered;
  await waitUntil(() => item.queueStore.listDispatched().length === 1, { label: 'the entry to reach dispatched' });

  coordinator.kick();
  coordinator.kick();
  coordinator.kick();
  assert.equal(item.queueStore.listDispatched().length, 1);
  assert.equal(item.queueStore.listDispatching().length, 0);

  controlled.release();
  await waitUntil(() => isFullyIdle(item), { label: 'full cleanup' });
});

// ── 16: restart ──────────────────────────────────────────────────────────

test('16 a restart-loaded dispatching entry remains blocked, never auto-redispatched', async () => {
  const item = fixture();
  const stuck = item.queueStore.enqueue(taskFor(item, 'task-stuck'));
  item.queueStore.markDispatching(stuck.id, 'run-stuck');

  const reloadedQueueStore = new XQueueStore({ storagePath: item.queuePath }).load();
  assert.equal(reloadedQueueStore.listDispatching().length, 1);

  const coordinator = new XQueueCoordinator({
    queueStore: reloadedQueueStore, claimStore: item.claimStore, runStore: item.runStore,
    modelAdapter: fastModel([create()]), ownerId: 'restart-owner',
  });
  const result = await coordinator.dispatchNext();
  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'inflight_or_ambiguous');
  assert.equal(reloadedQueueStore.listDispatching().length, 1, 'the stuck entry must remain exactly as dispatching after restart');
});

// ── 17-18: authority boundaries ──────────────────────────────────────────

test('17 no Codex/Claude path exists anywhere in the coordinator\'s executable source', () => {
  const source = fs.readFileSync(new URL('../mcp/x/queue-coordinator.mjs', import.meta.url), 'utf8');
  const codeOnly = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(codeOnly.toLowerCase(), /codex|claude/);
});

test('18 the coordinator never modifies the task payload/objective it was given', async () => {
  const item = fixture();
  const coordinator = coordinatorFor(item, { modelAdapter: fastModel([create()]) });
  const task = taskFor(item, 'task-1');
  const snapshotBefore = JSON.stringify(task);

  coordinator.enqueue(task);
  await waitUntil(() => isFullyIdle(item), { label: 'the task to fully finish' });

  assert.equal(JSON.stringify(task), snapshotBefore, 'the exact object handed to enqueue() must be byte-identical afterward');
});

// ── 19-23: notification-only re-read from XRunStore ─────────────────────────

test('19 event claims failed but persisted run is completed -> completed wins, no review', async () => {
  const item = fixture();
  const controlled = controllableModel([create()]);
  const coordinator = coordinatorFor(item, { modelAdapter: controlled });
  const entry = coordinator.enqueue(taskFor(item, 'task-1'));
  await controlled.entered;
  await waitUntil(() => item.queueStore.listDispatched().length === 1, { label: 'task-1 queue entry to reach dispatched' });
  const runId = item.queueStore.listDispatched()[0].runId;

  // Test-only stub: suppress the coordinator's own automatic terminal
  // reaction so the entry is still tracked when we feed it a forged event
  // below. Production behavior (dispatchNext's admitted.done observer) is
  // never modified -- only this test instance's method reference, and only
  // for the deterministic window this test needs.
  let resolveSuppressed;
  const suppressed = new Promise((resolve) => { resolveSuppressed = resolve; });
  const realOnXRunTerminal = coordinator.onXRunTerminal.bind(coordinator);
  coordinator.onXRunTerminal = (event) => {
    resolveSuppressed(event);
    return { handled: false, reason: 'test_stub_suppressed' };
  };

  controlled.release();
  await withTimeout(suppressed, 2000, 'automatic terminal observer to hit the suppression stub');

  assert.equal(item.runStore.getRun(runId).status, 'completed');
  assert.equal(item.queueStore.findDispatchedByRunId(runId)?.id, entry.id, 'still tracked -- automatic reaction was suppressed');

  coordinator.onXRunTerminal = realOnXRunTerminal;
  const forged = coordinator.onXRunTerminal({ type: 'x_run_terminal', runId, taskId: 'whatever', status: 'failed' });

  assert.equal(forged.handled, true);
  assert.equal(item.queueStore.listReviews().length, 0, 'persisted COMPLETED must win over a forged failed event -- no review created');
  assert.equal(item.queueStore.findDispatchedByRunId(runId), null, 'the entry must be pruned as COMPLETED');
});

test('20 a wrong event.taskId is ignored -- the persisted run\'s taskId is what is used', async () => {
  const item = fixture();
  const controlled = controllableModel([create('src/.env')]);
  const coordinator = coordinatorFor(item, { modelAdapter: controlled });
  // Write authority required so this deliberately protected-path action
  // actually reaches PROTECTED_PATH/NEEDS_REVIEW instead of being discarded
  // by the read-only authority boundary.
  const entry = coordinator.enqueue(taskFor(item, 'task-real', { allowedTools: ['repo_read', 'repo_edit'] }));
  await controlled.entered;
  await waitUntil(() => item.queueStore.listDispatched().length === 1, { label: 'task-real queue entry to reach dispatched' });
  const runId = item.queueStore.listDispatched()[0].runId;

  let resolveSuppressed;
  const suppressed = new Promise((resolve) => { resolveSuppressed = resolve; });
  const realOnXRunTerminal = coordinator.onXRunTerminal.bind(coordinator);
  coordinator.onXRunTerminal = (event) => {
    resolveSuppressed(event);
    return { handled: false, reason: 'test_stub_suppressed' };
  };

  controlled.release();
  await withTimeout(suppressed, 2000, 'automatic terminal observer to hit the suppression stub');

  assert.equal(item.runStore.getRun(runId).status, 'needs_review');
  assert.equal(item.queueStore.findDispatchedByRunId(runId)?.id, entry.id, 'still tracked -- automatic reaction was suppressed');

  coordinator.onXRunTerminal = realOnXRunTerminal;
  const forged = coordinator.onXRunTerminal({ type: 'x_run_terminal', runId, taskId: 'forged-wrong-task-id', status: 'needs_review' });

  assert.equal(forged.handled, true);
  assert.equal(item.queueStore.listReviews().length, 1);
  assert.equal(item.queueStore.listReviews()[0].taskId, 'task-real', 'must be the persisted taskId, never the forged event.taskId');
  assert.equal(item.queueStore.findDispatchedByRunId(runId), null, 'the entry must be pruned');
});

test('21 queue-tracked taskId disagreeing with the persisted run\'s taskId -> task_mismatch, no writes', async () => {
  const item = fixture();
  const controlled = controllableModel([create()]);
  const coordinator = coordinatorFor(item, { modelAdapter: controlled });
  coordinator.enqueue(taskFor(item, 'task-1'));
  await controlled.entered;
  await waitUntil(() => item.queueStore.listDispatched().length === 1, { label: 'the entry to reach dispatched' });
  const dispatchedEntry = item.queueStore.listDispatched()[0];
  const runId = dispatchedEntry.runId;

  // White-box: corrupt the queue's own taskId bookkeeping for this entry to
  // simulate a disagreement with persisted truth (this store has no public
  // API for it, by design -- it should never happen in real operation).
  item.queueStore.entries.get(dispatchedEntry.id).taskId = 'a-completely-different-task-id';

  controlled.release();
  await waitUntil(() => item.runStore.getRun(runId).status === 'completed', { label: 'the run to persist completed' });

  const result = coordinator.onXRunTerminal({ type: 'x_run_terminal', runId, taskId: 'task-1', status: 'completed' });
  assert.equal(result.handled, false);
  assert.equal(result.reason, 'task_mismatch');
  assert.equal(item.queueStore.findDispatchedByRunId(runId)?.id, dispatchedEntry.id, 'the entry must NOT be pruned on a mismatch');
  assert.equal(item.queueStore.listReviews().length, 0);
});

test('22 persisted run still running is rejected before any write (event-triggered)', async () => {
  const item = fixture();
  const controlled = controllableModel([create()]);
  const coordinator = coordinatorFor(item, { modelAdapter: controlled });
  coordinator.enqueue(taskFor(item, 'task-1'));
  await controlled.entered;
  await waitUntil(() => item.queueStore.listDispatched().length === 1, { label: 'the entry to reach dispatched' });
  const runId = item.queueStore.listDispatched()[0].runId;

  const result = coordinator.onXRunTerminal({ type: 'x_run_terminal', runId, taskId: 'task-1', status: 'completed' });
  assert.equal(result.reason, 'persisted_not_terminal');
  assert.equal(item.queueStore.listDispatched().length, 1);

  controlled.release();
  await waitUntil(() => isFullyIdle(item), { label: 'cleanup' });
});

test('23 a throwing terminal handler never produces an unhandled rejection from the admitted.done observer', async () => {
  const item = fixture();
  let unhandled = null;
  const onUnhandled = (err) => { unhandled = err; };
  process.on('unhandledRejection', onUnhandled);

  try {
    const coordinator = coordinatorFor(item, { modelAdapter: fastModel([create()]) });
    const originalGetRun = item.runStore.getRun.bind(item.runStore);
    let threwOnce = false;
    item.runStore.getRun = (...args) => {
      if (!threwOnce) { threwOnce = true; throw new Error('simulated terminal-bookkeeping failure'); }
      return originalGetRun(...args);
    };

    coordinator.enqueue(taskFor(item, 'task-1'));
    await waitUntil(() => threwOnce, { label: 'the terminal handler to hit the injected throw' });
    await sleep(50);

    assert.equal(unhandled, null, 'a throwing onXRunTerminal (via a throwing runStore.getRun) must never surface as an unhandled rejection');
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
});

// ── B2A: persisted 'interrupted' reconciliation (dispatched entries only) ──
//
// 'interrupted' is XRunStore's own startup-reconciliation outcome for a
// dead/stale claim (run-store.mjs's reconcileStartupState, already invoked
// by getProductionXRuntime() before Electron's XQueueCoordinator is even
// constructed). By the time a queue-level reconciliation ever runs, that
// transition has already happened and the claim is already gone -- these
// tests seed exactly that end state directly via the same public
// XRunStore/XQueueStore APIs createRun/markRunning/markInterrupted and
// enqueue/markDispatching/markDispatched already use elsewhere in this
// repo's own run-store/queue-store test suites, rather than starting a real
// runXTask and hoping to catch it mid-flight -- there is no live claim, no
// live model, and no live runXTask promise for task-1 in either test below.

/** Wraps a real XQueueStore, recording call order for recordReview/markTerminal only -- every other method is passed through unchanged. */
function orderTrackingQueueStore(realStore, order) {
  return {
    enqueue: (...a) => realStore.enqueue(...a),
    nextPending: (...a) => realStore.nextPending(...a),
    markDispatching: (...a) => realStore.markDispatching(...a),
    markDispatched: (...a) => realStore.markDispatched(...a),
    returnToPending: (...a) => realStore.returnToPending(...a),
    findDispatchedByRunId: (...a) => realStore.findDispatchedByRunId(...a),
    listPending: (...a) => realStore.listPending(...a),
    listDispatching: (...a) => realStore.listDispatching(...a),
    listDispatched: (...a) => realStore.listDispatched(...a),
    listReviews: (...a) => realStore.listReviews(...a),
    hasReview: (...a) => realStore.hasReview(...a),
    recordReview: (...a) => { order.push('recordReview'); return realStore.recordReview(...a); },
    markTerminal: (...a) => { order.push('markTerminal'); return realStore.markTerminal(...a); },
  };
}

test('24 tracked dispatched entry + persisted interrupted run -> handled true, review interrupted, recorded before prune, entry removed', () => {
  const item = fixture();
  const callOrder = [];
  const spyStore = orderTrackingQueueStore(item.queueStore, callOrder);

  const entry = item.queueStore.enqueue(taskFor(item, 'task-1'));
  const runId = 'run-task-1';
  item.queueStore.markDispatching(entry.id, runId);
  item.runStore.createRun({ runId, taskId: 'task-1' });
  item.runStore.markRunning({ runId, claimLeaseId: 'lease-1' });
  const interrupted = item.runStore.markInterrupted(runId);
  assert.equal(interrupted.status, 'interrupted');
  item.queueStore.markDispatched(entry.id, runId);

  const coordinator = new XQueueCoordinator({
    queueStore: spyStore, claimStore: item.claimStore, runStore: item.runStore,
    modelAdapter: fastModel([create()]), ownerId: `owner-${Math.random().toString(36).slice(2)}`,
  });

  const result = coordinator.onXRunTerminal({ runId });
  assert.equal(result.handled, true);

  const reviews = item.queueStore.listReviews();
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].status, 'interrupted');
  assert.equal(reviews[0].runId, runId);
  assert.equal(reviews[0].taskId, 'task-1');
  assert.equal(item.queueStore.findDispatchedByRunId(runId), null, 'the entry is pruned once its review is recorded');
  assert.deepEqual(callOrder, ['recordReview', 'markTerminal'], 'review must be recorded BEFORE the queue entry is pruned');
});

test('25 interrupted does not block the next already-pending X task', async () => {
  const item = fixture();

  const entry1 = item.queueStore.enqueue(taskFor(item, 'task-1'));
  const runId1 = 'run-task-1';
  item.queueStore.markDispatching(entry1.id, runId1);
  item.runStore.createRun({ runId: runId1, taskId: 'task-1' });
  item.runStore.markRunning({ runId: runId1, claimLeaseId: 'lease-1' });
  item.runStore.markInterrupted(runId1);
  item.queueStore.markDispatched(entry1.id, runId1);

  const model = controllableModel([create()]);
  const coordinator = coordinatorFor(item, { modelAdapter: model });

  const entry2 = coordinator.enqueue(taskFor(item, 'task-2'));
  assert.equal(item.queueStore.listPending().some((e) => e.id === entry2.id), true, 'task-2 remains pending while task-1\'s stale dispatched entry blocks the serial gate');

  const result = coordinator.onXRunTerminal({ runId: runId1 });
  assert.equal(result.handled, true);
  const reviews = item.queueStore.listReviews();
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].status, 'interrupted');
  assert.equal(item.queueStore.findDispatchedByRunId(runId1), null);

  await withTimeout(model.entered, 2000, 'task-2 dispatch after task-1 interrupted reconciliation');
  await waitUntil(() => item.queueStore.listDispatched().some((e) => e.id === entry2.id), { label: 'task-2 to reach dispatched' });

  model.release();
  await waitUntil(() => isFullyIdle(item), { label: 'task-2 to fully finish' });
});

test('26 persisted running run stays persisted_not_terminal: dispatched entry preserved, no review, no next dispatch', async () => {
  const item = fixture();
  const controlled = controllableModel([create()]);
  const coordinator = coordinatorFor(item, { modelAdapter: controlled });

  coordinator.enqueue(taskFor(item, 'task-1'));
  await controlled.entered;

  await waitUntil(
    () => item.queueStore.listDispatched().length === 1,
    { label: 'task-1 to reach dispatched' },
  );

  const runId = item.queueStore.listDispatched()[0].runId;
  assert.equal(item.runStore.getRun(runId).status, 'running');

  const entry2 = coordinator.enqueue(taskFor(item, 'task-2'));

  const result = coordinator.onXRunTerminal({ runId });

  assert.equal(result.handled, false);
  assert.equal(result.reason, 'persisted_not_terminal');

  assert.equal(
    item.queueStore.listDispatched().length,
    1,
    'task-1 entry preserved, not pruned',
  );

  assert.notEqual(
    item.queueStore.findDispatchedByRunId(runId),
    null,
  );

  assert.equal(
    item.queueStore.listReviews().length,
    0,
    'no review recorded',
  );

  assert.equal(
    item.queueStore.listPending().some((e) => e.id === entry2.id),
    true,
    'task-2 remains pending -- no next dispatch was triggered',
  );

  controlled.release();

  await waitUntil(
    () => isFullyIdle(item),
    { label: 'cleanup' },
  );
});

test('27 live deriveTerminalEvent contract remains limited to completed/needs_review/failed -- interrupted never broadens it', () => {
  const source = fs.readFileSync(
    new URL('../mcp/x/queue-coordinator.mjs', import.meta.url),
    'utf8',
  );

  const eventSetMatch = source.match(
    /const EVENT_TERMINAL_STATUSES = new Set\(\[([^\]]*)\]\);/,
  );

  assert.ok(
    eventSetMatch,
    'EVENT_TERMINAL_STATUSES must exist as a literal Set',
  );

  const eventStatuses = eventSetMatch[1]
    .split(',')
    .map((s) => s.trim().replace(/^'|'$/g, ''))
    .filter(Boolean);

  assert.deepEqual(
    eventStatuses.sort(),
    ['completed', 'failed', 'needs_review'],
    'the live transport contract must remain exactly completed/needs_review/failed',
  );

  assert.equal(
    eventStatuses.includes('interrupted'),
    false,
  );

  const fnMatch = source.match(
    /function deriveTerminalEvent\(outcome\) \{[\s\S]*?\n\}/,
  );

  assert.ok(
    fnMatch,
    'deriveTerminalEvent function body must be found',
  );

  const body = fnMatch[0];

  assert.match(
    body,
    /EVENT_TERMINAL_STATUSES\.has\(run\.status\)/,
    'deriveTerminalEvent must gate on EVENT_TERMINAL_STATUSES',
  );

  assert.doesNotMatch(
    body,
    /PERSISTED_TERMINAL_STATUSES/,
    'deriveTerminalEvent must never reference the persisted-reconciliation terminal set',
  );
});

// ── B2B: durable dispatch correlation (pre-generated runId) ────────────────
//
// Phase B2B pre-generates a runId in the coordinator BEFORE calling
// runXTask, persists it into the queue entry in the SAME atomic transition
// as `dispatching` (markDispatching(id, runId)), and passes that exact same
// runId into runXTask's own already-existing `runId` option. This makes a
// crashed-mid-dispatch entry deterministically resolvable later via
// reconcileDispatchingEntry, using only that runId -- never a taskId-based
// lookup (task_id is not guaranteed unique across a task's revision/repair/
// retry history).
//
// IMPORTANT CORRECTION: a missing XRunStore row for a known, durable runId
// is NOT safe to treat as "createRun never committed" -- XRunStore prunes
// old TERMINAL rows past its retention limit, so a null row could equally
// mean the run finished long ago and was later pruned. reconcileDispatching
// Entry therefore leaves this case completely untouched (still
// `dispatching`, still carrying its runId) rather than returning it to
// pending -- see the method's own doc comment in queue-coordinator.mjs.

/** Writes a legacy (pre-B2B) queue file directly -- a dispatching entry with runId:null, exactly as the OLD markDispatching(id) shape would have persisted it. Never uses the new production markDispatching(id, runId) API, which cannot produce this state at all once B2B ships. */
function writeLegacyDispatchingQueueFile(queuePath, { id, taskId, task }) {
  const payload = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    entries: [{
      id, task, taskId, status: 'dispatching',
      createdAt: new Date().toISOString(), dispatchingAt: new Date().toISOString(),
      dispatchedAt: null, runId: null,
    }],
    reviews: [],
  };
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  fs.writeFileSync(queuePath, JSON.stringify(payload, null, 2), 'utf8');
}

test('28 each new dispatch attempt gets a pre-generated runId before runXTask admission, persisted atomically with dispatching', async () => {
  const item = fixture();
  const controlled = controllableModel([create()]);
  const coordinator = coordinatorFor(item, { modelAdapter: controlled });

  let capturedRunId = null;
  const originalMarkDispatching = item.queueStore.markDispatching.bind(item.queueStore);
  item.queueStore.markDispatching = (id, runId) => {
    capturedRunId = runId;
    return originalMarkDispatching(id, runId);
  };

  coordinator.enqueue(taskFor(item, 'task-1'));
  await controlled.entered;

  assert.equal(typeof capturedRunId, 'string');
  assert.ok(capturedRunId.length > 0, 'markDispatching must be called with a real, non-empty pre-generated runId');
  // Already persisted (dispatching, at minimum) by the time generate() is entered.
  assert.equal(item.queueStore.listDispatching().length + item.queueStore.listDispatched().length, 1);

  controlled.release();
  await waitUntil(() => isFullyIdle(item), { label: 'cleanup' });
});

test('29 XQueueStore correlation equals the XRunStore row and the admitted runId -- all three agree', async () => {
  const item = fixture();
  const controlled = controllableModel([create()]);
  const coordinator = coordinatorFor(item, { modelAdapter: controlled });

  let preGeneratedRunId = null;
  const originalMarkDispatching = item.queueStore.markDispatching.bind(item.queueStore);
  item.queueStore.markDispatching = (id, runId) => {
    preGeneratedRunId = runId;
    return originalMarkDispatching(id, runId);
  };

  coordinator.enqueue(taskFor(item, 'task-1'));
  await controlled.entered;
  await waitUntil(() => item.queueStore.listDispatched().length === 1, { label: 'entry to reach dispatched' });

  const dispatchedRunId = item.queueStore.listDispatched()[0].runId;
  assert.equal(dispatchedRunId, preGeneratedRunId, 'the queue-persisted runId must equal the pre-generated one');
  assert.ok(item.runStore.getRun(preGeneratedRunId), 'XRunStore must have a real row for that exact pre-generated runId');

  controlled.release();
  await waitUntil(() => isFullyIdle(item), { label: 'cleanup' });
});

test('30 definitive no_capacity returns the entry to pending with runId cleared to null', async () => {
  const item = fixture();
  const blocker = new XClaimStore({ storagePath: item.dbPath });
  stores.push(blocker);
  blocker.claim({ taskId: 'blocking-task', ownerId: 'blocker-owner' });

  const coordinator = coordinatorFor(item, { modelAdapter: fastModel([create()]) });
  const entry = item.queueStore.enqueue(taskFor(item, 'task-1'));

  const result = await coordinator.dispatchNext();
  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'no_capacity');

  const reverted = item.queueStore.listPending().find((e) => e.id === entry.id);
  assert.ok(reverted, 'the entry must be back in pending');
  assert.equal(reverted.status, 'pending');
  assert.equal(reverted.runId, null, 'runId must be cleared so the next attempt generates a fresh one');
});

test('31 an ambiguous throw preserves dispatching with its known, already-durable runId', async () => {
  const item = fixture();
  const coordinator = coordinatorFor(item, { modelAdapter: fastModel([create()]) });

  let capturedRunId = null;
  const originalMarkDispatching = item.queueStore.markDispatching.bind(item.queueStore);
  item.queueStore.markDispatching = (id, runId) => {
    capturedRunId = runId;
    return originalMarkDispatching(id, runId);
  };

  const invalidTask = { version: X_TASK_VERSION, task_id: 'task-invalid' };
  const entry = item.queueStore.enqueue(invalidTask);

  const result = await coordinator.dispatchNext();
  assert.equal(result.reason, 'ambiguous_throw');

  const stillDispatching = item.queueStore.listDispatching().find((e) => e.id === entry.id);
  assert.ok(stillDispatching, 'the entry must remain dispatching');
  assert.equal(stillDispatching.runId, capturedRunId);
  assert.ok(stillDispatching.runId, 'the known, pre-generated runId must be preserved, not cleared');
});

// ── reconcileDispatchingEntry: legacy (runId:null) ──────────────────────────

test('32 startup: a legacy dispatching entry (runId:null) is left completely untouched -- no taskId lookup, no mutation', () => {
  const item = fixture();
  writeLegacyDispatchingQueueFile(item.queuePath, { id: 'legacy-1', taskId: 'task-legacy', task: taskFor(item, 'task-legacy') });
  item.queueStore.load();

  const legacyEntry = item.queueStore.listDispatching()[0];
  assert.equal(legacyEntry.runId, null);

  const coordinator = coordinatorFor(item, { modelAdapter: fastModel([create()]) });
  const result = coordinator.reconcileDispatchingEntry(legacyEntry);

  assert.equal(result.handled, false);
  assert.equal(result.reason, 'legacy_ambiguous');
  assert.equal(item.queueStore.listDispatching().length, 1, 'the legacy entry must still be present, exactly as dispatching');
  assert.equal(item.queueStore.listDispatching()[0].runId, null);
  assert.equal(item.queueStore.listPending().length, 0, 'must not have been returned to pending');
});

// ── reconcileDispatchingEntry: known runId, no XRunStore row (ambiguous) ────

test('33 startup: known runId with no XRunStore row is ambiguous -- entry stays dispatching, never returned to pending', () => {
  const item = fixture();
  const entry = item.queueStore.enqueue(taskFor(item, 'task-1'));
  item.queueStore.markDispatching(entry.id, 'run-never-created');

  const coordinator = coordinatorFor(item, { modelAdapter: fastModel([create()]) });
  const result = coordinator.reconcileDispatchingEntry(item.queueStore.listDispatching()[0]);

  assert.equal(result.handled, false);
  assert.equal(result.reason, 'run_not_found_ambiguous');
  assert.equal(item.queueStore.listDispatching().length, 1);
  assert.equal(item.queueStore.listDispatching()[0].status, 'dispatching');
  assert.equal(item.queueStore.listDispatching()[0].runId, 'run-never-created');
  assert.equal(item.queueStore.listPending().length, 0, 'must never be returned to pending on this evidence alone');
});

test('34 the null-row ambiguous path schedules no dispatch and makes no other state changes', () => {
  const item = fixture();
  const entry = item.queueStore.enqueue(taskFor(item, 'task-1'));
  item.queueStore.markDispatching(entry.id, 'run-never-created');

  const coordinator = coordinatorFor(item, { modelAdapter: fastModel([create()]) });

  let scheduleCalls = 0;
  coordinator._scheduleDispatch = () => {
    scheduleCalls += 1;
  };

  const result = coordinator.reconcileDispatchingEntry(
    item.queueStore.listDispatching()[0],
  );

  assert.equal(result.handled, false);
  assert.equal(result.reason, 'run_not_found_ambiguous');

  assert.equal(
    scheduleCalls,
    0,
    'run_not_found_ambiguous must not schedule another dispatch',
  );

  assert.equal(item.queueStore.listDispatching().length, 1);
  assert.equal(item.queueStore.listDispatching()[0].id, entry.id);
  assert.equal(item.queueStore.listDispatching()[0].runId, 'run-never-created');
  assert.equal(item.queueStore.listPending().length, 0);
  assert.equal(item.queueStore.listDispatched().length, 0);
  assert.equal(item.queueStore.listReviews().length, 0);
});

// ── reconcileDispatchingEntry: known run, taskId mismatch ───────────────────

test('35 startup: known run whose taskId disagrees with the queue entry -- untouched, task_mismatch', () => {
  const item = fixture();
  const entry = item.queueStore.enqueue(taskFor(item, 'task-1'));
  const runId = 'run-mismatch';
  item.queueStore.markDispatching(entry.id, runId);
  item.runStore.createRun({ runId, taskId: 'a-completely-different-task' });

  const coordinator = coordinatorFor(item, { modelAdapter: fastModel([create()]) });
  const result = coordinator.reconcileDispatchingEntry(item.queueStore.listDispatching()[0]);

  assert.equal(result.handled, false);
  assert.equal(result.reason, 'task_mismatch');
  assert.equal(item.queueStore.listDispatching().length, 1, 'entry untouched');
  assert.equal(item.queueStore.listDispatching()[0].status, 'dispatching');
});

// ── reconcileDispatchingEntry: known run, nonterminal (queued/running) ──────

test('36 startup: known run queued -> promoted to dispatched and preserved', () => {
  const item = fixture();
  const entry = item.queueStore.enqueue(taskFor(item, 'task-1'));
  const runId = 'run-queued';
  item.queueStore.markDispatching(entry.id, runId);
  item.runStore.createRun({ runId, taskId: 'task-1' });
  assert.equal(item.runStore.getRun(runId).status, 'queued');

  const coordinator = coordinatorFor(item, { modelAdapter: fastModel([create()]) });
  const result = coordinator.reconcileDispatchingEntry(item.queueStore.listDispatching()[0]);

  assert.equal(result.handled, true);
  assert.equal(result.reason, 'promoted_nonterminal');
  assert.equal(item.queueStore.listDispatching().length, 0);
  assert.equal(item.queueStore.listDispatched().length, 1);
  assert.equal(item.queueStore.findDispatchedByRunId(runId).id, entry.id);
  assert.equal(item.queueStore.listReviews().length, 0, 'no terminal event fabricated');
});

test('37 startup: known run running -> promoted to dispatched and preserved, still blocking the serial gate', async () => {
  const item = fixture();
  const entry = item.queueStore.enqueue(taskFor(item, 'task-1'));
  const runId = 'run-running';
  item.queueStore.markDispatching(entry.id, runId);
  item.runStore.createRun({ runId, taskId: 'task-1' });
  item.runStore.markRunning({ runId, claimLeaseId: 'lease-1' });
  assert.equal(item.runStore.getRun(runId).status, 'running');

  const coordinator = coordinatorFor(item, { modelAdapter: fastModel([create()]) });
  const result = coordinator.reconcileDispatchingEntry(item.queueStore.listDispatching()[0]);

  assert.equal(result.handled, true);
  assert.equal(result.reason, 'promoted_nonterminal');
  assert.equal(item.queueStore.listDispatching().length, 0);
  assert.equal(item.queueStore.findDispatchedByRunId(runId).id, entry.id);
  assert.equal(item.queueStore.listReviews().length, 0);

  // The coordinator's own existing serial gate now correctly blocks further
  // dispatch, exactly as any other in-flight dispatched entry would.
  const next = await coordinator.dispatchNext();
  assert.equal(next.dispatched, false);
  assert.equal(next.reason, 'inflight_or_ambiguous');
});

// ── reconcileDispatchingEntry: known run, terminal (reuses onXRunTerminal) ─

test('38 startup: known run completed -> promoted then reconciled via the existing onXRunTerminal path, pruned, no review', () => {
  const item = fixture();
  const entry = item.queueStore.enqueue(taskFor(item, 'task-1'));
  const runId = 'run-completed';
  item.queueStore.markDispatching(entry.id, runId);
  item.runStore.createRun({ runId, taskId: 'task-1' });
  item.runStore.markRunning({ runId, claimLeaseId: 'lease-1' });
  item.runStore.completeRun({
    runId, gateResult: { gate_status: 'COMPLETED', hearth_outcome: 'completed' },
    xResult: { task_id: 'task-1', gate_status: 'COMPLETED', hearth_outcome: 'completed' },
  });

  const coordinator = coordinatorFor(item, { modelAdapter: fastModel([create()]) });
  const result = coordinator.reconcileDispatchingEntry(item.queueStore.listDispatching()[0]);

  assert.equal(result.handled, true);
  assert.equal(item.queueStore.listDispatching().length, 0);
  assert.equal(item.queueStore.findDispatchedByRunId(runId), null, 'pruned once reconciled');
  assert.equal(item.queueStore.listReviews().length, 0, 'completed is not review-worthy');
});

test('39 startup: known run needs_review -> promoted then existing review-before-prune behavior applies', () => {
  const item = fixture();
  const entry = item.queueStore.enqueue(taskFor(item, 'task-1'));
  const runId = 'run-review';
  item.queueStore.markDispatching(entry.id, runId);
  item.runStore.createRun({ runId, taskId: 'task-1' });
  item.runStore.markRunning({ runId, claimLeaseId: 'lease-1' });
  item.runStore.completeRun({
    runId, gateResult: { gate_status: 'NEEDS_REVIEW', hearth_outcome: 'waiting' },
    xResult: { task_id: 'task-1', gate_status: 'NEEDS_REVIEW', hearth_outcome: 'waiting' },
  });

  const coordinator = coordinatorFor(item, { modelAdapter: fastModel([create()]) });
  const result = coordinator.reconcileDispatchingEntry(item.queueStore.listDispatching()[0]);

  assert.equal(result.handled, true);
  const reviews = item.queueStore.listReviews();
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].status, 'needs_review');
  assert.equal(reviews[0].runId, runId);
  assert.equal(item.queueStore.findDispatchedByRunId(runId), null);
});

test('40 startup: known run failed -> promoted then existing review-before-prune behavior applies', () => {
  const item = fixture();
  const entry = item.queueStore.enqueue(taskFor(item, 'task-1'));
  const runId = 'run-failed';
  item.queueStore.markDispatching(entry.id, runId);
  item.runStore.createRun({ runId, taskId: 'task-1' });
  item.runStore.markRunning({ runId, claimLeaseId: 'lease-1' });
  item.runStore.completeRun({
    runId, gateResult: { gate_status: 'FAILED', hearth_outcome: 'error' },
    xResult: { task_id: 'task-1', gate_status: 'FAILED', hearth_outcome: 'error' },
  });

  const coordinator = coordinatorFor(item, { modelAdapter: fastModel([create()]) });
  const result = coordinator.reconcileDispatchingEntry(item.queueStore.listDispatching()[0]);

  assert.equal(result.handled, true);
  const reviews = item.queueStore.listReviews();
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].status, 'failed');
  assert.equal(item.queueStore.findDispatchedByRunId(runId), null);
});

test('41 startup: known run interrupted -> promoted then existing review-before-prune behavior applies', () => {
  const item = fixture();
  const entry = item.queueStore.enqueue(taskFor(item, 'task-1'));
  const runId = 'run-interrupted';
  item.queueStore.markDispatching(entry.id, runId);
  item.runStore.createRun({ runId, taskId: 'task-1' });
  item.runStore.markRunning({ runId, claimLeaseId: 'lease-1' });
  item.runStore.markInterrupted(runId);

  const coordinator = coordinatorFor(item, { modelAdapter: fastModel([create()]) });
  const result = coordinator.reconcileDispatchingEntry(item.queueStore.listDispatching()[0]);

  assert.equal(result.handled, true);
  const reviews = item.queueStore.listReviews();
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].status, 'interrupted');
  assert.equal(item.queueStore.findDispatchedByRunId(runId), null);
});

// ── authority boundaries, restated for B2B ──────────────────────────────────

test('42 no taskId-based XRunStore lookup exists anywhere in the coordinator -- every runStore call is getRun(runId)', () => {
  const source = fs.readFileSync(
    new URL('../mcp/x/queue-coordinator.mjs', import.meta.url),
    'utf8',
  );

  const codeOnly = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

  assert.doesNotMatch(
    codeOnly,
    /ByTaskId/,
    'no taskId-keyed XRunStore lookup may exist or be introduced',
  );

  const runStoreCalls =
    codeOnly.match(/this\.runStore\.\w+\(/g) || [];

  assert.ok(
    runStoreCalls.length > 0,
    'sanity: the coordinator must call runStore at all',
  );

  for (const call of runStoreCalls) {
    assert.match(
      call,
      /^this\.runStore\.getRun\($/,
      `every runStore call must be getRun(runId), found: ${call}`,
    );
  }
});

test('43 no polling/timer exists anywhere in the coordinator\'s executable source', () => {
  const source = fs.readFileSync(
    new URL('../mcp/x/queue-coordinator.mjs', import.meta.url),
    'utf8',
  );

  const codeOnly = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

  assert.doesNotMatch(
    codeOnly,
    /setInterval|setTimeout/,
    'no polling/timer mechanism may exist or be introduced',
  );
});

// ── fast-restart liveness: onAdmissionAccepted (queue-dispatched path) ─────
//
// Notification-only (void, no payload), fired exactly once per durably-
// accepted admission -- after admitted.runId is validated against the
// pre-generated runId, before queueStore.markDispatched(). Exists purely so
// Electron can re-arm its fast-restart wakeup timer; this coordinator makes
// no decision based on whatever the callback does, and a throwing callback
// must never change admission/queue behavior.

test('44 onAdmissionAccepted fires exactly once after a durably-accepted admission', async () => {
  const item = fixture();
  const controlled = controllableModel([create()]);
  let calls = 0;
  const coordinator = coordinatorFor(item, { modelAdapter: controlled, onAdmissionAccepted: () => { calls += 1; } });

  coordinator.enqueue(taskFor(item, 'task-1'));
  await controlled.entered;
  await waitUntil(() => item.queueStore.listDispatched().length === 1, { label: 'entry to reach dispatched' });

  assert.equal(calls, 1, 'onAdmissionAccepted must fire exactly once for one accepted admission');

  controlled.release();
  await waitUntil(() => isFullyIdle(item), { label: 'cleanup' });
  assert.equal(calls, 1, 'onAdmissionAccepted must not fire again on terminal completion');
});

test('45 onAdmissionAccepted does not fire for a no_capacity denial', async () => {
  const item = fixture();
  const blocker = new XClaimStore({ storagePath: item.dbPath });
  stores.push(blocker);
  blocker.claim({ taskId: 'blocking-task', ownerId: 'blocker-owner' });

  let calls = 0;
  const coordinator = coordinatorFor(item, { modelAdapter: fastModel([create()]), onAdmissionAccepted: () => { calls += 1; } });
  item.queueStore.enqueue(taskFor(item, 'task-1'));

  const result = await coordinator.dispatchNext();
  assert.equal(result.reason, 'no_capacity');
  assert.equal(calls, 0, 'onAdmissionAccepted must never fire for a definite non-admission');
});

test('46 onAdmissionAccepted does not fire on an ambiguous (thrown) admission attempt', async () => {
  const item = fixture();
  let calls = 0;
  const coordinator = coordinatorFor(item, { modelAdapter: fastModel([create()]), onAdmissionAccepted: () => { calls += 1; } });

  const invalidTask = { version: X_TASK_VERSION, task_id: 'task-invalid' };
  item.queueStore.enqueue(invalidTask);

  const result = await coordinator.dispatchNext();
  assert.equal(result.reason, 'ambiguous_throw');
  assert.equal(calls, 0, 'onAdmissionAccepted must never fire for an ambiguous throw');
});

test('47 onAdmissionAccepted is structurally unreachable on a runId mismatch -- the mismatch return precedes the callback call site in source', () => {
  // A genuine runId mismatch cannot be produced by the real runXTask (it
  // always honors an explicitly-passed runId -- see run-x-task.mjs's own
  // `actualRunId = runId ?? crypto.randomUUID()`), so this is proven
  // structurally rather than by forcing an artificial mock.
  const source = fs.readFileSync(
    new URL('../mcp/x/queue-coordinator.mjs', import.meta.url),
    'utf8',
  );

  const mismatchGuardIdx = source.indexOf(
    'if (admitted.runId !== runId) {',
  );
  const callbackCallIdx = source.indexOf(
    'this.onAdmissionAccepted()',
  );

  assert.ok(
    mismatchGuardIdx !== -1,
    'the runId-mismatch guard must exist',
  );
  assert.ok(
    callbackCallIdx !== -1,
    'the onAdmissionAccepted call site must exist',
  );
  assert.ok(
    mismatchGuardIdx < callbackCallIdx,
    'the mismatch guard must precede the admission callback',
  );

  const mismatchBlock = source.slice(
    mismatchGuardIdx,
    callbackCallIdx,
  );

  assert.match(
    mismatchBlock,
    /return\s+\{\s*dispatched:\s*false,\s*reason:\s*'ambiguous_throw'/s,
    'the runId-mismatch path must return before onAdmissionAccepted can execute',
  );
});

test('48 a throwing onAdmissionAccepted callback never breaks dispatch -- the entry still reaches dispatched', async () => {
  const item = fixture();
  const controlled = controllableModel([create()]);
  const coordinator = coordinatorFor(item, {
    modelAdapter: controlled,
    onAdmissionAccepted: () => { throw new Error('simulated Electron-side hook failure'); },
  });

  coordinator.enqueue(taskFor(item, 'task-1'));
  await controlled.entered;
  await waitUntil(() => item.queueStore.listDispatched().length === 1, { label: 'entry must still reach dispatched despite the throwing callback' });
  assert.equal(item.queueStore.listDispatched()[0].taskId, 'task-1');

  controlled.release();
  await waitUntil(() => isFullyIdle(item), { label: 'cleanup' });
});
