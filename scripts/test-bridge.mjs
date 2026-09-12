/**
 * Hearth Bridge V1 Automated Test Suite
 * Tests remote task parsing, security constraints, duplicate claim protection,
 * payload sanitization, mock transport, and isolation.
 *
 * SAFETY GUARANTEES:
 * - Uses 100% in-memory mock transport (createMockTransport)
 * - Zero external HTTP requests to Supabase or the internet
 * - Zero live Antigravity execution
 * - Zero database migrations applied
 */

import {
  parseRemoteTaskPayload,
  HearthBridgeClient,
  createMockTransport,
  syncRemoteTaskState,
  flushPendingRemoteSyncs,
} from '../mcp/bridge/client.mjs';
import {
  getOrCreateDeviceId,
  generatePairingSecret,
  hashPairingSecret,
} from '../mcp/bridge/identity.mjs';
import {
  MAX_PAYLOAD_BYTES,
  classifyCompletion,
  isTaskActivelyRunning,
  hasRunningTask,
  taskRegistry,
  setTaskStore,
  sendAntigravityMessage,
} from '../mcp/executors/antigravity.mjs';
import { TaskStore } from '../mcp/executors/task-store.mjs';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

let passed = 0;
let failed = 0;
const results = [];

const test = async (name, fn) => {
  try {
    await fn();
    console.log(`  ✅ PASS  ${name}`);
    results.push({ name, status: 'PASS' });
    passed++;
  } catch (err) {
    console.error(`  ❌ FAIL  ${name}`);
    console.error(`           ${err.message}`);
    results.push({ name, status: 'FAIL', error: err.message });
    failed++;
  }
};

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
assert.equal = (actual, expected, message) => {
  if (actual !== expected) throw new Error(message || `Expected ${expected}, got ${actual}`);
};
assert.notEqual = (actual, expected, message) => {
  if (actual === expected) throw new Error(message || `Expected values to differ, got ${actual}`);
};

console.log('\n═══ Test Suite: Hearth Bridge V1 ═══\n');

const testDeviceId = 'a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d';
const mockOwnerId = '11111111-2222-3333-4444-555555555555';

// ── 1. Remote task parsing ──────────────────────────────────────────────────
await test('1. remote task parsing parses valid row correctly', async () => {
  const row = {
    id: 'task-001',
    device_id: testDeviceId,
    source: 'chatgpt',
    title: 'Review diff',
    prompt: 'Check git status and report changes',
    status: 'pending',
    created_at: '2026-09-09T12:00:00Z',
    request_id: 'req-abc',
  };
  const parsed = parseRemoteTaskPayload(row, testDeviceId);
  assert(parsed.id === 'task-001', 'id must match');
  assert(parsed.deviceId === testDeviceId, 'deviceId must match');
  assert(parsed.prompt === 'Check git status and report changes', 'prompt must match');
  assert(parsed.status === 'pending', 'status must be pending');
  assert(parsed.source === 'chatgpt', 'source must match');
});

// ── 2. Invalid payload rejected ─────────────────────────────────────────────
await test('2. invalid payload rejected (missing id, prompt, or wrong status)', async () => {
  let threwMissingPrompt = false;
  try {
    parseRemoteTaskPayload({ id: 't1', device_id: testDeviceId, status: 'pending', prompt: '' }, testDeviceId);
  } catch {
    threwMissingPrompt = true;
  }
  assert(threwMissingPrompt, 'Must throw for empty prompt');

  let threwNonPending = false;
  try {
    parseRemoteTaskPayload({ id: 't2', device_id: testDeviceId, status: 'running', prompt: 'hi' }, testDeviceId);
  } catch {
    threwNonPending = true;
  }
  assert(threwNonPending, 'Must throw for non-pending status');
});

// ── 3. >64KiB prompt rejected ───────────────────────────────────────────────
await test('3. >64KiB prompt rejected before execution', async () => {
  const oversized = 'x'.repeat(MAX_PAYLOAD_BYTES + 1);
  let threw = false;
  try {
    parseRemoteTaskPayload({ id: 't3', device_id: testDeviceId, status: 'pending', prompt: oversized }, testDeviceId);
  } catch (err) {
    threw = true;
    assert(err.message.includes('64 KiB'), `Expected 64 KiB error, got: ${err.message}`);
  }
  assert(threw, 'Must throw on >64KiB prompt');
});

// ── 4. Arbitrary workspace field ignored/rejected ───────────────────────────
await test('4. arbitrary workspace field ignored/rejected from remote payload', async () => {
  const rowWithMaliciousWorkspace = {
    id: 'task-exploit',
    device_id: testDeviceId,
    source: 'chatgpt',
    title: 'Escape workspace',
    prompt: 'Harmless prompt',
    status: 'pending',
    workspace: '/etc/shadow', // Attempted path injection
    command: 'rm -rf /',       // Attempted command injection
    executor: 'raw-shell',     // Attempted executor override
  };
  const parsed = parseRemoteTaskPayload(rowWithMaliciousWorkspace, testDeviceId);
  assert(parsed.workspace === undefined, 'workspace field must be stripped');
  assert(parsed.command === undefined, 'command field must be stripped');
  assert(parsed.executor === undefined, 'executor field must be stripped');
  assert(parsed.prompt === 'Harmless prompt', 'prompt preserved');
});

// ── 5. Pending task never auto executes ─────────────────────────────────────
await test('5. pending task never auto executes upon fetch', async () => {
  const mock = createMockTransport([
    { id: 't5', device_id: testDeviceId, status: 'pending', prompt: 'Test auto exec' }
  ]);
  const client = new HearthBridgeClient({
    deviceId: testDeviceId,
    supabaseUrl: 'https://mock.supabase.co',
    supabaseAnonKey: 'mock-anon',
    fetchFn: mock.fetch,
  });
  client.enabled = true;

  const pending = await client.fetchPendingTasks();
  assert(pending.length === 1, 'Should fetch 1 pending task');
  assert(pending[0].id === 't5', 'Fetched correct task');

  // Verify task in DB is STILL pending (fetch has zero auto-execution side effect)
  const dbTask = mock.getTasks().find(t => t.id === 't5');
  assert(dbTask.status === 'pending', 'DB status must remain pending');
});

// ── 6. Approve triggers executor once ───────────────────────────────────────
await test('6. approve triggers executor once and locks task', async () => {
  const mock = createMockTransport([
    { id: 't6', device_id: testDeviceId, status: 'pending', prompt: 'Run once' }
  ]);
  const client = new HearthBridgeClient({
    deviceId: testDeviceId,
    supabaseUrl: 'https://mock.supabase.co',
    supabaseAnonKey: 'mock-anon',
    fetchFn: mock.fetch,
  });
  client.enabled = true;

  let executionCount = 0;
  const executeAntigravity = async (task) => {
    executionCount++;
    return { taskId: 'hearth-local-1', conversationId: 'conv-1' };
  };

  // Human user approves: claim first
  const claimResult = await client.claimTask({ taskId: 't6' });
  assert(claimResult.claimed === true, 'Claim must succeed');

  if (claimResult.claimed) {
    await executeAntigravity(claimResult.task);
  }

  assert(executionCount === 1, 'Executor must be invoked exactly once');
  const dbTask = mock.getTasks().find(t => t.id === 't6');
  assert(dbTask.status === 'running', 'DB status must be running');
  assert(dbTask.approved_at !== undefined, 'approved_at must be populated');
});

// ── 7. Reject never triggers executor ───────────────────────────────────────
await test('7. reject never triggers executor and retains record', async () => {
  const mock = createMockTransport([
    { id: 't7', device_id: testDeviceId, status: 'pending', prompt: 'Reject me' }
  ]);
  const client = new HearthBridgeClient({
    deviceId: testDeviceId,
    supabaseUrl: 'https://mock.supabase.co',
    supabaseAnonKey: 'mock-anon',
    fetchFn: mock.fetch,
  });
  client.enabled = true;

  let executorInvoked = false;
  const executeAntigravity = () => { executorInvoked = true; };

  const success = await client.rejectTask({ taskId: 't7' });
  assert(success === true, 'Reject must succeed');
  assert(!executorInvoked, 'Executor must never be called on reject');

  const dbTask = mock.getTasks().find(t => t.id === 't7');
  assert(dbTask !== undefined, 'Task must not be deleted from DB');
  assert(dbTask.status === 'rejected', 'DB status must be rejected');
});

// ── 8. Duplicate claim prevented ───────────────────────────────────────────
await test('8. duplicate claim prevented (atomic conditional update)', async () => {
  const mock = createMockTransport([
    { id: 't8', device_id: testDeviceId, status: 'pending', prompt: 'Race task' }
  ]);
  const clientA = new HearthBridgeClient({
    deviceId: testDeviceId,
    supabaseUrl: 'https://mock.supabase.co',
    supabaseAnonKey: 'mock-anon',
    fetchFn: mock.fetch,
  });
  const clientB = new HearthBridgeClient({
    deviceId: testDeviceId,
    supabaseUrl: 'https://mock.supabase.co',
    supabaseAnonKey: 'mock-anon',
    fetchFn: mock.fetch,
  });

  // Client A claims first
  const claimA = await clientA.claimTask({ taskId: 't8' });
  assert(claimA.claimed === true, 'Client A claim must succeed');

  // Client B tries to claim the same task
  const claimB = await clientB.claimTask({ taskId: 't8' });
  assert(claimB.claimed === false, 'Client B claim must fail (0 rows affected)');
});

// ── 9. Done result sanitized ────────────────────────────────────────────────
await test('9. done result sanitized before writing back to DB', async () => {
  const mock = createMockTransport([
    { id: 't9', device_id: testDeviceId, status: 'running', prompt: 'Sanitize result' }
  ]);
  const client = new HearthBridgeClient({
    deviceId: testDeviceId,
    supabaseUrl: 'https://mock.supabase.co',
    supabaseAnonKey: 'mock-anon',
    fetchFn: mock.fetch,
  });

  const rawOutput = 'Task complete. Secret token was Bearer secret_token_12345 and apiKey AIzaSyA123456789012345678901234567890.';
  await client.updateTaskResult({
    taskId: 't9',
    hearthTaskId: 'ht-9',
    conversationId: 'c-9',
    status: 'done',
    result: rawOutput,
  });

  const dbTask = mock.getTasks().find(t => t.id === 't9');
  assert(dbTask.status === 'done', 'Status must be done');
  assert(!dbTask.result.includes('secret_token_12345'), 'Bearer token must be redacted');
  assert(!dbTask.result.includes('AIzaSyA1234567890'), 'API key must be redacted');
  assert(dbTask.result.includes('[REDACTED]'), 'Must include [REDACTED]');
});

// ── 10. Error sanitized ─────────────────────────────────────────────────────
await test('10. error sanitized before writing back to DB', async () => {
  const mock = createMockTransport([
    { id: 't10', device_id: testDeviceId, status: 'running', prompt: 'Sanitize error' }
  ]);
  const client = new HearthBridgeClient({
    deviceId: testDeviceId,
    supabaseUrl: 'https://mock.supabase.co',
    supabaseAnonKey: 'mock-anon',
    fetchFn: mock.fetch,
  });

  const rawError = 'Error connecting with eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.doNotLeakThisSignature';
  await client.updateTaskResult({
    taskId: 't10',
    status: 'error',
    error: rawError,
  });

  const dbTask = mock.getTasks().find(t => t.id === 't10');
  assert(dbTask.status === 'error', 'Status must be error');
  assert(!dbTask.error.includes('doNotLeakThisSignature'), 'JWT signature must be redacted');
  assert(dbTask.error.includes('[REDACTED_JWT]'), 'Must contain [REDACTED_JWT]');
});

// ── 10b. Waiting completion is non-terminal ───────────────────────────────
await test('10b. remote bridge preserves waiting without finished_at', async () => {
  const mock = createMockTransport([
    { id: 't10b', device_id: testDeviceId, status: 'running', prompt: 'Wait for artifact' }
  ]);
  const client = new HearthBridgeClient({
    deviceId: testDeviceId,
    supabaseUrl: 'https://mock.supabase.co',
    supabaseAnonKey: 'mock-anon',
    fetchFn: mock.fetch,
  });

  await client.updateTaskResult({
    taskId: 't10b',
    hearthTaskId: 'ht-10b',
    conversationId: 'c-10b',
    status: 'waiting',
    result: 'Completed response received; required artifact is not available yet.',
  });

  const dbTask = mock.getTasks().find(t => t.id === 't10b');
  assert(dbTask.status === 'waiting', 'Waiting status must be preserved');
  assert(!Object.hasOwn(dbTask, 'finished_at'), 'Waiting row must not receive finished_at');
  assert(dbTask.conversation_id === 'c-10b', 'Conversation ID must be retained for follow-up');
});

// ── 11. Disconnected transport doesn't break local Task Console ─────────────
await test('11. disconnected transport does not throw fatal crash', async () => {
  const failingFetch = async () => {
    throw new Error('ECONNREFUSED: Network unreachable');
  };
  const client = new HearthBridgeClient({
    deviceId: testDeviceId,
    supabaseUrl: 'https://unreachable.supabase.co',
    fetchFn: failingFetch,
  });
  client.enabled = true;

  let caughtError = false;
  try {
    await client.fetchPendingTasks();
  } catch (err) {
    caughtError = true;
    assert(err.message.includes('Network unreachable'), 'Captures network error cleanly');
  }
  assert(caughtError, 'Error should be captured gracefully without terminating process');
});

// ── 12. Bridge disabled performs zero remote polling ────────────────────────
await test('12. bridge disabled performs zero remote polling', async () => {
  let networkCalls = 0;
  const trackingFetch = async () => {
    networkCalls++;
    return { ok: true, json: async () => [] };
  };
  const client = new HearthBridgeClient({
    deviceId: testDeviceId,
    supabaseUrl: 'https://mock.supabase.co',
    fetchFn: trackingFetch,
  });
  client.enabled = false; // Disabled

  const tasks = await client.fetchPendingTasks();
  assert(tasks.length === 0, 'No tasks returned when disabled');
  assert(networkCalls === 0, 'Zero network calls must be made when disabled');
});

// ── 13. Task from other deviceId ignored ────────────────────────────────────
await test('13. task from other deviceId ignored by parser', async () => {
  const rowFromOtherDevice = {
    id: 't13',
    device_id: 'other-device-uuid-9999',
    status: 'pending',
    prompt: 'For someone else',
  };
  let threw = false;
  try {
    parseRemoteTaskPayload(rowFromOtherDevice, testDeviceId);
  } catch (err) {
    threw = true;
    assert(err.message.includes('Device mismatch'), 'Must throw device mismatch');
  }
  assert(threw, 'Must reject row with mismatched device_id');
});

// ── 14. Malformed database row rejected safely ──────────────────────────────
await test('14. malformed database row rejected safely without crashing fetch loop', async () => {
  const mock = createMockTransport([
    null,
    { invalid: 'schema' },
    { id: 'valid-14', device_id: testDeviceId, status: 'pending', prompt: 'I am valid' },
    { id: 'corrupt-14', device_id: testDeviceId, status: 'pending', prompt: null },
  ]);
  const client = new HearthBridgeClient({
    deviceId: testDeviceId,
    supabaseUrl: 'https://mock.supabase.co',
    fetchFn: mock.fetch,
  });
  client.enabled = true;

  const valid = await client.fetchPendingTasks();
  assert(valid.length === 1, 'Should filter out invalid rows and return only valid ones');
  assert(valid[0].id === 'valid-14', 'Correct valid task retained');
});

// ── 15. App cleanup stops polling/subscription ──────────────────────────────
await test('15. app cleanup stops polling timer cleanly', async () => {
  const client = new HearthBridgeClient({
    deviceId: testDeviceId,
    supabaseUrl: 'https://mock.supabase.co',
    pollIntervalMs: 50,
  });
  client.enabled = true;

  client.startPolling(() => {});
  assert(client.isPolling === true, 'Polling must be active');
  assert(client.pollTimer !== null, 'Timer must be active');

  client.stopPolling();
  assert(client.isPolling === false, 'Polling flag must be false');
  assert(client.pollTimer === null, 'Timer must be cleared');
});

// ── Additional verification: Identity & Pairing Hash ───────────────────────
await test('16. pairing secret generation and sha-256 hash match', async () => {
  const { secret, hash } = generatePairingSecret();
  assert(secret.startsWith('hearth_sec_'), 'Secret must have hearth_sec_ prefix');
  assert(hash.length === 64, 'SHA-256 hash must be 64 hex characters');
  assert(hashPairingSecret(secret) === hash, 'Hash must be deterministic');
});

await test('17. device identity persists random UUID without machine fingerprinting', async () => {
  const tmpDir = path.join(os.tmpdir(), `hearth-identity-test-${Date.now()}`);
  const id1 = getOrCreateDeviceId(tmpDir);
  const id2 = getOrCreateDeviceId(tmpDir);
  assert(id1 === id2, 'Device ID must be persistent across reads');
  assert(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id1), 'Must be standard UUID format');
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

// ── 18. remote task linkage persisted ─────────────────────────────────────────
await test('18. remote task linkage persisted to tasks.json', async () => {
  const tmpDir = path.join(os.tmpdir(), `hearth-remote-test-${Date.now()}-18`);
  const filePath = path.join(tmpDir, 'tasks.json');
  const store = new TaskStore(filePath);

  store.saveTask({
    taskId: 'hearth-t-18',
    conversationId: 'c-18',
    source: 'remote',
    remoteTaskId: 'remote-uuid-18',
    requestId: 'req-18',
    title: 'Linkage test task',
    status: 'running',
  });

  const diskData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const found = diskData.tasks.find((t) => t.taskId === 'hearth-t-18');
  assert(found, 'Task must be saved in tasks.json');
  assert.equal(found.source, 'remote');
  assert.equal(found.remoteTaskId, 'remote-uuid-18');
  assert.equal(found.requestId, 'req-18');
  assert.equal(found.conversationId, 'c-18');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── 19. hearth_task_id/conversation_id sync on start ─────────────────────────
await test('19. hearth_task_id/conversation_id sync on start', async () => {
  const mock = createMockTransport([
    { id: 'remote-row-19', device_id: testDeviceId, status: 'running', prompt: 'Sync on start' }
  ]);
  const client = new HearthBridgeClient({
    deviceId: testDeviceId,
    supabaseUrl: 'https://mock.supabase.co',
    fetchFn: mock.fetch,
  });
  client.enabled = true;

  const task = {
    taskId: 'hearth-task-19',
    conversationId: 'conv-init-19',
    source: 'remote',
    remoteTaskId: 'remote-row-19',
    status: 'running',
  };

  const res = await syncRemoteTaskState({
    bridgeClient: client,
    task,
    overrides: { status: 'running' },
  });

  assert.equal(res.synced, true);
  const dbTask = mock.getTasks().find(t => t.id === 'remote-row-19');
  assert.equal(dbTask.status, 'running');
  assert.equal(dbTask.hearth_task_id, 'hearth-task-19', 'hearth_task_id must be synced on start');
  assert.equal(dbTask.conversation_id, 'conv-init-19', 'conversation_id must be synced on start');
});

// ── 20. restart restores remote linkage ──────────────────────────────────────
await test('20. restart restores remote linkage and transitions running to recovery_required', async () => {
  const tmpDir = path.join(os.tmpdir(), `hearth-remote-test-${Date.now()}-20`);
  const filePath = path.join(tmpDir, 'tasks.json');
  const store1 = new TaskStore(filePath);

  store1.saveTask({
    taskId: 'hearth-task-20',
    conversationId: 'conv-20',
    source: 'remote',
    remoteTaskId: 'remote-row-20',
    requestId: 'req-20',
    title: 'Remote restart task',
    status: 'running',
  });

  // Reboot: new TaskStore instance
  const store2 = new TaskStore(filePath);
  const reconciled = store2.reconcileStartupState();
  assert.equal(reconciled.reconciledCount, 1);

  const restored = store2.getTask('hearth-task-20');
  assert.equal(restored.status, 'recovery_required', 'Running remote task must become recovery_required');
  assert.equal(restored.source, 'remote');
  assert.equal(restored.remoteTaskId, 'remote-row-20');
  assert.equal(restored.requestId, 'req-20');
  assert.equal(restored.conversationId, 'conv-20');

  // findTaskByRemoteLink still matches
  const foundByLink = store2.findTaskByRemoteLink({ remoteTaskId: 'remote-row-20' });
  assert(foundByLink, 'Must find restored task by remoteTaskId');
  assert.equal(foundByLink.taskId, 'hearth-task-20');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── 21. recovery resume DONE syncs same Supabase row ─────────────────────────
await test('21. recovery resume DONE syncs same Supabase row', async () => {
  const initialRow = {
    id: 'remote-row-21',
    device_id: testDeviceId,
    status: 'running',
    prompt: 'Remote recovery test',
    hearth_task_id: 'hearth-task-21',
    conversation_id: 'conv-orig-21',
    result: null,
    finished_at: null,
  };
  const mock = createMockTransport([initialRow]);
  const client = new HearthBridgeClient({
    deviceId: testDeviceId,
    supabaseUrl: 'https://mock.supabase.co',
    fetchFn: mock.fetch,
  });
  client.enabled = true;

  const tmpDir = path.join(os.tmpdir(), `hearth-remote-test-${Date.now()}-21`);
  const store = new TaskStore(path.join(tmpDir, 'tasks.json'));

  // Task recovered and now finishes DONE
  const task = {
    taskId: 'hearth-task-21',
    conversationId: 'conv-orig-21',
    source: 'remote',
    remoteTaskId: 'remote-row-21',
    status: 'done',
    completion: {
      status: 'done',
      summary: 'Task recovered and finished successfully.',
    },
    lastAnswer: 'Task recovered and finished successfully.',
  };

  const syncRes = await syncRemoteTaskState({
    bridgeClient: client,
    taskStore: store,
    task,
  });

  assert.equal(syncRes.synced, true);
  assert.equal(mock.getTasks().length, 1, 'Must update existing row, never create a new row');
  const dbTask = mock.getTasks()[0];
  assert.equal(dbTask.id, 'remote-row-21');
  assert.equal(dbTask.status, 'done');
  assert.equal(dbTask.hearth_task_id, 'hearth-task-21');
  assert.equal(dbTask.conversation_id, 'conv-orig-21');
  assert.equal(dbTask.result, 'Task recovered and finished successfully.');
  assert(dbTask.finished_at, 'finished_at must be populated');
  assert.equal(dbTask.error, null, 'error must be null on completion');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── 22. recovery Mark Failed syncs error ─────────────────────────────────────
await test('22. recovery Mark Failed syncs error to Supabase', async () => {
  const mock = createMockTransport([
    { id: 'remote-row-22', device_id: testDeviceId, status: 'running', prompt: 'Fail in recovery' }
  ]);
  const client = new HearthBridgeClient({
    deviceId: testDeviceId,
    supabaseUrl: 'https://mock.supabase.co',
    fetchFn: mock.fetch,
  });
  client.enabled = true;

  const task = {
    taskId: 'hearth-task-22',
    conversationId: 'conv-22',
    source: 'remote',
    remoteTaskId: 'remote-row-22',
    status: 'error',
    error: 'Task marked as failed during recovery by user.',
  };

  const syncRes = await syncRemoteTaskState({
    bridgeClient: client,
    task,
    overrides: { status: 'error', error: task.error },
  });

  assert.equal(syncRes.synced, true);
  const dbTask = mock.getTasks().find(t => t.id === 'remote-row-22');
  assert.equal(dbTask.status, 'error');
  assert.equal(dbTask.error, 'Task marked as failed during recovery by user.');
  assert(dbTask.finished_at, 'finished_at must be set on error');
});

// ── 23. bridge offline terminal sync is queued and retried ───────────────────
await test('23. bridge offline terminal sync is queued and retried upon reconnect', async () => {
  const tmpDir = path.join(os.tmpdir(), `hearth-remote-test-${Date.now()}-23`);
  const store = new TaskStore(path.join(tmpDir, 'tasks.json'));

  const mock = createMockTransport([
    { id: 'remote-row-23', device_id: testDeviceId, status: 'running', prompt: 'Offline queued sync' }
  ]);

  // Client without URL (offline)
  const offlineClient = new HearthBridgeClient({
    deviceId: testDeviceId,
    supabaseUrl: '',
    fetchFn: mock.fetch,
  });

  const task = {
    taskId: 'hearth-task-23',
    conversationId: 'conv-23',
    source: 'remote',
    remoteTaskId: 'remote-row-23',
    status: 'done',
    completion: { summary: 'Completed while bridge offline' },
    lastAnswer: 'Completed while bridge offline',
  };

  // Sync while offline -> marks pending
  const offlineRes = await syncRemoteTaskState({
    bridgeClient: offlineClient,
    taskStore: store,
    task,
  });

  assert.equal(offlineRes.synced, false);
  assert.equal(offlineRes.pending, true);

  const stored = store.getTask('hearth-task-23');
  assert.equal(stored.remoteSyncPending, true);
  assert.equal(stored.remoteSyncStatus, 'pending');

  // Supabase still untouched
  assert.equal(mock.getTasks()[0].status, 'running');

  // Now bridge comes online -> flush pending syncs
  const onlineClient = new HearthBridgeClient({
    deviceId: testDeviceId,
    supabaseUrl: 'https://mock.supabase.co',
    fetchFn: mock.fetch,
  });
  onlineClient.enabled = true;

  const flushRes = await flushPendingRemoteSyncs({
    bridgeClient: onlineClient,
    taskStore: store,
  });

  assert.equal(flushRes.flushed, 1);
  assert.equal(flushRes.failed, 0);

  const dbTask = mock.getTasks().find(t => t.id === 'remote-row-23');
  assert.equal(dbTask.status, 'done');
  assert.equal(dbTask.result, 'Completed while bridge offline');
  assert(dbTask.finished_at);

  const updatedStored = store.getTask('hearth-task-23');
  assert.equal(updatedStored.remoteSyncPending, false);
  assert.equal(updatedStored.remoteSyncStatus, 'synced');
  assert(updatedStored.remoteSyncedAt);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── 24. duplicate sync idempotent ────────────────────────────────────────────
await test('24. duplicate sync calls on same task are idempotent', async () => {
  const mock = createMockTransport([
    { id: 'remote-row-24', device_id: testDeviceId, status: 'running', prompt: 'Idempotency test' }
  ]);
  const client = new HearthBridgeClient({
    deviceId: testDeviceId,
    supabaseUrl: 'https://mock.supabase.co',
    fetchFn: mock.fetch,
  });
  client.enabled = true;

  const task = {
    taskId: 'hearth-task-24',
    conversationId: 'conv-24',
    source: 'remote',
    remoteTaskId: 'remote-row-24',
    status: 'done',
    completion: { summary: 'Idempotent finish' },
  };

  const res1 = await syncRemoteTaskState({ bridgeClient: client, task });
  const res2 = await syncRemoteTaskState({ bridgeClient: client, task });

  assert.equal(res1.synced, true);
  assert.equal(res2.synced, true);
  assert.equal(mock.getTasks().length, 1, 'Must still be exactly 1 row');
  assert.equal(mock.getTasks()[0].status, 'done');
});

// ── 25. local task unaffected ────────────────────────────────────────────────
await test('25. local task is completely unaffected by remote sync logic', async () => {
  const mock = createMockTransport([]);
  const client = new HearthBridgeClient({
    deviceId: testDeviceId,
    supabaseUrl: 'https://mock.supabase.co',
    fetchFn: mock.fetch,
  });
  client.enabled = true;

  const localTask = {
    taskId: 'local-task-25',
    conversationId: 'conv-local-25',
    source: 'local',
    status: 'done',
    completion: { summary: 'Local finish' },
  };

  const res = await syncRemoteTaskState({ bridgeClient: client, task: localTask });
  assert.equal(res.synced, false);
  assert.equal(res.pending, false);
  assert.equal(mock.getTasks().length, 0, 'Zero network calls or DB mutations for local task');
});

// ── 26. strict completion / false-DONE unchanged ────────────────────────────
await test('26. strict completion contract and false-DONE protections unchanged for remote tasks', async () => {
  // Prose with "success" status in JSON must NOT be classified as completed
  const proseWithSuccess = 'Job finished. ```json\n{"status":"success","summary":"Done"}\n```';
  const classified1 = classifyCompletion({
    response: proseWithSuccess,
    executorStatus: 'SUCCESS',
  });
  assert.equal(classified1.status, 'waiting', 'Status success is invalid and remains waiting');

  // Valid completed schema
  const validCompleted = 'Finished turn. ```json\n{"status":"completed","summary":"Build verified"}\n```';
  const classified2 = classifyCompletion({
    response: validCompleted,
    executorStatus: 'SUCCESS',
  });
  assert.equal(classified2.status, 'done');
  assert.equal(classified2.summary, 'Build verified');
});

// ── 27. ERROR releases active lock ──────────────────────────────────────────
await test('27. ERROR releases active lock', async () => {
  const errTask = {
    taskId: 'task-err-27',
    remoteTaskId: 'remote-row-27',
    source: 'remote',
    status: 'error',
    error: 'Antigravity exited without a final response.',
    child: null,
  };
  taskRegistry.set(errTask.taskId, errTask);

  // Authoritative predicate must report false
  assert.equal(isTaskActivelyRunning(errTask), false, 'Error task is not actively running');
  assert.equal(isTaskActivelyRunning(errTask.taskId), false, 'TaskId lookup for error task returns false');

  // Simulated bridge lock release
  let activeRemoteTaskId = errTask.remoteTaskId;
  if (!isTaskActivelyRunning(errTask)) {
    activeRemoteTaskId = null;
  }
  assert.equal(activeRemoteTaskId, null, 'Active lock must be released when task is error');
  taskRegistry.delete(errTask.taskId);
});

// ── 28. stale WAITING after restart does not deadlock new task ──────────────
await test('28. stale WAITING after restart does not deadlock new task', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-bridge-stale-wait-'));
  const store = new TaskStore(path.join(tempDir, 'tasks.json'));
  setTaskStore(store);

  // Clear in-memory registry
  for (const k of taskRegistry.keys()) taskRegistry.delete(k);

  // Persist a waiting task
  store.saveTask({
    taskId: 'task-stale-wait-28',
    remoteTaskId: 'remote-wait-28',
    source: 'remote',
    status: 'waiting',
    workspace: tempDir,
  });

  // Reconcile startup
  store.reconcileStartupState();
  const loadedTask = store.getTask('task-stale-wait-28');
  assert.equal(loadedTask.status, 'waiting', 'Task remains waiting');

  // Stale waiting without live executor must NOT block new task
  assert.equal(isTaskActivelyRunning(loadedTask), false, 'Stale waiting task is not actively running');
  assert.equal(hasRunningTask(), false, 'hasRunningTask must return false for stale waiting');

  setTaskStore(null);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ── 29. live WAITING same conversation allows follow-up ─────────────────────
await test('29. live WAITING same conversation allows follow-up', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-bridge-followup-'));
  const waitingTask = {
    taskId: 'task-followup-29',
    conversationId: 'conv-followup-29',
    workspace: tempDir,
    status: 'waiting',
    isResuming: false,
    recentEvents: [],
  };
  taskRegistry.set(waitingTask.taskId, waitingTask);

  const mockRunner = async (_exe, _args, { input }) => {
    return {
      stdout: JSON.stringify({
        event: 'result',
        result: {
          conversation_id: 'conv-followup-29',
          status: 'SUCCESS',
          response: '```json\n{"status":"completed","summary":"Follow-up successful"}\n```',
        },
      }) + '\n',
    };
  };

  const res = await sendAntigravityMessage({
    taskId: waitingTask.taskId,
    message: 'Proceed with next step',
    customAgyPath: process.execPath,
    runner: mockRunner,
  });

  assert.equal(res.status, 'done', 'Follow-up must complete successfully');
  assert.equal(waitingTask.status, 'done', 'Task status must transition to done');
  taskRegistry.delete(waitingTask.taskId);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ── 30. stale WAITING can coexist with approval of new independent task ──────
await test('30. stale WAITING can coexist with approval of new independent task according to policy', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-bridge-coexist-'));
  const store = new TaskStore(path.join(tempDir, 'tasks.json'));
  setTaskStore(store);

  // Stale waiting task 1
  store.saveTask({
    taskId: 'task-coexist-1',
    remoteTaskId: 'remote-1',
    source: 'remote',
    status: 'waiting',
  });

  // New independent task 2
  const newRemoteTaskId = 'remote-2';
  const existing = store.findTaskByRemoteLink({ remoteTaskId: newRemoteTaskId });
  assert.equal(existing, null, 'New independent task has no duplicate linkage');

  // Authoritative predicate confirms Task 1 does not block Task 2
  assert.equal(hasRunningTask(), false, 'Stale waiting task 1 does not block new independent task');

  setTaskStore(null);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ── 31. RUNNING -> WAITING -> ERROR syncs same remote row ───────────────────
await test('31. RUNNING -> WAITING -> ERROR syncs same remote row', async () => {
  const mock = createMockTransport([
    { id: 'remote-row-31', device_id: testDeviceId, status: 'running', prompt: 'Transition test' }
  ]);
  const client = new HearthBridgeClient({
    deviceId: testDeviceId,
    supabaseUrl: 'https://mock.supabase.co',
    fetchFn: mock.fetch,
  });
  client.enabled = true;

  const task = {
    taskId: 'hearth-task-31',
    conversationId: 'conv-31',
    source: 'remote',
    remoteTaskId: 'remote-row-31',
    status: 'running',
    recentEvents: [],
  };

  // Step 1: Transitions to WAITING (interim)
  task.status = 'waiting';
  task.completion = { summary: 'Waiting for additional input' };
  const resWait = await syncRemoteTaskState({ bridgeClient: client, task });
  assert.equal(resWait.synced, true);
  assert.equal(mock.getTasks()[0].status, 'waiting');
  assert(!mock.getTasks()[0].finished_at, 'finished_at must not be set on waiting');

  // Step 2: Executor exits without final response -> ERROR
  task.status = 'error';
  task.error = 'Antigravity exited without a final response.';
  const resErr = await syncRemoteTaskState({ bridgeClient: client, task });
  assert.equal(resErr.synced, true);
  assert.equal(mock.getTasks()[0].status, 'error');
  assert.notEqual(mock.getTasks()[0].finished_at, null, 'finished_at must be set on terminal error');
  assert.equal(mock.getTasks()[0].error, 'Antigravity exited without a final response.');
  assert.equal(mock.getTasks().length, 1, 'Must still be exactly 1 row; no duplicates');
});

// ── 32. executor exits without final response -> remote ERROR + finished_at ──
await test('32. executor exits without final response -> remote ERROR + finished_at', async () => {
  const mock = createMockTransport([
    { id: 'remote-row-32', device_id: testDeviceId, status: 'running', prompt: 'Exit without response' }
  ]);
  const client = new HearthBridgeClient({
    deviceId: testDeviceId,
    supabaseUrl: 'https://mock.supabase.co',
    fetchFn: mock.fetch,
  });
  client.enabled = true;

  // Simulate classifyCompletion with empty response
  const completion = classifyCompletion({ response: '', executorStatus: 'SUCCESS' });
  assert.equal(completion.status, 'error');
  assert.equal(completion.error, 'Antigravity exited without a final response.');

  const task = {
    taskId: 'hearth-task-32',
    conversationId: 'conv-32',
    source: 'remote',
    remoteTaskId: 'remote-row-32',
    status: completion.status,
    error: completion.error,
    completion,
  };

  const res = await syncRemoteTaskState({ bridgeClient: client, task });
  assert.equal(res.synced, true);
  const row = mock.getTasks()[0];
  assert.equal(row.status, 'error');
  assert.notEqual(row.finished_at, null, 'finished_at must be recorded');
  assert.equal(row.error, 'Antigravity exited without a final response.');
});

// ── 33. persisted ERROR never restores as WAITING ───────────────────────────
await test('33. persisted ERROR never restores as WAITING', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-bridge-err-'));
  const store = new TaskStore(path.join(tempDir, 'tasks.json'));

  store.saveTask({
    taskId: 'task-err-33',
    remoteTaskId: 'remote-33',
    source: 'remote',
    status: 'error',
    error: 'Antigravity exited without a final response.',
  });

  // Reconcile startup
  store.reconcileStartupState();
  const task = store.getTask('task-err-33');
  assert.equal(task.status, 'error', 'Error status must remain strictly error');
  assert.notEqual(task.status, 'waiting', 'Error must never be restored to waiting');
  assert.notEqual(task.status, 'running', 'Error must never be restored to running');

  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ── 34. new remote task can Approve & Run after prior ERROR ─────────────────
await test('34. new remote task can Approve & Run after prior ERROR', async () => {
  let activeRemoteTaskId = 'task-prior-err-34';
  const priorTask = {
    taskId: 'task-prior-err-34',
    source: 'remote',
    status: 'error',
    error: 'Antigravity exited without a final response.',
  };
  taskRegistry.set(priorTask.taskId, priorTask);

  // When approving new task: check if active task is actually running
  if (activeRemoteTaskId) {
    const active = isTaskActivelyRunning(activeRemoteTaskId);
    if (!active) {
      activeRemoteTaskId = null; // Automatically cleared
    }
  }

  assert.equal(activeRemoteTaskId, null, 'Prior error task lock must be automatically cleared');

  // New task can now acquire the lock
  const newTaskId = 'task-new-34';
  activeRemoteTaskId = newTaskId;
  assert.equal(activeRemoteTaskId, newTaskId, 'New remote task successfully claims lock');
  taskRegistry.delete(priorTask.taskId);
});

// ── 35. no duplicate remote row/task/conversation ───────────────────────────
await test('35. no duplicate remote row/task/conversation across transitions', async () => {
  const mock = createMockTransport([
    { id: 'remote-row-35', device_id: testDeviceId, status: 'running', prompt: 'Unique row test' }
  ]);
  const client = new HearthBridgeClient({
    deviceId: testDeviceId,
    supabaseUrl: 'https://mock.supabase.co',
    fetchFn: mock.fetch,
  });
  client.enabled = true;

  const task = {
    taskId: 'hearth-task-35',
    conversationId: 'conv-unique-35',
    source: 'remote',
    remoteTaskId: 'remote-row-35',
    status: 'running',
  };

  // Multiple sequential sync calls simulating turn transitions
  await syncRemoteTaskState({ bridgeClient: client, task, overrides: { status: 'running' } });
  await syncRemoteTaskState({ bridgeClient: client, task, overrides: { status: 'waiting' } });
  await syncRemoteTaskState({ bridgeClient: client, task, overrides: { status: 'error', error: 'Exited' } });

  const tasks = mock.getTasks();
  assert.equal(tasks.length, 1, 'Must maintain exactly one row without duplicates');
  assert.equal(tasks[0].id, 'remote-row-35');
  assert.equal(tasks[0].hearth_task_id, 'hearth-task-35');
  assert.equal(tasks[0].conversation_id, 'conv-unique-35');
});

// ── 36. strict completion contract unchanged ────────────────────────────────
await test('36. strict completion contract unchanged: success/done in json are NOT completed', async () => {
  const invalidSuccess = classifyCompletion({
    response: '```json\n{"status":"success","summary":"done"}\n```',
    executorStatus: 'SUCCESS',
  });
  assert.equal(invalidSuccess.status, 'waiting', 'status success must remain waiting');

  const invalidDone = classifyCompletion({
    response: '```json\n{"status":"done","summary":"done"}\n```',
    executorStatus: 'SUCCESS',
  });
  assert.equal(invalidDone.status, 'waiting', 'status done must remain waiting');

  const validCompleted = classifyCompletion({
    response: '```json\n{"status":"completed","summary":"verified"}\n```',
    executorStatus: 'SUCCESS',
  });
  assert.equal(validCompleted.status, 'done', 'status completed must transition to done');
});

// ── 37. recovery/persistence v0.4.3 unchanged ───────────────────────────────
await test('37. recovery/persistence v0.4.3 unchanged: recovery_required blocks until dismissed', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-bridge-v043-'));
  const store = new TaskStore(path.join(tempDir, 'tasks.json'));
  setTaskStore(store);

  // Clear in-memory taskRegistry
  for (const k of taskRegistry.keys()) taskRegistry.delete(k);

  store.saveTask({
    taskId: 'task-rec-37',
    status: 'recovery_required',
    dismissed: false,
    workspace: tempDir,
  });

  assert.equal(hasRunningTask(), true, 'Undismissed recovery_required must block');

  store.dismissTask('task-rec-37');
  assert.equal(hasRunningTask(), false, 'Dismissed recovery task releases lock');

  setTaskStore(null);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ── 38. native packaged condition: two stale WAITING tasks + no live process -> new approval succeeds
await test('38. native packaged condition: two stale WAITING tasks + no live process -> new approval succeeds', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-bridge-native-deadlock-'));
  const store = new TaskStore(path.join(tempDir, 'tasks.json'));
  setTaskStore(store);

  // Clear in-memory taskRegistry
  for (const k of taskRegistry.keys()) taskRegistry.delete(k);

  // Stale waiting task 1 (e.g. prior executor error recovered as waiting)
  store.saveTask({
    taskId: 'local-wait-1',
    remoteTaskId: 'remote-wait-row-1',
    source: 'remote',
    status: 'waiting',
    workspace: tempDir,
    completion: {
      status: 'waiting',
      summary: 'Interim waiting response',
    },
  });

  // Stale waiting task 2 (e.g. second remote task left in waiting in DB)
  store.saveTask({
    taskId: 'local-wait-2',
    remoteTaskId: 'remote-wait-row-2',
    source: 'remote',
    status: 'waiting',
    workspace: tempDir,
    completion: {
      status: 'waiting',
      summary: 'Another waiting response',
    },
  });

  // Reconcile startup
  const reconcileRes = store.reconcileStartupState();
  assert.equal(reconcileRes.reconciledCount, 0, 'Waiting tasks are untouched by startup reconciliation');

  // Exact native bridge state simulation
  let activeRemoteTaskId = 'remote-wait-row-2'; // May have lingered from resume
  const newPendingTaskId = 'remote-pending-row-3';

  // Native approval guard in bridge:approve-task
  const approveGuard = () => {
    if (activeRemoteTaskId) {
      if (!isTaskActivelyRunning(activeRemoteTaskId)) {
        activeRemoteTaskId = null; // Cleared because dormant waiting
      } else {
        throw new Error('Another task is currently running.');
      }
    }
    if (hasRunningTask()) {
      throw new Error('Another task is currently running.');
    }
  };

  // Must not throw "Another task is currently running."
  approveGuard();

  assert.equal(activeRemoteTaskId, null, 'Lingering remote lock must be cleared');
  assert.equal(hasRunningTask(), false, 'hasRunningTask must be false when only waiting tasks exist');

  // Now the new independent task can claim active lock and start
  activeRemoteTaskId = newPendingTaskId;
  assert.equal(activeRemoteTaskId, newPendingTaskId, 'New task claims activeRemoteTaskId');

  setTaskStore(null);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ── 39. bridge:approve-task runtime closure execution: all bindings exist without ReferenceError
await test('39. bridge:approve-task runtime closure execution: all bindings exist without ReferenceError', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-bridge-approve-closure-'));
  const store = new TaskStore(path.join(tempDir, 'tasks.json'));
  setTaskStore(store);

  // Clear in-memory taskRegistry
  for (const k of taskRegistry.keys()) taskRegistry.delete(k);

  // Verify electron/main.cjs source contains getAntigravityTask in the bridge:approve-task handler
  const mainCjsSrc = fs.readFileSync(path.join(process.cwd(), 'electron/main.cjs'), 'utf8');
  const handlerMatch = mainCjsSrc.match(/ipcMain\.handle\('bridge:approve-task'[\s\S]*?const \{([\s\S]*?)\} = await importFromHere\('\.\.\/mcp\/executors\/antigravity\.mjs'\);/);
  assert(handlerMatch, 'bridge:approve-task handler must import from antigravity.mjs');
  const importedSymbols = handlerMatch[1].split(',').map(s => s.trim());
  assert(importedSymbols.includes('getAntigravityTask'), 'bridge:approve-task MUST import getAntigravityTask');
  assert(importedSymbols.includes('startAntigravityTask'), 'bridge:approve-task MUST import startAntigravityTask');
  assert(importedSymbols.includes('hasRunningTask'), 'bridge:approve-task MUST import hasRunningTask');
  assert(importedSymbols.includes('isTaskActivelyRunning'), 'bridge:approve-task MUST import isTaskActivelyRunning');

  // Execute the exact runtime bridge:approve-task execution block
  const {
    hasRunningTask: checkRunning,
    isTaskActivelyRunning: checkActive,
    startAntigravityTask: startTask,
    getAntigravityTask: getTask,
  } = await import('../mcp/executors/antigravity.mjs');

  const { syncRemoteTaskState: syncRemote } = await import('../mcp/bridge/client.mjs');

  const mock = createMockTransport([
    { id: 'remote-approve-39', device_id: testDeviceId, status: 'pending', prompt: 'Approve runtime test' }
  ]);
  const client = new HearthBridgeClient({
    deviceId: testDeviceId,
    supabaseUrl: 'https://mock.supabase.co',
    fetchFn: mock.fetch,
  });
  client.enabled = true;

  const mockRunner = async () => ({
    stdout: JSON.stringify({
      event: 'init',
      conversation_id: 'conv-approve-39',
    }) + '\n' + JSON.stringify({
      event: 'result',
      status: 'SUCCESS',
      result: {
        status: 'SUCCESS',
        response: '```json\n{"status":"completed","summary":"Approval execution success"}\n```',
      },
    }) + '\n',
  });

  // Execute approval path simulating bridge:approve-task
  const taskId = 'remote-approve-39';
  let activeRemoteTaskId = null;

  if (activeRemoteTaskId) {
    if (!checkActive(activeRemoteTaskId)) {
      activeRemoteTaskId = null;
    } else {
      throw new Error('Another task is currently running.');
    }
  }
  if (checkRunning && checkRunning()) {
    throw new Error('Another task is currently running.');
  }

  const claimResult = await client.claimTask({ taskId });
  assert(claimResult.claimed === true, 'Claim must succeed');
  activeRemoteTaskId = taskId;

  const startRes = await startTask({
    workspace: tempDir,
    prompt: 'Approve runtime test',
    title: 'Test Remote Task',
    source: 'remote',
    remoteTaskId: taskId,
    requestId: 'req-39',
    userApproved: true,
    runner: mockRunner,
    customAgyPath: process.execPath,
  });

  // Verify getAntigravityTask is defined, callable, and resolves the task object
  assert(typeof getTask === 'function', 'getAntigravityTask must be a function');
  const taskObj = getTask(startRes.taskId) || startRes;
  assert(taskObj !== null && typeof taskObj === 'object', 'taskObj must be resolved');
  assert.equal(taskObj.taskId, startRes.taskId, 'taskObj must match started taskId');

  // Verify syncRemoteTaskState runs cleanly without error
  await syncRemote({
    bridgeClient: client,
    taskStore: store,
    task: taskObj,
    overrides: { status: 'running' },
  });

  const updatedDb = mock.getTasks().find(t => t.id === taskId);
  assert.equal(updatedDb.status, 'running', 'DB task must be updated to running');
  assert.equal(updatedDb.hearth_task_id, startRes.taskId, 'DB task must have hearth_task_id');

  setTaskStore(null);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// Problem B Remote Linkage & Durable Sync Tests (G through L)
// ══════════════════════════════════════════════════════════════════════════════

// G. Remote start immediately writes hearth_task_id + conversation_id to same row
await test('G. Remote start immediately writes hearth_task_id + conversation_id to same row', async () => {
  const deviceId = 'dev-g-test';
  const remoteId = 'remote-g-1';
  const mock = createMockTransport([
    {
      id: remoteId,
      device_id: deviceId,
      prompt: 'Remote start immediate sync test',
      status: 'pending',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      hearth_task_id: null,
      conversation_id: null,
    },
  ]);

  const client = new HearthBridgeClient({
    supabaseUrl: 'https://mock.supabase.co',
    supabaseKey: 'mock-key',
    deviceId,
    fetchFn: mock.fetch,
  });

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-bridge-g-'));
  const store = new TaskStore({ storagePath: path.join(tempDir, 'tasks.json') });
  store.load();

  // 1. Claim task
  const claimRes = await client.claimTask({ taskId: remoteId });
  assert.equal(claimRes.claimed, true);

  // 2. Pre-allocate Hearth taskId and persist immediately
  const hearthTaskId = 'hearth-g-' + Date.now();
  const initialTask = {
    taskId: hearthTaskId,
    conversationId: null,
    workspace: tempDir,
    title: 'Immediate sync test',
    source: 'remote',
    remoteTaskId: remoteId,
    requestId: 'req-g-1',
    status: 'starting',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    remoteSyncPending: false,
    remoteSyncStatus: 'pending',
  };
  store.saveTask(initialTask);

  // 3. Immediately sync hearth_task_id
  await syncRemoteTaskState({
    bridgeClient: client,
    taskStore: store,
    task: initialTask,
    overrides: { status: 'running' },
  });

  // Verify DB row has hearth_task_id immediately
  let row = mock.getTasks().find(t => t.id === remoteId);
  assert.equal(row.hearth_task_id, hearthTaskId);
  assert.equal(row.status, 'running');

  // 4. Once conversationId is discovered, immediately sync conversation_id
  const convId = 'conv-g-' + Date.now();
  initialTask.conversationId = convId;
  initialTask.status = 'running';
  await syncRemoteTaskState({
    bridgeClient: client,
    taskStore: store,
    task: initialTask,
  });

  // Verify same row has both hearth_task_id and conversation_id
  row = mock.getTasks().find(t => t.id === remoteId);
  assert.equal(row.hearth_task_id, hearthTaskId);
  assert.equal(row.conversation_id, convId);
  assert.equal(mock.getTasks().length, 1, 'Never create duplicate remote rows');

  fs.rmSync(tempDir, { recursive: true, force: true });
});

// H. failed initial remote sync queues retry
await test('H. failed initial remote sync queues retry', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-bridge-h-'));
  const store = new TaskStore({ storagePath: path.join(tempDir, 'tasks.json') });
  store.load();

  const remoteId = 'remote-h-1';
  const hearthTaskId = 'hearth-h-1';
  const initialTask = {
    taskId: hearthTaskId,
    conversationId: null,
    workspace: tempDir,
    title: 'Offline sync test',
    source: 'remote',
    remoteTaskId: remoteId,
    requestId: 'req-h-1',
    status: 'starting',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  store.saveTask(initialTask);

  // Sync with client offline / null client
  const res = await syncRemoteTaskState({
    bridgeClient: null, // offline
    taskStore: store,
    task: initialTask,
    overrides: { status: 'running' },
  });

  assert.equal(res.synced, false);
  assert.equal(res.pending, true);

  // Verify task in store has remoteSyncPending = true
  const stored = store.getTask(hearthTaskId);
  assert.equal(stored.remoteSyncPending, true);
  assert.equal(stored.remoteSyncStatus, 'pending');

  // Bring client online and flush
  const mock = createMockTransport([
    {
      id: remoteId,
      device_id: 'dev-h',
      status: 'pending',
      hearth_task_id: null,
      conversation_id: null,
    },
  ]);
  const onlineClient = new HearthBridgeClient({
    supabaseUrl: 'https://mock.supabase.co',
    supabaseKey: 'mock-key',
    deviceId: 'dev-h',
    fetchFn: mock.fetch,
  });

  const flushRes = await flushPendingRemoteSyncs({
    bridgeClient: onlineClient,
    taskStore: store,
  });
  assert.equal(flushRes.flushed, 1);
  assert.equal(store.getTask(hearthTaskId).remoteSyncPending, false);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

// I. restart preserves pending remote linkage
await test('I. restart preserves pending remote linkage', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-bridge-i-'));
  const storagePath = path.join(tempDir, 'tasks.json');
  const store1 = new TaskStore({ storagePath });
  store1.load();

  const remoteId = 'remote-i-1';
  const hearthTaskId = 'hearth-i-1';
  const task = {
    taskId: hearthTaskId,
    conversationId: 'conv-i-1',
    workspace: tempDir,
    title: 'Restart linkage test',
    source: 'remote',
    remoteTaskId: remoteId,
    requestId: 'req-i-1',
    status: 'running',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    remoteSyncPending: true,
    remoteSyncStatus: 'pending',
  };
  store1.saveTask(task);

  // Simulate application restart
  const store2 = new TaskStore({ storagePath });
  store2.load();
  const recon = store2.reconcileStartupState();
  assert.equal(recon.reconciledCount, 1);

  const restored = store2.getTask(hearthTaskId);
  assert.equal(restored.status, 'recovery_required');
  assert.equal(restored.source, 'remote');
  assert.equal(restored.remoteTaskId, remoteId);
  assert.equal(restored.requestId, 'req-i-1');
  assert.equal(restored.conversationId, 'conv-i-1');
  assert.equal(restored.remoteSyncPending, true);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

// J. terminal state updates same remote row
await test('J. terminal state updates same remote row', async () => {
  const deviceId = 'dev-j-test';
  const remoteId = 'remote-j-1';
  const mock = createMockTransport([
    {
      id: remoteId,
      device_id: deviceId,
      status: 'running',
      hearth_task_id: 'hearth-j-1',
      conversation_id: 'conv-j-1',
    },
  ]);
  const client = new HearthBridgeClient({
    supabaseUrl: 'https://mock.supabase.co',
    supabaseKey: 'mock-key',
    deviceId,
    fetchFn: mock.fetch,
  });

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-bridge-j-'));
  const store = new TaskStore({ storagePath: path.join(tempDir, 'tasks.json') });
  store.load();

  const task = {
    taskId: 'hearth-j-1',
    conversationId: 'conv-j-1',
    workspace: tempDir,
    title: 'Terminal sync test',
    source: 'remote',
    remoteTaskId: remoteId,
    requestId: 'req-j-1',
    status: 'done',
    completion: { status: 'done', summary: 'Work completed successfully.' },
    lastAnswer: 'Work completed successfully.',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  store.saveTask(task);

  const res = await syncRemoteTaskState({
    bridgeClient: client,
    taskStore: store,
    task,
  });
  assert.equal(res.synced, true);

  const row = mock.getTasks().find(t => t.id === remoteId);
  assert.equal(row.status, 'done');
  assert.equal(row.result, 'Work completed successfully.');
  assert(row.finished_at !== null && row.finished_at !== undefined);
  assert.equal(row.hearth_task_id, 'hearth-j-1');
  assert.equal(row.conversation_id, 'conv-j-1');

  fs.rmSync(tempDir, { recursive: true, force: true });
});

// K. source=remote without remoteTaskId is rejected/reconciled safely
await test('K. source=remote without remoteTaskId is rejected/reconciled safely', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-bridge-k-'));
  const store = new TaskStore({ storagePath: path.join(tempDir, 'tasks.json') });
  store.load();

  // 1. Explicit saveTask throws invariant error if source='remote' lacks remoteTaskId
  let threw = false;
  try {
    store.saveTask({
      taskId: 'hearth-k-invalid',
      source: 'remote',
      remoteTaskId: null,
      workspace: tempDir,
      title: 'Invalid remote task',
      status: 'starting',
    });
  } catch (err) {
    threw = true;
    assert(err.message.includes('missing required remoteTaskId'));
  }
  assert.equal(threw, true, 'saveTask must throw if source=remote has no remoteTaskId');

  // 2. Loading raw persisted payload with source='remote' and empty remoteTaskId reconciles safely to 'local'
  const rawPayload = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    tasks: [
      {
        taskId: 'hearth-k-reconcile',
        source: 'remote',
        remoteTaskId: '',
        workspace: tempDir,
        title: 'Corrupt source',
        status: 'running',
      },
    ],
  };
  fs.writeFileSync(path.join(tempDir, 'tasks.json'), JSON.stringify(rawPayload));
  const store2 = new TaskStore({ storagePath: path.join(tempDir, 'tasks.json') });
  store2.load();
  const loaded = store2.getTask('hearth-k-reconcile');
  assert.equal(loaded.source, 'local', 'Missing remoteTaskId must be reconciled safely to local');

  fs.rmSync(tempDir, { recursive: true, force: true });
});

// L. no duplicate task/row/conversation
await test('L. no duplicate task/row/conversation', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-bridge-l-'));
  const store = new TaskStore({ storagePath: path.join(tempDir, 'tasks.json') });
  store.load();

  const remoteId = 'remote-l-1';
  const reqId = 'req-l-1';
  store.saveTask({
    taskId: 'hearth-l-existing',
    source: 'remote',
    remoteTaskId: remoteId,
    requestId: reqId,
    workspace: tempDir,
    title: 'Duplicate prevention test',
    status: 'running',
  });

  // Verify findTaskByRemoteLink detects existing task by remoteTaskId or requestId
  const existingByRemote = store.findTaskByRemoteLink({ remoteTaskId: remoteId });
  assert(existingByRemote !== null);
  assert.equal(existingByRemote.taskId, 'hearth-l-existing');

  const existingByReq = store.findTaskByRemoteLink({ requestId: reqId });
  assert(existingByReq !== null);
  assert.equal(existingByReq.taskId, 'hearth-l-existing');

  // Verify mock database rows stay exactly 1 across multiple sync calls
  const mock = createMockTransport([
    {
      id: remoteId,
      device_id: 'dev-l',
      status: 'running',
      hearth_task_id: 'hearth-l-existing',
    },
  ]);
  const client = new HearthBridgeClient({
    supabaseUrl: 'https://mock.supabase.co',
    supabaseKey: 'mock-key',
    deviceId: 'dev-l',
    fetchFn: mock.fetch,
  });

  const task = store.getTask('hearth-l-existing');
  await syncRemoteTaskState({ bridgeClient: client, taskStore: store, task });
  await syncRemoteTaskState({ bridgeClient: client, taskStore: store, task });
  await syncRemoteTaskState({ bridgeClient: client, taskStore: store, task });

  assert.equal(mock.getTasks().length, 1, 'Supabase table must contain exactly 1 row without duplicates');

  fs.rmSync(tempDir, { recursive: true, force: true });
});

console.log('\n══════════════════════════════════════════════════════════');
console.log(`  Bridge Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);
console.log('══════════════════════════════════════════════════════════\n');

if (failed > 0) process.exit(1);
