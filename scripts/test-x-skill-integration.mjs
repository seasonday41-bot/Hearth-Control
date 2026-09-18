import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseXTask, X_TASK_VERSION } from '../mcp/x/task-contract.mjs';
import { executeXTask } from '../mcp/x/execute-x-task.mjs';
import { createHearthSkillRegistry } from '../mcp/skills/registry.mjs';
import { LOCAL_SKILL_TOOLS } from '../mcp/skills/gateway.mjs';
import { TEST_RUN_TOOL } from '../mcp/skills/test-runner.mjs';

const workspaces = [];
function createWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-x-skill-integration-'));
  workspaces.push(root);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts/test-pass.mjs'), "import test from 'node:test';\ntest('ok', () => {});\n");
  return root;
}

afterEach(() => {
  for (const root of workspaces.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeTask(root, overrides = {}) {
  return parseXTask({
    version: X_TASK_VERSION,
    task_id: 'TASK-SKILL-INT-1',
    parent_task_id: null,
    revision: 1,
    attempt: 1,
    based_on_result_id: null,
    objective: 'Inspect repository structure and check Git branch status without modifying workspace.',
    problem: 'Need read-only repository inspection evidence.',
    expected_behavior: 'Appropriate Skill is selected and execution is guided by its playbook.',
    observed_behavior: 'No skill playbook is active.',
    why_this_matters: 'Skills provide reusable playbooks for common agent tasks.',
    known_evidence: [],
    suspected_area: [],
    workspace: { repo: 'Hearth-Control', root },
    scope: { allowed_paths: ['src'], preferred_files: [], forbidden_paths: [] },
    constraints: { preserve: [], do_not: [] },
    allowed_tools: ['repo_read', 'file_search'],
    acceptance_criteria: ['Relevant skill is loaded and its playbook influences execution.'],
    validation: { required: ['node --test scripts/test-pass.mjs'], optional: [] },
    verification: null,
    done_criteria: ['Required validation passes.'],
    teaching_notes: [],
    uncertainty_policy: { policy: 'bounded_autonomy', stop_conditions: [] },
    repair_budget: { initial_attempts: 1, max_repairs: 2, max_total_rounds: 3 },
    timing: { estimated_minutes: 5, first_check_after_minutes: 1, soft_deadline_minutes: 3, hard_timeout_minutes: 10 },
    commit_policy: { mode: 'never' },
    ...overrides,
  });
}

function modelWithActions(actions = []) {
  const calls = [];
  return {
    calls,
    async generate(request, options) {
      calls.push({ request, options });
      return {
        ok: true,
        provider: 'mock',
        model: 'mock-model',
        requestedModel: null,
        text: JSON.stringify({ actions }),
        finishReason: 'stop',
        usage: null,
        error: null,
      };
    },
  };
}

function extractAllMessages(adapter) {
  if (!adapter.calls.length) return '';
  const request = adapter.calls[0].request;
  return (request.messages || []).map((m) => m.content || '').join('\n');
}

test('XS1: X deterministically selects and loads repo-inspect for read-only inspection tasks', async () => {
  const root = createWorkspace();
  const task = makeTask(root, {
    objective: 'Inspect repository structure and check Git branch status without modifying workspace.',
    allowed_tools: ['repo_read', 'file_search'],
    constraints: {
      preserve: [],
      do_not: ['Do not create, modify, or delete files.'],
    },
  });

  const adapter = modelWithActions([]);
  const result = await executeXTask(task, adapter);

  assert.equal(adapter.calls.length >= 1, true, 'model adapter must be called');
  const promptText = extractAllMessages(adapter);
  assert.match(
    promptText,
    /# Repo Inspect|Skill: repo-inspect|summary:.*inspect a selected repository/i,
    'Model request must contain the repo-inspect skill instructions or playbook'
  );
  assert.equal(result.repairOutcome.status, 'validated');
  assert.equal(result.gateResult.gate_status, 'COMPLETED');
});

test('XS2: X deterministically selects and loads bug-fix for bug repair tasks with repo_edit', async () => {
  const root = createWorkspace();
  const task = makeTask(root, {
    objective: 'Diagnose and fix a reproducible bug in the calculation function.',
    allowed_tools: ['repo_read', 'file_search', 'repo_edit'],
    constraints: {
      preserve: [],
      do_not: ['Do not commit or deploy.'],
    },
  });

  const adapter = modelWithActions([
    { type: 'create', path: 'src/fix.js', content: 'export const fixed = true;\n' },
  ]);
  const result = await executeXTask(task, adapter);

  assert.equal(adapter.calls.length >= 1, true, 'model adapter must be called');
  const promptText = extractAllMessages(adapter);
  assert.match(
    promptText,
    /# Bug Fix|Skill: bug-fix|summary:.*diagnose and fix a reproducible coding bug/i,
    'Model request must contain the bug-fix skill instructions or playbook'
  );
  assert.equal(result.repairOutcome.status, 'validated');
  assert.equal(result.gateResult.gate_status, 'COMPLETED');
  assert.equal(fs.existsSync(path.join(root, 'src/fix.js')), true);
});

test('XS3: X deterministically selects and loads test-regression for regression verification tasks', async () => {
  const root = createWorkspace();
  const task = makeTask(root, {
    objective: 'Reproduce and verify test regression against approved Hearth test suites.',
    allowed_tools: ['repo_read', 'test_run'],
    constraints: {
      preserve: [],
      do_not: ['Do not edit files.'],
    },
  });

  const adapter = modelWithActions([]);
  const result = await executeXTask(task, adapter);

  assert.equal(adapter.calls.length >= 1, true, 'model adapter must be called');
  const promptText = extractAllMessages(adapter);
  assert.match(
    promptText,
    /# Test Regression|Skill: test-regression|summary:.*select and run the smallest approved regression tests/i,
    'Model request must contain the test-regression skill instructions or playbook'
  );
  assert.equal(result.repairOutcome.status, 'validated');
  assert.equal(result.gateResult.gate_status, 'COMPLETED');
});

test('XS4: Skill requested tools are intersected with task allowed_tools; missing tools remain missing', async () => {
  const root = createWorkspace();
  // bug-fix skill requests [repo_list, repo_read_file, file_search, git_inspect, test_run]
  // task only allows [repo_read, file_search]
  const task = makeTask(root, {
    objective: 'Diagnose a defect within the repository without executing tests.',
    allowed_tools: ['repo_read', 'file_search'],
  });

  const adapter = modelWithActions([]);
  await executeXTask(task, adapter);

  assert.equal(adapter.calls.length >= 1, true, 'model adapter must be called');
  const promptText = extractAllMessages(adapter);
  // Verify that test_run was not authorized or given to the model as an available capability
  assert.doesNotMatch(
    promptText,
    /"test_run" is authorized/i,
    'test_run must not be authorized when absent from task.allowed_tools'
  );
});

test('XS5: Skill metadata cannot grant repo_edit or any authority absent from task.allowed_tools', async () => {
  const root = createWorkspace();
  // Task is read-only (repo_read only), but asks to fix a defect (triggering bug-fix skill)
  const task = makeTask(root, {
    objective: 'Fix a defect in src/calc.js',
    allowed_tools: ['repo_read', 'file_search'], // NO repo_edit
  });

  // Model attempts a write action
  const adapter = modelWithActions([
    { type: 'create', path: 'src/calc.js', content: 'export const calc = 42;\n' },
  ]);
  const result = await executeXTask(task, adapter);

  // Even though bug-fix mode is workspace-write, task authority must prevail.
  // The read-only authority boundary (mcp/x/local-executor.mjs's
  // enforceReadOnlyActionBoundary) now discards this action BEFORE
  // validateIntent or Phase 5B's PERMISSION_DENIED check ever see it, so
  // execution completes and validates cleanly rather than failing --
  // the security property (no write without repo_edit) is unchanged and
  // proven the same way: zero file mutation.
  assert.equal(result.repairOutcome.status, 'validated');
  assert.equal(result.gateResult.gate_status, 'COMPLETED');
  assert.equal(result.gateResult.hearth_outcome, 'completed');
  assert.equal(result.gateResult.reason_code, 'validated');
  assert.equal(result.xResult.gate_status, 'COMPLETED');
  assert.equal(result.repairOutcome.rounds[0].executor.read_only_actions_discarded, 1);
  assert.deepEqual(result.repairOutcome.rounds[0].executor.blockers, []);
  assert.equal(fs.existsSync(path.join(root, 'src/calc.js')), false, 'no file write permitted without repo_edit');
});

test('XS6: Unavailable skill tool does not cause shell or exec fallback', async () => {
  // Read local-executor and execute-x-task source to verify strict absence of shell fallback
  const executorSrc = fs.readFileSync(new URL('../mcp/x/local-executor.mjs', import.meta.url), 'utf8');
  const executeTaskSrc = fs.readFileSync(new URL('../mcp/x/execute-x-task.mjs', import.meta.url), 'utf8');

  assert.doesNotMatch(executorSrc, /\b(?:child_process\.)?exec\s*\(/, 'LocalExecutor must never use exec');
  assert.doesNotMatch(executorSrc, /shell\s*:\s*true/, 'LocalExecutor must never spawn a shell');
  assert.doesNotMatch(executeTaskSrc, /\b(?:child_process\.)?exec\s*\(/, 'executeXTask must never use exec');
  assert.doesNotMatch(executeTaskSrc, /shell\s*:\s*true/, 'executeXTask must never spawn a shell');
});

test('XS7: Existing registry, gateway, and test-runner are reused rather than parallel systems', async () => {
  const registry = createHearthSkillRegistry();
  const availableTools = [
    ...LOCAL_SKILL_TOOLS.map((t) => t.function.name),
    TEST_RUN_TOOL.function.name,
  ];

  const repoInspect = await registry.load('repo-inspect', { agent: 'x', availableTools });
  assert.equal(repoInspect.metadata.id, 'repo-inspect');
  assert.equal(repoInspect.grantsPermissions, false);

  const bugFix = await registry.load('bug-fix', { agent: 'x', availableTools });
  assert.equal(bugFix.metadata.id, 'bug-fix');
  assert.equal(bugFix.grantsPermissions, false);

  const testRegression = await registry.load('test-regression', { agent: 'x', availableTools });
  assert.equal(testRegression.metadata.id, 'test-regression');
  assert.equal(testRegression.grantsPermissions, false);

  // Unauthorized agent is rejected
  await assert.rejects(
    () => registry.load('repo-inspect', { agent: 'unauthorized-agent', availableTools }),
    { code: 'SKILL_AGENT_REJECTED' }
  );
});

test('XS8: Skill instructions/playbook cannot widen workspace scope or validation authority', async () => {
  const root = createWorkspace();
  const task = makeTask(root, {
    objective: 'Diagnose and fix bug in calculation',
    allowed_tools: ['repo_read', 'repo_edit'],
    scope: {
      allowed_paths: ['src'],
      preferred_files: [],
      forbidden_paths: [],
    },
  });

  // Model attempts write outside scope.allowed_paths
  const adapter = modelWithActions([
    { type: 'create', path: 'scripts/out-of-scope.js', content: 'malicious' },
  ]);
  const result = await executeXTask(task, adapter);

  assert.equal(result.repairOutcome.status, 'escalation_required');
  assert.equal(result.gateResult.gate_status, 'FAILED');
  assert.equal(result.gateResult.reason_code, 'structural_execution_failure');
  assert.equal(fs.existsSync(path.join(root, 'scripts/out-of-scope.js')), false);
});
