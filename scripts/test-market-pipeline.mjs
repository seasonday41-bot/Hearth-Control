import test from 'node:test';
import assert from 'node:assert/strict';
import { collectXauSearchResults, runXauSearchSpecialist } from '../mcp/market/search-pipeline.mjs';
import { runXauInvestSpecialist } from '../mcp/market/invest-specialist.mjs';

const iso = '2026-09-20T02:00:00.000Z';

const validResearch = (url = 'https://www.federalreserve.gov/newsevents.htm') => ({
  version: 'xau-research-v1',
  symbol: 'XAUUSD',
  generated_at: iso,
  window: { start: '2026-09-19T02:00:00.000Z', end: iso },
  sources: [{
    id: 'src-1',
    url,
    title: 'Federal Reserve update',
    publisher: 'Federal Reserve',
    published_at: '2026-09-19T18:00:00.000Z',
    retrieved_at: iso,
    source_type: 'official',
    credibility: 'primary',
  }],
  items: [{
    id: 'item-1',
    capability: 'economic_indicators',
    topic: 'Rates',
    summary: 'Rate expectations remain relevant for gold.',
    fact_type: 'interpretation',
    bias: 'bullish',
    impact: 'high',
    horizon: 'swing',
    source_ids: ['src-1'],
  }],
  macro: [],
});

const risingBars = Array.from({ length: 60 }, (_, index) => {
  const close = 2500 + (index * 2);
  return { open: close - 1, high: close + 4, low: close - 4, close, volume: 1000 + index };
});

const searchProvider = {
  async search({ topicId }) {
    if (topicId !== 'fed_rates') return [];
    return [{
      title: 'Federal Reserve update',
      url: 'https://www.federalreserve.gov/newsevents.htm',
      publisher: 'Federal Reserve',
      published_at: '2026-09-19T18:00:00.000Z',
      retrieved_at: iso,
      snippet: 'Policy update.',
    }];
  },
};

test('Market Pipeline V1.1 search collection deduplicates URLs', async () => {
  const provider = {
    async search() {
      return [
        { title: 'A', url: 'https://example.com/a', publisher: 'Example', published_at: iso, retrieved_at: iso },
        { title: 'A duplicate', url: 'https://example.com/a#fragment', publisher: 'Example', published_at: iso, retrieved_at: iso },
      ];
    },
  };
  const rows = await collectXauSearchResults({
    searchProvider: provider,
    plan: {
      topics: [
        { id: 'one', query: 'one' },
        { id: 'two', query: 'two' },
      ],
    },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, 'https://example.com/a');
});

test('Market Pipeline V1.2 Search specialist accepts synthesis only from retrieved sources', async () => {
  const result = await runXauSearchSpecialist({
    searchProvider,
    generatedAt: iso,
    synthesizer: {
      async synthesize() {
        return validResearch();
      },
    },
  });
  assert.equal(result.research.symbol, 'XAUUSD');
  assert.equal(result.research.sources[0].url, 'https://www.federalreserve.gov/newsevents.htm');
});

test('Market Pipeline V1.3 Search specialist rejects hallucinated source provenance', async () => {
  await assert.rejects(
    () => runXauSearchSpecialist({
      searchProvider,
      generatedAt: iso,
      synthesizer: {
        async synthesize() {
          return validResearch('https://invented.example.com/story');
        },
      },
    }),
    /xau_search_source_not_retrieved/,
  );
});

test('Market Pipeline V1.4 Invest specialist keeps deterministic analysis separate from narrative', async () => {
  const research = validResearch();
  const result = await runXauInvestSpecialist({
    market: { symbol: 'XAUUSD', timeframe: 'H1', as_of: iso, source: 'MT5', bars: risingBars },
    research,
    narrator: {
      async explain() {
        return {
          summary: 'Trend and evidence currently lean upward, with uncertainty.',
          bull_case: 'Upside continues if the measured trend persists.',
          base_case: 'Price consolidates around the measured technical structure.',
          bear_case: 'The setup weakens if invalidation is breached.',
          risks: ['Macro releases can change the evidence quickly.'],
        };
      },
    },
  });
  assert.equal(result.analysis.direction, 'UP');
  assert.equal(result.narrative.risks.length, 1);
  assert.equal(Object.hasOwn(result.narrative, 'direction'), false);
});

test('Market Pipeline V1.5 Invest narrative cannot inject numeric override fields', async () => {
  await assert.rejects(
    () => runXauInvestSpecialist({
      market: { symbol: 'XAUUSD', timeframe: 'H1', as_of: iso, source: 'MT5', bars: risingBars },
      research: validResearch(),
      narrator: {
        async explain() {
          return {
            summary: 'Summary',
            bull_case: 'Bull',
            base_case: 'Base',
            bear_case: 'Bear',
            risks: [],
            direction: 'DOWN',
          };
        },
      },
    }),
    /xau_invest_narrative_unknown_field:direction/,
  );
});

test('Market Pipeline V1.6 Invest narrative normalizes a scalar Qwen risks field', async () => {
  const result = await runXauInvestSpecialist({
    market: { symbol: 'XAUUSD', timeframe: 'H1', as_of: iso, source: 'MT5', bars: risingBars },
    research: validResearch(),
    narrator: {
      async explain() {
        return {
          summary: 'Summary',
          bull_case: 'Bull',
          base_case: 'Base',
          bear_case: 'Bear',
          risks: 'Macro conditions can change quickly.',
        };
      },
    },
  });

  assert.equal(result.analysis.direction, 'UP');
  assert.deepEqual(result.narrative.risks, ['Macro conditions can change quickly.']);
});

test('Market Pipeline V1.7 malformed risk entries cannot discard valid deterministic analysis', async () => {
  const result = await runXauInvestSpecialist({
    market: { symbol: 'XAUUSD', timeframe: 'H1', as_of: iso, source: 'MT5', bars: risingBars },
    research: validResearch(),
    narrator: {
      async explain() {
        return {
          summary: 'Summary',
          bull_case: 'Bull',
          base_case: 'Base',
          bear_case: 'Bear',
          risks: ['  Valid risk.  ', null, 7, '', { text: 'not trusted as prose' }],
        };
      },
    },
  });

  assert.equal(result.analysis.direction, 'UP');
  assert.equal(result.analysis.confidence > 0, true);
  assert.deepEqual(result.narrative.risks, ['Valid risk.']);
});
