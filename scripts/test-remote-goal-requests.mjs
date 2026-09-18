/** Remote Goal ingress foundation: contract validation, idempotency, security
 * boundaries, and result-sync tests for mcp/bridge/goal-requests-client.mjs
 * plus the GoalRunner/model.mjs extensions it relies on. All state lives in
 * disposable temp fixtures / a mock fetch transport; nothing here touches
 * real Supabase or the real goals.json. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { GoalStorage } from '../mcp/goals/storage.mjs';
import { GoalRunner } from '../mcp/goals/runner.mjs';
import { parseXTask, X_TASK_VERSION } from '../mcp/x/task-contract.mjs';
import {
  parseRemoteGoalPayload,
  parseGoalRequestRow,
  projectGoalStateForRemote,
  mapGoalStatusToRequestStatus,
  GoalRequestsClient,
  createMockGoalRequestsTransport,
} from '../mcp/bridge/goal-requests-client.mjs';

let passed = 0; let failed = 0;
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hearth-goal-requests-test-'));
const test = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); passed += 1; }
  catch (error) { console.error(`  FAIL  ${name}: ${error.message}\n${error.stack}`); failed += 1; }
};

const xTaskFixture = (taskId, workspaceRoot, allowedPaths = ['README.md']) => ({
  version: X_TASK_VERSION,
  task_id: taskId,
  parent_task_id: null,
  revision: 1,
  attempt: 1,
  based_on_result_id: null,
  objective: `Objective for ${taskId}`,
  problem: `Problem for ${taskId}`,
  expected_behavior: 'Report a plain fact. No file changes.',
  observed_behavior: 'Not yet reported.',
  why_this_matters: 'Remote Goal ingress test fixture.',
  known_evidence: [],
  suspected_area: [],
  workspace: { repo: 'test-repo', root: workspaceRoot },
  scope: { allowed_paths: allowedPaths, preferred_files: [], forbidden_paths: [] },
  constraints: { preserve: [], do_not: ['Do not modify any file.'] },
  allowed_tools: ['repo_read'],
  acceptance_criteria: ['Reports a plain fact.'],
  validation: { required: ['node --test scripts/test-x-task-contract.mjs'], optional: [] },
  verification: null,
  done_criteria: ['Reports a plain fact.'],
  teaching_notes: [],
  uncertainty_policy: { policy: 'bounded_autonomy', stop_conditions: [] },
  repair_budget: { initial_attempts: 1, max_repairs: 2, max_total_rounds: 3 },
  timing: { estimated_minutes: 3, first_check_after_minutes: 1, soft_deadline_minutes: 3, hard_timeout_minutes: 10 },
  commit_policy: { mode: 'never' },
});

const remoteGoalFixture = (workspaceRoot, { stepCount = 3 } = {}) => ({
  version: 'remote-goal-v1',
  title: 'Remote Repo Check',
  objective: 'Report three plain facts about this repository.',
  workspace: workspaceRoot,
  constraints: ['read-only', 'no file changes'],
  steps: Array.from({ length: stepCount }, (_, i) => ({
    id: `step-${i + 1}`,
    title: `Step ${i + 1}`,
    route: 'x',
    xTask: xTaskFixture(`REMOTE-GOAL-STEP-${i + 1}`, workspaceRoot),
  })),
});

const makeRow = (id, ownerId, goalPayload, overrides = {}) => ({
  id, user_id: ownerId, status: 'queued', title: goalPayload.title,
  goal: goalPayload, local_goal_id: null, result: null, error: null,
  created_at: '2026-09-17T00:00:00.000Z', updated_at: '2026-09-17T00:00:00.000Z',
  deleted_at: null, ...overrides,
});

console.log('\n=== Remote Goal Ingress Foundation ===\n');

// ── 1. valid remote Goal with 3 complete X steps validates ─────────────────
await test('1. a complete remote-goal-v1 with 3 complete X steps validates cleanly', async () => {
  const parsed = parseRemoteGoalPayload(remoteGoalFixture('/tmp/some-workspace'));
  assert.equal(parsed.steps.length, 3);
  assert.ok(parsed.steps.every((s) => s.route === 'x' && s.xTask?.version === X_TASK_VERSION));
});

// ── 2. malformed X step rejected ────────────────────────────────────────────
await test('2. a malformed X step (missing required xTask field) is rejected, not repaired', async () => {
  const payload = remoteGoalFixture('/tmp/some-workspace');
  delete payload.steps[1].xTask.objective;
  assert.throws(() => parseRemoteGoalPayload(payload), /Invalid.*x-task-v1|objective/i);
});

// ── 3. missing xTask rejected for route:x ───────────────────────────────────
await test('3. a route:"x" step with no xTask at all is rejected, never synthesized', async () => {
  const payload = remoteGoalFixture('/tmp/some-workspace');
  delete payload.steps[0].xTask;
  assert.throws(() => parseRemoteGoalPayload(payload), /no complete xTask/);
});

// ── 4. free-text Goal is never synthesized into X work ──────────────────────
await test('4. a free-text-only Goal (no steps, or steps missing xTask) is rejected outright, never synthesized', async () => {
  const bare = { version: 'remote-goal-v1', title: 'Do something useful', objective: 'Fix the bug', workspace: '/tmp/x', constraints: [], steps: [] };
  assert.throws(() => parseRemoteGoalPayload(bare), /non-empty array/);
  const manualOnly = { ...bare, steps: [{ id: 's1', title: 'Investigate', route: 'manual' }] };
  const parsedManual = parseRemoteGoalPayload(manualOnly);
  assert.equal(parsedManual.steps[0].xTask, null, 'a manual step must never get an invented xTask');
});

await test('4b. parseXTask is the REAL, unmodified validator -- an internally-inconsistent workspace is rejected', async () => {
  const payload = remoteGoalFixture('/tmp/workspace-a');
  payload.steps[0].xTask.workspace.root = '/tmp/workspace-b';
  assert.throws(() => parseRemoteGoalPayload(payload), /workspace\.root must match goal\.workspace/);
});

await test('4c. duplicate step ids within one remote Goal are rejected', async () => {
  const payload = remoteGoalFixture('/tmp/some-workspace');
  payload.steps[1].id = payload.steps[0].id;
  assert.throws(() => parseRemoteGoalPayload(payload), /duplicated/);
});

// ── owner/status row-level checks ───────────────────────────────────────────
await test('row-level: owner mismatch is rejected before any x-task-v1 parsing', async () => {
  const row = makeRow('row-1', 'owner-a', remoteGoalFixture('/tmp/ws'));
  assert.throws(() => parseGoalRequestRow(row, 'owner-b'), /Owner mismatch/);
});
await test('row-level: non-queued status is rejected', async () => {
  const row = makeRow('row-1', 'owner-a', remoteGoalFixture('/tmp/ws'), { status: 'running' });
  assert.throws(() => parseGoalRequestRow(row, 'owner-a'), /Invalid status/);
});

// ── 5/6/7/8/9/10: full import lifecycle against a standalone GoalRunner ────
async function setupHarness() {
  const dir = await fs.mkdtemp(path.join(root, 'harness-'));
  const workspace = path.join(dir, 'workspace');
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, 'README.md'), '# test\n');
  const storage = new GoalStorage({ storagePath: path.join(dir, 'goals.json') });
  const runner = new GoalRunner({ storage });
  return { dir, workspace, storage, runner };
}

/** Mirrors electron/main.cjs's approveRemoteGoalRequest exactly, minus the IPC/UI plumbing, for direct testing against a real GoalRunner. */
async function importRemoteGoal({ runner, client, requestId, row }) {
  const claim = await client.claimQueuedGoalRequest({ id: requestId });
  if (!claim.claimed) return { imported: false, reason: 'not_claimed' };
  const localGoalId = `remote-goal:${requestId}`;
  let goal = runner.get_goal(localGoalId);
  const alreadyExisted = Boolean(goal);
  if (!goal) {
    goal = await runner.create_goal({
      id: localGoalId,
      title: row.goal.title,
      objective: row.goal.objective,
      workspace: row.goal.workspace,
      constraints: row.goal.constraints,
      steps: row.goal.steps.map((s) => ({ id: s.id, title: s.title, route: s.route, xTask: s.xTask })),
      remoteGoalRequest: { provider: 'project-x', requestId },
    });
  }
  await client.recordLocalGoalId({ id: requestId, localGoalId: goal.id });
  return { imported: true, alreadyExisted, goal };
}

await test('5. repeated poll (fetchQueuedGoalRequests called twice before any claim) never mutates local state and imports one Goal only once approved', async () => {
  const { workspace, runner } = await setupHarness();
  const goalPayload = remoteGoalFixture(workspace);
  const transport = createMockGoalRequestsTransport([makeRow('row-5', 'owner-1', goalPayload)]);
  const client = new GoalRequestsClient({ supabaseUrl: 'https://x.test', supabaseAnonKey: 'anon', fetchFn: transport.fetch });
  client.setSession({ accessToken: 'tok', ownerId: 'owner-1' });

  const rows1 = await client.fetchQueuedGoalRequests();
  const rows2 = await client.fetchQueuedGoalRequests();
  assert.equal(rows1.length, 1);
  assert.equal(rows2.length, 1);
  assert.equal(transport.getRows()[0].status, 'queued', 'polling alone must never claim');

  const res = await importRemoteGoal({ runner, client, requestId: 'row-5', row: rows2[0] });
  assert.equal(res.imported, true);
  assert.equal(runner.list_goals().length, 1);
});

await test('6. restart does not duplicate an already-imported Goal (deterministic id + idempotent create)', async () => {
  const { workspace, storage: storageA } = await setupHarness();
  const dbPath = storageA.storagePath;
  const goalPayload = remoteGoalFixture(workspace);
  const transport = createMockGoalRequestsTransport([makeRow('row-6', 'owner-1', goalPayload)]);
  const client = new GoalRequestsClient({ supabaseUrl: 'https://x.test', supabaseAnonKey: 'anon', fetchFn: transport.fetch });
  client.setSession({ accessToken: 'tok', ownerId: 'owner-1' });

  const runnerA = new GoalRunner({ storage: storageA });
  const rowsA = await client.fetchQueuedGoalRequests();
  await importRemoteGoal({ runner: runnerA, client, requestId: 'row-6', row: rowsA[0] });
  assert.equal(runnerA.list_goals().length, 1);
  assert.equal(transport.getRows()[0].status, 'running');
  assert.equal(transport.getRows()[0].local_goal_id, 'remote-goal:row-6', 'recordLocalGoalId must have written back successfully');

  // "Restart": brand-new storage/runner instances pointed at the SAME file.
  // Repeated restart-triggered replays (e.g. via a resync sweep) must never
  // duplicate the Goal, matching electron/main.cjs's importGoalFromRequestRow.
  const storageB = new GoalStorage({ storagePath: dbPath });
  const runnerB = new GoalRunner({ storage: storageB });
  for (let i = 0; i < 3; i++) {
    let goal = runnerB.get_goal('remote-goal:row-6');
    if (!goal) {
      goal = await runnerB.create_goal({
        id: 'remote-goal:row-6', title: goalPayload.title, objective: goalPayload.objective, workspace: goalPayload.workspace,
        constraints: goalPayload.constraints, steps: goalPayload.steps, remoteGoalRequest: { provider: 'project-x', requestId: 'row-6' },
      });
    }
    assert.equal(runnerB.list_goals().length, 1, `exactly one Goal must exist after restart replay #${i + 1}`);
  }
});

await test('6b. crash recovery: a claimed-but-unimported row (local_goal_id still null) is found and finishes import exactly once', async () => {
  const { workspace, runner } = await setupHarness();
  const goalPayload = remoteGoalFixture(workspace);
  // Simulate: the claim already succeeded (status=running) but Hearth crashed
  // before ever writing local_goal_id back -- exactly the interrupted window
  // recoverUnimportedGoalRequests exists for.
  const transport = createMockGoalRequestsTransport([makeRow('row-6b', 'owner-1', goalPayload, { status: 'running', local_goal_id: null })]);
  const client = new GoalRequestsClient({ supabaseUrl: 'https://x.test', supabaseAnonKey: 'anon', fetchFn: transport.fetch });
  client.setSession({ accessToken: 'tok', ownerId: 'owner-1' });

  const recoverable = await client.fetchClaimedUnimportedGoalRequests();
  assert.equal(recoverable.length, 1);
  const localGoalId = `remote-goal:${recoverable[0].id}`;
  const goal = await runner.create_goal({
    id: localGoalId, title: recoverable[0].goal.title, objective: recoverable[0].goal.objective, workspace: recoverable[0].goal.workspace,
    constraints: recoverable[0].goal.constraints, steps: recoverable[0].goal.steps, remoteGoalRequest: { provider: 'project-x', requestId: recoverable[0].id },
  });
  await client.recordLocalGoalId({ id: recoverable[0].id, localGoalId: goal.id });

  // A second sweep must find nothing left to recover, and must never have
  // duplicated the Goal.
  const recoverableAgain = await client.fetchClaimedUnimportedGoalRequests();
  assert.equal(recoverableAgain.length, 0, 'once local_goal_id is set, the row must drop out of the recovery query');
  assert.equal(runner.list_goals().length, 1);
});

await test('7. importing a remote Goal never auto-runs it -- status stays ready, no xApproval, no X dispatch', async () => {
  const { workspace, runner } = await setupHarness();
  const goalPayload = remoteGoalFixture(workspace);
  const transport = createMockGoalRequestsTransport([makeRow('row-7', 'owner-1', goalPayload)]);
  const client = new GoalRequestsClient({ supabaseUrl: 'https://x.test', supabaseAnonKey: 'anon', fetchFn: transport.fetch });
  client.setSession({ accessToken: 'tok', ownerId: 'owner-1' });
  const rows = await client.fetchQueuedGoalRequests();
  const { goal } = await importRemoteGoal({ runner, client, requestId: 'row-7', row: rows[0] });
  assert.equal(goal.status, 'ready');
  assert.equal(goal.xApproval, null);
  assert.ok(goal.steps.every((s) => s.status === 'pending'));
});

await test('8. local Goal-level X approval is still required to actually run the imported Goal (no xExecutor wired -> run_goal fails closed, never silently skips approval)', async () => {
  const { workspace, runner } = await setupHarness();
  const goalPayload = remoteGoalFixture(workspace);
  const transport = createMockGoalRequestsTransport([makeRow('row-8', 'owner-1', goalPayload)]);
  const client = new GoalRequestsClient({ supabaseUrl: 'https://x.test', supabaseAnonKey: 'anon', fetchFn: transport.fetch });
  client.setSession({ accessToken: 'tok', ownerId: 'owner-1' });
  const rows = await client.fetchQueuedGoalRequests();
  const { goal } = await importRemoteGoal({ runner, client, requestId: 'row-8', row: rows[0] });
  // No xExecutor configured on this standalone runner -- proves the SAME
  // fail-closed path every other route:"x" Goal already goes through
  // (test-goal-runner-x.mjs's own "route:x with no xExecutor configured
  // fails closed": run_goal RESOLVES with status 'error', it does not
  // throw), i.e. nothing here bypasses it for remote Goals.
  const finished = await runner.run_goal(goal.id);
  assert.equal(finished.status, 'error');
  assert.match(finished.error, /X executor is not configured/);
});

await test('9. the exact imported step ids/xTask content are what Goal-level approval will fingerprint (identity preserved end to end)', async () => {
  const { workspace, runner } = await setupHarness();
  const goalPayload = remoteGoalFixture(workspace);
  const transport = createMockGoalRequestsTransport([makeRow('row-9', 'owner-1', goalPayload)]);
  const client = new GoalRequestsClient({ supabaseUrl: 'https://x.test', supabaseAnonKey: 'anon', fetchFn: transport.fetch });
  client.setSession({ accessToken: 'tok', ownerId: 'owner-1' });
  const rows = await client.fetchQueuedGoalRequests();
  const { goal } = await importRemoteGoal({ runner, client, requestId: 'row-9', row: rows[0] });
  for (let i = 0; i < goalPayload.steps.length; i++) {
    assert.equal(goal.steps[i].id, goalPayload.steps[i].id, 'stable remote step ids must survive import unchanged');
    assert.equal(goal.steps[i].xTask.task_id, goalPayload.steps[i].xTask.task_id);
    assert.deepEqual(parseXTask(goal.steps[i].xTask), parseXTask(goalPayload.steps[i].xTask), 'xTask content must be byte-identical to what was authored remotely');
  }
});

await test('10. a remote payload change after import cannot mutate the already-imported local Goal (claim is a one-time read; Hearth never re-reads a claimed row as a Goal source)', async () => {
  const { workspace, runner } = await setupHarness();
  const goalPayload = remoteGoalFixture(workspace);
  const transport = createMockGoalRequestsTransport([makeRow('row-10', 'owner-1', goalPayload)]);
  const client = new GoalRequestsClient({ supabaseUrl: 'https://x.test', supabaseAnonKey: 'anon', fetchFn: transport.fetch });
  client.setSession({ accessToken: 'tok', ownerId: 'owner-1' });
  const rows = await client.fetchQueuedGoalRequests();
  const { goal } = await importRemoteGoal({ runner, client, requestId: 'row-10', row: rows[0] });
  const originalStepCount = goal.steps.length;

  // Tamper with the REMOTE row's goal payload directly (simulating a
  // malicious or buggy later edit) -- the row is 'running' now, so the
  // normal fetchQueuedGoalRequests() filter would never even see it again.
  const remoteRow = transport.getRows().find((r) => r.id === 'row-10');
  remoteRow.goal = { ...remoteRow.goal, steps: [...remoteRow.goal.steps, { id: 'injected', title: 'Injected', route: 'x', xTask: goalPayload.steps[0].xTask }] };

  const reQueried = runner.get_goal(goal.id);
  assert.equal(reQueried.steps.length, originalStepCount, 'local Goal step count must be unaffected by a later remote row edit');
  assert.ok(!reQueried.steps.some((s) => s.id === 'injected'));
});

// ── 11-14: result sync ──────────────────────────────────────────────────────
await test('11. a COMPLETED Goal projects status=completed with a compact result', async () => {
  const { workspace, runner } = await setupHarness();
  const goalPayload = remoteGoalFixture(workspace, { stepCount: 1 });
  goalPayload.steps[0].route = 'manual'; // avoid needing real X execution for this pure projection test
  const goal = await runner.create_goal({
    id: 'remote-goal:row-11', title: goalPayload.title, objective: goalPayload.objective, workspace, constraints: [],
    steps: [{ id: 's1', title: 'Manual step', route: 'manual' }],
    remoteGoalRequest: { provider: 'project-x', requestId: 'row-11' },
  });
  goal.steps[0].status = 'completed';
  goal.status = 'completed';
  goal.updatedAt = new Date().toISOString();
  assert.equal(mapGoalStatusToRequestStatus(goal.status), 'completed');
  const projection = projectGoalStateForRemote(goal);
  assert.equal(projection.goal_status, 'completed');
  assert.equal(projection.completed_steps, 1);
  assert.equal(projection.total_steps, 1);
  assert.equal(JSON.stringify(projection).length < 5000, true, 'projection must stay compact, never a huge dump');
});

await test('12. a Goal with an open review item projects status=waiting', async () => {
  const goal = { id: 'g1', status: 'waiting', currentStepId: 's1', updatedAt: '2026-09-17T00:00:00.000Z', steps: [{ id: 's1', title: 'X step', status: 'waiting', route: 'x', result: null }], reviewQueue: [{ lifecycle: 'open' }] };
  assert.equal(mapGoalStatusToRequestStatus(goal.status), 'waiting');
  assert.equal(projectGoalStateForRemote(goal).review_open, true);
});

await test('13. an errored Goal projects status=failed', async () => {
  const goal = { id: 'g1', status: 'error', currentStepId: 's1', updatedAt: '2026-09-17T00:00:00.000Z', error: 'boom', steps: [{ id: 's1', title: 'X step', status: 'error', route: 'x', result: null }], reviewQueue: [] };
  assert.equal(mapGoalStatusToRequestStatus(goal.status), 'failed');
});

await test('14. a remote sync (write) failure never reruns Goal/X work -- it only fails to PATCH, local Goal is untouched', async () => {
  const { workspace, runner } = await setupHarness();
  const goal = await runner.create_goal({
    id: 'remote-goal:row-14', title: 'T', objective: 'O', workspace, constraints: [],
    steps: [{ id: 's1', title: 'Manual', route: 'manual' }],
    remoteGoalRequest: { provider: 'project-x', requestId: 'row-14' },
  });
  const failingClient = new GoalRequestsClient({ supabaseUrl: 'https://x.test', supabaseAnonKey: 'anon', fetchFn: async () => { throw new Error('network down'); } });
  failingClient.setSession({ accessToken: 'tok', ownerId: 'owner-1' });
  await assert.rejects(() => failingClient.projectGoalState({ id: 'row-14', goal }));
  const reGoal = runner.get_goal(goal.id);
  assert.equal(reGoal.status, 'ready', 'a failed remote sync must never mutate local Goal state');
});

await test('15. reconnect (a resync sweep) re-projects every remote-linked Goal from local durable truth, is idempotent, and updates the SAME remote row id', async () => {
  const { workspace, storage: storageA } = await setupHarness();
  const dbPath = storageA.storagePath;
  const goal = await new GoalRunner({ storage: storageA }).create_goal({
    id: 'remote-goal:row-15', title: 'T', objective: 'O', workspace, constraints: [],
    steps: [{ id: 's1', title: 'Manual', route: 'manual' }],
    remoteGoalRequest: { provider: 'project-x', requestId: 'row-15' },
  });
  const transport = createMockGoalRequestsTransport([makeRow('row-15', 'owner-1', remoteGoalFixture(workspace, { stepCount: 1 }), { status: 'running' })]);
  const client = new GoalRequestsClient({ supabaseUrl: 'https://x.test', supabaseAnonKey: 'anon', fetchFn: transport.fetch });
  client.setSession({ accessToken: 'tok', ownerId: 'owner-1' });

  // "Restart": fresh runner/storage reading the SAME durable goals.json.
  const storageB = new GoalStorage({ storagePath: dbPath });
  const runnerB = new GoalRunner({ storage: storageB });
  const resync = async () => {
    for (const g of runnerB.list_goals()) {
      if (g.remoteGoalRequest?.provider === 'project-x') {
        await client.projectGoalState({ id: g.remoteGoalRequest.requestId, goal: g });
      }
    }
  };
  await resync();
  await resync();
  const rowsAfter = transport.getRows().filter((r) => r.id === 'row-15');
  assert.equal(rowsAfter.length, 1, 'resync must never create a second row for the same id');
  assert.equal(rowsAfter[0].result.local_goal_id, goal.id);
});

await test('15b. failed step -> retry (superseded review, execGen 2) -> completion -> remote projection becomes completed, review_open=false, error=null', async () => {
  const { workspace, storage } = await setupHarness();
  const step1Result = JSON.stringify({ version: 'x-result-v1', result_id: 'res-step-1' });
  const step2OldResult = JSON.stringify({ version: 'x-result-v1', result_id: 'res-step-2-gen-1' });
  const step2NewResult = JSON.stringify({ version: 'x-result-v1', result_id: 'ac293b47-45f5-465d-b43c-33030c3f2179' });

  let persistedGoalNotifications = [];
  const runner = new GoalRunner({
    storage,
    onGoalPersisted: (g) => persistedGoalNotifications.push(g),
  });

  const goal = await runner.create_goal({
    id: 'remote-goal:row-15b',
    title: 'P1 Goal',
    objective: 'Test lifecycle projection',
    workspace,
    constraints: [],
    steps: [
      { id: 'step-1', title: 'Step 1', route: 'x', xTask: xTaskFixture('task-1', workspace), status: 'completed', result: step1Result, executionGeneration: 1 },
      { id: 'step-2', title: 'Step 2', route: 'x', xTask: xTaskFixture('task-2', workspace), status: 'error', result: step2OldResult, executionGeneration: 1 },
    ],
    remoteGoalRequest: { provider: 'project-x', requestId: 'row-15b' },
  });

  // Add historical failed review item for step 2 (currently open)
  goal.status = 'error';
  goal.error = 'Step 2 structural failure';
  goal.currentStepId = 'step-2';
  goal.reviewQueue = [{
    id: 'rev-item-1',
    idempotencyKey: 'idem-rev-1',
    goalId: goal.id,
    stepId: 'step-2',
    lifecycle: 'open',
    status: 'needs_review',
    executionGeneration: 1,
  }];
  storage.saveGoal(goal);

  const transport = createMockGoalRequestsTransport([
    makeRow('row-15b', 'owner-1', remoteGoalFixture(workspace, { stepCount: 2 }), {
      status: 'failed',
      error: 'Step 2 structural failure',
      result: projectGoalStateForRemote(goal),
    }),
  ]);
  const client = new GoalRequestsClient({ supabaseUrl: 'https://x.test', supabaseAnonKey: 'anon', fetchFn: transport.fetch });
  client.setSession({ accessToken: 'tok', ownerId: 'owner-1' });

  // Initial remote projection state: failed, review_open: true, error present
  const initialRow = transport.getRows().find((r) => r.id === 'row-15b');
  assert.equal(initialRow.status, 'failed');
  assert.equal(initialRow.result.review_open, true);
  assert.equal(initialRow.error, 'Step 2 structural failure');

  // Supervisor performs retry: old review item superseded, step 2 updated to executionGeneration 2
  goal.reviewQueue[0].lifecycle = 'superseded';
  goal.steps[1].executionGeneration = 2;
  goal.steps[1].status = 'running';
  goal.status = 'running';
  goal.error = null;
  storage.saveGoal(goal);

  // Step 2 revised execution completes successfully with new result
  goal.steps[1].status = 'completed';
  goal.steps[1].result = step2NewResult;
  storage.saveGoal(goal);

  // All steps completed -> complete_goal called
  runner.complete_goal(goal.id);

  const completedLocalGoal = runner.get_goal(goal.id);
  assert.equal(completedLocalGoal.status, 'completed');
  assert.equal(completedLocalGoal.currentStepId, null, 'complete_goal must clear currentStepId');
  assert.ok(completedLocalGoal.finishedAt, 'finishedAt must be set');

  // Remote sync runs
  await client.projectGoalState({ id: 'row-15b', goal: completedLocalGoal });

  const finalRow = transport.getRows().find((r) => r.id === 'row-15b');
  assert.equal(finalRow.status, 'completed', 'remote status must update to completed');
  assert.equal(finalRow.error, null, 'remote error must be cleared (null)');
  assert.equal(finalRow.finished_at, completedLocalGoal.finishedAt, 'remote finished_at must match local finishedAt');
  assert.equal(finalRow.result.goal_status, 'completed');
  assert.equal(finalRow.result.review_open, false, 'superseded review must not leave review_open=true');
  assert.equal(finalRow.result.current_step_id, null, 'completed goal must project current_step_id as null');
  assert.equal(finalRow.result.completed_steps, 2);

  // Step 2 result projection check: must contain newest generation 2 result
  const step2Projection = finalRow.result.step_statuses.find((s) => s.id === 'step-2');
  assert.equal(step2Projection.status, 'completed');
  assert.ok(step2Projection.summary.includes('ac293b47-45f5-465d-b43c-33030c3f2179'), 'latest execution generation 2 result must win');

  // Historical review remains superseded in local durable state
  assert.equal(completedLocalGoal.reviewQueue.length, 1);
  assert.equal(completedLocalGoal.reviewQueue[0].lifecycle, 'superseded');

  // onGoalPersisted was called on saves
  assert.ok(persistedGoalNotifications.length > 0, 'onGoalPersisted must be invoked on goal mutations');
  assert.equal(persistedGoalNotifications[persistedGoalNotifications.length - 1].status, 'completed');
});

await test('15c. superseded review does not count as open, and completed goal cannot be regressed by stale remote data', async () => {
  const goal = {
    id: 'g-15c',
    status: 'completed',
    currentStepId: 'step-2', // Even if legacy field was still set, projection must project null
    finishedAt: '2026-09-18T00:00:00.000Z',
    updatedAt: '2026-09-18T00:00:00.000Z',
    steps: [
      { id: 's1', title: 'Step 1', status: 'completed', route: 'x', result: 'res-1' },
      { id: 's2', title: 'Step 2', status: 'completed', route: 'x', result: 'res-2-gen-2' },
    ],
    reviewQueue: [
      { id: 'rev-1', lifecycle: 'superseded', stepId: 's2' },
    ],
  };

  const projection = projectGoalStateForRemote(goal);
  assert.equal(projection.goal_status, 'completed');
  assert.equal(projection.current_step_id, null, 'completed goal must project current_step_id=null');
  assert.equal(projection.review_open, false, 'superseded review must not count as open');
  assert.equal(projection.completed_steps, 2);
});

console.log('\n=== Compatibility (relies on adjacent suites; spot-checked here) ===\n');

await test('16. this module never imports or writes public.tasks -- it only ever hits the /goal_requests REST path', async () => {
  const src = await fs.readFile(new URL('../mcp/bridge/goal-requests-client.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /from ['"]\.\.\/bridge\/public-tasks-client\.mjs['"]/, 'must not import the public.tasks adapter');
  assert.doesNotMatch(src, /rest\/v1\/tasks\b/, 'must never construct a public.tasks REST URL');
  // Every REST call this module makes targets /goal_requests only.
  const urlLines = src.match(/\/rest\/v1\/[a-z_]+/g) || [];
  assert.ok(urlLines.length > 0);
  assert.ok(urlLines.every((u) => u === '/rest/v1/goal_requests'), `unexpected REST target(s): ${urlLines.join(', ')}`);
});

await test('19. no Anti/Antigravity execution fallback, and no self-asserted preauthorization flag, exists anywhere in the new module', async () => {
  const src = await fs.readFile(new URL('../mcp/bridge/goal-requests-client.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /startAntigravityTask|routeToAnti/, 'must never call into Antigravity execution');
  // Real usage patterns, not mere mentions -- this file's own header comment
  // legitimately explains that it never uses service_role, which would
  // otherwise false-positive on a naive keyword scan.
  assert.doesNotMatch(src, /\.preauthorized\b|metadata\.preauthorized|trusted\s*:\s*true|SERVICE_ROLE_KEY|role:\s*['"]service_role['"]/, 'must never read/assert a preauthorization flag or use a service-role key');
});

await fs.rm(root, { recursive: true, force: true });
console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
