import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const REVIEW_STATUSES = new Set(['needs_review', 'failed', 'interrupted']);
const receiptDigest = (receipts) => crypto.createHash('sha256').update(JSON.stringify(receipts)).digest('hex');
const validQueuePayload = (value) => {
  if (!value || Array.isArray(value) || !Array.isArray(value.entries) || !Array.isArray(value.reviews)) return false;
  if (value.schemaVersion === 1) return value.receipts === undefined;
  if (value.schemaVersion !== 2 || !Array.isArray(value.receipts) || value.receiptDigest !== receiptDigest(value.receipts)) return false;
  const ids = new Set();
  const entryById = new Map(value.entries.filter((entry) => entry && typeof entry.id === 'string').map((entry) => [entry.id, entry]));
  for (const receipt of value.receipts) {
    if (!receipt || typeof receipt.requestId !== 'string' || !receipt.requestId ||
        typeof receipt.queueId !== 'string' || !receipt.queueId || typeof receipt.fingerprint !== 'string' ||
        typeof receipt.workspaceRoot !== 'string' ||
        !['pending', 'dispatching', 'dispatched', 'terminal'].includes(receipt.queueStatus) || ids.has(receipt.requestId)) return false;
    const entry = entryById.get(receipt.queueId);
    if (receipt.queueStatus === 'terminal') {
      if (entry || typeof receipt.runId !== 'string' ||
          !['completed', 'needs_review', 'failed', 'interrupted'].includes(receipt.terminalStatus)) return false;
    } else if (!entry || entry.status !== receipt.queueStatus ||
               (receipt.queueStatus === 'dispatched' ? receipt.runId !== entry.runId : receipt.runId !== null)) return false;
    ids.add(receipt.requestId);
  }
  return true;
};

/**
 * Persistent, JSON-file-backed store for XQueueCoordinator's own bookkeeping
 * ONLY -- mirrors mcp/goals/storage.mjs's GoalStorage exactly (same
 * load/save shape: atomic tmp-file + rename, a .bak copy kept before each
 * overwrite, corrupted-primary falls back to backup on load).
 *
 * This store is authoritative for queue bookkeeping and ingress receipts:
 *  - which already-authored x-task-v1 payloads are waiting to be dispatched
 *    (and, for the one currently being/just dispatched, which runId it
 *    became, once known);
 *  - which terminal runs (needs_review/failed) still need a human's review.
 *  - which request_id values were already accepted, including after an
 *    entry is pruned. Receipts record queue state and a terminal status
 *    snapshot, but never replace XRunStore's execution result truth.
 *
 * It NEVER stores a persisted x-result-v1, gate result, or any other
 * X execution truth -- XRunStore remains the sole authority for that.
 *
 * Queue entry lifecycle is three states, not two, specifically to avoid a
 * crash-consistency gap: pending -> dispatching -> dispatched.
 *   - `dispatching` is persisted BEFORE calling runXTask/x_start, durably
 *     recording *intent* to dispatch ahead of the call that actually claims
 *     X's shared admission slot.
 *   - `dispatched` is only reached after that call has returned an accepted
 *     admission with a real runId.
 *   - `returnToPending` reverts dispatching -> pending only when there is
 *     definitive evidence that execution was not admitted / did not start:
 *     either the dispatch call explicitly reported no_capacity / not
 *     accepted, or Phase B2B startup reconciliation has a durable runId and
 *     proves that XRunStore contains no row for that exact runId (so
 *     createRun never committed). It is never used to paper over an
 *     unknown/ambiguous outcome. It also clears `runId` back to `null`, so
 *     the next dispatch attempt for this entry must generate a fresh runId.
 * A process crash between `dispatching` and `dispatched` therefore leaves
 * the entry stuck in `dispatching`, on purpose: this store never guesses
 * what happened to it (redispatching could double-claim the same task_id;
 * silently reverting to pending could re-run a task that is actually still
 * executing). Resolving a stuck `dispatching` entry requires cross-
 * referencing XRunStore, which is out of scope for this store -- see
 * `XQueueCoordinator.reconcileDispatchingEntry` (Phase B2B). For an entry
 * whose `runId` is still `null` (persisted by the pre-B2B `markDispatching`
 * shape), no such cross-reference is possible at all; it remains
 * permanently unresolvable by any automatic means and is left for human
 * review.
 *
 * A queue entry is pruned (deleted, not archived) the instant its dispatched
 * run reaches ANY terminal outcome; this store has nothing further to say
 * about a run once XQueueCoordinator has reacted to its terminal event once.
 * `markTerminal` therefore only ever deletes an entry that has actually
 * reached `dispatched` -- a `pending` or stuck-`dispatching` entry is never
 * silently discarded this way.
 */
export class XQueueStore {
  /** @param {string | { storagePath: string }} options */
  constructor(options) {
    const storagePath = typeof options === 'string' ? options : options?.storagePath;
    if (!storagePath || typeof storagePath !== 'string') {
      throw new Error('storagePath is required for XQueueStore');
    }
    this.storagePath = storagePath;
    this.backupPath = `${storagePath}.bak`;
    /** @type {Map<string, { id: string, task: object, taskId: string, status: 'pending'|'dispatching'|'dispatched', createdAt: string, dispatchingAt: string|null, dispatchedAt: string|null, runId: string|null }>} */
    this.entries = new Map();
    this.receipts = new Map();
    this.recoveryRequired = false;
    /** @type {Map<string, { runId: string, taskId: string, status: 'needs_review'|'failed', recordedAt: string }>} */
    this.reviews = new Map();
    this.loaded = false;
  }

  /**
   * Loads persisted state from disk. A missing store starts empty; corrupted
   * primary data may fall back to .bak, but then new ingress fails closed. A
   * `dispatching` entry loads exactly as it was persisted -- this method
   * never redispatches, never reverts it to pending, and never invents any
   * recovery of its own; see the class-level note above.
   */
  load() {
    this.entries.clear();
    this.reviews.clear();
    this.receipts.clear();
    let rawData = null;
    let primaryFailed = false;

    if (fs.existsSync(this.storagePath)) {
      try {
        rawData = JSON.parse(fs.readFileSync(this.storagePath, 'utf8'));
        if (!validQueuePayload(rawData)) throw new Error('Invalid queue store structure');
      } catch (err) {
        primaryFailed = true;
        console.warn(`[XQueueStore] Primary store '${this.storagePath}' corrupted: ${err.message}. Trying backup...`);
      }
    }
    if (!fs.existsSync(this.storagePath) && fs.existsSync(this.backupPath)) primaryFailed = true;
    if (!rawData && fs.existsSync(this.backupPath)) {
      primaryFailed = true;
      try {
        rawData = JSON.parse(fs.readFileSync(this.backupPath, 'utf8'));
        if (!validQueuePayload(rawData)) throw new Error('Invalid backup queue store structure');
        console.info(`[XQueueStore] Successfully restored queue from backup '${this.backupPath}'`);
      } catch (err) {
        console.warn(`[XQueueStore] Backup store '${this.backupPath}' also corrupted: ${err.message}`);
      }
    }

    if (rawData) {
      this.recoveryRequired ||= Boolean(rawData.recoveryRequired);
      for (const entry of Array.isArray(rawData.entries) ? rawData.entries : []) {
        if (entry && typeof entry.id === 'string') this.entries.set(entry.id, entry);
      }
      for (const review of Array.isArray(rawData.reviews) ? rawData.reviews : []) {
        if (review && typeof review.runId === 'string') this.reviews.set(review.runId, review);
      }
      for (const receipt of Array.isArray(rawData.receipts) ? rawData.receipts : []) {
        if (receipt && typeof receipt.requestId === 'string') this.receipts.set(receipt.requestId, receipt);
      }
    }
    this.recoveryRequired ||= primaryFailed;
    this.loaded = true;
    return this;
  }

  /** Persists current in-memory state to disk (atomic tmp-file + rename, with a .bak copy of the prior version). */
  save() {
    try {
      const dir = path.dirname(this.storagePath);
      fs.mkdirSync(dir, { recursive: true });
      const payload = {
        schemaVersion: 2,
        updatedAt: new Date().toISOString(),
        entries: Array.from(this.entries.values()),
        reviews: Array.from(this.reviews.values()),
        receipts: Array.from(this.receipts.values()),
        recoveryRequired: this.recoveryRequired,
      };
      payload.receiptDigest = receiptDigest(payload.receipts);
      const serialized = JSON.stringify(payload, null, 2);
      const tempPath = `${this.storagePath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      fs.writeFileSync(tempPath, serialized, 'utf8');
      if (fs.existsSync(this.storagePath)) {
        try { fs.copyFileSync(this.storagePath, this.backupPath); } catch { /* non-fatal */ }
      }
      fs.renameSync(tempPath, this.storagePath);
    } catch (err) {
      console.error(`[XQueueStore] Failed to save queue to ${this.storagePath}:`, err.message);
      throw err;
    }
  }

  /**
   * Adds one already-authored x-task-v1 payload to the pending queue. This
   * store never inspects, validates, or edits `task` beyond reading its
   * `task_id` for bookkeeping -- authoring/validation is entirely the
   * caller's (Chat's) and X's own (parseXTask's) responsibility. Rejects a
   * task with a missing/non-string `task_id` rather than silently enqueuing
   * something the coordinator could never later identify or track.
   * @param {object} task a complete x-task-v1 payload
   * @returns {{id:string, task:object, taskId:string, status:'pending', createdAt:string, dispatchingAt:null, dispatchedAt:null, runId:null}}
   */
  enqueue(task) {
    if (!task || typeof task.task_id !== 'string' || !task.task_id.trim()) {
      throw new TypeError('XQueueStore.enqueue requires task.task_id to be a non-empty string.');
    }
    const id = crypto.randomUUID();
    const entry = {
      id, task, taskId: task.task_id, status: 'pending',
      createdAt: new Date().toISOString(), dispatchingAt: null, dispatchedAt: null, runId: null,
    };
    this.entries.set(id, entry);
    this.save();
    return entry;
  }

  getReceipt(requestId) {
    return this.receipts.get(requestId) ?? null;
  }

  /** Persist a new entry and its idempotency receipt in the same queue-file save. */
  enqueueWithReceipt(task, { requestId, fingerprint, workspaceRoot }) {
    if (this.recoveryRequired) return { error: 'queue_recovery_required' };
    if (!requestId || !fingerprint || !workspaceRoot) throw new TypeError('Receipt identity is required.');
    const prior = this.getReceipt(requestId);
    if (prior) return prior.fingerprint === fingerprint
      ? { receipt: prior, entry: this.entries.get(prior.queueId) ?? null, replayed: true }
      : { error: 'request_id_conflict' };
    if (!task || typeof task.task_id !== 'string' || !task.task_id.trim()) throw new TypeError('A valid task_id is required.');
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const entry = { id, task, taskId: task.task_id, status: 'pending', createdAt, dispatchingAt: null, dispatchedAt: null, runId: null, workspaceRoot };
    const receipt = { requestId, queueId: id, taskId: task.task_id, fingerprint, workspaceRoot, queueStatus: 'pending', runId: null, terminalStatus: null, acceptedAt: createdAt };
    this.entries.set(id, entry);
    this.receipts.set(requestId, receipt);
    try { this.save(); } catch (error) {
      this.entries.delete(id);
      this.receipts.delete(requestId);
      throw error;
    }
    return { entry, receipt, replayed: false };
  }

  _receiptForEntry(id) {
    for (const receipt of this.receipts.values()) if (receipt.queueId === id) return receipt;
    return null;
  }

  /** Returns the oldest still-pending entry (insertion order), or null if none. */
  nextPending() {
    for (const entry of this.entries.values()) {
      if (entry.status === 'pending') return entry;
    }
    return null;
  }

  /** pending -> dispatching ONLY. Requires the caller's own pre-generated runId (Phase B2B), persisted in this SAME atomic transition -- must be called, and persisted, before the caller attempts runXTask/x_start, passing this exact same runId through. */
  markDispatching(id, runId) {
    const entry = this.entries.get(id);
    if (!entry || entry.status !== 'pending') return null;
    if (!runId || typeof runId !== 'string') throw new TypeError('markDispatching requires a real runId.');
    const priorEntry = { ...entry };
    const receipt = this._receiptForEntry(id);
    const priorReceipt = receipt ? { ...receipt } : null;
    entry.status = 'dispatching';
    entry.dispatchingAt = new Date().toISOString();
    entry.runId = runId;
    if (receipt) { receipt.queueStatus = 'dispatching'; receipt.runId = null; }
    try { this.save(); } catch (error) {
      Object.assign(entry, priorEntry);
      if (receipt) Object.assign(receipt, priorReceipt);
      throw error;
    }
    return entry;
  }

  /** dispatching -> dispatched ONLY. Only call once runXTask/x_start has actually returned an accepted admission with a real runId. */
  markDispatched(id, runId) {
    const entry = this.entries.get(id);
    if (!entry || entry.status !== 'dispatching') return null;
    if (!runId || typeof runId !== 'string') throw new TypeError('markDispatched requires a real runId.');
    const priorEntry = { ...entry };
    const receipt = this._receiptForEntry(id);
    const priorReceipt = receipt ? { ...receipt } : null;
    entry.status = 'dispatched';
    entry.dispatchedAt = new Date().toISOString();
    entry.runId = runId;
    if (receipt) { receipt.queueStatus = 'dispatched'; receipt.runId = runId; }
    try { this.save(); } catch (error) {
      Object.assign(entry, priorEntry);
      if (receipt) Object.assign(receipt, priorReceipt);
      throw error;
    }
    return entry;
  }

  /** dispatching -> pending ONLY. Use only when there is definitive evidence execution was not admitted / did not start -- never for an unknown/ambiguous outcome. Clears `runId` back to `null` so the next dispatch attempt for this entry must generate and persist a genuinely fresh, unrelated runId. */
  returnToPending(id) {
    const entry = this.entries.get(id);
    if (!entry || entry.status !== 'dispatching') return null;
    const priorEntry = { ...entry };
    const receipt = this._receiptForEntry(id);
    const priorReceipt = receipt ? { ...receipt } : null;
    entry.status = 'pending';
    entry.dispatchingAt = null;
    entry.runId = null;
    if (receipt) { receipt.queueStatus = 'pending'; receipt.runId = null; }
    try { this.save(); } catch (error) {
      Object.assign(entry, priorEntry);
      if (receipt) Object.assign(receipt, priorReceipt);
      throw error;
    }
    return entry;
  }

  /** Finds the entry currently dispatched as `runId`, if this store is still tracking it as active. */
  findDispatchedByRunId(runId) {
    for (const entry of this.entries.values()) {
      if (entry.status === 'dispatched' && entry.runId === runId) return entry;
    }
    return null;
  }

  /**
   * Read-only lookup: finds the receipt (dispatched OR already-terminal) carrying
   * this exact `runId`, so a caller (Electron's remote-result sync) can recover
   * which durable requestId a terminal X run belongs to. Never mutates queue or
   * receipt state, never changes admission/recovery/fencing behavior. A `runId`
   * with no matching receipt (never dispatched under this store, or the receipt
   * was never persisted with a runId) returns null. Receipts are keyed by
   * requestId and each requestId is only ever accepted once (see
   * `enqueueWithReceipt`), so a given runId can match at most one receipt.
   */
  findReceiptByRunId(runId) {
    if (!runId || typeof runId !== 'string') return null;
    for (const receipt of this.receipts.values()) {
      if (receipt.runId === runId) return receipt;
    }
    return null;
  }

  /** Prunes an entry ONLY once it has actually reached `dispatched` and its run has hit ANY terminal outcome. Never deletes a `pending` or stuck-`dispatching` entry. */
  markTerminal(id, terminalStatus = null) {
    const entry = this.entries.get(id);
    if (!entry || entry.status !== 'dispatched') return false;
    const receipt = this._receiptForEntry(id);
    const priorReceipt = receipt ? { ...receipt } : null;
    if (receipt) {
      if (!['completed', 'needs_review', 'failed', 'interrupted'].includes(terminalStatus)) throw new TypeError('A persisted terminal status is required.');
      receipt.queueStatus = 'terminal';
      receipt.runId = entry.runId;
      receipt.terminalStatus = terminalStatus;
    }
    this.entries.delete(id);
    try { this.save(); } catch (error) {
      this.entries.set(id, entry);
      if (receipt) Object.assign(receipt, priorReceipt);
      throw error;
    }
    return true;
  }

  /** Idempotent upsert keyed by runId: recording the same run's review twice returns the original record unchanged. Only 'needs_review', 'failed', and 'interrupted' are valid review statuses; runId and taskId must both be non-empty strings. */
  recordReview({ runId, taskId, status }) {
    if (!runId || typeof runId !== 'string') {
      throw new TypeError('recordReview requires a non-empty string runId.');
    }
    if (!taskId || typeof taskId !== 'string') {
      throw new TypeError('recordReview requires a non-empty string taskId.');
    }
    if (!REVIEW_STATUSES.has(status)) {
      throw new TypeError(`recordReview only accepts 'needs_review', 'failed', or 'interrupted', got '${status}'.`);
    }
    const existing = this.reviews.get(runId);
    if (existing) return existing;
    const record = { runId, taskId, status, recordedAt: new Date().toISOString() };
    this.reviews.set(runId, record);
    this.save();
    return record;
  }

  hasReview(runId) {
    return this.reviews.has(runId);
  }

  listPending() {
    return Array.from(this.entries.values()).filter((e) => e.status === 'pending');
  }

  listDispatching() {
    return Array.from(this.entries.values()).filter((e) => e.status === 'dispatching');
  }

  listDispatched() {
    return Array.from(this.entries.values()).filter((e) => e.status === 'dispatched');
  }

  listReviews() {
    return Array.from(this.reviews.values());
  }
}
