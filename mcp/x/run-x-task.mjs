import crypto from 'node:crypto';
import { parseXTask } from './task-contract.mjs';
import { XLeaseKeeper } from './lease-keeper.mjs';
import { evaluateResultGate } from './result-gate.mjs';
import { buildXResult } from './result-builder.mjs';
import { cancelXTask } from './cancel-x-task.mjs';

import { isWorkspaceLocked } from '../specialist/workspace-lock.mjs';

const X_CODER_ACTIVE_STATUSES = new Set(['submitted', 'running']);
const X_CODER_TERMINAL_STATUSES = new Set(['completed', 'failed', 'interrupted', 'cancelled']);
const DEFAULT_X_CODER_POLL_INTERVAL_MS = 100;

const describeError = (error) => ({
  code: typeof error?.code === 'string' ? error.code : 'ORCHESTRATION_ERROR',
  message: error?.message || String(error),
});

const keeperFailure = (status) => status === 'ownership_lost' ? 'ownership_lost' : 'ownership_uncertain';

const workerTerminal = (value) =>
  Boolean(value && typeof value.runId === 'string' && X_CODER_TERMINAL_STATUSES.has(value.status));

const requireXCoderClient = (client) => {
  if (!client || typeof client.submit !== 'function' || typeof client.getStatus !== 'function' ||
      typeof client.leaseValid !== 'function' || typeof client.cancel !== 'function') {
    throw new TypeError('runXTask requires an XCoderClient with submit/getStatus/leaseValid/cancel.');
  }
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pollXCoder(client, runId, intervalMs) {
  for (;;) {
    const status = await client.getStatus(runId);
    if (!status || status.runId !== runId) {
      const error = new Error('X Coder status response did not match the submitted run.');
      error.code = 'X_CODER_STATUS_MISMATCH';
      throw error;
    }
    if (X_CODER_TERMINAL_STATUSES.has(status.status)) return status;
    if (!X_CODER_ACTIVE_STATUSES.has(status.status)) {
      const error = new Error(`Unrecognized X Coder status '${status.status}'.`);
      error.code = 'X_CODER_STATUS_INVALID';
      throw error;
    }
    await wait(intervalMs);
  }
}

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

async function stopKeeperWithoutRelease(keeper) {
  const cleanup = { keeperStatus: null, released: null, error: null };
  if (!keeper) return cleanup;
  try {
    cleanup.keeperStatus = (await keeper.stop()).status;
  } catch (error) {
    cleanup.error = describeError(error);
  }
  return cleanup;
}

async function bestEffortStopWorker(xCoderClient, xCoderRunId) {
  try {
    const result = await xCoderClient.cancel(xCoderRunId);
    return workerTerminal(result) ? result : null;
  } catch {
    return null;
  }
}

const makeAmbiguousSubmitError = (runId, error) => {
  const wrapped = new Error(
    `X Coder submission is uncertain for Hearth run '${runId}': ${error?.message || String(error)}`,
  );
  wrapped.code = 'X_CODER_SUBMIT_UNCERTAIN';
  wrapped.runId = runId;
  wrapped.cause = error;
  return wrapped;
};

const cancellationOutcome = (actualRunId, taskId, xCoderRunId, result) => {
  if (result?.cancelled === true && result.run?.status === 'cancelled') {
    return {
      runId: actualRunId,
      taskId,
      xCoderRunId,
      status: 'cancelled',
      run: result.run,
      error: null,
      cleanup: result.cleanup,
      reconciliationRequired: false,
    };
  }
  return {
    runId: actualRunId,
    taskId,
    xCoderRunId,
    status: result?.status || 'cancel_uncertain',
    run: null,
    error: result?.operationalError ?? result?.error ?? null,
    cleanup: null,
    reconciliationRequired: true,
  };
};

/**
 * Admit one validated X task and return its durable Hearth run ID without
 * waiting for execution.
 *
 * Slice 8 execution authority lives in the standalone X Coder Service. Hearth
 * keeps claim/lease ownership and terminal XRunStore persistence. The service
 * returns a RepairOutcome only; the existing deterministic Result Gate and
 * x-result-v1 builder remain in this process unchanged.
 *
 * The second positional argument is intentionally retained until Slice 9 for
 * API compatibility with older callers, but it is no longer execution
 * authority and is never used to run the task in-process.
 */
export async function runXTask(task, _legacyModelAdapter, options = {}) {
  const {
    claimStore,
    runStore,
    xCoderClient: injectedXCoderClient,
    ownerId,
    leaseDurationMs,
    runId,
    jobManager,
    goalStorage,
    xCoderPollIntervalMs = DEFAULT_X_CODER_POLL_INTERVAL_MS,
  } = options;

  const xCoderClient = injectedXCoderClient ?? _legacyModelAdapter?.xCoderClient;
  const validatedTask = parseXTask(task);
  if (typeof ownerId !== 'string' || !ownerId.trim()) throw new TypeError('ownerId is required.');
  if (!Number.isInteger(xCoderPollIntervalMs) || xCoderPollIntervalMs < 1 || xCoderPollIntervalMs > 5000) {
    throw new TypeError('xCoderPollIntervalMs must be an integer between 1 and 5000.');
  }
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
  if (runId !== undefined && (typeof runId !== 'string' || !runId.trim())) {
    throw new TypeError('runId must be a non-empty string.');
  }

  const wsPath = validatedTask.workspace?.root || validatedTask.workspace_root || validatedTask.workspace;
  if (wsPath) {
    const lockCheck = isWorkspaceLocked(wsPath, {
      jobManager,
      claimStore,
      runStore,
      goalStorage,
    });
    if (lockCheck.locked) {
      return {
        accepted: false,
        reason: 'workspace_locked',
        runId: null,
        error: describeError(new Error(lockCheck.reason)),
      };
    }
  }

  requireXCoderClient(xCoderClient);

  const taskId = validatedTask.task_id;
  let claim;
  try {
    claim = claimStore.claim({ taskId, ownerId, leaseDurationMs });
  } catch (error) {
    return { accepted: false, reason: 'setup_failed', runId: null, error: describeError(error) };
  }
  if (claim === null) return { accepted: false, reason: 'no_capacity', runId: null };

  const actualRunId = runId ?? crypto.randomUUID();

  // Local durable setup happens before any cross-process execution starts.
  try {
    runStore.createRun({ runId: actualRunId, taskId, claimLeaseId: claim.leaseId });
    if (!runStore.markRunning({ runId: actualRunId, claimLeaseId: claim.leaseId })) {
      throw new Error('X run could not transition from queued to running.');
    }
  } catch (error) {
    let persistedRun = null;
    try { persistedRun = runStore.getRun(actualRunId); } catch { /* leave for reconciliation */ }
    const ours = persistedRun?.taskId === taskId && persistedRun.claimLeaseId === claim.leaseId;
    if (ours && ['queued', 'running'].includes(persistedRun.status)) {
      try {
        persistedRun = runStore.failRunFenced({
          runId: actualRunId,
          taskId,
          ownerId: claim.ownerId,
          leaseId: claim.leaseId,
          error: error?.message || 'X run setup failed.',
        }) ?? persistedRun;
      } catch { /* an uncertain local write remains reconcilable */ }
    }
    const cleanup = await releaseOriginalClaim(null, claimStore, claim);
    return {
      accepted: false,
      reason: 'setup_failed',
      runId: ours ? actualRunId : null,
      error: describeError(error),
      run: ours ? persistedRun : null,
      cleanup,
    };
  }

  // Cross-process submission is intentionally separated from local setup. If
  // the response is lost we cannot know whether the service started. Never
  // release the claim in that ambiguous window: the initial service watchdog
  // and this unrenewed claim share the same expiry, preventing a stale writer
  // from overlapping a new owner.
  let xCoderRunId;
  try {
    const submitted = await xCoderClient.submit({
      idempotencyKey: actualRunId,
      task: validatedTask,
      leaseExpiresAt: claim.leaseExpiresAt,
    });
    if (!submitted || typeof submitted.runId !== 'string' || !submitted.runId) {
      throw new Error('X Coder submit returned no run id.');
    }
    xCoderRunId = submitted.runId;
  } catch (error) {
    throw makeAmbiguousSubmitError(actualRunId, error);
  }

  let keeper;
  try {
    keeper = new XLeaseKeeper({
      claimStore,
      claim,
      onRenewed: async (renewed) => {
        const heartbeat = await xCoderClient.leaseValid(xCoderRunId, renewed.leaseExpiresAt);
        if (!heartbeat || heartbeat.runId !== xCoderRunId) {
          throw new Error('X Coder lease heartbeat did not match the submitted run.');
        }
        if (X_CODER_TERMINAL_STATUSES.has(heartbeat.status)) return;
        if (!X_CODER_ACTIVE_STATUSES.has(heartbeat.status)) {
          throw new Error(`X Coder lease heartbeat returned invalid status '${heartbeat.status}'.`);
        }
        const covered = heartbeat.accepted === true ||
          (Number.isInteger(heartbeat.leaseExpiresAt) && heartbeat.leaseExpiresAt >= renewed.leaseExpiresAt);
        if (!covered) throw new Error('X Coder rejected the renewed lease deadline.');
      },
    });
    keeper.start();
  } catch (error) {
    const worker = await bestEffortStopWorker(xCoderClient, xCoderRunId);
    if (worker) {
      let persistedRun = null;
      try { persistedRun = runStore.getRun(actualRunId); } catch { /* leave null */ }
      try {
        persistedRun = runStore.failRunFenced({
          runId: actualRunId,
          taskId,
          ownerId: claim.ownerId,
          leaseId: claim.leaseId,
          error: error?.message || 'X lease keeper setup failed.',
        }) ?? persistedRun;
      } catch { /* persistence uncertainty is reported below */ }
      const cleanup = await releaseOriginalClaim(keeper, claimStore, claim);
      return {
        accepted: false,
        reason: 'setup_failed',
        runId: actualRunId,
        xCoderRunId,
        error: describeError(error),
        run: persistedRun,
        cleanup,
      };
    }
    const wrapped = makeAmbiguousSubmitError(actualRunId, error);
    wrapped.code = 'X_CODER_KEEPER_UNCERTAIN';
    throw wrapped;
  }

  let explicitCancelPromise = null;
  const cancel = () => {
    if (!explicitCancelPromise) {
      explicitCancelPromise = cancelXTask({
        runId: actualRunId,
        xCoderRunId,
        taskId,
        claim,
        claimStore,
        runStore,
        keeper,
        xCoderClient,
      });
    }
    return explicitCancelPromise;
  };

  // Observe keeper liveness and service execution independently. A keeper
  // failure never releases the claim in this cross-process architecture:
  // best-effort worker cancel is attempted, then lease expiry/reconciliation
  // is the safety backstop if transport is unavailable.
  const keeperSettled = keeper.done.then((event) => ({ kind: 'keeper', event }));
  const executionSettled = pollXCoder(xCoderClient, xCoderRunId, xCoderPollIntervalMs)
    .then((value) => ({ kind: 'service', value }), (error) => ({ kind: 'service_error', error }));

  const done = (async () => {
    let serviceTerminalConfirmed = false;
    try {
      const first = await Promise.race([executionSettled, keeperSettled]);

      if (first.kind === 'keeper') {
        if (first.event.status === 'stopped' && explicitCancelPromise) {
          return cancellationOutcome(actualRunId, taskId, xCoderRunId, await explicitCancelPromise);
        }
        await bestEffortStopWorker(xCoderClient, xCoderRunId);
        return {
          runId: actualRunId,
          taskId,
          xCoderRunId,
          status: keeperFailure(first.event.status),
          run: null,
          error: first.event.error ? describeError(first.event.error) : null,
          cleanup: {
            keeperStatus: first.event.status,
            released: null,
            error: null,
          },
          reconciliationRequired: true,
        };
      }

      if (first.kind === 'service_error') {
        await bestEffortStopWorker(xCoderClient, xCoderRunId);
        const cleanup = await stopKeeperWithoutRelease(keeper);
        return {
          runId: actualRunId,
          taskId,
          xCoderRunId,
          status: 'service_uncertain',
          run: null,
          error: describeError(first.error),
          cleanup,
          reconciliationRequired: true,
        };
      }

      const service = first.value;
      serviceTerminalConfirmed = X_CODER_TERMINAL_STATUSES.has(service.status);

      if (service.status === 'cancelled') {
        if (explicitCancelPromise) {
          return cancellationOutcome(actualRunId, taskId, xCoderRunId, await explicitCancelPromise);
        }
        const cleanup = await stopKeeperWithoutRelease(keeper);
        return {
          runId: actualRunId,
          taskId,
          xCoderRunId,
          status: 'cancelled',
          run: null,
          error: null,
          cleanup,
          reconciliationRequired: true,
        };
      }

      if (service.status === 'interrupted') {
        const cleanup = await stopKeeperWithoutRelease(keeper);
        return {
          runId: actualRunId,
          taskId,
          xCoderRunId,
          status: 'interrupted',
          run: null,
          error: service.error ? describeError(new Error(service.error)) : null,
          cleanup,
          reconciliationRequired: true,
        };
      }

      let outcome;
      if (service.status === 'failed') {
        const executionError = new Error(service.error || 'X Coder Service execution failed.');
        executionError.code = 'X_CODER_EXECUTION_FAILED';
        const run = runStore.failRunFenced({
          runId: actualRunId,
          taskId,
          ownerId: claim.ownerId,
          leaseId: claim.leaseId,
          error: executionError.message,
        });
        outcome = run
          ? { status: run.status, run, error: describeError(executionError) }
          : { status: 'fence_rejected', run: null, error: describeError(executionError) };
      } else if (service.status === 'completed') {
        let gateResult;
        let xResult;
        try {
          gateResult = evaluateResultGate(service.result);
          xResult = buildXResult(validatedTask, service.result, gateResult);
        } catch (error) {
          const run = runStore.failRunFenced({
            runId: actualRunId,
            taskId,
            ownerId: claim.ownerId,
            leaseId: claim.leaseId,
            error: error?.message || 'X Coder returned an invalid RepairOutcome.',
          });
          outcome = run
            ? { status: run.status, run, error: describeError(error) }
            : { status: 'fence_rejected', run: null, error: describeError(error) };
        }
        if (!outcome) {
          const run = runStore.completeRunFenced({
            runId: actualRunId,
            ownerId: claim.ownerId,
            leaseId: claim.leaseId,
            gateResult,
            xResult,
          });
          outcome = run
            ? { status: run.status, run, error: null }
            : { status: 'fence_rejected', run: null, error: null };
        }
      } else {
        const error = new Error(`Unexpected terminal X Coder status '${service.status}'.`);
        error.code = 'X_CODER_STATUS_INVALID';
        throw error;
      }

      const cleanup = await releaseOriginalClaim(keeper, claimStore, claim);
      return {
        runId: actualRunId,
        taskId,
        xCoderRunId,
        ...outcome,
        cleanup,
        reconciliationRequired: false,
      };
    } catch (error) {
      if (serviceTerminalConfirmed) {
        const cleanup = await releaseOriginalClaim(keeper, claimStore, claim);
        return {
          runId: actualRunId,
          taskId,
          xCoderRunId,
          status: 'persistence_error',
          run: null,
          error: describeError(error),
          cleanup,
          reconciliationRequired: false,
        };
      }
      await bestEffortStopWorker(xCoderClient, xCoderRunId);
      const cleanup = await stopKeeperWithoutRelease(keeper);
      return {
        runId: actualRunId,
        taskId,
        xCoderRunId,
        status: 'service_uncertain',
        run: null,
        error: describeError(error),
        cleanup,
        reconciliationRequired: true,
      };
    }
  })();

  return {
    accepted: true,
    runId: actualRunId,
    xCoderRunId,
    taskId,
    cancel,
    done,
  };
}
