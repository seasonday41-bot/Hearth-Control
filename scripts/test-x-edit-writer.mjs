import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  createFile, replaceFile, applyEdits, XEditScopeError, DEFAULT_EDIT_LIMITS,
} from '../mcp/x/edit-writer.mjs';
import { X_TASK_VERSION } from '../mcp/x/task-contract.mjs';

const dirs = [];
function tmpWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-x-write-'));
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
  task_id: 'TASK-WRITE-1',
  parent_task_id: null,
  revision: 1,
  attempt: 1,
  based_on_result_id: null,
  objective: 'Apply a scoped, safe write.',
  problem: 'The writer needs bounded, atomic, precondition-safe edits.',
  expected_behavior: 'Only authorized, non-conflicting writes succeed.',
  observed_behavior: 'No write primitives exist yet.',
  why_this_matters: 'Unsafe writes risk data loss or scope escape.',
  known_evidence: [],
  suspected_area: [],
  workspace: { repo: 'Hearth-Control', root },
  scope: { allowed_paths: ['src'], preferred_files: [], forbidden_paths: [] },
  constraints: { preserve: [], do_not: [] },
  allowed_tools: ['repo_read'],
  acceptance_criteria: ['Write succeeds or is safely rejected.'],
  validation: { required: ['node --test scripts/test-x-edit-writer.mjs'], optional: [] },
  verification: null,
  done_criteria: ['Evidence is returned.'],
  teaching_notes: [],
  uncertainty_policy: { policy: 'bounded_autonomy', stop_conditions: [] },
  repair_budget: { initial_attempts: 1, max_repairs: 2, max_total_rounds: 3 },
  timing: { estimated_minutes: 5, first_check_after_minutes: 1, soft_deadline_minutes: 3, hard_timeout_minutes: 10 },
  commit_policy: { mode: 'never' },
  ...overrides,
});

// ---------------------------------------------------------------------------
// Basic create / replace
// ---------------------------------------------------------------------------

test('W1 create file inside allowed path succeeds with deterministic evidence', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const task = validTask(root);
  const result = await createFile(task, 'src/new.js', 'hello world');
  assert.equal(result.status, 'ok');
  assert.equal(result.operation, 'create');
  assert.equal(result.path, 'src/new.js');
  assert.equal(result.created, true);
  assert.equal(result.changed, true);
  assert.equal(result.before_hash, null);
  assert.equal(result.after_hash, sha256('hello world'));
  assert.equal(result.bytes_written, Buffer.byteLength('hello world', 'utf8'));
  assert.equal(fs.readFileSync(path.join(root, 'src/new.js'), 'utf8'), 'hello world');
});

test('W2 replace file inside allowed path succeeds with deterministic evidence', async () => {
  const root = tmpWorkspace();
  writeFile(root, 'src/app.js', 'old content');
  const task = validTask(root);
  const result = await replaceFile(task, 'src/app.js', 'new content', { expectedContent: 'old content' });
  assert.equal(result.status, 'ok');
  assert.equal(result.before_hash, sha256('old content'));
  assert.equal(result.after_hash, sha256('new content'));
  assert.equal(result.changed, true);
  assert.equal(result.created, false);
  assert.equal(fs.readFileSync(path.join(root, 'src/app.js'), 'utf8'), 'new content');
});

// ---------------------------------------------------------------------------
// Scope / path enforcement
// ---------------------------------------------------------------------------

test('W3 traversal ../ is rejected', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const task = validTask(root);
  const result = await createFile(task, '../outside.js', 'x');
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'PATH_REJECTED');
  assert.equal(fs.existsSync(path.join(path.dirname(root), 'outside.js')), false);
});

test('W4 absolute path is rejected', async () => {
  const root = tmpWorkspace();
  const task = validTask(root);
  const result = await createFile(task, '/etc/hearth-write-test.js', 'x');
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'PATH_REJECTED');
});

test('W5 a path outside allowed_paths is rejected', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'other'), { recursive: true });
  const task = validTask(root);
  const result = await createFile(task, 'other/new.js', 'x');
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'PATH_REJECTED');
  assert.equal(fs.existsSync(path.join(root, 'other/new.js')), false);
});

test('W6 a forbidden path inside allowed_paths is rejected', async () => {
  const root = tmpWorkspace();
  writeFile(root, 'src/danger/bad.js', 'existing');
  const task = validTask(root, { scope: { allowed_paths: ['src'], preferred_files: [], forbidden_paths: ['src/danger'] } });
  const result = await replaceFile(task, 'src/danger/bad.js', 'new', { expectedContent: 'existing' });
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'PATH_REJECTED');
  assert.equal(fs.readFileSync(path.join(root, 'src/danger/bad.js'), 'utf8'), 'existing');
});

test('W7 .env is rejected', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const task = validTask(root);
  const result = await createFile(task, 'src/.env', 'SECRET=1');
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'PROTECTED_PATH');
  assert.equal(fs.existsSync(path.join(root, 'src/.env')), false);
});

test('W8 .pem and .key are rejected', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const task = validTask(root);
  const pemResult = await createFile(task, 'src/id.pem', 'x');
  const keyResult = await createFile(task, 'src/id.key', 'x');
  assert.equal(pemResult.code, 'PROTECTED_PATH');
  assert.equal(keyResult.code, 'PROTECTED_PATH');
  assert.equal(fs.existsSync(path.join(root, 'src/id.pem')), false);
  assert.equal(fs.existsSync(path.join(root, 'src/id.key')), false);
});

test('W9 an existing symlink escaping the workspace is rejected', async () => {
  const root = tmpWorkspace();
  const outsideDir = tmpWorkspace();
  const outsideFile = path.join(outsideDir, 'secret.txt');
  fs.writeFileSync(outsideFile, 'outside-original');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.symlinkSync(outsideFile, path.join(root, 'src', 'link.js'));

  const task = validTask(root);
  const result = await replaceFile(task, 'src/link.js', 'malicious', { expectedContent: 'outside-original' });
  assert.equal(result.status, 'error');
  assert.ok(['SYMLINK_ESCAPE', 'PATH_REJECTED'].includes(result.code), JSON.stringify(result));
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'outside-original');
});

test('W10 a symlinked parent directory escaping the workspace is rejected for a new file', async () => {
  const root = tmpWorkspace();
  const outsideDir = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.symlinkSync(outsideDir, path.join(root, 'src', 'linkdir'));

  const task = validTask(root);
  const result = await createFile(task, 'src/linkdir/newfile.js', 'malicious');
  assert.equal(result.status, 'error');
  assert.ok(['SYMLINK_ESCAPE', 'PATH_REJECTED'].includes(result.code), JSON.stringify(result));
  assert.equal(fs.existsSync(path.join(outsideDir, 'newfile.js')), false);
});

test('W11 an ordinary (non-symlink) parent directory behaves normally', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src', 'nested'), { recursive: true });
  const task = validTask(root, { scope: { allowed_paths: ['src'], preferred_files: [], forbidden_paths: [] } });
  const result = await createFile(task, 'src/nested/new.js', 'ok');
  assert.equal(result.status, 'ok');
  assert.equal(fs.readFileSync(path.join(root, 'src/nested/new.js'), 'utf8'), 'ok');
});

test('W12 an exact-file scope grant cannot be widened to place a temp sibling artifact', async () => {
  const root = tmpWorkspace();
  writeFile(root, 'src/app.js', 'original-content');
  const task = validTask(root, { scope: { allowed_paths: ['src/app.js'], preferred_files: [], forbidden_paths: [] } });
  const result = await replaceFile(task, 'src/app.js', 'updated', { expectedContent: 'original-content' });
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'PATH_REJECTED');
  assert.equal(fs.readFileSync(path.join(root, 'src/app.js'), 'utf8'), 'original-content');
  assert.deepEqual(fs.readdirSync(path.join(root, 'src')), ['app.js']);
});

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

test('W13 write byte hard limit is enforced', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const task = validTask(root);
  const bigContent = 'a'.repeat(DEFAULT_EDIT_LIMITS.maxBytesPerWrite + 1);
  const result = await createFile(task, 'src/big.js', bigContent);
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'WRITE_LIMIT_EXCEEDED');
  assert.equal(fs.existsSync(path.join(root, 'src/big.js')), false);
});

test('W14 a huge caller-supplied limit cannot bypass the hard maximum', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const task = validTask(root);
  const overHardMax = 'a'.repeat(1_000_001); // 1 byte over HARD_EDIT_LIMITS.maxBytesPerWrite
  const result = await createFile(task, 'src/huge.js', overHardMax, { limits: { maxBytesPerWrite: Number.POSITIVE_INFINITY } });
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'WRITE_LIMIT_EXCEEDED');
});

test('W15 applyEdits rejects an oversized new_string before resolving the target', async () => {
  const root = tmpWorkspace();
  writeFile(root, 'src/app.js', 'small file');
  const task = validTask(root);
  const result = await applyEdits(task, 'src/app.js', [
    { old_string: 'small', new_string: 'x'.repeat(600_000) }, // over HARD maxBytesPerEditString
  ]);
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'WRITE_LIMIT_EXCEEDED');
  assert.equal(fs.readFileSync(path.join(root, 'src/app.js'), 'utf8'), 'small file');
});

test('W16 applyEdits rejects a huge projected replace_all output before building the string (no huge allocation)', async () => {
  const root = tmpWorkspace();
  writeFile(root, 'src/big.txt', 'x'.repeat(50_000));
  const task = validTask(root);
  const start = Date.now();
  const result = await applyEdits(task, 'src/big.txt', [
    { old_string: 'x', new_string: 'y'.repeat(10_000), replace_all: true },
  ]);
  const elapsedMs = Date.now() - start;
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'WRITE_LIMIT_EXCEEDED');
  assert.ok(elapsedMs < 3000, `took ${elapsedMs}ms -- may have attempted a huge allocation before rejecting`);
  assert.equal(fs.readFileSync(path.join(root, 'src/big.txt'), 'utf8'), 'x'.repeat(50_000));
});

// ---------------------------------------------------------------------------
// Preconditions / conflict safety
// ---------------------------------------------------------------------------

test('W17 exact precondition (expectedContent) succeeds', async () => {
  const root = tmpWorkspace();
  writeFile(root, 'src/app.js', 'v1');
  const task = validTask(root);
  const result = await replaceFile(task, 'src/app.js', 'v2', { expectedContent: 'v1' });
  assert.equal(result.status, 'ok');
});

test('W17b exact precondition (expectedHash) succeeds', async () => {
  const root = tmpWorkspace();
  writeFile(root, 'src/app.js', 'v1');
  const task = validTask(root);
  const result = await replaceFile(task, 'src/app.js', 'v2', { expectedHash: sha256('v1') });
  assert.equal(result.status, 'ok');
});

test('W18 a stale precondition is rejected', async () => {
  const root = tmpWorkspace();
  writeFile(root, 'src/app.js', 'current');
  const task = validTask(root);
  const result = await replaceFile(task, 'src/app.js', 'v2', { expectedContent: 'stale-assumption' });
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'PRECONDITION_FAILED');
});

test('W19 a failed precondition leaves the file completely unchanged', async () => {
  const root = tmpWorkspace();
  writeFile(root, 'src/app.js', 'current');
  const task = validTask(root);
  await replaceFile(task, 'src/app.js', 'v2', { expectedHash: 'not-the-real-hash' });
  assert.equal(fs.readFileSync(path.join(root, 'src/app.js'), 'utf8'), 'current');
});

test('W20 replaceFile without any precondition is rejected (no blind overwrite allowed)', async () => {
  const root = tmpWorkspace();
  writeFile(root, 'src/app.js', 'current');
  const task = validTask(root);
  const result = await replaceFile(task, 'src/app.js', 'v2', {});
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'PRECONDITION_FAILED');
  assert.equal(fs.readFileSync(path.join(root, 'src/app.js'), 'utf8'), 'current');
});

test('W21 createFile never overwrites a file that already exists at the target', async () => {
  const root = tmpWorkspace();
  writeFile(root, 'src/app.js', 'someone-elses-content');
  const task = validTask(root);
  const result = await createFile(task, 'src/app.js', 'my-content');
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'PRECONDITION_FAILED');
  assert.equal(fs.readFileSync(path.join(root, 'src/app.js'), 'utf8'), 'someone-elses-content');
});

test('W22 a target that changes after inspection but before publish is caught by pre-publish revalidation, and the racing content survives', async () => {
  const root = tmpWorkspace();
  const targetAbsolute = writeFile(root, 'src/app.js', 'original');
  const task = validTask(root);
  const result = await replaceFile(task, 'src/app.js', 'my-update', {
    expectedContent: 'original',
    __testTempPathFor: (dir) => {
      // Simulate a concurrent writer landing after our initial read+hash
      // but before this call's own publish step.
      fs.writeFileSync(targetAbsolute, 'raced-content-from-another-writer');
      return path.join(dir, `.x-write-tmp-race-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    },
  });
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'PRECONDITION_FAILED');
  assert.equal(fs.readFileSync(targetAbsolute, 'utf8'), 'raced-content-from-another-writer');
});

test('W23 the same pre-publish revalidation applies to applyEdits', async () => {
  const root = tmpWorkspace();
  const targetAbsolute = writeFile(root, 'src/app.js', 'hello world');
  const task = validTask(root);
  const result = await applyEdits(task, 'src/app.js', [{ old_string: 'hello', new_string: 'goodbye' }], {
    __testTempPathFor: (dir) => {
      fs.writeFileSync(targetAbsolute, 'raced-during-patch');
      return path.join(dir, `.x-write-tmp-race-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    },
  });
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'PRECONDITION_FAILED');
  assert.equal(fs.readFileSync(targetAbsolute, 'utf8'), 'raced-during-patch');
});

// ---------------------------------------------------------------------------
// Temp-file collision and atomic-failure safety
// ---------------------------------------------------------------------------

test('W24 a temp path collision with a file this call did not create leaves that file untouched and returns WRITE_FAILED', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  // Use the realpath'd directory: on macOS, os.tmpdir() lives under a
  // symlink (/var -> /private/var), and the module's own canonical
  // authorized directory is always the realpath'd one -- the collision
  // path must match that exactly to land in the same authorized directory.
  const collisionPath = path.join(fs.realpathSync(path.join(root, 'src')), '.x-write-tmp-collision-sentinel');
  fs.writeFileSync(collisionPath, 'pre-existing-sentinel-content');

  const task = validTask(root);
  const result = await createFile(task, 'src/new.js', 'content', {
    __testTempPathFor: () => collisionPath,
  });

  assert.equal(result.status, 'error');
  assert.equal(result.code, 'WRITE_FAILED');
  assert.equal(fs.readFileSync(collisionPath, 'utf8'), 'pre-existing-sentinel-content');
  assert.equal(fs.existsSync(path.join(root, 'src/new.js')), false);
});

test('W25 an injected temp path outside the authorized directory is rejected before any write', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const outsideDir = tmpWorkspace();
  const outsidePath = path.join(outsideDir, '.x-write-tmp-should-not-exist');

  const task = validTask(root);
  const result = await createFile(task, 'src/new.js', 'content', {
    __testTempPathFor: () => outsidePath,
  });

  assert.equal(result.status, 'error');
  assert.equal(result.code, 'PATH_REJECTED');
  assert.equal(fs.existsSync(outsidePath), false);
});

test('W25b an injected temp path without the reserved prefix is rejected before any write', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const task = validTask(root);
  const result = await createFile(task, 'src/new.js', 'content', {
    __testTempPathFor: (dir) => path.join(dir, 'arbitrary-sibling-name.js'),
  });
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'PATH_REJECTED');
  assert.equal(fs.existsSync(path.join(root, 'src/arbitrary-sibling-name.js')), false);
});

test('W25c an injected temp path targeting .env is rejected before any write', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const task = validTask(root);
  const result = await createFile(task, 'src/new.js', 'content', {
    __testTempPathFor: (dir) => path.join(dir, '.env'),
  });
  assert.equal(result.status, 'error');
  assert.equal(['PATH_REJECTED', 'PROTECTED_PATH'].includes(result.code), true);
  assert.equal(fs.existsSync(path.join(root, 'src/.env')), false);
});

test('W26 requesting src/app.js can never mutate a different authorized file (src/other.js) in the same directory', async () => {
  const root = tmpWorkspace();
  writeFile(root, 'src/app.js', 'app-original');
  writeFile(root, 'src/other.js', 'other-original');
  const task = validTask(root);

  const result = await replaceFile(task, 'src/app.js', 'app-updated', { expectedContent: 'app-original' });

  assert.equal(result.status, 'ok');
  assert.equal(result.path, 'src/app.js');
  assert.equal(fs.readFileSync(path.join(root, 'src/app.js'), 'utf8'), 'app-updated');
  assert.equal(fs.readFileSync(path.join(root, 'src/other.js'), 'utf8'), 'other-original');
});

// ---------------------------------------------------------------------------
// Mode preservation
// ---------------------------------------------------------------------------

test('W27 replaceFile preserves the executable permission bit', async () => {
  const root = tmpWorkspace();
  const filePath = writeFile(root, 'src/script.sh', '#!/bin/sh\necho original\n');
  fs.chmodSync(filePath, 0o755);
  const task = validTask(root);
  const result = await replaceFile(task, 'src/script.sh', '#!/bin/sh\necho updated\n', { expectedContent: '#!/bin/sh\necho original\n' });
  assert.equal(result.status, 'ok');
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o755);
});

test('W28 applyEdits preserves the executable permission bit', async () => {
  const root = tmpWorkspace();
  const filePath = writeFile(root, 'src/script.sh', '#!/bin/sh\necho original\n');
  fs.chmodSync(filePath, 0o755);
  const task = validTask(root);
  const result = await applyEdits(task, 'src/script.sh', [{ old_string: 'original', new_string: 'updated' }]);
  assert.equal(result.status, 'ok');
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o755);
});

// ---------------------------------------------------------------------------
// Determinism / non-mutation / capability surface
// ---------------------------------------------------------------------------

test('W29 hashes and evidence are deterministic', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const task = validTask(root);
  const result = await createFile(task, 'src/new.js', 'deterministic content');
  assert.equal(result.after_hash, sha256('deterministic content'));
  assert.equal(typeof result.bytes_written, 'number');
  assert.equal(result.bytes_written, Buffer.byteLength('deterministic content', 'utf8'));
});

test('W30 the loader/writer does not mutate the validated x-task input', async () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const task = validTask(root);
  const before = JSON.stringify(task);
  await createFile(task, 'src/new.js', 'content');
  assert.equal(JSON.stringify(task), before);
});

test('W31 a missing/invalid scope throws rather than silently expanding to the whole repository', async () => {
  const root = tmpWorkspace();
  const task = validTask(root, { scope: undefined });
  await assert.rejects(() => createFile(task, 'src/new.js', 'x'), XEditScopeError);
});

test('W32 no delete/rename-arbitrary/chmod-arbitrary/shell/network API is exported or reachable', async () => {
  const mod = await import('../mcp/x/edit-writer.mjs');
  for (const name of ['createFile', 'replaceFile', 'applyEdits']) assert.equal(typeof mod[name], 'function');
  // Error classes (XEditError, XEditScopeError) are expected exports; no
  // export whose NAME suggests a delete/rename/move/chmod capability may
  // exist at all.
  const dangerousNamePattern = /delete|remove|rename|move|chmod/i;
  const dangerousExports = Object.keys(mod).filter((name) => dangerousNamePattern.test(name));
  assert.deepEqual(dangerousExports, []);

  const source = fs.readFileSync(new URL('../mcp/x/edit-writer.mjs', import.meta.url), 'utf8');
  // Check for actual imports/calls, not prose mentions in comments (the
  // module's own docstring legitimately says it has no child_process
  // import, which would otherwise false-positive on a bare substring check).
  assert.equal(source.includes("'node:child_process'"), false, 'edit-writer.mjs must not import node:child_process');
  const forbiddenTokens = ['execSync', 'exec(', 'spawn(', 'fetch(', 'http.request', 'https.request', 'rmSync', 'rmdir'];
  for (const token of forbiddenTokens) {
    assert.equal(source.includes(token), false, `forbidden token '${token}' found in edit-writer.mjs`);
  }
});
