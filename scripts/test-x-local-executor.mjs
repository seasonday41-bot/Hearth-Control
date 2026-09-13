import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { executeTask, EXECUTOR_ACTION_TYPES, EXECUTOR_STATUSES } from '../mcp/x/local-executor.mjs';
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
  const task = validTask(root);
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
  const task = validTask(root, { scope: { allowed_paths: ['src'], preferred_files: ['src/app.js'], forbidden_paths: [] } });
  const adapter = jsonAdapter({ actions: [{ type: 'replace', path: 'src/app.js', content: 'new content' }] });
  const result = await executeTask(task, adapter);
  assert.equal(result.status, 'completed');
  assert.equal(fs.readFileSync(path.join(root, 'src/app.js'), 'utf8'), 'new content');
});

test('E3 valid exact patch intent succeeds', async () => {
  const root = tmpWorkspace();
  writeFile(root, 'src/app.js', 'const x = 1;\n');
  const task = validTask(root, { scope: { allowed_paths: ['src'], preferred_files: ['src/app.js'], forbidden_paths: [] } });
  const adapter = jsonAdapter({ actions: [{ type: 'patch', path: 'src/app.js', edits: [{ old_string: 'const x = 1;', new_string: 'const x = 2;' }] }] });
  const result = await executeTask(task, adapter);
  assert.equal(result.status, 'completed');
  assert.equal(fs.readFileSync(path.join(root, 'src/app.js'), 'utf8'), 'const x = 2;\n');
});

test('E4 multiple ordered actions all succeed and evidence lists them in order', async () => {
  const root = tmpWorkspace();
  writeFile(root, 'src/a.js', 'a-original');
  const task = validTask(root, { scope: { allowed_paths: ['src'], preferred_files: ['src/a.js'], forbidden_paths: [] } });
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

test('E6 unsupported action type is rejected', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const task = validTask(root);
  const result = await executeTask(task, jsonAdapter({ actions: [{ type: 'delete', path: 'src/app.js' }] }));
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockers[0].reason, 'unsupported_action');
  assert.equal(fs.existsSync(path.join(root, 'src/app.js')), false);
});

test('E7 a missing required field is rejected', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const task = validTask(root);
  const result = await executeTask(task, jsonAdapter({ actions: [{ type: 'create', content: 'x' }] })); // no path
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockers[0].reason, 'missing_field');
});

test('E8 too many actions is rejected', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const task = validTask(root);
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
  const task = validTask(root);
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
  const task = validTask(root);
  const result = await executeTask(task, jsonAdapter({ actions: [{ type: 'create', path: 'other/new.js', content: 'x' }] }));
  assert.equal(result.status, 'failed');
  assert.equal(result.blockers[0].code, 'PATH_REJECTED');
  assert.equal(fs.existsSync(path.join(root, 'other/new.js')), false);
});

test('E11 a protected path cannot mutate the filesystem', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const task = validTask(root);
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
  const task = validTask(root);
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
  const task = validTask(root, { scope: { allowed_paths: ['src'], preferred_files: ['src/app.js'], forbidden_paths: [] } });
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
  const task = validTask(root, { scope: { allowed_paths: ['src'], preferred_files: ['src/app.js'], forbidden_paths: [] } });
  const result = await executeTask(task, jsonAdapter({ actions: [{ type: 'replace', path: 'src/app.js', content: 'replaced' }] }));
  assert.equal(result.status, 'failed');
  assert.equal(result.changes[0].code, 'PRECONDITION_FAILED');
  assert.match(result.changes[0].detail, /complete/);
  assert.match(fs.readFileSync(path.join(root, 'src/app.js'), 'utf8'), /Bearer/);
});

test('E18b replace of a file never loaded into context is blocked before any write', async () => {
  const root = tmpWorkspace();
  writeFile(root, 'src/app.js', 'not-in-context');
  const task = validTask(root); // preferred_files empty -- app.js is never loaded into context
  const result = await executeTask(task, jsonAdapter({ actions: [{ type: 'replace', path: 'src/app.js', content: 'replaced' }] }));
  assert.equal(result.status, 'failed');
  assert.equal(result.changes[0].code, 'PRECONDITION_FAILED');
  assert.equal(fs.readFileSync(path.join(root, 'src/app.js'), 'utf8'), 'not-in-context');
});

test('E19 stale disk content after context load still fails through Phase 5B precondition checking (replace)', async () => {
  const root = tmpWorkspace();
  const target = writeFile(root, 'src/app.js', 'original');
  const task = validTask(root, { scope: { allowed_paths: ['src'], preferred_files: ['src/app.js'], forbidden_paths: [] } });
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
  const task = validTask(root); // preferred_files empty -- never loaded into context
  const result = await executeTask(task, jsonAdapter({ actions: [{ type: 'patch', path: 'src/app.js', edits: [{ old_string: 'const x = 1;', new_string: 'const x = 2;' }] }] }));
  assert.equal(result.status, 'failed');
  assert.equal(result.changes[0].code, 'PRECONDITION_FAILED');
  assert.equal(fs.readFileSync(path.join(root, 'src/app.js'), 'utf8'), 'const x = 1;');
});

test('E21 patch target only truncated/redacted in context is blocked', async () => {
  const root = tmpWorkspace();
  writeFile(root, 'src/app.js', 'const token = "Bearer abcDEF1234567890superlongtoken";\nconst x = 1;\n');
  const task = validTask(root, { scope: { allowed_paths: ['src'], preferred_files: ['src/app.js'], forbidden_paths: [] } });
  const result = await executeTask(task, jsonAdapter({ actions: [{ type: 'patch', path: 'src/app.js', edits: [{ old_string: 'const x = 1;', new_string: 'const x = 2;' }] }] }));
  assert.equal(result.status, 'failed');
  assert.equal(result.changes[0].code, 'PRECONDITION_FAILED');
  assert.match(fs.readFileSync(path.join(root, 'src/app.js'), 'utf8'), /Bearer/);
});

test('E22 a model-supplied patch expected_hash is rejected as an unknown field', async () => {
  const root = tmpWorkspace();
  writeFile(root, 'src/app.js', 'const x = 1;');
  const task = validTask(root, { scope: { allowed_paths: ['src'], preferred_files: ['src/app.js'], forbidden_paths: [] } });
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
  const task = validTask(root, { scope: { allowed_paths: ['src'], preferred_files: ['src/app.js'], forbidden_paths: [] } });
  const result = await executeTask(task, jsonAdapter({ actions: [{ type: 'patch', path: 'src/app.js', edits: [{ old_string: 'hello', new_string: 'goodbye' }] }] }));
  assert.equal(result.status, 'completed');
  assert.equal(fs.readFileSync(path.join(root, 'src/app.js'), 'utf8'), 'goodbye world padding');
});

test('E24 disk drift after context load (old_string still present) fails PRECONDITION_FAILED and preserves the drifted file', async () => {
  const root = tmpWorkspace();
  const target = writeFile(root, 'src/app.js', 'hello world padding');
  const task = validTask(root, { scope: { allowed_paths: ['src'], preferred_files: ['src/app.js'], forbidden_paths: [] } });
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
  const task = validTask(root, { scope: { allowed_paths: ['src'], preferred_files: ['src/app.js'], forbidden_paths: [] } });
  const result = await executeTask(task, jsonAdapter({ actions: [{ type: 'replace', path: 'src/app.js', content: 'replaced fully' }] }));
  assert.equal(result.status, 'completed');
  assert.equal(fs.readFileSync(path.join(root, 'src/app.js'), 'utf8'), 'replaced fully');
});

test('LN2 patch succeeds against multiline numbered content via a middle-line old_string', async () => {
  const root = tmpWorkspace();
  const original = 'function add(a, b) {\n  return a + b;\n}\n\nfunction sub(a, b) {\n  return a - b;\n}\n';
  writeFile(root, 'src/app.js', original);
  const task = validTask(root, { scope: { allowed_paths: ['src'], preferred_files: ['src/app.js'], forbidden_paths: [] } });
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
  const task = validTask(root, { scope: { allowed_paths: ['src'], preferred_files: ['src/notes.txt'], forbidden_paths: [] } });
  const result = await executeTask(task, jsonAdapter({ actions: [{ type: 'replace', path: 'src/notes.txt', content: 'cleared' }] }));
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(fs.readFileSync(path.join(root, 'src/notes.txt'), 'utf8'), 'cleared');
});

test('LN4 patch succeeds when a DIFFERENT source line begins with number-like text elsewhere in the same file', async () => {
  const root = tmpWorkspace();
  const original = '10:30am standup notes\nconst marker = "keep me";\n20: not a line number either\n';
  writeFile(root, 'src/notes.txt', original);
  const task = validTask(root, { scope: { allowed_paths: ['src'], preferred_files: ['src/notes.txt'], forbidden_paths: [] } });
  const result = await executeTask(task, jsonAdapter({ actions: [{ type: 'patch', path: 'src/notes.txt', edits: [{ old_string: 'const marker = "keep me";', new_string: 'const marker = "changed";' }] }] }));
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(fs.readFileSync(path.join(root, 'src/notes.txt'), 'utf8'), original.replace('const marker = "keep me";', 'const marker = "changed";'));
});

test('LN5 replace succeeds against content with blank lines and a trailing newline', async () => {
  const root = tmpWorkspace();
  const original = 'first\n\nthird\n\n\nsixth\n';
  writeFile(root, 'src/app.js', original);
  const task = validTask(root, { scope: { allowed_paths: ['src'], preferred_files: ['src/app.js'], forbidden_paths: [] } });
  const result = await executeTask(task, jsonAdapter({ actions: [{ type: 'replace', path: 'src/app.js', content: 'now-single-line' }] }));
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(fs.readFileSync(path.join(root, 'src/app.js'), 'utf8'), 'now-single-line');
});

test('LN6 patch succeeds against content with blank lines and a trailing newline', async () => {
  const root = tmpWorkspace();
  const original = 'first\n\nthird\n\n\nsixth\n';
  writeFile(root, 'src/app.js', original);
  const task = validTask(root, { scope: { allowed_paths: ['src'], preferred_files: ['src/app.js'], forbidden_paths: [] } });
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
});
