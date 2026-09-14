import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { XClaimStore } from '../mcp/x/claim-store.mjs';
import { XRunStore } from '../mcp/x/run-store.mjs';
import { registerWorkspaceTools } from '../mcp/tools.mjs';
import { getProductionXRuntime, __resetProductionXRuntimeForTests } from '../mcp/x/production-runtime.mjs';

const dirs = [];
const previousEnv = { HEARTH_RUNTIME_DIR: undefined, hadOwn: false };

function fixtureDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-x-startup-recon-'));
  dirs.push(root);
  return root;
}

/** Points HEARTH_RUNTIME_DIR at a fresh temp dir and clears the memoized production singleton, so each test gets an isolated runtime. */
function useIsolatedRuntimeDir() {
  const dir = fixtureDir();
  process.env.HEARTH_RUNTIME_DIR = dir;
  __resetProductionXRuntimeForTests();
  return path.join(dir, 'hearth-runtime.sqlite');
}

afterEach(() => {
  __resetProductionXRuntimeForTests();
  if (previousEnv.hadOwn) process.env.HEARTH_RUNTIME_DIR = previousEnv.HEARTH_RUNTIME_DIR;
  else delete process.env.HEARTH_RUNTIME_DIR;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// Capture the ambient env once, at module load, before any test mutates it.
previousEnv.hadOwn = Object.prototype.hasOwnProperty.call(process.env, 'HEARTH_RUNTIME_DIR');
previousEnv.HEARTH_RUNTIME_DIR = process.env.HEARTH_RUNTIME_DIR;

/** Seeds a run directly via a real, independent XClaimStore/XRunStore pair pointed at the same file -- simulating pre-crash state left by a prior process. */
function seedStores(dbPath) {
  const claimStore = new XClaimStore({ storagePath: dbPath, leaseDurationMs: 30_000 });
  const runStore = new XRunStore({ storagePath: dbPath });
  return { claimStore, runStore, close() { claimStore.close(); runStore.close(); } };
}

test('S1 a stale running run whose claim expired/died becomes interrupted on startup', async () => {
  const dbPath = useIsolatedRuntimeDir();
  const seed = seedStores(dbPath);
  const claim = seed.claimStore.claim({ taskId: 'task-1', ownerId: 'crashed-owner', leaseDurationMs: 10 });
  seed.runStore.createRun({ runId: 'run-1', taskId: 'task-1', claimLeaseId: claim.leaseId });
  seed.runStore.markRunning({ runId: 'run-1', claimLeaseId: claim.leaseId });
  await new Promise((r) => setTimeout(r, 30)); // let the short lease genuinely expire
  seed.close();

  const { runStore } = getProductionXRuntime();
  assert.equal(runStore.getRun('run-1').status, 'interrupted');
});

test('S2 a stale queued run whose claim died becomes interrupted on startup', async () => {
  const dbPath = useIsolatedRuntimeDir();
  const seed = seedStores(dbPath);
  const claim = seed.claimStore.claim({ taskId: 'task-1', ownerId: 'crashed-owner', leaseDurationMs: 10 });
  seed.runStore.createRun({ runId: 'run-1', taskId: 'task-1', claimLeaseId: claim.leaseId });
  await new Promise((r) => setTimeout(r, 30));
  seed.close();

  const { runStore } = getProductionXRuntime();
  assert.equal(runStore.getRun('run-1').status, 'interrupted');
});

test('S3 a queued run with no recorded lease at all becomes interrupted on startup', async () => {
  const dbPath = useIsolatedRuntimeDir();
  const seed = seedStores(dbPath);
  seed.runStore.createRun({ runId: 'run-1', taskId: 'task-1' }); // never claimed/marked running -- claim_lease_id is null
  seed.close();

  const { runStore } = getProductionXRuntime();
  assert.equal(runStore.getRun('run-1').status, 'interrupted');
});

test('S4 a run whose exact claim is still genuinely live remains running, untouched', async () => {
  const dbPath = useIsolatedRuntimeDir();
  const seed = seedStores(dbPath);
  const claim = seed.claimStore.claim({ taskId: 'task-1', ownerId: 'still-alive-owner', leaseDurationMs: 60_000 });
  seed.runStore.createRun({ runId: 'run-1', taskId: 'task-1', claimLeaseId: claim.leaseId });
  seed.runStore.markRunning({ runId: 'run-1', claimLeaseId: claim.leaseId });
  const before = seed.runStore.getRun('run-1');

  const { runStore } = getProductionXRuntime();
  assert.deepEqual(runStore.getRun('run-1'), before);

  seed.close();
});

test('S5 a run whose lease was reclaimed by a different owner (different leaseId, same task_id) becomes interrupted', async () => {
  const dbPath = useIsolatedRuntimeDir();
  const seed = seedStores(dbPath);
  const originalClaim = seed.claimStore.claim({ taskId: 'task-1', ownerId: 'owner-a', leaseDurationMs: 10 });
  seed.runStore.createRun({ runId: 'run-1', taskId: 'task-1', claimLeaseId: originalClaim.leaseId });
  seed.runStore.markRunning({ runId: 'run-1', claimLeaseId: originalClaim.leaseId });
  await new Promise((r) => setTimeout(r, 30)); // original lease expires
  const reclaimed = seed.claimStore.claim({ taskId: 'task-1', ownerId: 'owner-b', leaseDurationMs: 60_000 });
  assert.notEqual(reclaimed.leaseId, originalClaim.leaseId);

  const { runStore } = getProductionXRuntime();
  // The OLD run's recorded lease no longer matches the currently active one -- it must be interrupted, even though task-1 itself has a live claim again under a new owner.
  assert.equal(runStore.getRun('run-1').status, 'interrupted');

  seed.close();
});

test('S6 a run whose claim was explicitly released becomes interrupted', async () => {
  const dbPath = useIsolatedRuntimeDir();
  const seed = seedStores(dbPath);
  const claim = seed.claimStore.claim({ taskId: 'task-1', ownerId: 'owner-a', leaseDurationMs: 60_000 });
  seed.runStore.createRun({ runId: 'run-1', taskId: 'task-1', claimLeaseId: claim.leaseId });
  seed.runStore.markRunning({ runId: 'run-1', claimLeaseId: claim.leaseId });
  assert.equal(seed.claimStore.release({ taskId: 'task-1', ownerId: 'owner-a', leaseId: claim.leaseId }), true);

  const { runStore } = getProductionXRuntime();
  assert.equal(runStore.getRun('run-1').status, 'interrupted');

  seed.close();
});

test('S7 startup reconciliation runs exactly once per production runtime initialization, not repeatedly', async () => {
  const dbPath = useIsolatedRuntimeDir();
  const seed = seedStores(dbPath);
  const claim = seed.claimStore.claim({ taskId: 'task-1', ownerId: 'crashed-owner', leaseDurationMs: 10 });
  seed.runStore.createRun({ runId: 'run-1', taskId: 'task-1', claimLeaseId: claim.leaseId });
  seed.runStore.markRunning({ runId: 'run-1', claimLeaseId: claim.leaseId });
  await new Promise((r) => setTimeout(r, 30));
  seed.close();

  const original = XRunStore.prototype.reconcileStartupState;
  let calls = 0;
  XRunStore.prototype.reconcileStartupState = function patched(...args) {
    calls += 1;
    return original.apply(this, args);
  };
  try {
    const runtime1 = getProductionXRuntime();
    const runtime2 = getProductionXRuntime(); // second call: must be the memoized singleton, no re-run
    assert.equal(runtime1, runtime2);
    runtime1.runStore.getRun('run-1'); // simulated x_task poll -- must not trigger reconciliation
    runtime1.runStore.getRun('run-1');
    assert.equal(calls, 1, `expected reconciliation to run exactly once, ran ${calls} times`);
  } finally {
    XRunStore.prototype.reconcileStartupState = original;
  }
});

test('S8 a genuinely live claim held by a simulated second process/store is NOT interrupted by this process\'s startup', async () => {
  const dbPath = useIsolatedRuntimeDir();
  // "Process B": still alive, holding a real, unexpired claim.
  const processB = seedStores(dbPath);
  const claim = processB.claimStore.claim({ taskId: 'task-b', ownerId: 'owner-b', leaseDurationMs: 60_000 });
  processB.runStore.createRun({ runId: 'run-b', taskId: 'task-b', claimLeaseId: claim.leaseId });
  processB.runStore.markRunning({ runId: 'run-b', claimLeaseId: claim.leaseId });

  // "Process A": restarts, points its own production runtime at the same file.
  const { runStore } = getProductionXRuntime();
  assert.equal(runStore.getRun('run-b').status, 'running');
  assert.equal(runStore.getRun('run-b').claimLeaseId, claim.leaseId);

  processB.close();
});

test('S9 the reconciliation callback is strictly read-only: no claim renew/release/claim call is ever made', async () => {
  const dbPath = useIsolatedRuntimeDir();
  const seed = seedStores(dbPath);
  const claim = seed.claimStore.claim({ taskId: 'task-1', ownerId: 'owner-a', leaseDurationMs: 10 });
  seed.runStore.createRun({ runId: 'run-1', taskId: 'task-1', claimLeaseId: claim.leaseId });
  seed.runStore.markRunning({ runId: 'run-1', claimLeaseId: claim.leaseId });
  await new Promise((r) => setTimeout(r, 30));
  seed.close();

  const originalRenew = XClaimStore.prototype.renew;
  const originalRelease = XClaimStore.prototype.release;
  const originalClaim = XClaimStore.prototype.claim;
  const originalGetActiveClaim = XClaimStore.prototype.getActiveClaim;
  let renewCalls = 0, releaseCalls = 0, claimCalls = 0, getActiveClaimCalls = 0;
  XClaimStore.prototype.renew = function (...a) { renewCalls += 1; return originalRenew.apply(this, a); };
  XClaimStore.prototype.release = function (...a) { releaseCalls += 1; return originalRelease.apply(this, a); };
  XClaimStore.prototype.claim = function (...a) { claimCalls += 1; return originalClaim.apply(this, a); };
  XClaimStore.prototype.getActiveClaim = function (...a) { getActiveClaimCalls += 1; return originalGetActiveClaim.apply(this, a); };
  try {
    getProductionXRuntime();
    assert.equal(renewCalls, 0, 'reconciliation must never call renew()');
    assert.equal(releaseCalls, 0, 'reconciliation must never call release()');
    assert.equal(claimCalls, 0, 'reconciliation must never call claim()');
    assert.ok(getActiveClaimCalls > 0, 'reconciliation must consult getActiveClaim() (read-only)');
  } finally {
    XClaimStore.prototype.renew = originalRenew;
    XClaimStore.prototype.release = originalRelease;
    XClaimStore.prototype.claim = originalClaim;
    XClaimStore.prototype.getActiveClaim = originalGetActiveClaim;
  }
});

test('S10 production runtime initialization triggers reconciliation once; a subsequent x_task-style poll does not re-trigger it', async () => {
  const dbPath = useIsolatedRuntimeDir();
  const seed = seedStores(dbPath);
  seed.runStore.createRun({ runId: 'run-1', taskId: 'task-1' }); // null lease -- would be interrupted by reconciliation
  seed.close();

  const original = XRunStore.prototype.reconcileStartupState;
  let calls = 0;
  XRunStore.prototype.reconcileStartupState = function patched(...args) {
    calls += 1;
    return original.apply(this, args);
  };
  try {
    const { runStore } = getProductionXRuntime();
    assert.equal(calls, 1);
    assert.equal(runStore.getRun('run-1').status, 'interrupted');
    for (let i = 0; i < 5; i += 1) runStore.getRun('run-1'); // simulated repeated x_task polling
    assert.equal(calls, 1, 'polling x_task-style reads must never re-run reconciliation');
  } finally {
    XRunStore.prototype.reconcileStartupState = original;
  }
});

test('S11 a fresh runtime with no x_runs at all is harmless', async () => {
  useIsolatedRuntimeDir();
  assert.doesNotThrow(() => getProductionXRuntime());
  const { runStore } = getProductionXRuntime();
  assert.equal(runStore.getRun('anything'), null);
});

test('S12 reopening the runtime after a dead lease reconciles the persisted state again from scratch', async () => {
  const dbPath = useIsolatedRuntimeDir();
  const seed = seedStores(dbPath);
  const claim = seed.claimStore.claim({ taskId: 'task-1', ownerId: 'crashed-owner', leaseDurationMs: 10 });
  seed.runStore.createRun({ runId: 'run-1', taskId: 'task-1', claimLeaseId: claim.leaseId });
  seed.runStore.markRunning({ runId: 'run-1', claimLeaseId: claim.leaseId });
  await new Promise((r) => setTimeout(r, 30));
  seed.close();

  // First "process" opens the runtime and reconciles.
  const first = getProductionXRuntime();
  assert.equal(first.runStore.getRun('run-1').status, 'interrupted');
  first.claimStore.close();
  first.runStore.close();

  // A brand-new "process" (fresh singleton) reopens the SAME file.
  __resetProductionXRuntimeForTests();
  const second = getProductionXRuntime();
  assert.equal(second.runStore.getRun('run-1').status, 'interrupted');
});

test('S13 terminal rows are never touched by startup reconciliation', async () => {
  const dbPath = useIsolatedRuntimeDir();
  const seed = seedStores(dbPath);
  const claim = seed.claimStore.claim({ taskId: 'task-1', ownerId: 'owner-a' });
  seed.runStore.createRun({ runId: 'run-1', taskId: 'task-1', claimLeaseId: claim.leaseId });
  seed.runStore.markRunning({ runId: 'run-1', claimLeaseId: claim.leaseId });
  seed.runStore.completeRunFenced({
    runId: 'run-1', ownerId: 'owner-a', leaseId: claim.leaseId,
    gateResult: { gate_status: 'COMPLETED', hearth_outcome: 'completed' },
    xResult: { version: 'x-result-v1', task_id: 'task-1', gate_status: 'COMPLETED', hearth_outcome: 'completed' },
  });
  const before = seed.runStore.getRun('run-1');
  seed.claimStore.release({ taskId: 'task-1', ownerId: 'owner-a', leaseId: claim.leaseId });
  seed.close();

  const { runStore } = getProductionXRuntime();
  assert.deepEqual(runStore.getRun('run-1'), before);
});

test('S14 registerWorkspaceTools without an injected xRuntime uses the real reconciled production runtime, and x_task still works correctly', async () => {
  const dbPath = useIsolatedRuntimeDir();
  const seed = seedStores(dbPath);
  const claim = seed.claimStore.claim({ taskId: 'task-1', ownerId: 'crashed-owner', leaseDurationMs: 10 });
  seed.runStore.createRun({ runId: 'run-1', taskId: 'task-1', claimLeaseId: claim.leaseId });
  seed.runStore.markRunning({ runId: 'run-1', claimLeaseId: claim.leaseId });
  await new Promise((r) => setTimeout(r, 30));
  seed.close();

  const workspace = fixtureDir();
  const tools = new Map();
  const fakeServer = { registerTool(name, config, handler) { tools.set(name, handler); } };
  // No `xRuntime` override -- exercises the real getProductionXRuntime() path.
  registerWorkspaceTools(fakeServer, { workspace, permissions: {} });

  assert.ok(tools.has('x_start'));
  assert.ok(tools.has('x_task'));
  const result = await tools.get('x_task')({ run_id: 'run-1' });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.status, 'interrupted', 'x_task must reflect the real, already-reconciled production state');
});

test('S15 multiple independent runtime instances against the same DB do not corrupt each other\'s reconciliation', async () => {
  const dbPath = useIsolatedRuntimeDir();
  const seed = seedStores(dbPath);
  const deadClaim = seed.claimStore.claim({ taskId: 'task-dead', ownerId: 'dead-owner', leaseDurationMs: 10 });
  seed.runStore.createRun({ runId: 'run-dead', taskId: 'task-dead', claimLeaseId: deadClaim.leaseId });
  seed.runStore.markRunning({ runId: 'run-dead', claimLeaseId: deadClaim.leaseId });
  await new Promise((r) => setTimeout(r, 30));
  const liveClaim = seed.claimStore.claim({ taskId: 'task-live', ownerId: 'live-owner', leaseDurationMs: 60_000 });
  seed.runStore.createRun({ runId: 'run-live', taskId: 'task-live', claimLeaseId: liveClaim.leaseId });
  seed.runStore.markRunning({ runId: 'run-live', claimLeaseId: liveClaim.leaseId });

  // Two independent instances (not the singleton) reconciling against the same file, one after another.
  const instanceA = { claimStore: new XClaimStore({ storagePath: dbPath }), runStore: new XRunStore({ storagePath: dbPath }) };
  const isClaimLiveA = (taskId, leaseId) => {
    const active = instanceA.claimStore.getActiveClaim(taskId);
    return Boolean(active && active.leaseId === leaseId);
  };
  instanceA.runStore.reconcileStartupState(isClaimLiveA);

  const instanceB = { claimStore: new XClaimStore({ storagePath: dbPath }), runStore: new XRunStore({ storagePath: dbPath }) };
  const isClaimLiveB = (taskId, leaseId) => {
    const active = instanceB.claimStore.getActiveClaim(taskId);
    return Boolean(active && active.leaseId === leaseId);
  };
  const secondPassInterrupted = instanceB.runStore.reconcileStartupState(isClaimLiveB);

  assert.equal(instanceA.runStore.getRun('run-dead').status, 'interrupted');
  assert.equal(instanceA.runStore.getRun('run-live').status, 'running');
  assert.equal(instanceB.runStore.getRun('run-dead').status, 'interrupted');
  assert.equal(instanceB.runStore.getRun('run-live').status, 'running');
  assert.deepEqual(secondPassInterrupted, [], 'the second instance\'s reconciliation must be a no-op -- the first instance already resolved it');

  instanceA.claimStore.close(); instanceA.runStore.close();
  instanceB.claimStore.close(); instanceB.runStore.close();
  seed.close();
});
