import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { redactSecrets } from '../executors/antigravity.mjs';
import { getJobManager } from '../runtime/job-manager.mjs';
import { parseXTask } from '../x/task-contract.mjs';
import {
  createGoal,
  createGoalCheckpoint,
  createReviewQueueItem,
  validateGoal,
  validateSpecialistHandoff,
  sanitizeEvidence,
  HANDOFF_TARGETS,
} from './model.mjs';

import {
  validateSpecialistExecution,
  validateSpecialistResult,
  validateSpecialistResultDecision,
  deriveSpecialistExecutionId,
} from '../specialist/contract.mjs';

import {
  resolveCodexBinary,
  createOutputSchemaFile,
  formatSpecialistPrompt,
  parseCodexJsonlOutput,
  buildCodexArgs,
} from '../specialist/codex-adapter.mjs';

import {
  captureGitPreCheck,
  verifyGitPostCheck,
} from '../specialist/git-verifier.mjs';

import {
  isWorkspaceLocked,
} from '../specialist/workspace-lock.mjs';

import {
  canonicalJson,
  canonicalizeXTask,
  computeXTaskFingerprint,
} from '../x/fingerprint.mjs';

/**
 * Derives the durable X requestId for a Goal step.
 *
 * generation null or 1 (first/only execution) → legacy format:
 *   goal:<goalId>:step:<stepId>
 *
 * generation >= 2 (retry or interrupted recovery) → extended format:
 *   goal:<goalId>:step:<stepId>:exec:<generation>
 *
 * Centralised so no call site duplicates this logic.
 *
 * @param {object} goal
 * @param {object} step
 * @returns {string}
 */
function getXRequestId(goal, step) {
  const gen = step.executionGeneration ?? null;
  return gen != null && gen >= 2
    ? `goal:${goal.id}:step:${step.id}:exec:${gen}`
    : `goal:${goal.id}:step:${step.id}`;
}

/**
 * Composes a human-readable review/failure reason from an x-result-v1
 * object without changing anything about its stable taxonomy: `reason_code`
 * (or `waiting_reason` when supplied) is always kept as the first, stable
 * segment, and the specific underlying blocker -- already computed by
 * Phase 6/8 but previously dropped at this exact boundary -- is appended
 * when present. Returns null when the result carries neither, so callers
 * can fall back to their own default text unchanged.
 * @param {object|null} result xStatus.result (x-result-v1) or null/undefined
 * @param {string|null} [primaryCode] reason_code or waiting_reason, whichever the caller prefers as the stable lead segment
 */
function describeXResultFailure(result, primaryCode) {
  const code = primaryCode || result?.reason_code || null;
  const blocker = Array.isArray(result?.blockers) ? result.blockers[0] : null;
  const segments = [];
  if (code) segments.push(code);
  if (blocker?.reason && blocker.reason !== code) segments.push(blocker.reason);
  if (blocker?.detail) segments.push(blocker.detail);
  return segments.length > 0 ? segments.join(': ') : null;
}

export class GoalRunner {
  /**
   * @param {{
   *   storage: import('./storage.mjs').GoalStorage,
   *   antigravityExecutor?: {
   *     startAntigravityTask: Function,
   *     getAntigravityTask: Function,
   *   },
   *   xExecutor?: {
   *     dispatchXTask: Function,
   *     getXTaskStatus: Function,
   *   },
   *   jobManager?: import('../runtime/job-manager.mjs').JobManager,
   *   onReviewItemPersisted?: (item: object, goal: object) => void,
   * }} options
   */
  constructor(options) {
    const storage = (options && typeof options.saveGoal === 'function') ? options : options?.storage;
    if (!storage) throw new Error('storage is required for GoalRunner');
    this.storage = storage;
    this.antigravityExecutor = options?.antigravityExecutor;
    this.xExecutor = options?.xExecutor || null;
    this.jobManager = options?.jobManager || null;
    this.claimStore = options?.claimStore || null;
    // Optional, notification-only (void, fire-and-forget) hook: called
    // AFTER a Review Queue item has been durably saved (never before --
    // never mid-transition), so it can never influence continuation, never
    // dispatch X, and a throwing/slow callback can never break Goal
    // execution (always wrapped in try/catch at each call site). This is
    // the ONLY seam a remote projection (e.g. mcp/bridge/
    // review-queue-sync.mjs) is wired through -- GoalRunner itself knows
    // nothing about Supabase/remote sync.
    this.onReviewItemPersisted = options?.onReviewItemPersisted || null;
    this.onGoalPersisted = options?.onGoalPersisted || null;

    const rawSaveGoal = this.storage.saveGoal.bind(this.storage);
    this.storage.saveGoal = (goal) => {
      const saved = rawSaveGoal(goal);
      if (typeof this.onGoalPersisted === 'function') {
        try {
          this.onGoalPersisted(saved);
        } catch (err) {
          console.warn('[GoalRunner] onGoalPersisted callback failed:', err.message);
        }
      }
      return saved;
    };

    /** @type {string | null} */
    this.activeGoalId = null;
    /** @type {Set<string>} */
    this.pausedGoals = new Set();
    this.reconciledGoals = [];
    this.reconcileStartupState();
  }

  /**
   * Reconciles goal state on startup after crash or restart.
   * Running goals are transitioned to paused so they cannot falsely auto-complete.
   * @returns {any[]} reconciled goals
   */
  reconcileStartupState() {
    const goals = this.storage.listGoals();
    const reconciled = [];
    for (const goal of goals) {
      let goalChanged = false;
      if (goal.status === 'running') {
        goal.status = 'paused';
        goal.updatedAt = new Date().toISOString();
        const step = goal.steps.find((s) => s.id === goal.currentStepId);
        if (step && step.status === 'running') {
          step.status = 'paused';
          step.result = 'Step execution interrupted by application restart. Resume required.';
        }
        goalChanged = true;
      }

      const execs = goal.specialistExecutions || [];
      for (const exec of execs) {
        if (['dispatching', 'running'].includes(exec.status)) {
          exec.status = 'interrupted';
          exec.finishedAt = new Date().toISOString();
          exec.error = 'Specialist execution interrupted by application restart.';
          goalChanged = true;

          const existingResult = (goal.specialistResults || []).find((r) => r.executionId === exec.id);
          if (!existingResult) {
            const resId = `specialist-res:${exec.id}:${Date.now()}`;
            const resultRecord = validateSpecialistResult({
              version: 'specialist-result-v1',
              id: resId,
              executionId: exec.id,
              handoffId: exec.handoffId,
              goalId: goal.id,
              stepId: exec.stepId,
              target: exec.target,
              status: 'interrupted',
              summary: 'Specialist execution was interrupted by an application restart.',
              codex: { sessionId: exec.codexSessionId, exitCode: null, signal: 'SIGTERM' },
              git: { preHead: null, postHead: null, preDirtyPaths: [], postChangedPaths: [], commitsCreated: false },
              boundary: { allowedPathsValid: true, forbiddenPathsValid: true, violations: [] },
              startedAt: exec.startedAt || exec.authorizedAt,
              finishedAt: exec.finishedAt,
              error: exec.error,
            });
            exec.resultId = resId;
            goal.specialistResults = [...(goal.specialistResults || []), resultRecord];
          }
        }
      }

      if (goalChanged) {
        this.storage.saveGoal(goal);
        reconciled.push(goal);
      }
    }
    if (reconciled.length > 0) {
      this.reconciledGoals = reconciled;
      return reconciled;
    }
    return this.reconciledGoals || [];
  }

  /**
   * Operation 1: create_goal
   */
  async create_goal({ id, title, objective, workspace, steps = [], constraints = [], remoteGoalRequest = null }) {
    if (!workspace || typeof workspace !== 'string') {
      throw new Error('Goal must be bound to a valid workspace path');
    }

    try {
      const stat = await fs.stat(workspace);
      if (!stat.isDirectory()) {
        throw new Error(`Workspace path '${workspace}' is not a directory`);
      }
    } catch (err) {
      throw new Error(`Invalid or inaccessible workspace path '${workspace}': ${err.message}`);
    }

    const goal = createGoal({ id, title, objective, workspace, steps, constraints, remoteGoalRequest });
    return this.storage.saveGoal(goal);
  }

  /**
   * Operation 2: get_goal
   */
  get_goal(goalId) {
    if (!goalId || typeof goalId !== 'string') throw new Error('goalId is required');
    return this.storage.getGoal(goalId);
  }

  /**
   * Operation 3: list_goals
   */
  list_goals() {
    return this.storage.listGoals();
  }

  /**
   * Clears terminal Goal history only. Never removes draft/ready/active Goals.
   */
  clear_goal_history() {
    return this.storage.clearGoalHistory();
  }

  /**
   * Returns whether any goal is currently active.
   * Active statuses: running, waiting, paused.
   * @returns {boolean}
   */
  is_goal_active() {
    if (this.activeGoalId) return true;
    const all = this.storage.listGoals();
    return all.some((g) => ['running', 'waiting', 'paused'].includes(g.status));
  }

  /**
   * Operation 4: run_goal
   */
  async run_goal(goalId, options = {}) {
    if (!goalId || typeof goalId !== 'string') throw new Error('goalId is required');

    const goal = this.storage.getGoal(goalId);
    if (!goal) throw new Error(`Goal with ID '${goalId}' was not found`);

    if (['completed'].includes(goal.status)) {
      throw new Error(`Cannot run goal '${goalId}' because it is already completed`);
    }

    if (goal.steps.length === 0) {
      throw new Error(`Cannot run goal '${goalId}' because it has no steps defined`);
    }

    // Verify workspace exists
    try {
      const stat = await fs.stat(goal.workspace);
      if (!stat.isDirectory()) throw new Error('Workspace is not a directory');
    } catch {
      throw new Error(`Goal workspace '${goal.workspace}' is inaccessible`);
    }

    // Single active execution lock
    if (this.activeGoalId) {
      if (this.activeGoalId === goalId) {
        throw new Error(`Goal '${goalId}' is already executing`);
      }
      throw new Error(`Another goal ('${this.activeGoalId}') is currently executing`);
    }

    this.activeGoalId = goalId;
    this.pausedGoals.delete(goalId);

    try {
      const now = new Date().toISOString();
      goal.status = 'running';
      if (!goal.startedAt) goal.startedAt = now;
      goal.updatedAt = now;
      this.storage.saveGoal(goal);

      if (options.onProgress) options.onProgress(goal);

      // Find current or next pending step
      let stepIndex = 0;
      if (goal.currentStepId) {
        const idx = goal.steps.findIndex((s) => s.id === goal.currentStepId);
        if (idx !== -1) {
          // If current step is completed/skipped, advance to next
          if (['completed', 'skipped'].includes(goal.steps[idx].status)) {
            stepIndex = idx + 1;
          } else {
            stepIndex = idx;
          }
        }
      }

      while (stepIndex < goal.steps.length) {
        // Check if paused
        if (this.pausedGoals.has(goalId)) {
          goal.status = 'paused';
          goal.updatedAt = new Date().toISOString();
          this.storage.saveGoal(goal);
          this.activeGoalId = null;
          if (options.onProgress) options.onProgress(goal);
          return goal;
        }

        const step = goal.steps[stepIndex];
        goal.currentStepId = step.id;

        // Skip already completed/skipped steps
        if (['completed', 'skipped'].includes(step.status)) {
          stepIndex++;
          continue;
        }

        if (Array.isArray(goal.reviewQueue)) {
          const unresolvedItem = goal.reviewQueue.find(
            (it) => it.stepId === step.id && ['open', 'acknowledged'].includes(it.lifecycle)
          );
          if (unresolvedItem) {
            goal.status = 'waiting';
            this.activeGoalId = null;
            this.storage.saveGoal(goal);
            throw new Error(
              `Cannot run goal '${goalId}' on step '${step.title}': blocked by unresolved review item '${unresolvedItem.id}' (${unresolvedItem.status}/${unresolvedItem.lifecycle}). Human decision is required.`
            );
          }
        }

        step.status = 'running';
        step.startedAt = new Date().toISOString();
        goal.updatedAt = new Date().toISOString();
        this.storage.saveGoal(goal);
        if (options.onProgress) options.onProgress(goal);

        try {
          // Execute the step
          const stepResult = await this.executeStep(goal, step, options);

          if (stepResult.status === 'completed') {
            step.status = 'completed';
            step.result = stepResult.result ? redactSecrets(stepResult.result) : 'Step completed successfully';
            step.evidence = stepResult.evidence || null;
            step.finishedAt = new Date().toISOString();

            // Create checkpoint for this completed step
            const completedCount = goal.steps.filter((s) => s.status === 'completed').length;
            const nextStepObj = goal.steps[stepIndex + 1];
            this.checkpoint_goal(goal.id, step.id, {
              summary: `Step ${stepIndex + 1} (${step.title}) completed: ${step.result}`,
              completedSteps: completedCount,
              evidence: step.evidence,
              checks: stepResult.checks || {},
              nextStep: nextStepObj ? nextStepObj.id : null,
              route: step.route,
            }, goal);

            this.storage.saveGoal(goal);
            if (options.onProgress) options.onProgress(goal);

            stepIndex++;

            // If pause was requested during this step execution
            if (this.pausedGoals.has(goalId)) {
              goal.status = 'paused';
              goal.updatedAt = new Date().toISOString();
              const hasPauseCp = goal.checkpoints.some((c) => c.summary.toLowerCase().includes('pause'));
              if (!hasPauseCp) {
                const cp = createGoalCheckpoint({
                  goalId: goal.id,
                  stepId: goal.currentStepId,
                  summary: 'Goal paused by user',
                  completedSteps: goal.steps.filter((s) => s.status === 'completed').length,
                  nextStep: goal.currentStepId,
                  route: 'manual',
                });
                goal.checkpoints.push(cp);
              }
              this.activeGoalId = null;
              this.storage.saveGoal(goal);
              if (options.onProgress) options.onProgress(goal);
              return goal;
            }
          } else if (stepResult.status === 'waiting') {
            step.status = 'waiting';
            step.result = stepResult.result ? redactSecrets(stepResult.result) : 'Step waiting for input or verification';
            goal.status = 'waiting';
            goal.updatedAt = new Date().toISOString();

            // INTERRUPTED RECOVERY: allocate a new executionGeneration exactly
            // once before saving. The new generation becomes durable here; the
            // next resume_goal/run_goal will compute a new requestId via
            // getXRequestId and dispatch a genuinely fresh X execution.
            // Idempotent across Hearth restarts: if the process crashes after
            // this save, the next restart sees the already-incremented value and
            // does not increment again.
            if (stepResult.interruptedRecovery) {
              const prevGen = step.executionGeneration ?? 1;
              step.executionGeneration = prevGen + 1;
              // Append a durable checkpoint describing the recovery allocation.
              this.checkpoint_goal(goal.id, step.id, {
                summary: `Interrupted recovery: step '${step.title}' allocated new execution generation ${step.executionGeneration}. Resume the goal to dispatch a fresh X run.`,
                completedSteps: goal.steps.filter((s) => s.status === 'completed').length,
                evidence: {
                  interruptedRequestId: stepResult.evidence?.requestId || null,
                  interruptedRunId: stepResult.evidence?.runId || null,
                  newExecutionGeneration: step.executionGeneration,
                },
                nextStep: step.id,
                route: step.route,
              }, goal);
            }

            // NEEDS_REVIEW (never INTERRUPTED -- see executeStep's route:'x'
            // branch, the only current source of reviewNeeded): create/
            // update the durable Review Queue item BEFORE checkpointing/
            // saving, so both land in the SAME save below.
            let waitingReviewItem = null;
            if (stepResult.reviewNeeded) {
              waitingReviewItem = this.recordReviewItem(goal, {
                stepId: step.id,
                taskId: step.xTask?.task_id || null,
                runId: stepResult.evidence?.runId || null,
                resultId: stepResult.evidence?.resultId || null,
                status: stepResult.reviewStatus || 'needs_review',
                reason: stepResult.reviewReason || step.result,
                evidence: stepResult.evidence || null,
              });
            }

            if (!stepResult.interruptedRecovery) {
              this.checkpoint_goal(goal.id, step.id, {
                summary: `Step ${stepIndex + 1} (${step.title}) waiting: ${step.result}`,
                completedSteps: goal.steps.filter((s) => s.status === 'completed').length,
                evidence: stepResult.evidence,
                nextStep: step.id,
                route: step.route,
              }, goal);
            }

            this.storage.saveGoal(goal);
            // Fired only AFTER the item is durably saved -- see the
            // onReviewItemPersisted doc comment in the constructor.
            if (waitingReviewItem && this.onReviewItemPersisted) {
              try { this.onReviewItemPersisted(waitingReviewItem, goal); }
              catch (err) { console.error('[GoalRunner] onReviewItemPersisted callback failed:', err); }
            }
            this.activeGoalId = null;
            if (options.onProgress) options.onProgress(goal);
            return goal;
          } else if (stepResult.status === 'error') {
            step.status = 'error';
            step.result = stepResult.error ? redactSecrets(stepResult.error) : 'Step execution error';
            step.finishedAt = new Date().toISOString();

            if (step.required) {
              // FAILED: record the Review Queue item and a checkpoint BEFORE
              // the save below, so fail_goal's own subsequent fetch (it
              // re-reads from storage by id) sees both already persisted.
              let errorReviewItem = null;
              if (stepResult.reviewNeeded) {
                errorReviewItem = this.recordReviewItem(goal, {
                  stepId: step.id,
                  taskId: step.xTask?.task_id || null,
                  runId: stepResult.evidence?.runId || null,
                  resultId: stepResult.evidence?.resultId || null,
                  status: stepResult.reviewStatus || 'failed',
                  reason: stepResult.reviewReason || step.result,
                  evidence: stepResult.evidence || null,
                });
              }
              this.checkpoint_goal(goal.id, step.id, {
                summary: `Step ${stepIndex + 1} (${step.title}) failed: ${step.result}`,
                completedSteps: goal.steps.filter((s) => s.status === 'completed').length,
                evidence: stepResult.evidence,
                nextStep: null,
                route: step.route,
              }, goal);
              this.storage.saveGoal(goal);
              if (errorReviewItem && this.onReviewItemPersisted) {
                try { this.onReviewItemPersisted(errorReviewItem, goal); }
                catch (err) { console.error('[GoalRunner] onReviewItemPersisted callback failed:', err); }
              }
              const failedGoal = this.fail_goal(goal.id, `Required step '${step.title}' failed: ${step.result}`);
              if (options.onProgress) options.onProgress(failedGoal);
              return failedGoal;
            }
            // Optional step failed, create checkpoint and proceed
            this.storage.saveGoal(goal);
            stepIndex++;
          }
        } catch (err) {
          step.status = 'error';
          step.result = redactSecrets(err.message);
          step.finishedAt = new Date().toISOString();

          if (step.required) {
            // A thrown exception (e.g. "X executor is not configured", a
            // network failure before X ever admitted the task) is still a
            // FAILED outcome from Hearth's perspective -- it still needs a
            // Review Queue item, even though no X runId/evidence exists yet.
            const catchReviewItem = this.recordReviewItem(goal, {
              stepId: step.id,
              taskId: step.xTask?.task_id || null,
              status: 'failed',
              reason: err.message,
            });
            this.checkpoint_goal(goal.id, step.id, {
              summary: `Step ${stepIndex + 1} (${step.title}) failed: ${step.result}`,
              completedSteps: goal.steps.filter((s) => s.status === 'completed').length,
              nextStep: null,
              route: step.route,
            }, goal);
            this.storage.saveGoal(goal);
            if (catchReviewItem && this.onReviewItemPersisted) {
              try { this.onReviewItemPersisted(catchReviewItem, goal); }
              catch (callbackErr) { console.error('[GoalRunner] onReviewItemPersisted callback failed:', callbackErr); }
            }
            const failedGoal = this.fail_goal(goal.id, `Required step '${step.title}' threw error: ${err.message}`);
            if (options.onProgress) options.onProgress(failedGoal);
            return failedGoal;
          }
          this.storage.saveGoal(goal);
          stepIndex++;
        }
      }

      // All steps processed: verify completion contract
      const completedGoal = this.complete_goal(goal.id);
      if (options.onProgress) options.onProgress(completedGoal);
      return completedGoal;
    } finally {
      if (this.activeGoalId === goalId) {
        this.activeGoalId = null;
      }
    }
  }

  /**
   * Internal: executes an individual step.
   * Respects permission system, route, and completion verification.
   */
  async executeStep(goal, step, options = {}) {
    // 1. Custom mock execution for unit tests
    if (options.executeStepFn) {
      return options.executeStepFn(goal, step);
    }

    // 2. Permission enforcement
    const permissions = options.permissions || {};
    const antigravityPerm = permissions.Antigravity || 'Ask';

    if (step.route === 'antigravity') {
      if (antigravityPerm === 'Blocked') {
        throw new Error('Antigravity permission is Blocked in Hearth Control');
      }

      if (antigravityPerm === 'Ask') {
        if (options.requestApproval) {
          const allowed = await options.requestApproval({
            permission: 'Antigravity',
            action: `Goal Step: ${step.title}`,
          });
          if (!allowed) {
            throw new Error(`User denied Antigravity approval for step '${step.title}'`);
          }
        } else {
          throw new Error(`Step '${step.title}' requires permission approval`);
        }
      }

      // Execute via Antigravity Executor
      if (!this.antigravityExecutor?.startAntigravityTask) {
        throw new Error('Antigravity executor is not configured');
      }

      const prompt = `Goal: ${goal.title}\nObjective: ${goal.objective}\n\nStep: ${step.title}\nInstructions:\n${step.description}`;
      const taskRes = await this.antigravityExecutor.startAntigravityTask({
        workspace: goal.workspace,
        prompt,
        title: `${goal.title} - ${step.title}`,
        runner: options.runner,
        customAgentApiPath: options.customAgentApiPath,
        claimStore: this.claimStore,
      });

      // Poll until step reaches terminal state (done / waiting / error)
      const taskId = taskRes.taskId;
      let finalTask = null;
      for (let i = 0; i < 60; i++) {
        finalTask = this.antigravityExecutor.getAntigravityTask(taskId);
        if (['done', 'waiting', 'error'].includes(finalTask.status)) {
          break;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }

      if (!finalTask) {
        throw new Error(`Task ${taskId} timed out without reaching terminal state`);
      }

      // Check false-DONE and completion contract: process exit alone is not done
      if (finalTask.status === 'done') {
        return {
          status: 'completed',
          result: finalTask.lastAnswer || 'Task completed successfully',
          evidence: {
            taskId: finalTask.taskId,
            conversationId: finalTask.conversationId,
            jobId: finalTask.jobId || null,
            completion: finalTask.completion || null,
            durableJobEvidence: finalTask.durableJobEvidence || null,
          },
        };
      }

      if (finalTask.status === 'waiting') {
        return {
          status: 'waiting',
          result: finalTask.lastAnswer || finalTask.completion?.reason || 'Waiting for completion contract verification',
          evidence: {
            taskId: finalTask.taskId,
            conversationId: finalTask.conversationId,
            jobId: finalTask.jobId || null,
            completion: finalTask.completion || null,
            durableJobEvidence: finalTask.durableJobEvidence || null,
          },
        };
      }

      return {
        status: 'error',
        error: finalTask.error || 'Antigravity task failed',
        evidence: {
          taskId: finalTask.taskId,
          conversationId: finalTask.conversationId,
          jobId: finalTask.jobId || null,
          durableJobEvidence: finalTask.durableJobEvidence || null,
        },
      };
    }

    if (step.route === 'x') {
      // route:'x' steps carry an already-authored, already-validated
      // x-task-v1 (see model.mjs's validateStep) -- Goal Runner never
      // constructs, repairs, or infers one; a missing/invalid xTask fails
      // closed here rather than falling through to any other route.
      if (!step.xTask) {
        throw new Error(`Step '${step.title}' has route "x" but no validated xTask; cannot execute`);
      }
      if (!this.xExecutor?.dispatchXTask || !this.xExecutor?.getXTaskStatus) {
        throw new Error('X executor is not configured');
      }

      // Deterministic per goal+step+generation requestId. A duplicate resume/
      // continuation (same generation) calls dispatchXTask again with the SAME
      // requestId and SAME task content, which the shared X ingress resolves
      // to the SAME durable receipt instead of executing X again. After a
      // retry or interrupted-recovery allocation, executionGeneration is
      // incremented before this point, producing a NEW requestId that routes
      // to a genuinely new execution.
      const requestId = getXRequestId(goal, step);
      const action = `Goal step: ${goal.title} / ${step.title}`;

      // Passes the LIVE goal/step objects (not just their ids) so any
      // Goal-level X approval granted during this call can be recorded
      // directly on THIS run's own `goal` reference -- the same object
      // this loop mutates and saves throughout -- rather than via a
      // separate storage fetch-mutate-save that would race with (and be
      // silently overwritten by) this loop's own subsequent
      // this.storage.saveGoal(goal) calls.
      await this.xExecutor.dispatchXTask({ requestId, task: step.xTask, action, goal, step });

      // Poll the same durable queue receipt used by Phase 1's remote path
      // until it reaches terminal, bounded by the task's own declared
      // hard_timeout_minutes (never an invented budget). A poll-window
      // timeout with the underlying run still genuinely in flight is
      // reported as 'waiting', not an error -- resuming the goal re-enters
      // this same idempotent dispatch/poll, never a second X execution.
      const hardTimeoutMinutes = step.xTask.timing?.hard_timeout_minutes || 10;
      const maxAttempts = Math.max(1, Math.ceil((hardTimeoutMinutes * 60000) / 1000));
      let xStatus = null;
      for (let i = 0; i < maxAttempts; i++) {
        xStatus = await this.xExecutor.getXTaskStatus(requestId);
        if (xStatus?.queue_status === 'terminal') break;
        await new Promise((r) => setTimeout(r, 1000));
      }

      // resultId correlates a review-queue item back to XRunStore's own
      // durable x-result-v1 record (xStatus.result is that FULL object when
      // present) -- reference-only, never the transcript itself.
      const resultId = (xStatus?.result && typeof xStatus.result === 'object' && typeof xStatus.result.result_id === 'string')
        ? xStatus.result.result_id
        : null;
      const evidence = {
        requestId,
        queueId: xStatus?.queue_id || null,
        runId: xStatus?.run_id || null,
        resultId,
        gateStatus: xStatus?.gate_status || null,
        hearthOutcome: xStatus?.hearth_outcome || null,
      };

      if (xStatus?.queue_status !== 'terminal') {
        return {
          status: 'waiting',
          result: 'X step is still in progress after the poll window elapsed. Resume the goal to check again.',
          evidence,
        };
      }

      // xStatus.result is XRunStore's persisted x-result-v1 -- a structured
      // object, never a string (unlike Antigravity's chat-style lastAnswer).
      // step.result is contractually a string (model.mjs's validateStep
      // nulls out anything else), and run_goal's own redactSecrets() call
      // is string-only and silently returns '' for a non-string input -- so
      // this must already be a string by the time it leaves here.
      const xResultText = (value) => (value == null ? null : typeof value === 'string' ? value : JSON.stringify(value));

      if (xStatus.terminal_status === 'completed') {
        return { status: 'completed', result: xResultText(xStatus.result) || 'X step completed successfully', evidence };
      }
      if (xStatus.terminal_status === 'needs_review') {
        // x-result-v1 always carries reason_code, and waiting_reason
        // specifically when hearth_outcome is 'waiting' (needs_review's own
        // outcome) -- a concise, structured "why", preferred over dumping
        // the full result JSON as the review reason. The specific
        // underlying blocker (e.g. a safety-boundary block) that Phase 8
        // already attached to this same result is appended rather than
        // dropped -- see describeXResultFailure.
        const reviewReason = xStatus.error
          || describeXResultFailure(xStatus.result, xStatus.result?.waiting_reason)
          || 'X step needs review';
        return {
          status: 'waiting',
          result: xStatus.error || xResultText(xStatus.result) || 'X step needs review',
          evidence,
          reviewNeeded: true,
          reviewStatus: 'needs_review',
          reviewReason,
        };
      }
      if (xStatus.terminal_status === 'interrupted') {
        // Recoverable — deliberately NEVER a Review Queue item (no reviewNeeded
        // here): an interrupted run has no ambiguous outcome for a human to
        // weigh in on. Signal the caller (run_goal) to allocate a new
        // executionGeneration so the NEXT resume dispatches a genuinely fresh
        // X execution under a new requestId, rather than coalescing to the
        // existing terminal interrupted receipt forever (the loop-bug this
        // flag was introduced to fix).
        return {
          status: 'waiting',
          result: 'X step was interrupted and is recoverable. A new execution will be allocated on resume.',
          evidence,
          interruptedRecovery: true,
        };
      }
      // 'failed' (or any unrecognized terminal status): fail closed. The
      // stable reason_code remains the lead segment; the specific blocker
      // reason/detail Phase 6/8 already computed (e.g. 'unsupported_action'
      // / "action 0: unsupported type 'undefined'") is appended so a human
      // reviewing this step sees more than the generic reason_code alone.
      const failureReason = xStatus.error || describeXResultFailure(xStatus.result) || 'X step failed';
      return {
        status: 'error',
        error: xStatus.error || 'X step failed',
        evidence,
        reviewNeeded: true,
        reviewStatus: 'failed',
        reviewReason: failureReason,
      };
    }

    if (step.route === 'durable_job' || step.durableJob) {
      const jm = this.jobManager || getJobManager();
      const job = jm.startJob({
        command: step.durableJob?.command || step.command,
        args: step.durableJob?.args || step.args || [],
        cwd: goal.workspace,
        timeoutMs: step.durableJob?.timeoutMs || step.timeoutMs,
      });
      const result = await jm.waitForJob(job.id);
      if (result.status === 'completed') {
        return {
          status: 'completed',
          result: result.stdout || 'Durable job completed successfully',
          evidence: { jobId: job.id, ...result },
        };
      }
      return {
        status: 'error',
        error: result.error || result.stderr || `Durable job exited with code ${result.exitCode}`,
        evidence: { jobId: job.id, ...result },
      };
    }

    if (step.route === 'manual') {
      return {
        status: 'waiting',
        result: 'Manual verification step requires user sign-off',
      };
    }

    return {
      status: 'completed',
      result: `Step executed via route ${step.route}`,
    };
  }

  /**
   * Operation 5: pause_goal
   */
  async pause_goal(goalId) {
    if (!goalId || typeof goalId !== 'string') throw new Error('goalId is required');

    const goal = this.storage.getGoal(goalId);
    if (!goal) throw new Error(`Goal '${goalId}' not found`);

    if (!['running', 'waiting'].includes(goal.status)) {
      throw new Error(`Cannot pause goal in status '${goal.status}'`);
    }

    this.pausedGoals.add(goalId);
    goal.status = 'paused';
    goal.updatedAt = new Date().toISOString();

    // Create checkpoint before pausing
    const cp = createGoalCheckpoint({
      goalId,
      stepId: goal.currentStepId,
      summary: 'Goal paused by user',
      completedSteps: goal.steps.filter((s) => s.status === 'completed').length,
      nextStep: goal.currentStepId,
      route: 'manual',
    });
    goal.checkpoints.push(cp);

    if (this.activeGoalId === goalId) {
      this.activeGoalId = null;
    }

    return this.storage.saveGoal(goal);
  }

  /**
   * Operation 6: resume_goal
   */
  async resume_goal(goalId, options = {}) {
    if (!goalId || typeof goalId !== 'string') throw new Error('goalId is required');

    const goal = this.storage.getGoal(goalId);
    if (!goal) throw new Error(`Goal '${goalId}' not found`);

    if (!['paused', 'waiting', 'ready'].includes(goal.status)) {
      throw new Error(`Cannot resume goal in status '${goal.status}'`);
    }

    const currentStep = goal.steps.find((s) => s.id === (goal.currentStepId || goal.steps[0]?.id));
    if (currentStep && currentStep.route === 'manual' && currentStep.status === 'waiting') {
      throw new Error(
        `Cannot resume goal on waiting manual step '${currentStep.title}'. Explicit manual sign-off is required.`
      );
    }

    // Read latest checkpoint if available
    const latestCheckpoint = goal.checkpoints[goal.checkpoints.length - 1];
    const resumeStepId = latestCheckpoint?.nextStep || goal.currentStepId || goal.steps[0]?.id;
    const resumeStep = goal.steps.find((s) => s.id === resumeStepId);

    if (resumeStep && Array.isArray(goal.reviewQueue)) {
      const unresolvedItem = goal.reviewQueue.find(
        (it) => it.stepId === resumeStep.id && ['open', 'acknowledged'].includes(it.lifecycle)
      );
      if (unresolvedItem) {
        throw new Error(
          `Cannot resume goal '${goalId}' on step '${resumeStep.title}': blocked by unresolved review item '${unresolvedItem.id}' (${unresolvedItem.status}/${unresolvedItem.lifecycle}). Human decision is required.`
        );
      }
    }

    this.pausedGoals.delete(goalId);

    if (latestCheckpoint?.nextStep) {
      goal.currentStepId = latestCheckpoint.nextStep;
    }

    return this.run_goal(goalId, options);
  }

  /**
   * Operation 7: checkpoint_goal
   *
   * `liveGoal`, when passed, is used INSTEAD of a fresh storage fetch: this
   * is required for any caller (run_goal's own loop) that already holds
   * the live, in-flight goal object it will itself save again afterward --
   * GoalStorage.saveGoal() always returns a brand-new re-validated object
   * rather than mutating its input, so a separate fetch-mutate-save here
   * would land on a DIFFERENT object than the caller's, and get silently
   * clobbered by the caller's own next saveGoal(goal) call (the exact bug
   * class already found and fixed for Goal-level X approval). External
   * callers (no liveGoal) are unaffected: this still fetches, mutates, and
   * saves entirely on its own, exactly as before.
   */
  checkpoint_goal(goalId, stepId, data = {}, liveGoal = null) {
    if (!goalId || typeof goalId !== 'string') throw new Error('goalId is required');

    const goal = liveGoal || this.storage.getGoal(goalId);
    if (!goal) throw new Error(`Goal '${goalId}' not found`);

    const checkpoint = createGoalCheckpoint({
      goalId,
      stepId,
      summary: data.summary,
      completedSteps: data.completedSteps,
      evidence: data.evidence,
      filesChanged: data.filesChanged,
      checks: data.checks,
      nextStep: data.nextStep,
      route: data.route,
    });

    goal.checkpoints.push(checkpoint);
    goal.updatedAt = new Date().toISOString();
    this.storage.saveGoal(goal);

    return checkpoint;
  }

  /**
   * Records (or, idempotently, no-ops on) a Review Queue item for a step
   * whose terminal outcome was NEEDS_REVIEW or FAILED -- never INTERRUPTED,
   * which is recoverable/waiting on its own and never reaches this method
   * (see executeStep's route:'x' branch, the only current source of
   * `reviewNeeded`). Always operates on the LIVE `goal` object passed in
   * (never a separate storage fetch) for the same reason checkpoint_goal's
   * `liveGoal` parameter exists -- see that method's own doc comment.
   * Idempotent by `idempotencyKey` (the underlying X runId when available,
   * so a restart/reconciliation replay of the SAME terminal run never
   * creates a duplicate item -- falls back to a stable `goalId:stepId`
   * scoped key when no runId exists, e.g. a thrown exception before X ever
   * admitted the task).
   *
   * Never persists by itself: the caller (run_goal) owns saving the SAME
   * live `goal` object afterward, exactly like Goal-level X approval.
   *
   * @returns {object} the created or already-existing review queue item
   */
  recordReviewItem(goal, { stepId, taskId = null, runId = null, resultId = null, status, reason, evidence = null }) {
    if (!goal || typeof goal !== 'object') throw new Error('goal is required to record a review item');
    if (!Array.isArray(goal.reviewQueue)) goal.reviewQueue = [];

    const idempotencyKey = runId || `${goal.id}:${stepId}:${status}`;
    const existing = goal.reviewQueue.find((item) => item.idempotencyKey === idempotencyKey);
    if (existing) {
      existing.updatedAt = new Date().toISOString();
      return existing;
    }

    const item = createReviewQueueItem({ idempotencyKey, stepId, taskId, runId, resultId, status, reason, evidence });
    goal.reviewQueue.push(item);
    return item;
  }

  /**
   * Flattens every Goal's reviewQueue into a single list (newest first),
   * each item annotated with its own goalId/goalTitle -- the "smallest
   * durable Review Queue layer" this phase needs: reviews live durably on
   * their own Goal (reusing GoalStorage's existing save/load round-trip,
   * no new store), and this is purely a read-side aggregation over
   * `list_goals()` for a caller (e.g. a future Chat-facing summary) that
   * wants a cross-goal view of what needs attention.
   * @param {{ goalId?: string }} [filter] optional: only one goal's items
   * @returns {object[]}
   */
  list_review_queue(filter = {}) {
    const goals = filter.goalId
      ? [this.storage.getGoal(filter.goalId)].filter(Boolean)
      : this.storage.listGoals();

    const items = [];
    for (const goal of goals) {
      for (const item of goal.reviewQueue || []) {
        items.push({ ...item, goalId: goal.id, goalTitle: goal.title });
      }
    }
    return items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  /**
   * Operation 8: complete_goal
   */
  complete_goal(goalId) {
    if (!goalId || typeof goalId !== 'string') throw new Error('goalId is required');

    const goal = this.storage.getGoal(goalId);
    if (!goal) throw new Error(`Goal '${goalId}' not found`);

    // Strict validation: check all required steps are completed
    const requiredIncomplete = goal.steps.filter((s) => s.required && s.status !== 'completed');
    if (requiredIncomplete.length > 0) {
      throw new Error(
        `Cannot complete goal: required step(s) [${requiredIncomplete.map((s) => s.title).join(', ')}] are not completed`
      );
    }

    // Check no step is waiting or in error
    const activeWaiting = goal.steps.some((s) => s.status === 'waiting');
    if (activeWaiting) {
      goal.status = 'waiting';
      goal.updatedAt = new Date().toISOString();
      return this.storage.saveGoal(goal);
    }

    const now = new Date().toISOString();
    goal.status = 'completed';
    goal.finishedAt = now;
    goal.updatedAt = now;
    goal.currentStepId = null;

    if (this.activeGoalId === goalId) {
      this.activeGoalId = null;
    }

    return this.storage.saveGoal(goal);
  }

  /**
   * Operation 9: fail_goal
   */
  fail_goal(goalId, reason) {
    if (!goalId || typeof goalId !== 'string') throw new Error('goalId is required');

    const goal = this.storage.getGoal(goalId);
    if (!goal) throw new Error(`Goal '${goalId}' not found`);

    const now = new Date().toISOString();
    goal.status = 'error';
    goal.error = reason ? redactSecrets(String(reason)) : 'Goal failed';
    goal.finishedAt = now;
    goal.updatedAt = now;

    if (this.activeGoalId === goalId) {
      this.activeGoalId = null;
    }

    return this.storage.saveGoal(goal);
  }

  /**
   * Operation 10: signoff_step
   * Explicit user sign-off for manual steps in 'waiting' state.
   */
  async signoff_step(goalId, stepId, options = {}) {
    if (!goalId || typeof goalId !== 'string') throw new Error('goalId is required');
    if (!stepId || typeof stepId !== 'string') throw new Error('stepId is required');

    const goal = this.storage.getGoal(goalId);
    if (!goal) throw new Error(`Goal '${goalId}' not found`);

    const stepIndex = goal.steps.findIndex((s) => s.id === stepId);
    if (stepIndex === -1) throw new Error(`Step '${stepId}' not found in goal '${goalId}'`);
    const step = goal.steps[stepIndex];

    // Validate that step is the active/current step
    if (goal.currentStepId && goal.currentStepId !== stepId) {
      throw new Error(`Step '${stepId}' is not the active step (active: '${goal.currentStepId}')`);
    }

    // Validate step route is manual
    if (step.route !== 'manual') {
      throw new Error(`Cannot sign off non-manual step '${stepId}' (route: '${step.route}')`);
    }

    // Validate step status is waiting
    if (step.status !== 'waiting') {
      throw new Error(`Cannot sign off step '${stepId}' with status '${step.status}'. Step must be in 'waiting' status.`);
    }

    const action = options.action || 'complete';

    if (action === 'fail') {
      step.status = 'error';
      step.result = options.note ? redactSecrets(options.note) : 'Manual step rejected by user';
      step.finishedAt = new Date().toISOString();
      goal.updatedAt = new Date().toISOString();
      this.storage.saveGoal(goal);

      // Record checkpoint for failed manual step
      const completedCount = goal.steps.filter((s) => s.status === 'completed').length;
      const cp = createGoalCheckpoint({
        goalId: goal.id,
        stepId: step.id,
        summary: `Manual step '${step.title}' failed: ${step.result}`,
        completedSteps: completedCount,
        evidence: { error: step.result },
        nextStep: null,
        route: 'manual',
      });
      goal.checkpoints.push(cp);
      this.storage.saveGoal(goal);

      if (step.required) {
        return this.fail_goal(goal.id, `Manual required step '${step.title}' failed: ${step.result}`);
      }

      // If optional step failed, find next pending step
      const nextStep = goal.steps.slice(stepIndex + 1).find((s) => s.status === 'pending');
      goal.currentStepId = nextStep ? nextStep.id : null;
      goal.status = nextStep ? 'ready' : 'completed';
      this.storage.saveGoal(goal);
      return goal;
    }

    if (action !== 'complete') {
      throw new Error(`Invalid signoff action '${action}'. Must be 'complete' or 'fail'.`);
    }

    // Mark step completed
    step.status = 'completed';
    step.result = options.note ? redactSecrets(options.note) : 'Manual verification signed off by user';
    step.finishedAt = new Date().toISOString();
    if (options.evidence) {
      step.evidence = options.evidence;
    }

    // Find next required or pending step
    const nextStep = goal.steps.slice(stepIndex + 1).find((s) => s.status === 'pending');
    const completedCount = goal.steps.filter((s) => s.status === 'completed').length;

    // Checkpoint creation with sanitized summary and evidence
    const cp = createGoalCheckpoint({
      goalId: goal.id,
      stepId: step.id,
      summary: `Manual step '${step.title}' signed off as completed${options.note ? ': ' + redactSecrets(options.note) : ''}`,
      completedSteps: completedCount,
      evidence: step.evidence || null,
      nextStep: nextStep ? nextStep.id : null,
      route: 'manual',
    });
    goal.checkpoints.push(cp);

    if (nextStep) {
      goal.currentStepId = nextStep.id;
      goal.status = 'ready';
    } else {
      // Check if all required steps are completed
      const requiredIncomplete = goal.steps.filter((s) => s.required && s.status !== 'completed');
      if (requiredIncomplete.length === 0) {
        goal.status = 'completed';
        goal.finishedAt = new Date().toISOString();
        goal.currentStepId = null;
      }
    }

    goal.updatedAt = new Date().toISOString();
    this.storage.saveGoal(goal);

    // If autoRun is requested and there is a next step, continue execution
    if (options.autoRun && nextStep) {
      return this.run_goal(goal.id, options);
    }

    if (options.onProgress) options.onProgress(goal);
    return goal;
  }

  /**
   * Operation 11: acknowledge_review
   * Acknowledges a Review Queue item without mutating step status, goal status,
   * without dispatching X, and without unblocking execution.
   */
  async acknowledge_review(goalId, reviewItemId, options = {}) {
    if (!goalId || typeof goalId !== 'string') throw new Error('goalId is required');
    if (!reviewItemId || typeof reviewItemId !== 'string') throw new Error('reviewItemId is required');

    const goal = this.storage.getGoal(goalId);
    if (!goal) throw new Error(`Goal '${goalId}' not found`);

    const item = (goal.reviewQueue || []).find((it) => it.id === reviewItemId || it.idempotencyKey === reviewItemId);
    if (!item) throw new Error(`Review queue item '${reviewItemId}' not found in goal '${goalId}'`);

    if (['acknowledged', 'resolved', 'superseded'].includes(item.lifecycle)) {
      return { goal, item, alreadyAcknowledged: true };
    }

    const now = new Date().toISOString();
    item.lifecycle = 'acknowledged';
    item.acknowledgedAt = now;
    if (options.actor) item.acknowledgedBy = redactSecrets(options.actor).slice(0, 200);
    if (options.note) item.note = redactSecrets(options.note).slice(0, 2000);
    item.updatedAt = now;

    goal.updatedAt = now;
    this.storage.saveGoal(goal);

    if (this.onReviewItemPersisted) {
      try { this.onReviewItemPersisted(item, goal); } catch {}
    }

    return { goal, item };
  }

  /**
   * Operation 12: resolve_review
   * Resolves a Review Queue item for a step whose terminal X outcome was NEEDS_REVIEW.
   * Supports action: 'accept' (marks step completed, creates checkpoint, unblocks next steps)
   * or action: 'reject' (marks step and Goal as error, unblocks review without retrying or continuing).
   */
  async resolve_review(goalId, reviewItemId, options = {}) {
    if (!goalId || typeof goalId !== 'string') throw new Error('goalId is required');
    if (!reviewItemId || typeof reviewItemId !== 'string') throw new Error('reviewItemId is required');

    const action = options.action || 'accept';
    if (action !== 'accept' && action !== 'reject') {
      throw new Error(`Cannot resolve review with action '${action}'. Slice 1 only supports action: 'accept' or 'reject' for needs_review items.`);
    }

    const goal = this.storage.getGoal(goalId);
    if (!goal) throw new Error(`Goal '${goalId}' not found`);

    const item = (goal.reviewQueue || []).find((it) => it.id === reviewItemId || it.idempotencyKey === reviewItemId);
    if (!item) throw new Error(`Review queue item '${reviewItemId}' not found in goal '${goalId}'`);

    const expectedResolution = action === 'reject' ? 'rejected' : 'accepted';

    // Double resolve idempotency
    if (item.lifecycle === 'resolved') {
      if (item.resolution === expectedResolution) {
        return { goal, item, alreadyResolved: true };
      }
      throw new Error(`Review item '${reviewItemId}' is already resolved with conflicting resolution '${item.resolution}'`);
    }

    if (item.status !== 'needs_review') {
      throw new Error(`Cannot accept review item with status '${item.status}'. Slice 1 only supports resolving 'needs_review' items.`);
    }

    if (!['open', 'acknowledged'].includes(item.lifecycle)) {
      throw new Error(`Cannot resolve review item in lifecycle '${item.lifecycle}'. Must be 'open' or 'acknowledged'.`);
    }

    const stepIndex = goal.steps.findIndex((s) => s.id === item.stepId);
    if (stepIndex === -1) {
      throw new Error(`Step '${item.stepId}' associated with review item '${item.id}' not found in goal '${goal.id}'`);
    }
    const step = goal.steps[stepIndex];

    const now = new Date().toISOString();
    item.lifecycle = 'resolved';
    item.resolution = expectedResolution;
    item.resolvedAt = now;
    if (options.note) item.note = redactSecrets(options.note).slice(0, 2000);
    item.updatedAt = now;

    if (action === 'reject') {
      step.status = 'error';
      step.finishedAt = now;
      if (!step.result && options.note) {
        step.result = redactSecrets(options.note).slice(0, 2000);
      }

      const completedCount = goal.steps.filter((s) => s.status === 'completed').length;
      this.checkpoint_goal(goal.id, step.id, {
        summary: `Review resolved: step '${step.title}' rejected by supervisor${options.note ? ': ' + redactSecrets(options.note) : ''}`,
        completedSteps: completedCount,
        evidence: step.evidence,
        nextStep: null,
        route: step.route,
      }, goal);

      goal.status = 'error';
      goal.error = `Review resolved: step '${step.title}' rejected by supervisor${options.note ? ': ' + redactSecrets(options.note) : ''}`;
      goal.finishedAt = now;
      goal.updatedAt = now;

      if (this.activeGoalId === goal.id) {
        this.activeGoalId = null;
      }
    } else {
      step.status = 'completed';
      step.finishedAt = now;

      const completedCount = goal.steps.filter((s) => s.status === 'completed').length;
      const nextStepObj = goal.steps.slice(stepIndex + 1).find((s) => s.status === 'pending');

      this.checkpoint_goal(goal.id, step.id, {
        summary: `Review resolved: step '${step.title}' accepted by supervisor${options.note ? ': ' + redactSecrets(options.note) : ''}`,
        completedSteps: completedCount,
        evidence: step.evidence,
        nextStep: nextStepObj ? nextStepObj.id : null,
        route: step.route,
      }, goal);

      if (nextStepObj) {
        goal.currentStepId = nextStepObj.id;
        goal.status = 'ready';
      } else {
        const requiredIncomplete = goal.steps.filter((s) => s.required && s.status !== 'completed');
        if (requiredIncomplete.length === 0) {
          goal.status = 'completed';
          goal.finishedAt = now;
          goal.currentStepId = null;
        }
      }

      goal.updatedAt = now;
    }

    this.storage.saveGoal(goal);

    if (this.onReviewItemPersisted) {
      try { this.onReviewItemPersisted(item, goal); } catch {}
    }

    if (action === 'accept' && options.autoRun && nextStepObj) {
      return this.run_goal(goal.id, options);
    }

    return { goal, item };
  }

  /**
   * Alias for resume_goal
   */
  async resumeGoal(goalId, options) {
    return this.resume_goal(goalId, options);
  }

  /**
   * Alias for signoff_step supporting both parameter styles
   */
  async signoffStep(goalIdOrParams, stepId, options) {
    if (goalIdOrParams && typeof goalIdOrParams === 'object') {
      return this.signoff_step(goalIdOrParams.goalId, goalIdOrParams.stepId, goalIdOrParams);
    }
    return this.signoff_step(goalIdOrParams, stepId, options);
  }

  /**
   * Alias for acknowledge_review supporting both parameter styles
   */
  async acknowledgeReview(goalIdOrParams, reviewItemId, options) {
    if (goalIdOrParams && typeof goalIdOrParams === 'object') {
      return this.acknowledge_review(goalIdOrParams.goalId, goalIdOrParams.reviewItemId, goalIdOrParams);
    }
    return this.acknowledge_review(goalIdOrParams, reviewItemId, options);
  }

  /**
   * Alias for resolve_review supporting both parameter styles
   */
  async resolveReview(goalIdOrParams, reviewItemId, options) {
    if (goalIdOrParams && typeof goalIdOrParams === 'object') {
      return this.resolve_review(goalIdOrParams.goalId, goalIdOrParams.reviewItemId, goalIdOrParams);
    }
    return this.resolve_review(goalIdOrParams, reviewItemId, options);
  }

  /**
   * Operation 13: retry_review
   *
   * Prepares a NEW X execution for a step whose terminal X outcome was
   * NEEDS_REVIEW or FAILED. Semantically distinct from resolve_review (which
   * ACCEPTS a NEEDS_REVIEW result without any new execution): RETRY means
   * "run X again."
   *
   * Caller (Main Brain / human) MUST supply a COMPLETE, already-authored
   * x-task-v1 payload in options.xTask. Hearth validates it but never
   * synthesizes, repairs, or extends it. Required fields authored by Main Brain:
   *   - task_id (must match existing step.xTask.task_id -- same logical task)
   *   - revision: same-spec retry => old.revision; revised => old.revision + 1
   *   - attempt: same-spec retry => old.attempt + 1; revised => 1
   *   - based_on_result_id: MUST equal reviewItem.resultId when resultId exists
   *
   * DOES NOT dispatch X. The next resume_goal / run_goal performs dispatch.
   *
   * Idempotent on double-call: if the review item is already superseded,
   * returns { goal, item, alreadySuperseded: true } without re-incrementing
   * executionGeneration or re-saving.
   *
   * @param {string} goalId
   * @param {string} reviewItemId
   * @param {{ xTask: object, note?: string, actor?: string }} options
   */
  async retry_review(goalId, reviewItemId, options = {}) {
    if (!goalId || typeof goalId !== 'string') throw new Error('goalId is required');
    if (!reviewItemId || typeof reviewItemId !== 'string') throw new Error('reviewItemId is required');

    const goal = this.storage.getGoal(goalId);
    if (!goal) throw new Error(`Goal '${goalId}' not found`);

    const item = (goal.reviewQueue || []).find(
      (it) => it.id === reviewItemId || it.idempotencyKey === reviewItemId
    );
    if (!item) throw new Error(`Review queue item '${reviewItemId}' not found in goal '${goalId}'`);

    // ── Locate the step ───────────────────────────────────────────────────────
    const stepIndex = goal.steps.findIndex((s) => s.id === item.stepId);
    if (stepIndex === -1) {
      throw new Error(`Step '${item.stepId}' for review item '${reviewItemId}' not found in goal '${goalId}'`);
    }
    const step = goal.steps[stepIndex];

    // ── Validate the complete new xTask (required, no synthesis) ──────────────
    if (!options.xTask || typeof options.xTask !== 'object') {
      throw new Error('retry_review requires a complete x-task-v1 payload in options.xTask; Hearth never synthesizes one');
    }
    let newXTask;
    try {
      newXTask = parseXTask(options.xTask);
    } catch (err) {
      throw new Error(`retry_review: invalid xTask: ${err.message}`);
    }

    // ── Idempotency: already superseded by a previous retry call ─────────────
    if (item.lifecycle === 'superseded') {
      if (step.xTask && JSON.stringify(newXTask) === JSON.stringify(step.xTask)) {
        return { goal, item, alreadySuperseded: true };
      }
      throw new Error(`Cannot retry review item '${reviewItemId}' because it is already superseded by a different retry request`);
    }

    // ── Guard: only open/acknowledged review items can be retried ─────────────
    if (!['open', 'acknowledged'].includes(item.lifecycle)) {
      throw new Error(
        `Cannot retry review item '${reviewItemId}' in lifecycle '${item.lifecycle}'. Must be 'open' or 'acknowledged'.`
      );
    }
    if (!['needs_review', 'failed'].includes(item.status)) {
      throw new Error(
        `Cannot retry review item '${reviewItemId}' with status '${item.status}'. Must be 'needs_review' or 'failed'.`
      );
    }

    const oldXTask = step.xTask;
    if (!oldXTask) {
      throw new Error(`Step '${step.title}' has no existing xTask to retry against`);
    }

    // ── Lineage validation (fail closed) ─────────────────────────────────────
    // task_id: must refer to the same logical task.
    if (newXTask.task_id !== oldXTask.task_id) {
      throw new Error(
        `retry_review: newXTask.task_id '${newXTask.task_id}' does not match existing step task_id '${oldXTask.task_id}'. Retry must continue the same logical task.`
      );
    }

    const isSameSpec = newXTask.revision === oldXTask.revision;
    const isRevisedSpec = newXTask.revision === oldXTask.revision + 1;

    if (!isSameSpec && !isRevisedSpec) {
      throw new Error(
        `retry_review: newXTask.revision ${newXTask.revision} is invalid. Same-spec retry requires revision ${oldXTask.revision}; revised retry requires revision ${oldXTask.revision + 1}.`
      );
    }

    if (isSameSpec) {
      // Same specification: attempt must increment by exactly 1.
      const expectedAttempt = oldXTask.attempt + 1;
      if (newXTask.attempt !== expectedAttempt) {
        throw new Error(
          `retry_review: same-spec retry requires newXTask.attempt ${expectedAttempt} (old.attempt ${oldXTask.attempt} + 1); got ${newXTask.attempt}.`
        );
      }
    } else {
      // Revised specification: attempt must reset to 1.
      if (newXTask.attempt !== 1) {
        throw new Error(
          `retry_review: revised retry (revision ${newXTask.revision}) requires newXTask.attempt 1; got ${newXTask.attempt}.`
        );
      }
    }

    // based_on_result_id: must equal reviewItem.resultId when a resultId exists.
    if (item.resultId) {
      if (newXTask.based_on_result_id !== item.resultId) {
        throw new Error(
          `retry_review: newXTask.based_on_result_id '${newXTask.based_on_result_id}' must equal review item resultId '${item.resultId}'.`
        );
      }
    }

    // ── All validation passed. Apply changes atomically before saving. ────────
    const now = new Date().toISOString();

    // 1. Replace step xTask with the authorized new payload.
    step.xTask = newXTask;

    // 2. Allocate exactly one new executionGeneration.
    const prevGen = step.executionGeneration ?? 1;
    step.executionGeneration = prevGen + 1;

    // 3. Reset step state for a fresh execution. Preserve evidence (history);
    //    clear terminal fields that would block re-execution.
    step.status = 'pending';
    step.result = null;
    step.finishedAt = null;
    // startedAt is cleared so the new execution gets its own start timestamp.
    step.startedAt = null;

    // 4. Route goal back to ready (unblocks resume_goal; clears error terminal).
    goal.currentStepId = step.id;
    goal.status = 'ready';
    goal.error = null;
    goal.finishedAt = null;
    goal.updatedAt = now;

    // 5. Supersede the old review item (preserve all original evidence/history).
    item.lifecycle = 'superseded';
    item.supersededAt = now;
    if (options.note) item.note = redactSecrets(String(options.note)).slice(0, 2000);
    if (options.actor) item.acknowledgedBy = redactSecrets(String(options.actor)).slice(0, 200);
    item.updatedAt = now;

    // 6. Append a durable checkpoint BEFORE saving so it lands atomically.
    const newRequestId = getXRequestId(goal, step);
    this.checkpoint_goal(goal.id, step.id, {
      summary: `Human retry prepared: step '${step.title}' will re-execute via X (generation ${step.executionGeneration}). Previous review item '${item.id}' superseded. Next requestId: ${newRequestId}. revision=${newXTask.revision}, attempt=${newXTask.attempt}${item.resultId ? `, based_on_result_id=${newXTask.based_on_result_id}` : ''}.`,
      completedSteps: goal.steps.filter((s) => s.status === 'completed').length,
      evidence: {
        previousReviewItemId: item.id,
        previousStatus: item.status,
        previousResultId: item.resultId || null,
        newExecutionGeneration: step.executionGeneration,
        newRequestId,
        revision: newXTask.revision,
        attempt: newXTask.attempt,
        based_on_result_id: newXTask.based_on_result_id || null,
      },
      nextStep: step.id,
      route: step.route,
    }, goal);

    // 7. Single atomic save. All mutations above land together.
    this.storage.saveGoal(goal);

    if (this.onReviewItemPersisted) {
      try { this.onReviewItemPersisted(item, goal); } catch {}
    }

    return { goal, item };
  }

  /**
   * Alias for retry_review supporting both parameter styles
   */
  async retryReview(goalIdOrParams, reviewItemId, options) {
    if (goalIdOrParams && typeof goalIdOrParams === 'object') {
      return this.retry_review(goalIdOrParams.goalId, goalIdOrParams.reviewItemId, goalIdOrParams);
    }
    return this.retry_review(goalIdOrParams, reviewItemId, options);
  }

  /**
   * Operation 14: get_goal_context (x-context-v1)
   *
   * Derives a compact, read-only continuation context for a Goal.
   * STRICT: ZERO state mutations, ZERO file writes, ZERO execution generation allocation.
   *
   * @param {string} goalId
   * @returns {Promise<object>} x-context-v1 payload
   */
  async get_goal_context(goalId) {
    if (!goalId || typeof goalId !== 'string') throw new Error('goalId is required');
    const goal = this.storage.getGoal(goalId);
    if (!goal) throw new Error(`Goal '${goalId}' not found`);

    const now = new Date().toISOString();

    // Completed step IDs
    const completedStepIds = goal.steps.filter((s) => s.status === 'completed').map((s) => s.id);

    // Current step resolution
    let currentStep = null;
    if (goal.status !== 'completed') {
      if (goal.currentStepId) {
        currentStep = goal.steps.find((s) => s.id === goal.currentStepId) || null;
      }
      if (!currentStep) {
        currentStep = goal.steps.find((s) => s.status !== 'completed') || null;
      }
    }

    const currentStepId = currentStep ? currentStep.id : null;

    // Remaining step IDs
    const remainingStepIds = currentStep
      ? goal.steps
          .filter((s) => s.status !== 'completed' && s.id !== currentStep.id)
          .map((s) => s.id)
      : [];

    // Current step summary
    const currentStepDetails = currentStep
      ? {
          id: currentStep.id,
          title: currentStep.title,
          route: currentStep.route,
          required: currentStep.required !== false,
          status: currentStep.status,
          execution_generation: currentStep.executionGeneration ?? null,
        }
      : null;

    const authoredTask = currentStep && currentStep.route === 'x' && currentStep.xTask ? currentStep.xTask : null;

    // Current request ID and execution status check (Read-only primitive)
    let currentRequestId = null;
    let requestStatus = null;
    if (currentStep && currentStep.route === 'x') {
      currentRequestId = getXRequestId(goal, currentStep);
      if (this.xExecutor?.getXTaskStatus) {
        try {
          requestStatus = await this.xExecutor.getXTaskStatus(currentRequestId);
        } catch {
          requestStatus = { found: false, reason: 'status_check_error' };
        }
      } else {
        requestStatus = { found: false, reason: 'executor_unavailable' };
      }
    }

    // Review Queue item derivation
    const reviewQueue = goal.reviewQueue || [];
    const activeReviewItem =
      (currentStepId && reviewQueue.find((item) => item.stepId === currentStepId && ['open', 'acknowledged'].includes(item.lifecycle))) ||
      reviewQueue.find((item) => ['open', 'acknowledged'].includes(item.lifecycle)) ||
      null;

    const supersededReviewItem = currentStep
      ? reviewQueue.find((item) => item.stepId === currentStep.id && item.lifecycle === 'superseded')
      : null;

    const reviewDetails = activeReviewItem
      ? {
          active_item_id: activeReviewItem.id,
          status: activeReviewItem.status,
          lifecycle: activeReviewItem.lifecycle,
          reason: activeReviewItem.reason || null,
          result_id: activeReviewItem.resultId || null,
        }
      : null;

    // Specialist handoff derivation
    const specialistHandoffs = goal.specialistHandoffs || [];
    const currentHandoffs = currentStep
      ? specialistHandoffs.filter((h) => h.stepId === currentStep.id)
      : [];
    const activeHandoff = currentStep
      ? currentHandoffs.find((h) => {
          if (h.lifecycle !== 'requested') return false;
          const reqId = getXRequestId(goal, currentStep);
          if (h.source.requestId !== reqId) return false;
          if ((h.source.executionGeneration ?? 1) !== (currentStep.executionGeneration ?? 1)) return false;
          if (h.source.xTaskFingerprint && currentStep.xTask) {
            try {
              let taskRoot = currentStep.xTask.workspace?.root || goal.workspace;
              try {
                taskRoot = fsSync.realpathSync(taskRoot);
              } catch {}
              const currentFingerprint = computeXTaskFingerprint(currentStep.xTask, taskRoot);
              if (currentFingerprint !== h.source.xTaskFingerprint) return false;
            } catch {
              return false;
            }
          }
          if (h.reviewItemId) {
            const rev = (goal.reviewQueue || []).find((item) => item.id === h.reviewItemId);
            if (!rev || !['open', 'acknowledged'].includes(rev.lifecycle)) return false;
          }
          return true;
        })
      : null;

    const specialistHandoffDetails = activeHandoff
      ? {
          id: activeHandoff.id,
          target: activeHandoff.target,
          lifecycle: activeHandoff.lifecycle,
          stale: false,
        }
      : currentHandoffs.length > 0
        ? {
            id: currentHandoffs[currentHandoffs.length - 1].id,
            target: currentHandoffs[currentHandoffs.length - 1].target,
            lifecycle: currentHandoffs[currentHandoffs.length - 1].lifecycle,
            stale: true,
          }
        : null;

    // Execution evidence references
    let latestRunId = activeReviewItem?.runId || null;
    let latestResultId = activeReviewItem?.resultId || null;
    let latestTerminalStatus = activeReviewItem?.status || null;

    if (!latestRunId && currentStep?.evidence && typeof currentStep.evidence === 'object') {
      latestRunId = currentStep.evidence.runId || null;
      latestResultId = currentStep.evidence.resultId || null;
    }

    const executionDetails = currentStep
      ? {
          current_request_id: currentRequestId,
          request_status: requestStatus,
          latest_run_id: latestRunId,
          latest_result_id: latestResultId,
          latest_terminal_status: latestTerminalStatus,
        }
      : null;

    // Goal X approval derivation
    let approvalDetails = {
      snapshot_present: false,
      snapshot_granted_at: null,
      validity: 'none',
    };

    if (goal.xApproval) {
      approvalDetails.snapshot_present = true;
      approvalDetails.snapshot_granted_at = goal.xApproval.approvedAt || null;

      if (currentStep && currentStep.route === 'x' && currentStep.xTask) {
        try {
          let taskRoot = currentStep.xTask.workspace?.root || goal.workspace;
          let approvalRoot = goal.xApproval.workspaceRoot;
          try {
            taskRoot = fsSync.realpathSync(taskRoot);
            approvalRoot = fsSync.realpathSync(approvalRoot);
          } catch {}
          const currentFingerprint = computeXTaskFingerprint(currentStep.xTask, taskRoot);
          const match = goal.xApproval.steps?.find(
            (s) => s.stepId === currentStep.id && s.xTaskFingerprint === currentFingerprint
          );
          if (match && approvalRoot === taskRoot) {
            approvalDetails.validity = 'valid';
          } else {
            approvalDetails.validity = 'invalid';
          }
        } catch {
          approvalDetails.validity = 'unknown';
        }
      } else {
        approvalDetails.validity = 'none';
      }
    }

    // Recent checkpoints (max 3)
    const recentCheckpoints = (goal.checkpoints || []).slice(-3).map((cp) => ({
      id: cp.id,
      timestamp: cp.timestamp,
      summary: cp.summary,
      step_id: cp.stepId,
      completed_steps: cp.completedSteps,
      next_step: cp.nextStep,
    }));

    // Next Legal Action derivation (Priority Order)
    let nextLegalAction = null;

    // 2. GOAL_COMPLETED
    if (goal.status === 'completed') {
      nextLegalAction = {
        type: 'GOAL_COMPLETED',
        step_id: null,
        reason: 'Goal is completed.',
      };
    }

    // 2b. Active non-stale Specialist Handoff request / execution / result
    const specialistExecs = goal.specialistExecutions || [];
    const specialistResults = goal.specialistResults || [];
    const specialistDecisions = goal.specialistResultDecisions || [];
    const activeExec = activeHandoff ? specialistExecs.find((e) => e.handoffId === activeHandoff.id && ['authorized', 'dispatching', 'running'].includes(e.status)) : null;
    const interruptedExec = activeHandoff ? specialistExecs.find((e) => e.handoffId === activeHandoff.id && e.status === 'interrupted') : null;
    const latestResult = activeHandoff ? specialistResults.find((r) => r.handoffId === activeHandoff.id) : null;
    const latestDecision = latestResult ? specialistDecisions.find((d) => d.resultId === latestResult.id) : null;

    if (!nextLegalAction && latestResult && !latestDecision) {
      nextLegalAction = {
        type: 'WAIT_FOR_SPECIALIST_RESULT_DECISION',
        step_id: currentStep.id,
        reason: `Specialist result (${latestResult.status}) is available for handoff '${latestResult.handoffId}'; awaiting Main Brain decision.`,
        result_id: latestResult.id,
        execution_id: latestResult.executionId,
        handoff_id: latestResult.handoffId,
      };
    } else if (!nextLegalAction && activeExec) {
      if (activeExec.status === 'authorized') {
        nextLegalAction = {
          type: 'SPECIALIST_EXECUTION_AUTHORIZED',
          step_id: currentStep.id,
          reason: `Specialist execution '${activeExec.id}' is authorized; ready for dispatch.`,
          execution_id: activeExec.id,
          handoff_id: activeExec.handoffId,
        };
      } else if (['dispatching', 'running'].includes(activeExec.status)) {
        nextLegalAction = {
          type: 'WAIT_FOR_SPECIALIST',
          step_id: currentStep.id,
          reason: `Specialist execution '${activeExec.id}' is running under JobManager.`,
          execution_id: activeExec.id,
          handoff_id: activeExec.handoffId,
        };
      }
    } else if (!nextLegalAction && interruptedExec) {
      nextLegalAction = {
        type: 'SPECIALIST_RECOVERY_REQUIRED',
        step_id: currentStep.id,
        reason: `Specialist execution '${interruptedExec.id}' was interrupted. Recovery required.`,
        execution_id: interruptedExec.id,
        handoff_id: interruptedExec.handoffId,
      };
    } else if (!nextLegalAction && activeHandoff && !latestDecision) {
      nextLegalAction = {
        type: 'SPECIALIST_HANDOFF_REQUESTED',
        step_id: currentStep.id,
        reason: `Specialist handoff (${activeHandoff.target}) requested for step '${currentStep.title}'; awaiting execution authorization.`,
        handoff_id: activeHandoff.id,
        target: activeHandoff.target,
      };
    }

    // 3. Active unresolved Review Queue item
    if (!nextLegalAction && activeReviewItem) {
      if (activeReviewItem.status === 'needs_review') {
        nextLegalAction = {
          type: 'WAIT_FOR_REVIEW',
          step_id: activeReviewItem.stepId || currentStepId,
          reason: `Step '${activeReviewItem.stepId || currentStepId}' needs review (lifecycle: ${activeReviewItem.lifecycle}).`,
        };
      } else if (activeReviewItem.status === 'failed') {
        nextLegalAction = {
          type: 'RETRY_REQUIRES_NEW_XTASK',
          step_id: activeReviewItem.stepId || currentStepId,
          reason: `Step '${activeReviewItem.stepId || currentStepId}' failed. A new xTask must be authored to retry.`,
        };
      }
    }

    // 4. Manual waiting step
    if (
      !nextLegalAction &&
      currentStep &&
      currentStep.route === 'manual' &&
      (currentStep.status === 'waiting' || goal.status === 'waiting')
    ) {
      nextLegalAction = {
        type: 'WAIT_FOR_MANUAL_SIGNOFF',
        step_id: currentStep.id,
        reason: `Step '${currentStep.title}' is waiting for manual signoff.`,
      };
    }

    // 5. Current X request exists and is non-terminal
    if (
      !nextLegalAction &&
      requestStatus?.found &&
      ['admitted', 'queued', 'running'].includes(requestStatus.status)
    ) {
      nextLegalAction = {
        type: 'WAIT_FOR_X',
        step_id: currentStep.id,
        reason: `X task execution for step '${currentStep.title}' is currently ${requestStatus.status}.`,
      };
    }

    // 6. Current request is terminal but Goal state has not reconciled with it
    if (
      !nextLegalAction &&
      requestStatus?.found &&
      ['completed', 'needs_review', 'failed', 'interrupted'].includes(requestStatus.status)
    ) {
      if (currentStep.status === 'running' || currentStep.status === 'pending') {
        nextLegalAction = {
          type: 'RECOVERY_REQUIRED',
          step_id: currentStep.id,
          reason: `X request ${currentRequestId} is terminal (${requestStatus.status}) but Goal step status is '${currentStep.status}'. Reconciliation required.`,
        };
      }
    }

    // 7. Interrupted recovery already allocated: waiting/paused step + executionGeneration >= 2 + request not found
    if (
      !nextLegalAction &&
      currentStep &&
      ['waiting', 'paused'].includes(currentStep.status) &&
      (currentStep.executionGeneration ?? 1) >= 2 &&
      (!requestStatus || !requestStatus.found)
    ) {
      nextLegalAction = {
        type: 'RESUME_CURRENT_STEP',
        step_id: currentStep.id,
        reason: `Step '${currentStep.title}' was interrupted; execution generation ${currentStep.executionGeneration} allocated for recovery.`,
      };
    }

    // 8. Human retry prepared: pending step + executionGeneration >= 2 + superseded prior review + request not found
    if (
      !nextLegalAction &&
      currentStep &&
      currentStep.status === 'pending' &&
      (currentStep.executionGeneration ?? 1) >= 2 &&
      supersededReviewItem &&
      (!requestStatus || !requestStatus.found)
    ) {
      nextLegalAction = {
        type: 'RESUME_CURRENT_STEP',
        step_id: currentStep.id,
        reason: `Human retry prepared for step '${currentStep.title}' (generation ${currentStep.executionGeneration}); ready to resume.`,
      };
    }

    // Goal paused with pending/paused step and no active request
    if (
      !nextLegalAction &&
      goal.status === 'paused' &&
      currentStep &&
      ['pending', 'paused'].includes(currentStep.status) &&
      (!requestStatus || !requestStatus.found)
    ) {
      if ((currentStep.executionGeneration ?? 1) >= 2) {
        nextLegalAction = {
          type: 'RESUME_CURRENT_STEP',
          step_id: currentStep.id,
          reason: `Goal is paused with allocated execution generation ${currentStep.executionGeneration}; ready to resume step.`,
        };
      } else {
        nextLegalAction = {
          type: 'RESUME_GOAL',
          step_id: currentStep.id,
          reason: `Goal is paused at step '${currentStep.title}'; resume required.`,
        };
      }
    }

    // 9. First-run pending X step: generation null/1 + request not found -> approval check
    if (
      !nextLegalAction &&
      currentStep &&
      currentStep.route === 'x' &&
      currentStep.status === 'pending' &&
      (!currentStep.executionGeneration || currentStep.executionGeneration <= 1) &&
      (!requestStatus || !requestStatus.found)
    ) {
      if (approvalDetails.validity !== 'valid') {
        nextLegalAction = {
          type: 'WAIT_FOR_APPROVAL',
          step_id: currentStep.id,
          reason: `Step '${currentStep.title}' requires Goal-level X approval before execution.`,
        };
      } else {
        nextLegalAction = {
          type: 'RUN_CURRENT_STEP',
          step_id: currentStep.id,
          reason: `Step '${currentStep.title}' is approved and ready for first execution.`,
        };
      }
    }

    // Non-X first-run pending step
    if (
      !nextLegalAction &&
      currentStep &&
      currentStep.status === 'pending' &&
      (!currentStep.executionGeneration || currentStep.executionGeneration <= 1)
    ) {
      nextLegalAction = {
        type: 'RUN_CURRENT_STEP',
        step_id: currentStep.id,
        reason: `Step '${currentStep.title}' is ready for first execution.`,
      };
    }

    // 10. Completed current step + next pending authored step
    if (!nextLegalAction && currentStep && currentStep.status === 'completed' && remainingStepIds.length > 0) {
      nextLegalAction = {
        type: 'CONTINUE_NEXT_STEP',
        step_id: remainingStepIds[0],
        reason: `Step '${currentStep.id}' completed; next step '${remainingStepIds[0]}' is ready to continue.`,
      };
    }

    // 11. Goal error with no represented recovery path
    if (!nextLegalAction && goal.status === 'error') {
      nextLegalAction = {
        type: 'GOAL_FAILED',
        step_id: currentStepId,
        reason: goal.error || 'Goal entered unrecoverable error state.',
      };
    }

    // Fallback
    if (!nextLegalAction) {
      nextLegalAction = {
        type: 'RECOVERY_REQUIRED',
        step_id: currentStepId,
        reason: 'Canonical state is contradictory or unknown. Recovery required.',
      };
    }

    return {
      version: 'x-context-v1',
      generated_at: now,
      goal: {
        id: goal.id,
        title: goal.title,
        objective: goal.objective,
        status: goal.status,
        workspace: goal.workspace,
      },
      progress: {
        completed_step_ids: completedStepIds,
        current_step_id: currentStepId,
        remaining_step_ids: remainingStepIds,
      },
      current_step: currentStepDetails,
      authored_task: authoredTask,
      execution: executionDetails,
      review: reviewDetails,
      specialist_handoff: specialistHandoffDetails,
      approval: approvalDetails,
      recent_checkpoints: recentCheckpoints,
      next_legal_action: nextLegalAction,
    };
  }

  async getGoalContext(goalIdOrParams) {
    if (goalIdOrParams && typeof goalIdOrParams === 'object') {
      return this.get_goal_context(goalIdOrParams.goalId);
    }
    return this.get_goal_context(goalIdOrParams);
  }

  /**
   * Slice 5: Creates a durable, auditable specialist handoff request record for an X step.
   * STRICT: Performs ZERO X dispatch, ZERO Codex/Work dispatch, ZERO review item lifecycle mutation.
   *
   * @param {string} goalId
   * @param {string} stepId
   * @param {{ target?: string, reason?: string, requestedAction?: string, actor?: string }} options
   * @returns {Promise<{ handoff: object, goal: object }>}
   */
  async request_specialist_handoff(goalId, stepId, options = {}) {
    if (!goalId || typeof goalId !== 'string') throw new Error('goalId is required');
    if (!stepId || typeof stepId !== 'string') throw new Error('stepId is required');

    const target = options.target || options.requested_specialist;
    if (!target || !HANDOFF_TARGETS.includes(target)) {
      throw new Error(`Invalid target '${target}': must be one of ${HANDOFF_TARGETS.join(', ')}`);
    }

    const reason = options.reason || '';
    const requestedAction = options.requestedAction || options.requested_action || '';
    const actor = options.actor || 'MainBrain';

    const goal = this.storage.getGoal(goalId);
    if (!goal) throw new Error(`Goal '${goalId}' not found`);

    const step = goal.steps.find((s) => s.id === stepId);
    if (!step) throw new Error(`Step '${stepId}' not found in Goal '${goalId}'`);

    if (step.status === 'running' || goal.status === 'running') {
      throw new Error(`Cannot request specialist handoff while step '${step.title}' is running`);
    }

    const sourceRequestId = getXRequestId(goal, step);
    if (this.xExecutor?.getXTaskStatus) {
      try {
        const reqStatus = await this.xExecutor.getXTaskStatus(sourceRequestId);
        if (reqStatus?.found && ['admitted', 'queued', 'running'].includes(reqStatus.status)) {
          throw new Error(`Cannot request specialist handoff while X execution is active (${reqStatus.status})`);
        }
      } catch (err) {
        if (err.message?.includes('active')) throw err;
      }
    }

    const reviewQueue = goal.reviewQueue || [];
    const activeReviewItem = reviewQueue.find(
      (item) => item.stepId === step.id && ['open', 'acknowledged'].includes(item.lifecycle)
    );

    if (!activeReviewItem) {
      throw new Error(`Specialist handoff is only permitted for steps with an active NEEDS_REVIEW or FAILED review item`);
    }

    const handoffId = `handoff:${goal.id}:${step.id}:${target}:${sourceRequestId}`;

    const existingHandoffs = goal.specialistHandoffs || [];
    const existing = existingHandoffs.find((h) => h.id === handoffId);
    if (existing) {
      if (existing.reason === reason && existing.requestedAction === requestedAction) {
        return { handoff: existing, goal };
      }
      throw new Error(`Conflicting specialist handoff request: handoff '${handoffId}' already exists with different parameters`);
    }

    let xTaskFingerprint = null;
    if (step.xTask) {
      let taskRoot = step.xTask.workspace?.root || goal.workspace;
      try {
        taskRoot = fsSync.realpathSync(taskRoot);
      } catch {}
      xTaskFingerprint = computeXTaskFingerprint(step.xTask, taskRoot);
    }

    const record = validateSpecialistHandoff({
      version: 'specialist-handoff-request-v1',
      id: handoffId,
      goalId: goal.id,
      stepId: step.id,
      target,
      source: {
        worker: 'x',
        taskId: step.xTask?.task_id || null,
        requestId: sourceRequestId,
        executionGeneration: step.executionGeneration ?? null,
        runId: activeReviewItem.runId || step.evidence?.runId || null,
        resultId: activeReviewItem.resultId || step.evidence?.resultId || null,
        terminalStatus: activeReviewItem.status,
        xTaskFingerprint,
      },
      reviewItemId: activeReviewItem.id,
      reason,
      requestedAction,
      lifecycle: 'requested',
      createdAt: new Date().toISOString(),
      createdBy: actor,
    });

    goal.specialistHandoffs = [...existingHandoffs, record];
    goal.updatedAt = new Date().toISOString();
    this.storage.saveGoal(goal);

    return { handoff: record, goal };
  }

  async requestSpecialistHandoff(goalIdOrParams, stepId, options) {
    if (goalIdOrParams && typeof goalIdOrParams === 'object') {
      return this.request_specialist_handoff(goalIdOrParams.goalId, goalIdOrParams.stepId, goalIdOrParams);
    }
    return this.request_specialist_handoff(goalIdOrParams, stepId, options);
  }

  /**
   * Slice 5: Read-only builder for specialist-handoff-v1 continuation package.
   * STRICT: ZERO state writes, ZERO execution dispatches, ZERO review lifecycle mutations.
   *
   * @param {string} goalId
   * @param {string} handoffId
   * @returns {Promise<object>} specialist-handoff-v1 package
   */
  async build_specialist_handoff(goalId, handoffId) {
    if (!goalId || typeof goalId !== 'string') throw new Error('goalId is required');
    if (!handoffId || typeof handoffId !== 'string') throw new Error('handoffId is required');

    const goal = this.storage.getGoal(goalId);
    if (!goal) throw new Error(`Goal '${goalId}' not found`);

    const handoff = (goal.specialistHandoffs || []).find((h) => h.id === handoffId);
    if (!handoff) throw new Error(`Specialist handoff '${handoffId}' not found in Goal '${goalId}'`);

    const step = goal.steps.find((s) => s.id === handoff.stepId) || null;

    let stale = false;
    if (!step) {
      stale = true;
    } else {
      const currentRequestId = getXRequestId(goal, step);
      if (handoff.source.requestId !== currentRequestId) stale = true;
      if (handoff.source.executionGeneration !== (step.executionGeneration ?? null)) stale = true;

      if (step.route === 'x' && step.xTask && handoff.source.xTaskFingerprint) {
        try {
          let taskRoot = step.xTask.workspace?.root || goal.workspace;
          try {
            taskRoot = fsSync.realpathSync(taskRoot);
          } catch {}
          const currentFingerprint = computeXTaskFingerprint(step.xTask, taskRoot);
          if (currentFingerprint !== handoff.source.xTaskFingerprint) stale = true;
        } catch {
          stale = true;
        }
      }

      if (handoff.reviewItemId) {
        const reviewItem = (goal.reviewQueue || []).find((item) => item.id === handoff.reviewItemId);
        if (!reviewItem || !['open', 'acknowledged'].includes(reviewItem.lifecycle)) {
          stale = true;
        }
      }
    }

    const context = await this.get_goal_context(goalId);
    const now = new Date().toISOString();

    return {
      version: 'specialist-handoff-v1',
      generated_at: now,
      stale,
      handoff: {
        id: handoff.id,
        target: handoff.target,
        lifecycle: handoff.lifecycle,
        reason: handoff.reason,
        requested_action: handoff.requestedAction,
        created_at: handoff.createdAt,
        created_by: handoff.createdBy,
      },
      goal: {
        id: goal.id,
        title: goal.title,
        objective: goal.objective,
        status: goal.status,
        workspace: goal.workspace,
      },
      source: {
        worker: handoff.source.worker,
        step_id: handoff.stepId,
        task_id: handoff.source.taskId,
        request_id: handoff.source.requestId,
        execution_generation: handoff.source.executionGeneration,
        run_id: handoff.source.runId,
        result_id: handoff.source.resultId,
        terminal_status: handoff.source.terminalStatus,
      },
      authored_x_task: step?.xTask || null,
      context,
      evidence: {
        review_item_id: handoff.reviewItemId,
        review_reason: handoff.reason,
        result_id: handoff.source.resultId,
        run_id: handoff.source.runId,
      },
      boundaries: {
        workspace: step?.xTask?.workspace?.root || goal.workspace,
        allowed_paths: step?.xTask?.scope?.allowed_paths || [],
        forbidden_paths: step?.xTask?.scope?.forbidden_paths || [],
        constraints: step?.xTask?.constraints || goal.constraints || [],
        acceptance_criteria: step?.xTask?.acceptance_criteria || [],
        commit_policy: step?.xTask?.commit_policy || { mode: 'never' },
      },
    };
  }

  async buildSpecialistHandoff(goalIdOrParams, handoffId) {
    if (goalIdOrParams && typeof goalIdOrParams === 'object') {
      return this.build_specialist_handoff(goalIdOrParams.goalId, goalIdOrParams.handoffId);
    }
    return this.build_specialist_handoff(goalIdOrParams, handoffId);
  }

  async get_specialist_handoff(goalId, handoffId) {
    return this.build_specialist_handoff(goalId, handoffId);
  }

  async getSpecialistHandoff(goalIdOrParams, handoffId) {
    if (goalIdOrParams && typeof goalIdOrParams === 'object') {
      return this.get_specialist_handoff(goalIdOrParams.goalId, goalIdOrParams.handoffId);
    }
    return this.get_specialist_handoff(goalIdOrParams, handoffId);
  }

  async list_specialist_handoffs(goalId) {
    if (!goalId || typeof goalId !== 'string') throw new Error('goalId is required');
    const goal = this.storage.getGoal(goalId);
    if (!goal) throw new Error(`Goal '${goalId}' not found`);
    return goal.specialistHandoffs || [];
  }

  async listSpecialistHandoffs(goalIdOrParams) {
    if (goalIdOrParams && typeof goalIdOrParams === 'object') {
      return this.list_specialist_handoffs(goalIdOrParams.goalId);
    }
    return this.list_specialist_handoffs(goalIdOrParams);
  }

  /**
   * Slice 6A: Explicitly authorizes specialist execution for a durable handoff.
   * STRICT: Requires existing non-stale requested handoff + active unresolved X review item.
   */
  async authorize_specialist_execution(goalId, handoffId, options = {}) {
    if (!goalId || typeof goalId !== 'string') throw new Error('goalId is required');
    if (!handoffId || typeof handoffId !== 'string') throw new Error('handoffId is required');

    const actor = options.actor || 'MainBrain';

    const goal = this.storage.getGoal(goalId);
    if (!goal) throw new Error(`Goal '${goalId}' not found`);

    const handoffPackage = await this.build_specialist_handoff(goalId, handoffId);
    if (!handoffPackage || handoffPackage.stale) {
      throw new Error(`Specialist handoff '${handoffId}' is stale or invalid and cannot be authorized`);
    }

    if (handoffPackage.handoff.target !== 'codex') {
      throw new Error(`Unsupported specialist target '${handoffPackage.handoff.target}': only 'codex' is supported`);
    }

    if (handoffPackage.handoff.lifecycle !== 'requested') {
      throw new Error(`Specialist handoff '${handoffId}' is in state '${handoffPackage.handoff.lifecycle}', expected 'requested'`);
    }

    const reviewQueue = goal.reviewQueue || [];
    const activeReviewItem = reviewQueue.find(
      (item) => item.id === handoffPackage.evidence.review_item_id && ['open', 'acknowledged'].includes(item.lifecycle)
    );
    if (!activeReviewItem) {
      throw new Error(`Linked X review item is missing or resolved; specialist execution cannot be authorized`);
    }

    const existingExecs = goal.specialistExecutions || [];
    const priorForHandoff = existingExecs.filter((e) => e.handoffId === handoffId);
    const existing = priorForHandoff.find((e) => ['authorized', 'dispatching', 'running', 'completed'].includes(e.status));
    if (existing) {
      return { execution: existing, goal };
    }
    // Every prior attempt for this handoff (if any) has already terminated as
    // interrupted/failed; derive a fresh, non-colliding generation-suffixed id so a
    // retry never overwrites or duplicates the historical record of that attempt.
    const execId = deriveSpecialistExecutionId(handoffId, priorForHandoff.length + 1);

    const lockCheck = isWorkspaceLocked(goal.workspace, {
      jobManager: this.jobManager,
      claimStore: this.claimStore,
      goalStorage: this.storage,
    });
    if (lockCheck.locked) {
      throw new Error(`Cannot authorize specialist execution: ${lockCheck.reason}`);
    }

    let xTaskFingerprint = null;
    if (handoffPackage.authored_x_task) {
      try {
        let taskRoot = handoffPackage.authored_x_task.workspace?.root || goal.workspace;
        try { taskRoot = fsSync.realpathSync(taskRoot); } catch {}
        xTaskFingerprint = computeXTaskFingerprint(handoffPackage.authored_x_task, taskRoot);
      } catch {}
    }

    const executionRecord = validateSpecialistExecution({
      version: 'specialist-execution-v1',
      id: execId,
      handoffId: handoffPackage.handoff.id,
      target: handoffPackage.handoff.target,
      goalId: goal.id,
      stepId: handoffPackage.source.step_id,
      generation: priorForHandoff.length + 1,
      status: 'authorized',
      workspace: goal.workspace,
      source: {
        worker: 'x',
        requestId: handoffPackage.source.request_id,
        runId: handoffPackage.source.run_id,
        resultId: handoffPackage.source.result_id,
        taskId: handoffPackage.source.task_id,
        xTaskFingerprint,
      },
      authorizedAt: new Date().toISOString(),
      authorizedBy: actor,
    });

    goal.specialistExecutions = [...existingExecs, executionRecord];
    goal.updatedAt = new Date().toISOString();
    this.storage.saveGoal(goal);

    return { execution: executionRecord, goal };
  }

  async authorizeSpecialistExecution(goalIdOrParams, handoffId, options) {
    if (goalIdOrParams && typeof goalIdOrParams === 'object') {
      return this.authorize_specialist_execution(goalIdOrParams.goalId, goalIdOrParams.handoffId, goalIdOrParams);
    }
    return this.authorize_specialist_execution(goalIdOrParams, handoffId, options);
  }

  /**
   * Slice 6A: Dispatches an authorized specialist execution under JobManager via CodexAdapter.
   */
  async dispatch_specialist_execution(goalId, executionId, options = {}) {
    if (!goalId || typeof goalId !== 'string') throw new Error('goalId is required');
    if (!executionId || typeof executionId !== 'string') throw new Error('executionId is required');

    const goal = this.storage.getGoal(goalId);
    if (!goal) throw new Error(`Goal '${goalId}' not found`);

    const execution = (goal.specialistExecutions || []).find((e) => e.id === executionId);
    if (!execution) throw new Error(`Specialist execution '${executionId}' not found in Goal '${goalId}'`);

    if (execution.status !== 'authorized') {
      throw new Error(`Specialist execution '${executionId}' is in status '${execution.status}', expected 'authorized'`);
    }

    const handoffPackage = await this.build_specialist_handoff(goal.id, execution.handoffId);
    if (handoffPackage.stale) {
      throw new Error(`Specialist handoff is stale; cannot dispatch execution '${executionId}'`);
    }

    const lockCheck = isWorkspaceLocked(goal.workspace, {
      jobManager: this.jobManager,
      claimStore: this.claimStore,
      goalStorage: this.storage,
      ignoreExecutionId: executionId,
    });
    if (lockCheck.locked) {
      throw new Error(`Cannot dispatch specialist execution: ${lockCheck.reason}`);
    }

    const gitPreCheck = await captureGitPreCheck(goal.workspace);

    execution.status = 'dispatching';
    execution.startedAt = new Date().toISOString();
    goal.updatedAt = new Date().toISOString();
    this.storage.saveGoal(goal);

    const codexBin = await resolveCodexBinary(options.codexBin);

    const osTmpDir = os.tmpdir();
    const tempDir = await fs.mkdtemp(path.join(osTmpDir, 'hearth-codex-specialist-'));
    const schemaPath = await createOutputSchemaFile(tempDir);
    const outputPath = path.join(tempDir, 'codex-final-output.json');

    const promptText = formatSpecialistPrompt(handoffPackage);
    const args = buildCodexArgs({
      workspace: goal.workspace,
      schemaPath,
      outputPath,
    });

    const jobMgr = this.jobManager || getJobManager();
    const jobId = `job_specialist_${execution.id}_${Date.now()}`;

    const onCompleted = async (jobResult) => {
      try {
        await this._handleSpecialistJobCompleted(goal.id, execution.id, jobResult, gitPreCheck, handoffPackage, outputPath, tempDir);
      } catch (err) {
        console.error(`[GoalRunner] Error in specialist completion handler:`, err);
      }
    };

    const job = jobMgr.startJob({
      jobId,
      command: codexBin,
      args,
      cwd: goal.workspace,
      stdinPayload: promptText,
      metadata: {
        type: 'specialist_execution',
        goalId: goal.id,
        executionId: execution.id,
        handoffId: execution.handoffId,
        workspace: goal.workspace,
        gitPreCheck,
      },
      onCompleted,
    });

    execution.status = 'running';
    execution.jobId = job.id;
    goal.updatedAt = new Date().toISOString();
    this.storage.saveGoal(goal);

    return { execution, job, goal };
  }

  async dispatchSpecialistExecution(goalIdOrParams, executionId, options) {
    if (goalIdOrParams && typeof goalIdOrParams === 'object') {
      return this.dispatch_specialist_execution(goalIdOrParams.goalId, goalIdOrParams.executionId, goalIdOrParams);
    }
    return this.dispatch_specialist_execution(goalIdOrParams, executionId, options);
  }

  /**
   * Internal completion handler when JobManager completes a specialist process.
   */
  async _handleSpecialistJobCompleted(goalId, executionId, jobResult, gitPreCheck, handoffPackage, outputPath, tempDir) {
    const goal = this.storage.getGoal(goalId);
    if (!goal) return;

    const execution = (goal.specialistExecutions || []).find((e) => e.id === executionId);
    if (!execution) return;

    const { sessionId } = parseCodexJsonlOutput(jobResult.stdout);
    let finalResponse = null;
    try {
      if (fsSync.existsSync(outputPath)) {
        const raw = await fs.readFile(outputPath, 'utf8');
        finalResponse = JSON.parse(raw);
      }
    } catch {}

    const gitPostCheck = await verifyGitPostCheck(goal.workspace, gitPreCheck, handoffPackage.boundaries);

    let status = finalResponse?.status && ['completed', 'needs_review', 'failed'].includes(finalResponse.status)
      ? finalResponse.status
      : 'completed';

    if (jobResult.status === 'cancelled' || jobResult.signal) {
      status = 'interrupted';
    } else if (jobResult.exitCode !== 0 || jobResult.status === 'error') {
      status = 'failed';
    } else if (!gitPostCheck.allowedPathsValid || !gitPostCheck.forbiddenPathsValid || gitPostCheck.violations.length > 0) {
      status = 'needs_review';
    }

    const resId = `specialist-res:${execution.id}:${Date.now()}`;
    const resultRecord = validateSpecialistResult({
      version: 'specialist-result-v1',
      id: resId,
      executionId: execution.id,
      handoffId: execution.handoffId,
      goalId: goal.id,
      stepId: execution.stepId,
      target: execution.target,
      status,
      summary: finalResponse?.summary || jobResult.error || `Codex specialist execution finished with status '${status}'.`,
      codex: {
        sessionId: sessionId || execution.codexSessionId,
        exitCode: jobResult.exitCode,
        signal: jobResult.signal,
      },
      git: {
        preHead: gitPreCheck.head,
        postHead: gitPostCheck.postHead,
        preDirtyPaths: gitPreCheck.dirtyPaths,
        postChangedPaths: gitPostCheck.postChangedPaths,
        commitsCreated: gitPostCheck.commitsCreated,
      },
      boundary: {
        allowedPathsValid: gitPostCheck.allowedPathsValid,
        forbiddenPathsValid: gitPostCheck.forbiddenPathsValid,
        violations: gitPostCheck.violations,
      },
      validation: {
        claimed: finalResponse?.validation_claims || null,
        observed: {
          postChangedPaths: gitPostCheck.postChangedPaths,
          commitsCreated: gitPostCheck.commitsCreated,
        },
      },
      startedAt: execution.startedAt || execution.authorizedAt,
      finishedAt: new Date().toISOString(),
      error: jobResult.error || (gitPostCheck.violations.length ? gitPostCheck.violations.join('; ') : null),
    });

    execution.status = (status === 'needs_review' || status === 'completed') ? 'completed' : status;
    execution.finishedAt = new Date().toISOString();
    execution.resultId = resId;
    if (sessionId) execution.codexSessionId = sessionId;

    goal.specialistResults = [...(goal.specialistResults || []), resultRecord];
    goal.updatedAt = new Date().toISOString();
    this.storage.saveGoal(goal);

    try {
      if (tempDir && fsSync.existsSync(tempDir)) {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    } catch {}
  }

  async get_specialist_execution(goalId, executionId) {
    if (!goalId || typeof goalId !== 'string') throw new Error('goalId is required');
    if (!executionId || typeof executionId !== 'string') throw new Error('executionId is required');
    const goal = this.storage.getGoal(goalId);
    if (!goal) throw new Error(`Goal '${goalId}' not found`);
    const exec = (goal.specialistExecutions || []).find((e) => e.id === executionId);
    if (!exec) throw new Error(`Specialist execution '${executionId}' not found in Goal '${goalId}'`);
    return exec;
  }

  async getSpecialistExecution(goalIdOrParams, executionId) {
    if (goalIdOrParams && typeof goalIdOrParams === 'object') {
      return this.get_specialist_execution(goalIdOrParams.goalId, goalIdOrParams.executionId);
    }
    return this.get_specialist_execution(goalIdOrParams, executionId);
  }

  async get_specialist_result(goalId, resultId) {
    if (!goalId || typeof goalId !== 'string') throw new Error('goalId is required');
    if (!resultId || typeof resultId !== 'string') throw new Error('resultId is required');
    const goal = this.storage.getGoal(goalId);
    if (!goal) throw new Error(`Goal '${goalId}' not found`);
    const res = (goal.specialistResults || []).find((r) => r.id === resultId);
    if (!res) throw new Error(`Specialist result '${resultId}' not found in Goal '${goalId}'`);
    return res;
  }

  async getSpecialistResult(goalIdOrParams, resultId) {
    if (goalIdOrParams && typeof goalIdOrParams === 'object') {
      return this.get_specialist_result(goalIdOrParams.goalId, goalIdOrParams.resultId);
    }
    return this.get_specialist_result(goalIdOrParams, resultId);
  }

  async list_specialist_executions(goalId) {
    if (!goalId || typeof goalId !== 'string') throw new Error('goalId is required');
    const goal = this.storage.getGoal(goalId);
    if (!goal) throw new Error(`Goal '${goalId}' not found`);
    return goal.specialistExecutions || [];
  }

  async listSpecialistExecutions(goalIdOrParams) {
    if (goalIdOrParams && typeof goalIdOrParams === 'object') {
      return this.list_specialist_executions(goalIdOrParams.goalId);
    }
    return this.list_specialist_executions(goalIdOrParams);
  }

  async list_specialist_results(goalId) {
    if (!goalId || typeof goalId !== 'string') throw new Error('goalId is required');
    const goal = this.storage.getGoal(goalId);
    if (!goal) throw new Error(`Goal '${goalId}' not found`);
    return goal.specialistResults || [];
  }

  async listSpecialistResults(goalIdOrParams) {
    if (goalIdOrParams && typeof goalIdOrParams === 'object') {
      return this.list_specialist_results(goalIdOrParams.goalId);
    }
    return this.list_specialist_results(goalIdOrParams);
  }

  /**
   * Slice 6B: Explicitly ACCEPTS a valid completed specialist result.
   */
  async accept_specialist_result(goalId, resultId, options = {}) {
    if (!goalId || typeof goalId !== 'string') throw new Error('goalId is required');
    if (!resultId || typeof resultId !== 'string') throw new Error('resultId is required');

    const goal = this.storage.getGoal(goalId);
    if (!goal) throw new Error(`Goal '${goalId}' not found`);

    const result = (goal.specialistResults || []).find((r) => r.id === resultId);
    if (!result) throw new Error(`Specialist result '${resultId}' not found in Goal '${goalId}'`);

    const execution = (goal.specialistExecutions || []).find((e) => e.id === result.executionId);
    if (!execution) throw new Error(`Specialist execution '${result.executionId}' not found for result '${resultId}'`);

    const handoff = (goal.specialistHandoffs || []).find((h) => h.id === result.handoffId);
    if (!handoff) throw new Error(`Specialist handoff '${result.handoffId}' not found for result '${resultId}'`);

    const step = goal.steps.find((s) => s.id === result.stepId);
    if (!step) throw new Error(`Step '${result.stepId}' not found in Goal '${goalId}'`);

    const existingDecision = (goal.specialistResultDecisions || []).find((d) => d.resultId === resultId);
    if (existingDecision) {
      if (existingDecision.decision === 'accepted') {
        return { decision: existingDecision, goal, accepted: true, idempotent: true };
      }
      throw new Error(`Cannot accept specialist result '${resultId}': result was previously rejected`);
    }

    if (result.status !== 'completed') {
      throw new Error(`Cannot accept specialist result '${resultId}': status is '${result.status}', only 'completed' results may be accepted`);
    }

    if (step.status === 'completed') {
      throw new Error(`Cannot accept specialist result '${resultId}': step '${step.id}' is already completed`);
    }

    const currentGen = step.executionGeneration ?? 1;
    const handoffGen = handoff.source?.executionGeneration ?? 1;
    if (currentGen !== handoffGen) {
      throw new Error(`Specialist result '${resultId}' is stale; step execution generation is ${currentGen} but handoff generation was ${handoffGen}`);
    }

    if (step.route === 'x' && step.xTask) {
      try {
        let taskRoot = step.xTask.workspace?.root || goal.workspace;
        try { taskRoot = fsSync.realpathSync(taskRoot); } catch {}
        const currentFingerprint = computeXTaskFingerprint(step.xTask, taskRoot);
        if (handoff.source?.xTaskFingerprint && handoff.source.xTaskFingerprint !== currentFingerprint) {
          throw new Error(`Specialist result '${resultId}' is stale; step xTask content has changed`);
        }
      } catch (err) {
        if (err.message.includes('is stale')) throw err;
      }
    }

    const reviewItem = (goal.reviewQueue || []).find(
      (it) => (handoff.reviewItemId && it.id === handoff.reviewItemId) || (it.stepId === step.id && it.runId === handoff.source?.runId)
    ) || (goal.reviewQueue || []).find((it) => it.stepId === step.id && ['open', 'acknowledged'].includes(it.lifecycle));

    if (!reviewItem || !['open', 'acknowledged'].includes(reviewItem.lifecycle)) {
      throw new Error(`Specialist result '${resultId}' is stale; original linked review item is no longer open or acknowledged`);
    }

    const newerExec = (goal.specialistExecutions || []).find(
      (e) => e.stepId === step.id && e.id !== execution.id && new Date(e.authorizedAt || 0) > new Date(execution.authorizedAt || 0)
    );
    if (newerExec) {
      throw new Error(`Specialist result '${resultId}' is stale; a newer specialist execution exists for step '${step.id}'`);
    }

    const decisionRecord = validateSpecialistResultDecision({
      version: 'specialist-result-decision-v1',
      id: `specialist-decision:${result.id}`,
      resultId: result.id,
      executionId: result.executionId,
      handoffId: result.handoffId,
      goalId: goal.id,
      stepId: step.id,
      decision: 'accepted',
      decidedAt: new Date().toISOString(),
      decidedBy: options.decidedBy || 'MainBrain',
      note: options.note || null,
    });

    goal.specialistResultDecisions = [...(goal.specialistResultDecisions || []), decisionRecord];

    reviewItem.lifecycle = 'superseded';
    reviewItem.supersededAt = new Date().toISOString();
    reviewItem.note = redactSecrets(`Superseded by accepted specialist result ${result.id}` + (options.note ? `: ${options.note}` : ''));
    reviewItem.updatedAt = new Date().toISOString();

    step.status = 'completed';
    step.result = redactSecrets(result.summary || 'Specialist result accepted.');
    step.specialistResultId = result.id;
    step.specialistExecutionId = result.executionId;
    step.specialistHandoffId = result.handoffId;
    step.evidence = sanitizeEvidence({
      ...(step.evidence || {}),
      specialistResultId: result.id,
      specialistExecutionId: result.executionId,
      specialistHandoffId: result.handoffId,
      codexSessionId: result.codex?.sessionId || null,
      gitPostHead: result.git?.postHead || null,
      postChangedPaths: result.git?.postChangedPaths || [],
    });
    step.finishedAt = new Date().toISOString();

    const stepIndex = goal.steps.findIndex((s) => s.id === step.id);
    const completedCount = goal.steps.filter((s) => s.status === 'completed').length;
    const nextStepObj = goal.steps.slice(stepIndex + 1).find((s) => !['completed', 'skipped'].includes(s.status));

    if (nextStepObj) {
      goal.status = 'ready';
      goal.currentStepId = nextStepObj.id;
      this.checkpoint_goal(goal.id, step.id, {
        summary: `Step ${stepIndex + 1} (${step.title}) completed via accepted specialist result ${result.id}: ${step.result}`,
        completedSteps: completedCount,
        evidence: step.evidence,
        nextStep: nextStepObj.id,
        route: step.route,
      }, goal);
      const savedGoal = this.storage.saveGoal(goal);
      return { decision: decisionRecord, goal: savedGoal, accepted: true };
    } else {
      this.checkpoint_goal(goal.id, step.id, {
        summary: `Step ${stepIndex + 1} (${step.title}) completed via accepted specialist result ${result.id}: ${step.result}`,
        completedSteps: completedCount,
        evidence: step.evidence,
        nextStep: null,
        route: step.route,
      }, goal);
      const savedGoal = this.complete_goal(goal.id);
      return { decision: decisionRecord, goal: savedGoal, accepted: true };
    }
  }

  async acceptSpecialistResult(goalIdOrParams, resultId, options) {
    if (goalIdOrParams && typeof goalIdOrParams === 'object') {
      return this.accept_specialist_result(goalIdOrParams.goalId, goalIdOrParams.resultId, goalIdOrParams);
    }
    return this.accept_specialist_result(goalIdOrParams, resultId, options);
  }

  /**
   * Slice 6B: Explicitly REJECTS a specialist result.
   */
  async reject_specialist_result(goalId, resultId, options = {}) {
    if (!goalId || typeof goalId !== 'string') throw new Error('goalId is required');
    if (!resultId || typeof resultId !== 'string') throw new Error('resultId is required');

    const goal = this.storage.getGoal(goalId);
    if (!goal) throw new Error(`Goal '${goalId}' not found`);

    const result = (goal.specialistResults || []).find((r) => r.id === resultId);
    if (!result) throw new Error(`Specialist result '${resultId}' not found in Goal '${goalId}'`);

    const existingDecision = (goal.specialistResultDecisions || []).find((d) => d.resultId === resultId);
    if (existingDecision) {
      if (existingDecision.decision === 'rejected') {
        return { decision: existingDecision, goal, rejected: true, idempotent: true };
      }
      throw new Error(`Cannot reject specialist result '${resultId}': result was previously accepted`);
    }

    if (!['completed', 'needs_review'].includes(result.status)) {
      throw new Error(`Cannot reject specialist result '${resultId}': status is '${result.status}'`);
    }

    const decisionRecord = validateSpecialistResultDecision({
      version: 'specialist-result-decision-v1',
      id: `specialist-decision:${result.id}`,
      resultId: result.id,
      executionId: result.executionId,
      handoffId: result.handoffId,
      goalId: goal.id,
      stepId: result.stepId,
      decision: 'rejected',
      decidedAt: new Date().toISOString(),
      decidedBy: options.decidedBy || 'MainBrain',
      note: options.note || null,
    });

    goal.specialistResultDecisions = [...(goal.specialistResultDecisions || []), decisionRecord];

    const completedCount = goal.steps.filter((s) => s.status === 'completed').length;
    this.checkpoint_goal(goal.id, result.stepId, {
      summary: `Specialist result ${result.id} rejected: ${options.note || 'Main Brain rejected specialist result'}`,
      completedSteps: completedCount,
      nextStep: result.stepId,
      route: 'x',
    }, goal);

    const savedGoal = this.storage.saveGoal(goal);
    return { decision: decisionRecord, goal: savedGoal, rejected: true };
  }

  async rejectSpecialistResult(goalIdOrParams, resultId, options) {
    if (goalIdOrParams && typeof goalIdOrParams === 'object') {
      return this.reject_specialist_result(goalIdOrParams.goalId, goalIdOrParams.resultId, goalIdOrParams);
    }
    return this.reject_specialist_result(goalIdOrParams, resultId, options);
  }

  async get_specialist_result_decision(goalId, resultId) {
    if (!goalId || typeof goalId !== 'string') throw new Error('goalId is required');
    if (!resultId || typeof resultId !== 'string') throw new Error('resultId is required');
    const goal = this.storage.getGoal(goalId);
    if (!goal) throw new Error(`Goal '${goalId}' not found`);
    const decision = (goal.specialistResultDecisions || []).find((d) => d.resultId === resultId);
    return decision || null;
  }

  async getSpecialistResultDecision(goalIdOrParams, resultId) {
    if (goalIdOrParams && typeof goalIdOrParams === 'object') {
      return this.get_specialist_result_decision(goalIdOrParams.goalId, goalIdOrParams.resultId);
    }
    return this.get_specialist_result_decision(goalIdOrParams, resultId);
  }
}
