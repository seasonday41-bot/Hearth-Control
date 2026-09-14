import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

import { registerWorkspaceTools, toolNames } from '../mcp/tools.mjs';
import { XClaimStore } from '../mcp/x/claim-store.mjs';
import { XRunStore } from '../mcp/x/run-store.mjs';
import { X_TASK_VERSION } from '../mcp/x/task-contract.mjs';

const fixtures = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-x-mcp-tools-'));
  const dbPath = path.join(root, 'hearth-runtime.sqlite');
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'scripts/test-pass.mjs'), "import test from 'node:test';\ntest('passes', () => {});\n");
  const item = { root, dbPath, stores: [] };
  fixtures.push(item);
  return item;
}
afterEach(() => {
  for (const item of fixtures.splice(0)) {
    for (const store of item.stores) store.close();
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

/** Constructs a real, SQLite-backed XClaimStore + XRunStore pair pointed at the given file -- tracked for cleanup. */
function realStores(item, dbPath = item.dbPath) {
  const claimStore = new XClaimStore({ storagePath: dbPath });
  const runStore = new XRunStore({ storagePath: dbPath });
  item.stores.push(claimStore, runStore);
  return { claimStore, runStore };
}

/** Minimal fake MCP server: records registerTool(name, config, handler) calls so tests can invoke handlers directly. */
function fakeServer() {
  const tools = new Map();
  return { tools, registerTool(name, config, handler) { tools.set(name, { config, handler }); } };
}

function registerFor(item, overrides = {}) {
  const server = fakeServer();
  const { claimStore, runStore } = overrides.claimStore ? overrides : realStores(item);
  const ownerId = overrides.ownerId ?? `owner-${Math.random().toString(36).slice(2)}`;
  const modelAdapter = overrides.modelAdapter ?? model();
  registerWorkspaceTools(server, {
    workspace: item.root,
    permissions: {},
    xRuntime: { claimStore, runStore, modelAdapter, ownerId },
  });
  return { server, claimStore, runStore, ownerId };
}

function taskFor(item, taskId = 'task-x-1') {
  return {
    version: X_TASK_VERSION, task_id: taskId, parent_task_id: null,
    revision: 1, attempt: 1, based_on_result_id: null,
    objective: 'Run one X task via MCP.', problem: 'The MCP tools need a durable, fenced runner.',
    expected_behavior: 'x_start/x_task expose the fenced X pipeline.',
    observed_behavior: 'No MCP tool wiring existed yet.',
    why_this_matters: 'A transport adapter must not add a second orchestration layer.',
    known_evidence: [], suspected_area: [], workspace: { repo: 'Hearth-Control', root: item.root },
    scope: { allowed_paths: ['src'], preferred_files: [], forbidden_paths: [] },
    constraints: { preserve: [], do_not: [] }, allowed_tools: ['repo_read'],
    acceptance_criteria: ['The run is fenced.'],
    validation: { required: ['node --test scripts/test-pass.mjs'], optional: [] },
    verification: null, done_criteria: ['Required validation passes.'], teaching_notes: [],
    uncertainty_policy: { policy: 'bounded_autonomy', stop_conditions: [] },
    repair_budget: { initial_attempts: 1, max_repairs: 2, max_total_rounds: 3 },
    timing: { estimated_minutes: 5, first_check_after_minutes: 1, soft_deadline_minutes: 3, hard_timeout_minutes: 10 },
    commit_policy: { mode: 'never' },
  };
}

const model = (actions = []) => ({
  async generate() {
    return { ok: true, provider: 'fake', model: 'fake', text: JSON.stringify({ actions }), finishReason: 'stop', usage: null, error: null };
  },
});
const create = (pathName = 'src/ok.js') => ({ type: 'create', path: pathName, content: 'ok\n' });

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

/** A model that hangs forever (never resolves generate()) until externally released -- proves x_start never waits for it. */
function hangingModel() {
  const entered = deferred();
  const release = deferred();
  return {
    entered: entered.promise,
    async generate() {
      entered.resolve();
      await release.promise;
      return model().generate();
    },
    release: release.resolve,
  };
}

const jsonOf = (toolResult) => JSON.parse(toolResult.content[0].text);

async function pollUntilTerminal(server, runId, { timeoutMs = 4000, intervalMs = 15 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = jsonOf(await server.tools.get('x_task').handler({ run_id: runId }));
    if (['completed', 'needs_review', 'failed', 'interrupted'].includes(response.status)) return response;
    if (Date.now() > deadline) throw new Error(`timed out waiting for run '${runId}' to reach a terminal status`);
    await sleep(intervalMs);
  }
}

test('T1 x_start returns promptly while execution remains running (does not await model completion)', async () => {
  const item = fixture();
  const { server } = registerFor(item, { modelAdapter: hangingModel() });
  const startedAt = Date.now();
  const result = jsonOf(await server.tools.get('x_start').handler({ task: taskFor(item) }));
  const elapsedMs = Date.now() - startedAt;
  assert.equal(result.accepted, true);
  assert.equal(result.status, 'running');
  assert.ok(elapsedMs < 500, `x_start took ${elapsedMs}ms; expected a prompt return, not a wait on model execution`);
});

test('T2 accepted x_start returns a run_id and task_id', async () => {
  const item = fixture();
  const { server } = registerFor(item);
  const result = jsonOf(await server.tools.get('x_start').handler({ task: taskFor(item) }));
  assert.equal(result.accepted, true);
  assert.equal(typeof result.run_id, 'string');
  assert.ok(result.run_id.length > 0);
  assert.equal(result.task_id, 'task-x-1');
  await pollUntilTerminal(server, result.run_id);
});

test('T3 denied admission returns no run_id and creates no run row', async () => {
  const item = fixture();
  const { server, runStore } = registerFor(item);
  const outsideClaims = new XClaimStore({ storagePath: item.dbPath });
  item.stores.push(outsideClaims);
  outsideClaims.claim({ taskId: 'task-x-1', ownerId: 'someone-else' });

  const result = jsonOf(await server.tools.get('x_start').handler({ task: taskFor(item) }));
  assert.deepEqual(result, { accepted: false, reason: 'no_capacity', run_id: null });
  // No run row exists for the denied task under any plausible auto-generated id -- confirm the store has zero rows at all.
  assert.equal(runStore.getRun('task-x-1'), null);
});

test('T4 x_task sees the running persisted state immediately after x_start', async () => {
  const item = fixture();
  const adapter = hangingModel();
  const { server } = registerFor(item, { modelAdapter: adapter });
  const started = jsonOf(await server.tools.get('x_start').handler({ task: taskFor(item) }));
  await adapter.entered;
  const status = jsonOf(await server.tools.get('x_task').handler({ run_id: started.run_id }));
  assert.equal(status.status, 'running');
  assert.equal(status.result, null);
  adapter.release();
});

test('T5 x_task later sees COMPLETED with the full persisted x-result-v1', async () => {
  const item = fixture();
  const { server } = registerFor(item, { modelAdapter: model([create()]) });
  const started = jsonOf(await server.tools.get('x_start').handler({ task: taskFor(item) }));
  const final = await pollUntilTerminal(server, started.run_id);
  assert.equal(final.status, 'completed');
  assert.equal(final.gate_status, 'COMPLETED');
  assert.equal(final.hearth_outcome, 'completed');
  assert.equal(final.result.task_id, 'task-x-1');
  assert.equal(final.result.gate_status, 'COMPLETED');
});

test('T6 x_task sees NEEDS_REVIEW for a safety-boundary outcome', async () => {
  const item = fixture();
  const { server } = registerFor(item, { modelAdapter: model([create('src/.env')]) });
  const started = jsonOf(await server.tools.get('x_start').handler({ task: taskFor(item) }));
  const final = await pollUntilTerminal(server, started.run_id);
  assert.equal(final.status, 'needs_review');
  assert.equal(final.gate_status, 'NEEDS_REVIEW');
  assert.equal(final.result.reason_code, 'safety_boundary_review');
});

test('T7 x_task sees a real Result Gate FAILED for a structural failure', async () => {
  const item = fixture();
  const { server } = registerFor(item, { modelAdapter: model([create('outside/no.js')]) });
  const started = jsonOf(await server.tools.get('x_start').handler({ task: taskFor(item) }));
  const final = await pollUntilTerminal(server, started.run_id);
  assert.equal(final.status, 'failed');
  assert.equal(final.gate_status, 'FAILED');
  assert.equal(final.hearth_outcome, 'error');
});

test('T8 x_task reports interrupted for a persisted interrupted run', async () => {
  const item = fixture();
  const { server, runStore } = registerFor(item);
  runStore.createRun({ runId: 'run-interrupted-1', taskId: 'task-x-1' });
  runStore.markRunning({ runId: 'run-interrupted-1', claimLeaseId: 'lease-orphaned' });
  runStore.markInterrupted('run-interrupted-1');
  const status = jsonOf(await server.tools.get('x_task').handler({ run_id: 'run-interrupted-1' }));
  assert.equal(status.status, 'interrupted');
});

test('T9 unknown run_id is handled safely as a tool failure, not a thrown/crashed handler', async () => {
  const item = fixture();
  const { server } = registerFor(item);
  const result = await server.tools.get('x_task').handler({ run_id: 'does-not-exist' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /No X run found/);
});

test('T10 x_start does not await full model execution even when the model never resolves', async () => {
  const item = fixture();
  const { server } = registerFor(item, { modelAdapter: hangingModel() });
  const raced = await Promise.race([
    server.tools.get('x_start').handler({ task: taskFor(item) }).then(() => 'x_start'),
    sleep(1000).then(() => 'timeout'),
  ]);
  assert.equal(raced, 'x_start', 'x_start must resolve well before a 1s timeout even with a permanently hanging model');
});

test('T11 a second process/store sharing the same SQLite file cannot bypass global admission', async () => {
  const item = fixture();
  const adapter = hangingModel();
  const { server: serverA } = registerFor(item, { modelAdapter: adapter });
  const firstStart = jsonOf(await serverA.tools.get('x_start').handler({ task: taskFor(item) }));
  assert.equal(firstStart.accepted, true);
  await adapter.entered;

  // Simulate a second OS process: an entirely independent tool registration
  // (its own XClaimStore/XRunStore instances) pointed at the SAME shared
  // SQLite file, admitting a DIFFERENT task_id.
  let secondModelCalled = 0;
  const { server: serverB } = registerFor(item, {
    modelAdapter: { async generate() { secondModelCalled += 1; return model().generate(); } },
  });
  const secondResult = jsonOf(await serverB.tools.get('x_start').handler({ task: taskFor(item, 'task-x-2-different') }));

  // Different task_id, but the single SQLite-backed global admission slot
  // is already held by process A -- must still be denied.
  assert.equal(secondResult.accepted, false);
  assert.equal(secondResult.reason, 'no_capacity');
  assert.equal(secondModelCalled, 0);

  adapter.release();
  await pollUntilTerminal(serverA, firstStart.run_id);
});

test('T12 x_task works from a fresh store/process reading the same SQLite file', async () => {
  const item = fixture();
  const { server: serverA } = registerFor(item, { modelAdapter: model([create()]) });
  const started = jsonOf(await serverA.tools.get('x_start').handler({ task: taskFor(item) }));
  await pollUntilTerminal(serverA, started.run_id);

  // A completely independent registration (fresh XRunStore instance), same file.
  const { server: serverB } = registerFor(item);
  const seenFromB = jsonOf(await serverB.tools.get('x_task').handler({ run_id: started.run_id }));
  assert.equal(seenFromB.status, 'completed');
  assert.equal(seenFromB.result.task_id, 'task-x-1');
});

test('T13 no Codex/Claude routing occurs anywhere in the tool source or in tool responses', async () => {
  // A prose mention explaining the policy (e.g. "never routes to Codex or
  // Claude" in a tool description) is fine and expected; what must never
  // exist is an actual call into a Codex/Claude routing function. Check
  // code constructs, not the mere presence of the word.
  const modulePath = fileURLToPath(new URL('../mcp/tools.mjs', import.meta.url));
  const source = fs.readFileSync(modulePath, 'utf8');

  assert.ok(
    !/\bcodex\w*\s*\(/i.test(source),
    'mcp/tools.mjs must not call a Codex-routing function',
  );

  assert.ok(
    !/\bclaude\w*\s*\(/i.test(source),
    'mcp/tools.mjs must not call a Claude-escalation function',
  );

  const item = fixture();
  const { server } = registerFor(item, { modelAdapter: model([create('outside/no.js')]) }); // a FAILED-producing task
  const started = jsonOf(await server.tools.get('x_start').handler({ task: taskFor(item) }));
  const final = await pollUntilTerminal(server, started.run_id);
  const serialized = JSON.stringify(final);
  assert.ok(!/codex/i.test(serialized));
  assert.ok(!/forwarded_to|escalat/i.test(serialized), 'a failed/needs_review result must not carry any auto-escalation field');
});

test('T14 no unhandled background rejection occurs when execution throws', async () => {
  const item = fixture();
  // A ModelAdapter that always throws is caught by LocalExecutor as a
  // classified, repairable 'model_request_failed'; after the repair budget
  // is exhausted this deterministically reaches NEEDS_REVIEW / external
  // dependency (never a raw uncaught exception). The point of this test is
  // that runXTask's background `done` settlement never becomes an
  // unhandled rejection along the way.
  const throwingAdapter = { async generate() { throw new Error('adapter exploded'); } };
  const { server } = registerFor(item, { modelAdapter: throwingAdapter });

  let unhandled = null;
  const onUnhandled = (reason) => { unhandled = reason; };
  process.on('unhandledRejection', onUnhandled);
  try {
    const started = jsonOf(await server.tools.get('x_start').handler({ task: taskFor(item) }));
    const final = await pollUntilTerminal(server, started.run_id, { timeoutMs: 8000 });
    assert.equal(final.status, 'needs_review');
    assert.equal(final.gate_status, 'NEEDS_REVIEW');
    assert.equal(final.hearth_outcome, 'waiting');
    await sleep(20); // give any stray unhandled rejection a chance to surface
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
  assert.equal(unhandled, null, `expected no unhandledRejection, got: ${unhandled}`);
});

test('T15 existing MCP tools remain registered and unaffected by the new X tools', async () => {
  const item = fixture();
  const { server } = registerFor(item);
  for (const name of ['workspace_info', 'list_files', 'read_file', 'write_file', 'git_status', 'git_diff', 'run_command',
    'antigravity_status', 'antigravity_start', 'antigravity_task', 'antigravity_send', 'x_start', 'x_task']) {
    assert.ok(server.tools.has(name), `expected tool '${name}' to still be registered`);
    assert.ok(toolNames.includes(name), `expected '${name}' listed in toolNames`);
  }
  const info = jsonOf(await server.tools.get('workspace_info').handler({}));
  assert.equal(info.workspace, item.root);
});

// ── fast-restart liveness: x_admission_hint (direct x_start path) ──────────
//
// A content-free IPC hint only -- no runId/taskId/leaseId/expiry/status --
// so Electron's fast-restart wakeup scheduler can re-arm itself by
// independently reading persisted claim state, never by trusting this
// message's payload. Reuses the exact withMockedProcessSend/
// withoutProcessSend pattern already established in
// scripts/test-x-terminal-event.mjs for the same process.send surface.
// Filtered by message type (rather than asserting raw call counts/order) so
// these tests stay robust regardless of exactly when the separate,
// already-existing x_run_terminal notification (fired later, only once the
// run actually reaches a terminal status) happens to land relative to the
// synchronous admission hint.

/** Temporarily installs a mock process.send for the duration of `fn`, restoring the prior value (present or absent) afterward. */
async function withMockedProcessSend(mockFn, fn) {
  const hadOwnProperty = Object.prototype.hasOwnProperty.call(process, 'send');
  const original = process.send;
  process.send = mockFn;
  try {
    return await fn();
  } finally {
    if (hadOwnProperty) process.send = original;
    else delete process.send;
  }
}
/** Ensures process.send is absent for the duration of `fn` (the real, non-forked default). */
async function withoutProcessSend(fn) {
  const hadOwnProperty = Object.prototype.hasOwnProperty.call(process, 'send');
  const original = process.send;
  delete process.send;
  try {
    return await fn();
  } finally {
    if (hadOwnProperty) process.send = original;
  }
}

test('H1 direct x_start accepted admission sends exactly one x_admission_hint', async () => {
  const item = fixture();
  const { server } = registerFor(item);
  const calls = [];

  const result = await withMockedProcessSend(
    (msg) => { calls.push(msg); },
    async () =>
      jsonOf(await server.tools.get('x_start').handler({
        task: taskFor(item),
      })),
  );

  assert.equal(result.accepted, true);

  const admissionHints = calls.filter(
    (msg) => msg?.type === 'x_admission_hint',
  );

  assert.equal(
    admissionHints.length,
    1,
    'expected exactly one x_admission_hint for an accepted admission',
  );

  assert.deepEqual(admissionHints[0], {
    type: 'x_admission_hint',
  });

  await pollUntilTerminal(server, result.run_id);
});

test('H2 rejected x_start (no_capacity) sends no admission hint', async () => {
  const item = fixture();
  const { server } = registerFor(item);
  const outsideClaims = new XClaimStore({ storagePath: item.dbPath });
  item.stores.push(outsideClaims);
  outsideClaims.claim({ taskId: 'task-x-1', ownerId: 'someone-else' });

  const calls = [];
  const result = await withMockedProcessSend((msg) => { calls.push(msg); }, async () =>
    jsonOf(await server.tools.get('x_start').handler({ task: taskFor(item) })));
  assert.equal(result.accepted, false);
  const admissionHints = calls.filter((msg) => msg?.type === 'x_admission_hint');
  assert.equal(admissionHints.length, 0, 'a denied admission must never send an admission hint');
});

test('H3 the admission hint carries no authoritative payload -- no runId, taskId, leaseId, expiry, or status', async () => {
  const item = fixture();
  const { server } = registerFor(item);
  const calls = [];

  const result = await withMockedProcessSend(
    (msg) => { calls.push(msg); },
    async () =>
      jsonOf(await server.tools.get('x_start').handler({
        task: taskFor(item),
      })),
  );

  const admissionHints = calls.filter(
    (msg) => msg?.type === 'x_admission_hint',
  );

  assert.equal(admissionHints.length, 1);

  assert.deepEqual(
    Object.keys(admissionHints[0]).sort(),
    ['type'],
    'the hint must carry exactly one field: type',
  );

  assert.equal(
    admissionHints[0].type,
    'x_admission_hint',
  );

  await pollUntilTerminal(server, result.run_id);
});

test('H4 process.send absent or throwing never affects x_start\'s own accepted response', async () => {
  const item = fixture();
  const { server: server1 } = registerFor(item);
  const withoutResult = await withoutProcessSend(async () =>
    jsonOf(await server1.tools.get('x_start').handler({ task: taskFor(item, 'task-x-2') })));
  assert.equal(withoutResult.accepted, true);
  await pollUntilTerminal(server1, withoutResult.run_id);

  const item2 = fixture();
  const { server: server2 } = registerFor(item2);
  const throwingResult = await withMockedProcessSend(() => { throw new Error('simulated IPC failure'); }, async () =>
    jsonOf(await server2.tools.get('x_start').handler({ task: taskFor(item2) })));
  assert.equal(throwingResult.accepted, true);
  await pollUntilTerminal(server2, throwingResult.run_id);
});
