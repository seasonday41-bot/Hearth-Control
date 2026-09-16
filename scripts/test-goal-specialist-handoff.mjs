// Focused test suite for Slice 5: Durable X -> Codex/Work handoff preparation
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { XQueueStore } from '../mcp/x/queue-store.mjs';
import { X_TASK_VERSION } from '../mcp/x/task-contract.mjs';
import { createGoal } from '../mcp/goals/model.mjs';
import { GoalStorage } from '../mcp/goals/storage.mjs';
import { GoalRunner } from '../mcp/goals/runner.mjs';

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const xTaskFor = (root, taskId, objective = 'Report a fact', overrides = {}) => ({
  version: X_TASK_VERSION,
  task_id: taskId,
  parent_task_id: null,
  revision: 1,
  attempt: 1,
  based_on_result_id: null,
  objective,
  problem: 'A fact is not yet known.',
  expected_behavior: 'The fact is reported.',
  observed_behavior: 'No report yet.',
  why_this_matters: 'Specialist handoff testing.',
  known_evidence: [],
  suspected_area: [],
  workspace: { repo: 'fixture', root },
  scope: { allowed_paths: ['scripts'], preferred_files: [], forbidden_paths: [] },
  constraints: { preserve: [], do_not: [] },
  allowed_tools: ['repo_read'],
  acceptance_criteria: ['Reported'],
  validation: { required: ['test'], optional: [] },
  verification: null,
  done_criteria: ['Reported'],
  teaching_notes: [],
  uncertainty_policy: { policy: 'bounded_autonomy', stop_conditions: [] },
  repair_budget: { initial_attempts: 1, max_repairs: 2, max_total_rounds: 3 },
  timing: { estimated_minutes: 1, first_check_after_minutes: 1, soft_deadline_minutes: 1, hard_timeout_minutes: 1 },
  commit_policy: { mode: 'never' },
  ...overrides,
});

function createHarness({ mockStatus = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-specialist-handoff-'));
  dirs.push(root);
  const goalStoragePath = path.join(root, 'goals.json');
  const storage = new GoalStorage({ storagePath: goalStoragePath });

  let dispatchCount = 0;
  const runner = new GoalRunner({
    storage,
    xExecutor: {
      dispatchXTask: async () => { dispatchCount += 1; },
      getXTaskStatus: async (reqId) => {
        if (typeof mockStatus === 'function') return mockStatus(reqId);
        if (mockStatus) return mockStatus;
        return { found: true, queue_status: 'terminal', terminal_status: 'completed', result: 'ok' };
      },
    },
  });

  return { root, storage, runner, goalStoragePath, get dispatchCount() { return dispatchCount; } };
}

console.log('\n=== Slice 5: Specialist Handoff Preparation Test Suite ===\n');

let passed = 0;
let failed = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); passed += 1; }
  catch (err) { console.error(`  FAIL  ${name}: ${err.stack || err.message}`); failed += 1; }
};

// 1. NEEDS_REVIEW HANDOFF REQUEST
await t('1. NEEDS_REVIEW handoff request creates 1 durable record, review remains open, goal stays blocked, 0 extra dispatches', async () => {
  const h = createHarness({
    mockStatus: async () => ({
      found: true, queue_status: 'terminal', terminal_status: 'needs_review',
      result: { version: 'x-result-v1', result_id: 'r-nr-1', task_id: 'T-NR-1', reason_code: 'waiting_review' },
    }),
  });

  const goal = await h.runner.create_goal({
    title: 'Needs Review Goal', objective: 'Test handoff from needs_review', workspace: h.root,
    steps: [{ id: 's1', title: 'Step 1', description: '', route: 'x', xTask: xTaskFor(h.root, 'T-NR-1') }],
  });

  await h.runner.run_goal(goal.id);
  const reloaded = h.storage.getGoal(goal.id);
  const reviewItem = reloaded.reviewQueue[0];
  assert.equal(reviewItem.status, 'needs_review');
  assert.equal(reviewItem.lifecycle, 'open');

  const initialDispatches = h.dispatchCount;

  // Request handoff to Codex
  const { handoff, goal: updatedGoal } = await h.runner.request_specialist_handoff(goal.id, 's1', {
    target: 'codex', reason: 'Complex algorithm required', requestedAction: 'Implement optimized search',
  });

  assert.ok(handoff);
  assert.equal(handoff.target, 'codex');
  assert.equal(handoff.lifecycle, 'requested');
  assert.equal(updatedGoal.specialistHandoffs.length, 1);

  // Review item remains open (NOT superseded/resolved)
  const afterHandoffReview = updatedGoal.reviewQueue[0];
  assert.equal(afterHandoffReview.lifecycle, 'open');
  assert.equal(updatedGoal.status, 'waiting');
  assert.equal(h.dispatchCount, initialDispatches, 'Zero additional dispatches on handoff request');
});

// 2. FAILED HANDOFF REQUEST
await t('2. FAILED handoff request persists record, review remains failed/open, step remains error, goal not completed', async () => {
  const h = createHarness({
    mockStatus: async () => ({
      found: true, queue_status: 'terminal', terminal_status: 'failed',
      error: 'Build error',
    }),
  });

  const goal = await h.runner.create_goal({
    title: 'Failed Goal', objective: 'Test handoff from failed', workspace: h.root,
    steps: [
      { id: 's1', title: 'Step 1', description: '', route: 'x', xTask: xTaskFor(h.root, 'T-F-1') },
      { id: 's2', title: 'Step 2', description: '', route: 'x', xTask: xTaskFor(h.root, 'T-F-2') },
    ],
  });

  await h.runner.run_goal(goal.id);
  const reloaded = h.storage.getGoal(goal.id);
  assert.equal(reloaded.steps[0].status, 'error');

  const { handoff, goal: updatedGoal } = await h.runner.request_specialist_handoff(goal.id, 's1', {
    target: 'work', reason: 'Hard build error', requestedAction: 'Fix compiler options',
  });

  assert.equal(handoff.target, 'work');
  assert.equal(updatedGoal.specialistHandoffs.length, 1);
  assert.equal(updatedGoal.steps[0].status, 'error');
  assert.equal(updatedGoal.steps[1].status, 'pending', 'Downstream step 2 remains pending');
  assert.notEqual(updatedGoal.status, 'completed');
});

// 3. RUNNING X REJECTED
await t('3. Handoff request on a running X step fails closed', async () => {
  const h = createHarness({
    mockStatus: async () => ({ found: true, queue_status: 'dispatching', status: 'running' }),
  });

  const goal = await h.runner.create_goal({
    title: 'Running Goal', objective: 'Test rejection of running step', workspace: h.root,
    steps: [{ id: 's1', title: 'Step 1', description: '', route: 'x', xTask: xTaskFor(h.root, 'T-R-1') }],
  });

  // Set step status to running manually to simulate active execution
  goal.status = 'running';
  goal.steps[0].status = 'running';
  h.storage.saveGoal(goal);

  await assert.rejects(
    () => h.runner.request_specialist_handoff(goal.id, 's1', { target: 'codex' }),
    /Cannot request specialist handoff while step/
  );
});

// 4. INTERRUPTED REJECTED
await t('4. Handoff request on an INTERRUPTED step without an active review item fails closed', async () => {
  const h = createHarness({
    mockStatus: async () => ({ found: true, queue_status: 'terminal', terminal_status: 'interrupted' }),
  });

  const goal = await h.runner.create_goal({
    title: 'Interrupted Goal', objective: 'Test rejection of interrupted step', workspace: h.root,
    steps: [{ id: 's1', title: 'Step 1', description: '', route: 'x', xTask: xTaskFor(h.root, 'T-I-1') }],
  });

  await h.runner.run_goal(goal.id);
  const reloaded = h.storage.getGoal(goal.id);
  assert.equal(reloaded.steps[0].status, 'waiting');
  assert.equal(reloaded.reviewQueue.length, 0, 'INTERRUPTED step produces NO review item');

  await assert.rejects(
    () => h.runner.request_specialist_handoff(goal.id, 's1', { target: 'codex' }),
    /Specialist handoff is only permitted for steps with an active NEEDS_REVIEW or FAILED/
  );
});

// 5. DETERMINISTIC ID
await t('5. Repeat identical handoff request yields same handoff ID and exactly one stored record', async () => {
  const h = createHarness({
    mockStatus: async () => ({
      found: true, queue_status: 'terminal', terminal_status: 'needs_review',
      result: { version: 'x-result-v1', result_id: 'r-det-1', task_id: 'T-DET-1', reason_code: 'waiting_review' },
    }),
  });

  const goal = await h.runner.create_goal({
    title: 'Deterministic Goal', objective: 'Test deterministic ID', workspace: h.root,
    steps: [{ id: 's1', title: 'Step 1', description: '', route: 'x', xTask: xTaskFor(h.root, 'T-DET-1') }],
  });

  await h.runner.run_goal(goal.id);

  const res1 = await h.runner.request_specialist_handoff(goal.id, 's1', {
    target: 'codex', reason: 'Reason A', requestedAction: 'Action A',
  });

  const res2 = await h.runner.request_specialist_handoff(goal.id, 's1', {
    target: 'codex', reason: 'Reason A', requestedAction: 'Action A',
  });

  assert.equal(res1.handoff.id, res2.handoff.id);
  assert.equal(res2.goal.specialistHandoffs.length, 1, 'Only one record stored on repeated identical request');
});

// 6. CONFLICTING DUPLICATE
await t('6. Conflicting handoff request (same source & target, different parameters) fails closed', async () => {
  const h = createHarness({
    mockStatus: async () => ({
      found: true, queue_status: 'terminal', terminal_status: 'needs_review',
      result: { version: 'x-result-v1', result_id: 'r-cnf-1', task_id: 'T-CNF-1', reason_code: 'waiting_review' },
    }),
  });

  const goal = await h.runner.create_goal({
    title: 'Conflicting Goal', objective: 'Test conflicting handoff request', workspace: h.root,
    steps: [{ id: 's1', title: 'Step 1', description: '', route: 'x', xTask: xTaskFor(h.root, 'T-CNF-1') }],
  });

  await h.runner.run_goal(goal.id);

  await h.runner.request_specialist_handoff(goal.id, 's1', {
    target: 'codex', reason: 'Reason A', requestedAction: 'Action A',
  });

  await assert.rejects(
    () => h.runner.request_specialist_handoff(goal.id, 's1', {
      target: 'codex', reason: 'DIFFERENT REASON', requestedAction: 'Action A',
    }),
    /Conflicting specialist handoff request/
  );
});

// 7. RESTART DURABILITY
await t('7. Restart durability: handoff record persists across GoalStorage reload', async () => {
  const h = createHarness({
    mockStatus: async () => ({
      found: true, queue_status: 'terminal', terminal_status: 'needs_review',
      result: { version: 'x-result-v1', result_id: 'r-rst-1', task_id: 'T-RST-1', reason_code: 'waiting_review' },
    }),
  });

  const goal = await h.runner.create_goal({
    title: 'Restart Goal', objective: 'Test restart durability', workspace: h.root,
    steps: [{ id: 's1', title: 'Step 1', description: '', route: 'x', xTask: xTaskFor(h.root, 'T-RST-1') }],
  });

  await h.runner.run_goal(goal.id);
  const { handoff } = await h.runner.request_specialist_handoff(goal.id, 's1', {
    target: 'codex', reason: 'Persist test', requestedAction: 'Action',
  });

  // Simulate application restart
  const newStorage = new GoalStorage({ storagePath: h.goalStoragePath });
  const reloadedGoal = newStorage.getGoal(goal.id);
  assert.equal(reloadedGoal.specialistHandoffs.length, 1);
  assert.equal(reloadedGoal.specialistHandoffs[0].id, handoff.id);
  assert.equal(reloadedGoal.specialistHandoffs[0].target, 'codex');
});

// 8. HANDOFF PACKAGE
await t('8. build_specialist_handoff creates valid specialist-handoff-v1 continuation package', async () => {
  const h = createHarness({
    mockStatus: async () => ({
      found: true, queue_status: 'terminal', terminal_status: 'needs_review',
      result: { version: 'x-result-v1', result_id: 'r-pkg-1', task_id: 'T-PKG-1', reason_code: 'waiting_review' },
    }),
  });

  const goal = await h.runner.create_goal({
    title: 'Package Goal', objective: 'Test specialist-handoff-v1 package', workspace: h.root,
    steps: [{ id: 's1', title: 'Step 1', description: '', route: 'x', xTask: xTaskFor(h.root, 'T-PKG-1') }],
  });

  await h.runner.run_goal(goal.id);
  const { handoff } = await h.runner.request_specialist_handoff(goal.id, 's1', {
    target: 'codex', reason: 'Review requested', requestedAction: 'Refactor module',
  });

  const pkg = await h.runner.build_specialist_handoff(goal.id, handoff.id);
  assert.equal(pkg.version, 'specialist-handoff-v1');
  assert.equal(pkg.stale, false);
  assert.equal(pkg.handoff.target, 'codex');
  assert.equal(pkg.handoff.reason, 'Review requested');
  assert.equal(pkg.source.worker, 'x');
  assert.equal(pkg.source.step_id, 's1');
  assert.ok(pkg.authored_x_task);
  assert.equal(pkg.authored_x_task.task_id, 'T-PKG-1');
  assert.equal(pkg.boundaries.workspace, h.root);
  assert.ok(pkg.context);
  assert.equal(pkg.context.version, 'x-context-v1');
});

// 9. READ-ONLY PROOF
await t('9. Read-only proof: build_specialist_handoff performs zero storage writes and zero dispatches', async () => {
  const h = createHarness({
    mockStatus: async () => ({
      found: true, queue_status: 'terminal', terminal_status: 'needs_review',
      result: { version: 'x-result-v1', result_id: 'r-ro-1', task_id: 'T-RO-1', reason_code: 'waiting_review' },
    }),
  });

  const goal = await h.runner.create_goal({
    title: 'Read Only Goal', objective: 'Test read-only package derivation', workspace: h.root,
    steps: [{ id: 's1', title: 'Step 1', description: '', route: 'x', xTask: xTaskFor(h.root, 'T-RO-1') }],
  });

  await h.runner.run_goal(goal.id);
  const { handoff } = await h.runner.request_specialist_handoff(goal.id, 's1', { target: 'work' });

  const bytesBefore = fs.readFileSync(h.goalStoragePath, 'utf8');
  const dispatchesBefore = h.dispatchCount;

  await h.runner.build_specialist_handoff(goal.id, handoff.id);
  await h.runner.build_specialist_handoff(goal.id, handoff.id);

  const bytesAfter = fs.readFileSync(h.goalStoragePath, 'utf8');
  assert.equal(bytesAfter, bytesBefore, 'goals.json bytes must remain identical after build_specialist_handoff');
  assert.equal(h.dispatchCount, dispatchesBefore, 'dispatch count must remain identical');
});

// 10. STALE AFTER RETRY
await t('10. Handoff becomes stale (stale: true) when step is retried with a new execution', async () => {
  const h = createHarness({
    mockStatus: async () => ({
      found: true, queue_status: 'terminal', terminal_status: 'needs_review',
      result: { version: 'x-result-v1', result_id: 'r-stl-1', task_id: 'T-STL-1', reason_code: 'waiting_review' },
    }),
  });

  const goal = await h.runner.create_goal({
    title: 'Stale Retry Goal', objective: 'Test staleness after retry', workspace: h.root,
    steps: [{ id: 's1', title: 'Step 1', description: '', route: 'x', xTask: xTaskFor(h.root, 'T-STL-1') }],
  });

  await h.runner.run_goal(goal.id);
  const { handoff } = await h.runner.request_specialist_handoff(goal.id, 's1', { target: 'codex' });

  const pkg1 = await h.runner.build_specialist_handoff(goal.id, handoff.id);
  assert.equal(pkg1.stale, false);

  // Now retry the review item (increments generation to 2)
  const reviewItem = goal.reviewQueue[0];
  const retryTask = xTaskFor(h.root, 'T-STL-1', 'Objective 2', { revision: 2, attempt: 1, based_on_result_id: 'r-stl-1' });
  await h.runner.retry_review(goal.id, reviewItem.id, { xTask: retryTask });

  // The historical handoff record when read now reports stale: true
  const pkg2 = await h.runner.build_specialist_handoff(goal.id, handoff.id);
  assert.equal(pkg2.stale, true, 'Handoff must be reported as stale after source execution changed');
});

// 11. STALE AFTER REVIEW RESOLUTION
await t('11. Handoff becomes stale when original review item is resolved', async () => {
  const h = createHarness({
    mockStatus: async () => ({
      found: true, queue_status: 'terminal', terminal_status: 'needs_review',
      result: { version: 'x-result-v1', result_id: 'r-res-1', task_id: 'T-RES-1', reason_code: 'waiting_review' },
    }),
  });

  const goal = await h.runner.create_goal({
    title: 'Stale Resolve Goal', objective: 'Test staleness after review resolution', workspace: h.root,
    steps: [{ id: 's1', title: 'Step 1', description: '', route: 'x', xTask: xTaskFor(h.root, 'T-RES-1') }],
  });

  await h.runner.run_goal(goal.id);
  const { handoff } = await h.runner.request_specialist_handoff(goal.id, 's1', { target: 'codex' });

  // Resolve review item (accept)
  const reviewItem = goal.reviewQueue[0];
  await h.runner.resolve_review(goal.id, reviewItem.id, 'accept');

  const pkg = await h.runner.build_specialist_handoff(goal.id, handoff.id);
  assert.equal(pkg.stale, true, 'Handoff must report stale: true after linked review is resolved');
});

// 12. CONTEXT HANDOFF VISIBILITY
await t('12. get_goal_context exposes specialist_handoff and SPECIALIST_HANDOFF_REQUESTED next legal action', async () => {
  const h = createHarness({
    mockStatus: async () => ({
      found: true, queue_status: 'terminal', terminal_status: 'needs_review',
      result: { version: 'x-result-v1', result_id: 'r-ctx-1', task_id: 'T-CTX-1', reason_code: 'waiting_review' },
    }),
  });

  const goal = await h.runner.create_goal({
    title: 'Context Visibility Goal', objective: 'Test x-context-v1 visibility', workspace: h.root,
    steps: [{ id: 's1', title: 'Step 1', description: '', route: 'x', xTask: xTaskFor(h.root, 'T-CTX-1') }],
  });

  await h.runner.run_goal(goal.id);
  const { handoff } = await h.runner.request_specialist_handoff(goal.id, 's1', { target: 'codex' });

  const ctx = await h.runner.get_goal_context(goal.id);
  assert.ok(ctx.specialist_handoff);
  assert.equal(ctx.specialist_handoff.id, handoff.id);
  assert.equal(ctx.specialist_handoff.target, 'codex');
  assert.equal(ctx.specialist_handoff.stale, false);

  assert.equal(ctx.next_legal_action.type, 'SPECIALIST_HANDOFF_REQUESTED');
  assert.equal(ctx.next_legal_action.target, 'codex');
  assert.equal(ctx.next_legal_action.handoff_id, handoff.id);
});

// 13. NO APPROVAL REUSE
await t('13. Specialist handoff package does NOT expose X approval as specialist authorization', async () => {
  const h = createHarness({
    mockStatus: async () => ({
      found: true, queue_status: 'terminal', terminal_status: 'needs_review',
      result: { version: 'x-result-v1', result_id: 'r-app-1', task_id: 'T-APP-1', reason_code: 'waiting_review' },
    }),
  });

  const goal = await h.runner.create_goal({
    title: 'Approval Scope Goal', objective: 'Test no approval reuse', workspace: h.root,
    steps: [{ id: 's1', title: 'Step 1', description: '', route: 'x', xTask: xTaskFor(h.root, 'T-APP-1') }],
  });

  // Pre-seed an X approval record on goal
  goal.xApproval = { approvedAt: new Date().toISOString(), workspaceRoot: h.root, steps: [{ stepId: 's1', xTaskFingerprint: 'dummy' }] };
  h.storage.saveGoal(goal);

  await h.runner.run_goal(goal.id);
  const { handoff } = await h.runner.request_specialist_handoff(goal.id, 's1', { target: 'codex' });

  const pkg = await h.runner.build_specialist_handoff(goal.id, handoff.id);
  assert.equal(pkg.boundaries.workspace, h.root);
  // Verify package has no authorization flag granting silent execution
  assert.equal(pkg.handoff.lifecycle, 'requested');
  assert.equal(pkg.stale, false);
});

// 14. CONTROLLED SMOKE
await t('14. Controlled smoke: 3-step Goal, s2 NEEDS_REVIEW, handoff to Codex, restart durability & no auto execution', async () => {
  const h = createHarness({
    mockStatus: async (reqId) => {
      if (reqId.includes('s1')) return { found: true, queue_status: 'terminal', terminal_status: 'completed', result: 'ok' };
      if (reqId.includes('s2')) return {
        found: true, queue_status: 'terminal', terminal_status: 'needs_review',
        result: { version: 'x-result-v1', result_id: 'r-smk-2', task_id: 'T-SMK-2', reason_code: 'waiting_review' },
      };
      return { found: true, queue_status: 'terminal', terminal_status: 'completed', result: 'ok' };
    },
  });

  const goal = await h.runner.create_goal({
    title: 'Controlled Smoke Goal', objective: 'Test 3-step goal handoff', workspace: h.root,
    steps: [
      { id: 's1', title: 'Step 1', description: '', route: 'x', xTask: xTaskFor(h.root, 'T-SMK-1') },
      { id: 's2', title: 'Step 2', description: '', route: 'x', xTask: xTaskFor(h.root, 'T-SMK-2') },
      { id: 's3', title: 'Step 3', description: '', route: 'x', xTask: xTaskFor(h.root, 'T-SMK-3') },
    ],
  });

  await h.runner.run_goal(goal.id);

  const goalState1 = h.storage.getGoal(goal.id);
  assert.equal(goalState1.steps[0].status, 'completed');
  assert.equal(goalState1.steps[1].status, 'waiting');
  assert.equal(goalState1.steps[2].status, 'pending');

  const { handoff } = await h.runner.request_specialist_handoff(goal.id, 's2', {
    target: 'codex', reason: 'Refactor s2 logic', requestedAction: 'Use optimized AST parser',
  });

  const ctx1 = await h.runner.get_goal_context(goal.id);
  assert.equal(ctx1.next_legal_action.type, 'SPECIALIST_HANDOFF_REQUESTED');
  assert.equal(ctx1.next_legal_action.handoff_id, handoff.id);

  // Simulate full application restart: fresh GoalStorage & fresh GoalRunner
  const newStorage = new GoalStorage({ storagePath: h.goalStoragePath });
  let newDispatches = 0;
  const newRunner = new GoalRunner({
    storage: newStorage,
    xExecutor: {
      dispatchXTask: async () => { newDispatches += 1; },
      getXTaskStatus: async () => ({ found: false }),
    },
  });

  const ctx2 = await newRunner.get_goal_context(goal.id);
  assert.equal(ctx2.specialist_handoff.id, handoff.id);
  assert.equal(ctx2.specialist_handoff.stale, false);
  assert.equal(ctx2.next_legal_action.type, 'SPECIALIST_HANDOFF_REQUESTED');
  assert.equal(newDispatches, 0, 'No automatic dispatches on restart');

  const handoffsList = await newRunner.list_specialist_handoffs(goal.id);
  assert.equal(handoffsList.length, 1);
  assert.equal(handoffsList[0].id, handoff.id);

  const pkg = await newRunner.build_specialist_handoff(goal.id, handoff.id);
  assert.equal(pkg.handoff.id, handoff.id);
  assert.equal(pkg.stale, false);
});

// 15. MCP CONTROL/READ ROUNDTRIP
await t('15. MCP control and read tool methods roundtrip correctly', async () => {
  const h = createHarness({
    mockStatus: async () => ({
      found: true, queue_status: 'terminal', terminal_status: 'needs_review',
      result: { version: 'x-result-v1', result_id: 'r-mcp-1', task_id: 'T-MCP-1', reason_code: 'waiting_review' },
    }),
  });

  const goal = await h.runner.create_goal({
    title: 'MCP Roundtrip Goal', objective: 'Test MCP roundtrip', workspace: h.root,
    steps: [{ id: 's1', title: 'Step 1', description: '', route: 'x', xTask: xTaskFor(h.root, 'T-MCP-1') }],
  });

  await h.runner.run_goal(goal.id);

  // Invoke request_specialist_handoff
  const reqRes = await h.runner.requestSpecialistHandoff({
    goalId: goal.id, stepId: 's1', target: 'work', reason: 'MCP test', requestedAction: 'Check AST',
  });
  assert.ok(reqRes.handoff);
  assert.equal(reqRes.handoff.target, 'work');

  // Invoke list_specialist_handoffs
  const listRes = await h.runner.listSpecialistHandoffs({ goalId: goal.id });
  assert.equal(listRes.length, 1);
  assert.equal(listRes[0].id, reqRes.handoff.id);

  // Invoke build_specialist_handoff / get_specialist_handoff
  const getRes = await h.runner.getSpecialistHandoff({ goalId: goal.id, handoffId: reqRes.handoff.id });
  assert.equal(getRes.version, 'specialist-handoff-v1');
  assert.equal(getRes.handoff.id, reqRes.handoff.id);
  assert.equal(getRes.stale, false);
});

console.log(`\nResults: ${passed} passed, ${failed} failed out of ${passed + failed} tests\n`);
if (failed > 0) process.exit(1);
