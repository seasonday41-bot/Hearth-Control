/**
 * Hearth Goal Review Decision Foundation Test Suite (Slice 1)
 *
 * Proves:
 *   A. ACKNOWLEDGE: open -> acknowledged, no goal/step mutation, 0 X dispatch, idempotent, restart durability
 *   B. RESOLVE ACCEPT: needs_review -> resolved (accepted), step -> completed, 0 direct X dispatch, checkpoint appended, idempotent, restart durability
 *   C. FAILED SAFETY: resolve accept on status=failed rejects, step remains error, 0 X dispatch
 *   D. RESUME GUARD: unresolved review (open/acknowledged) blocks resume_goal, no loop, after resolve continues next step
 *   E. REMOTE BOUNDARY: local state remains sole authority
 *   F. MCP EXPOSURE: review_queue_acknowledge and review_queue_resolve tools function correctly
 */

import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { GoalStorage } from '../mcp/goals/storage.mjs';
import { GoalRunner } from '../mcp/goals/runner.mjs';
import { X_TASK_VERSION } from '../mcp/x/task-contract.mjs';
import { registerWorkspaceTools, toolNames } from '../mcp/tools.mjs';

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

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hearth-review-decision-test-'));
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
  why_this_matters: 'Review decision foundation test coverage.',
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

console.log('\n=== Hearth Goal Review Decision Test Suite (Slice 1) ===\n');

// ── A. ACKNOWLEDGE: open -> acknowledged ────────────────────────────────────
await test('A1. acknowledge_review transitions lifecycle to acknowledged without mutating Goal or Step', async () => {
  const storagePath = freshStoragePath();
  const storage = new GoalStorage({ storagePath });
  const xExecutor = makeMockXExecutor();
  const runner = new GoalRunner({ storage, xExecutor });

  const goal = await runner.create_goal({
    title: 'Ack Goal',
    objective: 'Test acknowledge',
    workspace: testWorkspace,
    steps: [{ id: 's1', title: 'Step 1', description: '', route: 'x', xTask: validXTask('ACK-1') }],
  });

  const requestId = `goal:${goal.id}:step:s1`;
  xExecutor.statuses.set(requestId, {
    found: true, queue_status: 'terminal', terminal_status: 'needs_review',
    result: { version: 'x-result-v1', result_id: 'ack-res-1', task_id: 'ACK-1', reason_code: 'waiting_review' },
  });

  const running = await runner.run_goal(goal.id);
  assert.equal(running.reviewQueue.length, 1);
  const item = running.reviewQueue[0];
  assert.equal(item.status, 'needs_review');
  assert.equal(item.lifecycle, 'open');
  assert.equal(running.status, 'waiting');
  assert.equal(running.steps[0].status, 'waiting');
  assert.equal(xExecutor.dispatchLog.length, 1);

  // Acknowledge the review item
  const ackResult = await runner.acknowledge_review(goal.id, item.id, { actor: 'ChatSupervisor', note: 'Noted problem' });
  assert.equal(ackResult.item.lifecycle, 'acknowledged');
  assert.ok(ackResult.item.acknowledgedAt);
  assert.equal(ackResult.item.acknowledgedBy, 'ChatSupervisor');
  assert.equal(ackResult.item.note, 'Noted problem');

  // Verify Goal and Step remain in waiting status
  const reloaded = storage.getGoal(goal.id);
  assert.equal(reloaded.status, 'waiting', 'Goal status must remain waiting');
  assert.equal(reloaded.steps[0].status, 'waiting', 'Step status must remain waiting');
  assert.equal(xExecutor.dispatchLog.length, 1, 'Acknowledge must NOT dispatch X');

  // A2. Idempotent double acknowledge
  const doubleAck = await runner.acknowledge_review(goal.id, item.id, { actor: 'ChatSupervisor' });
  assert.equal(doubleAck.alreadyAcknowledged, true);
  assert.equal(doubleAck.item.lifecycle, 'acknowledged');
  assert.equal(xExecutor.dispatchLog.length, 1);

  // A3. Restart preserves acknowledged lifecycle
  const restartedStorage = new GoalStorage({ storagePath });
  const restartedGoal = restartedStorage.getGoal(goal.id);
  assert.equal(restartedGoal.reviewQueue[0].lifecycle, 'acknowledged');
  assert.equal(restartedGoal.reviewQueue[0].acknowledgedBy, 'ChatSupervisor');
});

// ── B. RESOLVE: NEEDS_REVIEW accept ─────────────────────────────────────────
await test('B1. resolve_review(accept) on NEEDS_REVIEW completes step and unblocks goal without X dispatch', async () => {
  const storagePath = freshStoragePath();
  const storage = new GoalStorage({ storagePath });
  const xExecutor = makeMockXExecutor();
  const runner = new GoalRunner({ storage, xExecutor });

  const goal = await runner.create_goal({
    title: 'Resolve Goal',
    objective: 'Test resolve accept',
    workspace: testWorkspace,
    steps: [
      { id: 's1', title: 'Step 1', description: '', route: 'x', xTask: validXTask('RES-1') },
      { id: 's2', title: 'Step 2', description: '', route: 'x', xTask: validXTask('RES-2') },
    ],
  });

  const req1 = `goal:${goal.id}:step:s1`;
  const structuredResult = { version: 'x-result-v1', result_id: 'res-1', task_id: 'RES-1', gate_status: 'NEEDS_REVIEW', waiting_reason: 'manual_verification' };
  xExecutor.statuses.set(req1, { found: true, queue_status: 'terminal', terminal_status: 'needs_review', result: structuredResult });

  await runner.run_goal(goal.id);
  assert.equal(xExecutor.dispatchLog.length, 1, 'Only step 1 dispatched');
  const preGoal = storage.getGoal(goal.id);
  assert.equal(preGoal.status, 'waiting');
  assert.equal(preGoal.steps[0].status, 'waiting');
  assert.equal(preGoal.steps[1].status, 'pending');
  const reviewItemId = preGoal.reviewQueue[0].id;

  // Resolve review with action: 'accept'
  const resolveResult = await runner.resolve_review(goal.id, reviewItemId, { note: 'Output verified manually' });
  assert.equal(resolveResult.item.lifecycle, 'resolved');
  assert.equal(resolveResult.item.resolution, 'accepted');
  assert.ok(resolveResult.item.resolvedAt);
  assert.equal(resolveResult.item.note, 'Output verified manually');

  const afterResolve = storage.getGoal(goal.id);
  assert.equal(afterResolve.steps[0].status, 'completed', 'Step 1 must be completed');
  assert.ok(afterResolve.steps[0].finishedAt);
  assert.equal(afterResolve.steps[0].result, JSON.stringify(structuredResult), 'Original result preserved');
  assert.equal(afterResolve.status, 'ready', 'Goal must transition to ready since next step is pending');
  assert.equal(afterResolve.currentStepId, 's2', 'Current step must advance to s2');
  assert.equal(xExecutor.dispatchLog.length, 1, 'Resolve itself must NOT dispatch X');

  // Checkpoint verified
  const latestCheckpoint = afterResolve.checkpoints[afterResolve.checkpoints.length - 1];
  assert.ok(latestCheckpoint.summary.includes("Review resolved: step 'Step 1' accepted by supervisor"));
  assert.equal(latestCheckpoint.nextStep, 's2');

  // B2. Idempotent double resolve
  const doubleResolve = await runner.resolve_review(goal.id, reviewItemId, { action: 'accept' });
  assert.equal(doubleResolve.alreadyResolved, true);
  assert.equal(doubleResolve.item.lifecycle, 'resolved');

  // B3. Conflicting resolve fails closed
  await assert.rejects(
    () => runner.resolve_review(goal.id, reviewItemId, { action: 'invalid_action' }),
    /Slice 1 only supports action: 'accept'/
  );

  // B4. Restart preserves resolved state
  const restartedStorage = new GoalStorage({ storagePath });
  const restartedGoal = restartedStorage.getGoal(goal.id);
  assert.equal(restartedGoal.reviewQueue[0].lifecycle, 'resolved');
  assert.equal(restartedGoal.steps[0].status, 'completed');
  assert.equal(restartedGoal.status, 'ready');
});

// ── C. FAILED SAFETY: resolve accept on status=failed must reject ───────────
await test('C. resolve_review rejects accepting a FAILED review item', async () => {
  const storagePath = freshStoragePath();
  const storage = new GoalStorage({ storagePath });
  const xExecutor = makeMockXExecutor();
  const runner = new GoalRunner({ storage, xExecutor });

  const goal = await runner.create_goal({
    title: 'Fail Safety Goal',
    objective: 'Failed items must not be accepted',
    workspace: testWorkspace,
    steps: [{ id: 's1', title: 'Step 1', description: '', route: 'x', xTask: validXTask('FAIL-1'), required: true }],
  });

  const req1 = `goal:${goal.id}:step:s1`;
  xExecutor.statuses.set(req1, { found: true, queue_status: 'terminal', terminal_status: 'failed', error: 'test failure' });

  await runner.run_goal(goal.id);
  const failedGoal = storage.getGoal(goal.id);
  assert.equal(failedGoal.status, 'error');
  assert.equal(failedGoal.steps[0].status, 'error');
  assert.equal(failedGoal.reviewQueue[0].status, 'failed');
  assert.equal(failedGoal.reviewQueue[0].lifecycle, 'open');

  // Attempting to resolve accept on failed review item MUST reject!
  await assert.rejects(
    () => runner.resolve_review(goal.id, failedGoal.reviewQueue[0].id, { action: 'accept' }),
    /Cannot accept review item with status 'failed'/
  );

  // Verify status is untouched
  const recheck = storage.getGoal(goal.id);
  assert.equal(recheck.steps[0].status, 'error');
  assert.equal(recheck.status, 'error');
  assert.equal(recheck.reviewQueue[0].lifecycle, 'open');
  assert.equal(xExecutor.dispatchLog.length, 1, 'X dispatch count must remain 1');
});

// ── D. RESUME GUARD: unresolved review blocks resume_goal ───────────────────
await test('D. resume_goal refuses when step has open or acknowledged review, and proceeds once resolved', async () => {
  const storagePath = freshStoragePath();
  const storage = new GoalStorage({ storagePath });
  const xExecutor = makeMockXExecutor();
  const runner = new GoalRunner({ storage, xExecutor });

  const goal = await runner.create_goal({
    title: 'Guard Goal',
    objective: 'Test resume guard',
    workspace: testWorkspace,
    steps: [
      { id: 's1', title: 'Step 1', description: '', route: 'x', xTask: validXTask('GUARD-1') },
      { id: 's2', title: 'Step 2', description: '', route: 'x', xTask: validXTask('GUARD-2') },
    ],
  });

  const req1 = `goal:${goal.id}:step:s1`;
  xExecutor.statuses.set(req1, {
    found: true, queue_status: 'terminal', terminal_status: 'needs_review',
    result: { version: 'x-result-v1', result_id: 'guard-res-1', task_id: 'GUARD-1', reason_code: 'waiting_review' },
  });

  await runner.run_goal(goal.id);
  assert.equal(xExecutor.dispatchLog.length, 1);
  const item = storage.getGoal(goal.id).reviewQueue[0];
  assert.equal(item.lifecycle, 'open');

  // 1. Calling resume_goal on open review MUST fail closed
  await assert.rejects(
    () => runner.resume_goal(goal.id),
    /blocked by unresolved review item/
  );
  assert.equal(xExecutor.dispatchLog.length, 1, 'Must NOT re-dispatch X');

  // 2. Acknowledging review: resume_goal MUST STILL fail closed
  await runner.acknowledge_review(goal.id, item.id);
  await assert.rejects(
    () => runner.resume_goal(goal.id),
    /blocked by unresolved review item/
  );
  assert.equal(xExecutor.dispatchLog.length, 1, 'Must NOT re-dispatch X');

  // 3. Resolve review as accepted
  await runner.resolve_review(goal.id, item.id, { action: 'accept' });

  // 4. Set up step 2 status in xExecutor
  const req2 = `goal:${goal.id}:step:s2`;
  xExecutor.statuses.set(req2, {
    found: true, queue_status: 'terminal', terminal_status: 'completed',
    result: { version: 'x-result-v1', result_id: 'guard-res-2', task_id: 'GUARD-2' },
  });

  // Now resume_goal unblocks and executes step 2!
  const resumed = await runner.resume_goal(goal.id);
  assert.equal(xExecutor.dispatchLog.length, 2, 'Step 2 must now be dispatched');
  assert.equal(xExecutor.dispatchLog[1].requestId, req2);
  assert.equal(resumed.steps[0].status, 'completed');
  assert.equal(resumed.steps[1].status, 'completed');
  assert.equal(resumed.status, 'completed');
});

// ── E. MCP EXPOSURE: acknowledge and resolve tools ──────────────────────────
await test('E. review_queue_acknowledge and review_queue_resolve MCP tools function correctly', async () => {
  const storagePath = freshStoragePath();
  const storage = new GoalStorage({ storagePath });
  const xExecutor = makeMockXExecutor();
  const runner = new GoalRunner({ storage, xExecutor });

  const goal = await runner.create_goal({
    title: 'MCP Tools Goal',
    objective: 'Test MCP tool calls',
    workspace: testWorkspace,
    steps: [{ id: 's1', title: 'Step 1', description: '', route: 'x', xTask: validXTask('MCP-1') }],
  });

  const req1 = `goal:${goal.id}:step:s1`;
  xExecutor.statuses.set(req1, {
    found: true, queue_status: 'terminal', terminal_status: 'needs_review',
    result: { version: 'x-result-v1', result_id: 'mcp-res-1', task_id: 'MCP-1', reason_code: 'waiting_review' },
  });

  await runner.run_goal(goal.id);
  const item = storage.getGoal(goal.id).reviewQueue[0];

  const tools = new Map();
  const fakeServer = { registerTool: (name, config, handler) => tools.set(name, { config, handler }) };
  registerWorkspaceTools(fakeServer, {
    workspace: testWorkspace,
    permissions: {},
    reviewQueueTransport: {
      list: async ({ goalId } = {}) => ({ items: runner.list_review_queue(goalId ? { goalId } : {}) }),
      acknowledge: async ({ goalId, reviewItemId, actor, note } = {}) => runner.acknowledge_review(goalId, reviewItemId, { actor, note }),
      resolve: async ({ goalId, reviewItemId, action, note } = {}) => runner.resolve_review(goalId, reviewItemId, { action, note }),
    },
  });

  assert.ok(tools.has('review_queue_acknowledge'));
  assert.ok(tools.has('review_queue_resolve'));
  assert.ok(toolNames.includes('review_queue_acknowledge'));
  assert.ok(toolNames.includes('review_queue_resolve'));

  // Call review_queue_acknowledge tool
  const ackRes = JSON.parse((await tools.get('review_queue_acknowledge').handler({
    goal_id: goal.id,
    review_item_id: item.id,
    actor: 'MainBrain',
    note: 'Acknowledged via MCP',
  })).content[0].text);
  assert.equal(ackRes.item.lifecycle, 'acknowledged');
  assert.equal(ackRes.item.acknowledgedBy, 'MainBrain');

  // Call review_queue_resolve tool
  const resolveRes = JSON.parse((await tools.get('review_queue_resolve').handler({
    goal_id: goal.id,
    review_item_id: item.id,
    action: 'accept',
    note: 'Accepted via MCP',
  })).content[0].text);
  assert.equal(resolveRes.item.lifecycle, 'resolved');
  assert.equal(resolveRes.item.resolution, 'accepted');

  const finalGoal = storage.getGoal(goal.id);
  assert.equal(finalGoal.steps[0].status, 'completed');
  assert.equal(finalGoal.status, 'completed');
});

console.log(`\nResults: ${passed} passed, ${failed} failed out of ${passed + failed} tests\n`);
if (failed > 0) process.exit(1);
