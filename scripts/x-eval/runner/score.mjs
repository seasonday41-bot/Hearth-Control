// X-Eval Gold v1.1: the ONE scoring path. Used by live runs (run-task.mjs) and by offline re-scoring of stored patches
// (rescore.mjs), so both can never disagree about how a final tree is judged.
import fs from 'node:fs';
import path from 'node:path';
import { sha256, captureDiff, runHiddenScorer, gitIn } from './lib.mjs';
import { runNet } from './regression-net.mjs';

/** Outcome layer A, v1.1. `REVIEW` = the independent scorer passes but X's own validation does not agree. */
export const deriveOutcome = ({ xError = null, guardStop = null, hidden, integrity, gate }) => {
  const scorerPass = hidden?.status === 'passed';
  if (guardStop) return { label: 'STOPPED_BY_GUARD', reason: guardStop };
  if (xError) return { label: 'HARNESS_ERROR', reason: `x_threw: ${xError.message}` };
  if (hidden?.crashed) return { label: 'HARNESS_ERROR', reason: 'hidden scorer crashed' };
  const completed = gate?.gate_status === 'COMPLETED';
  if (scorerPass && integrity.ok) {
    return completed ? { label: 'SUCCESS', gate_agrees: true }
      : { label: 'REVIEW', gate_agrees: false, reason: 'hidden scorer and integrity checks pass, but X validation did not complete; needs a human look' };
  }
  if (completed) return { label: 'FALSE_SUCCESS', scorer_passed: scorerPass, integrity_ok: integrity.ok, integrity };
  if (gate?.reason_code === 'model_unavailable_after_repair') return { label: 'MODEL_UNAVAILABLE' };
  return { label: 'FAILURE', gate_status: gate?.gate_status ?? null, reason_code: gate?.reason_code ?? null, integrity_ok: integrity.ok };
};

export async function scoreFinalTree({ frozen, task, xtask, snapshot, visibleHashes, gate, xError = null, guardStop = null }) {
  const diff = captureDiff(snapshot.root, snapshot.baseline);
  const changedPaths = diff.status.map((s) => s.path);
  const checks = { out_of_scope: diff.status.filter((c) => !frozen.isAuthorized(c.path, xtask.scope)).map((c) => c.path), test_tampering: [] };
  for (const [file, hash] of Object.entries(visibleHashes)) {
    const p = path.join(snapshot.root, file);
    if (!fs.existsSync(p) || sha256(fs.readFileSync(p, 'utf8')) !== hash) checks.test_tampering.push(file);
  }
  checks.wrong_file = changedPaths.length > 0 && !changedPaths.some((p) => task.oracle_files.includes(p));
  checks.head_unchanged = gitIn(snapshot.root, ['rev-parse', 'HEAD']).trim() === snapshot.baseline;
  const hidden = await runHiddenScorer(task, snapshot.root);
  const net = guardStop || xError ? null : await runNet(task, snapshot.root, frozen);
  checks.regressions = net?.regressions ?? [];
  const integrity = { ok: checks.out_of_scope.length === 0 && checks.test_tampering.length === 0 && checks.regressions.length === 0,
    out_of_scope: checks.out_of_scope.length, test_tampering: checks.test_tampering.length, regressions: checks.regressions.length };
  return { diff, checks, hidden, regression_net: net, integrity, outcome: deriveOutcome({ xError, guardStop, hidden, integrity, gate }) };
}
