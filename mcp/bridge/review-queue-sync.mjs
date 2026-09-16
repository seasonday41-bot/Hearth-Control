import { redactSecrets } from '../executors/antigravity.mjs';

/**
 * Remote projection sync for Hearth's local Review Queue (Phase: visibility
 * only). Writes to Project X's `public.review_items` table -- a table
 * DEDICATED to this purpose, never `public.tasks` (a different entity with
 * a different lifecycle; see mcp/bridge/public-tasks-client.mjs's own
 * locked docstring for why that table requires a complete x-task-v1 per
 * row and must never be reused for a notification).
 *
 * LOCKED: this module is write-only from Hearth's perspective. Nothing
 * here (or anywhere else in this pass) ever reads `review_items` back into
 * any local decision -- Goal state, Review Queue local state, X dispatch,
 * approvals, continuation, and recovery are governed ENTIRELY by
 * goal.reviewQueue (see mcp/goals/runner.mjs), never by this remote
 * mirror. A modified, deleted, or forged remote row therefore has zero
 * effect on Hearth: there is no code path that consumes one.
 *
 * Deliberately mirrors mcp/bridge/public-tasks-client.mjs's own
 * session/auth shape (constructor -> setSession -> getHeaders ->
 * _requireReady) rather than sharing its class, since ReviewItemsClient
 * targets a structurally different table/entity -- exactly the same
 * reasoning that class's own docstring gives for not sharing
 * HearthBridgeClient's class.
 */

const MAX_SANITIZE_DEPTH = 12;

/**
 * Deep-sanitizes an arbitrary JSON-shaped value for a remote write, exactly
 * mirroring public-tasks-client.mjs's own sanitizeResultForRemote (a
 * separate, small copy -- not imported -- since that helper is private to
 * a deliberately different entity's module and this is the same simple,
 * bounded-depth, string-leaf-redaction shape, not new logic).
 */
const sanitizeForRemote = (value, depth = 0) => {
  if (depth > MAX_SANITIZE_DEPTH) return null;
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
 * Projects one local Review Queue item (see mcp/goals/model.mjs's
 * createReviewQueueItem / mcp/goals/runner.mjs's list_review_queue) into
 * the exact public.review_items row shape. `id` is the item's own
 * idempotencyKey verbatim -- never re-derived -- so a retried/replayed
 * sync always targets the SAME remote row. Reference-only: no transcript,
 * chain-of-thought, secrets, or model prompt exists in the source item to
 * begin with (see createReviewQueueItem's own docstring), and every string
 * leaf is redacted again here as defense in depth, matching this
 * codebase's established remote-write discipline.
 *
 * @param {object} item a Review Queue item as returned by
 *   GoalRunner.list_review_queue() (carries goalId/goalTitle already) or
 *   a bare item plus an explicit { goalId, goalTitle }.
 * @param {{ goalId?: string, goalTitle?: string }} [context]
 * @returns {object} a plain object matching public.review_items' columns
 */
export const projectReviewItemForRemote = (item, context = {}) => {
  if (!item || typeof item !== 'object') throw new Error('projectReviewItemForRemote requires a review item');
  if (!item.idempotencyKey || typeof item.idempotencyKey !== 'string') {
    throw new Error('projectReviewItemForRemote requires item.idempotencyKey');
  }
  return {
    id: item.idempotencyKey,
    goal_id: context.goalId ?? item.goalId ?? null,
    goal_title: context.goalTitle ?? item.goalTitle ?? null,
    step_id: item.stepId ?? null,
    task_id: item.taskId ?? null,
    run_id: item.runId ?? null,
    result_id: item.resultId ?? null,
    status: item.status,
    reason: typeof item.reason === 'string' ? redactSecrets(item.reason) : null,
    evidence: sanitizeForRemote(item.evidence ?? {}),
    local_created_at: item.createdAt ?? null,
    local_updated_at: item.updatedAt ?? null,
  };
};

/**
 * Thin PostgREST client for `public.review_items`, session-compatible with
 * (and intended to share the SAME session as) Project X's existing
 * PublicTasksClient -- same Supabase project, same authenticated owner,
 * different table.
 */
export class ReviewItemsClient {
  /**
   * @param {{ supabaseUrl?: string, supabaseAnonKey?: string, ownerId?: string | null, fetchFn?: typeof fetch }} options
   */
  constructor(options = {}) {
    this.supabaseUrl = (options.supabaseUrl || '').replace(/\/+$/, '');
    this.supabaseAnonKey = options.supabaseAnonKey || '';
    this.ownerId = options.ownerId || null;
    this.accessToken = null;
    this.fetchFn = options.fetchFn || globalThis.fetch;
  }

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
   * Idempotent upsert by primary key (`id` = the local idempotencyKey).
   * `user_id` is stamped from the authenticated session's ownerId, never
   * trusted from the caller. A retried/replayed call with the SAME
   * payload converges on the SAME single row -- PostgREST's own
   * merge-duplicates resolution, not application-level dedup.
   * @param {ReturnType<typeof projectReviewItemForRemote>} payload
   * @returns {Promise<boolean>}
   */
  async upsertReviewItem(payload) {
    this._requireReady();
    if (!payload?.id) throw new Error('upsertReviewItem requires payload.id');
    const url = `${this.supabaseUrl}/rest/v1/review_items?on_conflict=id`;
    const res = await this.fetchFn(url, {
      method: 'POST',
      headers: this.getHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify({ ...payload, user_id: this.ownerId }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Failed to upsert review item (${res.status}): ${errText}`);
    }
    return true;
  }
}

/**
 * Best-effort sync of ONE local Review Queue item to its remote row.
 * NEVER throws (a caller wired as a fire-and-forget hook must never see an
 * exception), NEVER mutates the local item it was given, and never
 * touches Goal/X/Anti state -- a failure is only ever logged, to be
 * retried later by resyncPendingReviewItems. Returns true/false for
 * observability only; callers must not branch Goal behavior on it.
 * @param {{ client: ReviewItemsClient | null, item: object, goalId?: string, goalTitle?: string }} params
 * @returns {Promise<boolean>}
 */
export const syncReviewItemToRemote = async ({ client, item, goalId, goalTitle }) => {
  if (!client) return false;
  try {
    const payload = projectReviewItemForRemote(item, { goalId, goalTitle });
    await client.upsertReviewItem(payload);
    return true;
  } catch (err) {
    console.warn(`[ReviewQueueSync] Failed to sync review item '${item?.id}' (will retry on reconnect):`, err.message);
    return false;
  }
};

/**
 * Reconciliation sweep: resyncs every durable local Review Queue item
 * across every Goal -- safe to call repeatedly (startup, reconnect,
 * sign-in), since each call is just a fresh set of idempotent upserts.
 * A pure read of local state (`goalRunner.list_review_queue()`) followed
 * by best-effort remote writes; never mutates local state, never throws.
 * @param {{ client: ReviewItemsClient | null, goalRunner: { list_review_queue: Function } | null }} params
 * @returns {Promise<{ attempted: number, succeeded: number }>}
 */
export const resyncPendingReviewItems = async ({ client, goalRunner }) => {
  if (!client || !goalRunner) return { attempted: 0, succeeded: 0 };
  let items;
  try { items = goalRunner.list_review_queue(); } catch { return { attempted: 0, succeeded: 0 }; }
  let succeeded = 0;
  for (const item of items) {
    const ok = await syncReviewItemToRemote({ client, item, goalId: item.goalId, goalTitle: item.goalTitle });
    if (ok) succeeded += 1;
  }
  return { attempted: items.length, succeeded };
};
