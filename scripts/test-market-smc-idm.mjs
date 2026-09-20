import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSmcIdm, SMC_IDM_ENGINE_VERSION } from '../mcp/market/smc-idm-engine.mjs';

const base = Date.UTC(2026, 8, 21, 0, 0, 0);
const makeBar = (minutes, open, high, low, close) => ({
  time: new Date(base + (minutes * 60_000)).toISOString(),
  open,
  high,
  low,
  close,
  volume: 1000 + minutes,
});

const bullishContext = [
  makeBar(0, 8, 10, 6, 9),
  makeBar(60, 9, 12, 8, 10),
  makeBar(120, 8, 9, 5, 7),
  makeBar(180, 10, 13, 9, 12),
  makeBar(240, 8, 10, 6, 9),
  makeBar(300, 11, 14, 10, 13),
  makeBar(360, 10, 12, 8, 11),
];

const bearishContext = [
  makeBar(0, 12, 14, 10, 11),
  makeBar(60, 13, 15, 12, 14),
  makeBar(120, 11, 13, 9, 10),
  makeBar(180, 12, 14, 11, 13),
  makeBar(240, 10, 12, 8, 9),
  makeBar(300, 10, 11, 9, 10),
  makeBar(360, 9, 10, 7, 8),
];

const bullishSetup = [
  makeBar(0, 98, 100, 95, 99),
  makeBar(15, 100, 104, 98, 103),
  makeBar(30, 99, 101, 96, 98),
  makeBar(45, 99, 100, 97, 99),
  makeBar(60, 101, 102, 98, 99),
  makeBar(75, 102, 106, 101, 105),
  makeBar(90, 98, 102, 95, 99),
  makeBar(105, 99, 103, 98, 102),
];

const bullishTriggerReady = [
  makeBar(90, 98, 100, 96, 99),
  makeBar(95, 99, 101, 97, 100),
  makeBar(100, 100, 100.5, 98, 99),
  makeBar(105, 99, 102, 99, 101.5),
];

const bullishTriggerWaiting = [
  makeBar(90, 98, 100, 96, 99),
  makeBar(95, 99, 101, 97, 100),
  makeBar(100, 100, 100.5, 98, 99),
  makeBar(105, 99, 100.8, 98.5, 100),
];

const bearishSetup = [
  makeBar(0, 103, 105, 100, 102),
  makeBar(15, 102, 104, 98, 99),
  makeBar(30, 101, 106, 100, 105),
  makeBar(45, 102, 104, 101, 103),
  makeBar(60, 102, 105, 100, 104),
  makeBar(75, 99, 100, 94, 95),
  makeBar(90, 102, 107, 98, 101),
  makeBar(105, 101, 103, 97, 98),
];

const bearishTriggerReady = [
  makeBar(90, 102, 106, 100, 101),
  makeBar(95, 101, 104, 98, 99),
  makeBar(100, 100, 105, 99, 104),
  makeBar(105, 99, 103, 97, 97.5),
];

test('SMC V2.1 bullish setup reaches READY only after H1 context, M15 sweep/zone, and M5 micro BOS', () => {
  const result = analyzeSmcIdm({
    contextBars: bullishContext,
    setupBars: bullishSetup,
    triggerBars: bullishTriggerReady,
  });

  assert.equal(result.version, SMC_IDM_ENGINE_VERSION);
  assert.equal(result.strategy, 'SMC_IDM');
  assert.equal(result.direction, 'BUY');
  assert.equal(result.state, 'READY');
  assert.equal(result.evidence.bos.confirmation, 'close');
  assert.equal(result.evidence.idm.type, 'LOW');
  assert.equal(result.evidence.dealing_range.side, 'discount');
  assert.ok(result.evidence.post_bos.sweep);
  assert.ok(result.evidence.post_bos.zoneTouch);
  assert.ok(result.evidence.trigger);
  assert.equal(result.reason_codes.length, 0);
  assert.equal(result.entry_zone.length, 2);
  assert.equal(result.targets.length, 1);
});

test('SMC V2.2 valid bullish setup remains PRE_SIGNAL while M5 trigger is still pending', () => {
  const result = analyzeSmcIdm({
    contextBars: bullishContext,
    setupBars: bullishSetup,
    triggerBars: bullishTriggerWaiting,
  });

  assert.equal(result.direction, 'BUY');
  assert.equal(result.state, 'PRE_SIGNAL');
  assert.ok(result.reason_codes.includes('waiting_for_m5_micro_bos'));
  assert.equal(result.evidence.trigger, null);
});

test('SMC V2.3 BOS is close-confirmed; a wick through structure does not count', () => {
  const wickOnly = bullishSetup.map((item) => ({ ...item }));
  wickOnly[5] = makeBar(75, 102, 106, 101, 103.5);

  const result = analyzeSmcIdm({
    contextBars: bullishContext,
    setupBars: wickOnly,
    triggerBars: bullishTriggerWaiting,
  });

  assert.equal(result.state, 'INVALID');
  assert.ok(result.reason_codes.includes('bos_not_confirmed'));
});

test('SMC V2.4 a close beyond IDM invalidates the setup instead of forcing a signal', () => {
  const invalidated = bullishSetup.map((item) => ({ ...item }));
  invalidated[6] = makeBar(90, 98, 101, 94, 95.5);

  const result = analyzeSmcIdm({
    contextBars: bullishContext,
    setupBars: invalidated,
    triggerBars: bullishTriggerReady,
  });

  assert.equal(result.state, 'INVALID');
  assert.ok(result.reason_codes.includes('idm_structure_invalidated'));
});

test('SMC V2.5 neutral/insufficient H1 structure fails closed before setup logic', () => {
  const neutralContext = bullishContext.slice(0, 4);
  const result = analyzeSmcIdm({
    contextBars: neutralContext,
    setupBars: bullishSetup,
    triggerBars: bullishTriggerReady,
  });

  assert.equal(result.state, 'INVALID');
  assert.equal(result.direction, null);
  assert.ok(result.reason_codes.includes('context_not_directional'));
});

test('SMC V2.6 output stays technical-only and contains no account, lot, or execution authority', () => {
  const result = analyzeSmcIdm({
    contextBars: bullishContext,
    setupBars: bullishSetup,
    triggerBars: bullishTriggerReady,
  });

  const encoded = JSON.stringify(result);
  assert.doesNotMatch(encoded, /balance|equity|lot|volume|order_send|margin/i);
  assert.equal(Object.hasOwn(result, 'approved_volume'), false);
  assert.equal(Object.hasOwn(result, 'risk_fraction'), false);
});

test('SMC V2.7 bearish structure uses the mirrored SELL path', () => {
  const result = analyzeSmcIdm({
    contextBars: bearishContext,
    setupBars: bearishSetup,
    triggerBars: bearishTriggerReady,
  });

  assert.equal(result.direction, 'SELL');
  assert.ok(['PRE_SIGNAL', 'READY'].includes(result.state));
  assert.equal(result.evidence.bos.confirmation, 'close');
  assert.equal(result.evidence.idm.type, 'HIGH');
  assert.equal(result.evidence.dealing_range.side, 'premium');
});

test('SMC V2.8 malformed OHLC or non-monotonic time fails closed', () => {
  const badRange = bullishSetup.map((item) => ({ ...item }));
  badRange[2] = { ...badRange[2], high: 94, low: 96 };
  assert.throws(
    () => analyzeSmcIdm({ contextBars: bullishContext, setupBars: badRange, triggerBars: bullishTriggerReady }),
    /smc_setup_range_invalid:2/,
  );

  const badTime = bullishTriggerReady.map((item) => ({ ...item }));
  badTime[2] = { ...badTime[2], time: badTime[1].time };
  assert.throws(
    () => analyzeSmcIdm({ contextBars: bullishContext, setupBars: bullishSetup, triggerBars: badTime }),
    /smc_trigger_time_non_monotonic:2/,
  );
});
