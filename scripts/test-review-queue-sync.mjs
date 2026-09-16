// Focused tests for mcp/bridge/review-queue-sync.mjs: the visibility-only,
// write-only remote projection of the local Review Queue onto Project X's
// public.review_items table. Uses the REAL production module (never a
// hand-copied reimplementation) plus a REAL GoalStorage/GoalRunner for the
// integration-style tests, exactly like scripts/test-goal-review-queue.mjs
// does for GoalRunner itself.
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ReviewItemsClient,
  projectReviewItemForRemote,
  syncReviewItemToRemote,
  resyncPendingReviewItems,
} from '../mcp/bridge/review-queue-sync.mjs';
import { createReviewQueueItem } from '../mcp/goals/model.mjs';
import { GoalStorage } from '../mcp/goals/storage.mjs';
import { GoalRunner } from '../mcp/goals/runner.mjs';
import { X_TASK_VERSION } from '../mcp/x/task-contract.mjs';

const fixtures = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-review-sync-'));
  fixtures.push(root);
  return root;
}
afterEach(() => { for (const root of fixtures.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

/**
 * Minimal PostgREST-shaped mock for public.review_items ONLY -- if
 * anything ever POSTs/PATCHes/GETs a path containing "/tasks", it is
 * recorded as a violation rather than served, so tests can assert
 * "no public.tasks row is created or modified" directly against real
 * request traffic instead of by absence of a spy call.
 */
function createMockReviewItemsTransport({ failNextN = 0 } = {}) {
  const rows = new Map();
  const calls = [];
  let remainingFailures = failNextN;
  const tasksTouched = [];
  const mockFetch = async (urlStr, options = {}) => {
    const url = new URL(urlStr);
    calls.push({ url: urlStr, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null, headers: options.headers });
    if (url.pathname.includes('/tasks')) {
      tasksTouched.push(urlStr);
      return { ok: false, status: 404, json: async () => ({ error: 'unexpected public.tasks access in review-queue-sync test' }), text: async () => 'not found' };
    }
    if (!url.pathname.endsWith('/review_items')) {
      return { ok: false, status: 404, json: async () => ({ error: 'not found' }), text: async () => 'not found' };
    }
    if (remainingFailures > 0) {
      remainingFailures -= 1;
      return { ok: false, status: 500, json: async () => ({ error: 'simulated transient failure' }), text: async () => 'simulated transient failure' };
    }
    if ((options.method || 'GET') === 'POST') {
      const body = JSON.parse(options.body || '{}');
      rows.set(body.id, { ...(rows.get(body.id) || {}), ...body });
      return { ok: true, status: 201, json: async () => [rows.get(body.id)], text: async () => JSON.stringify([rows.get(body.id)]) };
    }
    return { ok: true, status: 200, json: async () => Array.from(rows.values()), text: async () => JSON.stringify(Array.from(rows.values())) };
  };
  return { fetch: mockFetch, rows, calls, tasksTouched };
}

function clientFor(transport, overrides = {}) {
  const client = new ReviewItemsClient({
    supabaseUrl: 'https://pavrugcmxdgdxrjinzlm.supabase.co',
    supabaseAnonKey: 'anon-key',
    fetchFn: transport.fetch,
    ...overrides,
  });
  client.setSession({ accessToken: 'owner-token', ownerId: 'owner-1' });
  return client;
}

const xTaskFor = (root, taskId) => ({
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
  why_this_matters: 'Review Queue remote-sync regression coverage.',
  known_evidence: [],
  suspected_area: [],
  workspace: { repo: 'fixture', root },
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
});

const makeMockXExecutor = () => {
  const dispatchLog = [];
  const statuses = new Map();
  return {
    dispatchLog, statuses,
    dispatchXTask: async ({ requestId, task, action }) => {
      dispatchLog.push({ requestId, task, action });
      return { accepted: true };
    },
    getXTaskStatus: async (requestId) => statuses.get(requestId) || { found: false, queue_status: undefined },
  };
};

console.log('\n=== Review Queue Remote Sync Test Suite ===\n');
let passed = 0;
let failed = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); passed += 1; }
  catch (err) { console.error(`  FAIL  ${name}: ${err.stack || err.message}`); failed += 1; }
};

// ── 1 & 2. Projection preserves allowed fields, excludes forbidden ones ────
await t('1/2. projection preserves allowed fields exactly and includes no forbidden fields', async () => {
  const item = createReviewQueueItem({
    idempotencyKey: 'run-123', stepId: 'step-1', taskId: 'TASK-1', runId: 'run-123',
    resultId: 'result-1', status: 'needs_review', reason: 'supervisor_review',
    evidence: { requestId: 'goal:g:step:step-1', queueId: 'q1', runId: 'run-123', resultId: 'result-1', gateStatus: 'NEEDS_REVIEW', hearthOutcome: 'waiting' },
  });
  const projected = projectReviewItemForRemote(item, { goalId: 'goal-1', goalTitle: 'My Goal' });

  assert.deepEqual(projected, {
    id: 'run-123',
    goal_id: 'goal-1',
    goal_title: 'My Goal',
    step_id: 'step-1',
    task_id: 'TASK-1',
    run_id: 'run-123',
    result_id: 'result-1',
    status: 'needs_review',
    reason: 'supervisor_review',
    evidence: { requestId: 'goal:g:step:step-1', queueId: 'q1', runId: 'run-123', resultId: 'result-1', gateStatus: 'NEEDS_REVIEW', hearthOutcome: 'waiting' },
    local_created_at: item.createdAt,
    local_updated_at: item.updatedAt,
  });

  const forbidden = ['transcript', 'rawTranscript', 'chainOfThought', 'chain_of_thought', 'prompt', 'token', 'secret', 'credential', 'apiKey', 'api_key'];
  const serialized = JSON.stringify(projected).toLowerCase();
  for (const word of forbidden) assert.equal(serialized.includes(word.toLowerCase()), false, `forbidden field/word '${word}' must never appear in the projection`);
});

// ── 3 & 4. First sync creates one row; replay upserts the SAME row ────────
await t('3/4. first sync creates exactly one remote row; replay upserts the same row without duplicating', async () => {
  const transport = createMockReviewItemsTransport();
  const client = clientFor(transport);
  const item = createReviewQueueItem({ idempotencyKey: 'run-abc', stepId: 's1', status: 'failed', reason: 'boom' });

  const first = await syncReviewItemToRemote({ client, item, goalId: 'g1', goalTitle: 'Goal One' });
  assert.equal(first, true);
  assert.equal(transport.rows.size, 1);
  assert.equal(transport.rows.get('run-abc').status, 'failed');

  // Replay: same idempotencyKey, slightly updated content (simulating an
  // updatedAt bump) -- must upsert the SAME row, never create a second one.
  const updatedItem = { ...item, updatedAt: new Date(Date.now() + 1000).toISOString() };
  const second = await syncReviewItemToRemote({ client, item: updatedItem, goalId: 'g1', goalTitle: 'Goal One' });
  assert.equal(second, true);
  assert.equal(transport.rows.size, 1, 'a replayed sync must never create a second remote row');
  assert.equal(transport.rows.get('run-abc').id, 'run-abc');
});

// ── 5, 6 & 7. Sync failure never mutates local item / Goal state / dispatches X
await t('5/6/7. a sync failure never mutates the local review item, Goal state, or dispatches X', async () => {
  const transport = createMockReviewItemsTransport({ failNextN: 999 }); // always fails
  const client = clientFor(transport);

  const storage = new GoalStorage({ storagePath: path.join(fixture(), 'goals.json') });
  const xExecutor = makeMockXExecutor();
  const runner = new GoalRunner({
    storage, xExecutor,
    onReviewItemPersisted: (item, goal) => { void syncReviewItemToRemote({ client, item, goalId: goal.id, goalTitle: goal.title }); },
  });

  const workspace = fixture();
  const goal = await runner.create_goal({
    title: 'Sync Failure Goal', objective: 'x', workspace,
    steps: [{ id: 's1', title: 'S1', description: '', route: 'x', xTask: xTaskFor(workspace, 'TASK-SYNCFAIL'), required: true }],
  });

  const requestId = `goal:${goal.id}:step:s1`;
  xExecutor.statuses.set(requestId, { found: true, queue_status: 'terminal', terminal_status: 'failed', error: 'x failed', run_id: 'run-syncfail' });

  const beforeSnapshot = JSON.stringify(storage.getGoal(goal.id));
  const finished = await runner.run_goal(goal.id);

  // Give the fire-and-forget sync a moment to actually attempt (and fail).
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(finished.status, 'error');
  assert.equal(finished.reviewQueue.length, 1, 'the LOCAL review item must still exist despite the remote sync failing');
  assert.equal(finished.reviewQueue[0].status, 'failed');
  assert.equal(transport.rows.size, 0, 'the failed sync must never have actually written a remote row');
  assert.equal(xExecutor.dispatchLog.length, 1, 'a sync failure must never trigger an extra X dispatch');

  // Local state (minus the review item/checkpoint this run itself added)
  // was never rolled back or otherwise mutated by the sync failure -- the
  // goal's OWN steps/xTask content is untouched.
  const before = JSON.parse(beforeSnapshot);
  assert.deepEqual(finished.steps[0].xTask, before.steps[0].xTask);
});

// ── 8. Reconnect/startup resync retries durable items ───────────────────────
await t('8. reconnect/startup resync (resyncPendingReviewItems) retries every durable local item', async () => {
  const transport = createMockReviewItemsTransport();
  const client = clientFor(transport);
  const storage = new GoalStorage({ storagePath: path.join(fixture(), 'goals.json') });
  const runner = new GoalRunner({ storage }); // no onReviewItemPersisted -- simulates items that were created while offline/unsynced

  const workspace = fixture();
  const goalA = await runner.create_goal({ title: 'A', objective: 'x', workspace, steps: [{ title: 'S1', description: '', route: 'manual' }] });
  const goalB = await runner.create_goal({ title: 'B', objective: 'x', workspace, steps: [{ title: 'S1', description: '', route: 'manual' }] });

  const gA = storage.getGoal(goalA.id);
  runner.recordReviewItem(gA, { stepId: gA.steps[0].id, status: 'failed', reason: 'a' });
  storage.saveGoal(gA);
  const gB = storage.getGoal(goalB.id);
  runner.recordReviewItem(gB, { stepId: gB.steps[0].id, status: 'needs_review', reason: 'b' });
  storage.saveGoal(gB);

  assert.equal(transport.rows.size, 0, 'nothing synced yet');
  const result = await resyncPendingReviewItems({ client, goalRunner: runner });
  assert.equal(result.attempted, 2);
  assert.equal(result.succeeded, 2);
  assert.equal(transport.rows.size, 2, 'both durable local items must now be synced');
});

// ── 9. Restart/replay produces the same remote id ───────────────────────────
await t('9. restart/replay produces the SAME remote row id as the original sync', async () => {
  const transport = createMockReviewItemsTransport();
  const client = clientFor(transport);
  const storagePath = path.join(fixture(), 'goals.json');
  const storage = new GoalStorage({ storagePath });
  const runner = new GoalRunner({ storage });
  const workspace = fixture();
  const goal = await runner.create_goal({ title: 'Restart Goal', objective: 'x', workspace, steps: [{ title: 'S1', description: '', route: 'manual' }] });
  const g = storage.getGoal(goal.id);
  const item = runner.recordReviewItem(g, { stepId: g.steps[0].id, status: 'failed', reason: 'r' });
  storage.saveGoal(g);

  await syncReviewItemToRemote({ client, item, goalId: goal.id, goalTitle: goal.title });
  const firstRemoteId = [...transport.rows.keys()][0];
  assert.equal(firstRemoteId, item.idempotencyKey);

  // Simulate a restart: fresh GoalStorage/GoalRunner over the SAME file.
  const restartedStorage = new GoalStorage({ storagePath });
  const restartedRunner = new GoalRunner({ storage: restartedStorage });
  const resynced = await resyncPendingReviewItems({ client, goalRunner: restartedRunner });
  assert.equal(resynced.attempted, 1);
  assert.equal(transport.rows.size, 1, 'restart/replay must resolve to the SAME remote row, never a second one');
  assert.equal([...transport.rows.keys()][0], firstRemoteId);
});

// ── 10. No public.tasks row is ever created or modified ────────────────────
await t('10. no public.tasks row is ever created or modified by review-queue-sync', async () => {
  const transport = createMockReviewItemsTransport();
  const client = clientFor(transport);
  const item = createReviewQueueItem({ idempotencyKey: 'run-notasks', stepId: 's1', status: 'failed', reason: 'x' });
  await syncReviewItemToRemote({ client, item, goalId: 'g1', goalTitle: 'G' });
  await resyncPendingReviewItems({ client, goalRunner: { list_review_queue: () => [item] } });
  assert.deepEqual(transport.tasksTouched, [], 'no request should ever target public.tasks');
  for (const call of transport.calls) assert.ok(!call.url.includes('/tasks'), `request must never target /tasks: ${call.url}`);
});

// ── 11. No X -> Anti fallback ───────────────────────────────────────────────
await t('11. review-queue-sync never triggers an Antigravity dispatch', async () => {
  const transport = createMockReviewItemsTransport();
  const client = clientFor(transport);
  const storage = new GoalStorage({ storagePath: path.join(fixture(), 'goals.json') });
  const xExecutor = makeMockXExecutor();
  const antigravityCalls = [];
  const runner = new GoalRunner({
    storage, xExecutor,
    antigravityExecutor: { startAntigravityTask: async (...a) => { antigravityCalls.push(a); return { taskId: 't1' }; }, getAntigravityTask: () => ({ status: 'done' }) },
    onReviewItemPersisted: (item, goal) => { void syncReviewItemToRemote({ client, item, goalId: goal.id, goalTitle: goal.title }); },
  });
  const workspace = fixture();
  const goal = await runner.create_goal({
    title: 'No Anti Goal', objective: 'x', workspace,
    steps: [{ id: 's1', title: 'S1', description: '', route: 'x', xTask: xTaskFor(workspace, 'TASK-NOANTI'), required: true }],
  });
  xExecutor.statuses.set(`goal:${goal.id}:step:s1`, { found: true, queue_status: 'terminal', terminal_status: 'needs_review', run_id: 'run-noanti', result: { version: 'x-result-v1', result_id: 'r1', task_id: 'TASK-NOANTI', waiting_reason: 'x', reason_code: 'y' } });
  await runner.run_goal(goal.id, { permissions: { Antigravity: 'Allow' } });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(antigravityCalls.length, 0);
});

// ── additional: user_id is stamped from the session, never trusted from payload
await t('additional: upsertReviewItem stamps user_id from the authenticated session, never from caller-supplied data', async () => {
  const transport = createMockReviewItemsTransport();
  const client = clientFor(transport);
  await client.upsertReviewItem({ id: 'run-xyz', status: 'failed', user_id: 'attacker-supplied-id' });
  assert.equal(transport.rows.get('run-xyz').user_id, 'owner-1', 'user_id must always be the authenticated ownerId, never trusted from the payload');
});

console.log(`\nResults: ${passed} passed, ${failed} failed out of ${passed + failed} tests\n`);
if (failed > 0) process.exit(1);
