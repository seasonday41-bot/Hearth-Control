import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { makeValidTask } from '../mcp/x/executor-contract/fixtures.mjs';
import { XCoderClient } from '../mcp/x/x-coder-client.mjs';
import { startXCoderHttpServer } from '../mcp/x-coder-service/server.mjs';
import { StubExecutor } from '../mcp/x-coder-service/stub-executor.mjs';

const runtimes = [];
const dirs = [];

const startStub = async ({ delayMs = 10 } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-x-coder-client-'));
  dirs.push(dir);
  const runtime = await startXCoderHttpServer({
    storagePath: path.join(dir, 'idempotency.sqlite'),
    port: 0,
    executor: new StubExecutor({ delayMs }),
  });
  runtimes.push(runtime);
  return {
    runtime,
    client: new XCoderClient({ baseUrl: 'http://127.0.0.1:' + runtime.port }),
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

  const submitted = await client.submit({ idempotencyKey: 'client-1', task });
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

  const first = await client.submit({ idempotencyKey: 'client-idem', task });
  const duplicate = await client.submit({ idempotencyKey: 'client-idem', task });

  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.runId, first.runId);
  await runtime.service.registry.waitForAttachedRun(first.runId);
  assert.equal(runtime.service.registry.executor.calls, 1);
});

test('C5-3 cancel returns the service terminal acknowledgement', async () => {
  const { client } = await startStub({ delayMs: 10_000 });
  const submitted = await client.submit({ idempotencyKey: 'client-cancel', task: makeValidTask() });
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
  await assert.rejects(() => client.submit({ idempotencyKey: '', task: makeValidTask() }), TypeError);
  await assert.rejects(() => client.getStatus(''), TypeError);
  await assert.rejects(() => client.cancel(''), TypeError);
});
