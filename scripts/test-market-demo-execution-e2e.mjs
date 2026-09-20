import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createMt5SocketBridge } from '../mcp/market/mt5-bridge-server.mjs';
import { Mt5RiskLoopbackAdapter } from '../mcp/market/mt5-risk-adapter.mjs';
import { evaluateXauRisk } from '../mcp/market/risk-gate.mjs';
import { DemoAutoExecutor, DemoExecutionJournal } from '../mcp/market/demo-auto-executor.mjs';
import { parseTechnicalSignal } from '../mcp/market/technical-signal.mjs';

const nowMs = Date.UTC(2026, 8, 21, 2, 0, 0);
const nowIso = new Date(nowMs).toISOString();
const nowEpoch = Math.floor(nowMs / 1000);
const sessionId = 'demo:11111111-1111-4111-8111-111111111111';

const technicalSignal = parseTechnicalSignal({
  version: 'technical-signal-v1',
  id: 'techsig:v1:eeeeeeeeeeeeeeeeeeeeeeee',
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
  evidence: { test: 'demo-execution-e2e' },
  reason_codes: [],
  as_of: '2026-09-21T01:45:00.000Z',
  expires_at: '2026-09-21T02:15:00.000Z',
});

const riskSnapshot = {
  type: 'risk_snapshot',
  version: 1,
  canonical_symbol: 'XAUUSD',
  broker_symbol: 'GOLD',
  as_of: nowEpoch,
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
    bid: 2500.9,
    ask: 2501.1,
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

const modeState = {
  mode: 'DEMO_AUTO',
  demo_auto_enabled: true,
  trade_execution_enabled: true,
  demo_session_id: sessionId,
};

const connectFakeDemoEa = (port) => new Promise((resolve, reject) => {
  const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
    socket.setEncoding('utf8');
    socket.write(`${JSON.stringify(riskSnapshot)}\n`);
    socket.write(`${JSON.stringify({
      type: 'executor_hello',
      version: 1,
      canonical_symbol: 'XAUUSD',
      broker_symbol: 'GOLD',
      account_type: 'demo',
      as_of: nowEpoch,
    })}\n`);
    resolve(socket);
  });

  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const request = JSON.parse(line);
      if (request.type !== 'demo_order') continue;
      socket.write(`${JSON.stringify({
        type: 'execution_receipt',
        version: 1,
        request_id: request.request_id,
        status: 'FILLED',
        account_type: 'demo',
        retcode: 10009,
        reason: 'done',
        order_ticket: '5001',
        deal_ticket: '5002',
        position_ticket: '5003',
        fill_price: 2501.1,
        volume: request.volume,
        stop_loss: request.stop_loss,
        take_profit: request.take_profit,
        as_of: nowEpoch + 1,
      })}\n`);
    }
  });
  socket.on('error', reject);
});

test('Market Demo Execution E2E V3 READY signal -> Risk -> session-bound executor -> MT5 receipt', async () => {
  const bridge = createMt5SocketBridge({
    httpPort: 18845,
    ingestPort: 18846,
    riskStaleAfterMs: 30_000,
    executorStaleAfterMs: 30_000,
    now: () => nowMs,
  });

  let socket;
  try {
    await bridge.start();
    socket = await connectFakeDemoEa(18846);
    await new Promise((resolve) => setTimeout(resolve, 15));

    const riskAdapter = new Mt5RiskLoopbackAdapter({
      baseUrl: 'http://127.0.0.1:18845',
    });
    const telemetry = await riskAdapter.getRiskState({ symbol: 'XAUUSD' });

    const riskDecision = evaluateXauRisk({
      technicalSignal,
      modeState,
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
      now: nowIso,
    });

    assert.equal(riskDecision.decision, 'APPROVE');
    assert.equal(riskDecision.demo_session_id, sessionId);

    const journal = new DemoExecutionJournal({ now: () => nowIso });
    journal.load();
    const executor = new DemoAutoExecutor({
      getMode: () => modeState,
      transport: bridge,
      journal,
      now: () => nowIso,
    });

    const record = await executor.execute({
      technicalSignal,
      riskDecision,
      brokerState: telemetry.broker,
    });

    assert.equal(record.state, 'FILLED');
    assert.equal(record.request.demo_session_id, sessionId);
    assert.equal(record.request.volume, 1);
    assert.equal(record.receipt.account_type, 'demo');
    assert.equal(record.receipt.fill_price, 2501.1);
    assert.equal(journal.list().length, 1);
  } finally {
    socket?.destroy();
    await bridge.stop();
  }
});
