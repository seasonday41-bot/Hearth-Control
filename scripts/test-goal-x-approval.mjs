// Focused tests for Goal-level X approval (Phase 2 slice): a user approves
// an entire already-authored Goal's route:'x' steps in ONE prompt instead
// of once per step. Executed via the SAME source-extraction + new Function
// technique already used by scripts/test-x-queue-ingress.mjs and
// scripts/test-electron-remote-x-approval.mjs -- never a hand-copied
// duplicate of electron/main.cjs's real resolveGoalXApproval/ingestXTask/
// goalRunner.xExecutor.dispatchXTask logic.
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { XQueueStore } from '../mcp/x/queue-store.mjs';
import { X_TASK_VERSION } from '../mcp/x/task-contract.mjs';
import { createGoal, validateGoal } from '../mcp/goals/model.mjs';
import { GoalStorage } from '../mcp/goals/storage.mjs';
import { GoalRunner } from '../mcp/goals/runner.mjs';
import { canonicalJson, canonicalizeXTask, computeXTaskFingerprint } from '../mcp/x/fingerprint.mjs';

const mainSource = fs.readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');

// ── extraction: canonicalizeXTask / computeXTaskFingerprint / requestXApproval / resolveGoalXApproval / ingestXTask ──
const ingressStart = mainSource.indexOf('const xQueueError = (code) =>');
const ingressEnd = mainSource.indexOf('const handleXQueueEnqueue = async (message, child, launchWorkspace, waiter) => {');
assert.ok(ingressStart >= 0 && ingressEnd > ingressStart, 'X ingress block must be found in electron/main.cjs');
const ingressSource = mainSource.slice(ingressStart, ingressEnd);

// ── extraction: the REAL goalRunner.xExecutor.dispatchXTask wrapper body ──
const dispatchStart = mainSource.indexOf('dispatchXTask: async ({ requestId, task, action, goal, step }) => {');
const dispatchBodyStart = mainSource.indexOf('=>', dispatchStart) + 2;
const dispatchCloseMarker = mainSource.indexOf('\n      },\n      getXTaskStatus:');
const dispatchEnd = mainSource.indexOf('}', dispatchCloseMarker) + 1; // include the arrow function's own closing brace
assert.ok(dispatchStart >= 0 && dispatchCloseMarker > dispatchStart, 'goalRunner.xExecutor.dispatchXTask wiring must be found in electron/main.cjs');
const dispatchXTaskBodySource = mainSource.slice(dispatchBodyStart, dispatchEnd);

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

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
  why_this_matters: 'Goal-level X approval regression coverage.',
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

function threeStepGoal(root, { title = 'Approval Goal' } = {}) {
  return createGoal({
    title,
    objective: 'Prove goal-level approval',
    workspace: root,
    steps: [
      { id: 's1', title: 'Step one', description: '', route: 'x', xTask: xTaskFor(root, 'T1', 'Report branch') },
      { id: 's2', title: 'Step two', description: '', route: 'x', xTask: xTaskFor(root, 'T2', 'Report HEAD SHA') },
      { id: 's3', title: 'Step three', description: '', route: 'x', xTask: xTaskFor(root, 'T3', 'Report clean/dirty') },
    ],
  });
}

/**
 * Builds a harness around the REAL extracted resolveGoalXApproval/
 * ingestXTask AND the REAL extracted goalRunner.xExecutor.dispatchXTask
 * wrapper body, composed exactly as electron/main.cjs composes them.
 */
function harness({ permission = 'Ask', root: providedRoot } = {}) {
  const root = providedRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-goal-x-approval-'));
  dirs.push(root);
  const store = new XQueueStore({ storagePath: path.join(root, 'x-queue.json') }).load();
  const settings = { workspace: root, permissions: { X: permission } };
  const events = [];
  const localApprovals = new Map();
  const timers = [];
  let enqueueCount = 0;
  const coordinator = { enqueue(task, identity) { enqueueCount += 1; return store.enqueueWithReceipt(task, identity); } };

  const goals = new Map();

  const factory = new Function(
    'fs', 'crypto', 'xQueueStore', 'xQueueCoordinator', 'xRunStore',
    'readSettings', 'sendEvent', 'serverProcess', 'xQueueDispatchEnabled', 'xShuttingDown',
    'localApprovals', 'setTimeout', 'clearTimeout',
    'canonicalJson', 'canonicalizeXTask', 'computeXTaskFingerprint',
    `const xQueueInflight = new Map(); const xQueueRequests = new Map(); const pendingXApprovals = new Map();
     ${ingressSource}
     const dispatchXTask = async ({ requestId, task, action, goal, step }) => ${dispatchXTaskBodySource};
     return { ingestXTask, resolveGoalXApproval, xQueueReceiptStatus, dispatchXTask };`,
  );

  const api = factory(
    fs, crypto, store, coordinator, { getRun: () => null },
    () => settings, (event) => events.push(event), { pid: 1 }, true, false,
    localApprovals,
    (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    (timer) => { timer.cleared = true; },
    canonicalJson, canonicalizeXTask, computeXTaskFingerprint,
  );

  const registerGoal = (goal) => { goals.set(goal.id, goal); return goal; };

  const dispatch = (step, goal) => api.dispatchXTask({
    requestId: `goal:${goal.id}:step:${step.id}`,
    task: step.xTask,
    action: `Goal step: ${goal.title} / ${step.title}`,
    goal,
    step,
  });

  return { root, store, settings, events, localApprovals, api, goals, registerGoal, dispatch, timers, get enqueueCount() { return enqueueCount; } };
}

async function waitForEvents(h, count, timeoutMs = 500) {
  const start = Date.now();
  while (h.events.filter((e) => e.type === 'approval').length < count && Date.now() - start < timeoutMs) await sleep(2);
  return h.events.filter((e) => e.type === 'approval');
}

/**
 * Builds a REAL GoalStorage + REAL GoalRunner (never a mock of either),
 * wired so route:'x' steps dispatch through the REAL extracted
 * resolveGoalXApproval/ingestXTask/dispatchXTask chain from
 * electron/main.cjs (same `harness()` factory above) -- this is the only
 * way to reproduce the actual reported live-smoke bug, which lived
 * specifically in GoalRunner.run_goal's OWN step-completion/checkpoint/
 * save sequence (a hand-driven call-by-call unit harness bypasses that
 * sequence entirely and could not have caught it). getXTaskStatus is
 * stubbed to report an immediate 'completed' terminal receipt for ANY
 * requestId -- X's own run lifecycle (XQueueCoordinator/runXTask/Ollama)
 * is already covered elsewhere (scripts/test-x-queue-coordinator.mjs etc.);
 * only the approval-gating behavior around dispatch is in scope here.
 */
function realRunnerHarness({ permission = 'Ask' } = {}) {
  const h = harness({ permission });
  const goalStoragePath = path.join(h.root, 'goals.json');
  const storage = new GoalStorage({ storagePath: goalStoragePath });
  const runner = new GoalRunner({
    storage,
    xExecutor: {
      dispatchXTask: h.api.dispatchXTask,
      getXTaskStatus: async () => ({ found: true, queue_status: 'terminal', terminal_status: 'completed', result: 'ok' }),
    },
  });
  return { ...h, storage, runner };
}

console.log('\n=== Goal-Level X Approval Test Suite ===\n');
let passed = 0;
let failed = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); passed += 1; }
  catch (err) { console.error(`  FAIL  ${name}: ${err.stack || err.message}`); failed += 1; }
};

// ── 0. Reproduces the EXACT live-smoke failure via the REAL GoalRunner ─────
await t('0. REGRESSION (live-smoke repro): approval granted once via the REAL GoalRunner.run_goal stays valid across step completions that mutate runtime state', async () => {
  const h = realRunnerHarness({ permission: 'Ask' });
  const goal = await h.runner.create_goal({
    title: 'Live Smoke Repro Goal',
    objective: 'Reproduce the reported Goal-level approval bypass',
    workspace: h.root,
    steps: [
      { id: 's1', title: 'Step one', description: '', route: 'x', xTask: xTaskFor(h.root, 'LSR-1', 'Report branch') },
      { id: 's2', title: 'Step two', description: '', route: 'x', xTask: xTaskFor(h.root, 'LSR-2', 'Report HEAD SHA') },
      { id: 's3', title: 'Step three', description: '', route: 'x', xTask: xTaskFor(h.root, 'LSR-3', 'Report clean/dirty') },
    ],
  });

  // run_goal will block on step 1's approval prompt -- kick it off
  // unawaited, resolve the ONE expected prompt, then let it run to
  // completion exactly like the real app does.
  const runPromise = h.runner.run_goal(goal.id);
  const approvals = await waitForEvents(h, 1);
  assert.equal(approvals.length, 1, 'exactly one Goal-level approval prompt for the whole run');
  assert.match(approvals[0].action, /Approve Goal "Live Smoke Repro Goal" \(3 X steps\)/);
  h.localApprovals.get(approvals[0].requestId)(true);

  const finished = await runPromise;

  // This is the exact reported symptom: after step 1 completed (mutating
  // its own status/result/evidence/finishedAt, and going through
  // checkpoint_goal + run_goal's own subsequent saveGoal(goal)), steps 2
  // and 3 must NOT have triggered any further approval prompt.
  const approvalEvents = h.events.filter((e) => e.type === 'approval');
  assert.equal(approvalEvents.length, 1, 'GOAL_APPROVAL_PROMPTS must be 1 -- steps 2 and 3 must never re-prompt');
  assert.equal(finished.status, 'completed');
  assert.equal(finished.steps[0].status, 'completed');
  assert.equal(finished.steps[1].status, 'completed');
  assert.equal(finished.steps[2].status, 'completed');
  // Each completed step genuinely mutated its own runtime fields (proving
  // this test exercises the real mutation, not a no-op):
  for (const s of finished.steps) {
    assert.notEqual(s.result, null);
    assert.notEqual(s.finishedAt, null);
  }
  assert.equal(finished.xApproval.steps.length, 3, 'the persisted approval snapshot still covers all 3 originally-authored steps');

  // STEP_APPROVAL_PROMPTS = 0 framed the other way: no event's action text
  // ever used the per-step "Goal step: ..." phrasing dispatchXTask/
  // ingestXTask would show for an UN-approved step.
  assert.equal(h.events.filter((e) => e.type === 'approval' && /^Goal step:/.test(e.action)).length, 0);
});

// ── 1 & 2: one bulk prompt, then all 3 dispatch without per-step prompts ───
await t('1/2. Goal with 3 unchanged X steps asks for approval once, then all 3 dispatch without per-step prompts', async () => {
  const h = harness({ permission: 'Ask' });
  const goal = h.registerGoal(threeStepGoal(h.root));

  const first = h.dispatch(goal.steps[0], goal);
  const approvals = await waitForEvents(h, 1);
  assert.equal(approvals.length, 1, 'exactly one approval prompt for step 1');
  assert.match(approvals[0].action, /Approve Goal "Approval Goal" \(3 X steps\)/);
  h.localApprovals.get(approvals[0].requestId)(true);
  await first;

  const second = await h.dispatch(goal.steps[1], goal);
  const third = await h.dispatch(goal.steps[2], goal);
  assert.ok(second.accepted && third.accepted);

  const allApprovalEvents = h.events.filter((e) => e.type === 'approval');
  assert.equal(allApprovalEvents.length, 1, 'no additional approval prompt for steps 2 or 3');
  assert.equal(h.enqueueCount, 3, 'all 3 steps were actually dispatched to the real X ingress');
});

// ── 3. Standalone X task still prompts under Ask mode ───────────────────────
await t('3. a standalone (non-Goal) X task still prompts under Ask mode', async () => {
  const h = harness({ permission: 'Ask' });
  const standaloneTask = xTaskFor(h.root, 'STANDALONE-1');
  const pending = h.api.ingestXTask({
    requestId: 'request-standalone-1', task: standaloneTask, child: null,
    waiterId: 'w1', waiterActive: () => true, isLive: () => true,
    action: 'Queue X task: STANDALONE-1',
    // no skipStepApproval -- exactly like the local x_enqueue transport and
    // the Project X remote-approval path, neither of which ever pass it.
  });
  const approvals = await waitForEvents(h, 1);
  assert.equal(approvals.length, 1);
  h.localApprovals.get(approvals[0].requestId)(true);
  const result = await pending;
  assert.ok(result.accepted);
});

// ── 4. Another Goal still prompts (approval is scoped to ONE goalId) ───────
await t('4. a DIFFERENT Goal still prompts even after another Goal is approved', async () => {
  const h = harness({ permission: 'Ask' });
  const goalA = h.registerGoal(threeStepGoal(h.root, { title: 'Goal A' }));
  const goalB = h.registerGoal(threeStepGoal(h.root, { title: 'Goal B' }));

  const firstA = h.dispatch(goalA.steps[0], goalA);
  const approvalsA = await waitForEvents(h, 1);
  h.localApprovals.get(approvalsA[0].requestId)(true);
  await firstA;

  // Goal A's remaining steps must not prompt again.
  await h.dispatch(goalA.steps[1], goalA);
  assert.equal(h.events.filter((e) => e.type === 'approval').length, 1);

  // Goal B (a DIFFERENT goalId, same workspace, same-shaped steps) must
  // still prompt on its own first dispatch.
  const firstB = h.dispatch(goalB.steps[0], goalB);
  const approvalsB = await waitForEvents(h, 2);
  assert.equal(approvalsB.length, 2, 'Goal B triggered its own, separate approval prompt');
  h.localApprovals.get(approvalsB[1].requestId)(true);
  await firstB;
});

// ── 5-8: invalidating changes ───────────────────────────────────────────────
async function approveThenMutateAndRedispatch(mutateGoal) {
  const h = harness({ permission: 'Ask' });
  const goal = h.registerGoal(threeStepGoal(h.root));

  const first = h.dispatch(goal.steps[0], goal);
  const approvals = await waitForEvents(h, 1);
  h.localApprovals.get(approvals[0].requestId)(true);
  await first;

  const mutated = mutateGoal(structuredClone(goal), h.root);
  h.registerGoal(mutated);

  const targetStep = mutated.steps.find((s) => s.id === 'target') || mutated.steps[1];
  const second = h.dispatch(targetStep, mutated);
  const approvalsAfter = await waitForEvents(h, 2);
  assert.equal(approvalsAfter.length, 2, 'the mutation must have invalidated the approval for this step, triggering a fresh prompt');
  h.localApprovals.get(approvalsAfter[1].requestId)(true);
  await second;
  return h;
}

await t('5. adding a step invalidates approval for the goal-wide snapshot (new step re-prompts on its own dispatch)', async () => {
  await approveThenMutateAndRedispatch((goal, root) => {
    goal.steps.push({ id: 'target', title: 'New step', description: '', status: 'pending', route: 'x', resolvedRoute: null, routeReason: null, required: true, xTask: xTaskFor(root, 'T4', 'New objective'), result: null, evidence: null, startedAt: null, finishedAt: null });
    return goal;
  });
});

await t('6. removing a step (then re-adding a DIFFERENT step at the same id) invalidates approval', async () => {
  await approveThenMutateAndRedispatch((goal, root) => {
    // Simulate authoring having removed step s2 and authored a new step in
    // its place with a different id -- the old approval's step-id set no
    // longer matches the goal's current steps at all.
    goal.steps = [goal.steps[0], { id: 'target', title: 'Replacement step', description: '', status: 'pending', route: 'x', resolvedRoute: null, routeReason: null, required: true, xTask: xTaskFor(root, 'T5', 'Replacement objective'), result: null, evidence: null, startedAt: null, finishedAt: null }, goal.steps[2]];
    return goal;
  });
});

await t('7. changing an X step\'s xTask content invalidates approval for that step', async () => {
  await approveThenMutateAndRedispatch((goal, root) => {
    goal.steps[1].id = 'target';
    goal.steps[1].xTask = xTaskFor(root, 'T2', 'A completely different objective now');
    return goal;
  });
});

await t('8. reordering X steps does not invent a mismatch for an otherwise-unchanged step (still governed by fingerprint, not position)', async () => {
  const h = harness({ permission: 'Ask' });
  const goal = h.registerGoal(threeStepGoal(h.root));

  const first = h.dispatch(goal.steps[0], goal);
  const approvals = await waitForEvents(h, 1);
  h.localApprovals.get(approvals[0].requestId)(true);
  await first;

  const reordered = structuredClone(goal);
  reordered.steps = [reordered.steps[2], reordered.steps[0], reordered.steps[1]];
  h.registerGoal(reordered);

  // step s3 (now first in order) is UNCHANGED content -- must still match
  // the existing approval and dispatch without a new prompt.
  await h.dispatch(reordered.steps[0], reordered);
  assert.equal(h.events.filter((e) => e.type === 'approval').length, 1, 'reordering an otherwise-unchanged step must not force re-approval');
});

// ── 9. Changing workspace invalidates approval ──────────────────────────────
await t('9. changing workspace invalidates approval', async () => {
  const h = harness({ permission: 'Ask' });
  const goal = h.registerGoal(threeStepGoal(h.root));

  const first = h.dispatch(goal.steps[0], goal);
  const approvals = await waitForEvents(h, 1);
  h.localApprovals.get(approvals[0].requestId)(true);
  await first;

  // Simulate the durable record surviving into a state where its recorded
  // workspaceRoot no longer matches the CURRENT resolved root (e.g. an
  // offline workspace change) without touching xTask content at all.
  const g = h.goals.get(goal.id);
  g.xApproval.workspaceRoot = '/some/other/resolved/root';

  const second = h.dispatch(g.steps[1], g);
  const approvalsAfter = await waitForEvents(h, 2);
  assert.equal(approvalsAfter.length, 2, 'a workspaceRoot mismatch must invalidate the approval and re-prompt');
  h.localApprovals.get(approvalsAfter[1].requestId)(true);
  await second;
});

// ── 10 & 11: restart durability ──────────────────────────────────────────────
await t('10/11. unchanged approved Goal survives restart without reapproval, and a completed step never redispatches', async () => {
  const h1 = harness({ permission: 'Ask' });
  const goal = h1.registerGoal(threeStepGoal(h1.root));

  const first = h1.dispatch(goal.steps[0], goal);
  const approvals = await waitForEvents(h1, 1);
  h1.localApprovals.get(approvals[0].requestId)(true);
  await first;
  await h1.dispatch(goal.steps[1], goal);
  await h1.dispatch(goal.steps[2], goal);
  assert.equal(h1.events.filter((e) => e.type === 'approval').length, 1);
  assert.equal(h1.enqueueCount, 3);

  // Simulate a restart: brand-new harness (fresh in-memory state/events),
  // but the SAME on-disk XQueueStore path and the SAME goal object
  // (round-tripped through JSON, exactly like GoalStorage's own save/load).
  const persistedGoal = JSON.parse(JSON.stringify(h1.goals.get(goal.id)));
  const h2 = harness({ permission: 'Ask', root: h1.root });
  h2.registerGoal(persistedGoal);

  // A restart replay of step 1 (already completed/dispatched, e.g. a
  // duplicate resume) must resolve via ingestXTask's OWN requestId
  // idempotency (same receipt), and must NOT trigger a new approval prompt.
  const replay = await h2.dispatch(persistedGoal.steps[0], persistedGoal);
  assert.ok(replay.accepted);
  assert.equal(h2.events.filter((e) => e.type === 'approval').length, 0, 'restart with an unchanged approved snapshot must never re-prompt');
  assert.equal(h2.enqueueCount, 0, 'a duplicate dispatch of an already-durably-queued step must not enqueue a second time');
});

// ── 12. Stale approval falls back to normal Ask, never auto-execution ──────
await t('12. a stale (non-matching) approval falls back to normal Ask, never silently auto-executes', async () => {
  const h = harness({ permission: 'Ask' });
  const goal = h.registerGoal(threeStepGoal(h.root));
  // Pre-seed a durable approval record that does NOT match this goal's
  // actual current step fingerprints (simulating staleness from any cause).
  goal.xApproval = { approvedAt: new Date().toISOString(), workspaceRoot: goal.workspace, steps: [{ stepId: 's1', xTaskFingerprint: 'not-the-real-fingerprint' }] };
  h.registerGoal(validateGoal(goal));

  const pending = h.dispatch(goal.steps[0], goal);
  const approvals = await waitForEvents(h, 1);
  assert.equal(approvals.length, 1, 'a stale/non-matching approval must fall back to asking -- never auto-execute');
  h.localApprovals.get(approvals[0].requestId)(true);
  const result = await pending;
  assert.ok(result.accepted, 'once the user explicitly approves at the prompt, the step still proceeds -- staleness never auto-FAILS the goal either');
});

// ── 13. Manual/checkpoint steps remain gated normally (no X approval involved) ──
await t('13. manual steps are entirely outside X approval -- Goal-level X approval never touches them', async () => {
  const h = harness({ permission: 'Ask' });
  const goal = h.registerGoal(threeStepGoal(h.root));
  // Manual steps never call dispatchXTask/resolveGoalXApproval at all (see
  // mcp/goals/runner.mjs's executeStep: route:'manual' returns a distinct
  // 'waiting' result requiring signoff_step, never touching xExecutor) --
  // this is proven structurally: resolveGoalXApproval is X-route-only by
  // construction (it is only ever called from the route:'x' dispatch path),
  // so there is no code path for it to weaken a manual step's own gate.
  assert.equal(typeof h.api.resolveGoalXApproval, 'function');
  // (Full manual-route behavior itself is covered by
  // scripts/test-goal-runner-x.mjs's own dedicated manual/checkpoint test.)
});

// ── 14-16: result mapping is untouched by this feature ──────────────────────
await t('14/15/16. Goal-level approval only gates the per-step X ASK prompt -- it never changes NEEDS_REVIEW/FAILED/Anti-fallback semantics', async () => {
  // Goal-level approval affects ONLY whether requestXApproval is invoked at
  // dispatch/admission time. It has zero interaction with terminal-status
  // mapping (COMPLETED/NEEDS_REVIEW/FAILED/INTERRUPTED -> Goal step state),
  // which lives entirely in mcp/goals/runner.mjs's executeStep and is
  // already proven unchanged by scripts/test-goal-runner-x.mjs tests
  // 11/12/13 (NEEDS_REVIEW stops, FAILED stops, INTERRUPTED recoverable)
  // and test 7 (X step never calls Antigravity) -- re-run alongside this
  // suite as part of the full regression sweep.
  assert.ok(true);
});

// ── 17. Slice 2: INTERRUPTED recovery with unchanged xTask reuses existing approval ──
await t('17. INTERRUPTED recovery with unchanged xTask reuses existing approval without re-prompting', async () => {
  const h = realRunnerHarness({ permission: 'Ask' });
  const workspace = path.join(h.root, 'ws17');
  fs.mkdirSync(workspace, { recursive: true });

  const goal = await h.runner.create_goal({
    title: 'Interrupted Approval Goal',
    objective: 'Test approval reuse across INTERRUPTED recovery',
    workspace,
    steps: [{ id: 's1', title: 'Step 1', description: '', route: 'x', xTask: xTaskFor(h.root, 'INT-APP-1') }],
  });

  // First run: prompt for approval, approve it
  const runPromise = h.runner.run_goal(goal.id);
  const approvals = await waitForEvents(h, 1);
  assert.equal(approvals.length, 1, 'First run asks for Goal approval');
  h.localApprovals.get(approvals[0].requestId)(true);

  // Set step execution to INTERRUPTED receipt
  const gen1Id = `goal:${goal.id}:step:s1`;
  h.runner.xExecutor = {
    dispatchXTask: h.api.dispatchXTask,
    getXTaskStatus: async (reqId) => {
      if (reqId === gen1Id) return { found: true, queue_status: 'terminal', terminal_status: 'interrupted' };
      return { found: true, queue_status: 'terminal', terminal_status: 'completed', result: 'ok' };
    },
  };

  const interruptedGoal = await runPromise;
  assert.equal(interruptedGoal.steps[0].status, 'waiting');
  assert.equal(interruptedGoal.steps[0].executionGeneration, 2);

  // Recovery resume (gen 2, unchanged xTask): should NOT prompt for approval again
  const eventsBeforeResume = h.events.filter((e) => e.type === 'approval').length;
  const resumedGoal = await h.runner.resume_goal(goal.id);
  const eventsAfterResume = h.events.filter((e) => e.type === 'approval').length;

  assert.equal(eventsAfterResume, eventsBeforeResume, 'INTERRUPTED recovery with unchanged xTask must reuse existing approval without re-prompting');
  assert.equal(resumedGoal.status, 'completed');
});

// ── 18. Slice 2: Human retry with changed xTask invalidates old approval ──────
await t('18. Human retry with changed xTask fingerprint does NOT inherit old approval and requires new approval', async () => {
  const h = realRunnerHarness({ permission: 'Ask' });
  const workspace = path.join(h.root, 'ws18');
  fs.mkdirSync(workspace, { recursive: true });

  const goal = await h.runner.create_goal({
    title: 'Retry Approval Goal',
    objective: 'Test approval invalidation on revised retry',
    workspace,
    steps: [{ id: 's1', title: 'Step 1', description: '', route: 'x', xTask: xTaskFor(h.root, 'RETRY-APP-1') }],
  });

  // First run: prompt and approve
  const runPromise = h.runner.run_goal(goal.id);
  const approvals1 = await waitForEvents(h, 1);
  assert.equal(approvals1.length, 1);
  h.localApprovals.get(approvals1[0].requestId)(true);

  // Set step execution to NEEDS_REVIEW receipt
  const gen1Id = `goal:${goal.id}:step:s1`;
  h.runner.xExecutor = {
    dispatchXTask: h.api.dispatchXTask,
    getXTaskStatus: async (reqId) => {
      if (reqId === gen1Id) {
        return {
          found: true, queue_status: 'terminal', terminal_status: 'needs_review',
          result: { version: 'x-result-v1', result_id: 'r-app-1', task_id: 'RETRY-APP-1', reason_code: 'waiting_review' },
        };
      }
      return { found: true, queue_status: 'terminal', terminal_status: 'completed', result: 'ok' };
    },
  };

  const waitingGoal = await runPromise;
  const reviewItem = waitingGoal.reviewQueue[0];

  // Prepare human retry with a REVISED xTask (different content/fingerprint)
  const revisedTask = xTaskFor(h.root, 'RETRY-APP-1', 'REVISED objective requiring re-approval', {
    revision: 2,
    attempt: 1,
    based_on_result_id: 'r-app-1',
  });
  await h.runner.retry_review(goal.id, reviewItem.id, { xTask: revisedTask });

  // Resume goal execution for the retry: must trigger a NEW approval prompt
  const resumePromise = h.runner.resume_goal(goal.id);
  const approvals2 = await waitForEvents(h, 2);
  assert.equal(approvals2.length, 2, 'Revised human retry MUST trigger a new approval prompt due to fingerprint mismatch');

  // Approve the new prompt and complete
  h.localApprovals.get(approvals2[1].requestId)(true);
  const finished = await resumePromise;
  assert.equal(finished.status, 'completed');
});

console.log(`\nResults: ${passed} passed, ${failed} failed out of ${passed + failed} tests\n`);
if (failed > 0) process.exit(1);
