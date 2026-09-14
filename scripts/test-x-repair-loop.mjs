import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTaskWithRepair, classifyExecutorFailure, FAILURE_CLASSIFICATION, REPAIR_STATUSES } from '../mcp/x/repair-loop.mjs';
import { XContextScopeError } from '../mcp/x/context-loader.mjs';
import { X_TASK_VERSION } from '../mcp/x/task-contract.mjs';

const dirs = [];
function tmpWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-x-repair-'));
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

const validTask = (root, overrides = {}) => ({
  version: X_TASK_VERSION,
  task_id: 'TASK-REPAIR-1',
  parent_task_id: null,
  revision: 1,
  attempt: 1,
  based_on_result_id: null,
  objective: 'Apply a change and keep it valid.',
  problem: 'The repair loop needs to execute, validate, and repair safely.',
  expected_behavior: 'Only in-scope, schema-valid changes are ever applied.',
  observed_behavior: 'No repair loop exists yet.',
  why_this_matters: 'Unbounded or unsafe repair would defeat the whole safety chain.',
  known_evidence: [],
  suspected_area: [],
  workspace: { repo: 'Hearth-Control', root },
  scope: { allowed_paths: ['src'], preferred_files: [], forbidden_paths: [] },
  constraints: { preserve: [], do_not: [] },
  allowed_tools: ['repo_read'],
  acceptance_criteria: ['The task ends validated or safely escalated.'],
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

/** A fake ModelAdapter that returns one queued JSON response per call (the last entry repeats if exhausted) and records every request it was sent. */
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

// ---------------------------------------------------------------------------
// Core state machine
// ---------------------------------------------------------------------------

test('RL1 round 1 completes and required validation passes -> validated, one round', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFile(root, 'scripts/test-pass.mjs', "import test from 'node:test';\ntest('ok', () => {});\n");
  const task = validTask(root, { validation: { required: ['node --test scripts/test-pass.mjs'], optional: [] } });
  const adapter = queueAdapter([{ actions: [{ type: 'create', path: 'src/new.js', content: 'hello' }] }]);

  const result = await runTaskWithRepair(task, adapter);

  assert.equal(result.status, 'validated');
  assert.equal(result.total_rounds, 1);
  assert.equal(result.rounds.length, 1);
  assert.equal(adapter.calls.length, 1);
  assert.equal(fs.readFileSync(path.join(root, 'src/new.js'), 'utf8'), 'hello');
});

test('RL2/RL7/RL8 a required-validation failure repairs, the newly-created file becomes visible in round 2, and is successfully patched there', async () => {
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
  const task = validTask(root, { validation: { required: ['node --test scripts/test-check-newfile.mjs'], optional: [] } });
  const adapter = queueAdapter([
    { actions: [{ type: 'create', path: 'src/newfile.js', content: 'original' }] },   // round 1: validation will fail (content isn't 'patched' yet)
    { actions: [{ type: 'patch', path: 'src/newfile.js', edits: [{ old_string: 'original', new_string: 'patched' }] }] }, // round 2
  ]);

  const result = await runTaskWithRepair(task, adapter);

  assert.equal(result.status, 'validated');
  assert.equal(result.total_rounds, 2);
  assert.equal(adapter.calls.length, 2);
  assert.equal(result.rounds[0].validation.required[0].status, 'failed');
  assert.equal(result.rounds[1].validation.required[0].status, 'passed');
  assert.equal(fs.readFileSync(path.join(root, 'src/newfile.js'), 'utf8'), 'patched');

  // The file round 1 created was not in the original scope.preferred_files
  // or suspected_area -- it can only appear in round 2's context because
  // the repair loop added it automatically after round 1.
  assert.match(promptOf(adapter.calls[1]), /src\/newfile\.js/);
  assert.match(promptOf(adapter.calls[1]), /original/);
});

test('RL3 PRECONDITION_FAILED is classified repairable and a repair round is attempted', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFile(root, 'src/other.js', 'not-in-context');
  writeFile(root, 'scripts/test-pass.mjs', "import test from 'node:test';\ntest('ok', () => {});\n");
  const task = validTask(root, { validation: { required: ['node --test scripts/test-pass.mjs'], optional: [] } });
  const adapter = queueAdapter([
    { actions: [{ type: 'replace', path: 'src/other.js', content: 'x' }] }, // not in context -- PRECONDITION_FAILED
    { actions: [{ type: 'create', path: 'src/new.js', content: 'ok' }] },   // valid recovery
  ]);

  const result = await runTaskWithRepair(task, adapter);

  assert.equal(result.rounds[0].classification, 'repairable');
  assert.equal(result.rounds[0].executor.blockers[0].code, 'PRECONDITION_FAILED');
  assert.equal(result.status, 'validated');
  assert.equal(result.total_rounds, 2);
});

test('RL4 a structural failure (PATH_REJECTED) escalates immediately with no second executeTask/model call', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'other'), { recursive: true });
  const task = validTask(root);
  const adapter = queueAdapter([{ actions: [{ type: 'create', path: 'other/new.js', content: 'x' }] }]);

  const result = await runTaskWithRepair(task, adapter);

  assert.equal(result.status, 'escalation_required');
  assert.equal(result.total_rounds, 1);
  assert.equal(adapter.calls.length, 1);
  assert.equal(result.rounds[0].classification, 'escalate');
  assert.equal(result.rounds[0].executor.blockers[0].code, 'PATH_REJECTED');
});

test('RL5 an unrecognized reason/code classifies fail-closed as escalate', () => {
  const fakeResult = { status: 'failed', blockers: [{ reason: 'totally_unrecognized_reason', code: undefined, detail: 'x' }] };
  assert.equal(classifyExecutorFailure(fakeResult), 'escalate');
  assert.equal(FAILURE_CLASSIFICATION.totally_unrecognized_reason, undefined);
});

test('RL6 a missing/invalid scope becomes an invalid_task_scope escalation with no model call', async () => {
  const root = tmpWorkspace();
  const task = validTask(root, { scope: undefined });
  const adapter = queueAdapter([{ actions: [] }]);

  const result = await runTaskWithRepair(task, adapter);

  assert.equal(result.status, 'escalation_required');
  assert.equal(result.blockers[0].reason, 'invalid_task_scope');
  assert.equal(adapter.calls.length, 0);
  assert.equal(result.rounds.length, 0);
});

test('RL19 a malformed/unauthorized validation command escalates immediately with no second executeTask/model call', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const task = validTask(root, { validation: { required: ['node --test scripts/test-pass.mjs; rm -rf /'], optional: [] } });
  const adapter = queueAdapter([{ actions: [{ type: 'create', path: 'src/new.js', content: 'x' }] }]);

  const result = await runTaskWithRepair(task, adapter);

  assert.equal(result.status, 'escalation_required');
  assert.equal(result.total_rounds, 1);
  assert.equal(adapter.calls.length, 1);
  assert.equal(result.blockers[0].reason, 'invalid_validation_command');
  assert.equal(result.rounds[0].classification, 'escalate');
  assert.equal(result.rounds[0].validation.required[0].status, 'invalid_command');
});

// ---------------------------------------------------------------------------
// Scope preservation across rounds
// ---------------------------------------------------------------------------

test('RL9/RL10 allowed_paths and forbidden_paths are identical across every round', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFile(root, 'scripts/test-fail.mjs', "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('boom', () => { assert.equal(1, 2); });\n");
  const task = validTask(root, {
    scope: { allowed_paths: ['src', 'lib'], preferred_files: [], forbidden_paths: ['src/danger'] },
    validation: { required: ['node --test scripts/test-fail.mjs'], optional: [] },
  });
  const adapter = queueAdapter([{ actions: [{ type: 'create', path: 'src/new.js', content: 'x' }] }]);
  await runTaskWithRepair(task, adapter); // required validation always fails -> repairs until budget exhausted

  assert.ok(adapter.calls.length >= 2);
  const scopeSection = (prompt) => prompt.match(/Allowed paths: [^\n]+\nForbidden paths: [^\n]+/)[0];
  const first = scopeSection(promptOf(adapter.calls[0]));
  for (const call of adapter.calls.slice(1)) {
    assert.equal(scopeSection(promptOf(call)), first);
  }
  assert.match(first, /Allowed paths: src, lib/);
  assert.match(first, /Forbidden paths: src\/danger/);
});

test('RL11 the original task object is never mutated', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFile(root, 'scripts/test-pass.mjs', "import test from 'node:test';\ntest('ok', () => {});\n");
  const task = validTask(root, { validation: { required: ['node --test scripts/test-pass.mjs'], optional: [] } });
  const before = JSON.stringify(task);
  await runTaskWithRepair(task, queueAdapter([{ actions: [{ type: 'create', path: 'src/new.js', content: 'x' }] }]));
  assert.equal(JSON.stringify(task), before);
});

// ---------------------------------------------------------------------------
// Budget enforcement
// ---------------------------------------------------------------------------

test('RL12 a repair budget of 1 stops after exactly one round', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFile(root, 'scripts/test-fail.mjs', "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('boom', () => { assert.equal(1, 2); });\n");
  const task = validTask(root, {
    validation: { required: ['node --test scripts/test-fail.mjs'], optional: [] },
    repair_budget: { initial_attempts: 1, max_repairs: 0, max_total_rounds: 1 },
  });
  const adapter = queueAdapter([{ actions: [{ type: 'create', path: 'src/new.js', content: 'x' }] }]);

  const result = await runTaskWithRepair(task, adapter);

  assert.equal(result.status, 'escalation_required');
  assert.equal(result.total_rounds, 1);
  assert.equal(adapter.calls.length, 1);
});

test('RL13 the canonical maximum of 3 total rounds is enforced and never exceeded', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFile(root, 'scripts/test-fail.mjs', "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('boom', () => { assert.equal(1, 2); });\n");
  const task = validTask(root, {
    validation: { required: ['node --test scripts/test-fail.mjs'], optional: [] },
    repair_budget: { initial_attempts: 1, max_repairs: 2, max_total_rounds: 3 },
  });
  const adapter = queueAdapter([{ actions: [{ type: 'create', path: 'src/new.js', content: 'x' }] }]); // always fails validation

  const result = await runTaskWithRepair(task, adapter);

  assert.equal(result.status, 'escalation_required');
  assert.equal(result.total_rounds, 3);
  assert.equal(adapter.calls.length, 3);
});

test('RL14 success short-circuits and never spends more rounds than needed', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFile(root, 'scripts/test-pass.mjs', "import test from 'node:test';\ntest('ok', () => {});\n");
  const task = validTask(root, {
    validation: { required: ['node --test scripts/test-pass.mjs'], optional: [] },
    repair_budget: { initial_attempts: 1, max_repairs: 2, max_total_rounds: 3 },
  });
  const adapter = queueAdapter([{ actions: [{ type: 'create', path: 'src/new.js', content: 'x' }] }]);

  const result = await runTaskWithRepair(task, adapter);

  assert.equal(result.status, 'validated');
  assert.equal(result.total_rounds, 1);
  assert.equal(adapter.calls.length, 1);
});

// ---------------------------------------------------------------------------
// Optional validation
// ---------------------------------------------------------------------------

test('RL15a optional validation runs after required passes', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFile(root, 'scripts/test-pass.mjs', "import test from 'node:test';\ntest('ok', () => {});\n");
  writeFile(root, 'scripts/test-optional.mjs', "import test from 'node:test';\ntest('ok', () => {});\n");
  const task = validTask(root, { validation: { required: ['node --test scripts/test-pass.mjs'], optional: ['node --test scripts/test-optional.mjs'] } });
  const adapter = queueAdapter([{ actions: [{ type: 'create', path: 'src/new.js', content: 'x' }] }]);

  const result = await runTaskWithRepair(task, adapter);

  assert.equal(result.status, 'validated');
  assert.equal(result.rounds[0].validation.optional.length, 1);
  assert.equal(result.rounds[0].validation.optional[0].command, 'node --test scripts/test-optional.mjs');
});

test('RL15b optional validation never runs when required fails', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFile(root, 'scripts/test-fail.mjs', "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('boom', () => { assert.equal(1, 2); });\n");
  writeFile(root, 'scripts/test-optional.mjs', "import test from 'node:test';\ntest('ok', () => {});\n");
  const task = validTask(root, {
    validation: { required: ['node --test scripts/test-fail.mjs'], optional: ['node --test scripts/test-optional.mjs'] },
    repair_budget: { initial_attempts: 1, max_repairs: 0, max_total_rounds: 1 },
  });
  const adapter = queueAdapter([{ actions: [{ type: 'create', path: 'src/new.js', content: 'x' }] }]);

  const result = await runTaskWithRepair(task, adapter);

  assert.equal(result.rounds[0].validation.optional.length, 0);
});

test('RL16 an optional validation failure still returns validated overall', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFile(root, 'scripts/test-pass.mjs', "import test from 'node:test';\ntest('ok', () => {});\n");
  writeFile(root, 'scripts/test-optional-fail.mjs', "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('boom', () => { assert.equal(1, 2); });\n");
  const task = validTask(root, { validation: { required: ['node --test scripts/test-pass.mjs'], optional: ['node --test scripts/test-optional-fail.mjs'] } });
  const adapter = queueAdapter([{ actions: [{ type: 'create', path: 'src/new.js', content: 'x' }] }]);

  const result = await runTaskWithRepair(task, adapter);

  assert.equal(result.status, 'validated');
  assert.equal(result.rounds[0].validation.optional[0].status, 'failed');
});

// ---------------------------------------------------------------------------
// Evidence bounding / determinism
// ---------------------------------------------------------------------------

test('RL17 repair evidence fed to the next round is bounded, not an unbounded dump', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const hugeTail = `STARTMARKER${'x'.repeat(5000)}ENDMARKER`;
  writeFile(root, 'scripts/test-huge-fail.mjs', [
    "import test from 'node:test';",
    `test('boom', () => { throw new Error(${JSON.stringify(hugeTail)}); });`,
  ].join('\n'));
  const task = validTask(root, {
    validation: { required: ['node --test scripts/test-huge-fail.mjs'], optional: [] },
    repair_budget: { initial_attempts: 1, max_repairs: 1, max_total_rounds: 2 },
  });
  const adapter = queueAdapter([{ actions: [{ type: 'create', path: 'src/new.js', content: 'x' }] }]);

  await runTaskWithRepair(task, adapter);

  assert.equal(adapter.calls.length, 2);
  const round2Prompt = promptOf(adapter.calls[1]);
  assert.equal(round2Prompt.includes('ENDMARKER'), false, 'evidence must be bounded, not an unbounded dump of process output');
});

test('RL18 the outcome shape is deterministic and stable across equivalent runs', async () => {
  const shapeOf = (value) => {
    if (Array.isArray(value)) return value.length > 0 ? [shapeOf(value[0])] : [];
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, shapeOf(value[k])]));
    return typeof value;
  };

  const runOnce = async () => {
    const root = tmpWorkspace();
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFile(root, 'scripts/test-pass.mjs', "import test from 'node:test';\ntest('ok', () => {});\n");
    const task = validTask(root, { validation: { required: ['node --test scripts/test-pass.mjs'], optional: [] } });
    return runTaskWithRepair(task, queueAdapter([{ actions: [{ type: 'create', path: 'src/new.js', content: 'x' }] }]));
  };

  const first = await runOnce();
  const second = await runOnce();

  assert.deepEqual(shapeOf(first), shapeOf(second));
  assert.ok(REPAIR_STATUSES.includes(first.status));
  assert.equal(first.total_rounds, first.rounds.length);
  assert.equal(typeof first.task_id, 'string');
  assert.ok(Array.isArray(first.blockers));
});
