import { detectConfirmedThreeBarSwings } from './swing-core.mjs';

export const SMC_IDM_ENGINE_VERSION = 'smc-idm-engine-v1';

const finite = (value) => Number.isFinite(value);
const round = (value, digits = 2) => {
  if (!finite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const normalizeIso = (value) => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

const normalizeBars = (bars, label) => {
  if (!Array.isArray(bars) || bars.length < 3) throw new Error(`smc_${label}_bars_insufficient`);
  let previousTime = -Infinity;
  return bars.map((bar, index) => {
    if (!bar || typeof bar !== 'object' || Array.isArray(bar)) throw new Error(`smc_${label}_bar_invalid:${index}`);
    const open = Number(bar.open);
    const high = Number(bar.high);
    const low = Number(bar.low);
    const close = Number(bar.close);
    if (![open, high, low, close].every(finite)) throw new Error(`smc_${label}_ohlc_invalid:${index}`);
    if (high < low || high < Math.max(open, close) || low > Math.min(open, close)) {
      throw new Error(`smc_${label}_range_invalid:${index}`);
    }
    const time = normalizeIso(bar.time);
    if (!time) throw new Error(`smc_${label}_time_invalid:${index}`);
    const epoch = Date.parse(time);
    if (epoch <= previousTime) throw new Error(`smc_${label}_time_non_monotonic:${index}`);
    previousTime = epoch;
    return { index, time, open, high, low, close };
  });
};

const swingsByType = (bars, type) => detectConfirmedThreeBarSwings(bars).filter((item) => item.type === type);

const contextBias = (bars) => {
  const highs = swingsByType(bars, 'HIGH');
  const lows = swingsByType(bars, 'LOW');
  if (highs.length < 2 || lows.length < 2) {
    return { bias: 'neutral', highs: highs.slice(-2), lows: lows.slice(-2) };
  }

  const previousHigh = highs.at(-2);
  const latestHigh = highs.at(-1);
  const previousLow = lows.at(-2);
  const latestLow = lows.at(-1);

  const bullish = latestHigh.price > previousHigh.price && latestLow.price > previousLow.price;
  const bearish = latestHigh.price < previousHigh.price && latestLow.price < previousLow.price;

  return {
    bias: bullish ? 'bullish' : bearish ? 'bearish' : 'neutral',
    highs: [previousHigh, latestHigh],
    lows: [previousLow, latestLow],
  };
};

const findLatestBos = (bars, direction) => {
  const type = direction === 'BUY' ? 'HIGH' : 'LOW';
  const swings = swingsByType(bars, type);
  let latest = null;

  for (const swing of swings) {
    for (let index = swing.confirmed_index + 1; index < bars.length; index += 1) {
      const broken = direction === 'BUY'
        ? bars[index].close > swing.price
        : bars[index].close < swing.price;
      if (!broken) continue;
      const candidate = {
        direction,
        reference: swing,
        break_index: index,
        break_time: bars[index].time,
        break_close: bars[index].close,
        break_high: bars[index].high,
        break_low: bars[index].low,
        confirmation: 'close',
      };
      if (!latest || candidate.break_index > latest.break_index) latest = candidate;
      break;
    }
  }

  return latest;
};

const findIdm = (bars, bos, direction) => {
  if (!bos) return null;
  const type = direction === 'BUY' ? 'LOW' : 'HIGH';
  const swings = swingsByType(bars, type);
  for (let index = swings.length - 1; index >= 0; index -= 1) {
    const swing = swings[index];
    if (swing.confirmed_index < bos.break_index) return swing;
  }
  return null;
};

const rangeOverlap = (bar, zone) => bar.high >= zone.lower && bar.low <= zone.upper;

const findOrderBlock = (bars, bos, direction) => {
  for (let index = bos.break_index - 1; index >= 0; index -= 1) {
    const bar = bars[index];
    const opposite = direction === 'BUY' ? bar.close < bar.open : bar.close > bar.open;
    if (!opposite) continue;
    return {
      kind: 'ORDER_BLOCK',
      lower: bar.low,
      upper: bar.high,
      index,
      time: bar.time,
    };
  }
  return null;
};

const findFvgs = (bars, bos, direction) => {
  const zones = [];
  for (let index = 2; index <= bos.break_index; index += 1) {
    const twoBack = bars[index - 2];
    const current = bars[index];
    if (direction === 'BUY' && current.low > twoBack.high) {
      zones.push({
        kind: 'FVG',
        lower: twoBack.high,
        upper: current.low,
        index,
        time: current.time,
      });
    }
    if (direction === 'SELL' && current.high < twoBack.low) {
      zones.push({
        kind: 'FVG',
        lower: current.high,
        upper: twoBack.low,
        index,
        time: current.time,
      });
    }
  }
  return zones;
};

const midpoint = (lower, upper) => (lower + upper) / 2;

const zoneOnCorrectSide = (zone, dealingMidpoint, direction) => direction === 'BUY'
  ? midpoint(zone.lower, zone.upper) < dealingMidpoint
  : midpoint(zone.lower, zone.upper) > dealingMidpoint;

const mergeOverlap = (first, second) => {
  if (!first || !second) return null;
  const lower = Math.max(first.lower, second.lower);
  const upper = Math.min(first.upper, second.upper);
  if (lower > upper) return null;
  return {
    kind: 'OB_FVG',
    lower,
    upper,
    components: [first, second],
    index: Math.max(first.index, second.index),
    time: first.index >= second.index ? first.time : second.time,
  };
};

const selectZone = (bars, bos, direction, dealingMidpoint) => {
  const ob = findOrderBlock(bars, bos, direction);
  const fvgs = findFvgs(bars, bos, direction);
  const eligibleOb = ob && zoneOnCorrectSide(ob, dealingMidpoint, direction) ? ob : null;
  const eligibleFvgs = fvgs.filter((zone) => zoneOnCorrectSide(zone, dealingMidpoint, direction));

  if (eligibleOb) {
    for (let index = eligibleFvgs.length - 1; index >= 0; index -= 1) {
      const merged = mergeOverlap(eligibleOb, eligibleFvgs[index]);
      if (merged && zoneOnCorrectSide(merged, dealingMidpoint, direction)) return merged;
    }
  }

  const candidates = [
    ...(eligibleOb ? [eligibleOb] : []),
    ...eligibleFvgs,
  ];
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (direction === 'BUY') return midpoint(b.lower, b.upper) - midpoint(a.lower, a.upper);
    return midpoint(a.lower, a.upper) - midpoint(b.lower, b.upper);
  });
  return candidates[0];
};

const findPostBosState = (bars, bos, idm, zone, direction) => {
  let sweep = null;
  let zoneTouch = null;
  let invalidated = null;

  for (let index = bos.break_index + 1; index < bars.length; index += 1) {
    const bar = bars[index];
    if (!zoneTouch && zone && rangeOverlap(bar, zone)) zoneTouch = { index, time: bar.time };

    if (direction === 'BUY') {
      if (bar.close <= idm.price) {
        invalidated = { index, time: bar.time, close: bar.close };
        break;
      }
      if (!sweep && bar.low <= idm.price && bar.close > idm.price) {
        sweep = { index, time: bar.time, price: bar.low, close: bar.close };
      }
    } else {
      if (bar.close >= idm.price) {
        invalidated = { index, time: bar.time, close: bar.close };
        break;
      }
      if (!sweep && bar.high >= idm.price && bar.close < idm.price) {
        sweep = { index, time: bar.time, price: bar.high, close: bar.close };
      }
    }
  }

  return { sweep, zoneTouch, invalidated };
};

const findMicroBos = (bars, direction, notBeforeTime) => {
  const type = direction === 'BUY' ? 'HIGH' : 'LOW';
  const swings = swingsByType(bars, type);
  const threshold = Date.parse(notBeforeTime);
  let latest = null;

  for (const swing of swings) {
    if (Date.parse(swing.confirmed_at) < threshold) continue;
    for (let index = swing.confirmed_index + 1; index < bars.length; index += 1) {
      const bar = bars[index];
      if (Date.parse(bar.time) < threshold) continue;
      const broken = direction === 'BUY' ? bar.close > swing.price : bar.close < swing.price;
      if (!broken) continue;
      const candidate = {
        reference: swing,
        break_index: index,
        break_time: bar.time,
        break_close: bar.close,
        confirmation: 'close',
      };
      if (!latest || candidate.break_index > latest.break_index) latest = candidate;
      break;
    }
  }
  return latest;
};

const invalidResult = ({ direction, asOf, reasonCodes, context }) => ({
  version: SMC_IDM_ENGINE_VERSION,
  strategy: 'SMC_IDM',
  symbol: 'XAUUSD',
  direction,
  state: 'INVALID',
  context_timeframe: 'H1',
  setup_timeframe: 'M15',
  trigger_timeframe: 'M5',
  entry_zone: null,
  invalidation: null,
  targets: [],
  evidence: { context },
  reason_codes: reasonCodes,
  as_of: asOf,
});

export const analyzeSmcIdm = ({ contextBars, setupBars, triggerBars } = {}) => {
  const context = normalizeBars(contextBars, 'context');
  const setup = normalizeBars(setupBars, 'setup');
  const trigger = normalizeBars(triggerBars, 'trigger');
  const asOf = trigger.at(-1)?.time || setup.at(-1)?.time || context.at(-1)?.time || '';

  const contextState = contextBias(context);
  if (contextState.bias === 'neutral') {
    return invalidResult({
      direction: null,
      asOf,
      reasonCodes: ['context_not_directional'],
      context: contextState,
    });
  }

  const direction = contextState.bias === 'bullish' ? 'BUY' : 'SELL';
  const bos = findLatestBos(setup, direction);
  if (!bos) {
    return invalidResult({
      direction,
      asOf,
      reasonCodes: ['bos_not_confirmed'],
      context: contextState,
    });
  }

  const idm = findIdm(setup, bos, direction);
  if (!idm) {
    return invalidResult({
      direction,
      asOf,
      reasonCodes: ['idm_not_found'],
      context: contextState,
    });
  }

  const impulseSlice = setup.slice(idm.index, bos.break_index + 1);
  const rangeLow = direction === 'BUY'
    ? idm.price
    : Math.min(...impulseSlice.map((bar) => bar.low));
  const rangeHigh = direction === 'BUY'
    ? Math.max(...impulseSlice.map((bar) => bar.high))
    : idm.price;
  const dealingMidpoint = midpoint(rangeLow, rangeHigh);

  const zone = selectZone(setup, bos, direction, dealingMidpoint);
  if (!zone) {
    return invalidResult({
      direction,
      asOf,
      reasonCodes: ['discount_premium_zone_not_found'],
      context: contextState,
    });
  }

  const postBos = findPostBosState(setup, bos, idm, zone, direction);
  if (postBos.invalidated) {
    return {
      ...invalidResult({
        direction,
        asOf,
        reasonCodes: ['idm_structure_invalidated'],
        context: contextState,
      }),
      evidence: {
        context: contextState,
        bos,
        idm,
        dealing_range: { low: round(rangeLow), high: round(rangeHigh), midpoint: round(dealingMidpoint) },
        zone,
        post_bos: postBos,
      },
    };
  }

  const triggerAfter = postBos.sweep?.time || bos.break_time;
  const microBos = postBos.sweep ? findMicroBos(trigger, direction, triggerAfter) : null;
  const ready = Boolean(postBos.sweep && postBos.zoneTouch && microBos);
  const state = ready ? 'READY' : 'PRE_SIGNAL';

  const postBosBars = setup.slice(bos.break_index + 1);
  const invalidation = direction === 'BUY'
    ? Math.min(idm.price, ...(postBosBars.length ? postBosBars.map((bar) => bar.low) : [idm.price]))
    : Math.max(idm.price, ...(postBosBars.length ? postBosBars.map((bar) => bar.high) : [idm.price]));
  const target = direction === 'BUY' ? rangeHigh : rangeLow;

  const reasonCodes = [];
  if (!postBos.sweep) reasonCodes.push('waiting_for_idm_sweep');
  if (!postBos.zoneTouch) reasonCodes.push('waiting_for_zone_touch');
  if (postBos.sweep && postBos.zoneTouch && !microBos) reasonCodes.push('waiting_for_m5_micro_bos');

  return {
    version: SMC_IDM_ENGINE_VERSION,
    strategy: 'SMC_IDM',
    symbol: 'XAUUSD',
    direction,
    state,
    context_timeframe: 'H1',
    setup_timeframe: 'M15',
    trigger_timeframe: 'M5',
    entry_zone: [round(zone.lower), round(zone.upper)],
    invalidation: round(invalidation),
    targets: [round(target)],
    evidence: {
      context: contextState,
      bos,
      idm,
      dealing_range: {
        low: round(rangeLow),
        high: round(rangeHigh),
        midpoint: round(dealingMidpoint),
        side: direction === 'BUY' ? 'discount' : 'premium',
      },
      zone,
      post_bos: postBos,
      trigger: microBos,
    },
    reason_codes: reasonCodes,
    as_of: asOf,
  };
};
