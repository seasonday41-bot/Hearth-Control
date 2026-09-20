import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TECHNICAL_SIGNAL_VERSION,
  TECHNICAL_SIGNAL_TTL_MS,
  TechnicalSignalBook,
  deriveTechnicalSignalId,
  expireTechnicalSignal,
  isTechnicalSignalExpired,
  normalizeEngineTechnicalSignal,
  parseTechnicalSignal,
} from '../mcp/market/technical-signal.mjs';

const iso = '2026-09-21T01:00:00.000Z';
const later = '2026-09-21T01:05:00.000Z';

const swing = (time, type, price, index = 1) => ({
  version: 'three-bar-swing-v1',
  type,
  index,
  time,
  price,
  confirmed_index: index + 1,
  confirmed_at: new Date(Date.parse(time) + 60_000).toISOString(),
});

const smcResult = ({ state = 'PRE_SIGNAL', asOf = iso, trigger = null } = {}) => ({
  version: 'smc-idm-engine-v1',
  strategy: 'SMC_IDM',
  symbol: 'XAUUSD',
  direction: 'BUY',
  state,
  context_timeframe: 'H1',
  setup_timeframe: 'M15',
  trigger_timeframe: 'M5',
  entry_zone: state === 'INVALID' ? null : [2300, 2302],
  invalidation: state === 'INVALID' ? null : 2294,
  targets: state === 'INVALID' ? [] : [2315],
  evidence: {
    context: { bias: 'bullish' },
    bos: {
      direction: 'BUY',
      reference: swing('2026-09-21T00:15:00.000Z', 'HIGH', 2310, 5),
      break_time: '2026-09-21T00:45:00.000Z',
      confirmation: 'close',
    },
    idm: swing('2026-09-21T00:30:00.000Z', 'LOW', 2298, 7),
    zone: { kind: 'OB_FVG', lower: 2300, upper: 2302 },
    trigger,
  },
  reason_codes: state === 'PRE_SIGNAL' ? ['waiting_for_m5_micro_bos'] : [],
  as_of: asOf,
});

const harmonicResult = ({ state = 'PRE_SIGNAL', asOf = iso, withD = false, trigger = null } = {}) => ({
  version: 'harmonic-prz-engine-v1',
  strategy: 'HARMONIC_PRZ',
  symbol: 'XAUUSD',
  direction: 'BUY',
  state,
  pattern: 'GARTLEY',
  context_timeframe: 'H1',
  setup_timeframe: 'M15',
  trigger_timeframe: 'M5',
  prz: [2300, 2303],
  entry_zone: state === 'INVALID' ? null : [2300, 2303],
  invalidation: state === 'INVALID' ? null : 2288,
  targets: state === 'INVALID' ? [] : [2312, 2320],
  evidence: {
    context: { bias: 'neutral' },
    points: {
      X: swing('2026-09-20T22:00:00.000Z', 'LOW', 2290, 1),
      A: swing('2026-09-20T22:30:00.000Z', 'HIGH', 2340, 3),
      B: swing('2026-09-20T23:00:00.000Z', 'LOW', 2310, 5),
      C: swing('2026-09-20T23:30:00.000Z', 'HIGH', 2330, 7),
      D: withD ? swing('2026-09-21T00:30:00.000Z', 'LOW', 2301, 9) : null,
    },
    ratios: { ratios: { ab_xa: 0.6, bc_ab: 0.666 } },
    prz: { lower: 2300, upper: 2303 },
    trigger,
  },
  reason_codes: state === 'PRE_SIGNAL'
    ? [withD ? 'waiting_for_m5_micro_bos' : 'waiting_for_d_confirmation']
    : [],
  as_of: asOf,
});

test('Technical Signal V2.1 normalizes SMC and Harmonic into one strict contract', () => {
  const smc = normalizeEngineTechnicalSignal(smcResult());
  const harmonic = normalizeEngineTechnicalSignal(harmonicResult());

  for (const signal of [smc, harmonic]) {
    assert.equal(signal.version, TECHNICAL_SIGNAL_VERSION);
    assert.equal(signal.symbol, 'XAUUSD');
    assert.equal(signal.context_timeframe, 'H1');
    assert.equal(signal.setup_timeframe, 'M15');
    assert.equal(signal.trigger_timeframe, 'M5');
    assert.match(signal.id, /^techsig:v1:[a-f0-9]{24}$/);
    assert.ok(signal.expires_at);
  }
  assert.notEqual(smc.id, harmonic.id);
});

test('Technical Signal V2.2 SMC setup id stays stable from PRE_SIGNAL to READY', () => {
  const pre = normalizeEngineTechnicalSignal(smcResult());
  const ready = normalizeEngineTechnicalSignal(smcResult({
    state: 'READY',
    asOf: later,
    trigger: { break_time: later, confirmation: 'close' },
  }));

  assert.equal(pre.id, ready.id);
  assert.equal(pre.state, 'PRE_SIGNAL');
  assert.equal(ready.state, 'READY');
  assert.equal(
    Date.parse(pre.expires_at) - Date.parse(pre.as_of),
    TECHNICAL_SIGNAL_TTL_MS.PRE_SIGNAL,
  );
  assert.equal(
    Date.parse(ready.expires_at) - Date.parse(ready.as_of),
    TECHNICAL_SIGNAL_TTL_MS.READY,
  );
});

test('Technical Signal V2.3 Harmonic id ignores D/trigger so one candidate keeps identity as it matures', () => {
  const projected = normalizeEngineTechnicalSignal(harmonicResult());
  const ready = normalizeEngineTechnicalSignal(harmonicResult({
    state: 'READY',
    asOf: later,
    withD: true,
    trigger: { break_time: later, confirmation: 'close' },
  }));

  assert.equal(projected.id, ready.id);
  assert.equal(deriveTechnicalSignalId(harmonicResult()), deriveTechnicalSignalId(harmonicResult({ withD: true })));
});

test('Technical Signal V2.4 changing a structural setup anchor creates a different id', () => {
  const first = smcResult();
  const second = smcResult();
  second.evidence.idm = swing('2026-09-21T00:35:00.000Z', 'LOW', 2297, 8);

  assert.notEqual(deriveTechnicalSignalId(first), deriveTechnicalSignalId(second));
});

test('Technical Signal V2.5 book deduplicates exact repeats and upgrades PRE_SIGNAL to READY', () => {
  const book = new TechnicalSignalBook();
  const pre = normalizeEngineTechnicalSignal(smcResult());
  const ready = normalizeEngineTechnicalSignal(smcResult({
    state: 'READY',
    asOf: later,
    trigger: { break_time: later, confirmation: 'close' },
  }));

  const first = book.upsert(pre, { now: pre.as_of });
  const duplicate = book.upsert(pre, { now: pre.as_of });
  const update = book.upsert(ready, { now: ready.as_of });

  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.updated, false);
  assert.equal(update.created, false);
  assert.equal(update.updated, true);
  assert.equal(book.list().length, 1);
  assert.equal(book.get(pre.id).state, 'READY');
});

test('Technical Signal V2.6 READY cannot regress to PRE_SIGNAL and INVALID is terminal', () => {
  const book = new TechnicalSignalBook();
  const ready = normalizeEngineTechnicalSignal(smcResult({
    state: 'READY',
    asOf: later,
    trigger: { break_time: later, confirmation: 'close' },
  }));
  const preNewer = normalizeEngineTechnicalSignal(smcResult({
    state: 'PRE_SIGNAL',
    asOf: '2026-09-21T01:10:00.000Z',
  }));

  book.upsert(ready, { now: ready.as_of });
  assert.throws(() => book.upsert(preNewer, { now: preNewer.as_of }), /technical_signal_state_regression/);

  const invalid = parseTechnicalSignal({
    ...ready,
    state: 'INVALID',
    entry_zone: null,
    invalidation: null,
    targets: [],
    expires_at: null,
    reason_codes: ['structure_invalidated'],
    as_of: '2026-09-21T01:11:00.000Z',
  });
  book.upsert(invalid, { now: invalid.as_of });
  assert.equal(book.get(ready.id).state, 'INVALID');

  const changedInvalid = parseTechnicalSignal({
    ...invalid,
    reason_codes: ['different_terminal_reason'],
    as_of: '2026-09-21T01:12:00.000Z',
  });
  assert.throws(() => book.upsert(changedInvalid, { now: changedInvalid.as_of }), /technical_signal_terminal/);
});

test('Technical Signal V2.7 expiry deterministically invalidates PRE_SIGNAL and READY', () => {
  const pre = normalizeEngineTechnicalSignal(smcResult());
  const before = new Date(Date.parse(pre.expires_at) - 1).toISOString();
  const atExpiry = pre.expires_at;

  assert.equal(isTechnicalSignalExpired(pre, before), false);
  assert.equal(isTechnicalSignalExpired(pre, atExpiry), true);

  const expired = expireTechnicalSignal(pre, atExpiry);
  assert.equal(expired.state, 'INVALID');
  assert.equal(expired.expires_at, null);
  assert.ok(expired.reason_codes.includes('signal_expired'));

  const book = new TechnicalSignalBook();
  const harmonic = normalizeEngineTechnicalSignal(harmonicResult());
  book.upsert(harmonic, { now: harmonic.as_of });
  const expiredItems = book.expire(harmonic.expires_at);
  assert.equal(expiredItems.length, 1);
  assert.equal(book.get(harmonic.id).state, 'INVALID');
});

test('Technical Signal V2.8 stale updates fail closed', () => {
  const book = new TechnicalSignalBook();
  const latest = normalizeEngineTechnicalSignal(smcResult({
    asOf: '2026-09-21T01:10:00.000Z',
  }));
  const stale = normalizeEngineTechnicalSignal(smcResult({
    asOf: '2026-09-21T01:05:00.000Z',
  }));

  book.upsert(latest, { now: latest.as_of });
  assert.throws(() => book.upsert(stale, { now: stale.as_of }), /technical_signal_stale_update/);
});

test('Technical Signal V2.9 contract rejects unknown fields and risk/execution contamination', () => {
  const signal = normalizeEngineTechnicalSignal(smcResult());

  assert.throws(
    () => parseTechnicalSignal({ ...signal, surprise: true }),
    /technical_signal_unknown_field:surprise/,
  );

  assert.throws(
    () => parseTechnicalSignal({
      ...signal,
      evidence: { ...signal.evidence, approved_volume: 0.1 },
    }),
    /technical_signal_forbidden_field:approved_volume/,
  );
});

test('Technical Signal V2.10 an invalid engine result without a real setup identity is not normalized', () => {
  const noSetup = smcResult({ state: 'INVALID' });
  noSetup.direction = null;
  noSetup.evidence = { context: { bias: 'neutral' } };
  noSetup.reason_codes = ['context_not_directional'];

  assert.throws(
    () => normalizeEngineTechnicalSignal(noSetup),
    /technical_signal_direction_invalid/,
  );
});
