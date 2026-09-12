import { createOllamaProvider } from './ollama.mjs';

const selectionError = (code, message) => ({
  ok: false,
  provider: null,
  error: { code, message, status: null, retryable: false },
});

const providerCallError = (provider, code, message) => ({
  ok: false,
  provider,
  error: { code, message: String(message || 'Provider request failed'), status: null, retryable: false },
});

/**
 * Explicit provider selection only. Callers retain Hearth task, completion,
 * durable-job, continuation, synchronization, and safety ownership.
 */
export class ProviderSelection {
  constructor({ localProvider, localProviderOptions, externalProvider } = {}) {
    this.localProvider = localProvider || createOllamaProvider(localProviderOptions);
    this.externalProvider = externalProvider || null;
  }

  getProvider(name) {
    if (name === 'local') {
      return this.localProvider?.chat instanceof Function
        ? { ok: true, provider: 'local', adapter: this.localProvider }
        : selectionError('CONFIGURATION_ERROR', 'Local provider is not configured');
    }
    if (name === 'external') {
      return this.externalProvider?.chat instanceof Function
        ? { ok: true, provider: 'external', adapter: this.externalProvider }
        : selectionError('CONFIGURATION_ERROR', 'External provider is not configured');
    }
    return selectionError('CONFIGURATION_ERROR', `Unknown provider: ${String(name || '')}`);
  }

  async chat({ provider, ...request } = {}) {
    const selected = this.getProvider(provider);
    if (!selected.ok) return selected;
    try {
      const result = await selected.adapter.chat(request);
      if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
        return providerCallError(provider, 'MALFORMED_RESPONSE', 'Provider returned a malformed result');
      }
      return result;
    } catch (error) {
      return providerCallError(provider, 'PROVIDER_ERROR', error?.message || 'Provider request failed');
    }
  }

  async chatStream({ provider, ...request } = {}) {
    const selected = this.getProvider(provider);
    if (!selected.ok) return selected;
    if (typeof selected.adapter.chatStream !== 'function') {
      return { ok: false, provider, error: { code: 'UNSUPPORTED', message: 'Selected provider does not support streaming', status: null, retryable: false } };
    }
    try {
      return await selected.adapter.chatStream(request);
    } catch (error) {
      return { ok: false, provider, error: { code: 'PROVIDER_ERROR', message: error?.message || 'Provider stream failed', status: null, retryable: false } };
    }
  }
}

export const createProviderSelection = (options = {}) => new ProviderSelection(options);
