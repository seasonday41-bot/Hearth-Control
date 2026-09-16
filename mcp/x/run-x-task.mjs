import crypto from 'node:crypto';
import { parseXTask } from './task-contract.mjs';
import { XLeaseKeeper } from './lease-keeper.mjs';
import { XExecutionAbortedError } from './cancellation.mjs';
import { executeXTask } from './execute-x-task.mjs';

import { isWorkspaceLocked } from '../specialist/workspace-lock.mjs';

const describeError = (error) => ({
  code: typeof error?.code === 'string' ? error.code : 'ORCHESTRATION_ERROR',
  message: error?.message || String(error),
});

const isCancellation = (error) => error instanceof XExecutionAbortedError || error?.code === 'X_EXECUTION_ABORTED';
const keeperFailure = (status) => status === 'ownership_lost' ? 'ownership_lost' : 'ownership_uncertain';

async function releaseOriginalClaim(keeper, claimStore, claim) {
  const cleanup = { keeperStatus: null, released: null, error: null };
  if (keeper) {
    try {
      cleanup.keeperStatus = (await keeper.stop()).status;
    } catch (error) {
      cleanup.error = describeError(error);
    }
  }
  try {
    cleanup.released = claimStore.release({
      taskId: claim.taskId, ownerId: claim.ownerId, leaseId: claim.leaseId,
    });
  } catch (error) {
    cleanup.error = describeError(error);
  }
  return cleanup;
}

/**
 * Admit one validated X task and return its durable run ID without waiting for
 * model execution. Only the original claim identity may complete or release
 * this run. `done` always resolves to an orchestration outcome, never rejects.
 */
export async function runXTask(task, modelAdapter, options = {}) {
  const {
    claimStore, runStore, ownerId, leaseDurationMs, executionOptions = {}, runId, jobManager, goalStorage,
  } = options;
  const validatedTask = parseXTask(task);
  if (typeof ownerId !== 'string' || !ownerId.trim()) throw new TypeError('ownerId is required.');
  if (!claimStore || typeof claimStore.claim !== 'function' || typeof claimStore.release !== 'function') {
    throw new TypeError('runXTask requires an XClaimStore.');
  }
  if (!runStore || typeof runStore.createRun !== 'function' || typeof runStore.markRunning !== 'function' ||
      typeof runStore.completeRunFenced !== 'function' || typeof runStore.failRunFenced !== 'function') {
    throw new TypeError('runXTask requires an XRunStore with fenced terminal methods.');
  }
  if (!claimStore.storagePath || claimStore.storagePath !== runStore.storagePath) {
    throw new TypeError('XClaimStore and XRunStore must use the same runtime SQLite path.');
  }
  if (runId !== undefined && (typeof runId !== 'string' || !runId.trim())) throw new TypeError('runId must be a non-empty string.');

  const wsPath = validatedTask.workspace?.root || validatedTask.workspace_root || validatedTask.workspace;
  if (wsPath) {
    const lockCheck = isWorkspaceLocked(wsPath, {
      jobManager,
      claimStore,
      runStore,
      goalStorage,
    });
    if (lockCheck.locked) {
      return { accepted: false, reason: 'workspace_locked', runId: null, error: describeError(new Error(lockCheck.reason)) };
    }
  }

  const taskId = validatedTask.task_id;
  let claim;
  try {
    claim = claimStore.claim({ taskId, ownerId, leaseDurationMs });
  } catch (error) {
    return { accepted: false, reason: 'setup_failed', runId: null, error: describeError(error) };
  }
  if (claim === null) return { accepted: false, reason: 'no_capacity', runId: null };

  const actualRunId = runId ?? crypto.randomUUID();
  let keeper = null;
  try {
    runStore.createRun({ runId: actualRunId, taskId, claimLeaseId: claim.leaseId });
    if (!runStore.markRunning({ runId: actualRunId, claimLeaseId: claim.leaseId })) {
      throw new Error('X run could not transition from queued to running.');
    }
    keeper = new XLeaseKeeper({ claimStore, claim });
    keeper.start();
  } catch (error) {
    // createRun can fail after its INSERT; only this exact run/lease may be
    // marked failed. A duplicate runId must never be changed by this owner.
    let persistedRun = null;
    try { persistedRun = runStore.getRun(actualRunId); } catch { /* leave for reconciliation */ }
    const ours = persistedRun?.taskId === taskId && persistedRun.claimLeaseId === claim.leaseId;
    if (ours && ['queued', 'running'].includes(persistedRun.status)) {
      try {
        persistedRun = runStore.failRunFenced({
          runId: actualRunId, taskId, ownerId: claim.ownerId, leaseId: claim.leaseId,
          error: error?.message || 'X run setup failed.',
        }) ?? persistedRun;
      } catch { /* an uncertain write remains reconcilable */ }
    }
    const cleanup = await releaseOriginalClaim(keeper, claimStore, claim);
    return {
      accepted: false, reason: 'setup_failed', runId: ours ? actualRunId : null,
      error: describeError(error), run: ours ? persistedRun : null, cleanup,
    };
  }

  const controller = new AbortController();
  // Observe the keeper before scheduling execution; its done promise resolves
  // for every stop/loss/error state and never rejects.
  const keeperSettled = keeper.done.then((event) => {
    if (event.status !== 'stopped') controller.abort(event.error);
    return { kind: 'keeper', event };
  });
  const executionSettled = Promise.resolve()
    .then(() => executeXTask(validatedTask, modelAdapter, { ...executionOptions, signal: controller.signal }))
    .then((value) => ({ kind: 'fulfilled', value }), (error) => ({ kind: 'rejected', error }));

  const done = (async () => {
    let outcome;
    try {
      const first = await Promise.race([executionSettled, keeperSettled]);
      const keeperStopped = keeper.state !== 'active' || controller.signal.aborted;
      if (first.kind === 'keeper' || keeperStopped) {
        controller.abort(first.kind === 'keeper' ? first.event.error : keeper.error);
        await executionSettled;
        outcome = {
          status: keeperFailure(keeper.state), run: null,
          error: keeper.error ? describeError(keeper.error) : null,
        };
      } else if (first.kind === 'rejected' && isCancellation(first.error)) {
        outcome = { status: 'cancelled', run: null, error: describeError(first.error) };
      } else if (first.kind === 'rejected') {
        const run = runStore.failRunFenced({
          runId: actualRunId, taskId, ownerId: claim.ownerId, leaseId: claim.leaseId,
          error: first.error?.message || String(first.error),
        });
        outcome = run
          ? { status: run.status, run, error: describeError(first.error) }
          : { status: 'fence_rejected', run: null, error: describeError(first.error) };
      } else {
        const { gateResult, xResult } = first.value;
        const run = runStore.completeRunFenced({
          runId: actualRunId, ownerId: claim.ownerId, leaseId: claim.leaseId, gateResult, xResult,
        });
        outcome = run
          ? { status: run.status, run, error: null }
          : { status: 'fence_rejected', run: null, error: null };
      }
    } catch (error) {
      // A terminal write can throw after its UPDATE (for example, during
      // retention/readback). Do not make a second terminal decision here.
      outcome = { status: 'persistence_error', run: null, error: describeError(error) };
    }
    const cleanup = await releaseOriginalClaim(keeper, claimStore, claim);
    return { runId: actualRunId, taskId, ...outcome, cleanup };
  })();

  return { accepted: true, runId: actualRunId, taskId, done };
}
