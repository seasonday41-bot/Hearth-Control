import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { makeValidTask } from '../x/executor-contract/fixtures.mjs';
import { createXCoderService, startXCoderHttpServer } from './server.mjs';
import { StubExecutor } from './stub-executor.mjs';
import { XCoderClient } from '../x/x-coder-client.mjs';

const items = [];
const fixture = ({ delayMs = 10_000 } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-x-coder-lease-'));
  const executor = new StubExecutor({ delayMs });
  const service = createXCoderService({
    storagePath: path.join(dir, 'idempotency.sqlite'),
    executor,
  });
  const item = { dir, executor, service, runtime: null };
  items.push(item);
  return item;
};

afterEach(async () => {
  for (const item of items.splice(0)) {
    if (item.runtime) {
      try { await item.runtime.stop(); } catch {}
    } else {
      try {
        for (const runId of [...item.service.registry.live.keys()]) {
          await item.service.cancel({ version: 'x-executor-api-v1', run_id: runId });
        }
        item.service.close();
      } catch {}
    }
    fs.rmSync(item.dir, { recursive: true, force: true });
  }
});

test('S6-1 submit arms watchdog against the initial lease deadline before any renewal push', async () => {
  const item = fixture();
  const initialDeadline = Date.now() + 140;
  const submitted = item.service.submit({
    version: 'x-executor-api-v1',
    idempotency_key: 'initial-deadline',
    lease_expires_at: initialDeadline,
    task: makeValidTask(),
  });

  assert.equal(item.service.registry.getAttachedLeaseDeadline(submitted.run_id), initialDeadline);
  assert.equal(item.executor.calls, 0, 'executor starts on a microtask after watchdog is already armed');

  await sleep(220);
  assert.equal(item.executor.calls, 1);
  const status = item.service.getStatus({ version: 'x-executor-api-v1', run_id: submitted.run_id });
  assert.equal(status.status, 'interrupted');
  assert.equal(item.service.registry.getAttachedLeaseDeadline(submitted.run_id), null);
});

test('S6-2 leaseValid extends the watchdog beyond the original deadline, then self-aborts at the extended deadline', async () => {
  const item = fixture();
  const initialDeadline = Date.now() + 180;
  const submitted = item.service.submit({
    version: 'x-executor-api-v1',
    idempotency_key: 'extended-deadline',
    lease_expires_at: initialDeadline,
    task: makeValidTask(),
  });

  await sleep(60);
  const extendedDeadline = Date.now() + 320;
  const renewal = item.service.leaseValid({
    version: 'x-executor-api-v1',
    run_id: submitted.run_id,
    lease_expires_at: extendedDeadline,
  });
  assert.equal(renewal.accepted, true);
  assert.equal(renewal.lease_expires_at, extendedDeadline);
  assert.equal(item.service.registry.getAttachedLeaseDeadline(submitted.run_id), extendedDeadline);

  const untilPastOriginal = Math.max(0, initialDeadline - Date.now() + 50);
  await sleep(untilPastOriginal);
  assert.equal(
    item.service.getStatus({ version: 'x-executor-api-v1', run_id: submitted.run_id }).status,
    'running',
    'old deadline must not fire after renewal extended it',
  );

  const untilPastExtended = Math.max(0, extendedDeadline - Date.now() + 60);
  await sleep(untilPastExtended);
  assert.equal(
    item.service.getStatus({ version: 'x-executor-api-v1', run_id: submitted.run_id }).status,
    'interrupted',
  );
});

test('S6-3 stale leaseValid push never shortens an already longer watchdog deadline', async () => {
  const item = fixture();
  const initialDeadline = Date.now() + 500;
  const submitted = item.service.submit({
    version: 'x-executor-api-v1',
    idempotency_key: 'stale-renewal',
    lease_expires_at: initialDeadline,
    task: makeValidTask(),
  });

  const stale = item.service.leaseValid({
    version: 'x-executor-api-v1',
    run_id: submitted.run_id,
    lease_expires_at: initialDeadline - 100,
  });
  assert.equal(stale.accepted, false);
  assert.equal(stale.lease_expires_at, initialDeadline);
  assert.equal(item.service.registry.getAttachedLeaseDeadline(submitted.run_id), initialDeadline);
});

test('S6-4 HTTP client carries initial lease deadline and leaseValid extension end to end', async () => {
  const item = fixture();
  item.service.close();
  const runtime = await startXCoderHttpServer({
    storagePath: path.join(item.dir, 'http-idempotency.sqlite'),
    port: 0,
    executor: new StubExecutor({ delayMs: 10_000 }),
  });
  item.runtime = runtime;
  item.service = runtime.service;

  const client = new XCoderClient({ baseUrl: 'http://127.0.0.1:' + runtime.port });
  const initialDeadline = Date.now() + 300;
  const submitted = await client.submit({
    idempotencyKey: 'http-lease',
    leaseExpiresAt: initialDeadline,
    task: makeValidTask(),
  });
  assert.equal(runtime.service.registry.getAttachedLeaseDeadline(submitted.runId), initialDeadline);

  const extendedDeadline = initialDeadline + 500;
  const renewed = await client.leaseValid(submitted.runId, extendedDeadline);
  assert.equal(renewed.accepted, true);
  assert.equal(renewed.leaseExpiresAt, extendedDeadline);

  const cancelled = await client.cancel(submitted.runId);
  assert.equal(cancelled.status, 'cancelled');
});

test('S6-5 submit without an initial lease deadline is rejected at the wire boundary', () => {
  const item = fixture({ delayMs: 5 });
  assert.throws(
    () => item.service.submit({
      version: 'x-executor-api-v1',
      idempotency_key: 'missing-lease',
      task: makeValidTask(),
    }),
    /lease_expires_at/,
  );
  assert.equal(item.executor.calls, 0);
});
