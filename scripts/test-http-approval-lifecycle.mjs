// Focused tests for the HTTP-child-owned approval lifecycle in mcp/http.mjs:
// settleApproval as the single settlement point for every resolution path
// (a matching approval:result, the 60s timeout, no transport at all, and
// shutdown), and the approval:resolved notification it sends on each one.
//
// mcp/http.mjs has real module-level side effects (express() construction,
// a real app.listen() TCP bind, process.on('message'/'SIGTERM'/'disconnect')
// registered against the actual test process) so it cannot be imported
// directly in a plain Node test process -- same constraint
// scripts/test-updater.mjs, scripts/test-electron-x-wakeup.mjs, and
// scripts/test-electron-window-lifecycle.mjs already work around. This
// suite extracts the EXACT committed settleApproval/requestApproval/
// message-handler/shutdown text and executes it via a factory wrapper
// against fake crypto/process/timer/listener doubles -- never a
// hand-copied duplicate of the logic.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const httpSource = fs.readFileSync(new URL('../mcp/http.mjs', import.meta.url), 'utf8');

// ── extraction ───────────────────────────────────────────────────────────

const approvalBlockStart = httpSource.indexOf('const settleApproval = (requestId, allowed, reason) => {');
const approvalBlockEnd = httpSource.indexOf("\n\napp.get('/health'");
assert.ok(approvalBlockStart !== -1 && approvalBlockEnd !== -1, 'the settleApproval/requestApproval/message-handler block must be found in mcp/http.mjs');
const approvalBlockSource = httpSource.slice(approvalBlockStart, approvalBlockEnd);

const shutdownBlockStart = httpSource.indexOf('const shutdown = () => {');
assert.ok(shutdownBlockStart !== -1, 'the shutdown block must be found in mcp/http.mjs');
const shutdownBlockSource = httpSource.slice(shutdownBlockStart).trimEnd();

/**
 * Builds a fresh, isolated instance of the EXACT settleApproval/
 * requestApproval/message-handler/shutdown text extracted above, sharing
 * the same `approvals` Map they all close over in the real file. `withSend`
 * false omits `process.send` entirely, reproducing the real "no IPC
 * transport" branch exactly as mcp/http.mjs's own `if (process.send)`
 * check would see it.
 */
function buildApprovalHarness({ withSend = true } = {}) {
  const sent = [];
  const listenerCalls = { close: 0 };
  const fakeListener = { close(cb) { listenerCalls.close += 1; cb?.(); } };
  const timers = { scheduled: [] };
  const fakeSetTimeout = (fn, delay) => {
    const handle = { fn, delay, cleared: false };
    timers.scheduled.push(handle);
    return handle;
  };
  const fakeClearTimeout = (handle) => { if (handle) handle.cleared = true; };

  const messageListeners = [];
  const fakeProcessBase = {
    on(event, cb) { if (event === 'message') messageListeners.push(cb); return fakeProcessBase; },
    exit() { /* no-op in tests */ },
  };
  const fakeProcess = withSend ? { ...fakeProcessBase, send: (msg) => sent.push(msg) } : fakeProcessBase;

  let uuidCounter = 0;
  const fakeCrypto = { randomUUID: () => `req-${++uuidCounter}` };
  const queueReplies = new Map();
  const permissions = {};
  const queueError = (code) => Object.assign(new Error(code), { code });

  const factorySource = `
    const approvals = new Map();
    ${approvalBlockSource}
    ${shutdownBlockSource}
    return { settleApproval, requestApproval, approvals, shutdown };
  `;
  const factory = new Function(
    'crypto', 'process', 'setTimeout', 'clearTimeout', 'queueReplies', 'permissions', 'queueError', 'listener',
    factorySource,
  );
  const instance = factory(fakeCrypto, fakeProcess, fakeSetTimeout, fakeClearTimeout, queueReplies, permissions, queueError, fakeListener);

  return {
    ...instance,
    sent,
    timers,
    listenerCalls,
    triggerMessage: (message) => { for (const cb of messageListeners) cb(message); },
  };
}

// ── dynamic: the exact extracted code, executed against fake doubles ─────

test('HTTP-A1 a matching approval:result settles the pending approval with reason user', async () => {
  const h = buildApprovalHarness();
  const promise = h.requestApproval({ permission: 'Antigravity', action: 'do thing' });
  assert.equal(h.approvals.size, 1);
  const [requestId] = h.approvals.keys();
  h.triggerMessage({ type: 'approval:result', requestId, allowed: true });
  const allowed = await promise;
  assert.equal(allowed, true);
  assert.equal(h.approvals.size, 0, 'the pending entry must be removed once settled');
  const resolvedEvents = h.sent.filter((m) => m.type === 'approval:resolved');
  assert.equal(resolvedEvents.length, 1);
  assert.equal(resolvedEvents[0].requestId, requestId);
  assert.equal(resolvedEvents[0].allowed, true);
  assert.equal(resolvedEvents[0].reason, 'user');
});

test('HTTP-A2 an approval:result for an unknown requestId is a harmless no-op', () => {
  const h = buildApprovalHarness();
  h.requestApproval({ permission: 'Antigravity', action: 'do thing' });
  assert.equal(h.approvals.size, 1);
  h.triggerMessage({ type: 'approval:result', requestId: 'not-a-real-id', allowed: true });
  assert.equal(h.approvals.size, 1, 'the real pending approval must remain untouched');
  assert.equal(h.sent.filter((m) => m.type === 'approval:resolved').length, 0, 'no lifecycle event may fire for an unknown requestId');
});

test('HTTP-A3 the 60s timeout settles false with reason timeout and removes the pending entry', () => {
  const h = buildApprovalHarness();
  h.requestApproval({ permission: 'Antigravity', action: 'do thing' });
  assert.equal(h.approvals.size, 1);
  const [requestId] = h.approvals.keys();
  const timeoutHandle = h.timers.scheduled.find((t) => t.delay === 60000);
  assert.ok(timeoutHandle, 'a 60s timer must have been scheduled');
  timeoutHandle.fn(); // fire it directly -- never a real wall-clock wait
  assert.equal(h.approvals.size, 0);
  const resolvedEvents = h.sent.filter((m) => m.type === 'approval:resolved');
  assert.equal(resolvedEvents.length, 1);
  assert.equal(resolvedEvents[0].requestId, requestId);
  assert.equal(resolvedEvents[0].allowed, false);
  assert.equal(resolvedEvents[0].reason, 'timeout');
});

test('HTTP-A4 with no process.send transport, the approval settles immediately with reason aborted and leaks nothing', async () => {
  const h = buildApprovalHarness({ withSend: false });
  const allowed = await h.requestApproval({ permission: 'Antigravity', action: 'do thing' });
  assert.equal(allowed, false);
  assert.equal(h.approvals.size, 0, 'no pending entry may be left behind');
  assert.equal(h.sent.length, 0, 'no process.send exists, so no notification could have been sent');
});

test('HTTP-A5 shutdown drains every pending approval with reason shutdown', async () => {
  const h = buildApprovalHarness();
  const first = h.requestApproval({ permission: 'Antigravity', action: 'first' });
  const second = h.requestApproval({ permission: 'Terminal', action: 'second' });
  assert.equal(h.approvals.size, 2);
  h.shutdown();
  assert.deepEqual(
    await Promise.all([first, second]),
    [false, false],
    'shutdown must settle every pending approval false',
  );
  assert.equal(h.approvals.size, 0, 'no pending approval may survive shutdown');
  const resolvedEvents = h.sent.filter((m) => m.type === 'approval:resolved' && m.reason === 'shutdown');
  assert.equal(resolvedEvents.length, 2, 'both pending approvals must settle with reason shutdown');
  assert.ok(
    resolvedEvents.every((event) => event.allowed === false),
    'every shutdown approval:resolved event must report allowed=false',
  );
  assert.equal(
    h.timers.scheduled.filter((timer) => !timer.cleared).length,
    0,
    'shutdown must clear every pending approval timer',
  );
  assert.equal(h.listenerCalls.close, 1, 'shutdown must still close the listener');
});

test('HTTP-A6 a duplicate or late resolution after settlement is a harmless no-op', async () => {
  const h = buildApprovalHarness();
  const promise = h.requestApproval({ permission: 'Antigravity', action: 'do thing' });
  const [requestId] = h.approvals.keys();
  h.triggerMessage({ type: 'approval:result', requestId, allowed: true });
  const allowed = await promise;
  assert.equal(allowed, true);
  const sentAfterFirst = h.sent.filter((m) => m.type === 'approval:resolved').length;
  assert.equal(sentAfterFirst, 1);
  h.triggerMessage({ type: 'approval:result', requestId, allowed: false }); // late/duplicate arrival
  assert.equal(
    h.sent.filter((m) => m.type === 'approval:resolved').length,
    sentAfterFirst,
    'a second settlement attempt for an already-settled requestId must not emit a second lifecycle event',
  );
  assert.equal(h.approvals.size, 0);
});
