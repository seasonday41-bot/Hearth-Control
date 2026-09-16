/**
 * Hearth Goal Runner Autopilot Multi-Step Coordination Test Suite (Slice 3)
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

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hearth-autopilot-test-'));
const testWorkspace = path.join(tmpDir, 'workspace');
await fs.mkdir(testWorkspace, { recursive: true });
let storageCounter = 0;
const freshStoragePath = () => path.join(tmpDir, `goals-${++storageCounter}.json`);

const validXTask = (taskId = 'TASK-1', overrides = {}) => ({
  version: X_TASK_VERSION,
  task_id: taskId,
  parent_task_id: null,
  revision: 1,
  attempt: 1,
  based_on_result_id: null,
  objective: 'Autopilot test objective.',
  problem: 'Problem description.',
  expected_behavior: 'Expected behavior.',
  observed_behavior: 'Observed behavior.',
  why_this_matters: 'Slice 3 test coverage.',
  known_evidence: [],
  suspected_area: [],
  workspace: { repo: 'fixture', root: testWorkspace },
  scope: { allowed_paths: ['scripts'], preferred_files: [], forbidden_paths: [] },
  constraints: { preserve: [], do_not: [] },
  allowed_tools: ['repo_read'],
  acceptance_criteria: ['Done'],
  validation: { required: ['node --test scripts/test-build-metadata.mjs'], optional: [] },
  verification: null,
  done_criteria: ['Done'],
  teaching_notes: [],
  uncertainty_policy: { policy: 'bounded_autonomy', stop_conditions: [] },
  repair_budget: { initial_attempts: 1, max_repairs: 2, max_total_rounds: 3 },
  timing: { estimated_minutes: 1, first_check_after_minutes: 1, soft_deadline_minutes: 1, hard_timeout_minutes: 1 },
  commit_policy: { mode: 'never' },
  ...overrides,
});

const makeMockXExecutor = () => {
  const dispatches = new Map();
  const dispatchLog = [];
  const statuses = new Map();
  return {
    dispatches, dispatchLog, statuses,
    dispatchXTask: async ({ requestId, task }) => {
      if (!dispatches.has(requestId)) {
        dispatches.set(requestId, { task });
      }
      dispatchLog.push({ requestId, task, timestamp: Date.now() });
      return { accepted: true };
    },
    getXTaskStatus: async (requestId) => statuses.get(requestId) || { found: false, queue_status: undefined },
  };
};

console.log('\n=== Hearth Goal Runner Autopilot Multi-Step Test Suite (Slice 3) ===\n');

// ── 1. NORMAL MULTI-STEP ───────────────────────────────────────────────────
await test('1. Normal multi-step Goal: 3 X steps execute in order to completion, each dispatched once', async () => {
  const storagePath = freshStoragePath();
  const xExecutor = makeMockXExecutor();
  const storage = new GoalStorage({ storagePath });
  const runner = new GoalRunner({ storage, xExecutor });

  const goal = await runner.create_goal({
    title: '3-Step Goal', objective: 'Run all 3', workspace: testWorkspace,
    steps: [
      { id: 's1', title: 'Step 1', description: '', route: 'x', xTask: validXTask('T1') },
      { id: 's2', title: 'Step 2', description: '', route: 'x', xTask: validXTask('T2') },
      { id: 's3', title: 'Step 3', description: '', route: 'x', xTask: validXTask('T3') },
    ],
  });

  const req1 = `goal:${goal.id}:step:s1`;
  const req2 = `goal:${goal.id}:step:s2`;
  const req3 = `goal:${goal.id}:step:s3`;

  xExecutor.statuses.set(req1, { found: true, queue_status: 'terminal', terminal_status: 'completed', result: 'ok1' });
  xExecutor.statuses.set(req2, { found: true, queue_status: 'terminal', terminal_status: 'completed', result: 'ok2' });
  xExecutor.statuses.set(req3, { found: true, queue_status: 'terminal', terminal_status: 'completed', result: 'ok3' });

  const finished = await runner.run_goal(goal.id);

  assert.equal(finished.status, 'completed');
  assert.equal(finished.steps[0].status, 'completed');
  assert.equal(finished.steps[1].status, 'completed');
  assert.equal(finished.steps[2].status, 'completed');

  assert.equal(xExecutor.dispatchLog.length, 3);
  assert.equal(xExecutor.dispatchLog[0].requestId, req1);
  assert.equal(xExecutor.dispatchLog[1].requestId, req2);
  assert.equal(xExecutor.dispatchLog[2].requestId, req3);
});

// ── 2. SAME-GOAL RE-ENTRY ──────────────────────────────────────────────────
await test('2. Same-goal concurrent re-entry is rejected immediately', async () => {
  const storagePath = freshStoragePath();
  const storage = new GoalStorage({ storagePath });

  let slowResolve;
  const xExecutor = {
    dispatchXTask: async () => ({ accepted: true }),
    getXTaskStatus: async () => {
      // Hold execution in-flight
      await new Promise((r) => { slowResolve = r; });
      return { found: true, queue_status: 'terminal', terminal_status: 'completed', result: 'ok' };
    },
  };

  const runner = new GoalRunner({ storage, xExecutor });
  const goal = await runner.create_goal({
    title: 'Slow Goal', objective: 'Test lock', workspace: testWorkspace,
    steps: [{ id: 's1', title: 'Step 1', description: '', route: 'x', xTask: validXTask('T-LOCK') }],
  });

  // Start first run_goal (will block in getXTaskStatus)
  const firstRun = runner.run_goal(goal.id);
  await new Promise((r) => setTimeout(r, 10)); // Ensure first run enters loop and acquires lock

  // Concurrent call on same goal ID must reject
  await assert.rejects(
    () => runner.run_goal(goal.id),
    /already executing/i
  );

  // Unblock first run
  slowResolve();
  const finished = await firstRun;
  assert.equal(finished.status, 'completed');
});

// ── 3. DIFFERENT-GOAL RE-ENTRY ──────────────────────────────────────────────
await test('3. Different-goal concurrent re-entry is rejected immediately', async () => {
  const storagePath = freshStoragePath();
  const storage = new GoalStorage({ storagePath });

  let slowResolve;
  const xExecutor = {
    dispatchXTask: async () => ({ accepted: true }),
    getXTaskStatus: async () => {
      await new Promise((r) => { slowResolve = r; });
      return { found: true, queue_status: 'terminal', terminal_status: 'completed', result: 'ok' };
    },
  };

  const runner = new GoalRunner({ storage, xExecutor });
  const goalA = await runner.create_goal({
    title: 'Goal A', objective: 'Lock test A', workspace: testWorkspace,
    steps: [{ id: 's1', title: 'Step 1', description: '', route: 'x', xTask: validXTask('TA') }],
  });
  const goalB = await runner.create_goal({
    title: 'Goal B', objective: 'Lock test B', workspace: testWorkspace,
    steps: [{ id: 's1', title: 'Step 1', description: '', route: 'x', xTask: validXTask('TB') }],
  });

  const runA = runner.run_goal(goalA.id);
  await new Promise((r) => setTimeout(r, 10));

  await assert.rejects(
    () => runner.run_goal(goalB.id),
    /Another goal .* is currently executing/i
  );

  slowResolve();
  await runA;
});

// ── 4. NEEDS_REVIEW STOP ───────────────────────────────────────────────────
await test('4. Step 2 NEEDS_REVIEW stops autopilot immediately before Step 3 dispatch', async () => {
  const storagePath = freshStoragePath();
  const xExecutor = makeMockXExecutor();
  const storage = new GoalStorage({ storagePath });
  const runner = new GoalRunner({ storage, xExecutor });

  const goal = await runner.create_goal({
    title: 'Needs Review Goal', objective: 'Stop at step 2', workspace: testWorkspace,
    steps: [
      { id: 's1', title: 'Step 1', description: '', route: 'x', xTask: validXTask('T1') },
      { id: 's2', title: 'Step 2', description: '', route: 'x', xTask: validXTask('T2') },
      { id: 's3', title: 'Step 3', description: '', route: 'x', xTask: validXTask('T3') },
    ],
  });

  xExecutor.statuses.set(`goal:${goal.id}:step:s1`, { found: true, queue_status: 'terminal', terminal_status: 'completed', result: 'ok' });
  xExecutor.statuses.set(`goal:${goal.id}:step:s2`, {
    found: true, queue_status: 'terminal', terminal_status: 'needs_review',
    result: { version: 'x-result-v1', result_id: 'r2', task_id: 'T2', reason_code: 'waiting_review' },
  });

  const waiting = await runner.run_goal(goal.id);

  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.steps[0].status, 'completed');
  assert.equal(waiting.steps[1].status, 'waiting');
  assert.equal(waiting.steps[2].status, 'pending');

  const step3Dispatches = xExecutor.dispatchLog.filter((d) => d.requestId === `goal:${goal.id}:step:s3`);
  assert.equal(step3Dispatches.length, 0, 'Step 3 must NEVER have dispatched');
});

// ── 5. REVIEW ACCEPT CONTINUATION ──────────────────────────────────────────
await test('5. Resolving Step 2 (accept) skips steps 1/2 and dispatches Step 3 to completion', async () => {
  const storagePath = freshStoragePath();
  const xExecutor = makeMockXExecutor();
  const storage = new GoalStorage({ storagePath });
  const runner = new GoalRunner({ storage, xExecutor });

  const goal = await runner.create_goal({
    title: 'Resolve Accept Goal', objective: 'Resume after accept', workspace: testWorkspace,
    steps: [
      { id: 's1', title: 'Step 1', description: '', route: 'x', xTask: validXTask('T1') },
      { id: 's2', title: 'Step 2', description: '', route: 'x', xTask: validXTask('T2') },
      { id: 's3', title: 'Step 3', description: '', route: 'x', xTask: validXTask('T3') },
    ],
  });

  xExecutor.statuses.set(`goal:${goal.id}:step:s1`, { found: true, queue_status: 'terminal', terminal_status: 'completed', result: 'ok' });
  xExecutor.statuses.set(`goal:${goal.id}:step:s2`, {
    found: true, queue_status: 'terminal', terminal_status: 'needs_review',
    result: { version: 'x-result-v1', result_id: 'r2', task_id: 'T2', reason_code: 'waiting_review' },
  });
  xExecutor.statuses.set(`goal:${goal.id}:step:s3`, { found: true, queue_status: 'terminal', terminal_status: 'completed', result: 'ok3' });

  const waiting = await runner.run_goal(goal.id);
  const item = waiting.reviewQueue[0];

  // Resolve step 2
  await runner.resolve_review(goal.id, item.id, { action: 'accept' });

  const initialLogLength = xExecutor.dispatchLog.length;
  const completed = await runner.resume_goal(goal.id);

  assert.equal(completed.status, 'completed');
  assert.equal(completed.steps[0].status, 'completed');
  assert.equal(completed.steps[1].status, 'completed');
  assert.equal(completed.steps[2].status, 'completed');

  // Steps 1 & 2 must NOT be re-dispatched on resume
  const s1Count = xExecutor.dispatchLog.filter((d) => d.requestId === `goal:${goal.id}:step:s1`).length;
  const s2Count = xExecutor.dispatchLog.filter((d) => d.requestId === `goal:${goal.id}:step:s2`).length;
  const s3Count = xExecutor.dispatchLog.filter((d) => d.requestId === `goal:${goal.id}:step:s3`).length;

  assert.equal(s1Count, 1, 'Step 1 dispatched exactly once');
  assert.equal(s2Count, 1, 'Step 2 dispatched exactly once');
  assert.equal(s3Count, 1, 'Step 3 dispatched exactly once');
});

// ── 6. REVIEW RETRY CONTINUATION ──────────────────────────────────────────
await test('6. Retrying Step 2 runs Step 2 (gen 2) FIRST before Step 3 dispatches', async () => {
  const storagePath = freshStoragePath();
  const xExecutor = makeMockXExecutor();
  const storage = new GoalStorage({ storagePath });
  const runner = new GoalRunner({ storage, xExecutor });

  const goal = await runner.create_goal({
    title: 'Retry Continuation Goal', objective: 'Retry step 2 first', workspace: testWorkspace,
    steps: [
      { id: 's1', title: 'Step 1', description: '', route: 'x', xTask: validXTask('T1') },
      { id: 's2', title: 'Step 2', description: '', route: 'x', xTask: validXTask('T2') },
      { id: 's3', title: 'Step 3', description: '', route: 'x', xTask: validXTask('T3') },
    ],
  });

  xExecutor.statuses.set(`goal:${goal.id}:step:s1`, { found: true, queue_status: 'terminal', terminal_status: 'completed', result: 'ok' });
  xExecutor.statuses.set(`goal:${goal.id}:step:s2`, {
    found: true, queue_status: 'terminal', terminal_status: 'needs_review',
    result: { version: 'x-result-v1', result_id: 'r2', task_id: 'T2', reason_code: 'waiting_review' },
  });

  const waiting = await runner.run_goal(goal.id);
  const item = waiting.reviewQueue[0];

  const retryXTask = validXTask('T2', { revision: 1, attempt: 2, based_on_result_id: 'r2' });
  await runner.retry_review(goal.id, item.id, { xTask: retryXTask });

  // Set gen 2 status for Step 2 and status for Step 3
  const gen2Req = `goal:${goal.id}:step:s2:exec:2`;
  xExecutor.statuses.set(gen2Req, { found: true, queue_status: 'terminal', terminal_status: 'completed', result: 'ok2-retried' });
  xExecutor.statuses.set(`goal:${goal.id}:step:s3`, { found: true, queue_status: 'terminal', terminal_status: 'completed', result: 'ok3' });

  const completed = await runner.resume_goal(goal.id);

  assert.equal(completed.status, 'completed');
  assert.equal(completed.steps[1].status, 'completed');
  assert.equal(completed.steps[2].status, 'completed');

  // Verify dispatch order: s1 -> s2 (gen 1) -> s2:exec:2 (gen 2) -> s3
  assert.equal(xExecutor.dispatchLog[0].requestId, `goal:${goal.id}:step:s1`);
  assert.equal(xExecutor.dispatchLog[1].requestId, `goal:${goal.id}:step:s2`);
  assert.equal(xExecutor.dispatchLog[2].requestId, gen2Req);
  assert.equal(xExecutor.dispatchLog[3].requestId, `goal:${goal.id}:step:s3`);
});

// ── 7. REQUIRED FAILED STOP ───────────────────────────────────────────────
await test('7. Step 2 FAILED required:true stops autopilot immediately in error status', async () => {
  const storagePath = freshStoragePath();
  const xExecutor = makeMockXExecutor();
  const storage = new GoalStorage({ storagePath });
  const runner = new GoalRunner({ storage, xExecutor });

  const goal = await runner.create_goal({
    title: 'Required Fail Goal', objective: 'Stop on required fail', workspace: testWorkspace,
    steps: [
      { id: 's1', title: 'Step 1', description: '', route: 'x', xTask: validXTask('T1') },
      { id: 's2', title: 'Step 2', description: '', route: 'x', xTask: validXTask('T2'), required: true },
      { id: 's3', title: 'Step 3', description: '', route: 'x', xTask: validXTask('T3') },
    ],
  });

  xExecutor.statuses.set(`goal:${goal.id}:step:s1`, { found: true, queue_status: 'terminal', terminal_status: 'completed', result: 'ok' });
  xExecutor.statuses.set(`goal:${goal.id}:step:s2`, { found: true, queue_status: 'terminal', terminal_status: 'failed', error: 'build failure' });

  const failedGoal = await runner.run_goal(goal.id);

  assert.equal(failedGoal.status, 'error');
  assert.equal(failedGoal.steps[0].status, 'completed');
  assert.equal(failedGoal.steps[1].status, 'error');
  assert.equal(failedGoal.steps[2].status, 'pending');

  const s3Dispatches = xExecutor.dispatchLog.filter((d) => d.requestId === `goal:${goal.id}:step:s3`);
  assert.equal(s3Dispatches.length, 0, 'Step 3 must not dispatch');
});

// ── 8. OPTIONAL FAILED CONTINUATION ───────────────────────────────────────
await test('8. Step 2 FAILED required:false logs error, preserves Goal progress, and dispatches Step 3', async () => {
  const storagePath = freshStoragePath();
  const xExecutor = makeMockXExecutor();
  const storage = new GoalStorage({ storagePath });
  const runner = new GoalRunner({ storage, xExecutor });

  const goal = await runner.create_goal({
    title: 'Optional Fail Goal', objective: 'Continue on optional fail', workspace: testWorkspace,
    steps: [
      { id: 's1', title: 'Step 1', description: '', route: 'x', xTask: validXTask('T1') },
      { id: 's2', title: 'Step 2', description: '', route: 'x', xTask: validXTask('T2'), required: false },
      { id: 's3', title: 'Step 3', description: '', route: 'x', xTask: validXTask('T3') },
    ],
  });

  xExecutor.statuses.set(`goal:${goal.id}:step:s1`, { found: true, queue_status: 'terminal', terminal_status: 'completed', result: 'ok' });
  xExecutor.statuses.set(`goal:${goal.id}:step:s2`, { found: true, queue_status: 'terminal', terminal_status: 'failed', error: 'optional test failed' });
  xExecutor.statuses.set(`goal:${goal.id}:step:s3`, { found: true, queue_status: 'terminal', terminal_status: 'completed', result: 'ok3' });

  const finished = await runner.run_goal(goal.id);

  assert.equal(finished.status, 'completed');
  assert.equal(finished.steps[0].status, 'completed');
  assert.equal(finished.steps[1].status, 'error', 'Optional step remains error');
  assert.equal(finished.steps[2].status, 'completed', 'Step 3 executes to completion');

  const s3Dispatches = xExecutor.dispatchLog.filter((d) => d.requestId === `goal:${goal.id}:step:s3`);
  assert.equal(s3Dispatches.length, 1);
});

// ── 9. INTERRUPTED STOP ────────────────────────────────────────────────────
await test('9. Step 2 INTERRUPTED stops autopilot, allocates generation 2, and leaves Step 3 pending', async () => {
  const storagePath = freshStoragePath();
  const xExecutor = makeMockXExecutor();
  const storage = new GoalStorage({ storagePath });
  const runner = new GoalRunner({ storage, xExecutor });

  const goal = await runner.create_goal({
    title: 'Interrupted Stop Goal', objective: 'Stop on interrupted', workspace: testWorkspace,
    steps: [
      { id: 's1', title: 'Step 1', description: '', route: 'x', xTask: validXTask('T1') },
      { id: 's2', title: 'Step 2', description: '', route: 'x', xTask: validXTask('T2') },
      { id: 's3', title: 'Step 3', description: '', route: 'x', xTask: validXTask('T3') },
    ],
  });

  xExecutor.statuses.set(`goal:${goal.id}:step:s1`, { found: true, queue_status: 'terminal', terminal_status: 'completed', result: 'ok' });
  xExecutor.statuses.set(`goal:${goal.id}:step:s2`, { found: true, queue_status: 'terminal', terminal_status: 'interrupted' });

  const waiting = await runner.run_goal(goal.id);

  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.steps[1].status, 'waiting');
  assert.equal(waiting.steps[1].executionGeneration, 2);
  assert.equal(waiting.steps[2].status, 'pending');
  assert.equal(waiting.reviewQueue.length, 0);

  const s3Dispatches = xExecutor.dispatchLog.filter((d) => d.requestId === `goal:${goal.id}:step:s3`);
  assert.equal(s3Dispatches.length, 0);
});

// ── 10. INTERRUPTED RESTART ────────────────────────────────────────────────
await test('10. Interrupted recovery allocation persists across restart and resumes with :exec:2 before Step 3', async () => {
  const storagePath = freshStoragePath();
  const xExecutor = makeMockXExecutor();
  const storage = new GoalStorage({ storagePath });
  const runner = new GoalRunner({ storage, xExecutor });

  const goal = await runner.create_goal({
    title: 'Interrupted Restart Goal', objective: 'Test restart after interrupted allocation', workspace: testWorkspace,
    steps: [
      { id: 's1', title: 'Step 1', description: '', route: 'x', xTask: validXTask('T1') },
      { id: 's2', title: 'Step 2', description: '', route: 'x', xTask: validXTask('T2') },
      { id: 's3', title: 'Step 3', description: '', route: 'x', xTask: validXTask('T3') },
    ],
  });

  xExecutor.statuses.set(`goal:${goal.id}:step:s1`, { found: true, queue_status: 'terminal', terminal_status: 'completed', result: 'ok' });
  xExecutor.statuses.set(`goal:${goal.id}:step:s2`, { found: true, queue_status: 'terminal', terminal_status: 'interrupted' });

  const waiting = await runner.run_goal(goal.id);
  assert.equal(waiting.steps[1].executionGeneration, 2);

  // Restart GoalStorage & GoalRunner
  const storage2 = new GoalStorage({ storagePath });
  const xExecutor2 = makeMockXExecutor();
  const runner2 = new GoalRunner({ storage: storage2, xExecutor: xExecutor2 });

  const reloaded = storage2.getGoal(goal.id);
  assert.equal(reloaded.steps[1].executionGeneration, 2, 'Generation remains 2 after restart');

  // Set receipts for generation 2 of Step 2 and Step 3
  const gen2Req = `goal:${goal.id}:step:s2:exec:2`;
  xExecutor2.statuses.set(gen2Req, { found: true, queue_status: 'terminal', terminal_status: 'completed', result: 'recovered' });
  xExecutor2.statuses.set(`goal:${goal.id}:step:s3`, { found: true, queue_status: 'terminal', terminal_status: 'completed', result: 'ok3' });

  const completed = await runner2.resume_goal(goal.id);

  assert.equal(completed.status, 'completed');
  assert.equal(xExecutor2.dispatchLog.length, 2);
  assert.equal(xExecutor2.dispatchLog[0].requestId, gen2Req);
  assert.equal(xExecutor2.dispatchLog[1].requestId, `goal:${goal.id}:step:s3`);
});

// ── 11. MANUAL STEP ────────────────────────────────────────────────────────
await test('11. Manual Step 2 stops autopilot; Step 3 pending until explicit signoff', async () => {
  const storagePath = freshStoragePath();
  const xExecutor = makeMockXExecutor();
  const storage = new GoalStorage({ storagePath });
  const runner = new GoalRunner({ storage, xExecutor });

  const goal = await runner.create_goal({
    title: 'Manual Step Goal', objective: 'Stop at manual step', workspace: testWorkspace,
    steps: [
      { id: 's1', title: 'Step 1', description: '', route: 'x', xTask: validXTask('T1') },
      { id: 's2', title: 'Step 2 (Manual)', description: '', route: 'manual' },
      { id: 's3', title: 'Step 3', description: '', route: 'x', xTask: validXTask('T3') },
    ],
  });

  xExecutor.statuses.set(`goal:${goal.id}:step:s1`, { found: true, queue_status: 'terminal', terminal_status: 'completed', result: 'ok' });
  xExecutor.statuses.set(`goal:${goal.id}:step:s3`, { found: true, queue_status: 'terminal', terminal_status: 'completed', result: 'ok3' });

  const waiting = await runner.run_goal(goal.id);

  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.steps[1].status, 'waiting');
  assert.equal(waiting.steps[2].status, 'pending');

  const s3DispatchesBefore = xExecutor.dispatchLog.filter((d) => d.requestId === `goal:${goal.id}:step:s3`).length;
  assert.equal(s3DispatchesBefore, 0, 'Step 3 must not dispatch while manual step is waiting');

  // resume_goal without signoff must reject
  await assert.rejects(
    () => runner.resume_goal(goal.id),
    /Explicit manual sign-off is required/i
  );

  // Perform explicit signoff
  await runner.signoff_step(goal.id, 's2', { result: 'User verified manually' });

  const completed = await runner.resume_goal(goal.id);

  assert.equal(completed.status, 'completed');
  assert.equal(completed.steps[1].status, 'completed');
  assert.equal(completed.steps[2].status, 'completed');

  const s3DispatchesAfter = xExecutor.dispatchLog.filter((d) => d.requestId === `goal:${goal.id}:step:s3`).length;
  assert.equal(s3DispatchesAfter, 1);
});

// ── 12. COMPLETED STEP RESTART ─────────────────────────────────────────────
await test('12. Restart with Steps 1 & 2 completed skips them and dispatches Step 3 once', async () => {
  const storagePath = freshStoragePath();
  const storage = new GoalStorage({ storagePath });

  // Pre-seed storage with Steps 1 & 2 completed
  const goalId = 'completed-restart-goal';
  const goal = {
    id: goalId, schemaVersion: 1, title: 'Pre-completed Goal', objective: 'Test restart', workspace: testWorkspace,
    status: 'ready', currentStepId: 's3', steps: [
      { id: 's1', title: 'Step 1', description: '', route: 'x', status: 'completed', required: true, xTask: validXTask('T1') },
      { id: 's2', title: 'Step 2', description: '', route: 'x', status: 'completed', required: true, xTask: validXTask('T2') },
      { id: 's3', title: 'Step 3', description: '', route: 'x', status: 'pending', required: true, xTask: validXTask('T3') },
    ],
    checkpoints: [{ id: 'cp1', goalId, stepId: 's2', summary: 'Step 2 completed', completedSteps: 2, nextStep: 's3', route: 'x', createdAt: new Date().toISOString() }],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  storage.saveGoal(goal);

  const xExecutor = makeMockXExecutor();
  const runner = new GoalRunner({ storage, xExecutor });

  xExecutor.statuses.set(`goal:${goalId}:step:s3`, { found: true, queue_status: 'terminal', terminal_status: 'completed', result: 'ok3' });

  const finished = await runner.resume_goal(goalId);

  assert.equal(finished.status, 'completed');
  assert.equal(xExecutor.dispatchLog.length, 1);
  assert.equal(xExecutor.dispatchLog[0].requestId, `goal:${goalId}:step:s3`);
});

// ── 13. LOCK RELEASE ───────────────────────────────────────────────────────
await test('13. activeGoalId is released across completed, waiting, failed, interrupted, manual, and thrown paths', async () => {
  const storagePath = freshStoragePath();
  const xExecutor = makeMockXExecutor();
  const storage = new GoalStorage({ storagePath });
  const runner = new GoalRunner({ storage, xExecutor });

  // 13a. Completed path releases lock
  const gComp = await runner.create_goal({
    title: 'Comp Goal', objective: 'test', workspace: testWorkspace,
    steps: [{ id: 's1', title: 'Step 1', description: '', route: 'x', xTask: validXTask('T1') }],
  });
  xExecutor.statuses.set(`goal:${gComp.id}:step:s1`, { found: true, queue_status: 'terminal', terminal_status: 'completed', result: 'ok' });
  await runner.run_goal(gComp.id);
  assert.equal(runner.activeGoalId, null, 'activeGoalId must be null after goal completion');

  // 13b. Waiting (needs_review) releases lock
  const gWait = await runner.create_goal({
    title: 'Wait Goal', objective: 'test', workspace: testWorkspace,
    steps: [{ id: 's1', title: 'Step 1', description: '', route: 'x', xTask: validXTask('T1') }],
  });
  xExecutor.statuses.set(`goal:${gWait.id}:step:s1`, { found: true, queue_status: 'terminal', terminal_status: 'needs_review', result: { version: 'x-result-v1', result_id: 'r1', task_id: 'T1' } });
  await runner.run_goal(gWait.id);
  assert.equal(runner.activeGoalId, null, 'activeGoalId must be null after waiting for review');

  // 13c. Failed required step releases lock
  const gFail = await runner.create_goal({
    title: 'Fail Goal', objective: 'test', workspace: testWorkspace,
    steps: [{ id: 's1', title: 'Step 1', description: '', route: 'x', xTask: validXTask('T1'), required: true }],
  });
  xExecutor.statuses.set(`goal:${gFail.id}:step:s1`, { found: true, queue_status: 'terminal', terminal_status: 'failed', error: 'failed' });
  await runner.run_goal(gFail.id);
  assert.equal(runner.activeGoalId, null, 'activeGoalId must be null after goal failure');

  // 13d. Interrupted releases lock
  const gInt = await runner.create_goal({
    title: 'Int Goal', objective: 'test', workspace: testWorkspace,
    steps: [{ id: 's1', title: 'Step 1', description: '', route: 'x', xTask: validXTask('T1') }],
  });
  xExecutor.statuses.set(`goal:${gInt.id}:step:s1`, { found: true, queue_status: 'terminal', terminal_status: 'interrupted' });
  await runner.run_goal(gInt.id);
  assert.equal(runner.activeGoalId, null, 'activeGoalId must be null after interrupted allocation');

  // 13e. Manual waiting releases lock
  const gMan = await runner.create_goal({
    title: 'Man Goal', objective: 'test', workspace: testWorkspace,
    steps: [{ id: 's1', title: 'Step 1', description: '', route: 'manual' }],
  });
  await runner.run_goal(gMan.id);
  assert.equal(runner.activeGoalId, null, 'activeGoalId must be null after manual step waiting');

  // 13f. Thrown step error releases lock
  const gErr = await runner.create_goal({
    title: 'Err Goal', objective: 'test', workspace: testWorkspace,
    steps: [{ id: 's1', title: 'Step 1', description: '', route: 'x', xTask: validXTask('TERR') }],
  });
  const throwingExecutor = {
    dispatchXTask: async () => { throw new Error('Uncaught dispatch error'); },
    getXTaskStatus: async () => ({ found: false }),
  };
  const throwingRunner = new GoalRunner({ storage, xExecutor: throwingExecutor });
  await throwingRunner.run_goal(gErr.id);
  assert.equal(throwingRunner.activeGoalId, null, 'activeGoalId must be null after thrown step error');
});

console.log(`\nResults: ${passed} passed, ${failed} failed out of ${passed + failed} tests\n`);
if (failed > 0) process.exit(1);
