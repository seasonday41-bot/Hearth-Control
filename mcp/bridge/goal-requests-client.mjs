import { redactSecrets } from '../executors/antigravity.mjs';
import { parseXTask } from '../x/task-contract.mjs';

/**
 * Adapter for Project X's `public.goal_requests` remote transport (Supabase
 * project pavrugcmxdgdxrjinzlm) -- a DEDICATED table, separate from
 * `public.tasks` (which remains ONE ROW = ONE complete x-task-v1, unchanged
 * by this module) and separate from `public.review_items` (outbound
 * projection only). This is the inbound half of remote Goal ingress: Chat/
 * Main Brain authors a COMPLETE multi-step Goal snapshot and queues it here;
 * Hearth never synthesizes, repairs, reorders, or invents any part of it.
 *
 * Owner/session-scoped exactly like PublicTasksClient (an authenticated user
 * JWT, never a device_id, never service_role) -- deliberately reuses the
 * SAME Project X session (publicTasksSession in electron/main.cjs) rather
 * than inventing a third auth surface, since this is the same Supabase
 * project as public.tasks.
 *
 * LOCKED: a row's mere existence, or its `status`, is NEVER local execution
 * authority. Claiming a row (queued -> running) only means "this specific
 * row is now imported as a local Goal, in 'ready' state" -- it does NOT run
 * anything and does NOT grant X approval. The existing, unmodified Goal-
 * level X approval mechanism (electron/main.cjs's resolveGoalXApproval) is
 * the only thing that can ever authorize an X step to actually dispatch.
 */

export const REMOTE_GOAL_VERSION = 'remote-goal-v1';

/** Same vocabulary public.tasks already uses -- see public-tasks-client.mjs's header comment. */
export const GOAL_REQUEST_STATUSES = Object.freeze(['queued', 'running', 'waiting', 'completed', 'failed', 'cancelled']);

/** Locked, verbatim local Goal-status -> goal_requests-status mapping. No other classification layer. */
const GOAL_REQUEST_STATUS_BY_GOAL_STATUS = Object.freeze({
  draft: 'queued',
  ready: 'running',
  running: 'running',
  paused: 'running',
  waiting: 'waiting',
  error: 'failed',
  completed: 'completed',
});

/**
 * Maps a local Goal's status to the goal_requests status vocabulary. Pure
 * and total over every known GOAL_STATUSES value.
 * @param {string} goalStatus
 * @returns {'queued'|'running'|'waiting'|'completed'|'failed'}
 */
export const mapGoalStatusToRequestStatus = (goalStatus) => {
  const mapped = GOAL_REQUEST_STATUS_BY_GOAL_STATUS[goalStatus];
  if (!mapped) throw new Error(`Cannot map unrecognized Goal status '${goalStatus}' to a goal_requests status.`);
  return mapped;
};

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === 'string' && Boolean(value.trim());

/**
 * Validates one step of a remote-goal-v1 payload against the SAME rules the
 * local Goal model (mcp/goals/model.mjs's STEP_ROUTES/validateStep) already
 * enforces for route -- but here, structurally, BEFORE it ever reaches
 * create_goal(): route:"x" requires a complete x-task-v1 (validated via the
 * real, unmodified parseXTask -- the exact same authority every other X
 * entry point uses), route:"manual" carries no xTask, and NOTHING is ever
 * invented from title/description for either.
 * @param {any} rawStep
 * @param {number} index
 * @returns {{id: string, title: string, route: 'x'|'manual', xTask: object|null}}
 */
const parseRemoteGoalStep = (rawStep, index) => {
  if (!isPlainObject(rawStep)) throw new Error(`steps[${index}] must be an object`);
  if (!isNonEmptyString(rawStep.id)) throw new Error(`steps[${index}].id must be a non-empty string`);
  if (!isNonEmptyString(rawStep.title)) throw new Error(`steps[${index}].title must be a non-empty string`);
  if (rawStep.route !== 'x' && rawStep.route !== 'manual') {
    throw new Error(`steps[${index}].route must be "x" or "manual"`);
  }
  let xTask = null;
  if (rawStep.route === 'x') {
    if (!isPlainObject(rawStep.xTask)) {
      throw new Error(`steps[${index}] has route "x" but no complete xTask; a full x-task-v1 payload is required`);
    }
    // The sole authority on validity -- never repaired, never filled in.
    xTask = parseXTask(rawStep.xTask);
  }
  return { id: rawStep.id.trim().slice(0, 200), title: rawStep.title.trim().slice(0, 200), route: rawStep.route, xTask };
};

/**
 * Validates a COMPLETE remote-goal-v1 payload (the `goal` jsonb column's
 * content). Structural/contract validation only -- workspace AUTHORITY
 * (does this Goal's workspace match Hearth's currently configured
 * workspace) is deliberately NOT decided here, same separation of concerns
 * as public-tasks-client.mjs's parsePublicXTaskRow: see electron/main.cjs's
 * approveRemoteGoalRequest, the single place that decision is made.
 * @param {any} payload
 * @returns {{title: string, objective: string, workspace: string, constraints: string[], steps: Array<{id:string,title:string,route:string,xTask:object|null}>}}
 */
export const parseRemoteGoalPayload = (payload) => {
  if (!isPlainObject(payload)) throw new Error('goal payload must be an object');
  if (payload.version !== REMOTE_GOAL_VERSION) throw new Error(`goal.version must equal ${REMOTE_GOAL_VERSION}`);
  if (!isNonEmptyString(payload.title)) throw new Error('goal.title must be a non-empty string');
  if (!isNonEmptyString(payload.objective)) throw new Error('goal.objective must be a non-empty string');
  if (!isNonEmptyString(payload.workspace)) throw new Error('goal.workspace must be a non-empty string');
  const constraints = Array.isArray(payload.constraints)
    ? payload.constraints.map((c) => { if (typeof c !== 'string') throw new Error('goal.constraints must contain only strings'); return c.trim().slice(0, 200); })
    : [];
  if (!Array.isArray(payload.steps) || payload.steps.length === 0) {
    throw new Error('goal.steps must be a non-empty array -- Hearth never invents Goal steps');
  }
  const workspace = payload.workspace.trim();
  const steps = payload.steps.map((step, index) => parseRemoteGoalStep(step, index));
  // Every route:"x" step's own xTask.workspace.root must agree with the
  // Goal's own declared workspace -- an internally inconsistent payload is
  // rejected outright, never silently reconciled to one or the other.
  for (const [index, step] of steps.entries()) {
    if (step.xTask && step.xTask.workspace?.root !== workspace) {
      throw new Error(`steps[${index}].xTask.workspace.root must match goal.workspace exactly`);
    }
  }
  const ids = new Set();
  for (const [index, step] of steps.entries()) {
    if (ids.has(step.id)) throw new Error(`steps[${index}].id '${step.id}' is duplicated -- step ids must be unique`);
    ids.add(step.id);
  }
  return { title: payload.title.trim().slice(0, 200), objective: payload.objective.trim().slice(0, 4000), workspace, constraints, steps };
};

/**
 * Validates one raw `public.goal_requests` row: must have the expected
 * status (`queued` by default; `running` when re-reading a row this SAME
 * client already claimed but never finished importing -- see
 * fetchClaimedUnimportedGoalRequests), must (if an expected owner is
 * supplied) belong to that owner, and its `goal` column must already be a
 * complete, valid remote-goal-v1 payload.
 * @param {any} row
 * @param {string} [expectedOwnerId]
 * @param {string} [expectedStatus]
 * @returns {{id: string, ownerId: string|null, title: string, createdAt: string, goal: ReturnType<typeof parseRemoteGoalPayload>}}
 */
export const parseGoalRequestRow = (row, expectedOwnerId, expectedStatus = 'queued') => {
  if (!row || typeof row !== 'object') throw new Error('Malformed goal_requests row: expected an object');
  const { id, user_id, status, title, goal, created_at } = row;
  if (!isNonEmptyString(id)) throw new Error('Invalid goal_requests row: missing or invalid id');
  if (expectedOwnerId && user_id !== expectedOwnerId) {
    throw new Error(`Owner mismatch: row '${id}' is owned by '${user_id}', expected '${expectedOwnerId}'`);
  }
  if (status !== expectedStatus) throw new Error(`Invalid status: expected '${expectedStatus}', got '${status}'`);
  const parsedGoal = parseRemoteGoalPayload(goal);
  return {
    id,
    ownerId: typeof user_id === 'string' ? user_id : null,
    title: isNonEmptyString(title) ? title.trim().slice(0, 200) : parsedGoal.title,
    createdAt: typeof created_at === 'string' ? created_at : new Date().toISOString(),
    goal: parsedGoal,
  };
};

const MAX_REMOTE_PROJECTION_DEPTH = 12;
const sanitizeForRemote = (value, depth = 0) => {
  if (depth > MAX_REMOTE_PROJECTION_DEPTH) return null;
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeForRemote(item, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) out[key] = sanitizeForRemote(val, depth + 1);
    return out;
  }
  return value;
};

/**
 * Builds the compact, sanitized progress/result projection for a local Goal
 * -- never a raw transcript, never a full x-result-v1 dump per step. This is
 * the ONLY shape ever written to a goal_requests row's `result` column,
 * whether the Goal is mid-run or terminal.
 * @param {object} goal
 * @returns {object}
 */
export const projectGoalStateForRemote = (goal) => {
  const totalSteps = goal.steps.length;
  const completedSteps = goal.steps.filter((s) => s.status === 'completed').length;
  const reviewOpen = (goal.reviewQueue || []).some((item) => ['open', 'acknowledged'].includes(item.lifecycle));
  return sanitizeForRemote({
    local_goal_id: goal.id,
    goal_status: goal.status,
    current_step_id: goal.status === 'completed' ? null : (goal.currentStepId ?? null),
    completed_steps: completedSteps,
    total_steps: totalSteps,
    review_open: reviewOpen,
    step_statuses: goal.steps.map((s) => ({ id: s.id, title: s.title, status: s.status, route: s.route, summary: s.result || null })),
    updated_at: goal.updatedAt,
  });
};

/**
 * Supabase (Project X) REST client for `public.goal_requests`. Deliberately
 * its own class rather than sharing PublicTasksClient's: different table,
 * different payload shape, different claim/write vocabulary -- conflating
 * them would risk silently mixing the two transports.
 */
export class GoalRequestsClient {
  /**
   * @param {{ supabaseUrl?: string, supabaseAnonKey?: string, ownerId?: string|null, fetchFn?: typeof fetch }} options
   */
  constructor(options = {}) {
    this.supabaseUrl = (options.supabaseUrl || '').replace(/\/+$/, '');
    this.supabaseAnonKey = options.supabaseAnonKey || '';
    this.ownerId = options.ownerId || null;
    this.accessToken = null;
    this.fetchFn = options.fetchFn || globalThis.fetch;
  }

  /** Deliberately separate from every other client's setSession -- see PublicTasksClient's own note. */
  setSession(session = {}) {
    if (session.supabaseUrl !== undefined) this.supabaseUrl = (session.supabaseUrl || '').replace(/\/+$/, '');
    if (session.supabaseAnonKey !== undefined) this.supabaseAnonKey = session.supabaseAnonKey || '';
    if (session.accessToken !== undefined) this.accessToken = session.accessToken;
    if (session.ownerId !== undefined) this.ownerId = session.ownerId;
  }

  getHeaders(extra = {}) {
    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json', ...extra };
    if (this.supabaseAnonKey) headers['apikey'] = this.supabaseAnonKey;
    if (this.accessToken) headers['Authorization'] = `Bearer ${this.accessToken}`;
    return headers;
  }

  _requireReady() {
    if (!this.supabaseUrl) throw new Error('Project X Supabase URL is not configured');
    if (!this.accessToken) throw new Error('Project X requires an authenticated user session (no access token set)');
    if (!this.ownerId) throw new Error('Project X requires a known ownerId (no session set)');
  }

  /**
   * A PURE read: never claims, executes, or mutates anything. Malformed or
   * foreign-owner rows are skipped (logged), never thrown for the whole
   * batch.
   * @returns {Promise<Array<ReturnType<typeof parseGoalRequestRow>>>}
   */
  async fetchQueuedGoalRequests() {
    this._requireReady();
    const url = `${this.supabaseUrl}/rest/v1/goal_requests?user_id=eq.${encodeURIComponent(this.ownerId)}&status=eq.queued&deleted_at=is.null&order=created_at.asc`;
    const res = await this.fetchFn(url, { method: 'GET', headers: this.getHeaders() });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Failed to fetch queued goal requests (${res.status}): ${errText}`);
    }
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    const valid = [];
    for (const row of data) {
      try { valid.push(parseGoalRequestRow(row, this.ownerId)); }
      catch (err) { console.warn(`[GoalRequestsClient] Skipping invalid queued row ${row?.id}: ${err.message}`); }
    }
    return valid;
  }

  /**
   * Recovery read: rows this owner already claimed (`running`) but that
   * never got a local_goal_id written back -- i.e. Hearth crashed or was
   * killed strictly between a successful claim and finishing the local
   * import. A PURE read, same shape as fetchQueuedGoalRequests. The row's
   * own `goal` payload is still the original, untouched snapshot (claiming
   * only ever changes `status`/`started_at`), so re-reading it here to
   * finish an interrupted import is safe and does not violate "a claimed
   * row is read once as a Goal source" -- that rule is about a row whose
   * import already SUCCEEDED, not one still stuck mid-import.
   * @returns {Promise<Array<ReturnType<typeof parseGoalRequestRow>>>}
   */
  async fetchClaimedUnimportedGoalRequests() {
    this._requireReady();
    const url = `${this.supabaseUrl}/rest/v1/goal_requests?user_id=eq.${encodeURIComponent(this.ownerId)}&status=eq.running&local_goal_id=is.null&order=created_at.asc`;
    const res = await this.fetchFn(url, { method: 'GET', headers: this.getHeaders() });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Failed to fetch claimed-unimported goal requests (${res.status}): ${errText}`);
    }
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    const valid = [];
    for (const row of data) {
      try { valid.push(parseGoalRequestRow(row, this.ownerId, 'running')); }
      catch (err) { console.warn(`[GoalRequestsClient] Skipping invalid claimed-unimported row ${row?.id}: ${err.message}`); }
    }
    return valid;
  }

  /**
   * Atomically claims one row: `queued` -> `running`, scoped to this exact
   * id + owner + current `queued` status. Fails safely (claimed: false,
   * never throws for a lost race) if another consumer already claimed it --
   * this is the ONLY write this client ever makes based on row `status`
   * alone; every other write is a projection of already-decided local truth.
   * @param {{ id: string }} params
   */
  async claimQueuedGoalRequest({ id }) {
    this._requireReady();
    if (!id) throw new Error('id is required to claim a queued goal request');
    const url = `${this.supabaseUrl}/rest/v1/goal_requests?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(this.ownerId)}&status=eq.queued`;
    const res = await this.fetchFn(url, {
      method: 'PATCH',
      headers: this.getHeaders({ 'Prefer': 'return=representation' }),
      body: JSON.stringify({ status: 'running', started_at: new Date().toISOString() }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Failed to claim queued goal request (${res.status}): ${errText}`);
    }
    const rows = await res.json();
    if (Array.isArray(rows) && rows.length === 1) return { claimed: true, row: rows[0] };
    return { claimed: false };
  }

  /**
   * Rejects a still-`queued` row (`queued` -> `cancelled`). Never claims,
   * never touches an already-claimed row.
   * @param {{ id: string }} params
   */
  async rejectQueuedGoalRequest({ id }) {
    this._requireReady();
    if (!id) throw new Error('id is required to reject a queued goal request');
    const url = `${this.supabaseUrl}/rest/v1/goal_requests?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(this.ownerId)}&status=eq.queued`;
    const res = await this.fetchFn(url, {
      method: 'PATCH',
      headers: this.getHeaders({ 'Prefer': 'return=representation' }),
      body: JSON.stringify({ status: 'cancelled' }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Failed to reject goal request (${res.status}): ${errText}`);
    }
    const rows = await res.json();
    return Array.isArray(rows) && rows.length > 0;
  }

  /**
   * Records that a claimed row has been imported as a local Goal --
   * unconditional PATCH by id, never gated on status (the row is already
   * `running`; this only adds local_goal_id).
   * @param {{ id: string, localGoalId: string }} params
   */
  async recordLocalGoalId({ id, localGoalId }) {
    this._requireReady();
    if (!id || !localGoalId) throw new Error('id and localGoalId are required');
    const url = `${this.supabaseUrl}/rest/v1/goal_requests?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(this.ownerId)}`;
    const res = await this.fetchFn(url, {
      method: 'PATCH',
      headers: this.getHeaders({ 'Prefer': 'return=minimal' }),
      body: JSON.stringify({ local_goal_id: localGoalId }),
    });
    return res.ok;
  }

  /**
   * Writes the current durable projection of a local Goal onto its row --
   * unconditional PATCH by id, safe to call repeatedly (idempotent by
   * construction: always overwrites with current local truth, never
   * accumulates). Never claims, never reruns anything, never fails the
   * caller into retrying Goal/X work -- callers treat a false return the
   * same way syncTerminalReceiptToPublicTasks does (log and retry later).
   * @param {{ id: string, goal: object }} params
   * @returns {Promise<boolean>}
   */
  async projectGoalState({ id, goal }) {
    this._requireReady();
    if (!id) throw new Error('id is required');
    const status = mapGoalStatusToRequestStatus(goal.status);
    const body = {
      status,
      result: projectGoalStateForRemote(goal),
      error: goal.error ? redactSecrets(String(goal.error)) : null,
      finished_at: (status === 'completed' || status === 'failed')
        ? (goal.finishedAt || new Date().toISOString())
        : null,
    };
    const url = `${this.supabaseUrl}/rest/v1/goal_requests?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(this.ownerId)}`;
    const res = await this.fetchFn(url, {
      method: 'PATCH',
      headers: this.getHeaders({ 'Prefer': 'return=minimal' }),
      body: JSON.stringify(body),
    });
    return res.ok;
  }

  /** Marks a claimed row failed with an error, e.g. when import itself fails before any Goal is created. */
  async markGoalRequestFailed({ id, error }) {
    this._requireReady();
    if (!id) throw new Error('id is required');
    const url = `${this.supabaseUrl}/rest/v1/goal_requests?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(this.ownerId)}`;
    const res = await this.fetchFn(url, {
      method: 'PATCH',
      headers: this.getHeaders({ 'Prefer': 'return=minimal' }),
      body: JSON.stringify({ status: 'failed', error: error ? redactSecrets(String(error)) : null, finished_at: new Date().toISOString() }),
    });
    return res.ok;
  }
}

/**
 * In-memory mock fetch transport for tests -- mirrors PublicTasksClient's
 * createMockPublicTasksTransport exactly (same GET/PATCH/filter semantics).
 * @param {Array<any>} [initialRows]
 */
export const createMockGoalRequestsTransport = (initialRows = []) => {
  const rows = JSON.parse(JSON.stringify(initialRows));

  const mockFetch = async (urlStr, options = {}) => {
    const url = new URL(urlStr);
    const method = options.method || 'GET';
    if (!url.pathname.endsWith('/goal_requests')) {
      return { ok: false, status: 404, json: async () => ({ error: 'Not found' }), text: async () => 'Not found' };
    }
    const searchParams = url.searchParams;
    const ownerFilter = searchParams.get('user_id')?.replace(/^eq\./, '');
    const statusFilter = searchParams.get('status')?.replace(/^eq\./, '');
    const idFilter = searchParams.get('id')?.replace(/^eq\./, '');
    const deletedAtFilter = searchParams.get('deleted_at');
    const localGoalIdFilter = searchParams.get('local_goal_id');

    if (method === 'GET') {
      const matched = rows.filter((r) => {
        if (!r || typeof r !== 'object') return false;
        if (ownerFilter && r.user_id !== ownerFilter) return false;
        if (statusFilter && r.status !== statusFilter) return false;
        if (idFilter && r.id !== idFilter) return false;
        if (deletedAtFilter === 'is.null' && r.deleted_at) return false;
        if (localGoalIdFilter === 'is.null' && r.local_goal_id) return false;
        return true;
      });
      return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(matched)), text: async () => JSON.stringify(matched) };
    }

    if (method === 'PATCH') {
      const body = JSON.parse(options.body || '{}');
      const updated = [];
      for (const r of rows) {
        let match = true;
        if (idFilter && r.id !== idFilter) match = false;
        if (ownerFilter && r.user_id !== ownerFilter) match = false;
        if (statusFilter && r.status !== statusFilter) match = false;
        if (match) {
          Object.assign(r, body);
          r.sync_version = (r.sync_version || 1) + 1;
          updated.push(JSON.parse(JSON.stringify(r)));
        }
      }
      return { ok: true, status: 200, json: async () => updated, text: async () => JSON.stringify(updated) };
    }

    return { ok: false, status: 404, json: async () => ({ error: 'Not found' }), text: async () => 'Not found' };
  };

  return { fetch: mockFetch, rows, getRows: () => rows };
};
