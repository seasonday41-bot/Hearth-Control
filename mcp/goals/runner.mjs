import fs from 'node:fs/promises';
import { redactSecrets } from '../executors/antigravity.mjs';
import { getJobManager } from '../runtime/job-manager.mjs';
import {
  createGoal,
  createGoalCheckpoint,
  validateGoal,
} from './model.mjs';

export class GoalRunner {
  /**
   * @param {{
   *   storage: import('./storage.mjs').GoalStorage,
   *   antigravityExecutor?: {
   *     startAntigravityTask: Function,
   *     getAntigravityTask: Function,
   *   },
   *   jobManager?: import('../runtime/job-manager.mjs').JobManager,
   * }} options
   */
  constructor(options) {
    const storage = (options && typeof options.saveGoal === 'function') ? options : options?.storage;
    if (!storage) throw new Error('storage is required for GoalRunner');
    this.storage = storage;
    this.antigravityExecutor = options?.antigravityExecutor;
    this.jobManager = options?.jobManager || null;
    this.claimStore = options?.claimStore || null;
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
      if (goal.status === 'running') {
        goal.status = 'paused';
        goal.updatedAt = new Date().toISOString();
        const step = goal.steps.find((s) => s.id === goal.currentStepId);
        if (step && step.status === 'running') {
          step.status = 'paused';
          step.result = 'Step execution interrupted by application restart. Resume required.';
        }
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
  async create_goal({ title, objective, workspace, steps = [], constraints = [] }) {
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

    const goal = createGoal({ title, objective, workspace, steps, constraints });
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
    if (this.activeGoalId && this.activeGoalId !== goalId) {
      throw new Error(`Another goal ('${this.activeGoalId}') is currently executing`);
    }

    this.activeGoalId = goalId;
    this.pausedGoals.delete(goalId);

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
          });

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

          this.checkpoint_goal(goal.id, step.id, {
            summary: `Step ${stepIndex + 1} (${step.title}) waiting: ${step.result}`,
            completedSteps: goal.steps.filter((s) => s.status === 'completed').length,
            evidence: stepResult.evidence,
            nextStep: step.id,
            route: step.route,
          });

          this.storage.saveGoal(goal);
          this.activeGoalId = null;
          if (options.onProgress) options.onProgress(goal);
          return goal;
        } else if (stepResult.status === 'error') {
          step.status = 'error';
          step.result = stepResult.error ? redactSecrets(stepResult.error) : 'Step execution error';
          step.finishedAt = new Date().toISOString();
          this.storage.saveGoal(goal);

          if (step.required) {
            return this.fail_goal(goal.id, `Required step '${step.title}' failed: ${step.result}`);
          }
          // Optional step failed, create checkpoint and proceed
          stepIndex++;
        }
      } catch (err) {
        step.status = 'error';
        step.result = redactSecrets(err.message);
        step.finishedAt = new Date().toISOString();
        this.storage.saveGoal(goal);

        if (step.required) {
          return this.fail_goal(goal.id, `Required step '${step.title}' threw error: ${err.message}`);
        }
        stepIndex++;
      }
    }

    // All steps processed: verify completion contract
    return this.complete_goal(goal.id);
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

    if (!['paused', 'waiting'].includes(goal.status)) {
      throw new Error(`Cannot resume goal in status '${goal.status}'`);
    }

    const currentStep = goal.steps.find((s) => s.id === (goal.currentStepId || goal.steps[0]?.id));
    if (currentStep && currentStep.route === 'manual' && currentStep.status === 'waiting') {
      throw new Error(
        `Cannot resume goal on waiting manual step '${currentStep.title}'. Explicit manual sign-off is required.`
      );
    }

    this.pausedGoals.delete(goalId);

    // Read latest checkpoint if available
    const latestCheckpoint = goal.checkpoints[goal.checkpoints.length - 1];
    if (latestCheckpoint?.nextStep) {
      goal.currentStepId = latestCheckpoint.nextStep;
    }

    return this.run_goal(goalId, options);
  }

  /**
   * Operation 7: checkpoint_goal
   */
  checkpoint_goal(goalId, stepId, data = {}) {
    if (!goalId || typeof goalId !== 'string') throw new Error('goalId is required');

    const goal = this.storage.getGoal(goalId);
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
}

