import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { XRunStore, XRunStoreError } from '../mcp/x/run-store.mjs';
import { XClaimStore } from '../mcp/x/claim-store.mjs';

const dirs = [];
function tmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-x-run-store-'));
  dirs.push(dir);
  return path.join(dir, 'hearth-runtime.sqlite');
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const alwaysLive = () => true;
const neverLive = () => false;

const fakeGateResult = (gateStatus, hearthOutcome) => ({ gate_status: gateStatus, hearth_outcome: hearthOutcome });
const fakeXResult = (taskId, gateStatus, hearthOutcome, overrides = {}) => ({
  version: 'x-result-v1', task_id: taskId, gate_status: gateStatus, hearth_outcome: hearthOutcome, ...overrides,
});

test('R1 opening a store creates the x_runs table in a fresh temp file', () => {
  const dbPath = tmpDbPath();
  const store = new XRunStore({ storagePath: dbPath });
  assert.equal(store.getRun('nope'), null);
  assert.equal(fs.existsSync(dbPath), true);
  store.close();
});

test('R2 createRun starts a run in queued status with no gate/result/error yet', () => {
  const store = new XRunStore({ storagePath: tmpDbPath() });
  const run = store.createRun({ runId: 'run-1', taskId: 'task-1' });
  assert.equal(run.status, 'queued');
  assert.equal(run.gateStatus, null);
  assert.equal(run.hearthOutcome, null);
  assert.equal(run.result, null);
  assert.equal(run.error, null);
  assert.equal(run.claimLeaseId, null);
  store.close();
});

test('R3 duplicate runId is rejected with a typed XRunStoreError, not a raw SQLite error', () => {
  const store = new XRunStore({ storagePath: tmpDbPath() });
  store.createRun({ runId: 'run-1', taskId: 'task-1' });
  try {
    store.createRun({ runId: 'run-1', taskId: 'task-2' });
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof XRunStoreError);
    assert.equal(err.code, 'DUPLICATE_RUN_ID');
  }
  store.close();
});

test('R4 queued -> running requires and records a real claim lease id', () => {
  const store = new XRunStore({ storagePath: tmpDbPath() });
  store.createRun({ runId: 'run-1', taskId: 'task-1' });
  const run = store.markRunning({ runId: 'run-1', claimLeaseId: 'lease-abc' });
  assert.equal(run.status, 'running');
  assert.equal(run.claimLeaseId, 'lease-abc');
  store.close();
});

test('R4b markRunning without a claimLeaseId is rejected -- a run must never enter running with a null lease', () => {
  const store = new XRunStore({ storagePath: tmpDbPath() });
  store.createRun({ runId: 'run-1', taskId: 'task-1' });
  assert.throws(() => store.markRunning({ runId: 'run-1' }), TypeError);
  assert.throws(() => store.markRunning({ runId: 'run-1', claimLeaseId: '' }), TypeError);
  assert.equal(store.getRun('run-1').status, 'queued');
  store.close();
});

test('R5 running -> completed persists gate_status/hearth_outcome/result_json', () => {
  const store = new XRunStore({ storagePath: tmpDbPath() });
  store.createRun({ runId: 'run-1', taskId: 'task-1' });
  store.markRunning({ runId: 'run-1', claimLeaseId: 'lease-1' });
  const xResult = fakeXResult('task-1', 'COMPLETED', 'completed');
  const run = store.completeRun({ runId: 'run-1', gateResult: fakeGateResult('COMPLETED', 'completed'), xResult });
  assert.equal(run.status, 'completed');
  assert.equal(run.gateStatus, 'COMPLETED');
  assert.equal(run.hearthOutcome, 'completed');
  assert.deepEqual(run.result, xResult);
  store.close();
});

test('R6 running -> needs_review', () => {
  const store = new XRunStore({ storagePath: tmpDbPath() });
  store.createRun({ runId: 'run-1', taskId: 'task-1' });
  store.markRunning({ runId: 'run-1', claimLeaseId: 'lease-1' });
  const run = store.completeRun({ runId: 'run-1', gateResult: fakeGateResult('NEEDS_REVIEW', 'waiting'), xResult: fakeXResult('task-1', 'NEEDS_REVIEW', 'waiting') });
  assert.equal(run.status, 'needs_review');
  assert.equal(run.hearthOutcome, 'waiting');
  store.close();
});

test('R7 running -> failed (real Result Gate FAILED)', () => {
  const store = new XRunStore({ storagePath: tmpDbPath() });
  store.createRun({ runId: 'run-1', taskId: 'task-1' });
  store.markRunning({ runId: 'run-1', claimLeaseId: 'lease-1' });
  const run = store.completeRun({ runId: 'run-1', gateResult: fakeGateResult('FAILED', 'error'), xResult: fakeXResult('task-1', 'FAILED', 'error') });
  assert.equal(run.status, 'failed');
  assert.equal(run.gateStatus, 'FAILED');
  assert.ok(run.result);
  store.close();
});

test('R8 persisted x-result-v1 JSON round-trips exactly', () => {
  const store = new XRunStore({ storagePath: tmpDbPath() });
  store.createRun({ runId: 'run-1', taskId: 'task-1' });
  store.markRunning({ runId: 'run-1', claimLeaseId: 'lease-1' });
  const xResult = fakeXResult('task-1', 'COMPLETED', 'completed', { files_changed: ['src/a.js'], validation: [{ name: 'x', status: 'passed' }] });
  store.completeRun({ runId: 'run-1', gateResult: fakeGateResult('COMPLETED', 'completed'), xResult });
  assert.deepEqual(store.getRun('run-1').result, xResult);
  store.close();
});

test('R9 orchestration error (failRun) is bounded and distinct from a Result Gate FAILED', () => {
  const store = new XRunStore({ storagePath: tmpDbPath() });
  store.createRun({ runId: 'run-1', taskId: 'task-1' });
  store.markRunning({ runId: 'run-1', claimLeaseId: 'lease-1' });
  const run = store.failRun({ runId: 'run-1', error: 'x'.repeat(10_000) });
  assert.equal(run.status, 'failed');
  assert.equal(run.gateStatus, null);
  assert.equal(run.result, null);
  assert.ok(Buffer.byteLength(run.error, 'utf8') <= 2000);
  store.close();
});

test('R9b failRun is also allowed directly from queued (e.g. admission denied before running)', () => {
  const store = new XRunStore({ storagePath: tmpDbPath() });
  store.createRun({ runId: 'run-1', taskId: 'task-1' });
  const run = store.failRun({ runId: 'run-1', error: 'could not acquire admission' });
  assert.equal(run.status, 'failed');
  store.close();
});

test('R9c orchestration error truncation is genuinely UTF-8 byte safe for multibyte/Thai/emoji text', () => {
  const store = new XRunStore({ storagePath: tmpDbPath() });
  const thai = 'สวัสดีครับขอบคุณมากๆ'.repeat(300);
  const emoji = '😀🚀🔥'.repeat(300);
  const cases = [thai, emoji, thai + emoji];
  cases.forEach((text, i) => {
    const runId = `run-multibyte-${i}`;
    store.createRun({ runId, taskId: `task-${i}` });
    store.markRunning({ runId, claimLeaseId: `lease-${i}` });
    const run = store.failRun({ runId, error: text });
    assert.ok(Buffer.byteLength(run.error, 'utf8') <= 2000, `expected <=2000 bytes, got ${Buffer.byteLength(run.error, 'utf8')}`);
    assert.ok(!run.error.includes('�'), 'truncated error must not contain a replacement character from a split multi-byte sequence');
  });
  store.close();
});

test('R10 invalid/backwards transitions are rejected (return null), never applied', () => {
  const store = new XRunStore({ storagePath: tmpDbPath() });
  store.createRun({ runId: 'run-1', taskId: 'task-1' });
  assert.equal(store.completeRun({ runId: 'run-1', gateResult: fakeGateResult('COMPLETED', 'completed'), xResult: fakeXResult('task-1', 'COMPLETED', 'completed') }), null);
  assert.equal(store.getRun('run-1').status, 'queued');

  store.markRunning({ runId: 'run-1', claimLeaseId: 'lease-1' });
  store.completeRun({ runId: 'run-1', gateResult: fakeGateResult('COMPLETED', 'completed'), xResult: fakeXResult('task-1', 'COMPLETED', 'completed') });
  assert.equal(store.markRunning({ runId: 'run-1', claimLeaseId: 'lease-2' }), null);
  assert.equal(store.failRun({ runId: 'run-1', error: 'late' }), null);
  assert.equal(store.markInterrupted('run-1'), null);
  assert.equal(store.getRun('run-1').status, 'completed');
  store.close();
});

test('R11 unknown run_id updates fail safely (return null / throw TypeError only for missing required params)', () => {
  const store = new XRunStore({ storagePath: tmpDbPath() });
  assert.equal(store.markRunning({ runId: 'ghost', claimLeaseId: 'lease-1' }), null);
  assert.equal(store.completeRun({ runId: 'ghost', gateResult: fakeGateResult('COMPLETED', 'completed'), xResult: fakeXResult('task-1', 'COMPLETED', 'completed') }), null);
  assert.equal(store.failRun({ runId: 'ghost', error: 'x' }), null);
  assert.equal(store.markInterrupted('ghost'), null);
  assert.equal(store.setClaimLease('ghost', 'lease-1'), null);
  assert.equal(store.getRun('ghost'), null);
  store.close();
});

test('R12 reconciliation leaves a non-terminal run untouched when its claim is genuinely still live', () => {
  const store = new XRunStore({ storagePath: tmpDbPath() });
  store.createRun({ runId: 'run-1', taskId: 'task-1' });
  store.markRunning({ runId: 'run-1', claimLeaseId: 'lease-1' });
  assert.deepEqual(store.reconcileStartupState(alwaysLive), []);
  assert.equal(store.getRun('run-1').status, 'running');
  store.close();
});

test('R13 reconciliation marks interrupted when the claim is dead/expired/released', () => {
  const store = new XRunStore({ storagePath: tmpDbPath() });
  store.createRun({ runId: 'run-1', taskId: 'task-1' });
  store.markRunning({ runId: 'run-1', claimLeaseId: 'lease-1' });
  assert.deepEqual(store.reconcileStartupState(neverLive), ['run-1']);
  assert.equal(store.getRun('run-1').status, 'interrupted');
  store.close();
});

test('R13b reconciliation always interrupts a queued run whose claim was never recorded (null lease), without consulting the callback', () => {
  const store = new XRunStore({ storagePath: tmpDbPath() });
  store.createRun({ runId: 'run-1', taskId: 'task-1' });
  let called = false;
  const interrupted = store.reconcileStartupState(() => { called = true; return true; });
  assert.deepEqual(interrupted, ['run-1']);
  assert.equal(called, false);
  store.close();
});

test('R14 reconciliation is idempotent across repeated calls', () => {
  const store = new XRunStore({ storagePath: tmpDbPath() });
  store.createRun({ runId: 'run-1', taskId: 'task-1' });
  store.markRunning({ runId: 'run-1', claimLeaseId: 'lease-1' });
  assert.deepEqual(store.reconcileStartupState(neverLive), ['run-1']);
  assert.deepEqual(store.reconcileStartupState(neverLive), []);
  assert.equal(store.getRun('run-1').status, 'interrupted');
  store.close();
});

test('R15 terminal rows are never touched by reconciliation, regardless of liveness callback', () => {
  const store = new XRunStore({ storagePath: tmpDbPath() });
  store.createRun({ runId: 'run-1', taskId: 'task-1' });
  store.markRunning({ runId: 'run-1', claimLeaseId: 'lease-1' });
  store.completeRun({ runId: 'run-1', gateResult: fakeGateResult('COMPLETED', 'completed'), xResult: fakeXResult('task-1', 'COMPLETED', 'completed') });
  const before = store.getRun('run-1');
  assert.deepEqual(store.reconcileStartupState(neverLive), []);
  assert.deepEqual(store.getRun('run-1'), before);
  store.close();
});

test('R16 retention deletes only the oldest terminal rows beyond the limit', () => {
  const store = new XRunStore({ storagePath: tmpDbPath(), retentionLimit: 3 });
  let t = 1000;
  for (let i = 0; i < 5; i += 1) {
    const runId = `run-${i}`;
    store.now = () => t++;
    store.createRun({ runId, taskId: 'task-1' });
    store.markRunning({ runId, claimLeaseId: `lease-${i}` });
    store.completeRun({ runId, gateResult: fakeGateResult('COMPLETED', 'completed'), xResult: fakeXResult('task-1', 'COMPLETED', 'completed') });
  }
  const survivors = ['run-0', 'run-1', 'run-2', 'run-3', 'run-4']
    .map((id) => store.getRun(id)).filter(Boolean).map((r) => r.runId);
  assert.equal(survivors.length, 3);
  assert.deepEqual(survivors.sort(), ['run-2', 'run-3', 'run-4']);
  store.close();
});

test('R16b retention ordering is deterministic when updated_at ties (stable rowid secondary order)', () => {
  const store = new XRunStore({ storagePath: tmpDbPath(), retentionLimit: 2 });
  const fixedNow = 5000;
  store.now = () => fixedNow;
  for (let i = 0; i < 4; i += 1) {
    const runId = `run-${i}`;
    store.createRun({ runId, taskId: 'task-1' });
    store.markRunning({ runId, claimLeaseId: `lease-${i}` });
    store.completeRun({ runId, gateResult: fakeGateResult('COMPLETED', 'completed'), xResult: fakeXResult('task-1', 'COMPLETED', 'completed') });
  }
  const survivors = ['run-0', 'run-1', 'run-2', 'run-3']
    .map((id) => store.getRun(id)).filter(Boolean).map((r) => r.runId);
  assert.deepEqual(survivors.sort(), ['run-2', 'run-3']);

  const store2 = new XRunStore({ storagePath: tmpDbPath(), retentionLimit: 2 });
  store2.now = () => fixedNow;
  for (let i = 0; i < 4; i += 1) {
    const runId = `run-${i}`;
    store2.createRun({ runId, taskId: 'task-1' });
    store2.markRunning({ runId, claimLeaseId: `lease-${i}` });
    store2.completeRun({ runId, gateResult: fakeGateResult('COMPLETED', 'completed'), xResult: fakeXResult('task-1', 'COMPLETED', 'completed') });
  }
  const survivors2 = ['run-0', 'run-1', 'run-2', 'run-3']
    .map((id) => store2.getRun(id)).filter(Boolean).map((r) => r.runId);
  assert.deepEqual(survivors2.sort(), survivors.sort());
  store.close();
  store2.close();
});

test('R17 retention never deletes queued/running rows even far beyond the limit', () => {
  const store = new XRunStore({ storagePath: tmpDbPath(), retentionLimit: 1 });
  store.createRun({ runId: 'active-1', taskId: 'task-1' });
  store.createRun({ runId: 'active-2', taskId: 'task-2' });
  store.createRun({ runId: 'active-3', taskId: 'task-3' });
  store.createRun({ runId: 'terminal-1', taskId: 'task-4' });
  store.markRunning({ runId: 'terminal-1', claimLeaseId: 'lease-1' });
  store.completeRun({ runId: 'terminal-1', gateResult: fakeGateResult('COMPLETED', 'completed'), xResult: fakeXResult('task-4', 'COMPLETED', 'completed') });
  assert.ok(store.getRun('active-1'));
  assert.ok(store.getRun('active-2'));
  assert.ok(store.getRun('active-3'));
  store.close();
});

test('R18 reopening the same SQLite file preserves records across a new store instance', () => {
  const dbPath = tmpDbPath();
  const storeA = new XRunStore({ storagePath: dbPath });
  storeA.createRun({ runId: 'run-1', taskId: 'task-1' });
  storeA.markRunning({ runId: 'run-1', claimLeaseId: 'lease-1' });
  storeA.close();

  const storeB = new XRunStore({ storagePath: dbPath });
  const run = storeB.getRun('run-1');
  assert.equal(run.status, 'running');
  assert.equal(run.claimLeaseId, 'lease-1');
  storeB.close();
});

// --- setClaimLease invariant ------------------------------------------------

test('SCL1 setClaimLease succeeds while queued', () => {
  const store = new XRunStore({ storagePath: tmpDbPath() });
  store.createRun({ runId: 'run-1', taskId: 'task-1' });
  const run = store.setClaimLease('run-1', 'lease-x');
  assert.equal(run.claimLeaseId, 'lease-x');
  assert.equal(run.status, 'queued');
  store.close();
});

test('SCL2 setClaimLease rejects a non-string/empty lease id', () => {
  const store = new XRunStore({ storagePath: tmpDbPath() });
  store.createRun({ runId: 'run-1', taskId: 'task-1' });
  assert.throws(() => store.setClaimLease('run-1', ''), TypeError);
  assert.throws(() => store.setClaimLease('run-1', null), TypeError);
  assert.throws(() => store.setClaimLease('run-1', 123), TypeError);
  store.close();
});

test('SCL3 setClaimLease cannot change or clear the lease of a running run', () => {
  const store = new XRunStore({ storagePath: tmpDbPath() });
  store.createRun({ runId: 'run-1', taskId: 'task-1' });
  store.markRunning({ runId: 'run-1', claimLeaseId: 'lease-original' });
  assert.equal(store.setClaimLease('run-1', 'lease-different'), null);
  assert.equal(store.getRun('run-1').claimLeaseId, 'lease-original');
  store.close();
});

test('SCL4 setClaimLease cannot touch a terminal run', () => {
  const store = new XRunStore({ storagePath: tmpDbPath() });
  store.createRun({ runId: 'run-1', taskId: 'task-1' });
  store.markRunning({ runId: 'run-1', claimLeaseId: 'lease-1' });
  store.completeRun({ runId: 'run-1', gateResult: fakeGateResult('COMPLETED', 'completed'), xResult: fakeXResult('task-1', 'COMPLETED', 'completed') });
  assert.equal(store.setClaimLease('run-1', 'lease-late'), null);
  assert.equal(store.getRun('run-1').claimLeaseId, 'lease-1');
  store.close();
});

// --- completeRun persistence-integrity validation ---------------------------

test('CI1 completeRun rejects a missing/non-object xResult and leaves the run running', () => {
  const store = new XRunStore({ storagePath: tmpDbPath() });
  store.createRun({ runId: 'run-1', taskId: 'task-1' });
  store.markRunning({ runId: 'run-1', claimLeaseId: 'lease-1' });
  assert.throws(() => store.completeRun({ runId: 'run-1', gateResult: fakeGateResult('COMPLETED', 'completed'), xResult: null }), TypeError);
  assert.throws(() => store.completeRun({ runId: 'run-1', gateResult: fakeGateResult('COMPLETED', 'completed'), xResult: 'not-an-object' }), TypeError);
  assert.throws(() => store.completeRun({ runId: 'run-1', gateResult: fakeGateResult('COMPLETED', 'completed') }), TypeError);
  assert.equal(store.getRun('run-1').status, 'running');
  store.close();
});

test('CI2 completeRun rejects an xResult.gate_status mismatch and leaves the run running', () => {
  const store = new XRunStore({ storagePath: tmpDbPath() });
  store.createRun({ runId: 'run-1', taskId: 'task-1' });
  store.markRunning({ runId: 'run-1', claimLeaseId: 'lease-1' });
  const mismatched = fakeXResult('task-1', 'FAILED', 'error');
  assert.throws(() => store.completeRun({ runId: 'run-1', gateResult: fakeGateResult('COMPLETED', 'completed'), xResult: mismatched }), TypeError);
  assert.equal(store.getRun('run-1').status, 'running');
  store.close();
});

test('CI3 completeRun rejects an xResult.hearth_outcome mismatch and leaves the run running', () => {
  const store = new XRunStore({ storagePath: tmpDbPath() });
  store.createRun({ runId: 'run-1', taskId: 'task-1' });
  store.markRunning({ runId: 'run-1', claimLeaseId: 'lease-1' });
  const mismatched = fakeXResult('task-1', 'COMPLETED', 'waiting');
  assert.throws(() => store.completeRun({ runId: 'run-1', gateResult: fakeGateResult('COMPLETED', 'completed'), xResult: mismatched }), TypeError);
  assert.equal(store.getRun('run-1').status, 'running');
  store.close();
});

// --- completeRun task_id integrity ------------------------------------------

test('TID1 completeRun succeeds when xResult.task_id matches the run\'s actual task_id', () => {
  const store = new XRunStore({ storagePath: tmpDbPath() });
  store.createRun({ runId: 'run-1', taskId: 'task-1' });
  store.markRunning({ runId: 'run-1', claimLeaseId: 'lease-1' });
  const run = store.completeRun({ runId: 'run-1', gateResult: fakeGateResult('COMPLETED', 'completed'), xResult: fakeXResult('task-1', 'COMPLETED', 'completed') });
  assert.ok(run);
  assert.equal(run.status, 'completed');
  store.close();
});

test('TID2 completeRun rejects (returns null) when xResult.task_id does not match the run\'s actual task_id, leaving the run running', () => {
  const store = new XRunStore({ storagePath: tmpDbPath() });
  store.createRun({ runId: 'run-1', taskId: 'task-1' });
  store.markRunning({ runId: 'run-1', claimLeaseId: 'lease-1' });
  const wrongTaskResult = fakeXResult('task-DIFFERENT', 'COMPLETED', 'completed');
  const outcome = store.completeRun({ runId: 'run-1', gateResult: fakeGateResult('COMPLETED', 'completed'), xResult: wrongTaskResult });
  assert.equal(outcome, null);
  assert.equal(store.getRun('run-1').status, 'running');
  store.close();
});

test('TID3 completeRun rejects a missing xResult.task_id and leaves the run running', () => {
  const store = new XRunStore({ storagePath: tmpDbPath() });
  store.createRun({ runId: 'run-1', taskId: 'task-1' });
  store.markRunning({ runId: 'run-1', claimLeaseId: 'lease-1' });
  assert.throws(() => store.completeRun({
    runId: 'run-1',
    gateResult: fakeGateResult('COMPLETED', 'completed'),
    xResult: { version: 'x-result-v1', gate_status: 'COMPLETED', hearth_outcome: 'completed' },
  }), TypeError);
  assert.equal(store.getRun('run-1').status, 'running');
  store.close();
});

test('TID4 completeRun rejects a whitespace-only xResult.task_id and leaves the run running', () => {
  const store = new XRunStore({ storagePath: tmpDbPath() });
  store.createRun({ runId: 'run-1', taskId: 'task-1' });
  store.markRunning({ runId: 'run-1', claimLeaseId: 'lease-1' });
  assert.throws(() => store.completeRun({
    runId: 'run-1',
    gateResult: fakeGateResult('COMPLETED', 'completed'),
    xResult: fakeXResult('   ', 'COMPLETED', 'completed'),
  }), TypeError);
  assert.equal(store.getRun('run-1').status, 'running');
  store.close();
});

// --- lease-id validation -----------------------------------------------------

test('LEASE1 whitespace-only lease ids are rejected everywhere a real lease id is required', () => {
  const store = new XRunStore({ storagePath: tmpDbPath() });
  store.createRun({ runId: 'run-1', taskId: 'task-1' });
  assert.throws(() => store.markRunning({ runId: 'run-1', claimLeaseId: '   ' }), TypeError);
  assert.throws(() => store.setClaimLease('run-1', '   '), TypeError);
  assert.throws(() => store.createRun({ runId: 'run-2', taskId: 'task-2', claimLeaseId: '   ' }), TypeError);
  store.close();
});

// --- Concurrency: two independent store instances against the SAME file ---

test('C1 two store instances cannot both transition the same queued run to running -- exactly one wins', () => {
  const dbPath = tmpDbPath();
  const storeA = new XRunStore({ storagePath: dbPath });
  storeA.createRun({ runId: 'run-1', taskId: 'task-1' });
  storeA.close();

  const storeB1 = new XRunStore({ storagePath: dbPath });
  const storeB2 = new XRunStore({ storagePath: dbPath });
  const resultA = storeB1.markRunning({ runId: 'run-1', claimLeaseId: 'lease-from-B1' });
  const resultB = storeB2.markRunning({ runId: 'run-1', claimLeaseId: 'lease-from-B2' });

  const winners = [resultA, resultB].filter(Boolean);
  assert.equal(winners.length, 1);
  const finalRun = storeB1.getRun('run-1');
  assert.equal(finalRun.status, 'running');
  assert.ok(['lease-from-B1', 'lease-from-B2'].includes(finalRun.claimLeaseId));

  storeB1.close();
  storeB2.close();
});

test('C2 duplicate create from two store instances against the same file produces exactly one row', () => {
  const dbPath = tmpDbPath();
  const storeA = new XRunStore({ storagePath: dbPath });
  const storeB = new XRunStore({ storagePath: dbPath });

  let errors = 0;
  let successes = 0;
  for (const store of [storeA, storeB]) {
    try {
      store.createRun({ runId: 'shared-run', taskId: 'task-1' });
      successes += 1;
    } catch (err) {
      assert.ok(err instanceof XRunStoreError);
      assert.equal(err.code, 'DUPLICATE_RUN_ID');
      errors += 1;
    }
  }
  assert.equal(successes, 1);
  assert.equal(errors, 1);
  assert.ok(storeA.getRun('shared-run'));

  storeA.close();
  storeB.close();
});

test('C3 a stale transition attempt cannot overwrite a run another process already moved to terminal', () => {
  const dbPath = tmpDbPath();
  const storeA = new XRunStore({ storagePath: dbPath });
  storeA.createRun({ runId: 'run-1', taskId: 'task-1' });
  storeA.markRunning({ runId: 'run-1', claimLeaseId: 'lease-1' });

  const storeB = new XRunStore({ storagePath: dbPath });
  storeB.completeRun({ runId: 'run-1', gateResult: fakeGateResult('COMPLETED', 'completed'), xResult: fakeXResult('task-1', 'COMPLETED', 'completed') });

  assert.equal(storeA.failRun({ runId: 'run-1', error: 'stale failure attempt' }), null);
  assert.equal(storeA.markInterrupted('run-1'), null);

  const finalRun = storeA.getRun('run-1');
  assert.equal(finalRun.status, 'completed');
  assert.equal(finalRun.error, null);

  storeA.close();
  storeB.close();
});

test('C4 reconciliation holds one atomic transaction: a concurrent write against the shared file is blocked mid-decision, so a genuinely-live claim cannot be raced into interrupted', () => {
  const dbPath = tmpDbPath();
  const store = new XRunStore({ storagePath: dbPath });
  store.createRun({ runId: 'run-1', taskId: 'task-1' });
  store.markRunning({ runId: 'run-1', claimLeaseId: 'lease-1' });

  const raceConn = new DatabaseSync(dbPath);
  raceConn.exec('PRAGMA busy_timeout = 50');
  let blockedWriteObserved = false;

  const isClaimLive = (taskId, claimLeaseId) => {
    // Simulates another process attempting to renew/reclaim its lease
    // WHILE reconciliation is mid-decision -- this must be blocked by
    // XRunStore's own open transaction.
    try {
      raceConn.exec('BEGIN IMMEDIATE');
      raceConn.exec('ROLLBACK');
    } catch (err) {
      blockedWriteObserved = /locked|busy/i.test(err.message);
    }
    return taskId === 'task-1' && claimLeaseId === 'lease-1';
  };

  const interrupted = store.reconcileStartupState(isClaimLive);

  assert.equal(blockedWriteObserved, true, 'a concurrent write during reconciliation must be blocked by the shared lock, not silently allowed to race');
  assert.deepEqual(interrupted, []);
  assert.equal(store.getRun('run-1').status, 'running');

  raceConn.close();
  store.close();
});

test('C5 the REAL XClaimStore.getActiveClaim read path works correctly from inside an open reconciliation transaction, against the same shared file', () => {
  const dbPath = tmpDbPath();

  // Real Phase 4 claim, real API, same shared file -- no claim-store.mjs modification.
  const claimStore = new XClaimStore({ storagePath: dbPath, leaseDurationMs: 30_000 });
  const claim = claimStore.claim({ taskId: 'task-1', ownerId: 'owner-1' });
  assert.ok(claim, 'expected a real active claim to be acquired');

  const runStore = new XRunStore({ storagePath: dbPath });
  runStore.createRun({ runId: 'run-1', taskId: 'task-1', claimLeaseId: claim.leaseId });
  runStore.markRunning({ runId: 'run-1', claimLeaseId: claim.leaseId });

  // Read-only callback backed by the real, unmodified XClaimStore API.
  const isClaimLive = (taskId, claimLeaseId) => {
    const active = claimStore.getActiveClaim(taskId);
    return Boolean(active && active.leaseId === claimLeaseId);
  };

  let interrupted;
  assert.doesNotThrow(() => {
    interrupted = runStore.reconcileStartupState(isClaimLive);
  }, 'reconciliation must not throw or deadlock while a real XClaimStore read runs inside its transaction');

  assert.deepEqual(interrupted, [], 'a genuinely active real claim must not be interrupted');
  assert.equal(runStore.getRun('run-1').status, 'running');

  claimStore.close();
  runStore.close();
});

// ── R1: hasNonTerminalRunForClaimLease ──────────────────────────────────────
//
// Read-only: does ANY non-terminal (queued/running) run currently carry
// this exact claim_lease_id? Lets a caller holding only a bare leaseId
// (e.g. from XClaimStore.getActiveClaim(), which is claim-kind-agnostic and
// knows nothing about X vs. any other consumer of the shared claim table)
// determine whether that lease actually belongs to an X run.

test('R1 hasNonTerminalRunForClaimLease is true for a matching QUEUED run', () => {
  const store = new XRunStore({ storagePath: tmpDbPath() });
  store.createRun({ runId: 'run-1', taskId: 'task-1', claimLeaseId: 'lease-1' });
  assert.equal(store.getRun('run-1').status, 'queued');
  assert.equal(store.hasNonTerminalRunForClaimLease('lease-1'), true);
});

test('R1 hasNonTerminalRunForClaimLease is true for a matching RUNNING run', () => {
  const store = new XRunStore({ storagePath: tmpDbPath() });
  store.createRun({ runId: 'run-1', taskId: 'task-1', claimLeaseId: 'lease-1' });
  store.markRunning({ runId: 'run-1', claimLeaseId: 'lease-1' });
  assert.equal(store.getRun('run-1').status, 'running');
  assert.equal(store.hasNonTerminalRunForClaimLease('lease-1'), true);
});

test('R1 hasNonTerminalRunForClaimLease is false once the run reaches COMPLETED', () => {
  const store = new XRunStore({ storagePath: tmpDbPath() });
  store.createRun({ runId: 'run-1', taskId: 'task-1', claimLeaseId: 'lease-1' });
  store.markRunning({ runId: 'run-1', claimLeaseId: 'lease-1' });
  store.completeRun({ runId: 'run-1', gateResult: fakeGateResult('COMPLETED', 'completed'), xResult: fakeXResult('task-1', 'COMPLETED', 'completed') });
  assert.equal(store.hasNonTerminalRunForClaimLease('lease-1'), false);
});

test('R1 hasNonTerminalRunForClaimLease is false once the run reaches NEEDS_REVIEW', () => {
  const store = new XRunStore({ storagePath: tmpDbPath() });
  store.createRun({ runId: 'run-1', taskId: 'task-1', claimLeaseId: 'lease-1' });
  store.markRunning({ runId: 'run-1', claimLeaseId: 'lease-1' });
  store.completeRun({ runId: 'run-1', gateResult: fakeGateResult('NEEDS_REVIEW', 'waiting'), xResult: fakeXResult('task-1', 'NEEDS_REVIEW', 'waiting') });
  assert.equal(store.hasNonTerminalRunForClaimLease('lease-1'), false);
});

test('R1 hasNonTerminalRunForClaimLease is false once the run reaches FAILED', () => {
  const store = new XRunStore({ storagePath: tmpDbPath() });
  store.createRun({ runId: 'run-1', taskId: 'task-1', claimLeaseId: 'lease-1' });
  store.markRunning({ runId: 'run-1', claimLeaseId: 'lease-1' });
  store.completeRun({ runId: 'run-1', gateResult: fakeGateResult('FAILED', 'error'), xResult: fakeXResult('task-1', 'FAILED', 'error') });
  assert.equal(store.hasNonTerminalRunForClaimLease('lease-1'), false);
});

test('R1 hasNonTerminalRunForClaimLease is false once the run reaches INTERRUPTED', () => {
  const store = new XRunStore({ storagePath: tmpDbPath() });
  store.createRun({ runId: 'run-1', taskId: 'task-1', claimLeaseId: 'lease-1' });
  store.markRunning({ runId: 'run-1', claimLeaseId: 'lease-1' });
  store.markInterrupted('run-1');
  assert.equal(store.hasNonTerminalRunForClaimLease('lease-1'), false);
});

test('R1 hasNonTerminalRunForClaimLease is false for an unknown/unrelated leaseId', () => {
  const store = new XRunStore({ storagePath: tmpDbPath() });
  store.createRun({ runId: 'run-1', taskId: 'task-1', claimLeaseId: 'lease-1' });
  store.markRunning({ runId: 'run-1', claimLeaseId: 'lease-1' });
  assert.equal(store.hasNonTerminalRunForClaimLease('some-other-lease'), false);
  assert.equal(store.hasNonTerminalRunForClaimLease('other-lease-id-unrelated'), false);
});

test('R1 hasNonTerminalRunForClaimLease rejects invalid input safely (no throw, false)', () => {
  const store = new XRunStore({ storagePath: tmpDbPath() });
  assert.equal(store.hasNonTerminalRunForClaimLease(''), false);
  assert.equal(store.hasNonTerminalRunForClaimLease(null), false);
  assert.equal(store.hasNonTerminalRunForClaimLease(undefined), false);
});
