import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { makeValidTask } from '../x/executor-contract/fixtures.mjs';
import { createXCoderService, startXCoderHttpServer } from './server.mjs';
import { StubExecutor } from './stub-executor.mjs';

const fixtures = [];
const fixture = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-x-coder-service-'));
  const item = {
    dir,
    storagePath: path.join(dir, 'x-coder-idempotency.sqlite'),
    services: [],
    servers: [],
  };
  fixtures.push(item);
  return item;
};

afterEach(async () => {
  for (const item of fixtures.splice(0)) {
    for (const runtime of item.servers.reverse()) {
      try { await runtime.stop(); } catch {}
    }
    for (const service of item.services.reverse()) {
      try { service.close(); } catch {}
    }
    fs.rmSync(item.dir, { recursive: true, force: true });
  }
});

test('S4-1 first submit durably reserves before one stub execution, duplicate key never starts twice', async () => {
  const item = fixture();
  const executor = new StubExecutor({ delayMs: 20 });
  const service = createXCoderService({ storagePath: item.storagePath, executor });
  item.services.push(service);

  const request = {
    version: 'x-executor-api-v1',
    idempotency_key: 'idem-1',
    task: makeValidTask(),
  };
  const first = service.submit(request);
  const duplicate = service.submit(request);

  assert.equal(first.duplicate, false);
  assert.equal(first.status, 'running');
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.run_id, first.run_id);

  const durable = service.store.getByIdempotencyKey('idem-1');
  assert.equal(durable.runId, first.run_id);
  assert.ok(['submitted', 'running'].includes(durable.state));

  await service.registry.waitForAttachedRun(first.run_id);
  assert.equal(executor.calls, 1);
  const final = service.getStatus({ version: 'x-executor-api-v1', run_id: first.run_id });
  assert.equal(final.status, 'completed');
  assert.equal(final.result.task_id, request.task.task_id);
});

test('S4-2 distinct idempotency keys create distinct runs and execute independently in sequence', async () => {
  const item = fixture();
  const executor = new StubExecutor({ delayMs: 5 });
  const service = createXCoderService({ storagePath: item.storagePath, executor });
  item.services.push(service);

  const first = service.submit({
    version: 'x-executor-api-v1',
    idempotency_key: 'idem-a',
    task: makeValidTask(),
  });
  await service.registry.waitForAttachedRun(first.run_id);

  const secondTask = makeValidTask();
  secondTask.task_id = 'task-2';
  const second = service.submit({
    version: 'x-executor-api-v1',
    idempotency_key: 'idem-b',
    task: secondTask,
  });
  await service.registry.waitForAttachedRun(second.run_id);

  assert.notEqual(first.run_id, second.run_id);
  assert.equal(executor.calls, 2);
  assert.equal(service.getStatus({ version: 'x-executor-api-v1', run_id: first.run_id }).status, 'completed');
  assert.equal(service.getStatus({ version: 'x-executor-api-v1', run_id: second.run_id }).status, 'completed');
});

test('S4-3 cancel aborts an attached stub run and produces terminal cancelled status', async () => {
  const item = fixture();
  const executor = new StubExecutor({ delayMs: 10_000 });
  const service = createXCoderService({ storagePath: item.storagePath, executor });
  item.services.push(service);

  const submitted = service.submit({
    version: 'x-executor-api-v1',
    idempotency_key: 'idem-cancel',
    task: makeValidTask(),
  });
  const cancelled = await service.cancel({
    version: 'x-executor-api-v1',
    run_id: submitted.run_id,
  });

  assert.equal(cancelled.acknowledged, true);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(service.getStatus({ version: 'x-executor-api-v1', run_id: submitted.run_id }).status, 'cancelled');
});

test('S4-4 normal completion survives a fresh service instance without re-execution', async () => {
  const item = fixture();
  const firstExecutor = new StubExecutor({ delayMs: 5 });
  const firstService = createXCoderService({ storagePath: item.storagePath, executor: firstExecutor });

  const submitted = firstService.submit({
    version: 'x-executor-api-v1',
    idempotency_key: 'idem-complete',
    task: makeValidTask(),
  });
  await firstService.registry.waitForAttachedRun(submitted.run_id);
  firstService.close();

  const secondExecutor = new StubExecutor({ delayMs: 5 });
  const secondService = createXCoderService({ storagePath: item.storagePath, executor: secondExecutor });
  item.services.push(secondService);

  assert.deepEqual(secondService.interruptedOnStartup, []);
  const duplicate = secondService.submit({
    version: 'x-executor-api-v1',
    idempotency_key: 'idem-complete',
    task: makeValidTask(),
  });
  assert.equal(duplicate.run_id, submitted.run_id);
  assert.equal(duplicate.status, 'completed');
  assert.equal(duplicate.duplicate, true);
  assert.equal(secondExecutor.calls, 0);
});

test('S4-5 HTTP boundary exposes submit/status/cancel over localhost JSON only', async () => {
  const item = fixture();
  const runtime = await startXCoderHttpServer({
    storagePath: item.storagePath,
    port: 0,
    executor: new StubExecutor({ delayMs: 5 }),
  });
  item.servers.push(runtime);
  const base = 'http://127.0.0.1:' + runtime.port;

  const submitResponse = await fetch(base + '/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      version: 'x-executor-api-v1',
      idempotency_key: 'idem-http',
      task: makeValidTask(),
    }),
  });
  assert.equal(submitResponse.status, 200);
  const submitted = await submitResponse.json();
  assert.equal(submitted.duplicate, false);

  await runtime.service.registry.waitForAttachedRun(submitted.run_id);
  const statusResponse = await fetch(base + '/status', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: 'x-executor-api-v1', run_id: submitted.run_id }),
  });
  assert.equal(statusResponse.status, 200);
  assert.equal((await statusResponse.json()).status, 'completed');

  const invalidResponse = await fetch(base + '/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: 'x-executor-api-v1', idempotency_key: '', task: makeValidTask() }),
  });
  assert.equal(invalidResponse.status, 400);
});
