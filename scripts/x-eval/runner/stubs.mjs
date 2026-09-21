// Model STUBS for the Step-5 runner smoke (eval-only). A stub is a ModelAdapter: generate() returns the
// X model-response shape. Stubs exist to test the HARNESS, never to score X. Nothing here calls Ollama.
//
// The `oracle` stub replays the reference fix as X `patch` actions. It lives in the runner process, so the
// reference patch is never in the task text, prompt, or snapshot.

import fs from 'node:fs';
import path from 'node:path';
import { gitRepo, gitShow } from './lib.mjs';

const respond = (payload, extra = {}) => ({ ok: true, provider: 'stub', model: 'stub', requestedModel: null, text: typeof payload === 'string' ? payload : JSON.stringify(payload), finishReason: 'stop', usage: null, error: null, ...extra });

/** Hunks of `git diff parent fixed -- file` as {old_string,new_string} edits, widened until every old_string is unique in the parent text. */
export const referenceEdits = (parent, fixed, file) => {
  const parentText = gitShow(parent, file);
  for (const context of [3, 6, 12, 25, 60]) {
    const diff = gitRepo(['diff', `-U${context}`, parent, fixed, '--', file]);
    const edits = []; let cur = null;
    for (const line of diff.split('\n')) {
      if (line.startsWith('@@')) { cur = { o: [], n: [] }; edits.push(cur); continue; }
      if (!cur || line.startsWith('\\') || line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) continue;
      const t = line.slice(1);
      if (line[0] === ' ') { cur.o.push(t); cur.n.push(t); } else if (line[0] === '-') cur.o.push(t); else if (line[0] === '+') cur.n.push(t);
    }
    const out = edits.map((e) => ({ old_string: e.o.join('\n'), new_string: e.n.join('\n') }));
    if (out.length && out.every((e) => e.old_string && parentText.split(e.old_string).length === 2)) return out;
  }
  throw new Error(`cannot build unique edits for ${file}`);
};

const oracle = ({ task }) => {
  const actions = task.oracle_files.map((file) => ({ type: 'patch', path: file, edits: referenceEdits(task.parent, task.fixed, file) }));
  return { async generate() { return respond({ actions, explanation: 'oracle: replay of the reference fix', confidence: 1 }); } };
};

const NEUTRAL_TEST = "import test from 'node:test';\ntest('neutralized', () => {});\n";

export const makeStub = (name, ctx) => {
  const { snapshotRoot, visibleFiles } = ctx;
  if (name === 'oracle') return oracle(ctx);
  if (name === 'overbroad-gate') { // Gold v1.1 check: correct fix + the over-generalization the real model made (top-level blockers collapsed)
    const actions = ctx.task.oracle_files.map((file) => ({ type: 'patch', path: file, edits: [...referenceEdits(ctx.task.parent, ctx.task.fixed, file),
      { old_string: "return buildGateResult('FAILED', topBlocker.reason, evidence);", new_string: "return buildGateResult('FAILED', 'structural_execution_failure', evidence);" }] }));
    return { async generate() { return respond({ actions, explanation: 'reference + over-broad edit', confidence: 1 }); } };
  }
  if (name === 'noop') return { async generate() { return respond({ actions: [], explanation: 'nothing to do', confidence: 0.1 }); } };
  if (name === 'malformed') return { async generate() { return respond('this is not json'); } };
  if (name.startsWith('create:')) { // attempt to create a file at an arbitrary (usually forbidden) path
    const target = name.slice('create:'.length);
    return { async generate() { return respond({ actions: [{ type: 'create', path: target, content: 'x-eval probe\n' }], explanation: 'probe', confidence: 0.5 }); } };
  }
  if (name === 'replace-visible-test') { // try to overwrite the read-only visible validator through X
    const file = visibleFiles[0].file;
    return { async generate() { return respond({ actions: [{ type: 'replace', path: file, content: NEUTRAL_TEST }], explanation: 'probe', confidence: 0.5 }); } };
  }
  if (name === 'side-effect-tamper') { // bypass X entirely: rewrite the visible test so it passes, and touch an out-of-scope file
    return { async generate() {
      fs.writeFileSync(path.join(snapshotRoot, visibleFiles[0].file), NEUTRAL_TEST);
      fs.appendFileSync(path.join(snapshotRoot, 'README.md'), '\ntampered by harness probe\n');
      return respond({ actions: [], explanation: 'nothing to do', confidence: 0.9 });
    } };
  }
  if (name === 'poison-snapshot-x') { // corrupt the snapshot's own copy of X: the frozen executor must be unaffected
    return { async generate() {
      for (const f of ['execute-x-task', 'repair-loop', 'local-executor', 'result-gate', 'result-builder', 'context-loader', 'validation-runner']) {
        const p = path.join(snapshotRoot, 'mcp', 'x', `${f}.mjs`);
        if (fs.existsSync(p)) fs.writeFileSync(p, "throw new Error('poisoned snapshot copy of X');\n");
      }
      return respond({ actions: [], explanation: 'nothing to do', confidence: 0.1 });
    } };
  }
  throw new Error(`unknown stub '${name}'`);
};
