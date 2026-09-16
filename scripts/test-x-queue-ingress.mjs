import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { XQueueStore } from '../mcp/x/queue-store.mjs';
import { XClaimStore } from '../mcp/x/claim-store.mjs';
import { parseXTask } from '../mcp/x/task-contract.mjs';
import { canonicalJson, canonicalizeXTask, computeXTaskFingerprint } from '../mcp/x/fingerprint.mjs';
import { getNextXQueueCapacityDeadline, __resetProductionXRuntimeForTests } from '../mcp/x/production-runtime.mjs';

const source = fs.readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
const start = source.indexOf('const xQueueError = (code) =>');
const end = source.indexOf('// Fast-restart X liveness:', start);
assert.ok(start >= 0 && end > start);
const mainIngressSource = source.slice(start, end);
const httpSource = fs.readFileSync(new URL('../mcp/http.mjs', import.meta.url), 'utf8');
const transportStart = httpSource.indexOf('const queueReplies = new Map();');
const transportEnd = httpSource.indexOf('onAntigravityAdmissionReleased(() => {', transportStart);
assert.ok(transportStart >= 0 && transportEnd > transportStart);
const httpTransportSource = httpSource.slice(transportStart, transportEnd);
const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function taskFor(root, objective = 'Queue one task') {
  return {
    version: 'x-task-v1', task_id: 'task-1', parent_task_id: null, revision: 1, attempt: 1,
    based_on_result_id: null, objective, problem: 'Need a queue', expected_behavior: 'Queued once',
    observed_behavior: 'No ingress', why_this_matters: 'Idempotency', known_evidence: [], suspected_area: [],
    workspace: { repo: 'fixture', root }, scope: { allowed_paths: ['src'], preferred_files: [], forbidden_paths: [] },
    constraints: { preserve: [], do_not: [] }, allowed_tools: ['repo_read'], acceptance_criteria: ['Queued'],
    validation: { required: ['test'], optional: [] }, done_criteria: ['Done'], teaching_notes: [],
    uncertainty_policy: { policy: 'stop', stop_conditions: [] },
    repair_budget: { initial_attempts: 1, max_repairs: 0, max_total_rounds: 1 },
    timing: { estimated_minutes: 1, first_check_after_minutes: 1, soft_deadline_minutes: 1, hard_timeout_minutes: 1 },
    commit_policy: { mode: 'never' },
  };
}

function harness(permission = 'Allow', persistedRun = null, fsImpl = fs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-x-ingress-'));
  dirs.push(root);
  fs.mkdirSync(path.join(root, 'src'));
  const store = new XQueueStore({ storagePath: path.join(root, 'x-queue.json') }).load();
  const child = { pid: 1 };
  const settings = { workspace: root, permissions: { X: permission } };
  const events = [];
  const timers = [];
  const localApprovals = new Map();
  let enqueueCount = 0;
  const coordinator = { enqueue(task, identity) { enqueueCount += 1; return store.enqueueWithReceipt(task, identity); } };
  const factory = new Function(
    'fs', 'crypto', 'xQueueStore', 'xQueueCoordinator', 'xParseTask', 'xRunStore',
    'readSettings', 'sendEvent', 'serverProcess', 'xQueueDispatchEnabled', 'xShuttingDown', 'localApprovals', 'setTimeout', 'clearTimeout',
    'canonicalJson', 'canonicalizeXTask', 'computeXTaskFingerprint',
    `const xQueueInflight = new Map(); const xQueueRequests = new Map(); const pendingXApprovals = new Map();
     ${mainIngressSource}
     return { handleXQueueEnqueue, cancelXQueueRequest, cancelXQueueChild, xQueueReceiptStatus,
       xQueueRequests, localApprovals, pendingXApprovals };`,
  );
  const api = factory(fsImpl, crypto, store, coordinator, parseXTask, { getRun: () => persistedRun },
    () => settings, (event) => events.push(event), child, true, false, localApprovals,
    (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    (timer) => { timer.cleared = true; },
    canonicalJson, canonicalizeXTask, computeXTaskFingerprint);
  const request = (transportId, task = taskFor(root), requestId = 'request-1') => {
    const waiter = { transportId, child, active: true, inflight: null };
    api.xQueueRequests.set(transportId, waiter);
    return api.handleXQueueEnqueue({ requestId, task, workspace: settings.workspace }, child, settings.workspace, waiter);
  };
  return { root, store, child, settings, events, timers, api, request, get enqueueCount() { return enqueueCount; } };
}

async function waitForApproval(h) {
  for (let attempt = 0; attempt < 100 && h.events.length === 0; attempt += 1) await sleep(2);
  assert.equal(h.events.length, 1);
  return h.events[0].requestId;
}

test('main validates and fingerprints independently, and rejects a changed request_id payload', async () => {
  const h = harness();
  const first = await h.request('transport-1');
  assert.equal(first.accepted, true);
  assert.equal(first.run_id, null);
  assert.equal((await h.request('transport-2')).queue_id, first.queue_id);
  assert.equal(h.enqueueCount, 1);
  await assert.rejects(h.request('transport-3', taskFor(h.root, 'Different objective')), { code: 'request_id_conflict' });
  await assert.rejects(h.request('transport-4', { ...taskFor(h.root), unknown: true }, 'request-2'), { code: 'INVALID_X_TASK' });
  assert.equal(h.enqueueCount, 1);
});

test('concurrent equal fingerprints share one X approval and one durable entry', async () => {
  const h = harness('Ask');
  const first = h.request('transport-1');
  const second = h.request('transport-2');
  const approvalId = await waitForApproval(h);
  h.api.localApprovals.get(approvalId)(true);
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one.queue_id, two.queue_id, 'both coalesced callers receive the SAME durable queue_id');
  assert.equal(h.enqueueCount, 1, 'exactly one durable queue entry for two concurrent equal-fingerprint requests');
  // Exactly one approval was ever requested and exactly one resolution was
  // ever sent for it -- coalescing must never re-prompt a second time, and
  // resolving it must never emit a second, duplicate settlement event. This
  // is two events in total by design ('approval' then 'approval:resolved'
  // once localApprovals.get(approvalId)(true) settles it above), not one.
  const approvalRequests = h.events.filter((e) => e.type === 'approval');
  const approvalResolutions = h.events.filter((e) => e.type === 'approval:resolved');
  assert.equal(approvalRequests.length, 1, 'exactly one approval request for two coalesced callers');
  assert.equal(approvalResolutions.length, 1, 'exactly one approval resolution, matching the single request');
  assert.equal(approvalResolutions[0].requestId, approvalRequests[0].requestId);
  assert.equal(approvalResolutions[0].allowed, true);
  assert.equal(h.events.length, approvalRequests.length + approvalResolutions.length, 'no other event type was emitted');
  assert.equal(h.api.pendingXApprovals.size, 0);
});

test('one disconnected waiter does not cancel another waiter for the same approved request', async () => {
  const h = harness('Ask');
  const first = h.request('transport-1');
  const second = h.request('transport-2');
  const approvalId = await waitForApproval(h);
  h.api.cancelXQueueRequest('transport-1');
  h.api.localApprovals.get(approvalId)(true);
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one.queue_id, two.queue_id);
  assert.equal(h.enqueueCount, 1);
});

test('conflicting in-flight fingerprint fails before a second approval', async () => {
  const h = harness('Ask');
  const first = h.request('transport-1');
  const approvalId = await waitForApproval(h);
  await assert.rejects(h.request('transport-2', taskFor(h.root, 'Changed')), { code: 'request_id_conflict' });
  assert.equal(h.events.length, 1);
  h.api.localApprovals.get(approvalId)(true);
  await first;
  assert.equal(h.enqueueCount, 1);
});

test('last requester/child loss before approval aborts without a ghost enqueue', async () => {
  const h = harness('Ask');
  const pending = h.request('transport-1');
  const approvalId = await waitForApproval(h);
  h.api.cancelXQueueChild(h.child);
  await assert.rejects(pending, { code: 'permission_denied' });
  assert.equal(h.api.localApprovals.has(approvalId), false);
  assert.equal(h.store.getReceipt('request-1'), null);
  assert.equal(h.enqueueCount, 0);
});

test('disconnect while resolving workspace paths cannot create a ghost enqueue', async () => {
  let releasePaths;
  const pathsReady = new Promise((resolve) => { releasePaths = resolve; });
  const delayedFs = {
    promises: { realpath: async (target) => { await pathsReady; return fs.promises.realpath(target); } },
  };
  const h = harness('Allow', null, delayedFs);
  const pending = h.request('transport-1');
  h.api.cancelXQueueRequest('transport-1');
  releasePaths();
  await assert.rejects(pending, { code: 'transport_unavailable' });
  assert.equal(h.enqueueCount, 0);
  assert.equal(h.store.getReceipt('request-1'), null);
  assert.equal(h.events.length, 0);
});

test('disconnect during final workspace recheck cannot commit the queue entry', async () => {
  let releaseFinalPath;
  let finalPathStarted;
  const finalPathReady = new Promise((resolve) => { releaseFinalPath = resolve; });
  const finalPathReached = new Promise((resolve) => { finalPathStarted = resolve; });
  let realpathCalls = 0;
  const delayedFs = {
    promises: { realpath: async (target) => {
      realpathCalls += 1;
      if (realpathCalls === 5) { finalPathStarted(); await finalPathReady; }
      return fs.promises.realpath(target);
    } },
  };
  const h = harness('Allow', null, delayedFs);
  const pending = h.request('transport-1');
  await finalPathReached;
  h.api.cancelXQueueRequest('transport-1');
  releaseFinalPath();
  await assert.rejects(pending, { code: 'transport_unavailable' });
  assert.equal(h.enqueueCount, 0);
  assert.equal(h.store.getReceipt('request-1'), null);
});

test('unset X defaults to Ask; approval expires at 60000ms; Blocked never asks', async () => {
  const h = harness(null);
  const pending = h.request('transport-1');
  await waitForApproval(h);
  assert.equal(h.timers[0].ms, 60000);
  h.timers[0].fn();
  await assert.rejects(pending, { code: 'permission_denied' });
  assert.equal(h.store.getReceipt('request-1'), null);
  const blocked = harness('Blocked');
  await assert.rejects(blocked.request('transport-2'), { code: 'permission_blocked' });
  assert.equal(blocked.events.length, 0);
});

test('loss after durable commit does not remove the job; replay survives workspace change', async () => {
  const h = harness();
  const original = await h.request('transport-1');
  h.api.cancelXQueueChild(h.child);
  assert.equal(h.store.listPending().length, 1);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-x-other-'));
  dirs.push(other);
  h.settings.workspace = other;
  const replay = await h.request('transport-2', taskFor(h.root));
  assert.equal(replay.queue_id, original.queue_id);
  assert.equal(h.enqueueCount, 1);
  await assert.rejects(h.request('transport-3', taskFor(other), 'request-2'), { code: 'workspace_mismatch' });
});

test('degraded store blocks even an enqueue replay while read-only receipt status remains available', async () => {
  const h = harness();
  await h.request('transport-1');
  h.store.recoveryRequired = true;
  await assert.rejects(h.request('transport-2'), { code: 'queue_recovery_required' });
  assert.equal(h.api.xQueueReceiptStatus(h.store.getReceipt('request-1')).found, true);
  assert.equal(h.enqueueCount, 1);
});

test('terminal status reports retained SQLite detail without inventing pruned execution detail', async () => {
  const h = harness('Allow', {
    status: 'completed', gateStatus: 'COMPLETED', hearthOutcome: 'completed',
    error: null, result: { version: 'x-result-v1' },
  });
  const accepted = await h.request('transport-1');
  h.store.markDispatching(accepted.queue_id, 'run-1');
  h.store.markDispatched(accepted.queue_id, 'run-1');
  h.store.markTerminal(accepted.queue_id, 'completed');
  const retained = h.api.xQueueReceiptStatus(h.store.getReceipt('request-1'));
  assert.equal(retained.execution_detail_available, true);
  assert.equal(retained.gate_status, 'COMPLETED');
  assert.equal(retained.hearth_outcome, 'completed');
  assert.deepEqual(retained.result, { version: 'x-result-v1' });
  const reloaded = new XQueueStore({ storagePath: h.store.storagePath }).load();
  assert.equal(reloaded.getReceipt('request-1').terminalStatus, 'completed');
  assert.equal(reloaded.listDispatched().length, 0);
  const unavailable = harness();
  const other = await unavailable.request('transport-2');
  unavailable.store.markDispatching(other.queue_id, 'run-2');
  unavailable.store.markDispatched(other.queue_id, 'run-2');
  unavailable.store.markTerminal(other.queue_id, 'failed');
  const status = unavailable.api.xQueueReceiptStatus(unavailable.store.getReceipt('request-1'));
  assert.equal(status.execution_detail_available, false);
  assert.equal(status.terminal_status, 'failed');
  assert.equal(Object.hasOwn(status, 'result'), false);
});

function httpHarness() {
  const sent = [];
  const timers = [];
  const childProcess = { connected: true, send(message) { sent.push(message); } };
  const factory = new Function('crypto', 'process', 'setTimeout', 'clearTimeout',
    `${httpTransportSource} return { queueIngressTransportFor, queueReplies };`);
  const api = factory(crypto, childProcess,
    (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; }, () => {});
  const response = new EventEmitter();
  return { sent, timers, response, ...api, transport: api.queueIngressTransportFor(response) };
}

test('HTTP transport correlates an ack with transportId, separate from durable requestId', async () => {
  const h = httpHarness();
  const pending = h.transport.enqueue({ requestId: 'durable-1', task: { task_id: 'task-1' }, workspace: '/workspace' });
  assert.equal(h.sent[0].type, 'x_queue_enqueue_request');
  assert.equal(h.sent[0].requestId, 'durable-1');
  assert.match(h.sent[0].transportId, /^[0-9a-f-]{36}$/);
  assert.notEqual(h.sent[0].transportId, h.sent[0].requestId);
  assert.equal(h.timers[0].ms, 120000);
  h.queueReplies.get(h.sent[0].transportId).finish(null, { accepted: true, queue_id: 'queue-1' });
  assert.equal((await pending).queue_id, 'queue-1');
  assert.equal(h.queueReplies.size, 0);
});

test('HTTP transport timeout and disconnect cancel only uncommitted waiting round trips', async () => {
  const timed = httpHarness();
  const first = timed.transport.enqueue({ requestId: 'durable-1', task: {}, workspace: '/workspace' });
  timed.timers[0].fn();
  await assert.rejects(first, { code: 'transport_timeout' });
  assert.deepEqual(timed.sent[1], { type: 'x_queue_request_cancel', transportId: timed.sent[0].transportId });

  const disconnected = httpHarness();
  const second = disconnected.transport.status({ requestId: 'durable-1' });
  disconnected.response.emit('close');
  await assert.rejects(second, { code: 'transport_unavailable' });
  assert.deepEqual(disconnected.sent[1], { type: 'x_queue_request_cancel', transportId: disconnected.sent[0].transportId });
});

test('IPC ack loss after main commits is recovered by a fresh HTTP retry', async () => {
  const main = harness();
  const firstChild = httpHarness();
  const task = taskFor(main.root);
  const firstPending = firstChild.transport.enqueue({ requestId: 'request-1', task, workspace: main.root });
  const firstRequest = firstChild.sent[0];
  const firstWaiter = { transportId: firstRequest.transportId, child: main.child, active: true, inflight: null };
  main.api.xQueueRequests.set(firstRequest.transportId, firstWaiter);
  const accepted = await main.api.handleXQueueEnqueue(firstRequest, main.child, main.root, firstWaiter);
  assert.equal(main.store.getReceipt('request-1').queueId, accepted.queue_id);
  firstChild.response.emit('close'); // the committed ack never arrives
  main.api.cancelXQueueRequest(firstRequest.transportId);
  await assert.rejects(firstPending, { code: 'transport_unavailable' });

  const retryChild = httpHarness();
  const retryPending = retryChild.transport.enqueue({ requestId: 'request-1', task, workspace: main.root });
  const retryRequest = retryChild.sent[0];
  const retryWaiter = { transportId: retryRequest.transportId, child: main.child, active: true, inflight: null };
  main.api.xQueueRequests.set(retryRequest.transportId, retryWaiter);
  const receipt = await main.api.handleXQueueEnqueue(retryRequest, main.child, main.root, retryWaiter);
  retryChild.queueReplies.get(retryRequest.transportId).finish(null, receipt);
  assert.equal((await retryPending).queue_id, accepted.queue_id);
  assert.equal(main.enqueueCount, 1);
  assert.equal(main.store.listPending().length, 1);
});

test('Antigravity HTTP child release sends only a content-free capacity hint', () => {
  assert.match(httpSource, /onAntigravityAdmissionReleased\(\(\) => \{[\s\S]*?process\.send\(\{ type: 'x_capacity_released_hint' \}\)/);
  assert.match(source, /message\?\.type === 'x_capacity_released_hint'/);
});

test('shared capacity deadline reads an Antigravity lease and ignores claim kind', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-x-capacity-'));
  dirs.push(root);
  const previous = process.env.HEARTH_RUNTIME_DIR;
  process.env.HEARTH_RUNTIME_DIR = root;
  __resetProductionXRuntimeForTests();
  const claims = new XClaimStore({ storagePath: path.join(root, 'hearth-runtime.sqlite') });
  try {
    const claim = claims.claim({ taskId: 'antigravity:task-1', ownerId: 'test-owner' });
    assert.equal(getNextXQueueCapacityDeadline(), claim.leaseExpiresAt);
    claims.release({ taskId: claim.taskId, ownerId: claim.ownerId, leaseId: claim.leaseId });
    assert.equal(getNextXQueueCapacityDeadline(), null);
  } finally {
    claims.close();
    __resetProductionXRuntimeForTests();
    if (previous === undefined) delete process.env.HEARTH_RUNTIME_DIR;
    else process.env.HEARTH_RUNTIME_DIR = previous;
  }
});
