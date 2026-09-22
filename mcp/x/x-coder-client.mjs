import { EXECUTOR_API_VERSION } from './executor-contract/index.mjs';

const DEFAULT_BASE_URL = 'http://127.0.0.1:3217';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const RUN_STATUSES = new Set([
  'submitted', 'running', 'completed', 'needs_review', 'failed', 'interrupted', 'cancelled',
]);

const validateBaseUrl = (value) => {
  let url;
  try { url = new URL(String(value || DEFAULT_BASE_URL)); }
  catch { throw new Error('x_coder_invalid_base_url'); }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error('x_coder_loopback_required');
  }
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url.origin;
};

const isNonEmptyString = (value) => typeof value === 'string' && Boolean(value.trim());

const validateCommonResponse = (payload) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('x_coder_invalid_response');
  }
  if (payload.version !== EXECUTOR_API_VERSION || !isNonEmptyString(payload.run_id) ||
      !RUN_STATUSES.has(payload.status)) {
    throw new Error('x_coder_invalid_response');
  }
  return payload;
};

export class XCoderClient {
  constructor({
    baseUrl = DEFAULT_BASE_URL,
    fetchFn = globalThis.fetch,
    timeoutMs = 10_000,
  } = {}) {
    if (typeof fetchFn !== 'function') throw new TypeError('XCoderClient requires fetch.');
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be a positive integer.');
    this.baseUrl = validateBaseUrl(baseUrl);
    this.fetchFn = fetchFn;
    this.timeoutMs = timeoutMs;
  }

  async _post(pathname, body, { signal } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('x_coder_timeout')), this.timeoutMs);
    const onAbort = () => controller.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const response = await this.fetchFn(new URL(pathname, this.baseUrl).toString(), {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        redirect: 'error',
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('x_coder_response_too_large');
      let payload;
      try { payload = text ? JSON.parse(text) : null; }
      catch { throw new Error('x_coder_invalid_json'); }

      if (!response.ok) {
        const detail = isNonEmptyString(payload?.error) ? payload.error : 'http_' + response.status;
        throw new Error('x_coder_' + detail);
      }
      return payload;
    } catch (error) {
      if (signal?.aborted) throw new Error('x_coder_cancelled');
      if (controller.signal.aborted || error?.name === 'AbortError') throw new Error('x_coder_timeout');
      if (/^x_coder_/.test(String(error?.message || ''))) throw error;
      throw new Error('x_coder_unavailable');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async submit({ idempotencyKey, task, leaseExpiresAt, signal } = {}) {
    if (!isNonEmptyString(idempotencyKey)) throw new TypeError('idempotencyKey is required.');
    if (!task || typeof task !== 'object' || Array.isArray(task)) throw new TypeError('task is required.');
    if (!Number.isInteger(leaseExpiresAt) || leaseExpiresAt <= 0) throw new TypeError('leaseExpiresAt is required.');

    const payload = validateCommonResponse(await this._post('/submit', {
      version: EXECUTOR_API_VERSION,
      idempotency_key: idempotencyKey.trim(),
      lease_expires_at: leaseExpiresAt,
      task,
    }, { signal }));

    if (typeof payload.duplicate !== 'boolean') throw new Error('x_coder_invalid_response');
    return {
      runId: payload.run_id,
      status: payload.status,
      duplicate: payload.duplicate,
    };
  }

  async getStatus(runId, { signal } = {}) {
    if (!isNonEmptyString(runId)) throw new TypeError('runId is required.');
    const payload = validateCommonResponse(await this._post('/status', {
      version: EXECUTOR_API_VERSION,
      run_id: runId.trim(),
    }, { signal }));
    if (payload.run_id !== runId.trim()) throw new Error('x_coder_run_id_mismatch');
    return {
      runId: payload.run_id,
      status: payload.status,
      result: payload.result ?? null,
      error: payload.error ?? null,
    };
  }

  async leaseValid(runId, leaseExpiresAt, { signal } = {}) {
    if (!isNonEmptyString(runId)) throw new TypeError('runId is required.');
    if (!Number.isInteger(leaseExpiresAt) || leaseExpiresAt <= 0) throw new TypeError('leaseExpiresAt is required.');
    const payload = validateCommonResponse(await this._post('/lease-valid', {
      version: EXECUTOR_API_VERSION,
      run_id: runId.trim(),
      lease_expires_at: leaseExpiresAt,
    }, { signal }));
    if (payload.run_id !== runId.trim() || typeof payload.accepted !== 'boolean' ||
        (payload.lease_expires_at !== null && !Number.isInteger(payload.lease_expires_at))) {
      throw new Error('x_coder_invalid_response');
    }
    return {
      runId: payload.run_id,
      status: payload.status,
      leaseExpiresAt: payload.lease_expires_at,
      accepted: payload.accepted,
    };
  }

  async cancel(runId, { signal } = {}) {
    if (!isNonEmptyString(runId)) throw new TypeError('runId is required.');
    const payload = validateCommonResponse(await this._post('/cancel', {
      version: EXECUTOR_API_VERSION,
      run_id: runId.trim(),
    }, { signal }));
    if (payload.run_id !== runId.trim() || typeof payload.acknowledged !== 'boolean') {
      throw new Error('x_coder_invalid_response');
    }
    return {
      runId: payload.run_id,
      status: payload.status,
      result: payload.result ?? null,
      error: payload.error ?? null,
      acknowledged: payload.acknowledged,
    };
  }
}

export const createXCoderClient = (options = {}) => new XCoderClient(options);
export const X_CODER_DEFAULT_BASE_URL = DEFAULT_BASE_URL;
