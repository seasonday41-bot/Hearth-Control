import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { makeValidTask } from '../mcp/x/executor-contract/fixtures.mjs';
import { XCoderClient } from '../mcp/x/x-coder-client.mjs';
import { startXCoderHttpServer } from '../mcp/x-coder-service/server.mjs';
import { StubExecutor } from '../mcp/x-coder-service/stub-executor.mjs';
import { X_CODER_AUTH_HEADER } from '../mcp/x/x-coder-auth.mjs';

const runtimes = [];
const dirs = [];

const startStub = async ({ delayMs = 10, executor } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-x-coder-client-'));
  dirs.push(dir);
  const authSecretPath = path.join(dir, 'auth.secret');
  const stubExecutor = executor ?? new StubExecutor({ delayMs });
  const runtime = await startXCoderHttpServer({
    storagePath: path.join(dir, 'idempotency.sqlite'),
    authSecretPath,
    port: 0,
    executor: stubExecutor,
  });
  runtimes.push(runtime);
  return {
    runtime,
    executor: stubExecutor,
    authSecretPath,
    client: new XCoderClient({ baseUrl: 'http://127.0.0.1:' + runtime.port, authSecretPath }),
  };
};

afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) {
    try { await runtime.stop(); } catch {}
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test('C5-1 submit and getStatus round-trip against Slice 4 stub service', async () => {
  const { runtime, client } = await startStub();
  const task = makeValidTask();

  const submitted = await client.submit({ idempotencyKey: 'client-1', task, leaseExpiresAt: Date.now() + 60_000 });
  assert.equal(submitted.duplicate, false);
  assert.equal(submitted.status, 'running');

  await runtime.service.registry.waitForAttachedRun(submitted.runId);
  const status = await client.getStatus(submitted.runId);
  assert.equal(status.status, 'completed');
  assert.equal(status.result.task_id, task.task_id);
  assert.equal(status.error, null);
});

test('C5-2 duplicate submit returns the same durable run id without a second stub execution', async () => {
  const { runtime, client } = await startStub({ delayMs: 25 });
  const task = makeValidTask();

  const first = await client.submit({ idempotencyKey: 'client-idem', task, leaseExpiresAt: Date.now() + 60_000 });
  const duplicate = await client.submit({ idempotencyKey: 'client-idem', task, leaseExpiresAt: Date.now() + 60_000 });

  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.runId, first.runId);
  await runtime.service.registry.waitForAttachedRun(first.runId);
  assert.equal(runtime.service.registry.executor.calls, 1);
});

test('C5-3 cancel returns the service terminal acknowledgement', async () => {
  const { client } = await startStub({ delayMs: 10_000 });
  const submitted = await client.submit({ idempotencyKey: 'client-cancel', task: makeValidTask(), leaseExpiresAt: Date.now() + 60_000 });
  const cancelled = await client.cancel(submitted.runId);

  assert.equal(cancelled.acknowledged, true);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal((await client.getStatus(submitted.runId)).status, 'cancelled');
});

test('C5-4 client refuses non-loopback service origins', () => {
  assert.throws(
    () => new XCoderClient({ baseUrl: 'https://example.com' }),
    /x_coder_loopback_required/,
  );
});

test('C5-5 invalid arguments fail before any service request', async () => {
  const { client } = await startStub();
  await assert.rejects(() => client.submit({ idempotencyKey: '', task: makeValidTask(), leaseExpiresAt: Date.now() + 60_000 }), TypeError);
  await assert.rejects(() => client.getStatus(''), TypeError);
  await assert.rejects(() => client.cancel(''), TypeError);
});


test('C6-1 leaseValid extends the service watchdog through the client boundary', async () => {
  const { runtime, client } = await startStub({ delayMs: 10_000 });
  const initial = Date.now() + 120;
  const submitted = await client.submit({
    idempotencyKey: 'client-lease',
    task: makeValidTask(),
    leaseExpiresAt: initial,
  });

  const extended = Date.now() + 500;
  const renewal = await client.leaseValid(submitted.runId, extended);
  assert.equal(renewal.runId, submitted.runId);
  assert.equal(renewal.status, 'running');
  assert.equal(renewal.leaseExpiresAt, extended);
  assert.equal(renewal.accepted, true);
  assert.equal(runtime.service.registry.getAttachedLeaseDeadline(submitted.runId), extended);

  await client.cancel(submitted.runId);
});

test('C6-2 submit requires the initial lease deadline and leaseValid validates arguments locally', async () => {
  const { client } = await startStub();
  await assert.rejects(
    () => client.submit({ idempotencyKey: 'missing-deadline', task: makeValidTask() }),
    TypeError,
  );
  await assert.rejects(() => client.leaseValid('', Date.now() + 1000), TypeError);
  await assert.rejects(() => client.leaseValid('run-1', 0), TypeError);
});

test('R1-C1 a client constructed with the matching secret authenticates successfully', async () => {
  const { runtime, client } = await startStub();
  const submitted = await client.submit({ idempotencyKey: 'auth-ok', task: makeValidTask(), leaseExpiresAt: Date.now() + 60_000 });
  assert.equal(submitted.duplicate, false);
  await runtime.service.registry.waitForAttachedRun(submitted.runId);
});

test('R1-C2 a request with no auth header is rejected and never reaches the executor', async () => {
  const { runtime, executor } = await startStub({ delayMs: 5 });
  const response = await fetch('http://127.0.0.1:' + runtime.port + '/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      version: 'x-executor-api-v1',
      idempotency_key: 'no-header',
      lease_expires_at: Date.now() + 60_000,
      task: makeValidTask(),
    }),
  });
  assert.equal(response.status, 401);
  assert.equal(executor.calls, 0);
});

test('R1-C3 a client constructed with the wrong secret is rejected and never reaches the executor', async () => {
  const { runtime, executor, authSecretPath } = await startStub({ delayMs: 5 });
  const badClient = new XCoderClient({
    baseUrl: 'http://127.0.0.1:' + runtime.port,
    authSecretPath,
    authSecret: 'not-the-real-secret',
  });
  await assert.rejects(
    () => badClient.submit({ idempotencyKey: 'wrong-secret', task: makeValidTask(), leaseExpiresAt: Date.now() + 60_000 }),
    /x_coder_unauthorized/,
  );
  assert.equal(executor.calls, 0);
});
