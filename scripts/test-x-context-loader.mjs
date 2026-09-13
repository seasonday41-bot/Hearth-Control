import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  loadTaskContext, XContextScopeError, DEFAULT_CONTEXT_LIMITS,
} from '../mcp/x/context-loader.mjs';
import { redactSecretContent } from '../mcp/x/secret-guard.mjs';
import { X_TASK_VERSION } from '../mcp/x/task-contract.mjs';

const dirs = [];
function tmpWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-x-ctx-'));
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
  task_id: 'TASK-CTX-1',
  parent_task_id: null,
  revision: 1,
  attempt: 1,
  based_on_result_id: null,
  objective: 'Load bounded context.',
  problem: 'The loader needs deterministic, scoped, safe context.',
  expected_behavior: 'Only authorized, secret-safe content is included.',
  observed_behavior: 'No context loader exists yet.',
  why_this_matters: 'Unsafe context would leak secrets or scope.',
  known_evidence: [],
  suspected_area: [],
  workspace: { repo: 'Hearth-Control', root },
  scope: { allowed_paths: ['src'], preferred_files: [], forbidden_paths: [] },
  constraints: { preserve: [], do_not: [] },
  allowed_tools: ['repo_read'],
  acceptance_criteria: ['Context loads.'],
  validation: { required: ['node --test scripts/test-x-context-loader.mjs'], optional: [] },
  verification: null,
  done_criteria: ['Context packet returned.'],
  teaching_notes: [],
  uncertainty_policy: { policy: 'bounded_autonomy', stop_conditions: [] },
  repair_budget: { initial_attempts: 1, max_repairs: 2, max_total_rounds: 3 },
  timing: { estimated_minutes: 5, first_check_after_minutes: 1, soft_deadline_minutes: 3, hard_timeout_minutes: 10 },
  commit_policy: { mode: 'never' },
  ...overrides,
});

const fileEntry = (packet, relPath) => packet.files.find((f) => f.path === relPath);
const omittedEntry = (packet, relPath) => packet.omitted.find((o) => o.path === relPath);

// ---------------------------------------------------------------------------
// Scope enforcement
// ---------------------------------------------------------------------------

test('CTX1 valid scoped file read succeeds', async () => {
  const root = tmpWorkspace();
  writeFile(root, 'src/index.js', 'console.log("hi");\n');
  const task = validTask(root, { scope: { allowed_paths: ['src'], preferred_files: ['src/index.js'], forbidden_paths: [] } });
  const packet = await loadTaskContext(task);
  const file = fileEntry(packet, 'src/index.js');
  assert.ok(file, JSON.stringify(packet.omitted));
  assert.equal(file.status, 'ok');
  assert.match(file.content, /console\.log/);
});

test('CTX2 traversal ../ is rejected', async () => {
  const root = tmpWorkspace();
  writeFile(root, 'src/index.js', 'ok');
  const outsideDir = tmpWorkspace();
  fs.writeFileSync(path.join(outsideDir, 'outside.txt'), 'secret-outside');
  const relPath = path.posix.join('..', path.basename(outsideDir), 'outside.txt');
  const task = validTask(root, { scope: { allowed_paths: ['src'], preferred_files: [relPath], forbidden_paths: [] } });
  const packet = await loadTaskContext(task);
  assert.equal(fileEntry(packet, relPath), undefined);
  const omitted = omittedEntry(packet, relPath);
  assert.ok(omitted);
  assert.equal(omitted.reason, 'scope_violation');
});

test('CTX3 absolute path outside workspace rejected', async () => {
  const root = tmpWorkspace();
  const task = validTask(root, { scope: { allowed_paths: ['src'], preferred_files: ['/etc/passwd'], forbidden_paths: [] } });
  const packet = await loadTaskContext(task);
  assert.equal(packet.files.length, 0);
  assert.equal(packet.omitted[0].reason, 'scope_violation');
});

test('CTX4 allowed_paths enforced -- a file outside allowed_paths is rejected', async () => {
  const root = tmpWorkspace();
  writeFile(root, 'src/a.js', 'a');
  writeFile(root, 'other/b.js', 'b');
  const task = validTask(root, { scope: { allowed_paths: ['src'], preferred_files: ['other/b.js'], forbidden_paths: [] } });
  const packet = await loadTaskContext(task);
  assert.equal(fileEntry(packet, 'other/b.js'), undefined);
  assert.equal(omittedEntry(packet, 'other/b.js').reason, 'scope_violation');
});

test('CTX5 forbidden_paths enforced even inside allowed_paths', async () => {
  const root = tmpWorkspace();
  writeFile(root, 'src/ok.js', 'ok');
  writeFile(root, 'src/danger/bad.js', 'bad');
  const task = validTask(root, { scope: { allowed_paths: ['src'], preferred_files: ['src/danger/bad.js'], forbidden_paths: ['src/danger'] } });
  const packet = await loadTaskContext(task);
  assert.equal(fileEntry(packet, 'src/danger/bad.js'), undefined);
  assert.equal(omittedEntry(packet, 'src/danger/bad.js').reason, 'forbidden_path');
});

test('CTX6 preferred_files cannot bypass scope -- they are hints only, never authorization', async () => {
  const root = tmpWorkspace();
  writeFile(root, 'other/hidden.js', 'nope');
  const task = validTask(root, { scope: { allowed_paths: ['src'], preferred_files: ['other/hidden.js'], forbidden_paths: [] } });
  const packet = await loadTaskContext(task);
  assert.equal(fileEntry(packet, 'other/hidden.js'), undefined);
  // A missing/unauthorized preferred file must be reported as omitted, never
  // escalated to a blocker on its own -- it is a hint, not required evidence.
  assert.equal(omittedEntry(packet, 'other/hidden.js').reason, 'scope_violation');
  assert.equal(packet.blockers.length, 0);
});

test('CTX6b options.requiredPaths IS treated as required evidence and can become a blocker', async () => {
  const root = tmpWorkspace();
  const task = validTask(root, { scope: { allowed_paths: ['src'], preferred_files: [], forbidden_paths: [] } });
  const packet = await loadTaskContext(task, { requiredPaths: ['src/missing.js'] });
  assert.equal(packet.blockers.length, 1);
  assert.equal(packet.blockers[0].path, 'src/missing.js');
});

test('CTX7 symlink escaping the workspace is rejected', async () => {
  const root = tmpWorkspace();
  const outsideDir = tmpWorkspace();
  fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'outside-secret-token');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.symlinkSync(path.join(outsideDir, 'secret.txt'), path.join(root, 'src', 'link.txt'));
  const task = validTask(root, { scope: { allowed_paths: ['src'], preferred_files: ['src/link.txt'], forbidden_paths: [] } });
  const packet = await loadTaskContext(task);
  assert.equal(fileEntry(packet, 'src/link.txt'), undefined);
  assert.equal(JSON.stringify(packet).includes('outside-secret-token'), false);
});

test('CTX8 symlink into a forbidden path (inside the workspace) is rejected', async () => {
  const root = tmpWorkspace();
  writeFile(root, 'src/forbidden/creds.txt', 'forbidden-secret-token');
  fs.symlinkSync(path.join(root, 'src', 'forbidden', 'creds.txt'), path.join(root, 'src', 'ok-looking.txt'));
  const task = validTask(root, { scope: { allowed_paths: ['src'], preferred_files: ['src/ok-looking.txt'], forbidden_paths: ['src/forbidden'] } });
  const packet = await loadTaskContext(task);
  assert.equal(fileEntry(packet, 'src/ok-looking.txt'), undefined);
  assert.equal(JSON.stringify(packet).includes('forbidden-secret-token'), false);
});

test('CTX8b a directory symlink escaping the workspace is never traversed', async () => {
  const root = tmpWorkspace();
  const outsideDir = tmpWorkspace();
  fs.writeFileSync(path.join(outsideDir, 'outside-file.txt'), 'outside-dir-secret-token');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.symlinkSync(outsideDir, path.join(root, 'src', 'linked-dir'));
  writeFile(root, 'src/real-file.js', 'sibling content');

  const readdirCalls = [];
  const realFs = await import('node:fs/promises');
  const spyFsApi = {
    readdir: async (dir, opts) => { readdirCalls.push(dir); return realFs.readdir(dir, opts); },
    stat: (p) => realFs.stat(p),
  };
  const task = validTask(root, { suspected_area: ['src'], scope: { allowed_paths: ['src'], preferred_files: [], forbidden_paths: [] } });
  const packet = await loadTaskContext(task, { fsApi: spyFsApi });

  assert.equal(fileEntry(packet, 'src/real-file.js')?.status, 'ok');
  assert.equal(JSON.stringify(packet).includes('outside-dir-secret-token'), false);
  assert.ok(!readdirCalls.some((d) => d === outsideDir || d.startsWith(`${outsideDir}${path.sep}`)),
    `readdir must never be called on the symlinked-outside directory; calls: ${JSON.stringify(readdirCalls)}`);
});

test('CTX_D1 a forbidden nested directory is never traversed (readdir spy proof)', async () => {
  const root = tmpWorkspace();
  writeFile(root, 'src/ok/sibling.js', 'fine');
  writeFile(root, 'src/danger/deep/leak.js', 'forbidden-nested-secret-token');

  const readdirCalls = [];
  const realFs = await import('node:fs/promises');
  const spyFsApi = {
    readdir: async (dir, opts) => { readdirCalls.push(dir); return realFs.readdir(dir, opts); },
    stat: (p) => realFs.stat(p),
  };
  const task = validTask(root, { suspected_area: ['src'], scope: { allowed_paths: ['src'], preferred_files: [], forbidden_paths: ['src/danger'] } });
  const packet = await loadTaskContext(task, { fsApi: spyFsApi });

  assert.equal(fileEntry(packet, 'src/ok/sibling.js')?.status, 'ok');
  assert.equal(JSON.stringify(packet).includes('forbidden-nested-secret-token'), false);
  const dangerAbsolute = path.join(root, 'src', 'danger');
  assert.ok(!readdirCalls.some((d) => d === dangerAbsolute || d.startsWith(`${dangerAbsolute}${path.sep}`)),
    `readdir must never descend into the forbidden directory; calls: ${JSON.stringify(readdirCalls)}`);
});

test('CTX_D2 a protected-named nested directory is never traversed (readdir spy proof)', async () => {
  const root = tmpWorkspace();
  writeFile(root, 'src/ok/sibling.js', 'fine');
  writeFile(root, 'src/credentials/deep/leak.js', 'protected-nested-secret-token');

  const readdirCalls = [];
  const realFs = await import('node:fs/promises');
  const spyFsApi = {
    readdir: async (dir, opts) => { readdirCalls.push(dir); return realFs.readdir(dir, opts); },
    stat: (p) => realFs.stat(p),
  };
  const task = validTask(root, { suspected_area: ['src'], scope: { allowed_paths: ['src'], preferred_files: [], forbidden_paths: [] } });
  const packet = await loadTaskContext(task, { fsApi: spyFsApi });

  assert.equal(fileEntry(packet, 'src/ok/sibling.js')?.status, 'ok');
  assert.equal(JSON.stringify(packet).includes('protected-nested-secret-token'), false);
  const credsAbsolute = path.join(root, 'src', 'credentials');
  assert.ok(!readdirCalls.some((d) => d === credsAbsolute || d.startsWith(`${credsAbsolute}${path.sep}`)),
    `readdir must never descend into a protected directory; calls: ${JSON.stringify(readdirCalls)}`);
});

test('CTX_D3 a suspected_area directory is cleanly listed with no spurious "unreadable" omission', async () => {
  const root = tmpWorkspace();
  writeFile(root, 'src/a.js', 'a');
  writeFile(root, 'src/b.js', 'b');
  const task = validTask(root, { suspected_area: ['src'], scope: { allowed_paths: ['src'], preferred_files: [], forbidden_paths: [] } });
  const packet = await loadTaskContext(task);
  assert.equal(fileEntry(packet, 'src/a.js')?.status, 'ok');
  assert.equal(fileEntry(packet, 'src/b.js')?.status, 'ok');
  assert.equal(omittedEntry(packet, 'src'), undefined, 'the directory itself must not be reported as unreadable before being listed');
});

test('CTX9 .env is blocked by path', async () => {
  const root = tmpWorkspace();
  writeFile(root, 'src/.env', 'API_KEY=abc123supersecretvalue');
  const task = validTask(root, { scope: { allowed_paths: ['src'], preferred_files: ['src/.env'], forbidden_paths: [] } });
  const packet = await loadTaskContext(task);
  assert.equal(fileEntry(packet, 'src/.env'), undefined);
  assert.equal(omittedEntry(packet, 'src/.env').reason, 'blocked_secret_path');
});

test('CTX10 *.pem is blocked by path', async () => {
  const root = tmpWorkspace();
  writeFile(root, 'src/server.pem', '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----');
  const task = validTask(root, { scope: { allowed_paths: ['src'], preferred_files: ['src/server.pem'], forbidden_paths: [] } });
  const packet = await loadTaskContext(task);
  assert.equal(fileEntry(packet, 'src/server.pem'), undefined);
  assert.equal(omittedEntry(packet, 'src/server.pem').reason, 'blocked_secret_path');
});

test('CTX11 *.key is blocked by path', async () => {
  const root = tmpWorkspace();
  writeFile(root, 'src/id.key', 'super-secret-key-material');
  const task = validTask(root, { scope: { allowed_paths: ['src'], preferred_files: ['src/id.key'], forbidden_paths: [] } });
  const packet = await loadTaskContext(task);
  assert.equal(fileEntry(packet, 'src/id.key'), undefined);
  assert.equal(omittedEntry(packet, 'src/id.key').reason, 'blocked_secret_path');
});

// ---------------------------------------------------------------------------
// Content Secret Guard
// ---------------------------------------------------------------------------

test('CTX12 private-key content in an ordinary file is redacted', async () => {
  const root = tmpWorkspace();
  writeFile(root, 'src/notes.txt', 'before\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\n-----END PRIVATE KEY-----\nafter');
  const task = validTask(root, { scope: { allowed_paths: ['src'], preferred_files: ['src/notes.txt'], forbidden_paths: [] } });
  const packet = await loadTaskContext(task);
  const file = fileEntry(packet, 'src/notes.txt');
  assert.ok(file);
  assert.equal(file.content.includes('MIIEvQIBADANBgkq'), false);
  assert.match(file.content, /REDACTED_PRIVATE_KEY/);
});

test('CTX13 bearer/API/JWT-like secret content is redacted', async () => {
  const root = tmpWorkspace();
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  writeFile(root, 'src/auth.js', `const token = "Bearer abcDEF1234567890";\nconst jwt = "${jwt}";\n`);
  const task = validTask(root, { scope: { allowed_paths: ['src'], preferred_files: ['src/auth.js'], forbidden_paths: [] } });
  const packet = await loadTaskContext(task);
  const file = fileEntry(packet, 'src/auth.js');
  assert.ok(file);
  assert.equal(file.content.includes('abcDEF1234567890'), false);
  assert.equal(file.content.includes(jwt), false);
  assert.match(file.content, /REDACTED/);
});

test('CTX14 credential JSON fields are redacted', async () => {
  const root = tmpWorkspace();
  writeFile(root, 'src/config.json', '{"password": "hunter2superlong", "token": "xyz789secretvalue"}');
  const task = validTask(root, { scope: { allowed_paths: ['src'], preferred_files: ['src/config.json'], forbidden_paths: [] } });
  const packet = await loadTaskContext(task);
  const file = fileEntry(packet, 'src/config.json');
  assert.ok(file);
  assert.equal(file.content.includes('hunter2superlong'), false);
  assert.equal(file.content.includes('xyz789secretvalue'), false);
});

test('CTX15 safe ordinary source code remains readable and unmodified', async () => {
  const root = tmpWorkspace();
  const source = 'export function add(a, b) {\n  return a + b;\n}\n';
  writeFile(root, 'src/math.js', source);
  const task = validTask(root, { scope: { allowed_paths: ['src'], preferred_files: ['src/math.js'], forbidden_paths: [] } });
  const packet = await loadTaskContext(task);
  const file = fileEntry(packet, 'src/math.js');
  assert.equal(file.status, 'ok');
  assert.match(file.content, /export function add/);
});

test('CTX_SEC1 a token on the same line as a search match is redacted before it can appear in context', async () => {
  const root = tmpWorkspace();
  writeFile(root, 'src/leaky.js', 'const findme = "Bearer superSecretToken123456";\n');
  const task = validTask(root, { scope: { allowed_paths: ['src'], preferred_files: [], forbidden_paths: [] } });
  const packet = await loadTaskContext(task, { searchQueries: ['findme'] });
  assert.ok(packet.search_results.length > 0, JSON.stringify(packet));
  const excerpts = packet.search_results.map((r) => r.excerpt).join('\n');
  assert.match(excerpts, /findme/);
  assert.equal(excerpts.includes('superSecretToken123456'), false);
  assert.match(excerpts, /REDACTED/);
});

test('CTX_SEC2 a token inside known_evidence text is redacted in the output', async () => {
  const root = tmpWorkspace();
  const task = validTask(root, { known_evidence: ['Investigate token Bearer superSecretEvidenceToken999'] });
  const packet = await loadTaskContext(task);
  assert.equal(JSON.stringify(packet.evidence).includes('superSecretEvidenceToken999'), false);
});

// ---------------------------------------------------------------------------
// Bounded limits
// ---------------------------------------------------------------------------

test('CTX16 per-file byte limit is enforced', async () => {
  const root = tmpWorkspace();
  writeFile(root, 'src/big.txt', 'a'.repeat(5000));
  const task = validTask(root, { scope: { allowed_paths: ['src'], preferred_files: ['src/big.txt'], forbidden_paths: [] } });
  const packet = await loadTaskContext(task, { limits: { maxBytesPerFile: 100 } });
  const file = fileEntry(packet, 'src/big.txt');
  assert.equal(file.status, 'truncated');
  assert.ok(file.bytes <= 100);
});

test('CTX17 total-context byte limit is enforced across files', async () => {
  const root = tmpWorkspace();
  for (let i = 0; i < 5; i += 1) writeFile(root, `src/f${i}.txt`, 'x'.repeat(500));
  const task = validTask(root, {
    scope: { allowed_paths: ['src'], preferred_files: [0, 1, 2, 3, 4].map((i) => `src/f${i}.txt`), forbidden_paths: [] },
  });
  const packet = await loadTaskContext(task, { limits: { maxTotalBytes: 900, maxBytesPerFile: 500 } });
  const totalFileBytes = packet.files.reduce((sum, f) => sum + f.bytes, 0);
  assert.ok(totalFileBytes <= 900, `total file bytes ${totalFileBytes} exceeded budget`);
  assert.ok(packet.files.length < 5);
  assert.ok(packet.omitted.some((o) => o.reason === 'context_limit'));
});

test('CTX18 search result count and excerpt length limits are enforced', async () => {
  const root = tmpWorkspace();
  const lines = Array.from({ length: 50 }, (_, i) => `needle occurrence number ${i} padding padding padding padding padding padding padding padding`).join('\n');
  writeFile(root, 'src/haystack.js', lines);
  const task = validTask(root, { scope: { allowed_paths: ['src'], preferred_files: [], forbidden_paths: [] } });
  const packet = await loadTaskContext(task, { searchQueries: ['needle'], limits: { maxSearchResults: 5, maxExcerptLength: 20 } });
  assert.equal(packet.search_results.length, 5);
  for (const result of packet.search_results) assert.ok(result.excerpt.length <= 20);
});

test('CTX_HARD1 caller-supplied limits cannot exceed hard maxima', async () => {
  const root = tmpWorkspace();
  const task = validTask(root, {});
  const packet = await loadTaskContext(task, { limits: { maxFiles: 100000, maxTotalBytes: Number.POSITIVE_INFINITY, maxSearchResults: 999999, maxBytesPerFile: 999999999 } });
  assert.ok(packet.limits.maxFiles <= 50);
  assert.ok(packet.limits.maxTotalBytes <= 150000);
  assert.ok(packet.limits.maxSearchResults <= 100);
  assert.ok(packet.limits.maxBytesPerFile <= 20000);
});

test('CTX_HARD2 a huge preferred_files/suspected_area/requiredPaths input cannot inflate the packet (adversarial)', async () => {
  const root = tmpWorkspace();
  const bigList = Array.from({ length: 3000 }, (_, i) => `outside/${'x'.repeat(280)}-${i}`);
  const task = validTask(root, {
    suspected_area: bigList.slice(0, 1000),
    scope: { allowed_paths: ['src'], preferred_files: bigList.slice(1000, 2000), forbidden_paths: [] },
  });
  const start = Date.now();
  const packet = await loadTaskContext(task, { requiredPaths: bigList.slice(2000, 3000) });
  const elapsedMs = Date.now() - start;
  assert.ok(elapsedMs < 5000, `adversarial input took too long: ${elapsedMs}ms`);
  assert.ok(packet.omitted.length <= 110, `omitted grew unbounded: ${packet.omitted.length}`);
  assert.ok(packet.blockers.length <= 110, `blockers grew unbounded: ${packet.blockers.length}`);
});

test('CTX_PACKET1 the final serialized packet never exceeds an adversarially small maxPacketBytes ceiling', async () => {
  const root = tmpWorkspace();
  const bigList = Array.from({ length: 150 }, (_, i) => `outside/${'y'.repeat(280)}-${i}`);
  const task = validTask(root, { scope: { allowed_paths: ['src'], preferred_files: bigList, forbidden_paths: [] } });
  const ceiling = 5000;
  const packet = await loadTaskContext(task, { maxPacketBytes: ceiling });
  const actualBytes = Buffer.byteLength(JSON.stringify(packet), 'utf8');
  assert.ok(actualBytes <= ceiling, `serialized packet ${actualBytes} bytes exceeded ceiling ${ceiling}`);
});

// ---------------------------------------------------------------------------
// Search must never read unauthorized content
// ---------------------------------------------------------------------------

test('CTX_SRCH1 a matching string inside an out-of-scope file is never read, not merely filtered', async () => {
  const root = tmpWorkspace();
  writeFile(root, 'src/inside.js', 'const marker = "findable-token";\n');
  writeFile(root, 'outside/secret.js', 'const marker = "findable-token"; const leak = "very-secret-outside-value";\n');

  const readFileCalls = [];
  const realFs = await import('node:fs/promises');
  const spyFsApiForRead = { readdir: (...a) => realFs.readdir(...a), stat: (...a) => realFs.stat(...a) };
  const { ReadOnlyToolGateway } = await import('../mcp/skills/gateway.mjs');
  const trackingFs = {
    ...realFs,
    readFile: async (...a) => { readFileCalls.push(a[0]); return realFs.readFile(...a); },
  };
  const gateway = new ReadOnlyToolGateway({ workspace: root, fsApi: trackingFs });

  const task = validTask(root, { scope: { allowed_paths: ['src'], preferred_files: [], forbidden_paths: [] } });
  const packet = await loadTaskContext(task, { gateway, fsApi: spyFsApiForRead, searchQueries: ['findable-token'] });

  assert.ok(packet.search_results.every((r) => r.path.startsWith('src/')));
  assert.equal(JSON.stringify(packet).includes('very-secret-outside-value'), false);
  const outsideAbsolute = path.join(root, 'outside', 'secret.js');
  assert.ok(!readFileCalls.includes(outsideAbsolute), `the out-of-scope file must never be read; calls: ${JSON.stringify(readFileCalls)}`);
});

// ---------------------------------------------------------------------------
// Determinism / non-mutation / no-write-capability
// ---------------------------------------------------------------------------

test('CTX19 output ordering is deterministic across repeated calls', async () => {
  const root = tmpWorkspace();
  writeFile(root, 'src/a.js', 'a');
  writeFile(root, 'src/b.js', 'b');
  writeFile(root, 'src/c.js', 'c');
  const task = validTask(root, { scope: { allowed_paths: ['src'], preferred_files: ['src/c.js', 'src/a.js', 'src/b.js'], forbidden_paths: [] } });
  const first = await loadTaskContext(task);
  const second = await loadTaskContext(task);
  assert.deepEqual(first.files.map((f) => f.path), second.files.map((f) => f.path));
  assert.deepEqual(first.files.map((f) => f.path), ['src/c.js', 'src/a.js', 'src/b.js']);
});

test('CTX20 loader does not mutate the validated x-task input', async () => {
  const root = tmpWorkspace();
  writeFile(root, 'src/a.js', 'a');
  const task = validTask(root, { scope: { allowed_paths: ['src'], preferred_files: ['src/a.js'], forbidden_paths: [] } });
  const before = JSON.stringify(task);
  await loadTaskContext(task);
  assert.equal(JSON.stringify(task), before);
});

test('CTX_SCOPE1 a missing/invalid scope throws rather than silently expanding to the whole repository', async () => {
  const root = tmpWorkspace();
  const task = validTask(root, { scope: undefined });
  await assert.rejects(() => loadTaskContext(task), XContextScopeError);
  const emptyAllowed = validTask(root, { scope: { allowed_paths: [], preferred_files: [], forbidden_paths: [] } });
  await assert.rejects(() => loadTaskContext(emptyAllowed), XContextScopeError);
});

test('CTX24 no filesystem write API is reachable through this module (safe timeout-only child.kill is allowed)', () => {
  const source = fs.readFileSync(new URL('../mcp/x/context-loader.mjs', import.meta.url), 'utf8');
  const forbiddenWrite = ['writeFile', 'unlink', 'rmdir', 'rm(', 'rename(', 'chmod(', 'appendFile', 'mkdir('];
  for (const token of forbiddenWrite) assert.equal(source.includes(token), false, `forbidden write token '${token}' found in context-loader.mjs`);
  const forbiddenExec = ['execSync', 'exec('];
  for (const token of forbiddenExec) assert.equal(source.includes(token), false, `forbidden shell-exec token '${token}' found in context-loader.mjs`);
  // Arbitrary process termination must never be reachable -- but the module
  // legitimately calls child.kill('SIGTERM') to end its OWN timed-out,
  // read-only git child process. Assert the dangerous generic form is
  // absent while the narrow, safe, self-owned-child form is what's present.
  assert.equal(source.includes('process.kill('), false, 'arbitrary process.kill must not be reachable');
  assert.match(source, /child\.kill\('SIGTERM'\)/, 'expected only the safe self-owned git-child timeout kill');
});

// ---------------------------------------------------------------------------
// Git context: read-only, bounded, scoped, redacted, honest about failure
// ---------------------------------------------------------------------------

function gitFixture() {
  const root = tmpWorkspace();
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'x@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'X Test'], { cwd: root });
  writeFile(root, 'src/a.js', 'console.log(1);\n');
  writeFile(root, 'outside/b.js', 'console.log(2);\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: root });
  return root;
}

test('CTX21 git inspection is read-only and bounded (branch/head/status/diff present, no mutation)', async () => {
  const root = gitFixture();
  const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
  const task = validTask(root, { scope: { allowed_paths: ['src'], preferred_files: [], forbidden_paths: [] } });
  const packet = await loadTaskContext(task);
  assert.ok(packet.git.branch);
  assert.ok(packet.git.head);
  const after = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
  assert.equal(before, after);
});

test('CTX22 full-repository dump is impossible under default limits', async () => {
  const root = tmpWorkspace();
  for (let i = 0; i < 40; i += 1) writeFile(root, `src/file${i}.js`, `content ${i}\n`.repeat(50));
  const task = validTask(root, { suspected_area: ['src'], scope: { allowed_paths: ['src'], preferred_files: [], forbidden_paths: [] } });
  const packet = await loadTaskContext(task);
  assert.ok(packet.files.length <= DEFAULT_CONTEXT_LIMITS.maxFiles);
});

test('CTX23 existing ReadOnlyToolGateway behavior is not regressed by isProtectedPath export', async () => {
  const { ReadOnlyToolGateway, isProtectedPath } = await import('../mcp/skills/gateway.mjs');
  const root = tmpWorkspace();
  writeFile(root, 'src/.env', 'SECRET=1');
  writeFile(root, 'src/ok.js', 'fine');
  const gateway = new ReadOnlyToolGateway({ workspace: root });
  const listing = await gateway.repoList();
  const envEntry = listing.entries.find((e) => e.path === 'src/.env');
  assert.ok(envEntry.protected);
  assert.equal(isProtectedPath('src/.env'), true);
  assert.equal(isProtectedPath('src/ok.js'), false);
});

test('CTX_GIT1 status/diff are literal-pathspec-scoped to allowed_paths (glob-shaped scope cannot expand matching)', async () => {
  const calls = [];
  const gitRunner = async (args) => { calls.push(args); return null; };
  const root = tmpWorkspace();
  const task = validTask(root, { scope: { allowed_paths: ['mcp/x*'], preferred_files: [], forbidden_paths: ['mcp/x/secret*'] } });
  await loadTaskContext(task, { gitRunner });
  const statusCall = calls.find((c) => c[0] === 'status');
  const diffCall = calls.find((c) => c[0] === 'diff');
  assert.ok(statusCall.includes(':(literal)mcp/x*'), JSON.stringify(statusCall));
  assert.ok(statusCall.includes(':(exclude,literal)mcp/x/secret*'), JSON.stringify(statusCall));
  assert.ok(diffCall.includes(':(literal)mcp/x*'));
  assert.ok(diffCall.includes(':(exclude,literal)mcp/x/secret*'));
});

test('CTX_GIT2 a protected file (.env) under an allowed directory never appears in git status/diff text', async () => {
  const root = tmpWorkspace();
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'x@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'X Test'], { cwd: root });
  writeFile(root, 'src/a.js', 'one\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: root });
  writeFile(root, 'src/.env', 'TOKEN=super-secret-env-value');
  writeFile(root, 'src/a.js', 'one\nchanged\n');

  const task = validTask(root, { scope: { allowed_paths: ['src'], preferred_files: [], forbidden_paths: [] } });
  const packet = await loadTaskContext(task);
  assert.equal(JSON.stringify(packet.git).includes('.env'), false);
  assert.equal(JSON.stringify(packet.git).includes('super-secret-env-value'), false);
  assert.ok(JSON.stringify(packet.git.status || '').includes('a.js') || JSON.stringify(packet.git.diff_summary || '').includes('a.js'));
});

test('CTX_GIT3 a rename from out-of-scope into scope does not leak the out-of-scope source path', async () => {
  const root = tmpWorkspace();
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'x@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'X Test'], { cwd: root });
  writeFile(root, 'outside/secret-name-XYZ.txt', 'content for rename test padding padding padding padding');
  writeFile(root, 'src/keep.js', 'keep');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: root });
  execFileSync('git', ['mv', 'outside/secret-name-XYZ.txt', 'src/renamed.txt'], { cwd: root });

  const task = validTask(root, { scope: { allowed_paths: ['src'], preferred_files: [], forbidden_paths: [] } });
  const packet = await loadTaskContext(task);
  assert.equal(JSON.stringify(packet.git).includes('secret-name-XYZ'), false);
});

test('CTX_GIT4 a rename from a protected path into an allowed directory does not leak the protected source path', async () => {
  const root = tmpWorkspace();
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'x@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'X Test'], { cwd: root });
  writeFile(root, 'src/.env', 'TOKEN=abc');
  writeFile(root, 'src/keep.js', 'keep');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: root });
  execFileSync('git', ['mv', 'src/.env', 'src/env-copy.txt'], { cwd: root });

  const task = validTask(root, { scope: { allowed_paths: ['src'], preferred_files: [], forbidden_paths: [] } });
  const packet = await loadTaskContext(task);
  assert.equal(JSON.stringify(packet.git).includes('.env'), false);
});

test('CTX_GIT_CLEAN1 a successful clean scoped status reports clean=true', async () => {
  const root = gitFixture();
  const task = validTask(root, { scope: { allowed_paths: ['src'], preferred_files: [], forbidden_paths: [] } });
  const packet = await loadTaskContext(task);
  assert.equal(packet.git.clean, true);
});

test('CTX_GIT_CLEAN2 a successful dirty scoped status reports clean=false', async () => {
  const root = gitFixture();
  writeFile(root, 'src/a.js', 'console.log(1);\nconsole.log(2);\n');
  const task = validTask(root, { scope: { allowed_paths: ['src'], preferred_files: [], forbidden_paths: [] } });
  const packet = await loadTaskContext(task);
  assert.equal(packet.git.clean, false);
});

test('CTX_GIT_CLEAN3 a failed/timed-out scoped status reports clean=null, never a false true', async () => {
  const root = tmpWorkspace();
  const failingGitRunner = async () => null;
  const task = validTask(root, { scope: { allowed_paths: ['src'], preferred_files: [], forbidden_paths: [] } });
  const packet = await loadTaskContext(task, { gitRunner: failingGitRunner });
  assert.equal(packet.git.clean, null);
  assert.equal(packet.git.status, null);
  assert.equal(packet.git.diff_summary, null);
});
