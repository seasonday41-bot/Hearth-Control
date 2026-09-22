import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { XClaimStore } from '../mcp/x/claim-store.mjs';
import { XRunStore } from '../mcp/x/run-store.mjs';
import { runXTask } from '../mcp/x/run-x-task.mjs';
import { XCoderClient } from '../mcp/x/x-coder-client.mjs';
import { EXECUTOR_API_VERSION } from '../mcp/x/executor-contract/index.mjs';
import { createXCoderService, startXCoderHttpServer } from '../mcp/x-coder-service/server.mjs';
import { RealXCoderExecutor } from '../mcp/x-coder-service/real-executor.mjs';
import { StubExecutor } from '../mcp/x-coder-service/stub-executor.mjs';
import { createTestXCoderClient } from './lib/test-x-coder-client.mjs';

const fixtures = [];

function fixture({ leaseDurationMs = 1_000 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-x-cutover-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(
    path.join(root, 'scripts/test-pass.mjs'),
    "import test from 'node:test';\ntest('passes', () => {});\n",
  );
  const hearthDb = path.join(root, 'hearth-runtime.sqlite');
  const claims = new XClaimStore({ storagePath: hearthDb, leaseDurationMs });
  const runs = new XRunStore({ storagePath: hearthDb });
  const item = { root, hearthDb, claims, runs, runtimes: [], services: [] };
  fixtures.push(item);
  return item;
}

afterEach(async () => {
  for (const item of fixtures.splice(0)) {
    for (const runtime of item.runtimes.reverse()) {
      try { await runtime.stop(); } catch {}
    }
    for (const service of item.services.reverse()) {
      try { service.close(); } catch {}
    }
    try { item.claims.close(); } catch {}
    try { item.runs.close(); } catch {}
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

function taskFor(item, taskId, { actionPath = 'src/ok.js', actionType = 'create' } = {}) {
  return {
    version: 'x-task-v1',
    task_id: taskId,
    parent_task_id: null,
    revision: 1,
    attempt: 1,
    based_on_result_id: null,
    objective: 'Run one Slice 8 cutover task.',
    problem: 'Execution must cross the X Coder Service boundary.',
    expected_behavior: 'Hearth persists the same gate outcome as the pre-cutover path.',
    observed_behavior: 'This fixture exercises the extracted worker.',
    why_this_matters: 'Cutover must preserve output and stale-writer safety.',
    known_evidence: [],
    suspected_area: ['src'],
    workspace: { repo: 'Hearth-Control', root: item.root },
    scope: { allowed_paths: ['src'], preferred_files: [], forbidden_paths: [] },
    constraints: { preserve: [], do_not: [] },
    allowed_tools: ['repo_read', 'repo_edit'],
    acceptance_criteria: ['The expected terminal truth is persisted.'],
    validation: { required: ['node --test scripts/test-pass.mjs'], optional: [] },
    verification: null,
    done_criteria: ['The run terminates safely.'],
    teaching_notes: [],
    uncertainty_policy: { policy: 'bounded_autonomy', stop_conditions: [] },
    repair_budget: { initial_attempts: 1, max_repairs: 2, max_total_rounds: 3 },
    timing: { estimated_minutes: 5, first_check_after_minutes: 1, soft_deadline_minutes: 3, hard_timeout_minutes: 10 },
    commit_policy: { mode: 'never' },
    __fixture: { actionPath, actionType },
  };
}

const stripFixtureField = (task) => {
  const copy = structuredClone(task);
  delete copy.__fixture;
  return copy;
};

const actionModel = (actionFactory) => ({
  async generate() {
    return {
      ok: true,
      provider: 'fake',
      model: 'fake',
      text: JSON.stringify({ actions: [actionFactory()] }),
      finishReason: 'stop',
      usage: null,
      error: null,
    };
  },
});

async function startHttpRuntime(item, modelAdapter) {
  const runtime = await startXCoderHttpServer({
    storagePath: path.join(item.root, 'x-coder-http-' + crypto.randomUUID() + '.sqlite'),
    port: 0,
    executor: new RealXCoderExecutor({ modelAdapter }),
  });
  item.runtimes.push(runtime);
  return {
    runtime,
    client: new XCoderClient({
      baseUrl: 'http://127.0.0.1:' + runtime.port,
      timeoutMs: 5_000,
    }),
  };
}

const directClientFor = (service) => ({
  async submit({ idempotencyKey, task, leaseExpiresAt }) {
    const result = service.submit({
      version: EXECUTOR_API_VERSION,
      idempotency_key: idempotencyKey,
      lease_expires_at: leaseExpiresAt,
      task,
    });
    return { runId: result.run_id, status: result.status, duplicate: result.duplicate };
  },
  async getStatus(runId) {
    const result = service.getStatus({ version: EXECUTOR_API_VERSION, run_id: runId });
    if (!result) return null;
    return { runId: result.run_id, status: result.status, result: result.result, error: result.error };
  },
  async leaseValid(runId, leaseExpiresAt) {
    const result = service.leaseValid({
      version: EXECUTOR_API_VERSION,
      run_id: runId,
      lease_expires_at: leaseExpiresAt,
    });
    if (!result) return null;
    return {
      runId: result.run_id,
      status: result.status,
      leaseExpiresAt: result.lease_expires_at,
      accepted: result.accepted,
    };
  },
  async cancel(runId) {
    const result = await service.cancel({ version: EXECUTOR_API_VERSION, run_id: runId });
    if (!result) return null;
    return {
      runId: result.run_id,
      status: result.status,
      result: result.result,
      error: result.error,
      acknowledged: result.acknowledged,
    };
  },
});

test('S8-1 real HTTP X Coder Service preserves COMPLETED gate/result output', async () => {
  const item = fixture();
  const modelAdapter = actionModel(() => ({ type: 'create', path: 'src/ok.js', content: 'ok\n' }));
  const { client } = await startHttpRuntime(item, modelAdapter);
  const task = stripFixtureField(taskFor(item, 'slice8-completed'));

  const admitted = await runXTask(task, modelAdapter, {
    claimStore: item.claims,
    runStore: item.runs,
    xCoderClient: client,
    ownerId: 'owner-completed',
    runId: 'hearth-completed',
    xCoderPollIntervalMs: 5,
  });
  assert.equal(admitted.accepted, true);

  const outcome = await admitted.done;
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.run.gateStatus, 'COMPLETED');
  assert.equal(outcome.run.result.task_id, task.task_id);
  assert.deepEqual(outcome.run.result.files_changed, ['src/ok.js']);
  assert.equal(item.runs.getRun('hearth-completed').status, 'completed');
});

test('S8-2 real HTTP X Coder Service preserves NEEDS_REVIEW gate/result output', async () => {
  const item = fixture();
  const modelAdapter = actionModel(() => ({ type: 'create', path: 'src/.env', content: 'SECRET=x\n' }));
  const { client } = await startHttpRuntime(item, modelAdapter);
  const task = stripFixtureField(taskFor(item, 'slice8-review'));

  const admitted = await runXTask(task, modelAdapter, {
    claimStore: item.claims,
    runStore: item.runs,
    xCoderClient: client,
    ownerId: 'owner-review',
    runId: 'hearth-review',
    xCoderPollIntervalMs: 5,
  });

  const outcome = await admitted.done;
  assert.equal(outcome.status, 'needs_review');
  assert.equal(outcome.run.gateStatus, 'NEEDS_REVIEW');
  assert.equal(outcome.run.result.task_id, task.task_id);
  assert.equal(item.runs.getRun('hearth-review').status, 'needs_review');
  assert.equal(fs.existsSync(path.join(item.root, 'src/.env')), false);
});

test('S8-3 explicit cancel crosses HTTP service ack before fenced Hearth cancellation', async () => {
  const item = fixture({ leaseDurationMs: 2_000 });
  let entered;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const modelAdapter = {
    async generate(_request, options = {}) {
      entered();
      await new Promise((resolve, reject) => {
        if (options.signal?.aborted) {
          reject(options.signal.reason ?? new Error('aborted'));
          return;
        }
        options.signal?.addEventListener('abort', () => reject(options.signal.reason ?? new Error('aborted')), { once: true });
      });
    },
  };
  const { client } = await startHttpRuntime(item, modelAdapter);
  const task = stripFixtureField(taskFor(item, 'slice8-cancel'));

  const admitted = await runXTask(task, modelAdapter, {
    claimStore: item.claims,
    runStore: item.runs,
    xCoderClient: client,
    ownerId: 'owner-cancel',
    runId: 'hearth-cancel',
    xCoderPollIntervalMs: 5,
  });
  await enteredPromise;

  const cancellation = await admitted.cancel();
  assert.equal(cancellation.cancelled, true);
  assert.equal(cancellation.status, 'cancelled');
  assert.equal(cancellation.run.status, 'cancelled');
  assert.equal(item.runs.getRun('hearth-cancel').status, 'cancelled');

  const outcome = await admitted.done;
  assert.equal(outcome.status, 'cancelled');
  assert.equal(item.claims.getActiveClaim('slice8-cancel'), null);
});

test('S8-4 service restart interruption falls through to Hearth lease-expiry reconciliation', async () => {
  const item = fixture({ leaseDurationMs: 80 });
  const serviceDb = path.join(item.root, 'x-coder-restart.sqlite');

  const preCrash = createXCoderService({
    storagePath: serviceDb,
    executor: new StubExecutor({ delayMs: 10_000 }),
  });
  preCrash.store.reserve({ idempotencyKey: 'hearth-restart', runId: 'service-restart' });
  preCrash.store.markRunning('service-restart');
  preCrash.close();

  const restarted = createXCoderService({
    storagePath: serviceDb,
    executor: new StubExecutor({ delayMs: 5 }),
  });
  item.services.push(restarted);
  assert.deepEqual(restarted.interruptedOnStartup, ['service-restart']);

  const client = directClientFor(restarted);
  const task = stripFixtureField(taskFor(item, 'slice8-restart'));
  const admitted = await runXTask(task, {}, {
    claimStore: item.claims,
    runStore: item.runs,
    xCoderClient: client,
    ownerId: 'owner-restart',
    runId: 'hearth-restart',
    leaseDurationMs: 80,
    xCoderPollIntervalMs: 1,
  });

  const outcome = await admitted.done;
  assert.equal(outcome.status, 'interrupted');
  assert.equal(outcome.reconciliationRequired, true);
  assert.equal(outcome.cleanup.released, null);
  assert.equal(item.runs.getRun('hearth-restart').status, 'running');

  await sleep(130);
  const reconciled = item.runs.reconcileStartupState((taskId, leaseId) => {
    const active = item.claims.getActiveClaim(taskId);
    return Boolean(active && active.leaseId === leaseId);
  });
  assert.deepEqual(reconciled, ['hearth-restart']);
  assert.equal(item.runs.getRun('hearth-restart').status, 'interrupted');
});

test('S8-5 watchdog firing at the write boundary prevents stale filesystem mutation', async () => {
  const item = fixture({ leaseDurationMs: 5_000 });
  const target = path.join(item.root, 'src/target.js');
  fs.writeFileSync(target, 'before\n');
  const beforeHash = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
  const beforeMtime = fs.statSync(target).mtimeMs;

  let runtimeRef = null;
  let watchdogFiredAtWriteBoundary = false;
  const writeLimits = {
    get maxBytesPerWrite() {
      const live = runtimeRef && [...runtimeRef.service.registry.live.values()][0];
      if (live && !watchdogFiredAtWriteBoundary) {
        watchdogFiredAtWriteBoundary = true;
        live.leaseExpiresAt = Date.now() - 1;
        runtimeRef.service.registry._expireLease(live.runId, live.leaseExpiresAt);
      }
      return 200_000;
    },
    maxEditsPerOperation: 50,
    maxBytesPerEditString: 100_000,
    maxAggregateEditBytes: 200_000,
  };

  const modelAdapter = actionModel(() => ({
    type: 'replace',
    path: 'src/target.js',
    content: 'after\n',
  }));
  runtimeRef = createTestXCoderClient({
    root: item.root,
    modelAdapter,
    executionOptions: { writeLimits },
  });
  item.services.push(runtimeRef.service);

  const task = stripFixtureField(taskFor(item, 'slice8-stale-writer'));
  const admitted = await runXTask(task, modelAdapter, {
    claimStore: item.claims,
    runStore: item.runs,
    xCoderClient: runtimeRef.client,
    ownerId: 'owner-stale-writer',
    runId: 'hearth-stale-writer',
    leaseDurationMs: 5_000,
    xCoderPollIntervalMs: 1,
  });

  const outcome = await admitted.done;
  assert.equal(watchdogFiredAtWriteBoundary, true);
  assert.equal(outcome.status, 'interrupted');
  assert.equal(outcome.reconciliationRequired, true);

  const afterHash = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
  const afterMtime = fs.statSync(target).mtimeMs;
  assert.equal(afterHash, beforeHash);
  assert.equal(afterMtime, beforeMtime);
  assert.equal(fs.readFileSync(target, 'utf8'), 'before\n');
  assert.equal(
    fs.readdirSync(path.dirname(target)).some((name) => name.startsWith('.x-write-tmp-')),
    false,
  );
});
