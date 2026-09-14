// Focused tests for the fast-restart X liveness wakeup wiring in
// electron/main.cjs -- a single one-shot timer (never polling/setInterval)
// tied to the persisted current claim's lease_expires_at, re-armed after
// every successful admission (queue-dispatched or direct x_start) and
// unconditionally after every timer fire (required for lease renewal: see
// mcp/x/production-runtime.mjs's own W4 test for the T1->T2 proof).
//
// electron/main.cjs requires the real `electron` module and Electron app
// lifecycle, so it cannot be executed directly in a plain Node test process
// (same constraint scripts/test-updater.mjs and
// scripts/test-electron-x-queue-integration.mjs already work around).
// This suite:
//  - statically verifies ordering/shape of the actual committed source
//    (the same main.indexOf(...)/slice(...) technique already used
//    elsewhere), and
//  - extracts the EXACT armXWakeup/onXWakeupFire text and executes it via
//    a small factory wrapper (they share mutable closure state --
//    xWakeupTimer -- and reference each other, so unlike the simpler B2A/B2B
//    reconciliation loops they cannot be extracted as one standalone
//    statement; the factory declares the same `let xWakeupTimer` they both
//    close over, and injects fake setTimeout/clearTimeout so no test
//    actually waits on wall-clock timers), so behavior is proven against
//    the real committed code, never a hand-copied duplicate.
// Substantive correctness of the reconciliation decision itself (renewal,
// reclaim, idempotency, direct-path repair) is proven at the
// production-runtime.mjs layer (scripts/test-x-startup-reconciliation.mjs's
// W1-W7) with zero extraction tricks needed, since that is where the actual
// decision logic lives -- this file only proves Electron's own wiring atop
// it: scheduling, unref, unconditional re-arm, per-run containment, and
// that Electron never inspects claim/run truth directly.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const mainSource = fs.readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');

// ── extraction ───────────────────────────────────────────────────────────

const wakeupStart = mainSource.indexOf('const armXWakeup = () => {');
const wakeupEnd = mainSource.indexOf('\nconst getUpdaterInfo = () => ({');
assert.ok(wakeupStart !== -1 && wakeupEnd !== -1, 'the armXWakeup/onXWakeupFire block must be found in electron/main.cjs');
const wakeupSource = mainSource.slice(wakeupStart, wakeupEnd);

const xStartupBlockStart = mainSource.indexOf("const { XQueueStore } = await importFromHere('../mcp/x/queue-store.mjs');");
const xStartupBlockEnd = mainSource.indexOf("} catch (err) {\n    console.error('Failed to initialize XQueueCoordinator:'");
assert.ok(xStartupBlockStart !== -1 && xStartupBlockEnd !== -1, 'the X startup block must be found');
const xStartupBlock = mainSource.slice(xStartupBlockStart, xStartupBlockEnd);

/**
 * Builds a fresh, isolated instance of the EXACT armXWakeup/onXWakeupFire
 * text extracted above, wrapped in a factory that declares the same
 * `let xWakeupTimer` they both close over, with fake setTimeout/clearTimeout
 * so no test waits on a real timer.
 */
function buildWakeupHarness({ xGetNextWakeupDeadline, xReconcileRuntimeNow, xQueueCoordinator, consoleImpl }) {
  const timerState = { scheduled: null, clearedCount: 0 };
  const fakeSetTimeout = (fn, delay) => {
    const handle = { fn, delay, unrefCalled: false, unref() { this.unrefCalled = true; return this; } };
    timerState.scheduled = handle;
    return handle;
  };
  const fakeClearTimeout = (handle) => {
    if (handle) timerState.clearedCount += 1;
  };

  const factorySource = `
    let xWakeupTimer = null;
    ${wakeupSource}
    return { armXWakeup, onXWakeupFire, getTimer: () => xWakeupTimer };
  `;
  const factory = new Function(
    'xGetNextWakeupDeadline', 'xReconcileRuntimeNow', 'xQueueCoordinator', 'setTimeout', 'clearTimeout', 'console',
    factorySource,
  );
  const instance = factory(xGetNextWakeupDeadline, xReconcileRuntimeNow, xQueueCoordinator, fakeSetTimeout, fakeClearTimeout, consoleImpl ?? console);
  return { ...instance, timerState };
}

// ── static: ordering and shape of the real committed source ────────────────

test('W-E1 armXWakeup is defined before onAntigravityAdmissionReleased/X startup wiring uses it', () => {
  const defIdx = mainSource.indexOf('const armXWakeup = () => {');
  const usedInConstructorIdx = mainSource.indexOf('onAdmissionAccepted: () => armXWakeup()');
  assert.ok(defIdx !== -1 && usedInConstructorIdx !== -1);
  assert.ok(defIdx < usedInConstructorIdx, 'armXWakeup must be defined before it is referenced in the XQueueCoordinator constructor call');
});

test('W-E2 onAdmissionAccepted is wired to armXWakeup in the XQueueCoordinator constructor call', () => {
  assert.match(
    xStartupBlock,
    /new XQueueCoordinator\(\{[\s\S]*?onAdmissionAccepted:\s*\(\)\s*=>\s*armXWakeup\(\)[\s\S]*?\}\)/,
    'the XQueueCoordinator construction must pass onAdmissionAccepted: () => armXWakeup()',
  );
});

test('W-E3 x_admission_hint is wired to armXWakeup in the existing serverProcess message handler', () => {
  assert.match(
    mainSource,
    /if \(message\?\.type === 'x_admission_hint'\) armXWakeup\(\);/,
    'the message handler must call armXWakeup() for an x_admission_hint message',
  );
  const registrationCount = (mainSource.match(/serverProcess\.on\('message',/g) || []).length;
  assert.equal(registrationCount, 1, 'must not introduce a second serverProcess message listener');
});

test('W-E4 armXWakeup() is called once at the end of the X startup block, after kick()', () => {
  const kickIdx = xStartupBlock.lastIndexOf('xQueueCoordinator.kick();');
  const armIdx = xStartupBlock.indexOf('armXWakeup();');
  assert.ok(kickIdx !== -1 && armIdx !== -1);
  assert.ok(kickIdx < armIdx, 'the initial armXWakeup() call must run after the startup kick()');
});

test('W-E5 no polling/timer mechanism exists in the fast-restart wakeup feature itself', () => {
  // Scoped to the wakeup block and the X startup block this feature added
  // to -- NOT the whole file, which already has unrelated, pre-existing
  // setInterval usage for other features (e.g. continuationRecoveryTimer
  // for durable-job continuation recovery, and a local-chat stream sync
  // interval). This proves the NEW feature introduces no polling, without
  // making a false claim about the rest of the file.
  assert.doesNotMatch(wakeupSource, /setInterval/, 'the wakeup block itself must never use setInterval');
  assert.doesNotMatch(xStartupBlock, /setInterval/, 'the X startup block must never use setInterval for the wakeup feature');
});

test('W-E6 the wakeup block never inspects claim/run truth directly -- no runStore./claimStore. call anywhere in it', () => {
  assert.doesNotMatch(
    wakeupSource,
    /\b(runStore|claimStore)\.\w+\(/,
    'armXWakeup/onXWakeupFire must only ever call xGetNextWakeupDeadline()/xReconcileRuntimeNow(), never runStore/claimStore directly',
  );
});

test('W-E7 onXWakeupFire re-arms unconditionally in a finally block, and notifies per-run inside its own try/catch', () => {
  assert.match(wakeupSource, /\bfinally\s*\{\s*[\s\S]*?armXWakeup\(\);\s*\}/, 'the re-arm call must be inside a finally block');
  assert.match(
    wakeupSource,
    /for \(const runId of runIds\) \{\s*try \{\s*xQueueCoordinator\?\.onXRunTerminal\(\{ runId \}\);\s*\} catch/,
    'each returned runId must be notified inside its own try/catch',
  );
});

// ── dynamic: exact extracted source, executed against fake doubles ─────────

test('W-D1 armXWakeup schedules a one-shot timer for the exact deadline and calls unref()', () => {
  const h = buildWakeupHarness({
    xGetNextWakeupDeadline: () => Date.now() + 5000,
    xReconcileRuntimeNow: () => [],
    xQueueCoordinator: { onXRunTerminal: () => {} },
  });
  h.armXWakeup();
  assert.ok(h.timerState.scheduled, 'a timer must be scheduled');
  assert.ok(h.timerState.scheduled.delay > 0 && h.timerState.scheduled.delay <= 5000);
  assert.equal(h.timerState.scheduled.unrefCalled, true, 'the timer must be unref()\'d');
});

test('W-D2 armXWakeup clears any existing timer before scheduling a new one', () => {
  let deadline = Date.now() + 5000;
  const h = buildWakeupHarness({
    xGetNextWakeupDeadline: () => deadline,
    xReconcileRuntimeNow: () => [],
    xQueueCoordinator: { onXRunTerminal: () => {} },
  });
  h.armXWakeup();
  const first = h.timerState.scheduled;
  deadline = Date.now() + 9000;
  h.armXWakeup();
  assert.equal(h.timerState.clearedCount, 1, 'the prior timer must be cleared exactly once');
  assert.notEqual(h.timerState.scheduled, first, 'a fresh timer must replace it');
});

test('W-D3 armXWakeup leaves no timer armed when there is no active claim (null deadline)', () => {
  const h = buildWakeupHarness({
    xGetNextWakeupDeadline: () => null,
    xReconcileRuntimeNow: () => [],
    xQueueCoordinator: { onXRunTerminal: () => {} },
  });
  h.armXWakeup();
  assert.equal(h.timerState.scheduled, null);
  assert.equal(h.getTimer(), null);
});

test('W-D4 onXWakeupFire calls reconcileXRuntimeNow, notifies each returned runId, then unconditionally re-arms', () => {
  const notified = [];
  let deadline = Date.now() + 1000;
  const h = buildWakeupHarness({
    xGetNextWakeupDeadline: () => deadline,
    xReconcileRuntimeNow: () => ['run-a', 'run-b'],
    xQueueCoordinator: { onXRunTerminal: ({ runId }) => { notified.push(runId); } },
  });
  h.onXWakeupFire();
  assert.deepEqual(notified, ['run-a', 'run-b']);
  assert.ok(h.timerState.scheduled, 'armXWakeup must have been called again, re-arming a new timer');
});

test('W-D5 onXWakeupFire re-arms even when reconcileXRuntimeNow returns an empty array (renewal case)', () => {
  const h = buildWakeupHarness({
    xGetNextWakeupDeadline: () => Date.now() + 2000,
    xReconcileRuntimeNow: () => [],
    xQueueCoordinator: { onXRunTerminal: () => { throw new Error('must not be called -- nothing was returned'); } },
  });
  h.onXWakeupFire();
  assert.ok(h.timerState.scheduled, 'an empty reconciliation result must still trigger a re-arm');
});

test('W-D6 onXWakeupFire re-arms even when reconcileXRuntimeNow itself throws', () => {
  const loggedErrors = [];
  const h = buildWakeupHarness({
    xGetNextWakeupDeadline: () => Date.now() + 2000,
    xReconcileRuntimeNow: () => { throw new Error('simulated reconciliation failure'); },
    xQueueCoordinator: { onXRunTerminal: () => {} },
    consoleImpl: { error: (...a) => loggedErrors.push(a) },
  });
  assert.doesNotThrow(() => h.onXWakeupFire());
  assert.ok(h.timerState.scheduled, 'a thrown reconciliation must still trigger a re-arm');
  assert.ok(loggedErrors.length > 0);
});

test('W-D7 onXWakeupFire contains one throwing onXRunTerminal notification and still re-arms and still notifies the rest', () => {
  const notified = [];
  const loggedErrors = [];
  const h = buildWakeupHarness({
    xGetNextWakeupDeadline: () => Date.now() + 2000,
    xReconcileRuntimeNow: () => ['run-throws', 'run-ok'],
    xQueueCoordinator: {
      onXRunTerminal: ({ runId }) => {
        notified.push(runId);
        if (runId === 'run-throws') throw new Error('simulated notification failure');
      },
    },
    consoleImpl: { error: (...a) => loggedErrors.push(a) },
  });
  h.onXWakeupFire();
  assert.deepEqual(notified, ['run-throws', 'run-ok'], 'both runIds must be reached despite the first throwing');
  assert.ok(h.timerState.scheduled, 'must still re-arm after a notification failure');
  assert.ok(loggedErrors.length > 0);
});

test('W-D8 a null xQueueCoordinator (not yet constructed) is tolerated -- optional chaining, no throw', () => {
  const h = buildWakeupHarness({
    xGetNextWakeupDeadline: () => Date.now() + 2000,
    xReconcileRuntimeNow: () => ['run-a'],
    xQueueCoordinator: null,
  });
  assert.doesNotThrow(() => h.onXWakeupFire());
  assert.ok(h.timerState.scheduled);
});
