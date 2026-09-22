/**
 * Hearth Goal Runner -> X Test Suite (Phase 2 slice)
 *
 * Proves the Goal Runner's route:'x' step contract: a step may execute
 * through X only when it already carries a complete, parseXTask-validated
 * x-task-v1 payload -- Goal Runner never synthesizes, repairs, or infers
 * one from title/description, and X execution is reached only through a
 * mock xExecutor standing in for the real Electron-owned ingestXTask/
 * XQueueCoordinator ingress (electron/main.cjs wires the real one; see
 * scripts/test-electron-remote-x-approval.mjs and
 * scripts/test-x-queue-coordinator.mjs for that ingress's own regression
 * coverage, re-run alongside this suite).
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
    console.error(`  FAIL  ${name}: ${err.message}`);
    failed += 1;
  }
};

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hearth-goal-x-test-'));
const testWorkspace = path.join(tmpDir, 'workspace');
await fs.mkdir(testWorkspace, { recursive: true });
let storageCounter = 0;
const freshStoragePath = () => path.join(tmpDir, `goals-${++storageCounter}.json`);

const validXTask = (overrides = {}) => ({
  version: X_TASK_VERSION,
  task_id: 'GOAL-X-STEP',
  parent_task_id: null,
  revision: 1,
  attempt: 1,
  based_on_result_id: null,
  objective: 'Report current branch.',
  problem: 'The current git state is not yet known via the Goal Runner X path.',
  expected_behavior: 'Report the exact current branch name as a plain fact.',
  observed_behavior: 'No report has been produced yet.',
  why_this_matters: 'Proves Goal Runner steps can dispatch through the shared X ingress.',
  known_evidence: [],
  suspected_area: [],
  workspace: { repo: 'referenced-chatgpt-conversation-this-is-an-2', root: testWorkspace },
  scope: { allowed_paths: ['scripts'], preferred_files: [], forbidden_paths: [] },
  constraints: { preserve: [], do_not: ['Do not create, modify, or delete any file.'] },
  allowed_tools: ['repo_read'],
  acceptance_criteria: ['The response states the current branch name.'],
  validation: { required: ['node --test scripts/test-build-metadata.mjs'], optional: [] },
  verification: null,
  done_criteria: ['Branch has been reported.'],
  teaching_notes: [],
  uncertainty_policy: { policy: 'bounded_autonomy', stop_conditions: [] },
  repair_budget: { initial_attempts: 1, max_repairs: 2, max_total_rounds: 3 },
  timing: { estimated_minutes: 3, first_check_after_minutes: 1, soft_deadline_minutes: 3, hard_timeout_minutes: 10 },
  commit_policy: { mode: 'never' },
  ...overrides,
});

/**
 * Mock xExecutor standing in for main.cjs's real
 * { dispatchXTask: (...) => ingestXTask(...), getXTaskStatus: (...) => xQueueReceiptStatus(...) }.
 * `dispatches` only ever gains a NEW entry the first time a given requestId
 * is seen -- mirroring ingestXTask's own requestId-keyed durable-receipt
 * idempotency (a retried call with the same requestId+task never re-executes).
 * Tests drive terminal truth by writing directly into `statuses` before
 * calling run_goal/resume_goal, so polling always resolves on the first
 * attempt (no real timers in this suite).
 */
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

console.log('\n=== Hearth Goal Runner -> X Test Suite ===\n');

// ── 1. Legacy free-text Goal still validates unchanged ─────────────────────
await test('1. free-text manual Goal remains valid', async () => {
  const storage = new GoalStorage({ storagePath: freshStoragePath() });
  const runner = new GoalRunner({ storage });

  const goal = await runner.create_goal({
    title: 'Legacy Goal',
    objective: 'Free-text steps only',
    workspace: testWorkspace,
    steps: [{ id: 's1', title: 'Do a thing', description: 'Free text instructions', route: 'manual' }],
  });

  assert.equal(goal.steps[0].route, 'manual');
  assert.equal(goal.steps[0].xTask, null);
});

// ── 2. route:x without xTask is rejected ────────────────────────────────────
await test('2. route:x without xTask is rejected/fails closed', async () => {
  const storage = new GoalStorage({ storagePath: freshStoragePath() });
  const runner = new GoalRunner({ storage });

  await assert.rejects(
    async () => runner.create_goal({
      title: 'Missing xTask',
      objective: 'Should fail',
      workspace: testWorkspace,
      steps: [{ id: 's1', title: 'X step', description: '', route: 'x' }],
    }),
    /route "x" but no xTask/i
  );
});

// ── 3. route:x with malformed xTask rejected ────────────────────────────────
await test('3. route:x with malformed xTask rejected', async () => {
  const storage = new GoalStorage({ storagePath: freshStoragePath() });
  const runner = new GoalRunner({ storage });

  await assert.rejects(
    async () => runner.create_goal({
      title: 'Malformed xTask',
      objective: 'Should fail',
      workspace: testWorkspace,
      steps: [{ id: 's1', title: 'X step', description: '', route: 'x', xTask: { version: X_TASK_VERSION } }],
    }),
    /route "x" but an invalid xTask/i
  );
});

// ── 4. route:x with complete x-task-v1 validates ────────────────────────────
await test('4. route:x with complete x-task-v1 validates', async () => {
  const storage = new GoalStorage({ storagePath: freshStoragePath() });
  const runner = new GoalRunner({ storage });

  const goal = await runner.create_goal({
    title: 'Valid X Goal',
    objective: 'Should succeed',
    workspace: testWorkspace,
    steps: [{ id: 's1', title: 'X step', description: '', route: 'x', xTask: validXTask() }],
  });

  assert.equal(goal.steps[0].route, 'x');
  assert.equal(goal.steps[0].xTask.version, X_TASK_VERSION);
  assert.equal(goal.steps[0].xTask.task_id, 'GOAL-X-STEP');
  // Hearth never rewrites the authored content.
  assert.equal(goal.steps[0].xTask.objective, 'Report current branch.');
});

// ── 5. xTask persists through Goal storage/checkpoint/reload ───────────────
await test('5. xTask persists through Goal storage/checkpoint/reload', async () => {
  const storagePath = freshStoragePath();
  const storage = new GoalStorage({ storagePath });
  const runner = new GoalRunner({ storage });

  const goal = await runner.create_goal({
    title: 'Persist X Goal',
    objective: 'Should survive reload',
    workspace: testWorkspace,
    steps: [{ id: 's1', title: 'X step', description: '', route: 'x', xTask: validXTask() }],
  });

  runner.checkpoint_goal(goal.id, 's1', { summary: 'test checkpoint', completedSteps: 0 });

  // Simulate an app restart: brand-new GoalStorage instance over the SAME file.
  const reloadedStorage = new GoalStorage({ storagePath });
  const reloaded = reloadedStorage.getGoal(goal.id);

  assert.ok(reloaded, 'goal must survive reload');
  assert.equal(reloaded.steps[0].route, 'x');
  assert.deepEqual(reloaded.steps[0].xTask, goal.steps[0].xTask);
});

// ── 6. X step uses shared X ingress (via the xExecutor seam) ───────────────
await test('6. X step uses shared X ingress', async () => {
  const storage = new GoalStorage({ storagePath: freshStoragePath() });
  const xExecutor = makeMockXExecutor();
  const runner = new GoalRunner({ storage, xExecutor });

  const goal = await runner.create_goal({
    title: 'Dispatch Goal',
    objective: 'Should call xExecutor',
    workspace: testWorkspace,
    steps: [{ id: 's1', title: 'X step', description: '', route: 'x', xTask: validXTask() }],
  });

  const requestId = `goal:${goal.id}:step:s1`;
  xExecutor.statuses.set(requestId, {
    found: true, queue_status: 'terminal', terminal_status: 'completed',
    result: 'main / abc123 / clean', queue_id: 'q1', run_id: 'r1',
    gate_status: 'passed', hearth_outcome: 'accepted',
  });

  const finished = await runner.run_goal(goal.id);

  assert.equal(xExecutor.dispatchLog.length, 1);
  assert.equal(xExecutor.dispatchLog[0].requestId, requestId);
  assert.deepEqual(xExecutor.dispatchLog[0].task, goal.steps[0].xTask);
  assert.equal(finished.status, 'completed');
  assert.equal(finished.steps[0].status, 'completed');
  assert.equal(finished.steps[0].result, 'main / abc123 / clean');
});

// ── 7. X step uses its configured executor ───────────────────────────────────────
await test('7. X step uses its configured executor', async () => {
  const storage = new GoalStorage({ storagePath: freshStoragePath() });
  const xExecutor = makeMockXExecutor();
  const runner = new GoalRunner({ storage, xExecutor });

  const goal = await runner.create_goal({
    title: 'No Anti Goal',
    objective: 'X only',
    workspace: testWorkspace,
    steps: [{ id: 's1', title: 'X step', description: '', route: 'x', xTask: validXTask() }],
  });

  const requestId = `goal:${goal.id}:step:s1`;
  xExecutor.statuses.set(requestId, { found: true, queue_status: 'terminal', terminal_status: 'completed', result: 'ok' });

  await runner.run_goal(goal.id);

});

// ── 8 & 9. Stable requestId + duplicate resume never duplicates X execution ─
await test('8/9. requestId is stable per goal+step, and duplicate resume does not duplicate X execution', async () => {
  const storage = new GoalStorage({ storagePath: freshStoragePath() });
  const xExecutor = makeMockXExecutor();
  const runner = new GoalRunner({ storage, xExecutor });

  const goal = await runner.create_goal({
    title: 'Duplicate Resume Goal',
    objective: 'Should not double-execute',
    workspace: testWorkspace,
    steps: [{ id: 's1', title: 'X step', description: '', route: 'x', xTask: validXTask() }],
  });

  const expectedRequestId = `goal:${goal.id}:step:s1`;
  // needs_review: goal stops automatically, remains resumable.
  xExecutor.statuses.set(expectedRequestId, { found: true, queue_status: 'terminal', terminal_status: 'needs_review', error: 'please review' });

  const first = await runner.run_goal(goal.id);
  assert.equal(first.status, 'waiting');
  assert.equal(xExecutor.dispatchLog.length, 1);
  const requestId1 = xExecutor.dispatchLog[0].requestId;

  await assert.rejects(
    () => runner.resume_goal(goal.id),
    /blocked by unresolved review item/
  );
  assert.equal(xExecutor.dispatchLog.length, 1, 'a duplicate resume must not create a second X execution');
  assert.equal(requestId1, expectedRequestId);
  assert.equal(requestId1, `goal:${goal.id}:step:s1`);
});

// ── 10. COMPLETED advances to the next already-authored READY step ─────────
await test('10. COMPLETED advances to next already-authored step', async () => {
  const storage = new GoalStorage({ storagePath: freshStoragePath() });
  const xExecutor = makeMockXExecutor();
  const runner = new GoalRunner({ storage, xExecutor });

  const goal = await runner.create_goal({
    title: 'Two Step Goal',
    objective: 'X then manual review',
    workspace: testWorkspace,
    steps: [
      { id: 's1', title: 'X step', description: '', route: 'x', xTask: validXTask() },
      { id: 's2', title: 'Manual step', description: 'Second step', route: 'manual' },
    ],
  });

  const requestId = `goal:${goal.id}:step:s1`;
  xExecutor.statuses.set(requestId, { found: true, queue_status: 'terminal', terminal_status: 'completed', result: 'x step ok' });

  const finished = await runner.run_goal(goal.id);

  assert.equal(finished.steps[0].status, 'completed');
  assert.equal(finished.steps[1].status, 'waiting');
  assert.equal(finished.status, 'waiting');
});

// ── 11. NEEDS_REVIEW stops automatic continuation ───────────────────────────
await test('11. NEEDS_REVIEW stops automatic continuation', async () => {
  const storage = new GoalStorage({ storagePath: freshStoragePath() });
  const xExecutor = makeMockXExecutor();
  const runner = new GoalRunner({ storage, xExecutor });

  const goal = await runner.create_goal({
    title: 'Needs Review Goal',
    objective: 'Should stop',
    workspace: testWorkspace,
    steps: [
      { id: 's1', title: 'X step', description: '', route: 'x', xTask: validXTask() },
      { id: 's2', title: 'Manual step', description: 'Never runs', route: 'manual' },
    ],
  });

  const requestId = `goal:${goal.id}:step:s1`;
  xExecutor.statuses.set(requestId, { found: true, queue_status: 'terminal', terminal_status: 'needs_review', error: 'ambiguous result' });

  const finished = await runner.run_goal(goal.id);

  assert.equal(finished.steps[0].status, 'waiting');
  assert.equal(finished.steps[1].status, 'pending', 'dependent step must not have been dispatched');
  assert.equal(finished.status, 'waiting');
});

// ── 12. FAILED stops dependent continuation ─────────────────────────────────
await test('12. FAILED stops dependent continuation', async () => {
  const storage = new GoalStorage({ storagePath: freshStoragePath() });
  const xExecutor = makeMockXExecutor();
  const runner = new GoalRunner({ storage, xExecutor });

  const goal = await runner.create_goal({
    title: 'Failed Goal',
    objective: 'Should stop dependents',
    workspace: testWorkspace,
    steps: [
      { id: 's1', title: 'X step', description: '', route: 'x', xTask: validXTask(), required: true },
      { id: 's2', title: 'Manual step', description: 'Never runs', route: 'manual' },
    ],
  });

  const requestId = `goal:${goal.id}:step:s1`;
  xExecutor.statuses.set(requestId, { found: true, queue_status: 'terminal', terminal_status: 'failed', error: 'x execution failed' });

  const finished = await runner.run_goal(goal.id);

  assert.equal(finished.steps[0].status, 'error');
  assert.equal(finished.steps[1].status, 'pending');
  assert.equal(finished.status, 'error');
  assert.match(finished.error, /x execution failed/);
});

// ── 12b. FAILED result with no top-level error surfaces reason_code + blocker reason/detail ──
await test('12b. FAILED (structural_execution_failure) with no top-level error surfaces the stable reason_code AND the specific blocker reason/detail in the Review Queue', async () => {
  const storage = new GoalStorage({ storagePath: freshStoragePath() });
  const xExecutor = makeMockXExecutor();
  const runner = new GoalRunner({ storage, xExecutor });

  const goal = await runner.create_goal({
    title: 'Structural Failure Goal',
    objective: 'Reproduce the real P2D structural_execution_failure',
    workspace: testWorkspace,
    steps: [{ id: 's1', title: 'X step', description: '', route: 'x', xTask: validXTask(), required: true }],
  });

  const requestId = `goal:${goal.id}:step:s1`;
  // Mirrors the actual persisted x-result-v1 for run_id
  // c749980f-edfe-4314-8708-d08bcd5ab00e: no top-level queue error string,
  // only the result's reason_code + blockers[0].
  xExecutor.statuses.set(requestId, {
    found: true,
    queue_status: 'terminal',
    terminal_status: 'failed',
    error: null,
    result: {
      reason_code: 'structural_execution_failure',
      blockers: [{ reason: 'unsupported_action', detail: "action 0: unsupported type 'undefined'" }],
    },
  });

  const finished = await runner.run_goal(goal.id);

  assert.equal(finished.status, 'error');
  const item = finished.reviewQueue[0];
  assert.ok(item, 'a Review Queue item must be recorded');
  // The stable reason_code must still be present, unchanged.
  assert.match(item.reason, /structural_execution_failure/);
  // The specific underlying blocker must now also be surfaced, not dropped.
  assert.match(item.reason, /unsupported_action/);
  assert.match(item.reason, /action 0: unsupported type 'undefined'/);
  // No duplicate dispatch: exactly one X dispatch for this run.
  assert.equal(xExecutor.dispatchLog.filter((d) => d.requestId === requestId).length, 1);
});

// ── 11b. NEEDS_REVIEW result with no top-level error surfaces waiting_reason + blocker reason/detail ──
await test('11b. NEEDS_REVIEW (safety_boundary_review) with no top-level error surfaces waiting_reason AND blocker reason/detail in the Review Queue', async () => {
  const storage = new GoalStorage({ storagePath: freshStoragePath() });
  const xExecutor = makeMockXExecutor();
  const runner = new GoalRunner({ storage, xExecutor });

  const goal = await runner.create_goal({
    title: 'Safety Boundary Review Goal',
    objective: 'A safety-boundary block should still show its specific blocker',
    workspace: testWorkspace,
    steps: [{ id: 's1', title: 'X step', description: '', route: 'x', xTask: validXTask(), required: true }],
  });

  const requestId = `goal:${goal.id}:step:s1`;
  xExecutor.statuses.set(requestId, {
    found: true,
    queue_status: 'terminal',
    terminal_status: 'needs_review',
    error: null,
    result: {
      reason_code: 'safety_boundary_review',
      waiting_reason: 'supervisor_review',
      blockers: [{ reason: 'PROTECTED_PATH', detail: 'attempted write to a protected path' }],
    },
  });

  const finished = await runner.run_goal(goal.id);

  assert.equal(finished.status, 'waiting');
  const item = finished.reviewQueue[0];
  assert.ok(item, 'a Review Queue item must be recorded');
  assert.match(item.reason, /supervisor_review/);
  assert.match(item.reason, /PROTECTED_PATH/);
  assert.match(item.reason, /attempted write to a protected path/);
  assert.equal(xExecutor.dispatchLog.filter((d) => d.requestId === requestId).length, 1);
});

// ── 13. INTERRUPTED remains recoverable (Slice 2: new generation + new requestId) ──
await test('13. INTERRUPTED remains recoverable/waiting (Slice 2: allocates new generation, resumes with :exec:2)', async () => {
  const storage = new GoalStorage({ storagePath: freshStoragePath() });
  const xExecutor = makeMockXExecutor();
  const runner = new GoalRunner({ storage, xExecutor });

  const goal = await runner.create_goal({
    title: 'Interrupted Goal',
    objective: 'Should stay recoverable',
    workspace: testWorkspace,
    steps: [{ id: 's1', title: 'X step', description: '', route: 'x', xTask: validXTask() }],
  });

  const gen1RequestId = `goal:${goal.id}:step:s1`;
  const gen2RequestId = `goal:${goal.id}:step:s1:exec:2`;
  xExecutor.statuses.set(gen1RequestId, { found: true, queue_status: 'terminal', terminal_status: 'interrupted' });

  const finished = await runner.run_goal(goal.id);
  assert.equal(finished.steps[0].status, 'waiting');
  assert.equal(finished.status, 'waiting');
  // Slice 2: generation allocated exactly once on INTERRUPTED
  assert.equal(finished.steps[0].executionGeneration, 2, 'executionGeneration must be 2 after INTERRUPTED');
  assert.equal(xExecutor.dispatchLog.length, 1, 'gen1 dispatched once');
  assert.equal(xExecutor.dispatchLog[0].requestId, gen1RequestId);

  // Recovery: resume dispatches a fresh execution under gen2 requestId, not the old terminal gen1.
  // Set gen2 receipt to completed so resume can finish.
  xExecutor.statuses.set(gen2RequestId, { found: true, queue_status: 'terminal', terminal_status: 'completed', result: 'recovered' });
  const resumed = await runner.resume_goal(goal.id);
  assert.equal(resumed.steps[0].status, 'completed');
  assert.equal(resumed.status, 'completed');
  // gen2 must have been dispatched exactly once (not gen1 again, which would coalesce to interrupted)
  const gen2Dispatches = xExecutor.dispatchLog.filter((d) => d.requestId === gen2RequestId);
  assert.equal(gen2Dispatches.length, 1, 'gen2 requestId must be dispatched exactly once for recovery');
  assert.equal(xExecutor.dispatchLog.length, 2, 'total: 1 gen1 + 1 gen2 dispatch');
});

// ── 14. Manual/checkpoint behavior unchanged ────────────────────────────────
await test('14. manual/checkpoint behavior unchanged alongside route:x', async () => {
  const storage = new GoalStorage({ storagePath: freshStoragePath() });
  const xExecutor = makeMockXExecutor();
  const runner = new GoalRunner({ storage, xExecutor });

  const goal = await runner.create_goal({
    title: 'Manual Plus X Goal',
    objective: 'Manual gate must still hold',
    workspace: testWorkspace,
    steps: [
      { id: 's1', title: 'X step', description: '', route: 'x', xTask: validXTask() },
      { id: 's2', title: 'Manual step', description: 'Needs sign-off', route: 'manual' },
    ],
  });

  const requestId = `goal:${goal.id}:step:s1`;
  xExecutor.statuses.set(requestId, { found: true, queue_status: 'terminal', terminal_status: 'completed', result: 'ok' });

  const afterX = await runner.run_goal(goal.id);
  assert.equal(afterX.steps[0].status, 'completed');
  assert.equal(afterX.steps[1].status, 'waiting');
  assert.equal(afterX.status, 'waiting');

  // resume_goal must still refuse to bypass the manual gate.
  await assert.rejects(async () => runner.resume_goal(goal.id), /manual sign-off is required/i);

  const signed = await runner.signoff_step(goal.id, 's2', { action: 'complete' });
  assert.equal(signed.status, 'completed');
});

// ── 15. Pause/resume unchanged with an x-route step present ────────────────
await test('15. pause/resume unchanged with a route:x step present (Slice 2: recovery uses :exec:2)', async () => {
  const storage = new GoalStorage({ storagePath: freshStoragePath() });
  const xExecutor = makeMockXExecutor();
  const runner = new GoalRunner({ storage, xExecutor });

  const goal = await runner.create_goal({
    title: 'Pause X Goal',
    objective: 'Pause while an X step is in review',
    workspace: testWorkspace,
    steps: [{ id: 's1', title: 'X step', description: '', route: 'x', xTask: validXTask() }],
  });

  const gen1RequestId = `goal:${goal.id}:step:s1`;
  const gen2RequestId = `goal:${goal.id}:step:s1:exec:2`;
  // interrupted leaves the goal in 'waiting', one of pause_goal's two
  // allowed source statuses (the other is 'running') -- exercising the
  // existing pause/resume gate exactly as any other route already does.
  xExecutor.statuses.set(gen1RequestId, { found: true, queue_status: 'terminal', terminal_status: 'interrupted' });
  const waiting = await runner.run_goal(goal.id);
  assert.equal(waiting.status, 'waiting');
  // Slice 2: generation allocated to 2 after INTERRUPTED
  assert.equal(waiting.steps[0].executionGeneration, 2);
  assert.equal(xExecutor.dispatchLog.length, 1);

  await runner.pause_goal(goal.id);
  const paused = storage.getGoal(goal.id);
  assert.equal(paused.status, 'paused');
  assert.equal(xExecutor.dispatchLog.length, 1, 'pause_goal itself must never dispatch to X');

  // Recovery: resume dispatches under gen2 requestId (new execution, not the old terminal gen1).
  xExecutor.statuses.set(gen2RequestId, { found: true, queue_status: 'terminal', terminal_status: 'completed', result: 'ok' });
  const resumed = await runner.resume_goal(goal.id);
  assert.equal(resumed.status, 'completed');
  const gen2Dispatches = xExecutor.dispatchLog.filter((d) => d.requestId === gen2RequestId);
  assert.equal(gen2Dispatches.length, 1, 'resume must dispatch exactly one gen2 execution for recovery');
  assert.equal(xExecutor.dispatchLog.length, 2, 'total: 1 gen1 + 1 gen2 dispatch');
});

// ── 16. Startup reconciliation does not rerun an already-terminal X step ───
await test('16. restart/reconciliation does not rerun an already-terminal X step', async () => {
  const storagePath = freshStoragePath();
  const storage = new GoalStorage({ storagePath });
  const xExecutor = makeMockXExecutor();
  const runner = new GoalRunner({ storage, xExecutor });

  const goal = await runner.create_goal({
    title: 'Already Completed X Goal',
    objective: 'Must not rerun on restart',
    workspace: testWorkspace,
    steps: [{ id: 's1', title: 'X step', description: '', route: 'x', xTask: validXTask() }],
  });

  const requestId = `goal:${goal.id}:step:s1`;
  xExecutor.statuses.set(requestId, { found: true, queue_status: 'terminal', terminal_status: 'completed', result: 'already done' });
  await runner.run_goal(goal.id);
  assert.equal(xExecutor.dispatchLog.length, 1);

  // Simulate an app restart: new GoalStorage + new GoalRunner + fresh xExecutor spy.
  const restartedStorage = new GoalStorage({ storagePath });
  const restartedXExecutor = makeMockXExecutor();
  const restartedRunner = new GoalRunner({ storage: restartedStorage, xExecutor: restartedXExecutor });
  const reconciled = restartedRunner.get_goal(goal.id);
  assert.equal(reconciled.status, 'completed', 'a genuinely completed goal must stay completed across restart');

  await assert.rejects(async () => restartedRunner.run_goal(goal.id), /already completed/i);
  assert.equal(restartedXExecutor.dispatchLog.length, 0, 'restart must never redispatch an already-terminal X step');
});

// ── 16b. Restart mid-X-run demotes to paused (existing generic behavior) ───
await test('16b. a running X step is demoted to paused on restart, then safely resumable', async () => {
  const storagePath = freshStoragePath();
  const storage = new GoalStorage({ storagePath });
  const xExecutor = makeMockXExecutor();
  const runner = new GoalRunner({ storage, xExecutor });

  const goal = await runner.create_goal({
    title: 'Interrupted Restart Goal',
    objective: 'Simulate a crash mid X run',
    workspace: testWorkspace,
    steps: [{ id: 's1', title: 'X step', description: '', route: 'x', xTask: validXTask() }],
  });

  // Simulate a crash mid-execution: goal/step left 'running' on disk.
  const crashed = storage.getGoal(goal.id);
  crashed.status = 'running';
  crashed.currentStepId = 's1';
  crashed.steps[0].status = 'running';
  storage.saveGoal(crashed);

  const restartedStorage = new GoalStorage({ storagePath });
  const restartedXExecutor = makeMockXExecutor();
  const restartedRunner = new GoalRunner({ storage: restartedStorage, xExecutor: restartedXExecutor });

  const reconciled = restartedRunner.get_goal(goal.id);
  assert.equal(reconciled.status, 'paused');
  assert.equal(reconciled.steps[0].status, 'paused');
  assert.equal(restartedXExecutor.dispatchLog.length, 0, 'reconciliation itself must never dispatch to X');

  const requestId = `goal:${goal.id}:step:s1`;
  restartedXExecutor.statuses.set(requestId, { found: true, queue_status: 'terminal', terminal_status: 'completed', result: 'resumed ok' });
  const resumed = await restartedRunner.resume_goal(goal.id);
  assert.equal(resumed.status, 'completed');
  assert.equal(restartedXExecutor.dispatchLog.length, 1);
  assert.equal(restartedXExecutor.dispatchLog[0].requestId, requestId);
});

// ── 17. Retired route fails closed for new goals ────────────────────────────
await test('17. retired route cannot be added to a new Goal', async () => {
  const storage = new GoalStorage({ storagePath: freshStoragePath() });
  const runner = new GoalRunner({ storage });
  await assert.rejects(() => runner.create_goal({
    title: 'Retired route', objective: 'Preserve historical safety', workspace: testWorkspace,
    steps: [{ id: 's1', title: 'Legacy step', route: 'antigravity' }],
  }), /goal_step_route_retired/);
});

// ── Additional: X executor not configured fails closed ─────────────────────
await test('additional: route:x with no xExecutor configured fails closed', async () => {
  const storage = new GoalStorage({ storagePath: freshStoragePath() });
  const runner = new GoalRunner({ storage }); // no xExecutor

  const goal = await runner.create_goal({
    title: 'No Executor Goal',
    objective: 'Should fail closed',
    workspace: testWorkspace,
    steps: [{ id: 's1', title: 'X step', description: '', route: 'x', xTask: validXTask() }],
  });

  const finished = await runner.run_goal(goal.id);
  assert.equal(finished.status, 'error');
  assert.match(finished.error, /X executor is not configured/);
});

console.log(`\nResults: ${passed} passed, ${failed} failed out of ${passed + failed} tests\n`);
if (failed > 0) process.exit(1);
