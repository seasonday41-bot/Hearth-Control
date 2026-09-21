// Hidden scorer (SLICE ONLY): repair evidence fed to the next model round must
// keep the TAIL of long validation output (where the real error is), stay bounded,
// keep exit metadata, and never split a multi-byte character. This is ONE of the
// three behaviors bundled in c7cbaa326f; prompt-directive and done_criteria /
// teaching_notes rendering are NOT scored here. Uses only runTaskWithRepair (present
// before and after), so parent failure is behavioral.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createScorer, parseRoot, load } from './_lib.mjs';

const root = parseRoot();
const s = createScorer();
let repair;
await s.check('load mcp/x/repair-loop.mjs', async () => { repair = await load(root, 'mcp/x/repair-loop.mjs'); });
if (!repair) s.finish();

const dirs = [];
process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const task = (workspace) => ({
  version: 'x-task-v1', task_id: 'TASK-TAIL-1', parent_task_id: null, revision: 1, attempt: 1, based_on_result_id: null,
  objective: 'o', problem: 'p', expected_behavior: 'e', observed_behavior: 'b', why_this_matters: 'w',
  known_evidence: [], suspected_area: [], workspace: { repo: 'r', root: workspace },
  scope: { allowed_paths: ['src'], preferred_files: [], forbidden_paths: [] }, constraints: { preserve: [], do_not: [] },
  allowed_tools: ['repo_read', 'repo_edit'], acceptance_criteria: ['a'],
  validation: { required: ['node --test scripts/test-tail.mjs'], optional: [] }, verification: null,
  done_criteria: ['d'], teaching_notes: [], uncertainty_policy: { policy: 'bounded_autonomy', stop_conditions: [] },
  repair_budget: { initial_attempts: 1, max_repairs: 1, max_total_rounds: 2 },
  timing: { estimated_minutes: 5, first_check_after_minutes: 1, soft_deadline_minutes: 3, hard_timeout_minutes: 10 },
  commit_policy: { mode: 'never' },
});
const secondRoundPrompt = async (testSource) => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'xeval-tail-')); dirs.push(ws);
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'scripts', 'test-tail.mjs'), testSource);
  const calls = [];
  const adapter = { generate: async (req) => { calls.push(req); return { ok: true, provider: 'fake', model: 'fake', requestedModel: null, text: JSON.stringify({ actions: [{ type: 'create', path: 'src/n.js', content: 'x' }] }), finishReason: 'stop', usage: null, error: null }; } };
  await repair.runTaskWithRepair(task(ws), adapter);
  assert.equal(calls.length, 2, 'expected a second (repair) round');
  return calls[1].messages.map((m) => m.content).join('\n');
};

await s.check('noise first, decisive failure last: the failure text reaches the next round', async () => {
  const prompt = await secondRoundPrompt(`import test from 'node:test';\nconsole.log(${JSON.stringify('n'.repeat(6000))});\ntest('decisive', () => { throw new Error('DECISIVE_ASSERTION_AT_END'); });\n`);
  assert.ok(prompt.includes('DECISIVE_ASSERTION_AT_END'), 'decisive failure text was truncated away');
});
await s.check('output stays bounded (no multi-thousand-character dump)', async () => {
  const prompt = await secondRoundPrompt(`import test from 'node:test';\nconsole.log(${JSON.stringify('z'.repeat(9000))});\ntest('boom', () => { throw new Error('E'); });\n`);
  assert.ok(!prompt.includes('z'.repeat(2500)));
});
await s.check('command/status/exit metadata is kept', async () => {
  const prompt = await secondRoundPrompt(`import test from 'node:test';\ntest('boom', () => { throw new Error('E'); });\n`);
  assert.match(prompt, /Validation 'node --test scripts\/test-tail\.mjs': failed; exit 1/);
});
for (const pad of [0, 1, 2]) {
  await s.check(`multi-byte output (byte offset ${pad}) is never cut mid-character`, async () => {
    const noise = `${'a'.repeat(pad)}${'ก'.repeat(1800)}`;
    const prompt = await secondRoundPrompt(`import test from 'node:test';\nconsole.log(${JSON.stringify(noise)});\ntest('boom', () => { throw new Error('END_MARK'); });\n`);
    assert.ok(!prompt.includes('�'), 'replacement character found: a multi-byte character was split');
  });
}
s.finish();
