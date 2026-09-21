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
  now = () => '2026-09-21T02:30:00.000Z',
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
    now,
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

// ---------- WAITING_FOR_ENTRY policy ----------
//
// Clock domain: signals are stamped from MT5 bar times, so these tests drive expiry ONLY through the
// closed M5 bar time. The wall clock (`now`) is set to an unrelated far-future date on purpose.

const SESSION = 'demo:11111111-1111-4111-8111-111111111111';
const OTHER_SESSION = 'demo:22222222-2222-4222-8222-222222222222';
const OUTSIDE = 'demo_executor_price_outside_entry_zone';
const M5 = 300_000;
const at = (hhmm) => `2026-09-21T${hhmm}:00.000Z`;

const demoAuto = (overrides = {}) => mode({
  mode: 'DEMO_AUTO',
  demo_auto_enabled: true,
  trade_execution_enabled: true,
  demo_session_id: SESSION,
  ...overrides,
});

const decision = (technicalSignal, currentMode, overrides = {}) => ({
  version: 'xau-risk-decision-v1',
  id: 'riskdec:v1:dddddddddddddddddddddddd',
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
  ...overrides,
});

// Fake of the real executor's entry-zone gate: same error, thrown before anything is journaled.
const zoneGatedExecutor = ({ journal, seen }) => async ({ technicalSignal, brokerState }) => {
  seen.push(technicalSignal);
  const price = technicalSignal.direction === 'BUY' ? brokerState.ask : brokerState.bid;
  const [lower, upper] = technicalSignal.entry_zone;
  if (price < lower || price > upper) throw new Error(OUTSIDE);
  journal.push({ proposal_id: technicalSignal.id, state: 'FILLED' });
  return { state: 'FILLED' };
};

const quotes = {
  IN_ZONE: { bid: 2521.9, ask: 2522.1 },
  BUY_OUT: { bid: 2529.9, ask: 2530.1 },
  SELL_OUT: { bid: 2529.9, ask: 2530.1 },
};

// M5 payload whose last CLOSED bar opens at `closedIso`; the final bar is the forming one.
const m5Payload = (closedIso, patches) => {
  const closedMs = Date.parse(closedIso);
  return {
    symbol: 'XAUUSD',
    timeframe: 'M5',
    as_of: new Date(closedMs + M5).toISOString(),
    source: 'MT5',
    bars: Array.from({ length: 31 }, (_, index) => {
      const time = new Date(closedMs - (29 - index) * M5).toISOString();
      return { time, open: 2521, high: 2523, low: 2519, close: 2522, volume: 1, ...patches[time] };
    }),
  };
};

const waitingHarness = ({ direction = 'BUY', currentMode = demoAuto(), wall = { value: '2099-01-01T00:00:00.000Z' } } = {}) => {
  const journal = [];
  const seen = [];
  const control = { rejectRisk: false, closed: at('02:20'), patches: {}, quote: quotes.IN_ZONE };
  let riskCalls = 0;
  let telemetryCalls = 0;

  const base = make({
    currentMode,
    configured: riskConfig,
    entries: journal,
    now: () => wall.value,
    execute: zoneGatedExecutor({ journal, seen }),
    evaluateRisk: ({ technicalSignal }) => {
      riskCalls += 1;
      return control.rejectRisk
        ? decision(technicalSignal, currentMode, { decision: 'REJECT', approved_volume: null, approved_risk_fraction: null, reason_codes: ['spread_too_wide'] })
        : decision(technicalSignal, currentMode);
    },
  });
  const { coordinator } = base;
  coordinator.marketAdapter = {
    getBars: async ({ timeframe }) => (timeframe === 'M5' ? m5Payload(control.closed, control.patches) : bars(timeframe)),
  };
  coordinator.riskAdapter = {
    getRiskState: async (args) => {
      telemetryCalls += 1;
      const state = await riskAdapter.getRiskState(args);
      return { ...state, broker: { ...state.broker, ...control.quote } };
    },
  };

  // Real engines stamp as_of with the last closed M5 bar time, so a READY setup's as_of moves every cycle.
  const readySignal = (asOf, extra = {}) => ({ ...engine({ state: 'READY', direction }), as_of: asOf, ...extra });

  const cycle = async ({ closed, quote, engineOutput, harmonic, rejectRisk } = {}) => {
    if (closed) control.closed = closed;
    if (quote) control.quote = quote;
    if (rejectRisk !== undefined) control.rejectRisk = rejectRisk;
    const emitted = engineOutput ?? readySignal(control.closed);
    coordinator.analyzeSmc = () => emitted;
    if (harmonic) coordinator.analyzeHarmonic = () => harmonic;
    return coordinator.check({ force: true });
  };

  return {
    ...base,
    journal,
    seen,
    control,
    cycle,
    readySignal,
    currentMode,
    wall,
    riskCalls: () => riskCalls,
    telemetryCalls: () => telemetryCalls,
    outQuote: direction === 'BUY' ? quotes.BUY_OUT : quotes.SELL_OUT,
  };
};

const waitingOf = (state) => state.waiting_for_entry;

test('Live V2 W1 READY outside the entry zone waits without latching the circuit breaker', async () => {
  const h = waitingHarness();
  const state = await h.cycle({ quote: h.outQuote });
  assert.equal(state.state, 'waiting_for_entry');
  assert.equal(state.execution_blocked_reason, 'waiting_for_entry');
  assert.equal(state.circuit_breaker_active, false);
  assert.equal(h.executions(), 1);
  assert.equal(waitingOf(state).length, 1);
  const [entry] = waitingOf(state);
  assert.deepEqual(entry.entry_zone, [2520, 2524]);
  assert.equal(entry.invalidation, 2510);
  assert.deepEqual(entry.targets, [2540]);
  assert.equal(entry.first_ready_at, at('02:20'));
  assert.equal(entry.expires_at, at('02:50'));
  assert.equal(entry.registered_at, at('02:25')); // market time, not the wall clock
});

test('Live V2 W2 re-entry fetches fresh telemetry, re-runs Risk with the ORIGINAL signal and executes once', async () => {
  const h = waitingHarness();
  await h.cycle({ quote: h.outQuote });
  const telemetryBefore = h.telemetryCalls();
  const riskBefore = h.riskCalls();

  // Same setup id, later as_of and a much wider zone: must not replace the original.
  const state = await h.cycle({
    closed: at('02:25'),
    quote: quotes.IN_ZONE,
    engineOutput: h.readySignal(at('02:25'), { entry_zone: [2500, 2560] }),
  });

  assert.equal(state.state, 'executed');
  assert.equal(h.telemetryCalls(), telemetryBefore + 1);
  assert.equal(h.riskCalls(), riskBefore + 1);
  assert.equal(h.executions(), 2);
  assert.equal(h.journal.length, 1);
  const submitted = h.seen.at(-1);
  assert.deepEqual(submitted.entry_zone, [2520, 2524]);
  assert.equal(submitted.invalidation, 2510);
  assert.equal(submitted.as_of, at('02:20'));
  assert.equal(submitted.expires_at, at('02:50'));
  assert.equal(waitingOf(state).length, 0);
});

test('Live V2 W3 refreshed engine expiry never extends the FIRST-READY lifetime', async () => {
  const h = waitingHarness();

  // T0: READY is seen but Risk rejects it, so nothing is registered yet.
  let state = await h.cycle({ closed: at('02:20'), quote: h.outQuote, rejectRisk: true });
  assert.equal(state.state, 'risk_rejected');
  assert.equal(waitingOf(state).length, 0);

  // Later the engine re-emits the SAME id with a later as_of (02:30 -> refreshed expiry 03:00).
  // Waiting registration happens now, but it must carry the FIRST-READY anchor.
  state = await h.cycle({ closed: at('02:30'), quote: h.outQuote, rejectRisk: false });
  assert.equal(state.state, 'waiting_for_entry');
  assert.equal(waitingOf(state)[0].first_ready_at, at('02:20'));
  assert.equal(waitingOf(state)[0].expires_at, at('02:50'));

  state = await h.cycle({ closed: at('02:40'), quote: h.outQuote });
  assert.equal(waitingOf(state).length, 1); // 02:45 market time: still inside the original TTL
  const attemptsBeforeExpiry = h.executions();

  // 02:45 closed bar => market time 02:50 = original expiry; refreshed expiry would be 03:15.
  state = await h.cycle({ closed: at('02:45'), quote: quotes.IN_ZONE });
  assert.equal(state.execution_blocked_reason, 'waiting_entry_cancelled');
  assert.equal(waitingOf(state).length, 0);
  assert.equal(h.executions(), attemptsBeforeExpiry);
  assert.equal(h.journal.length, 0);

  // Still READY and in zone, but the expired setup must not be given a fresh window.
  state = await h.cycle({ closed: at('02:50'), quote: quotes.IN_ZONE });
  assert.equal(state.execution_blocked_reason, 'waiting_entry_cancelled');
  assert.equal(h.executions(), attemptsBeforeExpiry);
  assert.equal(h.journal.length, 0);
});

test('Live V2 W3b expiry is decided in market time; the wall clock cannot extend or shorten it', async () => {
  // Wall clock far in the PAST: the machine clock would say "not expired" forever.
  const past = waitingHarness({ wall: { value: '1999-01-01T00:00:00.000Z' } });
  await past.cycle({ quote: past.outQuote });
  const cancelled = await past.cycle({ closed: at('02:45'), quote: quotes.IN_ZONE });
  assert.equal(cancelled.execution_blocked_reason, 'waiting_entry_cancelled');
  assert.equal(past.journal.length, 0);

  // Wall clock far in the FUTURE: a wall-clock check would cancel instantly; market time must not.
  const future = waitingHarness({ wall: { value: '2099-01-01T00:00:00.000Z' } });
  await future.cycle({ quote: future.outQuote });
  const still = await future.cycle({ closed: at('02:25'), quote: future.outQuote });
  assert.equal(waitingOf(still).length, 1);
  const executed = await future.cycle({ closed: at('02:30'), quote: quotes.IN_ZONE });
  assert.equal(executed.state, 'executed');
  assert.equal(future.journal.length, 1);
});

test('Live V2 W4 BUY invalidation reached while waiting cancels the setup and never executes', async () => {
  const h = waitingHarness();
  await h.cycle({ quote: h.outQuote });
  h.control.patches[at('02:25')] = { low: 2509 }; // BUY invalidation is 2510
  const state = await h.cycle({ closed: at('02:25'), quote: quotes.IN_ZONE });
  assert.equal(waitingOf(state).length, 0);
  assert.equal(state.execution_blocked_reason, 'waiting_entry_cancelled');
  assert.equal(h.executions(), 1);
  assert.equal(h.journal.length, 0);
});

test('Live V2 W4b a closed bar that stays above BUY invalidation keeps the setup waiting', async () => {
  const h = waitingHarness();
  await h.cycle({ quote: h.outQuote });
  h.control.patches[at('02:25')] = { low: 2511 };
  const state = await h.cycle({ closed: at('02:25'), quote: h.outQuote });
  assert.equal(state.state, 'waiting_for_entry');
  assert.equal(waitingOf(state).length, 1);
});

test('Live V2 W4c invalidation between first READY and waiting registration prevents registration and execution', async () => {
  const h = waitingHarness();
  // First READY: Risk rejects, so the executor is never reached and nothing is registered.
  let state = await h.cycle({ closed: at('02:20'), quote: h.outQuote, rejectRisk: true });
  assert.equal(state.state, 'risk_rejected');
  assert.equal(h.executions(), 0);

  // A confirmed bar reaches the original invalidation; the executor WOULD now report outside-zone.
  h.control.patches[at('02:25')] = { low: 2509 };
  state = await h.cycle({ closed: at('02:25'), quote: h.outQuote, rejectRisk: false });
  assert.equal(state.execution_blocked_reason, 'waiting_entry_cancelled');
  assert.equal(waitingOf(state).length, 0);
  assert.equal(h.executions(), 0);

  // Even back in zone the invalidated setup is never executed while it stays READY.
  state = await h.cycle({ closed: at('02:30'), quote: quotes.IN_ZONE });
  assert.equal(h.executions(), 0);
  assert.equal(h.journal.length, 0);
  assert.equal(waitingOf(state).length, 0);
});

test('Live V2 W4d SELL invalidation uses high >= invalidation and ignores lows', async () => {
  const h = waitingHarness({ direction: 'SELL' }); // SELL: invalidation 2535, target 2500
  let state = await h.cycle({ quote: h.outQuote });
  assert.equal(state.state, 'waiting_for_entry');

  // A deep low would kill a BUY but is irrelevant to a SELL; high 2534.9 is still below the stop.
  h.control.patches[at('02:25')] = { low: 2500, high: 2534.9 };
  state = await h.cycle({ closed: at('02:25'), quote: h.outQuote });
  assert.equal(waitingOf(state).length, 1);

  h.control.patches[at('02:30')] = { high: 2535 }; // touches the SELL invalidation
  state = await h.cycle({ closed: at('02:30'), quote: quotes.IN_ZONE });
  assert.equal(waitingOf(state).length, 0);
  assert.equal(state.execution_blocked_reason, 'waiting_entry_cancelled');
  assert.equal(h.journal.length, 0);
});

test('Live V2 W5 a setup that stops being READY is cleared and a later READY starts a NEW first-READY record', async () => {
  const h = waitingHarness();
  let state = await h.cycle({ quote: h.outQuote });
  assert.equal(waitingOf(state)[0].first_ready_at, at('02:20'));

  state = await h.cycle({ closed: at('02:25'), engineOutput: engine({ state: 'PRE_SIGNAL' }) });
  assert.equal(waitingOf(state).length, 0);
  assert.equal(h.coordinator.firstReady.size, 0);

  state = await h.cycle({ closed: at('02:30'), quote: h.outQuote });
  assert.equal(waitingOf(state)[0].first_ready_at, at('02:30'));
  assert.equal(waitingOf(state)[0].expires_at, at('03:00'));

  const invalid = { ...engine({ state: 'INVALID' }), direction: null, entry_zone: null, invalidation: null, targets: [], reason_codes: ['idm_structure_invalidated'] };
  state = await h.cycle({ closed: at('02:35'), engineOutput: invalid });
  assert.equal(waitingOf(state).length, 0);
  assert.equal(h.coordinator.firstReady.size, 0);
  assert.equal(h.journal.length, 0);
});

test('Live V2 W6 session change or leaving DEMO_AUTO drops the record; a still-READY setup starts a fresh episode', async () => {
  const session = waitingHarness();
  await session.cycle({ quote: session.outQuote });
  session.currentMode.demo_session_id = OTHER_SESSION;
  let state = await session.cycle({ closed: at('02:30') });
  assert.equal(waitingOf(state).length, 1);
  assert.equal(waitingOf(state)[0].first_ready_at, at('02:30')); // not carried over from the old session
  assert.equal(state.circuit_breaker_active, false);

  const leave = waitingHarness();
  await leave.cycle({ quote: leave.outQuote });
  Object.assign(leave.currentMode, { mode: 'MONITOR', demo_auto_enabled: false, trade_execution_enabled: false });
  state = await leave.cycle({ closed: at('02:25') });
  assert.equal(waitingOf(state).length, 0);
  assert.equal(leave.coordinator.firstReady.size, 0);
  assert.equal(leave.executions(), 1);
  Object.assign(leave.currentMode, { mode: 'DEMO_AUTO', demo_auto_enabled: true, trade_execution_enabled: true });
  state = await leave.cycle({ closed: at('02:35') });
  assert.equal(waitingOf(state)[0].first_ready_at, at('02:35'));

  const off = waitingHarness();
  await off.cycle({ quote: off.outQuote });
  off.currentMode.automatic_analysis_enabled = false;
  state = await off.cycle({ closed: at('02:25') });
  assert.equal(waitingOf(state).length, 0);
  assert.equal(off.coordinator.firstReady.size, 0);
});

test('Live V2 W7 Risk REJECT on re-entry blocks execution but keeps the setup waiting', async () => {
  const h = waitingHarness();
  await h.cycle({ quote: h.outQuote });
  const state = await h.cycle({ closed: at('02:25'), quote: quotes.IN_ZONE, rejectRisk: true });
  assert.equal(state.state, 'risk_rejected');
  assert.equal(state.risk.decision, 'REJECT');
  assert.equal(h.executions(), 1);
  assert.equal(waitingOf(state).length, 1);
  assert.equal(state.circuit_breaker_active, false);
});

test('Live V2 W8 successful execution clears the record and never submits the same setup twice', async () => {
  const h = waitingHarness();
  await h.cycle({ quote: h.outQuote });
  let state = await h.cycle({ closed: at('02:25'), quote: quotes.IN_ZONE });
  assert.equal(state.state, 'executed');
  assert.equal(waitingOf(state).length, 0);
  assert.equal(h.coordinator.firstReady.size, 0);
  const attempts = h.executions();

  for (const closed of [at('02:30'), at('02:35'), at('02:40')]) {
    state = await h.cycle({ closed });
    assert.equal(state.execution_blocked_reason, 'setup_already_submitted');
  }
  assert.equal(h.executions(), attempts);
  assert.equal(h.journal.length, 1);
  assert.equal(h.coordinator.firstReady.size, 0);
});

test('Live V2 W9 a proposal journaled while waiting is dropped and never resubmitted', async () => {
  const h = waitingHarness();
  const first = await h.cycle({ quote: h.outQuote });
  h.journal.push({ proposal_id: waitingOf(first)[0].signal_id, state: 'FILLED' });
  const state = await h.cycle({ closed: at('02:25'), quote: quotes.IN_ZONE });
  assert.equal(waitingOf(state).length, 0);
  assert.equal(state.execution_blocked_reason, 'setup_already_submitted');
  assert.equal(h.executions(), 1);
});

test('Live V2 W10 every other executor error still latches the circuit breaker', async () => {
  for (const message of ['receipt_timeout', 'demo_executor_signal_stale', `${OUTSIDE}_variant`, 'demo_executor_kill_switch_active']) {
    const h = waitingHarness();
    h.coordinator.executor = { execute: async () => { throw new Error(message); } };
    const state = await h.cycle({ quote: quotes.IN_ZONE });
    assert.equal(state.execution_blocked_reason, 'execution_uncertain_circuit_breaker', message);
    assert.equal(state.circuit_breaker_active, true, message);
    assert.equal(waitingOf(state).length, 0, message);
  }

  const waiting = waitingHarness();
  await waiting.cycle({ quote: waiting.outQuote });
  waiting.coordinator.executor = { execute: async () => { throw new Error('receipt_timeout'); } };
  const state = await waiting.cycle({ closed: at('02:25'), quote: quotes.IN_ZONE });
  assert.equal(state.circuit_breaker_active, true);
});

test('Live V2 W11 tracking is in memory only: stop() and a new coordinator start empty', async () => {
  const h = waitingHarness();
  await h.cycle({ quote: h.outQuote });
  assert.equal(h.coordinator.firstReady.size, 1);
  h.coordinator.stop();
  assert.equal(h.coordinator.firstReady.size, 0);
  assert.equal(h.coordinator.getState().waiting_for_entry.length, 0);
  assert.equal(waitingHarness().coordinator.firstReady.size, 0);
});

test('Live V2 W12 the first READY anchor survives a multiple-READY block', async () => {
  const h = waitingHarness();
  const otherReady = engine({ strategy: 'HARMONIC_PRZ', state: 'READY' });
  let state = await h.cycle({ quote: h.outQuote, harmonic: { ...otherReady, as_of: at('02:20') } });
  assert.equal(state.execution_blocked_reason, 'multiple_ready_setups');
  assert.equal(h.executions(), 0);

  const invalidHarmonic = { ...otherReady, state: 'INVALID', direction: null, entry_zone: null, invalidation: null, targets: [], reason_codes: ['pattern_not_found'] };
  state = await h.cycle({ closed: at('02:30'), quote: h.outQuote, harmonic: invalidHarmonic });
  assert.equal(state.state, 'waiting_for_entry');
  assert.equal(waitingOf(state)[0].first_ready_at, at('02:20'));
  assert.equal(waitingOf(state)[0].expires_at, at('02:50'));
});

test('Live V2 W13 a READY setup is tracked once and its record is bounded to the current READY ids', async () => {
  const h = waitingHarness();
  for (const closed of [at('02:20'), at('02:25'), at('02:30'), at('02:35')]) {
    await h.cycle({ closed, quote: h.outQuote });
    assert.equal(h.coordinator.firstReady.size, 1);
    assert.equal(h.coordinator.waitingCancelled.size, 0);
  }
  await h.cycle({ closed: at('02:45'), engineOutput: engine({ state: 'PRE_SIGNAL' }) });
  assert.equal(h.coordinator.firstReady.size, 0);
  assert.equal(h.coordinator.waitingCancelled.size, 0);
});
