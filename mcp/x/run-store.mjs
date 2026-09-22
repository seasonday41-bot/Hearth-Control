import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Local X run status/result store.
 *
 * XRunStore owns exactly one table, `x_runs`, in the shared Hearth runtime
 * SQLite database (see runtime-paths.mjs). It is deliberately independent
 * of `XClaimStore`/`x_task_claims` (claim-store.mjs) -- it never opens a
 * second connection to check claim state itself, and never imports
 * claim-store.mjs. `reconcileStartupState` instead takes an INJECTED
 * liveness callback, so this module has no hard-coded assumption about
 * process identity, lease shape, or which store owns global admission --
 * that stays claim-store.mjs's job, exactly as it already is today.
 *
 * This is X's own orchestration-lifecycle vocabulary. `interrupted` here is assigned
 * only by startup reconciliation, never by the Result Gate -- it means
 * "this run's process is gone," not that X ever judged it FAILED.
 *
 * `result_json` holds the complete, already-bounded x-result-v1 record
 * (Phase 9's own size limits already apply); this store never receives or
 * persists raw model/terminal output.
 *
 * Every lifecycle transition below is a SINGLE atomic conditional
 * `UPDATE ... WHERE run_id = ? AND status = <allowed current state(s)>`,
 * with success/failure determined from the statement's own reported
 * `changes` count -- never a separate `SELECT status` followed by a
 * conditional `UPDATE`. This database is shared across multiple OS
 * processes, so a check-then-write pattern would be a real, exploitable
 * TOCTOU race; a single statement's WHERE clause and its `changes` count
 * are evaluated by SQLite as one atomic operation.
 *
 * The production admission flow is: acquire a claim -> `createRun(...,
 * claimLeaseId)` -> `markRunning(..., <that same lease>)`. A run may never
 * be observed as `running` with a null `claim_lease_id`, and once a run
 * leaves `queued` its recorded lease can never be changed or cleared by
 * `setClaimLease` -- that invariant is enforced by `setClaimLease`'s own
 * `WHERE status = 'queued'` gate, not merely by convention.
 */

export const X_RUN_STATUSES = Object.freeze(['queued', 'running', 'completed', 'needs_review', 'failed', 'interrupted', 'cancelled']);
export const X_RUN_TERMINAL_STATUSES = Object.freeze(['completed', 'needs_review', 'failed', 'interrupted', 'cancelled']);
export const X_RUN_NON_TERMINAL_STATUSES = Object.freeze(['queued', 'running']);

export const DEFAULT_RUN_RETENTION_LIMIT = 200;
const MAX_ERROR_BYTES = 2000;

/** Verbatim, locked Result Gate -> X run status mapping. No other classification layer. */
const RUN_STATUS_BY_GATE_STATUS = Object.freeze({
  COMPLETED: 'completed',
  NEEDS_REVIEW: 'needs_review',
  FAILED: 'failed',
});

export class XRunStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'XRunStoreError';
    this.code = code;
  }
}

/** Rejects non-string, empty, and whitespace-only lease ids everywhere a real lease id is required. */
const isValidLeaseId = (value) => typeof value === 'string' && value.trim().length > 0;
// SQLite evaluates 'now' while executing the UPDATE, after any write-lock wait.
const SQLITE_NOW_MS = `(CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER))`;
const LIVE_CLAIM_PREDICATE = `EXISTS (SELECT 1 FROM x_task_claims AS claim
  WHERE claim.task_id = x_runs.task_id AND claim.owner_id = ? AND claim.lease_id = x_runs.claim_lease_id
    AND claim.state = 'active' AND claim.lease_expires_at > ${SQLITE_NOW_MS})`;

const requireFencingIdentity = (ownerId, leaseId) => {
  if (typeof ownerId !== 'string' || !ownerId.trim()) throw new TypeError('ownerId is required for a fenced transition.');
  if (!isValidLeaseId(leaseId)) throw new TypeError('leaseId is required for a fenced transition.');
};

const validateCompletion = (runId, gateResult, xResult) => {
  if (!runId || typeof runId !== 'string') throw new TypeError('runId is required.');
  if (!gateResult || typeof gateResult.gate_status !== 'string') throw new TypeError('gateResult.gate_status is required.');
  const mappedStatus = RUN_STATUS_BY_GATE_STATUS[gateResult.gate_status];
  if (!mappedStatus) throw new TypeError(`Unrecognized gate_status '${gateResult.gate_status}'.`);
  if (!xResult || typeof xResult !== 'object' || Array.isArray(xResult)) {
    throw new TypeError('completeRun: xResult must be an object.');
  }
  if (typeof xResult.task_id !== 'string' || xResult.task_id.trim().length === 0) {
    throw new TypeError('completeRun: xResult.task_id must be a non-empty string.');
  }
  if (xResult.gate_status !== gateResult.gate_status) {
    throw new TypeError(`completeRun: xResult.gate_status ('${xResult.gate_status}') does not match gateResult.gate_status ('${gateResult.gate_status}').`);
  }
  if (xResult.hearth_outcome !== gateResult.hearth_outcome) {
    throw new TypeError(`completeRun: xResult.hearth_outcome ('${xResult.hearth_outcome}') does not match gateResult.hearth_outcome ('${gateResult.hearth_outcome}').`);
  }
  return mappedStatus;
};

/**
 * Truncates to at most `maxBytes` UTF-8 bytes WITHOUT ever splitting a
 * multi-byte character -- decoding a byte-truncated buffer can insert a
 * U+FFFD replacement character at a split boundary, and that replacement
 * character is itself 3 bytes when re-encoded, so a naive
 * `buffer.subarray(0, maxBytes).toString('utf8')` can silently produce a
 * string whose own byte length EXCEEDS maxBytes. This backs off one byte
 * at a time until the decode no longer ends in a replacement character,
 * matching context-loader.mjs's own proven `truncateToByteLimit` approach.
 */
const truncateUtf8Safe = (text, maxBytes) => {
  const str = String(text ?? '');
  const buffer = Buffer.from(str, 'utf8');
  if (buffer.byteLength <= maxBytes) return str;
  if (maxBytes <= 0) return '';
  let end = maxBytes;
  let decoded = buffer.subarray(0, end).toString('utf8');
  while (decoded.endsWith('�') && end > 0) {
    end -= 1;
    decoded = buffer.subarray(0, end).toString('utf8');
  }
  return decoded;
};

const rowToRecord = (row) => {
  if (!row) return null;
  return {
    runId: row.run_id,
    taskId: row.task_id,
    status: row.status,
    gateStatus: row.gate_status ?? null,
    hearthOutcome: row.hearth_outcome ?? null,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    error: row.error ?? null,
    claimLeaseId: row.claim_lease_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

export class XRunStore {
  /** @param {{ storagePath: string, retentionLimit?: number }} options */
  constructor({ storagePath, retentionLimit } = {}) {
    if (!storagePath || typeof storagePath !== 'string') {
      throw new TypeError('storagePath is required for XRunStore');
    }
    this.storagePath = storagePath;
    this.retentionLimit = Number.isInteger(retentionLimit) && retentionLimit > 0
      ? retentionLimit
      : DEFAULT_RUN_RETENTION_LIMIT;
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
    db.exec(`CREATE TABLE IF NOT EXISTS x_runs (
      run_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      status TEXT NOT NULL,
      gate_status TEXT,
      hearth_outcome TEXT,
      result_json TEXT,
      error TEXT,
      claim_lease_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    this.db = db;
    return db;
  }

  /**
   * Keeps the most recent `retentionLimit` TERMINAL rows. Ordered by
   * `updated_at DESC, rowid DESC` -- the implicit SQLite `rowid` (stable
   * across UPDATEs, monotonic with insertion order) is a deterministic
   * secondary key so a tie on `updated_at` (a millisecond timestamp;
   * ordinary under fast/bulk writes) never produces ambiguous, run-to-run
   * different survivors. Queued/running rows are never touched, by
   * construction of the WHERE clause.
   */
  _applyRetention(db) {
    db.prepare(`DELETE FROM x_runs WHERE run_id IN (
      SELECT run_id FROM x_runs
      WHERE status IN ('completed','needs_review','failed','interrupted','cancelled')
      ORDER BY updated_at DESC, rowid DESC
      LIMIT -1 OFFSET ?
    )`).run(this.retentionLimit);
  }

  /**
   * Creates a new run row in `queued` status. Must be called BEFORE any
   * background execution begins, so a crash immediately after cannot make
   * the run disappear. Duplicate-`runId` detection is a single atomic
   * `INSERT OR IGNORE`; the loser gets a typed `XRunStoreError`, never a
   * leaked raw SQLite constraint error.
   */
  createRun({ runId, taskId, claimLeaseId = null } = {}) {
    if (!runId || typeof runId !== 'string') throw new TypeError('runId is required to create a run.');
    if (!taskId || typeof taskId !== 'string') throw new TypeError('taskId is required to create a run.');
    if (claimLeaseId !== null && claimLeaseId !== undefined && !isValidLeaseId(claimLeaseId)) {
      throw new TypeError('claimLeaseId, when provided, must be a non-empty, non-whitespace string.');
    }
    const db = this._getDb();
    const now = this.now();
    const result = db.prepare(`INSERT OR IGNORE INTO x_runs
      (run_id, task_id, status, gate_status, hearth_outcome, result_json, error, claim_lease_id, created_at, updated_at)
      VALUES (?, ?, 'queued', NULL, NULL, NULL, NULL, ?, ?, ?)`)
      .run(runId, taskId, claimLeaseId ?? null, now, now);
    if (result.changes === 0) {
      throw new XRunStoreError('DUPLICATE_RUN_ID', `A run already exists for runId '${runId}'.`);
    }
    this._applyRetention(db);
    return this.getRun(runId);
  }

  /** Returns the run record, or `null` if unknown. `result` is parsed back into an object when present. */
  getRun(runId) {
    if (!runId || typeof runId !== 'string') return null;
    const row = this._getDb().prepare('SELECT * FROM x_runs WHERE run_id = ?').get(runId);
    return rowToRecord(row);
  }

  /** Read-only: returns the most recently updated X runs, newest first. */
  listRecentRuns(limit = 20) {
    const bounded = Number.isInteger(limit) ? Math.max(1, Math.min(limit, 100)) : 20;
    return this._getDb()
      .prepare('SELECT * FROM x_runs ORDER BY updated_at DESC, rowid DESC LIMIT ?')
      .all(bounded)
      .map(rowToRecord);
  }

  /**
   * Read-only: does ANY non-terminal (`queued`/`running`) run currently
   * carry this exact `claim_lease_id`? Lets a caller holding only a bare
   * leaseId (e.g. from XClaimStore.getActiveClaim(), which is claim-kind-
   * agnostic and knows nothing about X vs. any other consumer of the
   * shared claim table) determine whether that lease actually belongs to
   * an X run, without needing to enumerate or expose run rows at all.
   * @param {string} claimLeaseId
   * @returns {boolean}
   */
  hasNonTerminalRunForClaimLease(claimLeaseId) {
    if (!claimLeaseId || typeof claimLeaseId !== 'string') return false;
    const row = this._getDb().prepare(
      `SELECT 1 FROM x_runs WHERE claim_lease_id = ? AND status IN ('queued','running') LIMIT 1`,
    ).get(claimLeaseId);
    return Boolean(row);
  }

  /**
   * Records a claim lease id -- ONLY while a run is still `queued`. A
   * single atomic `UPDATE ... WHERE run_id = ? AND status = 'queued'`, so
   * this can never clear or change the lease of a `running` or terminal
   * run (`changes === 0` -> `null` in both the unknown-run and
   * wrong-status cases). `claimLeaseId` must be a real, non-empty,
   * non-whitespace string -- there is no way to use this method to null
   * out a lease.
   */
  setClaimLease(runId, claimLeaseId) {
    if (!runId || typeof runId !== 'string') throw new TypeError('runId is required.');
    if (!isValidLeaseId(claimLeaseId)) {
      throw new TypeError('claimLeaseId is required and must be a non-empty, non-whitespace string.');
    }
    const db = this._getDb();
    const now = this.now();
    const result = db.prepare(`UPDATE x_runs SET claim_lease_id = ?, updated_at = ?
      WHERE run_id = ? AND status = 'queued'`)
      .run(claimLeaseId, now, runId);
    if (result.changes === 0) return null;
    return this.getRun(runId);
  }

  /**
   * `queued` -> `running`, atomically, together with recording a real
   * admission lease -- a run may never be observed as `running` with a
   * null `claim_lease_id`. `claimLeaseId` is required and must be a real,
   * non-empty, non-whitespace string (a `TypeError` if omitted or blank,
   * not a silent no-op). `changes === 0` (unknown run, or not `queued`) is
   * reported as `null`.
   */
  markRunning({ runId, claimLeaseId } = {}) {
    if (!runId || typeof runId !== 'string') throw new TypeError('runId is required.');
    if (!isValidLeaseId(claimLeaseId)) {
      throw new TypeError('claimLeaseId is required to transition a run to running -- a run must never enter running without a real admission lease.');
    }
    const db = this._getDb();
    const now = this.now();
    const result = db.prepare(`UPDATE x_runs SET status = 'running', claim_lease_id = ?, updated_at = ?
      WHERE run_id = ? AND status = 'queued'`)
      .run(claimLeaseId, now, runId);
    if (result.changes === 0) return null;
    return this.getRun(runId);
  }

  /**
   * The terminal write for a REAL Result Gate outcome: `running` ->
   * `completed`/`needs_review`/`failed`, mapped verbatim from
   * `gateResult.gate_status`. This is persistence-integrity validation
   * ONLY (never a reclassification): `xResult` must be a real object whose
   * own `task_id`/`gate_status`/`hearth_outcome` agree with this run and
   * `gateResult` -- a mismatch or a malformed `xResult` throws `TypeError`
   * (for shape problems) BEFORE any database mutation, or (for a
   * `task_id` that belongs to a different task entirely) is folded
   * directly into the atomic transition's own WHERE clause so an
   * x-result-v1 can never be persisted onto the wrong run. Either way the
   * run is left exactly as it was (`running`). The actual state transition
   * is a single atomic `UPDATE ... WHERE run_id = ? AND task_id = ? AND
   * status = 'running'` -- never a separate `SELECT` to check `task_id`
   * first; `changes === 0` (unknown run, wrong task_id, or already
   * terminal) is reported as `null`.
   */
  completeRun({ runId, gateResult, xResult } = {}) {
    const mappedStatus = validateCompletion(runId, gateResult, xResult);
    const db = this._getDb();
    const now = this.now();
    const result = db.prepare(`UPDATE x_runs SET status = ?, gate_status = ?, hearth_outcome = ?, result_json = ?, error = NULL, updated_at = ?
      WHERE run_id = ? AND task_id = ? AND status = 'running'`)
      .run(mappedStatus, gateResult.gate_status, gateResult.hearth_outcome ?? null, JSON.stringify(xResult), now, runId, xResult.task_id);
    if (result.changes === 0) return null;
    this._applyRetention(db);
    return this.getRun(runId);
  }

  /** Production terminal transition: the live claim and run update are one SQLite statement. */
  completeRunFenced({ runId, ownerId, leaseId, gateResult, xResult } = {}) {
    const mappedStatus = validateCompletion(runId, gateResult, xResult);
    requireFencingIdentity(ownerId, leaseId);
    const db = this._getDb();
    const result = db.prepare(`UPDATE x_runs SET status = ?, gate_status = ?, hearth_outcome = ?, result_json = ?, error = NULL, updated_at = ${SQLITE_NOW_MS}
      WHERE run_id = ? AND task_id = ? AND status = 'running' AND claim_lease_id = ?
      AND ${LIVE_CLAIM_PREDICATE}`)
      .run(mappedStatus, gateResult.gate_status, gateResult.hearth_outcome ?? null, JSON.stringify(xResult),
        runId, xResult.task_id, leaseId, ownerId);
    if (result.changes === 0) return null;
    this._applyRetention(db);
    return this.getRun(runId);
  }

  /**
   * Records an ORCHESTRATION-level failure -- distinct from a real Result
   * Gate FAILED -- always landing in `status: 'failed'` with `gate_status`/
   * `hearth_outcome`/`result` left `null`. `error` is truncated UTF-8-byte-
   * safely to `MAX_ERROR_BYTES`. A single atomic
   * `UPDATE ... WHERE run_id = ? AND status IN ('queued','running')`;
   * `changes === 0` (already terminal) is reported as `null`.
   */
  failRun({ runId, error } = {}) {
    if (!runId || typeof runId !== 'string') throw new TypeError('runId is required.');
    const db = this._getDb();
    const now = this.now();
    const bounded = truncateUtf8Safe(error ?? 'Unknown orchestration error', MAX_ERROR_BYTES);
    const result = db.prepare(`UPDATE x_runs SET status = 'failed', gate_status = NULL, hearth_outcome = NULL, result_json = NULL, error = ?, updated_at = ?
      WHERE run_id = ? AND status IN ('queued','running')`)
      .run(bounded, now, runId);
    if (result.changes === 0) return null;
    this._applyRetention(db);
    return this.getRun(runId);
  }

  /** Production orchestration failure, fenced for both claimed queued and running runs. */
  failRunFenced({ runId, taskId, ownerId, leaseId, error } = {}) {
    if (!runId || typeof runId !== 'string') throw new TypeError('runId is required.');
    if (!taskId || typeof taskId !== 'string' || !taskId.trim()) throw new TypeError('taskId is required.');
    requireFencingIdentity(ownerId, leaseId);
    const db = this._getDb();
    const bounded = truncateUtf8Safe(error ?? 'Unknown orchestration error', MAX_ERROR_BYTES);
    const result = db.prepare(`UPDATE x_runs SET status = 'failed', gate_status = NULL, hearth_outcome = NULL, result_json = NULL, error = ?, updated_at = ${SQLITE_NOW_MS}
      WHERE run_id = ? AND task_id = ? AND status IN ('queued','running') AND claim_lease_id = ?
      AND ${LIVE_CLAIM_PREDICATE}`)
      .run(bounded, runId, taskId, leaseId, ownerId);
    if (result.changes === 0) return null;
    this._applyRetention(db);
    return this.getRun(runId);
  }

  /**
   * Explicit cancellation terminal transition, fenced to the live claim.
   * Mirrors failRunFenced's ownership guarantees but records cancellation
   * without a Result Gate outcome or orchestration error. A single atomic
   * UPDATE may move only this task's queued/running row carrying the exact
   * live claim lease. `changes === 0` means the run/identity/status/lease
   * no longer authorizes cancellation and is reported as `null`.
   */
  cancelRunFenced({ runId, taskId, ownerId, leaseId } = {}) {
    if (!runId || typeof runId !== 'string') throw new TypeError('runId is required.');
    if (!taskId || typeof taskId !== 'string' || !taskId.trim()) throw new TypeError('taskId is required.');
    requireFencingIdentity(ownerId, leaseId);
    const db = this._getDb();
    const result = db.prepare(`UPDATE x_runs SET status = 'cancelled', gate_status = NULL, hearth_outcome = NULL, result_json = NULL, error = NULL, updated_at = ${SQLITE_NOW_MS}
      WHERE run_id = ? AND task_id = ? AND status IN ('queued','running') AND claim_lease_id = ?
      AND ${LIVE_CLAIM_PREDICATE}`)
      .run(runId, taskId, leaseId, ownerId);
    if (result.changes === 0) return null;
    this._applyRetention(db);
    return this.getRun(runId);
  }

  /**
   * Reconciliation-only transition: `queued`/`running` -> `interrupted`.
   * A single atomic `UPDATE ... WHERE run_id = ? AND status IN
   * ('queued','running')`, inherently idempotent and unable to overwrite
   * an already-terminal row.
   */
  markInterrupted(runId) {
    if (!runId || typeof runId !== 'string') throw new TypeError('runId is required.');
    const db = this._getDb();
    const now = this.now();
    const result = db.prepare(`UPDATE x_runs SET status = 'interrupted', updated_at = ?
      WHERE run_id = ? AND status IN ('queued','running')`)
      .run(now, runId);
    if (result.changes === 0) return null;
    this._applyRetention(db);
    return this.getRun(runId);
  }

  /**
   * Evaluates every non-terminal run against claim liveness and marks it
   * `interrupted` when its claim is no longer genuinely active.
   *
   * The ENTIRE decision -- reading candidate rows, consulting
   * `isClaimLive`, and writing any resulting `interrupted` transition -- is
   * wrapped in a single `BEGIN IMMEDIATE ... COMMIT` transaction on this
   * store's own connection. Because SQLite's write lock is file-level (not
   * table-level) even though `x_runs` and `x_task_claims` are different
   * tables in the SAME file, this guarantees NO other connection --
   * including a real `XClaimStore.renew()`/`claim()`/`release()` from any
   * process -- can complete a write anywhere in the shared database while
   * this decision is in progress; such a write simply blocks (and retries
   * via its own `busy_timeout`) until this transaction commits. This is
   * what closes the TOCTOU race where a genuinely-live process's lease
   * renewal could otherwise land exactly between the liveness check and
   * the interrupt write. (Verified empirically against `node:sqlite`'s
   * actual locking behavior: another connection's plain reads are never
   * blocked by an open `BEGIN IMMEDIATE` elsewhere and see a consistent
   * snapshot, while another connection's own `BEGIN IMMEDIATE` genuinely
   * blocks until this one commits or rolls back.)
   *
   * CONTRACT: `isClaimLive(taskId, claimLeaseId)` MUST ONLY READ (e.g.
   * `XClaimStore.getActiveClaim(taskId)?.leaseId === claimLeaseId`) -- a
   * write from inside this callback would attempt its own transaction
   * against the same locked file and deadlock/block until timeout. Plain
   * reads are never blocked by this method's open transaction.
   *
   * A run whose `claim_lease_id` is `null` is always interrupted without
   * consulting the callback, since there is no lease to check. Idempotent:
   * a row already terminal (including one raced to `interrupted` by a
   * concurrent call) is simply a `changes === 0` no-op.
   *
   * @param {(taskId: string, claimLeaseId: string|null) => boolean} isClaimLive
   * @returns {string[]} the runIds marked interrupted by this call
   */
  reconcileStartupState(isClaimLive) {
    if (typeof isClaimLive !== 'function') throw new TypeError('isClaimLive callback is required.');
    const db = this._getDb();
    const interrupted = [];
    db.exec('BEGIN IMMEDIATE');
    try {
      const rows = db.prepare(`SELECT run_id, task_id, claim_lease_id FROM x_runs WHERE status IN ('queued','running')`).all();
      for (const row of rows) {
        const alive = row.claim_lease_id != null && Boolean(isClaimLive(row.task_id, row.claim_lease_id));
        if (!alive && this.markInterrupted(row.run_id)) {
          interrupted.push(row.run_id);
        }
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return interrupted;
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
