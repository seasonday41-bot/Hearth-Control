import crypto from 'node:crypto';
import { durableStateToExternalStatus } from './idempotency-store.mjs';

const describeError = (error) => error?.message || String(error);

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
   */
  submit({ idempotencyKey, task } = {}) {
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

    const started = this._start({ runId: record.runId, task });
    return {
      runId: record.runId,
      status: started ? 'running' : durableStateToExternalStatus(this.store.getByRunId(record.runId)?.state),
      duplicate: false,
    };
  }

  _start({ runId, task }) {
    if (this.live.has(runId)) return false;

    const controller = new AbortController();
    const running = this.store.markRunning(runId);
    if (!running) return false;

    const live = {
      runId,
      controller,
      settled: null,
    };
    this.live.set(runId, live);

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
        if (this.live.get(runId) === live) this.live.delete(runId);
      });

    return true;
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

    live.controller.abort(new Error('X Coder execution cancelled.'));
    await live.settled;

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
    await live.settled;
    return this.getStatus(runId);
  }

  attachedCount() {
    return this.live.size;
  }
}
