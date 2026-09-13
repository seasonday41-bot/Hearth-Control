const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'qwen3.5:9b-hermes';

export const LOCAL_RUNTIME_PROFILES = Object.freeze({
  fast: Object.freeze({ think: false, timeoutMs: 30_000, options: Object.freeze({ num_ctx: 4096, num_predict: 512 }) }),
  normal: Object.freeze({ think: false, timeoutMs: 90_000, options: Object.freeze({ num_ctx: 8192, num_predict: 1024 }) }),
  deep: Object.freeze({ think: true, timeoutMs: 300_000, options: Object.freeze({ num_ctx: 16384, num_predict: 2048 }) }),
  light: Object.freeze({ think: false, timeoutMs: 30_000, options: Object.freeze({ num_ctx: 4096, num_predict: 512 }) }),
  medium: Object.freeze({ think: false, timeoutMs: 90_000, options: Object.freeze({ num_ctx: 8192, num_predict: 1024 }) }),
  high: Object.freeze({ think: true, timeoutMs: 300_000, options: Object.freeze({ num_ctx: 16384, num_predict: 2048 }) }),
});
export const DEFAULT_LOCAL_PROFILE = 'normal';

const PROFILE_ALIASES = Object.freeze({ light: 'fast', medium: 'normal', high: 'deep' });
const normalizeProfile = (profile) => PROFILE_ALIASES[profile] || (LOCAL_RUNTIME_PROFILES[profile] ? profile : DEFAULT_LOCAL_PROFILE);
const LONG_RESPONSE_TIMEOUTS = Object.freeze({ fast: 180_000, normal: 300_000, deep: 600_000 });
export const resolveRequestTimeout = ({ profile, longResponse = false, configuredTimeout, timeoutMs } = {}) => {
  const normalizedProfile = normalizeProfile(profile);
  const explicitTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : null;
  const baseTimeout = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : LOCAL_RUNTIME_PROFILES[normalizedProfile].timeoutMs;
  return explicitTimeout || (longResponse ? Math.max(baseTimeout, LONG_RESPONSE_TIMEOUTS[normalizedProfile]) : baseTimeout);
};

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
    timeoutMs,
    fetchFn = globalThis.fetch,
  } = {}) {
    if (typeof fetchFn !== 'function') throw new TypeError('OllamaProvider requires a fetch implementation');
    this.baseUrl = trimBaseUrl(baseUrl);
    this.model = typeof model === 'string' && model.trim() ? model.trim() : null;
    this.profile = normalizeProfile(profile);
    this.timeoutOverridden = Number.isFinite(timeoutMs) && timeoutMs > 0;
    this.timeoutMs = this.timeoutOverridden ? timeoutMs : LOCAL_RUNTIME_PROFILES[this.profile].timeoutMs;
    this.fetchFn = fetchFn;
  }

  async request(path, { method = 'GET', body, signal, timeoutMs = this.timeoutMs } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
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
    longResponse = false,
    timeoutMs,
    tools,
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
    const normalizedProfile = normalizeProfile(profile);
    const runtimeProfile = LOCAL_RUNTIME_PROFILES[normalizedProfile];
    const runtimeOptions = { ...runtimeProfile.options, ...(options || {}) };
    if (numCtx !== undefined) runtimeOptions.num_ctx = numCtx;
    if (numPredict !== undefined) runtimeOptions.num_predict = numPredict;
    if (temperature !== undefined) runtimeOptions.temperature = temperature;
    if (longResponse) runtimeOptions.num_predict = Math.max(runtimeOptions.num_predict || 0, 4096);
    const configuredTimeout = this.timeoutOverridden ? this.timeoutMs : runtimeProfile.timeoutMs;
    const requestTimeoutMs = resolveRequestTimeout({ profile: normalizedProfile, longResponse, configuredTimeout, timeoutMs });
    const result = await this.request('/api/chat', {
      method: 'POST',
      body: {
        model: model.trim(),
        messages,
        stream: false,
        think: think === undefined ? runtimeProfile.think : Boolean(think),
        options: runtimeOptions,
        ...(Array.isArray(tools) && tools.length > 0 ? { tools } : {}),
      },
      signal,
      timeoutMs: requestTimeoutMs,
    });
    if (!result.ok) return this.normalizeFailure(result, 'chat');
    const response = result.payload?.message?.content;
    if (typeof response !== 'string') {
      return providerError({ code: 'MALFORMED_RESPONSE', message: 'Ollama chat response did not contain message.content' });
    }
    const doneReason = typeof result.payload.done_reason === 'string' && result.payload.done_reason.trim()
      ? result.payload.done_reason.trim()
      : 'unknown';
    const toolCalls = Array.isArray(result.payload?.message?.tool_calls) ? result.payload.message.tool_calls : [];
    return {
      ok: true,
      provider: 'ollama',
      model: model.trim(),
      profile: normalizedProfile,
      response,
      done: result.payload.done !== false,
      doneReason,
      done_reason: doneReason,
      outputLimitReached: doneReason === 'length',
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }

  async chatStream({
    messages,
    model = this.model,
    profile = this.profile,
    signal,
    options,
    think,
    num_ctx: numCtx,
    num_predict: numPredict,
    temperature,
    longResponse = false,
    timeoutMs,
    onChunk,
    tools,
  } = {}) {
    if (!Array.isArray(messages) || messages.length === 0) return providerError({ code: 'INVALID_REQUEST', message: 'messages must be a non-empty array' });
    if (!model || typeof model !== 'string' || !model.trim()) return providerError({ code: 'MODEL_REQUIRED', message: 'An Ollama model is required' });
    if (typeof onChunk !== 'function') return providerError({ code: 'INVALID_REQUEST', message: 'onChunk callback is required' });
    const normalizedProfile = normalizeProfile(profile);
    const runtimeProfile = LOCAL_RUNTIME_PROFILES[normalizedProfile];
    const runtimeOptions = { ...runtimeProfile.options, ...(options || {}) };
    if (numCtx !== undefined) runtimeOptions.num_ctx = numCtx;
    if (numPredict !== undefined) runtimeOptions.num_predict = numPredict;
    if (temperature !== undefined) runtimeOptions.temperature = temperature;
    if (longResponse) runtimeOptions.num_predict = Math.max(runtimeOptions.num_predict || 0, 4096);
    const requestTimeoutMs = resolveRequestTimeout({
      profile: normalizedProfile,
      longResponse,
      configuredTimeout: this.timeoutOverridden ? this.timeoutMs : runtimeProfile.timeoutMs,
      timeoutMs,
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    const onAbort = () => controller.abort(signal.reason);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    let responseText = '';
    let doneReason = 'unknown';
    const toolCalls = [];
    let reader;
    try {
      const response = await this.fetchFn(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { Accept: 'application/x-ndjson', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model.trim(), messages, stream: true,
          think: think === undefined ? runtimeProfile.think : Boolean(think),
          options: runtimeOptions,
          ...(Array.isArray(tools) && tools.length > 0 ? { tools } : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text();
        let payload = null;
        try { payload = text ? JSON.parse(text) : null; } catch {}
        return this.normalizeFailure({ ok: false, status: response.status, payload, text }, 'chat');
      }
      if (!response.body) return providerError({ code: 'MALFORMED_RESPONSE', message: 'Ollama stream did not provide a response body' });
      reader = response.body.getReader ? response.body.getReader() : null;
      if (!reader) return providerError({ code: 'MALFORMED_RESPONSE', message: 'Ollama stream body is not readable' });
      const decoder = new TextDecoder();
      let buffer = '';
      const consumeLine = async (line) => {
        if (!line.trim()) return false;
        let event;
        try { event = JSON.parse(line); } catch { return false; }
        const content = event?.message?.content;
        if (typeof content === 'string' && content) {
          responseText += content;
          await onChunk(content);
        }
        if (Array.isArray(event?.message?.tool_calls)) toolCalls.push(...event.message.tool_calls);
        if (typeof event?.done_reason === 'string' && event.done_reason) doneReason = event.done_reason;
        return Boolean(event?.done);
      };
      let finished = false;
      while (!finished) {
        const next = await reader.read();
        if (next.done) {
          buffer += decoder.decode();
          if (buffer.trim()) await consumeLine(buffer);
          break;
        }
        buffer += decoder.decode(next.value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (await consumeLine(line)) { finished = true; break; }
        }
      }
      return {
        ok: true,
        provider: 'ollama',
        model: model.trim(),
        profile: normalizedProfile,
        response: responseText,
        done: true,
        doneReason,
        done_reason: doneReason,
        outputLimitReached: doneReason === 'length',
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      };
    } catch (error) {
      if (signal?.aborted) return { ...providerError({ code: 'CANCELLED', message: 'chat request was cancelled', retryable: false }), response: responseText, doneReason };
      if (isAbortError(error)) return { ...providerError({ code: 'TIMEOUT', message: 'chat request timed out', retryable: true }), response: responseText, doneReason };
      return { ...providerError({ code: 'UNAVAILABLE', message: error?.message || 'Ollama stream failed', retryable: true }), response: responseText, doneReason };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (reader && signal?.aborted) await reader.cancel().catch(() => {});
    }
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
