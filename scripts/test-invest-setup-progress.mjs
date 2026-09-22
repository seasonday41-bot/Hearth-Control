// The Invest page's plain-language layer. It decides nothing -- these tests
// exist so the words on screen keep matching what the engine actually reports.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  setupSteps,
  setupSummary,
  freshness,
  timeLeft,
  RISK_MAX_STATE_AGE_MS,
} from '../src/invest-setup-progress.ts';

const labels = (steps) => steps.map((step) => `${step.label}:${step.state}`);

test('PROG1 a READY setup has climbed every rung', () => {
  for (const strategy of ['SMC_IDM', 'HARMONIC_PRZ']) {
    const steps = setupSteps(strategy, 'READY', []);
    assert.ok(steps.length > 0);
    assert.ok(steps.every((step) => step.state === 'done'), strategy);
  }
});

test('PROG2 the rungs before the blocker are done, the blocker is waiting, the rest are pending', () => {
  // The engine reports both of these together when the sweep has not happened yet.
  const steps = setupSteps('SMC_IDM', 'PRE_SIGNAL', ['waiting_for_idm_sweep', 'waiting_for_zone_touch']);
  assert.deepEqual(labels(steps), [
    'H1 direction:done',
    'M15 break of structure:done',
    'IDM point:done',
    'Entry zone:done',
    'IDM sweep:waiting',
    'Price touched the zone:pending',
    'M5 micro break:pending',
  ]);
});

test('PROG3 a failed rung reads as failed, not as waiting', () => {
  const steps = setupSteps('SMC_IDM', 'INVALID', ['context_not_directional']);
  assert.equal(steps[0].state, 'failed', 'H1 direction failed');
  assert.ok(steps.slice(1).every((step) => step.state === 'pending'));
});

test('PROG4 the last SMC rung is the M5 micro break', () => {
  const steps = setupSteps('SMC_IDM', 'PRE_SIGNAL', ['waiting_for_m5_micro_bos']);
  assert.equal(steps.at(-1).state, 'waiting');
  assert.ok(steps.slice(0, -1).every((step) => step.state === 'done'));
});

test('PROG5 Harmonic has its own ladder and stalls at D confirmation', () => {
  const steps = setupSteps('HARMONIC_PRZ', 'PRE_SIGNAL', ['waiting_for_d_confirmation']);
  assert.deepEqual(labels(steps), [
    'Pattern found:done',
    'D point confirmed:waiting',
    'Structure still valid:pending',
    'M5 micro break:pending',
  ]);
});

test('PROG6 a broken structure is reported as broken, not as progress', () => {
  assert.match(setupSummary('INVALID', ['idm_structure_invalidated']), /broke before it could trigger/);
  assert.match(setupSummary('INVALID', ['harmonic_structure_invalidated']), /broke before it could trigger/);
});

test('PROG7 READY says what is actually still needed: the price inside the zone', () => {
  assert.match(setupSummary('READY', []), /inside the entry zone/);
});

test('PROG13 the summary keeps acronym casing instead of flattening it', () => {
  assert.equal(setupSummary('PRE_SIGNAL', ['waiting_for_idm_sweep']), 'Waiting for the IDM sweep.');
  assert.equal(setupSummary('PRE_SIGNAL', ['waiting_for_m5_micro_bos']), 'Waiting for the M5 micro break.');
});

test('PROG8 freshness follows the Risk Gate boundary, not merely whether a snapshot exists', () => {
  assert.equal(freshness(0).tone, 'live');
  assert.equal(freshness(RISK_MAX_STATE_AGE_MS).tone, 'live');
  assert.equal(freshness(RISK_MAX_STATE_AGE_MS + 1).tone, 'lagging');
  assert.equal(freshness(59_000).tone, 'lagging');
  assert.equal(freshness(120_000).tone, 'stale');
  assert.match(freshness(120_000).label, /2 min old/);
  assert.match(freshness(7_200_000).label, /2 h old/);
});

test('PROG9 absent telemetry is absent, never quietly "live"', () => {
  for (const value of [null, undefined, NaN]) assert.equal(freshness(value).tone, 'absent');
});

test('PROG10 a stale snapshot is never reported as live', () => {
  // The exact case seen in production: the bridge was up and snapshots were
  // present, but the EA had been detached for 55 minutes.
  const stale = freshness(3_308_800);
  assert.equal(stale.tone, 'stale');
  assert.doesNotMatch(stale.label, /live/i);
});

test('PROG12 an unknown or empty state reads as not reached, never as complete', () => {
  // The state the page is in most of the time: nothing is happening. Showing a
  // full ladder of ticks here would read as "about to trigger".
  for (const [state, codes] of [[undefined, []], ['NO_SETUP', []], ['INVALID', []], ['PRE_SIGNAL', ['some_future_reason_code']]]) {
    const steps = setupSteps('SMC_IDM', state, codes);
    assert.ok(steps.every((step) => step.state === 'pending'), `${state} / ${codes}`);
  }
});

test('PROG11 time left counts down and disappears once it has expired', () => {
  const now = Date.parse('2026-09-21T02:20:00.000Z');
  assert.equal(timeLeft('2026-09-21T02:50:00.000Z', now), '30m 0s');
  assert.equal(timeLeft('2026-09-21T02:20:45.000Z', now), '45s');
  assert.equal(timeLeft('2026-09-21T02:20:00.000Z', now), null, 'expired exactly now');
  assert.equal(timeLeft('2026-09-21T02:19:00.000Z', now), null, 'already past');
  assert.equal(timeLeft(null, now), null);
});
