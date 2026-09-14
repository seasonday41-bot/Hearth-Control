import { XClaimStore } from '../x/claim-store.mjs';
import { XLeaseKeeper } from '../x/lease-keeper.mjs';
import { resolveHearthRuntimeDatabasePath } from '../x/runtime-paths.mjs';

/**
 * Antigravity's side of the shared X/Antigravity global execution-admission
 * slot. Reuses the exact same `XClaimStore` primitive (and file) X's own
 * `runXTask` uses -- SQLite's `BEGIN IMMEDIATE` file-level locking remains
 * the sole cross-process authority (see claim-store.mjs). This module never
 * touches `x_task_claims` rows owned by an X task_id: every Antigravity
 * claim row is keyed under the `antigravity:` task-id namespace below, so an
 * Antigravity claim and an X claim are always two different rows -- global
 * capacity=1 is enforced entirely by `XClaimStore.claim()`'s own
 * cross-task-id `state = 'active' AND task_id != ?` check, unmodified.
 *
 * Unlike X's `runXTask`, an Antigravity task has no single function-scoped
 * `done` promise: its terminal state is set from many places across
 * mcp/executors/antigravity.mjs (spawn failure, stream errors, watchdog,
 * explicit stop, background-job failure, durable-job continuation, ...).
 * The already-authoritative predicate for "is this task still actively
 * running" is `isTaskActivelyRunning()` in that module; this module never
 * reimplements that logic -- it only ever calls a caller-supplied
 * `isActive` predicate.
 *
 * Normal release is triggered from two independent places, so correctness
 * never depends on catching every terminal-state call site in
 * antigravity.mjs:
 *  - a fast path: the caller re-checks `isActive` after any task
 *    transition it observes (antigravity.mjs wires this to
 *    `onTaskTransition`);
 *  - a bounded safety net: this module's own fixed-interval poll, which
 *    re-checks `isActive` independently of any output/event from the task
 *    and both renews (via `XLeaseKeeper`, unmodified, time-based) and
 *    releases. A stale claim is therefore always released within one poll
 *    interval of the task going inactive, even if a future code path in
 *    antigravity.mjs forgets to call `emitTaskTransition`.
 *
 * Ownership LOSS (the lease expired before we renewed it, and another
 * process's `claim()` reclaimed the slot) is different from normal release:
 * the task may still genuinely be executing, so simply forgetting the local
 * record would let it keep running without the shared claim -- exactly the
 * concurrent-execution outcome this whole feature exists to prevent. There
 * is no in-scope way to invent a new forced-termination mechanism (that
 * would be a second durable-job runtime), so ownership loss instead drives
 * the caller-supplied `onOwnershipLost(taskId)` hook, which antigravity.mjs
 * wires to its own existing, already-tested verified-stop lifecycle,
 * `stopAntigravityTask()`. If that existing hook itself cannot verify the
 * stop (it already has its own fencing and throws in that case), the
 * failure is logged -- there is no further existing safe fallback to reach
 * for without redesigning Antigravity, which is explicitly out of scope.
 *
 * If the process itself dies (crash, force-quit) no more polling or
 * renewal happens and the lease simply expires -- identical to X's own
 * crash-safety model, no special reconciliation invented here.
 */

const CLAIM_NAMESPACE = 'antigravity:';
const DEFAULT_LEASE_DURATION_MS = 30000;
const DEFAULT_POLL_INTERVAL_MS = 10000;

export const antigravityClaimTaskId = (taskId) => `${CLAIM_NAMESPACE}${taskId}`;

/** taskId -> { claim, keeper, claimStore, ownerId, taskId, released, poll } */
const admissions = new Map();

/**
 * Post-release notification plumbing ONLY. This never changes
 * admission/release semantics: it fires strictly after
 * `releaseAntigravityAdmission`'s own persisted `claimStore.release(...)`
 * call has already returned `true` -- never before, never on a `false`
 * result, never on a thrown release, never merely because a task reached
 * done/error. A listener's own failure is logged and otherwise ignored: it
 * cannot change the release result, retry anything, propagate back into
 * `releaseAntigravityAdmission`, mutate admission state, or route anywhere.
 */
const admissionReleasedListeners = new Set();

/**
 * Subscribes to the post-release notification. Fires once per successful
 * persisted release, after the shared claim is already gone.
 * @param {(event: { taskId: string }) => void} listener
 * @returns {() => void} unsubscribe function
 */
export function onAntigravityAdmissionReleased(listener) {
  if (typeof listener !== 'function') {
    throw new TypeError('listener must be a function.');
  }
  admissionReleasedListeners.add(listener);
  return () => {
    admissionReleasedListeners.delete(listener);
  };
}

function emitAntigravityAdmissionReleased(event) {
  for (const listener of admissionReleasedListeners) {
    try {
      listener(event);
    } catch (error) {
      console.error('[AntigravityAdmission] release listener failed:', error);
    }
  }
}

let productionClaimStore = null;

/**
 * Lazy, per-process singleton `XClaimStore` pointed at the same shared
 * hearth-runtime.sqlite file X uses -- for callers (Electron's main
 * process, mcp/goals/runner.mjs) that do not already hold an X runtime
 * singleton of their own. A process that already constructed one via
 * `getProductionXRuntime()` (mcp/tools.mjs) should pass that claimStore
 * instead of calling this, so the process holds one SQLite connection to
 * the file, not two.
 */
export function getProductionAntigravityClaimStore() {
  if (!productionClaimStore) {
    productionClaimStore = new XClaimStore({ storagePath: resolveHearthRuntimeDatabasePath() });
  }
  return productionClaimStore;
}

/** Test-only: forces the next getProductionAntigravityClaimStore() call to construct a fresh instance. */
export function __resetProductionAntigravityClaimStoreForTests() {
  productionClaimStore = null;
}

/**
 * Attempts to admit one Antigravity task into the single shared global
 * execution slot. `claimStore` is required to actually enforce admission --
 * a caller that omits it (as every existing Antigravity unit test does,
 * since they predate this feature and never touch the shared runtime
 * SQLite file) gets `{ ok: true, record: null }`, i.e. admission is a
 * no-op, matching this feature's pre-existing behavior exactly for every
 * caller that does not opt in.
 *
 * @param {{
 *   claimStore?: import('../x/claim-store.mjs').XClaimStore,
 *   taskId: string,
 *   ownerId: string,
 *   leaseDurationMs?: number,
 *   pollIntervalMs?: number,
 *   isActive: (taskId: string) => boolean,
 *   onOwnershipLost: (taskId: string) => (Promise<any> | any),
 * }} params
 * @returns {Promise<{ ok: boolean, record: object | null }>}
 */
export async function acquireAntigravityAdmission({
  claimStore, taskId, ownerId, leaseDurationMs = DEFAULT_LEASE_DURATION_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS, isActive, onOwnershipLost,
} = {}) {
  if (!claimStore) return { ok: true, record: null };
  if (!taskId || typeof taskId !== 'string') throw new TypeError('taskId is required to acquire Antigravity admission.');
  if (!ownerId || typeof ownerId !== 'string') throw new TypeError('ownerId is required to acquire Antigravity admission.');
  if (typeof isActive !== 'function') throw new TypeError('isActive predicate is required to acquire Antigravity admission.');
  if (typeof onOwnershipLost !== 'function') throw new TypeError('onOwnershipLost hook is required to acquire Antigravity admission.');
  if (admissions.has(taskId)) return { ok: false, record: null };

  const claim = claimStore.claim({ taskId: antigravityClaimTaskId(taskId), ownerId, leaseDurationMs });
  if (claim === null) return { ok: false, record: null };

  const keeper = new XLeaseKeeper({ claimStore, claim });
  keeper.start();

  const record = { claim, keeper, claimStore, ownerId, taskId, released: false, poll: null };
  admissions.set(taskId, record);

  const tick = () => {
    if (record.released) return;
    if (!isActive(taskId)) void releaseAntigravityAdmission(taskId);
  };
  record.poll = setInterval(tick, pollIntervalMs);
  record.poll.unref?.();

  // The keeper only ever finishes on its own for 'ownership_lost' or
  // 'error' (a caller-initiated stop always calls releaseAntigravityAdmission
  // first, which sets `record.released` and calls `keeper.stop()` itself --
  // that resolves `keeper.done` with 'stopped', which is a no-op below).
  void keeper.done.then((event) => {
    if (record.released) return;
    record.released = true;
    if (record.poll) clearInterval(record.poll);
    admissions.delete(taskId);
    if (event.status === 'stopped') return;
    void Promise.resolve().then(() => onOwnershipLost(taskId)).catch((err) => {
      console.error(`[Antigravity] Ownership-loss stop failed for task ${taskId} (event=${event.status}):`, err?.message || err);
    });
  });

  return { ok: true, record };
}

/**
 * Releases the exact claim originally acquired for `taskId`, if this
 * process still holds an admission record for it. Idempotent no-op when
 * nothing (or an already-released record) is held -- mirrors
 * `XClaimStore.release()`'s own idempotency. This is the normal-completion
 * path only; it must never be the only reaction to ownership loss (see the
 * module docstring) -- that is handled by `onOwnershipLost` above instead.
 * @param {string} taskId
 * @returns {Promise<boolean>}
 */
export async function releaseAntigravityAdmission(taskId) {
  const record = admissions.get(taskId);
  if (!record || record.released) return true;
  record.released = true;
  admissions.delete(taskId);
  if (record.poll) clearInterval(record.poll);
  try {
    await record.keeper.stop();
  } catch {
    // keeper failure does not prevent releasing the claim below
  }
  try {
    const released = record.claimStore.release({
      taskId: antigravityClaimTaskId(taskId), ownerId: record.ownerId, leaseId: record.claim.leaseId,
    });
    if (released) {
      emitAntigravityAdmissionReleased({ taskId });
    }
    return released;
  } catch {
    return false;
  }
}

/** Whether this process currently holds a live admission record for `taskId`. */
export function hasAntigravityAdmission(taskId) {
  return admissions.has(taskId);
}

/** Test-only: clears all in-memory admission bookkeeping without releasing claims. */
export function __resetAntigravityAdmissionsForTests() {
  for (const record of admissions.values()) {
    if (record.poll) clearInterval(record.poll);
  }
  admissions.clear();
}
