import { createOllamaProvider } from '../providers/ollama.mjs';

const requestError = (code, message) => ({
  ok: false,
  provider: null,
  model: null,
  requestedModel: null,
  text: null,
  finishReason: null,
  usage: null,
  error: { code, message, status: null, retryable: false },
});

const relayAbort = (source, target) => {
  if (!source) return () => {};
  const abort = () => target.abort(source.reason);
  if (source.aborted) abort();
  else source.addEventListener('abort', abort, { once: true });
  return () => source.removeEventListener('abort', abort);
};

/** Validates the narrow, provider-independent local model surface. */
export const assertModelAdapterContract = (adapter) => {
  if (!adapter || typeof adapter.generate !== 'function') {
    throw new TypeError('ModelAdapter must implement generate().');
  }
  if (adapter.cancel !== undefined && typeof adapter.cancel !== 'function') {
    throw new TypeError('ModelAdapter cancel must be a function when provided.');
  }
  return adapter;
};

/**
 * Keeps only model-facing data. It deliberately has no task, process, tool,
 * filesystem, or completion ownership.
 */
export const normalizeModelResponse = (result, { requestedModel = null } = {}) => {
  if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
    return requestError('MALFORMED_RESPONSE', 'Model provider returned a malformed result.');
  }
  const provider = typeof result.provider === 'string' ? result.provider : null;
  const model = typeof result.model === 'string' && result.model.trim()
    ? result.model.trim()
    : null;
  const configuredModel = typeof requestedModel === 'string' && requestedModel.trim()
    ? requestedModel.trim()
    : null;
  if (!result.ok) {
    return {
      ok: false,
      provider,
      model,
      requestedModel: configuredModel,
      text: null,
      finishReason: null,
      usage: result.usage && typeof result.usage === 'object' ? result.usage : null,
      error: result.error || { code: 'PROVIDER_ERROR', message: 'Model provider request failed', status: null, retryable: false },
    };
  }
  const text = typeof result.response === 'string'
    ? result.response
    : (typeof result.content === 'string' ? result.content : null);
  if (text === null) return requestError('MALFORMED_RESPONSE', 'Model provider response did not contain text.');
  const finishReason = typeof result.doneReason === 'string'
    ? result.doneReason
    : (typeof result.done_reason === 'string' ? result.done_reason : null);
  return {
    ok: true,
    provider,
    model,
    requestedModel: configuredModel,
    text,
    finishReason,
    usage: result.usage && typeof result.usage === 'object' ? result.usage : null,
    error: null,
  };
};

/**
 * Wraps any existing chat-capable provider. The adapter uses its provider's
 * existing timeout, context, and model policy; it does not discover or pull
 * models and does not manufacture usage data.
 */
export const createModelAdapter = ({ provider } = {}) => {
  if (!provider || typeof provider.chat !== 'function') {
    throw new TypeError('ModelAdapter requires a chat-capable provider.');
  }
  const activeRequests = new Map();
  const adapter = {
    async generate(request = {}, options = {}) {
      const requestId = typeof options.requestId === 'string' && options.requestId.trim()
        ? options.requestId.trim()
        : (typeof request.requestId === 'string' && request.requestId.trim() ? request.requestId.trim() : null);
      if (requestId && activeRequests.has(requestId)) {
        return requestError('REQUEST_IN_PROGRESS', `Model request '${requestId}' is already in progress.`);
      }
      const messages = Array.isArray(request.messages)
        ? request.messages
        : (typeof request.prompt === 'string' && request.prompt.trim()
          ? [{ role: 'user', content: request.prompt }]
          : null);
      if (!messages) return requestError('INVALID_REQUEST', 'messages or prompt is required.');

      const controller = new AbortController();
      const cleanupRelay = relayAbort(options.signal || request.signal, controller);
      if (requestId) activeRequests.set(requestId, controller);
      const model = options.model ?? request.model;
      try {
        const result = await provider.chat({
          messages,
          ...(typeof model === 'string' && model.trim() ? { model: model.trim() } : {}),
          ...(options.profile ?? request.profile ? { profile: options.profile ?? request.profile } : {}),
          ...(options.context ?? request.options ? { options: options.context ?? request.options } : {}),
          ...(options.think ?? request.think) !== undefined ? { think: options.think ?? request.think } : {},
          ...(options.num_ctx ?? request.num_ctx) !== undefined ? { num_ctx: options.num_ctx ?? request.num_ctx } : {},
          ...(options.num_predict ?? request.num_predict) !== undefined ? { num_predict: options.num_predict ?? request.num_predict } : {},
          ...(options.temperature ?? request.temperature) !== undefined ? { temperature: options.temperature ?? request.temperature } : {},
          ...(options.longResponse ?? request.longResponse) !== undefined ? { longResponse: Boolean(options.longResponse ?? request.longResponse) } : {},
          ...(options.timeoutMs ?? request.timeoutMs) !== undefined ? { timeoutMs: options.timeoutMs ?? request.timeoutMs } : {},
          signal: controller.signal,
        });
        return normalizeModelResponse(result, { requestedModel: model });
      } catch (error) {
        return requestError('PROVIDER_ERROR', error?.message || 'Model provider request failed.');
      } finally {
        cleanupRelay();
        if (requestId && activeRequests.get(requestId) === controller) activeRequests.delete(requestId);
      }
    },

    cancel(requestId) {
      const controller = activeRequests.get(requestId);
      if (!controller) return false;
      controller.abort(new Error('Model request cancelled.'));
      return true;
    },
  };
  return assertModelAdapterContract(adapter);
};

/** Reuses the established local Ollama implementation and configuration. */
export const createOllamaModelAdapter = ({ provider, providerOptions } = {}) =>
  createModelAdapter({ provider: provider || createOllamaProvider(providerOptions) });
