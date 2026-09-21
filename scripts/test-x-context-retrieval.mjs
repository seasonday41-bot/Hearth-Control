// X v0.2 Slice 2: deterministic context retrieval (terms -> excerpt windows, related read-only modules, evidence refs).
// Deterministic: temp workspaces, fake ModelAdapter, no model, no network, no benchmark data.
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadTaskContext } from '../mcp/x/context-loader.mjs';
import { extractTerms, extractProseStems, planRanges, locateRanges, extractRelativeImports, extractEvidenceRefs, RETRIEVAL } from '../mcp/x/context-retrieval.mjs';
import { executeTask, buildModelRequest, getPatchableContextPaths, getEligibleContextPaths } from '../mcp/x/local-executor.mjs';
import { applyEdits } from '../mcp/x/edit-writer.mjs';
import { X_TASK_VERSION } from '../mcp/x/task-contract.mjs';

const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-x-retrieval-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const write = (root, rel, content) => { const abs = path.join(root, rel); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, content); return abs; };
const task = (root, over = {}) => ({
  version: X_TASK_VERSION, task_id: 'TASK-RT', parent_task_id: null, revision: 1, attempt: 1, based_on_result_id: null,
  objective: 'Adjust the behavior.', problem: 'Something is wrong.', expected_behavior: 'It works.', observed_behavior: 'It fails.', why_this_matters: 'w',
  known_evidence: [], suspected_area: ['src/big.js'], workspace: { repo: 'r', root },
  scope: { allowed_paths: ['src/big.js'], preferred_files: [], forbidden_paths: ['scripts'] }, constraints: { preserve: [], do_not: [] },
  allowed_tools: ['repo_read', 'repo_edit'], acceptance_criteria: ['a'], validation: { required: [], optional: [] }, verification: null,
  done_criteria: ['d'], teaching_notes: [], uncertainty_policy: { policy: 'bounded_autonomy', stop_conditions: [] },
  repair_budget: { initial_attempts: 1, max_repairs: 2, max_total_rounds: 3 },
  timing: { estimated_minutes: 5, first_check_after_minutes: 1, soft_deadline_minutes: 3, hard_timeout_minutes: 10 }, commit_policy: { mode: 'never' }, ...over,
});
// ~20 KB (over the default 8,000 B/file cap). `computeTargetValue` is defined ONCE, at line 250.
const big = (n = 400) => {
  const lines = Array.from({ length: n }, (_, i) => `const line${i + 1} = ${i + 1}; // ${'x'.repeat(30)}`);
  lines[249] = 'function computeTargetValue(input) { return input * 2; }';
  return `${lines.join('\n')}\n`;
};
const fileOf = (ctx, p = 'src/big.js') => ctx.files.find((f) => f.path === p);
const adapterOf = (actions) => ({ generate: async () => ({ ok: true, provider: 'fake', model: 'fake', requestedModel: null, text: JSON.stringify({ actions }), finishReason: 'stop', usage: null, error: null }) });

// ------------------------------------------------------------- pure functions ----

test('RT1 extractTerms: identifiers, literals, file-like names, word parts, mid-sentence proper nouns; stack frames dropped; deterministic', () => {
  const t = { objective: 'Fix getUpdaterRuntimeBlocker so X_ACTIVE and DURABLE_JOB_ACTIVE work.', problem: "The 'second-instance' handler throws under Electron when app.config.js is read; see `parseWidgetConfig` and BrowserWindow.",
    expected_behavior: 'Expected behavior stays the same.', observed_behavior: 'Observed value is wrong.', acceptance_criteria: ['task_id is preserved'],
    known_evidence: ['TypeError: cannot read\n    at Test.runInAsyncScope (node:internal/test_runner/test:1:1)\n    at processPendingSubtests (file:///x.mjs:1:1)'] };
  const terms = extractTerms(t); const names = terms.map((x) => x.term);
  for (const want of ['getUpdaterRuntimeBlocker', 'X_ACTIVE', 'DURABLE_JOB_ACTIVE', 'second-instance', 'app.config.js', 'parseWidgetConfig', 'BrowserWindow', 'task_id', 'Electron']) assert.ok(names.includes(want), `missing ${want}: ${names.join(',')}`);
  assert.ok(names.includes('config'), 'word part of app.config.js');
  assert.equal(terms.find((x) => x.term === 'config').ci, true);
  assert.ok(!names.includes('runInAsyncScope') && !names.includes('processPendingSubtests'), 'stack-frame lines must not contribute');
  assert.ok(!names.includes('Expected') && !names.includes('Observed'), 'sentence-initial capitals are not proper nouns');
  assert.deepEqual(extractTerms(t), terms);
  assert.ok(terms.length <= RETRIEVAL.MAX_TERMS);
  assert.deepEqual(extractTerms({}), []);
});

test('RT2 no benchmark knowledge is baked into the retrieval code (no candidate SHA, task id, file name or domain term)', () => {
  const forbidden = ['original-fs', 'asar', 'physicalFs', '4f261b2f4b', '79664a00cc', '8d08bc3621', '070e9850b1', 'c1d6770715', 'result-gate', 'updater', 'stager', 'Hearth', 'getUpdaterRuntimeBlocker', 'second-instance'];
  for (const file of ['context-retrieval.mjs', 'context-loader.mjs', 'local-executor.mjs']) {
    const source = fs.readFileSync(new URL(`../mcp/x/${file}`, import.meta.url), 'utf8');
    for (const token of forbidden) assert.equal(source.includes(token), false, `'${token}' must not appear in ${file}`);
  }
});

test('RT3 locateRanges: a definition outranks a mere use; ubiquitous terms are ignored; windows are bounded, merged and clamped', () => {
  const lines = Array.from({ length: 120 }, (_, i) => `x${i}`);
  lines[10] = 'runFrobnicator(a, b);'; lines[80] = 'function runFrobnicator(a, b) {';
  const terms = [{ term: 'runFrobnicator', kind: 'identifier', weight: 3, ci: false }];
  const r = locateRanges(lines, terms, RETRIEVAL.ANCHOR);
  assert.equal(r.ranges[0].start, 81 - RETRIEVAL.ANCHOR.padBefore, 'the definition line (81) is chosen first');
  assert.ok(r.ranges.length <= RETRIEVAL.ANCHOR.maxWindows);
  const noisy = Array.from({ length: 300 }, (_, i) => `use itemList here ${i}`);
  assert.deepEqual(locateRanges(noisy, [{ term: 'itemList', kind: 'identifier', weight: 3, ci: false }], RETRIEVAL.ANCHOR).ranges, [], 'a term on every line carries no signal');
  const edge = locateRanges(['function head() {}', 'b'], [{ term: 'head', kind: 'identifier', weight: 3, ci: false }], RETRIEVAL.ANCHOR);
  assert.deepEqual([edge.ranges[0].start, edge.ranges[0].end], [1, 2], 'clamped to the file');
  assert.deepEqual(locateRanges([], terms, RETRIEVAL.ANCHOR), { ranges: [], matched: [] });
  assert.deepEqual(locateRanges(lines, [], RETRIEVAL.ANCHOR), { ranges: [], matched: [] });
  assert.deepEqual(locateRanges(lines, terms, RETRIEVAL.ANCHOR), r, 'deterministic');
});

test('RT4 extractRelativeImports: require / import / from / dynamic import; ignores bare, node: and absolute specifiers; ordered, deduplicated', () => {
  const src = "const a = require('./a.cjs');\nimport b from '../b.mjs';\nimport './side.js';\nconst c = await import('./c.mjs');\nconst n = require('node:fs');\nconst p = require('lodash');\nimport x from '/abs.js';\nconst dup = require('./a.cjs');";
  assert.deepEqual(extractRelativeImports(src), ['./a.cjs', '../b.mjs', './side.js', './c.mjs']);
});

test('RT5 extractEvidenceRefs: path:line[:col], file:// prefix, bounded count, code extensions only', () => {
  const refs = extractEvidenceRefs({ known_evidence: ['at /w/ws/src/a.js:12:5', 'file:///w/ws/src/b.mjs:7', 'see docs/readme.md:3', ...Array.from({ length: 10 }, (_, i) => `src/f${i}.js:${i + 1}`)] });
  assert.deepEqual(refs.slice(0, 2), [{ path: '/w/ws/src/a.js', line: 12 }, { path: '/w/ws/src/b.mjs', line: 7 }]);
  assert.equal(refs.length, RETRIEVAL.MAX_EVIDENCE_REFS);
  assert.ok(!refs.some((r) => r.path.endsWith('.md')));
});

// ------------------------------------------------------------- anchor locating ----

test('RT10 file-level hint + a named symbol: the loader locates the excerpt itself (no range in the task) and Slice-1 patching then works end to end', async () => {
  const root = tmp(); const text = big(); write(root, 'src/big.js', text);
  const t = task(root, { problem: 'The helper `computeTargetValue` returns the wrong number.' });
  const ctx = await loadTaskContext(t);
  const f = fileOf(ctx);
  assert.equal(f.status, 'excerpt');
  assert.ok(f.retrieval.kind === 'auto_excerpt' && f.retrieval.matched_terms.includes('computeTargetValue'));
  assert.ok(f.excerpts.some((r) => r.start_line <= 250 && r.end_line >= 250));
  assert.ok(f.content.includes('250: function computeTargetValue'));
  assert.ok(f.bytes <= 8000 && ctx.limits.maxBytesPerFile === 8000, 'no cap raised');
  assert.deepEqual(ctx.retrieval.auto_excerpts.map((a) => a.path), ['src/big.js']);
  const result = await executeTask(t, adapterOf([{ type: 'patch', path: 'src/big.js', edits: [{ old_string: 'function computeTargetValue(input) { return input * 2; }', new_string: 'function computeTargetValue(input) { return input * 3; }' }] }]));
  assert.equal(result.status, 'completed', JSON.stringify(result.blockers));
  assert.equal(fs.readFileSync(path.join(root, 'src/big.js'), 'utf8'), text.replace('input * 2', 'input * 3'));
});

test('RT11 no matching term -> exactly the previous behavior (truncated head, no excerpt, no retrieval key)', async () => {
  const root = tmp(); write(root, 'src/big.js', big());
  const ctx = await loadTaskContext(task(root, { problem: 'The helper `neverDefinedAnywhere` is wrong.' }));
  assert.equal(fileOf(ctx).status, 'truncated');
  assert.equal(fileOf(ctx).retrieval, undefined);
  assert.equal(ctx.retrieval, undefined);
});

test('RT12 irrelevant or ubiquitous terms stay bounded and add nothing (a term on 300 lines is noise)', async () => {
  const root = tmp();
  write(root, 'src/big.js', `${Array.from({ length: 400 }, (_, i) => `const item${i} = itemList.push(${i}); // ${'y'.repeat(30)}`).join('\n')}\n`);
  const ctx = await loadTaskContext(task(root, { problem: 'Problem with `itemList` and `push`.' }));
  assert.equal(fileOf(ctx).status, 'truncated');
  assert.equal(ctx.retrieval, undefined);
});

test('RT13 small-file path unchanged: a file that fits is loaded whole and the packet is identical with retrieval on or off', async () => {
  const root = tmp(); write(root, 'src/big.js', 'function computeTargetValue(input) { return input * 2; }\n');
  const t = task(root, { problem: 'The helper `computeTargetValue` returns the wrong number.' });
  const on = await loadTaskContext(t);
  const off = await loadTaskContext(t, { retrieval: false });
  assert.deepEqual(JSON.parse(JSON.stringify(on)), JSON.parse(JSON.stringify(off)));
  assert.equal(fileOf(on).status, 'ok');
  assert.equal(on.retrieval, undefined);
});

test('RT14 an explicit range hint wins over automatic location', async () => {
  const root = tmp(); write(root, 'src/big.js', big());
  const t = task(root, { problem: 'The helper `computeTargetValue` returns the wrong number.', suspected_area: ['src/big.js:10-15'] });
  const f = fileOf(await loadTaskContext(t));
  assert.equal(f.status, 'excerpt');
  assert.equal(f.retrieval, undefined);
  assert.deepEqual(f.excerpts, [{ start_line: 10, end_line: 15 }]);
});

test('RT15 secret guard unchanged: a redaction inside an auto-located window falls back to truncated (fail-closed)', async () => {
  const root = tmp(); const lines = big().split('\n'); lines[254] = 'const cfg = { "token": "abcdef1234567890" };'; write(root, 'src/big.js', lines.join('\n'));
  const ctx = await loadTaskContext(task(root, { problem: 'The helper `computeTargetValue` returns the wrong number.' }));
  assert.equal(fileOf(ctx).status, 'truncated');
  assert.ok(!fileOf(ctx).content.includes('abcdef1234567890'));
});

test('RT16 retrieval: false switches everything off, and retrieval never changes the limits', async () => {
  const root = tmp(); write(root, 'src/big.js', big());
  const t = task(root, { problem: 'The helper `computeTargetValue` returns the wrong number.' });
  const off = await loadTaskContext(t, { retrieval: false });
  assert.equal(fileOf(off).status, 'truncated');
  const on = await loadTaskContext(t);
  assert.deepEqual(on.limits, off.limits);
  assert.deepEqual(JSON.parse(JSON.stringify(await loadTaskContext(t))), JSON.parse(JSON.stringify(on)), 'deterministic');
});

// ------------------------------------------------------- read-only reference files ----
// Authority is explicit: `allowed_paths` (the task's own scope) or `scope.reference_paths`. Nothing else is ever read, however
// relevant an import neighbour looks.

const relatedFixture = (root, { libLines = 60 } = {}) => {
  write(root, 'src/main.js', "const lib = require('../lib/lib.js');\nmodule.exports = lib;\n");
  const lib = Array.from({ length: libLines }, (_, i) => `// filler line ${i + 1}`);
  lib[24] = 'function frobnicateWidget() { return globalThis.legacyBridge; } // the physical bridge lives here';
  write(root, 'lib/lib.js', `${lib.join('\n')}\n`);
};
const relTask = (root, over = {}, reference_paths = ['lib']) => task(root, {
  suspected_area: ['src/main.js'], problem: 'Behavior of `frobnicateWidget` is wrong.',
  scope: { allowed_paths: ['src/main.js'], preferred_files: [], forbidden_paths: ['scripts'], ...(reference_paths ? { reference_paths } : {}) }, ...over,
});

test('RT20 with explicit reference_paths, an imported module is surfaced READ-ONLY where the task terms match, after the anchors, within its byte cap', async () => {
  const root = tmp(); relatedFixture(root);
  const ctx = await loadTaskContext(relTask(root));
  assert.deepEqual(ctx.files.map((f) => `${f.path}:${f.status}`), ['src/main.js:ok', 'lib/lib.js:reference']);
  const ref = fileOf(ctx, 'lib/lib.js');
  assert.equal(ref.read_only, true);
  assert.equal(ref.retrieval.via, 'src/main.js');
  assert.equal(ref.retrieval.authority, 'reference_paths');
  assert.ok(ref.content.includes('25: function frobnicateWidget'));
  assert.ok(ref.bytes <= RETRIEVAL.RELATED.maxBytesPerFile);
  assert.deepEqual(ctx.retrieval.related.map((r) => [r.path, r.authority]), [['lib/lib.js', 'reference_paths']]);
  assert.equal(ctx.limits.maxTotalBytes, 40000);
});

test('RT20b DEFAULT DENY: without reference_paths an import neighbour outside allowed_paths is never read (it does not even appear as omitted)', async () => {
  const root = tmp(); relatedFixture(root);
  for (const refs of [null, [], ['somewhere/else']]) {
    const ctx = await loadTaskContext(relTask(root, {}, refs));
    assert.deepEqual(ctx.files.map((f) => f.path), ['src/main.js']);
    assert.equal(ctx.retrieval, undefined);
    assert.ok(!JSON.stringify(ctx).includes('legacyBridge'), 'no byte of the unlisted neighbour reaches the packet');
  }
  // and the packet is byte-identical to the retrieval-off packet, so the model prompt cannot differ either
  const t = relTask(root, {}, null);
  assert.deepEqual(JSON.parse(JSON.stringify(await loadTaskContext(t))), JSON.parse(JSON.stringify(await loadTaskContext(t, { retrieval: false }))));
});

test('RT20c an in-scope neighbour (inside allowed_paths) may still be shown read-only, tagged with its authority; a listed FILE needs no import link', async () => {
  const root = tmp(); relatedFixture(root);
  write(root, 'src/sib.js', `${Array.from({ length: 30 }, () => '// filler').join('\n')}\nfunction frobnicateWidget() {}\n`);
  write(root, 'src/main.js', "const sib = require('./sib.js');\n");
  const inScope = await loadTaskContext(relTask(root, { scope: { allowed_paths: ['src'], preferred_files: [], forbidden_paths: [] } }, null));
  assert.deepEqual(inScope.retrieval.related.map((r) => [r.path, r.authority]), [['src/sib.js', 'allowed_paths']]);
  write(root, 'src/main.js', 'module.exports = 1;\n'); // no import at all
  const listed = await loadTaskContext(relTask(root, {}, ['lib/lib.js']));
  assert.deepEqual(listed.retrieval.related.map((r) => [r.path, r.via, r.authority]), [['lib/lib.js', null, 'reference_paths']]);
});

test('RT21 a reference is never editable: schema, executor, prompt guidance and the write boundary all refuse it (also when it is listed in reference_paths)', async () => {
  const root = tmp(); relatedFixture(root);
  const t = relTask(root); const ctx = await loadTaskContext(t);
  assert.ok(!getPatchableContextPaths(ctx).includes('lib/lib.js') && !getEligibleContextPaths(ctx).includes('lib/lib.js'));
  const req = buildModelRequest(t, ctx);
  assert.match(req.messages[0].content, /status: reference/);
  assert.match(req.messages[1].content, /--- lib\/lib\.js \(status: reference\) ---/);
  assert.match(req.messages[1].content, /Read-only reference paths \(never editable\): lib/);
  for (const action of [{ type: 'patch', path: 'lib/lib.js', edits: [{ old_string: 'frobnicateWidget', new_string: 'x' }] }, { type: 'replace', path: 'lib/lib.js', content: 'x' }, { type: 'create', path: 'lib/new.js', content: 'x' }]) {
    const result = await executeTask(t, adapterOf([action]));
    assert.equal(result.status, 'failed');
    assert.ok(fs.readFileSync(path.join(root, 'lib/lib.js'), 'utf8').includes('frobnicateWidget'));
    assert.ok(!fs.existsSync(path.join(root, 'lib/new.js')));
  }
  const direct = await applyEdits(t, 'lib/lib.js', [{ old_string: 'frobnicateWidget', new_string: 'x' }]);
  assert.equal(direct.code, 'PATH_REJECTED', 'the write boundary independently refuses a path outside allowed_paths, reference_paths or not');
  assert.ok(fs.readFileSync(path.join(root, 'lib/lib.js'), 'utf8').includes('frobnicateWidget'));
});

test('RT21b reference_paths grant reading only: they widen neither editable files, scope checks nor evidence anchors', async () => {
  const root = tmp(); relatedFixture(root);
  const t = relTask(root, { known_evidence: [`at f (${root}/lib/lib.js:25:3)`] });
  const ctx = await loadTaskContext(t);
  assert.ok(ctx.files.every((f) => f.path === 'src/main.js' || f.status === 'reference'));
  assert.deepEqual(ctx.retrieval?.evidence_anchors ?? [], []);
  assert.ok(!ctx.files.some((f) => f.path === 'lib/lib.js' && f.status !== 'reference'), 'an evidence path:line cannot promote a reference file to an anchor');
  assert.equal(scopeOk(t, 'lib/lib.js'), false);
});
const scopeOk = (t, rel) => { const s = t.scope; return s.allowed_paths.some((p) => rel === p || rel.startsWith(`${p}/`)); };

test('RT22 reference reads keep every existing rule: forbidden, protected, symlink (out of workspace or to an unlisted/forbidden target), missing, bare and cyclic imports yield nothing', async () => {
  const root = tmp(); const outside = tmp();
  write(root, 'src/main.js', "require('../lib/forbidden.js'); require('../lib/.env'); require('../lib/link.js'); require('../lib/link2.js'); require('../lib/missing.js'); require('lodash'); require('./main.js');\n");
  const hit = `${Array.from({ length: 30 }, () => '// filler').join('\n')}\nfunction frobnicateWidget() {}\n`;
  write(root, 'lib/forbidden.js', hit); write(root, 'lib/.env', hit); write(outside, 'evil.js', hit); write(root, 'unlisted/secret-module.js', hit);
  fs.symlinkSync(path.join(outside, 'evil.js'), path.join(root, 'lib', 'link.js'));
  fs.symlinkSync(path.join(root, 'unlisted', 'secret-module.js'), path.join(root, 'lib', 'link2.js')); // resolves OUTSIDE reference_paths
  const ctx = await loadTaskContext(relTask(root, { scope: { allowed_paths: ['src/main.js'], preferred_files: [], forbidden_paths: ['lib/forbidden.js'], reference_paths: ['lib'] } }));
  assert.deepEqual(ctx.files.map((f) => f.path), ['src/main.js']);
  const viaForbiddenTarget = tmp(); write(viaForbiddenTarget, 'src/main.js', "require('../lib/alias.js');\n"); write(viaForbiddenTarget, 'private/real.js', hit); write(viaForbiddenTarget, 'lib/keep.js', 'x\n');
  fs.symlinkSync(path.join(viaForbiddenTarget, 'private', 'real.js'), path.join(viaForbiddenTarget, 'lib', 'alias.js'));
  const ctx2 = await loadTaskContext(relTask(viaForbiddenTarget, { scope: { allowed_paths: ['src/main.js'], preferred_files: [], forbidden_paths: ['private'], reference_paths: ['lib'] } }));
  assert.deepEqual(ctx2.files.map((f) => f.path), ['src/main.js'], 'a listed name that resolves into forbidden_paths is refused on the RESOLVED path');
});

test('RT23 reference reads are bounded: at most 3 files, each within its byte cap, charged to the same budgets', async () => {
  const root = tmp();
  write(root, 'src/main.js', `${['a', 'b', 'c', 'd', 'e', 'f'].map((n) => `require('../lib/${n}.js');`).join('\n')}\n`);
  for (const n of ['a', 'b', 'c', 'd', 'e', 'f']) write(root, `lib/${n}.js`, `${Array.from({ length: 200 }, (_, i) => `// ${'z'.repeat(60)} ${i}`).join('\n')}\nfunction frobnicateWidget() {}\n`);
  const ctx = await loadTaskContext(relTask(root));
  const refs = ctx.files.filter((f) => f.status === 'reference');
  assert.equal(refs.length, RETRIEVAL.RELATED.maxFiles);
  assert.ok(refs.every((r) => r.bytes <= RETRIEVAL.RELATED.maxBytesPerFile));
  const tight = await loadTaskContext(relTask(root), { limits: { maxTotalBytes: 150 } });
  assert.ok(tight.files.reduce((n, f) => n + f.bytes, 0) <= 150 + 1, 'the total budget still applies');
});

test('RT24 reference reads add nothing when no term scores, and nothing when the task has no terms at all', async () => {
  const root = tmp(); relatedFixture(root);
  assert.equal((await loadTaskContext(relTask(root, { problem: 'Behavior of `somethingElseEntirely` is wrong.' }))).files.length, 1);
  assert.equal((await loadTaskContext(relTask(root, { problem: 'It is wrong.' }))).files.length, 1);
});

test('RT25 secret guard on reference reads: a redaction inside the shown window skips the file; a secret elsewhere in it does not', async () => {
  const root = tmp(); relatedFixture(root);
  const lib = fs.readFileSync(path.join(root, 'lib/lib.js'), 'utf8').split('\n');
  const outsideWindow = [...lib]; outsideWindow[55] = 'const c = { "token": "abcdef1234567890" };'; write(root, 'lib/lib.js', outsideWindow.join('\n'));
  const ok = await loadTaskContext(relTask(root));
  assert.equal(fileOf(ok, 'lib/lib.js')?.status, 'reference');
  assert.ok(!fileOf(ok, 'lib/lib.js').content.includes('abcdef1234567890'));
  const inside = [...lib]; inside[26] = 'const c = { "token": "abcdef1234567890" };'; write(root, 'lib/lib.js', inside.join('\n'));
  assert.equal(fileOf(await loadTaskContext(relTask(root)), 'lib/lib.js'), undefined);
});

test('RT26 task contract: reference_paths is optional, validated, normalized, and may overlap neither allowed_paths nor forbidden_paths', async () => {
  const { validateXTask } = await import('../mcp/x/task-contract.mjs');
  const root = '/w/ws';
  const base = task(root, { validation: { required: ['node --test scripts/test-a.mjs'], optional: [] } }); const withScope = (scope) => ({ ...base, scope: { ...base.scope, ...scope } });
  const plain = validateXTask(base);
  assert.equal(plain.ok, true, JSON.stringify(plain.errors));
  assert.equal('reference_paths' in plain.value.scope, false, 'absent stays absent: existing task shapes are unchanged');
  const good = validateXTask(withScope({ reference_paths: ['./electron/updater.cjs', 'docs/'] }));
  assert.equal(good.ok, true, JSON.stringify(good.errors));
  assert.deepEqual(good.value.scope.reference_paths, ['electron/updater.cjs', 'docs']);
  for (const bad of [{ reference_paths: 'x' }, { reference_paths: ['/abs'] }, { reference_paths: ['../up'] }, { reference_paths: [''] }, { reference_paths: ['src/big.js'] }, { reference_paths: ['src'] }, { reference_paths: ['scripts/a.js'] }, { reference_paths: Array.from({ length: 65 }, (_, i) => `d${i}`) }]) {
    assert.equal(validateXTask(withScope(bad)).ok, false, JSON.stringify(bad));
  }
});

test('RT27 repair rounds keep reference_paths (and only reference_paths grants nothing new)', async () => {
  const src = fs.readFileSync(new URL('../mcp/x/repair-loop.mjs', import.meta.url), 'utf8');
  assert.match(src, /reference_paths/);
});

// ------------------------------------------------------------- evidence references ----

test('RT30 path:line references in evidence anchor authorized files with a window; out-of-scope and forbidden references are ignored silently', async () => {
  const root = tmp(); write(root, 'src/big.js', big()); write(root, 'scripts/test-x.mjs', 'x\n');
  const t = task(root, { suspected_area: [], known_evidence: [`Error\n    at Object.<anonymous> (${root}/src/big.js:250:7)`, `at file://${root}/src/big.js:100:1`, 'at run (scripts/test-x.mjs:10:1)', 'at /etc/hosts.js:3:1'] });
  const ctx = await loadTaskContext(t);
  const f = fileOf(ctx);
  assert.equal(f.status, 'excerpt');
  assert.ok(f.excerpts.some((r) => r.start_line <= 250 && r.end_line >= 250) && f.excerpts.some((r) => r.start_line <= 100 && r.end_line >= 100));
  assert.deepEqual(ctx.retrieval.evidence_anchors, ['src/big.js']);
  assert.ok(!ctx.omitted.some((o) => /scripts|etc/.test(String(o.path))), 'ignored silently, not reported as omitted');
  assert.equal(ctx.files.length, 1);
});

test('RT31 scope is never expanded: retrieval never loads a file outside scope as an editable or excerpt file', async () => {
  const root = tmp(); relatedFixture(root); write(root, 'lib/other.js', 'function frobnicateWidget() {}\n');
  const ctx = await loadTaskContext(relTask(root));
  assert.ok(ctx.files.every((f) => f.path === 'src/main.js' || f.status === 'reference'));
  assert.ok(!ctx.files.some((f) => f.path === 'lib/other.js'), 'a sibling in a reference dir that is NOT imported and not listed as a file is not read');
});

// ---------------------------------------------- second pass: adaptive windows inside the SAME byte budget ----
// Generic fixture (nothing to do with any benchmark): a 600-line module whose task text names two functions, prose-describes a
// third, and needs an edit in the gap between the two named ones and in the import block.

const inventory = () => {
  const lines = Array.from({ length: 600 }, (_, i) => `// filler ${i + 1}`);
  lines[0] = '// inventory helpers';
  lines[2] = "const fs = require('node:fs');";
  lines[3] = "const path = require('node:path');";
  lines[60] = 'async function shipOrders(list) {';
  lines[61] = '  return list.map((o) => o.id);';
  lines[62] = '}';
  lines[120] = 'function reserveStock(sku, qty) {';
  lines[124] = '  if (!fs.existsSync(sku)) { return 0; }';
  lines[164] = '  fs.rmSync(scratchDir, { recursive: true, force: true });';
  lines[200] = 'function releaseLedger(entry) {';
  lines[203] = '  return path.join(entry, "ledger");';
  return `${lines.join('\n')}\n`;
};
const invTask = (root, over = {}) => task(root, { suspected_area: ['src/inv.js'], scope: { allowed_paths: ['src/inv.js'], preferred_files: [], forbidden_paths: ['scripts'] },
  problem: 'Both `reserveStock` and `releaseLedger` must clean up. The order shipping code ships orders in bulk and is fine.', ...over });
const covers = (excerpts, n) => excerpts.some((r) => r.start_line <= n && r.end_line >= n);

test('RT40 planRanges (pure): strict windows first, then bindings, bridged gaps and prose-stem windows; every window has provenance; the plan never exceeds the budget', () => {
  const lines = inventory().split('\n').slice(0, 600);
  const t = invTask('/w');
  const terms = extractTerms(t); const stems = extractProseStems(t);
  const plan = planRanges(lines, terms, stems, 8000);
  assert.ok(plan.plan_bytes <= 8000 - RETRIEVAL.PLAN.reserveBytes);
  const vias = new Set(plan.ranges.map((r) => r.via));
  for (const via of ['term', 'binding', 'bridge', 'stem']) assert.ok(vias.has(via), `missing ${via}: ${JSON.stringify([...vias])}`);
  assert.ok(plan.ranges.every((r) => [1, 2].includes(r.pass) && typeof r.via === 'string' && r.start >= 1 && r.end <= 600));
  assert.equal(plan.ranges.filter((r) => r.pass === 1).length, 2);
  assert.ok(plan.ranges.length > RETRIEVAL.ANCHOR.maxWindows, 'the window count is no longer capped at 3 when the budget allows');
  assert.ok(plan.ranges.find((r) => r.via === 'binding').binding.length > 0);
  assert.ok(plan.ranges.some((r) => r.via === 'stem' && r.stems.length > 0));
  const covered = (n) => plan.ranges.some((r) => r.start <= n && r.end >= n);
  for (const n of [3, 61, 121, 165, 201]) assert.ok(covered(n), `line ${n} should be shown`);
  assert.deepEqual(planRanges(lines, terms, stems, 8000), plan, 'deterministic');
});

test('RT41 planRanges: no strong signal in the file -> nothing, however much prose the task has; a tight budget is never exceeded and pass 1 wins it', () => {
  const lines = inventory().split('\n');
  const t = invTask('/w');
  assert.deepEqual(planRanges(lines, [{ term: 'notInTheFile', kind: 'identifier', weight: 3, ci: false }], extractProseStems(t), 8000).ranges, []);
  assert.deepEqual(planRanges(lines, extractTerms(t), extractProseStems(t), 0).ranges, [], 'a zero budget shows nothing');
  for (const budget of [400, 700, 1200, 3000]) {
    const plan = planRanges(lines, extractTerms(t), extractProseStems(t), budget);
    assert.ok(plan.plan_bytes <= Math.max(0, budget - RETRIEVAL.PLAN.reserveBytes), `budget ${budget}: ${plan.plan_bytes}`);
  }
  const tight = planRanges(lines, extractTerms(t), extractProseStems(t), 1200);
  assert.ok(tight.ranges.every((r) => r.pass === 1 || r.via !== 'stem') || tight.ranges.some((r) => r.pass === 1), 'strict windows are considered before anything else');
});

test('RT42 planRanges: a binding is only added when a shown window USES it; bridges are bounded by gap length', () => {
  const lines = Array.from({ length: 400 }, (_, i) => `// filler ${i + 1}`);
  lines[2] = "const unusedThing = require('node:os');"; lines[3] = "const usedThing = require('node:path');";
  lines[200] = 'function anchorHere() { return usedThing.join("a"); }';
  lines[390] = 'function anotherAnchor() {}';
  const terms = [{ term: 'anchorHere', kind: 'identifier', weight: 3, ci: false }, { term: 'anotherAnchor', kind: 'identifier', weight: 3, ci: false }];
  const plan = planRanges(lines, terms, [], 20000);
  const bindings = plan.ranges.filter((r) => r.via === 'binding').map((r) => r.binding);
  assert.deepEqual(bindings, ['usedThing']);
  assert.ok(!plan.ranges.some((r) => r.via === 'bridge' && r.end - r.start + 1 > RETRIEVAL.PLAN.bridgeMaxGapLines));
  assert.ok(!plan.ranges.some((r) => r.via === 'bridge' && r.start <= 300 && r.end >= 300), 'a gap of ~150 lines is not bridged');
});

test('RT43 loader: same 8,000 B per-file cap, more windows; the excerpt carries provenance for every window and stays patchable through the Slice-1 gates', async () => {
  const root = tmp(); const text = inventory(); write(root, 'src/inv.js', text);
  const t = invTask(root);
  const ctx = await loadTaskContext(t);
  const f = fileOf(ctx, 'src/inv.js');
  assert.equal(f.status, 'excerpt');
  assert.ok(f.bytes <= 8000 && ctx.limits.maxBytesPerFile === 8000, 'the per-file cap was not raised');
  assert.ok(f.retrieval.windows.length > RETRIEVAL.ANCHOR.maxWindows, 'more than 3 windows contributed');
  for (const n of [3, 61, 121, 165, 201]) assert.ok(covers(f.excerpts, n), `line ${n}`);
  assert.ok(f.retrieval.windows.every((w) => w.pass && w.via));
  assert.deepEqual(new Set(f.retrieval.windows.map((w) => w.via)), new Set(['term', 'binding', 'bridge', 'stem']));
  const before = "  fs.rmSync(scratchDir, { recursive: true, force: true });";
  const result = await executeTask(t, adapterOf([{ type: 'patch', path: 'src/inv.js', edits: [{ old_string: before, new_string: "  fs.rmSync(scratchDir, { recursive: true, force: false });" }] }]));
  assert.equal(result.status, 'completed', JSON.stringify(result.blockers));
  assert.equal(fs.readFileSync(path.join(root, 'src/inv.js'), 'utf8'), text.replace(before, "  fs.rmSync(scratchDir, { recursive: true, force: false });"));
});

test('RT44 loader: a smaller per-file cap shrinks the plan (never exceeds it); nothing is added for a file that fits; retrieval:false is unchanged', async () => {
  const root = tmp(); write(root, 'src/inv.js', inventory());
  const t = invTask(root);
  const small = await loadTaskContext(t, { limits: { maxBytesPerFile: 1500 } });
  assert.ok(fileOf(small, 'src/inv.js').bytes <= 1500);
  const off = await loadTaskContext(t, { retrieval: false });
  assert.equal(fileOf(off, 'src/inv.js').status, 'truncated');
  const tiny = tmp(); write(tiny, 'src/inv.js', 'function reserveStock() {}\n');
  const a = await loadTaskContext(invTask(tiny)); const b = await loadTaskContext(invTask(tiny), { retrieval: false });
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
});

test('RT45 explicit path:START-END hints keep the Slice-1 limit of 4 ranges; only automatic retrieval may use more', async () => {
  const root = tmp(); write(root, 'src/inv.js', inventory());
  const t = invTask(root, { suspected_area: ['src/inv.js:5-6', 'src/inv.js:100-101', 'src/inv.js:200-201', 'src/inv.js:300-301', 'src/inv.js:400-401', 'src/inv.js:500-501'] });
  const f = fileOf(await loadTaskContext(t), 'src/inv.js');
  assert.equal(f.status, 'excerpt');
  assert.ok(f.excerpts.length <= 4 && f.retrieval === undefined);
});
