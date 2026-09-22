import { redactSecrets } from '../security/redact-secrets.mjs';
import { parseXTask } from '../x/task-contract.mjs';

/**
 * Adapter for Project X's `public.tasks` remote transport (Supabase project
 * pavrugcmxdgdxrjinzlm) -- a SEPARATE, parallel transport from the existing
 * `mcp/bridge/client.mjs` HearthBridgeClient (`hearth_tasks`, device-scoped,
 * pending/running/waiting/done/error vocabulary). This adapter is
 * owner/session-scoped and speaks `public.tasks`'s own vocabulary
 * (queued/running/waiting/completed/failed/cancelled).
 *
 * LOCKED against the REAL verified `public.tasks` schema -- there is no
 * `owner_id`, `task`, `payload`, or claim/lease column. Owner is
 * `user_id`; the complete x-task-v1 payload lives at `metadata.x_task`.
 * `title`/`instruction` are human-readable summary fields only and are
 * NEVER treated as X input -- this module never authors, repairs, or
 * synthesizes an x-task-v1 payload from them, and never invents a
 * workspace: `parsePublicXTaskRow` requires `metadata.x_task` to already
 * be a complete, valid x-task-v1 payload and delegates 100% of its
 * structural/contract validation to the existing, unmodified `parseXTask`
 * (mcp/x/task-contract.mjs) -- the exact same validator every other X
 * entry point (x_start, x_enqueue) already uses. Workspace AUTHORITY (does
 * the task's workspace match Hearth's current settings) is deliberately
 * NOT decided here -- see electron/main.cjs's shared X ingress, which is
 * the single place that decision is made for every caller (local and
 * remote alike).
 */

/**
 * Validates one raw `public.tasks` row: must be `queued`, must (if an
 * expected owner is supplied) belong to that owner (`user_id`), and its
 * `metadata.x_task` field must already be a complete, valid x-task-v1
 * payload per the existing contract. Throws on any violation -- never
 * repairs, never fills in a missing field, never substitutes a different
 * workspace, never synthesizes a task from `title`/`instruction`.
 *
 * @param {any} row
 * @param {string} [expectedOwnerId]
 * @returns {{ id: string, ownerId: string|null, status: 'queued', createdAt: string, task: object }}
 */
export const parsePublicXTaskRow = (row, expectedOwnerId) => {
  if (!row || typeof row !== 'object') {
    throw new Error('Malformed public.tasks row: expected an object');
  }

  const { id, user_id, status, created_at, metadata } = row;

  if (!id || typeof id !== 'string') {
    throw new Error('Invalid public.tasks row: missing or invalid id');
  }

  if (expectedOwnerId && user_id !== expectedOwnerId) {
    throw new Error(`Owner mismatch: row '${id}' is owned by '${user_id}', expected '${expectedOwnerId}'`);
  }

  if (status !== 'queued') {
    throw new Error(`Invalid status: expected 'queued', got '${status}'`);
  }

  // No synthesis: title/instruction are summary text only and are NEVER
  // read as X input. metadata.x_task is the ONLY source of the x-task-v1
  // payload, and parseXTask is the sole authority on whether it is
  // complete and well-formed (unknown fields included).
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error(`Invalid public.tasks row '${id}': metadata must be an object`);
  }
  if (!('x_task' in metadata)) {
    throw new Error(`Invalid public.tasks row '${id}': metadata.x_task is required`);
  }
  const xTask = parseXTask(metadata.x_task);

  return {
    id,
    ownerId: typeof user_id === 'string' ? user_id : null,
    status: 'queued',
    createdAt: typeof created_at === 'string' ? created_at : new Date().toISOString(),
    task: xTask,
  };
};

/** Locked, verbatim X-terminal-status -> public.tasks-status mapping. No other classification layer. */
const PUBLIC_TASKS_STATUS_BY_X_STATUS = Object.freeze({
  completed: 'completed',
  needs_review: 'waiting',
  failed: 'failed',
  interrupted: 'waiting',
});

/**
 * Maps a terminal XRunStore status to the public.tasks status vocabulary.
 * Throws for any non-terminal or unrecognized status -- this is a pure,
 * total function over the exact four terminal X statuses, not a fallback
 * classifier.
 * @param {string} xStatus
 * @returns {'completed'|'waiting'|'failed'}
 */
export const mapXStatusToPublicTasksStatus = (xStatus) => {
  const mapped = PUBLIC_TASKS_STATUS_BY_X_STATUS[xStatus];
  if (!mapped) throw new Error(`Cannot map non-terminal or unrecognized X status '${xStatus}' to a public.tasks status.`);
  return mapped;
};

/**
 * `public.tasks.result` is `jsonb`, and x-result-v1 is a structured object
 * (not a string) -- this deep-sanitizes every string leaf of an arbitrary
 * JSON-shaped value with the existing redactSecrets, preserving the
 * object/array structure, rather than ever collapsing it to a single
 * stringified blob. x-result-v1 itself already excludes raw
 * transcript/tool-stream/stdout/stderr (see result-builder.mjs); this only
 * guards against a credential-shaped string slipping through inside one of
 * its text fields (e.g. `error`, `evidence_found`). Bounded depth, matching
 * this codebase's existing "bounded, deterministic" sanitization style.
 */
const MAX_REMOTE_RESULT_SANITIZE_DEPTH = 12;
const sanitizeResultForRemote = (value, depth = 0) => {
  if (depth > MAX_REMOTE_RESULT_SANITIZE_DEPTH) return null;
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeResultForRemote(item, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) out[key] = sanitizeResultForRemote(val, depth + 1);
    return out;
  }
  return value;
};

/**
 * Supabase (Project X) REST client for `public.tasks`. Owner/session-scoped
 * (an authenticated user JWT, never a device_id), speaking native fetch
 * against PostgREST -- same zero-dependency style as HearthBridgeClient,
 * deliberately not sharing its class: the two transports have different
 * scoping (owner vs device), different status vocabularies, and different
 * projects, and conflating them would risk silently mixing the two.
 */
export class PublicTasksClient {
  /**
   * @param {{
   *   supabaseUrl?: string,
   *   supabaseAnonKey?: string,
   *   ownerId?: string | null,
   *   fetchFn?: typeof fetch,
   * }} options
   */
  constructor(options = {}) {
    this.supabaseUrl = (options.supabaseUrl || '').replace(/\/+$/, '');
    this.supabaseAnonKey = options.supabaseAnonKey || '';
    this.ownerId = options.ownerId || null;
    this.accessToken = null;
    this.fetchFn = options.fetchFn || globalThis.fetch;
  }

  /**
   * Updates credentials and the authenticated owner session. Deliberately
   * separate from HearthBridgeClient.setSession -- this project's
   * accessToken/ownerId must never be conflated with the old bridge's.
   * @param {{ accessToken?: string | null, ownerId?: string | null, supabaseUrl?: string, supabaseAnonKey?: string }} session
   */
  setSession(session = {}) {
    if (session.supabaseUrl !== undefined) this.supabaseUrl = (session.supabaseUrl || '').replace(/\/+$/, '');
    if (session.supabaseAnonKey !== undefined) this.supabaseAnonKey = session.supabaseAnonKey || '';
    if (session.accessToken !== undefined) this.accessToken = session.accessToken;
    if (session.ownerId !== undefined) this.ownerId = session.ownerId;
  }

  getHeaders(extra = {}) {
    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json', ...extra };
    if (this.supabaseAnonKey) headers['apikey'] = this.supabaseAnonKey;
    // Owner-scoped rows require a real authenticated user JWT -- unlike the
    // old device-scoped bridge, this client never falls back to the anon
    // key as a bearer token, since the anon key carries no owner identity
    // for row-level security to scope against.
    if (this.accessToken) headers['Authorization'] = `Bearer ${this.accessToken}`;
    return headers;
  }

  _requireReady() {
    if (!this.supabaseUrl) throw new Error('Project X Supabase URL is not configured');
    if (!this.accessToken) throw new Error('Project X requires an authenticated user session (no access token set)');
    if (!this.ownerId) throw new Error('Project X requires a known ownerId (no session set)');
  }

  /**
   * Reads every currently `queued` row owned by the authenticated user.
   * A PURE READ: this method itself never claims, executes, or mutates
   * anything -- polling/observing queued rows must never auto-run X.
   * Malformed or foreign-owner rows are skipped (logged), never thrown for
   * the whole batch, matching HearthBridgeClient.fetchPendingTasks's
   * established resilience pattern.
   * @returns {Promise<Array<ReturnType<typeof parsePublicXTaskRow>>>}
   */
  async fetchQueuedTasks() {
    this._requireReady();
    const url = `${this.supabaseUrl}/rest/v1/tasks?user_id=eq.${encodeURIComponent(this.ownerId)}&status=eq.queued&deleted_at=is.null&order=created_at.asc`;
    const res = await this.fetchFn(url, { method: 'GET', headers: this.getHeaders() });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Failed to fetch queued tasks (${res.status}): ${errText}`);
    }
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    const validTasks = [];
    for (const row of data) {
      try {
        validTasks.push(parsePublicXTaskRow(row, this.ownerId));
      } catch (err) {
        console.warn(`[PublicTasksClient] Skipping invalid queued row ${row?.id}: ${err.message}`);
      }
    }
    return validTasks;
  }

  /**
   * Atomically claims one row: `queued` -> `running`, scoped to this exact
   * id + owner + current `queued` status. Fails safely (claimed: false,
   * never throws for a lost race) if another consumer already claimed it.
   * @param {{ id: string }} params
   * @returns {Promise<{ claimed: boolean, row?: any }>}
   */
  async claimQueuedTask({ id }) {
    this._requireReady();
    if (!id) throw new Error('id is required to claim a queued task');
    // Only status/started_at are set -- there is no claim/lease column, and
    // updated_at/sync_version are owned entirely by the existing DB trigger,
    // never written here. metadata is never included, so metadata.x_task
    // (and any other existing metadata) is preserved untouched.
    const url = `${this.supabaseUrl}/rest/v1/tasks?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(this.ownerId)}&status=eq.queued`;
    const res = await this.fetchFn(url, {
      method: 'PATCH',
      headers: this.getHeaders({ 'Prefer': 'return=representation' }),
      body: JSON.stringify({ status: 'running', started_at: new Date().toISOString() }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Failed to claim queued task (${res.status}): ${errText}`);
    }
    const rows = await res.json();
    if (Array.isArray(rows) && rows.length === 1) return { claimed: true, row: rows[0] };
    // 0 rows updated: another consumer already claimed it, or it's no longer queued.
    return { claimed: false };
  }

  /**
   * Writes a terminal X outcome back onto the SAME public.tasks row, using
   * ONLY the locked X-status -> public.tasks-status mapping. `result` is
   * the full x-result-v1 object (jsonb column) -- deep-sanitized via
   * sanitizeResultForRemote, never collapsed to a stringified blob and
   * never a raw transcript/tool-call stream. `finished_at` is set only for
   * the two truly terminal outcomes (completed/failed); 'waiting'
   * (needs_review/interrupted) leaves it null since the task is not done.
   * updated_at/sync_version are never written here -- the existing DB
   * trigger owns those. metadata (and metadata.x_task) is never included
   * in the body, so it is preserved untouched for correlation/debugging.
   * @param {{ id: string, xStatus: 'completed'|'needs_review'|'failed'|'interrupted', result?: any, error?: string|null }} params
   * @returns {Promise<boolean>}
   */
  async updateTaskFromXRun({ id, xStatus, result, error }) {
    this._requireReady();
    if (!id) throw new Error('id is required to update a task from its X run');
    const status = mapXStatusToPublicTasksStatus(xStatus);
    const body = { status };
    if (status === 'completed' || status === 'failed') body.finished_at = new Date().toISOString();
    if (result !== undefined) body.result = result === null || result === undefined ? null : sanitizeResultForRemote(result);
    if (error !== undefined) body.error = error ? redactSecrets(String(error)) : null;
    const url = `${this.supabaseUrl}/rest/v1/tasks?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(this.ownerId)}`;
    const res = await this.fetchFn(url, {
      method: 'PATCH',
      headers: this.getHeaders({ 'Prefer': 'return=representation' }),
      body: JSON.stringify(body),
    });
    return res.ok;
  }
}

/**
 * In-memory mock fetch transport for tests -- fully simulates the
 * `public.tasks` PostgREST endpoint without any network access, mirroring
 * HearthBridgeClient's own createMockTransport shape exactly (same
 * GET/PATCH/filter semantics) so both bridge adapters are tested the same
 * proven way.
 * @param {Array<any>} [initialRows]
 */
export const createMockPublicTasksTransport = (initialRows = []) => {
  const rows = JSON.parse(JSON.stringify(initialRows));

  const mockFetch = async (urlStr, options = {}) => {
    const url = new URL(urlStr);
    const method = options.method || 'GET';
    if (!url.pathname.endsWith('/tasks')) {
      return { ok: false, status: 404, json: async () => ({ error: 'Not found' }), text: async () => 'Not found' };
    }

    const searchParams = url.searchParams;
    const ownerFilter = searchParams.get('user_id')?.replace(/^eq\./, '');
    const statusFilter = searchParams.get('status')?.replace(/^eq\./, '');
    const idFilter = searchParams.get('id')?.replace(/^eq\./, '');
    const deletedAtFilter = searchParams.get('deleted_at');

    if (method === 'GET') {
      const matched = rows.filter((r) => {
        if (!r || typeof r !== 'object') return false;
        if (ownerFilter && r.user_id !== ownerFilter) return false;
        if (statusFilter && r.status !== statusFilter) return false;
        if (idFilter && r.id !== idFilter) return false;
        if (deletedAtFilter === 'is.null' && r.deleted_at) return false;
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
          updated.push(JSON.parse(JSON.stringify(r)));
        }
      }
      return { ok: true, status: 200, json: async () => updated, text: async () => JSON.stringify(updated) };
    }

    return { ok: false, status: 404, json: async () => ({ error: 'Not found' }), text: async () => 'Not found' };
  };

  return { fetch: mockFetch, rows, getRows: () => rows };
};

