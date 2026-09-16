import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

import {
  validateSpecialistExecution,
  validateSpecialistResult,
  deriveSpecialistExecutionId,
} from '../mcp/specialist/contract.mjs';

import {
  resolveCodexBinary,
  createOutputSchemaFile,
  formatSpecialistPrompt,
  parseCodexJsonlOutput,
  buildCodexArgs,
} from '../mcp/specialist/codex-adapter.mjs';

import {
  captureGitPreCheck,
  verifyGitPostCheck,
} from '../mcp/specialist/git-verifier.mjs';

import {
  isWorkspaceLocked,
  normalizeWorkspacePath,
} from '../mcp/specialist/workspace-lock.mjs';

import {
  createGoal,
  createReviewQueueItem,
} from '../mcp/goals/model.mjs';
import { GoalStorage } from '../mcp/goals/storage.mjs';
import { GoalRunner } from '../mcp/goals/runner.mjs';
import { JobManager } from '../mcp/runtime/job-manager.mjs';
import { parseXTask } from '../mcp/x/task-contract.mjs';

async function runTests() {
  console.log('=== Starting Slice 6A Specialist Codex Adapter Tests ===');

  const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'hearth-slice6a-test-'));

  try {
    // Test 1: CONTRACT VALIDATION
    console.log('[Test 1] Contract Validation...');
    const validExec = validateSpecialistExecution({
      version: 'specialist-execution-v1',
      id: 'specialist-exec:h1',
      handoffId: 'h1',
      target: 'codex',
      goalId: 'g1',
      stepId: 's1',
      source: { requestId: 'req1' },
    });
    assert.equal(validExec.version, 'specialist-execution-v1');
    assert.equal(validExec.status, 'authorized');

    const validRes = validateSpecialistResult({
      version: 'specialist-result-v1',
      id: 'r1',
      executionId: 'e1',
      handoffId: 'h1',
      goalId: 'g1',
      stepId: 's1',
      target: 'codex',
      status: 'completed',
    });
    assert.equal(validRes.version, 'specialist-result-v1');
    assert.equal(validRes.status, 'completed');

    // Test 5: DETERMINISTIC EXECUTION ID
    console.log('[Test 5] Deterministic Execution ID...');
    const execId1 = deriveSpecialistExecutionId('handoff1');
    const execId2 = deriveSpecialistExecutionId('handoff1');
    assert.equal(execId1, 'specialist-exec:handoff1');
    assert.equal(execId1, execId2);

    // Test 11: COMMAND BUILDER PROOF
    console.log('[Test 11] Command Builder Proof...');
    const args = buildCodexArgs({
      workspace: '/test/workspace',
      schemaPath: '/test/schema.json',
      outputPath: '/test/output.json',
    });
    assert.deepEqual(args, [
      '-a', 'never',
      'exec',
      '--json',
      '-C', '/test/workspace',
      '--sandbox', 'workspace-write',
      '--output-schema', '/test/schema.json',
      '-o', '/test/output.json',
      '-',
    ]);
    assert.equal(args[0], '-a');
    assert.equal(args[1], 'never');
    assert.equal(args[2], 'exec');
    assert.equal(args[args.indexOf('-C') + 1], '/test/workspace');
    assert.equal(args[args.indexOf('--sandbox') + 1], 'workspace-write');
    assert.equal(args[args.indexOf('--output-schema') + 1], '/test/schema.json');
    assert.equal(args[args.indexOf('-o') + 1], '/test/output.json');
    assert.equal(args[args.length - 1], '-');
    assert.ok(!args.includes('--approve-for-me'));
    assert.ok(!args.includes('danger-full-access'));
    assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));

    // Test 13: JSONL PARSER
    console.log('[Test 13] JSONL Parser...');
    const jsonlStdout = '{"type":"thread.started","session_id":"sess_12345"}\n{"type":"msg"}\n';
    const parsedJsonl = parseCodexJsonlOutput(jsonlStdout);
    assert.equal(parsedJsonl.sessionId, 'sess_12345');
    assert.equal(parsedJsonl.events.length, 2);

    // Test 16 & 17 & Fail-Closed Proof
    console.log('[Test Fail-Closed] Path Verification & Result Fail-Closed...');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(execFile);
    await execAsync('git', ['init'], { cwd: tmpBase });
    await execAsync('git', ['config', 'user.name', 'Test'], { cwd: tmpBase });
    await execAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpBase });
    await fs.writeFile(path.join(tmpBase, 'README.md'), '# Baseline\n');
    await execAsync('git', ['add', '.'], { cwd: tmpBase });
    await execAsync('git', ['commit', '-m', 'Initial commit'], { cwd: tmpBase });

    const mockPre = await captureGitPreCheck(tmpBase);
    const postPass = await verifyGitPostCheck(tmpBase, mockPre, {
      allowedPaths: ['src/**'],
      forbiddenPaths: ['secrets/**'],
    });
    assert.equal(postPass.allowedPathsValid, true);
    assert.equal(postPass.forbiddenPathsValid, true);

    await fs.writeFile(path.join(tmpBase, 'secrets.key'), 'confidential');
    const postFailForbidden = await verifyGitPostCheck(tmpBase, mockPre, {
      forbiddenPaths: ['secrets.key'],
    });
    assert.equal(postFailForbidden.forbiddenPathsValid, false);
    assert.ok(postFailForbidden.violations.length > 0);

    const postFailAllowed = await verifyGitPostCheck(tmpBase, mockPre, {
      allowedPaths: ['src/**'],
    });
    assert.equal(postFailAllowed.allowedPathsValid, false);
    assert.ok(postFailAllowed.violations.length > 0);

    // Test 12: JOBMANAGER STDIN
    console.log('[Test 12] JobManager Stdin handling...');
    const jobStorePath = path.join(tmpBase, 'jobs.json');
    const jobMgr = new JobManager({ storagePath: jobStorePath });
    const echoJob = jobMgr.startJob({
      command: 'cat',
      cwd: tmpBase,
      stdinPayload: 'hello stdin payload',
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(echoJob.stdout.includes('hello stdin payload'));

    // Test Workspace Lock Matrix A-G
    console.log('[Test Workspace Lock Matrix A-G] Workspace Locking Matrix...');
    const wsA = path.join(tmpBase, 'wsA');
    const wsB = path.join(tmpBase, 'wsB');
    await fs.mkdir(wsA, { recursive: true });
    await fs.mkdir(wsB, { recursive: true });

    const symlinkWsA = path.join(tmpBase, 'symlinkWsA');
    await fs.symlink(wsA, symlinkWsA);

    const lockJobMgr = new JobManager({ storagePath: path.join(tmpBase, 'lock-jobs.json') });
    lockJobMgr.jobs.set('job_spec_1', {
      id: 'job_spec_1',
      status: 'running',
      cwd: wsA,
      metadata: { workspace: wsA },
    });

    // A. Codex active -> GoalRunner X same workspace blocked
    const lockCheckA = isWorkspaceLocked(wsA, { jobManager: lockJobMgr });
    assert.equal(lockCheckA.locked, true);

    // B & C. Codex active -> runXTask on same workspace blocked
    const { runXTask } = await import('../mcp/x/run-x-task.mjs');
    const makeMockXTask = (ws) => parseXTask({
      version: 'x-task-v1',
      task_id: 'task_lock_test',
      parent_task_id: null,
      revision: 1,
      attempt: 1,
      based_on_result_id: null,
      objective: 'Lock test objective',
      problem: 'Lock test problem',
      expected_behavior: 'Lock test expected',
      observed_behavior: 'Lock test observed',
      why_this_matters: 'Lock test why',
      known_evidence: [],
      suspected_area: [],
      workspace: { repo: 'repo', root: ws },
      scope: { allowed_paths: ['src/**'], preferred_files: [], forbidden_paths: [] },
      constraints: { preserve: [], do_not: [] },
      allowed_tools: ['repo_read'],
      acceptance_criteria: ['Crit 1'],
      validation: { required: ['node -v'], optional: [] },
      verification: null,
      done_criteria: ['Done 1'],
      teaching_notes: [],
      uncertainty_policy: { policy: 'bounded_autonomy', stop_conditions: [] },
      repair_budget: { initial_attempts: 1, max_repairs: 2, max_total_rounds: 3 },
      timing: { estimated_minutes: 3, first_check_after_minutes: 1, soft_deadline_minutes: 3, hard_timeout_minutes: 10 },
      commit_policy: { mode: 'never' },
    });

    const runXResA = await runXTask(makeMockXTask(wsA), {}, {
      claimStore: { claim: () => ({ leaseId: '1' }), release: () => {}, storagePath: '/tmp/dummy' },
      runStore: { createRun: () => {}, markRunning: () => {}, completeRunFenced: () => {}, failRunFenced: () => {}, storagePath: '/tmp/dummy' },
      ownerId: 'owner1',
      jobManager: lockJobMgr,
    });
    assert.equal(runXResA.accepted, false);
    assert.equal(runXResA.reason, 'workspace_locked');

    // D. X active -> Codex same workspace blocked
    const mockClaimStore = {
      listActiveClaims: () => [{ claimId: 'claim_1', workspace: wsA, status: 'executing' }],
    };
    const lockCheckD = isWorkspaceLocked(wsA, { claimStore: mockClaimStore });
    assert.equal(lockCheckD.locked, true);

    // E. Codex workspace A active -> X workspace B remains unblocked
    const lockCheckE = isWorkspaceLocked(wsB, { jobManager: lockJobMgr });
    assert.equal(lockCheckE.locked, false);

    // F. X workspace A active -> Codex workspace B remains unblocked
    const lockCheckF = isWorkspaceLocked(wsB, { claimStore: mockClaimStore });
    assert.equal(lockCheckF.locked, false);

    // G. Symlink alias resolves to same workspace -> lock applies
    const lockCheckG = isWorkspaceLocked(symlinkWsA, { jobManager: lockJobMgr });
    assert.equal(lockCheckG.locked, true);

    // Test GoalRunner Specialist Execution Authorization & Dispatch
    console.log('[Test GoalRunner Integration] GoalRunner Integration...');
    const goalStoragePath = path.join(tmpBase, 'goals.json');
    const storage = new GoalStorage({ storagePath: goalStoragePath });
    const runner = new GoalRunner({ storage, jobManager: jobMgr });

    const wsDir = path.join(tmpBase, 'test-ws');
    await fs.mkdir(wsDir, { recursive: true });
    await execAsync('git', ['init'], { cwd: wsDir });
    await execAsync('git', ['config', 'user.name', 'Test'], { cwd: wsDir });
    await execAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: wsDir });
    await fs.writeFile(path.join(wsDir, 'README.md'), '# Test Repo\n');
    await execAsync('git', ['add', '.'], { cwd: wsDir });
    await execAsync('git', ['commit', '-m', 'Initial commit'], { cwd: wsDir });

    const makeValidXTask = (overrides = {}) => parseXTask({
      version: 'x-task-v1',
      task_id: 'task_slice6a_test_1',
      parent_task_id: null,
      revision: 1,
      attempt: 1,
      based_on_result_id: null,
      objective: 'Specialist test objective',
      problem: 'Specialist test problem',
      expected_behavior: 'Specialist test expected behavior',
      observed_behavior: 'Specialist test observed behavior',
      why_this_matters: 'Specialist test why this matters',
      known_evidence: [],
      suspected_area: [],
      workspace: { repo: 'test-repo', root: wsDir },
      scope: { allowed_paths: ['src/**'], preferred_files: [], forbidden_paths: [] },
      constraints: { preserve: [], do_not: [] },
      allowed_tools: ['repo_read'],
      acceptance_criteria: ['Acceptance criteria 1'],
      validation: { required: ['node -v'], optional: [] },
      verification: null,
      done_criteria: ['Done criteria 1'],
      teaching_notes: [],
      uncertainty_policy: { policy: 'bounded_autonomy', stop_conditions: [] },
      repair_budget: { initial_attempts: 1, max_repairs: 2, max_total_rounds: 3 },
      timing: { estimated_minutes: 3, first_check_after_minutes: 1, soft_deadline_minutes: 3, hard_timeout_minutes: 10 },
      commit_policy: { mode: 'never' },
      ...overrides,
    });

    const xTask = makeValidXTask();

    const goal = await runner.create_goal({
      title: 'Specialist Goal',
      objective: 'Test specialist authorization',
      workspace: wsDir,
      steps: [{ title: 'Step 1', route: 'x', xTask }],
    });

    goal.reviewQueue = [createReviewQueueItem({
      idempotencyKey: 'item1',
      stepId: goal.steps[0].id,
      runId: 'run1',
      resultId: 'res1',
      status: 'needs_review',
      lifecycle: 'open',
      reason: 'Needs specialist assistance',
    })];
    goal.steps[0].status = 'waiting';
    goal.steps[0].result = 'Step failed. Review required.';
    storage.saveGoal(goal);

    const handoffRes = await runner.request_specialist_handoff(goal.id, goal.steps[0].id, {
      target: 'codex',
      reason: 'Specialist required for refactor',
    });
    assert.equal(handoffRes.handoff.lifecycle, 'requested');

    let context = await runner.get_goal_context(goal.id);
    assert.equal(context.next_legal_action.type, 'SPECIALIST_HANDOFF_REQUESTED');

    const authRes = await runner.authorize_specialist_execution(goal.id, handoffRes.handoff.id);
    assert.equal(authRes.execution.status, 'authorized');

    const authRes2 = await runner.authorize_specialist_execution(goal.id, handoffRes.handoff.id);
    assert.equal(authRes2.execution.id, authRes.execution.id);

    context = await runner.get_goal_context(goal.id);
    assert.equal(context.next_legal_action.type, 'SPECIALIST_EXECUTION_AUTHORIZED');

    const lockCheck = isWorkspaceLocked(wsDir, { goalStorage: storage });
    assert.equal(lockCheck.locked, true);

    assert.equal(goal.reviewQueue[0].lifecycle, 'open');
    assert.notEqual(goal.status, 'completed');

    console.log('=== All Slice 6A Tests PASSED Successfully ===');
  } finally {
    await fs.rm(tmpBase, { recursive: true, force: true });
  }
}

runTests().catch((err) => {
  console.error('Slice 6A Test Failure:', err);
  process.exit(1);
});
