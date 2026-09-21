// Hidden scorer / feasibility probe: re-authorizing a specialist handoff after
// every prior execution has terminated (interrupted) must create a NEW generation
// with a fresh, non-colliding id and keep the old record. The commit ships no test,
// so this is eval-authored. Uses only pre-existing runner API.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createScorer, parseRoot, load } from './_lib.mjs';

const root = parseRoot();
const s = createScorer();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xeval-spec-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
let M;
await s.check('load goal runner + storage + contract modules', async () => {
  M = {
    ...(await load(root, 'mcp/goals/runner.mjs')), ...(await load(root, 'mcp/goals/storage.mjs')),
    ...(await load(root, 'mcp/goals/model.mjs')), ...(await load(root, 'mcp/runtime/job-manager.mjs')),
    ...(await load(root, 'mcp/x/task-contract.mjs')), ...(await load(root, 'mcp/specialist/contract.mjs')),
  };
});
if (!M) s.finish();

const ws = path.join(tmp, 'ws');
fs.mkdirSync(ws, { recursive: true });
const git = (...a) => execFileSync('git', a, { cwd: ws, stdio: 'ignore' });
git('init'); git('config', 'user.name', 'T'); git('config', 'user.email', 't@example.com');
fs.writeFileSync(path.join(ws, 'README.md'), '# t\n'); git('add', '.'); git('commit', '-m', 'init');
const xTask = () => M.parseXTask({
  version: 'x-task-v1', task_id: 'task_scorer_1', parent_task_id: null, revision: 1, attempt: 1, based_on_result_id: null,
  objective: 'o', problem: 'p', expected_behavior: 'e', observed_behavior: 'b', why_this_matters: 'w',
  known_evidence: [], suspected_area: [], workspace: { repo: 'r', root: ws },
  scope: { allowed_paths: ['src/**'], preferred_files: [], forbidden_paths: [] }, constraints: { preserve: [], do_not: [] },
  allowed_tools: ['repo_read'], acceptance_criteria: ['a'], validation: { required: ['node -v'], optional: [] }, verification: null,
  done_criteria: ['d'], teaching_notes: [], uncertainty_policy: { policy: 'bounded_autonomy', stop_conditions: [] },
  repair_budget: { initial_attempts: 1, max_repairs: 2, max_total_rounds: 3 },
  timing: { estimated_minutes: 3, first_check_after_minutes: 1, soft_deadline_minutes: 3, hard_timeout_minutes: 10 }, commit_policy: { mode: 'never' },
});

let ctx;
await s.check('setup: goal with an open X review item and a requested handoff', async () => {
  const storage = new M.GoalStorage({ storagePath: path.join(tmp, 'goals.json') });
  const runner = new M.GoalRunner({ storage, jobManager: new M.JobManager({ storagePath: path.join(tmp, 'jobs.json') }) });
  const goal = await runner.create_goal({ title: 'G', objective: 'O', workspace: ws, steps: [{ title: 'S1', route: 'x', xTask: xTask() }] });
  goal.reviewQueue = [M.createReviewQueueItem({ idempotencyKey: 'i1', stepId: goal.steps[0].id, runId: 'run1', resultId: 'res1', status: 'needs_review', lifecycle: 'open', reason: 'needs specialist' })];
  goal.steps[0].status = 'waiting'; goal.steps[0].result = 'Step failed. Review required.';
  storage.saveGoal(goal);
  const handoff = await runner.request_specialist_handoff(goal.id, goal.steps[0].id, { target: 'codex', reason: 'refactor' });
  ctx = { storage, runner, goalId: goal.id, handoffId: handoff.handoff.id };
});
if (!ctx) s.finish();

const first = { id: null };
await s.check('first authorization creates generation 1 with the base id', async () => {
  const r = await ctx.runner.authorize_specialist_execution(ctx.goalId, ctx.handoffId);
  first.id = r.execution.id;
  assert.equal(r.execution.id, M.deriveSpecialistExecutionId(ctx.handoffId));
});
await s.check('while one is active, re-authorizing returns the SAME execution (idempotent)', async () => {
  const r = await ctx.runner.authorize_specialist_execution(ctx.goalId, ctx.handoffId);
  assert.equal(r.execution.id, first.id);
  assert.equal(ctx.storage.getGoal(ctx.goalId).specialistExecutions.length, 1);
});
await s.check('after the first execution is interrupted, re-authorizing creates generation 2 with a fresh id; the old record is kept', async () => {
  const goal = ctx.storage.getGoal(ctx.goalId);
  goal.specialistExecutions[0].status = 'interrupted';
  ctx.storage.saveGoal(goal);
  const r = await ctx.runner.authorize_specialist_execution(ctx.goalId, ctx.handoffId);
  const all = ctx.storage.getGoal(ctx.goalId).specialistExecutions;
  assert.equal(all.length, 2, `expected 2 records, got ${all.length}`);
  assert.equal(new Set(all.map((e) => e.id)).size, 2, 'execution ids must be unique');
  assert.equal(r.execution.id, M.deriveSpecialistExecutionId(ctx.handoffId, 2));
  assert.equal(r.execution.generation, 2);
  assert.equal(all.find((e) => e.id === first.id).status, 'interrupted', 'historical record must be preserved unchanged');
});
s.finish();
