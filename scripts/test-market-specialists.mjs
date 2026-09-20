import test from 'node:test';
import assert from 'node:assert/strict';
import { INVEST_CAPABILITIES, getInvestCapabilities } from '../mcp/market/capabilities.mjs';
import { createXauSearchPlan, buildSearchSynthesisInstruction } from '../mcp/market/search-specialist.mjs';
import { validateXauResearch, parseXauResearch } from '../mcp/market/research-contract.mjs';
import { analyzeTechnical } from '../mcp/market/technical.mjs';
import { analyzeXauUsd } from '../mcp/market/invest-engine.mjs';

const iso = '2026-09-20T02:00:00.000Z';

const research = (bias = 'bullish') => ({
  version: 'xau-research-v1',
  symbol: 'XAUUSD',
  generated_at: iso,
  window: {
    start: '2026-09-19T02:00:00.000Z',
    end: iso,
  },
  sources: [
    {
      id: 'src-fed',
      url: 'https://www.federalreserve.gov/newsevents.htm',
      title: 'Federal Reserve policy update',
      publisher: 'Federal Reserve',
      published_at: '2026-09-19T18:00:00.000Z',
      retrieved_at: iso,
      source_type: 'official',
      credibility: 'primary',
    },
  ],
  items: [
    {
      id: 'item-1',
      capability: 'economic_indicators',
      topic: 'Rates',
      summary: 'Policy expectations shifted in a direction relevant to gold.',
      fact_type: 'interpretation',
      bias,
      impact: 'high',
      horizon: 'swing',
      source_ids: ['src-fed'],
    },
  ],
  macro: [],
});

const bars = Array.from({ length: 60 }, (_, index) => {
  const close = 2500 + (index * 2);
  return {
    time: new Date(Date.UTC(2026, 8, 18, 0, index)).toISOString(),
    open: close - 1,
    high: close + 4,
    low: close - 4,
    close,
    volume: 1000 + index,
  };
});

test('Market V1.1 preserves the original ten Invest capability IDs', () => {
  assert.equal(INVEST_CAPABILITIES.length, 10);
  assert.deepEqual(getInvestCapabilities('XAU/USD').map((item) => item.id), [
    'market_analysis',
    'technical_analysis',
    'risk_management',
    'portfolio_diversification',
    'economic_indicators',
    'value_investing',
    'earnings_reports',
    'market_sentiment',
    'growth_vs_dividend',
    'global_events',
  ]);
});

test('Market V1.2 XAUUSD marks equity-only capabilities not applicable', () => {
  const byId = Object.fromEntries(getInvestCapabilities('XAUUSD').map((item) => [item.id, item.xauusd]));
  assert.equal(byId.value_investing, 'not_applicable');
  assert.equal(byId.earnings_reports, 'not_applicable');
  assert.equal(byId.growth_vs_dividend, 'not_applicable');
  assert.equal(byId.portfolio_diversification, 'contextual');
});

test('Market V1.3 Search plan is bounded and focused on XAUUSD evidence', () => {
  const plan = createXauSearchPlan({ generatedAt: iso });
  assert.equal(plan.symbol, 'XAUUSD');
  assert.equal(plan.topics.length, 6);
  assert.ok(plan.topics.some((item) => /Federal Reserve/i.test(item.query)));
  assert.ok(plan.topics.some((item) => /DXY/i.test(item.query)));
  assert.ok(plan.rules.some((item) => /Do not emit Buy\/Sell\/Hold/i.test(item)));
});

test('Market V1.4 Search synthesis instruction preserves provenance requirement', () => {
  const plan = createXauSearchPlan({ generatedAt: iso });
  const prompt = buildSearchSynthesisInstruction({
    plan,
    rawResults: [{
      topic_id: 'fed_rates',
      title: 'Policy update',
      url: 'https://www.federalreserve.gov/newsevents.htm',
      publisher: 'Federal Reserve',
      published_at: iso,
      retrieved_at: iso,
      snippet: 'Example evidence.',
    }],
  });
  assert.match(prompt, /xau-research-v1/);
  assert.match(prompt, /source_ids/);
  assert.match(prompt, /not applicable/i);
});

test('Market V1.5 Research contract rejects unsupported symbols and unknown sources', () => {
  const wrongSymbol = research();
  wrongSymbol.symbol = 'AAPL';
  assert.equal(validateXauResearch(wrongSymbol).ok, false);

  const unknownSource = research();
  unknownSource.items[0].source_ids = ['missing'];
  const result = validateXauResearch(unknownSource);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((item) => item.code === 'UNKNOWN_SOURCE'));
});

test('Market V1.6 Research contract redacts secret-shaped text', () => {
  const input = research();
  input.items[0].summary = 'Bearer abcdefghijklmnopqrstuvwxyz123456';
  const parsed = parseXauResearch(input);
  assert.doesNotMatch(parsed.items[0].summary, /abcdefghijklmnopqrstuvwxyz123456/);
  assert.match(parsed.items[0].summary, /REDACTED/);
});

test('Market V1.7 Technical analysis derives bullish structure from rising bars', () => {
  const technical = analyzeTechnical(bars);
  assert.equal(technical.bias, 'bullish');
  assert.ok(technical.current > technical.ma20);
  assert.ok(technical.rsi14 >= 55);
  assert.ok(technical.atr14 > 0);
});

test('Market V1.8 Invest engine combines technical and research evidence', () => {
  const result = analyzeXauUsd({
    market: {
      symbol: 'XAUUSD',
      timeframe: 'H1',
      as_of: iso,
      source: 'MT5',
      bars,
    },
    research: research('bullish'),
  });
  assert.equal(result.version, 'xau-invest-result-v1');
  assert.equal(result.direction, 'UP');
  assert.ok(result.confidence >= 50 && result.confidence <= 90);
  assert.equal(result.technical_bias, 'bullish');
  assert.equal(result.macro_bias, 'bullish');
  assert.equal(result.capabilities.find((item) => item.id === 'earnings_reports').status, 'not_applicable');
  assert.equal(result.targets.length, 2);
});

test('Market V1.9 Invest engine exposes deterministic risk boundaries', () => {
  const result = analyzeXauUsd({
    market: {
      symbol: 'XAUUSD',
      timeframe: 'H1',
      as_of: iso,
      source: 'MT5',
      bars,
    },
    research: research('bearish'),
  });
  assert.ok(['UP', 'DOWN', 'NEUTRAL'].includes(result.direction));
  assert.equal(result.support.length, 1);
  assert.equal(result.resistance.length, 1);
  assert.equal(result.entry_zone.length, 2);
  assert.ok(['low', 'medium', 'high'].includes(result.risk_level));
});

test('Market V1.10 malformed market data fails closed', () => {
  assert.throws(() => analyzeXauUsd({
    market: { symbol: 'XAUUSD', timeframe: 'H1', as_of: iso, source: 'MT5', bars: bars.slice(0, 10) },
    research: research(),
  }), /insufficient_market_bars/);
});
