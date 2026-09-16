import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

import {
  validateSpecialistResultDecision,
  SPECIALIST_DECISION_STATES,
} from '../mcp/specialist/contract.mjs';

import {
  createGoal,
  createReviewQueueItem,
} from '../mcp/goals/model.mjs';
import { GoalStorage } from '../mcp/goals/storage.mjs';
import { GoalRunner } from '../mcp/goals/runner.mjs';
import { X_TASK_VERSION } from '../mcp/x/task-contract.mjs';
import { computeXTaskFingerprint } from '../mcp/x/fingerprint.mjs';

const xTaskFor = (root, taskId, objective = 'Second step objective', overrides = {}) => ({
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

async function runTests() {
  console.log('=== Starting Slice 6B Specialist Result Decision Tests ===');

  const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'hearth-slice6b-test-'));

  try {
    // ----------------------------------------------------
    // Test 1: DECISION CONTRACT VALIDATION
    // ----------------------------------------------------
    console.log('[Test 1] Decision Contract Validation...');
    const validDec = validateSpecialistResultDecision({
      version: 'specialist-result-decision-v1',
      id: 'specialist-decision:res-1',
      resultId: 'res-1',
      executionId: 'exec-1',
      handoffId: 'handoff-1',
      goalId: 'g1',
      stepId: 's1',
      decision: 'accepted',
      decidedAt: new Date().toISOString(),
      decidedBy: 'human',
      note: 'Looks good',
    });
    assert.equal(validDec.version, 'specialist-result-decision-v1');
    assert.equal(validDec.decision, 'accepted');
    assert.equal(validDec.id, 'specialist-decision:res-1');

    const invalidDec = validateSpecialistResultDecision({
      version: 'specialist-result-decision-v1',
      id: 'specialist-decision:res-1',
      resultId: 'res-1',
      executionId: 'exec-1',
      handoffId: 'handoff-1',
      goalId: 'g1',
      stepId: 's1',
      decision: 'invalid_decision',
    });
    assert.equal(invalidDec, null);

    // Setup helper for Goal & GoalRunner
    const setupEnv = async (dirName) => {
      const dbPath = path.join(tmpBase, `${dirName}.json`);
      const storage = new GoalStorage(dbPath);
      storage.load();
      const runner = new GoalRunner(storage);
      return { storage, runner, dbPath };
    };

    // Helper to create standard 3-step goal with step 2 blocked by X review and having specialist result
    const createFixtureGoal = (opts = {}) => {
      const resultStatus = opts.resultStatus || 'completed';
      const reviewStatus = opts.reviewStatus || 'needs_review';
      const step2Status = opts.step2Status || 'waiting';

      const g = createGoal({
        id: 'goal-6b-test',
        title: 'Slice 6B Test Goal',
        objective: 'Slice 6B Test Goal Objective',
        workspace: '/tmp/test-ws',
        reqId: 'req-6b',
        runId: 'run-6b',
        steps: [
          { id: 'step-1', title: 'Step 1', prompt: 'First step', status: 'completed' },
          {
            id: 'step-2',
            title: 'Step 2',
            prompt: 'Second step',
            status: step2Status,
            route: 'x',
            executionGeneration: 1,
            requestId: 'goal:goal-6b-test:step:step-2',
            runId: 'run-x-1',
            resultId: 'res-x-1',
            xTask: xTaskFor('/tmp/test-ws', 'task-step-2'),
          },
          { id: 'step-3', title: 'Step 3', prompt: 'Third step', status: 'pending' },
        ],
      });

      g.currentStepId = 'step-2';
      g.status = 'waiting';
      const fp = computeXTaskFingerprint(g.steps[1].xTask, '/tmp/test-ws');
      const revItem = createReviewQueueItem({
        idempotencyKey: 'ik-1',
        stepId: 'step-2',
        runId: 'run-x-1',
        resultId: 'res-x-1',
        status: reviewStatus,
        lifecycle: 'open',
        reason: 'Review required',
      });
      revItem.requestId = 'goal:goal-6b-test:step:step-2';
      revItem.executionGeneration = 1;
      revItem.fingerprint = fp;
      g.reviewQueue = [revItem];
      g.specialistHandoffs = [
        {
          version: 'specialist-handoff-request-v1',
          id: 'handoff-1',
          target: 'codex',
          goalId: 'goal-6b-test',
          stepId: 'step-2',
          source: {
            requestId: 'goal:goal-6b-test:step:step-2',
            runId: 'run-x-1',
            resultId: 'res-x-1',
            executionGeneration: 1,
            xTaskFingerprint: fp,
            terminalStatus: reviewStatus,
          },
          createdAt: new Date().toISOString(),
          requestedBy: 'human',
        },
      ];
      g.specialistExecutions = [
        {
          version: 'specialist-execution-v1',
          id: 'specialist-exec:handoff-1',
          handoffId: 'handoff-1',
          target: 'codex',
          goalId: 'goal-6b-test',
          stepId: 'step-2',
          source: g.specialistHandoffs[0].source,
          authorizedAt: new Date().toISOString(),
          authorizedBy: 'human',
          status: 'completed',
        },
      ];
      g.specialistResults = [
        {
          version: 'specialist-result-v1',
          id: 'res-spec-1',
          executionId: 'specialist-exec:handoff-1',
          handoffId: 'handoff-1',
          goalId: 'goal-6b-test',
          stepId: 'step-2',
          target: 'codex',
          status: resultStatus,
          summary: 'Specialist completed changes successfully',
          artifacts: ['diff.txt'],
          completedAt: new Date().toISOString(),
        },
      ];

      return g;
    };

    // ----------------------------------------------------
    // Test 2: SPECIALIST RESULT IMMUTABILITY
    // ----------------------------------------------------
    console.log('[Test 2] Specialist Result Immutability...');
    {
      const { storage, runner } = await setupEnv('t2');
      const g = createFixtureGoal();
      await storage.saveGoal(g);

      const loadedG = await storage.getGoal('goal-6b-test');
      const originalResultJson = JSON.stringify(loadedG.specialistResults[0]);
      await runner.accept_specialist_result('goal-6b-test', 'res-spec-1', { decidedBy: 'test' });
      const updatedG = await storage.getGoal('goal-6b-test');
      const afterAcceptJson = JSON.stringify(updatedG.specialistResults[0]);

      assert.equal(originalResultJson, afterAcceptJson, 'Specialist result must remain byte/logically unchanged after accept');
    }

    // ----------------------------------------------------
    // Test 3: ACCEPT COMPLETED RESULT
    // ----------------------------------------------------
    console.log('[Test 3] Accept Completed Result...');
    {
      const { storage, runner } = await setupEnv('t3');
      const g = createFixtureGoal();
      await storage.saveGoal(g);

      const res = await runner.accept_specialist_result('goal-6b-test', 'res-spec-1', { decidedBy: 'tester', note: 'accepting' });
      assert.equal(res.accepted, true);
      assert.equal(res.decision.decision, 'accepted');

      const updatedG = await storage.getGoal('goal-6b-test');
      assert.equal(updatedG.specialistResultDecisions.length, 1);
      assert.equal(updatedG.specialistResultDecisions[0].decision, 'accepted');
      assert.equal(updatedG.steps[1].status, 'completed');
      assert.equal(updatedG.status, 'ready');
      assert.equal(updatedG.currentStepId, 'step-3');
      assert.equal(updatedG.reviewQueue[0].lifecycle, 'superseded');
    }

    // ----------------------------------------------------
    // Test 4: ACCEPT NEEDS_REVIEW REJECTED
    // ----------------------------------------------------
    console.log('[Test 4] Accept Needs_Review Rejected...');
    {
      const { storage, runner } = await setupEnv('t4');
      const g = createFixtureGoal({ resultStatus: 'needs_review' });
      await storage.saveGoal(g);

      await assert.rejects(
        runner.accept_specialist_result('goal-6b-test', 'res-spec-1'),
        /only 'completed' results may be accepted/
      );
    }

    // ----------------------------------------------------
    // Test 5: ACCEPT FAILED REJECTED
    // ----------------------------------------------------
    console.log('[Test 5] Accept Failed Rejected...');
    {
      const { storage, runner } = await setupEnv('t5');
      const g = createFixtureGoal({ resultStatus: 'failed' });
      await storage.saveGoal(g);

      await assert.rejects(
        runner.accept_specialist_result('goal-6b-test', 'res-spec-1'),
        /only 'completed' results may be accepted/
      );
    }

    // ----------------------------------------------------
    // Test 6: ACCEPT INTERRUPTED REJECTED
    // ----------------------------------------------------
    console.log('[Test 6] Accept Interrupted Rejected...');
    {
      const { storage, runner } = await setupEnv('t6');
      const g = createFixtureGoal({ resultStatus: 'interrupted' });
      await storage.saveGoal(g);

      await assert.rejects(
        runner.accept_specialist_result('goal-6b-test', 'res-spec-1'),
        /only 'completed' results may be accepted/
      );
    }

    // ----------------------------------------------------
    // Test 7: X needs_review -> specialist accepted -> review becomes superseded
    // ----------------------------------------------------
    console.log('[Test 7] X Needs_Review -> Specialist Accepted...');
    {
      const { storage, runner } = await setupEnv('t7');
      const g = createFixtureGoal({ reviewStatus: 'needs_review' });
      await storage.saveGoal(g);

      await runner.accept_specialist_result('goal-6b-test', 'res-spec-1');
      const updatedG = await storage.getGoal('goal-6b-test');
      assert.equal(updatedG.reviewQueue[0].lifecycle, 'superseded');
      assert.equal(typeof updatedG.reviewQueue[0].supersededAt, 'string');
    }

    // ----------------------------------------------------
    // Test 8: X failed -> specialist accepted -> review becomes superseded
    // ----------------------------------------------------
    console.log('[Test 8] X Failed -> Specialist Accepted...');
    {
      const { storage, runner } = await setupEnv('t8');
      const g = createFixtureGoal({ reviewStatus: 'failed' });
      await storage.saveGoal(g);

      await runner.accept_specialist_result('goal-6b-test', 'res-spec-1');
      const updatedG = await storage.getGoal('goal-6b-test');
      assert.equal(updatedG.reviewQueue[0].lifecycle, 'superseded');
    }

    // ----------------------------------------------------
    // Test 9: REJECT COMPLETED -> original review remains open/acknowledged
    // ----------------------------------------------------
    console.log('[Test 9] Reject Completed -> Original Review Remains Open...');
    {
      const { storage, runner } = await setupEnv('t9');
      const g = createFixtureGoal();
      await storage.saveGoal(g);

      const res = await runner.reject_specialist_result('goal-6b-test', 'res-spec-1', { note: 'Not what we wanted' });
      assert.equal(res.rejected, true);
      assert.equal(res.decision.decision, 'rejected');

      const updatedG = await storage.getGoal('goal-6b-test');
      assert.equal(updatedG.reviewQueue[0].lifecycle, 'open');
      assert.equal(updatedG.steps[1].status, 'waiting');
      assert.equal(updatedG.status, 'waiting');
    }

    // ----------------------------------------------------
    // Test 10: DOUBLE ACCEPT IDEMPOTENT
    // ----------------------------------------------------
    console.log('[Test 10] Double Accept Idempotent...');
    {
      const { storage, runner } = await setupEnv('t10');
      const g = createFixtureGoal();
      await storage.saveGoal(g);

      const res1 = await runner.accept_specialist_result('goal-6b-test', 'res-spec-1');
      const checkpointsCount1 = (await storage.getGoal('goal-6b-test')).checkpoints.length;

      const res2 = await runner.accept_specialist_result('goal-6b-test', 'res-spec-1');
      const checkpointsCount2 = (await storage.getGoal('goal-6b-test')).checkpoints.length;

      assert.equal(res2.idempotent, true);
      assert.equal(checkpointsCount1, checkpointsCount2, 'No duplicate checkpoint on idempotent accept');
    }

    // ----------------------------------------------------
    // Test 11: DOUBLE REJECT IDEMPOTENT
    // ----------------------------------------------------
    console.log('[Test 11] Double Reject Idempotent...');
    {
      const { storage, runner } = await setupEnv('t11');
      const g = createFixtureGoal();
      await storage.saveGoal(g);

      const res1 = await runner.reject_specialist_result('goal-6b-test', 'res-spec-1');
      const checkpointsCount1 = (await storage.getGoal('goal-6b-test')).checkpoints.length;

      const res2 = await runner.reject_specialist_result('goal-6b-test', 'res-spec-1');
      const checkpointsCount2 = (await storage.getGoal('goal-6b-test')).checkpoints.length;

      assert.equal(res2.idempotent, true);
      assert.equal(checkpointsCount1, checkpointsCount2, 'No duplicate checkpoint on idempotent reject');
    }

    // ----------------------------------------------------
    // Test 12: ACCEPT AFTER REJECT FAILS
    // ----------------------------------------------------
    console.log('[Test 12] Accept After Reject Fails...');
    {
      const { storage, runner } = await setupEnv('t12');
      const g = createFixtureGoal();
      await storage.saveGoal(g);

      await runner.reject_specialist_result('goal-6b-test', 'res-spec-1');
      await assert.rejects(
        runner.accept_specialist_result('goal-6b-test', 'res-spec-1'),
        /previously rejected/
      );
    }

    // ----------------------------------------------------
    // Test 13: REJECT AFTER ACCEPT FAILS
    // ----------------------------------------------------
    console.log('[Test 13] Reject After Accept Fails...');
    {
      const { storage, runner } = await setupEnv('t13');
      const g = createFixtureGoal();
      await storage.saveGoal(g);

      await runner.accept_specialist_result('goal-6b-test', 'res-spec-1');
      await assert.rejects(
        runner.reject_specialist_result('goal-6b-test', 'res-spec-1'),
        /previously accepted/
      );
    }

    // ----------------------------------------------------
    // Test 14: STALE AFTER X RETRY FAILS
    // ----------------------------------------------------
    console.log('[Test 14] Stale After X Retry Fails...');
    {
      const { storage, runner } = await setupEnv('t14');
      const g = createFixtureGoal();
      g.steps[1].executionGeneration = 2; // Incremented by retry
      await storage.saveGoal(g);

      await assert.rejects(
        runner.accept_specialist_result('goal-6b-test', 'res-spec-1'),
        /is stale/
      );
    }

    // ----------------------------------------------------
    // Test 15: STALE AFTER X TASK FINGERPRINT CHANGE FAILS
    // ----------------------------------------------------
    console.log('[Test 15] Stale After X Task Fingerprint Change Fails...');
    {
      const { storage, runner } = await setupEnv('t15');
      const g = createFixtureGoal();
      g.steps[1].xTask.objective = 'Changed objective that alters fingerprint';
      await storage.saveGoal(g);

      await assert.rejects(
        runner.accept_specialist_result('goal-6b-test', 'res-spec-1'),
        /is stale/
      );
    }

    // ----------------------------------------------------
    // Test 16: STALE AFTER ORIGINAL REVIEW RESOLVED FAILS
    // ----------------------------------------------------
    console.log('[Test 16] Stale After Original Review Resolved Fails...');
    {
      const { storage, runner } = await setupEnv('t16');
      const g = createFixtureGoal();
      g.reviewQueue[0].lifecycle = 'resolved';
      await storage.saveGoal(g);

      await assert.rejects(
        runner.accept_specialist_result('goal-6b-test', 'res-spec-1'),
        /is stale/
      );
    }

    // ----------------------------------------------------
    // Test 17: STALE WHEN NEWER SPECIALIST RESULT EXISTS FAILS
    // ----------------------------------------------------
    console.log('[Test 17] Stale When Newer Specialist Result Exists Fails...');
    {
      const { storage, runner } = await setupEnv('t17');
      const g = createFixtureGoal();
      g.specialistExecutions.push({
        version: 'specialist-execution-v1',
        id: 'specialist-exec:handoff-2',
        handoffId: 'handoff-2',
        target: 'codex',
        goalId: 'goal-6b-test',
        stepId: 'step-2',
        source: g.specialistHandoffs[0].source,
        authorizedAt: new Date(Date.now() + 10000).toISOString(),
        authorizedBy: 'human',
        status: 'authorized',
      });
      await storage.saveGoal(g);

      await assert.rejects(
        runner.accept_specialist_result('goal-6b-test', 'res-spec-1'),
        /is stale/
      );
    }

    // ----------------------------------------------------
    // Test 18: STEP X LINEAGE PRESERVED
    // ----------------------------------------------------
    console.log('[Test 18] Step X Lineage Preserved...');
    {
      const { storage, runner } = await setupEnv('t18');
      const g = createFixtureGoal();
      await storage.saveGoal(g);

      await runner.accept_specialist_result('goal-6b-test', 'res-spec-1');
      const updatedG = await storage.getGoal('goal-6b-test');
      const s2 = updatedG.steps[1];
      assert.ok(s2.xTask);
      assert.equal(updatedG.specialistHandoffs[0].source.requestId, 'goal:goal-6b-test:step:step-2');
      assert.equal(updatedG.specialistHandoffs[0].source.runId, 'run-x-1');
      assert.equal(updatedG.specialistHandoffs[0].source.resultId, 'res-x-1');
      assert.equal(updatedG.reviewQueue[0].runId, 'run-x-1');
    }

    // ----------------------------------------------------
    // Test 19: SPECIALIST EVIDENCE LINKED
    // ----------------------------------------------------
    console.log('[Test 19] Specialist Evidence Linked...');
    {
      const { storage, runner } = await setupEnv('t19');
      const g = createFixtureGoal();
      await storage.saveGoal(g);

      await runner.accept_specialist_result('goal-6b-test', 'res-spec-1');
      const updatedG = await storage.getGoal('goal-6b-test');
      const s2 = updatedG.steps[1];
      assert.equal(s2.evidence.specialistResultId, 'res-spec-1');
      assert.equal(s2.evidence.specialistExecutionId, 'specialist-exec:handoff-1');
      assert.equal(s2.evidence.specialistHandoffId, 'handoff-1');
    }

    // ----------------------------------------------------
    // Test 20: NON-FINAL ACCEPT -> Goal ready, currentStepId correct, zero dispatch
    // ----------------------------------------------------
    console.log('[Test 20] Non-Final Accept...');
    {
      const { storage, runner } = await setupEnv('t20');
      const g = createFixtureGoal();
      await storage.saveGoal(g);

      let dispatched = false;
      runner.runXForGoalStep = async () => { dispatched = true; };

      await runner.accept_specialist_result('goal-6b-test', 'res-spec-1');
      const updatedG = await storage.getGoal('goal-6b-test');
      assert.equal(updatedG.status, 'ready');
      assert.equal(updatedG.currentStepId, 'step-3');
      assert.equal(dispatched, false, 'Zero automatic dispatch on accept');
    }

    // ----------------------------------------------------
    // Test 21: FINAL ACCEPT -> Goal completed exactly once
    // ----------------------------------------------------
    console.log('[Test 21] Final Accept...');
    {
      const { storage, runner } = await setupEnv('t21');
      const g = createFixtureGoal();
      // Make step-2 the final step by completing step-3
      g.steps[2].status = 'completed';
      await storage.saveGoal(g);

      await runner.accept_specialist_result('goal-6b-test', 'res-spec-1');
      const updatedG = await storage.getGoal('goal-6b-test');
      assert.equal(updatedG.status, 'completed');
      assert.equal(updatedG.steps[1].status, 'completed');
    }

    // ----------------------------------------------------
    // Test 22: ACCEPT DOES NOT MODIFY X APPROVAL
    // ----------------------------------------------------
    console.log('[Test 22] Accept Does Not Modify X Approval...');
    {
      const { storage, runner } = await setupEnv('t22');
      const g = createFixtureGoal();
      g.xApproval = { approvedAt: '2026-01-01T00:00:00Z', workspaceRoot: '/tmp/test-ws', steps: [{ stepId: 'step-2', xTaskFingerprint: 'fp-1' }] };
      await storage.saveGoal(g);

      await runner.accept_specialist_result('goal-6b-test', 'res-spec-1');
      const updatedG = await storage.getGoal('goal-6b-test');
      assert.deepEqual(updatedG.xApproval, g.xApproval);
    }

    // ----------------------------------------------------
    // Test 23: REJECT DOES NOT MODIFY X APPROVAL
    // ----------------------------------------------------
    console.log('[Test 23] Reject Does Not Modify X Approval...');
    {
      const { storage, runner } = await setupEnv('t23');
      const g = createFixtureGoal();
      g.xApproval = { approvedAt: '2026-01-01T00:00:00Z', workspaceRoot: '/tmp/test-ws', steps: [{ stepId: 'step-2', xTaskFingerprint: 'fp-1' }] };
      await storage.saveGoal(g);

      await runner.reject_specialist_result('goal-6b-test', 'res-spec-1');
      const updatedG = await storage.getGoal('goal-6b-test');
      assert.deepEqual(updatedG.xApproval, g.xApproval);
    }

    // ----------------------------------------------------
    // Test 24: CONTEXT pending decision -> WAIT_FOR_SPECIALIST_RESULT_DECISION
    // ----------------------------------------------------
    console.log('[Test 24] Context Pending Decision...');
    {
      const { storage, runner } = await setupEnv('t24');
      const g = createFixtureGoal();
      await storage.saveGoal(g);

      const ctx = await runner.get_goal_context('goal-6b-test');
      assert.equal(ctx.next_legal_action.type, 'WAIT_FOR_SPECIALIST_RESULT_DECISION');
      assert.equal(ctx.next_legal_action.result_id, 'res-spec-1');
    }

    // ----------------------------------------------------
    // Test 25: CONTEXT rejected result falls back to original review
    // ----------------------------------------------------
    console.log('[Test 25] Context Rejected Result Fallback...');
    {
      const { storage, runner } = await setupEnv('t25');
      const g = createFixtureGoal();
      await storage.saveGoal(g);

      await runner.reject_specialist_result('goal-6b-test', 'res-spec-1');
      const ctx = await runner.get_goal_context('goal-6b-test');
      assert.equal(ctx.next_legal_action.type, 'WAIT_FOR_REVIEW');
      assert.equal(ctx.review.status, 'needs_review');
    }

    // ----------------------------------------------------
    // Test 26: CONTEXT accepted non-final -> CONTINUE_NEXT_STEP or RUN_CURRENT_STEP
    // ----------------------------------------------------
    console.log('[Test 26] Context Accepted Non-Final...');
    {
      const { storage, runner } = await setupEnv('t26');
      const g = createFixtureGoal();
      await storage.saveGoal(g);

      await runner.accept_specialist_result('goal-6b-test', 'res-spec-1');
      const ctx = await runner.get_goal_context('goal-6b-test');
      assert.ok(['CONTINUE_NEXT_STEP', 'RUN_CURRENT_STEP', 'WAIT_FOR_APPROVAL'].includes(ctx.next_legal_action.type));
      assert.equal(ctx.progress.current_step_id, 'step-3');
    }

    // ----------------------------------------------------
    // Test 27: CONTEXT accepted final -> GOAL_COMPLETED
    // ----------------------------------------------------
    console.log('[Test 27] Context Accepted Final...');
    {
      const { storage, runner } = await setupEnv('t27');
      const g = createFixtureGoal();
      g.steps[2].status = 'completed';
      await storage.saveGoal(g);

      await runner.accept_specialist_result('goal-6b-test', 'res-spec-1');
      const ctx = await runner.get_goal_context('goal-6b-test');
      assert.equal(ctx.next_legal_action.type, 'GOAL_COMPLETED');
      assert.equal(ctx.goal.status, 'completed');
    }

    // ----------------------------------------------------
    // Test 28: RESTART accepted -> same completed Step, superseded review, no duplicate
    // ----------------------------------------------------
    console.log('[Test 28] Restart Accepted...');
    {
      const { storage, runner, dbPath } = await setupEnv('t28');
      const g = createFixtureGoal();
      await storage.saveGoal(g);

      await runner.accept_specialist_result('goal-6b-test', 'res-spec-1');

      // Restart runner with fresh storage instance reading same dbPath
      const storage2 = new GoalStorage(dbPath);
      storage2.load();
      const runner2 = new GoalRunner(storage2);

      const restartedG = await storage2.getGoal('goal-6b-test');
      assert.equal(restartedG.steps[1].status, 'completed');
      assert.equal(restartedG.status, 'ready');
      assert.equal(restartedG.currentStepId, 'step-3');
      assert.equal(restartedG.reviewQueue[0].lifecycle, 'superseded');

      const ctx = await runner2.get_goal_context('goal-6b-test');
      assert.equal(ctx.progress.current_step_id, 'step-3');
    }

    // ----------------------------------------------------
    // Test 29: RESTART rejected -> original review active, Goal blocked
    // ----------------------------------------------------
    console.log('[Test 29] Restart Rejected...');
    {
      const { storage, runner, dbPath } = await setupEnv('t29');
      const g = createFixtureGoal();
      await storage.saveGoal(g);

      await runner.reject_specialist_result('goal-6b-test', 'res-spec-1');

      const storage2 = new GoalStorage(dbPath);
      storage2.load();
      const runner2 = new GoalRunner(storage2);

      const restartedG = await storage2.getGoal('goal-6b-test');
      assert.equal(restartedG.steps[1].status, 'waiting');
      assert.equal(restartedG.status, 'waiting');
      assert.equal(restartedG.reviewQueue[0].lifecycle, 'open');

      const ctx = await runner2.get_goal_context('goal-6b-test');
      assert.equal(ctx.next_legal_action.type, 'WAIT_FOR_REVIEW');
    }

    // ----------------------------------------------------
    // Test 30: MCP/IPC roundtrip helper test
    // ----------------------------------------------------
    console.log('[Test 30] MCP Decision Retrieval...');
    {
      const { storage, runner } = await setupEnv('t30');
      const g = createFixtureGoal();
      await storage.saveGoal(g);

      const noDec = await runner.get_specialist_result_decision('goal-6b-test', 'res-spec-1');
      assert.equal(noDec, null);

      await runner.accept_specialist_result('goal-6b-test', 'res-spec-1');
      const dec = await runner.get_specialist_result_decision('goal-6b-test', 'res-spec-1');
      assert.ok(dec);
      assert.equal(dec.decision, 'accepted');
    }

    // ----------------------------------------------------
    // Test 31: ZERO AUTOMATIC X DISPATCH
    // ----------------------------------------------------
    console.log('[Test 31] Zero Automatic X Dispatch...');
    {
      const { storage, runner } = await setupEnv('t31');
      const g = createFixtureGoal();
      await storage.saveGoal(g);

      let xDispatched = false;
      runner.runXForGoalStep = async () => { xDispatched = true; };

      await runner.accept_specialist_result('goal-6b-test', 'res-spec-1');
      assert.equal(xDispatched, false);

      await runner.reject_specialist_result('goal-6b-test', 'res-spec-1').catch(() => {});
      assert.equal(xDispatched, false);
    }

    // ----------------------------------------------------
    // Test 32: ZERO AUTOMATIC CODEX DISPATCH
    // ----------------------------------------------------
    console.log('[Test 32] Zero Automatic Codex Dispatch...');
    {
      const { storage, runner } = await setupEnv('t32');
      const g = createFixtureGoal();
      await storage.saveGoal(g);

      let codexDispatched = false;
      runner.dispatch_specialist_execution = async () => { codexDispatched = true; };

      await runner.accept_specialist_result('goal-6b-test', 'res-spec-1');
      assert.equal(codexDispatched, false);
    }

    // ----------------------------------------------------
    // CONTROLLED SMOKE TEST
    // ----------------------------------------------------
    console.log('[Controlled Smoke Test] Full Slice 6B Smoke Flow...');
    {
      const { storage, runner, dbPath } = await setupEnv('controlled-smoke');
      const g = createFixtureGoal();
      await storage.saveGoal(g);

      // Verify initial context
      const ctx0 = await runner.get_goal_context('goal-6b-test');
      assert.equal(ctx0.next_legal_action.type, 'WAIT_FOR_SPECIALIST_RESULT_DECISION');

      // Call accept_specialist_result
      const acceptRes = await runner.accept_specialist_result('goal-6b-test', 'res-spec-1', {
        decidedBy: 'human-main-brain',
        note: 'Controlled smoke accept',
      });
      assert.equal(acceptRes.accepted, true);
      assert.equal(acceptRes.decision.decision, 'accepted');

      // Verify goal state
      const gPost = await storage.getGoal('goal-6b-test');
      assert.equal(gPost.specialistResults[0].status, 'completed', 'Result evidence unchanged');
      assert.equal(gPost.reviewQueue[0].lifecycle, 'superseded', 'Review superseded');
      assert.equal(gPost.steps[1].status, 'completed', 'Step 2 completed');
      assert.equal(gPost.status, 'ready', 'Goal ready');
      assert.equal(gPost.currentStepId, 'step-3', 'Current step is Step 3');
      assert.equal(gPost.steps[2].status, 'pending', 'Step 3 still NOT dispatched');

      // Verify restart
      const storageR = new GoalStorage(dbPath);
      storageR.load();
      const runnerR = new GoalRunner(storageR);
      const ctxR = await runnerR.get_goal_context('goal-6b-test');
      assert.ok(['CONTINUE_NEXT_STEP', 'RUN_CURRENT_STEP', 'WAIT_FOR_APPROVAL'].includes(ctxR.next_legal_action.type));

      // Controlled Smoke REJECT scenario
      const { storage: storageRej, runner: runnerRej } = await setupEnv('controlled-smoke-reject');
      const gRej = createFixtureGoal();
      await storageRej.saveGoal(gRej);

      const rejRes = await runnerRej.reject_specialist_result('goal-6b-test', 'res-spec-1', {
        decidedBy: 'human-main-brain',
        note: 'Controlled smoke reject',
      });
      assert.equal(rejRes.rejected, true);

      const gPostRej = await storageRej.getGoal('goal-6b-test');
      assert.equal(gPostRej.reviewQueue[0].lifecycle, 'open', 'Original review stays active');
      assert.equal(gPostRej.status, 'waiting', 'Goal stays blocked');
      assert.equal(gPostRej.steps[1].status, 'waiting', 'Step 2 remains waiting');

      const ctxRej = await runnerRej.get_goal_context('goal-6b-test');
      assert.equal(ctxRej.next_legal_action.type, 'WAIT_FOR_REVIEW');
    }

    console.log('=== All Slice 6B Specialist Result Decision Tests Passed Successfully! ===');
  } finally {
    await fs.rm(tmpBase, { recursive: true, force: true }).catch(() => {});
  }
}

runTests().catch((err) => {
  console.error('Slice 6B Test Failure:', err);
  process.exit(1);
});
