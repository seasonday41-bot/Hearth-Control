const DEFAULT_BASE_URL = 'http://127.0.0.1:8765';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const MAX_RESPONSE_BYTES = 256 * 1024;

const finite = (value) => Number.isFinite(value);

const normalizeIso = (value, code) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(code);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(code);
  return date.toISOString();
};

const positive = (value, code, { allowZero = false } = {}) => {
  const number = Number(value);
  if (!finite(number) || (allowZero ? number < 0 : number <= 0)) throw new Error(code);
  return number;
};

const validateBaseUrl = (value) => {
  let url;
  try { url = new URL(String(value || DEFAULT_BASE_URL)); }
  catch { throw new Error('mt5_risk_invalid_base_url'); }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)) throw new Error('mt5_risk_loopback_required');
  return url.origin;
};

const normalizeRiskPayload = (payload) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('mt5_risk_invalid_payload');
  if (String(payload.symbol || '').toUpperCase().replace('/', '') !== 'XAUUSD') throw new Error('mt5_risk_symbol_mismatch');
  if (payload.source !== 'MT5') throw new Error('mt5_risk_source_invalid');

  const account = payload.account;
  const broker = payload.broker;
  if (!account || typeof account !== 'object' || Array.isArray(account)) throw new Error('mt5_risk_account_invalid');
  if (!broker || typeof broker !== 'object' || Array.isArray(broker)) throw new Error('mt5_risk_broker_invalid');
  if (account.open_risk_complete !== true) throw new Error('mt5_risk_open_risk_incomplete');

  const accountType = String(account.account_type || '').toLowerCase();
  if (!['demo', 'live'].includes(accountType)) throw new Error('mt5_risk_account_type_invalid');
  const currency = String(account.currency || '').toUpperCase();
  if (!currency) throw new Error('mt5_risk_currency_invalid');

  const accountState = {
    account_type: accountType,
    currency,
    equity: positive(account.equity, 'mt5_risk_equity_invalid'),
    peak_equity: positive(account.peak_equity, 'mt5_risk_peak_equity_invalid'),
    free_margin: positive(account.free_margin, 'mt5_risk_free_margin_invalid', { allowZero: true }),
    daily_realized_loss: positive(account.daily_realized_loss, 'mt5_risk_daily_loss_invalid', { allowZero: true }),
    open_risk_currency: positive(account.open_risk_currency, 'mt5_risk_open_risk_invalid', { allowZero: true }),
    open_positions: Number(account.open_positions),
    as_of: normalizeIso(payload.as_of, 'mt5_risk_as_of_invalid'),
  };
  if (!Number.isInteger(accountState.open_positions) || accountState.open_positions < 0) {
    throw new Error('mt5_risk_open_positions_invalid');
  }
  if (accountState.peak_equity < accountState.equity) throw new Error('mt5_risk_peak_equity_below_equity');

  const brokerState = {
    symbol: 'XAUUSD',
    bid: positive(broker.bid, 'mt5_risk_bid_invalid'),
    ask: positive(broker.ask, 'mt5_risk_ask_invalid'),
    point_size: positive(broker.point_size, 'mt5_risk_point_size_invalid'),
    tick_size: positive(broker.tick_size, 'mt5_risk_tick_size_invalid'),
    tick_value_per_lot: positive(broker.tick_value_per_lot, 'mt5_risk_tick_value_invalid'),
    volume_min: positive(broker.volume_min, 'mt5_risk_volume_min_invalid'),
    volume_max: positive(broker.volume_max, 'mt5_risk_volume_max_invalid'),
    volume_step: positive(broker.volume_step, 'mt5_risk_volume_step_invalid'),
    margin_per_lot: positive(broker.margin_per_lot, 'mt5_risk_margin_invalid'),
    estimated_slippage_points: positive(broker.estimated_slippage_points, 'mt5_risk_slippage_invalid', { allowZero: true }),
    as_of: normalizeIso(payload.as_of, 'mt5_risk_as_of_invalid'),
  };
  if (brokerState.ask < brokerState.bid) throw new Error('mt5_risk_quote_invalid');
  if (brokerState.volume_max < brokerState.volume_min || brokerState.volume_step > brokerState.volume_max) throw new Error('mt5_risk_volume_bounds_invalid');

  return {
    symbol: 'XAUUSD',
    broker_symbol: String(payload.broker_symbol || '').slice(0, 64),
    source: 'MT5',
    as_of: accountState.as_of,
    account: accountState,
    broker: brokerState,
  };
};

export class Mt5RiskLoopbackAdapter {
  constructor({ baseUrl = DEFAULT_BASE_URL, fetchFn = globalThis.fetch, timeoutMs = 5_000 } = {}) {
    if (typeof fetchFn !== 'function') throw new TypeError('Mt5RiskLoopbackAdapter requires fetch');
    this.baseUrl = validateBaseUrl(baseUrl);
    this.fetchFn = fetchFn;
    this.timeoutMs = timeoutMs;
  }

  async getRiskState({ symbol = 'XAUUSD', signal } = {}) {
    const normalizedSymbol = String(symbol || '').toUpperCase().replace('/', '');
    if (normalizedSymbol !== 'XAUUSD') throw new Error('mt5_risk_unsupported_symbol');

    const url = new URL('/v1/risk-state', this.baseUrl);
    url.searchParams.set('symbol', 'XAUUSD');

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
      if (!response.ok) throw new Error(`mt5_risk_http_${response.status}`);
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('mt5_risk_response_too_large');
      let payload;
      try { payload = JSON.parse(text); }
      catch { throw new Error('mt5_risk_invalid_json'); }
      return normalizeRiskPayload(payload);
    } catch (error) {
      if (signal?.aborted) throw new Error('mt5_risk_cancelled');
      if (error?.name === 'AbortError') throw new Error('mt5_risk_timeout');
      if (/^mt5_risk_/.test(String(error?.message || ''))) throw error;
      throw new Error('mt5_risk_unavailable');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

export const createMt5RiskLoopbackAdapter = (options = {}) => new Mt5RiskLoopbackAdapter(options);
