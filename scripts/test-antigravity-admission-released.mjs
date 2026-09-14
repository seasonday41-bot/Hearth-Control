// Focused tests for the post-release notification plumbing added to
// mcp/executors/antigravity-admission.mjs: onAntigravityAdmissionReleased()
// must fire strictly AFTER releaseAntigravityAdmission()'s own persisted
// claimStore.release(...) call has already returned true -- never before,
// never on a false/thrown release, never merely because a task transitioned.
// This is plumbing only; it must never change admission/release semantics.
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { XClaimStore } from '../mcp/x/claim-store.mjs';
import {
  acquireAntigravityAdmission,
  releaseAntigravityAdmission,
  hasAntigravityAdmission,
  antigravityClaimTaskId,
  onAntigravityAdmissionReleased,
  __resetAntigravityAdmissionsForTests,
} from '../mcp/executors/antigravity-admission.mjs';

const dirs = [];
const stores = [];
const unsubscribers = [];
const acquiredIds = new Set();

function tmpStorePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-ag-release-notify-'));
  dirs.push(dir);
  return path.join(dir, 'hearth-runtime.sqlite');
}
function makeStore(storagePath, opts = {}) {
  const store = new XClaimStore({ storagePath, ...opts });
  stores.push(store);
  return store;
}
async function acquire(params) {
  const result = await acquireAntigravityAdmission(params);
  if (result.ok && result.record) acquiredIds.add(params.taskId);
  return result;
}

afterEach(async () => {
  for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
  for (const id of [...acquiredIds]) {
    await releaseAntigravityAdmission(id);
    acquiredIds.delete(id);
  }
  __resetAntigravityAdmissionsForTests();
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const alwaysActive = () => true;
const neverInvoked = () => { throw new Error('onOwnershipLost must not be called in this test'); };

// ── 1-2: successful release notifies exactly once, with the right taskId ───

test('1-2 successful persisted release notifies exactly once, after the claim is already gone, with the original taskId', async () => {
  const storagePath = tmpStorePath();
  const claimStore = makeStore(storagePath);
  const taskId = 'ag-task-1';

  const calls = [];
  unsubscribers.push(onAntigravityAdmissionReleased((event) => {
    // Observe, from inside the listener itself, that the shared claim is
    // ALREADY gone by the time this fires.
    calls.push({ event, activeClaim: claimStore.getActiveClaim(antigravityClaimTaskId(taskId)) });
  }));

  const result = await acquire({
    claimStore, taskId, ownerId: 'owner-1',
    isActive: alwaysActive, onOwnershipLost: neverInvoked,
  });
  assert.equal(result.ok, true);

  const released = await releaseAntigravityAdmission(taskId);
  acquiredIds.delete(taskId);
  assert.equal(released, true);

  assert.equal(calls.length, 1, 'the listener must fire exactly once');
  assert.equal(calls[0].event.taskId, taskId, 'the listener must receive the original Antigravity taskId');
  assert.equal(calls[0].activeClaim, null, 'the shared claim must already be gone when the listener observes it');
});

// ── 3-4: a non-successful release never notifies ────────────────────────────

test('3 claimStore.release() returning false does not notify', async () => {
  const storagePath = tmpStorePath();
  const claimStore = makeStore(storagePath);
  const taskId = 'ag-task-3';

  let calls = 0;
  unsubscribers.push(onAntigravityAdmissionReleased(() => { calls += 1; }));

  const result = await acquire({
    claimStore, taskId, ownerId: 'owner-3',
    isActive: alwaysActive, onOwnershipLost: neverInvoked,
  });
  assert.equal(result.ok, true);

  const originalRelease = claimStore.release.bind(claimStore);
  claimStore.release = () => false;

  const released = await releaseAntigravityAdmission(taskId);
  acquiredIds.delete(taskId);
  assert.equal(released, false);
  assert.equal(calls, 0, 'no notification for a release that returned false');

  claimStore.release = originalRelease;
});

test('4 claimStore.release() throwing does not notify, and releaseAntigravityAdmission still returns false', async () => {
  const storagePath = tmpStorePath();
  const claimStore = makeStore(storagePath);
  const taskId = 'ag-task-4';

  let calls = 0;
  unsubscribers.push(onAntigravityAdmissionReleased(() => { calls += 1; }));

  const result = await acquire({
    claimStore, taskId, ownerId: 'owner-4',
    isActive: alwaysActive, onOwnershipLost: neverInvoked,
  });
  assert.equal(result.ok, true);

  const originalRelease = claimStore.release.bind(claimStore);
  claimStore.release = () => { throw new Error('simulated release failure'); };

  const released = await releaseAntigravityAdmission(taskId);
  acquiredIds.delete(taskId);
  assert.equal(released, false);
  assert.equal(calls, 0, 'no notification for a release that threw');

  claimStore.release = originalRelease;
});

// ── 5: a throwing listener is contained ─────────────────────────────────────

test('5 a throwing notification listener does not change the release result and does not block other listeners', async () => {
  const storagePath = tmpStorePath();
  const claimStore = makeStore(storagePath);
  const taskId = 'ag-task-5';

  let secondListenerCalls = 0;
  unsubscribers.push(onAntigravityAdmissionReleased(() => { throw new Error('listener boom'); }));
  unsubscribers.push(onAntigravityAdmissionReleased(() => { secondListenerCalls += 1; }));

  const result = await acquire({
    claimStore, taskId, ownerId: 'owner-5',
    isActive: alwaysActive, onOwnershipLost: neverInvoked,
  });
  assert.equal(result.ok, true);

  const released = await releaseAntigravityAdmission(taskId);
  acquiredIds.delete(taskId);

  assert.equal(released, true, 'a throwing listener must not change the successful release result');
  assert.equal(secondListenerCalls, 1, 'a throwing listener must not prevent a later listener from being called');
});

// ── 6: idempotent release notifies only once ────────────────────────────────

test('6 calling releaseAntigravityAdmission again after already released does not notify a second time', async () => {
  const storagePath = tmpStorePath();
  const claimStore = makeStore(storagePath);
  const taskId = 'ag-task-6';

  let calls = 0;
  unsubscribers.push(onAntigravityAdmissionReleased(() => { calls += 1; }));

  const result = await acquire({
    claimStore, taskId, ownerId: 'owner-6',
    isActive: alwaysActive, onOwnershipLost: neverInvoked,
  });
  assert.equal(result.ok, true);

  const first = await releaseAntigravityAdmission(taskId);
  const second = await releaseAntigravityAdmission(taskId);
  const third = await releaseAntigravityAdmission(taskId);
  acquiredIds.delete(taskId);

  assert.equal(first, true);
  assert.equal(second, true);
  assert.equal(third, true);
  assert.equal(calls, 1, 'idempotent re-release must not notify again');
});

// ── 7: unsubscribe ───────────────────────────────────────────────────────

test('7 the unsubscribe function stops a listener from being called', async () => {
  const storagePath = tmpStorePath();
  const claimStore = makeStore(storagePath);
  const taskId = 'ag-task-7';

  let calls = 0;
  const unsubscribe = onAntigravityAdmissionReleased(() => { calls += 1; });
  unsubscribe();

  const result = await acquire({
    claimStore, taskId, ownerId: 'owner-7',
    isActive: alwaysActive, onOwnershipLost: neverInvoked,
  });
  assert.equal(result.ok, true);

  await releaseAntigravityAdmission(taskId);
  acquiredIds.delete(taskId);

  assert.equal(calls, 0, 'a removed listener must never be called');
});

// ── 8: existing admission/release behavior is unchanged ───────────────────

test('8 existing admission/release behavior (acquire, hasAntigravityAdmission, release) is unchanged', async () => {
  const storagePath = tmpStorePath();
  const claimStore = makeStore(storagePath);
  const taskId = 'ag-task-8';

  const result = await acquire({
    claimStore, taskId, ownerId: 'owner-8',
    isActive: alwaysActive, onOwnershipLost: neverInvoked,
  });
  assert.equal(result.ok, true);
  assert.equal(hasAntigravityAdmission(taskId), true);
  assert.equal(claimStore.getActiveClaim(antigravityClaimTaskId(taskId)).ownerId, 'owner-8');

  const released = await releaseAntigravityAdmission(taskId);
  acquiredIds.delete(taskId);
  assert.equal(released, true);
  assert.equal(hasAntigravityAdmission(taskId), false);
  assert.equal(claimStore.getActiveClaim(antigravityClaimTaskId(taskId)), null);

  // No listener registered in this test -- confirms the notification
  // plumbing is entirely opt-in and inert by default.
  const secondRelease = await releaseAntigravityAdmission(taskId);
  assert.equal(secondRelease, true);
});
