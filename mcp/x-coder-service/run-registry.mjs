import crypto from 'node:crypto';
import { durableStateToExternalStatus } from './idempotency-store.mjs';

const describeError = (error) => error?.message || String(error);
const MAX_TIMER_DELAY = 2_147_483_647;

export class XCoderRunRegistry {
  constructor({ store, executor, createRunId = () => crypto.randomUUID() } = {}) {
    if (!store || typeof store.reserve !== 'function' || typeof store.getByRunId !== 'function') {
      throw new TypeError('XCoderRunRegistry requires an idempotency store.');
    }
    if (!executor || typeof executor.execute !== 'function') {
      throw new TypeError('XCoderRunRegistry requires an executor with execute().');
    }
    if (typeof createRunId !== 'function') throw new TypeError('createRunId must be a function.');
    this.store = store;
    this.executor = executor;
    this.createRunId = createRunId;
    this.live = new Map();
  }

  /**
   * Reserve durable idempotency identity first, then and only then attach and
   * start in-process execution. A duplicate key never reaches _start().
   * The initial lease deadline is mandatory and arms the watchdog before
   * executor work begins, closing the pre-first-renewal gap.
   */
  submit({ idempotencyKey, task, leaseExpiresAt } = {}) {
    if (!Number.isInteger(leaseExpiresAt) || leaseExpiresAt <= 0) {
      throw new TypeError('leaseExpiresAt must be a positive epoch-millisecond integer.');
    }
    const proposedRunId = this.createRunId();
    const reservation = this.store.reserve({ idempotencyKey, runId: proposedRunId });
    const record = reservation.record;
    if (!record) throw new Error('Idempotency reservation did not produce a durable record.');

    if (!reservation.inserted) {
      return {
        runId: record.runId,
        status: durableStateToExternalStatus(record.state),
        duplicate: true,
      };
    }

    const started = this._start({ runId: record.runId, task, leaseExpiresAt });
    return {
      runId: record.runId,
      status: started ? 'running' : durableStateToExternalStatus(this.store.getByRunId(record.runId)?.state),
      duplicate: false,
    };
  }

  _start({ runId, task, leaseExpiresAt }) {
    if (this.live.has(runId)) return false;

    const controller = new AbortController();
    const running = this.store.markRunning(runId);
    if (!running) return false;

    const live = {
      runId,
      controller,
      settled: null,
      leaseExpiresAt,
      watchdog: null,
    };
    this.live.set(runId, live);

    if (leaseExpiresAt <= Date.now()) {
      this._expireLease(runId, leaseExpiresAt);
      this.live.delete(runId);
      return true;
    }

    this._armWatchdog(live);
    live.settled = Promise.resolve()
      .then(() => this.executor.execute({ runId, task, signal: controller.signal }))
      .then(
        (result) => {
          if (controller.signal.aborted) return { kind: 'aborted', result: null, error: null };
          const persisted = this.store.markCompleted(runId, result);
          return persisted
            ? { kind: 'completed', result, error: null }
            : { kind: 'not_persisted', result: null, error: null };
        },
        (error) => {
          if (controller.signal.aborted) return { kind: 'aborted', result: null, error };
          const persisted = this.store.markFailed(runId, describeError(error));
          return persisted
            ? { kind: 'failed', result: null, error }
            : { kind: 'not_persisted', result: null, error };
        },
      )
      .finally(() => {
        this._clearWatchdog(live);
        if (this.live.get(runId) === live) this.live.delete(runId);
      });

    return true;
  }

  _clearWatchdog(live) {
    if (live?.watchdog) clearTimeout(live.watchdog);
    if (live) live.watchdog = null;
  }

  _armWatchdog(live) {
    this._clearWatchdog(live);
    const remaining = live.leaseExpiresAt - Date.now();
    if (remaining <= 0) {
      queueMicrotask(() => this._expireLease(live.runId, live.leaseExpiresAt));
      return;
    }
    live.watchdog = setTimeout(
      () => this._expireLease(live.runId, live.leaseExpiresAt),
      Math.min(MAX_TIMER_DELAY, remaining),
    );
  }

  _expireLease(runId, expectedDeadline) {
    const live = this.live.get(runId);
    if (!live || live.leaseExpiresAt !== expectedDeadline) return false;
    if (Date.now() < live.leaseExpiresAt) {
      this._armWatchdog(live);
      return false;
    }

    this._clearWatchdog(live);
    live.controller.abort(new Error('X Coder execution lease expired.'));
    this.store.markLeaseExpired(runId);
    if (!live.settled && this.live.get(runId) === live) this.live.delete(runId);
    return true;
  }

  /**
   * Pushes a newly renewed authoritative deadline. Stale/out-of-order pushes
   * never shorten a currently longer deadline. A terminal or detached run
   * cannot be resurrected.
   */
  leaseValid(runId, leaseExpiresAt) {
    if (!Number.isInteger(leaseExpiresAt) || leaseExpiresAt <= 0) {
      throw new TypeError('leaseExpiresAt must be a positive epoch-millisecond integer.');
    }
    const record = this.store.getByRunId(runId);
    if (!record) return null;
    const live = this.live.get(runId);
    if (!live || !['submitted', 'running'].includes(record.state)) {
      return {
        runId,
        status: durableStateToExternalStatus(record.state),
        leaseExpiresAt: null,
        accepted: false,
      };
    }

    if (leaseExpiresAt > live.leaseExpiresAt) {
      live.leaseExpiresAt = leaseExpiresAt;
      this._armWatchdog(live);
    }

    return {
      runId,
      status: durableStateToExternalStatus(this.store.getByRunId(runId)?.state),
      leaseExpiresAt: live.leaseExpiresAt,
      accepted: leaseExpiresAt >= live.leaseExpiresAt,
    };
  }

  getStatus(runId) {
    const record = this.store.getByRunId(runId);
    if (!record) return null;
    return {
      runId: record.runId,
      status: durableStateToExternalStatus(record.state),
      result: record.result,
      error: record.error,
    };
  }

  async cancel(runId) {
    const record = this.store.getByRunId(runId);
    if (!record) return null;

    const live = this.live.get(runId);
    if (!live) {
      return {
        ...this.getStatus(runId),
        acknowledged: record.state === 'cancelled',
      };
    }

    this._clearWatchdog(live);
    live.controller.abort(new Error('X Coder execution cancelled.'));
    if (live.settled) await live.settled;

    const current = this.store.getByRunId(runId);
    let cancelled = current;
    if (current && ['submitted', 'running'].includes(current.state)) {
      cancelled = this.store.markCancelled(runId) ?? current;
    }

    return {
      runId,
      status: durableStateToExternalStatus(cancelled?.state),
      result: cancelled?.result ?? null,
      error: cancelled?.error ?? null,
      acknowledged: cancelled?.state === 'cancelled',
    };
  }

  /** Test/diagnostic helper only: resolves when the currently attached run settles. */
  async waitForAttachedRun(runId) {
    const live = this.live.get(runId);
    if (!live) return this.getStatus(runId);
    if (live.settled) await live.settled;
    return this.getStatus(runId);
  }

  /** Test/diagnostic helper only: exposes the currently armed deadline, never lease authority. */
  getAttachedLeaseDeadline(runId) {
    return this.live.get(runId)?.leaseExpiresAt ?? null;
  }

  attachedCount() {
    return this.live.size;
  }
}
