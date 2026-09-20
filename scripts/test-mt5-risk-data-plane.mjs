import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {
  createMt5SocketBridge,
  normalizeMt5RiskSnapshot,
} from '../mcp/market/mt5-bridge-server.mjs';
import { Mt5RiskLoopbackAdapter } from '../mcp/market/mt5-risk-adapter.mjs';

const baseEpoch = Date.UTC(2026, 8, 21, 1, 0, 0) / 1000;

const riskSnapshot = (overrides = {}) => ({
  type: 'risk_snapshot',
  version: 1,
  canonical_symbol: 'XAUUSD',
  broker_symbol: 'XAUUSDm',
  as_of: baseEpoch,
  account: {
    account_type: 'demo',
    currency: 'USD',
    equity: 10000,
    peak_equity: 10200,
    free_margin: 8000,
    daily_realized_loss: 50,
    open_risk_currency: 100,
    open_positions: 1,
    open_risk_complete: true,
  },
  broker: {
    bid: 2500,
    ask: 2500.5,
    point_size: 0.1,
    tick_size: 0.1,
    tick_value_per_lot: 1,
    volume_min: 0.01,
    volume_max: 100,
    volume_step: 0.01,
    margin_per_lot: 1000,
    estimated_slippage_points: 2,
  },
  ...overrides,
});

const sendLine = ({ port, payload }) => new Promise((resolve, reject) => {
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

test('MT5 Risk Plane V2.1 normalizes bounded read-only demo risk telemetry', () => {
  const normalized = normalizeMt5RiskSnapshot(riskSnapshot());
  assert.equal(normalized.symbol, 'XAUUSD');
  assert.equal(normalized.source, 'MT5');
  assert.equal(normalized.account.account_type, 'demo');
  assert.equal(normalized.account.equity, 10000);
  assert.equal(normalized.account.open_risk_complete, true);
  assert.equal(normalized.broker.tick_size, 0.1);
  assert.equal(normalized.broker.volume_step, 0.01);
  assert.equal(normalized.broker.margin_per_lot, 1000);
});

test('MT5 Risk Plane V2.2 malformed broker/account metadata fails closed', () => {
  const missingTick = riskSnapshot();
  delete missingTick.broker.tick_value_per_lot;
  assert.throws(() => normalizeMt5RiskSnapshot(missingTick), /tick_value_invalid/);

  const badPeak = riskSnapshot();
  badPeak.account.peak_equity = 9000;
  assert.throws(() => normalizeMt5RiskSnapshot(badPeak), /peak_equity_below_equity/);

  const noCompleteness = riskSnapshot();
  delete noCompleteness.account.open_risk_complete;
  assert.throws(() => normalizeMt5RiskSnapshot(noCompleteness), /open_risk_complete_required/);
});

test('MT5 Risk Plane V2.3 TCP risk snapshot becomes loopback HTTP and adapter state', async () => {
  const bridge = createMt5SocketBridge({
    httpPort: 18805,
    ingestPort: 18806,
    staleAfterMs: 30_000,
    riskStaleAfterMs: 30_000,
  });

  try {
    await bridge.start();
    await sendLine({ port: 18806, payload: riskSnapshot() });

    const response = await fetch('http://127.0.0.1:18805/v1/risk-state?symbol=XAUUSD');
    assert.equal(response.status, 200);
    const raw = await response.json();
    assert.equal(raw.account.account_type, 'demo');
    assert.equal(raw.broker_symbol, 'XAUUSDm');

    const adapter = new Mt5RiskLoopbackAdapter({
      baseUrl: 'http://127.0.0.1:18805',
    });
    const state = await adapter.getRiskState({ symbol: 'XAUUSD' });

    assert.equal(state.account.equity, 10000);
    assert.equal(state.account.peak_equity, 10200);
    assert.equal(state.account.open_positions, 1);
    assert.equal(state.broker.bid, 2500);
    assert.equal(state.broker.ask, 2500.5);
    assert.equal(Object.hasOwn(state.account, 'login'), false);
    assert.equal(Object.hasOwn(state, 'account_number'), false);
  } finally {
    await bridge.stop();
  }
});

test('MT5 Risk Plane V2.4 missing and stale risk telemetry returns 503', async () => {
  let now = Date.now();
  const bridge = createMt5SocketBridge({
    httpPort: 18807,
    ingestPort: 18808,
    riskStaleAfterMs: 1000,
    now: () => now,
  });

  try {
    await bridge.start();

    const missing = await fetch('http://127.0.0.1:18807/v1/risk-state?symbol=XAUUSD');
    assert.equal(missing.status, 503);
    assert.equal((await missing.json()).error, 'mt5_no_risk_snapshot');

    await sendLine({ port: 18808, payload: riskSnapshot() });
    now += 2000;

    const stale = await fetch('http://127.0.0.1:18807/v1/risk-state?symbol=XAUUSD');
    assert.equal(stale.status, 503);
    assert.equal((await stale.json()).error, 'mt5_risk_snapshot_stale');
  } finally {
    await bridge.stop();
  }
});

test('MT5 Risk Plane V2.5 incomplete open-position risk is visible at transport but adapter refuses it', async () => {
  const bridge = createMt5SocketBridge({
    httpPort: 18809,
    ingestPort: 18810,
    riskStaleAfterMs: 30_000,
  });

  try {
    await bridge.start();
    const incomplete = riskSnapshot();
    incomplete.account.open_risk_complete = false;
    await sendLine({ port: 18810, payload: incomplete });

    const adapter = new Mt5RiskLoopbackAdapter({
      baseUrl: 'http://127.0.0.1:18809',
    });
    await assert.rejects(
      () => adapter.getRiskState({ symbol: 'XAUUSD' }),
      /mt5_risk_open_risk_incomplete/,
    );
  } finally {
    await bridge.stop();
  }
});

test('MT5 Risk Plane V2.6 risk endpoint remains loopback-only through bridge host policy', () => {
  assert.throws(
    () => createMt5SocketBridge({ host: '0.0.0.0' }),
    /mt5_bridge_loopback_required/,
  );
});
