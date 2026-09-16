import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createGoal, validateGoal } from '../mcp/goals/model.mjs';
import { GoalStorage } from '../mcp/goals/storage.mjs';
import { GoalRunner } from '../mcp/goals/runner.mjs';
import { X_TASK_VERSION } from '../mcp/x/task-contract.mjs';
import { registerWorkspaceTools, toolNames } from '../mcp/tools.mjs';

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const makeTask = (root, taskId, objective = 'Do task', overrides = {}) => ({
  version: X_TASK_VERSION,
  task_id: taskId,
  parent_task_id: null,
  revision: 1,
  attempt: 1,
  based_on_result_id: null,
  objective,
  problem: 'Problem',
  expected_behavior: 'Expected',
  observed_behavior: 'Observed',
  why_this_matters: 'Matters',
  known_evidence: [],
  suspected_area: [],
  workspace: { repo: 'fixture', root },
  scope: { allowed_paths: ['scripts'], preferred_files: [], forbidden_paths: [] },
  constraints: { preserve: [], do_not: [] },
  allowed_tools: ['repo_read'],
  acceptance_criteria: ['Done'],
  validation: { required: ['test'], optional: [] },
  verification: null,
  done_criteria: ['Done'],
  teaching_notes: [],
  uncertainty_policy: { policy: 'bounded_autonomy', stop_conditions: [] },
  repair_budget: { initial_attempts: 1, max_repairs: 2, max_total_rounds: 3 },
  timing: { estimated_minutes: 1, first_check_after_minutes: 1, soft_deadline_minutes: 1, hard_timeout_minutes: 1 },
  commit_policy: { mode: 'never' },
  ...overrides,
});

test('SESSION HANDOFF TEST: 5-step goal with acknowledged needs_review', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-ctx-test-1-'));
  dirs.push(root);
  const storage = new GoalStorage({ storagePath: path.join(root, 'goals.json') });
  const runner = new GoalRunner({ storage });

  let goal = createGoal({
    title: '5-step Goal',
    objective: 'Test session handoff',
    workspace: root,
    steps: [
      { id: 's1', title: 'Step 1', route: 'x', xTask: makeTask(root, 'T1'), status: 'completed' },
      { id: 's2', title: 'Step 2', route: 'x', xTask: makeTask(root, 'T2'), status: 'completed' },
      { id: 's3', title: 'Step 3', route: 'x', xTask: makeTask(root, 'T3'), status: 'waiting' },
      { id: 's4', title: 'Step 4', route: 'x', xTask: makeTask(root, 'T4'), status: 'pending' },
      { id: 's5', title: 'Step 5', route: 'x', xTask: makeTask(root, 'T5'), status: 'pending' },
    ],
  });
  goal.currentStepId = 's3';
  goal.status = 'waiting';
  goal.reviewQueue = [
    {
      id: 'rev-s3',
      idempotencyKey: 'key-s3',
      stepId: 's3',
      taskId: 'T3',
      runId: 'run-s3',
      resultId: 'res-s3',
      status: 'needs_review',
      lifecycle: 'acknowledged',
      acknowledgedAt: new Date().toISOString(),
      reason: 'Needs human review',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];
  storage.saveGoal(goal);

  // Restart GoalRunner with fresh storage
  const storage2 = new GoalStorage({ storagePath: path.join(root, 'goals.json') });
  const runner2 = new GoalRunner({ storage: storage2 });

  const ctx = await runner2.getGoalContext(goal.id);
  assert.equal(ctx.version, 'x-context-v1');
  assert.deepEqual(ctx.progress.completed_step_ids, ['s1', 's2']);
  assert.equal(ctx.progress.current_step_id, 's3');
  assert.deepEqual(ctx.progress.remaining_step_ids, ['s4', 's5']);
  assert.equal(ctx.review.active_item_id, 'rev-s3');
  assert.equal(ctx.review.lifecycle, 'acknowledged');
  assert.equal(ctx.review.result_id, 'res-s3');
  assert.equal(ctx.next_legal_action.type, 'WAIT_FOR_REVIEW');
});

test('RETRY PREPARED TEST: generation 2 allocated, request not admitted -> RESUME_CURRENT_STEP', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-ctx-test-2-'));
  dirs.push(root);
  const storage = new GoalStorage({ storagePath: path.join(root, 'goals.json') });
  const runner = new GoalRunner({ storage });

  const oldTask = makeTask(root, 'T3', 'Original spec', { revision: 1, attempt: 1 });
  let goal = createGoal({
    title: 'Retry Goal',
    objective: 'Test retry prepared',
    workspace: root,
    steps: [
      { id: 's1', title: 'Step 1', route: 'x', xTask: makeTask(root, 'T1'), status: 'completed' },
      { id: 's2', title: 'Step 2', route: 'x', xTask: makeTask(root, 'T2'), status: 'completed' },
      { id: 's3', title: 'Step 3', route: 'x', xTask: oldTask, status: 'waiting' },
    ],
  });
  goal.currentStepId = 's3';
  goal.status = 'waiting';
  goal.reviewQueue = [
    {
      id: 'rev-s3',
      idempotencyKey: 'key-s3',
      stepId: 's3',
      taskId: 'T3',
      runId: 'run-s3',
      resultId: 'res-s3',
      status: 'needs_review',
      lifecycle: 'open',
      reason: 'Needs review',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];
  storage.saveGoal(goal);

  // Prepare retry
  const newTask = makeTask(root, 'T3', 'Revised spec', { revision: 2, attempt: 1, based_on_result_id: 'res-s3' });
  await runner.retry_review(goal.id, 'rev-s3', { xTask: newTask, note: 'Retry revision 2' });

  // Restart storage/runner BEFORE resume
  const storage2 = new GoalStorage({ storagePath: path.join(root, 'goals.json') });
  const mockXExecutor = { getXTaskStatus: () => ({ found: false, reason: 'not_found' }) };
  const runner2 = new GoalRunner({ storage: storage2, xExecutor: mockXExecutor });

  const ctx = await runner2.getGoalContext(goal.id);
  assert.equal(ctx.current_step.id, 's3');
  assert.equal(ctx.current_step.execution_generation, 2);
  assert.equal(ctx.authored_task.revision, 2);
  assert.equal(ctx.authored_task.attempt, 1);
  assert.equal(ctx.execution.current_request_id, `goal:${goal.id}:step:s3:exec:2`);
  assert.equal(ctx.execution.request_status.found, false);
  assert.equal(ctx.next_legal_action.type, 'RESUME_CURRENT_STEP');
});

test('RETRY ALREADY DISPATCHED TEST: generation 2 request exists non-terminal -> WAIT_FOR_X', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-ctx-test-3-'));
  dirs.push(root);
  const storage = new GoalStorage({ storagePath: path.join(root, 'goals.json') });
  const runner = new GoalRunner({ storage });

  const oldTask = makeTask(root, 'T3', 'Original spec');
  let goal = createGoal({
    title: 'Retry Dispatched Goal',
    objective: 'Test retry running',
    workspace: root,
    steps: [
      { id: 's3', title: 'Step 3', route: 'x', xTask: oldTask, status: 'waiting' },
    ],
  });
  goal.currentStepId = 's3';
  goal.status = 'waiting';
  goal.reviewQueue = [
    {
      id: 'rev-s3',
      idempotencyKey: 'key-s3',
      stepId: 's3',
      taskId: 'T3',
      runId: 'run-s3',
      resultId: 'res-s3',
      status: 'needs_review',
      lifecycle: 'open',
      reason: 'Needs review',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];
  storage.saveGoal(goal);

  const newTask = makeTask(root, 'T3', 'Revised spec', { revision: 2, attempt: 1, based_on_result_id: 'res-s3' });
  await runner.retry_review(goal.id, 'rev-s3', { xTask: newTask });

  const mockXExecutor = {
    getXTaskStatus: (reqId) => {
      if (reqId === `goal:${goal.id}:step:s3:exec:2`) {
        return { found: true, status: 'running', runId: 'run-gen2' };
      }
      return { found: false };
    },
  };
  const runner2 = new GoalRunner({ storage, xExecutor: mockXExecutor });

  const ctx = await runner2.getGoalContext(goal.id);
  assert.equal(ctx.execution.request_status.found, true);
  assert.equal(ctx.execution.request_status.status, 'running');
  assert.equal(ctx.next_legal_action.type, 'WAIT_FOR_X');
});

test('FAILED TEST: step failed with open failed review -> RETRY_REQUIRES_NEW_XTASK', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-ctx-test-4-'));
  dirs.push(root);
  const storage = new GoalStorage({ storagePath: path.join(root, 'goals.json') });

  let goal = createGoal({
    title: 'Failed Step Goal',
    objective: 'Test failed review derivation',
    workspace: root,
    steps: [
      { id: 's1', title: 'Step 1', route: 'x', xTask: makeTask(root, 'T1'), status: 'completed' },
      { id: 's2', title: 'Step 2', route: 'x', xTask: makeTask(root, 'T2'), status: 'error', result: 'Syntax error' },
      { id: 's3', title: 'Step 3', route: 'x', xTask: makeTask(root, 'T3'), status: 'pending' },
    ],
  });
  goal.currentStepId = 's2';
  goal.status = 'error';
  goal.error = 'Step 2 failed';
  goal.reviewQueue = [
    {
      id: 'rev-s2',
      idempotencyKey: 'key-s2',
      stepId: 's2',
      taskId: 'T2',
      runId: 'run-s2',
      resultId: 'res-s2',
      status: 'failed',
      lifecycle: 'open',
      reason: 'Build error',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];
  storage.saveGoal(goal);

  const runner = new GoalRunner({ storage });
  const ctx = await runner.getGoalContext(goal.id);
  assert.equal(ctx.next_legal_action.type, 'RETRY_REQUIRES_NEW_XTASK');
  assert.equal(ctx.review.active_item_id, 'rev-s2');
  assert.equal(ctx.review.status, 'failed');
  assert.deepEqual(ctx.progress.remaining_step_ids, ['s3']);
});

test('COMPLETED GOAL TEST: completed goal -> GOAL_COMPLETED', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-ctx-test-5-'));
  dirs.push(root);
  const storage = new GoalStorage({ storagePath: path.join(root, 'goals.json') });

  let goal = createGoal({
    title: 'Done Goal',
    objective: 'Test completed goal',
    workspace: root,
    steps: [
      { id: 's1', title: 'Step 1', route: 'x', xTask: makeTask(root, 'T1'), status: 'completed' },
    ],
  });
  goal.status = 'completed';
  goal.currentStepId = null;
  storage.saveGoal(goal);

  const runner = new GoalRunner({ storage });
  const ctx = await runner.getGoalContext(goal.id);
  assert.equal(ctx.next_legal_action.type, 'GOAL_COMPLETED');
  assert.equal(ctx.current_step, null);
  assert.deepEqual(ctx.progress.completed_step_ids, ['s1']);
});

test('APPROVAL TESTS: valid approval vs changed task', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-ctx-test-6-')));
  dirs.push(root);
  const storage = new GoalStorage({ storagePath: path.join(root, 'goals.json') });

  const task = makeTask(root, 'T1');
  let goal = createGoal({
    title: 'Approval Goal',
    objective: 'Test approval reporting',
    workspace: root,
    steps: [
      { id: 's1', title: 'Step 1', route: 'x', xTask: task, status: 'pending' },
    ],
  });

  // Calculate fingerprint for valid approval
  const canonicalJson = (v) => JSON.stringify(v, (k, item) => (!item || Array.isArray(item) || typeof item !== 'object' ? item : Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]))));
  const fp = crypto.createHash('sha256').update(canonicalJson({ ...task, workspace: { ...task.workspace, root } })).digest('hex');

  goal.xApproval = {
    approvedAt: new Date().toISOString(),
    workspaceRoot: root,
    steps: [{ stepId: 's1', xTaskFingerprint: fp }],
  };
  storage.saveGoal(goal);

  const runner = new GoalRunner({ storage });
  const ctxValid = await runner.getGoalContext(goal.id);
  assert.equal(ctxValid.approval.snapshot_present, true);
  assert.equal(ctxValid.approval.validity, 'valid');
  assert.equal(ctxValid.next_legal_action.type, 'RUN_CURRENT_STEP');

  // Modify task -> invalid approval
  goal.steps[0].xTask.objective = 'Modified objective';
  storage.saveGoal(goal);

  const ctxInvalid = await runner.getGoalContext(goal.id);
  assert.equal(ctxInvalid.approval.snapshot_present, true);
  assert.equal(ctxInvalid.approval.validity, 'invalid');
  assert.equal(ctxInvalid.next_legal_action.type, 'WAIT_FOR_APPROVAL');
});

test('READ-ONLY PROOF: getGoalContext leaves canonical Goal file byte-identical', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-ctx-test-7-'));
  dirs.push(root);
  const storagePath = path.join(root, 'goals.json');
  const storage = new GoalStorage({ storagePath });

  let goal = createGoal({
    title: 'Readonly Goal',
    objective: 'Test zero mutations',
    workspace: root,
    steps: [
      { id: 's1', title: 'Step 1', route: 'x', xTask: makeTask(root, 'T1'), status: 'pending' },
    ],
  });
  storage.saveGoal(goal);

  const beforeBytes = fs.readFileSync(storagePath);

  const runner = new GoalRunner({ storage });
  await runner.getGoalContext(goal.id);
  await runner.getGoalContext(goal.id);
  await runner.getGoalContext(goal.id);

  const afterBytes = fs.readFileSync(storagePath);
  assert.deepEqual(beforeBytes, afterBytes, 'Goal file on disk must remain byte-identical after context reads');
});

test('MCP TEST: goal_get_context tool returns x-context-v1 over transport', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-ctx-test-8-'));
  dirs.push(root);
  const storage = new GoalStorage({ storagePath: path.join(root, 'goals.json') });
  const runner = new GoalRunner({ storage });

  let goal = createGoal({
    title: 'MCP Goal',
    objective: 'Test MCP tool',
    workspace: root,
    steps: [
      { id: 's1', title: 'Step 1', route: 'x', xTask: makeTask(root, 'T1'), status: 'completed' },
      { id: 's2', title: 'Step 2', route: 'x', xTask: makeTask(root, 'T2'), status: 'pending' },
    ],
  });
  goal.currentStepId = 's2';
  storage.saveGoal(goal);

  const tools = new Map();
  const fakeServer = { registerTool: (name, config, handler) => tools.set(name, { config, handler }) };

  assert.ok(toolNames.includes('goal_get_context'), 'toolNames array must include goal_get_context');

  registerWorkspaceTools(fakeServer, {
    workspace: root,
    permissions: {},
    reviewQueueTransport: {
      getGoalContext: async ({ goalId }) => runner.getGoalContext(goalId),
    },
  });

  const tool = tools.get('goal_get_context');
  assert.ok(tool, 'goal_get_context tool must be registered');

  const result = await tool.handler({ goal_id: goal.id });
  const parsed = JSON.parse(result.content[0].text);

  assert.equal(parsed.version, 'x-context-v1');
  assert.equal(parsed.goal.id, goal.id);
  assert.deepEqual(parsed.progress.completed_step_ids, ['s1']);
  assert.equal(parsed.progress.current_step_id, 's2');
  assert.equal(parsed.next_legal_action.type, 'WAIT_FOR_APPROVAL');
});

test('INTERRUPTED CONTEXT PROOF: gen1 terminal INTERRUPTED -> executionGeneration 2 allocated -> restart before resume -> RESUME_CURRENT_STEP', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-ctx-test-interrupted-'));
  dirs.push(root);
  const storage = new GoalStorage({ storagePath: path.join(root, 'goals.json') });

  const task = makeTask(root, 'T2');
  let goal = createGoal({
    title: 'Interrupted Goal',
    objective: 'Test interrupted recovery context',
    workspace: root,
    steps: [
      { id: 's1', title: 'Step 1', route: 'x', xTask: makeTask(root, 'T1'), status: 'completed' },
      { id: 's2', title: 'Step 2', route: 'x', xTask: task, status: 'paused', executionGeneration: 2, result: 'Step execution interrupted by application restart.' },
    ],
  });
  goal.currentStepId = 's2';
  goal.status = 'paused';
  goal.reviewQueue = [];
  storage.saveGoal(goal);

  const storage2 = new GoalStorage({ storagePath: path.join(root, 'goals.json') });
  let dispatchCount = 0;
  const mockXExecutor = {
    dispatchXTask: async () => { dispatchCount++; return { accepted: true }; },
    getXTaskStatus: () => ({ found: false, reason: 'not_found' }),
  };
  const runner = new GoalRunner({ storage: storage2, xExecutor: mockXExecutor });

  const ctx = await runner.getGoalContext(goal.id);

  assert.equal(ctx.next_legal_action.type, 'RESUME_CURRENT_STEP');
  assert.equal(ctx.review, null, 'No active Review Queue item must exist for interrupted step');
  assert.deepEqual(ctx.authored_task, task, 'xTask must remain unchanged');
  assert.equal(ctx.current_step.execution_generation, 2, 'executionGeneration must remain 2');
  assert.equal(dispatchCount, 0, 'Context read must not dispatch X');
});

test('RUNNING CONTEXT PROOF: current X request exists and is non-terminal -> WAIT_FOR_X without mutation or dispatch', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-ctx-test-running-'));
  dirs.push(root);
  const storagePath = path.join(root, 'goals.json');
  const storage = new GoalStorage({ storagePath });

  const task = makeTask(root, 'T1');
  let goal = createGoal({
    title: 'Running Goal',
    objective: 'Test running request context',
    workspace: root,
    steps: [
      { id: 's1', title: 'Step 1', route: 'x', xTask: task, status: 'running' },
    ],
  });
  goal.currentStepId = 's1';
  goal.status = 'running';
  storage.saveGoal(goal);

  let dispatchCount = 0;
  const mockXExecutor = {
    dispatchXTask: async () => { dispatchCount++; return { accepted: true }; },
    getXTaskStatus: (reqId) => {
      if (reqId === `goal:${goal.id}:step:s1`) {
        return { found: true, status: 'running', runId: 'run-running-1' };
      }
      return { found: false };
    },
  };
  const runner = new GoalRunner({ storage, xExecutor: mockXExecutor });

  const beforeBytes = fs.readFileSync(storagePath);
  const ctx = await runner.getGoalContext(goal.id);
  const afterBytes = fs.readFileSync(storagePath);

  assert.equal(ctx.next_legal_action.type, 'WAIT_FOR_X');
  assert.equal(ctx.execution.request_status.found, true);
  assert.equal(ctx.execution.request_status.status, 'running');
  assert.equal(dispatchCount, 0, 'No duplicate dispatch on reading context');
  assert.deepEqual(beforeBytes, afterBytes, 'No state mutation on disk');
});
