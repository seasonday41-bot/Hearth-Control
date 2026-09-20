import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createMt5SocketBridge } from '../mcp/market/mt5-bridge-server.mjs';
import { Mt5LoopbackAdapter } from '../mcp/market/mt5-adapter.mjs';
import { runXauInvestSpecialist } from '../mcp/market/invest-specialist.mjs';

const iso = '2026-09-20T03:00:00.000Z';
const baseEpoch = Date.UTC(2026, 8, 18, 0, 0, 0) / 1000;

const research = {
  version: 'xau-research-v1',
  symbol: 'XAUUSD',
  generated_at: iso,
  window: {
    start: '2026-09-19T03:00:00.000Z',
    end: iso,
  },
  sources: [{
    id: 'src-fed',
    url: 'https://www.federalreserve.gov/newsevents.htm',
    title: 'Federal Reserve evidence',
    publisher: 'Federal Reserve Board',
    published_at: '2026-09-19T18:00:00.000Z',
    retrieved_at: iso,
    source_type: 'official',
    credibility: 'primary',
  }],
  items: [{
    id: 'item-fed',
    capability: 'economic_indicators',
    topic: 'fed_rates',
    summary: 'Policy evidence is supportive for gold in this synthetic validation fixture.',
    fact_type: 'interpretation',
    bias: 'bullish',
    impact: 'medium',
    horizon: 'swing',
    source_ids: ['src-fed'],
  }],
  macro: [],
};

const snapshot = {
  type: 'snapshot',
  version: 1,
  canonical_symbol: 'XAUUSD',
  broker_symbol: 'GOLD',
  timeframe: 'H1',
  as_of: baseEpoch + (60 * 60 * 60),
  bars: Array.from({ length: 60 }, (_, index) => {
    const close = 2500 + (index * 2);
    return {
      time: baseEpoch + (60 * 60 * index),
      open: close - 1,
      high: close + 4,
      low: close - 4,
      close,
      volume: 1000 + index,
    };
  }),
};

const sendSnapshot = (port, payload) => new Promise((resolve, reject) => {
  const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
    socket.write(`${JSON.stringify(payload)}\n`, (error) => {
      if (error) {
        reject(error);
        return;
      }
      setTimeout(() => {
        socket.end();
        resolve();
      }, 15);
    });
  });
  socket.on('error', reject);
});

test('Market MT5 E2E V1 TCP snapshot -> adapter -> Invest engine', async () => {
  const bridge = createMt5SocketBridge({
    httpPort: 18775,
    ingestPort: 18776,
    staleAfterMs: 30_000,
  });

  try {
    await bridge.start();
    await sendSnapshot(18776, snapshot);

    const mt5 = new Mt5LoopbackAdapter({
      baseUrl: 'http://127.0.0.1:18775',
    });
    const market = await mt5.getBars({
      symbol: 'XAUUSD',
      timeframe: 'H1',
      limit: 60,
    });

    const result = await runXauInvestSpecialist({
      market,
      research,
      narrator: null,
    });

    assert.equal(market.source, 'MT5');
    assert.equal(market.bars.length, 60);
    assert.equal(result.analysis.symbol, 'XAUUSD');
    assert.equal(result.analysis.direction, 'UP');
    assert.ok(result.analysis.confidence >= 50);
    assert.equal(result.analysis.support.length, 1);
    assert.equal(result.analysis.resistance.length, 1);
    assert.equal(result.analysis.entry_zone.length, 2);
    assert.equal(result.analysis.targets.length, 2);
  } finally {
    await bridge.stop();
  }
});
