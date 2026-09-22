const describeError = (error) => ({
  code: typeof error?.code === 'string' ? error.code : 'CANCEL_ERROR',
  message: error?.message || String(error),
});

const notCancelled = (status, extra = {}) => ({
  cancelled: false,
  clean: false,
  status,
  run: null,
  cleanup: null,
  ...extra,
});

const validateInputs = ({ runId, xCoderRunId, taskId, claim, claimStore, runStore, keeper, xCoderClient, maxPersistAttempts }) => {
  if (typeof runId !== 'string' || !runId.trim()) throw new TypeError('runId is required.');
  if (typeof taskId !== 'string' || !taskId.trim()) throw new TypeError('taskId is required.');
  if (xCoderRunId !== undefined && (typeof xCoderRunId !== 'string' || !xCoderRunId.trim())) {
    throw new TypeError('xCoderRunId must be a non-empty string when provided.');
  }
  if (!claim || claim.taskId !== taskId || typeof claim.ownerId !== 'string' || !claim.ownerId ||
      typeof claim.leaseId !== 'string' || !claim.leaseId) {
    throw new TypeError('cancelXTask requires the original claim identity for this task.');
  }
  if (typeof claimStore?.isOwner !== 'function' || typeof claimStore?.release !== 'function') {
    throw new TypeError('cancelXTask requires claimStore.isOwner() and release().');
  }
  if (typeof runStore?.cancelRunFenced !== 'function') {
    throw new TypeError('cancelXTask requires runStore.cancelRunFenced().');
  }
  if (typeof keeper?.stop !== 'function') throw new TypeError('cancelXTask requires the active lease keeper.');
  if (typeof xCoderClient?.cancel !== 'function') throw new TypeError('cancelXTask requires xCoderClient.cancel().');
  if (!Number.isInteger(maxPersistAttempts) || maxPersistAttempts < 1 || maxPersistAttempts > 10) {
    throw new TypeError('maxPersistAttempts must be an integer between 1 and 10.');
  }
};

const ownerStillLive = (claimStore, claim) =>
  claimStore.isOwner(claim.taskId, claim.ownerId, claim.leaseId);

/**
 * Explicit X cancellation ordering:
 *   X terminal cancelled ack
 *   -> fenced Hearth cancellation persistence
 *   -> keeper stop
 *   -> original claim release
 *
 * No failure path stops renewal or releases the claim. That is deliberate:
 * lease-loss and persistence-fault paths stay eligible for the existing
 * expiry/reconciliation semantics instead of manufacturing a clean cancel.
 */
export async function cancelXTask({
  runId,
  xCoderRunId = runId,
  taskId,
  claim,
  claimStore,
  runStore,
  keeper,
  xCoderClient,
  maxPersistAttempts = 3,
  logger = console,
} = {}) {
  validateInputs({ runId, xCoderRunId, taskId, claim, claimStore, runStore, keeper, xCoderClient, maxPersistAttempts });
  const serviceRunId = xCoderRunId ?? runId;

  let ack;
  try {
    ack = await xCoderClient.cancel(serviceRunId);
  } catch (error) {
    return notCancelled('x_cancel_error', { error: describeError(error) });
  }

  if (!ack || ack.runId !== serviceRunId || ack.acknowledged !== true || ack.status !== 'cancelled') {
    return notCancelled('x_cancel_not_acknowledged', { xAck: ack ?? null });
  }

  let persistedRun = null;
  let lastPersistenceError = null;
  let persistAttempts = 0;

  for (let attempt = 1; attempt <= maxPersistAttempts; attempt += 1) {
    persistAttempts = attempt;
    // The first persistence attempt follows the X ack immediately. Every
    // retry is preceded by a fresh ownership check, so a stale owner never
    // keeps hammering the database after lease loss.
    if (attempt > 1 && !ownerStillLive(claimStore, claim)) {
      return notCancelled('lease_lost', {
        xAck: ack,
        persistAttempts: attempt - 1,
        reconciliationRequired: true,
        error: lastPersistenceError ? describeError(lastPersistenceError) : null,
      });
    }

    try {
      persistedRun = runStore.cancelRunFenced({
        runId,
        taskId,
        ownerId: claim.ownerId,
        leaseId: claim.leaseId,
      });
      lastPersistenceError = null;
    } catch (error) {
      persistedRun = null;
      lastPersistenceError = error;
    }

    if (persistedRun?.status === 'cancelled') break;
    persistedRun = null;

    // Required post-failure diagnosis before any retry.
    if (!ownerStillLive(claimStore, claim)) {
      return notCancelled('lease_lost', {
        xAck: ack,
        persistAttempts: attempt,
        reconciliationRequired: true,
        error: lastPersistenceError ? describeError(lastPersistenceError) : null,
      });
    }
  }

  if (!persistedRun) {
    const operationalError = lastPersistenceError ?? new Error(
      `cancelRunFenced did not persist after ${maxPersistAttempts} attempts while the lease remained live.`,
    );
    try {
      logger?.error?.('[X cancel] terminal X ack could not be persisted while lease remained live', {
        runId,
        taskId,
        attempts: maxPersistAttempts,
        error: describeError(operationalError),
      });
    } catch {
      // Logging must never alter cancellation semantics.
    }
    return notCancelled('persistence_fault', {
      xAck: ack,
      persistAttempts: maxPersistAttempts,
      operationalError: describeError(operationalError),
      reconciliationRequired: true,
    });
  }

  // Success is now durable. Cleanup is intentionally after persistence.
  const cleanup = {
    keeperStatus: null,
    released: null,
    error: null,
  };
  try {
    cleanup.keeperStatus = (await keeper.stop())?.status ?? null;
  } catch (error) {
    cleanup.error = describeError(error);
  }
  try {
    cleanup.released = claimStore.release({
      taskId: claim.taskId,
      ownerId: claim.ownerId,
      leaseId: claim.leaseId,
    });
  } catch (error) {
    cleanup.error = describeError(error);
  }

  return {
    cancelled: true,
    clean: cleanup.keeperStatus === 'stopped' && cleanup.released === true && cleanup.error === null,
    status: 'cancelled',
    xCoderRunId: serviceRunId,
    run: persistedRun,
    xAck: ack,
    persistAttempts,
    cleanup,
  };
}
