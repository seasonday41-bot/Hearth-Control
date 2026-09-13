import assert from 'node:assert/strict';
import test from 'node:test';
import { parseXTask, validateXTask, X_TASK_REPAIR_LIMITS, X_TASK_VERSION } from '../mcp/x/task-contract.mjs';

const validTask = (overrides = {}) => ({
  version: X_TASK_VERSION,
  task_id: 'TASK-001',
  parent_task_id: null,
  revision: 1,
  attempt: 1,
  based_on_result_id: null,
  objective: 'Fix the focused defect.',
  problem: 'The task packet needs deterministic validation.',
  expected_behavior: 'Malformed packets are rejected before execution.',
  observed_behavior: 'No x-task-v1 validator exists yet.',
  why_this_matters: 'Future execution needs explicit authority and bounds.',
  known_evidence: ['docs/X-EXECUTOR-V1-SPEC.md'],
  suspected_area: ['mcp/x'],
  workspace: { repo: 'Hearth-Control', root: '/approved/hearth' },
  scope: { allowed_paths: ['mcp/x'], preferred_files: ['mcp/x/task-contract.mjs'], forbidden_paths: ['mcp/runtime'] },
  constraints: { preserve: ['Durable Job Runtime'], do_not: ['Modify Bridge'] },
  allowed_tools: ['repo_read', 'file_search'],
  acceptance_criteria: ['Focused tests pass.'],
  validation: { required: ['node --test scripts/test-x-task-contract.mjs'], optional: [] },
  verification: { evidence: ['validator result'] },
  done_criteria: ['Validator returns a normalized packet.'],
  teaching_notes: [],
  uncertainty_policy: { policy: 'bounded_autonomy', stop_conditions: ['Scope conflict'] },
  repair_budget: { initial_attempts: 1, max_repairs: 2, max_total_rounds: 3 },
  timing: { estimated_minutes: 10, first_check_after_minutes: 2, soft_deadline_minutes: 8, hard_timeout_minutes: 15 },
  commit_policy: 'never',
  ...overrides,
});

const invalid = (task, path) => {
  const result = validateXTask(task);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((entry) => entry.path === path), JSON.stringify(result.errors));
};

test('TASK1 minimal valid x-task-v1 normalizes deterministically', () => {
  const input = validTask();
  const first = parseXTask(input);
  const second = parseXTask(input);
  assert.deepEqual(first, second);
  assert.equal(first.version, 'x-task-v1');
  assert.deepEqual(first.commit_policy, { mode: 'never' });
});

test('TASK2 full valid task preserves optional fields and canonical limits', () => {
  const actual = parseXTask(validTask({ parent_task_id: 'TASK-000', revision: 2, attempt: 3, based_on_result_id: 'RESULT-001', teaching_notes: ['Explain the root cause.'], validation: { required: ['tests'], optional: ['build'] } }));
  assert.equal(actual.parent_task_id, 'TASK-000');
  assert.equal(actual.based_on_result_id, 'RESULT-001');
  assert.deepEqual(actual.teaching_notes, ['Explain the root cause.']);
  assert.equal(actual.repair_budget.max_total_rounds, X_TASK_REPAIR_LIMITS.maxTotalRounds);
});

test('TASK3 wrong version is rejected', () => invalid(validTask({ version: 'x-task-v0' }), 'version'));
test('TASK4 missing task_id is rejected', () => invalid(validTask({ task_id: '' }), 'task_id'));
test('TASK5 invalid revision and attempt are rejected', () => {
  const result = validateXTask(validTask({ revision: 0, attempt: 1.5 }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((entry) => entry.path === 'revision'));
  assert.ok(result.errors.some((entry) => entry.path === 'attempt'));
});
test('TASK6 invalid path scope is rejected', () => invalid(validTask({ scope: { allowed_paths: ['../outside'], preferred_files: [], forbidden_paths: [] } }), 'scope.allowed_paths'));
test('TASK7 conflicting allowed and forbidden paths are rejected', () => invalid(validTask({ scope: { allowed_paths: ['mcp'], preferred_files: [], forbidden_paths: ['mcp/x'] } }), 'scope'));
test('TASK8 invalid commit policy is rejected', () => invalid(validTask({ commit_policy: 'push_now' }), 'commit_policy'));
test('TASK9 invalid timing ordering is rejected', () => invalid(validTask({ timing: { estimated_minutes: 10, first_check_after_minutes: 9, soft_deadline_minutes: 8, hard_timeout_minutes: 7 } }), 'timing'));
test('TASK10 repair budget beyond canonical maximum is rejected', () => invalid(validTask({ repair_budget: { initial_attempts: 1, max_repairs: 3, max_total_rounds: 4 } }), 'repair_budget.max_repairs'));
test('TASK11 required validation missing is rejected', () => invalid(validTask({ validation: { required: [], optional: [] } }), 'validation.required'));

test('TASK12 revision ancestry fields are preserved', () => {
  const actual = parseXTask(validTask({ parent_task_id: 'TASK-0', revision: 4, attempt: 2, based_on_result_id: 'RESULT-3' }));
  assert.deepEqual({ parent: actual.parent_task_id, revision: actual.revision, attempt: actual.attempt, result: actual.based_on_result_id }, { parent: 'TASK-0', revision: 4, attempt: 2, result: 'RESULT-3' });
});

test('TASK13 documented verification metadata is preserved', () => {
  const verification = { evidence: ['focused test'], reviewer: 'user' };
  assert.deepEqual(parseXTask(validTask({ verification })).verification, verification);
});

test('TASK14 validator does not mutate input', () => {
  const input = validTask({ scope: { allowed_paths: ['./mcp/x/'], preferred_files: [], forbidden_paths: [] } });
  const before = structuredClone(input);
  parseXTask(input);
  assert.deepEqual(input, before);
});

test('TASK15 normalized output is deterministic with documented aliases', () => {
  const nestedScope = { allowed_paths: ['mcp/x'], preferred_files: [], forbidden_paths: [], workspace: { repo: 'Hearth-Control', root: '/approved/hearth' } };
  const input = validTask({ workspace: undefined, scope: nestedScope, validation: undefined, verification: { required: ['tests'], optional: [] }, uncertainty_policy: undefined, uncertainty: { policy: 'bounded_autonomy', stop_conditions: [] }, commit_policy: { mode: 'require_user_approval' } });
  const actual = parseXTask(input);
  assert.deepEqual(actual.workspace, nestedScope.workspace);
  assert.deepEqual(actual.validation, { required: ['tests'], optional: [] });
  assert.deepEqual(actual.uncertainty_policy, { policy: 'bounded_autonomy', stop_conditions: [] });
  assert.deepEqual(actual.commit_policy, { mode: 'require_user_approval' });
});

console.log('X task contract Phase 3 tests: 15 passed');
