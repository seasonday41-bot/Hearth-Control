import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_OUTCOME_HORIZON_MS,
  TECHNICAL_OUTCOME_VERSION,
  TechnicalOutcomeBook,
  evaluateTechnicalSignalOutcome,
  summarizeTechnicalOutcomes,
} from '../mcp/market/outcome-tracker.mjs';
import { parseTechnicalSignal } from '../mcp/market/technical-signal.mjs';

const signal = ({
  id = 'techsig:v1:aaaaaaaaaaaaaaaaaaaaaaaa',
  strategy = 'SMC_IDM',
  direction = 'BUY',
  asOf = '2026-09-21T01:00:00.000Z',
  expiresAt = '2026-09-21T01:30:00.000Z',
  entryZone = [100, 102],
  invalidation = 96,
  targets = [111],
} = {}) => parseTechnicalSignal({
  version: 'technical-signal-v1',
  id,
  strategy,
  symbol: 'XAUUSD',
  direction,
  state: 'READY',
  context_timeframe: 'H1',
  setup_timeframe: 'M15',
  trigger_timeframe: 'M5',
  entry_zone: entryZone,
  invalidation,
  targets,
  evidence: { test: true },
  reason_codes: [],
  as_of: asOf,
  expires_at: expiresAt,
});

const bar = (time, open, high, low, close) => ({ time, open, high, low, close });

test('Outcome V2.1 BUY resolves WIN from TP1 with deterministic R, MAE and MFE', () => {
  const result = evaluateTechnicalSignalOutcome(signal(), [
    bar('2026-09-21T01:05:00.000Z', 103, 104, 100.5, 101.5),
    bar('2026-09-21T01:10:00.000Z', 102, 108, 99, 107),
    bar('2026-09-21T01:15:00.000Z', 107, 112, 106, 111.5),
  ]);

  assert.equal(result.version, TECHNICAL_OUTCOME_VERSION);
  assert.equal(result.status, 'RESOLVED');
  assert.equal(result.outcome, 'WIN');
  assert.equal(result.entry_price, 101);
  assert.equal(result.entry_at, '2026-09-21T01:05:00.000Z');
  assert.equal(result.realized_r, 2);
  assert.equal(result.mae_r, 0.4);
  assert.equal(result.mfe_r, 2.2);
  assert.equal(result.reason_code, 'target_reached');
});

test('Outcome V2.2 SELL resolves LOSS at invalidation as -1R', () => {
  const sell = signal({
    id: 'techsig:v1:bbbbbbbbbbbbbbbbbbbbbbbb',
    strategy: 'HARMONIC_PRZ',
    direction: 'SELL',
    entryZone: [108, 110],
    invalidation: 114,
    targets: [99],
  });

  const result = evaluateTechnicalSignalOutcome(sell, [
    bar('2026-09-21T01:05:00.000Z', 111, 112, 108.5, 109),
    bar('2026-09-21T01:10:00.000Z', 109, 114.5, 107, 113),
  ]);

  assert.equal(result.outcome, 'LOSS');
  assert.equal(result.realized_r, -1);
  assert.equal(result.reason_code, 'invalidation_reached');
  assert.equal(result.mae_r, 1.1);
  assert.equal(result.mfe_r, 0.4);
});

test('Outcome V2.3 does not use the signal bar for a retroactive fill', () => {
  const result = evaluateTechnicalSignalOutcome(signal(), [
    bar('2026-09-21T01:00:00.000Z', 101, 112, 95, 110),
    bar('2026-09-21T01:05:00.000Z', 105, 106, 104, 105),
    bar('2026-09-21T01:30:00.000Z', 105, 106, 104, 105),
  ]);

  assert.equal(result.status, 'RESOLVED');
  assert.equal(result.outcome, 'NEUTRAL');
  assert.equal(result.entry_at, null);
  assert.equal(result.reason_code, 'entry_not_reached_before_signal_expiry');
});

test('Outcome V2.4 entry and exit on the same bar resolves NEUTRAL because OHLC order is unknowable', () => {
  const result = evaluateTechnicalSignalOutcome(signal(), [
    bar('2026-09-21T01:05:00.000Z', 103, 112, 95, 101),
  ]);

  assert.equal(result.outcome, 'NEUTRAL');
  assert.equal(result.reason_code, 'entry_exit_same_bar_ambiguous');
  assert.equal(result.realized_r, 0);
});

test('Outcome V2.5 stop and target on the same later bar resolves NEUTRAL', () => {
  const result = evaluateTechnicalSignalOutcome(signal(), [
    bar('2026-09-21T01:05:00.000Z', 102, 103, 100.5, 101.5),
    bar('2026-09-21T01:10:00.000Z', 102, 112, 95, 105),
  ]);

  assert.equal(result.outcome, 'NEUTRAL');
  assert.equal(result.reason_code, 'stop_target_same_bar_ambiguous');
});

test('Outcome V2.6 remains TRACKING until enough bars cover entry expiry or post-entry horizon', () => {
  const noEntryYet = evaluateTechnicalSignalOutcome(signal(), [
    bar('2026-09-21T01:05:00.000Z', 105, 106, 104, 105),
  ]);
  assert.equal(noEntryYet.status, 'TRACKING');
  assert.equal(noEntryYet.outcome, null);

  const entered = evaluateTechnicalSignalOutcome(signal(), [
    bar('2026-09-21T01:05:00.000Z', 102, 103, 100.5, 101.5),
    bar('2026-09-21T01:10:00.000Z', 102, 105, 100, 104),
  ]);
  assert.equal(entered.status, 'TRACKING');
  assert.equal(entered.entry_at, '2026-09-21T01:05:00.000Z');
  assert.ok(entered.mfe_r > 0);
});

test('Outcome V2.7 entry never reached by signal expiry resolves NEUTRAL', () => {
  const result = evaluateTechnicalSignalOutcome(signal(), [
    bar('2026-09-21T01:05:00.000Z', 105, 106, 104, 105),
    bar('2026-09-21T01:30:00.000Z', 105, 106, 104, 105),
  ]);

  assert.equal(result.outcome, 'NEUTRAL');
  assert.equal(result.reason_code, 'entry_not_reached_before_signal_expiry');
});

test('Outcome V2.8 a filled trade with no TP/SL by horizon resolves NEUTRAL', () => {
  const shortHorizon = 10 * 60 * 1000;
  const result = evaluateTechnicalSignalOutcome(signal(), [
    bar('2026-09-21T01:05:00.000Z', 102, 103, 100.5, 101.5),
    bar('2026-09-21T01:10:00.000Z', 102, 105, 100, 104),
    bar('2026-09-21T01:15:00.000Z', 104, 106, 102, 105),
  ], { outcomeHorizonMs: shortHorizon });

  assert.equal(result.outcome, 'NEUTRAL');
  assert.equal(result.reason_code, 'outcome_horizon_expired');
  assert.equal(result.realized_r, 0);
});

test('Outcome V2.9 book is idempotent, updates TRACKING, and treats RESOLVED as terminal', () => {
  const ready = signal();
  const tracking = evaluateTechnicalSignalOutcome(ready, [
    bar('2026-09-21T01:05:00.000Z', 102, 103, 100.5, 101.5),
    bar('2026-09-21T01:10:00.000Z', 102, 105, 100, 104),
  ]);
  const resolved = evaluateTechnicalSignalOutcome(ready, [
    bar('2026-09-21T01:05:00.000Z', 102, 103, 100.5, 101.5),
    bar('2026-09-21T01:10:00.000Z', 102, 108, 99, 107),
    bar('2026-09-21T01:15:00.000Z', 107, 112, 106, 111.5),
  ]);

  const book = new TechnicalOutcomeBook();
  assert.equal(book.upsert(tracking).created, true);
  assert.equal(book.upsert(tracking).updated, false);
  assert.equal(book.upsert(resolved).updated, true);
  assert.equal(book.get(ready.id).outcome, 'WIN');

  assert.throws(() => book.upsert({ ...resolved, observed_at: '2026-09-21T01:20:00.000Z' }), /technical_outcome_terminal/);
});

test('Outcome V2.10 summary separates strategies and computes win rate, R profit factor, and drawdown', () => {
  const makeResolved = ({ suffix, strategy, outcome, r, resolvedAt, mae = 0.5, mfe = 1 }) => ({
    version: TECHNICAL_OUTCOME_VERSION,
    id: `techout:v1:${suffix.repeat(24)}`,
    signal_id: `techsig:v1:${suffix.repeat(24)}`,
    strategy,
    symbol: 'XAUUSD',
    direction: 'BUY',
    signal_as_of: '2026-09-21T01:00:00.000Z',
    observed_at: resolvedAt,
    status: 'RESOLVED',
    outcome,
    reason_code: outcome === 'WIN' ? 'target_reached' : outcome === 'LOSS' ? 'invalidation_reached' : 'outcome_horizon_expired',
    entry_model: 'zone_midpoint_after_signal',
    entry_price: 100,
    entry_at: '2026-09-21T01:05:00.000Z',
    stop_price: 95,
    target_price: 110,
    risk_distance: 5,
    realized_r: r,
    mae_r: mae,
    mfe_r: mfe,
    resolved_at: resolvedAt,
    bars_observed: 3,
  });

  const outcomes = [
    makeResolved({ suffix: 'a', strategy: 'SMC_IDM', outcome: 'WIN', r: 2, resolvedAt: '2026-09-21T02:00:00.000Z' }),
    makeResolved({ suffix: 'b', strategy: 'SMC_IDM', outcome: 'LOSS', r: -1, resolvedAt: '2026-09-21T03:00:00.000Z' }),
    makeResolved({ suffix: 'c', strategy: 'HARMONIC_PRZ', outcome: 'LOSS', r: -1, resolvedAt: '2026-09-21T04:00:00.000Z' }),
    makeResolved({ suffix: 'd', strategy: 'HARMONIC_PRZ', outcome: 'WIN', r: 1.5, resolvedAt: '2026-09-21T05:00:00.000Z' }),
    makeResolved({ suffix: 'e', strategy: 'HARMONIC_PRZ', outcome: 'NEUTRAL', r: 0, resolvedAt: '2026-09-21T06:00:00.000Z' }),
  ];

  const summary = summarizeTechnicalOutcomes(outcomes);
  assert.equal(summary.overall.wins, 2);
  assert.equal(summary.overall.losses, 2);
  assert.equal(summary.overall.neutrals, 1);
  assert.equal(summary.overall.win_rate, 0.5);
  assert.equal(summary.overall.gross_profit_r, 3.5);
  assert.equal(summary.overall.gross_loss_r, 2);
  assert.equal(summary.overall.profit_factor_r, 1.75);
  assert.equal(summary.overall.cumulative_r, 1.5);
  assert.equal(summary.overall.max_drawdown_r, 2);
  assert.equal(summary.by_strategy.SMC_IDM.win_rate, 0.5);
  assert.equal(summary.by_strategy.HARMONIC_PRZ.neutrals, 1);
});

test('Outcome V2.11 rejects PRE_SIGNAL and impossible trade geometry', () => {
  const ready = signal();
  assert.throws(
    () => evaluateTechnicalSignalOutcome({ ...ready, state: 'PRE_SIGNAL' }, []),
    /technical_outcome_ready_signal_required/,
  );

  const bad = signal({
    id: 'techsig:v1:cccccccccccccccccccccccc',
    invalidation: 105,
  });
  assert.throws(
    () => evaluateTechnicalSignalOutcome(bad, []),
    /technical_outcome_geometry_invalid/,
  );
});

test('Outcome V2.12 malformed bars fail closed and default horizon remains explicit', () => {
  assert.equal(DEFAULT_OUTCOME_HORIZON_MS, 24 * 60 * 60 * 1000);
  assert.throws(
    () => evaluateTechnicalSignalOutcome(signal(), [
      bar('2026-09-21T01:05:00.000Z', 100, 99, 101, 100),
    ]),
    /technical_outcome_range_invalid:0/,
  );
});
