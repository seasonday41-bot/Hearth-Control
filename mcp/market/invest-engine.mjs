import { getInvestCapabilities } from './capabilities.mjs';
import { parseXauResearch } from './research-contract.mjs';
import { analyzeTechnical } from './technical.mjs';

export const XAU_INVEST_RESULT_VERSION = 'xau-invest-result-v1';

const impactWeight = Object.freeze({ low: 1, medium: 2, high: 3 });
const biasSign = Object.freeze({ bullish: 1, bearish: -1, neutral: 0, mixed: 0 });

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const round = (value, digits = 2) => {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const researchScore = (research, horizons = null) => {
  let score = 0;
  let weight = 0;
  for (const item of research.items) {
    if (horizons && !horizons.includes(item.horizon)) continue;
    const itemWeight = impactWeight[item.impact] || 1;
    score += (biasSign[item.bias] || 0) * itemWeight;
    weight += itemWeight;
  }
  return { score, weight, normalized: weight ? score / weight : 0 };
};

const classifyBias = (normalized) =>
  normalized >= 0.2 ? 'bullish' : normalized <= -0.2 ? 'bearish' : 'neutral';

const validateSnapshot = (snapshot) => {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('invalid_market_snapshot');
  const symbol = String(snapshot.symbol || '').toUpperCase().replace('/', '');
  if (symbol !== 'XAUUSD') throw new Error('unsupported_market_symbol');
  if (!Array.isArray(snapshot.bars) || snapshot.bars.length < 20) throw new Error('insufficient_market_bars');
  for (const [index, bar] of snapshot.bars.entries()) {
    if (!bar || typeof bar !== 'object') throw new Error(`invalid_market_bar:${index}`);
    for (const field of ['open', 'high', 'low', 'close']) {
      if (!Number.isFinite(bar[field])) throw new Error(`invalid_market_bar_${field}:${index}`);
    }
    if (bar.high < bar.low) throw new Error(`invalid_market_bar_range:${index}`);
  }
  return {
    symbol: 'XAUUSD',
    timeframe: String(snapshot.timeframe || 'unknown'),
    as_of: typeof snapshot.as_of === 'string' ? snapshot.as_of : '',
    source: String(snapshot.source || 'unknown'),
    bars: snapshot.bars.map((bar) => ({ ...bar })),
  };
};

export const analyzeXauUsd = ({ market, research }) => {
  const snapshot = validateSnapshot(market);
  const normalizedResearch = parseXauResearch(research);
  const technical = analyzeTechnical(snapshot.bars);

  const allResearch = researchScore(normalizedResearch);
  const macroResearch = researchScore(normalizedResearch, ['macro', 'swing']);
  const intradayResearch = researchScore(normalizedResearch, ['intraday', 'swing']);

  const technicalNormalized = clamp(technical.score / 5, -1, 1);
  const composite = (technicalNormalized * 0.6) + (allResearch.normalized * 0.4);

  const direction = composite >= 0.2 ? 'UP' : composite <= -0.2 ? 'DOWN' : 'NEUTRAL';
  const confidence = Math.round(clamp(50 + Math.abs(composite) * 40, 50, 90));
  const macroBias = classifyBias(macroResearch.normalized);
  const newsBias = classifyBias(intradayResearch.normalized);

  const price = technical.current;
  const atrValue = technical.atr14 || Math.max((technical.resistance - technical.support) / 4, price * 0.0025);
  const entryHalf = atrValue * 0.25;
  const entryZone = direction === 'UP'
    ? [round(price - entryHalf), round(price + entryHalf * 0.5)]
    : direction === 'DOWN'
      ? [round(price - entryHalf * 0.5), round(price + entryHalf)]
      : [round(price - entryHalf), round(price + entryHalf)];

  const invalidation = direction === 'UP'
    ? round(Math.min(technical.support, price - atrValue))
    : direction === 'DOWN'
      ? round(Math.max(technical.resistance, price + atrValue))
      : null;

  const riskDistance = invalidation == null ? atrValue : Math.abs(price - invalidation);
  const targets = direction === 'UP'
    ? [round(price + riskDistance), round(price + (2 * riskDistance))]
    : direction === 'DOWN'
      ? [round(price - riskDistance), round(price - (2 * riskDistance))]
      : [];

  const atrPercent = price ? (atrValue / price) * 100 : 0;
  const disagreement =
    (technical.bias === 'bullish' && allResearch.normalized < -0.2) ||
    (technical.bias === 'bearish' && allResearch.normalized > 0.2);
  const riskLevel = disagreement || atrPercent >= 1.5 ? 'high' : atrPercent >= 0.8 ? 'medium' : 'low';

  const capabilities = getInvestCapabilities('XAUUSD').map((capability) => ({
    id: capability.id,
    applicability: capability.xauusd,
    status: capability.xauusd === 'not_applicable' ? 'not_applicable'
      : capability.xauusd === 'contextual' ? 'needs_portfolio_context'
        : 'available',
  }));

  return {
    version: XAU_INVEST_RESULT_VERSION,
    symbol: 'XAUUSD',
    timeframe: snapshot.timeframe,
    as_of: snapshot.as_of,
    direction,
    confidence,
    technical_bias: technical.bias,
    macro_bias: macroBias,
    news_bias: newsBias,
    support: [technical.support],
    resistance: [technical.resistance],
    entry_zone: entryZone,
    invalidation,
    targets,
    risk_level: riskLevel,
    technical,
    evidence: normalizedResearch.items.map((item) => ({
      id: item.id,
      capability: item.capability,
      bias: item.bias,
      impact: item.impact,
      horizon: item.horizon,
      source_ids: item.source_ids,
    })),
    capabilities,
    methodology: {
      technical_weight: 0.6,
      research_weight: 0.4,
      note: 'Direction is deterministic from market bars and evidence-tagged research; unsupported equity-only capabilities are never synthesized for spot XAUUSD.',
    },
  };
};
