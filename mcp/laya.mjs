/** Optional, advisory-only loopback adapter. LAYA is never an execution route. */
const endpoint = () => {
  const raw = process.env.HEARTH_LAYA_ENDPOINT;
  if (!raw) return null;
  const url = new URL(raw);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) {
    throw new Error('LAYA endpoint must be a credential-free loopback HTTP URL.');
  }
  return url;
};

const request = async (action, body) => {
  const base = endpoint();
  if (!base) throw new Error('LAYA is not configured.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const url = new URL(action, `${base.href.replace(/\/$/, '')}/`);
    const response = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`LAYA returned HTTP ${response.status}.`);
    const raw = await response.text();
    if (raw.length > 64000) throw new Error('LAYA response exceeded size limit.');
    return JSON.parse(raw);
  } finally { clearTimeout(timer); }
};

export const layaStatus = async () => {
  try {
    if (!endpoint()) return { available: false, connected: false, mode: 'consult+review', last_error: 'not_configured' };
    const state = await request('status');
    return {
      available: true, connected: state.connected === true,
      provider: typeof state.provider === 'string' ? state.provider.slice(0, 80) : null,
      model: typeof state.model === 'string' ? state.model.slice(0, 80) : null,
      mode: 'consult+review', last_error: null,
    };
  } catch (error) {
    return { available: true, connected: false, mode: 'consult+review', last_error: error.message.replace(/https?:\/\/\S+/g, '[endpoint]') };
  }
};

export const layaConsult = (prompt) => request('consult', { prompt, mode: 'advice_only' });
export const layaReview = (payload) => request('review', { ...payload, mode: 'advice_only' });
