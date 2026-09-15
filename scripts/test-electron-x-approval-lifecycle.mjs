// Focused tests for the main-owned X approval lifecycle in electron/main.cjs:
// requestXApproval's centralized `finish` settlement (user, timeout, abort,
// shutdown, child/startup invalidation) and the server:respond-approval
// handler's isolation of pendingXApprovals requestIds from the HTTP child
// relay.
//
// electron/main.cjs requires the real `electron` module and Electron app
// lifecycle, so it cannot be executed directly in a plain Node test process
// (same constraint scripts/test-updater.mjs, scripts/test-electron-x-wakeup.mjs,
// scripts/test-electron-window-lifecycle.mjs, and
// scripts/test-electron-x-queue-integration.mjs already work around). This
// suite extracts the EXACT committed requestXApproval and
// server:respond-approval text and executes it via a factory wrapper against
// fake crypto/sendEvent/timer/ipcMain doubles, sharing the same
// pendingXApprovals/localApprovals/xShuttingDown/serverProcess closure state
// the real file shares between them -- never a hand-copied duplicate.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const mainSource = fs.readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');

// ── extraction ───────────────────────────────────────────────────────────

const requestXApprovalStart = mainSource.indexOf('const requestXApproval = (record, child, action) => new Promise((resolve) => {');
const requestXApprovalEnd = mainSource.indexOf('\nconst handleXQueueEnqueue = async (message, child, launchWorkspace, waiter) => {');
assert.ok(requestXApprovalStart !== -1 && requestXApprovalEnd !== -1, 'requestXApproval must be found in electron/main.cjs');
const requestXApprovalSource = mainSource.slice(requestXApprovalStart, requestXApprovalEnd);

const respondApprovalStart = mainSource.indexOf("ipcMain.handle('server:respond-approval', (_event, response) => {");
const respondApprovalEnd = mainSource.indexOf("\n  ipcMain.handle('workspace:validate'");
assert.ok(respondApprovalStart !== -1 && respondApprovalEnd !== -1, 'the server:respond-approval handler must be found in electron/main.cjs');
const respondApprovalSource = mainSource.slice(respondApprovalStart, respondApprovalEnd);

/**
 * Builds a fresh, isolated instance of the EXACT requestXApproval +
 * server:respond-approval text extracted above, sharing the same
 * pendingXApprovals/localApprovals/xShuttingDown/serverProcess closure
 * state they share in the real file. `setXShuttingDown`/`setServerProcess`
 * are test-only plumbing (electron/main.cjs itself never exposes such
 * setters) used to drive the exact preconditions requirement 7 needs.
 */
function buildXApprovalHarness() {
  const sent = [];
  const fakeSendEvent = (event) => sent.push(event);

  const timers = { scheduled: [] };
  const fakeSetTimeout = (fn, delay) => {
    const handle = { fn, delay, cleared: false };
    timers.scheduled.push(handle);
    return handle;
  };
  const fakeClearTimeout = (handle) => { if (handle) handle.cleared = true; };

  let uuidCounter = 0;
  const fakeCrypto = { randomUUID: () => `x-req-${++uuidCounter}` };

  const handlers = {};
  const fakeIpcMain = { handle: (name, cb) => { handlers[name] = cb; } };

  const factorySource = `
    let serverProcess = null;
    let xShuttingDown = false;
    const pendingXApprovals = new Map();
    const localApprovals = new Map();
    ${requestXApprovalSource}
    ${respondApprovalSource}
    return {
      requestXApproval, pendingXApprovals, localApprovals,
      setXShuttingDown: (v) => { xShuttingDown = v; },
      setServerProcess: (v) => { serverProcess = v; },
    };
  `;
  const factory = new Function('crypto', 'sendEvent', 'setTimeout', 'clearTimeout', 'ipcMain', factorySource);
  const instance = factory(fakeCrypto, fakeSendEvent, fakeSetTimeout, fakeClearTimeout, fakeIpcMain);

  return {
    ...instance,
    sent,
    timers,
    respondApproval: (response) => handlers['server:respond-approval'](null, response),
  };
}

const resolvedEventsFor = (sent, requestId) => sent.filter((m) => m.type === 'approval:resolved' && m.requestId === requestId);

// ── 1. user result ─────────────────────────────────────────────────────

test('XA1 a matching user response resolves allowed, reason=user, full cleanup, exactly one event', async () => {
  const h = buildXApprovalHarness();
  const child = { name: 'child' };
  h.setServerProcess(child);
  const record = { abort: new AbortController() };
  const promise = h.requestXApproval(record, child, 'do X thing');
  assert.equal(h.pendingXApprovals.size, 1);
  assert.equal(h.localApprovals.size, 1);
  const [requestId] = h.pendingXApprovals.keys();

  h.respondApproval({ requestId, allowed: true });

  const allowed = await promise;
  assert.equal(allowed, true);
  assert.equal(h.pendingXApprovals.size, 0, 'pendingXApprovals entry must be removed');
  assert.equal(h.localApprovals.size, 0, 'localApprovals entry must be removed');
  const events = resolvedEventsFor(h.sent, requestId);
  assert.equal(events.length, 1, 'exactly one approval:resolved event');
  assert.equal(events[0].allowed, true);
  assert.equal(events[0].reason, 'user');
});

test('XA1b a matching user Deny resolves allowed=false, reason=user', async () => {
  const h = buildXApprovalHarness();
  const child = { name: 'child' };
  h.setServerProcess(child);
  const record = { abort: new AbortController() };
  const promise = h.requestXApproval(record, child, 'do X thing');
  const [requestId] = h.pendingXApprovals.keys();
  h.respondApproval({ requestId, allowed: false });
  const allowed = await promise;
  assert.equal(allowed, false);
  const events = resolvedEventsFor(h.sent, requestId);
  assert.equal(events.length, 1);
  assert.equal(events[0].allowed, false);
  assert.equal(events[0].reason, 'user');
});

// ── 2. timeout ─────────────────────────────────────────────────────────

test('XA2 the 60s timeout resolves false, reason=timeout, cleanup occurs, exactly one event', async () => {
  const h = buildXApprovalHarness();
  const child = { name: 'child' };
  h.setServerProcess(child);
  const record = { abort: new AbortController() };
  const promise = h.requestXApproval(record, child, 'do X thing');
  const [requestId] = h.pendingXApprovals.keys();
  const timeoutHandle = h.timers.scheduled.find((t) => t.delay === 60000);
  assert.ok(timeoutHandle, 'a 60s timer must have been scheduled');

  timeoutHandle.fn(); // fire it directly -- never a real wall-clock wait

  const allowed = await promise;
  assert.equal(allowed, false);
  assert.equal(h.pendingXApprovals.size, 0);
  assert.equal(h.localApprovals.size, 0);
  const events = resolvedEventsFor(h.sent, requestId);
  assert.equal(events.length, 1);
  assert.equal(events[0].allowed, false);
  assert.equal(events[0].reason, 'timeout');
});

// ── 3. abort ───────────────────────────────────────────────────────────

test('XA3 record.abort resolves false, reason=aborted, cleanup occurs, exactly one event', async () => {
  const h = buildXApprovalHarness();
  const child = { name: 'child' };
  h.setServerProcess(child);
  const record = { abort: new AbortController() };
  const promise = h.requestXApproval(record, child, 'do X thing');
  const [requestId] = h.pendingXApprovals.keys();

  record.abort.abort();

  const allowed = await promise;
  assert.equal(allowed, false);
  assert.equal(h.pendingXApprovals.size, 0);
  assert.equal(h.localApprovals.size, 0);
  const events = resolvedEventsFor(h.sent, requestId);
  assert.equal(events.length, 1);
  assert.equal(events[0].allowed, false);
  assert.equal(events[0].reason, 'aborted');
});

// ── 4. shutdown cancellation ──────────────────────────────────────────

test('XA4 shutdown cancellation resolves false, reason=shutdown, cleanup occurs, exactly one event', async () => {
  const h = buildXApprovalHarness();
  const child = { name: 'child' };
  h.setServerProcess(child);
  const record = { abort: new AbortController() };
  const promise = h.requestXApproval(record, child, 'do X thing');
  const [requestId] = h.pendingXApprovals.keys();
  const pending = h.pendingXApprovals.get(requestId);

  h.setXShuttingDown(true);
  pending.cancel(); // exactly how app.on('before-quit')'s drain loop calls it

  const allowed = await promise;
  assert.equal(allowed, false);
  assert.equal(h.pendingXApprovals.size, 0);
  assert.equal(h.localApprovals.size, 0);
  const events = resolvedEventsFor(h.sent, requestId);
  assert.equal(events.length, 1);
  assert.equal(events[0].allowed, false);
  assert.equal(events[0].reason, 'shutdown');
});

// ── 5. isolation from the HTTP child relay ────────────────────────────

test('XA5 server:respond-approval settles a pendingXApprovals requestId locally and never relays it to the HTTP child', async () => {
  const h = buildXApprovalHarness();
  const child = { name: 'child', send: () => { throw new Error('serverProcess.send must never be called for an X approval'); } };
  h.setServerProcess(child);
  const record = { abort: new AbortController() };
  const promise = h.requestXApproval(record, child, 'do X thing');
  const [requestId] = h.pendingXApprovals.keys();

  const result = h.respondApproval({ requestId, allowed: true });
  assert.equal(result, true, 'must return true immediately');

  const allowed = await promise;
  assert.equal(allowed, true, 'must have resolved locally');
});

// ── 6. duplicate / late settlement ────────────────────────────────────

test('XA6 a second settlement attempt after resolution (user) is a harmless no-op', async () => {
  const h = buildXApprovalHarness();
  // A late/duplicate server:respond-approval for an already-settled X
  // requestId correctly falls through to the generic serverProcess relay
  // (real production behavior: the actual HTTP child would just ignore an
  // unknown requestId) -- give the fake child a harmless send() so that
  // existing, accepted fallthrough doesn't itself crash the test double.
  const child = { name: 'child', send: () => {} };
  h.setServerProcess(child);
  const record = { abort: new AbortController() };
  const promise = h.requestXApproval(record, child, 'do X thing');
  const [requestId] = h.pendingXApprovals.keys();

  h.respondApproval({ requestId, allowed: true });
  const allowed = await promise;
  assert.equal(allowed, true);
  const countAfterFirst = resolvedEventsFor(h.sent, requestId).length;
  assert.equal(countAfterFirst, 1);

  // Late/duplicate arrivals via every remaining settlement path:
  h.respondApproval({ requestId, allowed: false }); // duplicate user response
  const timeoutHandle = h.timers.scheduled.find((t) => t.delay === 60000);
  timeoutHandle.fn(); // the timer (already cleared, but simulate a race anyway)
  record.abort.abort(); // late abort

  assert.equal(resolvedEventsFor(h.sent, requestId).length, countAfterFirst, 'no duplicate approval:resolved event may be emitted');
  assert.equal(h.pendingXApprovals.size, 0);
  assert.equal(h.localApprovals.size, 0);
});

test('XA6b a second settlement attempt after timeout is a harmless no-op', () => {
  const h = buildXApprovalHarness();
  const child = { name: 'child', send: () => {} }; // see XA6's comment
  h.setServerProcess(child);
  const record = { abort: new AbortController() };
  h.requestXApproval(record, child, 'do X thing');
  const [requestId] = h.pendingXApprovals.keys();
  const timeoutHandle = h.timers.scheduled.find((t) => t.delay === 60000);

  timeoutHandle.fn();
  const countAfterFirst = resolvedEventsFor(h.sent, requestId).length;
  assert.equal(countAfterFirst, 1);

  timeoutHandle.fn(); // firing the same (already-cleared) handle again
  h.respondApproval({ requestId, allowed: true }); // late user response

  assert.equal(resolvedEventsFor(h.sent, requestId).length, countAfterFirst);
});

// ── 7. child/startup invalidation ─────────────────────────────────────

test('XA7 xShuttingDown before admission settles false with reason=shutdown and leaves no pending state', async () => {
  const h = buildXApprovalHarness();
  const child = { name: 'child' };
  h.setServerProcess(child);
  h.setXShuttingDown(true);
  const record = { abort: new AbortController() };

  const allowed = await h.requestXApproval(record, child, 'do X thing');

  assert.equal(allowed, false);
  assert.equal(h.pendingXApprovals.size, 0, 'no pending approval state may be left behind');
  assert.equal(h.localApprovals.size, 0);
  const events = h.sent.filter((m) => m.type === 'approval:resolved');
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, 'shutdown');
  assert.equal(h.sent.some((m) => m.type === 'approval'), false, 'no approval prompt may be shown for an already-invalid request');
});

test('XA7b serverProcess !== child before admission settles false with reason=aborted and leaves no pending state', async () => {
  const h = buildXApprovalHarness();
  const child = { name: 'child' };
  const otherProcess = { name: 'a different, newer child' };
  h.setServerProcess(otherProcess); // simulates the child having already been replaced
  const record = { abort: new AbortController() };

  const allowed = await h.requestXApproval(record, child, 'do X thing');

  assert.equal(allowed, false);
  assert.equal(h.pendingXApprovals.size, 0);
  assert.equal(h.localApprovals.size, 0);
  const events = h.sent.filter((m) => m.type === 'approval:resolved');
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, 'aborted');
  assert.equal(h.sent.some((m) => m.type === 'approval'), false);
});
