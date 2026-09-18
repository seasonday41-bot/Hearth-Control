import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { executeTask, EXECUTOR_ACTION_TYPES, EXECUTOR_STATUSES, LOCAL_EXECUTOR_RESPONSE_SCHEMA, buildModelRequest, buildLocalExecutorResponseSchema, buildCreatePathPattern, hasWriteAuthority } from '../mcp/x/local-executor.mjs';
import { X_TASK_VERSION } from '../mcp/x/task-contract.mjs';

const dirs = [];
function tmpWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-x-exec-'));
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

const sha256 = (text) => crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

const validTask = (root, overrides = {}) => ({
  version: X_TASK_VERSION,
  task_id: 'TASK-EXEC-1',
  parent_task_id: null,
  revision: 1,
  attempt: 1,
  based_on_result_id: null,
  objective: 'Apply a small, safe change.',
  problem: 'The executor needs to orchestrate context, model, and writer.',
  expected_behavior: 'Only schema-valid, authorized actions ever mutate disk.',
  observed_behavior: 'No LocalExecutor exists yet.',
  why_this_matters: 'Free-form model text must never directly control writes.',
  known_evidence: [],
  suspected_area: [],
  workspace: { repo: 'Hearth-Control', root },
  scope: { allowed_paths: ['src'], preferred_files: [], forbidden_paths: [] },
  constraints: { preserve: [], do_not: [] },
  allowed_tools: ['repo_read'],
  acceptance_criteria: ['The change is applied safely or safely rejected.'],
  validation: { required: ['node --test scripts/test-x-local-executor.mjs'], optional: [] },
  verification: null,
  done_criteria: ['Evidence is returned.'],
  teaching_notes: [],
  uncertainty_policy: { policy: 'bounded_autonomy', stop_conditions: [] },
  repair_budget: { initial_attempts: 1, max_repairs: 2, max_total_rounds: 3 },
  timing: { estimated_minutes: 5, first_check_after_minutes: 1, soft_deadline_minutes: 3, hard_timeout_minutes: 10 },
  commit_policy: { mode: 'never' },
  ...overrides,
});

const writeTask = (root, overrides = {}) => validTask(root, {
  allowed_tools: ['repo_read', 'repo_edit'],
  ...overrides,
});

const jsonAdapter = (payload) => ({
  generate: async () => ({
    ok: true, provider: 'fake', model: 'fake-model', requestedModel: null,
    text: typeof payload === 'string' ? payload : JSON.stringify(payload),
    finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1 }, error: null,
  }),
});
const throwingAdapter = (message) => ({ generate: async () => { throw new Error(message); } });
const failingAdapter = (message) => ({
  generate: async () => ({ ok: false, provider: 'fake', model: null, requestedModel: null, text: null, finishReason: null, usage: null, error: { code: 'PROVIDER_ERROR', message, status: null, retryable: false } }),
});
/** Runs `mutateDisk` (simulating an external race) inside generate(), landing it exactly between context load and write time. */
const racingAdapter = (mutateDisk, payload) => ({
  generate: async () => { mutateDisk(); return { ok: true, provider: 'fake', model: 'fake-model', requestedModel: null, text: JSON.stringify(payload), finishReason: 'stop', usage: null, error: null }; },
});

// ---------------------------------------------------------------------------
// Valid flows
// ---------------------------------------------------------------------------

test('E1 valid create intent for a new authorized path succeeds', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const task = writeTask(root);
  const adapter = jsonAdapter({ actions: [{ type: 'create', path: 'src/new.js', content: 'hello' }] });
  const result = await executeTask(task, adapter);
  assert.equal(result.status, 'completed');
  assert.equal(result.actions_completed, 1);
  assert.deepEqual(result.files_changed, ['src/new.js']);
  assert.equal(fs.readFileSync(path.join(root, 'src/new.js'), 'utf8'), 'hello');
});

test('E2 valid replace intent succeeds without any model-supplied hash', async () => {
  const root = tmpWorkspace();
  writeFile(root, 'src/app.js', 'old content');
  const task = writeTask(root, { scope: { allowed_paths: ['src'], preferred_files: ['src/app.js'], forbidden_paths: [] } });
  const adapter = jsonAdapter({ actions: [{ type: 'replace', path: 'src/app.js', content: 'new content' }] });
  const result = await executeTask(task, adapter);
  assert.equal(result.status, 'completed');
  assert.equal(fs.readFileSync(path.join(root, 'src/app.js'), 'utf8'), 'new content');
});

test('E3 valid exact patch intent succeeds', async () => {
  const root = tmpWorkspace();
  writeFile(root, 'src/app.js', 'const x = 1;\n');
  const task = writeTask(root, { scope: { allowed_paths: ['src'], preferred_files: ['src/app.js'], forbidden_paths: [] } });
  const adapter = jsonAdapter({ actions: [{ type: 'patch', path: 'src/app.js', edits: [{ old_string: 'const x = 1;', new_string: 'const x = 2;' }] }] });
  const result = await executeTask(task, adapter);
  assert.equal(result.status, 'completed');
  assert.equal(fs.readFileSync(path.join(root, 'src/app.js'), 'utf8'), 'const x = 2;\n');
});

test('E4 multiple ordered actions all succeed and evidence lists them in order', async () => {
  const root = tmpWorkspace();
  writeFile(root, 'src/a.js', 'a-original');
  const task = writeTask(root, { scope: { allowed_paths: ['src'], preferred_files: ['src/a.js'], forbidden_paths: [] } });
  const adapter = jsonAdapter({
    actions: [
      { type: 'create', path: 'src/b.js', content: 'b-content' },
      { type: 'replace', path: 'src/a.js', content: 'a-updated' },
    ],
  });
  const result = await executeTask(task, adapter);
  assert.equal(result.status, 'completed');
  assert.equal(result.actions_completed, 2);
  assert.deepEqual(result.changes.map((c) => c.path), ['src/b.js', 'src/a.js']);
  assert.equal(fs.readFileSync(path.join(root, 'src/b.js'), 'utf8'), 'b-content');
  assert.equal(fs.readFileSync(path.join(root, 'src/a.js'), 'utf8'), 'a-updated');
});

// ---------------------------------------------------------------------------
// Model output rejection (schema)
// ---------------------------------------------------------------------------

test('E5 malformed model JSON is rejected, zero mutation', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const task = validTask(root);
  const result = await executeTask(task, jsonAdapter('not json at all {'));
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockers[0].reason, 'malformed_json');
  assert.deepEqual(result.changes, []);
});

test('E6 unsupported action type is rejected (write-authorized task)', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  // write-authorized: the read-only authority boundary (see R2-R4) only
  // ever discards actions for a task WITHOUT repo_edit, so this must use
  // writeTask() to actually exercise validateIntent's own schema check.
  const task = writeTask(root);
  const result = await executeTask(task, jsonAdapter({ actions: [{ type: 'delete', path: 'src/app.js' }] }));
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockers[0].reason, 'unsupported_action');
  assert.equal(fs.existsSync(path.join(root, 'src/app.js')), false);
});

test('E7 a missing required field is rejected (write-authorized task)', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const task = writeTask(root);
  const result = await executeTask(task, jsonAdapter({ actions: [{ type: 'create', content: 'x' }] })); // no path
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockers[0].reason, 'missing_field');
});

test('E8 too many actions is rejected (write-authorized task)', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const task = writeTask(root);
  const actions = Array.from({ length: 11 }, (_, i) => ({ type: 'create', path: `src/f${i}.js`, content: 'x' }));
  const result = await executeTask(task, jsonAdapter({ actions }));
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockers[0].reason, 'too_many_actions');
  for (let i = 0; i < 11; i += 1) assert.equal(fs.existsSync(path.join(root, `src/f${i}.js`)), false);
});

test('E14 model output cannot override workspace/scope', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const task = validTask(root);
  const result = await executeTask(task, jsonAdapter({
    actions: [{ type: 'create', path: 'src/new.js', content: 'x' }],
    scope: { allowed_paths: ['/'] },
  }));
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockers[0].reason, 'schema_invalid');
  assert.equal(fs.existsSync(path.join(root, 'src/new.js')), false);
});

// ---------------------------------------------------------------------------
// Execution semantics
// ---------------------------------------------------------------------------

test('E9 a write failure stops subsequent actions', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const task = writeTask(root);
  const adapter = jsonAdapter({
    actions: [
      { type: 'create', path: 'src/first.js', content: 'ok' },
      { type: 'create', path: 'other/second.js', content: 'out-of-scope' }, // fails: outside allowed_paths
      { type: 'create', path: 'src/third.js', content: 'never-attempted' },
    ],
  });
  const result = await executeTask(task, adapter);
  assert.equal(result.status, 'failed');
  assert.equal(result.actions_requested, 3);
  assert.equal(result.actions_completed, 1);
  assert.equal(result.changes.length, 2);
  assert.equal(fs.existsSync(path.join(root, 'src/first.js')), true);
  assert.equal(fs.existsSync(path.join(root, 'other/second.js')), false);
  assert.equal(fs.existsSync(path.join(root, 'src/third.js')), false);
  assert.deepEqual(result.remaining_work, [{ type: 'create', path: 'src/third.js' }]);
});

test('E10 an out-of-scope action cannot mutate the filesystem', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'other'), { recursive: true });
  const task = writeTask(root);
  const result = await executeTask(task, jsonAdapter({ actions: [{ type: 'create', path: 'other/new.js', content: 'x' }] }));
  assert.equal(result.status, 'failed');
  assert.equal(result.blockers[0].code, 'PATH_REJECTED');
  assert.equal(fs.existsSync(path.join(root, 'other/new.js')), false);
});

test('E11 a protected path cannot mutate the filesystem', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const task = writeTask(root);
  const result = await executeTask(task, jsonAdapter({ actions: [{ type: 'create', path: 'src/.env', content: 'SECRET=1' }] }));
  assert.equal(result.status, 'failed');
  assert.equal(result.blockers[0].code, 'PROTECTED_PATH');
  assert.equal(fs.existsSync(path.join(root, 'src/.env')), false);
});

// ---------------------------------------------------------------------------
// Capability surface / determinism
// ---------------------------------------------------------------------------

test('E12 no shell/network/git mutation capability is reachable from this module', () => {
  const source = fs.readFileSync(new URL('../mcp/x/local-executor.mjs', import.meta.url), 'utf8');
  assert.equal(source.includes("'node:child_process'"), false, 'must not import node:child_process');
  const forbiddenTokens = ['execSync', 'exec(', 'spawn(', 'fetch(', 'http.request', 'https.request', 'rmSync', 'rmdir', 'rename(', 'chmod('];
  for (const token of forbiddenTokens) assert.equal(source.includes(token), false, `forbidden token '${token}' found in local-executor.mjs`);
});

test('E13 task input is not mutated', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const task = validTask(root);
  const before = JSON.stringify(task);
  await executeTask(task, jsonAdapter({ actions: [{ type: 'create', path: 'src/new.js', content: 'x' }] }));
  assert.equal(JSON.stringify(task), before);
});

test('E15 deterministic evidence is returned across repeated equivalent calls', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const task = writeTask(root);
  const adapter = () => jsonAdapter({ actions: [{ type: 'create', path: 'src/new.js', content: 'hello' }] });
  const first = await executeTask(task, adapter());
  fs.rmSync(path.join(root, 'src/new.js'));
  const second = await executeTask(task, adapter());
  assert.deepEqual({ ...first, model_metadata: null }, { ...second, model_metadata: null });
});

test('E16 a ModelAdapter that throws is handled safely', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const task = validTask(root);
  const result = await executeTask(task, throwingAdapter('boom'));
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockers[0].reason, 'model_request_failed');
});

test('E16b a ModelAdapter that returns ok:false is handled safely', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const task = validTask(root);
  const result = await executeTask(task, failingAdapter('provider unavailable'));
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockers[0].reason, 'model_request_failed');
});

// ---------------------------------------------------------------------------
// Replace provenance
// ---------------------------------------------------------------------------

test('E17 the model cannot supply or override expected_hash/expected_content on replace', async () => {
  const root = tmpWorkspace();
  writeFile(root, 'src/app.js', 'original');
  const task = writeTask(root, { scope: { allowed_paths: ['src'], preferred_files: ['src/app.js'], forbidden_paths: [] } });
  const result = await executeTask(task, jsonAdapter({
    actions: [{ type: 'replace', path: 'src/app.js', content: 'malicious', expected_hash: sha256('original') }],
  }));
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockers[0].reason, 'schema_invalid');
  assert.equal(fs.readFileSync(path.join(root, 'src/app.js'), 'utf8'), 'original');
});

test('E18 replace of a redacted (incomplete) context file is blocked before any write', async () => {
  const root = tmpWorkspace();
  writeFile(root, 'src/app.js', 'const token = "Bearer abcDEF1234567890superlongtoken";\n');
  const task = writeTask(root, { scope: { allowed_paths: ['src'], preferred_files: ['src/app.js'], forbidden_paths: [] } });
  const result = await executeTask(task, jsonAdapter({ actions: [{ type: 'replace', path: 'src/app.js', content: 'replaced' }] }));
  assert.equal(result.status, 'failed');
  assert.equal(result.changes[0].code, 'PRECONDITION_FAILED');
  assert.match(result.changes[0].detail, /complete/);
  assert.match(fs.readFileSync(path.join(root, 'src/app.js'), 'utf8'), /Bearer/);
});

test('E18b replace of a file never loaded into context is blocked before any write', async () => {
  const root = tmpWorkspace();
  writeFile(root, 'src/app.js', 'not-in-context');
  const task = writeTask(root); // preferred_files empty -- app.js is never loaded into context
  const result = await executeTask(task, jsonAdapter({ actions: [{ type: 'replace', path: 'src/app.js', content: 'replaced' }] }));
  assert.equal(result.status, 'failed');
  assert.equal(result.changes[0].code, 'PRECONDITION_FAILED');
  assert.equal(fs.readFileSync(path.join(root, 'src/app.js'), 'utf8'), 'not-in-context');
});

test('E19 stale disk content after context load still fails through Phase 5B precondition checking (replace)', async () => {
  const root = tmpWorkspace();
  const target = writeFile(root, 'src/app.js', 'original');
  const task = writeTask(root, { scope: { allowed_paths: ['src'], preferred_files: ['src/app.js'], forbidden_paths: [] } });
  const adapter = racingAdapter(
    () => fs.writeFileSync(target, 'raced-content'),
    { actions: [{ type: 'replace', path: 'src/app.js', content: 'attempted-update' }] },
  );
  const result = await executeTask(task, adapter);
  assert.equal(result.status, 'failed');
  assert.equal(result.changes[0].code, 'PRECONDITION_FAILED');
  assert.equal(fs.readFileSync(target, 'utf8'), 'raced-content');
});

// ---------------------------------------------------------------------------
// Patch provenance
// ---------------------------------------------------------------------------

test('E20 patch target not present in context is blocked, zero mutation', async () => {
  const root = tmpWorkspace();
  writeFile(root, 'src/app.js', 'const x = 1;');
  const task = writeTask(root); // preferred_files empty -- never loaded into context
  const result = await executeTask(task, jsonAdapter({ actions: [{ type: 'patch', path: 'src/app.js', edits: [{ old_string: 'const x = 1;', new_string: 'const x = 2;' }] }] }));
  assert.equal(result.status, 'failed');
  assert.equal(result.changes[0].code, 'PRECONDITION_FAILED');
  assert.equal(fs.readFileSync(path.join(root, 'src/app.js'), 'utf8'), 'const x = 1;');
});

test('E21 patch target only truncated/redacted in context is blocked', async () => {
  const root = tmpWorkspace();
  writeFile(root, 'src/app.js', 'const token = "Bearer abcDEF1234567890superlongtoken";\nconst x = 1;\n');
  const task = writeTask(root, { scope: { allowed_paths: ['src'], preferred_files: ['src/app.js'], forbidden_paths: [] } });
  const result = await executeTask(task, jsonAdapter({ actions: [{ type: 'patch', path: 'src/app.js', edits: [{ old_string: 'const x = 1;', new_string: 'const x = 2;' }] }] }));
  assert.equal(result.status, 'failed');
  assert.equal(result.changes[0].code, 'PRECONDITION_FAILED');
  assert.match(fs.readFileSync(path.join(root, 'src/app.js'), 'utf8'), /Bearer/);
});

test('E22 a model-supplied patch expected_hash is rejected as an unknown field', async () => {
  const root = tmpWorkspace();
  writeFile(root, 'src/app.js', 'const x = 1;');
  const task = writeTask(root, { scope: { allowed_paths: ['src'], preferred_files: ['src/app.js'], forbidden_paths: [] } });
  const result = await executeTask(task, jsonAdapter({
    actions: [{ type: 'patch', path: 'src/app.js', edits: [{ old_string: 'const x = 1;', new_string: 'const x = 2;' }], expected_hash: sha256('const x = 1;') }],
  }));
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockers[0].reason, 'schema_invalid');
  assert.equal(fs.readFileSync(path.join(root, 'src/app.js'), 'utf8'), 'const x = 1;');
});

test('E23 patch succeeds when disk content still matches the complete context snapshot', async () => {
  const root = tmpWorkspace();
  writeFile(root, 'src/app.js', 'hello world padding');
  const task = writeTask(root, { scope: { allowed_paths: ['src'], preferred_files: ['src/app.js'], forbidden_paths: [] } });
  const result = await executeTask(task, jsonAdapter({ actions: [{ type: 'patch', path: 'src/app.js', edits: [{ old_string: 'hello', new_string: 'goodbye' }] }] }));
  assert.equal(result.status, 'completed');
  assert.equal(fs.readFileSync(path.join(root, 'src/app.js'), 'utf8'), 'goodbye world padding');
});

test('E24 disk drift after context load (old_string still present) fails PRECONDITION_FAILED and preserves the drifted file', async () => {
  const root = tmpWorkspace();
  const target = writeFile(root, 'src/app.js', 'hello world padding');
  const task = writeTask(root, { scope: { allowed_paths: ['src'], preferred_files: ['src/app.js'], forbidden_paths: [] } });
  // The drifted content still contains "hello" -- a naive old_string-only
  // precondition would happily (and wrongly) patch it.
  const adapter = racingAdapter(
    () => fs.writeFileSync(target, 'hello universe padding'),
    { actions: [{ type: 'patch', path: 'src/app.js', edits: [{ old_string: 'hello', new_string: 'goodbye' }] }] },
  );
  const result = await executeTask(task, adapter);
  assert.equal(result.status, 'failed');
  assert.equal(result.changes[0].code, 'PRECONDITION_FAILED');
  assert.equal(fs.readFileSync(target, 'utf8'), 'hello universe padding');
});

// ---------------------------------------------------------------------------
// Line-number-prefix stripping (context.files[].content is "N: line",
// produced by the shared ReadOnlyToolGateway.repoReadFile) -- these prove
// the exact-prefix strip used to recover the raw precondition/hash basis
// is correct across the edge cases that could break a naive implementation.
// ---------------------------------------------------------------------------

test('LN1 replace succeeds against multiline numbered content, unchanged on disk', async () => {
  const root = tmpWorkspace();
  const original = 'function add(a, b) {\n  return a + b;\n}\n\nfunction sub(a, b) {\n  return a - b;\n}\n';
  writeFile(root, 'src/app.js', original);
  const task = writeTask(root, { scope: { allowed_paths: ['src'], preferred_files: ['src/app.js'], forbidden_paths: [] } });
  const result = await executeTask(task, jsonAdapter({ actions: [{ type: 'replace', path: 'src/app.js', content: 'replaced fully' }] }));
  assert.equal(result.status, 'completed');
  assert.equal(fs.readFileSync(path.join(root, 'src/app.js'), 'utf8'), 'replaced fully');
});

test('LN2 patch succeeds against multiline numbered content via a middle-line old_string', async () => {
  const root = tmpWorkspace();
  const original = 'function add(a, b) {\n  return a + b;\n}\n\nfunction sub(a, b) {\n  return a - b;\n}\n';
  writeFile(root, 'src/app.js', original);
  const task = writeTask(root, { scope: { allowed_paths: ['src'], preferred_files: ['src/app.js'], forbidden_paths: [] } });
  const result = await executeTask(task, jsonAdapter({ actions: [{ type: 'patch', path: 'src/app.js', edits: [{ old_string: 'return a - b;', new_string: 'return a - b - 1;' }] }] }));
  assert.equal(result.status, 'completed');
  assert.equal(fs.readFileSync(path.join(root, 'src/app.js'), 'utf8'), original.replace('return a - b;', 'return a - b - 1;'));
});

test('LN3 replace succeeds when a source line itself begins with number-like text ("10:30am ...")', async () => {
  const root = tmpWorkspace();
  // Line 1 legitimately looks like it could be confused with a "1: " or
  // "10: " numbering artifact if stripping were done with a generic regex
  // instead of an exact per-position prefix match.
  const original = '10:30am standup notes\n20: not a line number either\nthird line\n';
  writeFile(root, 'src/notes.txt', original);
  const task = writeTask(root, { scope: { allowed_paths: ['src'], preferred_files: ['src/notes.txt'], forbidden_paths: [] } });
  const result = await executeTask(task, jsonAdapter({ actions: [{ type: 'replace', path: 'src/notes.txt', content: 'cleared' }] }));
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(fs.readFileSync(path.join(root, 'src/notes.txt'), 'utf8'), 'cleared');
});

test('LN4 patch succeeds when a DIFFERENT source line begins with number-like text elsewhere in the same file', async () => {
  const root = tmpWorkspace();
  const original = '10:30am standup notes\nconst marker = "keep me";\n20: not a line number either\n';
  writeFile(root, 'src/notes.txt', original);
  const task = writeTask(root, { scope: { allowed_paths: ['src'], preferred_files: ['src/notes.txt'], forbidden_paths: [] } });
  const result = await executeTask(task, jsonAdapter({ actions: [{ type: 'patch', path: 'src/notes.txt', edits: [{ old_string: 'const marker = "keep me";', new_string: 'const marker = "changed";' }] }] }));
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(fs.readFileSync(path.join(root, 'src/notes.txt'), 'utf8'), original.replace('const marker = "keep me";', 'const marker = "changed";'));
});

test('LN5 replace succeeds against content with blank lines and a trailing newline', async () => {
  const root = tmpWorkspace();
  const original = 'first\n\nthird\n\n\nsixth\n';
  writeFile(root, 'src/app.js', original);
  const task = writeTask(root, { scope: { allowed_paths: ['src'], preferred_files: ['src/app.js'], forbidden_paths: [] } });
  const result = await executeTask(task, jsonAdapter({ actions: [{ type: 'replace', path: 'src/app.js', content: 'now-single-line' }] }));
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(fs.readFileSync(path.join(root, 'src/app.js'), 'utf8'), 'now-single-line');
});

test('LN6 patch succeeds against content with blank lines and a trailing newline', async () => {
  const root = tmpWorkspace();
  const original = 'first\n\nthird\n\n\nsixth\n';
  writeFile(root, 'src/app.js', original);
  const task = writeTask(root, { scope: { allowed_paths: ['src'], preferred_files: ['src/app.js'], forbidden_paths: [] } });
  const result = await executeTask(task, jsonAdapter({ actions: [{ type: 'patch', path: 'src/app.js', edits: [{ old_string: 'third', new_string: 'THIRD' }] }] }));
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(fs.readFileSync(path.join(root, 'src/app.js'), 'utf8'), original.replace('third', 'THIRD'));
});

// ---------------------------------------------------------------------------
// Sanity on the exported constants
// ---------------------------------------------------------------------------

test('E25 exported constants match the documented contract', () => {
  assert.deepEqual(EXECUTOR_ACTION_TYPES, ['create', 'replace', 'patch']);
  assert.deepEqual(EXECUTOR_STATUSES, ['completed', 'failed', 'blocked']);
  assert.equal(typeof LOCAL_EXECUTOR_RESPONSE_SCHEMA, 'object');
});

test('E26 LocalExecutor request carries the structured response schema', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const task = validTask(root);
  let capturedRequest;
  const adapter = {
    generate: async (req) => {
      capturedRequest = req;
      return {
        ok: true, provider: 'fake', model: 'fake-model', requestedModel: null,
        text: JSON.stringify({ actions: [] }),
        finishReason: 'stop', usage: null, error: null,
      };
    },
  };
  const result = await executeTask(task, adapter);
  assert.equal(result.status, 'completed');
  assert.equal(capturedRequest.format.type, 'object');
  assert.deepEqual(capturedRequest.format, buildLocalExecutorResponseSchema(task, { files: [] }));
});

test('E27 model output with top-level field "code" is rejected by validateIntent', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const task = validTask(root);
  const result = await executeTask(task, jsonAdapter({
    actions: [{ type: 'create', path: 'src/new.js', content: 'x' }],
    code: 'some model output code',
  }));
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockers[0].reason, 'schema_invalid');
  assert.equal(result.blockers[0].detail, "unknown top-level field 'code'");
  assert.equal(fs.existsSync(path.join(root, 'src/new.js')), false);
});

test('E28 model output with top-level field "profile" is rejected by validateIntent', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const task = validTask(root);
  const result = await executeTask(task, jsonAdapter({
    actions: [{ type: 'create', path: 'src/new.js', content: 'x' }],
    profile: 'developer',
  }));
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockers[0].reason, 'schema_invalid');
  assert.equal(result.blockers[0].detail, "unknown top-level field 'profile'");
  assert.equal(fs.existsSync(path.join(root, 'src/new.js')), false);
});

test('E29 buildModelRequest instructs model that paths must be repository-relative', () => {
  const root = tmpWorkspace();
  const task = writeTask(root);
  const context = { files: [], evidence: { known_evidence: [] } };
  const req = buildModelRequest(task, context);
  const systemPrompt = req.messages.find((m) => m.role === 'system')?.content || '';
  assert.match(systemPrompt, /repository-relative/i);
  assert.match(systemPrompt, /Never output an absolute filesystem path/i);
  assert.match(systemPrompt, /Never begin a path with "\/"/i);
  assert.match(systemPrompt, /Never use "\.\." as a path segment/i);
});

test('E30 LOCAL_EXECUTOR_RESPONSE_SCHEMA contains path pattern restriction prohibiting leading slash', () => {
  const createAction = LOCAL_EXECUTOR_RESPONSE_SCHEMA.properties.actions.items.anyOf[0];
  const replaceAction = LOCAL_EXECUTOR_RESPONSE_SCHEMA.properties.actions.items.anyOf[1];
  const patchAction = LOCAL_EXECUTOR_RESPONSE_SCHEMA.properties.actions.items.anyOf[2];
  assert.equal(createAction.properties.path.pattern, '^[^/].*');
  assert.equal(replaceAction.properties.path.pattern, '^[^/].*');
  assert.equal(patchAction.properties.path.pattern, '^[^/].*');
});

test('E31 absolute path model intent is rejected before filesystem mutation', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const task = writeTask(root);
  const adapter = jsonAdapter({
    actions: [{ type: 'create', path: '/Users/example/project/file.mjs', content: 'content' }],
  });
  const result = await executeTask(task, adapter);
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.files_changed, []);
  assert.equal(result.blockers[0].code, 'PATH_REJECTED');
  assert.equal(fs.existsSync(path.join(root, 'Users/example/project/file.mjs')), false);
});

test('E32 traversal path ../outside/file.mjs is rejected before filesystem mutation', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const task = writeTask(root);
  const adapter = jsonAdapter({
    actions: [{ type: 'create', path: '../outside/file.mjs', content: 'content' }],
  });
  const result = await executeTask(task, adapter);
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.files_changed, []);
  assert.equal(result.blockers[0].code, 'PATH_REJECTED');
});

test('E33 nested traversal scripts/../../outside.mjs is rejected before filesystem mutation', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const task = writeTask(root, { scope: { allowed_paths: ['scripts', 'src'], preferred_files: [], forbidden_paths: [] } });
  const adapter = jsonAdapter({
    actions: [{ type: 'create', path: 'scripts/../../outside.mjs', content: 'content' }],
  });
  const result = await executeTask(task, adapter);
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.files_changed, []);
  assert.equal(result.blockers[0].code, 'PATH_REJECTED');
});

test('E34 valid repo-relative path remains allowed', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  const task = writeTask(root, { scope: { allowed_paths: ['scripts'], preferred_files: [], forbidden_paths: [] } });
  const adapter = jsonAdapter({
    actions: [{ type: 'create', path: 'scripts/example.mjs', content: 'console.log("ok");\n' }],
  });
  const result = await executeTask(task, adapter);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.files_changed, ['scripts/example.mjs']);
  assert.equal(fs.readFileSync(path.join(root, 'scripts/example.mjs'), 'utf8'), 'console.log("ok");\n');
});

test('E35 LocalExecutor generation request carries bounded increased output budget (num_predict=4096, longResponse=true)', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const task = validTask(root);
  let capturedRequest;
  const adapter = {
    generate: async (req) => {
      capturedRequest = req;
      return {
        ok: true, provider: 'fake', model: 'fake-model', requestedModel: null,
        text: JSON.stringify({ actions: [] }),
        finishReason: 'stop', usage: null, error: null,
      };
    },
  };
  const result = await executeTask(task, adapter);
  assert.equal(result.status, 'completed');
  assert.equal(capturedRequest.num_predict, 4096);
  assert.equal(capturedRequest.longResponse, true);
});

test('E36 existing unknown-field strictness remains unchanged', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const task = writeTask(root);
  const result = await executeTask(task, jsonAdapter({
    actions: [{ type: 'create', path: 'src/new.js', content: 'x', extra_field: 'invalid' }],
  }));
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockers[0].reason, 'schema_invalid');
  assert.match(result.blockers[0].detail, /extra_field/);
});

test('E37 create schema dynamically enforces task.scope.allowed_paths prefixes and rejects root/.env/absolute paths', () => {
  const schema = buildLocalExecutorResponseSchema(
    { allowed_tools: ['repo_read', 'repo_edit'], scope: { allowed_paths: ['mcp/x', 'mcp/skills', 'scripts'] } },
    { files: [] },
  );
  const createPattern = new RegExp(schema.properties.actions.items.anyOf[0].properties.path.pattern);
  assert.equal(createPattern.test('scripts/example.mjs'), true);
  assert.equal(createPattern.test('mcp/x/local-executor.mjs'), true);
  assert.equal(createPattern.test('mcp/skills/registry.mjs'), true);
  assert.equal(createPattern.test('.env.example'), false);
  assert.equal(createPattern.test('README.md'), false);
  assert.equal(createPattern.test('/Users/example/file.mjs'), false);
  assert.equal(createPattern.test('docs/foo.md'), false);
});

test('E38 allowed_paths containing regex characters are safely escaped', () => {
  const schema = buildLocalExecutorResponseSchema(
    { allowed_tools: ['repo_read', 'repo_edit'], scope: { allowed_paths: ['pkg[special]', 'c++', 'tools.v1'] } },
    { files: [] },
  );
  const createPattern = new RegExp(schema.properties.actions.items.anyOf[0].properties.path.pattern);
  assert.equal(createPattern.test('pkg[special]/file.js'), true);
  assert.equal(createPattern.test('pkgspecial/file.js'), false);
  assert.equal(createPattern.test('c++/main.cpp'), true);
  assert.equal(createPattern.test('tools.v1/run.js'), true);
  assert.equal(createPattern.test('toolsxv1/run.js'), false);
});

test('E39 replace and patch path schemas are exact enums of eligible status === "ok" context files only', () => {
  const contextWithMixedFiles = {
    files: [
      { path: 'mcp/x/ok1.mjs', status: 'ok', content: '1: ok' },
      { path: 'mcp/x/redacted.mjs', status: 'redacted', content: '(withheld)' },
      { path: 'mcp/x/truncated.mjs', status: 'truncated', content: '1: tr' },
      { path: 'mcp/skills/ok2.mjs', status: 'ok', content: '1: ok2' },
    ],
  };
  const schema = buildLocalExecutorResponseSchema(
    { allowed_tools: ['repo_read', 'repo_edit'], scope: { allowed_paths: ['mcp/x', 'mcp/skills'] } },
    contextWithMixedFiles,
  );
  const replaceAction = schema.properties.actions.items.anyOf.find((a) => a.properties.type.enum[0] === 'replace');
  const patchAction = schema.properties.actions.items.anyOf.find((a) => a.properties.type.enum[0] === 'patch');
  assert.deepEqual(replaceAction.properties.path.enum, ['mcp/x/ok1.mjs', 'mcp/skills/ok2.mjs']);
  assert.deepEqual(patchAction.properties.path.enum, ['mcp/x/ok1.mjs', 'mcp/skills/ok2.mjs']);
  assert.equal(replaceAction.properties.path.enum.includes('mcp/x/redacted.mjs'), false);
  assert.equal(replaceAction.properties.path.enum.includes('mcp/x/truncated.mjs'), false);
});

test('E40 empty eligible context files produces valid create-only schema and actions: [] remains valid', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const task = writeTask(root);
  const schema = buildLocalExecutorResponseSchema(task, { files: [] });
  assert.equal(schema.properties.actions.items.anyOf.length, 1);
  assert.equal(schema.properties.actions.items.anyOf[0].properties.type.enum[0], 'create');

  const adapter = jsonAdapter({ actions: [] });
  const result = await executeTask(task, adapter);
  assert.equal(result.status, 'completed');
  assert.equal(result.actions_completed, 0);
  assert.deepEqual(result.files_changed, []);
});

test('E41 runtime PATH_REJECTED rejects out-of-scope path even if schema is bypassed', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  const task = writeTask(root, { scope: { allowed_paths: ['scripts'], preferred_files: [], forbidden_paths: [] } });
  const adapter = jsonAdapter({
    actions: [{ type: 'create', path: '.env.example', content: 'SECRET=1' }],
  });
  const result = await executeTask(task, adapter);
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.files_changed, []);
  assert.equal(result.blockers[0].code, 'PATH_REJECTED');
  assert.match(result.blockers[0].detail, /outside the authorized scope/);
  assert.equal(fs.existsSync(path.join(root, '.env.example')), false);
});

// ---------------------------------------------------------------------------
// Canonical Write-Authority Enforcement Regression Tests (R1 - R14)
// ---------------------------------------------------------------------------

test('R1 READ-ONLY SCHEMA: allowed_tools: ["repo_read"] produces actions: { type: "array", maxItems: 0 } and no create/replace/patch variants', () => {
  const task = validTask('/tmp', { allowed_tools: ['repo_read'] });
  const schema = buildLocalExecutorResponseSchema(task, {
    files: [{ path: 'src/app.js', status: 'ok', content: '1: ok' }],
  });
  assert.equal(schema.type, 'object');
  assert.deepEqual(schema.required, ['actions']);
  assert.equal(schema.properties.actions.type, 'array');
  assert.equal(schema.properties.actions.maxItems, 0);
  // Defense-in-depth: even if a model backend lets an element through
  // despite maxItems:0, `items` bounds its shape to an empty object.
  assert.deepEqual(schema.properties.actions.items, { type: 'object', additionalProperties: false });
  assert.equal(schema.properties.actions.anyOf, undefined);
});

test('R2 READ-ONLY CREATE BYPASS: hand-crafted create with repo_read only is discarded by the read-only authority boundary before it can reach mutation, zero mutation and no temp drift', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  const task = validTask(root, {
    allowed_tools: ['repo_read'],
    scope: { allowed_paths: ['scripts'], preferred_files: [], forbidden_paths: [] },
  });
  const adapter = jsonAdapter({
    actions: [
      {
        type: 'create',
        path: 'scripts/should-not-exist.mjs',
        content: 'export const fail = true;\n',
      },
    ],
  });
  const result = await executeTask(task, adapter);
  // The read-only authority boundary discards the action BEFORE
  // validateIntent or Phase 5B ever see it -- the action never reaches
  // executeOneAction at all, so this is now a normal, zero-action
  // 'completed' result rather than a per-action PERMISSION_DENIED failure.
  assert.equal(result.status, 'completed');
  assert.equal(result.actions_requested, 0);
  assert.equal(result.actions_completed, 0);
  assert.deepEqual(result.files_changed, []);
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.read_only_actions_discarded, 1);
  assert.equal(fs.existsSync(path.join(root, 'scripts/should-not-exist.mjs')), false);
  const entries = fs.readdirSync(path.join(root, 'scripts'));
  assert.deepEqual(entries, []);
});

test('R3 READ-ONLY REPLACE BYPASS: hand-crafted replace with repo_read only is discarded by the read-only authority boundary and leaves original file unchanged', async () => {
  const root = tmpWorkspace();
  writeFile(root, 'src/app.js', 'original content');
  const task = validTask(root, {
    allowed_tools: ['repo_read'],
    scope: { allowed_paths: ['src'], preferred_files: ['src/app.js'], forbidden_paths: [] },
  });
  const adapter = jsonAdapter({
    actions: [
      {
        type: 'replace',
        path: 'src/app.js',
        content: 'malicious replacement',
      },
    ],
  });
  const result = await executeTask(task, adapter);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.files_changed, []);
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.read_only_actions_discarded, 1);
  assert.equal(fs.readFileSync(path.join(root, 'src/app.js'), 'utf8'), 'original content');
});

test('R4 READ-ONLY PATCH BYPASS: hand-crafted patch with repo_read only is discarded by the read-only authority boundary and leaves original file unchanged', async () => {
  const root = tmpWorkspace();
  writeFile(root, 'src/app.js', 'const x = 1;\n');
  const task = validTask(root, {
    allowed_tools: ['repo_read'],
    scope: { allowed_paths: ['src'], preferred_files: ['src/app.js'], forbidden_paths: [] },
  });
  const adapter = jsonAdapter({
    actions: [
      {
        type: 'patch',
        path: 'src/app.js',
        edits: [{ old_string: 'const x = 1;', new_string: 'const x = 999;' }],
      },
    ],
  });
  const result = await executeTask(task, adapter);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.files_changed, []);
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.read_only_actions_discarded, 1);
  assert.equal(fs.readFileSync(path.join(root, 'src/app.js'), 'utf8'), 'const x = 1;\n');
});

test('R4b READ-ONLY: actions: [] from the model is unaffected by the boundary and remains []', async () => {
  const root = tmpWorkspace();
  const task = validTask(root, { allowed_tools: ['repo_read'] });
  const result = await executeTask(task, jsonAdapter({ actions: [], explanation: 'nothing to change', confidence: 0.9 }));
  assert.equal(result.status, 'completed');
  assert.equal(result.actions_requested, 0);
  assert.equal(result.read_only_actions_discarded, 0);
  assert.deepEqual(result.files_changed, []);
  assert.equal(result.model_metadata.explanation, 'nothing to change');
  assert.equal(result.model_metadata.confidence, 0.9);
});

test('R4c READ-ONLY: a malformed action (missing type entirely -- the exact shape observed in the real P2D failure) is discarded before validateIntent ever sees it, never surfaces unsupported_action, and analysis fields are preserved', async () => {
  const root = tmpWorkspace();
  const task = validTask(root, { allowed_tools: ['repo_read'] });
  const result = await executeTask(task, jsonAdapter({
    actions: [{ note: 'no type key at all' }],
    explanation: 'read-only audit summary',
    confidence: 0.5,
  }));
  assert.equal(result.status, 'completed');
  assert.notEqual(result.status, 'blocked');
  assert.equal(result.blockers.length, 0, 'must never surface unsupported_action for a read-only task');
  assert.equal(result.read_only_actions_discarded, 1);
  assert.deepEqual(result.files_changed, []);
  assert.deepEqual(result.changes, []);
  // Non-action analysis/result fields survive the normalization untouched.
  assert.equal(result.model_metadata.explanation, 'read-only audit summary');
  assert.equal(result.model_metadata.confidence, 0.5);
});

test('R4d READ-ONLY: multiple mixed actions (a well-formed write attempt plus a malformed one) are all discarded together, none partially executed', async () => {
  const root = tmpWorkspace();
  writeFile(root, 'src/app.js', 'untouched');
  const task = validTask(root, {
    allowed_tools: ['repo_read'],
    scope: { allowed_paths: ['src'], preferred_files: ['src/app.js'], forbidden_paths: [] },
  });
  const result = await executeTask(task, jsonAdapter({
    actions: [
      { type: 'replace', path: 'src/app.js', content: 'malicious' },
      { note: 'malformed, no type' },
    ],
  }));
  assert.equal(result.status, 'completed');
  assert.equal(result.read_only_actions_discarded, 2);
  assert.deepEqual(result.changes, []);
  assert.equal(fs.readFileSync(path.join(root, 'src/app.js'), 'utf8'), 'untouched');
});

test('R5 WRITE-AUTHORIZED CREATE: allowed_tools: ["repo_read", "repo_edit"] performs valid in-scope create', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  const task = validTask(root, {
    allowed_tools: ['repo_read', 'repo_edit'],
    scope: { allowed_paths: ['scripts'], preferred_files: [], forbidden_paths: [] },
  });
  const adapter = jsonAdapter({
    actions: [{ type: 'create', path: 'scripts/valid.mjs', content: 'console.log("ok");\n' }],
  });
  const result = await executeTask(task, adapter);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.files_changed, ['scripts/valid.mjs']);
  assert.equal(fs.readFileSync(path.join(root, 'scripts/valid.mjs'), 'utf8'), 'console.log("ok");\n');
  // The read-only authority boundary never engages for a write-authorized task.
  assert.equal(result.read_only_actions_discarded, 0);
});

test('R6 WRITE-AUTHORIZED REPLACE: repo_edit present performs valid complete-context replace', async () => {
  const root = tmpWorkspace();
  writeFile(root, 'src/app.js', 'old text');
  const task = validTask(root, {
    allowed_tools: ['repo_read', 'repo_edit'],
    scope: { allowed_paths: ['src'], preferred_files: ['src/app.js'], forbidden_paths: [] },
  });
  const adapter = jsonAdapter({
    actions: [{ type: 'replace', path: 'src/app.js', content: 'new text' }],
  });
  const result = await executeTask(task, adapter);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.files_changed, ['src/app.js']);
  assert.equal(fs.readFileSync(path.join(root, 'src/app.js'), 'utf8'), 'new text');
});

test('R7 WRITE-AUTHORIZED PATCH: repo_edit present performs valid complete-context patch', async () => {
  const root = tmpWorkspace();
  writeFile(root, 'src/app.js', 'const a = 10;\n');
  const task = validTask(root, {
    allowed_tools: ['repo_read', 'repo_edit'],
    scope: { allowed_paths: ['src'], preferred_files: ['src/app.js'], forbidden_paths: [] },
  });
  const adapter = jsonAdapter({
    actions: [{ type: 'patch', path: 'src/app.js', edits: [{ old_string: 'const a = 10;', new_string: 'const a = 20;' }] }],
  });
  const result = await executeTask(task, adapter);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.files_changed, ['src/app.js']);
  assert.equal(fs.readFileSync(path.join(root, 'src/app.js'), 'utf8'), 'const a = 20;\n');
});

test('R8 WRITE AUTHORITY DOES NOT WIDEN SCOPE: repo_edit present with path outside allowed_paths is rejected as PATH_REJECTED', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'outside'), { recursive: true });
  const task = validTask(root, {
    allowed_tools: ['repo_read', 'repo_edit'],
    scope: { allowed_paths: ['src'], preferred_files: [], forbidden_paths: [] },
  });
  const adapter = jsonAdapter({
    actions: [{ type: 'create', path: 'outside/new.js', content: 'hello' }],
  });
  const result = await executeTask(task, adapter);
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.files_changed, []);
  assert.equal(result.blockers[0].code, 'PATH_REJECTED');
  assert.equal(fs.existsSync(path.join(root, 'outside/new.js')), false);
});

test('R9 WRITE AUTHORITY DOES NOT BYPASS TRAVERSAL: repo_edit present with ../outside.mjs or scripts/../../outside.mjs is rejected as PATH_REJECTED', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  const task = validTask(root, {
    allowed_tools: ['repo_read', 'repo_edit'],
    scope: { allowed_paths: ['scripts'], preferred_files: [], forbidden_paths: [] },
  });
  const adapter1 = jsonAdapter({
    actions: [{ type: 'create', path: '../outside.mjs', content: 'bad' }],
  });
  const result1 = await executeTask(task, adapter1);
  assert.equal(result1.status, 'failed');
  assert.equal(result1.blockers[0].code, 'PATH_REJECTED');

  const adapter2 = jsonAdapter({
    actions: [{ type: 'create', path: 'scripts/../../outside.mjs', content: 'bad' }],
  });
  const result2 = await executeTask(task, adapter2);
  assert.equal(result2.status, 'failed');
  assert.equal(result2.blockers[0].code, 'PATH_REJECTED');
});

test('R10 SKILL METADATA CANNOT GRANT WRITE: skill metadata cannot grant write authority if task.allowed_tools lacks repo_edit', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  const task = validTask(root, {
    allowed_tools: ['repo_read'],
    scope: { allowed_paths: ['scripts'], preferred_files: [], forbidden_paths: [] },
    skill_metadata: { requested_tools: ['repo_edit'], permitted_tools: ['repo_edit'] },
  });
  assert.equal(hasWriteAuthority(task), false);
  const adapter = jsonAdapter({
    actions: [{ type: 'create', path: 'scripts/skill-test.mjs', content: 'bad' }],
  });
  const result = await executeTask(task, adapter);
  // Skill metadata still cannot grant write authority: the read-only
  // authority boundary discards the action before it ever reaches Phase 5B.
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.read_only_actions_discarded, 1);
  assert.equal(fs.existsSync(path.join(root, 'scripts/skill-test.mjs')), false);
});

test('R11 commit_policy = never with repo_edit present allows mutation without git commit', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  const task = validTask(root, {
    allowed_tools: ['repo_read', 'repo_edit'],
    scope: { allowed_paths: ['scripts'], preferred_files: [], forbidden_paths: [] },
    commit_policy: { mode: 'never' },
  });
  const adapter = jsonAdapter({
    actions: [{ type: 'create', path: 'scripts/no-commit.mjs', content: 'export const val = 1;\n' }],
  });
  const result = await executeTask(task, adapter);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.files_changed, ['scripts/no-commit.mjs']);
  assert.equal(fs.readFileSync(path.join(root, 'scripts/no-commit.mjs'), 'utf8'), 'export const val = 1;\n');
  assert.equal(fs.existsSync(path.join(root, '.git')), false);
});

test('R12 dynamic path-schema for write-authorized tasks preserves scope pattern and context enum', () => {
  const schema = buildLocalExecutorResponseSchema(
    { allowed_tools: ['repo_read', 'repo_edit'], scope: { allowed_paths: ['scripts'] } },
    { files: [{ path: 'scripts/run.mjs', status: 'ok', content: '1: ok' }] },
  );
  assert.equal(schema.properties.actions.items.anyOf.length, 3);
  assert.equal(schema.properties.actions.items.anyOf[0].properties.type.enum[0], 'create');
  assert.equal(schema.properties.actions.items.anyOf[1].properties.type.enum[0], 'replace');
  assert.equal(schema.properties.actions.items.anyOf[2].properties.type.enum[0], 'patch');
  assert.deepEqual(schema.properties.actions.items.anyOf[1].properties.path.enum, ['scripts/run.mjs']);
});

test('R13 strict unknown-field checking rejects unexpected top-level or action fields', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const task = validTask(root);
  const result = await executeTask(task, jsonAdapter({
    actions: [],
    unauthorized_field: 'illegal',
  }));
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockers[0].reason, 'schema_invalid');
  assert.match(result.blockers[0].detail, /unauthorized_field/);
});

test('R14 prompt instructions and output budget: read-only tasks instruct actions: [] while preserving num_predict:4096 and longResponse:true', () => {
  const readOnlyTask = validTask('/tmp', { allowed_tools: ['repo_read'] });
  const req = buildModelRequest(readOnlyTask, { files: [] });
  assert.equal(req.num_predict, 4096);
  assert.equal(req.longResponse, true);
  const systemMsg = req.messages.find((m) => m.role === 'system');
  assert.match(systemMsg.content, /This task has NO repository edit authority/);
  assert.match(systemMsg.content, /You MUST return actions: \[\]/);
  assert.match(systemMsg.content, /Do not propose create, replace, or patch/);

  const writeAuthorizedTask = writeTask('/tmp');
  const writeReq = buildModelRequest(writeAuthorizedTask, { files: [] });
  assert.equal(writeReq.num_predict, 4096);
  assert.equal(writeReq.longResponse, true);
  const writeSystemMsg = writeReq.messages.find((m) => m.role === 'system');
  assert.match(writeSystemMsg.content, /Only use "create", "replace", or "patch" as an action type/);
});
