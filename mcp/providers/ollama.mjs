const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MODEL = 'qwen3.5:9b-hermes';

export const LOCAL_RUNTIME_PROFILES = Object.freeze({
  light: Object.freeze({ think: false, options: Object.freeze({ num_ctx: 4096, num_predict: 256 }) }),
  medium: Object.freeze({ think: false, options: Object.freeze({ num_ctx: 8192, num_predict: 512 }) }),
  high: Object.freeze({ think: true, options: Object.freeze({ num_ctx: 16384, num_predict: 1024 }) }),
});
export const DEFAULT_LOCAL_PROFILE = 'light';

const trimBaseUrl = (value) => String(value || DEFAULT_BASE_URL).replace(/\/+$/, '');

const providerError = ({ code, message, status = null, retryable = false }) => ({
  ok: false,
  provider: 'ollama',
  error: { code, message: String(message || 'Ollama request failed'), status, retryable },
});

const isAbortError = (error) => error?.name === 'AbortError' || /aborted|abort/i.test(String(error?.message || ''));

/**
 * Minimal Ollama adapter. It never downloads models, owns Hearth tasks, or
 * decides Hearth completion state. All methods return normalized results.
 */
export class OllamaProvider {
  constructor({
    baseUrl = process.env.OLLAMA_BASE_URL || DEFAULT_BASE_URL,
    model = process.env.OLLAMA_MODEL || DEFAULT_MODEL,
    profile = process.env.OLLAMA_PROFILE || DEFAULT_LOCAL_PROFILE,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchFn = globalThis.fetch,
  } = {}) {
    if (typeof fetchFn !== 'function') throw new TypeError('OllamaProvider requires a fetch implementation');
    this.baseUrl = trimBaseUrl(baseUrl);
    this.model = typeof model === 'string' && model.trim() ? model.trim() : null;
    this.profile = Object.hasOwn(LOCAL_RUNTIME_PROFILES, profile) ? profile : DEFAULT_LOCAL_PROFILE;
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    this.fetchFn = fetchFn;
  }

  async request(path, { method = 'GET', body, signal } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = () => controller.abort(signal.reason);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers: body === undefined ? { Accept: 'application/json' } : {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload = null;
      try { payload = text ? JSON.parse(text) : null; } catch { /* normalized by caller */ }
      if (!response.ok) {
        return { ok: false, status: response.status, payload, text };
      }
      return { ok: true, status: response.status, payload, text };
    } catch (error) {
      if (signal?.aborted) return { ok: false, aborted: true, externalAbort: true, error };
      if (isAbortError(error)) return { ok: false, aborted: true, error };
      return { ok: false, networkError: true, error };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async health({ signal } = {}) {
    const result = await this.request('/api/tags', { signal });
    if (!result.ok) return this.normalizeFailure(result, 'health');
    if (!result.payload || !Array.isArray(result.payload.models)) {
      return providerError({ code: 'MALFORMED_RESPONSE', message: 'Ollama health response was malformed' });
    }
    return { ok: true, provider: 'ollama', available: true, modelCount: result.payload.models.length };
  }

  async listModels({ signal } = {}) {
    const result = await this.request('/api/tags', { signal });
    if (!result.ok) return this.normalizeFailure(result, 'listModels');
    if (!result.payload || !Array.isArray(result.payload.models)) {
      return providerError({ code: 'MALFORMED_RESPONSE', message: 'Ollama model list response was malformed' });
    }
    const models = result.payload.models
      .map((entry) => (typeof entry?.name === 'string' ? entry.name.trim() : ''))
      .filter(Boolean);
    return { ok: true, provider: 'ollama', models };
  }

  async chat({
    messages,
    model = this.model,
    profile = this.profile,
    stream = false,
    signal,
    options,
    think,
    num_ctx: numCtx,
    num_predict: numPredict,
    temperature,
  } = {}) {
    if (!Array.isArray(messages) || messages.length === 0) {
      return providerError({ code: 'INVALID_REQUEST', message: 'messages must be a non-empty array' });
    }
    if (!model || typeof model !== 'string' || !model.trim()) {
      return providerError({ code: 'MODEL_REQUIRED', message: 'An Ollama model is required' });
    }
    if (stream) {
      return providerError({ code: 'UNSUPPORTED', message: 'Streaming is not supported by the v0.1 adapter' });
    }
    const runtimeProfile = LOCAL_RUNTIME_PROFILES[profile] || LOCAL_RUNTIME_PROFILES[DEFAULT_LOCAL_PROFILE];
    const runtimeOptions = { ...runtimeProfile.options, ...(options || {}) };
    if (numCtx !== undefined) runtimeOptions.num_ctx = numCtx;
    if (numPredict !== undefined) runtimeOptions.num_predict = numPredict;
    if (temperature !== undefined) runtimeOptions.temperature = temperature;
    const result = await this.request('/api/chat', {
      method: 'POST',
      body: {
        model: model.trim(),
        messages,
        stream: false,
        think: think === undefined ? runtimeProfile.think : Boolean(think),
        options: runtimeOptions,
      },
      signal,
    });
    if (!result.ok) return this.normalizeFailure(result, 'chat');
    const response = result.payload?.message?.content;
    if (typeof response !== 'string') {
      return providerError({ code: 'MALFORMED_RESPONSE', message: 'Ollama chat response did not contain message.content' });
    }
    return { ok: true, provider: 'ollama', model: model.trim(), response, done: result.payload.done !== false };
  }

  normalizeFailure(result, operation) {
    if (result.externalAbort) return providerError({ code: 'CANCELLED', message: `${operation} request was cancelled`, retryable: false });
    if (result.aborted) return providerError({ code: 'TIMEOUT', message: `${operation} request timed out`, retryable: true });
    if (result.networkError) return providerError({ code: 'UNAVAILABLE', message: 'Ollama is unavailable', retryable: true });
    const message = result.payload?.error || result.text || `Ollama ${operation} request failed`;
    return providerError({ code: 'HTTP_ERROR', message, status: result.status, retryable: result.status >= 500 });
  }
}

export const createOllamaProvider = (options = {}) => new OllamaProvider(options);
export const OLLAMA_DEFAULT_BASE_URL = DEFAULT_BASE_URL;
export const OLLAMA_DEFAULT_MODEL = DEFAULT_MODEL;
