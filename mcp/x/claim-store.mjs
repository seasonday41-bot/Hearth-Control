import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

/**
 * Persistent, fencing-safe execution claim/lease for x-task-v1 tasks.
 *
 * This is deliberately isolated from the validated durable continuation
 * claim in `mcp/executors/task-store.mjs` (`continuation_claims`). That
 * table protects resuming a specific Hearth durable job/task. This table
 * protects X task *execution ownership*: which single X task, if any, a
 * dispatcher is currently allowed to run. The two must never be merged.
 *
 * Because `MAX_ACTIVE_TASKS = 1`, ownership is a single global slot: at
 * most one row may be `state = 'active'` with an unexpired lease at a time,
 * regardless of task_id. Claiming a task therefore both (a) prevents a
 * duplicate claim of that same task, and (b) prevents any other task from
 * acquiring the slot while it is held.
 *
 * Atomicity is provided by SQLite's own file-level write lock via
 * `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`, which serializes concurrent
 * claim attempts across separate `XClaimStore` instances, connections, and
 * processes pointed at the same storage file -- not by any in-memory
 * structure, which would not survive a restart or a second process.
 */

const DEFAULT_LEASE_DURATION_MS = 30000;

const rowToClaim = (row) => row && ({
  taskId: row.task_id,
  ownerId: row.owner_id,
  leaseId: row.lease_id,
  attempt: row.attempt,
  state: row.state,
  claimedAt: row.claimed_at,
  renewedAt: row.renewed_at,
  leaseExpiresAt: row.lease_expires_at,
  releasedAt: row.released_at,
});

export class XClaimStore {
  /**
   * @param {string | { storagePath: string, leaseDurationMs?: number }} options
   */
  constructor(options) {
    const storagePath = typeof options === 'string' ? options : options?.storagePath;
    if (!storagePath || typeof storagePath !== 'string') {
      throw new Error('storagePath is required for XClaimStore');
    }
    const leaseDurationMs = typeof options === 'object' ? options?.leaseDurationMs : undefined;
    this.storagePath = storagePath;
    this.leaseDurationMs = Number.isInteger(leaseDurationMs) && leaseDurationMs > 0
      ? leaseDurationMs
      : DEFAULT_LEASE_DURATION_MS;
    this.db = null;
  }

  now() {
    return Date.now();
  }

  _getDb() {
    if (this.db) return this.db;
    fs.mkdirSync(path.dirname(this.storagePath), { recursive: true });
    const db = new DatabaseSync(this.storagePath);
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(`CREATE TABLE IF NOT EXISTS x_task_claims (
      task_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      lease_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      state TEXT NOT NULL,
      claimed_at INTEGER NOT NULL,
      renewed_at INTEGER NOT NULL,
      lease_expires_at INTEGER NOT NULL,
      released_at INTEGER
    )`);
    this.db = db;
    return db;
  }

  _withTransaction(fn) {
    const db = this._getDb();
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn(db);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Atomically claims execution ownership of `taskId` for `ownerId`.
   *
   * Returns the new claim (with a freshly minted `leaseId`) on success, or
   * `null` when:
   *  - a *different* task currently holds the single global slot with an
   *    unexpired lease (global seriality), or
   *  - this same task already has an active, unexpired lease (duplicate
   *    claim / duplicate event delivery protection).
   *
   * A missing, released, or expired prior claim for this task is reclaimed
   * safely: a brand-new `leaseId` and incremented `attempt` are issued, so
   * a stale owner's identity is never silently reused.
   *
   * @param {{ taskId: string, ownerId: string, leaseDurationMs?: number }} params
   * @returns {{taskId:string, ownerId:string, leaseId:string, attempt:number, state:string, claimedAt:number, renewedAt:number, leaseExpiresAt:number, releasedAt:number|null} | null}
   */
  claim({ taskId, ownerId, leaseDurationMs } = {}) {
    if (!taskId || typeof taskId !== 'string') throw new TypeError('taskId is required to claim.');
    if (!ownerId || typeof ownerId !== 'string') throw new TypeError('ownerId is required to claim.');
    const duration = Number.isInteger(leaseDurationMs) && leaseDurationMs > 0 ? leaseDurationMs : this.leaseDurationMs;
    return this._withTransaction((db) => {
      const now = this.now();
      const globalBlocker = db.prepare(
        `SELECT task_id FROM x_task_claims WHERE state = 'active' AND lease_expires_at > ? AND task_id != ?`,
      ).get(now, taskId);
      if (globalBlocker) return null;

      const prior = db.prepare('SELECT * FROM x_task_claims WHERE task_id = ?').get(taskId);
      if (prior && prior.state === 'active' && prior.lease_expires_at > now) return null;

      const leaseId = crypto.randomUUID();
      const attempt = (prior?.attempt || 0) + 1;
      const leaseExpiresAt = now + duration;
      db.prepare(`INSERT INTO x_task_claims
        (task_id, owner_id, lease_id, attempt, state, claimed_at, renewed_at, lease_expires_at, released_at)
        VALUES (?, ?, ?, ?, 'active', ?, ?, ?, NULL)
        ON CONFLICT(task_id) DO UPDATE SET
          owner_id = excluded.owner_id, lease_id = excluded.lease_id, attempt = excluded.attempt,
          state = 'active', claimed_at = excluded.claimed_at, renewed_at = excluded.renewed_at,
          lease_expires_at = excluded.lease_expires_at, released_at = NULL`)
        .run(taskId, ownerId, leaseId, attempt, now, now, leaseExpiresAt);

      return { taskId, ownerId, leaseId, attempt, state: 'active', claimedAt: now, renewedAt: now, leaseExpiresAt, releasedAt: null };
    });
  }

  /**
   * Renews the lease of the *current* owner. Fails (returns `null`) for a
   * wrong owner, a wrong/stale lease id, a released claim, or a lease that
   * has already expired -- an owner must renew before its own lease lapses;
   * once lapsed, only `claim()` (stale recovery) may reclaim it, and only
   * with a new lease identity.
   *
   * @param {{ taskId: string, ownerId: string, leaseId: string, leaseDurationMs?: number }} params
   */
  renew({ taskId, ownerId, leaseId, leaseDurationMs } = {}) {
    if (!taskId || !ownerId || !leaseId) throw new TypeError('taskId, ownerId, and leaseId are required to renew.');
    const duration = Number.isInteger(leaseDurationMs) && leaseDurationMs > 0 ? leaseDurationMs : this.leaseDurationMs;
    return this._withTransaction((db) => {
      const now = this.now();
      const row = db.prepare('SELECT * FROM x_task_claims WHERE task_id = ?').get(taskId);
      if (!row || row.state !== 'active' || row.owner_id !== ownerId || row.lease_id !== leaseId) return null;
      if (row.lease_expires_at <= now) return null;
      const leaseExpiresAt = now + duration;
      db.prepare('UPDATE x_task_claims SET renewed_at = ?, lease_expires_at = ? WHERE task_id = ? AND lease_id = ?')
        .run(now, leaseExpiresAt, taskId, leaseId);
      return { taskId, ownerId, leaseId, attempt: row.attempt, state: 'active', claimedAt: row.claimed_at, renewedAt: now, leaseExpiresAt, releasedAt: null };
    });
  }

  /**
   * Releases the current owner's lease. Idempotent: releasing an
   * already-released claim under the *same* lease id is a harmless no-op
   * success. A stale owner (wrong owner id or a lease id superseded by a
   * later reclaim) cannot release the current owner's claim -- fencing.
   *
   * Releasing is not completion; it only frees the global execution slot.
   *
   * @param {{ taskId: string, ownerId: string, leaseId: string }} params
   * @returns {boolean}
   */
  release({ taskId, ownerId, leaseId } = {}) {
    if (!taskId || !ownerId || !leaseId) throw new TypeError('taskId, ownerId, and leaseId are required to release.');
    return this._withTransaction((db) => {
      const row = db.prepare('SELECT * FROM x_task_claims WHERE task_id = ?').get(taskId);
      if (!row || row.owner_id !== ownerId || row.lease_id !== leaseId) return false;
      if (row.state === 'released') return true;
      const now = this.now();
      db.prepare(`UPDATE x_task_claims SET state = 'released', released_at = ? WHERE task_id = ? AND lease_id = ?`)
        .run(now, taskId, leaseId);
      return true;
    });
  }

  /**
   * Returns whether `ownerId`/`leaseId` currently, validly own `taskId`'s
   * execution claim (active state, unexpired lease). Used as the fencing
   * check before any owner-only mutation outside this store.
   */
  isOwner(taskId, ownerId, leaseId) {
    if (!taskId || !ownerId || !leaseId) return false;
    const row = this._getDb().prepare('SELECT owner_id, lease_id, state, lease_expires_at FROM x_task_claims WHERE task_id = ?').get(taskId);
    return Boolean(row && row.owner_id === ownerId && row.lease_id === leaseId && row.state === 'active' && row.lease_expires_at > this.now());
  }

  /**
   * Exposes current global execution ownership without granting any
   * mutation rights. With no `taskId`, returns the single active claim
   * holding the global slot, if any. A released or expired claim is never
   * returned as active.
   *
   * @param {string} [taskId]
   */
  getActiveClaim(taskId = null) {
    const db = this._getDb();
    const now = this.now();
    if (taskId) {
      const row = db.prepare('SELECT * FROM x_task_claims WHERE task_id = ?').get(taskId);
      if (!row || row.state !== 'active' || row.lease_expires_at <= now) return null;
      return rowToClaim(row);
    }
    const row = db.prepare(`SELECT * FROM x_task_claims WHERE state = 'active' AND lease_expires_at > ? ORDER BY claimed_at ASC LIMIT 1`).get(now);
    return rowToClaim(row) || null;
  }

  /** Returns the raw stored row for a task, regardless of state -- for tests/diagnostics only. */
  getRaw(taskId) {
    const row = this._getDb().prepare('SELECT * FROM x_task_claims WHERE task_id = ?').get(taskId);
    return rowToClaim(row) || null;
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
