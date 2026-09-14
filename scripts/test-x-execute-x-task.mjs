import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseXTask, X_TASK_VERSION } from '../mcp/x/task-contract.mjs';
import { executeXTask } from '../mcp/x/execute-x-task.mjs';

const workspaces = [];
function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-x-execute-'));
  workspaces.push(root);
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'scripts/test-pass.mjs'), "import test from 'node:test';\ntest('ok', () => {});\n");
  return root;
}

afterEach(() => {
  for (const root of workspaces.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function taskFor(root) {
  return parseXTask({
    version: X_TASK_VERSION,
    task_id: 'TASK-EXECUTE-1',
    parent_task_id: null,
    revision: 1,
    attempt: 1,
    based_on_result_id: null,
    objective: 'Verify the production X composition.',
    problem: 'The Core X stages need a production composition entry point.',
    expected_behavior: 'Execution, gate, and result remain correlated.',
    observed_behavior: 'The stages currently have separate entry points.',
    why_this_matters: 'Callers need one result without duplicating Core X logic.',
    known_evidence: [],
    suspected_area: [],
    workspace: { repo: 'Hearth-Control', root },
    scope: { allowed_paths: ['src'], preferred_files: [], forbidden_paths: [] },
    constraints: { preserve: [], do_not: [] },
    allowed_tools: ['repo_read'],
    acceptance_criteria: ['A correlated X result is returned.'],
    validation: { required: ['node --test scripts/test-pass.mjs'], optional: [] },
    verification: null,
    done_criteria: ['Required validation passes.'],
    teaching_notes: [],
    uncertainty_policy: { policy: 'bounded_autonomy', stop_conditions: [] },
    repair_budget: { initial_attempts: 1, max_repairs: 2, max_total_rounds: 3 },
    timing: { estimated_minutes: 5, first_check_after_minutes: 1, soft_deadline_minutes: 3, hard_timeout_minutes: 10 },
    commit_policy: { mode: 'never' },
  });
}

function modelWith(action) {
  const calls = [];
  return {
    calls,
    async generate(request, options) {
      calls.push({ request, options });
      return {
        ok: true, provider: 'fake', model: 'fake-model', requestedModel: null,
        text: JSON.stringify({ actions: [action] }), finishReason: 'stop', usage: null, error: null,
      };
    },
  };
}

test('validated execution composes the real gate and result, forwards adapter/options, and preserves task', async () => {
  const root = workspace();
  const task = taskFor(root);
  const before = structuredClone(task);
  const adapter = modelWith({ type: 'create', path: 'src/ok.js', content: 'export const ok = true;\n' });
  const modelOptions = { temperature: 0.25 };

  const result = await executeXTask(task, adapter, { modelOptions });

  assert.deepEqual(Object.keys(result), ['repairOutcome', 'gateResult', 'xResult']);
  assert.equal(result.repairOutcome.status, 'validated');
  assert.equal(result.gateResult.gate_status, 'COMPLETED');
  assert.equal(result.gateResult.hearth_outcome, 'completed');
  assert.equal(result.xResult.gate_status, result.gateResult.gate_status);
  assert.equal(result.xResult.task_id, task.task_id);
  assert.deepEqual([...result.xResult.files_changed], ['src/ok.js']);
  assert.equal(fs.readFileSync(path.join(root, 'src/ok.js'), 'utf8'), 'export const ok = true;\n');
  assert.equal(adapter.calls.length, 1);
  assert.deepEqual(adapter.calls[0].options, modelOptions);
  assert.match(adapter.calls[0].request.messages[1].content, /Verify the production X composition/);
  assert.deepEqual(task, before);
});

test('protected path retains existing NEEDS_REVIEW semantics without writing', async () => {
  const root = workspace();
  const task = taskFor(root);
  const result = await executeXTask(task, modelWith({ type: 'create', path: 'src/.env', content: 'FAKE=1' }));

  assert.equal(result.repairOutcome.status, 'escalation_required');
  assert.equal(result.gateResult.gate_status, 'NEEDS_REVIEW');
  assert.equal(result.gateResult.hearth_outcome, 'waiting');
  assert.equal(result.gateResult.reason_code, 'safety_boundary_review');
  assert.equal(result.xResult.gate_status, result.gateResult.gate_status);
  assert.equal(result.xResult.reason_code, result.gateResult.reason_code);
  assert.equal(result.xResult.task_id, task.task_id);
  assert.equal(fs.existsSync(path.join(root, 'src/.env')), false);
});

test('out-of-scope write retains existing FAILED semantics without writing', async () => {
  const root = workspace();
  const task = taskFor(root);
  const result = await executeXTask(task, modelWith({ type: 'create', path: 'other/new.js', content: 'x' }));

  assert.equal(result.repairOutcome.status, 'escalation_required');
  assert.equal(result.gateResult.gate_status, 'FAILED');
  assert.equal(result.gateResult.hearth_outcome, 'error');
  assert.equal(result.gateResult.reason_code, 'structural_execution_failure');
  assert.equal(result.xResult.gate_status, result.gateResult.gate_status);
  assert.equal(result.xResult.reason_code, result.gateResult.reason_code);
  assert.equal(result.xResult.task_id, task.task_id);
  assert.equal(fs.existsSync(path.join(root, 'other/new.js')), false);
});
