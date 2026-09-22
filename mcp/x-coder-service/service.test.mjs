import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { makeValidTask } from '../x/executor-contract/fixtures.mjs';
import { createXCoderService, startXCoderHttpServer } from './server.mjs';
import { StubExecutor } from './stub-executor.mjs';
import { X_CODER_AUTH_HEADER } from '../x/x-coder-auth.mjs';

const fixtures = [];
const fixture = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-x-coder-service-'));
  const item = {
    dir,
    storagePath: path.join(dir, 'x-coder-idempotency.sqlite'),
    authSecretPath: path.join(dir, 'auth.secret'),
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
    lease_expires_at: Date.now() + 60_000,
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
    lease_expires_at: Date.now() + 60_000,
    task: makeValidTask(),
  });
  await service.registry.waitForAttachedRun(first.run_id);

  const secondTask = makeValidTask();
  secondTask.task_id = 'task-2';
  const second = service.submit({
    version: 'x-executor-api-v1',
    idempotency_key: 'idem-b',
    lease_expires_at: Date.now() + 60_000,
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
    lease_expires_at: Date.now() + 60_000,
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
    lease_expires_at: Date.now() + 60_000,
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
    lease_expires_at: Date.now() + 60_000,
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
    authSecretPath: item.authSecretPath,
    port: 0,
    executor: new StubExecutor({ delayMs: 5 }),
  });
  item.servers.push(runtime);
  const base = 'http://127.0.0.1:' + runtime.port;
  const authHeaders = { 'content-type': 'application/json', [X_CODER_AUTH_HEADER]: runtime.authSecret };

  const submitResponse = await fetch(base + '/submit', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      version: 'x-executor-api-v1',
      idempotency_key: 'idem-http',
      lease_expires_at: Date.now() + 60_000,
      task: makeValidTask(),
    }),
  });
  assert.equal(submitResponse.status, 200);
  const submitted = await submitResponse.json();
  assert.equal(submitted.duplicate, false);

  await runtime.service.registry.waitForAttachedRun(submitted.run_id);
  const statusResponse = await fetch(base + '/status', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ version: 'x-executor-api-v1', run_id: submitted.run_id }),
  });
  assert.equal(statusResponse.status, 200);
  assert.equal((await statusResponse.json()).status, 'completed');

  const invalidResponse = await fetch(base + '/submit', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ version: 'x-executor-api-v1', idempotency_key: '', lease_expires_at: Date.now() + 60_000, task: makeValidTask() }),
  });
  assert.equal(invalidResponse.status, 400);
});

test('S10-1 protected routes reject a missing auth header before touching the executor', async () => {
  const item = fixture();
  const executor = new StubExecutor({ delayMs: 5 });
  const runtime = await startXCoderHttpServer({
    storagePath: item.storagePath,
    authSecretPath: item.authSecretPath,
    port: 0,
    executor,
  });
  item.servers.push(runtime);
  const base = 'http://127.0.0.1:' + runtime.port;

  const response = await fetch(base + '/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      version: 'x-executor-api-v1',
      idempotency_key: 'idem-noauth',
      lease_expires_at: Date.now() + 60_000,
      task: makeValidTask(),
    }),
  });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, 'unauthorized');
  assert.equal(executor.calls, 0);
});

test('S10-2 protected routes reject an incorrect auth header before touching the executor', async () => {
  const item = fixture();
  const executor = new StubExecutor({ delayMs: 5 });
  const runtime = await startXCoderHttpServer({
    storagePath: item.storagePath,
    authSecretPath: item.authSecretPath,
    port: 0,
    executor,
  });
  item.servers.push(runtime);
  const base = 'http://127.0.0.1:' + runtime.port;

  const response = await fetch(base + '/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json', [X_CODER_AUTH_HEADER]: 'wrong-secret' },
    body: JSON.stringify({
      version: 'x-executor-api-v1',
      idempotency_key: 'idem-badauth',
      lease_expires_at: Date.now() + 60_000,
      task: makeValidTask(),
    }),
  });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, 'unauthorized');
  assert.equal(executor.calls, 0);
});

test('S10-3 status, cancel, and lease-valid all require the auth header', async () => {
  const item = fixture();
  const runtime = await startXCoderHttpServer({
    storagePath: item.storagePath,
    authSecretPath: item.authSecretPath,
    port: 0,
    executor: new StubExecutor({ delayMs: 5 }),
  });
  item.servers.push(runtime);
  const base = 'http://127.0.0.1:' + runtime.port;

  for (const route of ['/status', '/cancel', '/lease-valid']) {
    const response = await fetch(base + route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 'x-executor-api-v1', run_id: 'does-not-matter' }),
    });
    assert.equal(response.status, 401, `${route} should require auth`);
    assert.equal((await response.json()).error, 'unauthorized');
  }
});

test('S10-4 /health stays open and unauthenticated', async () => {
  const item = fixture();
  const runtime = await startXCoderHttpServer({
    storagePath: item.storagePath,
    authSecretPath: item.authSecretPath,
    port: 0,
    executor: new StubExecutor({ delayMs: 5 }),
  });
  item.servers.push(runtime);

  const response = await fetch('http://127.0.0.1:' + runtime.port + '/health');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'ok');
});

test('S10-5 a valid auth header is accepted on submit, status, cancel, and lease-valid', async () => {
  const item = fixture();
  const runtime = await startXCoderHttpServer({
    storagePath: item.storagePath,
    authSecretPath: item.authSecretPath,
    port: 0,
    executor: new StubExecutor({ delayMs: 10_000 }),
  });
  item.servers.push(runtime);
  const base = 'http://127.0.0.1:' + runtime.port;
  const headers = { 'content-type': 'application/json', [X_CODER_AUTH_HEADER]: runtime.authSecret };

  const submitResponse = await fetch(base + '/submit', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      version: 'x-executor-api-v1',
      idempotency_key: 'idem-valid-auth',
      lease_expires_at: Date.now() + 60_000,
      task: makeValidTask(),
    }),
  });
  assert.equal(submitResponse.status, 200);
  const submitted = await submitResponse.json();

  const leaseResponse = await fetch(base + '/lease-valid', {
    method: 'POST',
    headers,
    body: JSON.stringify({ version: 'x-executor-api-v1', run_id: submitted.run_id, lease_expires_at: Date.now() + 90_000 }),
  });
  assert.equal(leaseResponse.status, 200);

  const cancelResponse = await fetch(base + '/cancel', {
    method: 'POST',
    headers,
    body: JSON.stringify({ version: 'x-executor-api-v1', run_id: submitted.run_id }),
  });
  assert.equal(cancelResponse.status, 200);
  assert.equal((await cancelResponse.json()).acknowledged, true);
});


test('S6-1 submit arms the watchdog from the initial lease deadline before any renewal push', async () => {
  const item = fixture();
  const executor = new StubExecutor({ delayMs: 10_000 });
  const service = createXCoderService({ storagePath: item.storagePath, executor });
  item.services.push(service);

  const deadline = Date.now() + 120;
  const submitted = service.submit({
    version: 'x-executor-api-v1',
    idempotency_key: 'lease-initial',
    lease_expires_at: deadline,
    task: makeValidTask(),
  });

  assert.equal(service.registry.getAttachedLeaseDeadline(submitted.run_id), deadline);
  assert.equal(executor.calls, 0, 'executor starts on the next microtask but watchdog is already armed');
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(service.getStatus({ version: 'x-executor-api-v1', run_id: submitted.run_id }).status, 'interrupted');
});

test('S6-2 withholding every renewal past the initial deadline self-aborts the run', async () => {
  const item = fixture();
  const executor = new StubExecutor({ delayMs: 10_000 });
  const service = createXCoderService({ storagePath: item.storagePath, executor });
  item.services.push(service);

  const submitted = service.submit({
    version: 'x-executor-api-v1',
    idempotency_key: 'lease-withheld',
    lease_expires_at: Date.now() + 90,
    task: makeValidTask(),
  });

  await new Promise((resolve) => setTimeout(resolve, 150));
  const status = service.getStatus({ version: 'x-executor-api-v1', run_id: submitted.run_id });
  assert.equal(status.status, 'interrupted');
  assert.equal(service.registry.attachedCount(), 0);
  assert.equal(executor.calls, 1);
});

test('S6-3 leaseValid extends the watchdog and stale pushes never shorten it', async () => {
  const item = fixture();
  const executor = new StubExecutor({ delayMs: 10_000 });
  const service = createXCoderService({ storagePath: item.storagePath, executor });
  item.services.push(service);

  const initial = Date.now() + 120;
  const submitted = service.submit({
    version: 'x-executor-api-v1',
    idempotency_key: 'lease-extend',
    lease_expires_at: initial,
    task: makeValidTask(),
  });

  await new Promise((resolve) => setTimeout(resolve, 40));
  const extended = Date.now() + 260;
  const renewal = service.leaseValid({
    version: 'x-executor-api-v1',
    run_id: submitted.run_id,
    lease_expires_at: extended,
  });
  assert.equal(renewal.accepted, true);
  assert.equal(renewal.lease_expires_at, extended);

  const stale = service.leaseValid({
    version: 'x-executor-api-v1',
    run_id: submitted.run_id,
    lease_expires_at: initial,
  });
  assert.equal(stale.accepted, false);
  assert.equal(stale.lease_expires_at, extended);

  await new Promise((resolve) => setTimeout(resolve, 110));
  assert.equal(service.getStatus({ version: 'x-executor-api-v1', run_id: submitted.run_id }).status, 'running');

  const cancelled = await service.cancel({
    version: 'x-executor-api-v1',
    run_id: submitted.run_id,
  });
  assert.equal(cancelled.status, 'cancelled');
});

test('S6-4 an already-expired initial deadline interrupts without invoking the executor', async () => {
  const item = fixture();
  const executor = new StubExecutor({ delayMs: 10_000 });
  const service = createXCoderService({ storagePath: item.storagePath, executor });
  item.services.push(service);

  const submitted = service.submit({
    version: 'x-executor-api-v1',
    idempotency_key: 'lease-already-expired',
    lease_expires_at: Date.now() - 1,
    task: makeValidTask(),
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(service.getStatus({ version: 'x-executor-api-v1', run_id: submitted.run_id }).status, 'interrupted');
  assert.equal(service.registry.attachedCount(), 0);
  assert.equal(executor.calls, 0);
});
