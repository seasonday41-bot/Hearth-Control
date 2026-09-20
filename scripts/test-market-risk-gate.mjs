import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateXauRisk, XAU_RISK_DECISION_VERSION } from '../mcp/market/risk-gate.mjs';
import { parseTechnicalSignal } from '../mcp/market/technical-signal.mjs';

const now = '2026-09-21T02:00:00.000Z';
const demoSessionId = 'demo:11111111-1111-4111-8111-111111111111';

const readySignal = (overrides = {}) => parseTechnicalSignal({
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
  evidence: { setup: 'test' },
  reason_codes: [],
  as_of: '2026-09-21T01:45:00.000Z',
  expires_at: '2026-09-21T02:15:00.000Z',
  ...overrides,
});

const modeState = (overrides = {}) => ({
  version: 'invest-mode-v1',
  mode: 'DEMO_AUTO',
  startup_mode: 'MONITOR',
  automatic_analysis_enabled: true,
  demo_auto_enabled: true,
  trade_execution_enabled: true,
  demo_session_id: demoSessionId,
  restore_reason: 'runtime_transition',
  ...overrides,
});

const accountState = (overrides = {}) => ({
  account_type: 'demo',
  currency: 'USD',
  equity: 10000,
  peak_equity: 10200,
  free_margin: 8000,
  daily_realized_loss: 50,
  open_risk_currency: 50,
  open_positions: 1,
  cooldown_active: false,
  circuit_breaker_active: false,
  as_of: '2026-09-21T01:59:50.000Z',
  ...overrides,
});

const brokerState = (overrides = {}) => ({
  symbol: 'XAUUSD',
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
  as_of: '2026-09-21T01:59:55.000Z',
  ...overrides,
});

const riskConfig = (overrides = {}) => ({
  risk_fraction_per_trade: 0.005,
  max_daily_loss_fraction: 0.02,
  max_drawdown_fraction: 0.05,
  max_total_open_risk_fraction: 0.02,
  max_positions: 3,
  max_spread_points: 10,
  max_slippage_points: 3,
  min_stop_points: 10,
  max_stop_points: 200,
  max_state_age_ms: 30000,
  requested_volume: null,
  ...overrides,
});

const evaluate = (overrides = {}) => evaluateXauRisk({
  technicalSignal: overrides.technicalSignal || readySignal(),
  modeState: overrides.modeState || modeState(),
  accountState: overrides.accountState || accountState(),
  brokerState: overrides.brokerState || brokerState(),
  riskConfig: overrides.riskConfig || riskConfig(),
  now: overrides.now || now,
});

test('Risk V2.1 approves a valid demo READY signal with deterministic broker-normalized size', () => {
  const result = evaluate();
  assert.equal(result.version, XAU_RISK_DECISION_VERSION);
  assert.equal(result.decision, 'APPROVE');
  assert.equal(result.proposal_id, readySignal().id);
  assert.equal(result.approved_volume, 1);
  assert.equal(result.approved_risk_fraction, 0.005);
  assert.equal(result.checks.mode, 'pass');
  assert.equal(result.checks.account, 'pass');
  assert.equal(result.checks.margin, 'pass');
  assert.equal(result.sizing.loss_per_lot, 50);
  assert.equal(result.sizing.risk_budget_currency, 50);
  assert.equal(result.sizing.max_slippage_points, 3);
  assert.equal(result.demo_session_id, demoSessionId);
});

test('Risk V2.2 requested size above the risk ceiling is RESIZE, never a technical override', () => {
  const result = evaluate({ riskConfig: riskConfig({ requested_volume: 2 }) });
  assert.equal(result.decision, 'RESIZE');
  assert.equal(result.approved_volume, 1);
  assert.ok(result.reason_codes.includes('requested_volume_reduced'));
  assert.equal(result.strategy, 'SMC_IDM');
});

test('Risk V2.3 daily loss limit has veto authority', () => {
  const result = evaluate({
    accountState: accountState({ daily_realized_loss: 250 }),
  });
  assert.equal(result.decision, 'REJECT');
  assert.equal(result.approved_volume, null);
  assert.ok(result.reason_codes.includes('daily_loss_limit_reached'));
  assert.equal(result.checks.daily_loss, 'fail');
});

test('Risk V2.4 drawdown and circuit breaker independently veto a signal', () => {
  const drawdown = evaluate({
    accountState: accountState({ equity: 9000, peak_equity: 10000 }),
  });
  assert.equal(drawdown.decision, 'REJECT');
  assert.ok(drawdown.reason_codes.includes('drawdown_limit_reached'));

  const breaker = evaluate({
    accountState: accountState({ circuit_breaker_active: true }),
  });
  assert.equal(breaker.decision, 'REJECT');
  assert.ok(breaker.reason_codes.includes('circuit_breaker_active'));
});

test('Risk V2.5 live account is rejected even when every other input is valid', () => {
  const result = evaluate({
    accountState: accountState({ account_type: 'live' }),
  });
  assert.equal(result.decision, 'REJECT');
  assert.ok(result.reason_codes.includes('demo_account_required'));
  assert.equal(result.checks.account, 'fail');
});

test('Risk V2.6 DEMO_AUTO requires an explicit current-session execution latch', () => {
  const result = evaluate({
    modeState: modeState({ mode: 'MONITOR', demo_auto_enabled: false, trade_execution_enabled: false, demo_session_id: null }),
  });
  assert.equal(result.decision, 'REJECT');
  assert.ok(result.reason_codes.includes('demo_auto_not_enabled'));

  const approved = evaluate();
  assert.equal(approved.decision, 'APPROVE');
  assert.equal(approved.demo_session_id, demoSessionId);
  assert.equal(modeState().trade_execution_enabled, true);
  assert.equal(Object.hasOwn(approved, 'trade_execution_enabled'), false);

  const missingSession = evaluate({
    modeState: modeState({ demo_session_id: null }),
  });
  assert.equal(missingSession.decision, 'REJECT');
  assert.ok(missingSession.reason_codes.includes('demo_session_required'));
});

test('Risk V2.7 stale signal or stale account/broker state fails closed', () => {
  const staleSignal = evaluate({ now: '2026-09-21T02:15:00.000Z' });
  assert.equal(staleSignal.decision, 'REJECT');
  assert.ok(staleSignal.reason_codes.includes('signal_stale'));

  const staleBroker = evaluate({
    brokerState: brokerState({ as_of: '2026-09-21T01:58:00.000Z' }),
  });
  assert.equal(staleBroker.decision, 'REJECT');
  assert.ok(staleBroker.reason_codes.includes('risk_state_stale'));
});

test('Risk V2.8 spread, slippage, and stop-distance guards fail closed', () => {
  const spread = evaluate({ brokerState: brokerState({ ask: 2503 }) });
  assert.equal(spread.decision, 'REJECT');
  assert.ok(spread.reason_codes.includes('spread_too_wide'));

  const slippage = evaluate({ brokerState: brokerState({ estimated_slippage_points: 5 }) });
  assert.equal(slippage.decision, 'REJECT');
  assert.ok(slippage.reason_codes.includes('slippage_too_high'));

  const stop = evaluate({
    technicalSignal: readySignal({ invalidation: 2500.5 }),
  });
  assert.equal(stop.decision, 'REJECT');
  assert.ok(stop.reason_codes.includes('stop_distance_out_of_bounds'));
});

test('Risk V2.9 open-risk and max-position limits veto new exposure', () => {
  const exposure = evaluate({
    accountState: accountState({ open_risk_currency: 200 }),
  });
  assert.equal(exposure.decision, 'REJECT');
  assert.ok(exposure.reason_codes.includes('open_risk_limit_reached'));

  const positions = evaluate({
    accountState: accountState({ open_positions: 3 }),
  });
  assert.equal(positions.decision, 'REJECT');
  assert.ok(positions.reason_codes.includes('max_positions_reached'));
});

test('Risk V2.10 margin can cap volume and trigger RESIZE', () => {
  const result = evaluate({
    accountState: accountState({ free_margin: 600 }),
    riskConfig: riskConfig({ requested_volume: 1 }),
  });
  assert.equal(result.decision, 'RESIZE');
  assert.equal(result.approved_volume, 0.6);
  assert.equal(result.checks.margin, 'pass');
});

test('Risk V2.11 missing broker sizing metadata fails closed instead of assuming XAU contract specs', () => {
  const broken = brokerState();
  delete broken.tick_value_per_lot;
  const result = evaluate({ brokerState: broken });
  assert.equal(result.decision, 'REJECT');
  assert.ok(result.reason_codes.includes('risk_tick_value_invalid'));
  assert.equal(result.checks.broker, 'fail');
});

test('Risk V2.12 missing account state fails closed', () => {
  const result = evaluate({ accountState: {} });
  assert.equal(result.decision, 'REJECT');
  assert.ok(result.reason_codes.includes('risk_account_type_invalid') || result.reason_codes.includes('risk_account_state_required'));
});

test('Risk V2.13 PRE_SIGNAL cannot be approved', () => {
  const pre = {
    ...readySignal(),
    state: 'PRE_SIGNAL',
    expires_at: '2026-09-21T05:45:00.000Z',
  };
  const result = evaluate({ technicalSignal: pre });
  assert.equal(result.decision, 'REJECT');
  assert.ok(result.reason_codes.includes('signal_not_ready'));
});

test('Risk V2.14 Risk Gate does not mutate the technical signal or invent direction/targets', () => {
  const technicalSignal = readySignal();
  const before = structuredClone(technicalSignal);
  const result = evaluate({ technicalSignal });
  assert.deepEqual(technicalSignal, before);
  assert.equal(result.strategy, technicalSignal.strategy);
  assert.equal(Object.hasOwn(result, 'direction'), false);
  assert.equal(Object.hasOwn(result, 'targets'), false);
  assert.equal(Object.hasOwn(result, 'order'), false);
});

test('Risk V2.15 risk configuration is explicit and internally bounded', () => {
  const result = evaluate({
    riskConfig: riskConfig({ risk_fraction_per_trade: 0.03, max_total_open_risk_fraction: 0.02 }),
  });
  assert.equal(result.decision, 'REJECT');
  assert.ok(result.reason_codes.includes('risk_trade_fraction_exceeds_total_open_risk'));
});
