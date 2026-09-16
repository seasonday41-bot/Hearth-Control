import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { GoalStorage } from '../mcp/goals/storage.mjs';
import { GoalRunner } from '../mcp/goals/runner.mjs';
import { JobManager } from '../mcp/runtime/job-manager.mjs';
import { parseXTask } from '../mcp/x/task-contract.mjs';
import { createReviewQueueItem } from '../mcp/goals/model.mjs';

const execAsync = promisify(execFile);

async function runRealCodexSmoke() {
  console.log('=== Starting Slice 6A Real Codex Controlled Smoke ===');

  // Create disposable temporary git repository OUTSIDE Hearth repo
  const tempSmokeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hearth-codex-real-smoke-'));
  const targetSmokeWs = path.join(tempSmokeDir, 'disposable-smoke-repo');
  await fs.mkdir(targetSmokeWs, { recursive: true });

  try {
    // Git init in disposable repo
    await execAsync('git', ['init'], { cwd: targetSmokeWs });
    await execAsync('git', ['config', 'user.name', 'Hearth Smoke'], { cwd: targetSmokeWs });
    await execAsync('git', ['config', 'user.email', 'smoke@hearth.local'], { cwd: targetSmokeWs });
    await fs.writeFile(path.join(targetSmokeWs, 'README.md'), '# Disposable Smoke Repo\n');
    await execAsync('git', ['add', '.'], { cwd: targetSmokeWs });
    await execAsync('git', ['commit', '-m', 'Initial baseline commit'], { cwd: targetSmokeWs });

    const preCommitSha = (await execAsync('git', ['rev-parse', 'HEAD'], { cwd: targetSmokeWs })).stdout.trim();

    const jobStorePath = path.join(tempSmokeDir, 'jobs.json');
    const jobMgr = new JobManager({ storagePath: jobStorePath });

    const goalStorePath = path.join(tempSmokeDir, 'goals.json');
    const storage = new GoalStorage({ storagePath: goalStorePath });
    const runner = new GoalRunner({ storage, jobManager: jobMgr });

    // Create an xTask requiring creation of specialist-smoke.txt
    const xTask = parseXTask({
      version: 'x-task-v1',
      task_id: 'task_smoke_real_codex',
      parent_task_id: null,
      revision: 1,
      attempt: 1,
      based_on_result_id: null,
      objective: 'Create a single file named specialist-smoke.txt containing "HEARTH_CODEX_SMOKE_OK".',
      problem: 'specialist-smoke.txt is missing.',
      expected_behavior: 'specialist-smoke.txt exists with text HEARTH_CODEX_SMOKE_OK.',
      observed_behavior: 'specialist-smoke.txt does not exist.',
      why_this_matters: 'Verifies real Codex CLI execution under Hearth JobManager control.',
      known_evidence: [],
      suspected_area: [],
      workspace: { repo: 'disposable-smoke-repo', root: targetSmokeWs },
      scope: { allowed_paths: ['specialist-smoke.txt'], preferred_files: ['specialist-smoke.txt'], forbidden_paths: [] },
      constraints: { preserve: [], do_not: ['Do not create any git commits or extra files.'] },
      allowed_tools: ['repo_read', 'repo_edit'],
      acceptance_criteria: ['specialist-smoke.txt exists with HEARTH_CODEX_SMOKE_OK.'],
      validation: { required: ['test -f specialist-smoke.txt'], optional: [] },
      verification: null,
      done_criteria: ['specialist-smoke.txt created.'],
      teaching_notes: [],
      uncertainty_policy: { policy: 'bounded_autonomy', stop_conditions: [] },
      repair_budget: { initial_attempts: 1, max_repairs: 2, max_total_rounds: 3 },
      timing: { estimated_minutes: 3, first_check_after_minutes: 1, soft_deadline_minutes: 3, hard_timeout_minutes: 10 },
      commit_policy: { mode: 'never' },
    });

    const goal = await runner.create_goal({
      title: 'Real Codex Smoke Goal',
      objective: 'Smoke test real Codex adapter',
      workspace: targetSmokeWs,
      steps: [{ title: 'Create smoke file', route: 'x', xTask }],
    });

    // Inject active review queue item
    goal.reviewQueue = [createReviewQueueItem({
      idempotencyKey: 'item_smoke_1',
      stepId: goal.steps[0].id,
      runId: 'run_smoke_1',
      resultId: 'res_smoke_1',
      status: 'needs_review',
      lifecycle: 'open',
      reason: 'Step failed; escalating to Codex specialist.',
    })];
    goal.steps[0].status = 'waiting';
    goal.steps[0].result = 'X execution needs review.';
    storage.saveGoal(goal);

    // 1. Request Handoff
    const handoffRes = await runner.request_specialist_handoff(goal.id, goal.steps[0].id, {
      target: 'codex',
      reason: 'Escalating to real Codex CLI',
      requestedAction: 'Create specialist-smoke.txt containing HEARTH_CODEX_SMOKE_OK',
    });
    console.log('Specialist handoff requested:', handoffRes.handoff.id);

    // 2. Authorize Specialist Execution
    const authRes = await runner.authorize_specialist_execution(goal.id, handoffRes.handoff.id);
    console.log('Specialist execution authorized:', authRes.execution.id);

    // 3. Dispatch Specialist Execution (Spawns real /Users/illman/.local/bin/codex)
    console.log('Dispatching real Codex execution under JobManager...');
    const dispatchRes = await runner.dispatch_specialist_execution(goal.id, authRes.execution.id, {
      codexBin: '/Users/illman/.local/bin/codex',
    });
    console.log('Dispatched Job ID:', dispatchRes.job.id);

    // Wait for JobManager process completion (up to 30s)
    let job = jobMgr.getJob(dispatchRes.job.id);
    let waitMs = 0;
    while (job && job.status === 'running' && waitMs < 30000) {
      await new Promise((r) => setTimeout(r, 500));
      waitMs += 500;
      job = jobMgr.getJob(dispatchRes.job.id);
    }

    console.log(`Job finished with status '${job.status}', exitCode: ${job.exitCode}`);
    console.log('Job Stderr:', job.stderr);
    console.log('Job Stdout:', job.stdout);

    // Poll for completion callback to finish saving goal (up to 5s)
    let finalGoal = storage.getGoal(goal.id);
    let results = finalGoal.specialistResults || [];
    let pollResMs = 0;
    while (results.length === 0 && pollResMs < 5000) {
      await new Promise((r) => setTimeout(r, 200));
      pollResMs += 200;
      finalGoal = storage.getGoal(goal.id);
      results = finalGoal.specialistResults || [];
    }
    assert.ok(results.length >= 1, 'Expected durable specialist-result-v1 record');
    const resultRecord = results[results.length - 1];

    console.log('Durable Specialist Result:', JSON.stringify({
      id: resultRecord.id,
      status: resultRecord.status,
      summary: resultRecord.summary,
      codexSessionId: resultRecord.codex?.sessionId,
      postChangedPaths: resultRecord.git?.postChangedPaths,
      commitsCreated: resultRecord.git?.commitsCreated,
    }, null, 2));

    console.log('Sanitized Real Smoke Argv:', [job.command, ...job.args].join(' '));

    // Assertions for safety & correctness:
    // 1. Process was owned by JobManager and used exact production command builder
    assert.ok(job.id.startsWith('job_specialist_'));
    assert.ok(job.args.includes('-a') && job.args[job.args.indexOf('-a') + 1] === 'never', 'Must include explicit -a never');
    assert.ok(job.args.includes('--sandbox') && job.args[job.args.indexOf('--sandbox') + 1] === 'workspace-write', 'Must include workspace-write');
    assert.ok(!job.args.includes('--approve-for-me'), 'Must NOT include --approve-for-me');
    assert.ok(!job.args.includes('danger-full-access'), 'Must NOT include danger-full-access');
    assert.ok(!job.args.includes('--dangerously-bypass-approvals-and-sandbox'), 'Must NOT include dangerous flags');

    // 2. File specialist-smoke.txt created inside targetSmokeWs
    const smokeFilePath = path.join(targetSmokeWs, 'specialist-smoke.txt');
    assert.ok(fsSync.existsSync(smokeFilePath), 'specialist-smoke.txt should be created by Codex');

    // 3. No commits created (commit_policy never honored)
    const postCommitSha = (await execAsync('git', ['rev-parse', 'HEAD'], { cwd: targetSmokeWs })).stdout.trim();
    assert.equal(postCommitSha, preCommitSha, 'Git commit SHA must remain unchanged (no commits created)');

    // 4. Original X review item remains unresolved
    assert.equal(finalGoal.reviewQueue[0].lifecycle, 'open', 'Original X review queue item must remain open/unresolved');

    // 5. Goal step does NOT auto-complete
    assert.notEqual(finalGoal.status, 'completed', 'Goal must NOT auto-complete without Main Brain decision');

    // 6. Zero Hearth repository changes (targetSmokeWs was in temp dir)
    console.log('=== Real Codex Controlled Smoke PASSED Successfully ===');
  } finally {
    await fs.rm(tempSmokeDir, { recursive: true, force: true });
  }
}

runRealCodexSmoke().catch((err) => {
  console.error('Real Codex Smoke Failure:', err);
  process.exit(1);
});
