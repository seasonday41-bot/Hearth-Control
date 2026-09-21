// X v0.2 candidate freeze: the manifest identifies exactly the X code + X tests under evaluation. Deterministic, no model/network.
// NOTE: this test is part of the frozen test set. Any intentional change to X or its tests requires re-running
// `node scripts/x-eval/runner/x-candidate.mjs --freeze` (and a new baseline decision).
import assert from 'node:assert/strict';
import test from 'node:test';
import { candidateFiles, xCandidateIdentity, verifyCandidate, readManifest } from '../scripts/x-eval/runner/x-candidate.mjs';

test('CF1 the candidate is the X source plus the closure of its relative imports, sorted and stable', () => {
  const files = candidateFiles();
  for (const f of ['mcp/x/context-loader.mjs', 'mcp/x/context-retrieval.mjs', 'mcp/x/repair-digest.mjs', 'mcp/x/failure-kinds.mjs', 'mcp/x/result-gate.mjs', 'mcp/skills/gateway.mjs']) assert.ok(files.includes(f), f);
  assert.deepEqual(files, [...files].sort());
  assert.deepEqual(files, candidateFiles());
  assert.deepEqual(xCandidateIdentity().x_sha256, xCandidateIdentity().x_sha256);
});

test('CF2 the worktree equals the frozen manifest (X closure, X tests, Gold fingerprint)', () => {
  const verdict = verifyCandidate();
  assert.deepEqual(verdict.problems, []);
  assert.equal(verdict.ok, true);
});

test('CF3 any drift is detected: a changed X file hash, a changed test hash, a different Gold fingerprint, a missing manifest', () => {
  const manifest = readManifest();
  const firstFile = Object.keys(manifest.x_files)[0];
  const tamper = (patch) => verifyCandidate({ ...manifest, ...patch });
  const x = tamper({ x_files: { ...manifest.x_files, [firstFile]: '0'.repeat(64) }, x_sha256: '0'.repeat(64) });
  assert.equal(x.ok, false); assert.match(x.problems.join('\n'), new RegExp(firstFile.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
  assert.equal(tamper({ tests_sha256: '0'.repeat(64) }).ok, false);
  assert.equal(tamper({ gold_fingerprint: '0'.repeat(64) }).ok, false);
  assert.equal(verifyCandidate(null).ok, false);
});

test('CF4 the manifest records what it froze and that nothing was committed', () => {
  const manifest = readManifest();
  assert.equal(manifest.name, 'x-v0.2-candidate');
  assert.equal(manifest.committed, false);
  assert.equal(manifest.x_file_count, Object.keys(manifest.x_files).length);
  assert.equal(manifest.gold_fingerprint, 'f6ac8bfae42af5c5417e2da485f1b61f94c3e3ed6bb72cf5f3f8b142a9bdc03f');
});
