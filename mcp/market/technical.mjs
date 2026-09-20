const finite = (value) => Number.isFinite(value);

const round = (value, digits = 2) => {
  if (!finite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

export const sma = (values, period) => {
  if (!Array.isArray(values) || values.length < period || period <= 0) return null;
  const slice = values.slice(-period);
  if (!slice.every(finite)) return null;
  return slice.reduce((sum, value) => sum + value, 0) / period;
};

export const rsi = (values, period = 14) => {
  if (!Array.isArray(values) || values.length < period + 1) return null;
  const slice = values.slice(-(period + 1));
  let gains = 0;
  let losses = 0;
  for (let index = 1; index < slice.length; index += 1) {
    const delta = slice[index] - slice[index - 1];
    if (delta > 0) gains += delta;
    else losses += Math.abs(delta);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
};

export const atr = (bars, period = 14) => {
  if (!Array.isArray(bars) || bars.length < period + 1) return null;
  const slice = bars.slice(-(period + 1));
  const ranges = [];
  for (let index = 1; index < slice.length; index += 1) {
    const current = slice[index];
    const previous = slice[index - 1];
    if (![current.high, current.low, previous.close].every(finite)) return null;
    ranges.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close),
    ));
  }
  return ranges.reduce((sum, value) => sum + value, 0) / period;
};

export const analyzeTechnical = (bars) => {
  if (!Array.isArray(bars) || bars.length < 20) throw new Error('insufficient_market_bars');
  const closes = bars.map((bar) => bar.close);
  if (!closes.every(finite)) throw new Error('invalid_market_bars');

  const current = closes.at(-1);
  const ma20 = sma(closes, 20);
  const ma50 = sma(closes, 50);
  const ma200 = sma(closes, 200);
  const rsi14 = rsi(closes, 14);
  const atr14 = atr(bars, 14);
  const recent = bars.slice(-20);
  const support = Math.min(...recent.map((bar) => bar.low));
  const resistance = Math.max(...recent.map((bar) => bar.high));
  const fiveBack = closes.length >= 6 ? closes.at(-6) : closes[0];
  const momentum = current - fiveBack;

  let score = 0;
  if (ma20 != null) score += current > ma20 ? 1 : current < ma20 ? -1 : 0;
  if (ma50 != null) score += current > ma50 ? 1 : current < ma50 ? -1 : 0;
  if (ma20 != null && ma50 != null) score += ma20 > ma50 ? 1 : ma20 < ma50 ? -1 : 0;
  if (rsi14 != null) score += rsi14 >= 55 ? 1 : rsi14 <= 45 ? -1 : 0;
  score += momentum > 0 ? 1 : momentum < 0 ? -1 : 0;

  const bias = score >= 2 ? 'bullish' : score <= -2 ? 'bearish' : 'neutral';

  return {
    current: round(current),
    ma20: round(ma20),
    ma50: round(ma50),
    ma200: round(ma200),
    rsi14: round(rsi14),
    atr14: round(atr14),
    support: round(support),
    resistance: round(resistance),
    momentum5: round(momentum),
    score,
    bias,
  };
};
