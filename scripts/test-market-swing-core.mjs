import test from 'node:test';
import assert from 'node:assert/strict';
import {
  THREE_BAR_SWING_VERSION,
  detectConfirmedThreeBarSwings,
  latestConfirmedSwing,
} from '../mcp/market/swing-core.mjs';

const bar = (minute, high, low) => ({
  time: new Date(Date.UTC(2026, 8, 21, 0, minute)).toISOString(),
  high,
  low,
});

test('Swing Core V2.1 confirms a strict 3-bar Swing High only after the right bar exists', () => {
  const firstTwo = [
    bar(0, 10, 7),
    bar(1, 13, 8),
  ];
  assert.deepEqual(detectConfirmedThreeBarSwings(firstTwo), []);

  const swings = detectConfirmedThreeBarSwings([
    ...firstTwo,
    bar(2, 11, 9),
  ]);

  assert.equal(swings.length, 1);
  assert.deepEqual(swings[0], {
    version: THREE_BAR_SWING_VERSION,
    type: 'HIGH',
    index: 1,
    time: bar(1, 13, 8).time,
    price: 13,
    confirmed_index: 2,
    confirmed_at: bar(2, 11, 9).time,
  });
});

test('Swing Core V2.2 confirms a strict 3-bar Swing Low', () => {
  const swings = detectConfirmedThreeBarSwings([
    bar(0, 13, 8),
    bar(1, 12, 5),
    bar(2, 14, 7),
  ]);

  assert.equal(swings.length, 1);
  assert.equal(swings[0].type, 'LOW');
  assert.equal(swings[0].index, 1);
  assert.equal(swings[0].price, 5);
  assert.equal(swings[0].confirmed_index, 2);
});

test('Swing Core V2.3 rejects equal-high/equal-low ties instead of inventing pivots', () => {
  const highTie = detectConfirmedThreeBarSwings([
    bar(0, 13, 7),
    bar(1, 13, 8),
    bar(2, 11, 9),
  ]);
  assert.equal(highTie.some((item) => item.type === 'HIGH'), false);

  const lowTie = detectConfirmedThreeBarSwings([
    bar(0, 12, 5),
    bar(1, 13, 5),
    bar(2, 14, 7),
  ]);
  assert.equal(lowTie.some((item) => item.type === 'LOW'), false);
});

test('Swing Core V2.4 detects multiple confirmed swings in chronological order', () => {
  const swings = detectConfirmedThreeBarSwings([
    bar(0, 10, 7),
    bar(1, 14, 8),
    bar(2, 11, 6),
    bar(3, 15, 9),
    bar(4, 12, 8),
  ]);

  assert.deepEqual(
    swings.map((item) => [item.type, item.index, item.price]),
    [
      ['HIGH', 1, 14],
      ['LOW', 2, 6],
      ['HIGH', 3, 15],
    ],
  );
  assert.equal(latestConfirmedSwing(swings, 'HIGH')?.index, 3);
  assert.equal(latestConfirmedSwing(swings, 'LOW')?.index, 2);
});

test('Swing Core V2.5 fails closed on malformed ranges or non-monotonic timestamps', () => {
  assert.throws(
    () => detectConfirmedThreeBarSwings([
      bar(0, 10, 7),
      { ...bar(1, 8, 9) },
      bar(2, 11, 7),
    ]),
    /swing_invalid_range:1/,
  );

  assert.throws(
    () => detectConfirmedThreeBarSwings([
      bar(0, 10, 7),
      bar(0, 13, 8),
      bar(2, 11, 9),
    ]),
    /swing_non_monotonic_time:1/,
  );
});

test('Swing Core V2.6 does not mutate source bars or expose mutable source references', () => {
  const bars = [
    bar(0, 10, 7),
    bar(1, 13, 8),
    bar(2, 11, 9),
  ];
  const before = structuredClone(bars);
  const swings = detectConfirmedThreeBarSwings(bars);
  swings[0].price = 999;

  assert.deepEqual(bars, before);
  assert.equal(detectConfirmedThreeBarSwings(bars)[0].price, 13);
});
