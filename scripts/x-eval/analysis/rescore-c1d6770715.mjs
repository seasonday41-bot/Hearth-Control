// HISTORICAL (Step 6B). Superseded by runner/rescore.mjs. 'locked v1' = scorers-v1-archive; 'proposed v2' = the promoted v1.1 scorer.
// Offline RE-SCORING of a stored model patch (no model call, no lock change). Question: the locked hidden scorer
// passed 25/25 on the Qwen baseline patch for c1d6770715 while X's own visible validation failed. Which is right?
//   node scripts/x-eval/analysis/rescore-c1d6770715.mjs --work-dir D --patch <final.patch> [--out FILE]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createSnapshot, gitShow, loadFrozenX, runHiddenScorer, buildVisibleFiles } from '../runner/lib.mjs';
import { TASKS } from '../tasks/tasks-v1.mjs';

const { values } = parseArgs({ options: { 'work-dir': { type: 'string' }, patch: { type: 'string' }, out: { type: 'string' } } });
const task = TASKS.find((t) => t.id === 'c1d6770715');
const frozen = await loadFrozenX();
const WORK = path.resolve(values['work-dir']);
const PARENT_TEST = { file: 'scripts/test-x-result-gate-parent.mjs', content: gitShow(task.parent, 'scripts/test-x-result-gate.mjs') };
const visible = await buildVisibleFiles(task);
const FAIL = /^\s*✖\s+(.+?)(?:\s+\([\d.]+ms\))?\s*$/;
const names = (t) => [...new Set(t.split('\n').map((l) => FAIL.exec(l)?.[1]).filter(Boolean))].filter((n) => n !== 'failing tests:');
const vrun = async (root, cmd) => { const [r] = await frozen.runRequiredValidation({ workspace: { root }, scope: { allowed_paths: ['x'] }, validation: { required: [cmd], optional: [] } }, {}); return { status: r.status, failing: names(`${r.stdout}\n${r.stderr}`) }; };

const trees = {
  parent: createSnapshot({ workRoot: WORK, rev: task.parent, injectFiles: [...visible, PARENT_TEST] }),
  fixed: createSnapshot({ workRoot: WORK, rev: task.fixed, injectFiles: [PARENT_TEST] }),
  model: createSnapshot({ workRoot: WORK, rev: task.parent, injectFiles: [...visible, PARENT_TEST] }),
};
execFileSync('git', ['apply', path.resolve(values.patch)], { cwd: trees.model.root });
const out = { patch: path.basename(path.dirname(path.resolve(values.patch))), visible_fixed_test: {}, parent_test_regression_net: {}, hidden_locked: {}, hidden_proposed_v2: {} };
const VIS = 'node --test scripts/test-x-result-gate.mjs'; const PAR = 'node --test scripts/test-x-result-gate-parent.mjs';
out.visible_fixed_test.model = await vrun(trees.model.root, VIS);
out.visible_fixed_test.parent = await vrun(trees.parent.root, VIS);
out.parent_test_regression_net = { parent: await vrun(trees.parent.root, PAR), fixed: await vrun(trees.fixed.root, PAR), model: await vrun(trees.model.root, PAR) };
const intentional = new Set(out.parent_test_regression_net.fixed.failing); // tests the reference fix deliberately changed
out.parent_test_regression_net.regressions_in_model_patch = out.parent_test_regression_net.model.failing.filter((n) => !intentional.has(n));
const summarize = (r) => ({ status: r.status, fail: r.failing, pass: `${r.total - r.failing.length}/${r.total}` });
for (const [k, tk] of [['hidden_locked', { ...task, hidden: '../scorers-v1-archive/c1d6770715.mjs' }], ['hidden_proposed_v2', { ...task }]]) {
  for (const which of ['parent', 'fixed', 'model']) out[k][which] = summarize(await runHiddenScorer(tk, trees[which].root));
}
for (const t of Object.values(trees)) fs.rmSync(t.root, { recursive: true, force: true });
if (values.out) fs.writeFileSync(values.out, `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify(out, null, 2));
