import { INVEST_CAPABILITIES } from './capabilities.mjs';

export const XAU_SEARCH_PLAN_VERSION = 'xau-search-plan-v1';

const SEARCH_TOPICS = Object.freeze([
  Object.freeze({
    id: 'gold_market',
    capability: 'market_analysis',
    query: 'XAUUSD gold price market trend latest',
    purpose: 'Current gold-market drivers and near-term catalyst context.',
  }),
  Object.freeze({
    id: 'fed_rates',
    capability: 'economic_indicators',
    query: 'Federal Reserve interest rates inflation outlook latest',
    purpose: 'Rate-path expectations and policy signals that can affect gold.',
  }),
  Object.freeze({
    id: 'us_macro',
    capability: 'economic_indicators',
    query: 'US CPI PCE NFP unemployment latest',
    purpose: 'Fresh inflation and labor-market evidence relevant to Fed expectations.',
  }),
  Object.freeze({
    id: 'dollar_yields',
    capability: 'market_analysis',
    query: 'DXY US Dollar Index Treasury yields gold latest',
    purpose: 'Dollar and real/nominal yield pressure or support for gold.',
  }),
  Object.freeze({
    id: 'sentiment',
    capability: 'market_sentiment',
    query: 'gold market sentiment positioning latest',
    purpose: 'Evidence about current gold-market sentiment and positioning.',
  }),
  Object.freeze({
    id: 'global_risk',
    capability: 'global_events',
    query: 'geopolitical risk global markets gold safe haven latest',
    purpose: 'Global-event risks that can alter safe-haven demand.',
  }),
]);

export const createXauSearchPlan = ({ generatedAt = new Date().toISOString() } = {}) => ({
  version: XAU_SEARCH_PLAN_VERSION,
  symbol: 'XAUUSD',
  generated_at: generatedAt,
  topics: SEARCH_TOPICS.map((topic) => ({ ...topic })),
  capability_policy: INVEST_CAPABILITIES.map((item) => ({
    id: item.id,
    applicability: item.xauusd,
  })),
  rules: [
    'Prefer primary/official sources for economic releases and central-bank policy.',
    'Keep publication time and retrieval time separate.',
    'Distinguish fact, attributed claim, and interpretation.',
    'Do not emit Buy/Sell/Hold recommendations.',
    'Do not invent equity-only evidence for XAUUSD; mark non-applicable capabilities explicitly.',
    'Deduplicate repeated stories and retain source provenance.',
  ],
});

const earliestPublished = (results, fallback) => {
  const timestamps = results
    .map((item) => new Date(item.published_at).getTime())
    .filter(Number.isFinite);
  if (timestamps.length === 0) return fallback;
  return new Date(Math.min(...timestamps)).toISOString();
};

export const buildSearchSynthesisInstruction = ({ plan, rawResults }) => {
  if (!plan || plan.version !== XAU_SEARCH_PLAN_VERSION) throw new Error('invalid_xau_search_plan');
  if (!Array.isArray(rawResults)) throw new Error('invalid_search_results');
  const bounded = rawResults.slice(0, 120).map((item) => ({
    topic_id: String(item.topic_id || ''),
    title: String(item.title || '').slice(0, 500),
    url: String(item.url || '').slice(0, 2000),
    publisher: String(item.publisher || '').slice(0, 200),
    published_at: String(item.published_at || ''),
    retrieved_at: String(item.retrieved_at || ''),
    snippet: String(item.snippet || '').slice(0, 1200),
  }));
  const windowStart = earliestPublished(bounded, plan.generated_at);

  return [
    '[Hearth Search Specialist — XAU/USD]',
    'Produce ONLY a JSON object that conforms to xau-research-v1.',
    'Asset: XAUUSD.',
    'Your job is evidence synthesis, not trading advice.',
    `Set generated_at exactly to ${plan.generated_at}.`,
    `Set window.start exactly to ${windowStart} and window.end exactly to ${plan.generated_at}.`,
    'Build sources ONLY from supplied Raw results. Copy url, title, publisher, published_at, and retrieved_at exactly; never invent or alter source metadata.',
    'Assign a stable source id such as src-001 and make every research item cite one or more of those source_ids.',
    'Separate fact, attributed claim, and interpretation using fact_type.',
    'Use only these capability IDs: market_analysis, technical_analysis, risk_management, portfolio_diversification, economic_indicators, value_investing, earnings_reports, market_sentiment, growth_vs_dividend, global_events.',
    'For spot XAUUSD, value_investing, earnings_reports, and growth_vs_dividend are not applicable and must not be fabricated.',
    'For Federal Reserve Board sources, source_type=official and credibility=primary. For ordinary news, source_type=news and credibility=unknown unless the supplied metadata itself establishes otherwise.',
    'macro must be an array. If no structured numeric macro observation was supplied, return macro as an empty array rather than inventing values.',
    'If evidence is insufficient, omit the item rather than guessing.',
    `Search plan: ${JSON.stringify(plan)}`,
    `Raw results: ${JSON.stringify(bounded)}`,
  ].join('\n\n');
};
