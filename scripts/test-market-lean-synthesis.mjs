import test from 'node:test';
import assert from 'node:assert/strict';
import { runLeanLiveXauSearch } from '../mcp/market/live-search-synthesis.mjs';
import { runLiveXauSearch } from '../mcp/market/live-runtime.mjs';

const iso = '2026-09-20T03:00:00.000Z';

const batchProvider = {
  async searchBatch() {
    return [
      {
        topic_id: 'fed_rates',
        title: 'Federal Reserve issues FOMC statement',
        url: 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20260916a.htm',
        publisher: 'Federal Reserve Board',
        published_at: '2026-09-16T18:00:00.000Z',
        retrieved_at: iso,
        snippet: 'The Committee issued its monetary policy statement.',
      },
      {
        topic_id: 'us_macro',
        title: 'Major Economic Indicators Latest Numbers',
        url: 'https://www.bls.gov/bls/',
        publisher: 'U.S. Bureau of Labor Statistics',
        published_at: '2026-09-18T14:01:59.000Z',
        retrieved_at: iso,
        snippet: 'Latest official labor and inflation indicators.',
      },
      {
        topic_id: 'global_risk',
        title: 'Global risk story',
        url: 'https://example.com/global-risk',
        publisher: 'example.com',
        published_at: '2026-09-19T12:00:00.000Z',
        retrieved_at: iso,
        snippet: 'Geopolitical uncertainty affected markets.',
      },
    ];
  },
};

test('Market Lean V1.1 Hearth owns source metadata and capability mapping', async () => {
  const research = await runLeanLiveXauSearch({
    searchProvider: batchProvider,
    generatedAt: iso,
    classifier: {
      async classify({ sources }) {
        return {
          items: sources.map((source) => ({
            source_id: source.id,
            summary: `Evidence from ${source.publisher}.`,
            fact_type: 'interpretation',
            bias: source.topic_id === 'global_risk' ? 'mixed' : 'bullish',
            impact: 'medium',
            horizon: source.topic_id === 'fed_rates' ? 'macro' : 'swing',
          })),
        };
      },
    },
  });

  assert.equal(research.sources.length, 3);
  assert.equal(research.sources[0].url, 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20260916a.htm');
  assert.equal(research.sources[0].source_type, 'official');
  assert.equal(research.sources[0].credibility, 'primary');
  assert.equal(research.items.find((item) => item.topic === 'fed_rates').capability, 'economic_indicators');
  assert.equal(research.items.find((item) => item.topic === 'global_risk').capability, 'global_events');
});

test('Market Lean V1.2 classifier cannot inject source metadata or capability', async () => {
  const research = await runLeanLiveXauSearch({
    searchProvider: batchProvider,
    generatedAt: iso,
    classifier: {
      async classify({ sources }) {
        return {
          items: [{
            source_id: sources[0].id,
            summary: 'Policy evidence relevant to gold.',
            fact_type: 'interpretation',
            bias: 'neutral',
            impact: 'high',
            horizon: 'macro',
            url: 'https://invented.example.com',
            capability: 'value_investing',
          }],
        };
      },
    },
  });

  assert.equal(research.sources.length, 1);
  assert.equal(research.sources[0].url, 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20260916a.htm');
  assert.equal(research.items[0].capability, 'economic_indicators');
  assert.equal(Object.hasOwn(research.items[0], 'url'), false);
});

test('Market Lean V1.3 unknown source IDs fail closed when no valid evidence remains', async () => {
  await assert.rejects(
    () => runLeanLiveXauSearch({
      searchProvider: batchProvider,
      generatedAt: iso,
      classifier: {
        async classify() {
          return {
            items: [{
              source_id: 'src-999',
              summary: 'Invented evidence.',
              fact_type: 'fact',
              bias: 'bullish',
              impact: 'high',
              horizon: 'swing',
            }],
          };
        },
      },
    }),
    /xau_search_no_evidence/,
  );
});

test('Market Lean V1.4 runLiveXauSearch defaults to classifier path when synthesizer is absent', async () => {
  const research = await runLiveXauSearch({
    searchProvider: batchProvider,
    generatedAt: iso,
    classifier: {
      async classify({ sources }) {
        return {
          items: [{
            source_id: sources[0].id,
            summary: 'Official policy evidence.',
            fact_type: 'fact',
            bias: 'neutral',
            impact: 'medium',
            horizon: 'macro',
          }],
        };
      },
    },
  });

  assert.equal(research.version, 'xau-research-v1');
  assert.equal(research.sources.length, 1);
  assert.equal(research.items[0].topic, 'fed_rates');
});
