import { detectConfirmedThreeBarSwings } from './swing-core.mjs';

export const HARMONIC_PRZ_ENGINE_VERSION = 'harmonic-prz-engine-v1';

const PATTERNS = Object.freeze([
  Object.freeze({
    id: 'GARTLEY',
    ab_xa: Object.freeze([0.58, 0.66]),
    bc_ab: Object.freeze([0.382, 0.886]),
    ad_xa: Object.freeze([0.756, 0.816]),
    cd_bc: Object.freeze([1.13, 1.618]),
    cd_ab: Object.freeze([0.9, 1.1]),
  }),
  Object.freeze({
    id: 'BAT',
    ab_xa: Object.freeze([0.382, 0.5]),
    bc_ab: Object.freeze([0.382, 0.886]),
    ad_xa: Object.freeze([0.856, 0.916]),
    cd_bc: Object.freeze([1.618, 2.618]),
    cd_ab: Object.freeze([1.27, 1.618]),
  }),
]);

const INVALIDATION_BUFFER_XA = 0.02;
const finite = (value) => Number.isFinite(value);

const round = (value, digits = 4) => {
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
  if (!Array.isArray(bars) || bars.length < 3) throw new Error(`harmonic_${label}_bars_insufficient`);
  let previousTime = -Infinity;
  return bars.map((bar, index) => {
    if (!bar || typeof bar !== 'object' || Array.isArray(bar)) throw new Error(`harmonic_${label}_bar_invalid:${index}`);
    const open = Number(bar.open);
    const high = Number(bar.high);
    const low = Number(bar.low);
    const close = Number(bar.close);
    if (![open, high, low, close].every(finite)) throw new Error(`harmonic_${label}_ohlc_invalid:${index}`);
    if (high < low || high < Math.max(open, close) || low > Math.min(open, close)) {
      throw new Error(`harmonic_${label}_range_invalid:${index}`);
    }
    const time = normalizeIso(bar.time);
    if (!time) throw new Error(`harmonic_${label}_time_invalid:${index}`);
    const epoch = Date.parse(time);
    if (epoch <= previousTime) throw new Error(`harmonic_${label}_time_non_monotonic:${index}`);
    previousTime = epoch;
    return { index, time, open, high, low, close };
  });
};

const inRange = (value, range) => finite(value) && value >= range[0] && value <= range[1];

const summarizeContext = (bars) => {
  const swings = detectConfirmedThreeBarSwings(bars);
  const highs = swings.filter((item) => item.type === 'HIGH').slice(-2);
  const lows = swings.filter((item) => item.type === 'LOW').slice(-2);
  if (highs.length < 2 || lows.length < 2) return { bias: 'neutral', highs, lows };

  const bullish = highs[1].price > highs[0].price && lows[1].price > lows[0].price;
  const bearish = highs[1].price < highs[0].price && lows[1].price < lows[0].price;
  return {
    bias: bullish ? 'bullish' : bearish ? 'bearish' : 'neutral',
    highs,
    lows,
  };
};

const buildAlternatingZigzag = (bars) => {
  const raw = detectConfirmedThreeBarSwings(bars);
  const byIndex = new Map();
  for (const swing of raw) {
    const list = byIndex.get(swing.index) || [];
    list.push(swing);
    byIndex.set(swing.index, list);
  }

  const unambiguous = [...byIndex.values()]
    .filter((group) => group.length === 1)
    .map((group) => group[0])
    .sort((a, b) => a.index - b.index);

  const zigzag = [];
  for (const swing of unambiguous) {
    const previous = zigzag.at(-1);
    if (!previous || previous.type !== swing.type) {
      zigzag.push({ ...swing });
      continue;
    }

    const moreExtreme = swing.type === 'HIGH'
      ? swing.price > previous.price
      : swing.price < previous.price;
    if (moreExtreme) zigzag[zigzag.length - 1] = { ...swing };
  }
  return zigzag;
};

const directionForPoints = (points) => {
  const types = points.map((item) => item.type).join(',');
  if (types === 'LOW,HIGH,LOW,HIGH' || types === 'LOW,HIGH,LOW,HIGH,LOW') return 'BUY';
  if (types === 'HIGH,LOW,HIGH,LOW' || types === 'HIGH,LOW,HIGH,LOW,HIGH') return 'SELL';
  return null;
};

const validGeometry = (points, direction) => {
  const [x, a, b, c, d] = points;
  if (direction === 'BUY') {
    if (!(x.price < a.price && b.price > x.price && b.price < a.price && c.price > b.price && c.price < a.price)) return false;
    if (d && !(d.price < c.price && d.price > x.price)) return false;
    return true;
  }
  if (direction === 'SELL') {
    if (!(x.price > a.price && b.price < x.price && b.price > a.price && c.price < b.price && c.price > a.price)) return false;
    if (d && !(d.price > c.price && d.price < x.price)) return false;
    return true;
  }
  return false;
};

const ratio = (numerator, denominator) => denominator > 0 ? numerator / denominator : null;

const xabcRatios = ([x, a, b, c]) => {
  const xa = Math.abs(a.price - x.price);
  const ab = Math.abs(b.price - a.price);
  const bc = Math.abs(c.price - b.price);
  return {
    lengths: { xa, ab, bc },
    ratios: {
      ab_xa: ratio(ab, xa),
      bc_ab: ratio(bc, ab),
    },
  };
};

const fullRatios = ([x, a, b, c, d]) => {
  const base = xabcRatios([x, a, b, c]);
  const ad = Math.abs(d.price - a.price);
  const cd = Math.abs(d.price - c.price);
  return {
    lengths: { ...base.lengths, ad, cd },
    ratios: {
      ...base.ratios,
      ad_xa: ratio(ad, base.lengths.xa),
      cd_bc: ratio(cd, base.lengths.bc),
      cd_ab: ratio(cd, base.lengths.ab),
    },
  };
};

const projectedInterval = ({ anchor, length, range, direction }) => {
  const first = direction === 'BUY'
    ? anchor - (length * range[0])
    : anchor + (length * range[0]);
  const second = direction === 'BUY'
    ? anchor - (length * range[1])
    : anchor + (length * range[1]);
  return { lower: Math.min(first, second), upper: Math.max(first, second) };
};

const intersectIntervals = (intervals) => {
  const lower = Math.max(...intervals.map((item) => item.lower));
  const upper = Math.min(...intervals.map((item) => item.upper));
  return lower <= upper ? { lower, upper } : null;
};

const buildPrz = (points, pattern, direction) => {
  const [x, a, b, c] = points;
  const { lengths } = xabcRatios([x, a, b, c]);
  if (![lengths.xa, lengths.ab, lengths.bc].every((value) => finite(value) && value > 0)) return null;

  const xa = projectedInterval({
    anchor: a.price,
    length: lengths.xa,
    range: pattern.ad_xa,
    direction,
  });
  const bc = projectedInterval({
    anchor: c.price,
    length: lengths.bc,
    range: pattern.cd_bc,
    direction,
  });
  const abcd = projectedInterval({
    anchor: c.price,
    length: lengths.ab,
    range: pattern.cd_ab,
    direction,
  });
  const intersection = intersectIntervals([xa, bc, abcd]);
  if (!intersection) return null;

  return {
    lower: intersection.lower,
    upper: intersection.upper,
    components: {
      xa_retracement: xa,
      bc_extension: bc,
      ab_cd_projection: abcd,
    },
  };
};

const matchingProjectedPatterns = (points, direction) => {
  const measured = xabcRatios(points);
  return PATTERNS
    .filter((pattern) =>
      inRange(measured.ratios.ab_xa, pattern.ab_xa) &&
      inRange(measured.ratios.bc_ab, pattern.bc_ab))
    .map((pattern) => ({
      pattern,
      measured,
      prz: buildPrz(points, pattern, direction),
    }))
    .filter((item) => item.prz);
};

const fullPatternMatches = (points, projected) => {
  const measured = fullRatios(points);
  const { pattern, prz } = projected;
  const d = points[4];
  return (
    inRange(measured.ratios.ad_xa, pattern.ad_xa) &&
    inRange(measured.ratios.cd_bc, pattern.cd_bc) &&
    inRange(measured.ratios.cd_ab, pattern.cd_ab) &&
    d.price >= prz.lower &&
    d.price <= prz.upper
  ) ? measured : null;
};

const findLatestCandidate = (zigzag) => {
  for (let start = zigzag.length - 5; start >= 0; start -= 1) {
    const points = zigzag.slice(start, start + 5);
    if (points.length !== 5) continue;
    const direction = directionForPoints(points);
    if (!direction || !validGeometry(points, direction)) continue;

    const xabc = points.slice(0, 4);
    for (const projected of matchingProjectedPatterns(xabc, direction)) {
      const measured = fullPatternMatches(points, projected);
      if (!measured) continue;
      return {
        direction,
        points,
        pattern: projected.pattern,
        measured,
        prz: projected.prz,
        complete: true,
      };
    }
  }

  for (let start = zigzag.length - 4; start >= 0; start -= 1) {
    const points = zigzag.slice(start, start + 4);
    if (points.length !== 4) continue;
    const direction = directionForPoints(points);
    if (!direction || !validGeometry(points, direction)) continue;
    const projected = matchingProjectedPatterns(points, direction)[0];
    if (!projected) continue;
    return {
      direction,
      points,
      pattern: projected.pattern,
      measured: projected.measured,
      prz: projected.prz,
      complete: false,
    };
  }

  return null;
};

const findMicroBos = (bars, direction, notBeforeTime) => {
  const type = direction === 'BUY' ? 'HIGH' : 'LOW';
  const swings = detectConfirmedThreeBarSwings(bars).filter((item) => item.type === type);
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

const structuralInvalidation = (setupBars, candidate) => {
  if (!candidate.complete) return null;
  const x = candidate.points[0];
  const d = candidate.points[4];
  for (let index = d.confirmed_index + 1; index < setupBars.length; index += 1) {
    const bar = setupBars[index];
    if (candidate.direction === 'BUY' && bar.close <= x.price) {
      return { index, time: bar.time, close: bar.close };
    }
    if (candidate.direction === 'SELL' && bar.close >= x.price) {
      return { index, time: bar.time, close: bar.close };
    }
  }
  return null;
};

const deriveTradeLevels = (candidate) => {
  const [x, a] = candidate.points;
  const xa = Math.abs(a.price - x.price);
  const dReference = candidate.complete
    ? candidate.points[4].price
    : (candidate.prz.lower + candidate.prz.upper) / 2;
  const invalidation = candidate.direction === 'BUY'
    ? x.price - (xa * INVALIDATION_BUFFER_XA)
    : x.price + (xa * INVALIDATION_BUFFER_XA);
  const ad = Math.abs(a.price - dReference);
  const targets = candidate.direction === 'BUY'
    ? [dReference + (ad * 0.382), dReference + (ad * 0.618)]
    : [dReference - (ad * 0.382), dReference - (ad * 0.618)];

  return {
    invalidation: round(invalidation),
    targets: targets.map((value) => round(value)),
  };
};

const serializePoints = (points) => {
  const labels = ['X', 'A', 'B', 'C', 'D'];
  const out = {};
  for (let index = 0; index < points.length; index += 1) {
    out[labels[index]] = { ...points[index] };
  }
  if (points.length < 5) out.D = null;
  return out;
};

const roundedPrz = (prz) => ({
  lower: round(prz.lower),
  upper: round(prz.upper),
  components: Object.fromEntries(
    Object.entries(prz.components).map(([key, interval]) => [
      key,
      { lower: round(interval.lower), upper: round(interval.upper) },
    ]),
  ),
});

const roundedRatios = (measured) => ({
  lengths: Object.fromEntries(Object.entries(measured.lengths).map(([key, value]) => [key, round(value)])),
  ratios: Object.fromEntries(Object.entries(measured.ratios).map(([key, value]) => [key, round(value)])),
});

export const analyzeHarmonicPrz = ({ contextBars, setupBars, triggerBars } = {}) => {
  const context = normalizeBars(contextBars, 'context');
  const setup = normalizeBars(setupBars, 'setup');
  const trigger = normalizeBars(triggerBars, 'trigger');
  const asOf = trigger.at(-1)?.time || setup.at(-1)?.time || context.at(-1)?.time || '';
  const contextState = summarizeContext(context);
  const zigzag = buildAlternatingZigzag(setup);
  const candidate = findLatestCandidate(zigzag);

  if (!candidate) {
    return {
      version: HARMONIC_PRZ_ENGINE_VERSION,
      strategy: 'HARMONIC_PRZ',
      symbol: 'XAUUSD',
      direction: null,
      state: 'INVALID',
      pattern: null,
      context_timeframe: 'H1',
      setup_timeframe: 'M15',
      trigger_timeframe: 'M5',
      prz: null,
      entry_zone: null,
      invalidation: null,
      targets: [],
      evidence: { context: contextState, zigzag },
      reason_codes: ['harmonic_pattern_not_found'],
      as_of: asOf,
    };
  }

  const levels = deriveTradeLevels(candidate);
  const base = {
    version: HARMONIC_PRZ_ENGINE_VERSION,
    strategy: 'HARMONIC_PRZ',
    symbol: 'XAUUSD',
    direction: candidate.direction,
    pattern: candidate.pattern.id,
    context_timeframe: 'H1',
    setup_timeframe: 'M15',
    trigger_timeframe: 'M5',
    prz: [round(candidate.prz.lower), round(candidate.prz.upper)],
    entry_zone: [round(candidate.prz.lower), round(candidate.prz.upper)],
    invalidation: levels.invalidation,
    targets: levels.targets,
    evidence: {
      context: contextState,
      points: serializePoints(candidate.points),
      ratios: roundedRatios(candidate.measured),
      ratio_rules: {
        ab_xa: [...candidate.pattern.ab_xa],
        bc_ab: [...candidate.pattern.bc_ab],
        ad_xa: [...candidate.pattern.ad_xa],
        cd_bc: [...candidate.pattern.cd_bc],
        cd_ab: [...candidate.pattern.cd_ab],
      },
      prz: roundedPrz(candidate.prz),
      trigger: null,
    },
    as_of: asOf,
  };

  if (!candidate.complete) {
    return {
      ...base,
      state: 'PRE_SIGNAL',
      reason_codes: ['waiting_for_d_confirmation'],
    };
  }

  const invalidated = structuralInvalidation(setup, candidate);
  if (invalidated) {
    return {
      ...base,
      state: 'INVALID',
      evidence: { ...base.evidence, invalidated },
      reason_codes: ['harmonic_structure_invalidated'],
    };
  }

  const d = candidate.points[4];
  const triggerEvidence = findMicroBos(trigger, candidate.direction, d.confirmed_at);
  if (!triggerEvidence) {
    return {
      ...base,
      state: 'PRE_SIGNAL',
      reason_codes: ['waiting_for_m5_micro_bos'],
    };
  }

  return {
    ...base,
    state: 'READY',
    evidence: { ...base.evidence, trigger: triggerEvidence },
    reason_codes: [],
  };
};
