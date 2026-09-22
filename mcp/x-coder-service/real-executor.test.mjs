import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseXTask, X_TASK_VERSION } from '../x/task-contract.mjs';
import { runTaskWithRepair } from '../x/repair-loop.mjs';
import { XClaimStore } from '../x/claim-store.mjs';
import { XRunStore } from '../x/run-store.mjs';
import { XLeaseKeeper } from '../x/lease-keeper.mjs';
import { cancelXTask } from '../x/cancel-x-task.mjs';
import { XCoderClient } from '../x/x-coder-client.mjs';
import { createXCoderService, startXCoderHttpServer } from './server.mjs';
import { RealXCoderExecutor } from './real-executor.mjs';

const dirs = [];
function tmpDir(prefix = 'hearth-x-coder-real-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeFile(root, relPath, content) {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

const sha256 = (value) => crypto.createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex');

const taskFor = (root, overrides = {}) => ({
  version: X_TASK_VERSION,
  task_id: 'TASK-X-CODER-REAL-1',
  parent_task_id: null,
  revision: 1,
  attempt: 1,
  based_on_result_id: null,
  objective: 'Apply one bounded repository change and validate it.',
  problem: 'The extracted X Coder Service must preserve the existing executor behavior.',
  expected_behavior: 'The same task produces equivalent repair evidence inside or outside the service.',
  observed_behavior: 'The real executor is being moved behind a service wrapper.',
  why_this_matters: 'Extraction must not weaken execution or evidence semantics.',
  known_evidence: [],
  suspected_area: [],
  workspace: { repo: 'fixture-repo', root },
  scope: { allowed_paths: ['src'], preferred_files: [], forbidden_paths: [] },
  constraints: { preserve: [], do_not: [] },
  allowed_tools: ['repo_read', 'repo_edit'],
  acceptance_criteria: ['Required validation passes or bounded escalation evidence is returned.'],
  validation: { required: ['node --test scripts/test-pass.mjs'], optional: [] },
  verification: null,
  done_criteria: ['RepairOutcome is preserved.'],
  teaching_notes: [],
  uncertainty_policy: { policy: 'bounded_autonomy', stop_conditions: [] },
  repair_budget: { initial_attempts: 1, max_repairs: 2, max_total_rounds: 3 },
  timing: { estimated_minutes: 5, first_check_after_minutes: 1, soft_deadline_minutes: 3, hard_timeout_minutes: 10 },
  commit_policy: { mode: 'never' },
  ...overrides,
});

const queueAdapter = (responses, { onGenerate } = {}) => {
  const calls = [];
  return {
    calls,
    async generate(request) {
      calls.push(request);
      if (onGenerate) await onGenerate(calls.length, request);
      const payload = responses[Math.min(calls.length - 1, responses.length - 1)];
      return {
        ok: true,
        provider: 'fixture',
        model: 'fixture-model',
        requestedModel: null,
        text: JSON.stringify(payload),
        finishReason: 'stop',
        usage: null,
        error: null,
      };
    },
  };
};

const shapeOf = (value) => {
  if (Array.isArray(value)) return value.length > 0 ? [shapeOf(value[0])] : [];
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, shapeOf(value[key])]));
  }
  return typeof value;
};

const startServiceRun = async ({ root, adapter, taskOverrides = {}, key = 'real-service-run' }) => {
  const storagePath = path.join(tmpDir('hearth-x-coder-db-'), 'idempotency.sqlite');
  const service = createXCoderService({
    storagePath,
    executor: new RealXCoderExecutor({ modelAdapter: adapter }),
  });
  const task = taskFor(root, taskOverrides);
  const submitted = service.submit({
    version: 'x-executor-api-v1',
    idempotency_key: key,
    lease_expires_at: Date.now() + 60_000,
    task,
  });
  await service.registry.waitForAttachedRun(submitted.run_id);
  return { service, task, submitted, status: service.getStatus({ version: 'x-executor-api-v1', run_id: submitted.run_id }) };
};

test('S7.5-1 service real executor matches in-process RepairOutcome for the same create+validate fixture', async () => {
  const directRoot = tmpDir();
  const serviceRoot = tmpDir();
  for (const root of [directRoot, serviceRoot]) {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFile(root, 'scripts/test-pass.mjs', "import test from 'node:test';\ntest('ok', () => {});\n");
  }

  const response = { actions: [{ type: 'create', path: 'src/new.js', content: 'hello' }] };
  const direct = await runTaskWithRepair(parseXTask(taskFor(directRoot)), queueAdapter([response]));
  const serviceRun = await startServiceRun({ root: serviceRoot, adapter: queueAdapter([response]) });

  assert.equal(serviceRun.status.status, 'completed');
  assert.equal(serviceRun.status.result.status, direct.status);
  assert.equal(serviceRun.status.result.task_id, direct.task_id);
  assert.equal(serviceRun.status.result.total_rounds, direct.total_rounds);
  assert.deepEqual(shapeOf(serviceRun.status.result), shapeOf(direct));
  assert.deepEqual(serviceRun.status.result.rounds[0].executor.files_changed, direct.rounds[0].executor.files_changed);
  assert.equal(fs.readFileSync(path.join(directRoot, 'src/new.js'), 'utf8'), 'hello');
  assert.equal(fs.readFileSync(path.join(serviceRoot, 'src/new.js'), 'utf8'), 'hello');

  serviceRun.service.close();
});

test('S7.5-2 repair-budget exhaustion preserves the existing evidence shape through the service', async () => {
  const directRoot = tmpDir();
  const serviceRoot = tmpDir();
  for (const root of [directRoot, serviceRoot]) {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFile(root, 'scripts/test-fail.mjs', [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "test('fails', () => assert.equal(1, 2));",
    ].join('\n'));
  }

  const overrides = {
    validation: { required: ['node --test scripts/test-fail.mjs'], optional: [] },
    repair_budget: { initial_attempts: 1, max_repairs: 2, max_total_rounds: 3 },
  };
  const noOp = { actions: [] };
  const direct = await runTaskWithRepair(parseXTask(taskFor(directRoot, overrides)), queueAdapter([noOp]));
  const serviceRun = await startServiceRun({
    root: serviceRoot,
    adapter: queueAdapter([noOp]),
    taskOverrides: overrides,
    key: 'repair-exhaustion',
  });

  assert.equal(direct.status, 'escalation_required');
  assert.equal(direct.total_rounds, 3);
  assert.equal(serviceRun.status.status, 'completed');
  assert.equal(serviceRun.status.result.status, 'escalation_required');
  assert.equal(serviceRun.status.result.total_rounds, 3);
  assert.deepEqual(shapeOf(serviceRun.status.result), shapeOf(direct));
  for (const round of serviceRun.status.result.rounds) {
    assert.equal(round.kind, 'validation');
    assert.equal(round.validation.required[0].status, 'failed');
  }

  serviceRun.service.close();
});

test('S7.5-3 cancelling the real repair-loop path leaves the existing target whole and no temp residue', async () => {
  const root = tmpDir();
  const original = 'ORIGINAL_CONTENT\n';
  const target = writeFile(root, 'src/target.js', original);
  writeFile(root, 'scripts/test-pass.mjs', "import test from 'node:test';\ntest('ok', () => {});\n");
  const beforeStat = fs.statSync(target);
  const beforeHash = sha256(fs.readFileSync(target, 'utf8'));

  let releaseModel;
  const modelReady = new Promise((resolve) => { releaseModel = resolve; });
  let generated = false;
  const adapter = {
    async generate() {
      generated = true;
      releaseModel();
      await new Promise((resolve) => setTimeout(resolve, 75));
      return {
        ok: true,
        provider: 'fixture',
        model: 'fixture-model',
        requestedModel: null,
        text: JSON.stringify({
          actions: [{
            type: 'replace',
            path: 'src/target.js',
            content: 'X'.repeat(900_000),
          }],
        }),
        finishReason: 'stop',
        usage: null,
        error: null,
      };
    },
  };

  const storagePath = path.join(tmpDir('hearth-x-coder-cancel-db-'), 'idempotency.sqlite');
  const service = createXCoderService({
    storagePath,
    executor: new RealXCoderExecutor({ modelAdapter: adapter }),
  });
  const task = taskFor(root, {
    task_id: 'TASK-X-CODER-CANCEL',
    suspected_area: ['src/target.js'],
    scope: { allowed_paths: ['src'], preferred_files: ['src/target.js'], forbidden_paths: [] },
  });
  const submitted = service.submit({
    version: 'x-executor-api-v1',
    idempotency_key: 'real-cancel',
    lease_expires_at: Date.now() + 60_000,
    task,
  });

  await modelReady;
  assert.equal(generated, true);
  const cancelled = await service.cancel({
    version: 'x-executor-api-v1',
    run_id: submitted.run_id,
  });

  assert.equal(cancelled.acknowledged, true);
  assert.equal(cancelled.status, 'cancelled');
  const afterContent = fs.readFileSync(target, 'utf8');
  const afterStat = fs.statSync(target);
  assert.equal(sha256(afterContent), beforeHash);
  assert.equal(afterContent, original);
  assert.equal(afterStat.size, beforeStat.size);
  assert.equal(fs.readdirSync(path.dirname(target)).some((name) => name.startsWith('.x-write-tmp-')), false);

  service.close();
});


test('S7.5-4 explicit Hearth cancel persists only after real service ack and leaves filesystem unchanged', async () => {
  const root = tmpDir();
  const target = writeFile(root, 'src/target.js', 'ORIGINAL\n');
  writeFile(root, 'scripts/test-pass.mjs', "import test from 'node:test';\ntest('ok', () => {});\n");
  const beforeHash = sha256(fs.readFileSync(target, 'utf8'));

  let modelStartedResolve;
  const modelStarted = new Promise((resolve) => { modelStartedResolve = resolve; });
  const adapter = {
    async generate() {
      modelStartedResolve();
      await new Promise((resolve) => setTimeout(resolve, 200));
      return {
        ok: true,
        provider: 'fixture',
        model: 'fixture-model',
        requestedModel: null,
        text: JSON.stringify({
          actions: [{ type: 'replace', path: 'src/target.js', content: 'REPLACED\n' }],
        }),
        finishReason: 'stop',
        usage: null,
        error: null,
      };
    },
  };

  const serviceStorage = path.join(tmpDir('hearth-x-coder-explicit-service-'), 'idempotency.sqlite');
  const runtime = await startXCoderHttpServer({
    storagePath: serviceStorage,
    port: 0,
    executor: new RealXCoderExecutor({ modelAdapter: adapter }),
  });
  const client = new XCoderClient({ baseUrl: 'http://127.0.0.1:' + runtime.port });

  const task = taskFor(root, {
    task_id: 'TASK-X-CODER-EXPLICIT-CANCEL',
    suspected_area: ['src/target.js'],
    scope: { allowed_paths: ['src'], preferred_files: ['src/target.js'], forbidden_paths: [] },
  });
  const submitted = await client.submit({
    idempotencyKey: 'explicit-cancel',
    task,
    leaseExpiresAt: Date.now() + 60_000,
  });
  await modelStarted;

  const hearthDb = path.join(tmpDir('hearth-x-coder-explicit-hearth-'), 'hearth-runtime.sqlite');
  const claimStore = new XClaimStore({ storagePath: hearthDb, leaseDurationMs: 30_000 });
  const runStore = new XRunStore({ storagePath: hearthDb });
  const claim = claimStore.claim({ taskId: task.task_id, ownerId: 'owner-explicit-cancel' });
  runStore.createRun({ runId: submitted.runId, taskId: task.task_id, claimLeaseId: claim.leaseId });
  runStore.markRunning({ runId: submitted.runId, claimLeaseId: claim.leaseId });
  const keeper = new XLeaseKeeper({ claimStore, claim }).start();

  const result = await cancelXTask({
    runId: submitted.runId,
    taskId: task.task_id,
    claim,
    claimStore,
    runStore,
    keeper,
    xCoderClient: client,
  });

  assert.equal(result.cancelled, true);
  assert.equal(result.clean, true);
  assert.equal(result.run.status, 'cancelled');
  assert.equal(runStore.getRun(submitted.runId).status, 'cancelled');
  assert.equal(claimStore.getRaw(task.task_id).state, 'released');
  assert.equal((await client.getStatus(submitted.runId)).status, 'cancelled');
  assert.equal(sha256(fs.readFileSync(target, 'utf8')), beforeHash);
  assert.equal(fs.readdirSync(path.dirname(target)).some((name) => name.startsWith('.x-write-tmp-')), false);

  runStore.close();
  claimStore.close();
  await runtime.stop();
});
