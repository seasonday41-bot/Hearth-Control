import crypto from 'node:crypto';
import { parseTechnicalSignal } from './technical-signal.mjs';

export const XAU_RISK_DECISION_VERSION = 'xau-risk-decision-v1';
export const XAU_RISK_DECISIONS = Object.freeze(['APPROVE', 'RESIZE', 'REJECT']);

const CHECK_KEYS = Object.freeze([
  'signal',
  'freshness',
  'mode',
  'account',
  'broker',
  'stop',
  'spread',
  'slippage',
  'daily_loss',
  'drawdown',
  'positions',
  'exposure',
  'margin',
  'cooldown',
  'circuit_breaker',
]);

const clone = (value) => structuredClone(value);
const finite = (value) => Number.isFinite(value);
const round = (value, digits = 8) => {
  if (!finite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

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

const fraction = (value, code, { allowZero = false } = {}) => {
  const number = positive(value, code, { allowZero });
  if (number > 1) throw new Error(code);
  return number;
};

const integer = (value, code, { allowZero = false } = {}) => {
  const number = Number(value);
  if (!Number.isInteger(number) || (allowZero ? number < 0 : number <= 0)) throw new Error(code);
  return number;
};

const normalizeModeState = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('risk_mode_state_required');
  const demoSessionId = value.demo_session_id == null ? null : String(value.demo_session_id);
  if (demoSessionId != null && !/^demo:[0-9a-f-]{36}$/i.test(demoSessionId)) throw new Error('risk_demo_session_invalid');
  return {
    mode: String(value.mode || ''),
    demo_auto_enabled: value.demo_auto_enabled === true,
    trade_execution_enabled: value.trade_execution_enabled === true,
    demo_session_id: demoSessionId,
  };
};

const normalizeAccountState = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('risk_account_state_required');
  const accountType = String(value.account_type || '').toLowerCase();
  if (!['demo', 'live'].includes(accountType)) throw new Error('risk_account_type_invalid');

  const equity = positive(value.equity, 'risk_equity_invalid');
  const peakEquity = positive(value.peak_equity, 'risk_peak_equity_invalid');
  const freeMargin = positive(value.free_margin, 'risk_free_margin_invalid', { allowZero: true });
  const dailyRealizedLoss = positive(value.daily_realized_loss, 'risk_daily_loss_invalid', { allowZero: true });
  const openRisk = positive(value.open_risk_currency, 'risk_open_risk_invalid', { allowZero: true });
  const openPositions = integer(value.open_positions, 'risk_open_positions_invalid', { allowZero: true });
  const asOf = normalizeIso(value.as_of, 'risk_account_as_of_invalid');

  if (peakEquity < equity) throw new Error('risk_peak_equity_below_equity');

  if (typeof value.cooldown_active !== 'boolean') throw new Error('risk_cooldown_state_required');
  if (typeof value.circuit_breaker_active !== 'boolean') throw new Error('risk_circuit_breaker_state_required');

  return {
    account_type: accountType,
    currency: String(value.currency || '').toUpperCase(),
    equity,
    peak_equity: peakEquity,
    free_margin: freeMargin,
    daily_realized_loss: dailyRealizedLoss,
    open_risk_currency: openRisk,
    open_positions: openPositions,
    cooldown_active: value.cooldown_active,
    circuit_breaker_active: value.circuit_breaker_active,
    as_of: asOf,
  };
};

const normalizeBrokerState = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('risk_broker_state_required');
  const symbol = String(value.symbol || '').toUpperCase().replace('/', '');
  if (symbol !== 'XAUUSD') throw new Error('risk_broker_symbol_invalid');

  const bid = positive(value.bid, 'risk_bid_invalid');
  const ask = positive(value.ask, 'risk_ask_invalid');
  if (ask < bid) throw new Error('risk_quote_invalid');

  const pointSize = positive(value.point_size, 'risk_point_size_invalid');
  const tickSize = positive(value.tick_size, 'risk_tick_size_invalid');
  const tickValuePerLot = positive(value.tick_value_per_lot, 'risk_tick_value_invalid');
  const volumeMin = positive(value.volume_min, 'risk_volume_min_invalid');
  const volumeMax = positive(value.volume_max, 'risk_volume_max_invalid');
  const volumeStep = positive(value.volume_step, 'risk_volume_step_invalid');
  const marginPerLot = positive(value.margin_per_lot, 'risk_margin_per_lot_invalid');
  const estimatedSlippagePoints = positive(value.estimated_slippage_points, 'risk_slippage_invalid', { allowZero: true });
  const asOf = normalizeIso(value.as_of, 'risk_broker_as_of_invalid');

  if (volumeMax < volumeMin || volumeStep > volumeMax) throw new Error('risk_volume_bounds_invalid');

  return {
    symbol: 'XAUUSD',
    bid,
    ask,
    point_size: pointSize,
    tick_size: tickSize,
    tick_value_per_lot: tickValuePerLot,
    volume_min: volumeMin,
    volume_max: volumeMax,
    volume_step: volumeStep,
    margin_per_lot: marginPerLot,
    estimated_slippage_points: estimatedSlippagePoints,
    as_of: asOf,
  };
};

const normalizeRiskConfig = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('risk_config_required');

  const config = {
    risk_fraction_per_trade: fraction(value.risk_fraction_per_trade, 'risk_fraction_per_trade_invalid'),
    max_daily_loss_fraction: fraction(value.max_daily_loss_fraction, 'risk_max_daily_loss_invalid'),
    max_drawdown_fraction: fraction(value.max_drawdown_fraction, 'risk_max_drawdown_invalid'),
    max_total_open_risk_fraction: fraction(value.max_total_open_risk_fraction, 'risk_max_open_risk_invalid'),
    max_positions: integer(value.max_positions, 'risk_max_positions_invalid'),
    max_spread_points: positive(value.max_spread_points, 'risk_max_spread_invalid'),
    max_slippage_points: positive(value.max_slippage_points, 'risk_max_slippage_invalid', { allowZero: true }),
    min_stop_points: positive(value.min_stop_points, 'risk_min_stop_invalid'),
    max_stop_points: positive(value.max_stop_points, 'risk_max_stop_invalid'),
    max_state_age_ms: positive(value.max_state_age_ms, 'risk_max_state_age_invalid'),
    requested_volume: value.requested_volume == null
      ? null
      : positive(value.requested_volume, 'risk_requested_volume_invalid'),
  };

  if (config.max_stop_points < config.min_stop_points) throw new Error('risk_stop_bounds_invalid');
  if (config.max_daily_loss_fraction > config.max_drawdown_fraction) {
    throw new Error('risk_daily_loss_exceeds_drawdown');
  }
  if (config.risk_fraction_per_trade > config.max_total_open_risk_fraction) {
    throw new Error('risk_trade_fraction_exceeds_total_open_risk');
  }

  return config;
};

const blankChecks = () => Object.fromEntries(CHECK_KEYS.map((key) => [key, 'unavailable']));

const decisionId = (proposalId, asOf) => {
  const digest = crypto.createHash('sha256').update(`${proposalId}|${asOf}`).digest('hex').slice(0, 24);
  return `riskdec:v1:${digest}`;
};

const reject = ({ signal, asOf, reasonCodes, checks, sizing = null, demoSessionId = null }) => Object.freeze({
  version: XAU_RISK_DECISION_VERSION,
  id: decisionId(signal.id, asOf),
  proposal_id: signal.id,
  strategy: signal.strategy,
  symbol: 'XAUUSD',
  decision: 'REJECT',
  demo_session_id: demoSessionId,
  approved_risk_fraction: null,
  approved_volume: null,
  reason_codes: Object.freeze([...new Set(reasonCodes)]),
  checks: Object.freeze({ ...checks }),
  sizing: sizing ? Object.freeze(clone(sizing)) : null,
  as_of: asOf,
});

const floorToStep = (value, min, max, step) => {
  const bounded = Math.min(value, max);
  if (bounded < min) return 0;
  const steps = Math.floor((bounded - min + 1e-12) / step);
  const normalized = min + (steps * step);
  return round(Math.min(normalized, max), 8);
};

const signalEntry = (signal) => (signal.entry_zone[0] + signal.entry_zone[1]) / 2;

const decisionBase = ({ signal, decision, volume, riskFraction, reasons, checks, sizing, asOf, demoSessionId }) => Object.freeze({
  version: XAU_RISK_DECISION_VERSION,
  id: decisionId(signal.id, asOf),
  proposal_id: signal.id,
  strategy: signal.strategy,
  symbol: 'XAUUSD',
  decision,
  demo_session_id: demoSessionId,
  approved_risk_fraction: round(riskFraction, 8),
  approved_volume: round(volume, 8),
  reason_codes: Object.freeze([...new Set(reasons)]),
  checks: Object.freeze({ ...checks }),
  sizing: Object.freeze(clone(sizing)),
  as_of: asOf,
});

export const evaluateXauRisk = ({
  technicalSignal,
  modeState,
  accountState,
  brokerState,
  riskConfig,
  now = new Date().toISOString(),
} = {}) => {
  const signal = parseTechnicalSignal(technicalSignal);
  const asOf = normalizeIso(now, 'risk_now_invalid');
  const checks = blankChecks();
  checks.signal = signal.state === 'READY' ? 'pass' : 'fail';

  if (signal.state !== 'READY') {
    return reject({ signal, asOf, reasonCodes: ['signal_not_ready'], checks });
  }

  checks.freshness = Date.parse(asOf) < Date.parse(signal.expires_at) ? 'pass' : 'fail';
  if (checks.freshness === 'fail') {
    return reject({ signal, asOf, reasonCodes: ['signal_stale'], checks });
  }

  let mode;
  let account;
  let broker;
  let config;
  try {
    mode = normalizeModeState(modeState);
  } catch (error) {
    checks.mode = 'fail';
    return reject({ signal, asOf, reasonCodes: [String(error.message || 'risk_mode_invalid')], checks });
  }
  try {
    account = normalizeAccountState(accountState);
  } catch (error) {
    checks.account = 'fail';
    return reject({ signal, asOf, reasonCodes: [String(error.message || 'risk_account_invalid')], checks });
  }
  try {
    broker = normalizeBrokerState(brokerState);
  } catch (error) {
    checks.broker = 'fail';
    return reject({ signal, asOf, reasonCodes: [String(error.message || 'risk_broker_invalid')], checks });
  }
  try {
    config = normalizeRiskConfig(riskConfig);
  } catch (error) {
    return reject({ signal, asOf, reasonCodes: [String(error.message || 'risk_config_invalid')], checks });
  }

  const reasons = [];

  checks.mode = mode.mode === 'DEMO_AUTO' &&
    mode.demo_auto_enabled &&
    mode.trade_execution_enabled &&
    Boolean(mode.demo_session_id)
    ? 'pass'
    : 'fail';
  if (checks.mode === 'fail') {
    if (mode.mode !== 'DEMO_AUTO' || !mode.demo_auto_enabled) reasons.push('demo_auto_not_enabled');
    if (!mode.trade_execution_enabled) reasons.push('demo_execution_not_enabled');
    if (!mode.demo_session_id) reasons.push('demo_session_required');
  }

  checks.account = account.account_type === 'demo' ? 'pass' : 'fail';
  if (checks.account === 'fail') reasons.push('demo_account_required');

  checks.broker = 'pass';

  const accountAge = Date.parse(asOf) - Date.parse(account.as_of);
  const brokerAge = Date.parse(asOf) - Date.parse(broker.as_of);
  if (accountAge < 0 || brokerAge < 0 || accountAge > config.max_state_age_ms || brokerAge > config.max_state_age_ms) {
    checks.freshness = 'fail';
    reasons.push('risk_state_stale');
  }

  const entry = signalEntry(signal);
  const stopDistance = Math.abs(entry - signal.invalidation);
  const stopPoints = stopDistance / broker.point_size;
  checks.stop = finite(stopPoints) && stopPoints >= config.min_stop_points && stopPoints <= config.max_stop_points
    ? 'pass'
    : 'fail';
  if (checks.stop === 'fail') reasons.push('stop_distance_out_of_bounds');

  const spreadPoints = (broker.ask - broker.bid) / broker.point_size;
  checks.spread = spreadPoints <= config.max_spread_points ? 'pass' : 'fail';
  if (checks.spread === 'fail') reasons.push('spread_too_wide');

  checks.slippage = broker.estimated_slippage_points <= config.max_slippage_points ? 'pass' : 'fail';
  if (checks.slippage === 'fail') reasons.push('slippage_too_high');

  const dailyLossFraction = account.daily_realized_loss / account.equity;
  checks.daily_loss = dailyLossFraction < config.max_daily_loss_fraction ? 'pass' : 'fail';
  if (checks.daily_loss === 'fail') reasons.push('daily_loss_limit_reached');

  const drawdownFraction = (account.peak_equity - account.equity) / account.peak_equity;
  checks.drawdown = drawdownFraction < config.max_drawdown_fraction ? 'pass' : 'fail';
  if (checks.drawdown === 'fail') reasons.push('drawdown_limit_reached');

  checks.positions = account.open_positions < config.max_positions ? 'pass' : 'fail';
  if (checks.positions === 'fail') reasons.push('max_positions_reached');

  checks.cooldown = account.cooldown_active ? 'fail' : 'pass';
  if (checks.cooldown === 'fail') reasons.push('cooldown_active');

  checks.circuit_breaker = account.circuit_breaker_active ? 'fail' : 'pass';
  if (checks.circuit_breaker === 'fail') reasons.push('circuit_breaker_active');

  const maxOpenRiskCurrency = account.equity * config.max_total_open_risk_fraction;
  const remainingOpenRiskCurrency = Math.max(0, maxOpenRiskCurrency - account.open_risk_currency);
  checks.exposure = remainingOpenRiskCurrency > 0 ? 'pass' : 'fail';
  if (checks.exposure === 'fail') reasons.push('open_risk_limit_reached');

  if (reasons.length > 0) {
    return reject({
      signal,
      asOf,
      reasonCodes: reasons,
      checks,
      demoSessionId: mode.demo_session_id,
      sizing: {
        entry_price: round(entry),
        stop_distance: round(stopDistance),
        stop_points: round(stopPoints),
        spread_points: round(spreadPoints),
        daily_loss_fraction: round(dailyLossFraction),
        drawdown_fraction: round(drawdownFraction),
        remaining_open_risk_currency: round(remainingOpenRiskCurrency),
      },
    });
  }

  const lossPerLot = (stopDistance / broker.tick_size) * broker.tick_value_per_lot;
  if (!finite(lossPerLot) || lossPerLot <= 0) {
    checks.stop = 'fail';
    return reject({ signal, asOf, reasonCodes: ['loss_per_lot_invalid'], checks });
  }

  const perTradeBudget = account.equity * config.risk_fraction_per_trade;
  const riskBudget = Math.min(perTradeBudget, remainingOpenRiskCurrency);
  const riskLimitedVolume = riskBudget / lossPerLot;
  const marginLimitedVolume = broker.margin_per_lot > 0
    ? account.free_margin / broker.margin_per_lot
    : 0;
  checks.margin = marginLimitedVolume >= broker.volume_min ? 'pass' : 'fail';

  if (checks.margin === 'fail') {
    return reject({
      signal,
      asOf,
      reasonCodes: ['insufficient_margin_for_min_volume'],
      checks,
      sizing: {
        entry_price: round(entry),
        stop_distance: round(stopDistance),
        stop_points: round(stopPoints),
        loss_per_lot: round(lossPerLot),
        risk_budget_currency: round(riskBudget),
        risk_limited_volume: round(riskLimitedVolume),
        margin_limited_volume: round(marginLimitedVolume),
      },
    });
  }

  const maxPermittedRaw = Math.min(riskLimitedVolume, marginLimitedVolume, broker.volume_max);
  const maxPermittedVolume = floorToStep(
    maxPermittedRaw,
    broker.volume_min,
    broker.volume_max,
    broker.volume_step,
  );

  if (maxPermittedVolume < broker.volume_min) {
    checks.exposure = riskBudget <= 0 ? 'fail' : checks.exposure;
    return reject({
      signal,
      asOf,
      reasonCodes: ['risk_budget_below_min_volume'],
      checks,
      sizing: {
        entry_price: round(entry),
        stop_distance: round(stopDistance),
        stop_points: round(stopPoints),
        loss_per_lot: round(lossPerLot),
        risk_budget_currency: round(riskBudget),
        risk_limited_volume: round(riskLimitedVolume),
        margin_limited_volume: round(marginLimitedVolume),
        broker_volume_min: broker.volume_min,
      },
    });
  }

  let approvedVolume = maxPermittedVolume;
  let decision = 'APPROVE';
  const decisionReasons = [];

  if (config.requested_volume != null) {
    const requestedNormalized = floorToStep(
      config.requested_volume,
      broker.volume_min,
      broker.volume_max,
      broker.volume_step,
    );
    if (requestedNormalized < broker.volume_min) {
      return reject({
        signal,
        asOf,
        reasonCodes: ['requested_volume_below_broker_min'],
        checks,
        sizing: {
          requested_volume: config.requested_volume,
          max_permitted_volume: maxPermittedVolume,
        },
      });
    }

    if (requestedNormalized > maxPermittedVolume) {
      decision = 'RESIZE';
      approvedVolume = maxPermittedVolume;
      decisionReasons.push('requested_volume_reduced');
    } else {
      approvedVolume = requestedNormalized;
    }
  }

  const approvedRiskCurrency = approvedVolume * lossPerLot;
  const approvedRiskFraction = approvedRiskCurrency / account.equity;

  return decisionBase({
    signal,
    decision,
    volume: approvedVolume,
    riskFraction: approvedRiskFraction,
    reasons: decisionReasons,
    checks,
    demoSessionId: mode.demo_session_id,
    sizing: {
      entry_price: round(entry),
      stop_price: signal.invalidation,
      stop_distance: round(stopDistance),
      stop_points: round(stopPoints),
      spread_points: round(spreadPoints),
      estimated_slippage_points: round(broker.estimated_slippage_points),
      max_slippage_points: config.max_slippage_points,
      loss_per_lot: round(lossPerLot),
      per_trade_budget_currency: round(perTradeBudget),
      remaining_open_risk_currency: round(remainingOpenRiskCurrency),
      risk_budget_currency: round(riskBudget),
      risk_limited_volume: round(riskLimitedVolume),
      margin_limited_volume: round(marginLimitedVolume),
      max_permitted_volume: round(maxPermittedVolume),
      requested_volume: config.requested_volume,
      approved_risk_currency: round(approvedRiskCurrency),
      account_equity: round(account.equity),
      free_margin: round(account.free_margin),
      broker_volume_min: broker.volume_min,
      broker_volume_max: broker.volume_max,
      broker_volume_step: broker.volume_step,
      tick_size: broker.tick_size,
      tick_value_per_lot: broker.tick_value_per_lot,
      margin_per_lot: broker.margin_per_lot,
    },
    asOf,
    demoSessionId: mode.demo_session_id,
  });
};
