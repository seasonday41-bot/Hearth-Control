import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createMt5SocketBridge } from '../mcp/market/mt5-bridge-server.mjs';
import { Mt5RiskLoopbackAdapter } from '../mcp/market/mt5-risk-adapter.mjs';
import { evaluateXauRisk } from '../mcp/market/risk-gate.mjs';
import { parseTechnicalSignal } from '../mcp/market/technical-signal.mjs';

const asOfEpoch = Date.UTC(2026, 8, 21, 2, 0, 0) / 1000;
const asOfIso = new Date(asOfEpoch * 1000).toISOString();

const riskSnapshot = {
  type: 'risk_snapshot',
  version: 1,
  canonical_symbol: 'XAUUSD',
  broker_symbol: 'GOLD',
  as_of: asOfEpoch,
  account: {
    account_type: 'demo',
    currency: 'USD',
    equity: 10000,
    peak_equity: 10200,
    free_margin: 8000,
    daily_realized_loss: 50,
    open_risk_currency: 50,
    open_positions: 1,
    open_risk_complete: true,
  },
  broker: {
    bid: 2501,
    ask: 2501.5,
    point_size: 0.1,
    tick_size: 0.1,
    tick_value_per_lot: 1,
    volume_min: 0.01,
    volume_max: 100,
    volume_step: 0.01,
    margin_per_lot: 1000,
    estimated_slippage_points: 1,
  },
};

const signal = parseTechnicalSignal({
  version: 'technical-signal-v1',
  id: 'techsig:v1:dddddddddddddddddddddddd',
  strategy: 'SMC_IDM',
  symbol: 'XAUUSD',
  direction: 'BUY',
  state: 'READY',
  context_timeframe: 'H1',
  setup_timeframe: 'M15',
  trigger_timeframe: 'M5',
  entry_zone: [2500, 2502],
  invalidation: 2496,
  targets: [2512],
  evidence: { test: 'mt5-risk-e2e' },
  reason_codes: [],
  as_of: '2026-09-21T01:45:00.000Z',
  expires_at: '2026-09-21T02:15:00.000Z',
});

const sendLine = (port, payload) => new Promise((resolve, reject) => {
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

test('Market Risk E2E V2 TCP risk telemetry -> adapter -> independent Risk Gate', async () => {
  const bridge = createMt5SocketBridge({
    httpPort: 18815,
    ingestPort: 18816,
    riskStaleAfterMs: 30_000,
  });

  try {
    await bridge.start();
    await sendLine(18816, riskSnapshot);

    const adapter = new Mt5RiskLoopbackAdapter({
      baseUrl: 'http://127.0.0.1:18815',
    });
    const telemetry = await adapter.getRiskState({ symbol: 'XAUUSD' });

    const decision = evaluateXauRisk({
      technicalSignal: signal,
      modeState: {
        mode: 'DEMO_AUTO',
        demo_auto_enabled: true,
        trade_execution_enabled: true,
        demo_session_id: 'demo:11111111-1111-4111-8111-111111111111',
      },
      accountState: {
        ...telemetry.account,
        cooldown_active: false,
        circuit_breaker_active: false,
      },
      brokerState: telemetry.broker,
      riskConfig: {
        risk_fraction_per_trade: 0.005,
        max_daily_loss_fraction: 0.02,
        max_drawdown_fraction: 0.05,
        max_total_open_risk_fraction: 0.02,
        max_positions: 3,
        max_spread_points: 10,
        max_slippage_points: 3,
        min_stop_points: 10,
        max_stop_points: 200,
        max_state_age_ms: 30_000,
        requested_volume: null,
      },
      now: asOfIso,
    });

    assert.equal(decision.decision, 'APPROVE');
    assert.equal(decision.approved_volume, 1);
    assert.equal(decision.approved_risk_fraction, 0.005);
    assert.equal(decision.proposal_id, signal.id);
    assert.equal(decision.demo_session_id, 'demo:11111111-1111-4111-8111-111111111111');
    assert.equal(Object.hasOwn(decision, 'order'), false);
    assert.equal(Object.hasOwn(decision, 'trade_execution_enabled'), false);
  } finally {
    await bridge.stop();
  }
});