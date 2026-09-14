import { runXTask } from './run-x-task.mjs';

// Live x_run_terminal transport contract (Phase A) -- unchanged. This is the
// ONLY set deriveTerminalEvent may use: broadening it would silently change
// what the live x_run_terminal IPC/notification event reports.
const EVENT_TERMINAL_STATUSES = new Set(['completed', 'needs_review', 'failed']);

// Persisted XRunStore truth recognized by onXRunTerminal's own re-read --
// distinct from EVENT_TERMINAL_STATUSES above. Includes 'interrupted'
// (XRunStore's own startup-reconciliation outcome for a dead/stale claim,
// see run-store.mjs's reconcileStartupState) so a queue entry whose run was
// reconciled to 'interrupted' before this coordinator ever observes it is
// still recognized as terminal, not stranded in `dispatched` forever.
const PERSISTED_TERMINAL_STATUSES = new Set(['completed', 'needs_review', 'failed', 'interrupted']);
const REVIEW_STATUSES = new Set(['needs_review', 'failed', 'interrupted']);

/**
 * Derives the same `x_run_terminal` event shape mcp/tools.mjs's
 * `emitXRunTerminalEvent` derives from a runXTask outcome -- duplicated
 * intentionally rather than sharing code across module/process boundaries;
 * both are kept in sync by their own focused test suites
 * (scripts/test-x-terminal-event.mjs for mcp/tools.mjs,
 * scripts/test-x-queue-coordinator.mjs for this module). Only `runId` from
 * this event is ever trusted by `onXRunTerminal` below -- see its own
 * doc comment. Deliberately uses ONLY EVENT_TERMINAL_STATUSES, never
 * PERSISTED_TERMINAL_STATUSES -- the live transport contract must not be
 * broadened just because startup reconciliation recognizes 'interrupted'.
 * @param {{ run: object|null } | null} outcome
 */
function deriveTerminalEvent(outcome) {
  const run = outcome?.run;
  if (!run || !EVENT_TERMINAL_STATUSES.has(run.status)) return null;
  return {
    type: 'x_run_terminal',
    runId: run.runId, taskId: run.taskId, status: run.status,
    gateStatus: run.gateStatus, hearthOutcome: run.hearthOutcome,
    result: run.result, error: run.error,
  };
}

/**
 * Deterministic runtime queue coordinator for already-authored X tasks.
 *
 * This is NOT the planner/supervisor -- Chat (ChatGPT/Sol) remains sole
 * author of every task's objective, scope, and content. This coordinator
 * only ever dispatches a task it was explicitly handed via `enqueue()`; it
 * never invents, rewrites, or interprets one, never decides how to repair a
 * failure, and never routes anywhere near Codex or Claude. Nothing in this
 * module references either.
 *
 * Authority boundaries (locked):
 *  - XRunStore/XClaimStore (passed in, never written to by this file except
 *    via runXTask's own already-fenced calls) remain the sole authority for
 *    X execution and terminal x-result-v1 truth.
 *  - `x_run_terminal` (whether it arrives via this coordinator's own
 *    dispatch or a relayed/replayed Electron message) is notification
 *    only: `onXRunTerminal` uses an incoming event's `runId` purely to know
 *    which run to look up, then re-reads `runStore.getRun(runId)` and bases
 *    every decision on that persisted row -- never on the event's own
 *    `status`/`taskId` fields, which a stale or forged event could
 *    misreport.
 *  - The injected `queueStore` (XQueueStore) is authoritative only for
 *    which already-authored tasks are waiting to be dispatched, and for
 *    whether a terminal run still needs review -- never for execution
 *    truth itself.
 *
 * Phase B1 is deliberately globally serial and deliberately does NOT poll,
 * retry on a timer, or attempt any reconciliation of an ambiguous
 * (crashed-mid-dispatch) `dispatching` entry, or of a terminal event for a
 * run it isn't tracking as dispatched -- all of that is Phase B2, which
 * requires cross-referencing XRunStore in ways this module does not
 * attempt (no `listRuns`, no missed-event recovery).
 */
export class XQueueCoordinator {
  /**
   * @param {{
   *   queueStore: import('./queue-store.mjs').XQueueStore,
   *   claimStore: import('./claim-store.mjs').XClaimStore,
   *   runStore: import('./run-store.mjs').XRunStore,
   *   modelAdapter: object,
   *   ownerId: string,
   *   leaseDurationMs?: number,
   * }} deps
   */
  constructor({ queueStore, claimStore, runStore, modelAdapter, ownerId, leaseDurationMs } = {}) {
    if (!queueStore) throw new TypeError('queueStore is required for XQueueCoordinator.');
    if (!claimStore) throw new TypeError('claimStore is required for XQueueCoordinator.');
    if (!runStore) throw new TypeError('runStore is required for XQueueCoordinator.');
    if (!modelAdapter) throw new TypeError('modelAdapter is required for XQueueCoordinator.');
    if (!ownerId || typeof ownerId !== 'string') throw new TypeError('ownerId is required for XQueueCoordinator.');
    this.queueStore = queueStore;
    this.claimStore = claimStore;
    this.runStore = runStore;
    this.modelAdapter = modelAdapter;
    this.ownerId = ownerId;
    this.leaseDurationMs = leaseDurationMs;
    this._dispatching = false;
    /** Last ambiguous (thrown) dispatch attempt, for observability only -- never acted on automatically. */
    this.lastDispatchError = null;
  }

  /**
   * Accepts one already-authored x-task-v1 payload into the pending queue.
   * Never inspects, edits, or authors its content beyond what XQueueStore
   * itself validates (a non-empty `task_id`).
   * @param {object} task a complete x-task-v1 payload
   */
  enqueue(task) {
    const entry = this.queueStore.enqueue(task);
    this._scheduleDispatch();
    return entry;
  }

  /**
   * The one sanctioned way to re-trigger a dispatch attempt after a
   * definite no_capacity/returnToPending stall (Phase B1 has no internal
   * retry timer or polling). Creates no task, retries no ambiguous
   * `dispatching` entry, and mutates no persisted state by itself --
   * behaviorally identical to letting the normal dispatch triggers
   * (enqueue, a terminal event) run again right now. Electron integration
   * calls this when something with actual knowledge of a capacity change
   * (e.g. Antigravity's own terminal/inactive transition) indicates the
   * shared slot may have become free -- not part of this module.
   */
  kick() {
    this._scheduleDispatch();
  }

  /** Fire-and-forget scheduling helper: never leaves a dangling rejected promise, and its catch handler only logs -- it never rewrites queue state, never retries ambiguous dispatching work, never touches XRunStore, and never routes anywhere. */
  _scheduleDispatch() {
    void this.dispatchNext().catch((error) => {
      console.error('[XQueueCoordinator] dispatchNext failed:', error);
    });
  }

  /**
   * Attempts to dispatch the single next pending queued task, if any and if
   * nothing else is already dispatching/dispatched. Never drops a task: a
   * definite non-admission returns it to pending; an ambiguous (thrown)
   * dispatch attempt leaves it in `dispatching`, untouched, for Phase B2.
   */
  async dispatchNext() {
    if (this._dispatching) return { dispatched: false, reason: 'already_dispatching' };
    this._dispatching = true;
    try {
      // B1 is globally serial at the coordinator's own bookkeeping level,
      // not merely inferred from XClaimStore/no_capacity: a persisted
      // `dispatching` (ambiguous crash window) or `dispatched` (tracked
      // in-flight run) entry both block any further dispatch, including
      // across a restart, until Phase B2 resolves them.
      if (this.queueStore.listDispatching().length > 0 || this.queueStore.listDispatched().length > 0) {
        return { dispatched: false, reason: 'inflight_or_ambiguous' };
      }

      const entry = this.queueStore.nextPending();
      if (!entry) return { dispatched: false, reason: 'queue_empty' };

      this.queueStore.markDispatching(entry.id);

      let admitted;
      try {
        admitted = await runXTask(entry.task, this.modelAdapter, {
          claimStore: this.claimStore, runStore: this.runStore, ownerId: this.ownerId,
          leaseDurationMs: this.leaseDurationMs,
        });
      } catch (error) {
        // Ambiguous: runXTask may have claimed/persisted something before
        // throwing. Never guess -- leave the entry exactly as `dispatching`
        // for Phase B2 reconciliation, and never route this failure
        // anywhere (no Codex/Claude, no retry).
        this.lastDispatchError = { entryId: entry.id, error, at: new Date().toISOString() };
        return { dispatched: false, reason: 'ambiguous_throw', entryId: entry.id, error };
      }

      if (!admitted.accepted) {
        // A definite non-admission (no_capacity, or any other explicit
        // denial) -- the task is not dropped, only returned to pending.
        this.queueStore.returnToPending(entry.id);
        return { dispatched: false, reason: admitted.reason || 'not_accepted' };
      }

      this.queueStore.markDispatched(entry.id, admitted.runId);

      // Observe this dispatch's own completion directly (same-process,
      // in-memory promise) -- fire-and-forget, mirroring
      // mcp/tools.mjs's observeBackgroundCompletion. `done` itself is
      // documented to always resolve, never reject; the separate .catch
      // below exists for the fulfillment handler's OWN bookkeeping throwing
      // (e.g. a store write failing), not for `done` rejecting.
      void admitted.done
        .then((outcome) => {
          const event = deriveTerminalEvent(outcome);
          if (event) this.onXRunTerminal(event);
        })
        .catch((error) => {
          console.error('[XQueueCoordinator] terminal observation failed:', error);
        });

      return { dispatched: true, runId: admitted.runId, entryId: entry.id };
    } finally {
      this._dispatching = false;
    }
  }

  /**
   * Reacts to a persisted-terminal X run. `event` is used ONLY to learn
   * `runId` -- every decision below is then based on re-reading
   * `runStore.getRun(runId)`, never on `event.status`/`event.taskId`,
   * which this method never even inspects past validating `runId` itself.
   * This is what keeps `x_run_terminal` strictly notification-only: a
   * stale or forged event can at worst point at the wrong (or a real)
   * runId; it can never fabricate a status or taskId XRunStore doesn't
   * actually have.
   *
   * Phase B1 handles ONLY runs this coordinator is itself tracking as
   * `dispatched` (`queueStore.findDispatchedByRunId`) AND whose queue-
   * tracked `taskId` agrees with the persisted run's `taskId` -- anything
   * else (untracked, already reacted to, or a task-identity mismatch) is a
   * no-op, with no queue mutation, no review record, and no dispatch-next.
   *
   * Idempotent on `runId`: once an entry has been pruned by a first
   * reaction, a duplicate/replayed event for the same runId finds nothing
   * tracked and is a pure no-op.
   */
  onXRunTerminal(event) {
    if (!event || typeof event.runId !== 'string' || !event.runId) {
      return { handled: false, reason: 'invalid_event' };
    }

    const run = this.runStore.getRun(event.runId);
    if (!run) {
      return { handled: false, reason: 'run_not_found' };
    }
    if (!PERSISTED_TERMINAL_STATUSES.has(run.status)) {
      return { handled: false, reason: 'persisted_not_terminal' };
    }

    const entry = this.queueStore.findDispatchedByRunId(run.runId);
    if (!entry) {
      return { handled: false, reason: 'not_tracked' };
    }
    if (entry.taskId !== run.taskId) {
      // The queue's own bookkeeping disagrees with persisted truth about
      // which task this runId belongs to -- do not guess which is right.
      return { handled: false, reason: 'task_mismatch' };
    }

    if (REVIEW_STATUSES.has(run.status)) {
      // Crash-safe ordering: record the (idempotent, runId-keyed) review
      // BEFORE pruning the queue entry. If the process dies between the
      // two writes, a later replay of the same runId still finds this
      // entry tracked, re-calls recordReview (no-op, returns the existing
      // record), and completes markTerminal.
      this.queueStore.recordReview({ runId: run.runId, taskId: run.taskId, status: run.status });
      this.queueStore.markTerminal(entry.id);
    } else {
      // completed
      this.queueStore.markTerminal(entry.id);
    }

    this._scheduleDispatch();
    return { handled: true };
  }
}
