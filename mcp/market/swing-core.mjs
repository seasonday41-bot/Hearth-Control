export const THREE_BAR_SWING_VERSION = 'three-bar-swing-v1';

const finite = (value) => Number.isFinite(value);

const normalizeIso = (value) => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

const validateBars = (bars) => {
  if (!Array.isArray(bars)) throw new Error('swing_bars_required');

  let previousTime = -Infinity;
  return bars.map((bar, index) => {
    if (!bar || typeof bar !== 'object' || Array.isArray(bar)) {
      throw new Error(`swing_invalid_bar:${index}`);
    }

    const high = Number(bar.high);
    const low = Number(bar.low);
    if (![high, low].every(finite) || high < low) {
      throw new Error(`swing_invalid_range:${index}`);
    }

    const time = normalizeIso(bar.time);
    if (!time) throw new Error(`swing_invalid_time:${index}`);
    const epoch = Date.parse(time);
    if (epoch <= previousTime) throw new Error(`swing_non_monotonic_time:${index}`);
    previousTime = epoch;

    return { index, time, high, low };
  });
};

const swingPoint = ({ type, center, right }) => ({
  version: THREE_BAR_SWING_VERSION,
  type,
  index: center.index,
  time: center.time,
  price: type === 'HIGH' ? center.high : center.low,
  confirmed_index: right.index,
  confirmed_at: right.time,
});

export const detectConfirmedThreeBarSwings = (bars) => {
  const normalized = validateBars(bars);
  if (normalized.length < 3) return [];

  const swings = [];
  for (let index = 1; index < normalized.length - 1; index += 1) {
    const left = normalized[index - 1];
    const center = normalized[index];
    const right = normalized[index + 1];

    if (center.high > left.high && center.high > right.high) {
      swings.push(swingPoint({ type: 'HIGH', center, right }));
    }
    if (center.low < left.low && center.low < right.low) {
      swings.push(swingPoint({ type: 'LOW', center, right }));
    }
  }

  return swings;
};

export const latestConfirmedSwing = (swings, type) => {
  if (!Array.isArray(swings)) throw new Error('swing_points_required');
  if (!['HIGH', 'LOW'].includes(type)) throw new Error('swing_type_invalid');

  for (let index = swings.length - 1; index >= 0; index -= 1) {
    const swing = swings[index];
    if (swing?.type === type) return { ...swing };
  }
  return null;
};
