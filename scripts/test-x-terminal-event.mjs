// Focused tests for X Terminal Event Plumbing Phase A: the best-effort
// `x_run_terminal` transport notification emitted from the existing
// `observeBackgroundCompletion(admitted)` hook in mcp/tools.mjs, strictly
// AFTER XRunStore has already persisted terminal truth (never before, never
// instead of).
//
// Deliberately exercises the REAL x_start/x_task tool handlers (via
// registerWorkspaceTools, the exact production wiring) against a REAL
// temporary SQLite-backed XClaimStore/XRunStore pair -- the same pattern
// scripts/test-x-mcp-tools.mjs already establishes. The only fakes are a
// deterministic ModelAdapter (no live Ollama) and `process.send` (mocked
// per test, restored afterward) -- no parallel orchestration layer.
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { registerWorkspaceTools } from '../mcp/tools.mjs';
import { XClaimStore } from '../mcp/x/claim-store.mjs';
import { XRunStore } from '../mcp/x/run-store.mjs';
import { X_TASK_VERSION } from '../mcp/x/task-contract.mjs';

const fixtures = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-x-terminal-event-'));
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

function taskFor(item, taskId = 'task-x-1', { allowedTools = ['repo_read'] } = {}) {
  return {
    version: X_TASK_VERSION, task_id: taskId, parent_task_id: null,
    revision: 1, attempt: 1, based_on_result_id: null,
    objective: 'Run one X task via MCP.', problem: 'The MCP tools need a durable, fenced runner.',
    expected_behavior: 'x_start/x_task expose the fenced X pipeline.',
    observed_behavior: 'No MCP tool wiring existed yet.',
    why_this_matters: 'A transport adapter must not add a second orchestration layer.',
    known_evidence: [], suspected_area: [], workspace: { repo: 'Hearth-Control', root: item.root },
    scope: { allowed_paths: ['src'], preferred_files: [], forbidden_paths: [] },
    constraints: { preserve: [], do_not: [] }, allowed_tools: allowedTools,
    acceptance_criteria: ['The run is fenced.'],
    validation: { required: ['node --test scripts/test-pass.mjs'], optional: [] },
    verification: null, done_criteria: ['Required validation passes.'], teaching_notes: [],
    uncertainty_policy: { policy: 'bounded_autonomy', stop_conditions: [] },
    repair_budget: { initial_attempts: 1, max_repairs: 2, max_total_rounds: 3 },
    timing: { estimated_minutes: 5, first_check_after_minutes: 1, soft_deadline_minutes: 3, hard_timeout_minutes: 10 },
    commit_policy: { mode: 'never' },
  };
}

const jsonOf = (toolResult) => JSON.parse(toolResult.content[0].text);
/** Filters captured process.send calls down to x_run_terminal messages only -- x_start's own, separate, content-free x_admission_hint (fast-restart liveness) now also legitimately fires on every accepted admission, so raw call counts/positions are no longer a reliable proxy for "did x_run_terminal fire"; this keeps EVT1-7's original intent (the terminal-event contract itself) exact and unaffected by that unrelated hint. */
const terminalEventsOf = (calls) => calls.filter((msg) => msg?.type === 'x_run_terminal');
async function pollUntilTerminal(server, runId, { timeoutMs = 4000, intervalMs = 15 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = jsonOf(await server.tools.get('x_task').handler({ run_id: runId }));
    if (['completed', 'needs_review', 'failed', 'interrupted'].includes(response.status)) return response;
    if (Date.now() > deadline) throw new Error(`timed out waiting for run '${runId}' to reach a terminal status`);
    await sleep(intervalMs);
  }
}

const model = (actions = []) => ({
  async generate() {
    return { ok: true, provider: 'fake', model: 'fake', text: JSON.stringify({ actions }), finishReason: 'stop', usage: null, error: null };
  },
});
const create = (pathName = 'src/ok.js') => ({ type: 'create', path: pathName, content: 'ok\n' });

/** A model whose generate() pauses until externally released, and reports the abort signal it was given. */
function waitingModel() {
  let resolveEntered;
  const entered = new Promise((r) => { resolveEntered = r; });
  return {
    entered,
    async generate(_request, options) {
      resolveEntered(options?.signal);
      await new Promise((resolve) => {
        if (options?.signal?.aborted) resolve();
        else options?.signal?.addEventListener('abort', resolve, { once: true });
      });
      return { ok: true, provider: 'fake', model: 'fake', text: JSON.stringify({ actions: [] }), finishReason: 'stop', usage: null, error: null };
    },
  };
}

/** A model whose generate() pauses until externally released via release(), then resolves normally (no abort involved). */
function controllableModel(actions = []) {
  let resolveEntered;
  let resolveRelease;

  const entered = new Promise((resolve) => {
    resolveEntered = resolve;
  });

  const released = new Promise((resolve) => {
    resolveRelease = resolve;
  });

  return {
    entered,
    release() {
      resolveRelease();
    },
    async generate() {
      resolveEntered();
      await released;
      return {
        ok: true,
        provider: 'fake',
        model: 'fake',
        text: JSON.stringify({ actions }),
        finishReason: 'stop',
        usage: null,
        error: null,
      };
    },
  };
}

/** Waits for a real AbortSignal to fire, bounded so the test fails loudly instead of hanging. */
function waitForAbort(signal, timeoutMs = 2000) {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for the execution signal to abort')), timeoutMs);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
/** Bounds an otherwise-unobservable async chain (a guard, not the proof). */
function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs)),
  ]);
}

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

// ── 1-4: emits exactly once, matching persisted run fields ─────────────────

test('EVT1 COMPLETED emits exactly once, matching the persisted run', async () => {
  const item = fixture();
  const calls = [];
  await withMockedProcessSend((msg) => calls.push(msg), async () => {
    const { server, runStore } = registerFor(item, { modelAdapter: model([create('src/ok.js')]) });
    const started = jsonOf(await server.tools.get('x_start').handler({ task: taskFor(item) }));
    const final = await pollUntilTerminal(server, started.run_id);
    assert.equal(final.status, 'completed');

    const terminalEvents = terminalEventsOf(calls);
    assert.equal(terminalEvents.length, 1, 'exactly one x_run_terminal event must be emitted');
    const persisted = runStore.getRun(started.run_id);
    assert.deepEqual(terminalEvents[0], {
      type: 'x_run_terminal',
      runId: persisted.runId, taskId: persisted.taskId, status: persisted.status,
      gateStatus: persisted.gateStatus, hearthOutcome: persisted.hearthOutcome,
      result: persisted.result, error: persisted.error,
    });
    assert.equal(persisted.status, 'completed');
  });
});

test('EVT2 NEEDS_REVIEW emits exactly once, matching the persisted run', async () => {
  const item = fixture();
  const calls = [];
  await withMockedProcessSend((msg) => calls.push(msg), async () => {
    const { server, runStore } = registerFor(item, { modelAdapter: model([create('src/.env')]) });
    // Write authority required so this deliberately protected-path action
    // actually reaches PROTECTED_PATH/NEEDS_REVIEW instead of being
    // discarded by the read-only authority boundary.
    const task = taskFor(item, 'task-x-1', { allowedTools: ['repo_read', 'repo_edit'] });
    const started = jsonOf(await server.tools.get('x_start').handler({ task }));
    const final = await pollUntilTerminal(server, started.run_id);
    assert.equal(final.status, 'needs_review');

    const terminalEvents = terminalEventsOf(calls);
    assert.equal(terminalEvents.length, 1);
    const persisted = runStore.getRun(started.run_id);
    assert.equal(terminalEvents[0].status, 'needs_review');
    assert.deepEqual(terminalEvents[0], {
      type: 'x_run_terminal',
      runId: persisted.runId, taskId: persisted.taskId, status: persisted.status,
      gateStatus: persisted.gateStatus, hearthOutcome: persisted.hearthOutcome,
      result: persisted.result, error: persisted.error,
    });
  });
});

test('EVT3 FAILED emits exactly once, matching the persisted run', async () => {
  const item = fixture();
  const calls = [];
  await withMockedProcessSend((msg) => calls.push(msg), async () => {
    const { server, runStore } = registerFor(item, { modelAdapter: model([create('outside/no.js')]) });
    // Write authority required so this deliberately out-of-scope action
    // actually reaches PATH_REJECTED instead of being discarded by the
    // read-only authority boundary.
    const task = taskFor(item, 'task-x-1', { allowedTools: ['repo_read', 'repo_edit'] });
    const started = jsonOf(await server.tools.get('x_start').handler({ task }));
    const final = await pollUntilTerminal(server, started.run_id);
    assert.equal(final.status, 'failed');

    const terminalEvents = terminalEventsOf(calls);
    assert.equal(terminalEvents.length, 1);
    const persisted = runStore.getRun(started.run_id);
    assert.equal(terminalEvents[0].status, 'failed');
    assert.deepEqual(terminalEvents[0], {
      type: 'x_run_terminal',
      runId: persisted.runId, taskId: persisted.taskId, status: persisted.status,
      gateStatus: persisted.gateStatus, hearthOutcome: persisted.hearthOutcome,
      result: persisted.result, error: persisted.error,
    });
  });
});

test('EVT4 emitted event field set matches exactly what x_task itself reports (no drift between the two)', async () => {
  const item = fixture();
  const calls = [];
  await withMockedProcessSend((msg) => calls.push(msg), async () => {
    const { server } = registerFor(item, { modelAdapter: model([create()]) });
    const started = jsonOf(await server.tools.get('x_start').handler({ task: taskFor(item) }));
    const final = await pollUntilTerminal(server, started.run_id);

    const terminalEvents = terminalEventsOf(calls);
    assert.equal(terminalEvents.length, 1);
    const event = terminalEvents[0];
    assert.equal(event.runId, final.run_id);
    assert.equal(event.taskId, final.task_id);
    assert.equal(event.status, final.status);
    assert.equal(event.gateStatus, final.gate_status);
    assert.equal(event.hearthOutcome, final.hearth_outcome);
    assert.deepEqual(event.result, final.result);
    assert.equal(event.error, final.error);
  });
});

// ── 5-7: non-terminal-write outcomes never emit ─────────────────────────────

test('EVT5 fence_rejected emits nothing', async () => {
  const item = fixture();
  const calls = [];
  await withMockedProcessSend((msg) => calls.push(msg), async () => {
    const { server, runStore } = registerFor(item, { modelAdapter: model([create()]) });
    runStore.completeRunFenced = () => null;
    const started = jsonOf(await server.tools.get('x_start').handler({ task: taskFor(item) }));
    // The run can never reach a terminal x_task status now (fenced write
    // always rejected) -- wait a bounded amount past normal completion time
    // instead of polling for a terminal state that will never arrive.
    await sleep(200);
    assert.equal(runStore.getRun(started.run_id).status, 'running', 'a fence-rejected run must stay nonterminal');
    assert.equal(terminalEventsOf(calls).length, 0, 'no event may be emitted for a fence-rejected (non-persisted-by-us) outcome');
  });
});

test('EVT6 ownership_lost emits nothing', async () => {
  const item = fixture();
  const calls = [];

  await withMockedProcessSend((msg) => calls.push(msg), async () => {
    // A short lease so the keeper's own scheduled renewal (~leaseDurationMs/3)
    // fires well within this test's bounded waits, instead of XClaimStore's
    // default 30s lease leaving the keeper's first renewal attempt ~10s out.
    const claimStore = new XClaimStore({ storagePath: item.dbPath, leaseDurationMs: 300 });
    const runStore = new XRunStore({ storagePath: item.dbPath });
    item.stores.push(claimStore, runStore);

    const waiting = waitingModel();
    const { server, ownerId } = registerFor(item, {
      claimStore, runStore, modelAdapter: waiting,
    });

    const intruder = new XClaimStore({ storagePath: item.dbPath });
    item.stores.push(intruder);

    // Deterministic sentinel for runXTask reaching its final
    // releaseOriginalClaim(...) cleanup path.
    let resolveOriginalRelease;
    const originalReleaseAttempted = new Promise((resolve) => {
      resolveOriginalRelease = resolve;
    });

    const realRelease = claimStore.release.bind(claimStore);
    claimStore.release = (args) => {
      const result = realRelease(args);

      if (
        args?.taskId === 'task-x-1' &&
        args?.ownerId === ownerId
      ) {
        resolveOriginalRelease();
      }

      return result;
    };

    const started = jsonOf(
      await server.tools.get('x_start').handler({
        task: taskFor(item),
      }),
    );

    const signal = await waiting.entered;

    const active = claimStore.getActiveClaim('task-x-1');
    assert.ok(active);

    const leaseId = active.leaseId;

    assert.equal(
      intruder.release({
        taskId: 'task-x-1',
        ownerId: 'not-the-real-owner',
        leaseId,
      }),
      false,
    );

    claimStore
      ._getDb()
      .prepare(
        'UPDATE x_task_claims SET lease_expires_at = ? WHERE task_id = ?',
      )
      .run(Date.now() - 1000, 'task-x-1');

    const stolen = intruder.claim({
      taskId: 'task-x-1',
      ownerId: 'intruder',
      leaseDurationMs: 5000,
    });

    assert.ok(stolen);

    // Ownership loss itself.
    await waitForAbort(signal, 2000);
    assert.equal(signal.aborted, true);

    // Deterministically prove the original run reached its final cleanup.
    await withTimeout(
      originalReleaseAttempted,
      2000,
      'the original run cleanup release attempt',
    );

    // Flush promise reactions, including admitted.done.then(...).
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(
      terminalEventsOf(calls).length,
      0,
      'ownership loss must not emit x_run_terminal',
    );

    assert.equal(
      runStore.getRun(started.run_id).status,
      'running',
      'ownership loss must leave the persisted run nonterminal',
    );

    intruder.release({
      taskId: 'task-x-1',
      ownerId: 'intruder',
      leaseId: stolen.leaseId,
    });
  });
});

test('EVT7 persistence_error emits nothing, even though the row was genuinely written', async () => {
  const item = fixture();
  const calls = [];
  await withMockedProcessSend((msg) => calls.push(msg), async () => {
    const { server, runStore } = registerFor(item, { modelAdapter: model([create()]) });
    const realComplete = runStore.completeRunFenced.bind(runStore);
    runStore.completeRunFenced = (args) => {
      realComplete(args);
      throw new Error('post-write readback failed');
    };
    const started = jsonOf(await server.tools.get('x_start').handler({ task: taskFor(item) }));
    await sleep(200);

    // The row genuinely reached 'completed' (the real write happened before
    // the injected throw) -- but runXTask's own outcome carries run: null
    // for this path, so no event may be emitted for it.
    assert.equal(runStore.getRun(started.run_id).status, 'completed');
    assert.equal(terminalEventsOf(calls).length, 0, 'a post-write throw must not be treated as a safe-to-notify terminal outcome');
  });
});

// ── 8-10: notification-failure safety ───────────────────────────────────────

test('EVT8 process.send unavailable is harmless', async () => {
  const item = fixture();
  await withoutProcessSend(async () => {
    assert.equal(typeof process.send, 'undefined');
    const { server, runStore } = registerFor(item, { modelAdapter: model([create()]) });
    const started = jsonOf(await server.tools.get('x_start').handler({ task: taskFor(item) }));
    const final = await pollUntilTerminal(server, started.run_id);
    assert.equal(final.status, 'completed');
    assert.equal(runStore.getRun(started.run_id).status, 'completed');
  });
});

test('EVT9 process.send throwing is harmless', async () => {
  const item = fixture();
  let unhandled = null;
  const onUnhandled = (err) => { unhandled = err; };
  process.on('unhandledRejection', onUnhandled);
  try {
    await withMockedProcessSend(() => { throw new Error('IPC channel broken'); }, async () => {
      const { server, runStore } = registerFor(item, { modelAdapter: model([create()]) });
      const started = jsonOf(await server.tools.get('x_start').handler({ task: taskFor(item) }));
      const final = await pollUntilTerminal(server, started.run_id);
      assert.equal(final.status, 'completed', 'a throwing process.send must not affect x_task’s own reported status');
      assert.equal(runStore.getRun(started.run_id).status, 'completed');
    });
    await sleep(20);
    assert.equal(unhandled, null, 'a throwing process.send must never produce an unhandled rejection');
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
});

test('EVT10 notification failure never changes persisted x_runs truth', async () => {
  const item = fixture();
  await withMockedProcessSend(() => { throw new Error('IPC channel broken'); }, async () => {
    const { server, runStore } = registerFor(item, { modelAdapter: model([create('src/.env')]) });
    // Write authority required so this deliberately protected-path action
    // actually reaches PROTECTED_PATH/NEEDS_REVIEW instead of being
    // discarded by the read-only authority boundary.
    const task = taskFor(item, 'task-x-1', { allowedTools: ['repo_read', 'repo_edit'] });
    const started = jsonOf(await server.tools.get('x_start').handler({ task }));
    await pollUntilTerminal(server, started.run_id);
    const persisted = runStore.getRun(started.run_id);
    assert.equal(persisted.status, 'needs_review');
    assert.equal(persisted.gateStatus, 'NEEDS_REVIEW');
    assert.ok(persisted.result, 'the persisted x-result-v1 must be intact despite the notification failure');
  });
});

// ── 11: existing x_start/x_task behavior unchanged ──────────────────────────

test('EVT11 existing x_start/x_task behavior is unchanged by the new emission hook', async () => {
  const item = fixture();
  const controlled = controllableModel([create()]);
  const { server, runStore } = registerFor(item, { modelAdapter: controlled });
  const started = jsonOf(await server.tools.get('x_start').handler({ task: taskFor(item) }));
  assert.equal(started.accepted, true);
  assert.equal(typeof started.run_id, 'string');
  assert.equal(started.task_id, 'task-x-1');
  assert.equal(started.status, 'running');
  await controlled.entered;

  const running = jsonOf(await server.tools.get('x_task').handler({ run_id: started.run_id }));
  assert.equal(running.status, 'running');
  assert.equal(running.result, null);
  controlled.release();

  const final = await pollUntilTerminal(server, started.run_id);
  assert.equal(final.status, 'completed');
  assert.equal(final.gate_status, 'COMPLETED');
  assert.equal(final.hearth_outcome, 'completed');
  assert.equal(final.result.task_id, 'task-x-1');
  assert.equal(runStore.getRun(started.run_id).status, 'completed');

  // Admission denial still behaves exactly as before.
  const item2 = fixture();
  const outsideClaims = new XClaimStore({ storagePath: item2.dbPath });
  item2.stores.push(outsideClaims);
  outsideClaims.claim({ taskId: 'task-x-1', ownerId: 'someone-else' });
  const { server: server2 } = registerFor(item2);
  const denied = jsonOf(await server2.tools.get('x_start').handler({ task: taskFor(item2) }));
  assert.deepEqual(denied, { accepted: false, reason: 'no_capacity', run_id: null });
});

// ── 12: Electron relay recognizes x_run_terminal without a second transport ─

test('EVT12 Electron relay recognizes x_run_terminal via the existing serverProcess message bus, alongside (not instead of) the approval relay', async () => {
  // electron/main.cjs requires the real `electron` module (app, dialog,
  // ipcMain, ...) and is designed to run only inside a live Electron main
  // process, so it cannot be `require`d here. This asserts the actual
  // shipped source text's structure instead -- the same technique already
  // used elsewhere in this suite (e.g. scripts/test-test-runner.mjs) to
  // verify shape without executing an environment-locked module.
  const source = fs.readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');

  // `async` is permitted on the handler: several relayed request types await
  // main-side services. What this asserts is the handler's identity and shape,
  // not whether it happens to be synchronous.
  const handlerMatch = source.match(/serverProcess\.on\('message',\s*(?:async\s+)?\(message\)\s*=>\s*\{([\s\S]*?)\n {2}\}\);/);
  assert.ok(handlerMatch, 'the existing serverProcess.on(\'message\', ...) handler must still be present and singular');
  const handlerBody = handlerMatch[1];

  // Exactly one such handler registration exists -- no second event bus.
  const registrationCount = (source.match(/serverProcess\.on\('message',/g) || []).length;
  assert.equal(registrationCount, 1, 'must not introduce a second serverProcess message-listener/transport');

  assert.match(
    handlerBody,
    /message\?\.type === 'approval'\)\s*sendEvent\(message\)/,
    'the pre-existing approval relay must be untouched',
  );

  assert.match(
    handlerBody,
    /if\s*\(message\?\.type === 'x_run_terminal'\)\s*\{[\s\S]*?sendEvent\(message\);[\s\S]*?xQueueCoordinator\?\.onXRunTerminal\(message\);[\s\S]*?\}/,
    'x_run_terminal must both be relayed through the same sendEvent bus AND forwarded to xQueueCoordinator.onXRunTerminal',
  );

  // Both branches route through the one existing `sendEvent` function --
  // grep the whole file for a second, different relay target to rule out.
  const sendEventDefinitions = (source.match(/const sendEvent = /g) || []).length;
  assert.equal(sendEventDefinitions, 1, 'only one sendEvent transport must exist');
});
