import { redactSecrets, MAX_PAYLOAD_BYTES } from '../executors/antigravity.mjs';

/**
 * Validates and sanitizes a raw remote task row from Supabase.
 * Strips any injection of workspace, command, executor, or filesystem paths.
 * Enforces 64 KiB byte limit.
 *
 * @param {any} row
 * @param {string} expectedDeviceId
 * @returns {{ id: string, deviceId: string, source: string, title: string, prompt: string, status: string, createdAt: string, requestId?: string | null }}
 */
export const parseRemoteTaskPayload = (row, expectedDeviceId) => {
  if (!row || typeof row !== 'object') {
    throw new Error('Malformed task payload: expected an object');
  }

  const { id, device_id, prompt, title, status, source, created_at, request_id } = row;

  if (!id || typeof id !== 'string') {
    throw new Error('Invalid task payload: missing or invalid id');
  }

  if (device_id !== expectedDeviceId) {
    throw new Error(`Device mismatch: task is addressed to '${device_id}', expected '${expectedDeviceId}'`);
  }

  if (status !== 'pending') {
    throw new Error(`Invalid status: expected 'pending', got '${status}'`);
  }

  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('Task prompt must be a non-empty string');
  }

  const promptBytes = Buffer.byteLength(prompt, 'utf8');
  if (promptBytes > MAX_PAYLOAD_BYTES) {
    throw new Error(`Task prompt exceeds maximum 64 KiB limit (${promptBytes} bytes)`);
  }

  // Strict payload extraction: intentionally omit workspace, command, or other fields
  let metadata = {};
  if (row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)) {
    metadata = { ...row.metadata };
  } else if (typeof row.metadata === 'string') {
    try {
      const parsed = JSON.parse(row.metadata);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        metadata = parsed;
      }
    } catch {}
  }

  return {
    id,
    deviceId: device_id,
    source: typeof source === 'string' ? source : 'chatgpt',
    title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 200) : 'Remote Task',
    prompt: prompt.trim(),
    status: 'pending',
    createdAt: created_at || new Date().toISOString(),
    requestId: typeof request_id === 'string' ? request_id : null,
    metadata,
  };
};

/**
 * Supabase REST Bridge Client
 * Communicates with Supabase PostgREST endpoints using native fetch (Zero external dependencies).
 */
export class HearthBridgeClient {
  /**
   * @param {{
   *   supabaseUrl?: string,
   *   supabaseAnonKey?: string,
   *   deviceId: string,
   *   fetchFn?: typeof fetch,
   *   pollIntervalMs?: number,
   * }} options
   */
  constructor(options) {
    if (!options?.deviceId) throw new Error('deviceId is required for HearthBridgeClient');
    this.supabaseUrl = (options.supabaseUrl || '').replace(/\/+$/, '');
    this.supabaseAnonKey = options.supabaseAnonKey || '';
    this.deviceId = options.deviceId;
    this.fetchFn = options.fetchFn || globalThis.fetch;
    this.pollIntervalMs = options.pollIntervalMs || 5000;

    this.accessToken = null;
    this.ownerId = null;
    this.pollTimer = null;
    this.isPolling = false;
    this.enabled = false;
  }

  /**
   * Updates credentials and auth session.
   * @param {{ accessToken?: string | null, ownerId?: string | null, supabaseUrl?: string, supabaseAnonKey?: string }} session
   */
  setSession(session) {
    if (session.supabaseUrl !== undefined) this.supabaseUrl = (session.supabaseUrl || '').replace(/\/+$/, '');
    if (session.supabaseAnonKey !== undefined) this.supabaseAnonKey = session.supabaseAnonKey || '';
    if (session.accessToken !== undefined) this.accessToken = session.accessToken;
    if (session.ownerId !== undefined) this.ownerId = session.ownerId;
  }

  /**
   * Helper to build standard PostgREST headers with JWT authorization.
   * @param {Record<string, string>} [extra]
   */
  getHeaders(extra = {}) {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...extra,
    };
    if (this.supabaseAnonKey) {
      headers['apikey'] = this.supabaseAnonKey;
    }
    if (this.accessToken) {
      headers['Authorization'] = `Bearer ${this.accessToken}`;
    } else if (this.supabaseAnonKey) {
      headers['Authorization'] = `Bearer ${this.supabaseAnonKey}`;
    }
    return headers;
  }

  /**
   * Fetches pending tasks for this device from Supabase PostgREST.
   * @returns {Promise<Array<ReturnType<typeof parseRemoteTaskPayload>>>}
   */
  async fetchPendingTasks() {
    if (!this.enabled || !this.supabaseUrl) return [];

    const url = `${this.supabaseUrl}/rest/v1/hearth_tasks?device_id=eq.${encodeURIComponent(this.deviceId)}&status=eq.pending&order=created_at.asc`;
    const res = await this.fetchFn(url, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Failed to fetch pending tasks (${res.status}): ${errText}`);
    }

    const data = await res.json();
    if (!Array.isArray(data)) return [];

    const validTasks = [];
    for (const row of data) {
      try {
        const parsed = parseRemoteTaskPayload(row, this.deviceId);
        validTasks.push(parsed);
      } catch (err) {
        // Silently skip malformed rows or mismatched deviceIds without crashing the bridge
        console.warn(`[HearthBridge] Skipping invalid task row ${row?.id}: ${err.message}`);
      }
    }
    return validTasks;
  }

  /**
   * Atomically claims a task for execution.
   * Sets status to 'running', approved_at and started_at to now.
   * Enforces that the task must still be 'pending' and owned by this device.
   *
   * @param {{ taskId: string }} params
   * @returns {Promise<{ claimed: boolean, task?: any }>}
   */
  async claimTask({ taskId }) {
    if (!taskId) throw new Error('taskId is required to claim task');
    if (!this.supabaseUrl) throw new Error('Supabase URL is not configured');

    const now = new Date().toISOString();
    const url = `${this.supabaseUrl}/rest/v1/hearth_tasks?id=eq.${encodeURIComponent(taskId)}&device_id=eq.${encodeURIComponent(this.deviceId)}&status=eq.pending`;

    const res = await this.fetchFn(url, {
      method: 'PATCH',
      headers: this.getHeaders({
        'Prefer': 'return=representation',
      }),
      body: JSON.stringify({
        status: 'running',
        approved_at: now,
        started_at: now,
        updated_at: now,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Failed to claim task (${res.status}): ${errText}`);
    }

    const rows = await res.json();
    if (Array.isArray(rows) && rows.length === 1) {
      return { claimed: true, task: rows[0] };
    }
    // 0 rows updated: another instance claimed it or status changed
    return { claimed: false };
  }

  /**
   * Rejects a pending task. Does not call Antigravity.
   * @param {{ taskId: string }} params
   * @returns {Promise<boolean>}
   */
  async rejectTask({ taskId }) {
    if (!taskId) throw new Error('taskId is required to reject task');
    if (!this.supabaseUrl) throw new Error('Supabase URL is not configured');

    const now = new Date().toISOString();
    const url = `${this.supabaseUrl}/rest/v1/hearth_tasks?id=eq.${encodeURIComponent(taskId)}&device_id=eq.${encodeURIComponent(this.deviceId)}&status=eq.pending`;

    const res = await this.fetchFn(url, {
      method: 'PATCH',
      headers: this.getHeaders({
        'Prefer': 'return=representation',
      }),
      body: JSON.stringify({
        status: 'rejected',
        updated_at: now,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Failed to reject task (${res.status}): ${errText}`);
    }

    const rows = await res.json();
    return Array.isArray(rows) && rows.length > 0;
  }

  /**
   * Updates task status, Hearth task ID, conversation ID, and sanitized result/error.
   * Strips any raw transcripts, environment variables, or sensitive credentials before sending.
   *
   * @param {{
   *   taskId: string,
   *   hearthTaskId?: string | null,
   *   conversationId?: string | null,
   *   status: 'running' | 'waiting' | 'done' | 'error',
   *   result?: string | null,
   *   error?: string | null
   * }} params
   * @returns {Promise<boolean>}
   */
  async updateTaskResult({ taskId, hearthTaskId, conversationId, status, result, error }) {
    if (!taskId) throw new Error('taskId is required');
    if (!this.supabaseUrl) throw new Error('Supabase URL is not configured');

    const now = new Date().toISOString();
    const body = {
      status,
      updated_at: now,
    };

    if (hearthTaskId) body.hearth_task_id = hearthTaskId;
    if (conversationId) body.conversation_id = conversationId;

    if (result !== undefined) {
      body.result = result ? redactSecrets(String(result)) : null;
    }
    if (error !== undefined) {
      body.error = error ? redactSecrets(String(error)) : null;
    }
    if (status === 'done') {
      body.finished_at = now;
      body.error = null;
    } else if (status === 'error') {
      body.finished_at = now;
    }

    const url = `${this.supabaseUrl}/rest/v1/hearth_tasks?id=eq.${encodeURIComponent(taskId)}&device_id=eq.${encodeURIComponent(this.deviceId)}`;
    const res = await this.fetchFn(url, {
      method: 'PATCH',
      headers: this.getHeaders({ 'Prefer': 'return=representation' }),
      body: JSON.stringify(body),
    });

    return res.ok;
  }

  /**
   * Starts non-busy polling for pending tasks.
   * @param {(tasks: Array<ReturnType<typeof parseRemoteTaskPayload>>) => void} onTasks
   * @param {(err: Error) => void} [onError]
   */
  startPolling(onTasks, onError) {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.isPolling = true;

    const poll = async () => {
      if (!this.isPolling || !this.enabled) return;
      try {
        const tasks = await this.fetchPendingTasks();
        if (this.isPolling && this.enabled) {
          onTasks(tasks);
        }
      } catch (err) {
        if (onError && this.isPolling && this.enabled) {
          onError(err);
        }
      }
    };

    // Run initial fetch then interval
    void poll();
    this.pollTimer = setInterval(poll, this.pollIntervalMs);
  }

  /**
   * Stops polling and clears interval timer.
   */
  stopPolling() {
    this.isPolling = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}

/**
 * Synchronizes a local Hearth task state to its remote Supabase row.
 * Handles idempotency, secret redaction, offline queuing via taskStore, and terminal completion.
 *
 * @param {{
 *   bridgeClient?: HearthBridgeClient | null,
 *   taskStore?: { saveTask: (t: any) => any, getTask?: (id: string) => any },
 *   task: object,
 *   overrides?: object,
 * }} params
 * @returns {Promise<{ synced: boolean, pending: boolean, error?: string | null }>}
 */
export const syncRemoteTaskState = async ({ bridgeClient, taskStore, task, overrides = {} }) => {
  if (!task || task.source !== 'remote' || !task.remoteTaskId) {
    return { synced: false, pending: false };
  }

  const remoteStatus = overrides.status || (task.status === 'recovery_required' ? 'running' : task.status);
  const result = overrides.result !== undefined ? overrides.result : (task.completion?.summary || task.lastAnswer || null);
  const error = overrides.error !== undefined ? overrides.error : (task.error || null);
  const conversationId = overrides.conversationId !== undefined ? overrides.conversationId : (task.conversationId || null);

  // If bridge client is not configured or offline
  if (!bridgeClient || !bridgeClient.supabaseUrl) {
    task.remoteSyncPending = true;
    task.remoteSyncStatus = 'pending';
    if (taskStore && typeof taskStore.saveTask === 'function') taskStore.saveTask(task);
    return { synced: false, pending: true, error: 'Bridge client not configured or offline' };
  }

  try {
    const payload = {
      taskId: task.remoteTaskId,
      hearthTaskId: task.taskId,
      conversationId,
      status: remoteStatus,
      result,
      error,
    };

    const ok = await bridgeClient.updateTaskResult(payload);
    if (ok) {
      task.remoteSyncPending = false;
      task.remoteSyncStatus = 'synced';
      task.remoteSyncError = null;
      task.remoteSyncedAt = new Date().toISOString();
      if (taskStore && typeof taskStore.saveTask === 'function') taskStore.saveTask(task);
      return { synced: true, pending: false };
    } else {
      task.remoteSyncPending = true;
      task.remoteSyncStatus = 'failed';
      task.remoteSyncError = 'Supabase update returned false';
      if (taskStore && typeof taskStore.saveTask === 'function') taskStore.saveTask(task);
      return { synced: false, pending: true, error: task.remoteSyncError };
    }
  } catch (err) {
    const cleanError = redactSecrets(err.message);
    task.remoteSyncPending = true;
    task.remoteSyncStatus = 'failed';
    task.remoteSyncError = cleanError;
    if (taskStore && typeof taskStore.saveTask === 'function') taskStore.saveTask(task);
    return { synced: false, pending: true, error: cleanError };
  }
};

/**
 * Flushes all pending remote task synchronizations in taskStore.
 *
 * @param {{
 *   bridgeClient?: HearthBridgeClient | null,
 *   taskStore?: { listTasks: () => any[], saveTask: (t: any) => any },
 * }} params
 * @returns {Promise<{ flushed: number, failed: number }>}
 */
export const flushPendingRemoteSyncs = async ({ bridgeClient, taskStore }) => {
  if (!bridgeClient?.supabaseUrl || !taskStore || typeof taskStore.listTasks !== 'function') {
    return { flushed: 0, failed: 0 };
  }

  const tasks = taskStore.listTasks();
  let flushed = 0;
  let failed = 0;

  for (const t of tasks) {
    if (t && t.source === 'remote' && t.remoteTaskId && t.remoteSyncPending) {
      const res = await syncRemoteTaskState({ bridgeClient, taskStore, task: t });
      if (res.synced) flushed++;
      else failed++;
    }
  }

  return { flushed, failed };
};


/**
 * Creates an in-memory mock fetch transport for tests.
 * Fully simulates Supabase PostgREST endpoints without any network access.
 *
 * @param {Array<any>} [initialTasks]
 * @returns {{ fetch: typeof fetch, tasks: Array<any>, getTasks: () => Array<any> }}
 */
export const createMockTransport = (initialTasks = []) => {
  const tasks = JSON.parse(JSON.stringify(initialTasks));

  const mockFetch = async (urlStr, options = {}) => {
    const url = new URL(urlStr);
    const method = options.method || 'GET';
    const path = url.pathname;

    if (path.endsWith('/hearth_tasks')) {
      const searchParams = url.searchParams;
      const deviceIdFilter = searchParams.get('device_id')?.replace(/^eq\./, '');
      const statusFilter = searchParams.get('status')?.replace(/^eq\./, '');
      const idFilter = searchParams.get('id')?.replace(/^eq\./, '');

      if (method === 'GET') {
        let matched = tasks.filter(t => {
          if (!t || typeof t !== 'object') return false;
          if (deviceIdFilter && t.device_id !== deviceIdFilter) return false;
          if (statusFilter && t.status !== statusFilter) return false;
          if (idFilter && t.id !== idFilter) return false;
          return true;
        });
        return {
          ok: true,
          status: 200,
          json: async () => JSON.parse(JSON.stringify(matched)),
          text: async () => JSON.stringify(matched),
        };
      }

      if (method === 'PATCH') {
        const body = JSON.parse(options.body || '{}');
        const updated = [];
        for (const t of tasks) {
          let match = true;
          if (idFilter && t.id !== idFilter) match = false;
          if (deviceIdFilter && t.device_id !== deviceIdFilter) match = false;
          if (statusFilter && t.status !== statusFilter) match = false;

          if (match) {
            Object.assign(t, body);
            updated.push(JSON.parse(JSON.stringify(t)));
          }
        }
        return {
          ok: true,
          status: 200,
          json: async () => updated,
          text: async () => JSON.stringify(updated),
        };
      }
    }

    return {
      ok: false,
      status: 404,
      json: async () => ({ error: 'Not found' }),
      text: async () => 'Not found',
    };
  };

  return {
    fetch: mockFetch,
    tasks,
    getTasks: () => tasks,
  };
};
