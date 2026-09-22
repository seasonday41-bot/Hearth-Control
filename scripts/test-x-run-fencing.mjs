import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

import { XClaimStore } from '../mcp/x/claim-store.mjs';
import { XRunStore } from '../mcp/x/run-store.mjs';

const fixtures = [];
function fixture({ leaseDurationMs = 10_000, queued = false, recordedLeaseId } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-x-run-fencing-'));
  const storagePath = path.join(dir, 'hearth-runtime.sqlite');
  const claims = new XClaimStore({ storagePath, leaseDurationMs });
  const otherClaims = new XClaimStore({ storagePath, leaseDurationMs });
  const runs = new XRunStore({ storagePath });
  const claim = claims.claim({ taskId: 'task-1', ownerId: 'owner-1' });
  runs.createRun({ runId: 'run-1', taskId: 'task-1', claimLeaseId: recordedLeaseId === undefined ? claim.leaseId : recordedLeaseId });
  if (!queued) runs.markRunning({ runId: 'run-1', claimLeaseId: recordedLeaseId === undefined ? claim.leaseId : recordedLeaseId });
  const item = { dir, storagePath, claims, otherClaims, runs, claim };
  fixtures.push(item);
  return item;
}

afterEach(() => {
  for (const item of fixtures.splice(0)) {
    item.runs.close();
    item.claims.close();
    item.otherClaims.close();
    fs.rmSync(item.dir, { recursive: true, force: true });
  }
});

const gate = (gate_status, hearth_outcome) => ({ gate_status, hearth_outcome });
const xResult = (gateResult, taskId = 'task-1') => ({
  version: 'x-result-v1', task_id: taskId,
  gate_status: gateResult.gate_status, hearth_outcome: gateResult.hearth_outcome,
});
const complete = (item, gateResult, overrides = {}) => item.runs.completeRunFenced({
  runId: 'run-1', ownerId: item.claim.ownerId, leaseId: item.claim.leaseId,
  gateResult, xResult: xResult(gateResult), ...overrides,
});
const fail = (item, overrides = {}) => item.runs.failRunFenced({
  runId: 'run-1', taskId: 'task-1', ownerId: item.claim.ownerId, leaseId: item.claim.leaseId,
  error: 'orchestration error', ...overrides,
});
const cancel = (item, overrides = {}) => item.runs.cancelRunFenced({
  runId: 'run-1', taskId: 'task-1', ownerId: item.claim.ownerId, leaseId: item.claim.leaseId,
  ...overrides,
});

for (const [gateStatus, hearthOutcome, runStatus] of [
  ['COMPLETED', 'completed', 'completed'],
  ['NEEDS_REVIEW', 'waiting', 'needs_review'],
  ['FAILED', 'error', 'failed'],
]) {
  test(`live owner persists ${gateStatus} through fenced completion`, () => {
    const item = fixture();
    const result = xResult(gate(gateStatus, hearthOutcome));
    const run = complete(item, gate(gateStatus, hearthOutcome), { xResult: result });
    assert.equal(run.status, runStatus);
    assert.equal(run.gateStatus, gateStatus);
    assert.deepEqual(run.result, result);
  });
}

test('wrong owner, lease, task, and recorded run lease cannot complete', () => {
  const item = fixture();
  const decision = gate('COMPLETED', 'completed');
  assert.equal(complete(item, decision, { ownerId: 'owner-2' }), null);
  assert.equal(complete(item, decision, { leaseId: 'wrong-lease' }), null);
  assert.equal(complete(item, decision, { xResult: xResult(decision, 'other-task') }), null);
  assert.equal(item.runs.getRun('run-1').status, 'running');

  const mismatched = fixture({ recordedLeaseId: 'not-the-claim-lease' });
  assert.equal(complete(mismatched, decision), null);
  assert.equal(mismatched.runs.getRun('run-1').status, 'running');
});

test('expired and released leases cannot complete', async () => {
  const expired = fixture({ leaseDurationMs: 35 });
  await sleep(80);
  assert.equal(complete(expired, gate('COMPLETED', 'completed')), null);
  assert.equal(expired.runs.getRun('run-1').status, 'running');

  const released = fixture();
  assert.equal(released.claims.release({ taskId: 'task-1', ownerId: released.claim.ownerId, leaseId: released.claim.leaseId }), true);
  assert.equal(complete(released, gate('COMPLETED', 'completed')), null);
  assert.equal(released.runs.getRun('run-1').status, 'running');
});

test('old owner cannot complete or fail its run after a second store reclaims', async () => {
  const item = fixture({ leaseDurationMs: 35 });
  await sleep(80);
  const newer = item.otherClaims.claim({ taskId: 'task-1', ownerId: 'owner-2' });
  assert.ok(newer);
  assert.notEqual(newer.leaseId, item.claim.leaseId);
  assert.equal(complete(item, gate('COMPLETED', 'completed')), null);
  assert.equal(fail(item), null);
  assert.equal(item.runs.getRun('run-1').status, 'running');
  assert.equal(item.otherClaims.getActiveClaim('task-1').leaseId, newer.leaseId);
});

test('live owner persists bounded orchestration failure without gate/result', () => {
  const item = fixture();
  const run = fail(item, { error: 'ก'.repeat(2000) });
  assert.equal(run.status, 'failed');
  assert.equal(run.gateStatus, null);
  assert.equal(run.hearthOutcome, null);
  assert.equal(run.result, null);
  assert.ok(Buffer.byteLength(run.error, 'utf8') <= 2000);
  assert.equal(run.error.includes('�'), false);
});

test('claimed queued run can fail only with its current recorded lease', () => {
  const item = fixture({ queued: true });
  assert.equal(fail(item, { leaseId: 'wrong-lease' }), null);
  assert.equal(fail(item, { ownerId: 'wrong-owner' }), null);
  assert.equal(fail(item, { taskId: 'other-task' }), null);
  assert.equal(item.runs.getRun('run-1').status, 'queued');
  assert.equal(fail(item).status, 'failed');

  const unclaimed = fixture({ queued: true, recordedLeaseId: null });
  assert.equal(fail(unclaimed), null);
  assert.equal(unclaimed.runs.getRun('run-1').status, 'queued');

  const mismatched = fixture({ queued: true, recordedLeaseId: 'not-the-claim-lease' });
  assert.equal(fail(mismatched), null);
  assert.equal(mismatched.runs.getRun('run-1').status, 'queued');
});

test('live owner can persist explicit cancellation without gate/result/error', () => {
  const item = fixture();
  const run = cancel(item);
  assert.equal(run.status, 'cancelled');
  assert.equal(run.gateStatus, null);
  assert.equal(run.hearthOutcome, null);
  assert.equal(run.result, null);
  assert.equal(run.error, null);
  assert.equal(item.runs.hasNonTerminalRunForClaimLease(item.claim.leaseId), false);
});

test('claimed queued run can be cancelled only by its current recorded live lease', () => {
  const item = fixture({ queued: true });
  assert.equal(cancel(item, { leaseId: 'wrong-lease' }), null);
  assert.equal(cancel(item, { ownerId: 'wrong-owner' }), null);
  assert.equal(cancel(item, { taskId: 'other-task' }), null);
  assert.equal(item.runs.getRun('run-1').status, 'queued');
  assert.equal(cancel(item).status, 'cancelled');

  const unclaimed = fixture({ queued: true, recordedLeaseId: null });
  assert.equal(cancel(unclaimed), null);
  assert.equal(unclaimed.runs.getRun('run-1').status, 'queued');
});

test('expired, released, and reclaimed leases cannot cancel a run', async () => {
  const expired = fixture({ leaseDurationMs: 35 });
  await sleep(80);
  assert.equal(cancel(expired), null);
  assert.equal(expired.runs.getRun('run-1').status, 'running');

  const released = fixture();
  assert.equal(released.claims.release({ taskId: 'task-1', ownerId: released.claim.ownerId, leaseId: released.claim.leaseId }), true);
  assert.equal(cancel(released), null);
  assert.equal(released.runs.getRun('run-1').status, 'running');

  const reclaimed = fixture({ leaseDurationMs: 35 });
  await sleep(80);
  const newer = reclaimed.otherClaims.claim({ taskId: 'task-1', ownerId: 'owner-2' });
  assert.ok(newer);
  assert.equal(cancel(reclaimed), null);
  assert.equal(reclaimed.runs.getRun('run-1').status, 'running');
});

test('cancelled is terminal and cannot be overwritten by later completion/failure/interruption', () => {
  const item = fixture();
  assert.equal(cancel(item).status, 'cancelled');
  const decision = gate('COMPLETED', 'completed');
  assert.equal(complete(item, decision), null);
  assert.equal(fail(item), null);
  assert.equal(item.runs.markInterrupted('run-1'), null);
  assert.equal(item.runs.getRun('run-1').status, 'cancelled');
});

test('fenced transitions reject malformed identity and completion mismatch before mutation', () => {
  const item = fixture();
  const decision = gate('COMPLETED', 'completed');
  assert.throws(() => complete(item, decision, { ownerId: '' }), TypeError);
  assert.throws(() => complete(item, decision, { leaseId: '  ' }), TypeError);
  assert.throws(() => complete(item, decision, { xResult: xResult(gate('FAILED', 'error')) }), TypeError);
  assert.throws(() => fail(item, { taskId: '' }), TypeError);
  assert.equal(item.runs.getRun('run-1').status, 'running');
});

// A separate process owns the SQLite write lock. Its uncommitted claim change
// becomes visible only when it commits, while the parent's fenced UPDATE waits.
const LOCK_WORKER = `
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(process.argv[1]);
  db.exec('BEGIN IMMEDIATE');
  const mode = process.argv[2];
  let expiresAt = null;
  const commitAfter = Date.now() + Number(process.argv[3]);
  if (mode === 'release') db.prepare("UPDATE x_task_claims SET state = 'released' WHERE task_id = 'task-1'").run();
  if (mode === 'expire') {
    expiresAt = Date.now() + 300;
    db.prepare("UPDATE x_task_claims SET lease_expires_at = ? WHERE task_id = 'task-1'").run(expiresAt);
  }
  process.stdout.write(JSON.stringify({ locked: true, expiresAt, commitAfter }) + '\\n');
  setTimeout(() => { db.exec('COMMIT'); db.close(); }, Number(process.argv[3]));
`;

function lockClaim(item, mode, holdMs) {
  const child = spawn(process.execPath, ['-e', LOCK_WORKER, item.storagePath, mode, String(holdMs)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  const done = new Promise((resolve, reject) => {
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`lock worker exited ${code}: ${stderr}`)));
  });
  done.catch(() => {});
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const line = stdout.split('\n')[0];
      if (stdout.includes('\n')) resolve(JSON.parse(line));
    });
    child.on('error', reject);
    child.on('close', (code) => { if (!stdout.includes('\n')) reject(new Error(`lock worker closed ${code} before ready: ${stderr}`)); });
  });
  return { ready, done };
}

test('single UPDATE observes a claim changed by another process while it waited for the write lock', async () => {
  const item = fixture();
  const worker = lockClaim(item, 'release', 500);
  const { locked, commitAfter } = await worker.ready;
  assert.equal(locked, true);
  assert.ok(Date.now() < commitAfter, 'the terminal request starts before the other process commits');
  assert.equal(complete(item, gate('COMPLETED', 'completed')), null);
  await worker.done;
  assert.equal(item.runs.getRun('run-1').status, 'running');
});

test('lease expiry is evaluated inside the UPDATE after a cross-process lock wait', async () => {
  const item = fixture();
  const worker = lockClaim(item, 'expire', 550);
  const { expiresAt } = await worker.ready;
  assert.ok(Date.now() < expiresAt, 'the terminal request starts before the revised lease expiry');
  assert.equal(complete(item, gate('COMPLETED', 'completed')), null);
  await worker.done;
  assert.ok(Date.now() > expiresAt);
  assert.equal(item.runs.getRun('run-1').status, 'running');
});
