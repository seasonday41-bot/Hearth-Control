// Focused tests for the review_queue_list MCP tool: a read-only bridge
// from mcp/tools.mjs -> options.reviewQueueTransport -> (in production)
// electron/main.cjs's review_queue_list_request handler -> the SAME live
// goalRunner.list_review_queue() the running app itself uses. Here, the
// transport's `list()` is wired directly to a REAL GoalRunner/GoalStorage
// pair (never a hand-copied reimplementation of their logic) so these
// tests exercise the actual production Review Queue code, only standing
// in for the cross-process fork-IPC hop http.mjs/electron main.cjs add in
// production (that hop itself is proven by the live smoke, not unit tests).
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { registerWorkspaceTools, toolNames } from '../mcp/tools.mjs';
import { GoalStorage } from '../mcp/goals/storage.mjs';
import { GoalRunner } from '../mcp/goals/runner.mjs';
import { createReviewQueueItem } from '../mcp/goals/model.mjs';

const fixtures = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-review-queue-mcp-'));
  fixtures.push(root);
  return root;
}
afterEach(() => {
  for (const root of fixtures.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** Minimal fake MCP server: records registerTool(name, config, handler) calls, mirroring scripts/test-x-mcp-tools.mjs's own convention. */
function fakeServer() {
  const tools = new Map();
  return { tools, registerTool(name, config, handler) { tools.set(name, { config, handler }); } };
}

const jsonOf = (result) => JSON.parse(result.content[0].text);

/**
 * Builds a REAL GoalStorage + REAL GoalRunner over a temp goals.json, plus
 * a review_queue_list MCP tool wired to that SAME REAL GoalRunner's own
 * list_review_queue() -- exactly the "reuse the live instance" shape
 * production uses, just without the fork-IPC hop.
 */
function harness({ xExecutorSpy, antigravitySpy } = {}) {
  const root = fixture();
  const goalsPath = path.join(root, 'goals.json');
  const storage = new GoalStorage({ storagePath: goalsPath });
  const runner = new GoalRunner({
    storage,
    xExecutor: xExecutorSpy ? { dispatchXTask: async (...a) => { xExecutorSpy.push(a); return { accepted: true }; }, getXTaskStatus: async () => ({ queue_status: 'terminal', terminal_status: 'completed', result: 'ok' }) } : undefined,
    antigravityExecutor: antigravitySpy ? { startAntigravityTask: async (...a) => { antigravitySpy.push(a); return { taskId: 't1' }; }, getAntigravityTask: () => ({ status: 'done', lastAnswer: 'ok' }) } : undefined,
  });

  const server = fakeServer();
  registerWorkspaceTools(server, {
    workspace: root,
    permissions: {},
    reviewQueueTransport: { list: async ({ goalId } = {}) => ({ items: runner.list_review_queue(goalId ? { goalId } : {}) }) },
  });

  return { root, goalsPath, storage, runner, server };
}

function goalWithWorkspace(root, workspaceSubdir = 'ws') {
  const workspace = path.join(root, workspaceSubdir);
  fs.mkdirSync(workspace, { recursive: true });
  return workspace;
}

console.log('\n=== Review Queue MCP Tool Test Suite ===\n');
let passed = 0;
let failed = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); passed += 1; }
  catch (err) { console.error(`  FAIL  ${name}: ${err.stack || err.message}`); failed += 1; }
};

// ── 1. Empty Review Queue returns [] ────────────────────────────────────────
await t('1. empty Review Queue returns []', async () => {
  const h = harness();
  const workspace = goalWithWorkspace(h.root);
  await h.runner.create_goal({ title: 'No Reviews', objective: 'nothing to review', workspace, steps: [{ title: 'Step 1', description: 'x', route: 'manual' }] });

  const result = jsonOf(await h.server.tools.get('review_queue_list').handler({}));
  assert.deepEqual(result.items, []);
});

// ── 2. Existing durable item is returned correctly ──────────────────────────
await t('2. an existing durable review item is returned correctly with all fields', async () => {
  const h = harness();
  const workspace = goalWithWorkspace(h.root);
  const goal = await h.runner.create_goal({ title: 'Has A Review', objective: 'one item', workspace, steps: [{ title: 'Step 1', description: 'x', route: 'manual' }] });

  // Seed the review item via the REAL createReviewQueueItem (model.mjs),
  // never a hand-typed object shape -- this test is only proving the MCP
  // read path, not re-proving Review Queue creation semantics (already
  // covered by scripts/test-goal-review-queue.mjs).
  const item = createReviewQueueItem({
    idempotencyKey: 'run-123', stepId: 'step-1', taskId: 'TASK-1', runId: 'run-123',
    resultId: 'result-1', status: 'needs_review', reason: 'supervisor_review',
    evidence: { requestId: 'goal:x:step:step-1', queueId: 'q1', runId: 'run-123', resultId: 'result-1', gateStatus: 'NEEDS_REVIEW', hearthOutcome: 'waiting' },
  });
  const g = h.storage.getGoal(goal.id);
  g.reviewQueue.push(item);
  h.storage.saveGoal(g);

  const result = jsonOf(await h.server.tools.get('review_queue_list').handler({}));
  assert.equal(result.items.length, 1);
  const returned = result.items[0];
  assert.equal(returned.id, item.id);
  assert.equal(returned.idempotencyKey, 'run-123');
  assert.equal(returned.goalId, goal.id);
  assert.equal(returned.goalTitle, 'Has A Review');
  assert.equal(returned.stepId, 'step-1');
  assert.equal(returned.taskId, 'TASK-1');
  assert.equal(returned.runId, 'run-123');
  assert.equal(returned.resultId, 'result-1');
  assert.equal(returned.status, 'needs_review');
  assert.equal(returned.reason, 'supervisor_review');
  assert.ok(returned.createdAt && returned.updatedAt);
  assert.equal(JSON.stringify(returned).toLowerCase().includes('transcript'), false);
});

// ── 3. Multiple goals aggregate correctly, filterable by goal_id ───────────
await t('3. multiple goals aggregate correctly, newest first, filterable by goal_id', async () => {
  const h = harness();
  const workspaceA = goalWithWorkspace(h.root, 'ws-a');
  const workspaceB = goalWithWorkspace(h.root, 'ws-b');
  const goalA = await h.runner.create_goal({ title: 'Goal A', objective: 'a', workspace: workspaceA, steps: [{ title: 'S1', description: 'x', route: 'manual' }] });
  const goalB = await h.runner.create_goal({ title: 'Goal B', objective: 'b', workspace: workspaceB, steps: [{ title: 'S1', description: 'x', route: 'manual' }] });

  const itemA = createReviewQueueItem({ idempotencyKey: 'run-a', stepId: 's1', status: 'failed', reason: 'a failed' });
  const gA = h.storage.getGoal(goalA.id); gA.reviewQueue.push(itemA); h.storage.saveGoal(gA);

  // A tiny real delay so Goal B's createdAt/updatedAt is genuinely later
  // than Goal A's -- otherwise two synchronous saves can land in the same
  // millisecond, making "newest first" ambiguous rather than a real defect.
  await sleep(5);

  const itemB = createReviewQueueItem({ idempotencyKey: 'run-b', stepId: 's1', status: 'needs_review', reason: 'b review' });
  const gB = h.storage.getGoal(goalB.id); gB.reviewQueue.push(itemB); h.storage.saveGoal(gB);

  const all = jsonOf(await h.server.tools.get('review_queue_list').handler({})).items;
  assert.equal(all.length, 2);
  assert.equal(all[0].goalId, goalB.id, 'newest (Goal B, saved last) must come first');
  assert.equal(all[1].goalId, goalA.id);

  const onlyA = jsonOf(await h.server.tools.get('review_queue_list').handler({ goal_id: goalA.id })).items;
  assert.equal(onlyA.length, 1);
  assert.equal(onlyA[0].goalId, goalA.id);
});

// ── 4. Calling the tool performs no writes ──────────────────────────────────
await t('4. calling the tool performs no writes to goals.json or goals.json.bak', async () => {
  const h = harness();
  const workspace = goalWithWorkspace(h.root);
  const goal = await h.runner.create_goal({ title: 'Untouched', objective: 'x', workspace, steps: [{ title: 'S1', description: 'x', route: 'manual' }] });
  const item = createReviewQueueItem({ idempotencyKey: 'run-z', stepId: 's1', status: 'failed', reason: 'z' });
  const g = h.storage.getGoal(goal.id); g.reviewQueue.push(item); h.storage.saveGoal(g);

  const before = fs.readFileSync(h.goalsPath, 'utf8');
  const beforeMtime = fs.statSync(h.goalsPath).mtimeMs;
  const bakPath = `${h.goalsPath}.bak`;
  const bakExistedBefore = fs.existsSync(bakPath);
  const bakBefore = bakExistedBefore ? fs.readFileSync(bakPath, 'utf8') : null;

  await h.server.tools.get('review_queue_list').handler({});
  await h.server.tools.get('review_queue_list').handler({ goal_id: goal.id });

  const after = fs.readFileSync(h.goalsPath, 'utf8');
  assert.equal(after, before, 'goals.json content must be byte-identical after read-only tool calls');
  assert.equal(fs.statSync(h.goalsPath).mtimeMs, beforeMtime, 'goals.json mtime must not change');
  assert.equal(fs.existsSync(bakPath), bakExistedBefore, 'goals.json.bak must not be newly created');
  if (bakExistedBefore) assert.equal(fs.readFileSync(bakPath, 'utf8'), bakBefore);
});

// ── 5 & 6. No X or Anti dispatch occurs ─────────────────────────────────────
await t('5/6. calling the tool triggers zero X dispatch and zero Antigravity dispatch', async () => {
  const xCalls = [];
  const antiCalls = [];
  const h = harness({ xExecutorSpy: xCalls, antigravitySpy: antiCalls });
  const workspace = goalWithWorkspace(h.root);
  const goal = await h.runner.create_goal({ title: 'Spy Goal', objective: 'x', workspace, steps: [{ title: 'S1', description: 'x', route: 'manual' }] });
  const item = createReviewQueueItem({ idempotencyKey: 'run-spy', stepId: 's1', status: 'needs_review', reason: 'spy' });
  const g = h.storage.getGoal(goal.id); g.reviewQueue.push(item); h.storage.saveGoal(g);

  await h.server.tools.get('review_queue_list').handler({});
  assert.equal(xCalls.length, 0, 'review_queue_list must never dispatch X');
  assert.equal(antiCalls.length, 0, 'review_queue_list must never dispatch Antigravity');
});

// ── transport_unavailable when no reviewQueueTransport is injected ─────────
await t('additional: no injected reviewQueueTransport (e.g. stdio.mjs, no Electron parent) fails closed, never falls back to a second GoalRunner', async () => {
  const server = fakeServer();
  registerWorkspaceTools(server, { workspace: fixture(), permissions: {} });
  const result = jsonOf(await server.tools.get('review_queue_list').handler({}));
  assert.deepEqual(result, { items: [], reason: 'transport_unavailable' });
});

// ── 8. MCP tool registration does not alter existing tool behavior ─────────
await t('8. tool registration includes review_queue_list without displacing any existing tool', async () => {
  const h = harness();
  assert.ok(toolNames.includes('review_queue_list'));
  for (const name of toolNames) assert.equal(h.server.tools.has(name), true, `${name} must still be registered`);
});

console.log(`\nResults: ${passed} passed, ${failed} failed out of ${passed + failed} tests\n`);
if (failed > 0) process.exit(1);
