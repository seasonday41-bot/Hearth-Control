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

const dirs = [];
const stores = [];

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
  return { root, dbPath, queuePath, claimStore, runStore, queueStore };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function taskFor(item, taskId = 'task-1') {
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
    constraints: { preserve: [], do_not: [] }, allowed_tools: ['repo_read'],
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
  return new XQueueCoordinator({
    queueStore: item.queueStore, claimStore: item.claimStore, runStore: item.runStore,
    modelAdapter: overrides.modelAdapter ?? fastModel([create()]),
    ownerId: overrides.ownerId ?? `owner-${Math.random().toString(36).slice(2)}`,
    leaseDurationMs: overrides.leaseDurationMs,
  });
}

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
  item.queueStore.markDispatching = (id) => {
    const result = originalMarkDispatching(id);
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

  coordinator.enqueue(taskFor(item, 'task-review'));
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

  coordinator.enqueue(taskFor(item, 'task-failed'));
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
  coordinator.enqueue(taskFor(item, 'task-1'));
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
  const externalAdmitted = await runXTask(taskFor(item, 'external-task'), fastModel([create('outside/no.js')]), {
    claimStore: item.claimStore, runStore: item.runStore, ownerId: 'external-owner-not-this-coordinator',
  });
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
  item.queueStore.markDispatching(stuck.id);

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
  const entry = coordinator.enqueue(taskFor(item, 'task-real'));
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
