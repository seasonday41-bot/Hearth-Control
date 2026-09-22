import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const X_CODER_DURABLE_STATES = Object.freeze([
  'submitted',
  'running',
  'completed',
  'failed',
  'cancelled',
  'unknown_incomplete',
]);

const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled', 'unknown_incomplete']);
const nowMs = () => Date.now();

const rowToRecord = (row) => row && ({
  idempotencyKey: row.idempotency_key,
  runId: row.run_id,
  state: row.state,
  result: row.result_json ? JSON.parse(row.result_json) : null,
  error: row.error ?? null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const durableStateToExternalStatus = (state) =>
  state === 'unknown_incomplete' ? 'interrupted' : state;

export class XCoderIdempotencyStore {
  constructor({ storagePath } = {}) {
    if (typeof storagePath !== 'string' || !storagePath.trim()) {
      throw new TypeError('storagePath is required for XCoderIdempotencyStore.');
    }
    this.storagePath = storagePath;
    this.db = null;
  }

  _getDb() {
    if (this.db) return this.db;
    fs.mkdirSync(path.dirname(this.storagePath), { recursive: true });
    const db = new DatabaseSync(this.storagePath);
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(`CREATE TABLE IF NOT EXISTS x_coder_idempotency (
      idempotency_key TEXT PRIMARY KEY,
      run_id TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL,
      result_json TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    this.db = db;
    return db;
  }

  /**
   * First durable write in submit(): INSERT OR IGNORE the idempotency identity
   * before any executor work can begin. Exactly one caller wins; every loser
   * gets the already-durable run_id and must not execute again.
   */
  reserve({ idempotencyKey, runId } = {}) {
    if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) {
      throw new TypeError('idempotencyKey is required.');
    }
    if (typeof runId !== 'string' || !runId.trim()) {
      throw new TypeError('runId is required.');
    }
    const db = this._getDb();
    const now = nowMs();
    const result = db.prepare(`INSERT OR IGNORE INTO x_coder_idempotency
      (idempotency_key, run_id, state, result_json, error, created_at, updated_at)
      VALUES (?, ?, 'submitted', NULL, NULL, ?, ?)`)
      .run(idempotencyKey.trim(), runId.trim(), now, now);

    const row = db.prepare('SELECT * FROM x_coder_idempotency WHERE idempotency_key = ?')
      .get(idempotencyKey.trim());
    return { inserted: result.changes === 1, record: rowToRecord(row) };
  }

  getByIdempotencyKey(idempotencyKey) {
    if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) return null;
    return rowToRecord(
      this._getDb().prepare('SELECT * FROM x_coder_idempotency WHERE idempotency_key = ?')
        .get(idempotencyKey.trim()),
    );
  }

  getByRunId(runId) {
    if (typeof runId !== 'string' || !runId.trim()) return null;
    return rowToRecord(
      this._getDb().prepare('SELECT * FROM x_coder_idempotency WHERE run_id = ?')
        .get(runId.trim()),
    );
  }

  markRunning(runId) {
    const db = this._getDb();
    const result = db.prepare(`UPDATE x_coder_idempotency
      SET state = 'running', updated_at = ?
      WHERE run_id = ? AND state = 'submitted'`)
      .run(nowMs(), runId);
    if (result.changes === 0) return null;
    return this.getByRunId(runId);
  }

  markCompleted(runId, resultValue) {
    const db = this._getDb();
    const result = db.prepare(`UPDATE x_coder_idempotency
      SET state = 'completed', result_json = ?, error = NULL, updated_at = ?
      WHERE run_id = ? AND state = 'running'`)
      .run(JSON.stringify(resultValue ?? null), nowMs(), runId);
    if (result.changes === 0) return null;
    return this.getByRunId(runId);
  }

  markFailed(runId, error) {
    const db = this._getDb();
    const message = error == null ? 'Unknown executor error' : String(error);
    const result = db.prepare(`UPDATE x_coder_idempotency
      SET state = 'failed', result_json = NULL, error = ?, updated_at = ?
      WHERE run_id = ? AND state IN ('submitted','running')`)
      .run(message.slice(0, 4000), nowMs(), runId);
    if (result.changes === 0) return null;
    return this.getByRunId(runId);
  }

  markCancelled(runId) {
    const db = this._getDb();
    const result = db.prepare(`UPDATE x_coder_idempotency
      SET state = 'cancelled', result_json = NULL, error = NULL, updated_at = ?
      WHERE run_id = ? AND state IN ('submitted','running')`)
      .run(nowMs(), runId);
    if (result.changes === 0) return null;
    return this.getByRunId(runId);
  }

  /**
   * Process-start reconciliation. A fresh process has no attached in-memory
   * executions yet, so any submitted/running durable row is from a process
   * that disappeared. Never resume it: make that uncertainty terminal.
   */
  reconcileStartupState() {
    const db = this._getDb();
    db.exec('BEGIN IMMEDIATE');
    try {
      const rows = db.prepare(`SELECT run_id FROM x_coder_idempotency
        WHERE state IN ('submitted','running')`).all();
      const update = db.prepare(`UPDATE x_coder_idempotency
        SET state = 'unknown_incomplete', updated_at = ?
        WHERE run_id = ? AND state IN ('submitted','running')`);
      const interrupted = [];
      const now = nowMs();
      for (const row of rows) {
        if (update.run(now, row.run_id).changes === 1) interrupted.push(row.run_id);
      }
      db.exec('COMMIT');
      return interrupted;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  isTerminal(runId) {
    const record = this.getByRunId(runId);
    return Boolean(record && TERMINAL_STATES.has(record.state));
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
