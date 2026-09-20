import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createMt5SocketBridge, normalizeMt5Snapshot } from '../mcp/market/mt5-bridge-server.mjs';

const baseEpoch = Date.UTC(2026, 8, 20, 0, 0, 0) / 1000;

const snapshot = () => ({
  type: 'snapshot',
  version: 1,
  canonical_symbol: 'XAUUSD',
  broker_symbol: 'XAUUSDm',
  timeframe: 'H1',
  as_of: baseEpoch + (60 * 60 * 40),
  bars: Array.from({ length: 40 }, (_, index) => {
    const close = 2600 + index;
    return {
      time: baseEpoch + (60 * 60 * index),
      open: close - 1,
      high: close + 2,
      low: close - 2,
      close,
      volume: 1000 + index,
    };
  }),
});

test('MT5 Bridge V1.1 normalizes a valid XAUUSD snapshot', () => {
  const normalized = normalizeMt5Snapshot(snapshot());
  assert.equal(normalized.symbol, 'XAUUSD');
  assert.equal(normalized.broker_symbol, 'XAUUSDm');
  assert.equal(normalized.timeframe, 'H1');
  assert.equal(normalized.bars.length, 40);
  assert.match(normalized.bars[0].time, /Z$/);
});

test('MT5 Bridge V1.2 malformed or unsupported snapshots fail closed', () => {
  const wrong = snapshot();
  wrong.canonical_symbol = 'EURUSD';
  assert.throws(() => normalizeMt5Snapshot(wrong), /unsupported_symbol/);

  const nonMonotonic = snapshot();
  nonMonotonic.bars[10].time = nonMonotonic.bars[9].time;
  assert.throws(() => normalizeMt5Snapshot(nonMonotonic), /non_monotonic_time/);

  const badRange = snapshot();
  badRange.bars[0].high = badRange.bars[0].low - 1;
  assert.throws(() => normalizeMt5Snapshot(badRange), /invalid_range/);
});

const sendSnapshot = ({ port, payload }) => new Promise((resolve, reject) => {
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

test('MT5 Bridge V1.3 TCP ingest becomes HTTP /v1/bars snapshot', async () => {
  const bridge = createMt5SocketBridge({
    httpPort: 18765,
    ingestPort: 18766,
    staleAfterMs: 30_000,
  });
  try {
    await bridge.start();
    await sendSnapshot({ port: 18766, payload: snapshot() });

    const response = await fetch('http://127.0.0.1:18765/v1/bars?symbol=XAUUSD&timeframe=H1&limit=20');
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.symbol, 'XAUUSD');
    assert.equal(payload.broker_symbol, 'XAUUSDm');
    assert.equal(payload.bars.length, 20);
    assert.equal(payload.bars.at(-1).close, 2639);

    const health = await fetch('http://127.0.0.1:18765/health').then((res) => res.json());
    assert.equal(health.ok, true);
    assert.equal(health.snapshots[0].bar_count, 40);
  } finally {
    await bridge.stop();
  }
});

test('MT5 Bridge V1.4 missing and stale snapshots return 503', async () => {
  let now = Date.now();
  const bridge = createMt5SocketBridge({
    httpPort: 18767,
    ingestPort: 18768,
    staleAfterMs: 1000,
    now: () => now,
  });
  try {
    await bridge.start();

    const missing = await fetch('http://127.0.0.1:18767/v1/bars?symbol=XAUUSD&timeframe=H1&limit=20');
    assert.equal(missing.status, 503);
    assert.equal((await missing.json()).error, 'mt5_no_snapshot');

    await sendSnapshot({ port: 18768, payload: snapshot() });
    now += 2000;

    const stale = await fetch('http://127.0.0.1:18767/v1/bars?symbol=XAUUSD&timeframe=H1&limit=20');
    assert.equal(stale.status, 503);
    assert.equal((await stale.json()).error, 'mt5_snapshot_stale');
  } finally {
    await bridge.stop();
  }
});