// X v0.2 Slice 3: structured repair evidence digest. Deterministic: canned runner output + a few real `node --test` runs in temp
// workspaces; fake ModelAdapter; no model, no network.
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildValidationDigest, DIGEST } from '../mcp/x/repair-digest.mjs';
import { buildRepairEvidence, runTaskWithRepair, truncateTailText } from '../mcp/x/repair-loop.mjs';
import { isRepairTask } from '../mcp/x/local-executor.mjs';
import { loadTaskContext } from '../mcp/x/context-loader.mjs';
import { X_TASK_VERSION } from '../mcp/x/task-contract.mjs';

const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-x-digest-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const write = (root, rel, content) => { const abs = path.join(root, rel); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, content); };
const ROOT = '/work/space';
const FILE = (rel, l, c) => `file://${ROOT}/${rel}:${l}:${c}`;
const NODE_FRAMES = ['      at Test.runInAsyncScope (node:async_hooks:227:14)', '      at Test.run (node:internal/test_runner/test:1382:25)'].join('\n');
const SUMMARY = ['ℹ tests 5', 'ℹ suites 0', 'ℹ pass 3', 'ℹ fail 2', 'ℹ cancelled 0', 'ℹ skipped 0', 'ℹ todo 0', 'ℹ duration_ms 9.3', ''].join('\n');

const assertionBlock = (name, at, msg, expected, actual, frameLoc) => [
  `test at ${at}`, `✖ ${name} (1.2ms)`, `  AssertionError [ERR_ASSERTION]: ${msg}`, '  ', '  4 !== 5', '  ',
  `      at TestContext.<anonymous> (${frameLoc})`, NODE_FRAMES, '      at x {', '    generatedMessage: true,', "    code: 'ERR_ASSERTION',",
  `    actual: ${actual},`, `    expected: ${expected},`, "    operator: 'strictEqual',", "    diff: 'simple'", '  }', '',
].join('\n');
const canned = (blocks, head = ['✖ adds (1ms)', '✔ ok (1ms)']) => `${[...head, SUMMARY, '✖ failing tests:', '', ...blocks].join('\n')}\n`;

test('DG1 assertion failure -> test name, expected, actual, first error, file:line:col, counts (from text only)', () => {
  const out = canned([assertionBlock('adds numbers', 'scripts/test-a.mjs:4:1', 'Expected values to be strictly equal:', '5', '4', FILE('scripts/test-a.mjs', 4, 37))]);
  const d = buildValidationDigest(out, { roots: [ROOT] });
  assert.equal(d.parsed, true);
  assert.equal(d.kind, 'failing_tests');
  assert.deepEqual(d.counts, { tests: 5, pass: 3, fail: 2 });
  for (const want of ['Test results: 2 failed, 3 passed, 5 total.', '1. adds numbers [scripts/test-a.mjs:4]', 'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:', 'expected: 5', 'actual: 4', 'at scripts/test-a.mjs:4:37']) assert.ok(d.text.includes(want), `missing: ${want}\n${d.text}`);
  assert.ok(!d.text.includes(ROOT) && !d.text.includes('file://'), 'no host paths');
  assert.ok(Buffer.byteLength(d.text) <= DIGEST.MAX_BYTES);
});

test('DG2 a thrown error reports the first SOURCE frame and the test-side call site; internal/node_modules frames are ignored', () => {
  const out = canned([[
    'test at scripts/test-a.mjs:6:1', '✖ throws (0.1ms)', '  TypeError: kaboom in boom',
    `      at boom (${FILE('src/m.mjs', 2, 32)})`, `      at TestContext.<anonymous> (${FILE('scripts/test-a.mjs', 6, 24)})`, `      at dep (${FILE('node_modules/x/i.js', 1, 1)})`, NODE_FRAMES, '',
  ].join('\n')]);
  const d = buildValidationDigest(out, { roots: [ROOT] });
  assert.match(d.text, /TypeError: kaboom in boom/);
  assert.match(d.text, /at src\/m\.mjs:2:32 \(called from scripts\/test-a\.mjs:6:24\)/);
  assert.ok(!d.text.includes('node_modules') && !d.text.includes('node:internal'));
});

test('DG3 complex values (deep-equal) fall back to a bounded diff; simple values are printed as expected/actual', () => {
  const diff = ['  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:', '  + actual - expected', '  ', ...Array.from({ length: 30 }, (_, i) => `    line${i}`), '  '].join('\n');
  const out = canned([['test at scripts/test-a.mjs:5:1', '✖ deep (1ms)', diff, `      at TestContext.<anonymous> (${FILE('scripts/test-a.mjs', 5, 37)})`, '    actual: [Object],', '    expected: [Object],', "    operator: 'deepStrictEqual'", ''].join('\n')]);
  const d = buildValidationDigest(out, { roots: [ROOT] });
  assert.ok(!d.text.includes('[Object]'));
  const diffLines = d.text.split('\n').filter((l) => l.trimStart().startsWith('|'));
  assert.equal(diffLines.length, DIGEST.MAX_DIFF_LINES);
  assert.match(d.text, /\| \+ actual - expected/);
});

test('DG4 host paths never leak: workspace paths (also the /private alias) become relative, foreign absolute paths become <external>/name', () => {
  const out = canned([[
    'test at scripts/test-b.mjs:1:1', '✖ scripts/test-b.mjs (0.2ms)',
    `  Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/private${ROOT}/src/missing.mjs' imported from ${ROOT}/scripts/test-b.mjs and /usr/local/lib/thing/x.js`, '', '',
  ].join('\n')]);
  const d = buildValidationDigest(out, { roots: [`/private${ROOT}`] });
  assert.match(d.text, /Cannot find module 'src\/missing\.mjs' imported from scripts\/test-b\.mjs and <external>\/x\.js/);
  assert.ok(!d.text.includes('/usr/local') && !d.text.includes(ROOT));
});

test('DG5 many failures: at most MAX_FAILURES in full, the rest by name; the whole digest stays within the byte cap (multi-byte safe)', () => {
  const blocks = Array.from({ length: 14 }, (_, i) => assertionBlock(`失败 ${i}`.padEnd(60, 'é'), `scripts/test-a.mjs:${i + 3}:1`, `boom ${'é'.repeat(300)}`, `'${'x'.repeat(200)}'`, `'${'y'.repeat(200)}'`, FILE('scripts/test-a.mjs', i + 3, 5)));
  const d = buildValidationDigest(canned(blocks), { roots: [ROOT] });
  assert.equal(d.failures.length, 14);
  assert.ok(Buffer.byteLength(d.text) <= DIGEST.MAX_BYTES, String(Buffer.byteLength(d.text)));
  assert.ok((d.text.match(/^\d+\. /gm) || []).length <= DIGEST.MAX_FAILURES);
  assert.match(d.text, /\.\.\. and \d+ more failing: /);
  assert.ok(!d.text.includes('�'));
  const small = buildValidationDigest(canned(blocks), { roots: [ROOT], maxBytes: 500 });
  assert.ok(Buffer.byteLength(small.text) <= 500);
});

test('DG6 an over-long message keeps its END (the diagnostic), same policy as the raw tail', () => {
  const long = `STARTMARKER${'x'.repeat(5000)}ENDMARKER_ACTUAL_ERROR`;
  const out = canned([['test at scripts/test-a.mjs:2:1', '✖ boom (1ms)', `  Error: ${long}`, `      at TestContext.<anonymous> (${FILE('scripts/test-a.mjs', 2, 20)})`, ''].join('\n')]);
  const d = buildValidationDigest(out, { roots: [ROOT] });
  assert.ok(d.text.includes('ENDMARKER_ACTUAL_ERROR') && !d.text.includes('STARTMARKER'));
  assert.ok(Buffer.byteLength(d.text) <= DIGEST.MAX_BYTES);
});

test('DG7 unparseable / empty / non-string output -> empty digest (callers fall back to the raw tail)', () => {
  for (const input of ['', '   \n', 'just some log noise\nwith no runner structure', undefined, null, 42, { a: 1 }]) {
    const d = buildValidationDigest(input, { roots: [ROOT] });
    assert.deepEqual([d.parsed, d.kind, d.text], [false, null, ''], JSON.stringify(input));
  }
});

test('DG8 no failing section (missing or cut off by the output cap): names of tests marked failed, or the first error with its location', () => {
  const cut = `✖ alpha (1ms)\n✔ ok (1ms)\n  ✖ nested beta (2ms)\n${SUMMARY}`;
  const names = buildValidationDigest(cut, { roots: [ROOT] });
  assert.equal(names.kind, 'names_only');
  assert.match(names.text, /Failed tests \(names only[^)]*\): alpha; nested beta/);
  const crash = `Uncaught:\nTypeError: cannot read 'x' of undefined\n    at run (${FILE('src/app.js', 12, 5)})\n    at node:internal/main:1:1\n`;
  const err = buildValidationDigest(crash, { roots: [ROOT] });
  assert.equal(err.kind, 'error_only');
  assert.match(err.text, /First error: TypeError: cannot read 'x' of undefined\n\s+at src\/app\.js:12:5/);
});

test('DG9 ANSI colors and CRLF line endings are tolerated', () => {
  const esc = String.fromCharCode(27);
  const out = canned([assertionBlock('adds numbers', 'scripts/test-a.mjs:4:1', 'Expected values to be strictly equal:', '5', '4', FILE('scripts/test-a.mjs', 4, 37))])
    .replace(/✖/g, `${esc}[31m✖${esc}[39m`).replace(/\n/g, '\r\n');
  const d = buildValidationDigest(out, { roots: [ROOT] });
  assert.equal(d.kind, 'failing_tests');
  assert.match(d.text, /expected: 5/);
});

test('DG10 pure and deterministic: no imports/fs/process/network/model in the module, identical output for identical input', () => {
  const source = fs.readFileSync(new URL('../mcp/x/repair-digest.mjs', import.meta.url), 'utf8');
  assert.equal(/^\s*import\s/m.test(source), false, 'no imports at all');
  for (const token of ['process.', 'require(', 'fetch(', 'http', 'spawn', 'exec(', 'readFile', 'writeFile', 'Date.now', 'Math.random', 'generate(']) assert.equal(source.includes(token), false, token);
  const out = canned([assertionBlock('adds', 'scripts/test-a.mjs:4:1', 'm', '5', '4', FILE('scripts/test-a.mjs', 4, 37))]);
  assert.deepEqual(buildValidationDigest(out, { roots: [ROOT] }), buildValidationDigest(out, { roots: [ROOT] }));
});

// ------------------------------------------------------------------ repair evidence ----

const roundOf = (result) => ({ round: 1, kind: 'validation', executor: { status: 'completed', changes: [] }, validation: { required: [result], optional: [] }, classification: 'repairable' });
const failed = (stdout, stderr = '') => ({ command: 'node --test scripts/test-a.mjs', status: 'failed', exitCode: 1, signal: null, timedOut: false, stdout, stderr });

test('RE1 unparseable output -> evidence identical to the previous raw-tail format (fallback)', () => {
  const noise = `header noise\n${'z'.repeat(4000)}\nfinal diagnostic line`;
  const evidence = buildRepairEvidence(roundOf(failed(noise)), { workspaceRoot: ROOT });
  const expected = truncateTailText(['Repair context from round 1:', "Validation 'node --test scripts/test-a.mjs': failed; exit 1", `  tail: ${truncateTailText(noise, 1800)}`].join('\n'), 2500);
  assert.equal(evidence, expected);
  assert.ok(!evidence.includes('digest:'));
});

test('RE2 parseable output -> header, status, digest with test/expected/actual/file:line, then a SHORT tail; bounded; still a repair task', () => {
  const out = canned([assertionBlock('adds numbers', 'scripts/test-a.mjs:4:1', 'Expected values to be strictly equal:', '5', '4', FILE('scripts/test-a.mjs', 4, 37))]);
  const evidence = buildRepairEvidence(roundOf(failed(out)), { workspaceRoot: ROOT });
  const lines = evidence.split('\n');
  assert.equal(lines[0], 'Repair context from round 1:');
  assert.match(lines[1], /^Validation 'node --test scripts\/test-a\.mjs': failed; exit 1$/);
  assert.equal(lines[2], '  digest:');
  assert.ok(evidence.includes('    1. adds numbers [scripts/test-a.mjs:4]') && evidence.includes('    expected: 5') && evidence.includes('    at scripts/test-a.mjs:4:37'));
  const tail = evidence.split('\n  tail: ')[1];
  assert.ok(tail && Buffer.byteLength(tail) <= 600, 'short raw tail');
  assert.ok(Buffer.byteLength(evidence) <= 2500);
  assert.equal(isRepairTask({ known_evidence: [evidence] }), true);
});

test('RE3 many failures and large output never exceed the evidence budget or lose the header', () => {
  const blocks = Array.from({ length: 30 }, (_, i) => assertionBlock(`t${i}`, `scripts/test-a.mjs:${i + 3}:1`, 'm'.repeat(400), `'${'x'.repeat(300)}'`, `'${'y'.repeat(300)}'`, FILE('scripts/test-a.mjs', i + 3, 5)));
  const evidence = buildRepairEvidence(roundOf(failed(canned(blocks), 'e'.repeat(9000))), { workspaceRoot: ROOT });
  assert.ok(Buffer.byteLength(evidence) <= 2500);
  assert.ok(evidence.startsWith('Repair context from round 1:'));
  const two = buildRepairEvidence({ ...roundOf(failed('')), validation: { required: [failed(canned(blocks)), failed(canned(blocks))], optional: [] } }, { workspaceRoot: ROOT });
  assert.ok(Buffer.byteLength(two) <= 2500 && two.startsWith('Repair context from round 1:'));
});

test('RE4 execution-kind rounds are unchanged', () => {
  const round = { round: 2, kind: 'execution', executor: { status: 'failed', blockers: [{ code: 'PRECONDITION_FAILED', path: 'src/a.js', detail: 'hash mismatch' }], changes: [{ operation: 'patch', path: 'src/a.js', status: 'failed', code: 'PRECONDITION_FAILED' }] }, validation: null };
  assert.equal(buildRepairEvidence(round), "Repair context from round 2:\nExecution failed: PRECONDITION_FAILED at 'src/a.js' -- hash mismatch\n  patch src/a.js: failed (PRECONDITION_FAILED)");
});

test('RE5 the digest feeds retrieval: its path:line becomes an evidence anchor, and a secret inside the digest is redacted by the loader as before', async () => {
  const root = tmp();
  const bigSource = `${Array.from({ length: 400 }, (_, i) => `const line${i + 1} = ${i + 1}; // ${'x'.repeat(30)}`).join('\n')}\n`;
  write(root, 'src/big.js', bigSource);
  const out = canned([[
    'test at scripts/test-a.mjs:6:1', '✖ throws (0.1ms)', '  TypeError: bad config { "token": "abcdef1234567890" }',
    `      at big (file://${root}/src/big.js:250:7)`, `      at TestContext.<anonymous> (file://${root}/scripts/test-a.mjs:6:24)`, '',
  ].join('\n')]);
  const evidence = buildRepairEvidence(roundOf(failed(out)), { workspaceRoot: root });
  assert.match(evidence, /at src\/big\.js:250:7/);
  const task = {
    version: X_TASK_VERSION, task_id: 'T', workspace: { repo: 'r', root }, objective: 'o', problem: 'p', expected_behavior: 'e', observed_behavior: 'ob', known_evidence: [evidence], suspected_area: ['src/big.js'],
    scope: { allowed_paths: ['src/big.js'], preferred_files: [], forbidden_paths: ['scripts'] }, acceptance_criteria: ['a'],
  };
  const ctx = await loadTaskContext(task);
  const file = ctx.files.find((f) => f.path === 'src/big.js');
  assert.equal(file.status, 'excerpt');
  assert.ok(file.excerpts.some((r) => r.start_line <= 250 && r.end_line >= 250), 'the failing source line is inside a shown window');
  assert.ok(!JSON.stringify(ctx.evidence).includes('abcdef1234567890'), 'secret redaction of known_evidence is unchanged');
});

// ------------------------------------------------------------------ live: real node --test, real repair loop ----

const validTask = (root, over = {}) => ({
  version: X_TASK_VERSION, task_id: 'TASK-DIGEST', parent_task_id: null, revision: 1, attempt: 1, based_on_result_id: null,
  objective: 'Fix the calculator.', problem: 'total(2, 2) is wrong.', expected_behavior: 'total adds.', observed_behavior: 'It adds one extra.', why_this_matters: 'w',
  known_evidence: [], suspected_area: ['src/calc.js'], workspace: { repo: 'r', root },
  scope: { allowed_paths: ['src'], preferred_files: [], forbidden_paths: [] }, constraints: { preserve: [], do_not: [] },
  allowed_tools: ['repo_read', 'repo_edit'], acceptance_criteria: ['a'], validation: { required: ['node --test scripts/test-calc.mjs'], optional: [] }, verification: null,
  done_criteria: ['d'], teaching_notes: [], uncertainty_policy: { policy: 'bounded_autonomy', stop_conditions: [] },
  repair_budget: { initial_attempts: 1, max_repairs: 1, max_total_rounds: 2 },
  timing: { estimated_minutes: 5, first_check_after_minutes: 1, soft_deadline_minutes: 3, hard_timeout_minutes: 10 }, commit_policy: { mode: 'never' }, ...over,
});
const queueAdapter = (responses) => {
  const calls = [];
  return {
    calls,
    generate: async (request) => {
      calls.push(request);
      const payload = responses[Math.min(calls.length - 1, responses.length - 1)];
      return { ok: true, provider: 'fake', model: 'fake', requestedModel: null, text: JSON.stringify(payload), finishReason: 'stop', usage: null, error: null };
    },
  };
};

test('LV1 real failing node --test: round 2 sees test name, expected/actual and file:line; rounds are exactly as budgeted (no extra round)', async () => {
  const root = tmp();
  write(root, 'src/calc.js', 'export const total = (a, b) => a + b + 1;\nexport function explode() { throw new RangeError("out of range in explode"); }\n');
  write(root, 'scripts/test-calc.mjs', [
    "import test from 'node:test';", "import assert from 'node:assert/strict';", "import { total, explode } from '../src/calc.js';",
    "test('total adds two numbers', () => { assert.equal(total(2, 2), 4); });", "test('explode is safe', () => { explode(); });", '',
  ].join('\n'));
  const adapter = queueAdapter([{ actions: [{ type: 'create', path: 'src/unrelated.js', content: 'export {};\n' }] }]);
  const outcome = await runTaskWithRepair(validTask(root), adapter);
  assert.equal(outcome.total_rounds, 2);
  assert.equal(adapter.calls.length, 2, 'the digest adds no repair round');
  assert.equal(outcome.status, 'escalation_required');
  const prompt = adapter.calls[1].messages.map((m) => m.content).join('\n');
  for (const want of ['digest:', '1. total adds two numbers [scripts/test-calc.mjs:4]', 'expected: 4', 'actual: 5', 'at scripts/test-calc.mjs:4:', '2. explode is safe', 'RangeError: out of range in explode', 'at src/calc.js:2:']) assert.ok(prompt.includes(want), `missing: ${want}`);
  assert.ok(!prompt.includes(root), 'no absolute workspace path in the prompt');
  assert.equal(/at Test\.run/.test(prompt.split('digest:')[1].split('  tail:')[0]), false, 'no runner-internal frames in the digest part');
});

test('LV2 real failure whose output has no runner structure (script exits 1 with plain noise) -> the raw-tail evidence is still produced', async () => {
  const root = tmp();
  write(root, 'src/calc.js', 'export {};\n');
  write(root, 'scripts/test-calc.mjs', "console.log('plain noise before exit');\nprocess.exit(1);\n");
  const adapter = queueAdapter([{ actions: [{ type: 'create', path: 'src/x.js', content: 'x' }] }]);
  const outcome = await runTaskWithRepair(validTask(root), adapter);
  assert.equal(outcome.total_rounds, 2);
  const prompt = adapter.calls[1].messages.map((m) => m.content).join('\n');
  assert.match(prompt, /Repair context from round 1:/);
  assert.ok(prompt.includes('tail: plain noise before exit'));
  assert.ok(!prompt.includes('digest:'));
});
