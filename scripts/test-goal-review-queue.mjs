/**
 * Hearth Goal Runner Review Queue + Continuation Semantics Test Suite
 *
 * Proves the mechanical mapping from X terminal truth to Goal continuation:
 *   COMPLETED    -> continue to the next already-authored eligible step
 *   NEEDS_REVIEW -> exactly one durable Review Queue item, continuation stops
 *   FAILED       -> exactly one durable Review Queue item, continuation stops
 *   INTERRUPTED  -> waiting/recoverable, NEVER a Review Queue item
 * and that the Review Queue is idempotent (a restart/replay of the same
 * terminal run never creates a duplicate item, and never re-executes X).
 */

import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { GoalStorage } from '../mcp/goals/storage.mjs';
import { GoalRunner } from '../mcp/goals/runner.mjs';
import { X_TASK_VERSION } from '../mcp/x/task-contract.mjs';

let passed = 0;
let failed = 0;

const test = async (name, fn) => {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`  FAIL  ${name}: ${err.stack || err.message}`);
    failed += 1;
  }
};

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hearth-review-queue-test-'));
const testWorkspace = path.join(tmpDir, 'workspace');
await fs.mkdir(testWorkspace, { recursive: true });
let storageCounter = 0;
const freshStoragePath = () => path.join(tmpDir, `goals-${++storageCounter}.json`);

const validXTask = (taskId, overrides = {}) => ({
  version: X_TASK_VERSION,
  task_id: taskId,
  parent_task_id: null,
  revision: 1,
  attempt: 1,
  based_on_result_id: null,
  objective: 'Report a fact.',
  problem: 'A fact is not yet known.',
  expected_behavior: 'The fact is reported.',
  observed_behavior: 'No report has been produced yet.',
  why_this_matters: 'Review Queue / continuation semantics regression coverage.',
  known_evidence: [],
  suspected_area: [],
  workspace: { repo: 'referenced-chatgpt-conversation-this-is-an-2', root: testWorkspace },
  scope: { allowed_paths: ['scripts'], preferred_files: [], forbidden_paths: [] },
  constraints: { preserve: [], do_not: [] },
  allowed_tools: ['repo_read'],
  acceptance_criteria: ['Reported'],
  validation: { required: ['node --test scripts/test-build-metadata.mjs'], optional: [] },
  verification: null,
  done_criteria: ['Reported'],
  teaching_notes: [],
  uncertainty_policy: { policy: 'bounded_autonomy', stop_conditions: [] },
  repair_budget: { initial_attempts: 1, max_repairs: 2, max_total_rounds: 3 },
  timing: { estimated_minutes: 3, first_check_after_minutes: 1, soft_deadline_minutes: 3, hard_timeout_minutes: 10 },
  commit_policy: { mode: 'never' },
  ...overrides,
});

/** Mirrors test-goal-runner-x.mjs's own mock xExecutor exactly. */
const makeMockXExecutor = () => {
  const dispatches = new Map();
  const dispatchLog = [];
  const statuses = new Map();
  return {
    dispatches,
    dispatchLog,
    statuses,
    dispatchXTask: async ({ requestId, task, action }) => {
      if (!dispatches.has(requestId)) {
        dispatches.set(requestId, { task, action });
        dispatchLog.push({ requestId, task, action });
      }
      return { accepted: true };
    },
    getXTaskStatus: async (requestId) => statuses.get(requestId) || { found: false, queue_status: undefined },
  };
};

const mockAntigravityExecutor = (spy) => ({
  startAntigravityTask: async (opts) => { spy.push(opts); return { taskId: 'mock-anti-1', conversationId: 'c1' }; },
  getAntigravityTask: () => ({ taskId: 'mock-anti-1', status: 'done', lastAnswer: 'ok', completion: { status: 'done' } }),
});

console.log('\n=== Hearth Goal Runner Review Queue Test Suite ===\n');

// ── 1. COMPLETED continues eligible next authored step, zero review items ──
await test('1. COMPLETED continues to next authored step and creates zero review items', async () => {
  const storage = new GoalStorage({ storagePath: freshStoragePath() });
  const xExecutor = makeMockXExecutor();
  const runner = new GoalRunner({ storage, xExecutor });

  const goal = await runner.create_goal({
    title: 'Completed Chain Goal',
    objective: 'Two completed X steps in a row',
    workspace: testWorkspace,
    steps: [
      { id: 's1', title: 'Step 1', description: '', route: 'x', xTask: validXTask('RQ-C1') },
      { id: 's2', title: 'Step 2', description: '', route: 'x', xTask: validXTask('RQ-C2') },
    ],
  });

  xExecutor.statuses.set(`goal:${goal.id}:step:s1`, { found: true, queue_status: 'terminal', terminal_status: 'completed', result: { version: 'x-result-v1', result_id: 'r1', task_id: 'RQ-C1' } });
  xExecutor.statuses.set(`goal:${goal.id}:step:s2`, { found: true, queue_status: 'terminal', terminal_status: 'completed', result: { version: 'x-result-v1', result_id: 'r2', task_id: 'RQ-C2' } });

  const finished = await runner.run_goal(goal.id);
  assert.equal(finished.status, 'completed');
  assert.equal(finished.steps[0].status, 'completed');
  assert.equal(finished.steps[1].status, 'completed');
  assert.equal(finished.reviewQueue.length, 0);
  assert.equal(runner.list_review_queue({ goalId: goal.id }).length, 0);
  // The checkpoint-persistence fix: both step completions must have
  // actually survived run_goal's own subsequent saveGoal(goal) call.
  assert.ok(finished.checkpoints.length >= 2, `expected at least 2 checkpoints, got ${finished.checkpoints.length}`);
});

// ── 2 & 3. NEEDS_REVIEW: exactly one item, blocks dependent continuation ───
await test('2/3. NEEDS_REVIEW creates exactly one durable review item and blocks dependent continuation', async () => {
  const storage = new GoalStorage({ storagePath: freshStoragePath() });
  const xExecutor = makeMockXExecutor();
  const antigravityCalls = [];
  const runner = new GoalRunner({ storage, xExecutor, antigravityExecutor: mockAntigravityExecutor(antigravityCalls) });

  const goal = await runner.create_goal({
    title: 'Needs Review Goal',
    objective: 'Should stop and queue a review',
    workspace: testWorkspace,
    steps: [
      { id: 's1', title: 'Step 1', description: '', route: 'x', xTask: validXTask('RQ-NR1') },
      { id: 's2', title: 'Step 2 (never runs)', description: '', route: 'antigravity' },
    ],
  });

  xExecutor.statuses.set(`goal:${goal.id}:step:s1`, {
    found: true, queue_status: 'terminal', terminal_status: 'needs_review', run_id: 'run-nr-1',
    result: { version: 'x-result-v1', result_id: 'result-nr-1', task_id: 'RQ-NR1', waiting_reason: 'ambiguous_evidence', reason_code: 'waiting_review' },
  });

  const finished = await runner.run_goal(goal.id, { permissions: { Antigravity: 'Allow' } });

  assert.equal(finished.status, 'waiting');
  assert.equal(finished.steps[0].status, 'waiting');
  assert.equal(finished.steps[1].status, 'pending', 'dependent step must never have dispatched');
  assert.equal(antigravityCalls.length, 0);

  assert.equal(finished.reviewQueue.length, 1);
  const item = finished.reviewQueue[0];
  assert.equal(item.status, 'needs_review');
  assert.equal(item.stepId, 's1');
  assert.equal(item.taskId, 'RQ-NR1');
  assert.equal(item.resultId, 'result-nr-1');
  assert.equal(item.reason, 'ambiguous_evidence');
  assert.ok(item.runId, 'runId must be populated from stepResult.evidence');
  assert.ok(item.createdAt && item.updatedAt);
  // Reference-only: no raw transcript/chain-of-thought field names.
  assert.equal(JSON.stringify(item).toLowerCase().includes('transcript'), false);

  assert.ok(finished.checkpoints.some((c) => c.stepId === 's1'), 'a checkpoint must have been recorded for the waiting step');
});

// ── 4 & 5. FAILED: exactly one item, blocks dependent continuation ─────────
await test('4/5. FAILED creates exactly one durable review item and blocks dependent continuation', async () => {
  const storage = new GoalStorage({ storagePath: freshStoragePath() });
  const xExecutor = makeMockXExecutor();
  const antigravityCalls = [];
  const runner = new GoalRunner({ storage, xExecutor, antigravityExecutor: mockAntigravityExecutor(antigravityCalls) });

  const goal = await runner.create_goal({
    title: 'Failed Goal',
    objective: 'Should fail and queue a review',
    workspace: testWorkspace,
    steps: [
      { id: 's1', title: 'Step 1', description: '', route: 'x', xTask: validXTask('RQ-F1'), required: true },
      { id: 's2', title: 'Step 2 (never runs)', description: '', route: 'antigravity' },
    ],
  });

  xExecutor.statuses.set(`goal:${goal.id}:step:s1`, {
    found: true, queue_status: 'terminal', terminal_status: 'failed', error: 'x execution failed: build broke', run_id: 'run-f-1',
    result: null,
  });

  const finished = await runner.run_goal(goal.id, { permissions: { Antigravity: 'Allow' } });

  assert.equal(finished.status, 'error');
  assert.equal(finished.steps[0].status, 'error');
  assert.equal(finished.steps[1].status, 'pending');
  assert.equal(antigravityCalls.length, 0);

  assert.equal(finished.reviewQueue.length, 1);
  const item = finished.reviewQueue[0];
  assert.equal(item.status, 'failed');
  assert.equal(item.stepId, 's1');
  assert.equal(item.taskId, 'RQ-F1');
  assert.equal(item.reason, 'x execution failed: build broke');
  assert.ok(item.runId);

  assert.ok(finished.checkpoints.some((c) => c.stepId === 's1'), 'a checkpoint must have been recorded for the failed step');
});

// ── 6. INTERRUPTED becomes waiting/recoverable, zero review items ──────────
await test('6. INTERRUPTED becomes waiting/recoverable and creates zero review items', async () => {
  const storage = new GoalStorage({ storagePath: freshStoragePath() });
  const xExecutor = makeMockXExecutor();
  const runner = new GoalRunner({ storage, xExecutor });

  const goal = await runner.create_goal({
    title: 'Interrupted Goal',
    objective: 'Should stay recoverable, no review item',
    workspace: testWorkspace,
    steps: [{ id: 's1', title: 'Step 1', description: '', route: 'x', xTask: validXTask('RQ-I1') }],
  });

  const requestId = `goal:${goal.id}:step:s1`;
  xExecutor.statuses.set(requestId, { found: true, queue_status: 'terminal', terminal_status: 'interrupted' });

  const finished = await runner.run_goal(goal.id);
  assert.equal(finished.status, 'waiting');
  assert.equal(finished.steps[0].status, 'waiting');
  assert.equal(finished.reviewQueue.length, 0, 'INTERRUPTED must never create a review item');

  // Recovery: the underlying run later completes; resuming picks it up,
  // still with zero review items and zero duplicate X execution.
  xExecutor.statuses.set(requestId, { found: true, queue_status: 'terminal', terminal_status: 'completed', result: 'recovered' });
  const resumed = await runner.resume_goal(goal.id);
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.reviewQueue.length, 0);
  assert.equal(xExecutor.dispatchLog.length, 1, 'recovery must not have created a second X execution');
});

// ── 7 & 8. Restart/replay does not duplicate review item or X execution ────
await test('7/8. restart/replay does not duplicate the Review Queue item or X execution', async () => {
  const storagePath = freshStoragePath();
  const storage = new GoalStorage({ storagePath });
  const xExecutor = makeMockXExecutor();
  const runner = new GoalRunner({ storage, xExecutor });

  const goal = await runner.create_goal({
    title: 'Replay Goal',
    objective: 'Restart must not duplicate anything',
    workspace: testWorkspace,
    steps: [{ id: 's1', title: 'Step 1', description: '', route: 'x', xTask: validXTask('RQ-REPLAY') }],
  });

  const requestId = `goal:${goal.id}:step:s1`;
  xExecutor.statuses.set(requestId, {
    found: true, queue_status: 'terminal', terminal_status: 'needs_review',
    result: { version: 'x-result-v1', result_id: 'replay-result-1', task_id: 'RQ-REPLAY', waiting_reason: 'needs_human', reason_code: 'waiting_review' },
  });

  const first = await runner.run_goal(goal.id);
  assert.equal(first.reviewQueue.length, 1);
  const firstItemId = first.reviewQueue[0].id;
  assert.equal(xExecutor.dispatchLog.length, 1);

  // Simulate an app restart: fresh GoalStorage + fresh GoalRunner + fresh
  // xExecutor spy, same durable receipt state (still needs_review).
  const restartedStorage = new GoalStorage({ storagePath });
  const restartedXExecutor = makeMockXExecutor();
  restartedXExecutor.statuses.set(requestId, {
    found: true, queue_status: 'terminal', terminal_status: 'needs_review',
    result: { version: 'x-result-v1', result_id: 'replay-result-1', task_id: 'RQ-REPLAY', waiting_reason: 'needs_human', reason_code: 'waiting_review' },
  });
  const restartedRunner = new GoalRunner({ storage: restartedStorage, xExecutor: restartedXExecutor });

  // A duplicate resume (the same waiting step with an unresolved review item)
  // must fail closed per the Slice 1 resume guard, without duplicating X execution:
  await assert.rejects(
    () => restartedRunner.resume_goal(goal.id),
    /blocked by unresolved review item/
  );
  const reloaded = restartedStorage.getGoal(goal.id);
  assert.equal(reloaded.reviewQueue.length, 1, 'an unresolved review item must not be duplicated');
  assert.equal(reloaded.reviewQueue[0].id, firstItemId, 'the SAME review item must be preserved');
  assert.equal(restartedXExecutor.dispatchLog.length, 0, 'a replayed resume must not execute X');
});

// ── 11. Structured x-result-v1 remains preserved alongside a review item ───
await test('11. structured x-result-v1 result remains preserved on the step even when a review item is also created', async () => {
  const storage = new GoalStorage({ storagePath: freshStoragePath() });
  const xExecutor = makeMockXExecutor();
  const runner = new GoalRunner({ storage, xExecutor });

  const goal = await runner.create_goal({
    title: 'Structured Result Goal',
    objective: 'Result must survive alongside the review item',
    workspace: testWorkspace,
    steps: [{ id: 's1', title: 'Step 1', description: '', route: 'x', xTask: validXTask('RQ-STRUCT') }],
  });

  const structuredResult = { version: 'x-result-v1', result_id: 'struct-1', task_id: 'RQ-STRUCT', gate_status: 'NEEDS_REVIEW', waiting_reason: 'ambiguous_evidence', reason_code: 'waiting_review' };
  xExecutor.statuses.set(`goal:${goal.id}:step:s1`, { found: true, queue_status: 'terminal', terminal_status: 'needs_review', result: structuredResult });

  const finished = await runner.run_goal(goal.id);
  const parsed = JSON.parse(finished.steps[0].result);
  assert.equal(parsed.version, 'x-result-v1');
  assert.equal(parsed.result_id, 'struct-1');
  assert.equal(finished.reviewQueue[0].resultId, 'struct-1');
});

// ── 12. Anti is never used as fallback for NEEDS_REVIEW/FAILED ─────────────
await test('12. Anti is never used as a fallback for NEEDS_REVIEW or FAILED X outcomes', async () => {
  const storage = new GoalStorage({ storagePath: freshStoragePath() });
  const xExecutor = makeMockXExecutor();
  const antigravityCalls = [];
  const runner = new GoalRunner({ storage, xExecutor, antigravityExecutor: mockAntigravityExecutor(antigravityCalls) });

  const goal = await runner.create_goal({
    title: 'No Anti Fallback Goal',
    objective: 'Failures must never route to Antigravity',
    workspace: testWorkspace,
    steps: [{ id: 's1', title: 'Step 1', description: '', route: 'x', xTask: validXTask('RQ-NOANTI'), required: true }],
  });

  xExecutor.statuses.set(`goal:${goal.id}:step:s1`, { found: true, queue_status: 'terminal', terminal_status: 'failed', error: 'boom' });
  await runner.run_goal(goal.id, { permissions: { Antigravity: 'Allow' } });
  assert.equal(antigravityCalls.length, 0);
});

// ── list_review_queue aggregates across goals, newest first ────────────────
await test('additional: list_review_queue aggregates across goals, newest first, filterable by goalId', async () => {
  const storage = new GoalStorage({ storagePath: freshStoragePath() });
  const xExecutor = makeMockXExecutor();
  const runner = new GoalRunner({ storage, xExecutor });

  const goalA = await runner.create_goal({
    title: 'Goal A', objective: 'first', workspace: testWorkspace,
    steps: [{ id: 's1', title: 'S1', description: '', route: 'x', xTask: validXTask('RQ-AGG-A') }],
  });
  xExecutor.statuses.set(`goal:${goalA.id}:step:s1`, { found: true, queue_status: 'terminal', terminal_status: 'failed', error: 'a failed' });
  await runner.run_goal(goalA.id);

  const goalB = await runner.create_goal({
    title: 'Goal B', objective: 'second', workspace: testWorkspace,
    steps: [{ id: 's1', title: 'S1', description: '', route: 'x', xTask: validXTask('RQ-AGG-B') }],
  });
  xExecutor.statuses.set(`goal:${goalB.id}:step:s1`, { found: true, queue_status: 'terminal', terminal_status: 'needs_review', result: { version: 'x-result-v1', result_id: 'b-1', task_id: 'RQ-AGG-B', waiting_reason: 'review_me', reason_code: 'waiting_review' } });
  await runner.run_goal(goalB.id);

  const all = runner.list_review_queue();
  assert.equal(all.length, 2);
  assert.equal(all[0].goalId, goalB.id, 'newest (Goal B) must come first');
  assert.equal(all[1].goalId, goalA.id);
  assert.equal(all[0].goalTitle, 'Goal B');

  const onlyA = runner.list_review_queue({ goalId: goalA.id });
  assert.equal(onlyA.length, 1);
  assert.equal(onlyA[0].goalId, goalA.id);
});

console.log(`\nResults: ${passed} passed, ${failed} failed out of ${passed + failed} tests\n`);
if (failed > 0) process.exit(1);
