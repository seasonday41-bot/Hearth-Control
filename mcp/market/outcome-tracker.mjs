import crypto from 'node:crypto';
import { parseTechnicalSignal } from './technical-signal.mjs';

export const TECHNICAL_OUTCOME_VERSION = 'technical-outcome-v1';
export const TECHNICAL_OUTCOME_STATUS = Object.freeze(['TRACKING', 'RESOLVED']);
export const TECHNICAL_OUTCOMES = Object.freeze(['WIN', 'LOSS', 'NEUTRAL']);
export const DEFAULT_OUTCOME_HORIZON_MS = 24 * 60 * 60 * 1000;

const clone = (value) => structuredClone(value);
const finite = (value) => Number.isFinite(value);
const round = (value, digits = 4) => {
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

const normalizeBars = (bars) => {
  if (!Array.isArray(bars)) throw new Error('technical_outcome_bars_required');
  let previousTime = -Infinity;
  return bars.map((bar, index) => {
    if (!bar || typeof bar !== 'object' || Array.isArray(bar)) {
      throw new Error(`technical_outcome_bar_invalid:${index}`);
    }
    const open = Number(bar.open);
    const high = Number(bar.high);
    const low = Number(bar.low);
    const close = Number(bar.close);
    if (![open, high, low, close].every(finite)) {
      throw new Error(`technical_outcome_ohlc_invalid:${index}`);
    }
    if (high < low || high < Math.max(open, close) || low > Math.min(open, close)) {
      throw new Error(`technical_outcome_range_invalid:${index}`);
    }
    const time = normalizeIso(bar.time, `technical_outcome_time_invalid:${index}`);
    const epoch = Date.parse(time);
    if (epoch <= previousTime) throw new Error(`technical_outcome_time_non_monotonic:${index}`);
    previousTime = epoch;
    return { index, time, open, high, low, close };
  });
};

const deriveOutcomeId = (signalId) => {
  const digest = crypto.createHash('sha256').update(signalId).digest('hex').slice(0, 24);
  return `techout:v1:${digest}`;
};

const midpoint = ([lower, upper]) => (lower + upper) / 2;
const contains = (bar, price) => bar.low <= price && bar.high >= price;

const validateGeometry = (signal) => {
  const entry = midpoint(signal.entry_zone);
  const stop = signal.invalidation;
  const target = signal.targets[0];
  if (![entry, stop, target].every(finite)) throw new Error('technical_outcome_geometry_invalid');

  if (signal.direction === 'BUY') {
    if (!(stop < entry && target > entry)) throw new Error('technical_outcome_geometry_invalid');
  } else if (!(stop > entry && target < entry)) {
    throw new Error('technical_outcome_geometry_invalid');
  }

  const riskDistance = Math.abs(entry - stop);
  if (!(riskDistance > 0)) throw new Error('technical_outcome_risk_distance_invalid');
  return { entry, stop, target, riskDistance };
};

const excursionForBar = (bar, direction, entry, riskDistance) => {
  const favorable = direction === 'BUY' ? bar.high - entry : entry - bar.low;
  const adverse = direction === 'BUY' ? entry - bar.low : bar.high - entry;
  return {
    mfe_r: Math.max(0, favorable / riskDistance),
    mae_r: Math.max(0, adverse / riskDistance),
  };
};

const exitTouches = (bar, direction, stop, target) => ({
  stop: direction === 'BUY' ? bar.low <= stop : bar.high >= stop,
  target: direction === 'BUY' ? bar.high >= target : bar.low <= target,
});

const targetR = (entry, target, riskDistance) => Math.abs(target - entry) / riskDistance;

const baseOutcome = ({ signal, observedAt, entry, stop, target, riskDistance }) => ({
  version: TECHNICAL_OUTCOME_VERSION,
  id: deriveOutcomeId(signal.id),
  signal_id: signal.id,
  strategy: signal.strategy,
  symbol: 'XAUUSD',
  direction: signal.direction,
  signal_as_of: signal.as_of,
  observed_at: observedAt,
  status: 'TRACKING',
  outcome: null,
  reason_code: null,
  entry_model: 'zone_midpoint_after_signal',
  entry_price: round(entry),
  entry_at: null,
  stop_price: round(stop),
  target_price: round(target),
  risk_distance: round(riskDistance),
  realized_r: null,
  mae_r: 0,
  mfe_r: 0,
  resolved_at: null,
  bars_observed: 0,
});

const resolve = (base, {
  outcome,
  reasonCode,
  realizedR,
  maeR,
  mfeR,
  resolvedAt,
  entryAt,
  barsObserved,
}) => ({
  ...base,
  status: 'RESOLVED',
  outcome,
  reason_code: reasonCode,
  realized_r: round(realizedR),
  mae_r: round(maeR),
  mfe_r: round(mfeR),
  resolved_at: resolvedAt,
  entry_at: entryAt,
  bars_observed: barsObserved,
});

export const evaluateTechnicalSignalOutcome = (
  technicalSignal,
  bars,
  { outcomeHorizonMs = DEFAULT_OUTCOME_HORIZON_MS } = {},
) => {
  const signal = parseTechnicalSignal(technicalSignal);
  if (signal.state !== 'READY') throw new Error('technical_outcome_ready_signal_required');

  const horizonMs = Number(outcomeHorizonMs);
  if (!Number.isFinite(horizonMs) || horizonMs <= 0) throw new Error('technical_outcome_horizon_invalid');

  const observed = normalizeBars(bars).filter((bar) => Date.parse(bar.time) > Date.parse(signal.as_of));
  const observedAt = observed.at(-1)?.time || signal.as_of;
  const { entry, stop, target, riskDistance } = validateGeometry(signal);
  const base = baseOutcome({ signal, observedAt, entry, stop, target, riskDistance });
  const entryDeadline = Date.parse(signal.expires_at);

  let entryBar = null;
  for (const bar of observed) {
    if (Date.parse(bar.time) > entryDeadline) break;
    if (contains(bar, entry)) {
      entryBar = bar;
      break;
    }
  }

  if (!entryBar) {
    if (Date.parse(observedAt) < entryDeadline) return { ...base, bars_observed: observed.length };
    return resolve(base, {
      outcome: 'NEUTRAL',
      reasonCode: 'entry_not_reached_before_signal_expiry',
      realizedR: 0,
      maeR: 0,
      mfeR: 0,
      resolvedAt: new Date(entryDeadline).toISOString(),
      entryAt: null,
      barsObserved: observed.filter((bar) => Date.parse(bar.time) <= entryDeadline).length,
    });
  }

  const entryAt = entryBar.time;
  const entryIndex = observed.indexOf(entryBar);
  const entryTouches = exitTouches(entryBar, signal.direction, stop, target);
  if (entryTouches.stop || entryTouches.target) {
    return resolve(base, {
      outcome: 'NEUTRAL',
      reasonCode: 'entry_exit_same_bar_ambiguous',
      realizedR: 0,
      maeR: round(excursionForBar(entryBar, signal.direction, entry, riskDistance).mae_r),
      mfeR: round(excursionForBar(entryBar, signal.direction, entry, riskDistance).mfe_r),
      resolvedAt: entryBar.time,
      entryAt,
      barsObserved: entryIndex + 1,
    });
  }

  const horizonDeadline = Date.parse(entryAt) + horizonMs;
  let maeR = 0;
  let mfeR = 0;
  let barsObserved = entryIndex + 1;

  for (let index = entryIndex + 1; index < observed.length; index += 1) {
    const bar = observed[index];
    if (Date.parse(bar.time) > horizonDeadline) break;
    barsObserved = index + 1;

    const excursion = excursionForBar(bar, signal.direction, entry, riskDistance);
    maeR = Math.max(maeR, excursion.mae_r);
    mfeR = Math.max(mfeR, excursion.mfe_r);

    const touched = exitTouches(bar, signal.direction, stop, target);
    if (touched.stop && touched.target) {
      return resolve(base, {
        outcome: 'NEUTRAL',
        reasonCode: 'stop_target_same_bar_ambiguous',
        realizedR: 0,
        maeR,
        mfeR,
        resolvedAt: bar.time,
        entryAt,
        barsObserved,
      });
    }
    if (touched.target) {
      return resolve(base, {
        outcome: 'WIN',
        reasonCode: 'target_reached',
        realizedR: targetR(entry, target, riskDistance),
        maeR,
        mfeR,
        resolvedAt: bar.time,
        entryAt,
        barsObserved,
      });
    }
    if (touched.stop) {
      return resolve(base, {
        outcome: 'LOSS',
        reasonCode: 'invalidation_reached',
        realizedR: -1,
        maeR,
        mfeR,
        resolvedAt: bar.time,
        entryAt,
        barsObserved,
      });
    }
  }

  const coverageAt = Date.parse(observedAt);
  if (coverageAt < horizonDeadline) {
    return {
      ...base,
      entry_at: entryAt,
      mae_r: round(maeR),
      mfe_r: round(mfeR),
      bars_observed: barsObserved,
    };
  }

  return resolve(base, {
    outcome: 'NEUTRAL',
    reasonCode: 'outcome_horizon_expired',
    realizedR: 0,
    maeR,
    mfeR,
    resolvedAt: new Date(horizonDeadline).toISOString(),
    entryAt,
    barsObserved,
  });
};

const validateOutcome = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('technical_outcome_invalid');
  if (value.version !== TECHNICAL_OUTCOME_VERSION) throw new Error('technical_outcome_version_invalid');
  if (typeof value.id !== 'string' || !/^techout:v1:[a-f0-9]{24}$/.test(value.id)) throw new Error('technical_outcome_id_invalid');
  if (typeof value.signal_id !== 'string' || !/^techsig:v1:[a-f0-9]{24}$/.test(value.signal_id)) throw new Error('technical_outcome_signal_id_invalid');
  if (!['SMC_IDM', 'HARMONIC_PRZ'].includes(value.strategy)) throw new Error('technical_outcome_strategy_invalid');
  if (!['BUY', 'SELL'].includes(value.direction)) throw new Error('technical_outcome_direction_invalid');
  if (!TECHNICAL_OUTCOME_STATUS.includes(value.status)) throw new Error('technical_outcome_status_invalid');
  if (value.status === 'RESOLVED' && !TECHNICAL_OUTCOMES.includes(value.outcome)) throw new Error('technical_outcome_result_invalid');
  if (value.status === 'TRACKING' && value.outcome !== null) throw new Error('technical_outcome_tracking_result_invalid');
  return clone(value);
};

const outcomeFingerprint = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class TechnicalOutcomeBook {
  constructor() {
    this.outcomes = new Map();
  }

  upsert(outcome) {
    const next = validateOutcome(outcome);
    const existing = this.outcomes.get(next.signal_id);

    if (!existing) {
      this.outcomes.set(next.signal_id, next);
      return { outcome: clone(next), created: true, updated: false };
    }
    if (outcomeFingerprint(existing) === outcomeFingerprint(next)) {
      return { outcome: clone(existing), created: false, updated: false };
    }
    if (existing.id !== next.id || existing.strategy !== next.strategy || existing.direction !== next.direction) {
      throw new Error('technical_outcome_identity_conflict');
    }
    if (existing.status === 'RESOLVED') throw new Error('technical_outcome_terminal');
    if (Date.parse(next.observed_at) < Date.parse(existing.observed_at)) throw new Error('technical_outcome_stale_update');

    this.outcomes.set(next.signal_id, next);
    return { outcome: clone(next), created: false, updated: true };
  }

  get(signalId) {
    const value = this.outcomes.get(signalId);
    return value ? clone(value) : null;
  }

  list() {
    return [...this.outcomes.values()]
      .map((item) => clone(item))
      .sort((a, b) => Date.parse(a.resolved_at || a.observed_at) - Date.parse(b.resolved_at || b.observed_at));
  }

  summary() {
    return summarizeTechnicalOutcomes(this.list());
  }
}

const summarizeGroup = (items) => {
  const resolved = items.filter((item) => item.status === 'RESOLVED');
  const wins = resolved.filter((item) => item.outcome === 'WIN');
  const losses = resolved.filter((item) => item.outcome === 'LOSS');
  const neutrals = resolved.filter((item) => item.outcome === 'NEUTRAL');
  const decided = wins.length + losses.length;

  let cumulativeR = 0;
  let peakR = 0;
  let maxDrawdownR = 0;
  let grossProfitR = 0;
  let grossLossR = 0;

  for (const item of resolved.slice().sort((a, b) => Date.parse(a.resolved_at) - Date.parse(b.resolved_at))) {
    const value = Number(item.realized_r) || 0;
    cumulativeR += value;
    peakR = Math.max(peakR, cumulativeR);
    maxDrawdownR = Math.max(maxDrawdownR, peakR - cumulativeR);
    if (value > 0) grossProfitR += value;
    if (value < 0) grossLossR += Math.abs(value);
  }

  const average = (values) => values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;

  return {
    total: items.length,
    tracking: items.length - resolved.length,
    resolved: resolved.length,
    wins: wins.length,
    losses: losses.length,
    neutrals: neutrals.length,
    win_rate: decided ? round(wins.length / decided, 6) : null,
    cumulative_r: round(cumulativeR),
    gross_profit_r: round(grossProfitR),
    gross_loss_r: round(grossLossR),
    profit_factor_r: grossLossR > 0 ? round(grossProfitR / grossLossR, 6) : null,
    max_drawdown_r: round(maxDrawdownR),
    average_mae_r: average(resolved.map((item) => Number(item.mae_r) || 0)) == null
      ? null
      : round(average(resolved.map((item) => Number(item.mae_r) || 0))),
    average_mfe_r: average(resolved.map((item) => Number(item.mfe_r) || 0)) == null
      ? null
      : round(average(resolved.map((item) => Number(item.mfe_r) || 0))),
  };
};

export const summarizeTechnicalOutcomes = (outcomes) => {
  if (!Array.isArray(outcomes)) throw new Error('technical_outcomes_required');
  const parsed = outcomes.map(validateOutcome);
  return {
    version: 'technical-outcome-summary-v1',
    overall: summarizeGroup(parsed),
    by_strategy: {
      SMC_IDM: summarizeGroup(parsed.filter((item) => item.strategy === 'SMC_IDM')),
      HARMONIC_PRZ: summarizeGroup(parsed.filter((item) => item.strategy === 'HARMONIC_PRZ')),
    },
    methodology: {
      entry_model: 'zone midpoint must be touched strictly after signal.as_of and before signal.expires_at',
      exit_model: 'first target versus invalidation after entry; same-bar ordering ambiguity resolves NEUTRAL',
      win_rate_denominator: 'WIN + LOSS only; NEUTRAL excluded',
      realized_r: 'WIN uses TP1 distance divided by initial risk; LOSS=-1R; NEUTRAL=0R',
      profit_factor_r: 'gross positive R / absolute gross negative R; null when no losses exist',
      max_drawdown_r: 'peak-to-trough drawdown of cumulative resolved R ordered by resolved_at',
    },
  };
};
