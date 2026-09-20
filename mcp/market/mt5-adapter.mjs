const DEFAULT_BASE_URL = 'http://127.0.0.1:8765';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const ALLOWED_TIMEFRAMES = new Set(['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1']);
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

const validateBaseUrl = (value) => {
  let url;
  try { url = new URL(String(value || DEFAULT_BASE_URL)); }
  catch { throw new Error('mt5_invalid_base_url'); }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)) throw new Error('mt5_loopback_required');
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url.origin;
};

const normalizeIso = (value) => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

const normalizeBars = (bars) => {
  if (!Array.isArray(bars) || bars.length < 20) throw new Error('mt5_insufficient_bars');
  if (bars.length > 1000) throw new Error('mt5_too_many_bars');
  return bars.map((bar, index) => {
    if (!bar || typeof bar !== 'object' || Array.isArray(bar)) throw new Error(`mt5_invalid_bar:${index}`);
    const open = Number(bar.open);
    const high = Number(bar.high);
    const low = Number(bar.low);
    const close = Number(bar.close);
    const volume = bar.volume == null ? null : Number(bar.volume);
    if (![open, high, low, close].every(Number.isFinite)) throw new Error(`mt5_invalid_ohlc:${index}`);
    if (high < low || high < Math.max(open, close) || low > Math.min(open, close)) throw new Error(`mt5_invalid_range:${index}`);
    if (volume != null && (!Number.isFinite(volume) || volume < 0)) throw new Error(`mt5_invalid_volume:${index}`);
    const time = normalizeIso(String(bar.time || ''));
    if (!time) throw new Error(`mt5_invalid_time:${index}`);
    return { time, open, high, low, close, volume };
  });
};

export class Mt5LoopbackAdapter {
  constructor({ baseUrl = DEFAULT_BASE_URL, fetchFn = globalThis.fetch, timeoutMs = 10_000 } = {}) {
    if (typeof fetchFn !== 'function') throw new TypeError('Mt5LoopbackAdapter requires fetch');
    this.baseUrl = validateBaseUrl(baseUrl);
    this.fetchFn = fetchFn;
    this.timeoutMs = timeoutMs;
  }

  async getBars({ symbol = 'XAUUSD', timeframe = 'H1', limit = 250, signal } = {}) {
    const normalizedSymbol = String(symbol || '').toUpperCase().replace('/', '');
    if (normalizedSymbol !== 'XAUUSD') throw new Error('mt5_unsupported_symbol');
    const normalizedTimeframe = String(timeframe || '').toUpperCase();
    if (!ALLOWED_TIMEFRAMES.has(normalizedTimeframe)) throw new Error('mt5_unsupported_timeframe');
    const boundedLimit = Math.max(20, Math.min(500, Number(limit) || 250));

    const url = new URL('/v1/bars', this.baseUrl);
    url.searchParams.set('symbol', 'XAUUSD');
    url.searchParams.set('timeframe', normalizedTimeframe);
    url.searchParams.set('limit', String(boundedLimit));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = () => controller.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const response = await this.fetchFn(url.toString(), {
        method: 'GET',
        headers: { Accept: 'application/json' },
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`mt5_http_${response.status}`);
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('mt5_response_too_large');
      let payload;
      try { payload = JSON.parse(text); }
      catch { throw new Error('mt5_invalid_json'); }

      const payloadSymbol = String(payload?.symbol || '').toUpperCase().replace('/', '');
      if (payloadSymbol !== 'XAUUSD') throw new Error('mt5_symbol_mismatch');
      const payloadTimeframe = String(payload?.timeframe || '').toUpperCase();
      if (payloadTimeframe !== normalizedTimeframe) throw new Error('mt5_timeframe_mismatch');
      const asOf = normalizeIso(String(payload?.as_of || '')) || new Date().toISOString();
      return {
        symbol: 'XAUUSD',
        timeframe: normalizedTimeframe,
        as_of: asOf,
        source: 'MT5',
        bars: normalizeBars(payload?.bars),
      };
    } catch (error) {
      if (signal?.aborted) throw new Error('mt5_cancelled');
      if (error?.name === 'AbortError') throw new Error('mt5_timeout');
      if (/^mt5_/.test(String(error?.message || ''))) throw error;
      throw new Error('mt5_unavailable');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

export const createMt5LoopbackAdapter = (options = {}) => new Mt5LoopbackAdapter(options);
export const MT5_DEFAULT_BASE_URL = DEFAULT_BASE_URL;
