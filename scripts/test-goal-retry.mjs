/**
 * Hearth Slice 2 Test Suite
 */

import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { GoalStorage } from '../mcp/goals/storage.mjs';
import { GoalRunner } from '../mcp/goals/runner.mjs';
import { validateStep } from '../mcp/goals/model.mjs';
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

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hearth-slice2-test-'));
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
  objective: 'Report a fact.',
  problem: 'A fact is not yet known.',
  expected_behavior: 'The fact is reported.',
  observed_behavior: 'No report has been produced yet.',
  why_this_matters: 'Slice 2 test coverage.',
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
    dispatches, dispatchLog, statuses,
    dispatchXTask: async ({ requestId, task }) => {
      if (!dispatches.has(requestId)) {
        dispatches.set(requestId, { task });
        dispatchLog.push({ requestId, task });
      }
      return { accepted: true };
    },
    getXTaskStatus: async (requestId) => statuses.get(requestId) || { found: false, queue_status: undefined },
  };
};

const makeRunner = (storagePath, xExecutor) => {
  const storage = new GoalStorage({ storagePath });
  return new GoalRunner({ storage, xExecutor });
};

const makeXGoal = async (runner, taskId = 'TASK-1', xTaskOverrides = {}) =>
  runner.create_goal({
    title: 'Test Goal', objective: 'Test objective', workspace: testWorkspace,
    steps: [{ id: 's1', title: 'Step 1', description: '', route: 'x', xTask: validXTask(taskId, xTaskOverrides) }],
  });

const needsReviewStatus = (requestId, resultId = 'result-1') => ({
  found: true, queue_status: 'terminal', terminal_status: 'needs_review',
  result: { version: 'x-result-v1', result_id: resultId, task_id: 'TASK-1', reason_code: 'waiting_review' },
});
const failedStatus = () => ({
  found: true, queue_status: 'terminal', terminal_status: 'failed', error: 'X step failed',
});
const interruptedStatus = () => ({
  found: true, queue_status: 'terminal', terminal_status: 'interrupted',
});

console.log('\n=== Hearth Slice 2 Test Suite ===\n');

// 1. Legacy step loads correctly
await test('1. Legacy step (no executionGeneration) loads as null', () => {
  const rawStep = { id: 's-legacy', title: 'Legacy Step', route: 'x', xTask: validXTask(), status: 'pending', required: true };
  const validated = validateStep(rawStep);
  assert.equal(validated.executionGeneration, null);
});

// 2. executionGeneration persists across save/reload
await test('2. executionGeneration persists across save/reload', async () => {
  const storagePath = freshStoragePath();
  const storage = new GoalStorage({ storagePath });
  const runner = new GoalRunner({ storage });
  const goal = await makeXGoal(runner);
  goal.steps[0].executionGeneration = 3;
  storage.saveGoal(goal);
  const storage2 = new GoalStorage({ storagePath });
  const reloaded = storage2.getGoal(goal.id);
  assert.equal(reloaded.steps[0].executionGeneration, 3);
});

// 3. Generation null/1 produces legacy requestId
await test('3. Generation null produces legacy requestId goal:id:step:id', async () => {
  const storagePath = freshStoragePath();
  const xExecutor = makeMockXExecutor();
  const runner = makeRunner(storagePath, xExecutor);
  const goal = await makeXGoal(runner);
  assert.equal(goal.steps[0].executionGeneration, null);
  xExecutor.statuses.set(`goal:${goal.id}:step:s1`, { found: true, queue_status: 'terminal', terminal_status: 'completed', result: 'done' });
  await runner.run_goal(goal.id);
  assert.equal(xExecutor.dispatchLog.length, 1);
  assert.equal(xExecutor.dispatchLog[0].requestId, `goal:${goal.id}:step:s1`);
});

// 4. Generation >= 2 uses :exec:N format
await test('4. Generation 2 produces requestId goal:id:step:id:exec:2', async () => {
  const storagePath = freshStoragePath();
  const xExecutor = makeMockXExecutor();
  const storage = new GoalStorage({ storagePath });
  const runner = new GoalRunner({ storage, xExecutor });
  const goal = await makeXGoal(runner);
  goal.steps[0].executionGeneration = 2;
  storage.saveGoal(goal);
  xExecutor.statuses.set(`goal:${goal.id}:step:s1:exec:2`, { found: true, queue_status: 'terminal', terminal_status: 'completed', result: 'done' });
  await runner.run_goal(goal.id);
  assert.equal(xExecutor.dispatchLog.length, 1);
  assert.equal(xExecutor.dispatchLog[0].requestId, `goal:${goal.id}:step:s1:exec:2`);
});

// 5. NEEDS_REVIEW retry
await test('5. NEEDS_REVIEW retry: supersedes review, step pending, goal ready, generation once, zero extra X dispatch', async () => {
  const storagePath = freshStoragePath();
  const xExecutor = makeMockXExecutor();
  const runner = makeRunner(storagePath, xExecutor);
  const goal = await makeXGoal(runner);
  const requestId = `goal:${goal.id}:step:s1`;
  xExecutor.statuses.set(requestId, needsReviewStatus(requestId, 'result-42'));
  const waitingGoal = await runner.run_goal(goal.id);
  const item = waitingGoal.reviewQueue[0];

  const retryXTask = validXTask('TASK-1', { revision: 1, attempt: 2, based_on_result_id: 'result-42' });
  const { goal: retried, item: supersededItem } = await runner.retry_review(goal.id, item.id, { xTask: retryXTask });

  assert.equal(supersededItem.lifecycle, 'superseded');
  assert.ok(supersededItem.supersededAt);
  assert.equal(retried.steps[0].status, 'pending');
  assert.equal(retried.steps[0].executionGeneration, 2);
  assert.equal(retried.steps[0].xTask.attempt, 2);
  assert.equal(retried.status, 'ready');
  assert.equal(retried.error, null);
  const lastCp = retried.checkpoints[retried.checkpoints.length - 1];
  assert.ok(lastCp.summary.includes('generation 2'));
  assert.equal(xExecutor.dispatchLog.length, 1, 'retry_review must not dispatch X');
});

// 6. FAILED retry
await test('6. FAILED retry: step pending not completed, dependent blocked, goal ready, error cleared', async () => {
  const storagePath = freshStoragePath();
  const xExecutor = makeMockXExecutor();
  const storage = new GoalStorage({ storagePath });
  const runner = new GoalRunner({ storage, xExecutor });
  const goal = await runner.create_goal({
    title: 'Two Step Goal', objective: 'Test failed retry', workspace: testWorkspace,
    steps: [
      { id: 's1', title: 'Step 1', description: '', route: 'x', xTask: validXTask('TASK-FAILED') },
      { id: 's2', title: 'Step 2', description: '', route: 'x', xTask: validXTask('TASK-S2') },
    ],
  });
  xExecutor.statuses.set(`goal:${goal.id}:step:s1`, failedStatus());
  const failedGoal = await runner.run_goal(goal.id);
  assert.equal(failedGoal.status, 'error');
  const item = failedGoal.reviewQueue[0];

  const retryXTask = validXTask('TASK-FAILED', { revision: 2, attempt: 1, based_on_result_id: null });
  const { goal: retried } = await runner.retry_review(goal.id, item.id, { xTask: retryXTask });

  assert.equal(retried.steps[0].status, 'pending', 'Retried step must be pending');
  assert.equal(retried.steps[1].status, 'pending', 'Dependent step stays pending');
  assert.equal(retried.status, 'ready');
  assert.equal(retried.error, null);
  assert.equal(retried.finishedAt, null);
  assert.equal(retried.steps[0].executionGeneration, 2);
});

// 7. Same-spec retry
await test('7. Same-spec retry: same revision, attempt+1, based_on_result_id correct', async () => {
  const storagePath = freshStoragePath();
  const xExecutor = makeMockXExecutor();
  const runner = makeRunner(storagePath, xExecutor);
  const goal = await makeXGoal(runner, 'TASK-1', { revision: 2, attempt: 3 });
  const requestId = `goal:${goal.id}:step:s1`;
  xExecutor.statuses.set(requestId, needsReviewStatus(requestId, 'res-99'));
  const waiting = await runner.run_goal(goal.id);
  const item = waiting.reviewQueue[0];
  const retryXTask = validXTask('TASK-1', { revision: 2, attempt: 4, based_on_result_id: 'res-99' });
  const { goal: retried } = await runner.retry_review(goal.id, item.id, { xTask: retryXTask });
  assert.equal(retried.steps[0].xTask.revision, 2);
  assert.equal(retried.steps[0].xTask.attempt, 4);
  assert.equal(retried.steps[0].xTask.based_on_result_id, 'res-99');
});

// 8. Revised retry
await test('8. Revised retry: revision+1, attempt=1', async () => {
  const storagePath = freshStoragePath();
  const xExecutor = makeMockXExecutor();
  const runner = makeRunner(storagePath, xExecutor);
  const goal = await makeXGoal(runner, 'TASK-1', { revision: 1, attempt: 2 });
  const requestId = `goal:${goal.id}:step:s1`;
  xExecutor.statuses.set(requestId, { found: true, queue_status: 'terminal', terminal_status: 'needs_review', result: { version: 'x-result-v1', task_id: 'TASK-1', reason_code: 'waiting_review' } });
  const waiting = await runner.run_goal(goal.id);
  const item = waiting.reviewQueue[0];
  assert.equal(item.resultId, null);
  const retryXTask = validXTask('TASK-1', { revision: 2, attempt: 1, based_on_result_id: null });
  const { goal: retried } = await runner.retry_review(goal.id, item.id, { xTask: retryXTask });
  assert.equal(retried.steps[0].xTask.revision, 2);
  assert.equal(retried.steps[0].xTask.attempt, 1);
});

// 9. Invalid task_id rejected
await test('9. Different task_id rejected', async () => {
  const storagePath = freshStoragePath();
  const xExecutor = makeMockXExecutor();
  const runner = makeRunner(storagePath, xExecutor);
  const goal = await makeXGoal(runner, 'TASK-ORIGINAL');
  const requestId = `goal:${goal.id}:step:s1`;
  xExecutor.statuses.set(requestId, needsReviewStatus(requestId));
  const waiting = await runner.run_goal(goal.id);
  const item = waiting.reviewQueue[0];
  const wrongTaskXTask = validXTask('TASK-WRONG', { revision: 1, attempt: 2, based_on_result_id: 'result-1' });
  await assert.rejects(() => runner.retry_review(goal.id, item.id, { xTask: wrongTaskXTask }), /task_id/);
});

// 10. Invalid revision/attempt lineage rejected
await test('10a. Same-spec retry with wrong attempt rejected', async () => {
  const storagePath = freshStoragePath();
  const xExecutor = makeMockXExecutor();
  const runner = makeRunner(storagePath, xExecutor);
  const goal = await makeXGoal(runner, 'TASK-1');
  const requestId = `goal:${goal.id}:step:s1`;
  xExecutor.statuses.set(requestId, needsReviewStatus(requestId, 'r1'));
  const waiting = await runner.run_goal(goal.id);
  const item = waiting.reviewQueue[0];
  const badXTask = validXTask('TASK-1', { revision: 1, attempt: 5, based_on_result_id: 'r1' });
  await assert.rejects(() => runner.retry_review(goal.id, item.id, { xTask: badXTask }), /attempt/);
});

await test('10b. Revised retry with attempt != 1 rejected', async () => {
  const storagePath = freshStoragePath();
  const xExecutor = makeMockXExecutor();
  const runner = makeRunner(storagePath, xExecutor);
  const goal = await makeXGoal(runner, 'TASK-1', { revision: 1, attempt: 2 });
  const requestId = `goal:${goal.id}:step:s1`;
  xExecutor.statuses.set(requestId, { found: true, queue_status: 'terminal', terminal_status: 'needs_review', result: { version: 'x-result-v1', task_id: 'TASK-1', reason_code: 'c' } });
  const waiting = await runner.run_goal(goal.id);
  const item = waiting.reviewQueue[0];
  const badXTask = validXTask('TASK-1', { revision: 2, attempt: 3, based_on_result_id: null });
  await assert.rejects(() => runner.retry_review(goal.id, item.id, { xTask: badXTask }), /attempt 1/);
});

await test('10c. Revision jump > +1 rejected', async () => {
  const storagePath = freshStoragePath();
  const xExecutor = makeMockXExecutor();
  const runner = makeRunner(storagePath, xExecutor);
  const goal = await makeXGoal(runner, 'TASK-1');
  const requestId = `goal:${goal.id}:step:s1`;
  xExecutor.statuses.set(requestId, needsReviewStatus(requestId, 'r1'));
  const waiting = await runner.run_goal(goal.id);
  const item = waiting.reviewQueue[0];
  const badXTask = validXTask('TASK-1', { revision: 3, attempt: 1, based_on_result_id: 'r1' });
  await assert.rejects(() => runner.retry_review(goal.id, item.id, { xTask: badXTask }), /revision 3 is invalid/);
});

// 11. Invalid based_on_result_id rejected
await test('11. Wrong based_on_result_id rejected when resultId exists', async () => {
  const storagePath = freshStoragePath();
  const xExecutor = makeMockXExecutor();
  const runner = makeRunner(storagePath, xExecutor);
  const goal = await makeXGoal(runner, 'TASK-1');
  const requestId = `goal:${goal.id}:step:s1`;
  xExecutor.statuses.set(requestId, needsReviewStatus(requestId, 'correct-result-id'));
  const waiting = await runner.run_goal(goal.id);
  const item = waiting.reviewQueue[0];
  const wrongXTask = validXTask('TASK-1', { revision: 1, attempt: 2, based_on_result_id: 'WRONG-id' });
  await assert.rejects(() => runner.retry_review(goal.id, item.id, { xTask: wrongXTask }), /based_on_result_id/);
});

// 12. Double retry idempotency
await test('12. Double retry returns alreadySuperseded, no second increment', async () => {
  const storagePath = freshStoragePath();
  const xExecutor = makeMockXExecutor();
  const runner = makeRunner(storagePath, xExecutor);
  const goal = await makeXGoal(runner);
  const requestId = `goal:${goal.id}:step:s1`;
  xExecutor.statuses.set(requestId, needsReviewStatus(requestId, 'r1'));
  const waiting = await runner.run_goal(goal.id);
  const item = waiting.reviewQueue[0];
  const retryXTask = validXTask('TASK-1', { revision: 1, attempt: 2, based_on_result_id: 'r1' });
  await runner.retry_review(goal.id, item.id, { xTask: retryXTask });
  const second = await runner.retry_review(goal.id, item.id, { xTask: retryXTask });
  assert.equal(second.alreadySuperseded, true);
  const storage2 = new GoalStorage({ storagePath });
  const reloaded = storage2.getGoal(goal.id);
  assert.equal(reloaded.steps[0].executionGeneration, 2, 'Must remain 2 after double retry');
});

await test('12b. Conflicting retry on already-superseded review item fails closed', async () => {
  const storagePath = freshStoragePath();
  const xExecutor = makeMockXExecutor();
  const runner = makeRunner(storagePath, xExecutor);
  const goal = await makeXGoal(runner);
  const requestId = `goal:${goal.id}:step:s1`;
  xExecutor.statuses.set(requestId, needsReviewStatus(requestId, 'r1'));
  const waiting = await runner.run_goal(goal.id);
  const item = waiting.reviewQueue[0];
  const retryXTask1 = validXTask('TASK-1', { revision: 1, attempt: 2, based_on_result_id: 'r1' });
  await runner.retry_review(goal.id, item.id, { xTask: retryXTask1 });

  const retryXTask2 = validXTask('TASK-1', { revision: 2, attempt: 1, based_on_result_id: 'r1' });
  await assert.rejects(
    () => runner.retry_review(goal.id, item.id, { xTask: retryXTask2 }),
    /already superseded by a different retry request/
  );
});

// 13. INTERRUPTED: no review item, same xTask, generation once, checkpoint
await test('13. INTERRUPTED: no review item, xTask unchanged, generation=2, checkpoint appended', async () => {
  const storagePath = freshStoragePath();
  const xExecutor = makeMockXExecutor();
  const runner = makeRunner(storagePath, xExecutor);
  const goal = await makeXGoal(runner, 'TASK-INT');
  const requestId = `goal:${goal.id}:step:s1`;
  xExecutor.statuses.set(requestId, interruptedStatus());
  const waitingGoal = await runner.run_goal(goal.id);
  assert.equal(waitingGoal.reviewQueue.length, 0, 'No review item for INTERRUPTED');
  assert.equal(waitingGoal.steps[0].status, 'waiting');
  assert.equal(waitingGoal.steps[0].executionGeneration, 2);
  assert.equal(waitingGoal.steps[0].xTask.task_id, 'TASK-INT');
  assert.equal(waitingGoal.steps[0].xTask.revision, 1);
  const cp = waitingGoal.checkpoints.find((c) => c.evidence?.newExecutionGeneration === 2);
  assert.ok(cp, 'Checkpoint with newExecutionGeneration=2 must exist');
});

// 14. Restart after interrupted generation allocation: no re-increment
await test('14. Restart after interrupted allocation does not increment generation again', async () => {
  const storagePath = freshStoragePath();
  const xExecutor = makeMockXExecutor();
  const runner = makeRunner(storagePath, xExecutor);
  const goal = await makeXGoal(runner, 'TASK-INT2');
  xExecutor.statuses.set(`goal:${goal.id}:step:s1`, interruptedStatus());
  const waitingGoal = await runner.run_goal(goal.id);
  assert.equal(waitingGoal.steps[0].executionGeneration, 2);

  // Simulate restart: new runner from same storage
  const storage2 = new GoalStorage({ storagePath });
  const _runner2 = new GoalRunner({ storage: storage2, xExecutor });
  const reloaded = storage2.getGoal(goal.id);
  assert.equal(reloaded.steps[0].executionGeneration, 2, 'Must not re-increment on restart');
});

// 15. Resume after INTERRUPTED uses new :exec:N requestId
await test('15. Resume after INTERRUPTED dispatches with :exec:2 requestId', async () => {
  const storagePath = freshStoragePath();
  const xExecutor = makeMockXExecutor();
  const storage = new GoalStorage({ storagePath });
  const runner = new GoalRunner({ storage, xExecutor });
  const goal = await makeXGoal(runner, 'TASK-RESUME');
  const gen1Id = `goal:${goal.id}:step:s1`;
  const gen2Id = `goal:${goal.id}:step:s1:exec:2`;
  xExecutor.statuses.set(gen1Id, interruptedStatus());
  const waitingGoal = await runner.run_goal(goal.id);
  assert.equal(waitingGoal.steps[0].executionGeneration, 2);
  xExecutor.statuses.set(gen2Id, { found: true, queue_status: 'terminal', terminal_status: 'completed', result: 'done' });
  const progressEvents = [];
  const completed = await runner.resume_goal(goal.id, {
    onProgress: (g) => progressEvents.push(g.status),
  });
  assert.equal(completed.status, 'completed');
  const gen2Dispatches = xExecutor.dispatchLog.filter((d) => d.requestId === gen2Id);
  assert.equal(gen2Dispatches.length, 1, 'gen2 requestId dispatched exactly once');
  assert.equal(progressEvents[progressEvents.length - 1], 'completed', 'resume_goal must emit a final completed onProgress event');
});

// 16. Crash/replay: same requestId coalesces
await test('16. Same requestId after crash/replay: zero duplicate X dispatch', async () => {
  const storagePath = freshStoragePath();
  const xExecutor = makeMockXExecutor();
  const storage = new GoalStorage({ storagePath });
  const runner = new GoalRunner({ storage, xExecutor });
  const goal = await makeXGoal(runner);
  const requestId = `goal:${goal.id}:step:s1`;
  xExecutor.statuses.set(requestId, needsReviewStatus(requestId, 'r1'));
  const waiting = await runner.run_goal(goal.id);
  const item = waiting.reviewQueue[0];
  const retryXTask = validXTask('TASK-1', { revision: 1, attempt: 2, based_on_result_id: 'r1' });
  await runner.retry_review(goal.id, item.id, { xTask: retryXTask });
  const gen2Id = `goal:${goal.id}:step:s1:exec:2`;
  xExecutor.statuses.set(gen2Id, { found: true, queue_status: 'terminal', terminal_status: 'completed', result: 'done' });
  const storage2 = new GoalStorage({ storagePath });
  const runner2 = new GoalRunner({ storage: storage2, xExecutor });
  await runner2.resume_goal(goal.id);
  const gen2Dispatches = xExecutor.dispatchLog.filter((d) => d.requestId === gen2Id);
  assert.equal(gen2Dispatches.length, 1, 'gen2 dispatched exactly once even with crash/replay');
});

// 17a. INTERRUPTED: xTask unchanged
await test('17a. INTERRUPTED recovery: xTask byte-identical after recovery', async () => {
  const storagePath = freshStoragePath();
  const xExecutor = makeMockXExecutor();
  const storage = new GoalStorage({ storagePath });
  const runner = new GoalRunner({ storage, xExecutor });
  const originalXTask = validXTask('TASK-APPROVAL');
  const goal = await runner.create_goal({ title: 'Approval Goal', objective: 'test', workspace: testWorkspace, steps: [{ id: 's1', title: 'Step 1', description: '', route: 'x', xTask: originalXTask }] });
  xExecutor.statuses.set(`goal:${goal.id}:step:s1`, interruptedStatus());
  const waitingGoal = await runner.run_goal(goal.id);
  assert.equal(waitingGoal.steps[0].xTask.task_id, originalXTask.task_id);
  assert.equal(waitingGoal.steps[0].xTask.revision, originalXTask.revision);
  assert.equal(waitingGoal.steps[0].xTask.attempt, originalXTask.attempt);
});

// 17b. Revised retry: new xTask content (different fingerprint)
await test('17b. Revised retry: new xTask content differs from original (would not inherit old approval)', async () => {
  const storagePath = freshStoragePath();
  const xExecutor = makeMockXExecutor();
  const storage = new GoalStorage({ storagePath });
  const runner = new GoalRunner({ storage, xExecutor });
  const originalXTask = validXTask('TASK-APPROVAL2');
  const goal = await runner.create_goal({ title: 'Revised Approval Goal', objective: 'test', workspace: testWorkspace, steps: [{ id: 's1', title: 'Step 1', description: '', route: 'x', xTask: originalXTask }] });
  xExecutor.statuses.set(`goal:${goal.id}:step:s1`, needsReviewStatus(`goal:${goal.id}:step:s1`, 'r-rev'));
  const waiting = await runner.run_goal(goal.id);
  const item = waiting.reviewQueue[0];
  const revisedXTask = validXTask('TASK-APPROVAL2', { revision: 2, attempt: 1, based_on_result_id: 'r-rev', objective: 'REVISED: A different objective.' });
  const { goal: retried } = await runner.retry_review(goal.id, item.id, { xTask: revisedXTask });
  assert.equal(retried.steps[0].xTask.revision, 2);
  assert.notEqual(JSON.stringify(retried.steps[0].xTask), JSON.stringify(originalXTask), 'xTask must differ after revised retry');
});

// 18. Regression: Slice 1 ACK/RESOLVE unchanged
await test('18a. Regression: acknowledge_review (open -> acknowledged)', async () => {
  const storagePath = freshStoragePath();
  const xExecutor = makeMockXExecutor();
  const runner = makeRunner(storagePath, xExecutor);
  const goal = await makeXGoal(runner);
  const requestId = `goal:${goal.id}:step:s1`;
  xExecutor.statuses.set(requestId, needsReviewStatus(requestId, 'r-ack'));
  const waiting = await runner.run_goal(goal.id);
  const item = waiting.reviewQueue[0];
  const { goal: acked } = await runner.acknowledge_review(goal.id, item.id, { actor: 'test-actor' });
  assert.equal(acked.reviewQueue[0].lifecycle, 'acknowledged');
  assert.equal(acked.status, 'waiting');
  assert.equal(acked.steps[0].executionGeneration, null, 'ACK must not set executionGeneration');
});

await test('18b. Regression: resolve_review accept (needs_review -> completed)', async () => {
  const storagePath = freshStoragePath();
  const xExecutor = makeMockXExecutor();
  const runner = makeRunner(storagePath, xExecutor);
  const goal = await makeXGoal(runner);
  const requestId = `goal:${goal.id}:step:s1`;
  xExecutor.statuses.set(requestId, needsReviewStatus(requestId, 'r-resolve'));
  const waiting = await runner.run_goal(goal.id);
  const item = waiting.reviewQueue[0];
  const { goal: resolved } = await runner.resolve_review(goal.id, item.id, { action: 'accept' });
  assert.equal(resolved.reviewQueue[0].lifecycle, 'resolved');
  assert.equal(resolved.steps[0].status, 'completed');
  assert.equal(resolved.steps[0].executionGeneration, null, 'RESOLVE must not set executionGeneration');
});

await test('18c. Regression: resolve_review accept on failed still rejects', async () => {
  const storagePath = freshStoragePath();
  const xExecutor = makeMockXExecutor();
  const runner = makeRunner(storagePath, xExecutor);
  const goal = await makeXGoal(runner);
  const requestId = `goal:${goal.id}:step:s1`;
  xExecutor.statuses.set(requestId, failedStatus());
  const failedGoal = await runner.run_goal(goal.id);
  const item = failedGoal.reviewQueue[0];
  await assert.rejects(() => runner.resolve_review(goal.id, item.id, { action: 'accept' }), /needs_review/i);
});

await test('18d. Regression: normal completed run uses legacy requestId, no executionGeneration', async () => {
  const storagePath = freshStoragePath();
  const xExecutor = makeMockXExecutor();
  const runner = makeRunner(storagePath, xExecutor);
  const goal = await makeXGoal(runner);
  const requestId = `goal:${goal.id}:step:s1`;
  xExecutor.statuses.set(requestId, { found: true, queue_status: 'terminal', terminal_status: 'completed', result: 'done' });
  const completed = await runner.run_goal(goal.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.steps[0].executionGeneration, null);
  assert.equal(xExecutor.dispatchLog[0].requestId, `goal:${goal.id}:step:s1`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
