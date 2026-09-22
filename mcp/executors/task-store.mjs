import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { redactSecrets } from '../security/redact-secrets.mjs';

export const SCHEMA_VERSION = 1;

/**
 * Valid task status values recognized by Hearth.
 * @type {Set<string>}
 */
export const VALID_TASK_STATUSES = new Set([
  'pending',
  'starting',
  'running',
  'waiting',
  'paused',
  'error',
  'done',
  'recovery_required',
]);

/**
 * Sanitizes a task object before persisting to disk.
 * Strictly ensures:
 * - No raw transcript, child handles, streams, or cleanup callbacks
 * - No secrets, bearer tokens, or API keys
 * - Only valid structured fields and summaries
 * @param {object} raw
 * @returns {object}
 */
export const sanitizeTaskForPersistence = (raw) => {
  if (!raw || typeof raw !== 'object') return null;

  const status = VALID_TASK_STATUSES.has(raw.status) ? raw.status : 'error';
  const taskId = typeof raw.taskId === 'string' ? raw.taskId : '';
  const conversationId = typeof raw.conversationId === 'string' && raw.conversationId.trim() ? raw.conversationId.trim() : null;
  const workspace = typeof raw.workspace === 'string' ? raw.workspace : '';
  const title = redactSecrets(typeof raw.title === 'string' ? raw.title : 'Hearth Task');
  let source = raw.source === 'remote' ? 'remote' : 'local';
  const remoteTaskId = typeof raw.remoteTaskId === 'string' && raw.remoteTaskId.trim() ? raw.remoteTaskId.trim() : null;
  if (source === 'remote' && !remoteTaskId) {
    console.warn(`[TaskStore] Invariant violation: task '${taskId}' has source='remote' without remoteTaskId. Reconciling to 'local'.`);
    source = 'local';
  }
  const requestId = typeof raw.requestId === 'string' ? raw.requestId : null;
  const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString();
  const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString();
  const lastAnswer = raw.lastAnswer ? redactSecrets(String(raw.lastAnswer)) : null;
  const error = raw.error ? redactSecrets(String(raw.error)) : null;
  const dismissed = Boolean(raw.dismissed);
  const remoteSyncPending = Boolean(raw.remoteSyncPending);
  const remoteSyncStatus = typeof raw.remoteSyncStatus === 'string' ? raw.remoteSyncStatus : (remoteSyncPending ? 'pending' : null);
  const remoteSyncError = raw.remoteSyncError ? redactSecrets(String(raw.remoteSyncError)) : null;
  const requestedRoute = ['auto', 'mcp', 'manual', 'antigravity'].includes(raw.requestedRoute)
    ? raw.requestedRoute
    : 'auto';
  const resolvedRoute = ['mcp', 'manual', 'antigravity'].includes(raw.resolvedRoute)
    ? raw.resolvedRoute
    : 'manual';
  const routeReason = raw.routeReason ? redactSecrets(String(raw.routeReason)).slice(0, 300) : null;
  const routeTransitions = [];
  if (Array.isArray(raw.routeTransitions)) {
    for (const t of raw.routeTransitions.slice(-20)) {
      if (t && typeof t === 'object') {
        routeTransitions.push({
          from: String(t.from || ''),
          to: String(t.to || ''),
          reason: redactSecrets(String(t.reason || '')).slice(0, 300),
          timestamp: typeof t.timestamp === 'string' ? t.timestamp : new Date().toISOString(),
        });
      }
    }
  }

  const remoteSyncedAt = typeof raw.remoteSyncedAt === 'string' ? raw.remoteSyncedAt : null;

  // Sanitize lastEvent if present
  let lastEvent = null;
  if (raw.lastEvent && typeof raw.lastEvent === 'object') {
    lastEvent = {
      stepIndex: Number.isFinite(raw.lastEvent.stepIndex) ? raw.lastEvent.stepIndex : 0,
      type: String(raw.lastEvent.type || 'step'),
      status: raw.lastEvent.status ? String(raw.lastEvent.status) : null,
      createdAt: raw.lastEvent.createdAt ? String(raw.lastEvent.createdAt) : new Date().toISOString(),
      summary: redactSecrets(String(raw.lastEvent.summary || '')).slice(0, 1000),
    };
  }

  // Sanitize recentEvents list (capped at 50 to avoid disk bloat, structured summaries only)
  const recentEvents = [];
  if (Array.isArray(raw.recentEvents)) {
    for (const ev of raw.recentEvents.slice(-50)) {
      if (ev && typeof ev === 'object') {
        recentEvents.push({
          stepIndex: Number.isFinite(ev.stepIndex) ? ev.stepIndex : 0,
          type: String(ev.type || 'step'),
          status: ev.status ? String(ev.status) : null,
          createdAt: ev.createdAt ? String(ev.createdAt) : new Date().toISOString(),
          summary: redactSecrets(String(ev.summary || '')).slice(0, 1000),
        });
      }
    }
  }

  // Sanitize completion summary and checks
  let completion = null;
  if (raw.completion && typeof raw.completion === 'object') {
    completion = {
      status: ['done', 'waiting', 'error'].includes(raw.completion.status) ? raw.completion.status : 'error',
      normalizedStatus: ['completed', 'waiting', 'error'].includes(raw.completion.normalizedStatus) ? raw.completion.normalizedStatus : 'error',
      summary: redactSecrets(String(raw.completion.summary || '')),
      error: raw.completion.error ? redactSecrets(String(raw.completion.error)) : null,
      checks: raw.completion.checks || { build: 'not_run', tests: 'not_run' },
      artifacts: Array.isArray(raw.completion.artifacts) ? raw.completion.artifacts : [],
      interimReason: raw.completion.interimReason ? redactSecrets(String(raw.completion.interimReason)) : null,
    };
  }

  const jobId = typeof raw.jobId === 'string' && raw.jobId.trim() ? raw.jobId.trim() : null;
  const jobIds = Array.isArray(raw.jobIds) ? raw.jobIds.map(String) : (jobId ? [jobId] : []);
  const durableJobEvidence = (raw.durableJobEvidence && typeof raw.durableJobEvidence === 'object')
    ? {
        jobId: String(raw.durableJobEvidence.jobId || ''),
        taskId: raw.durableJobEvidence.taskId || null,
        conversationId: raw.durableJobEvidence.conversationId || null,
        status: raw.durableJobEvidence.status || null,
        exitCode: typeof raw.durableJobEvidence.exitCode === 'number' ? raw.durableJobEvidence.exitCode : null,
        signal: raw.durableJobEvidence.signal || null,
        durationMs: typeof raw.durableJobEvidence.durationMs === 'number' ? raw.durableJobEvidence.durationMs : null,
        stdout: redactSecrets(String(raw.durableJobEvidence.stdout || '')).slice(-65536),
        stderr: redactSecrets(String(raw.durableJobEvidence.stderr || '')).slice(-65536),
        error: raw.durableJobEvidence.error ? redactSecrets(String(raw.durableJobEvidence.error)) : null,
        completedAt: raw.durableJobEvidence.completedAt || null,
      }
    : null;

  return {
    taskId,
    conversationId,
    workspace,
    title,
    source,
    remoteTaskId,
    requestId,
    jobId,
    jobIds,
    durableJobEvidence,
    pendingContinuation: Boolean(raw.pendingContinuation),
    stopRequestedAt: typeof raw.stopRequestedAt === 'string' ? raw.stopRequestedAt : null,
    controllerState: typeof raw.controllerState === 'string' ? raw.controllerState : null,
    continuationJobId: typeof raw.continuationJobId === 'string' ? raw.continuationJobId : null,
    continuationState: ['in_progress', 'completed', 'failed'].includes(raw.continuationState) ? raw.continuationState : null,
    continuationRequestedAt: typeof raw.continuationRequestedAt === 'string' ? raw.continuationRequestedAt : null,
    continuationAttemptId: typeof raw.continuationAttemptId === 'string' ? raw.continuationAttemptId : null,
    continuationOwnerPid: Number.isInteger(raw.continuationOwnerPid) ? raw.continuationOwnerPid : null,
    status,
    createdAt,
    updatedAt,
    lastAnswer,
    error,
    lastEvent,
    recentEvents,
    completion,
    dismissed,
    remoteSyncStatus,
    remoteSyncPending,
    remoteSyncError,
    remoteSyncedAt,
    requestedRoute,
    resolvedRoute,
    routeReason,
    routeTransitions,
  };
};

export class TaskStore {
  /**
   * @param {string | { storagePath: string }} options
   */
  constructor(options) {
    const storagePath = typeof options === 'string' ? options : options?.storagePath;
    if (!storagePath || typeof storagePath !== 'string') {
      throw new Error('storagePath is required for TaskStore');
    }
    this.storagePath = storagePath;
    this.backupPath = `${storagePath}.bak`;
    /** @type {Map<string, object>} */
    this.tasks = new Map();
    this.loaded = false;
    this.continuationDb = null;
  }

  /**
   * Loads persisted task registry from storagePath.
   * If primary storage is corrupted or malformed, attempts recovery from backup.
   * If both fail or are absent, initializes empty safely without throwing unhandled exceptions.
   */
  load() {
    this.tasks.clear();
    let loadedData = null;

    // 1. Try reading primary storage
    if (fs.existsSync(this.storagePath)) {
      try {
        const raw = fs.readFileSync(this.storagePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          loadedData = parsed;
        }
      } catch (err) {
        console.warn(`[TaskStore] Primary store '${this.storagePath}' corrupted: ${err.message}. Trying backup...`);
      }
    }

    // 2. Fall back to backup if primary failed or was unparseable
    if (!loadedData && fs.existsSync(this.backupPath)) {
      try {
        const raw = fs.readFileSync(this.backupPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          loadedData = parsed;
          console.info(`[TaskStore] Successfully restored tasks from backup '${this.backupPath}'`);
        }
      } catch (err) {
        console.warn(`[TaskStore] Backup store '${this.backupPath}' also corrupted: ${err.message}`);
      }
    }

    // 3. Populate memory registry from loaded tasks
    if (loadedData && loadedData.tasks) {
      const taskList = Array.isArray(loadedData.tasks)
        ? loadedData.tasks
        : typeof loadedData.tasks === 'object'
          ? Object.values(loadedData.tasks)
          : [];
      for (const item of taskList) {
        const sanitized = sanitizeTaskForPersistence(item);
        if (sanitized && sanitized.taskId) {
          this.tasks.set(sanitized.taskId, sanitized);
        }
      }
    }

    this.loaded = true;
    return this.tasks;
  }

  /**
   * Persists current memory tasks to disk safely using atomic rename and backup copy.
   */
  save() {
    try {
      const dir = path.dirname(this.storagePath);
      fs.mkdirSync(dir, { recursive: true });

      const payload = {
        schemaVersion: SCHEMA_VERSION,
        updatedAt: new Date().toISOString(),
        tasks: Array.from(this.tasks.values()).map(sanitizeTaskForPersistence),
      };

      const serialized = `${JSON.stringify(payload, null, 2)}\n`;
      const tempPath = `${this.storagePath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // 1. Write to temporary file
      fs.writeFileSync(tempPath, serialized, 'utf8');

      // 2. Update backup copy if primary file exists
      if (fs.existsSync(this.storagePath)) {
        try {
          fs.copyFileSync(this.storagePath, this.backupPath);
        } catch { /* Non-fatal if backup cannot be rotated immediately */ }
      }

      // 3. Atomic rename temp -> primary
      fs.renameSync(tempPath, this.storagePath);
    } catch (err) {
      console.error(`[TaskStore] Failed to save tasks to '${this.storagePath}':`, err.message);
      throw err;
    }
  }

  /**
   * Reconciles tasks upon application startup after crash, restart, or power loss:
   * - Tasks in 'starting' or 'running' MUST NOT be assumed to be running.
   * - They transition strictly to 'recovery_required'.
   * - Preserves existing conversationId, taskId, workspace, and timestamps.
   * - Tasks already in 'done', 'error', 'waiting', 'paused' are kept intact.
   * @returns {{ reconciledCount: number, tasks: object[] }}
   */
  reconcileStartupState() {
    if (!this.loaded) this.load();
    let reconciledCount = 0;

    for (const [taskId, task] of this.tasks.entries()) {
      if (['starting', 'running'].includes(task.status)) {
        task.status = 'recovery_required';
        task.error = 'Process interrupted by application restart or unexpected exit. Manual recovery required.';
        task.updatedAt = new Date().toISOString();
        this.tasks.set(taskId, task);
        reconciledCount++;
      }
    }

    if (reconciledCount > 0) {
      this.save();
    }

    return {
      reconciledCount,
      tasks: Array.from(this.tasks.values()),
    };
  }

  /**
   * Retrieves a task by taskId.
   * @param {string} taskId
   * @returns {object | null}
   */
  getTask(taskId) {
    if (!this.loaded) this.load();
    return this.tasks.get(taskId) || null;
  }

  /**
   * Saves or updates a task in the persistent store.
   * @param {object} task
   * @returns {object} sanitized saved task
   */
  saveTask(task) {
    if (!this.loaded) this.load();
    if (task?.continuationAttemptId) {
      return this._withContinuationTransaction((db) => {
        const owner = db.prepare('SELECT attempt_id, state FROM continuation_claims WHERE task_id = ?').get(task.taskId);
        if (owner?.attempt_id !== task.continuationAttemptId || owner.state !== 'in_progress') {
          throw new Error(`Stale continuation attempt cannot update task '${task.taskId}'.`);
        }
        return this._saveTaskUnchecked(task);
      });
    }
    return this._saveTaskUnchecked(task);
  }

  _saveTaskUnchecked(task) {
    if (task && task.source === 'remote' && (!task.remoteTaskId || typeof task.remoteTaskId !== 'string' || !task.remoteTaskId.trim())) {
      throw new Error(`[TaskStore] Task '${task.taskId}' has source='remote' but is missing required remoteTaskId.`);
    }
    const sanitized = sanitizeTaskForPersistence(task);
    if (!sanitized || !sanitized.taskId) {
      throw new Error('Invalid task payload for TaskStore');
    }
    this.tasks.set(sanitized.taskId, sanitized);
    this.save();
    return sanitized;
  }

  _getContinuationDb() {
    if (this.continuationDb) return this.continuationDb;
    fs.mkdirSync(path.dirname(this.storagePath), { recursive: true });
    const db = new DatabaseSync(`${this.storagePath}.continuations.sqlite`);
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(`CREATE TABLE IF NOT EXISTS continuation_claims (
      task_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, state TEXT NOT NULL,
      attempt_id TEXT NOT NULL, owner_pid INTEGER NOT NULL, phase TEXT NOT NULL,
      child_pid INTEGER, heartbeat_at INTEGER NOT NULL, lease_expires_at INTEGER NOT NULL
    )`);
    this.continuationDb = db;
    return db;
  }

  _withContinuationTransaction(fn) {
    const db = this._getContinuationDb();
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

  static isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; }
    catch (err) { return err.code === 'EPERM'; }
  }

  claimContinuation({ taskId, jobId, evidence }) {
    return this._withContinuationTransaction((db) => {
      this.load();
      const task = this.getTask(taskId);
      if (!task || !task.conversationId || task.stopRequestedAt || ['done', 'error'].includes(task.status)) return null;
      const taskLink = task.jobId === jobId || task.jobIds?.includes(jobId);
      const evidenceLink = evidence?.taskId === taskId && evidence?.jobId === jobId;
      if (!taskLink && (task.jobId || task.jobIds?.length || !evidenceLink)) return null;
      const prior = db.prepare('SELECT * FROM continuation_claims WHERE task_id = ?').get(taskId);
      if (prior?.job_id === jobId && ['completed', 'failed'].includes(prior.state)) return null;
      if (prior?.state === 'in_progress') {
        const ownerAlive = TaskStore.isProcessAlive(prior.owner_pid);
        const childAlive = TaskStore.isProcessAlive(prior.child_pid);
        // Provider input is written only after its child PID is recorded.
        // An absent PID therefore means this attempt could not send a turn.
        if ((ownerAlive && prior.lease_expires_at > Date.now()) || childAlive) return null;
      }
      const attemptId = crypto.randomUUID();
      const now = Date.now();
      db.prepare(`INSERT INTO continuation_claims
        (task_id, job_id, state, attempt_id, owner_pid, phase, child_pid, heartbeat_at, lease_expires_at)
        VALUES (?, ?, 'in_progress', ?, ?, 'claimed', NULL, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET job_id=excluded.job_id, state=excluded.state,
        attempt_id=excluded.attempt_id, owner_pid=excluded.owner_pid, phase=excluded.phase,
        child_pid=NULL, heartbeat_at=excluded.heartbeat_at, lease_expires_at=excluded.lease_expires_at`)
        .run(taskId, jobId, attemptId, process.pid, now, now + 30000);
      task.continuationJobId = jobId;
      task.jobId = jobId;
      task.jobIds = Array.from(new Set([...(task.jobIds || []), jobId]));
      task.continuationAttemptId = attemptId;
      task.continuationOwnerPid = process.pid;
      task.continuationRequestedAt = new Date(now).toISOString();
      task.continuationState = 'in_progress';
      task.pendingContinuation = true;
      task.durableJobEvidence = evidence;
      task.updatedAt = new Date(now).toISOString();
      this._saveTaskUnchecked(task);
      return { task, attemptId };
    });
  }

  isContinuationOwner(taskId, jobId, attemptId) {
    const row = this._getContinuationDb().prepare('SELECT job_id, attempt_id, state FROM continuation_claims WHERE task_id = ?').get(taskId);
    return row?.job_id === jobId && row.attempt_id === attemptId && row.state === 'in_progress';
  }

  updateContinuationOwner(taskId, jobId, attemptId, { phase, childPid } = {}) {
    const now = Date.now();
    const result = this._getContinuationDb().prepare(`UPDATE continuation_claims SET
      phase=COALESCE(?, phase), child_pid=COALESCE(?, child_pid), heartbeat_at=?, lease_expires_at=?
      WHERE task_id=? AND job_id=? AND attempt_id=? AND state='in_progress'`)
      .run(phase || null, Number.isInteger(childPid) ? childPid : null, now, now + 30000, taskId, jobId, attemptId);
    return result.changes === 1;
  }

  finishContinuation({ taskId, jobId, attemptId, state, error = null, resultStatus = null }) {
    return this._withContinuationTransaction((db) => {
      const row = db.prepare('SELECT * FROM continuation_claims WHERE task_id = ?').get(taskId);
      if (row?.job_id !== jobId || row.attempt_id !== attemptId || row.state !== 'in_progress') return false;
      this.load();
      const task = this.getTask(taskId);
      if (!task) return false;
      task.continuationState = state;
      task.continuationAttemptId = null;
      task.continuationOwnerPid = null;
      task.pendingContinuation = false;
      if (['done', 'waiting', 'error'].includes(resultStatus)) task.status = resultStatus;
      if (error) {
        task.status = 'error';
        task.error = redactSecrets(String(error));
      }
      task.updatedAt = new Date().toISOString();
      this._saveTaskUnchecked(task);
      db.prepare('UPDATE continuation_claims SET state=?, heartbeat_at=? WHERE task_id=? AND attempt_id=?')
        .run(state, Date.now(), taskId, attemptId);
      return task;
    });
  }

  /**
   * Lists all tasks sorted by updatedAt descending.
   * @returns {object[]}
   */
  listTasks() {
    if (!this.loaded) this.load();
    return Array.from(this.tasks.values()).sort((a, b) => {
      const tA = new Date(a.updatedAt || a.createdAt).getTime();
      const tB = new Date(b.updatedAt || b.createdAt).getTime();
      return tB - tA;
    });
  }

  /**
   * Finds a task by its remote task linkage (remoteTaskId or requestId).
   * Used as an idempotency / duplicate protection check for bridge dispatches.
   * @param {{ remoteTaskId?: string, requestId?: string }} params
   * @returns {object | null}
   */
  findTaskByRemoteLink({ remoteTaskId, requestId }) {
    if (!this.loaded) this.load();
    for (const task of this.tasks.values()) {
      if (remoteTaskId && task.remoteTaskId === remoteTaskId) {
        return task;
      }
      if (requestId && task.requestId === requestId) {
        return task;
      }
    }
    return null;
  }

  /**
   * Dismisses a task from active recovery UI without deleting its evidence or marking it DONE.
   * @param {string} taskId
   * @returns {object}
   */
  dismissTask(taskId) {
    if (!this.loaded) this.load();
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task '${taskId}' not found in TaskStore.`);
    task.dismissed = true;
    task.updatedAt = new Date().toISOString();
    this.tasks.set(taskId, task);
    this.save();
    return task;
  }

  /**
   * Deletes a task by ID.
   * @param {string} taskId
   * @returns {boolean}
   */
  deleteTask(taskId) {
    if (!this.loaded) this.load();
    const deleted = this.tasks.delete(taskId);
    if (deleted) this.save();
    return deleted;
  }
}
