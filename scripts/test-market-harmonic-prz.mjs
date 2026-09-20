import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeHarmonicPrz,
  HARMONIC_PRZ_ENGINE_VERSION,
} from '../mcp/market/harmonic-prz-engine.mjs';

const base = Date.UTC(2026, 8, 21, 0, 0, 0);
const makeBar = (minutes, open, high, low, close) => ({
  time: new Date(base + (minutes * 60_000)).toISOString(),
  open,
  high,
  low,
  close,
  volume: 1000 + minutes,
});

const contextBars = [
  makeBar(0, 108, 110, 106, 109),
  makeBar(60, 109, 112, 108, 111),
  makeBar(120, 108, 109, 105, 107),
  makeBar(180, 110, 113, 109, 112),
  makeBar(240, 109, 111, 107, 110),
];

const bullishGartley = [
  makeBar(0, 106, 108, 104, 106),
  makeBar(15, 104, 107, 100, 105),
  makeBar(30, 108, 112, 106, 111),
  makeBar(45, 116, 120, 115, 118),
  makeBar(60, 114, 116, 112, 113),
  makeBar(75, 109, 111, 107.64, 109),
  makeBar(90, 112, 114, 110, 113),
  makeBar(105, 115, 116.64, 114, 115.5),
  makeBar(120, 110, 113, 108, 109),
  makeBar(135, 106, 108, 104.28, 106),
  makeBar(150, 107, 110, 106, 109),
];

const bullishXabcOnly = bullishGartley.slice(0, 9);

const bullishTriggerReady = [
  makeBar(150, 106, 108, 104.5, 107),
  makeBar(155, 107, 109, 105.5, 108),
  makeBar(160, 108, 108.5, 106, 107),
  makeBar(165, 107, 110, 106.5, 109.5),
];

const bullishTriggerWaiting = [
  makeBar(150, 106, 108, 104.5, 107),
  makeBar(155, 107, 109, 105.5, 108),
  makeBar(160, 108, 108.5, 106, 107),
  makeBar(165, 107, 108.8, 106.5, 108),
];

const mirrorPrice = (value) => 220 - value;
const mirrorBars = (bars) => bars.map((bar) => ({
  ...bar,
  open: mirrorPrice(bar.open),
  high: mirrorPrice(bar.low),
  low: mirrorPrice(bar.high),
  close: mirrorPrice(bar.close),
}));

test('Harmonic V2.1 bullish Gartley reaches READY only with confirmed D and M5 micro BOS', () => {
  const result = analyzeHarmonicPrz({
    contextBars,
    setupBars: bullishGartley,
    triggerBars: bullishTriggerReady,
  });

  assert.equal(result.version, HARMONIC_PRZ_ENGINE_VERSION);
  assert.equal(result.strategy, 'HARMONIC_PRZ');
  assert.equal(result.pattern, 'GARTLEY');
  assert.equal(result.direction, 'BUY');
  assert.equal(result.state, 'READY');
  assert.ok(result.evidence.points.D);
  assert.ok(result.evidence.points.D.price >= result.prz[0] && result.evidence.points.D.price <= result.prz[1]);
  assert.ok(result.evidence.trigger);
  assert.equal(result.reason_codes.length, 0);
  assert.equal(result.targets.length, 2);
});

test('Harmonic V2.2 valid XABC projection stays PRE_SIGNAL while D is unconfirmed', () => {
  const result = analyzeHarmonicPrz({
    contextBars,
    setupBars: bullishXabcOnly,
    triggerBars: bullishTriggerWaiting,
  });

  assert.equal(result.pattern, 'GARTLEY');
  assert.equal(result.direction, 'BUY');
  assert.equal(result.state, 'PRE_SIGNAL');
  assert.equal(result.evidence.points.D, null);
  assert.ok(result.reason_codes.includes('waiting_for_d_confirmation'));
  assert.ok(result.prz[0] < result.prz[1]);
});

test('Harmonic V2.3 confirmed Gartley remains PRE_SIGNAL until M5 confirmation occurs', () => {
  const result = analyzeHarmonicPrz({
    contextBars,
    setupBars: bullishGartley,
    triggerBars: bullishTriggerWaiting,
  });

  assert.equal(result.pattern, 'GARTLEY');
  assert.equal(result.state, 'PRE_SIGNAL');
  assert.ok(result.reason_codes.includes('waiting_for_m5_micro_bos'));
  assert.equal(result.evidence.trigger, null);
});

test('Harmonic V2.4 bearish Gartley uses the mirrored SELL path', () => {
  const result = analyzeHarmonicPrz({
    contextBars: mirrorBars(contextBars),
    setupBars: mirrorBars(bullishGartley),
    triggerBars: mirrorBars(bullishTriggerReady),
  });

  assert.equal(result.pattern, 'GARTLEY');
  assert.equal(result.direction, 'SELL');
  assert.equal(result.state, 'READY');
  assert.ok(result.evidence.trigger);
});

test('Harmonic V2.5 supports a projected Bat PRZ with explicit alternate AB-CD range', () => {
  const bat = [
    makeBar(0, 106, 108, 104, 106),
    makeBar(15, 104, 107, 100, 105),
    makeBar(30, 108, 112, 106, 111),
    makeBar(45, 116, 120, 115, 118),
    makeBar(60, 114, 116, 112, 113),
    makeBar(75, 111, 113, 110, 111),
    makeBar(90, 112, 114, 111, 113),
    makeBar(105, 114, 114.98, 113, 114),
    makeBar(120, 108, 112, 106, 108),
  ];

  const result = analyzeHarmonicPrz({
    contextBars,
    setupBars: bat,
    triggerBars: bullishTriggerWaiting,
  });

  assert.equal(result.pattern, 'BAT');
  assert.equal(result.direction, 'BUY');
  assert.equal(result.state, 'PRE_SIGNAL');
  assert.ok(result.reason_codes.includes('waiting_for_d_confirmation'));
});

test('Harmonic V2.6 wrong XABC ratios fail closed instead of inventing a pattern', () => {
  const wrong = bullishXabcOnly.map((item) => ({ ...item }));
  wrong[5] = makeBar(75, 103, 105, 102, 104);

  const result = analyzeHarmonicPrz({
    contextBars,
    setupBars: wrong,
    triggerBars: bullishTriggerWaiting,
  });

  assert.equal(result.state, 'INVALID');
  assert.equal(result.pattern, null);
  assert.ok(result.reason_codes.includes('harmonic_pattern_not_found'));
});

test('Harmonic V2.7 a close through X after confirmed D invalidates the setup', () => {
  const invalidated = [
    ...bullishGartley,
    makeBar(165, 103, 105, 98, 99),
  ];

  const result = analyzeHarmonicPrz({
    contextBars,
    setupBars: invalidated,
    triggerBars: bullishTriggerReady,
  });

  assert.equal(result.state, 'INVALID');
  assert.ok(result.reason_codes.includes('harmonic_structure_invalidated'));
});

test('Harmonic V2.8 output is technical-only and cannot size or execute a position', () => {
  const result = analyzeHarmonicPrz({
    contextBars,
    setupBars: bullishGartley,
    triggerBars: bullishTriggerReady,
  });
  const encoded = JSON.stringify(result);
  assert.doesNotMatch(encoded, /balance|equity|lot|volume|order_send|margin/i);
  assert.equal(Object.hasOwn(result, 'approved_volume'), false);
  assert.equal(Object.hasOwn(result, 'risk_fraction'), false);
});

test('Harmonic V2.9 malformed OHLC or non-monotonic timestamps fail closed', () => {
  const badRange = bullishGartley.map((item) => ({ ...item }));
  badRange[2] = { ...badRange[2], high: 100, low: 106 };
  assert.throws(
    () => analyzeHarmonicPrz({ contextBars, setupBars: badRange, triggerBars: bullishTriggerReady }),
    /harmonic_setup_range_invalid:2/,
  );

  const badTime = bullishTriggerReady.map((item) => ({ ...item }));
  badTime[2] = { ...badTime[2], time: badTime[1].time };
  assert.throws(
    () => analyzeHarmonicPrz({ contextBars, setupBars: bullishGartley, triggerBars: badTime }),
    /harmonic_trigger_time_non_monotonic:2/,
  );
});
