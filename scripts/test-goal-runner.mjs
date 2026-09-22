/**
 * Hearth Goal Runner V1 Core Test Suite
 * Tests multi-step execution, state machines, checkpointing, pause/resume,
 * workspace locking, and completion verification without live external execution.
 */

import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import {
  validateGoal,
  validateStep,
  createGoalCheckpoint,
  createGoal,
} from '../mcp/goals/model.mjs';
import { GoalStorage } from '../mcp/goals/storage.mjs';
import { GoalRunner } from '../mcp/goals/runner.mjs';

let passed = 0;
let failed = 0;

const test = async (name, fn) => {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`  FAIL  ${name}: ${err.message}`);
    failed += 1;
  }
};

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hearth-goal-test-'));
const testWorkspace = path.join(tmpDir, 'workspace');
await fs.mkdir(testWorkspace, { recursive: true });
const storagePath = path.join(tmpDir, 'goals.json');

console.log('\n=== Hearth Goal Runner V1 Core Test Suite ===\n');

// ── 1. Create Goal ─────────────────────────────────────────────────────────
await test('create goal: valid goal created with steps and workspace', async () => {
  const storage = new GoalStorage({ storagePath });
  const runner = new GoalRunner({ storage });

  const goal = await runner.create_goal({
    title: 'Fix Navigation Bug',
    objective: 'Ensure sidebar navigation switches smoothly',
    workspace: testWorkspace,
    steps: [
      { id: 's1', title: 'Inspect code', description: 'Read App.tsx', required: true },
      { id: 's2', title: 'Apply fix', description: 'Update route state', required: true },
    ],
    constraints: ['no-sudo', 'strict-workspace'],
  });

  assert.equal(goal.title, 'Fix Navigation Bug');
  assert.equal(goal.workspace, testWorkspace);
  assert.equal(goal.status, 'ready');
  assert.equal(goal.steps.length, 2);
  assert.equal(goal.steps[0].status, 'pending');
});

// ── 2. Invalid Goal Rejected ───────────────────────────────────────────────
await test('invalid goal rejected: missing workspace, empty title, empty objective', async () => {
  const storage = new GoalStorage({ storagePath });
  const runner = new GoalRunner({ storage });

  // Missing workspace
  await assert.rejects(
    async () => runner.create_goal({ title: 'T', objective: 'O', workspace: '' }),
    /workspace/i
  );

  // Non-existent directory
  await assert.rejects(
    async () => runner.create_goal({ title: 'T', objective: 'O', workspace: '/nonexistent/path/for/test' }),
    /invalid or inaccessible/i
  );

  // Empty title
  await assert.rejects(
    async () => runner.create_goal({ title: '', objective: 'O', workspace: testWorkspace }),
    /title must be a non-empty string/i
  );

  // Empty objective
  await assert.rejects(
    async () => runner.create_goal({ title: 'T', objective: '', workspace: testWorkspace }),
    /objective must be a non-empty string/i
  );
});

// ── 3. Workspace Locked While Goal Active ──────────────────────────────────
await test('workspace locked while goal active', async () => {
  const storage = new GoalStorage({ storagePath });
  const runner = new GoalRunner({ storage });

  const goal = await runner.create_goal({
    title: 'Active Goal',
    objective: 'Test lock',
    workspace: testWorkspace,
    steps: [{ title: 'Step 1', description: 'Wait' }],
  });

  assert.equal(runner.is_goal_active(), false);

  // Simulate goal becoming running
  goal.status = 'running';
  storage.saveGoal(goal);
  assert.equal(runner.is_goal_active(), true);

  // Simulate paused
  goal.status = 'paused';
  storage.saveGoal(goal);
  assert.equal(runner.is_goal_active(), true);

  // Simulate waiting
  goal.status = 'waiting';
  storage.saveGoal(goal);
  assert.equal(runner.is_goal_active(), true);

  // Simulate completed
  goal.status = 'completed';
  storage.saveGoal(goal);
  assert.equal(runner.is_goal_active(), false);
});

// ── 4. Run Ready Goal ──────────────────────────────────────────────────────
await test('run ready goal: transitions to running and executes steps', async () => {
  const storage = new GoalStorage({ storagePath });
  const runner = new GoalRunner({ storage });

  const goal = await runner.create_goal({
    title: 'Test Run',
    objective: 'Execute single step',
    workspace: testWorkspace,
    steps: [{ id: 's1', title: 'Step 1', description: 'Do work' }],
  });

  const executed = await runner.run_goal(goal.id, {
    executeStepFn: async (_g, step) => ({
      status: 'completed',
      result: `Executed ${step.title}`,
    }),
  });

  assert.equal(executed.status, 'completed');
  assert.equal(executed.steps[0].status, 'completed');
  assert.match(executed.steps[0].result, /Executed Step 1/);
});

// ── 5. Step Transition ─────────────────────────────────────────────────────
await test('step transition: pending -> running -> completed', async () => {
  const storage = new GoalStorage({ storagePath });
  const runner = new GoalRunner({ storage });

  const stepHistory = [];
  const goal = await runner.create_goal({
    title: 'Multi Step',
    objective: 'Two step workflow',
    workspace: testWorkspace,
    steps: [
      { id: 'step-1', title: 'First', description: '1' },
      { id: 'step-2', title: 'Second', description: '2' },
    ],
  });

  await runner.run_goal(goal.id, {
    onProgress: (g) => {
      const active = g.steps.find((s) => s.id === g.currentStepId);
      if (active) stepHistory.push(`${active.id}:${active.status}`);
    },
    executeStepFn: async (_g, step) => ({
      status: 'completed',
      result: `${step.id} done`,
    }),
  });

  const saved = storage.getGoal(goal.id);
  assert.equal(saved.status, 'completed');
  assert.equal(saved.steps[0].status, 'completed');
  assert.equal(saved.steps[1].status, 'completed');
  assert(stepHistory.includes('step-1:running'), 'Must record step-1 running');
  assert(stepHistory.includes('step-2:running'), 'Must record step-2 running');
});

// ── 6. Waiting Step Does Not Complete Goal ─────────────────────────────────
await test('waiting step does not complete goal: preserves waiting state', async () => {
  const storage = new GoalStorage({ storagePath });
  const runner = new GoalRunner({ storage });

  const goal = await runner.create_goal({
    title: 'Needs Approval',
    objective: 'Step requires human feedback',
    workspace: testWorkspace,
    steps: [
      { id: 's1', title: 'Automated step', description: 'Passes', route: 'mcp', required: true },
      { id: 's2', title: 'Review step', description: 'Requires review', route: 'mcp', required: true },
    ],
  });

  const result = await runner.run_goal(goal.id, {
    executeStepFn: async (_g, step) => {
      if (step.id === 's1') return { status: 'completed', result: 'Step 1 done' };
      return { status: 'waiting', result: 'Waiting on user approval' };
    },
  });

  assert.equal(result.status, 'waiting');
  assert.equal(result.steps[0].status, 'completed');
  assert.equal(result.steps[1].status, 'waiting');
  assert.equal(result.finishedAt, null, 'Goal must NOT have finishedAt');
});

// ── 7. Required Error Prevents Completion ──────────────────────────────────
await test('required error prevents completion: fails goal', async () => {
  const storage = new GoalStorage({ storagePath });
  const runner = new GoalRunner({ storage });

  const goal = await runner.create_goal({
    title: 'Fail Case',
    objective: 'Test error behavior',
    workspace: testWorkspace,
    steps: [
      { id: 's1', title: 'Failing required step', description: 'Breaks', required: true },
      { id: 's2', title: 'Subsequent step', description: 'Should not run', required: true },
    ],
  });

  const result = await runner.run_goal(goal.id, {
    executeStepFn: async () => ({ status: 'error', error: 'Build failed with syntax error' }),
  });

  assert.equal(result.status, 'error');
  assert.match(result.error, /Build failed with syntax error/);
  assert.equal(result.steps[0].status, 'error');
  assert.equal(result.steps[1].status, 'pending', 'Subsequent step must not run');
});

// ── 8. All Required Steps Complete => Goal Completed ───────────────────────
await test('all required steps complete => goal completed', async () => {
  const storage = new GoalStorage({ storagePath });
  const runner = new GoalRunner({ storage });

  const goal = await runner.create_goal({
    title: 'Success Goal',
    objective: 'All steps succeed',
    workspace: testWorkspace,
    steps: [
      { id: 'req-1', title: 'Req 1', description: 'Required', required: true },
      { id: 'opt-1', title: 'Opt 1', description: 'Optional', required: false },
      { id: 'req-2', title: 'Req 2', description: 'Required', required: true },
    ],
  });

  const result = await runner.run_goal(goal.id, {
    executeStepFn: async (_g, step) => {
      if (step.id === 'opt-1') return { status: 'error', error: 'Optional error' };
      return { status: 'completed', result: `${step.id} passed` };
    },
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.steps[0].status, 'completed');
  assert.equal(result.steps[1].status, 'error'); // optional step failed
  assert.equal(result.steps[2].status, 'completed');
  assert.notEqual(result.finishedAt, null);
});

// ── 9. Checkpoint Creation ─────────────────────────────────────────────────
await test('checkpoint creation: creates sanitized checkpoint structure', async () => {
  const storage = new GoalStorage({ storagePath });
  const runner = new GoalRunner({ storage });

  const goal = await runner.create_goal({
    title: 'Checkpoint Goal',
    objective: 'Test checkpointing',
    workspace: testWorkspace,
    steps: [{ id: 's1', title: 'Step 1', description: 'Inspect' }],
  });

  const cp = runner.checkpoint_goal(goal.id, 's1', {
    summary: 'Inspected files',
    completedSteps: 1,
    filesChanged: ['src/App.tsx'],
    checks: { tests: true, build: true },
    nextStep: 's2',
    route: 'manual',
  });

  assert.equal(cp.goalId, goal.id);
  assert.equal(cp.stepId, 's1');
  assert.equal(cp.summary, 'Inspected files');
  assert.equal(cp.completedSteps, 1);
  assert.equal(cp.checks.tests, true);
  assert.equal(cp.nextStep, 's2');
  assert.equal(cp.route, 'manual');

  const saved = storage.getGoal(goal.id);
  assert.equal(saved.checkpoints.length, 1);
});

// ── 10. Checkpoint Contains No Raw Transcript ──────────────────────────────
await test('checkpoint contains no raw transcript or credentials', async () => {
  const secretString = 'Bearer secret_token_1234567890';
  const rawTranscriptDump = 'USER_INPUT step 0\nMODEL RESPONSE tool_call ...';

  const cp = createGoalCheckpoint({
    goalId: 'g1',
    stepId: 's1',
    summary: `Executed with token ${secretString}`,
    evidence: {
      rawTranscript: rawTranscriptDump,
      token: 'secret-token',
      cleanSummary: 'Verified tests passed',
    },
  });

  assert(!cp.summary.includes('secret_token_1234567890'), 'Token must be redacted from summary');
  assert.equal(cp.summary.includes('[REDACTED]'), true);
  assert.equal(cp.evidence.rawTranscript, undefined, 'rawTranscript must be completely stripped');
  assert.equal(cp.evidence.token, undefined, 'token must be stripped');
  assert.equal(cp.evidence.cleanSummary, 'Verified tests passed');
});

// ── 11. Pause ──────────────────────────────────────────────────────────────
await test('pause: safely pauses goal and records checkpoint', async () => {
  const storage = new GoalStorage({ storagePath });
  const runner = new GoalRunner({ storage });

  const goal = await runner.create_goal({
    title: 'Pausable Goal',
    objective: 'Pause after step 1',
    workspace: testWorkspace,
    steps: [
      { id: 's1', title: 'Step 1', description: 'Runs' },
      { id: 's2', title: 'Step 2', description: 'Should be paused' },
    ],
  });

  // Run step 1, then trigger pause
  await runner.run_goal(goal.id, {
    executeStepFn: async () => {
      await runner.pause_goal(goal.id);
      return { status: 'completed', result: 'Step 1 done' };
    },
  });

  const saved = storage.getGoal(goal.id);
  assert.equal(saved.status, 'paused');
  assert.equal(saved.steps[0].status, 'completed');
  assert.equal(saved.steps[1].status, 'pending');
  assert(saved.checkpoints.some((c) => c.summary.includes('paused')));
});

// ── 12. Resume Continues from Checkpoint / Current Step ─────────────────────
await test('resume continues from checkpoint/current step without restarting', async () => {
  const storage = new GoalStorage({ storagePath });
  const runner = new GoalRunner({ storage });

  const goal = await runner.create_goal({
    title: 'Resumable Goal',
    objective: 'Resume from step 2',
    workspace: testWorkspace,
    steps: [
      { id: 's1', title: 'Step 1', description: 'Already done' },
      { id: 's2', title: 'Step 2', description: 'To be resumed' },
    ],
  });

  // Manually mark step 1 done and goal paused
  goal.steps[0].status = 'completed';
  goal.steps[0].result = 'Previously finished';
  goal.status = 'paused';
  goal.currentStepId = 's2';
  runner.checkpoint_goal(goal.id, 's1', {
    summary: 'Step 1 done',
    completedSteps: 1,
    nextStep: 's2',
  });
  storage.saveGoal(goal);

  let step1Reran = false;
  let step2Ran = false;

  await runner.resume_goal(goal.id, {
    executeStepFn: async (_g, step) => {
      if (step.id === 's1') step1Reran = true;
      if (step.id === 's2') step2Ran = true;
      return { status: 'completed', result: `${step.id} completed` };
    },
  });

  const finalGoal = storage.getGoal(goal.id);
  assert.equal(step1Reran, false, 'Step 1 must NOT rerun on resume');
  assert.equal(step2Ran, true, 'Step 2 must run on resume');
  assert.equal(finalGoal.status, 'completed');
  assert.equal(finalGoal.steps[1].status, 'completed');
});

// ── 13. Retired route cannot be created ──────────────────────────────────────
await test('retired execution route is rejected for new goals', async () => {
  const storage = new GoalStorage({ storagePath });
  const runner = new GoalRunner({ storage });
  await assert.rejects(() => runner.create_goal({
    title: 'Retired route', objective: 'Verify fail-closed creation', workspace: testWorkspace,
    steps: [{ id: 's1', title: 'Legacy step', route: 'antigravity' }],
  }), /goal_step_route_retired/);
});

await test('shared Bridge client remains importable', async () => {
  const { HearthBridgeClient } = await import('../mcp/bridge/client.mjs');
  assert.equal(typeof HearthBridgeClient, 'function');
});

// ── 16. Manual Step Waiting & No Implicit Resume ────────────────────────────
await test('manual step enters waiting and cannot be implicitly approved by resume_goal', async () => {
  const storage = new GoalStorage({ storagePath });
  const runner = new GoalRunner({ storage });

  const goal = await runner.create_goal({
    title: 'Manual Gate',
    objective: 'Require explicit human sign-off',
    workspace: testWorkspace,
    steps: [
      { id: 'm1', title: 'Sign-off required', description: 'Requires human inspection', route: 'manual', required: true },
    ],
  });

  const res = await runner.run_goal(goal.id);
  assert.equal(res.status, 'waiting');
  assert.equal(res.steps[0].status, 'waiting');
  assert.equal(res.steps[0].route, 'manual');

  // Attempting to resume without explicit sign-off must fail
  await assert.rejects(
    async () => runner.resume_goal(goal.id),
    /Cannot resume goal on waiting manual step/i
  );

  const saved = storage.getGoal(goal.id);
  assert.equal(saved.status, 'waiting', 'Goal must stay waiting');
  assert.equal(saved.steps[0].status, 'waiting', 'Step must NOT auto-complete');
});

// ── 17. Manual Sign-off & Progression to Next Step ──────────────────────────
await test('manual sign-off marks step completed, creates sanitized checkpoint, and advances to next step', async () => {
  const storage = new GoalStorage({ storagePath });
  const runner = new GoalRunner({ storage });

  const goal = await runner.create_goal({
    title: 'Manual + Progression',
    objective: 'Test progression after sign-off',
    workspace: testWorkspace,
    steps: [
      { id: 's1', title: 'Human Review', description: 'Inspect diff', route: 'manual', required: true },
      { id: 's2', title: 'Automated follow-up', description: 'Run test', route: 'mcp', required: true },
    ],
  });

  // 1. Run goal: stops at step 1
  await runner.run_goal(goal.id);
  const waitingGoal = storage.getGoal(goal.id);
  assert.equal(waitingGoal.status, 'waiting');
  assert.equal(waitingGoal.currentStepId, 's1');
  assert.equal(waitingGoal.steps[0].status, 'waiting');

  // 2. Explicit sign-off with secret in note
  const signedOff = await runner.signoff_step(goal.id, 's1', {
    action: 'complete',
    note: 'Approved by human with key Bearer secret_adm_token_99999',
  });

  assert.equal(signedOff.steps[0].status, 'completed');
  assert(!signedOff.steps[0].result.includes('secret_adm_token_99999'), 'Secrets must be redacted');
  assert(signedOff.steps[0].result.includes('[REDACTED]'));
  assert.equal(signedOff.currentStepId, 's2', 'Current step must advance to next step');
  assert.equal(signedOff.status, 'ready');

  // Check checkpoint
  const latestCp = signedOff.checkpoints[signedOff.checkpoints.length - 1];
  assert.equal(latestCp.stepId, 's1');
  assert.equal(latestCp.nextStep, 's2');
  assert.equal(latestCp.route, 'manual');
  assert.equal(latestCp.completedSteps, 1);
  assert(!latestCp.summary.includes('secret_adm_token_99999'));

  // 3. Continue execution with run_goal
  const final = await runner.run_goal(goal.id);
  assert.equal(final.status, 'completed');
  assert.equal(final.steps[0].status, 'completed');
  assert.equal(final.steps[1].status, 'completed');
});

// ── 18. Double Sign-off Rejection ──────────────────────────────────────────
await test('double sign-off rejected: already completed step cannot be signed off again', async () => {
  const storage = new GoalStorage({ storagePath });
  const runner = new GoalRunner({ storage });

  const goal = await runner.create_goal({
    title: 'Double Signoff Gate',
    objective: 'Test idempotency / double signoff protection',
    workspace: testWorkspace,
    steps: [
      { id: 'm1', title: 'Sign-off required', description: 'Requires human inspection', route: 'manual', required: true },
    ],
  });

  await runner.run_goal(goal.id);
  await runner.signoff_step(goal.id, 'm1', { action: 'complete', note: 'First approval' });

  // Second sign-off attempt on already completed step must throw
  await assert.rejects(
    async () => runner.signoff_step(goal.id, 'm1', { action: 'complete', note: 'Second approval' }),
    /Cannot sign off step 'm1' with status 'completed'/i
  );
});

// ── 19. Wrong Step or Wrong State Rejection ────────────────────────────────
await test('wrong step or wrong state rejection', async () => {
  const storage = new GoalStorage({ storagePath });
  const runner = new GoalRunner({ storage });

  const goal = await runner.create_goal({
    title: 'Validation Gate',
    objective: 'Test invalid signoff parameters',
    workspace: testWorkspace,
    steps: [
      { id: 's1', title: 'Automated', description: 'MCP tool', route: 'mcp', required: true },
      { id: 's2', title: 'Manual', description: 'Human inspection', route: 'manual', required: true },
    ],
  });

  // Non-existent stepId
  await assert.rejects(
    async () => runner.signoff_step(goal.id, 'unknown-step'),
    /Step 'unknown-step' not found/i
  );

  // Signoff on non-manual step
  await assert.rejects(
    async () => runner.signoff_step(goal.id, 's1'),
    /Cannot sign off non-manual step 's1'/i
  );

  // Signoff on inactive step before reached
  await assert.rejects(
    async () => runner.signoff_step(goal.id, 's2'),
    /is not the active step/i
  );
});

// ── 20. Manual Step Fail Rejection ─────────────────────────────────────────
await test('manual step fail marks step error and fails goal', async () => {
  const storage = new GoalStorage({ storagePath });
  const runner = new GoalRunner({ storage });

  const goal = await runner.create_goal({
    title: 'Security Gate',
    objective: 'Test manual fail path',
    workspace: testWorkspace,
    steps: [
      { id: 's1', title: 'Audit step', description: 'Security audit', route: 'manual', required: true },
      { id: 's2', title: 'Next step', description: 'Should not run', route: 'mcp', required: true },
    ],
  });

  await runner.run_goal(goal.id);
  const failedGoal = await runner.signoff_step(goal.id, 's1', {
    action: 'fail',
    note: 'Rejected: unauthorized external connection detected',
  });

  assert.equal(failedGoal.status, 'error');
  assert.equal(failedGoal.steps[0].status, 'error');
  assert.equal(failedGoal.steps[1].status, 'pending', 'Subsequent step must remain pending');
  assert.match(failedGoal.error, /unauthorized external connection/);
});

// ── 21. CWD-Independent Startup & Module Resolution ───────────────────────
await test('packaged module resolution and dynamic import are independent of process.cwd', async () => {
  const originalCwd = process.cwd();
  const foreignDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hearth-foreign-cwd-'));
  try {
    process.chdir(foreignDir);
    // Dynamic import must resolve relative to module path, not foreign process.cwd()
    const { pathToFileURL } = await import('node:url');
    const runnerUrl = pathToFileURL(path.join(originalCwd, 'mcp/goals/runner.mjs')).href;
    const storageUrl = pathToFileURL(path.join(originalCwd, 'mcp/goals/storage.mjs')).href;
    const { GoalRunner: ImportedRunner } = await import(runnerUrl);
    const { GoalStorage: ImportedStorage } = await import(storageUrl);

    assert.equal(typeof ImportedRunner, 'function');
    assert.equal(typeof ImportedStorage, 'function');

    const testStorage = new ImportedStorage({ storagePath });
    const runner = new ImportedRunner({ storage: testStorage });
    assert.equal(typeof runner.create_goal, 'function');
    assert.equal(typeof runner.signoff_step, 'function');
  } finally {
    process.chdir(originalCwd);
    await fs.rm(foreignDir, { recursive: true, force: true }).catch(() => {});
  }
});

// ── 22. Final onProgress on successful completion ──────────────────────────
await test('run_goal: final onProgress receives completed goal with currentStepId null and finishedAt set', async () => {
  const storage = new GoalStorage({ storagePath });
  const runner = new GoalRunner({ storage });

  const goal = await runner.create_goal({
    title: 'Final Progress Goal',
    objective: 'Verify terminal onProgress fires',
    workspace: testWorkspace,
    steps: [
      { id: 's1', title: 'Step 1', description: '1', required: true },
      { id: 's2', title: 'Step 2', description: '2', required: true },
    ],
  });

  const progressEvents = [];
  const result = await runner.run_goal(goal.id, {
    onProgress: (g) => progressEvents.push({ status: g.status, currentStepId: g.currentStepId, finishedAt: g.finishedAt }),
    executeStepFn: async (_g, step) => ({ status: 'completed', result: `${step.id} done` }),
  });

  assert.equal(result.status, 'completed');
  const finalEvent = progressEvents[progressEvents.length - 1];
  assert.equal(finalEvent.status, 'completed', 'Last onProgress call must carry the terminal completed status');
  assert.equal(finalEvent.currentStepId, null, 'Final onProgress goal must have currentStepId cleared');
  assert.notEqual(finalEvent.finishedAt, null, 'Final onProgress goal must have finishedAt set');

  // Durable state must already reflect completion by the time onProgress fires --
  // enforced here by re-reading storage from inside the callback itself.
  let sawCompletedDuringCallback = false;
  await runner.run_goal(
    (await runner.create_goal({
      title: 'Order Check Goal',
      objective: 'Durable save precedes notification',
      workspace: testWorkspace,
      steps: [{ id: 'only', title: 'Only step', description: '1', required: true }],
    })).id,
    {
      onProgress: (g) => {
        if (g.status === 'completed') {
          const persisted = storage.getGoal(g.id);
          sawCompletedDuringCallback = persisted.status === 'completed';
        }
      },
      executeStepFn: async () => ({ status: 'completed', result: 'done' }),
    }
  );
  assert.equal(sawCompletedDuringCallback, true, 'Storage must already show completed when onProgress fires');
});

// ── 23. Final onProgress on failure ─────────────────────────────────────────
await test('run_goal: final onProgress receives failed goal when a required step errors', async () => {
  const storage = new GoalStorage({ storagePath });
  const runner = new GoalRunner({ storage });

  const goal = await runner.create_goal({
    title: 'Final Progress Failure Goal',
    objective: 'Verify terminal onProgress fires on failure',
    workspace: testWorkspace,
    steps: [
      { id: 's1', title: 'Failing required step', description: 'Breaks', required: true },
      { id: 's2', title: 'Subsequent step', description: 'Should not run', required: true },
    ],
  });

  const progressEvents = [];
  const result = await runner.run_goal(goal.id, {
    onProgress: (g) => progressEvents.push({ status: g.status, error: g.error, finishedAt: g.finishedAt }),
    executeStepFn: async () => ({ status: 'error', error: 'Build failed with syntax error' }),
  });

  assert.equal(result.status, 'error');
  const finalEvent = progressEvents[progressEvents.length - 1];
  assert.equal(finalEvent.status, 'error', 'Last onProgress call must carry the terminal failed status');
  assert.match(finalEvent.error, /Build failed with syntax error/);
  assert.notEqual(finalEvent.finishedAt, null, 'Final failed onProgress goal must have finishedAt set');

  const persisted = storage.getGoal(goal.id);
  assert.equal(persisted.status, 'error', 'Durable goal must already be failed when onProgress fires');
});

// ── 24. resume_goal delivers final completed onProgress ─────────────────────
await test('resume_goal: final onProgress receives completed goal after resuming a waiting step', async () => {
  const storage = new GoalStorage({ storagePath });
  const runner = new GoalRunner({ storage });

  const goal = await runner.create_goal({
    title: 'Resume Progress Goal',
    objective: 'Verify resume_goal delivers terminal onProgress',
    workspace: testWorkspace,
    steps: [
      { id: 's1', title: 'Automated step', description: 'Passes', route: 'mcp', required: true },
      { id: 's2', title: 'Review step', description: 'Requires review', route: 'mcp', required: true },
    ],
  });

  let s2ShouldWait = true;
  const executeStepFn = async (_g, step) => {
    if (step.id === 's1') return { status: 'completed', result: 'Step 1 done' };
    if (s2ShouldWait) return { status: 'waiting', result: 'Waiting on user approval' };
    return { status: 'completed', result: 'Step 2 done' };
  };

  const waitingResult = await runner.run_goal(goal.id, { executeStepFn });
  assert.equal(waitingResult.status, 'waiting');

  s2ShouldWait = false;
  const progressEvents = [];
  const resumed = await runner.resume_goal(goal.id, {
    onProgress: (g) => progressEvents.push({ status: g.status, currentStepId: g.currentStepId, finishedAt: g.finishedAt }),
    executeStepFn,
  });

  assert.equal(resumed.status, 'completed');
  const finalEvent = progressEvents[progressEvents.length - 1];
  assert.equal(finalEvent.status, 'completed', 'resume_goal must deliver a final completed onProgress event');
  assert.equal(finalEvent.currentStepId, null);
  assert.notEqual(finalEvent.finishedAt, null);
});

// Cleanup temp fixture
await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});

console.log(`\nResults: ${passed} passed, ${failed} failed out of ${passed + failed} tests\n`);
if (failed > 0) process.exit(1);
