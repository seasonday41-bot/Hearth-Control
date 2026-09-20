import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveV2Coordinator } from '../mcp/market/live-v2-coordinator.mjs';

const mode = (overrides = {}) => ({
  mode: 'MONITOR',
  automatic_analysis_enabled: true,
  demo_auto_enabled: false,
  trade_execution_enabled: false,
  demo_session_id: null,
  ...overrides,
});

const bars = (timeframe, count = 30) => ({
  symbol: 'XAUUSD',
  timeframe,
  as_of: '2026-09-21T02:30:00.000Z',
  source: 'MT5',
  bars: Array.from({ length: count }, (_, index) => ({
    time: new Date(Date.UTC(2026, 8, 20, 20, 0, 0) + index * 300_000).toISOString(),
    open: 2500 + index,
    high: 2502 + index,
    low: 2498 + index,
    close: 2501 + index,
    volume: 1,
  })),
});

const engine = ({ strategy = 'SMC_IDM', state = 'PRE_SIGNAL', direction = 'BUY', suffix = 'a' } = {}) => ({
  version: strategy === 'SMC_IDM' ? 'smc-idm-engine-v1' : 'harmonic-prz-engine-v1',
  strategy,
  symbol: 'XAUUSD',
  direction,
  state,
  context_timeframe: 'H1',
  setup_timeframe: 'M15',
  trigger_timeframe: 'M5',
  entry_zone: [2520, 2524],
  invalidation: direction === 'BUY' ? 2510 : 2535,
  targets: [direction === 'BUY' ? 2540 : 2500],
  evidence: strategy === 'SMC_IDM'
    ? {
        bos: { reference: { time: `2026-09-20T20:0${suffix === 'a' ? '1' : '2'}:00.000Z` }, break_time: '2026-09-20T20:10:00.000Z' },
        idm: { time: '2026-09-20T20:05:00.000Z' },
      }
    : {
        points: {
          X: { time: '2026-09-20T20:00:00.000Z' },
          A: { time: '2026-09-20T20:05:00.000Z' },
          B: { time: '2026-09-20T20:10:00.000Z' },
          C: { time: '2026-09-20T20:15:00.000Z' },
        },
      },
  ...(strategy === 'HARMONIC_PRZ' ? { pattern: 'GARTLEY' } : {}),
  reason_codes: state === 'PRE_SIGNAL' ? ['waiting_for_m5_micro_bos'] : [],
  as_of: '2026-09-21T02:20:00.000Z',
});

const riskConfig = {
  version: 'demo-risk-config-v1',
  risk_fraction_per_trade: 0.005,
  max_daily_loss_fraction: 0.02,
  max_drawdown_fraction: 0.05,
  max_total_open_risk_fraction: 0.02,
  max_positions: 3,
  max_spread_points: 10,
  max_slippage_points: 3,
  min_stop_points: 10,
  max_stop_points: 200,
  requested_volume: null,
};

const marketAdapter = {
  getBars: async ({ timeframe }) => bars(timeframe),
};

const riskAdapter = {
  getRiskState: async () => ({
    account: {
      account_type: 'demo',
      currency: 'USD',
      equity: 10000,
      peak_equity: 10000,
      free_margin: 9000,
      daily_realized_loss: 0,
      open_risk_currency: 0,
      open_positions: 0,
      as_of: '2026-09-21T02:29:59.000Z',
    },
    broker: {
      symbol: 'XAUUSD',
      bid: 2521.9,
      ask: 2522.1,
      point_size: 0.1,
      tick_size: 0.1,
      tick_value_per_lot: 1,
      volume_min: 0.01,
      volume_max: 100,
      volume_step: 0.01,
      margin_per_lot: 1000,
      estimated_slippage_points: 1,
      as_of: '2026-09-21T02:29:59.000Z',
    },
  }),
};

const make = ({
  currentMode = mode(),
  configured = null,
  smc = engine(),
  harmonic = { ...engine({ strategy: 'HARMONIC_PRZ' }), state: 'INVALID', direction: null, entry_zone: null, invalidation: null, targets: [], reason_codes: ['pattern_not_found'] },
  execute = async () => ({ state: 'FILLED' }),
  entries = [],
  evaluateRisk = () => ({
    version: 'xau-risk-decision-v1',
    id: 'riskdec:v1:bbbbbbbbbbbbbbbbbbbbbbbb',
    proposal_id: 'techsig:v1:000000000000000000000000',
    strategy: 'SMC_IDM',
    symbol: 'XAUUSD',
    decision: 'APPROVE',
    demo_session_id: 'demo:11111111-1111-4111-8111-111111111111',
    approved_risk_fraction: 0.005,
    approved_volume: 0.5,
    reason_codes: [],
    checks: {},
    sizing: {},
    as_of: '2026-09-21T02:30:00.000Z',
  }),
} = {}) => {
  let executions = 0;
  const coordinator = new LiveV2Coordinator({
    getMode: () => currentMode,
    getRiskConfig: () => configured,
    marketAdapter,
    riskAdapter,
    executor: { execute: async (args) => { executions += 1; return execute(args); } },
    executionJournal: { list: () => entries },
    analyzeSmc: () => smc,
    analyzeHarmonic: () => harmonic,
    evaluateRisk,
    now: () => '2026-09-21T02:30:00.000Z',
    intervalMs: 60_000,
  });
  return { coordinator, executions: () => executions };
};

test('Live V2 V2.1 OFF does not read MT5 or execute', async () => {
  let reads = 0;
  const { coordinator, executions } = make({ currentMode: mode({ mode: 'OFF', automatic_analysis_enabled: false }) });
  coordinator.marketAdapter = { getBars: async () => { reads += 1; return bars('H1'); } };
  const state = await coordinator.check({ force: true });
  assert.equal(state.state, 'off');
  assert.equal(reads, 0);
  assert.equal(executions(), 0);
});

test('Live V2 V2.2 PRE_SIGNAL is visible in MONITOR and never reaches Risk/Executor', async () => {
  const { coordinator, executions } = make();
  const state = await coordinator.check({ force: true });
  assert.equal(state.strategies.SMC_IDM.state, 'PRE_SIGNAL');
  assert.match(state.strategies.SMC_IDM.signal_id, /^techsig:v1:/);
  assert.equal(state.execution_blocked_reason, null);
  assert.equal(executions(), 0);
});

test('Live V2 V2.3 READY in MONITOR is display-only', async () => {
  const { coordinator, executions } = make({ smc: engine({ state: 'READY' }) });
  const state = await coordinator.check({ force: true });
  assert.equal(state.strategies.SMC_IDM.state, 'READY');
  assert.equal(state.state, 'ready_monitor_only');
  assert.equal(state.execution_blocked_reason, 'demo_auto_not_enabled');
  assert.equal(executions(), 0);
});

test('Live V2 V2.4 DEMO_AUTO with no explicit risk config blocks execution', async () => {
  const currentMode = mode({
    mode: 'DEMO_AUTO',
    demo_auto_enabled: true,
    trade_execution_enabled: true,
    demo_session_id: 'demo:11111111-1111-4111-8111-111111111111',
  });
  const { coordinator, executions } = make({ currentMode, smc: engine({ state: 'READY' }) });
  const state = await coordinator.check({ force: true });
  assert.equal(state.state, 'blocked');
  assert.equal(state.execution_blocked_reason, 'risk_config_required');
  assert.equal(executions(), 0);
});

test('Live V2 V2.5 two independent READY strategies fail closed instead of choosing a winner', async () => {
  const currentMode = mode({
    mode: 'DEMO_AUTO',
    demo_auto_enabled: true,
    trade_execution_enabled: true,
    demo_session_id: 'demo:11111111-1111-4111-8111-111111111111',
  });
  const { coordinator, executions } = make({
    currentMode,
    configured: riskConfig,
    smc: engine({ state: 'READY' }),
    harmonic: engine({ strategy: 'HARMONIC_PRZ', state: 'READY' }),
  });
  const state = await coordinator.check({ force: true });
  assert.equal(state.execution_blocked_reason, 'multiple_ready_setups');
  assert.equal(executions(), 0);
});

test('Live V2 V2.6 one READY setup can pass Risk and reach executor exactly once', async () => {
  const currentMode = mode({
    mode: 'DEMO_AUTO',
    demo_auto_enabled: true,
    trade_execution_enabled: true,
    demo_session_id: 'demo:11111111-1111-4111-8111-111111111111',
  });

  let riskCalls = 0;
  const { coordinator, executions } = make({
    currentMode,
    configured: riskConfig,
    smc: engine({ state: 'READY' }),
    evaluateRisk: ({ technicalSignal }) => {
      riskCalls += 1;
      return {
        version: 'xau-risk-decision-v1',
        id: 'riskdec:v1:bbbbbbbbbbbbbbbbbbbbbbbb',
        proposal_id: technicalSignal.id,
        strategy: technicalSignal.strategy,
        symbol: 'XAUUSD',
        decision: 'APPROVE',
        demo_session_id: currentMode.demo_session_id,
        approved_risk_fraction: 0.005,
        approved_volume: 0.5,
        reason_codes: [],
        checks: {},
        sizing: {},
        as_of: '2026-09-21T02:30:00.000Z',
      };
    },
  });

  const state = await coordinator.check({ force: true });
  assert.equal(state.state, 'executed');
  assert.equal(state.risk.decision, 'APPROVE');
  assert.equal(state.risk.approved_volume, 0.5);
  assert.equal(riskCalls, 1);
  assert.equal(executions(), 1);
});

test('Live V2 V2.7 a proposal already present in execution journal is never resubmitted', async () => {
  const currentMode = mode({
    mode: 'DEMO_AUTO',
    demo_auto_enabled: true,
    trade_execution_enabled: true,
    demo_session_id: 'demo:11111111-1111-4111-8111-111111111111',
  });
  const ready = engine({ state: 'READY' });
  const temp = make({ currentMode, configured: riskConfig, smc: ready });
  const preview = await temp.coordinator.check({ force: true });
  const signalId = preview.strategies.SMC_IDM.signal_id;

  const { coordinator, executions } = make({
    currentMode,
    configured: riskConfig,
    smc: ready,
    entries: [{ proposal_id: signalId, state: 'FILLED' }],
  });
  const state = await coordinator.check({ force: true });
  assert.equal(state.execution_blocked_reason, 'setup_already_submitted');
  assert.equal(executions(), 0);
});

test('Live V2 V2.8 uncertain executor failure trips coordinator circuit breaker', async () => {
  const currentMode = mode({
    mode: 'DEMO_AUTO',
    demo_auto_enabled: true,
    trade_execution_enabled: true,
    demo_session_id: 'demo:11111111-1111-4111-8111-111111111111',
  });
  const { coordinator, executions } = make({
    currentMode,
    configured: riskConfig,
    smc: engine({ state: 'READY' }),
    execute: async () => { throw new Error('receipt_timeout'); },
    evaluateRisk: ({ technicalSignal }) => ({
      version: 'xau-risk-decision-v1',
      id: 'riskdec:v1:cccccccccccccccccccccccc',
      proposal_id: technicalSignal.id,
      strategy: technicalSignal.strategy,
      symbol: 'XAUUSD',
      decision: 'APPROVE',
      demo_session_id: currentMode.demo_session_id,
      approved_risk_fraction: 0.005,
      approved_volume: 0.5,
      reason_codes: [],
      checks: {},
      sizing: {},
      as_of: '2026-09-21T02:30:00.000Z',
    }),
  });
  const state = await coordinator.check({ force: true });
  assert.equal(state.execution_blocked_reason, 'execution_uncertain_circuit_breaker');
  assert.equal(state.circuit_breaker_active, true);
  assert.equal(executions(), 1);
});

test('Live V2 V2.9 repeated check on the same closed M5 bar is deduplicated', async () => {
  let analyses = 0;
  const { coordinator } = make();
  coordinator.analyzeSmc = () => { analyses += 1; return engine(); };
  await coordinator.check();
  await coordinator.check();
  assert.equal(analyses, 1);
});

test('Live V2 V2.10 forming MT5 bar is excluded from all three engine inputs', async () => {
  const seen = {};
  const { coordinator } = make();
  coordinator.analyzeSmc = ({ contextBars, setupBars, triggerBars }) => {
    seen.h1 = contextBars.length;
    seen.m15 = setupBars.length;
    seen.m5 = triggerBars.length;
    return engine();
  };
  await coordinator.check({ force: true });
  assert.deepEqual(seen, { h1: 29, m15: 29, m5: 29 });
});
