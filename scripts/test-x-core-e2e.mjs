import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseXTask, X_TASK_VERSION } from '../mcp/x/task-contract.mjs';
import { runTaskWithRepair } from '../mcp/x/repair-loop.mjs';
import { evaluateResultGate } from '../mcp/x/result-gate.mjs';
import { buildXResult } from '../mcp/x/result-builder.mjs';

/**
 * Core X E2E: proves the real pipeline composes correctly across module
 * boundaries --
 *
 *   parseXTask -> runTaskWithRepair -> evaluateResultGate -> buildXResult
 *
 * Every module here is the real, unmodified Phase 3/6/7/8/9 implementation
 * running real file I/O against a real temporary workspace. The only fake
 * is the ModelAdapter -- a deterministic, queued, offline fixture (no
 * Ollama, no network) that tests X's own orchestration/contracts, not
 * model quality. This composition exists only in this test file; no
 * production "pipeline" module is added, since nothing in Phases 1-9 calls
 * this chain in production yet.
 */

const dirs = [];
function tmpWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-x-e2e-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeFile(root, relPath, content) {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

/** Canonical x-task-v1 raw shape (matches the fixture proven valid in scripts/test-x-task-contract.mjs's own TASK1/TASK2). */
const rawTask = (root, overrides = {}) => ({
  version: X_TASK_VERSION,
  task_id: 'TASK-E2E-1',
  parent_task_id: null,
  revision: 1,
  attempt: 1,
  based_on_result_id: null,
  objective: 'Prove the Core X pipeline end to end.',
  problem: 'No end-to-end test proves the real modules compose correctly.',
  expected_behavior: 'The real pipeline produces correct, contract-consistent evidence.',
  observed_behavior: 'Only unit-level tests exist per module.',
  why_this_matters: 'Cross-module composition bugs are invisible to per-module tests.',
  known_evidence: [],
  suspected_area: [],
  workspace: { repo: 'Hearth-Control', root },
  scope: { allowed_paths: ['src'], preferred_files: [], forbidden_paths: [] },
  constraints: { preserve: [], do_not: [] },
  allowed_tools: ['repo_read'],
  acceptance_criteria: ['The pipeline reaches a deterministic terminal gate state.'],
  validation: { required: [], optional: [] },
  verification: null,
  done_criteria: ['Deterministic evidence is returned.'],
  teaching_notes: [],
  uncertainty_policy: { policy: 'bounded_autonomy', stop_conditions: [] },
  repair_budget: { initial_attempts: 1, max_repairs: 2, max_total_rounds: 3 },
  timing: { estimated_minutes: 5, first_check_after_minutes: 1, soft_deadline_minutes: 3, hard_timeout_minutes: 10 },
  commit_policy: { mode: 'never' },
  ...overrides,
});

/** Deterministic fake ModelAdapter: one queued JSON response per call (the last repeats if exhausted), records every request. No live Ollama/network involved. */
function queueAdapter(responses) {
  const calls = [];
  return {
    calls,
    generate: async (request) => {
      calls.push(request);
      const payload = responses[Math.min(calls.length - 1, responses.length - 1)];
      return {
        ok: true, provider: 'fake', model: 'fake-model', requestedModel: null,
        text: JSON.stringify(payload), finishReason: 'stop', usage: null, error: null,
      };
    },
  };
}

const promptOf = (request) => request.messages[1].content;

/** The approved test-only Core E2E composition. All four steps are the real Phase 3/6-7/8/9 modules; only the ModelAdapter is a deterministic fake. */
async function runPipeline(root, taskOverrides, adapter) {
  const task = parseXTask(rawTask(root, taskOverrides));
  const repairOutcome = await runTaskWithRepair(task, adapter);
  const gateResult = evaluateResultGate(repairOutcome);
  const xResult = buildXResult(task, repairOutcome, gateResult);
  return { task, repairOutcome, gateResult, xResult };
}

// ---------------------------------------------------------------------------
// A. Straight success
// ---------------------------------------------------------------------------

test('A. Straight success: safe edit + passing required validation -> COMPLETED end to end', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFile(root, 'scripts/test-pass.mjs', "import test from 'node:test';\ntest('ok', () => {});\n");
  const adapter = queueAdapter([{ actions: [{ type: 'create', path: 'src/hello.js', content: 'export const hello = 1;\n' }] }]);

  const { task, repairOutcome, gateResult, xResult } = await runPipeline(
    root,
    {
      allowed_tools: ['repo_read', 'repo_edit'],
      validation: { required: ['node --test scripts/test-pass.mjs'], optional: [] },
    },
    adapter,
  );

  // The real file was actually written with the expected content.
  assert.equal(fs.readFileSync(path.join(root, 'src/hello.js'), 'utf8'), 'export const hello = 1;\n');

  assert.equal(repairOutcome.status, 'validated');
  assert.equal(gateResult.gate_status, 'COMPLETED');
  assert.equal(gateResult.hearth_outcome, 'completed');

  assert.equal(xResult.task_id, task.task_id);
  assert.equal(xResult.gate_status, 'COMPLETED');
  assert.equal(xResult.hearth_outcome, 'completed');
  assert.equal(xResult.repair_attempts, 0);
  assert.deepEqual([...xResult.files_changed], ['src/hello.js']);
  assert.equal(xResult.validation.length, 1);
  assert.deepEqual({ ...xResult.validation[0] }, {
    name: 'node --test scripts/test-pass.mjs', required: true, status: 'passed',
    exit_code: 0, failure_origin: null, stdout_ref: null, stderr_ref: null,
  });
});

// ---------------------------------------------------------------------------
// B. Repair success
// ---------------------------------------------------------------------------

test('B. Repair success: round 2 sees the round-1 file, final validation passes -> COMPLETED, repair_attempts 1', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFile(root, 'scripts/test-check-newfile.mjs', [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "test('newfile has the expected content', () => {",
    "  const content = fs.readFileSync(path.join(process.cwd(), 'src', 'newfile.js'), 'utf8');",
    "  assert.equal(content, 'patched');",
    '});',
  ].join('\n'));
  const adapter = queueAdapter([
    { actions: [{ type: 'create', path: 'src/newfile.js', content: 'original' }] },   // round 1: validation fails (not 'patched' yet)
    { actions: [{ type: 'patch', path: 'src/newfile.js', edits: [{ old_string: 'original', new_string: 'patched' }] }] }, // round 2
  ]);

  const { repairOutcome, gateResult, xResult } = await runPipeline(
    root,
    {
      allowed_tools: ['repo_read', 'repo_edit'],
      validation: { required: ['node --test scripts/test-check-newfile.mjs'], optional: [] },
    },
    adapter,
  );

  assert.equal(repairOutcome.status, 'validated');
  assert.equal(repairOutcome.total_rounds, 2);
  assert.equal(repairOutcome.rounds[0].validation.required[0].status, 'failed');
  assert.equal(repairOutcome.rounds[1].validation.required[0].status, 'passed');
  assert.equal(fs.readFileSync(path.join(root, 'src/newfile.js'), 'utf8'), 'patched');

  // Round 2's actual model prompt contains the round-1-created file and its
  // content -- real cross-round context continuity, not an assumption.
  assert.equal(adapter.calls.length, 2);
  assert.match(promptOf(adapter.calls[1]), /src\/newfile\.js/);
  assert.match(promptOf(adapter.calls[1]), /original/);

  assert.equal(gateResult.gate_status, 'COMPLETED');
  assert.equal(xResult.gate_status, 'COMPLETED');
  assert.equal(xResult.hearth_outcome, 'completed');
  assert.equal(xResult.repair_attempts, 1);

  // x-result-v1 validation reflects the FINAL round only -- never round 1's
  // recorded failure, even though that round genuinely happened.
  assert.equal(xResult.validation.length, 1);
  assert.equal(xResult.validation[0].status, 'passed');

  assert.deepEqual([...xResult.files_changed], ['src/newfile.js']);
});

// ---------------------------------------------------------------------------
// C. Safety boundary
// ---------------------------------------------------------------------------

test('C. Safety boundary: PROTECTED_PATH (src/.env) is refused pre-mutation -> NEEDS_REVIEW/safety_boundary_review', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFile(root, 'scripts/test-pass.mjs', "import test from 'node:test';\ntest('ok', () => {});\n");
  const adapter = queueAdapter([{ actions: [{ type: 'create', path: 'src/.env', content: 'SECRET=1' }] }]);

  assert.equal(fs.existsSync(path.join(root, 'src/.env')), false);

  const { repairOutcome, gateResult, xResult } = await runPipeline(
    root,
    {
      allowed_tools: ['repo_read', 'repo_edit'],
      validation: { required: ['node --test scripts/test-pass.mjs'], optional: [] },
    },
    adapter,
  );

  // The protected target was never created -- refused before any mutation.
  assert.equal(fs.existsSync(path.join(root, 'src/.env')), false);

  assert.equal(repairOutcome.status, 'escalation_required');
  assert.equal(repairOutcome.rounds[0].classification, 'escalate');
  assert.equal(repairOutcome.rounds[0].executor.blockers[0].code, 'PROTECTED_PATH');

  assert.equal(gateResult.gate_status, 'NEEDS_REVIEW');
  assert.equal(gateResult.hearth_outcome, 'waiting');
  assert.equal(gateResult.reason_code, 'safety_boundary_review');
  assert.equal(gateResult.waiting_reason, 'supervisor_review');

  assert.equal(xResult.gate_status, 'NEEDS_REVIEW');
  assert.equal(xResult.hearth_outcome, 'waiting');
  assert.equal(xResult.reason_code, 'safety_boundary_review');
  assert.equal(xResult.waiting_reason, 'supervisor_review');
});

// ---------------------------------------------------------------------------
// D. Structural failure
// ---------------------------------------------------------------------------

test('D. Structural failure: out-of-scope write (PATH_REJECTED) -> FAILED/structural_execution_failure', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'other'), { recursive: true });
  writeFile(root, 'scripts/test-pass.mjs', "import test from 'node:test';\ntest('ok', () => {});\n");
  const adapter = queueAdapter([{ actions: [{ type: 'create', path: 'other/new.js', content: 'x' }] }]); // 'other' is outside scope.allowed_paths=['src']

  const { repairOutcome, gateResult, xResult } = await runPipeline(
    root,
    {
      allowed_tools: ['repo_read', 'repo_edit'],
      validation: { required: ['node --test scripts/test-pass.mjs'], optional: [] },
    },
    adapter,
  );

  // The out-of-scope target was never created.
  assert.equal(fs.existsSync(path.join(root, 'other/new.js')), false);

  assert.equal(repairOutcome.status, 'escalation_required');
  assert.equal(repairOutcome.rounds[0].classification, 'escalate');
  assert.equal(repairOutcome.rounds[0].executor.blockers[0].code, 'PATH_REJECTED');

  assert.equal(gateResult.gate_status, 'FAILED');
  assert.equal(gateResult.hearth_outcome, 'error');
  assert.equal(gateResult.reason_code, 'structural_execution_failure');
  assert.equal(gateResult.evidence.blocker.code, 'PATH_REJECTED');

  assert.equal(xResult.gate_status, 'FAILED');
  assert.equal(xResult.hearth_outcome, 'error');
  assert.equal(xResult.reason_code, 'structural_execution_failure');
});

// ---------------------------------------------------------------------------
// E. Secret containment
// ---------------------------------------------------------------------------

test('E. Secret containment: a fake secret in known_evidence never reaches the model prompt or the final x-result-v1', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFile(root, 'scripts/test-pass.mjs', "import test from 'node:test';\ntest('ok', () => {});\n");
  const fakeSecret = 'Bearer FAKE1234567890abcdefghijklmno-TESTTOKEN'; // fake shape only, never a real credential
  const adapter = queueAdapter([{ actions: [{ type: 'create', path: 'src/ok.js', content: 'export const ok = 1;\n' }] }]);

  const { task, repairOutcome, gateResult, xResult } = await runPipeline(
    root,
    {
      allowed_tools: ['repo_read', 'repo_edit'],
      known_evidence: [`leaked in logs: ${fakeSecret}`],
      validation: { required: ['node --test scripts/test-pass.mjs'], optional: [] },
    },
    adapter,
  );

  // Sanity: the fake secret genuinely exists in the raw task evidence
  // (proves this is a real containment test, not a no-op).
  assert.ok(task.known_evidence[0].includes(fakeSecret));

  // Phase 5A's Context Loader redacts it before it ever reaches the model prompt.
  assert.equal(adapter.calls.length, 1);
  const prompt = promptOf(adapter.calls[0]);
  assert.ok(!prompt.includes(fakeSecret));
  assert.ok(prompt.includes('Bearer [REDACTED]'));

  // The task still completes normally...
  assert.equal(repairOutcome.status, 'validated');
  assert.equal(gateResult.gate_status, 'COMPLETED');

  // ...and Phase 9's Result Builder redacts the same secret again on the way
  // into x-result-v1: it is absent from the entire serialized result.
  const serialized = JSON.stringify(xResult);
  assert.ok(!serialized.includes(fakeSecret));
});

test('F. Read-only task: repo_read only -> empty actions -> COMPLETED without writes', async () => {
  const root = tmpWorkspace();
  writeFile(root, 'scripts/test-pass.mjs', "import test from 'node:test';\ntest('ok', () => {});\n");
  const adapter = queueAdapter([{ actions: [] }]);

  const { task, repairOutcome, gateResult, xResult } = await runPipeline(
    root,
    {
      allowed_tools: ['repo_read'],
      validation: { required: ['node --test scripts/test-pass.mjs'], optional: [] },
    },
    adapter,
  );

  assert.equal(repairOutcome.status, 'validated');
  assert.equal(gateResult.gate_status, 'COMPLETED');
  assert.deepEqual([...xResult.files_changed], []);
});

test('G. Read-only task: unauthorized create attempt fails closed with PERMISSION_DENIED', async () => {
  const root = tmpWorkspace();
  writeFile(root, 'scripts/test-pass.mjs', "import test from 'node:test';\ntest('ok', () => {});\n");
  const adapter = queueAdapter([{ actions: [{ type: 'create', path: 'src/bad.js', content: 'no\n' }] }]);

  const { repairOutcome, gateResult, xResult } = await runPipeline(
    root,
    {
      allowed_tools: ['repo_read'],
      validation: { required: ['node --test scripts/test-pass.mjs'], optional: [] },
    },
    adapter,
  );

  assert.equal(fs.existsSync(path.join(root, 'src/bad.js')), false);
  assert.equal(repairOutcome.status, 'escalation_required');
  assert.equal(gateResult.gate_status, 'FAILED');
  assert.equal(gateResult.reason_code, 'structural_execution_failure');
  assert.equal(gateResult.evidence.blocker.code, 'PERMISSION_DENIED');
  assert.equal(xResult.gate_status, 'FAILED');
});
