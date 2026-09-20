import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEMO_EXECUTION_JOURNAL_VERSION,
  DemoAutoExecutor,
  DemoExecutionJournal,
  DemoExecutionJournalFileStore,
  parseDemoExecutionReceipt,
  prepareDemoExecutionRequest,
} from '../mcp/market/demo-auto-executor.mjs';
import { parseTechnicalSignal } from '../mcp/market/technical-signal.mjs';

const session = 'demo:11111111-1111-4111-8111-111111111111';
const now = '2026-09-21T02:00:00.000Z';

const signal = (overrides = {}) => parseTechnicalSignal({
  version: 'technical-signal-v1',
  id: 'techsig:v1:aaaaaaaaaaaaaaaaaaaaaaaa',
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
  evidence: { test: true },
  reason_codes: [],
  as_of: '2026-09-21T01:45:00.000Z',
  expires_at: '2026-09-21T02:15:00.000Z',
  ...overrides,
});

const risk = (overrides = {}) => ({
  version: 'xau-risk-decision-v1',
  id: 'riskdec:v1:bbbbbbbbbbbbbbbbbbbbbbbb',
  proposal_id: 'techsig:v1:aaaaaaaaaaaaaaaaaaaaaaaa',
  strategy: 'SMC_IDM',
  symbol: 'XAUUSD',
  decision: 'APPROVE',
  demo_session_id: session,
  approved_risk_fraction: 0.005,
  approved_volume: 1,
  reason_codes: [],
  checks: {
    signal: 'pass', freshness: 'pass', mode: 'pass', account: 'pass', broker: 'pass',
    stop: 'pass', spread: 'pass', slippage: 'pass', daily_loss: 'pass', drawdown: 'pass',
    positions: 'pass', exposure: 'pass', margin: 'pass', cooldown: 'pass', circuit_breaker: 'pass',
  },
  sizing: { max_slippage_points: 3 },
  as_of: '2026-09-21T01:59:55.000Z',
  ...overrides,
});

const mode = (overrides = {}) => ({
  mode: 'DEMO_AUTO',
  demo_auto_enabled: true,
  trade_execution_enabled: true,
  demo_session_id: session,
  ...overrides,
});

const broker = (overrides = {}) => ({
  symbol: 'XAUUSD',
  bid: 2500.9,
  ask: 2501.1,
  point_size: 0.1,
  as_of: '2026-09-21T01:59:58.000Z',
  ...overrides,
});

const receipt = (request, overrides = {}) => ({
  type: 'execution_receipt',
  version: 1,
  request_id: request.request_id,
  status: 'FILLED',
  account_type: 'demo',
  retcode: 10009,
  reason: 'done',
  order_ticket: '10',
  deal_ticket: '20',
  position_ticket: '30',
  fill_price: 2501.1,
  volume: 1,
  stop_loss: 2496,
  take_profit: 2512,
  as_of: '2026-09-21T02:00:01.000Z',
  ...overrides,
});

test('Demo Executor V2.1 prepares a session-bound order only from READY + approved risk', () => {
  const request = prepareDemoExecutionRequest({
    technicalSignal: signal(),
    riskDecision: risk(),
    modeState: mode(),
    brokerState: broker(),
    now,
  });

  assert.match(request.request_id, /^exec:v1:[a-f0-9]{24}$/);
  assert.equal(request.side, 'BUY');
  assert.equal(request.volume, 1);
  assert.equal(request.stop_loss, 2496);
  assert.equal(request.take_profit, 2512);
  assert.equal(request.demo_session_id, session);
  assert.equal(request.max_deviation_points, 3);
  assert.match(request.request_tag, /^HRT8_[A-F0-9]{12}$/);
});

test('Demo Executor V2.2 refuses session mismatch, stale risk, and price outside entry zone', () => {
  assert.throws(
    () => prepareDemoExecutionRequest({
      technicalSignal: signal(), riskDecision: risk(), modeState: mode({ demo_session_id: 'demo:22222222-2222-4222-8222-222222222222' }),
      brokerState: broker(), now,
    }),
    /session_mismatch/,
  );

  assert.throws(
    () => prepareDemoExecutionRequest({
      technicalSignal: signal(), riskDecision: risk({ as_of: '2026-09-21T01:59:00.000Z' }), modeState: mode(),
      brokerState: broker(), now,
    }),
    /risk_decision_stale/,
  );

  assert.throws(
    () => prepareDemoExecutionRequest({
      technicalSignal: signal(), riskDecision: risk(), modeState: mode(),
      brokerState: broker({ ask: 2505, bid: 2504.8 }), now,
    }),
    /price_outside_entry_zone/,
  );
});

test('Demo Executor V2.3 REJECT risk decisions and failed checks cannot become orders', () => {
  assert.throws(
    () => prepareDemoExecutionRequest({
      technicalSignal: signal(),
      riskDecision: risk({ decision: 'REJECT', approved_volume: null, approved_risk_fraction: null }),
      modeState: mode(),
      brokerState: broker(),
      now,
    }),
    /risk_not_approved/,
  );

  const failedChecks = risk();
  failedChecks.checks.spread = 'fail';
  assert.throws(
    () => prepareDemoExecutionRequest({
      technicalSignal: signal(), riskDecision: failedChecks, modeState: mode(), brokerState: broker(), now,
    }),
    /risk_checks_not_passed/,
  );
});

test('Demo Executor V2.4 live/non-demo receipts are rejected even after local approval', () => {
  const request = prepareDemoExecutionRequest({
    technicalSignal: signal(), riskDecision: risk(), modeState: mode(), brokerState: broker(), now,
  });
  assert.throws(
    () => parseDemoExecutionReceipt(receipt(request, { account_type: 'live' }), request),
    /receipt_not_demo/,
  );
});

test('Demo Executor V2.5 persistent journal is atomic and survives restart', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-demo-exec-'));
  try {
    const storagePath = path.join(root, 'demo-executions.json');
    const first = new DemoExecutionJournal({
      store: new DemoExecutionJournalFileStore({ storagePath }),
      now: () => now,
    });
    first.load();
    const request = prepareDemoExecutionRequest({
      technicalSignal: signal(), riskDecision: risk(), modeState: mode(), brokerState: broker(), now,
    });
    first.prepare(request);
    first.transition(request.request_id, 'SENT');
    first.transition(request.request_id, 'FILLED', { receipt: receipt(request) });

    const restarted = new DemoExecutionJournal({
      store: new DemoExecutionJournalFileStore({ storagePath }),
    });
    const records = restarted.load();
    assert.equal(records.length, 1);
    assert.equal(records[0].state, 'FILLED');
    assert.equal(records[0].attempts, 1);
    assert.equal(fs.readdirSync(root).some((name) => name.endsWith('.tmp')), false);
    assert.equal(JSON.parse(fs.readFileSync(storagePath, 'utf8')).version, DEMO_EXECUTION_JOURNAL_VERSION);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Demo Executor V2.6 successful transport is journaled and exact repeat is idempotent', async () => {
  let calls = 0;
  const journal = new DemoExecutionJournal({ now: () => now });
  journal.load();
  const transport = {
    status: () => ({ executor_ready: true, executor_account_type: 'demo' }),
    executeDemoOrder: async (request) => {
      calls += 1;
      return receipt(request);
    },
  };
  const executor = new DemoAutoExecutor({
    getMode: () => mode(),
    transport,
    journal,
    now: () => now,
  });

  const args = { technicalSignal: signal(), riskDecision: risk(), brokerState: broker() };
  const first = await executor.execute(args);
  const second = await executor.execute(args);

  assert.equal(first.state, 'FILLED');
  assert.equal(second.state, 'FILLED');
  assert.equal(calls, 1);
  assert.equal(journal.list().length, 1);
});

test('Demo Executor V2.7 transport uncertainty is persisted and retry uses the same stable request id', async () => {
  const journal = new DemoExecutionJournal({ now: () => now });
  journal.load();
  let calls = 0;
  const requestIds = [];
  const transport = {
    status: () => ({ executor_ready: true, executor_account_type: 'demo' }),
    executeDemoOrder: async (request) => {
      calls += 1;
      requestIds.push(request.request_id);
      if (calls === 1) throw new Error('receipt_timeout');
      return receipt(request, { status: 'DUPLICATE', reason: 'already_seen' });
    },
  };
  const executor = new DemoAutoExecutor({
    getMode: () => mode(),
    transport,
    journal,
    now: () => now,
  });
  const args = { technicalSignal: signal(), riskDecision: risk(), brokerState: broker() };

  await assert.rejects(() => executor.execute(args), /receipt_timeout/);
  assert.equal(journal.list()[0].state, 'UNCERTAIN');

  const recovered = await executor.execute(args);
  assert.equal(recovered.state, 'DUPLICATE');
  assert.equal(calls, 2);
  assert.equal(requestIds[0], requestIds[1]);
});

test('Demo Executor V2.8 kill switch/mode change blocks dispatch', async () => {
  let current = mode();
  let calls = 0;
  const journal = new DemoExecutionJournal({ now: () => now });
  journal.load();
  const transport = {
    executeDemoOrder: async (request) => {
      calls += 1;
      return receipt(request);
    },
  };
  const executor = new DemoAutoExecutor({
    getMode: () => current,
    transport,
    journal,
    now: () => now,
  });

  current = mode({ mode: 'OFF', demo_auto_enabled: false, trade_execution_enabled: false, demo_session_id: null });
  await assert.rejects(
    () => executor.execute({ technicalSignal: signal(), riskDecision: risk(), brokerState: broker() }),
    /not_enabled/,
  );
  assert.equal(calls, 0);
});

test('Demo Executor V2.9 executor never derives or increases volume beyond Risk decision', () => {
  const request = prepareDemoExecutionRequest({
    technicalSignal: signal(),
    riskDecision: risk({ decision: 'RESIZE', approved_volume: 0.37 }),
    modeState: mode(),
    brokerState: broker(),
    now,
  });
  assert.equal(request.volume, 0.37);
  assert.equal(Object.hasOwn(request, 'risk_fraction'), false);
  assert.equal(Object.hasOwn(request, 'balance'), false);
  assert.equal(Object.hasOwn(request, 'equity'), false);
});

test('Demo Executor V2.10 SELL geometry maps bid, stop and TP without reinterpreting strategy', () => {
  const sellSignal = signal({
    id: 'techsig:v1:cccccccccccccccccccccccc',
    strategy: 'HARMONIC_PRZ',
    direction: 'SELL',
    entry_zone: [2499, 2501],
    invalidation: 2506,
    targets: [2488],
  });
  const sellRisk = risk({
    id: 'riskdec:v1:dddddddddddddddddddddddd',
    proposal_id: sellSignal.id,
    strategy: 'HARMONIC_PRZ',
  });
  const request = prepareDemoExecutionRequest({
    technicalSignal: sellSignal,
    riskDecision: sellRisk,
    modeState: mode(),
    brokerState: broker({ bid: 2500, ask: 2500.2 }),
    now,
  });

  assert.equal(request.side, 'SELL');
  assert.equal(request.reference_price, 2500);
  assert.equal(request.stop_loss, 2506);
  assert.equal(request.take_profit, 2488);
});
