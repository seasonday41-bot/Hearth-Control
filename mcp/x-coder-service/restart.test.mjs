import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

import { makeValidTask } from '../x/executor-contract/fixtures.mjs';
import { X_CODER_AUTH_HEADER, ensureXCoderAuthSecret } from '../x/x-coder-auth.mjs';

const SERVER_PATH = path.resolve('mcp/x-coder-service/server.mjs');
const NODE = process.execPath;

const startChild = ({ storagePath, authSecretPath, counterPath, delayMs }) => {
  const child = spawn(NODE, [SERVER_PATH], {
    env: {
      ...process.env,
      X_CODER_STORAGE_PATH: storagePath,
      X_CODER_AUTH_SECRET_PATH: authSecretPath,
      X_CODER_EXECUTOR: 'stub',
      X_CODER_PORT: '0',
      X_CODER_STUB_DELAY_MS: String(delayMs),
      X_CODER_STUB_COUNTER_PATH: counterPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  const closed = new Promise((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal, stderr }));
  });

  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('X Coder child did not become ready: ' + stderr)), 5000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const lines = stdout.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (message.event === 'ready') {
            clearTimeout(timeout);
            resolve(message);
            return;
          }
        } catch {}
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`X Coder child closed before ready code=${code} signal=${signal}: ${stderr}`));
    });
  });

  return { child, ready, closed };
};

const post = async (port, pathname, body, authSecret) => {
  const response = await fetch('http://127.0.0.1:' + port + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [X_CODER_AUTH_HEADER]: authSecret },
    body: JSON.stringify(body),
  });
  return { statusCode: response.status, body: await response.json() };
};

const readCounter = (counterPath) => {
  try {
    return Number.parseInt(fs.readFileSync(counterPath, 'utf8').trim(), 10) || 0;
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
};

const waitFor = async (predicate, { timeoutMs = 3000, intervalMs = 20 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(intervalMs);
  }
  throw new Error('condition not met before timeout');
};

test('S4-restart kill mid-execution never silently executes the same idempotency key twice', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-x-coder-restart-'));
  const storagePath = path.join(dir, 'x-coder-idempotency.sqlite');
  const authSecretPath = path.join(dir, 'auth.secret');
  const authSecret = ensureXCoderAuthSecret({ secretPath: authSecretPath });
  const counterPath = path.join(dir, 'side-effect-count.txt');
  let firstChild = null;
  let secondChild = null;

  try {
    const task = makeValidTask();

    firstChild = startChild({ storagePath, authSecretPath, counterPath, delayMs: 10_000 });
    const firstReady = await firstChild.ready;
    const firstSubmit = await post(firstReady.port, '/submit', {
      version: 'x-executor-api-v1',
      idempotency_key: 'restart-key',
      lease_expires_at: Date.now() + 60_000,
      task,
    }, authSecret);
    assert.equal(firstSubmit.statusCode, 200);
    assert.equal(firstSubmit.body.duplicate, false);
    const oldRunId = firstSubmit.body.run_id;

    await waitFor(() => readCounter(counterPath) === 1);
    firstChild.child.kill('SIGKILL');
    const firstClosed = await firstChild.closed;
    assert.equal(firstClosed.signal, 'SIGKILL');

    secondChild = startChild({ storagePath, authSecretPath, counterPath, delayMs: 25 });
    const secondReady = await secondChild.ready;
    assert.ok(secondReady.interrupted_on_startup.includes(oldRunId));

    const oldStatus = await post(secondReady.port, '/status', {
      version: 'x-executor-api-v1',
      run_id: oldRunId,
    }, authSecret);
    assert.equal(oldStatus.statusCode, 200);
    assert.equal(oldStatus.body.status, 'interrupted');

    const duplicate = await post(secondReady.port, '/submit', {
      version: 'x-executor-api-v1',
      idempotency_key: 'restart-key',
      lease_expires_at: Date.now() + 60_000,
      task,
    }, authSecret);
    assert.equal(duplicate.statusCode, 200);
    assert.equal(duplicate.body.run_id, oldRunId);
    assert.equal(duplicate.body.duplicate, true);
    assert.equal(duplicate.body.status, 'interrupted');

    await sleep(100);
    assert.equal(readCounter(counterPath), 1, 'same idempotency key must not re-execute after restart');

    const freshTask = makeValidTask();
    freshTask.task_id = 'task-fresh';
    const fresh = await post(secondReady.port, '/submit', {
      version: 'x-executor-api-v1',
      idempotency_key: 'fresh-key',
      lease_expires_at: Date.now() + 60_000,
      task: freshTask,
    }, authSecret);
    assert.equal(fresh.statusCode, 200);
    assert.notEqual(fresh.body.run_id, oldRunId);
    assert.equal(fresh.body.duplicate, false);

    await waitFor(async () => {
      const status = await post(secondReady.port, '/status', {
        version: 'x-executor-api-v1',
        run_id: fresh.body.run_id,
      }, authSecret);
      return status.body.status === 'completed';
    });
    assert.equal(readCounter(counterPath), 2, 'fresh key should execute exactly once');

    secondChild.child.kill('SIGTERM');
    const secondClosed = await secondChild.closed;
    assert.equal(secondClosed.code, 0);
    secondChild = null;
  } finally {
    if (firstChild?.child.exitCode === null && firstChild?.child.signalCode === null) firstChild.child.kill('SIGKILL');
    if (secondChild?.child.exitCode === null && secondChild?.child.signalCode === null) secondChild.child.kill('SIGKILL');
    await Promise.allSettled([firstChild?.closed, secondChild?.closed].filter(Boolean));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
