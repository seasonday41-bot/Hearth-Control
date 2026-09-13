import crypto from 'node:crypto';
import { validateXTask } from './task-contract.mjs';

/**
 * Serial dispatcher for X task execution ownership.
 *
 * Scheduling/ownership only. It never invokes a model, a LocalExecutor,
 * repository writes, arbitrary commands, or Supabase, and it never marks a
 * task completed -- that is Result Gate's job in a later phase. It owns:
 *
 *  - deciding whether execution capacity exists (`MAX_ACTIVE_TASKS = 1`,
 *    enforced authoritatively by the underlying `XClaimStore`, not by this
 *    class -- this class holds no claim state of its own)
 *  - picking the next runnable task deterministically
 *  - validating the x-task-v1 boundary before a task can be claimed, so a
 *    malformed packet is rejected explicitly (reported in `skipped`)
 *    rather than silently dispatched
 *  - renewing/releasing the lease it currently holds
 */
export class XDispatcher {
  /**
   * @param {{ claimStore: import('./claim-store.mjs').XClaimStore, ownerId?: string, leaseDurationMs?: number }} options
   */
  constructor({ claimStore, ownerId, leaseDurationMs } = {}) {
    if (!claimStore || typeof claimStore.claim !== 'function') {
      throw new TypeError('XDispatcher requires a claimStore.');
    }
    this.store = claimStore;
    this.ownerId = typeof ownerId === 'string' && ownerId.trim()
      ? ownerId.trim()
      : `dispatcher-${process.pid}-${crypto.randomUUID()}`;
    this.leaseDurationMs = leaseDurationMs;
  }

  /** Current global execution owner, if any (read-only). */
  getActiveClaim() {
    return this.store.getActiveClaim();
  }

  /**
   * Attempts to claim exactly one runnable task from `entries`, in
   * deterministic order. Each entry is `{ task, priority?, enqueuedAt? }`
   * where `task` is a raw (unvalidated) x-task-v1 packet. `priority` and
   * `enqueuedAt` are dispatcher-only scheduling metadata -- they are not
   * part of the x-task-v1 contract and are never written into it.
   *
   * Ordering: higher `priority` first (entries without a finite priority
   * sort as 0); ties broken by earliest `enqueuedAt`; remaining ties broken
   * by input array order (stable FIFO). The x-task-v1 contract has no
   * priority field, so with no priority supplied this is plain FIFO.
   *
   * Returns `{ claim, task, skipped }` where `claim`/`task` are `null` when
   * nothing could be claimed (no capacity, or every entry was invalid or
   * itself already claimed). `skipped` explains every entry that was not
   * dispatched, so rejection is explicit rather than silent.
   */
  claimNext(entries) {
    if (!Array.isArray(entries)) throw new TypeError('entries must be an array.');
    const ordered = orderEntries(entries);
    const skipped = [];
    for (const entry of ordered) {
      const validated = validateXTask(entry.task);
      if (!validated.ok) {
        skipped.push({ reason: 'invalid_task', errors: validated.errors, task: entry.task });
        continue;
      }
      const claim = this.store.claim({
        taskId: validated.value.task_id,
        ownerId: this.ownerId,
        leaseDurationMs: this.leaseDurationMs,
      });
      if (claim) return { claim, task: validated.value, skipped };
      skipped.push({ reason: 'no_capacity', taskId: validated.value.task_id });
    }
    return { claim: null, task: null, skipped };
  }

  /** Renews this dispatcher's own lease on `taskId`. Fails for a lease it does not own. */
  renew(taskId, leaseId) {
    return this.store.renew({ taskId, ownerId: this.ownerId, leaseId, leaseDurationMs: this.leaseDurationMs });
  }

  /** Releases this dispatcher's own lease on `taskId`. Does not mark the task completed. */
  release(taskId, leaseId) {
    return this.store.release({ taskId, ownerId: this.ownerId, leaseId });
  }
}

const enqueuedAtMs = (entry) => {
  if (Number.isFinite(entry?.enqueuedAt)) return entry.enqueuedAt;
  if (typeof entry?.enqueuedAt === 'string') {
    const parsed = Date.parse(entry.enqueuedAt);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
};

const orderEntries = (entries) => entries
  .map((entry, index) => ({ entry, index }))
  .sort((a, b) => {
    const priorityA = Number.isFinite(a.entry?.priority) ? a.entry.priority : 0;
    const priorityB = Number.isFinite(b.entry?.priority) ? b.entry.priority : 0;
    if (priorityA !== priorityB) return priorityB - priorityA;
    const timeA = enqueuedAtMs(a.entry);
    const timeB = enqueuedAtMs(b.entry);
    if (timeA !== timeB) return timeA - timeB;
    return a.index - b.index;
  })
  .map(({ entry }) => entry);
