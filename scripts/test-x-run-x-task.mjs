import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { XClaimStore } from '../mcp/x/claim-store.mjs';
import { XRunStore } from '../mcp/x/run-store.mjs';
import { XExecutionAbortedError } from '../mcp/x/cancellation.mjs';
import { X_TASK_VERSION } from '../mcp/x/task-contract.mjs';
import { runXTask } from '../mcp/x/run-x-task.mjs';
import { createTestXCoderClient } from './lib/test-x-coder-client.mjs';

const fixtures = [];
function fixture(leaseDurationMs = 400) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-x-run-task-'));
  const dbPath = path.join(root, 'hearth-runtime.sqlite');
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'scripts/test-pass.mjs'), "import test from 'node:test';\ntest('passes', () => {});\n");
  const claims = new XClaimStore({ storagePath: dbPath, leaseDurationMs });
  const otherClaims = new XClaimStore({ storagePath: dbPath, leaseDurationMs });
  const runs = new XRunStore({ storagePath: dbPath });
  const item = { root, dbPath, claims, otherClaims, runs, xCoderRuntimes: [] };
  fixtures.push(item);
  return item;
}

afterEach(async () => {
  for (const item of fixtures.splice(0)) {
    for (const runtime of item.xCoderRuntimes.splice(0)) { try { await runtime.client.close(); } catch {} }
    item.claims.close();
    item.otherClaims.close();
    item.runs.close();
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

function taskFor(item, taskId = 'task-x-1', overrides = {}) {
  return {
    version: X_TASK_VERSION, task_id: taskId, parent_task_id: null,
    revision: 1, attempt: 1, based_on_result_id: null,
    objective: 'Run one X task.', problem: 'Execution needs a durable owner.',
    expected_behavior: 'The real X pipeline returns a fenced result.',
    observed_behavior: 'The production runner was absent.',
    why_this_matters: 'A stale owner must not publish a result.',
    known_evidence: [], suspected_area: [], workspace: { repo: 'Hearth-Control', root: item.root },
    scope: { allowed_paths: ['src'], preferred_files: [], forbidden_paths: [] },
    constraints: { preserve: [], do_not: [] }, allowed_tools: ['repo_read'],
    acceptance_criteria: ['The run is fenced.'],
    validation: { required: ['node --test scripts/test-pass.mjs'], optional: [] },
    verification: null, done_criteria: ['Required validation passes.'], teaching_notes: [],
    uncertainty_policy: { policy: 'bounded_autonomy', stop_conditions: [] },
    repair_budget: { initial_attempts: 1, max_repairs: 2, max_total_rounds: 3 },
    timing: { estimated_minutes: 5, first_check_after_minutes: 1, soft_deadline_minutes: 3, hard_timeout_minutes: 10 },
    commit_policy: { mode: 'never' },
    ...overrides,
  };
}

const model = (actions = []) => ({
  async generate() {
    return { ok: true, provider: 'fake', model: 'fake', text: JSON.stringify({ actions }), finishReason: 'stop', usage: null, error: null };
  },
});
const create = (pathName = 'src/ok.js') => ({ type: 'create', path: pathName, content: 'ok\n' });
const start = (item, task = taskFor(item), adapter = model(), overrides = {}) => {
  const { executionOptions = {}, xCoderClient: injectedClient, ...runOptions } = overrides;
  let xCoderClient = injectedClient;
  if (!xCoderClient) {
    const runtime = createTestXCoderClient({ root: item.root, modelAdapter: adapter, executionOptions });
    item.xCoderRuntimes.push(runtime);
    xCoderClient = runtime.client;
  }
  return runXTask(task, adapter, {
    claimStore: item.claims,
    runStore: item.runs,
    ownerId: 'owner-a',
    xCoderClient,
    xCoderPollIntervalMs: 1,
    ...runOptions,
  });
};

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function waitingModel() {
  const entered = deferred();
  return {
    entered: entered.promise,
    async generate(_request, options) {
      entered.resolve(options.signal);
      await new Promise((resolve) => {
        if (options.signal.aborted) resolve();
        else options.signal.addEventListener('abort', resolve, { once: true });
      });
      throw new XExecutionAbortedError();
    },
  };
}

test('invalid task is rejected before claim, run creation, and model execution', async () => {
  const item = fixture();
  let called = 0;
  await assert.rejects(start(item, { ...taskFor(item), version: 'wrong' }, { generate: () => { called += 1; } }), /Invalid x-task-v1/);
  assert.equal(item.claims.getRaw('task-x-1'), null);
  assert.equal(item.runs.getRun('run-1'), null);
  assert.equal(called, 0);
});

test('admission denial creates no run and starts no model', async () => {
  const item = fixture();
  item.otherClaims.claim({ taskId: 'other-task', ownerId: 'other-owner' });
  let called = 0;
  const admitted = await start(item, taskFor(item), { generate: () => { called += 1; } });
  assert.deepEqual(admitted, { accepted: false, reason: 'no_capacity', runId: null });
  assert.equal(item.runs.getRun('run-1'), null);
  assert.equal(called, 0);
});

for (const [name, action, status, gateStatus] of [
  ['COMPLETED', create(), 'completed', 'COMPLETED'],
  ['NEEDS_REVIEW', create('src/.env'), 'needs_review', 'NEEDS_REVIEW'],
  ['FAILED', create('outside/no.js'), 'failed', 'FAILED'],
]) {
  test(`${name} persists real X gate result through a fenced terminal write`, async () => {
    const item = fixture();
    const before = taskFor(item, 'task-x-1', { allowed_tools: ['repo_read', 'repo_edit'] });
    const task = structuredClone(before);
    const admitted = await start(item, task, model([action]), { runId: `run-${name}` });
    assert.equal(admitted.accepted, true);
    assert.equal(item.runs.getRun(admitted.runId).status, 'running');
    const result = await admitted.done;
    assert.equal(result.status, status, JSON.stringify(result));
    assert.equal(result.run.gateStatus, gateStatus);
    assert.equal(result.run.result.task_id, task.task_id);
    assert.equal(result.cleanup.released, true);
    assert.equal(item.claims.getActiveClaim(), null);
    assert.deepEqual(task, before);
  });
}

test('accepted run ID is exposed only after persisted running state and keeper start', async () => {
  const item = fixture();
  const adapter = waitingModel();
  const admitted = await start(item, taskFor(item), adapter);
  assert.equal(admitted.accepted, true);
  assert.equal(item.runs.getRun(admitted.runId).status, 'running');
  assert.equal(item.runs.getRun(admitted.runId).claimLeaseId, item.claims.getActiveClaim().leaseId);
  await adapter.entered;
  item.otherClaims.release({ taskId: 'task-x-1', ownerId: 'owner-a', leaseId: item.claims.getRaw('task-x-1').leaseId });
  await admitted.done;
});

test('keeper renews past original expiry and independent owners cannot enter', async () => {
  const item = fixture(300);
  const gate = deferred();
  const entered = deferred();
  const adapter = { async generate() { entered.resolve(); await gate.promise; return model().generate(); } };
  const admitted = await start(item, taskFor(item), adapter);
  assert.equal(admitted.accepted, true);
  await entered.promise;
  const originalExpiry = item.claims.getRaw('task-x-1').leaseExpiresAt;
  await sleep(750);
  assert.ok(Date.now() > originalExpiry);
  assert.ok(item.claims.getActiveClaim('task-x-1').leaseExpiresAt > originalExpiry);
  assert.equal(item.otherClaims.claim({ taskId: 'task-x-1', ownerId: 'owner-b' }), null);
  assert.equal(item.otherClaims.claim({ taskId: 'another-task', ownerId: 'owner-b' }), null);
  gate.resolve();
  assert.equal((await admitted.done).status, 'completed');
  assert.ok(item.otherClaims.claim({ taskId: 'another-task', ownerId: 'owner-b' }));
});

test('confirmed ownership loss aborts execution and leaves a nonterminal run', async () => {
  const item = fixture(600);
  const adapter = waitingModel();
  const admitted = await start(item, taskFor(item), adapter);
  assert.equal(admitted.accepted, true);
  const signal = await adapter.entered;
  const leaseId = item.claims.getActiveClaim().leaseId;
  assert.equal(item.otherClaims.release({ taskId: 'task-x-1', ownerId: 'owner-a', leaseId }), true);
  const result = await admitted.done;
  assert.equal(signal.aborted, true);
  assert.equal(result.status, 'ownership_lost');
  assert.equal(item.runs.getRun(admitted.runId).status, 'running');
  assert.equal(item.runs.getRun(admitted.runId).result, null);
});

test('renewal exception aborts execution but is not treated as confirmed loss or terminal failure', async () => {
  const item = fixture(600);
  const originalRenew = item.claims.renew.bind(item.claims);
  item.claims.renew = () => { throw new Error('renew database unavailable'); };
  const adapter = waitingModel();
  const admitted = await start(item, taskFor(item), adapter);
  assert.equal(admitted.accepted, true);
  const signal = await adapter.entered;
  const result = await admitted.done;
  assert.equal(signal.aborted, true);
  assert.equal(result.status, 'ownership_uncertain');
  assert.match(result.error.message, /renew database unavailable/);
  assert.equal(item.runs.getRun(admitted.runId).status, 'running');
  item.claims.renew = originalRenew;
});

test('ordinary execution throw uses failRunFenced and never stores an X result', async () => {
  const item = fixture();
  const executionOptions = Object.defineProperty({}, 'modelOptions', {
    enumerable: true, get() { throw new Error('unexpected orchestration fault'); },
  });
  const admitted = await start(item, taskFor(item), model(), { executionOptions });
  const result = await admitted.done;
  assert.equal(result.status, 'failed');
  assert.equal(result.run.gateStatus, null);
  assert.equal(result.run.result, null);
  assert.match(result.run.error, /unexpected orchestration fault/);
});

test('explicit X cancellation is not converted into an ordinary failed run', async () => {
  const item = fixture();
  const adapter = waitingModel();
  const admitted = await start(item, taskFor(item), adapter);
  await adapter.entered;

  const cancelled = await admitted.cancel();
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.status, 'cancelled');

  const result = await admitted.done;
  assert.equal(result.status, 'cancelled');
  assert.equal(item.runs.getRun(admitted.runId).status, 'cancelled');
  assert.equal(item.claims.getActiveClaim(), null);
});

test('null completeRunFenced reports fence rejection without unfenced fallback', async () => {
  const item = fixture();
  let calls = 0;
  item.runs.completeRunFenced = () => { calls += 1; return null; };
  item.runs.completeRun = () => { throw new Error('unfenced completion called'); };
  const admitted = await start(item);
  const result = await admitted.done;
  assert.equal(result.status, 'fence_rejected');
  assert.equal(calls, 1);
  assert.equal(item.runs.getRun(admitted.runId).status, 'running');
});

test('null failRunFenced reports fence rejection without unfenced fallback', async () => {
  const item = fixture();
  const executionOptions = Object.defineProperty({}, 'modelOptions', {
    enumerable: true, get() { throw new Error('unexpected execution fault'); },
  });
  let calls = 0;
  item.runs.failRunFenced = () => { calls += 1; return null; };
  item.runs.failRun = () => { throw new Error('unfenced failure called'); };
  const admitted = await start(item, taskFor(item), model(), { executionOptions });
  const result = await admitted.done;
  assert.equal(result.status, 'fence_rejected');
  assert.equal(calls, 1);
  assert.equal(item.runs.getRun(admitted.runId).status, 'running');
});

test('stale owner cannot persist a result after another store takes its claim', async () => {
  const item = fixture();
  const realComplete = item.runs.completeRunFenced.bind(item.runs);
  let newClaim;
  item.runs.completeRunFenced = (args) => {
    item.otherClaims.release({ taskId: args.xResult.task_id, ownerId: args.ownerId, leaseId: args.leaseId });
    newClaim = item.otherClaims.claim({ taskId: args.xResult.task_id, ownerId: 'owner-b' });
    return realComplete(args);
  };
  const admitted = await start(item);
  const result = await admitted.done;
  assert.ok(newClaim);
  assert.equal(result.status, 'fence_rejected');
  assert.equal(result.cleanup.released, false);
  assert.equal(item.runs.getRun(admitted.runId).status, 'running');
  assert.equal(item.otherClaims.getActiveClaim('task-x-1').leaseId, newClaim.leaseId);
});

test('release false is surfaced without changing an already persisted result', async () => {
  const item = fixture();
  item.claims.release = () => false;
  const admitted = await start(item);
  const result = await admitted.done;
  assert.equal(result.status, 'completed');
  assert.equal(result.cleanup.released, false);
  assert.equal(item.runs.getRun(admitted.runId).status, 'completed');
});

test('release exception is contained and done still resolves with persisted result', async () => {
  const item = fixture();
  item.claims.release = () => { throw new Error('release unavailable'); };
  const admitted = await start(item);
  const result = await admitted.done;
  assert.equal(result.status, 'completed');
  assert.match(result.cleanup.error.message, /release unavailable/);
  assert.equal(item.runs.getRun(admitted.runId).status, 'completed');
});

test('createRun failure after claim releases original lease and never starts execution', async () => {
  const item = fixture();
  item.runs.createRun = () => { throw new Error('create unavailable'); };
  let called = 0;
  const result = await start(item, taskFor(item), { generate: () => { called += 1; } });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'setup_failed');
  assert.equal(result.runId, null);
  assert.equal(result.cleanup.released, true);
  assert.equal(called, 0);
});

test('createRun throwing after its insert fences only its own persisted queued row', async () => {
  const item = fixture();
  const realCreate = item.runs.createRun.bind(item.runs);
  item.runs.createRun = (args) => {
    realCreate(args);
    throw new Error('create readback failed');
  };
  const result = await start(item, taskFor(item), model(), { runId: 'run-created' });
  assert.equal(result.accepted, false);
  assert.equal(result.runId, 'run-created');
  assert.equal(result.run.status, 'failed');
  assert.equal(result.cleanup.released, true);
});

test('duplicate runId cannot overwrite another run during setup cleanup', async () => {
  const item = fixture();
  item.runs.createRun({ runId: 'already-used', taskId: 'unrelated-task' });
  const result = await start(item, taskFor(item), model(), { runId: 'already-used' });
  assert.equal(result.accepted, false);
  assert.equal(result.runId, null);
  assert.equal(result.cleanup.released, true);
  assert.equal(item.runs.getRun('already-used').status, 'queued');
  assert.equal(item.runs.getRun('already-used').taskId, 'unrelated-task');
});

test('markRunning null fails claimed queued run through fenced failure and releases', async () => {
  const item = fixture();
  item.runs.markRunning = () => null;
  const result = await start(item, taskFor(item), model(), { runId: 'run-mark-fail' });
  assert.equal(result.accepted, false);
  assert.equal(result.runId, 'run-mark-fail');
  assert.equal(result.run.status, 'failed');
  assert.equal(result.run.gateStatus, null);
  assert.equal(result.cleanup.released, true);
});

test('keeper start failure prevents execution and uses fenced setup failure', async () => {
  const item = fixture();
  item.claims.getActiveClaim = () => null;
  let called = 0;
  const result = await start(item, taskFor(item), { generate: () => { called += 1; } });
  assert.equal(result.accepted, false);
  assert.equal(result.run.status, 'failed');
  assert.equal(result.cleanup.released, true);
  assert.equal(called, 0);
});

test('fenced setup failure returning null leaves its run nonterminal for reconciliation', async () => {
  const item = fixture();
  item.claims.getActiveClaim = () => null;
  item.runs.failRunFenced = () => null;
  const result = await start(item, taskFor(item), model(), { runId: 'run-stale-setup' });
  assert.equal(result.accepted, false);
  assert.equal(result.runId, 'run-stale-setup');
  assert.equal(result.run.status, 'running');
  assert.equal(result.cleanup.released, true);
});

test('a throw after fenced completion does not trigger a second terminal decision', async () => {
  const item = fixture();
  const realComplete = item.runs.completeRunFenced.bind(item.runs);
  item.runs.completeRunFenced = (args) => {
    realComplete(args);
    throw new Error('post-write readback failed');
  };
  item.runs.failRunFenced = () => { throw new Error('second terminal decision attempted'); };
  const admitted = await start(item);
  const result = await admitted.done;
  assert.equal(result.status, 'persistence_error');
  assert.equal(item.runs.getRun(admitted.runId).status, 'completed');
  assert.equal(result.cleanup.released, true);
});

test('terminal persistence occurs before keeper stop and original release', async () => {
  const item = fixture();
  const realRelease = item.claims.release.bind(item.claims);
  let statusAtRelease;
  item.claims.release = (args) => {
    statusAtRelease = item.runs.getRun('ordered-run').status;
    return realRelease(args);
  };
  const admitted = await start(item, taskFor(item), model(), { runId: 'ordered-run' });
  const result = await admitted.done;
  assert.equal(statusAtRelease, 'completed');
  assert.equal(result.cleanup.keeperStatus, 'stopped');
});

test('runner-owned signal overrides a caller-supplied execution signal', async () => {
  const item = fixture();
  const external = new AbortController();
  external.abort();
  let observed;
  const adapter = { async generate(_request, options) { observed = options.signal; return model().generate(); } };
  const admitted = await start(item, taskFor(item), adapter, { executionOptions: { signal: external.signal } });
  assert.equal((await admitted.done).status, 'completed');
  assert.notEqual(observed, external.signal);
  assert.equal(observed.aborted, false);
});

test('two independent run callers sharing SQLite cannot execute concurrently', async () => {
  const item = fixture();
  const adapter = waitingModel();
  const first = await start(item, taskFor(item), adapter);
  assert.equal(first.accepted, true);
  await adapter.entered;
  let secondCalled = 0;
  const secondAdapter = {
    async generate() { secondCalled += 1; return model().generate(); },
  };
  const secondRuntime = createTestXCoderClient({ root: item.root, modelAdapter: secondAdapter });
  item.xCoderRuntimes.push(secondRuntime);
  const second = await runXTask(taskFor(item, 'task-x-2'), secondAdapter, {
    claimStore: item.otherClaims,
    runStore: item.runs,
    ownerId: 'owner-b',
    xCoderClient: secondRuntime.client,
    xCoderPollIntervalMs: 1,
  });
  assert.deepEqual(second, { accepted: false, reason: 'no_capacity', runId: null });
  assert.equal(secondCalled, 0);
  item.otherClaims.release({ taskId: 'task-x-1', ownerId: 'owner-a', leaseId: item.claims.getRaw('task-x-1').leaseId });
  await first.done;
});

test('background done settles without an unhandled rejection when execution throws', async () => {
  const item = fixture();
  const executionOptions = Object.defineProperty({}, 'modelOptions', {
    enumerable: true, get() { throw new Error('background fault'); },
  });
  const admitted = await start(item, taskFor(item), model(), { executionOptions });
  assert.equal(admitted.accepted, true);
  await sleep(0);
  assert.equal((await admitted.done).status, 'failed');
});

test('different database paths are rejected before acquiring an execution claim', async () => {
  const item = fixture();
  const otherRuns = new XRunStore({ storagePath: path.join(item.root, 'other.sqlite') });
  try {
    await assert.rejects(runXTask(taskFor(item), model(), {
      claimStore: item.claims, runStore: otherRuns, ownerId: 'owner-a',
    }), /same runtime SQLite path/);
    assert.equal(item.claims.getActiveClaim(), null);
  } finally { otherRuns.close(); }
});
