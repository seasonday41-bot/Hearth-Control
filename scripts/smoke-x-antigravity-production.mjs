// Production smoke for the X v1 runtime and the shared X/Antigravity
// execution-admission slot, exercised through the REAL production entry
// paths -- not the focused unit tests.
//
// Real, unmodified production code used here:
//   - mcp/x/runtime-paths.mjs        resolveHearthRuntimeDatabasePath()
//   - mcp/x/production-runtime.mjs   getProductionXRuntime() (real singleton,
//                                    real XClaimStore/XRunStore, real
//                                    startup reconciliation)
//   - mcp/tools.mjs                  registerWorkspaceTools() -- the exact
//                                    function that wires x_start/x_task and
//                                    antigravity_start in every real MCP
//                                    process (forked HTTP server, stdio)
//   - mcp/executors/antigravity.mjs  startAntigravityTask() -- the exact
//                                    function every real Antigravity entry
//                                    point (Electron IPC, bridge, goals,
//                                    the MCP tool) funnels through
//   - mcp/executors/antigravity-admission.mjs  getProductionAntigravityClaimStore()
//
// The only substitutions are leaf dependencies, matching this repo's own
// established "real pipeline, fake leaf" convention (see
// scripts/test-x-core-e2e.mjs and scripts/test-x-mcp-tools.mjs):
//   - X's ModelAdapter is ALWAYS a deterministic, fast/controllable fake
//     here (never the real Ollama-backed adapter, even though `xRuntime`
//     carries a real one) -- this smoke proves the RUNTIME/admission
//     plumbing, not model quality, and must be fast and deterministic to
//     be a bounded smoke. Every x_start call below explicitly overrides
//     `modelAdapter` for this reason.
//   - Antigravity's `runner` is a deterministic, controllable fake (no real
//     `agy` process spawn) -- same reasoning, and matches the exact
//     single-shot-runner code path scripts/test-antigravity.mjs's own
//     "R3. successful start transitions through lifecycle to done" already
//     uses to prove startAntigravityTask's real production logic.
//
// All state lives under a throwaway HEARTH_RUNTIME_DIR (never the real
// user's ~/.hearth-control) but every module still resolves that path
// itself, through the same resolver production uses.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-prod-smoke-'));
const runtimeDir = path.join(smokeRoot, 'runtime');
fs.mkdirSync(runtimeDir, { recursive: true });
process.env.HEARTH_RUNTIME_DIR = runtimeDir;

const { resolveHearthRuntimeDatabasePath } = await import('../mcp/x/runtime-paths.mjs');
const { getProductionXRuntime, __resetProductionXRuntimeForTests } = await import('../mcp/x/production-runtime.mjs');
const {
  getProductionAntigravityClaimStore,
  __resetProductionAntigravityClaimStoreForTests,
} = await import('../mcp/executors/antigravity-admission.mjs');
const { registerWorkspaceTools } = await import('../mcp/tools.mjs');
const { startAntigravityTask, taskRegistry, getAntigravityTask } = await import('../mcp/executors/antigravity.mjs');
const { XClaimStore } = await import('../mcp/x/claim-store.mjs');
const { X_TASK_VERSION } = await import('../mcp/x/task-contract.mjs');

const expectedDbPath = resolveHearthRuntimeDatabasePath();

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(smokeRoot, 'ws-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts/test-pass.mjs'), "import test from 'node:test';\ntest('passes', () => {});\n");
  return root;
}

// ── shared X-side helpers (mirrors scripts/test-x-mcp-tools.mjs) ───────────

function fakeServer() {
  const tools = new Map();
  return { tools, registerTool(name, config, handler) { tools.set(name, { config, handler }); } };
}
const jsonOf = (toolResult) => JSON.parse(toolResult.content[0].text);

async function pollUntilTerminal(server, runId, { timeoutMs = 5000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = jsonOf(await server.tools.get('x_task').handler({ run_id: runId }));
    if (['completed', 'needs_review', 'failed', 'interrupted'].includes(response.status)) return response;
    if (Date.now() > deadline) throw new Error(`timed out waiting for run '${runId}' to reach a terminal status`);
    await sleep(intervalMs);
  }
}

function xTaskFor(root, taskId) {
  return {
    version: X_TASK_VERSION, task_id: taskId, parent_task_id: null,
    revision: 1, attempt: 1, based_on_result_id: null,
    objective: 'Production smoke: prove the real X pipeline runs end to end.',
    problem: 'Only focused/unit tests have proven X’s pipeline; production entry paths need direct proof.',
    expected_behavior: 'x_start/x_task expose the real fenced X pipeline against the real runtime DB.',
    observed_behavior: 'No production smoke exists yet.',
    why_this_matters: 'Passing unit tests do not prove the real wiring (paths, singletons, shared admission) works.',
    known_evidence: [], suspected_area: [], workspace: { repo: 'Hearth-Control', root },
    scope: { allowed_paths: ['src'], preferred_files: [], forbidden_paths: [] },
    constraints: { preserve: [], do_not: [] }, allowed_tools: ['repo_read'],
    acceptance_criteria: ['The run is fenced and reaches a real terminal state.'],
    validation: { required: ['node --test scripts/test-pass.mjs'], optional: [] },
    verification: null, done_criteria: ['Deterministic evidence is returned.'], teaching_notes: [],
    uncertainty_policy: { policy: 'bounded_autonomy', stop_conditions: [] },
    repair_budget: { initial_attempts: 1, max_repairs: 2, max_total_rounds: 3 },
    timing: { estimated_minutes: 5, first_check_after_minutes: 1, soft_deadline_minutes: 3, hard_timeout_minutes: 10 },
    commit_policy: { mode: 'never' },
  };
}
const create = (pathName = 'src/ok.js') => ({ type: 'create', path: pathName, content: 'ok\n' });
const fastModel = (actions = []) => ({
  async generate() {
    return { ok: true, provider: 'fake', model: 'fake', text: JSON.stringify({ actions }), finishReason: 'stop', usage: null, error: null };
  },
});
/** A ModelAdapter whose generate() pauses until externally released -- proves timing-sensitive admission/reconciliation behavior without depending on real Ollama latency. */
function controllableModel(actions = []) {
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  let markEntered;
  const entered = new Promise((resolve) => { markEntered = resolve; });
  return {
    entered,
    release: () => releaseGate(),
    async generate() {
      markEntered();
      await gate;
      return { ok: true, provider: 'fake', model: 'fake', text: JSON.stringify({ actions }), finishReason: 'stop', usage: null, error: null };
    },
  };
}

// ── shared Antigravity-side helper ──────────────────────────────────────

/** Single-shot fake runner -- the exact non-spawn code path
 * scripts/test-antigravity.mjs's "R3" test uses to reach a real 'done'
 * through startAntigravityTask's own unmodified production logic. Pauses
 * until externally released, so admission-timing scenarios are
 * deterministic rather than racing real process I/O. */
function controllableAgyRunner() {
  const conversationId = 'smoke-conv-' + Math.random().toString(36).slice(2);
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  let markEntered;
  const entered = new Promise((resolve) => { markEntered = resolve; });
  return {
    entered,
    release: () => releaseGate(),
    async run() {
      markEntered();
      await gate;
      return {
        stdout: [
          JSON.stringify({ event: 'init', conversation_id: conversationId }),
          JSON.stringify({
            event: 'result',
            result: {
              conversation_id: conversationId, status: 'SUCCESS',
              response: '```json\n{"status":"completed","summary":"Smoke task finished."}\n```',
            },
          }),
        ].join('\n'),
        stderr: '',
      };
    },
  };
}

after(() => {
  __resetProductionXRuntimeForTests();
  __resetProductionAntigravityClaimStoreForTests();
  fs.rmSync(smokeRoot, { recursive: true, force: true });
});

// ── 1: real production runtime SQLite path is used ─────────────────────────

let xRuntime;
test('SMOKE1 real production runtime SQLite path is used and shared with Antigravity', async () => {
  assert.equal(fs.existsSync(expectedDbPath), false, 'no DB file should exist before first production use');
  xRuntime = getProductionXRuntime();
  assert.equal(xRuntime.claimStore.storagePath, expectedDbPath);
  assert.equal(xRuntime.runStore.storagePath, expectedDbPath);
  assert.equal(typeof xRuntime.ownerId, 'string');
  assert.ok(xRuntime.ownerId.startsWith('mcp-'));

  const agClaimStore = getProductionAntigravityClaimStore();
  assert.equal(agClaimStore.storagePath, expectedDbPath, 'Antigravity must resolve the exact same shared file X does');

  assert.equal(fs.existsSync(expectedDbPath), true, 'the real production SQLite file must now exist on disk');
});

// ── 2, 3, 4, 11: x_start -> x_task full lifecycle + claim lifecycle ─────────

test('SMOKE2 x_start starts a real X task, x_task observes running -> completed, claim lifecycle is correct, no stale claim remains', async () => {
  const root = makeWorkspace();
  const server = fakeServer();
  registerWorkspaceTools(server, {
    workspace: root,
    permissions: {},
    xRuntime: {
      ...xRuntime,
      modelAdapter: fastModel([create('src/smoke-complete.js')]),
    },
  });

  assert.equal(xRuntime.claimStore.getActiveClaim('smoke-task-1'), null, 'no claim should be active before x_start');

  const started = jsonOf(await server.tools.get('x_start').handler({ task: xTaskFor(root, 'smoke-task-1') }));
  assert.equal(started.accepted, true);
  assert.equal(typeof started.run_id, 'string');

  const activeClaim = xRuntime.claimStore.getActiveClaim('smoke-task-1');
  assert.ok(activeClaim, 'a real claim must be active immediately after x_start');
  assert.equal(activeClaim.taskId, 'smoke-task-1');

  const running = jsonOf(await server.tools.get('x_task').handler({ run_id: started.run_id }));
  assert.equal(running.status, 'running');

  const final = await pollUntilTerminal(server, started.run_id);
  assert.equal(final.status, 'completed');
  assert.equal(final.gate_status, 'COMPLETED');
  assert.ok(final.result, 'a real persisted x-result-v1 must be present');

  assert.equal(xRuntime.claimStore.getActiveClaim('smoke-task-1'), null, 'the claim must be released after terminal completion -- no stale claim remains');
});

// ── 5: startup reconciliation does not disturb a live task ─────────────────

test('SMOKE3 startup reconciliation does not disturb a genuinely live task', async () => {
  const root = makeWorkspace();
  const server = fakeServer();
  const liveModel = controllableModel([create('src/live.js')]);
  registerWorkspaceTools(server, { workspace: root, permissions: {}, xRuntime: { ...xRuntime, modelAdapter: liveModel } });

  const started = jsonOf(await server.tools.get('x_start').handler({ task: xTaskFor(root, 'smoke-task-live') }));
  await liveModel.entered;

  const beforeClaim = xRuntime.claimStore.getActiveClaim('smoke-task-live');
  assert.ok(beforeClaim, 'the live task’s claim must be active');

  // Simulate a process restart while this run is still genuinely executing:
  // reset the production singleton and reconstruct it, exactly as a fresh
  // process boot would.
  __resetProductionXRuntimeForTests();
  const restarted = getProductionXRuntime();
  assert.equal(restarted.claimStore.storagePath, expectedDbPath, 'restart must resolve the same shared file');

  const afterRun = restarted.runStore.getRun(started.run_id);
  assert.equal(afterRun.status, 'running', 'a genuinely live run must remain running through reconciliation, never interrupted');
  const afterClaim = restarted.claimStore.getActiveClaim('smoke-task-live');
  assert.ok(afterClaim, 'the live claim must still be active after reconciliation');
  assert.equal(afterClaim.leaseId, beforeClaim.leaseId, 'reconciliation must not touch a genuinely live claim’s lease identity');

  // Drain it to a real terminal state before moving on, using the
  // reconstructed (current production) runtime.
  const server2 = fakeServer();
  registerWorkspaceTools(server2, { workspace: root, permissions: {}, xRuntime: restarted });
  liveModel.release();
  const final = await pollUntilTerminal(server2, started.run_id);
  assert.equal(final.status, 'completed');

  xRuntime = restarted;
});

// ── 6: crash/restart-style stale run becomes interrupted ───────────────────

test('SMOKE4 a crash/restart-style stale run becomes interrupted on the next production startup', async () => {
  const orphanedLeaseId = 'orphaned-lease-smoke';
  xRuntime.runStore.createRun({ runId: 'smoke-stale-run', taskId: 'smoke-task-stale', claimLeaseId: orphanedLeaseId });
  xRuntime.runStore.markRunning({ runId: 'smoke-stale-run', claimLeaseId: orphanedLeaseId });
  // No matching claim row exists for this lease at all -- simulating a
  // process that crashed before ever renewing (or whose claim already
  // expired), exactly like X's own S1/S2 unit coverage, but proven here
  // through the real production restart entry point.
  assert.equal(xRuntime.claimStore.getActiveClaim('smoke-task-stale'), null);

  __resetProductionXRuntimeForTests();
  const restarted = getProductionXRuntime();
  const reconciled = restarted.runStore.getRun('smoke-stale-run');
  assert.equal(reconciled.status, 'interrupted', 'a stale run with no live claim must become interrupted on production restart');

  xRuntime = restarted;
});

// ── 7, 8, 9, 10: mutual X/Antigravity admission through production wiring ──

let agHandle1;
test('SMOKE5 X active blocks Antigravity from starting (production claimStore wiring)', async () => {
  const root = makeWorkspace();
  const server = fakeServer();
  const xModel = controllableModel([create('src/xblock.js')]);
  registerWorkspaceTools(server, { workspace: root, permissions: {}, xRuntime: { ...xRuntime, modelAdapter: xModel } });

  const started = jsonOf(await server.tools.get('x_start').handler({ task: xTaskFor(root, 'smoke-task-blocks-ag') }));
  await xModel.entered;
  assert.equal(started.accepted, true);

  await assert.rejects(
    () => startAntigravityTask({
      workspace: root, prompt: 'Should be denied while X holds the slot.',
      customAgyPath: process.execPath, userApproved: true, awaitCompletion: false,
      runner: controllableAgyRunner().run, claimStore: xRuntime.claimStore,
    }),
    /shared execution slot is currently held/,
  );

  xModel.release();
  const final = await pollUntilTerminal(server, started.run_id);
  assert.equal(final.status, 'completed');
  assert.equal(xRuntime.claimStore.getActiveClaim('smoke-task-blocks-ag'), null, 'X’s claim must be released after it completes');
});

test('SMOKE6 after X releases, Antigravity can start; Antigravity active then blocks X (goal 9 + goal 7 reversed)', async () => {
  const root = makeWorkspace();
  agHandle1 = controllableAgyRunner();
  const startPromise = startAntigravityTask({
    workspace: root, prompt: 'Runs after X released the slot.',
    customAgyPath: process.execPath, userApproved: true, awaitCompletion: false,
    runner: agHandle1.run, claimStore: xRuntime.claimStore, existingTaskId: 'smoke-ag-task-1',
  });
  await agHandle1.entered;
  const res = await startPromise;
  assert.equal(res.taskId, 'smoke-ag-task-1');

  const agClaim = xRuntime.claimStore.getActiveClaim('antigravity:smoke-ag-task-1');
  assert.ok(agClaim, 'Antigravity’s real claim must be active while it runs');

  const server = fakeServer();
  const xServerModel = fastModel([create('src/should-not-run.js')]);
  registerWorkspaceTools(server, { workspace: root, permissions: {}, xRuntime: { ...xRuntime, modelAdapter: xServerModel } });
  const denied = jsonOf(await server.tools.get('x_start').handler({ task: xTaskFor(root, 'smoke-task-blocked-by-ag') }));
  assert.equal(denied.accepted, false);
  assert.deepEqual(denied, { accepted: false, reason: 'no_capacity', run_id: null });
});

test('SMOKE7 a second, independently-IDed Antigravity task is also denied while the first is active (goal 10)', async () => {
  const root = makeWorkspace();
  const second = controllableAgyRunner();
  await assert.rejects(
    () => startAntigravityTask({
      workspace: root, prompt: 'A second concurrent Antigravity task must be denied.',
      customAgyPath: process.execPath, userApproved: true, awaitCompletion: false,
      runner: second.run, claimStore: xRuntime.claimStore, existingTaskId: 'smoke-ag-task-2',
    }),
    /shared execution slot is currently held/,
  );
});

test('SMOKE8 releasing Antigravity allows X to start again (goal 8)', async () => {
  agHandle1.release();
  await sleep(80); // allow the fast-path onTaskTransition release to settle
  assert.equal(xRuntime.claimStore.getActiveClaim('antigravity:smoke-ag-task-1'), null, 'Antigravity’s claim must be released after it completes');
  const finalAgTask = getAntigravityTask('smoke-ag-task-1');
  assert.equal(finalAgTask.status, 'done');
  taskRegistry.delete('smoke-ag-task-1');

  const root = makeWorkspace();
  const server = fakeServer();
  registerWorkspaceTools(server, {
    workspace: root,
    permissions: {},
    xRuntime: {
      ...xRuntime,
      modelAdapter: fastModel([create('src/after-ag.js')]),
    },
  });
  const started = jsonOf(await server.tools.get('x_start').handler({ task: xTaskFor(root, 'smoke-task-after-ag') }));
  assert.equal(started.accepted, true, 'X must be able to start once Antigravity has released the shared slot');
  const final = await pollUntilTerminal(server, started.run_id);
  assert.equal(final.status, 'completed');
});

// ── 12: no terminal x-result is written after ownership loss ───────────────

test('SMOKE9 ownership loss leaves the run nonterminal and writes no x-result; reconciliation later marks it interrupted', async () => {
  const root = makeWorkspace();
  const server = fakeServer();
  const model = controllableModel([create('src/lost.js')]);
  registerWorkspaceTools(server, { workspace: root, permissions: {}, xRuntime: { ...xRuntime, modelAdapter: model } });

  const started = jsonOf(await server.tools.get('x_start').handler({ task: xTaskFor(root, 'smoke-task-ownership-loss') }));
  await model.entered;

  const claim = xRuntime.claimStore.getActiveClaim('smoke-task-ownership-loss');
  assert.ok(claim);

  // Force the lease into the past (without touching the in-flight run's own
  // in-memory keeper state) so an independent store instance can reclaim
  // it -- simulating this process going unresponsive long enough for its
  // lease to genuinely lapse while still mid-execution.
  xRuntime.claimStore._getDb().prepare('UPDATE x_task_claims SET lease_expires_at = ? WHERE task_id = ?')
    .run(Date.now() - 1000, 'smoke-task-ownership-loss');
  const intruder = new XClaimStore({ storagePath: expectedDbPath });
  const stolen = intruder.claim({ taskId: 'smoke-task-ownership-loss', ownerId: 'intruder-smoke', leaseDurationMs: 5000 });
  assert.ok(stolen, 'an independent store must be able to reclaim the now-expired lease');

  model.release();
  await sleep(200);

  const observed = jsonOf(await server.tools.get('x_task').handler({ run_id: started.run_id }));
  assert.equal(observed.status, 'running', 'ownership loss must leave the run nonterminal, not silently mark it complete');
  assert.equal(observed.result, null, 'no x-result may be persisted for a run that lost ownership');

  intruder.release({ taskId: 'smoke-task-ownership-loss', ownerId: 'intruder-smoke', leaseId: stolen.leaseId });
  intruder.close();

  __resetProductionXRuntimeForTests();
  const restarted = getProductionXRuntime();
  const reconciled = restarted.runStore.getRun(started.run_id);
  assert.equal(reconciled.status, 'interrupted', 'startup reconciliation must be what eventually resolves an ownership-lost run');
  assert.equal(reconciled.result, null);

  xRuntime = restarted;
});

// ── 13: existing Antigravity durable lifecycle still works, end to end ────

test('SMOKE10 a normal Antigravity task still completes end to end through the real production claimStore', async () => {
  const root = makeWorkspace();
  const runner = controllableAgyRunner();
  const startPromise = startAntigravityTask({
    workspace: root, prompt: 'Ordinary Antigravity lifecycle sanity check.',
    customAgyPath: process.execPath, userApproved: true, awaitCompletion: false,
    runner: runner.run, claimStore: xRuntime.claimStore, existingTaskId: 'smoke-ag-sanity',
  });
  await runner.entered;
  const res = await startPromise;
  runner.release();
  await sleep(80);
  const finalTask = getAntigravityTask(res.taskId);
  assert.equal(finalTask.status, 'done');
  assert.equal(xRuntime.claimStore.getActiveClaim('antigravity:smoke-ag-sanity'), null);
  taskRegistry.delete('smoke-ag-sanity');
});
