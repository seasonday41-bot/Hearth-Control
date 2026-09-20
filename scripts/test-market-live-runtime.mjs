import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicMarketSearchProvider } from '../mcp/market/web-search-provider.mjs';
import { Mt5LoopbackAdapter } from '../mcp/market/mt5-adapter.mjs';
import { runLiveXauSearch, runLiveXauInvestment } from '../mcp/market/live-runtime.mjs';

const iso = '2026-09-20T02:00:00.000Z';

const jsonResponse = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'content-type': 'application/json' },
});

const textResponse = (text, status = 200, contentType = 'text/xml') => new Response(text, {
  status,
  headers: { 'content-type': contentType },
});

test('Market Live V1.1 web provider uses fixed GDELT origin and Fed monetary RSS', async () => {
  const urls = [];
  const provider = new PublicMarketSearchProvider({
    fetchFn: async (url) => {
      urls.push(String(url));
      if (String(url).startsWith('https://api.gdeltproject.org/')) {
        return jsonResponse({
          articles: [{
            url: 'https://example.com/gold-story',
            title: 'Gold reacts to policy expectations',
            domain: 'example.com',
            seendate: '20260920T010000Z',
          }],
        });
      }
      if (String(url) === 'https://www.federalreserve.gov/feeds/press_monetary.xml') {
        return textResponse(`<?xml version="1.0"?><rss><channel><item>
          <title>Federal Reserve issues FOMC statement</title>
          <link>https://www.federalreserve.gov/newsevents/pressreleases/monetary20260916a.htm</link>
          <pubDate>Wed, 16 Sep 2026 18:00:00 GMT</pubDate>
          <description>Monetary policy statement.</description>
        </item></channel></rss>`);
      }
      throw new Error(`unexpected_url:${url}`);
    },
  });

  const results = await provider.search({
    query: 'Federal Reserve gold latest',
    topicId: 'fed_rates',
    limit: 5,
  });

  assert.equal(urls[0].startsWith('https://api.gdeltproject.org/api/v2/doc/doc?'), true);
  assert.equal(urls[1], 'https://www.federalreserve.gov/feeds/press_monetary.xml');
  assert.equal(results[0].publisher, 'Federal Reserve Board');
  assert.ok(results.some((item) => item.url === 'https://example.com/gold-story'));
});

test('Market Live V1.2 MT5 adapter is loopback-only and validates bars', async () => {
  assert.throws(() => new Mt5LoopbackAdapter({ baseUrl: 'https://broker.example.com' }), /mt5_loopback_required/);

  const bars = Array.from({ length: 30 }, (_, index) => {
    const close = 2600 + index;
    return {
      time: new Date(Date.UTC(2026, 8, 20, 0, index)).toISOString(),
      open: close - 1,
      high: close + 2,
      low: close - 2,
      close,
      volume: 100 + index,
    };
  });
  let requestedUrl = '';
  const mt5 = new Mt5LoopbackAdapter({
    fetchFn: async (url) => {
      requestedUrl = String(url);
      return jsonResponse({
        symbol: 'XAUUSD',
        timeframe: 'H1',
        as_of: iso,
        bars,
      });
    },
  });

  const snapshot = await mt5.getBars({ timeframe: 'H1', limit: 30 });
  assert.equal(requestedUrl.startsWith('http://127.0.0.1:8765/v1/bars?'), true);
  assert.equal(snapshot.symbol, 'XAUUSD');
  assert.equal(snapshot.source, 'MT5');
  assert.equal(snapshot.bars.length, 30);
});


test('Market Live V1.2b MT5 adapter normalizes transport failure', async () => {
  const mt5 = new Mt5LoopbackAdapter({
    fetchFn: async () => {
      throw new TypeError('fetch failed');
    },
    timeoutMs: 100,
  });
  await assert.rejects(
    () => mt5.getBars({ timeframe: 'H1', limit: 20 }),
    /mt5_unavailable/,
  );
});

const rawSearchProvider = {
  async search({ topicId }) {
    return [{
      title: `Evidence for ${topicId}`,
      url: `https://example.com/${topicId}`,
      publisher: 'example.com',
      published_at: '2026-09-20T01:00:00.000Z',
      retrieved_at: iso,
      snippet: 'Gold market evidence.',
    }];
  },
};

const synthesizer = {
  async synthesize({ plan, rawResults }) {
    return {
      version: 'xau-research-v1',
      symbol: 'XAUUSD',
      generated_at: plan.generated_at,
      window: { start: '2026-09-20T01:00:00.000Z', end: plan.generated_at },
      sources: rawResults.map((item, index) => ({
        id: `src-${String(index + 1).padStart(3, '0')}`,
        url: item.url,
        title: item.title,
        publisher: item.publisher,
        published_at: item.published_at,
        retrieved_at: item.retrieved_at,
        source_type: 'news',
        credibility: 'unknown',
      })),
      items: rawResults.slice(0, 3).map((item, index) => ({
        id: `item-${index + 1}`,
        capability: index === 1 ? 'economic_indicators' : 'market_analysis',
        topic: item.topic_id,
        summary: 'Evidence currently leans supportive for gold.',
        fact_type: 'interpretation',
        bias: 'bullish',
        impact: 'medium',
        horizon: 'swing',
        source_ids: [`src-${String(index + 1).padStart(3, '0')}`],
      })),
      macro: [],
    };
  },
};

test('Market Live V1.3 live search returns validated research only', async () => {
  const research = await runLiveXauSearch({
    searchProvider: rawSearchProvider,
    synthesizer,
    generatedAt: iso,
    limitPerTopic: 1,
  });
  assert.equal(research.version, 'xau-research-v1');
  assert.equal(research.symbol, 'XAUUSD');
  assert.ok(research.sources.length >= 3);
});

test('Market Live V1.4 live investment executes Search -> MT5 -> Invest', async () => {
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
  const mt5 = {
    async getBars() {
      return { symbol: 'XAUUSD', timeframe: 'H1', as_of: iso, source: 'MT5', bars };
    },
  };
  const narrator = {
    async explain() {
      return {
        summary: 'The measured setup currently leans upward.',
        bull_case: 'Measured momentum persists.',
        base_case: 'Price consolidates around the measured structure.',
        bear_case: 'The measured invalidation is breached.',
        risks: ['Macro evidence can change quickly.'],
      };
    },
  };

  const result = await runLiveXauInvestment({
    searchProvider: rawSearchProvider,
    synthesizer,
    mt5,
    narrator,
    generatedAt: iso,
  });

  assert.equal(result.research.symbol, 'XAUUSD');
  assert.equal(result.market.source, 'MT5');
  assert.equal(result.analysis.direction, 'UP');
  assert.equal(result.narrative.risks.length, 1);
});
