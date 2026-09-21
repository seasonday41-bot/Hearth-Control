// X v0.2 Slice 1: large-file targeted (excerpt) patch. Deterministic: temp workspaces, fake ModelAdapter, no model, no network.
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadTaskContext, parseRangeSpec, DEFAULT_CONTEXT_LIMITS } from '../mcp/x/context-loader.mjs';
import { executeTask, buildModelRequest, buildLocalExecutorResponseSchema, getEligibleContextPaths, getPatchableContextPaths, getExcerptContextFile, excerptRangeTexts } from '../mcp/x/local-executor.mjs';
import { applyEdits } from '../mcp/x/edit-writer.mjs';
import { X_TASK_VERSION } from '../mcp/x/task-contract.mjs';

const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-x-excerpt-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const sha = (t) => crypto.createHash('sha256').update(Buffer.from(t, 'utf8')).digest('hex');
const write = (root, rel, content) => { const abs = path.join(root, rel); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, content); return abs; };

// ~20 KB: comfortably over the DEFAULT 8,000 B/file cap, so it can only ever be shown as truncated or excerpt.
const LINES = 400;
const bigText = () => {
  const lines = Array.from({ length: LINES }, (_, i) => `const line${i + 1} = ${i + 1}; // ${'x'.repeat(30)}`);
  lines[99] = 'function targetAlpha() { return 1; }';   // line 100, unique
  lines[104] = "const dup = 'DUP';";                      // line 105 (shown in the excerpt)
  lines[349] = "const dup = 'DUP';";                      // line 350 (never shown): makes 'dup' ambiguous in the file
  lines[299] = 'function farAway() { return 2; }';       // line 300, unique but never shown
  return `${lines.join('\n')}\n`;
};
const task = (root, over = {}) => ({
  version: X_TASK_VERSION, task_id: 'TASK-XP', parent_task_id: null, revision: 1, attempt: 1, based_on_result_id: null,
  objective: 'o', problem: 'p', expected_behavior: 'e', observed_behavior: 'b', why_this_matters: 'w',
  known_evidence: [], suspected_area: ['src/big.js:95-110'], workspace: { repo: 'r', root },
  scope: { allowed_paths: ['src'], preferred_files: [], forbidden_paths: ['src/private'] }, constraints: { preserve: [], do_not: [] },
  allowed_tools: ['repo_read', 'repo_edit'], acceptance_criteria: ['a'], validation: { required: [], optional: [] }, verification: null,
  done_criteria: ['d'], teaching_notes: [], uncertainty_policy: { policy: 'bounded_autonomy', stop_conditions: [] },
  repair_budget: { initial_attempts: 1, max_repairs: 2, max_total_rounds: 3 },
  timing: { estimated_minutes: 5, first_check_after_minutes: 1, soft_deadline_minutes: 3, hard_timeout_minutes: 10 }, commit_policy: { mode: 'never' }, ...over,
});
const adapterOf = (actions, before) => ({ generate: async () => { if (before) before(); return { ok: true, provider: 'fake', model: 'fake', requestedModel: null, text: JSON.stringify({ actions }), finishReason: 'stop', usage: null, error: null }; } });
const patch = (edits, p = 'src/big.js') => ({ type: 'patch', path: p, edits });
const run = (t, actions, before) => executeTask(t, adapterOf(actions, before));
const bigPath = (root) => path.join(root, 'src', 'big.js');
const fileOf = (ctx, p = 'src/big.js') => ctx.files.find((f) => f.path === p);

// ------------------------------------------------------------------ loader ----

test('XP1 large file + path:START-END -> status excerpt with ranges, whole-file provenance, and NO cap raised', async () => {
  const root = tmp(); const text = bigText(); write(root, 'src/big.js', text);
  const ctx = await loadTaskContext(task(root));
  const f = fileOf(ctx);
  assert.equal(f.status, 'excerpt');
  assert.deepEqual(f.excerpts, [{ start_line: 95, end_line: 110 }]);
  assert.equal(f.full_file.sha256, sha(text));
  assert.equal(f.full_file.bytes, Buffer.byteLength(text, 'utf8'));
  assert.equal(f.full_file.lines, LINES + 1); // trailing newline = one final empty line, matching the numbering
  assert.ok(f.bytes <= DEFAULT_CONTEXT_LIMITS.maxBytesPerFile, 'excerpt must fit the unchanged per-file cap');
  assert.ok(f.content.startsWith('... (lines 1-94 not shown) ...\n95: '));
  assert.ok(f.content.endsWith('110: ' + text.split('\n')[109] + '\n... (lines 111-401 not shown) ...'));
  assert.equal(ctx.limits.maxBytesPerFile, 8000);
  assert.equal(ctx.limits.maxTotalBytes, 40000);
  assert.ok(!f.content.includes('line50 ') && !f.content.includes('function farAway'), 'unrequested lines must not appear');
});

test('XP2 large file WITHOUT a range hint is exactly the pre-existing truncated behavior', async () => {
  const root = tmp(); write(root, 'src/big.js', bigText());
  const ctx = await loadTaskContext(task(root, { suspected_area: ['src/big.js'] }));
  const f = fileOf(ctx);
  assert.equal(f.status, 'truncated');
  assert.equal(f.excerpts, undefined);
  assert.equal(f.full_file, undefined);
  assert.equal(getExcerptContextFile(ctx, 'src/big.js'), null);
});

test('XP3 a file that FITS the cap is loaded whole (status ok) even when a range hint is given', async () => {
  const root = tmp(); const small = 'a\nb\nc\n'; write(root, 'src/big.js', small);
  const ctx = await loadTaskContext(task(root, { suspected_area: ['src/big.js:2-2'] }));
  const f = fileOf(ctx);
  assert.equal(f.status, 'ok');
  assert.equal(f.excerpts, undefined);
  assert.ok(f.content.includes('1: a') && f.content.includes('3: c'));
});

test('XP4 parseRangeSpec: valid forms parse; every invalid or ordinary entry stays a plain path', () => {
  assert.deepEqual(parseRangeSpec('src/a.js:10-20'), { path: 'src/a.js', ranges: [{ start: 10, end: 20 }] });
  assert.deepEqual(parseRangeSpec('src/a.js:7'), { path: 'src/a.js', ranges: [{ start: 7, end: 7 }] });
  for (const bad of ['src/a.js', 'src/a.js:0-5', 'src/a.js:9-3', 'src/a.js:', 'src/a.js:x-y', 'src']) assert.deepEqual(parseRangeSpec(bad), { path: bad, ranges: null });
});

test('XP5 an invalid range entry never loads anything and never crashes; the plain path form still works', async () => {
  const root = tmp(); write(root, 'src/big.js', bigText());
  const bad = await loadTaskContext(task(root, { suspected_area: ['src/big.js:0-5'] }));
  assert.equal(bad.files.length, 0);
  assert.ok(bad.omitted.some((o) => o.reason === 'scope_violation' || o.reason === 'unreadable'));
});

test('XP6 ranges are merged, clamped and limited; the per-file byte cap truncates a range and shows nothing beyond it', async () => {
  const root = tmp(); write(root, 'src/big.js', bigText());
  const merged = await loadTaskContext(task(root, { suspected_area: ['src/big.js:10-20', 'src/big.js:18-30', 'src/big.js:31-32'] }));
  assert.deepEqual(fileOf(merged).excerpts, [{ start_line: 10, end_line: 32 }]);
  const many = await loadTaskContext(task(root, { suspected_area: [1, 3, 5, 7, 9, 11].map((n) => `src/big.js:${n * 20}-${n * 20 + 1}`) }));
  assert.equal(fileOf(many).excerpts.length, 4, 'at most 4 ranges per file');
  const huge = await loadTaskContext(task(root, { suspected_area: ['src/big.js:1-400'] }));
  const h = fileOf(huge);
  assert.equal(h.status, 'excerpt');
  assert.ok(h.bytes <= 8000);
  assert.ok(h.excerpts[0].end_line < 400, 'range cut where the cap ran out');
  assert.ok(h.content.endsWith(`... (lines ${h.excerpts[0].end_line + 1}-${LINES + 1} not shown) ...`));
});

test('XP7 secrets: a redaction INSIDE a shown line fails closed to truncated; a secret elsewhere in the file does not block a clean excerpt', async () => {
  const root = tmp();
  const lines = bigText().split('\n');
  lines[199] = 'const cfg = { "token": "abcdef1234567890" };'; // line 200, outside 95-110
  write(root, 'src/big.js', lines.join('\n'));
  const ok = await loadTaskContext(task(root));
  assert.equal(fileOf(ok).status, 'excerpt', 'redaction outside the shown lines must not matter');
  assert.ok(!fileOf(ok).content.includes('abcdef1234567890'));
  const inside = await loadTaskContext(task(root, { suspected_area: ['src/big.js:195-205'] }));
  assert.equal(fileOf(inside).status, 'truncated', 'a redacted shown line must never be patchable');
  assert.ok(!fileOf(inside).content.includes('abcdef1234567890'));
});

test('XP8 a file over the gateway read limit (1 MB) is never an excerpt (its full-file hash would not be real)', async () => {
  const root = tmp(); write(root, 'src/big.js', `${'x'.repeat(80)}\n`.repeat(14000)); // > 1 MB
  const ctx = await loadTaskContext(task(root, { suspected_area: ['src/big.js:5-9'] }));
  assert.equal(fileOf(ctx).status, 'truncated');
});

test('XP9 scope is unchanged for range hints: forbidden, out-of-scope, protected and symlink-escaping paths yield no content', async () => {
  const root = tmp(); const outside = tmp();
  write(root, 'src/private/secret-plan.js', bigText()); write(root, 'other/x.js', bigText()); write(root, 'src/.env', `${bigText()}`); write(outside, 'evil.js', bigText());
  fs.symlinkSync(path.join(outside, 'evil.js'), path.join(root, 'src', 'link.js'));
  const ctx = await loadTaskContext(task(root, { suspected_area: ['src/private/secret-plan.js:1-10', 'other/x.js:1-10', 'src/.env:1-10', 'src/link.js:1-10'] }));
  assert.equal(ctx.files.length, 0, JSON.stringify(ctx.files.map((f) => f.path)));
  assert.ok(ctx.omitted.length >= 3);
});

test('XP10 a range in suspected_area wins even when the same file was already requested plainly (repair rounds add it to preferred_files)', async () => {
  const root = tmp(); write(root, 'src/big.js', bigText());
  const t = task(root); t.scope.preferred_files = ['src/big.js'];
  assert.equal(fileOf(await loadTaskContext(t)).status, 'excerpt');
});

test('XP11 excerpts are charged to the unchanged budgets: a second large file is dropped once maxTotalBytes is spent; hard ceilings still clamp', async () => {
  const root = tmp(); write(root, 'src/big.js', bigText()); write(root, 'src/big2.js', bigText());
  const ctx = await loadTaskContext(task(root, { suspected_area: ['src/big.js:1-400', 'src/big2.js:1-400'] }), { limits: { maxTotalBytes: 9000, maxBytesPerFile: 999999 } });
  assert.equal(ctx.limits.maxBytesPerFile, 20000, 'the hard per-file ceiling still applies');
  const total = ctx.files.reduce((n, f) => n + f.bytes, 0);
  assert.ok(total <= 9000, `total ${total}`);
  const second = fileOf(ctx, 'src/big2.js');
  assert.equal(fileOf(ctx).status, 'excerpt');
  assert.ok(!second || (second.status !== 'excerpt' && second.bytes < 200), 'the exhausted budget leaves no room for a second excerpt (existing truncated-head behavior)');
});

// --------------------------------------------------------------- executor ----

test('XP20 excerpt patch succeeds: old_string is inside the shown range and unique; only that text changes, every other byte is preserved', async () => {
  const root = tmp(); const text = bigText(); write(root, 'src/big.js', text); fs.chmodSync(bigPath(root), 0o755);
  const result = await run(task(root), [patch([{ old_string: 'function targetAlpha() { return 1; }', new_string: 'function targetAlpha() { return 42; }' }])]);
  assert.equal(result.status, 'completed', JSON.stringify(result.blockers));
  assert.deepEqual(result.files_changed, ['src/big.js']);
  assert.equal(fs.readFileSync(bigPath(root), 'utf8'), text.replace('return 1; }', 'return 42; }'));
  assert.equal(result.changes[0].before_hash, sha(text));
  assert.equal(fs.statSync(bigPath(root)).mode & 0o777, 0o755, 'file mode preserved');
});

test('XP21 prompt and schema: excerpt guidance and the patch-only enum appear ONLY for excerpt contexts', async () => {
  const root = tmp(); write(root, 'src/big.js', bigText()); write(root, 'src/small.js', 'a\n');
  const t = task(root); t.suspected_area = ['src/big.js:95-110', 'src/small.js'];
  const ctx = await loadTaskContext(t);
  assert.deepEqual(getEligibleContextPaths(ctx), ['src/small.js']);
  assert.deepEqual(getPatchableContextPaths(ctx), ['src/small.js', 'src/big.js']);
  const req = buildModelRequest(t, ctx);
  assert.match(req.messages[0].content, /status: excerpt/);
  assert.match(req.messages[0].content, /ONLY "patch"/);
  assert.match(req.messages[1].content, /--- src\/big\.js \(status: excerpt\) ---/);
  const variants = req.format.properties.actions.items.anyOf;
  const enumOf = (type) => variants.find((v) => v.properties.type.enum[0] === type).properties.path.enum;
  assert.deepEqual(enumOf('replace'), ['src/small.js'], 'replace must never be allowed to name an excerpt file');
  assert.deepEqual(enumOf('patch'), ['src/small.js', 'src/big.js']);
});

test('XP22 ambiguous match: unique inside the excerpt but present elsewhere in the file -> rejected, file untouched', async () => {
  const root = tmp(); const text = bigText(); write(root, 'src/big.js', text);
  const result = await run(task(root), [patch([{ old_string: "const dup = 'DUP';", new_string: "const dup = 'CHANGED';" }])]);
  assert.equal(result.status, 'failed');
  assert.equal(result.changes[0].code, 'PRECONDITION_FAILED');
  assert.match(result.changes[0].detail, /exactly once in the whole file \(found 2\)/);
  assert.equal(fs.readFileSync(bigPath(root), 'utf8'), text);
});

test('XP23 old_string that is unique in the file but NOT within a shown excerpt -> rejected, file untouched', async () => {
  const root = tmp(); const text = bigText(); write(root, 'src/big.js', text);
  const result = await run(task(root), [patch([{ old_string: 'function farAway() { return 2; }', new_string: 'function farAway() { return 3; }' }])]);
  assert.equal(result.changes[0].code, 'PRECONDITION_FAILED');
  assert.match(result.changes[0].detail, /not entirely within a shown excerpt/);
  assert.equal(fs.readFileSync(bigPath(root), 'utf8'), text);
});

test('XP24 old_string that runs past the end of a shown range, or across the omission marker, is rejected', async () => {
  const root = tmp(); const text = bigText(); write(root, 'src/big.js', text);
  const lines = text.split('\n');
  const pastEnd = `${lines[109]}\n${lines[110]}`; // line 110 (last shown) + line 111 (not shown)
  const before = `${lines[93]}\n${lines[94]}`;     // line 94 (not shown) + line 95
  for (const old of [pastEnd, before, `${lines[109]}\n... (lines 111-401 not shown) ...`]) {
    const result = await run(task(root), [patch([{ old_string: old, new_string: 'X' }])]);
    assert.equal(result.changes[0].code, 'PRECONDITION_FAILED', old.slice(0, 40));
    assert.match(result.changes[0].detail, /not entirely within a shown excerpt/);
  }
  assert.equal(fs.readFileSync(bigPath(root), 'utf8'), text);
});

test('XP25 an old_string copied WITH the "N: " display prefix is not accepted', async () => {
  const root = tmp(); const text = bigText(); write(root, 'src/big.js', text);
  const result = await run(task(root), [patch([{ old_string: '100: function targetAlpha() { return 1; }', new_string: 'x' }])]);
  assert.equal(result.changes[0].code, 'PRECONDITION_FAILED');
  assert.equal(fs.readFileSync(bigPath(root), 'utf8'), text);
});

test('XP26 drift OUTSIDE the shown lines after context was loaded still aborts (full-file hash), and the drifted file is not overwritten', async () => {
  const root = tmp(); const text = bigText(); write(root, 'src/big.js', text);
  const drifted = text.replace('const line300 = 300;', 'const line300 = 999;').replace('function farAway() { return 2; }', 'function farAway() { return 2; } // drift');
  const result = await run(task(root), [patch([{ old_string: 'function targetAlpha() { return 1; }', new_string: 'function targetAlpha() { return 42; }' }])], () => fs.writeFileSync(bigPath(root), drifted));
  assert.equal(result.changes[0].code, 'PRECONDITION_FAILED');
  assert.match(result.changes[0].detail, /expectedHash did not match/);
  assert.equal(fs.readFileSync(bigPath(root), 'utf8'), drifted, 'must not overwrite the drifted content');
});

test('XP27 drift INSIDE the shown lines (old_string gone) aborts', async () => {
  const root = tmp(); const text = bigText(); write(root, 'src/big.js', text);
  const drifted = text.replace('return 1; }', 'return 7; }');
  const result = await run(task(root), [patch([{ old_string: 'function targetAlpha() { return 1; }', new_string: 'x' }])], () => fs.writeFileSync(bigPath(root), drifted));
  assert.equal(result.changes[0].code, 'PRECONDITION_FAILED');
  assert.equal(fs.readFileSync(bigPath(root), 'utf8'), drifted);
});

test('XP28 replace is rejected for an excerpt file, even when the model ignores the schema and emits it', async () => {
  const root = tmp(); const text = bigText(); write(root, 'src/big.js', text);
  const result = await run(task(root), [{ type: 'replace', path: 'src/big.js', content: 'export default 1;\n' }]);
  assert.equal(result.status, 'failed');
  assert.equal(result.changes[0].code, 'PRECONDITION_FAILED');
  assert.match(result.changes[0].detail, /only partially shown \(status: excerpt\)/);
  assert.equal(fs.readFileSync(bigPath(root), 'utf8'), text);
});

test('XP29 replace_all is refused for an excerpt patch (executor gate and writer gate)', async () => {
  const root = tmp(); const text = bigText(); write(root, 'src/big.js', text);
  const result = await run(task(root), [patch([{ old_string: 'function targetAlpha() { return 1; }', new_string: 'y', replace_all: true }])]);
  assert.equal(result.changes[0].code, 'PRECONDITION_FAILED');
  assert.match(result.changes[0].detail, /replace_all is not permitted/);
  assert.equal(fs.readFileSync(bigPath(root), 'utf8'), text);
  const direct = await applyEdits(task(root), 'src/big.js', [{ old_string: 'function targetAlpha() { return 1; }', new_string: 'y', replace_all: true }], { uniqueInOriginal: true });
  assert.equal(direct.code, 'PRECONDITION_FAILED');
  assert.equal(fs.readFileSync(bigPath(root), 'utf8'), text);
});

test('XP30 a later edit may not rely on text produced by an earlier edit (only text that was SHOWN can justify a patch)', async () => {
  const root = tmp(); const text = bigText(); write(root, 'src/big.js', text);
  const result = await run(task(root), [patch([
    { old_string: 'function targetAlpha() { return 1; }', new_string: 'function brandNew() { return 5; }' },
    { old_string: 'function brandNew() { return 5; }', new_string: 'function brandNew() { return 6; }' },
  ])]);
  assert.equal(result.changes[0].code, 'PRECONDITION_FAILED');
  assert.match(result.changes[0].detail, /edit 1: .*not entirely within a shown excerpt/);
  assert.equal(fs.readFileSync(bigPath(root), 'utf8'), text, 'all-or-nothing');
});

test("XP31 uniqueness is judged against the ORIGINAL file: an earlier edit that removes one of two occurrences cannot make a later ambiguous old_string 'unique'", async () => {
  const root = tmp(); const text = bigText(); write(root, 'src/big.js', text);
  // Edit 0 consumes the SHOWN occurrence of "const dup = 'DUP';" (line 105) together with its neighbor line, leaving only the unseen occurrence (line 350).
  // Edit 1's old_string "const dup = 'DUP';" is inside the excerpt and looks unique in the WORKING text, but in the original file it occurs twice.
  const lines = text.split('\n');
  const result = await run(task(root), [patch([
    { old_string: `${lines[103]}\n${lines[104]}`, new_string: 'const removed = 1;' },
    { old_string: "const dup = 'DUP';", new_string: "const dup = 'CHANGED';" },
  ])]);
  assert.equal(result.changes[0].code, 'PRECONDITION_FAILED');
  assert.match(result.changes[0].detail, /exactly once in the whole file \(found 2\)/);
  assert.equal(fs.readFileSync(bigPath(root), 'utf8'), text);
});

test('XP32 symlink swap between context load and write: the outside file is never touched and nothing is written through the link', async () => {
  const root = tmp(); const outside = tmp(); const text = bigText();
  write(root, 'src/big.js', text); const outsideFile = write(outside, 'target.js', text);
  const result = await run(task(root), [patch([{ old_string: 'function targetAlpha() { return 1; }', new_string: 'function targetAlpha() { return 42; }' }])], () => {
    fs.rmSync(bigPath(root)); fs.symlinkSync(outsideFile, bigPath(root));
  });
  assert.notEqual(result.status, 'completed');
  assert.ok(['SYMLINK_ESCAPE', 'PATH_REJECTED', 'PRECONDITION_FAILED'].includes(result.changes[0].code), result.changes[0].code);
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), text, 'the file outside the workspace must be untouched');
});

test('XP33 a path never loaded, or only loaded as a plain truncated head, keeps the old refusal wording (no excerpt, no new capability)', async () => {
  const root = tmp(); write(root, 'src/big.js', bigText()); write(root, 'src/other.js', bigText());
  const t = task(root, { suspected_area: ['src/other.js'] }); // big.js is not in context at all
  const r1 = await run(t, [patch([{ old_string: 'function targetAlpha() { return 1; }', new_string: 'x' }], 'src/big.js')]);
  assert.match(r1.changes[0].detail, /no complete \(status: ok\) snapshot in the loaded context; refusing to guess at unseen content/);
  const r2 = await run(t, [patch([{ old_string: 'const line2 = 2;', new_string: 'x' }], 'src/other.js')]); // other.js is a plain truncated head
  assert.match(r2.changes[0].detail, /no complete \(status: ok\) snapshot in the loaded context/);
});

test('XP34 corrupted excerpt provenance is refused (fail-closed): inconsistent ranges or line numbers give no range text', async () => {
  const root = tmp(); write(root, 'src/big.js', bigText());
  const ctx = await loadTaskContext(task(root));
  const f = fileOf(ctx);
  assert.ok(excerptRangeTexts(f).length === 1);
  assert.equal(excerptRangeTexts({ ...f, excerpts: [{ start_line: 95, end_line: 111 }] }), null);
  assert.equal(excerptRangeTexts({ ...f, content: f.content.replace('96: ', '97: ') }), null);
  assert.equal(excerptRangeTexts({ ...f, excerpts: [...f.excerpts, { start_line: 200, end_line: 201 }] }), null);
  assert.equal(getExcerptContextFile({ files: [{ ...f, full_file: undefined }] }, 'src/big.js'), null);
});

// -------------------------------------------------------------- regression ----

test('XP40 no behavior change for the pre-existing path: prompts and schema for contexts WITHOUT an excerpt are byte-identical to X v0.1', () => {
  const t = { version: 'x-task-v1', task_id: 'T', objective: 'o', problem: 'p', expected_behavior: 'e', observed_behavior: 'b', acceptance_criteria: ['a'], allowed_tools: ['repo_read', 'repo_edit'], scope: { allowed_paths: ['src'], forbidden_paths: [] } };
  const ctx = { files: [{ path: 'src/a.js', status: 'ok', content: '1: const a = 1;\n2: ' }, { path: 'src/b.js', status: 'truncated', content: '1: head' }], evidence: { known_evidence: ['x'] } };
  const rw = buildModelRequest(t, ctx); const ro = buildModelRequest({ ...t, allowed_tools: ['repo_read'] }, ctx);
  const h = (s) => sha(s);
  assert.equal(h(rw.messages[0].content), '1fb1f7851ffd7d5635bd1af63692b3b6abd316a2fde959d326d4706f0e4e11f0');
  assert.equal(h(rw.messages[1].content), 'f6d44128ce72b8ade89185babb9b48df9c34a27d902e77008853d45e92e6607a');
  assert.equal(h(ro.messages[0].content), '2b023320aec52d2e401e5d14e9f526f4d6c9d321d49f1a986ccbf645f7f8219d');
  assert.equal(h(JSON.stringify(rw.format)), 'a9082819f834173feba6d67d8db3daa38e1f1c6805c6f15907c0902c51b73981');
  assert.deepEqual(getPatchableContextPaths(ctx), getEligibleContextPaths(ctx));
});

test('XP41 a complete (status ok) file still patches exactly as before, including a unique-in-working-text edit sequence', async () => {
  const root = tmp(); write(root, 'src/small.js', 'const a = 1;\nconst b = 2;\n');
  const t = task(root, { suspected_area: ['src/small.js'] });
  const result = await run(t, [patch([{ old_string: 'const a = 1;', new_string: 'const a = 10;' }, { old_string: 'const a = 10;', new_string: 'const a = 11;' }], 'src/small.js')]);
  assert.equal(result.status, 'completed');
  assert.equal(fs.readFileSync(path.join(root, 'src/small.js'), 'utf8'), 'const a = 11;\nconst b = 2;\n');
});

test('XP42 the whole-file replace path for a complete (status ok) file is unchanged', async () => {
  const root = tmp(); write(root, 'src/small.js', 'const a = 1;\n');
  const result = await run(task(root, { suspected_area: ['src/small.js'] }), [{ type: 'replace', path: 'src/small.js', content: 'const a = 2;\n' }]);
  assert.equal(result.status, 'completed');
  assert.equal(fs.readFileSync(path.join(root, 'src/small.js'), 'utf8'), 'const a = 2;\n');
});
