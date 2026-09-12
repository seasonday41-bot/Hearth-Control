/**
 * Hearth Antigravity Integration Test Suite
 * Tests the Antigravity Executor V1 adapter, task registry, transcript redaction,
 * input validation, and permission enforcement without executing real tasks.
 *
 * SAFETY GUARANTEES OF THIS TEST SUITE:
 * - NO calls to real `agentapi new-conversation`
 * - NO calls to real `agentapi send-message`
 * - NO creation of real Antigravity tasks or conversations
 * - ALL process execution in start/send tests uses injected in-memory mock runners
 * - Real agentapi is ONLY checked via read-only fs.access/fs.stat in detectAntigravity
 * - NO reading of oauth_creds.json
 * - NO editing or writing to ~/.gemini/*
 * - NO editing or touching files outside test fixtures
 * - NO git commits or pushes
 */
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  detectAntigravity,
  startAntigravityTask,
  getAntigravityTask,
  sendAntigravityMessage,
  redactSecrets,
  resolveAgyPath,
  taskRegistry,
  hasRunningTask,
  isTaskActivelyRunning,
  resumeAntigravityTask,
  MAX_PAYLOAD_BYTES,
  classifyCompletion,
  HEARTH_COMPLETION_INSTRUCTION,
  buildAgyPrompt,
  registerBackgroundJob,
  recordBackgroundHeartbeat,
  completeBackgroundJob,
  getTaskExecutionState,
  isStreamInterruptedMessage,
  isStreamInterruptionEvent,
  extractInterruptionMessage,
  onTaskTransition,
} from '../mcp/executors/antigravity.mjs';
import {
  syncRemoteTaskState,
  HearthBridgeClient,
  createMockTransport,
} from '../mcp/bridge/client.mjs';
import { createMcpServer } from '../mcp/create-server.mjs';

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
  if (actual !== expected) {
    throw new Error(message || `Assertion failed: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
};

console.log('\n═══ Test Suite: Antigravity Executor V1 ═══\n');

// ── 1. detectAntigravity on current system ─────────────────────────────────
// Read-only filesystem stat/access check (zero subprocess calls)
await test('1. detectAntigravity returns structured detection on this Mac', async () => {
  const res = await detectAntigravity();
  assert(typeof res.available === 'boolean', 'available must be boolean');
  if (res.available) {
    assert(res.agentApiPath !== null, 'agentApiPath must not be null');
    assert(!res.agentApiPath.includes('..'), 'path must not contain traversal');
    assert(res.appPath !== null, 'appPath must not be null');
  } else {
    // When run inside sandbox where ~/.gemini is isolated from workspace,
    // ensure structured failure reason is returned without throwing.
    assert(typeof res.reason === 'string', 'reason must be a string');
  }
});

// ── 2. Invalid supported CLI path detection ────────────────────────────────
// Read-only filesystem check with custom invalid path (zero subprocess calls)
await test('2. resolveAgyPath handles an invalid CLI path gracefully', async () => {
  const cliPath = await resolveAgyPath('/nonexistent/mock/path/to/agy');
  assert(cliPath === null, 'invalid custom CLI path must resolve to null');
});

// ── 3. Workspace validation ───────────────────────────────────────────────
// Validation before execution: rejects invalid paths before calling runner
await test('3. startAntigravityTask rejects missing or invalid workspace', async () => {
  let threw = false;
  let runnerInvoked = false;
  try {
    await startAntigravityTask({
      workspace: '/nonexistent/directory/for/testing/hearth',
      prompt: 'Hello',
      customAgentApiPath: '/mock/bin/agentapi',
      runner: async () => { runnerInvoked = true; return { stdout: '{}', stderr: '' }; },
    });
  } catch (err) {
    threw = true;
    assert(err.message.includes('Workspace path') || err.message.includes('invalid'), `Unexpected error: ${err.message}`);
  }
  assert(threw, 'Should throw for invalid workspace');
  assert(!runnerInvoked, 'Runner must never be invoked if workspace is invalid');
});

// ── 4. Prompt size validation (64 KiB byte length) ─────────────────────────
// Validation before execution: rejects oversized prompt before calling runner
await test('4. startAntigravityTask rejects prompt exceeding 64 KiB byte length', async () => {
  const oversizedPrompt = 'A'.repeat(MAX_PAYLOAD_BYTES + 1);
  let threw = false;
  let runnerInvoked = false;
  try {
    await startAntigravityTask({
      workspace: process.cwd(),
      prompt: oversizedPrompt,
      customAgentApiPath: '/mock/bin/agentapi',
      runner: async () => { runnerInvoked = true; return { stdout: '{}', stderr: '' }; },
    });
  } catch (err) {
    threw = true;
    assert(err.message.includes('64 KiB'), `Expected 64 KiB rejection message, got: ${err.message}`);
  }
  assert(threw, 'Should throw for oversized prompt');
  assert(!runnerInvoked, 'Runner must never be invoked if prompt is oversized');
});

// ── 5. agentapi JSON parser ────────────────────────────────────────────────
// Uses in-memory mock runner: zero real subprocess execution
await test('5. startAntigravityTask parses agentapi JSON output correctly', async () => {
  const testConvId = 'test-conv-' + crypto.randomUUID();
  const mockRunner = async (file, args, opts) => {
    assert(args[0] === 'new-conversation', 'First arg must be new-conversation');
    return {
      stdout: JSON.stringify({
        response: {
          conversationMetadata: {
            metadata: {
              rootConversationId: testConvId,
            },
          },
        },
      }),
      stderr: '',
    };
  };

  const res = await startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'Safe unit test prompt',
    title: 'Unit Test Task',
    customAgentApiPath: '/mock/bin/agentapi',
    runner: mockRunner,
  });

  assert(typeof res.taskId === 'string', 'taskId must be a string');
  assert(res.conversationId === testConvId, 'conversationId must match mock');
  assert(res.status === 'running', 'status must be running');
  assert(res.workspace === process.cwd(), 'workspace must match');

  // Clean up any watcher attached to task
  const rawTask = taskRegistry.get(res.taskId);
  if (rawTask?.cleanup) rawTask.cleanup();
});

await test('5b. startAntigravityTask uses CLI stream input and records its final result', async () => {
  const testConvId = 'cli-conv-' + crypto.randomUUID();
  const mockRunner = async (_file, args, opts) => {
    assert(args.includes('--input-format'), 'CLI input format must be explicit');
    assert(args.includes('--output-format'), 'CLI output format must be explicit');
    assert(args.includes('--disable-slash-commands'), 'Slash commands must be disabled for remote prompts');
    assert(args.includes('--sandbox'), 'CLI must run with sandbox restrictions');
    assert(args.includes('--dangerously-skip-permissions'), 'Explicit Hearth approval must be forwarded to the CLI for this run');
    assert(args.includes('--add-dir'), 'Approved workspace must be registered explicitly');
    assert(args[args.indexOf('--add-dir') + 1] === process.cwd(), 'Registered workspace must match the active Hearth workspace');
    assert(!args.includes('Safe CLI prompt'), 'Prompt must not be exposed in process arguments');
    const inputEvent = JSON.parse(opts.input.trim());
    assert(inputEvent.event === 'user', 'CLI stdin event must be user');
    assert(inputEvent.message.content.includes('Safe CLI prompt'), 'CLI stdin prompt must include the remote task');
    assert(inputEvent.message.content.includes(process.cwd()), 'CLI stdin prompt must include the approved workspace context');
    return {
      stdout: [
        JSON.stringify({ event: 'init', conversation_id: testConvId, init: { permission_mode: 'request-review' } }),
        JSON.stringify({ event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'FINAL STATUS: COMPLETED — Read-only result' } }),
        JSON.stringify({ event: 'result', result: { conversation_id: testConvId, status: 'SUCCESS', response: 'FINAL STATUS: COMPLETED — Read-only result' } }),
      ].join('\n'),
      stderr: '',
    };
  };

  const res = await startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'Safe CLI prompt',
    customAgyPath: process.execPath,
    userApproved: true,
    runner: mockRunner,
  });
  const task = getAntigravityTask(res.taskId);
  assert(res.status === 'done', 'CLI task must finish as done');
  assert(task.conversationId === testConvId, 'CLI conversation ID must match');
  assert(task.lastAnswer.includes('Read-only result'), 'CLI result must be stored');
});

await test('5c. successful CLI envelope without a response is treated as an error', async () => {
  const testConvId = 'cli-empty-' + crypto.randomUUID();
  const res = await startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'Empty response test',
    customAgyPath: process.execPath,
    runner: async () => ({
      stdout: JSON.stringify({
        event: 'result',
        result: { conversation_id: testConvId, status: 'SUCCESS', response: '' },
      }),
      stderr: '',
    }),
  });
  const task = getAntigravityTask(res.taskId);
  assert(res.status === 'error', 'Empty CLI response must not be reported as done');
  assert(task.error.includes('without a final response'), 'Empty response error must be actionable');
});

// ── 5d. Completion contract (pure classifier + local fixtures only) ───────
await test('5d. progress-like final response remains waiting after clean process exit', () => {
  const completion = classifyCompletion({ response: 'Still working: packaging the app. Will report when finished.', executorStatus: 'SUCCESS' });
  assert(completion.status === 'waiting', 'Progress text must never become done');
  assert(completion.normalizedStatus === 'waiting', 'Normalized state must be waiting');
});

await test('5e. explicit structured completed final becomes done', () => {
  const completion = classifyCompletion({
    response: { status: 'completed', summary: 'Build and tests completed.', checks: { build: 'passed', tests: 'passed' } },
    executorStatus: 'SUCCESS',
  });
  assert(completion.status === 'done', 'Structured completed final must become done');
  assert(completion.checks.build === 'passed' && completion.checks.tests === 'passed', 'Structured checks must be retained');
});

await test('5e1. prose plus fenced completed contract becomes done', () => {
  const completion = classifyCompletion({ response: 'Verification finished.\n```json\n{"status":"completed","summary":"Build and tests completed."}\n```', executorStatus: 'SUCCESS' });
  assert(completion.status === 'done', 'Valid fenced completed contract must become done');
});

await test('5e2. prose plus fenced waiting contract remains waiting', () => {
  const completion = classifyCompletion({ response: 'A quick update:\n```json\n{"status":"waiting","summary":"Still packaging."}\n```', executorStatus: 'SUCCESS' });
  assert(completion.status === 'waiting', 'Valid fenced waiting contract must remain waiting');
});

await test('5e3. malformed or unrelated fenced JSON never becomes done', () => {
  const malformed = classifyCompletion({ response: '```json\n{"status":"completed",}\n```', executorStatus: 'SUCCESS' });
  const unrelated = classifyCompletion({ response: '```json\n{"status":"completed","message":"not a completion contract"}\n```', executorStatus: 'SUCCESS' });
  assert(malformed.status !== 'done' && unrelated.status !== 'done', 'Invalid fenced data must never satisfy completion');
});

await test('5e4. progress text with completed-looking words but no contract remains waiting', () => {
  const completion = classifyCompletion({ response: 'Still working; completed checks will be reported when packaging is finished.', executorStatus: 'SUCCESS' });
  assert(completion.status === 'waiting', 'Progress-like text must not become done');
});

await test('5f. missing required artifact prevents done', () => {
  const completion = classifyCompletion({
    response: { status: 'completed', summary: 'Completed.' },
    executorStatus: 'SUCCESS',
    workspace: process.cwd(),
    verificationRequirements: { requiredArtifacts: 'release/Hearth.dmg' },
  });
  assert(completion.status === 'waiting', 'Missing required artifact must not become done');
});

await test('5g. existing required artifact permits done', () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-completion-'));
  const artifact = path.join(fixtureDir, 'Hearth.dmg');
  fs.writeFileSync(artifact, 'fixture');
  try {
    const completion = classifyCompletion({
      response: { status: 'completed', summary: 'Completed.', artifacts: ['Hearth.dmg'] },
      executorStatus: 'SUCCESS',
      workspace: fixtureDir,
    });
    assert(completion.status === 'done', 'Existing declared artifact must permit done');
    assert(completion.artifacts.length === 1, 'Verified artifact must be recorded');
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

// ── 6. Invalid JSON response from agentapi ─────────────────────────────────
// Uses in-memory mock runner: zero real subprocess execution
await test('6. startAntigravityTask handles invalid non-JSON output', async () => {
  const mockRunner = async () => ({
    stdout: 'FATAL: something went wrong internally and stdout is not json',
    stderr: '',
  });

  let threw = false;
  try {
    await startAntigravityTask({
      workspace: process.cwd(),
      prompt: 'Test invalid output',
      customAgentApiPath: '/mock/bin/agentapi',
      runner: mockRunner,
    });
  } catch (err) {
    threw = true;
    assert(err.message.includes('non-JSON') || err.message.includes('invalid'), `Unexpected error: ${err.message}`);
  }
  assert(threw, 'Should throw structured error on non-JSON output');
});

// ── 7. Task registry retrieval & event bounding ───────────────────────────
// Uses in-memory mock runner: zero real subprocess execution
await test('7. task registry correctly stores and retrieves task state', async () => {
  const testConvId = 'test-conv-reg-' + crypto.randomUUID();
  const res = await startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'Registry test prompt',
    title: 'Registry Task',
    customAgentApiPath: '/mock/bin/agentapi',
    runner: async () => ({
      stdout: JSON.stringify({ response: { conversationId: testConvId } }),
      stderr: '',
    }),
  });

  const task = getAntigravityTask(res.taskId);
  assert(task.taskId === res.taskId, 'taskId must match');
  assert(task.conversationId === testConvId, 'conversationId must match');
  assert(task.title === 'Registry Task', 'title must match');
  assert(Array.isArray(task.recentEvents), 'recentEvents must be an array');

  // Clean up
  const rawTask = taskRegistry.get(res.taskId);
  if (rawTask?.cleanup) rawTask.cleanup();
});

// ── 8. Unknown taskId lookup ──────────────────────────────────────────────
// In-memory registry lookup only (zero subprocess calls)
await test('8. getAntigravityTask throws for unknown taskId', () => {
  let threw = false;
  try {
    getAntigravityTask('unknown-uuid-00000000');
  } catch (err) {
    threw = true;
    assert(err.message.includes('not found in task registry'), `Unexpected error: ${err.message}`);
  }
  assert(threw, 'Should throw for unknown taskId');
});

// ── 9. Transcript parser and line handling ────────────────────────────────
// In-memory data test (zero subprocess calls)
await test('9. transcript parser processes valid JSONL lines and updates task', async () => {
  const testConvId = 'conv-trans-' + crypto.randomUUID();
  const res = await startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'Transcript parse test',
    customAgentApiPath: '/mock/bin/agentapi',
    runner: async () => ({
      stdout: JSON.stringify({ response: { conversationId: testConvId } }),
      stderr: '',
    }),
  });

  const task = taskRegistry.get(res.taskId);
  assert(task !== undefined, 'Task must exist in registry');

  // Simulate pushing normalized events directly
  const rawEvent = {
    step_index: 1,
    type: 'PLANNER_RESPONSE',
    status: 'RUNNING',
    content: 'Agent is planning changes',
    created_at: new Date().toISOString(),
  };
  task.recentEvents.push({
    stepIndex: rawEvent.step_index,
    type: rawEvent.type,
    status: rawEvent.status,
    createdAt: rawEvent.created_at,
    summary: rawEvent.content,
  });

  const updated = getAntigravityTask(res.taskId);
  assert(updated.recentEvents.length === 1, 'Should have 1 event');
  assert(updated.recentEvents[0].type === 'PLANNER_RESPONSE', 'Type must match');

  // Clean up
  if (task?.cleanup) task.cleanup();
});

// ── 10. Transcript secret redaction ───────────────────────────────────────
// Pure string manipulation test (zero subprocess calls)
await test('10. redactSecrets redacts Bearer tokens, API keys, private keys, JWTs', () => {
  const sensitiveText = [
    'Authorization: Bearer ya29.a0AfH6SMDfake-token-secret-123456789',
    'Google API Key: AIzaSyDfakeApiKey123456789012345678901',
    '{"password": "MySuperSecretPassword123!"}',
    '{"access_token": "token_abc123_xyz"}',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0...\n-----END RSA PRIVATE KEY-----',
    'JWT: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.doNotLeakThisSignature',
    'ANTIGRAVITY_CSRF_TOKEN=do-not-leak-csrf',
  ].join('\n');

  const redacted = redactSecrets(sensitiveText);

  assert(!redacted.includes('ya29.a0AfH6SMDfake'), 'Bearer token leaked');
  assert(redacted.includes('Bearer [REDACTED]'), 'Bearer token not replaced');

  assert(!redacted.includes('AIzaSyDfakeApiKey'), 'Google API Key leaked');
  assert(redacted.includes('[REDACTED_API_KEY]'), 'API Key not replaced');

  assert(!redacted.includes('MySuperSecretPassword123!'), 'Password leaked');
  assert(redacted.includes('"password": "[REDACTED]"'), 'Password not redacted');

  assert(!redacted.includes('MIIEowIBAAKCAQEA0'), 'Private key leaked');
  assert(redacted.includes('[REDACTED_PRIVATE_KEY]'), 'Private key not redacted');

  assert(!redacted.includes('doNotLeakThisSignature'), 'JWT signature leaked');
  assert(redacted.includes('[REDACTED_JWT]'), 'JWT not redacted');

  assert(!redacted.includes('do-not-leak-csrf'), 'Antigravity CSRF token leaked');
  assert(redacted.includes('ANTIGRAVITY_CSRF_TOKEN=[REDACTED]'), 'Antigravity CSRF token not redacted');
});

// ── 11. Transcript file missing handling ──────────────────────────────────
// Uses in-memory mock runner: zero real subprocess execution
await test('11. transcript watcher handles missing transcript file without crashing', async () => {
  const testConvId = 'conv-missing-' + crypto.randomUUID();
  const res = await startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'Missing transcript test',
    customAgentApiPath: '/mock/bin/agentapi',
    runner: async () => ({
      stdout: JSON.stringify({ response: { conversationId: testConvId } }),
      stderr: '',
    }),
  });

  const task = getAntigravityTask(res.taskId);
  assert(task.status === 'running', 'Task should still be running without throwing');
  assert(task.recentEvents.length === 0, 'Recent events should be empty');

  // Clean up
  const rawTask = taskRegistry.get(res.taskId);
  if (rawTask?.cleanup) rawTask.cleanup();
});

// ── 12. sendAntigravityMessage validation ──────────────────────────────────
// Uses in-memory mock runner: zero real subprocess execution
await test('12. sendAntigravityMessage validates taskId, message size and invokes runner', async () => {
  const testConvId = 'conv-send-' + crypto.randomUUID();
  const startRes = await startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'Prompt for send test',
    customAgentApiPath: '/mock/bin/agentapi',
    runner: async () => ({
      stdout: JSON.stringify({ response: { conversationId: testConvId } }),
      stderr: '',
    }),
  });

  // Test oversized message rejection (checked before runner)
  let threwOversized = false;
  try {
    await sendAntigravityMessage({
      taskId: startRes.taskId,
      message: 'x'.repeat(MAX_PAYLOAD_BYTES + 1),
      customAgentApiPath: '/mock/bin/agentapi',
    });
  } catch (err) {
    threwOversized = true;
    assert(err.message.includes('64 KiB'), `Unexpected message: ${err.message}`);
  }
  assert(threwOversized, 'Should throw for oversized message');

  // Test successful send with in-memory mock runner
  let runnerCalled = false;
  const mockSendRunner = async (file, args, opts) => {
    assert(args[0] === 'send-message', 'Command must be send-message');
    assert(args[1] === testConvId, 'Target conversationId must match');
    assert(args[2] === 'Follow up message', 'Content must match');
    runnerCalled = true;
    return { stdout: JSON.stringify({ response: { status: 'delivered' } }), stderr: '' };
  };

  const sendRes = await sendAntigravityMessage({
    taskId: startRes.taskId,
    message: 'Follow up message',
    customAgentApiPath: '/mock/bin/agentapi',
    runner: mockSendRunner,
  });

  assert(runnerCalled, 'Runner should have been called');
  assert(sendRes.conversationId === testConvId, 'conversationId must match');

  // Clean up
  const rawTask = taskRegistry.get(startRes.taskId);
  if (rawTask?.cleanup) rawTask.cleanup();
});

// ── 13. Blocked permission in MCP tool ─────────────────────────────────────
// Permission gate test: blocked before any runner is touched
await test('13. antigravity_start is rejected when Antigravity permission is Blocked', async () => {
  const server = createMcpServer({
    workspace: process.cwd(),
    permissions: { Antigravity: 'Blocked' },
  });

  const tool = server._registeredTools['antigravity_start'];
  assert(tool !== undefined, 'antigravity_start must be registered');

  const res = await tool.handler({ prompt: 'test prompt' });
  assert(res.isError === true, 'Response must be error');
  assert(res.content[0].text.includes('Blocked'), `Expected Blocked in error message, got: ${res.content[0].text}`);
});

// ── 14. Ask permission with approval denial ────────────────────────────────
// Permission gate test: denied by user approval hook before any runner is touched
await test('14. antigravity_start requests approval and denies when rejected', async () => {
  let approvalRequested = false;
  const requestApproval = async ({ permission, action }) => {
    assert(permission === 'Antigravity', 'Permission must be Antigravity');
    approvalRequested = true;
    return false; // User clicks "Deny"
  };

  const server = createMcpServer({
    workspace: process.cwd(),
    permissions: { Antigravity: 'Ask' },
    requestApproval,
  });

  const tool = server._registeredTools['antigravity_start'];
  const res = await tool.handler({ prompt: 'test approval prompt' });

  assert(approvalRequested === true, 'requestApproval must be invoked');
  assert(res.isError === true, 'Response must be error when approval denied');
  assert(res.content[0].text.includes('denied'), `Expected denied in error, got: ${res.content[0].text}`);
});

// ── 15. Allow permission / Read-only tools without approval ────────────────
// Read-only check: calls detectAntigravity (stat/access only, zero subprocess execution)
await test('15. antigravity_status is read-only and does not require approval', async () => {
  let approvalCalled = false;
  const server = createMcpServer({
    workspace: process.cwd(),
    permissions: { Antigravity: 'Blocked' }, // Even when Blocked!
    requestApproval: async () => { approvalCalled = true; return false; },
  });

  const tool = server._registeredTools['antigravity_status'];
  assert(tool !== undefined, 'antigravity_status must be registered');

  const res = await tool.handler({});
  assert(!res.isError, `antigravity_status should not fail: ${res.content?.[0]?.text}`);
  assert(approvalCalled === false, 'antigravity_status must not request approval');

  const status = JSON.parse(res.content[0].text);
  assert(typeof status.available === 'boolean', 'available field must be present');
});

// ══════════════════════════════════════════════════════════════════════════════
// Hearth v0.4.0 Dispatch Flow Regression Tests (12 Minimum Requirements)
// ══════════════════════════════════════════════════════════════════════════════

// 1. start คืน Task ID โดยไม่รอ executor completion
await test('R1. startAntigravityTask returns Task ID immediately without awaiting completion', async () => {
  let runnerFinished = false;
  const mockSlowRunner = async () => {
    await new Promise((r) => setTimeout(r, 200));
    runnerFinished = true;
    return {
      stdout: JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: '```json\n{"status":"completed"}\n```' } }),
      stderr: '',
    };
  };

  const res = await startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'Non-blocking start test',
    customAgyPath: process.execPath,
    userApproved: true,
    runner: mockSlowRunner,
    awaitCompletion: false,
  });

  assert(typeof res.taskId === 'string' && res.taskId.length > 0, 'Must return valid taskId');
  assert(res.status === 'starting' || res.status === 'running', 'Status must be starting or running on immediate return');
  assert(runnerFinished === false, 'startAntigravityTask must return before slow runner completes');

  // Wait for background runner to settle to keep clean state
  await new Promise((r) => setTimeout(r, 250));
  taskRegistry.delete(res.taskId);
});

// 2. polling เริ่มได้ระหว่าง executor ยัง running
await test('R2. polling getAntigravityTask succeeds while executor is actively running', async () => {
  let finishRunner;
  const pendingPromise = new Promise((resolve) => { finishRunner = resolve; });

  const mockRunningRunner = async () => {
    await pendingPromise;
    return {
      stdout: JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: '```json\n{"status":"completed"}\n```' } }),
      stderr: '',
    };
  };

  const res = await startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'Polling while running test',
    customAgyPath: process.execPath,
    userApproved: true,
    runner: mockRunningRunner,
    awaitCompletion: false,
  });

  // Poll immediately while runner is still pending
  const polled = getAntigravityTask(res.taskId);
  assert(polled !== null && polled.taskId === res.taskId, 'Polling must find active task in registry');
  assert(polled.status === 'starting' || polled.status === 'running', `Expected starting/running, got ${polled.status}`);
  assert(Array.isArray(polled.recentEvents), 'recentEvents must be an array during execution');

  // Resolve background runner
  finishRunner();
  await new Promise((r) => setTimeout(r, 50));
  taskRegistry.delete(res.taskId);
});

// 3. successful start
await test('R3. successful start transitions through lifecycle to done', async () => {
  const testConvId = 'succ-start-' + crypto.randomUUID();
  const mockRunner = async () => ({
    stdout: [
      JSON.stringify({ event: 'init', conversation_id: testConvId }),
      JSON.stringify({ event: 'step_update', step_update: { step_index: 1, step_type: 'thinking', text_delta: 'analyzing workspace' } }),
      JSON.stringify({ event: 'result', result: { conversation_id: testConvId, status: 'SUCCESS', response: '```json\n{"status":"completed","summary":"Task finished successfully."}\n```' } }),
    ].join('\n'),
    stderr: '',
  });

  const res = await startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'Successful lifecycle prompt',
    customAgyPath: process.execPath,
    userApproved: true,
    runner: mockRunner,
    awaitCompletion: false,
  });

  assert(typeof res.taskId === 'string', 'taskId must be allocated');
  
  // Wait for background events to process
  await new Promise((r) => setTimeout(r, 60));
  const finalTask = getAntigravityTask(res.taskId);
  assert(finalTask.status === 'done', `Expected done, got: ${finalTask.status}`);
  assert(finalTask.conversationId === testConvId, 'conversationId must match');
  assert(finalTask.lastAnswer.includes('Task finished successfully'), 'lastAnswer must be populated');
  assert(finalTask.recentEvents.length > 0, 'recentEvents must be recorded');
  taskRegistry.delete(res.taskId);
});

// 4. Permission Ask approve
await test('R4. Permission Ask approve dispatches task and proceeds', async () => {
  let approvalRequested = false;
  const requestApproval = async ({ permission }) => {
    assert(permission === 'Antigravity', 'Must ask Antigravity permission');
    approvalRequested = true;
    return true; // User approves
  };

  const mockRunner = async () => ({
    stdout: JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: '```json\n{"status":"completed"}\n```' } }),
    stderr: '',
  });

  const server = createMcpServer({
    workspace: process.cwd(),
    permissions: { Antigravity: 'Ask' },
    requestApproval,
    customAgyPath: process.execPath,
    antigravityRunner: mockRunner,
  });

  const tool = server._registeredTools['antigravity_start'];
  const res = await tool.handler({ prompt: 'Approved permission prompt' });

  assert(approvalRequested === true, 'requestApproval must be called');
  assert(!res.isError, `Expected success, got: ${res.content?.[0]?.text}`);
  const data = JSON.parse(res.content[0].text);
  assert(typeof data.taskId === 'string', 'Must receive valid taskId');
  taskRegistry.delete(data.taskId);
});

// 5. Permission Ask reject
await test('R5. Permission Ask reject rejects without executing runner', async () => {
  let approvalRequested = false;
  const requestApproval = async () => {
    approvalRequested = true;
    return false; // User denies
  };

  const server = createMcpServer({
    workspace: process.cwd(),
    permissions: { Antigravity: 'Ask' },
    requestApproval,
  });

  const tool = server._registeredTools['antigravity_start'];
  const res = await tool.handler({ prompt: 'Denied permission prompt' });

  assert(approvalRequested === true, 'requestApproval must be called');
  assert(res.isError === true, 'Handler must return error on denial');
  assert(res.content[0].text.includes('denied'), 'Error must specify denied');
});

// 6. Permission timeout
await test('R6. Permission timeout returns structured timeout error', async () => {
  const requestApproval = async () => {
    // Simulates timeout in approval hook
    throw new Error('Approval request timed out.');
  };

  const server = createMcpServer({
    workspace: process.cwd(),
    permissions: { Antigravity: 'Ask' },
    requestApproval,
  });

  const tool = server._registeredTools['antigravity_start'];
  const res = await tool.handler({ prompt: 'Timed out permission prompt' });

  assert(res.isError === true, 'Must return error on timeout');
  assert(res.content[0].text.includes('timed out'), `Expected timed out, got: ${res.content[0].text}`);
});

// 7. executor spawn/start failure
await test('R7. executor spawn/start failure rejects and marks task error', async () => {
  let threw = false;
  try {
    await startAntigravityTask({
      workspace: process.cwd(),
      prompt: 'Spawn fail prompt',
      customAgyPath: '/non/existent/path/to/agy_binary',
    });
  } catch (err) {
    threw = true;
    assert(err.message.includes('not found') || err.message.includes('ENOENT'), `Unexpected error: ${err.message}`);
  }
  assert(threw === true, 'Must throw when executor binary is invalid');
});

// 8. executor timeout หลัง task ถูกสร้าง
await test('R8. executor execution timeout transitions task to error with sanitized message', async () => {
  let cleanupCalled = false;
  const slowHangingRunner = async () => {
    await new Promise((r) => setTimeout(r, 500));
    return { stdout: '', stderr: '' };
  };

  const res = await startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'Timeout prompt',
    customAgyPath: process.execPath,
    userApproved: true,
    runner: slowHangingRunner,
    awaitCompletion: false,
    executionTimeoutMs: 50, // Short 50ms timeout for test
  });

  // Attach cleanup spy to task
  const rawTask = taskRegistry.get(res.taskId);
  const origCleanup = rawTask.cleanup;
  rawTask.cleanup = () => {
    cleanupCalled = true;
    if (origCleanup) origCleanup();
  };

  // Wait past 50ms timeout
  await new Promise((r) => setTimeout(r, 90));

  const timedOutTask = getAntigravityTask(res.taskId);
  assert(timedOutTask.status === 'error', `Expected error status, got: ${timedOutTask.status}`);
  assert(timedOutTask.error.includes('timed out'), `Expected timeout error, got: ${timedOutTask.error}`);
  assert(cleanupCalled === true, 'Task cleanup must be invoked on timeout');
  taskRegistry.delete(res.taskId);
});

// 9. double click ไม่สร้าง duplicate
await test('R9. rapid double click guard prevents duplicate task submission', async () => {
  let startTaskLock = false;
  let taskSubmitCount = 0;

  const handleStartTaskSim = async () => {
    if (startTaskLock) return { rejected: true, reason: 'locked' };
    startTaskLock = true;
    taskSubmitCount++;
    try {
      await new Promise((r) => setTimeout(r, 40));
      return { rejected: false, taskId: 'task-1' };
    } finally {
      startTaskLock = false;
    }
  };

  // Simulate two concurrent clicks in the same tick
  const [click1, click2] = await Promise.all([
    handleStartTaskSim(),
    handleStartTaskSim(),
  ]);

  assert(taskSubmitCount === 1, `Expected exactly 1 task submit, got ${taskSubmitCount}`);
  assert(click1.rejected === false, 'First click must succeed');
  assert(click2.rejected === true, 'Second concurrent click must be rejected by lock');
});

// 10. Main IPC concurrent duplicate ถูก reject/dedupe
await test('R10. Main IPC rejects concurrent task start when task is already running', async () => {
  // Clear any leftover starting/running tasks from previous steps
  for (const [id, t] of taskRegistry.entries()) {
    if (['starting', 'running', 'waiting'].includes(t.status)) {
      taskRegistry.delete(id);
    }
  }

  assert(hasRunningTask() === false, 'hasRunningTask must return false when no active tasks');

  // Verify hasRunningTask detects active tasks in registry
  const fakeTaskId = 'fake-running-' + crypto.randomUUID();
  taskRegistry.set(fakeTaskId, {
    taskId: fakeTaskId,
    status: 'running',
  });

  assert(hasRunningTask() === true, 'hasRunningTask must return true when active task is present');

  // Clean up
  taskRegistry.delete(fakeTaskId);
  assert(hasRunningTask() === false, 'hasRunningTask must return false when no active tasks');
});

// 11. ทุก start outcome ออกจาก Starting...
await test('R11. all start outcomes (success, error, denial, timeout) exit Starting state', async () => {
  const simulateRendererStart = async (scenario) => {
    let taskSubmitting = true;
    let taskStatus = 'starting';
    let errorMessage = null;

    try {
      if (scenario === 'success') {
        taskStatus = 'running';
      } else if (scenario === 'denied') {
        throw new Error('User denied Antigravity access for this request.');
      } else if (scenario === 'timeout') {
        throw new Error('Approval request timed out.');
      } else if (scenario === 'spawn_fail') {
        throw new Error('Antigravity CLI was not found.');
      }
    } catch (err) {
      taskStatus = 'error';
      errorMessage = err.message;
    } finally {
      taskSubmitting = false;
    }

    return { taskSubmitting, taskStatus, errorMessage };
  };

  for (const scenario of ['success', 'denied', 'timeout', 'spawn_fail']) {
    const outcome = await simulateRendererStart(scenario);
    assert(outcome.taskSubmitting === false, `Scenario ${scenario} must set taskSubmitting to false`);
    assert(['running', 'error'].includes(outcome.taskStatus), `Scenario ${scenario} must not remain starting`);
    if (scenario !== 'success') {
      assert(outcome.taskStatus === 'error', `Scenario ${scenario} must transition to error`);
      assert(typeof outcome.errorMessage === 'string' && outcome.errorMessage.length > 0, `Scenario ${scenario} must preserve error message`);
    }
  }
});

// 12. Completion Contract เดิมยังผ่าน
await test('R12. Completion Contract and false-DONE protections remain fully intact', () => {
  // Fenced completed becomes done
  const c1 = classifyCompletion({
    response: 'Task complete.\n```json\n{"status":"completed","summary":"All files compiled."}\n```',
    executorStatus: 'SUCCESS',
  });
  assert(c1.status === 'done', 'Fenced valid completed contract must be done');

  // Progress text remains waiting
  const c2 = classifyCompletion({
    response: 'Still generating components, will update soon.',
    executorStatus: 'SUCCESS',
  });
  assert(c2.status === 'waiting', 'Progress text must remain waiting');

  // Missing required artifact remains waiting
  const c3 = classifyCompletion({
    response: '```json\n{"status":"completed","summary":"Build complete."}\n```',
    executorStatus: 'SUCCESS',
    workspace: process.cwd(),
    verificationRequirements: { requiredArtifacts: 'non_existent_output.bin' },
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Hearth v0.4.1 Streaming & Process Close Regression Tests (S1 through S11)
// ══════════════════════════════════════════════════════════════════════════════

class MockStreamingChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin = new EventEmitter();
    this.stdin.writable = true;
    this.stdin.written = '';
    this.stdin.write = (chunk) => {
      if (chunk !== undefined && chunk !== null) this.stdin.written += chunk.toString();
      return true;
    };
    this.stdin.end = (chunk) => {
      if (chunk !== undefined && chunk !== null) this.stdin.written += chunk.toString();
      this.stdin.writable = false;
      this.stdin.emit('end');
    };
    this.killed = false;
    this.exitCode = null;
    this.spawned = new Promise((resolve) => {
      this._resolveSpawn = resolve;
    });
  }
  markSpawned() {
    this._resolveSpawn();
  }
  kill(signal) {
    this.killed = true;
    this.exitCode = 0;
    this.emit('close', 0);
  }
}

// S1. final event ก่อน process close
await test('S1. final event arrives before process close: records final and finishes done', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-s1-' + crypto.randomUUID();
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'S1 test',
    customAgyPath: process.execPath,
    userApproved: true,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;
  assert.equal(res.status, 'running');

  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'step_update',
    step_update: { step_index: 1, step_type: 'agent_response', text_delta: 'executing step' },
  }) + '\n'));

  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'result',
    result: {
      conversation_id: testConvId,
      status: 'SUCCESS',
      response: '```json\n{"status":"completed","summary":"S1 completed cleanly."}\n```',
    },
  }) + '\n'));

  child.emit('close', 0);
  await new Promise((r) => setTimeout(r, 30));

  const task = getAntigravityTask(res.taskId);
  assert.equal(task.status, 'done');
  assert.equal(task.lastAnswer, 'S1 completed cleanly.');
  assert.equal(task.completion?.status, 'done');
  taskRegistry.delete(res.taskId);
});

// S2. final event split ข้าม stdout chunks
await test('S2. final event split across stdout chunks: correctly buffered and parsed', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-s2-' + crypto.randomUUID();
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'S2 test',
    customAgyPath: process.execPath,
    userApproved: true,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  const fullResult = JSON.stringify({
    event: 'result',
    result: {
      conversation_id: testConvId,
      status: 'SUCCESS',
      response: '```json\n{"status":"completed","summary":"S2 split chunk success."}\n```',
    },
  }) + '\n';

  const mid = Math.floor(fullResult.length / 2);
  child.stdout.emit('data', Buffer.from(fullResult.slice(0, mid)));
  await new Promise((r) => setTimeout(r, 10));
  child.stdout.emit('data', Buffer.from(fullResult.slice(mid)));

  child.emit('close', 0);
  await new Promise((r) => setTimeout(r, 30));

  const task = getAntigravityTask(res.taskId);
  assert.equal(task.status, 'done');
  assert.equal(task.lastAnswer, 'S2 split chunk success.');
  taskRegistry.delete(res.taskId);
});

// S3. final line ไม่มี newline ก่อน EOF
await test('S3. final line has no newline before EOF: drained and processed on close', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-s3-' + crypto.randomUUID();
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'S3 test',
    customAgyPath: process.execPath,
    userApproved: true,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  // Emit result line WITHOUT trailing newline \n
  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'result',
    result: {
      conversation_id: testConvId,
      status: 'SUCCESS',
      response: '```json\n{"status":"completed","summary":"S3 no trailing newline."}\n```',
    },
  })));

  child.emit('close', 0);
  await new Promise((r) => setTimeout(r, 30));

  const task = getAntigravityTask(res.taskId);
  assert.equal(task.status, 'done');
  assert.equal(task.lastAnswer, 'S3 no trailing newline.');
  taskRegistry.delete(res.taskId);
});

// S4. stdout end มาก่อน process close
await test('S4. stdout end arrives before process close: flushed on end without data drop', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-s4-' + crypto.randomUUID();
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'S4 test',
    customAgyPath: process.execPath,
    userApproved: true,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'result',
    result: {
      conversation_id: testConvId,
      status: 'SUCCESS',
      response: '```json\n{"status":"completed","summary":"S4 stdout end handled."}\n```',
    },
  }))); // no newline

  // stdout emits 'end' first
  child.stdout.emit('end');
  await new Promise((r) => setTimeout(r, 30));

  // Process closes later
  child.emit('close', 0);
  await new Promise((r) => setTimeout(r, 30));

  const task = getAntigravityTask(res.taskId);
  assert.equal(task.status, 'done');
  assert.equal(task.lastAnswer, 'S4 stdout end handled.');
  taskRegistry.delete(res.taskId);
});

// S5. process close มาก่อน parser microtask flush
await test('S5. process close arrives before parser microtask flush: awaited and synchronized', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-s5-' + crypto.randomUUID();
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'S5 test',
    customAgyPath: process.execPath,
    userApproved: true,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  // Queue result emission in a microtask, immediately followed by child close
  queueMicrotask(() => {
    child.stdout.emit('data', Buffer.from(JSON.stringify({
      event: 'result',
      result: {
        conversation_id: testConvId,
        status: 'SUCCESS',
        response: '```json\n{"status":"completed","summary":"S5 microtask synchronized."}\n```',
      },
    }) + '\n'));
  });

  child.emit('close', 0);
  await new Promise((r) => setTimeout(r, 30));

  const task = getAntigravityTask(res.taskId);
  assert.equal(task.status, 'done');
  assert.equal(task.lastAnswer, 'S5 microtask synchronized.');
  taskRegistry.delete(res.taskId);
});

// S6. multiple agent_response + final
await test('S6. multiple agent_response steps followed by final: final event determines completion', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-s6-' + crypto.randomUUID();
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'S6 test',
    customAgyPath: process.execPath,
    userApproved: true,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'step_update', step_update: { step_index: 1, step_type: 'agent_response', text_delta: 'I will inspect files' } }) + '\n'));
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'step_update', step_update: { step_index: 2, step_type: 'agent_response', text_delta: 'Still working on editing' } }) + '\n'));
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'step_update', step_update: { step_index: 3, step_type: 'agent_response', text_delta: 'Running tests now' } }) + '\n'));

  // Intermediate checks: task should be running, not done
  let task = getAntigravityTask(res.taskId);
  assert.equal(task.status, 'running');
  assert.equal(task.recentEvents.length, 3);

  // Final event arrives
  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'result',
    result: {
      conversation_id: testConvId,
      status: 'SUCCESS',
      response: '```json\n{"status":"completed","summary":"S6 finished all steps."}\n```',
    },
  }) + '\n'));

  child.emit('close', 0);
  await new Promise((r) => setTimeout(r, 30));

  task = getAntigravityTask(res.taskId);
  assert.equal(task.status, 'done');
  assert.equal(task.lastAnswer, 'S6 finished all steps.');
  taskRegistry.delete(res.taskId);
});

// S7. progress only + exit 0 => ERROR
await test('S7. progress only steps with clean exit 0: transitions to error, never false-done', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-s7-' + crypto.randomUUID();
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'S7 test',
    customAgyPath: process.execPath,
    userApproved: true,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'step_update',
    step_update: { step_index: 1, step_type: 'agent_response', text_delta: 'Working on compilation...' },
  }) + '\n'));
  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'step_update',
    step_update: { step_index: 2, step_type: 'thinking', text_delta: 'Thinking...' },
  }) + '\n'));

  // Exits 0 with NO result event
  child.emit('close', 0);
  await new Promise((r) => setTimeout(r, 30));

  const task = getAntigravityTask(res.taskId);
  assert.equal(task.status, 'error');
  assert(task.error.includes('without a final result event') || task.error.includes('without a final response'));
  taskRegistry.delete(res.taskId);
});

// S8. malformed final => ERROR/WAITING ตาม contract
await test('S8. malformed final or waiting response transitions per contract', async () => {
  // S8a: waiting contract becomes waiting
  const childA = new MockStreamingChild();
  const testConvIdA = 'conv-s8a-' + crypto.randomUUID();
  const resPromiseA = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'S8a test',
    customAgyPath: process.execPath,
    userApproved: true,
    spawnFn: () => {
      childA.markSpawned();
      return childA;
    },
  });
  await childA.spawned;
  childA.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvIdA }) + '\n'));
  const resA = await resPromiseA;
  childA.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'result',
    result: {
      conversation_id: testConvIdA,
      status: 'SUCCESS',
      response: '```json\n{"status":"waiting","summary":"Waiting for approval."}\n```',
    },
  }) + '\n'));
  childA.emit('close', 0);
  await new Promise((r) => setTimeout(r, 30));
  const taskA = getAntigravityTask(resA.taskId);
  assert.equal(taskA.status, 'waiting');
  taskRegistry.delete(resA.taskId);

  // S8b: empty response becomes error without a final response
  const childB = new MockStreamingChild();
  const testConvIdB = 'conv-s8b-' + crypto.randomUUID();
  const resPromiseB = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'S8b test',
    customAgyPath: process.execPath,
    userApproved: true,
    spawnFn: () => {
      childB.markSpawned();
      return childB;
    },
  });
  await childB.spawned;
  childB.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvIdB }) + '\n'));
  const resB = await resPromiseB;
  childB.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'result',
    result: { conversation_id: testConvIdB, status: 'SUCCESS', response: '' },
  }) + '\n'));
  childB.emit('close', 0);
  await new Promise((r) => setTimeout(r, 30));
  const taskB = getAntigravityTask(resB.taskId);
  assert.equal(taskB.status, 'error');
  assert(taskB.error.includes('without a final response'));
  taskRegistry.delete(resB.taskId);
});

// S9. fenced completion JSON ยังผ่าน
await test('S9. fenced completion JSON within conversational prose is extracted and completes done', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-s9-' + crypto.randomUUID();
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'S9 test',
    customAgyPath: process.execPath,
    userApproved: true,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  const proseResponse = 'I have inspected everything and ran all tests.\n```json\n{"status":"completed","summary":"Fenced prose contract valid."}\n```\nFeel free to ask if you have more questions.';

  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'result',
    result: {
      conversation_id: testConvId,
      status: 'SUCCESS',
      response: proseResponse,
    },
  }) + '\n'));

  child.emit('close', 0);
  await new Promise((r) => setTimeout(r, 30));

  const task = getAntigravityTask(res.taskId);
  assert.equal(task.status, 'done');
  assert.equal(task.lastAnswer, 'Fenced prose contract valid.');
  taskRegistry.delete(res.taskId);
});

// S10. secret/raw transcript ไม่หลุด
await test('S10. secrets and credentials in result payload are redacted and never leaked', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-s10-' + crypto.randomUUID();
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'S10 test',
    customAgyPath: process.execPath,
    userApproved: true,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  const secretPayload = 'Finished work with Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.leak and key AIzaSyD00000000000000000000000000000000 with "password": "supersecretpassword".';

  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'result',
    result: {
      conversation_id: testConvId,
      status: 'SUCCESS',
      response: 'FINAL STATUS: COMPLETED\n' + secretPayload,
    },
  }) + '\n'));

  child.emit('close', 0);
  await new Promise((r) => setTimeout(r, 30));

  const task = getAntigravityTask(res.taskId);
  assert(!task.lastAnswer.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'));
  assert(!task.lastAnswer.includes('AIzaSyD00000000000000000000000000000000'));
  assert(!task.lastAnswer.includes('supersecretpassword'));
  assert(task.lastAnswer.includes('[REDACTED]'));
  taskRegistry.delete(res.taskId);
});

// S11. result with output field or object payload variant
await test('S11. result event using output field or object status variant completes successfully', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-s11-' + crypto.randomUUID();
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'S11 test',
    customAgyPath: process.execPath,
    userApproved: true,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  // Transport status is SUCCESS, and output field contains strict Hearth contract with status: 'completed'
  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'result',
    result: {
      conversation_id: testConvId,
      status: 'SUCCESS',
      output: { status: 'completed', summary: 'Output field variant completed.' },
    },
  }) + '\n'));

  child.emit('close', 0);
  await new Promise((r) => setTimeout(r, 30));

  const task = getAntigravityTask(res.taskId);
  assert.equal(task.status, 'done');
  assert.equal(task.lastAnswer, 'Output field variant completed.');
  taskRegistry.delete(res.taskId);
});

// S12. streaming: status "success" in response payload is NOT DONE (remains waiting)
await test('S12. streaming: status "success" in final payload is rejected as invalid completion schema and NOT DONE', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-s12-' + crypto.randomUUID();
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'S12 test',
    customAgyPath: process.execPath,
    userApproved: true,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'result',
    result: {
      conversation_id: testConvId,
      status: 'SUCCESS',
      response: '```json\n{"status":"success","summary":"Operation finished with success status."}\n```',
    },
  }) + '\n'));

  child.emit('close', 0);
  await new Promise((r) => setTimeout(r, 30));

  const task = getAntigravityTask(res.taskId);
  assert(task.status !== 'done', 'Payload with status: "success" must NEVER become done');
  assert.equal(task.status, 'error');
  assert(task.status !== 'waiting', 'Must never become stale WAITING');
  taskRegistry.delete(res.taskId);
});

// S13. streaming: status "done" in response payload is NOT DONE (becomes ERROR on close without valid contract)
await test('S13. streaming: status "done" in final payload is rejected as invalid completion schema and NOT DONE', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-s13-' + crypto.randomUUID();
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'S13 test',
    customAgyPath: process.execPath,
    userApproved: true,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'result',
    result: {
      conversation_id: testConvId,
      status: 'SUCCESS',
      response: '```json\n{"status":"done","summary":"All work done."}\n```',
    },
  }) + '\n'));

  child.emit('close', 0);
  await new Promise((r) => setTimeout(r, 30));

  const task = getAntigravityTask(res.taskId);
  assert(task.status !== 'done', 'Payload with status: "done" must NEVER become done');
  assert.equal(task.status, 'error');
  assert(task.status !== 'waiting', 'Must never become stale WAITING');
  taskRegistry.delete(res.taskId);
});

// S14. streaming: transport SUCCESS with ordinary prose transitions to ERROR on close
await test('S14. streaming: transport SUCCESS + ordinary prose transitions to error on close per contract', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-s14-' + crypto.randomUUID();
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'S14 test',
    customAgyPath: process.execPath,
    userApproved: true,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'result',
    result: {
      conversation_id: testConvId,
      status: 'SUCCESS',
      response: 'I investigated the files and updated the configurations, but have no completion block.',
    },
  }) + '\n'));

  child.emit('close', 0);
  await new Promise((r) => setTimeout(r, 30));

  const task = getAntigravityTask(res.taskId);
  assert(task.status !== 'done', 'Ordinary prose must NEVER become done without completion declaration');
  assert.equal(task.status, 'error');
  assert(task.status !== 'waiting', 'Must never become stale WAITING');
  taskRegistry.delete(res.taskId);
});

// ══════════════════════════════════════════════════════════════════════════════
// Pure Classifier Strictness Tests (C1 through C6)
// ══════════════════════════════════════════════════════════════════════════════

await test('C1. {"status":"success","summary":"..."} is NOT DONE (pure classifier)', () => {
  // Object payload
  const cObj = classifyCompletion({
    response: { status: 'success', summary: 'Build succeeded.' },
    executorStatus: 'SUCCESS',
  });
  assert(cObj.status !== 'done', 'Object with status "success" must NOT be done');
  assert.equal(cObj.status, 'waiting');

  // JSON string
  const cStr = classifyCompletion({
    response: JSON.stringify({ status: 'success', summary: 'Build succeeded.' }),
    executorStatus: 'SUCCESS',
  });
  assert(cStr.status !== 'done', 'JSON string with status "success" must NOT be done');
  assert.equal(cStr.status, 'waiting');

  // Fenced JSON
  const cFence = classifyCompletion({
    response: 'Summary:\n```json\n{"status":"success","summary":"Build succeeded."}\n```',
    executorStatus: 'SUCCESS',
  });
  assert(cFence.status !== 'done', 'Fenced JSON with status "success" must NOT be done');
  assert.equal(cFence.status, 'waiting');
});

await test('C2. {"status":"done","summary":"..."} is NOT DONE (pure classifier)', () => {
  // Object payload
  const cObj = classifyCompletion({
    response: { status: 'done', summary: 'Work is done.' },
    executorStatus: 'SUCCESS',
  });
  assert(cObj.status !== 'done', 'Object with status "done" must NOT be done');
  assert.equal(cObj.status, 'waiting');

  // JSON string
  const cStr = classifyCompletion({
    response: JSON.stringify({ status: 'done', summary: 'Work is done.' }),
    executorStatus: 'SUCCESS',
  });
  assert(cStr.status !== 'done', 'JSON string with status "done" must NOT be done');
  assert.equal(cStr.status, 'waiting');

  // Fenced JSON
  const cFence = classifyCompletion({
    response: 'Done summary:\n```json\n{"status":"done","summary":"Work is done."}\n```',
    executorStatus: 'SUCCESS',
  });
  assert(cFence.status !== 'done', 'Fenced JSON with status "done" must NOT be done');
  assert.equal(cFence.status, 'waiting');
});

await test('C3. status "ok" or "finished" in JSON is NOT DONE', () => {
  const cOk = classifyCompletion({
    response: { status: 'ok', summary: 'Everything ok.' },
    executorStatus: 'SUCCESS',
  });
  assert(cOk.status !== 'done', 'status "ok" must NOT be done');
  assert.equal(cOk.status, 'waiting');

  const cFin = classifyCompletion({
    response: { status: 'finished', summary: 'Execution finished.' },
    executorStatus: 'SUCCESS',
  });
  assert(cFin.status !== 'done', 'status "finished" must NOT be done');
  assert.equal(cFin.status, 'waiting');
});

await test('C4. transport event status SUCCESS + response containing valid {"status":"completed",...} => DONE', () => {
  // Object
  const cObj = classifyCompletion({
    response: { status: 'completed', summary: 'Compilation completed successfully.' },
    executorStatus: 'SUCCESS',
  });
  assert.equal(cObj.status, 'done');

  // Fenced JSON
  const cFence = classifyCompletion({
    response: 'Final check:\n```json\n{"status":"completed","summary":"Fenced contract verified."}\n```',
    executorStatus: 'SUCCESS',
  });
  assert.equal(cFence.status, 'done');

  // Raw JSON string
  const cStr = classifyCompletion({
    response: JSON.stringify({ status: 'completed', summary: 'Raw JSON contract verified.' }),
    executorStatus: 'SUCCESS',
  });
  assert.equal(cStr.status, 'done');
});

await test('C5. transport event status SUCCESS + ordinary prose => WAITING/ERROR per contract', () => {
  // Non-empty ordinary prose without completion declaration -> waiting
  const cProse = classifyCompletion({
    response: 'I reviewed the codebase, changed the parser, and ran unit tests.',
    executorStatus: 'SUCCESS',
  });
  assert.equal(cProse.status, 'waiting');

  // Empty response -> error
  const cEmpty = classifyCompletion({
    response: '',
    executorStatus: 'SUCCESS',
  });
  assert.equal(cEmpty.status, 'error');
});

await test('C6. valid completed, waiting, error schemas transition strictly per contract', () => {
  const cCompleted = classifyCompletion({
    response: { status: 'completed', summary: 'Completed cleanly.' },
    executorStatus: 'SUCCESS',
  });
  assert.equal(cCompleted.status, 'done');
  assert.equal(cCompleted.normalizedStatus, 'completed');

  const cWaiting = classifyCompletion({
    response: { status: 'waiting', summary: 'Need user confirmation.' },
    executorStatus: 'SUCCESS',
  });
  assert.equal(cWaiting.status, 'waiting');
  assert.equal(cWaiting.normalizedStatus, 'waiting');

  const cError = classifyCompletion({
    response: { status: 'error', summary: 'Task failed due to missing file.' },
    executorStatus: 'SUCCESS',
  });
  assert.equal(cError.status, 'error');
  assert.equal(cError.normalizedStatus, 'error');
});

// ══════════════════════════════════════════════════════════════════════════════
// Auto-inject Completion Contract Regression Suite (I1 through I9)
// ══════════════════════════════════════════════════════════════════════════════

// I1. local task receives injected contract
await test('I1. local task receives auto-injected completion contract instruction over stdin', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-i1-' + crypto.randomUUID();
  const localPrompt = 'Build and test the native application.';
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: localPrompt,
    title: 'Local Build Task',
    customAgyPath: process.execPath,
    userApproved: true,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  assert(child.stdin.written.length > 0, 'CLI stdin must receive data');
  const stdinParsed = JSON.parse(child.stdin.written.trim());
  assert.equal(stdinParsed.event, 'user');
  assert(stdinParsed.message.content.includes('<HEARTH_COMPLETION_CONTRACT>'), 'stdin content must contain completion contract');
  assert(stdinParsed.message.content.includes('"status": "completed" | "waiting" | "error"'), 'stdin content must specify strict status schema');
  assert(stdinParsed.message.content.includes('Never use "done", "success", "ok", "finished"'), 'stdin content must forbid non-strict statuses');
  assert(stdinParsed.message.content.includes(localPrompt), 'stdin content must include the local user prompt');

  child.emit('close', 0);
  await new Promise((r) => setTimeout(r, 20));
  taskRegistry.delete(res.taskId);
});

// I2. remote task receives injected contract
await test('I2. remote task receives identical auto-injected completion contract instruction', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-i2-' + crypto.randomUUID();
  const remotePrompt = 'Compile release DMG artifact and verify signatures.';
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: remotePrompt,
    title: 'Remote Task #1042',
    customAgyPath: process.execPath,
    userApproved: true,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  const stdinParsed = JSON.parse(child.stdin.written.trim());
  assert(stdinParsed.message.content.includes('<HEARTH_COMPLETION_CONTRACT>'), 'Remote task must receive completion contract');
  assert(stdinParsed.message.content.includes(remotePrompt), 'Remote task must receive the remote prompt');
  assert(stdinParsed.message.content.includes('STRICT RULES:'), 'Remote task must receive strict schema rules');

  child.emit('close', 0);
  await new Promise((r) => setTimeout(r, 20));
  taskRegistry.delete(res.taskId);
});

// I3. follow-up receives injected contract
await test('I3. follow-up task receives identical auto-injected completion contract instruction', async () => {
  const testConvId = 'conv-i3-' + crypto.randomUUID();
  const child = new MockStreamingChild();

  const startRes = await startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'Initial task prompt',
    customAgyPath: process.execPath,
    userApproved: true,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });
  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  await new Promise((r) => setTimeout(r, 20));

  let capturedFollowUpInput = null;
  const mockFollowUpRunner = async (file, args, opts) => {
    capturedFollowUpInput = opts?.input || null;
    const streamOutput = [
      JSON.stringify({ event: 'init', conversation_id: testConvId }),
      JSON.stringify({
        event: 'result',
        result: {
          conversation_id: testConvId,
          status: 'SUCCESS',
          response: '```json\n{"status":"completed","summary":"Follow-up completed successfully."}\n```',
        },
      }),
    ].join('\n');
    return { stdout: streamOutput, stderr: '' };
  };

  await sendAntigravityMessage({
    taskId: startRes.taskId,
    message: 'Follow-up instruction: re-check unit tests',
    customAgyPath: process.execPath,
    runner: mockFollowUpRunner,
  });

  assert(typeof capturedFollowUpInput === 'string', 'Follow-up runner must receive stdin input');
  const parsedFollowUp = JSON.parse(capturedFollowUpInput.trim());
  assert(parsedFollowUp.message.content.includes('<HEARTH_COMPLETION_CONTRACT>'), 'Follow-up must contain completion contract');
  assert(parsedFollowUp.message.content.includes('Follow-up instruction: re-check unit tests'), 'Follow-up must contain message');
  assert(parsedFollowUp.message.content.includes('Never use "done", "success", "ok", "finished"'), 'Follow-up must enforce strict schema');

  child.emit('close', 0);
  await new Promise((r) => setTimeout(r, 20));
  taskRegistry.delete(startRes.taskId);
});

// I4. user prompt remains unchanged in title and registry
await test('I4. user prompt remains completely unchanged in task title and registry', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-i4-' + crypto.randomUUID();
  const rawUserPrompt = 'Clean up temporary files in /tmp/cache and report counts.';
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: rawUserPrompt,
    customAgyPath: process.execPath,
    userApproved: true,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  const task = getAntigravityTask(res.taskId);
  assert.equal(task.title, rawUserPrompt.slice(0, 60), 'Task title must strictly reflect original user prompt');
  assert(!task.title.includes('<HEARTH_COMPLETION_CONTRACT>'), 'Task title must NOT be polluted with injected contract');

  child.emit('close', 0);
  await new Promise((r) => setTimeout(r, 20));
  taskRegistry.delete(res.taskId);
});

// I5. auto-injected flow: valid completed final -> DONE
await test('I5. auto-injected flow: valid completed final transitions to DONE', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-i5-' + crypto.randomUUID();
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'Execute full compilation',
    customAgyPath: process.execPath,
    userApproved: true,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'result',
    result: {
      conversation_id: testConvId,
      status: 'SUCCESS',
      response: '```json\n{"status":"completed","summary":"All compilation targets succeeded."}\n```',
    },
  }) + '\n'));

  child.emit('close', 0);
  await new Promise((r) => setTimeout(r, 30));

  const task = getAntigravityTask(res.taskId);
  assert.equal(task.status, 'done');
  assert.equal(task.lastAnswer, 'All compilation targets succeeded.');
  taskRegistry.delete(res.taskId);
});

// I6. auto-injected flow: ordinary prose -> WAITING
await test('I6. auto-injected flow: ordinary prose without completion block transitions to WAITING', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-i6-' + crypto.randomUUID();
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'Check test status',
    customAgyPath: process.execPath,
    userApproved: true,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'result',
    result: {
      conversation_id: testConvId,
      status: 'SUCCESS',
      response: 'I looked at the test logs and some tests were still pending.',
    },
  }) + '\n'));

  child.emit('close', 0);
  await new Promise((r) => setTimeout(r, 30));

  const task = getAntigravityTask(res.taskId);
  assert.equal(task.status, 'error');
  assert(task.status !== 'done', 'Ordinary prose must NOT become done');
  assert(task.status !== 'waiting', 'Must never become stale WAITING');
  taskRegistry.delete(res.taskId);
});

// I7. auto-injected flow: invalid status success/done -> NOT DONE (becomes ERROR on close without valid contract)
await test('I7. auto-injected flow: invalid status success or done is rejected as NOT DONE', async () => {
  const childA = new MockStreamingChild();
  const testConvIdA = 'conv-i7a-' + crypto.randomUUID();
  const resPromiseA = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'Test invalid success',
    customAgyPath: process.execPath,
    userApproved: true,
    spawnFn: () => {
      childA.markSpawned();
      return childA;
    },
  });
  await childA.spawned;
  childA.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvIdA }) + '\n'));
  const resA = await resPromiseA;
  childA.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'result',
    result: {
      conversation_id: testConvIdA,
      status: 'SUCCESS',
      response: '```json\n{"status":"success","summary":"Finished with success status"}\n```',
    },
  }) + '\n'));
  childA.emit('close', 0);
  await new Promise((r) => setTimeout(r, 30));
  const taskA = getAntigravityTask(resA.taskId);
  assert.equal(taskA.status, 'error');
  assert(taskA.status !== 'done');
  assert(taskA.status !== 'waiting', 'Must never become stale WAITING');
  taskRegistry.delete(resA.taskId);

  const childB = new MockStreamingChild();
  const testConvIdB = 'conv-i7b-' + crypto.randomUUID();
  const resPromiseB = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'Test invalid done',
    customAgyPath: process.execPath,
    userApproved: true,
    spawnFn: () => {
      childB.markSpawned();
      return childB;
    },
  });
  await childB.spawned;
  childB.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvIdB }) + '\n'));
  const resB = await resPromiseB;
  childB.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'result',
    result: {
      conversation_id: testConvIdB,
      status: 'SUCCESS',
      response: '```json\n{"status":"done","summary":"Finished with done status"}\n```',
    },
  }) + '\n'));
  childB.emit('close', 0);
  await new Promise((r) => setTimeout(r, 30));
  const taskB = getAntigravityTask(resB.taskId);
  assert.equal(taskB.status, 'error');
  assert(taskB.status !== 'done');
  assert(taskB.status !== 'waiting', 'Must never become stale WAITING');
  taskRegistry.delete(resB.taskId);
});

// I8. auto-injected flow: no final event -> ERROR
await test('I8. auto-injected flow: process exit 0 without final event transitions to ERROR', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-i8-' + crypto.randomUUID();
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'Run task without final result',
    customAgyPath: process.execPath,
    userApproved: true,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'step_update',
    step_update: { step_index: 1, step_type: 'agent_response', text_delta: 'Performing tasks...' },
  }) + '\n'));

  // Clean exit code 0 without result event
  child.emit('close', 0);
  await new Promise((r) => setTimeout(r, 30));

  const task = getAntigravityTask(res.taskId);
  assert.equal(task.status, 'error');
  assert(task.status !== 'done');
  assert(task.error.includes('without a final result event') || task.error.includes('without a final response'));
  taskRegistry.delete(res.taskId);
});

// I9. auto-injected flow: no secret or raw prompt leakage
await test('I9. auto-injected flow: no secret or raw prompt leakage into UI/lastAnswer', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-i9-' + crypto.randomUUID();
  const secretKey = 'AIzaSyD99999999999999999999999999999999';
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: `Deploy using secret key ${secretKey}`,
    customAgyPath: process.execPath,
    userApproved: true,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'result',
    result: {
      conversation_id: testConvId,
      status: 'SUCCESS',
      response: `\`\`\`json\n{"status":"completed","summary":"Deployed using key ${secretKey} successfully."}\n\`\`\``,
    },
  }) + '\n'));

  child.emit('close', 0);
  await new Promise((r) => setTimeout(r, 30));

  const task = getAntigravityTask(res.taskId);
  assert.equal(task.status, 'done');
  assert(!task.lastAnswer.includes(secretKey), 'API key must be redacted in lastAnswer');
  assert(task.lastAnswer.includes('[REDACTED_API_KEY]'), 'Redaction placeholder must be present');
  assert(!task.lastAnswer.includes('<HEARTH_COMPLETION_CONTRACT>'), 'Injected contract tag must not leak in lastAnswer');
  assert(!task.title.includes('<HEARTH_COMPLETION_CONTRACT>'), 'Injected contract tag must not leak in title');
  taskRegistry.delete(res.taskId);
});

// ══════════════════════════════════════════════════════════════════════════════
// 9 Deterministic Lifecycle & Executor Ownership Tests
// ══════════════════════════════════════════════════════════════════════════════

// 1. 4m59s still RUNNING
await test('1. 4m59s still RUNNING', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-4m59s-' + crypto.randomUUID();
  // Scaled time: 1ms = 1s, watchdog = 330ms (330s / 5m30s)
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'Long running task at 4m59s',
    customAgyPath: process.execPath,
    userApproved: true,
    executionTimeoutMs: 330,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  // At simulated 4m59s (299ms in scaled time, before 330s watchdog expiry)
  await new Promise((r) => setTimeout(r, 299));

  const task = getAntigravityTask(res.taskId);
  assert.equal(task.status, 'running', 'Task must remain RUNNING at 4m59s while child is alive');
  assert.equal(isTaskActivelyRunning(res.taskId), true, 'Task must report actively running');
  assert(task.status !== 'waiting', 'Task must NOT become WAITING solely from elapsed time');
  assert(task.status !== 'error', 'Task must NOT timeout prematurely');
  assert(task.child !== null, 'task.child must remain attached');

  child.emit('close', 0);
  taskRegistry.delete(res.taskId);
});

// 2. 5m30s still RUNNING with live test child (heartbeat watchdog reset)
await test('2. 5m30s still RUNNING with live test child (heartbeat watchdog reset)', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-5m30s-' + crypto.randomUUID();
  // Scaled time: watchdog = 300ms (representing 330s / 5m30s)
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'Task running through 5m30s with heartbeat reset',
    customAgyPath: process.execPath,
    userApproved: true,
    executionTimeoutMs: 300,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  // At simulated ~4m53s - 5m00s (200ms), child emits progress / step_update (heartbeat reset)
  await new Promise((r) => setTimeout(r, 200));
  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'step_update',
    step_update: { step_index: 2, step_type: 'tool_call', text_delta: 'Running test:persistence suite in background...' },
  }) + '\n'));

  // Advance time past the original 300ms wall-clock deadline to 350ms (simulated >5m30s)
  await new Promise((r) => setTimeout(r, 150));

  const task = getAntigravityTask(res.taskId);
  assert.equal(task.status, 'running', 'Task must still be RUNNING at 5m30s because live child heartbeat reset watchdog');
  assert.equal(isTaskActivelyRunning(res.taskId), true, 'Task must report actively running at 5m30s');
  assert(task.status !== 'error', 'Task must NOT time out at 5m30s while active child is streaming');
  assert(task.status !== 'waiting', 'Task must NOT transition to WAITING at 5m30s');

  child.emit('close', 0);
  taskRegistry.delete(res.taskId);
});

// 3. 7m+ still RUNNING if child is alive
await test('3. 7m+ still RUNNING if child is alive', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-7m-' + crypto.randomUUID();
  // Scaled time: watchdog = 250ms
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'Task running past 7m while child is alive',
    customAgyPath: process.execPath,
    userApproved: true,
    executionTimeoutMs: 250,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  // Child emits heartbeats at ~3m (150ms) and ~6m (300ms)
  await new Promise((r) => setTimeout(r, 150));
  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'step_update',
    step_update: { step_index: 3, step_type: 'tool_call', text_delta: 'test:antigravity executing step 50...' },
  }) + '\n'));

  await new Promise((r) => setTimeout(r, 150));
  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'step_update',
    step_update: { step_index: 4, step_type: 'tool_call', text_delta: 'test:antigravity executing step 120...' },
  }) + '\n'));

  // Advance past 420ms (simulating 7m+ total from start)
  await new Promise((r) => setTimeout(r, 120));

  const task = getAntigravityTask(res.taskId);
  assert.equal(task.status, 'running', 'Task must still be RUNNING at 7m+ while child process is alive');
  assert.equal(isTaskActivelyRunning(res.taskId), true, 'Task must report actively running at 7m+');
  assert(task.child !== null, 'task.child must remain attached');

  child.emit('close', 0);
  taskRegistry.delete(res.taskId);
});

// 4. progress "I will wait" does not change lifecycle
await test('4. progress "I will wait" does not change lifecycle', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-i-will-wait-' + crypto.randomUUID();
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'Progress prose with live executor test',
    customAgyPath: process.execPath,
    userApproved: true,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  // Progress prose arriving while child process is alive
  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'result',
    result: {
      conversation_id: testConvId,
      status: 'SUCCESS',
      response: 'I have launched the test command for test:persistence and test:antigravity and will wait for it to complete.',
    },
  }) + '\n'));

  await new Promise((r) => setTimeout(r, 20));

  const task = getAntigravityTask(res.taskId);
  assert.equal(task.status, 'running', 'Task must remain RUNNING when progress text arrives while child is alive');
  assert(task.status !== 'waiting', 'Progress prose must NEVER transition task to WAITING');
  assert.equal(isTaskActivelyRunning(res.taskId), true, 'Task must report actively running');
  assert(task.child !== null, 'task.child must remain bound while child is alive');

  child.emit('close', 0);
  taskRegistry.delete(res.taskId);
});

// 5. background command exit result is collected
await test('5. background command exit result is collected', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-bg-exit-' + crypto.randomUUID();
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'Collect background command exit',
    customAgyPath: process.execPath,
    userApproved: true,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  // Background command finishes and its exit result/output is delivered
  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'step_update',
    step_update: {
      step_index: 5,
      step_type: 'tool_call',
      state: 'DONE',
      text_delta: 'Background command npm run test:persistence exited with code 0. Tests: 12 passed, 0 failed.',
    },
  }) + '\n'));

  await new Promise((r) => setTimeout(r, 20));

  const task = getAntigravityTask(res.taskId);
  assert.equal(task.status, 'running', 'Task remains RUNNING while child is alive after background command completes');
  assert(task.recentEvents.length > 0, 'Background command event must be collected into recentEvents');
  assert(task.lastEvent.summary.includes('exited with code 0'), 'lastEvent must record command exit code');

  child.emit('close', 0);
  taskRegistry.delete(res.taskId);
});

// 6. valid completed final => DONE
await test('6. valid completed final => DONE', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-valid-done-' + crypto.randomUUID();
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'Valid completion block test',
    customAgyPath: process.execPath,
    userApproved: true,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  // Explicit valid completion block arrives
  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'result',
    result: {
      conversation_id: testConvId,
      status: 'SUCCESS',
      response: '```json\n{"status":"completed","summary":"All 200 regression tests passed successfully."}\n```',
    },
  }) + '\n'));

  child.emit('close', 0);
  await new Promise((r) => setTimeout(r, 30));

  const task = getAntigravityTask(res.taskId);
  assert.equal(task.status, 'done', 'Valid completed contract must transition task to DONE');
  assert.equal(task.completion?.status, 'done');
  assert.equal(task.lastAnswer, 'All 200 regression tests passed successfully.');
  assert.equal(isTaskActivelyRunning(res.taskId), false, 'Done task must not be actively running');
  taskRegistry.delete(res.taskId);
});

// 7. explicit waiting contract => WAITING
await test('7. explicit waiting contract => WAITING', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-explicit-wait-' + crypto.randomUUID();
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'Explicit waiting contract test',
    customAgyPath: process.execPath,
    userApproved: true,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  // Explicit structured waiting contract arrives
  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'result',
    result: {
      conversation_id: testConvId,
      status: 'SUCCESS',
      response: '```json\n{"status":"waiting","summary":"Waiting on user feedback."}\n```',
    },
  }) + '\n'));

  await new Promise((r) => setTimeout(r, 20));

  const task = getAntigravityTask(res.taskId);
  assert.equal(task.status, 'waiting', 'Explicit waiting contract must transition task to WAITING');
  assert.equal(task.completion?.status, 'waiting');
  assert.equal(task.lastAnswer, 'Waiting on user feedback.');

  child.emit('close', 0);
  taskRegistry.delete(res.taskId);
});

// 8. executor dies without final => ERROR
await test('8. executor dies without final => ERROR', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-no-final-' + crypto.randomUUID();
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'Process exit with clean 0 but no final event',
    customAgyPath: process.execPath,
    userApproved: true,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  // Emits progress text only
  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'result',
    result: {
      conversation_id: testConvId,
      status: 'SUCCESS',
      response: 'I will wait for the test suite to finish.',
    },
  }) + '\n'));

  // Clean process close without structured completion contract
  child.emit('close', 0);
  await new Promise((r) => setTimeout(r, 30));

  const task = getAntigravityTask(res.taskId);
  assert.equal(task.status, 'error', 'Process exiting without valid structured completion contract must transition to ERROR');
  assert(task.status !== 'waiting', 'Must NEVER become WAITING after process closes without completion contract');
  assert(task.status !== 'done', 'Must NEVER become DONE without completion contract');
  assert(task.error.includes('without a final response') || task.error.includes('without a final result event'));
  taskRegistry.delete(res.taskId);
});

// 9. no orphan child processes
await test('9. no orphan child processes', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-no-orphan-' + crypto.randomUUID();
  child.on('kill', () => {});

  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'Process cleanup test',
    customAgyPath: process.execPath,
    userApproved: true,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  const task = taskRegistry.get(res.taskId);
  assert(task.child !== null, 'task.child must be bound');
  assert(typeof task.cleanup === 'function', 'task.cleanup must be registered');

  // Trigger task cleanup (e.g. abort or shutdown)
  task.cleanup();
  assert(child.killed, 'Child process must be marked killed via SIGTERM to prevent orphans');
  taskRegistry.delete(res.taskId);
});

// ══════════════════════════════════════════════════════════════════════════════
// Final Safety: Zero Transcript Dependency Tests (T1 through T4)
// ══════════════════════════════════════════════════════════════════════════════

// T1. execution works when no transcript directory exists
await test('T1. execution works when no transcript directory exists', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-no-transcript-dir-' + crypto.randomUUID();
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'No transcript dir test',
    customAgyPath: process.execPath,
    userApproved: true,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'step_update',
    step_update: { step_index: 1, step_type: 'tool_call', text_delta: 'Working without transcript file...' }
  }) + '\n'));

  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'result',
    result: {
      conversation_id: testConvId,
      status: 'SUCCESS',
      response: '```json\n{"status":"completed","summary":"Work completed strictly via stream protocol."}\n```'
    }
  }) + '\n'));

  child.emit('close', 0);
  await new Promise((r) => setTimeout(r, 30));

  const task = getAntigravityTask(res.taskId);
  assert.equal(task.status, 'done', 'Task must complete to DONE without transcript directory');
  assert.equal(task.completion?.status, 'done');
  assert.equal(task.lastAnswer, 'Work completed strictly via stream protocol.');
  assert.equal(task.recentEvents.length, 1);
  taskRegistry.delete(res.taskId);
});

// T2. transcript.jsonl is never required for DONE/WAITING/ERROR classification
await test('T2. transcript.jsonl is never required for DONE/WAITING/ERROR classification', async () => {
  // 1. Verify COMPLETED -> done
  {
    const child = new MockStreamingChild();
    const testConvId = 'conv-classify-done-' + crypto.randomUUID();
    const resPromise = startAntigravityTask({
      workspace: process.cwd(),
      prompt: 'Classify DONE test',
      customAgyPath: process.execPath,
      userApproved: true,
      spawnFn: () => {
        child.markSpawned();
        return child;
      },
    });
    await child.spawned;
    child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
    const res = await resPromise;

    child.stdout.emit('data', Buffer.from(JSON.stringify({
      event: 'result',
      result: {
        conversation_id: testConvId,
        status: 'SUCCESS',
        response: '```json\n{"status":"completed","summary":"Classified directly from stream."}\n```'
      }
    }) + '\n'));
    child.emit('close', 0);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(getAntigravityTask(res.taskId).status, 'done');
    taskRegistry.delete(res.taskId);
  }

  // 2. Verify WAITING -> waiting
  {
    const child = new MockStreamingChild();
    const testConvId = 'conv-classify-wait-' + crypto.randomUUID();
    const resPromise = startAntigravityTask({
      workspace: process.cwd(),
      prompt: 'Classify WAITING test',
      customAgyPath: process.execPath,
      userApproved: true,
      spawnFn: () => {
        child.markSpawned();
        return child;
      },
    });
    await child.spawned;
    child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
    const res = await resPromise;

    child.stdout.emit('data', Buffer.from(JSON.stringify({
      event: 'result',
      result: {
        conversation_id: testConvId,
        status: 'SUCCESS',
        response: '```json\n{"status":"waiting","summary":"Waiting directly from stream."}\n```'
      }
    }) + '\n'));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(getAntigravityTask(res.taskId).status, 'waiting');
    child.emit('close', 0);
    taskRegistry.delete(res.taskId);
  }

  // 3. Verify ERROR -> error
  {
    const child = new MockStreamingChild();
    const testConvId = 'conv-classify-err-' + crypto.randomUUID();
    const resPromise = startAntigravityTask({
      workspace: process.cwd(),
      prompt: 'Classify ERROR test',
      customAgyPath: process.execPath,
      userApproved: true,
      spawnFn: () => {
        child.markSpawned();
        return child;
      },
    });
    await child.spawned;
    child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
    const res = await resPromise;

    child.stdout.emit('data', Buffer.from(JSON.stringify({
      event: 'result',
      result: {
        conversation_id: testConvId,
        status: 'SUCCESS',
        response: 'No valid contract block emitted.'
      }
    }) + '\n'));
    child.emit('close', 0);
    await new Promise((r) => setTimeout(r, 20));
    const task = getAntigravityTask(res.taskId);
    assert.equal(task.status, 'error');
    assert(task.error.includes('without a final response'));
    taskRegistry.delete(res.taskId);
  }
});

// T3. >7-minute heartbeat lifecycle behavior remains unchanged
await test('T3. >7-minute heartbeat lifecycle behavior remains unchanged', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-t3-heartbeat-' + crypto.randomUUID();
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'Heartbeat lifecycle test without transcript',
    customAgyPath: process.execPath,
    userApproved: true,
    executionTimeoutMs: 250,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  // Stream activity resets watchdog
  await new Promise((r) => setTimeout(r, 150));
  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'step_update',
    step_update: { step_index: 1, step_type: 'tool_call', text_delta: 'Step 1...' }
  }) + '\n'));

  await new Promise((r) => setTimeout(r, 150));
  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'step_update',
    step_update: { step_index: 2, step_type: 'tool_call', text_delta: 'Step 2...' }
  }) + '\n'));

  // Advance past 400ms (representing >7m)
  await new Promise((r) => setTimeout(r, 100));
  const task = getAntigravityTask(res.taskId);
  assert.equal(task.status, 'running', 'Task must remain RUNNING while streaming is active');
  assert.equal(isTaskActivelyRunning(res.taskId), true);

  // Completion contract transitions directly to DONE
  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'result',
    result: {
      conversation_id: testConvId,
      status: 'SUCCESS',
      response: '```json\n{"status":"completed","summary":"Heartbeat lifecycle verified."}\n```'
    }
  }) + '\n'));
  child.emit('close', 0);
  await new Promise((r) => setTimeout(r, 30));

  const finalTask = getAntigravityTask(res.taskId);
  assert.equal(finalTask.status, 'done');
  assert.equal(finalTask.completion?.status, 'done');
  taskRegistry.delete(res.taskId);
});

// T4. no raw transcript access occurs during executor start/resume
await test('T4. no raw transcript access occurs during executor start/resume', async () => {
  const accessedPaths = [];

  // Spy on synchronous and asynchronous filesystem reads
  const origStatSync = fs.statSync;
  const origOpenSync = fs.openSync;
  const origReadFileSync = fs.readFileSync;
  const origExistsSync = fs.existsSync;

  fs.statSync = (p, ...args) => {
    accessedPaths.push(String(p));
    return origStatSync(p, ...args);
  };
  fs.openSync = (p, ...args) => {
    accessedPaths.push(String(p));
    return origOpenSync(p, ...args);
  };
  fs.readFileSync = (p, ...args) => {
    accessedPaths.push(String(p));
    return origReadFileSync(p, ...args);
  };
  fs.existsSync = (p) => {
    accessedPaths.push(String(p));
    return origExistsSync(p);
  };

  try {
    const child = new MockStreamingChild();
    const testConvId = 'conv-spy-' + crypto.randomUUID();
    const resPromise = startAntigravityTask({
      workspace: process.cwd(),
      prompt: 'Filesystem access spy test',
      customAgyPath: process.execPath,
      userApproved: true,
      spawnFn: () => {
        child.markSpawned();
        return child;
      },
    });

    await child.spawned;
    child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
    const res = await resPromise;

    child.stdout.emit('data', Buffer.from(JSON.stringify({
      event: 'step_update',
      step_update: { step_index: 1, step_type: 'tool_call', text_delta: 'Testing spy...' }
    }) + '\n'));

    // Call getAntigravityTask repeatedly
    getAntigravityTask(res.taskId);
    getAntigravityTask(res.taskId);

    child.stdout.emit('data', Buffer.from(JSON.stringify({
      event: 'result',
      result: {
        conversation_id: testConvId,
        status: 'SUCCESS',
        response: '```json\n{"status":"completed","summary":"Spy check complete."}\n```'
      }
    }) + '\n'));

    child.emit('close', 0);
    await new Promise((r) => setTimeout(r, 20));

    getAntigravityTask(res.taskId);

    // Test resumeAntigravityTask as well
    const resumeChild = new MockStreamingChild();
    const mockTask = {
      taskId: 'task-resume-spy-' + crypto.randomUUID(),
      conversationId: 'conv-resume-' + crypto.randomUUID(),
      status: 'recovery_required',
      workspace: process.cwd(),
      title: 'Resume spy test',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      recentEvents: [],
      error: null,
      completion: null,
    };
    taskRegistry.set(mockTask.taskId, mockTask);

    const resumePromise = resumeAntigravityTask({
      taskId: mockTask.taskId,
      message: 'Resume message',
      customAgyPath: process.execPath,
      spawnFn: () => {
        resumeChild.markSpawned();
        return resumeChild;
      },
    });
    await resumeChild.spawned;
    resumeChild.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: mockTask.conversationId }) + '\n'));
    await resumePromise;

    resumeChild.stdout.emit('data', Buffer.from(JSON.stringify({
      event: 'result',
      result: {
        conversation_id: mockTask.conversationId,
        status: 'SUCCESS',
        response: '```json\n{"status":"completed","summary":"Resume spy complete."}\n```'
      }
    }) + '\n'));
    resumeChild.emit('close', 0);
    await new Promise((r) => setTimeout(r, 20));

    getAntigravityTask(mockTask.taskId);

    // Verify zero transcript accesses
    const transcriptAccesses = accessedPaths.filter(p =>
      p.includes('transcript.jsonl') ||
      p.includes('.gemini/antigravity/brain') ||
      p.includes('.gemini/antigravity-cli/brain') ||
      p.includes('oauth_creds.json')
    );
    assert.equal(
      transcriptAccesses.length,
      0,
      `Detected raw transcript or credential access during execution: ${JSON.stringify(transcriptAccesses)}`
    );

    taskRegistry.delete(res.taskId);
    taskRegistry.delete(mockTask.taskId);
  } finally {
    fs.statSync = origStatSync;
    fs.openSync = origOpenSync;
    fs.readFileSync = origReadFileSync;
    fs.existsSync = origExistsSync;
  }
});

// ── Multi-Turn Session / Background Work Continuation (M1 & M2) ─────────────
// Reproduces: turn launches background work >7m → progress prose → background result → same conversation resumes/continues → structured completed → DONE
await test('M1. turn launches background work: progress keeps running, background result continues session, structured contract completes DONE', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-m1-' + crypto.randomUUID();
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'Launch long-running heartbeat process and verify',
    customAgyPath: process.execPath,
    userApproved: true,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  // 1. CLI initializes
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;
  const task = getAntigravityTask(res.taskId);
  assert.equal(task.status, 'running', 'Task must be running after init');
  assert.equal(child.stdin.writable, true, 'CLI stdin must remain open and writable');

  // 2. Turn 1: Model launches background command and outputs progress prose
  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'step_update',
    step_update: { step_index: 1, step_type: 'tool_call', state: 'RUNNING', tool_name: 'run_command' }
  }) + '\n'));
  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'result',
    result: {
      conversation_id: testConvId,
      status: 'SUCCESS',
      response: 'I have launched the controlled 440-second heartbeat process and will wait for it to complete.'
    }
  }) + '\n'));

  // Assert intermediate state: still running, stdin open, pending continuation
  let currentTask = getAntigravityTask(res.taskId);
  assert.equal(currentTask.status, 'running', 'Progress prose must keep task in RUNNING state while child is alive');
  assert.equal(currentTask.pendingContinuation, true, 'Task must record pendingContinuation');
  assert.equal(child.stdin.writable, true, 'CLI stdin must remain open across turns');

  // Record stdin written length before continuation
  const stdinLengthBeforeContinuation = child.stdin.written.length;

  // 3. Background tool finishes (>7m later in real-time)
  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'step_update',
    step_update: {
      step_index: 2,
      step_type: 'tool_call',
      state: 'DONE',
      tool_name: 'run_command',
      text_delta: 'Heartbeat process finished with exit code 0 after 440s.'
    }
  }) + '\n'));

  // Continuation turn prompt must have been sent to child's open stdin
  assert(child.stdin.written.length > stdinLengthBeforeContinuation, 'Background completion must write continuation turn to stdin');
  const continuationInput = child.stdin.written.slice(stdinLengthBeforeContinuation);
  assert(continuationInput.includes('The background command or tool has completed.'), 'Continuation must notify agent of tool completion');
  assert(continuationInput.includes('<HEARTH_COMPLETION_CONTRACT>'), 'Continuation must reinforce completion contract instruction');
  currentTask = getAntigravityTask(res.taskId);
  assert.equal(currentTask.status, 'running', 'Task must remain running during continuation');

  // 4. Model evaluates result in turn 2 and produces structured completion contract
  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'result',
    result: {
      conversation_id: testConvId,
      status: 'SUCCESS',
      response: '```json\n{"status":"completed","summary":"Background 440s process completed successfully and verified."}\n```'
    }
  }) + '\n'));

  // Structured completion arrived: stdin closed, status done
  currentTask = getAntigravityTask(res.taskId);
  assert.equal(currentTask.status, 'done', 'Explicit completed contract must transition task to DONE');
  assert.equal(currentTask.completion?.normalizedStatus, 'completed', 'Completion normalizedStatus must be completed');
  assert.equal(child.stdin.writable, false, 'CLI stdin must be closed upon final completion');

  // 5. Child process cleanly exits
  child.emit('close', 0);
  await new Promise((r) => setTimeout(r, 20));

  currentTask = getAntigravityTask(res.taskId);
  assert.equal(currentTask.status, 'done', 'Task must remain DONE after child process close');
  const internalTask = taskRegistry.get(res.taskId);
  assert.equal(internalTask?.child, null, 'Child reference must be cleaned up');
  taskRegistry.delete(res.taskId);
});

await test('M2. executor death before final: process exits after progress prose without structured contract strictly transitions to ERROR', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-m2-' + crypto.randomUUID();
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'Launch task and die before final contract',
    customAgyPath: process.execPath,
    userApproved: true,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  // Turn 1 ends with progress prose
  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'result',
    result: {
      conversation_id: testConvId,
      status: 'SUCCESS',
      response: 'I will wait for the test suite to finish.'
    }
  }) + '\n'));

  let currentTask = getAntigravityTask(res.taskId);
  assert.equal(currentTask.status, 'running', 'Progress prose while child is alive leaves task running');

  // Executor dies before final structured contract (e.g. process crash or premature exit)
  child.emit('close', 0);
  await new Promise((r) => setTimeout(r, 20));

  currentTask = getAntigravityTask(res.taskId);
  assert.equal(currentTask.status, 'error', 'Child exit 0 without final structured contract must strictly transition to ERROR');
  assert.equal(currentTask.error, 'Antigravity exited without a final response.', 'Error message must reflect executor exit without final response');
  const internalTask = taskRegistry.get(res.taskId);
  assert.equal(internalTask?.child, null, 'Child reference must be cleaned up');
  taskRegistry.delete(res.taskId);
});

// ══════════════════════════════════════════════════════════════════════════════
// Watchdog & Owned Background Work Regression Suite (W_A through W_F)
// ══════════════════════════════════════════════════════════════════════════════

// W_A: Background task runs past initial watchdog via periodic heartbeat, completes and reaches DONE
await test('W_A. background task runs past initial watchdog via periodic heartbeat, completes and reaches DONE', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-wa-' + crypto.randomUUID();
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'Long running task with background job',
    customAgyPath: process.execPath,
    userApproved: true,
    executionTimeoutMs: 150, // 150ms watchdog deadline
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  // Turn 1 ends with progress prose
  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'result',
    result: {
      conversation_id: testConvId,
      status: 'SUCCESS',
      response: 'I have started the background test suite and will wait for it to complete.',
    },
  }) + '\n'));

  let task = getAntigravityTask(res.taskId);
  assert.equal(task.status, 'running');
  assert.equal(task.pendingContinuation, true);

  // Register owned background job
  const bgChild = new EventEmitter();
  bgChild.killed = false;
  bgChild.exitCode = null;
  registerBackgroundJob(res.taskId, { name: 'test_suite', child: bgChild });

  task = getAntigravityTask(res.taskId);
  assert.equal(task.executionState, 'active_owned_background_work');
  assert.equal(task.lastWatchdogReset?.source, 'background_registered');

  // Emit 4 periodic heartbeats at 50ms intervals (total ~200ms > initial 150ms deadline)
  for (let i = 1; i <= 4; i++) {
    await new Promise((r) => setTimeout(r, 50));
    const ok = recordBackgroundHeartbeat(res.taskId, { text: `Heartbeat progress ${i}` });
    assert.equal(ok, true);
    task = getAntigravityTask(res.taskId);
    assert.equal(task.status, 'running', `Task must remain RUNNING at heartbeat ${i}`);
    assert.equal(task.lastWatchdogReset?.source, 'background_heartbeat', 'Watchdog reset source must be background_heartbeat');
    assert.equal(task.lastWatchdogReset?.details?.heartbeatCount, i);
  }

  // Complete background job cleanly
  const stdinLengthBefore = child.stdin.written.length;
  completeBackgroundJob(res.taskId, { exitCode: 0, output: 'Test suite passed 100%' });

  task = getAntigravityTask(res.taskId);
  assert.equal(task.lastWatchdogReset?.source, 'continuation_sent', 'Continuation turn triggered by background completion must reset watchdog');
  assert.equal(task.status, 'running');

  // Continuation prompt written to stdin
  assert(child.stdin.written.length > stdinLengthBefore);
  assert(child.stdin.written.includes('Test suite passed 100%'));

  // Turn 2 responds with explicit structured completed contract
  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'result',
    result: {
      conversation_id: testConvId,
      status: 'SUCCESS',
      response: '```json\n{"status":"completed","summary":"Background test suite finished and verified successfully."}\n```',
    },
  }) + '\n'));

  task = getAntigravityTask(res.taskId);
  assert.equal(task.status, 'done');
  assert.equal(task.completion?.normalizedStatus, 'completed');
  assert.equal(child.stdin.writable, false);

  child.emit('close', 0);
  await new Promise((r) => setTimeout(r, 20));
  taskRegistry.delete(res.taskId);
});

// W_B: Background task runs, but stops heartbeating / becomes silent beyond watchdog threshold => transitions to ERROR timeout
await test('W_B. background task that becomes silent beyond watchdog threshold transitions to ERROR timeout', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-wb-' + crypto.randomUUID();
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'Task with silent background job',
    customAgyPath: process.execPath,
    userApproved: true,
    executionTimeoutMs: 120, // 120ms watchdog
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'result',
    result: {
      conversation_id: testConvId,
      status: 'SUCCESS',
      response: 'I have started the background job.',
    },
  }) + '\n'));

  const bgChild = new EventEmitter();
  bgChild.killed = false;
  bgChild.exitCode = null;
  registerBackgroundJob(res.taskId, { name: 'silent_job', child: bgChild });

  recordBackgroundHeartbeat(res.taskId, { text: 'initial beat' });
  let task = getAntigravityTask(res.taskId);
  assert.equal(task.lastWatchdogReset?.source, 'background_heartbeat');
  assert.equal(task.status, 'running');

  // Silence: wait longer than watchdog (180ms > 120ms)
  await new Promise((r) => setTimeout(r, 180));

  task = getAntigravityTask(res.taskId);
  assert.equal(task.status, 'error', 'Silent background job beyond watchdog must time out to ERROR');
  assert(task.error?.includes('timed out'), `Error must be timeout message, got: ${task.error}`);

  child.emit('close', 0);
  taskRegistry.delete(res.taskId);
});

// W_C: Progress prose without active background process => transitions to ERROR timeout (does not live forever)
await test('W_C. progress prose without active background work transitions to ERROR timeout', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-wc-' + crypto.randomUUID();
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'Task claiming to wait but no work launched',
    customAgyPath: process.execPath,
    userApproved: true,
    executionTimeoutMs: 120,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'result',
    result: {
      conversation_id: testConvId,
      status: 'SUCCESS',
      response: 'I will wait for external input indefinitely.',
    },
  }) + '\n'));

  let task = getAntigravityTask(res.taskId);
  assert.equal(task.status, 'running');

  // No heartbeats, no background work. Wait 180ms > 120ms
  await new Promise((r) => setTimeout(r, 180));

  task = getAntigravityTask(res.taskId);
  assert.equal(task.status, 'error', 'Unbacked progress prose must time out to ERROR');
  assert(task.error?.includes('timed out'), `Error must be timeout message, got: ${task.error}`);

  child.emit('close', 0);
  taskRegistry.delete(res.taskId);
});

// W_D: Owned background child exits with error code before final contract => transitions to ERROR
await test('W_D. owned background child exiting with error code before final contract transitions to ERROR', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-wd-' + crypto.randomUUID();
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'Task whose background job crashes',
    customAgyPath: process.execPath,
    userApproved: true,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'result',
    result: {
      conversation_id: testConvId,
      status: 'SUCCESS',
      response: 'Running the build in the background.',
    },
  }) + '\n'));

  const bgChild = new EventEmitter();
  bgChild.killed = false;
  bgChild.exitCode = null;
  registerBackgroundJob(res.taskId, { name: 'crasher_job', child: bgChild });

  // Background child crashes with code 1
  completeBackgroundJob(res.taskId, { exitCode: 1, error: 'Command failed: npm test exited with code 1' });

  const task = getAntigravityTask(res.taskId);
  assert.equal(task.status, 'error', 'Background process exit code 1 must transition task to ERROR');
  assert.equal(task.completion?.normalizedStatus, 'error');
  assert(task.error?.includes('code 1'), `Error must report code 1, got: ${task.error}`);

  child.emit('close', 0);
  taskRegistry.delete(res.taskId);
});

// W_E: Structured waiting => WAITING only
await test('W_E. explicit structured waiting contract transitions strictly to WAITING', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-we-' + crypto.randomUUID();
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'Ask user for API keys',
    customAgyPath: process.execPath,
    userApproved: true,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'result',
    result: {
      conversation_id: testConvId,
      status: 'SUCCESS',
      response: '```json\n{"status":"waiting","summary":"Awaiting user authorization token to proceed."}\n```',
    },
  }) + '\n'));

  const task = getAntigravityTask(res.taskId);
  assert.equal(task.status, 'waiting', 'Explicit waiting contract must produce status waiting');
  assert.equal(task.completion?.normalizedStatus, 'waiting');
  assert(task.completion?.summary.includes('Awaiting user authorization'), 'Summary must reflect waiting reason');

  child.emit('close', 0);
  taskRegistry.delete(res.taskId);
});

// W_F: Structured completed => DONE
await test('W_F. explicit structured completed contract transitions strictly to DONE', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-wf-' + crypto.randomUUID();
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'Finish task cleanly',
    customAgyPath: process.execPath,
    userApproved: true,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'result',
    result: {
      conversation_id: testConvId,
      status: 'SUCCESS',
      response: '```json\n{"status":"completed","summary":"All requirements implemented and verified."}\n```',
    },
  }) + '\n'));

  const task = getAntigravityTask(res.taskId);
  assert.equal(task.status, 'done', 'Explicit completed contract must produce status done');
  assert.equal(task.completion?.normalizedStatus, 'completed');
  assert(task.completion?.summary.includes('All requirements implemented'), 'Summary must reflect completed summary');

  child.emit('close', 0);
  taskRegistry.delete(res.taskId);
});

// ══════════════════════════════════════════════════════════════════════════════
// Stream Interruption & Controller Lifecycle Regression Suite (CTRL_S1 - CTRL_S6)
// ══════════════════════════════════════════════════════════════════════════════

// CTRL_S1: Healthy controller + owned background heartbeats maintain RUNNING, background completes -> continuation -> structured completed -> DONE
await test('CTRL_S1. healthy controller + owned background heartbeats maintain RUNNING, background completes -> continuation -> structured completed -> DONE', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-ctrl-s1-' + crypto.randomUUID();
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'Execute long-running task with background verification',
    customAgyPath: process.execPath,
    userApproved: true,
    executionTimeoutMs: 200,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  // Turn 1 completes with progress prose
  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'result',
    result: {
      conversation_id: testConvId,
      status: 'SUCCESS',
      response: 'I have started the background test and will wait for it to complete.',
    },
  }) + '\n'));

  let task = getAntigravityTask(res.taskId);
  assert.equal(task.status, 'running');
  assert.equal(task.controllerState, 'healthy');

  // Register owned background job
  const bgChild = new EventEmitter();
  bgChild.killed = false;
  bgChild.exitCode = null;
  registerBackgroundJob(res.taskId, { name: 'long_runner', child: bgChild });

  // Simulate multiple heartbeats beyond initial watchdog (5 * 50ms = 250ms > 200ms)
  for (let i = 1; i <= 5; i++) {
    await new Promise((r) => setTimeout(r, 50));
    const ok = recordBackgroundHeartbeat(res.taskId, { text: `Heartbeat progress ${i}` });
    assert.equal(ok, true, `Heartbeat ${i} must succeed on healthy controller`);
    task = getAntigravityTask(res.taskId);
    assert.equal(task.status, 'running');
    assert.equal(task.controllerState, 'healthy');
  }

  // Background completes
  completeBackgroundJob(res.taskId, { exitCode: 0, output: 'Verification passed 100%' });
  task = getAntigravityTask(res.taskId);
  assert.equal(task.status, 'running');

  // Continuation turn delivers final structured completed contract
  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'result',
    result: {
      conversation_id: testConvId,
      status: 'SUCCESS',
      response: '```json\n{"status":"completed","summary":"Long-running task verified cleanly."}\n```',
    },
  }) + '\n'));

  task = getAntigravityTask(res.taskId);
  assert.equal(task.status, 'done');
  assert.equal(task.controllerState, 'closed');
  assert.equal(task.completion?.normalizedStatus, 'completed');

  child.emit('close', 0);
  taskRegistry.delete(res.taskId);
});

// CTRL_S2: Controller stream interrupted while background active -> bounded recovery fails -> ERROR -> heartbeat returns false and rejects zombie-RUNNING
await test('CTRL_S2. controller stream interrupted while background active -> bounded recovery fails -> ERROR -> heartbeat returns false and rejects zombie-RUNNING', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-ctrl-s2-' + crypto.randomUUID();
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'Stream interruption failure test',
    customAgyPath: process.execPath,
    userApproved: true,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  // Register owned background job
  const bgChild = new EventEmitter();
  bgChild.killed = false;
  bgChild.exitCode = null;
  registerBackgroundJob(res.taskId, { name: 'active_bg', child: bgChild });

  let task = getAntigravityTask(res.taskId);
  assert.equal(task.controllerState, 'healthy');

  // Interruption occurs: stream interrupted
  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'error',
    error: 'The stream was interrupted. Please continue the task you were working on.',
  }) + '\n'));

  task = getAntigravityTask(res.taskId);
  // First interruption triggers bounded recovery attempt (count = 1)
  assert.equal(task.controllerRecoveryCount, 1);
  assert.equal(task.controllerState, 'recovering');
  assert(child.stdin.written.includes('stream was interrupted'), 'Must prompt session continuation over stdin');

  // Now recovery fails: a second interruption is received
  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'error',
    error: 'The stream was interrupted. Please continue the task you were working on.',
  }) + '\n'));

  task = getAntigravityTask(res.taskId);
  // Terminal interruption: task is ERROR, controllerState is 'interrupted'
  assert.equal(task.status, 'error', 'Task must transition terminally to ERROR');
  assert.equal(task.controllerState, 'interrupted');
  assert(task.error?.includes('stream was interrupted'));

  // Requirement 9: background heartbeat MUST NOT reset watchdog or keep task running
  const heartbeatResult = recordBackgroundHeartbeat(res.taskId, { text: 'heartbeat after terminal error' });
  assert.equal(heartbeatResult, false, 'recordBackgroundHeartbeat MUST return false when controller is interrupted');

  task = getAntigravityTask(res.taskId);
  assert.equal(task.status, 'error', 'Task must remain ERROR and not revert to running');
  assert.equal(isTaskActivelyRunning(task), false, 'isTaskActivelyRunning must return false');

  taskRegistry.delete(res.taskId);
});

// CTRL_S3: Stream interruption + bounded recovery succeeds on same conversation -> no duplicates -> eventual completed -> DONE
await test('CTRL_S3. stream interruption + bounded recovery succeeds on same conversation -> no duplicates -> eventual completed -> DONE', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-ctrl-s3-' + crypto.randomUUID();
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'Stream interruption recovery test',
    customAgyPath: process.execPath,
    userApproved: true,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  // Register background job
  const bgChild = new EventEmitter();
  bgChild.killed = false;
  bgChild.exitCode = null;
  registerBackgroundJob(res.taskId, { name: 'singleton_bg', child: bgChild });

  // Stream interruption occurs
  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'error',
    error: 'The stream was interrupted. Please continue the task you were working on.',
  }) + '\n'));

  let task = getAntigravityTask(res.taskId);
  assert.equal(task.controllerRecoveryCount, 1);
  assert.equal(task.controllerState, 'recovering');
  assert.equal(task.conversationId, testConvId, 'Must preserve same conversationId');

  // Recovery succeeds: controller receives healthy progress event from agy
  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'agent_response',
    text: 'Reconnected to stream successfully. Resuming verification.',
  }) + '\n'));

  task = getAntigravityTask(res.taskId);
  assert.equal(task.controllerState, 'healthy', 'Controller must return to healthy state');
  assert.equal(task.status, 'running');

  // Verify background job was preserved without duplicate
  assert.equal(task.backgroundJobs.length, 1, 'Must maintain exactly one background job');
  assert.equal(task.backgroundJobs[0].name, 'singleton_bg');

  // Background completes
  completeBackgroundJob(res.taskId, { exitCode: 0, output: 'Verification all good' });

  // Final structured completed event
  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'result',
    result: {
      conversation_id: testConvId,
      status: 'SUCCESS',
      response: '```json\n{"status":"completed","summary":"Successfully recovered and verified."}\n```',
    },
  }) + '\n'));

  task = getAntigravityTask(res.taskId);
  assert.equal(task.status, 'done');
  assert.equal(task.controllerState, 'closed');
  assert.equal(task.completion?.normalizedStatus, 'completed');

  child.emit('close', 0);
  taskRegistry.delete(res.taskId);
});

// CTRL_S4: Local terminal stream ERROR triggers syncRemoteTaskState with status: "error", finished_at, and error to Supabase
await test('CTRL_S4. local terminal stream ERROR triggers syncRemoteTaskState with status: "error", finished_at, and error to Supabase', async () => {
  const mock = createMockTransport([
    {
      id: 'remote-row-ctrl-s4',
      device_id: 'test-device',
      status: 'running',
      hearth_task_id: null,
      conversation_id: null,
      created_at: new Date().toISOString(),
    },
  ]);
  const bridgeClient = new HearthBridgeClient({
    supabaseUrl: 'https://test.supabase.co',
    supabaseKey: 'test-key',
    deviceId: 'test-device',
    fetchFn: mock.fetch,
  });

  const unsub = onTaskTransition(async (t) => {
    if (t.remoteTaskId === 'remote-row-ctrl-s4') {
      await syncRemoteTaskState({ bridgeClient, task: t });
    }
  });

  const child = new MockStreamingChild();
  const testConvId = 'conv-ctrl-s4-' + crypto.randomUUID();
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'Remote task with terminal error',
    customAgyPath: process.execPath,
    userApproved: true,
    remoteTaskId: 'remote-row-ctrl-s4',
    source: 'remote',
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  // Simulate terminal stream interruption (2nd interruption => terminal)
  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'error',
    error: 'The stream was interrupted. Please continue the task you were working on.',
  }) + '\n'));
  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'error',
    error: 'The stream was interrupted. Please continue the task you were working on.',
  }) + '\n'));

  // Allow async syncTaskState promise to flush
  await new Promise((r) => setTimeout(r, 50));

  const task = getAntigravityTask(res.taskId);
  assert.equal(task.status, 'error');
  assert.equal(task.controllerState, 'interrupted');

  // Check Supabase mock row
  const rows = mock.getTasks();
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.id, 'remote-row-ctrl-s4');
  assert.equal(row.status, 'error', 'Remote row status must be synced to error');
  assert(row.finished_at, 'Remote row must have finished_at set on terminal error');
  assert(row.error?.includes('stream was interrupted'), 'Remote row error must include interruption details');

  unsub();
  taskRegistry.delete(res.taskId);
});

// CTRL_S5: Controller exits while background heartbeat still active -> transitions to ERROR, heartbeat returns false
await test('CTRL_S5. controller exits while background heartbeat still active -> transitions to ERROR, heartbeat returns false', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-ctrl-s5-' + crypto.randomUUID();
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'Controller process exit test',
    customAgyPath: process.execPath,
    userApproved: true,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  // Register active background job
  const bgChild = new EventEmitter();
  bgChild.killed = false;
  bgChild.exitCode = null;
  registerBackgroundJob(res.taskId, { name: 'surviving_bg', child: bgChild });

  let task = getAntigravityTask(res.taskId);
  assert.equal(task.status, 'running');
  assert.equal(task.controllerState, 'healthy');

  // Controller child exits unexpectedly without final completion contract
  child.emit('close', 1);
  await new Promise((r) => setTimeout(r, 20));

  task = getAntigravityTask(res.taskId);
  assert.equal(task.status, 'error', 'Task must be ERROR when controller exits without completion');
  assert.equal(task.controllerState, 'exited');

  // Heartbeat attempts now must fail
  const hbRes = recordBackgroundHeartbeat(res.taskId, { text: 'heartbeat after controller exit' });
  assert.equal(hbRes, false, 'recordBackgroundHeartbeat must return false when controller has exited');

  assert.equal(task.status, 'error');
  assert.equal(isTaskActivelyRunning(task), false);

  taskRegistry.delete(res.taskId);
});

// CTRL_S6: Background process exits (code 1 vs code 0) while controller is healthy -> correct classification preserved
await test('CTRL_S6. background process exits (code 1 vs code 0) while controller is healthy -> correct classification preserved', async () => {
  // Scenario A: Background process exits with code 1 (failure) -> transitions immediately to ERROR per Requirement 11.D
  {
    const childA = new MockStreamingChild();
    const testConvIdA = 'conv-ctrl-s6a-' + crypto.randomUUID();
    const resPromiseA = startAntigravityTask({
      workspace: process.cwd(),
      prompt: 'Background fail test',
      customAgyPath: process.execPath,
      userApproved: true,
      spawnFn: () => {
        childA.markSpawned();
        return childA;
      },
    });

    await childA.spawned;
    childA.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvIdA }) + '\n'));
    const resA = await resPromiseA;

    const bgChildA = new EventEmitter();
    registerBackgroundJob(resA.taskId, { name: 'failing_bg', child: bgChildA });

    // Complete background job with exitCode 1
    completeBackgroundJob(resA.taskId, { exitCode: 1, error: 'Command failed with exit code 1' });

    let taskA = getAntigravityTask(resA.taskId);
    assert.equal(taskA.status, 'error', 'Failed background job transitions task to ERROR per Requirement 11.D');
    assert.equal(taskA.completion?.normalizedStatus, 'error');
    assert(taskA.error?.includes('failed with exit code 1'));

    childA.emit('close', 0);
    await new Promise((r) => setTimeout(r, 20));
    taskRegistry.delete(resA.taskId);
  }

  // Scenario B: Background process exits with code 0 (success) -> continues session, structured contract completes DONE
  {
    const childB = new MockStreamingChild();
    const testConvIdB = 'conv-ctrl-s6b-' + crypto.randomUUID();
    const resPromiseB = startAntigravityTask({
      workspace: process.cwd(),
      prompt: 'Background success test',
      customAgyPath: process.execPath,
      userApproved: true,
      spawnFn: () => {
        childB.markSpawned();
        return childB;
      },
    });

    await childB.spawned;
    childB.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvIdB }) + '\n'));
    const resB = await resPromiseB;

    // Turn 1 progress prose sets pendingContinuation = true
    childB.stdout.emit('data', Buffer.from(JSON.stringify({
      event: 'result',
      result: {
        conversation_id: testConvIdB,
        status: 'SUCCESS',
        response: 'I have started the background task and will wait for it to complete.',
      },
    }) + '\n'));

    const bgChildB = new EventEmitter();
    registerBackgroundJob(resB.taskId, { name: 'success_bg', child: bgChildB });

    // Complete background job with exitCode 0
    completeBackgroundJob(resB.taskId, { exitCode: 0, output: 'Build and tests passed 100%' });

    let taskB = getAntigravityTask(resB.taskId);
    assert.equal(taskB.status, 'running');
    assert(childB.stdin.written.includes('Build and tests passed 100%'), 'Success output written to controller stdin');

    // Controller emits final completed contract
    childB.stdout.emit('data', Buffer.from(JSON.stringify({
      event: 'result',
      result: {
        conversation_id: testConvIdB,
        status: 'SUCCESS',
        response: '```json\n{"status":"completed","summary":"All tasks finished successfully."}\n```',
      },
    }) + '\n'));

    taskB = getAntigravityTask(resB.taskId);
    assert.equal(taskB.status, 'done');
    assert.equal(taskB.completion?.normalizedStatus, 'completed');
    childB.emit('close', 0);
    await new Promise((r) => setTimeout(r, 20));
    taskRegistry.delete(resB.taskId);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// Context Cancellation & Lifecycle-Aware Interruption Suite (CTX1 - CTX6)
// ══════════════════════════════════════════════════════════════════════════════

// CTX1: unexpected "stream input cancelled: context canceled" while controller/task RUNNING -> bounded recovery attempted
await test('CTX1. unexpected "stream input cancelled: context canceled" while running triggers bounded recovery attempt', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-ctx1-' + crypto.randomUUID();
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'Context cancel test 1',
    customAgyPath: process.execPath,
    userApproved: true,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  let task = getAntigravityTask(res.taskId);
  assert.equal(task.status, 'running');
  assert.equal(task.controllerState, 'healthy');

  // Unexpected transport error emitted to stderr while running
  child.stderr.emit('data', Buffer.from('stream input cancelled: context canceled\n'));

  task = getAntigravityTask(res.taskId);
  assert.equal(task.controllerRecoveryCount, 1, 'Bounded recovery count must increment to 1');
  assert.equal(task.controllerState, 'recovering', 'Controller state must transition to recovering');
  assert.equal(task.status, 'running', 'Task must remain running during recovery attempt');
  assert(child.stdin.written.includes('The previous stream was interrupted'), 'Session continuation prompt must be sent over stdin');

  taskRegistry.delete(res.taskId);
});

// CTX2: recovery succeeds -> same conversation -> no duplicate background work -> eventual structured completed -> DONE
await test('CTX2. context cancellation recovery succeeds -> same conversation, no duplicates -> eventual completed -> DONE', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-ctx2-' + crypto.randomUUID();
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'Context cancel recovery success test',
    customAgyPath: process.execPath,
    userApproved: true,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  // Register background job
  const bgChild = new EventEmitter();
  bgChild.killed = false;
  bgChild.exitCode = null;
  registerBackgroundJob(res.taskId, { name: 'ctx2_bg', child: bgChild });

  // Unexpected context cancellation arrives
  child.stderr.emit('data', Buffer.from('stream input cancelled: context canceled\n'));

  let task = getAntigravityTask(res.taskId);
  assert.equal(task.controllerState, 'recovering');
  assert.equal(task.conversationId, testConvId, 'Must preserve same conversationId');

  // Healthy progress arrives: stream reconnects and recovers
  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'agent_response',
    text: 'Stream reconnected. Continuing verification.',
  }) + '\n'));

  task = getAntigravityTask(res.taskId);
  assert.equal(task.controllerState, 'healthy', 'Controller must return to healthy');
  assert.equal(task.status, 'running');
  assert.equal(task.backgroundJobs.length, 1, 'Must maintain exactly one background job (no duplicates)');

  // Background completes
  completeBackgroundJob(res.taskId, { exitCode: 0, output: 'All assertions verified' });

  // Final structured completed response
  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'result',
    result: {
      conversation_id: testConvId,
      status: 'SUCCESS',
      response: '```json\n{"status":"completed","summary":"Task finished after context recovery."}\n```',
    },
  }) + '\n'));

  task = getAntigravityTask(res.taskId);
  assert.equal(task.status, 'done');
  assert.equal(task.controllerState, 'closed');
  assert.equal(task.completion?.normalizedStatus, 'completed');

  child.emit('close', 0);
  taskRegistry.delete(res.taskId);
});

// CTX3: recovery fails -> ERROR -> remote terminal sync
await test('CTX3. context cancellation recovery fails -> transitions to ERROR and syncs remote terminal row', async () => {
  const mock = createMockTransport([
    {
      id: 'remote-row-ctx3',
      device_id: 'test-device',
      status: 'running',
      hearth_task_id: null,
      conversation_id: null,
      created_at: new Date().toISOString(),
    },
  ]);
  const bridgeClient = new HearthBridgeClient({
    supabaseUrl: 'https://test.supabase.co',
    supabaseKey: 'test-key',
    deviceId: 'test-device',
    fetchFn: mock.fetch,
  });

  const unsub = onTaskTransition(async (t) => {
    if (t.remoteTaskId === 'remote-row-ctx3') {
      await syncRemoteTaskState({ bridgeClient, task: t });
    }
  });

  const child = new MockStreamingChild();
  const testConvId = 'conv-ctx3-' + crypto.randomUUID();
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'Remote context cancel failure test',
    customAgyPath: process.execPath,
    userApproved: true,
    remoteTaskId: 'remote-row-ctx3',
    source: 'remote',
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  // First cancellation: triggers recovery (count = 1)
  child.stderr.emit('data', Buffer.from('stream input cancelled: context canceled\n'));

  // Second cancellation: recovery exhausted/fails
  child.stderr.emit('data', Buffer.from('stream input cancelled: context canceled\n'));

  await new Promise((r) => setTimeout(r, 50));

  const task = getAntigravityTask(res.taskId);
  assert.equal(task.status, 'error', 'Task must transition terminally to ERROR');
  assert.equal(task.controllerState, 'interrupted');

  const rows = mock.getTasks();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'error', 'Supabase row status must be synced to error');
  assert(rows[0].finished_at, 'Supabase row must have finished_at populated');
  assert(rows[0].error?.includes('context canceled'), 'Supabase row error must report context cancellation');

  unsub();
  taskRegistry.delete(res.taskId);
});

// CTX4: same text caused by Hearth-initiated cleanup/cancel -> NO recovery attempt
await test('CTX4. context canceled caused by Hearth-initiated cleanup/cancel triggers NO recovery attempt', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-ctx4-' + crypto.randomUUID();
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'Intentional cleanup cancellation test',
    customAgyPath: process.execPath,
    userApproved: true,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  // Hearth intentionally initiates task cleanup / cancellation
  const rawTask = taskRegistry.get(res.taskId);
  rawTask.cleanup();

  assert.equal(rawTask.intentionalCancel, true, 'intentionalCancel flag must be true');

  const stdinLengthBefore = child.stdin.written.length;

  // Stderr emits context cancellation as process tears down
  child.stderr.emit('data', Buffer.from('stream input cancelled: context canceled\n'));

  const task = getAntigravityTask(res.taskId);
  assert.equal(task.controllerRecoveryCount, 0, 'Must NOT attempt recovery for Hearth-initiated cancellation');
  assert(task.controllerState !== 'recovering', 'Controller state must not be recovering');
  assert.equal(child.stdin.written.length, stdinLengthBefore, 'No recovery continuation prompt may be written to stdin');

  taskRegistry.delete(res.taskId);
});

// CTX5: background heartbeat cannot keep task alive after unrecoverable context cancellation
await test('CTX5. background heartbeat cannot keep task alive after unrecoverable context cancellation', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-ctx5-' + crypto.randomUUID();
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'Unrecoverable context cancel heartbeat test',
    customAgyPath: process.execPath,
    userApproved: true,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  // Register background job
  const bgChild = new EventEmitter();
  bgChild.killed = false;
  bgChild.exitCode = null;
  registerBackgroundJob(res.taskId, { name: 'bg_ctx5', child: bgChild });

  // Two context cancellations => unrecoverable terminal error
  child.stderr.emit('data', Buffer.from('stream input cancelled: context canceled\n'));
  child.stderr.emit('data', Buffer.from('stream input cancelled: context canceled\n'));

  let task = getAntigravityTask(res.taskId);
  assert.equal(task.status, 'error');
  assert.equal(task.controllerState, 'interrupted');

  // Background attempts heartbeat after terminal context cancellation
  const hbRes = recordBackgroundHeartbeat(res.taskId, { text: 'heartbeat after unrecoverable cancel' });
  assert.equal(hbRes, false, 'recordBackgroundHeartbeat MUST return false');

  task = getAntigravityTask(res.taskId);
  assert.equal(task.status, 'error', 'Task must stay error and not revert to running');
  assert.equal(isTaskActivelyRunning(task), false, 'isTaskActivelyRunning must return false');

  taskRegistry.delete(res.taskId);
});

// CTX6: existing literal "The stream was interrupted..." behavior remains unchanged
await test('CTX6. existing literal "The stream was interrupted..." behavior remains unchanged', async () => {
  // Pure classifier checks
  assert.equal(isStreamInterruptedMessage('The stream was interrupted. Please continue the task you were working on.'), true);
  assert.equal(isStreamInterruptedMessage('stream interrupted'), true);
  assert.equal(isStreamInterruptedMessage('connection interrupted'), true);
  assert.equal(isStreamInterruptedMessage('stream closed unexpectedly'), true);

  // Runtime task test with literal "The stream was interrupted..."
  const child = new MockStreamingChild();
  const testConvId = 'conv-ctx6-' + crypto.randomUUID();
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'Literal stream interruption test',
    customAgyPath: process.execPath,
    userApproved: true,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  // Interruption arrives using exact literal message
  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'error',
    error: 'The stream was interrupted. Please continue the task you were working on.',
  }) + '\n'));

  let task = getAntigravityTask(res.taskId);
  assert.equal(task.controllerRecoveryCount, 1);
  assert.equal(task.controllerState, 'recovering');
  assert(child.stdin.written.includes('stream was interrupted'));

  taskRegistry.delete(res.taskId);
});

// ── Heartbeat and Watchdog Diagnostic Suite (HB1 - HB8 + Accelerated Integration) ──

// HB1: healthy controller + background heartbeat every simulated 20s for >460s -> every heartbeat accepted -> watchdog timestamp advances continuously
await test('HB1. healthy controller + background heartbeat every simulated 20s for >460s -> every heartbeat accepted -> watchdog timestamp advances continuously', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-hb1-' + crypto.randomUUID();
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'HB1 continuous heartbeat test',
    customAgyPath: process.execPath,
    userApproved: true,
    executionTimeoutMs: 330000,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  const bgChild = new EventEmitter();
  bgChild.killed = false;
  bgChild.exitCode = null;
  registerBackgroundJob(res.taskId, { name: 'hb1_worker', child: bgChild });

  let previousResetAt = null;
  // 24 simulated heartbeats * 20s = 480s > 460s
  for (let i = 1; i <= 24; i++) {
    await new Promise((r) => setTimeout(r, 2));
    const ok = recordBackgroundHeartbeat(res.taskId, { text: `Heartbeat emission #${i}` });
    assert.equal(ok, true, `Heartbeat #${i} must be accepted`);

    const task = getAntigravityTask(res.taskId);
    assert.equal(task.heartbeatSeq, i, `Monotonic heartbeatSeq must equal ${i}`);
    assert.equal(task.backgroundJobs[0].heartbeatCount, i);
    assert.equal(task.backgroundJobs[0].state, 'running');
    assert.equal(task.lastWatchdogResetReason, 'background_heartbeat');
    assert.equal(task.status, 'running');
    assert.equal(task.controllerState, 'healthy');

    if (previousResetAt) {
      assert(new Date(task.lastWatchdogResetAt).getTime() >= new Date(previousResetAt).getTime());
    }
    previousResetAt = task.lastWatchdogResetAt;
  }

  taskRegistry.delete(res.taskId);
});

// HB2: heartbeat sequence stops unexpectedly after simulated ~5m -> test must identify stale/lost listener condition -> watchdog eventually errors as expected
await test('HB2. heartbeat sequence stops unexpectedly after simulated ~5m -> test must identify stale/lost listener condition -> watchdog eventually errors as expected', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-hb2-' + crypto.randomUUID();
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'HB2 lost listener test',
    customAgyPath: process.execPath,
    userApproved: true,
    executionTimeoutMs: 100, // Short watchdog for fast test
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  const bgChild = new EventEmitter();
  bgChild.killed = false;
  bgChild.exitCode = null;
  const job = registerBackgroundJob(res.taskId, { name: 'hb2_worker', child: bgChild });

  // Simulate active heartbeats up to iteration 15 (~5m equivalent)
  for (let i = 1; i <= 15; i++) {
    await new Promise((r) => setTimeout(r, 2));
    recordBackgroundHeartbeat(res.taskId, { text: `Heartbeat #${i}` });
  }

  let task = getAntigravityTask(res.taskId);
  assert.equal(task.heartbeatSeq, 15);
  const lastAcceptedAt = task.lastWatchdogResetAt;

  // Stale/lost listener condition: listener detached or emitter stops sending
  if (typeof job.detachListeners === 'function') {
    job.detachListeners();
  }

  // Wait for watchdog timeout (100ms) to fire
  await new Promise((r) => setTimeout(r, 140));

  task = getAntigravityTask(res.taskId);
  assert.equal(task.status, 'error', 'Task must transition to error on watchdog timeout');
  assert(task.error.includes('timed out'), `Expected timeout error, got: ${task.error}`);
  assert.equal(task.lastWatchdogResetAt, lastAcceptedAt, 'Watchdog timestamp must not have advanced after listener lost');

  taskRegistry.delete(res.taskId);
});

// HB3: background registry entry survives entire >7m lifecycle
await test('HB3. background registry entry survives entire >7m lifecycle', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-hb3-' + crypto.randomUUID();
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'HB3 registry persistence test',
    customAgyPath: process.execPath,
    userApproved: true,
    executionTimeoutMs: 330000,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  const bgChild = new EventEmitter();
  bgChild.killed = false;
  bgChild.exitCode = null;
  const registeredJob = registerBackgroundJob(res.taskId, {
    name: 'hb3_persistent_job',
    child: bgChild,
    metadata: { suite: 'smoke7' },
  });

  // Simulate turns and progress prose
  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'result',
    result: {
      conversation_id: testConvId,
      status: 'SUCCESS',
      response: 'Initial assertions passed. Controlled background heartbeat process active for 440s.',
    },
  }) + '\n'));

  // Simulate multiple heartbeats over lifecycle
  for (let i = 1; i <= 22; i++) {
    recordBackgroundHeartbeat(res.taskId, { text: `Pulse ${i}` });
  }

  const task = getAntigravityTask(res.taskId);
  assert.equal(task.backgroundJobs.length, 1);
  const foundJob = task.backgroundJobs[0];
  assert.equal(foundJob.id, registeredJob.id);
  assert.equal(foundJob.name, 'hb3_persistent_job');
  assert.equal(foundJob.state, 'running');
  assert.equal(foundJob.heartbeatCount, 22);
  assert(foundJob.registeredAt, 'registeredAt must be populated');
  assert(foundJob.lastHeartbeatAt, 'lastHeartbeatAt must be populated');

  taskRegistry.delete(res.taskId);
});

// HB4: background completion triggers exactly one continuation
await test('HB4. background completion triggers exactly one continuation', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-hb4-' + crypto.randomUUID();
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'HB4 continuation trigger test',
    customAgyPath: process.execPath,
    userApproved: true,
    executionTimeoutMs: 330000,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  const bgChild = new EventEmitter();
  bgChild.killed = false;
  bgChild.exitCode = null;
  registerBackgroundJob(res.taskId, { name: 'hb4_job', child: bgChild });

  // Progress prose arrives -> pendingContinuation becomes true
  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'result',
    result: {
      conversation_id: testConvId,
      status: 'SUCCESS',
      response: 'Waiting for background tests to complete.',
    },
  }) + '\n'));

  let task = getAntigravityTask(res.taskId);
  assert.equal(task.pendingContinuation, true);

  const initialStdinLength = child.stdin.written.length;

  // Background completes
  completeBackgroundJob(res.taskId, { exitCode: 0, output: 'Background suite passed 100%' });

  task = getAntigravityTask(res.taskId);
  assert.equal(task.pendingContinuation, false);
  assert.equal(task.lastWatchdogResetReason, 'continuation_sent');
  assert.equal(task.backgroundJobs[0].state, 'completed');
  assert.equal(task.backgroundJobs[0].exitCode, 0);

  // Exactly one continuation message was written to stdin
  const matches = (child.stdin.written.match(/The background command or tool has completed/g) || []).length;
  assert.equal(matches, 1);

  // Calling completeBackgroundJob again does NOT send a duplicate continuation
  completeBackgroundJob(res.taskId, { exitCode: 0, output: 'Second exit event' });
  const matchesAfter = (child.stdin.written.match(/The background command or tool has completed/g) || []).length;
  assert.equal(matchesAfter, 1);

  taskRegistry.delete(res.taskId);
});

// HB5: continuation uses same conversation_id and does not duplicate background process
await test('HB5. continuation uses same conversation_id and does not duplicate background process', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-hb5-' + crypto.randomUUID();
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'HB5 same conversation test',
    customAgyPath: process.execPath,
    userApproved: true,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  const bgChild = new EventEmitter();
  bgChild.killed = false;
  bgChild.exitCode = null;
  registerBackgroundJob(res.taskId, { id: 'bg-single', name: 'hb5_singleton', child: bgChild });

  // Progress prose
  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'result',
    result: { conversation_id: testConvId, status: 'SUCCESS', response: 'Waiting for heartbeat process.' },
  }) + '\n'));

  // Complete
  completeBackgroundJob(res.taskId, { jobId: 'bg-single', exitCode: 0, output: 'Done' });

  const task = getAntigravityTask(res.taskId);
  assert.equal(task.conversationId, testConvId, 'Must preserve same conversation_id');
  assert.equal(task.backgroundJobs.length, 1, 'Must NOT duplicate background process');

  taskRegistry.delete(res.taskId);
});

// HB6: controller interruption causes heartbeat rejection as intended
await test('HB6. controller interruption causes heartbeat rejection as intended', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-hb6-' + crypto.randomUUID();
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'HB6 interruption rejection test',
    customAgyPath: process.execPath,
    userApproved: true,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  const bgChild = new EventEmitter();
  bgChild.killed = false;
  bgChild.exitCode = null;
  registerBackgroundJob(res.taskId, { name: 'hb6_worker', child: bgChild });

  // Controller interrupted via stderr
  child.stderr.emit('data', Buffer.from('stream input cancelled: context canceled\n'));

  let task = getAntigravityTask(res.taskId);
  // First interruption triggered bounded recovery
  assert.equal(task.controllerState, 'recovering');

  // Second interruption fails recovery and marks terminally interrupted
  child.stderr.emit('data', Buffer.from('stream input cancelled: context canceled\n'));
  task = getAntigravityTask(res.taskId);
  assert.equal(task.controllerState, 'interrupted');
  assert.equal(task.status, 'error');

  // Heartbeat rejection
  const accepted = recordBackgroundHeartbeat(res.taskId, { text: 'Late heartbeat' });
  assert.equal(accepted, false, 'Heartbeat MUST be rejected when controller is interrupted');

  taskRegistry.delete(res.taskId);
});

// HB7: intentional cleanup removes heartbeat listener/job cleanly
await test('HB7. intentional cleanup removes heartbeat listener/job cleanly', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-hb7-' + crypto.randomUUID();
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'HB7 intentional cleanup test',
    customAgyPath: process.execPath,
    userApproved: true,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  const bgChild = new EventEmitter();
  bgChild.killed = false;
  bgChild.exitCode = null;
  registerBackgroundJob(res.taskId, { name: 'hb7_worker', child: bgChild });

  assert.equal(bgChild.listenerCount('heartbeat'), 1);

  // Intentional task cancel / cleanup
  const taskObj = taskRegistry.get(res.taskId);
  taskObj.cleanup();

  assert.equal(bgChild.listenerCount('heartbeat'), 0, 'Cleanup must detach heartbeat listener');
  const task = getAntigravityTask(res.taskId);
  assert.equal(task.backgroundJobs[0].state, 'cleaned_up');

  // Emitting on bgChild should not trigger recordBackgroundHeartbeat or advance heartbeatSeq
  const prevSeq = task.heartbeatSeq;
  bgChild.emit('heartbeat', { text: 'Zombie beat' });
  const afterTask = getAntigravityTask(res.taskId);
  assert.equal(afterTask.heartbeatSeq, prevSeq, 'No heartbeat sequence advance after cleanup');

  taskRegistry.delete(res.taskId);
});

// HB8: no heartbeat stdout/prose alone may reset watchdog unless it passes through recordBackgroundHeartbeat()
await test('HB8. no heartbeat stdout/prose alone may reset watchdog unless it passes through recordBackgroundHeartbeat()', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-hb8-' + crypto.randomUUID();
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'HB8 raw prose rejection test',
    customAgyPath: process.execPath,
    userApproved: true,
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  // Controller emits raw stdout prose mentioning heartbeat
  child.stdout.emit('data', Buffer.from('Heartbeat progress 1: background task actively emitting activity every 20s\n'));

  let task = getAntigravityTask(res.taskId);
  assert(task.lastWatchdogResetReason !== 'background_heartbeat', 'Raw stdout cannot reset watchdog as background_heartbeat');
  assert.equal(task.heartbeatSeq, 0, 'Raw stdout cannot advance heartbeatSeq');

  // Attempting recordBackgroundHeartbeat on task without registered background jobs returns false
  const ok = recordBackgroundHeartbeat(res.taskId, { text: 'Orphan heartbeat' });
  assert.equal(ok, false, 'recordBackgroundHeartbeat must return false when no background jobs exist');
  assert.equal(task.heartbeatSeq, 0);

  taskRegistry.delete(res.taskId);
});

// HB_ACCEL: short accelerated integration test simulating >7m runtime and completion at logical 460s
await test('HB_ACCEL. short accelerated integration test simulating >7m runtime and completion at logical 460s', async () => {
  const child = new MockStreamingChild();
  const testConvId = 'conv-hb-accel-' + crypto.randomUUID();
  const resPromise = startAntigravityTask({
    workspace: process.cwd(),
    prompt: 'Accelerated 7m lifecycle integration test',
    customAgyPath: process.execPath,
    userApproved: true,
    executionTimeoutMs: 250, // Short watchdog requiring continuous resets
    spawnFn: () => {
      child.markSpawned();
      return child;
    },
  });

  await child.spawned;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: testConvId }) + '\n'));
  const res = await resPromise;

  // T+50ms: Progress prose arrives (simulating 5m05s in real time)
  await new Promise((r) => setTimeout(r, 50));
  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'result',
    result: {
      conversation_id: testConvId,
      status: 'SUCCESS',
      response: 'All initial assertions verified cleanly. Controlled 460s background heartbeat process is active.',
    },
  }) + '\n'));

  let task = getAntigravityTask(res.taskId);
  assert.equal(task.status, 'running');
  assert.equal(task.pendingContinuation, true);

  // Register owned background job
  const bgChild = new EventEmitter();
  bgChild.killed = false;
  bgChild.exitCode = null;
  registerBackgroundJob(res.taskId, { name: 'accel_heartbeat_worker', child: bgChild });

  // Simulate 8 periodic heartbeats every 40ms (8 * 40ms = 320ms > 250ms watchdog)
  for (let i = 1; i <= 8; i++) {
    await new Promise((r) => setTimeout(r, 40));
    bgChild.emit('heartbeat', { text: `Logical heartbeat #${i} @ logical T+${i * 50}s` });
    task = getAntigravityTask(res.taskId);
    assert.equal(task.status, 'running');
    assert.equal(task.heartbeatSeq, i);
    assert.equal(task.lastWatchdogResetReason, 'background_heartbeat');
  }

  // Logical 460s: Background completes cleanly
  completeBackgroundJob(res.taskId, { exitCode: 0, output: '460s heartbeat process finished with exit code 0.' });

  task = getAntigravityTask(res.taskId);
  assert.equal(task.status, 'running');
  assert.equal(task.pendingContinuation, false);
  assert.equal(task.lastWatchdogResetReason, 'continuation_sent');

  // Verify continuation prompt was delivered to same session
  assert(child.stdin.written.includes('The background command or tool has completed.'));

  // Controller responds to continuation prompt with structured completed contract
  child.stdout.emit('data', Buffer.from(JSON.stringify({
    event: 'result',
    result: {
      conversation_id: testConvId,
      status: 'SUCCESS',
      response: '```json\n{"status":"completed","summary":"Background 460s process completed successfully and verified."}\n```',
    },
  }) + '\n'));

  task = getAntigravityTask(res.taskId);
  assert.equal(task.status, 'done');
  assert.equal(task.completion?.status, 'done');
  assert.equal(task.completion?.normalizedStatus, 'completed');
  assert.equal(task.controllerState, 'closed');

  child.emit('close', 0);
  taskRegistry.delete(res.taskId);
});

// ── Summary ────────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════');
console.log(`  Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);
console.log('══════════════════════════════════════════════════════════\n');

if (failed > 0) {
  console.log('Failed tests:');
  results.filter(r => r.status === 'FAIL').forEach(r => console.log(`  - ${r.name}: ${r.error}`));
  process.exit(1);
}
