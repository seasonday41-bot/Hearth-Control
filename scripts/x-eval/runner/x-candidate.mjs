#!/usr/bin/env node
// X v0.2 candidate identity (NOT part of the Gold fingerprint; Gold v1.2 files are untouched by this module).
//   node scripts/x-eval/runner/x-candidate.mjs --freeze   write scripts/x-eval/x-v02-candidate.json from the current worktree
//   node scripts/x-eval/runner/x-candidate.mjs --verify   compare the worktree with that manifest (exit 1 on any difference)
//
// The candidate is the set of files X actually runs: every mcp/x/*.mjs plus the transitive closure of the RELATIVE imports
// they pull in (gateway, registry, providers, ...), hashed by CONTENT. `git ls-files -s` (what `executorIdentity()` in lib.mjs
// reports) hashes the INDEX and therefore cannot describe an uncommitted candidate; this hashes the worktree files themselves.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { EVAL_DIR, REPO, lockFingerprint, gitRepo } from './lib.mjs';

export const MANIFEST_PATH = path.join(EVAL_DIR, 'x-v02-candidate.json');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const rel = (abs) => path.relative(REPO, abs).split(path.sep).join('/');
const IMPORT_RE = /(?:from\s+|import\s*\(\s*|import\s+|require\(\s*)(['"])(\.{1,2}\/[^'"\n]+)\1/g;

const resolveImport = (fromAbs, spec) => {
  const base = path.resolve(path.dirname(fromAbs), spec);
  for (const candidate of [base, `${base}.mjs`, `${base}.cjs`, `${base}.js`, path.join(base, 'index.mjs'), path.join(base, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
};

/** Every mcp/x/*.mjs plus the transitive closure of their relative imports (files inside the repo only), sorted. */
export const candidateFiles = () => {
  const entry = fs.readdirSync(path.join(REPO, 'mcp', 'x')).filter((f) => f.endsWith('.mjs')).map((f) => path.join(REPO, 'mcp', 'x', f));
  const seen = new Set();
  const stack = [...entry];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(IMPORT_RE)) {
      const dep = resolveImport(file, m[2]);
      if (dep && dep.startsWith(`${REPO}${path.sep}`) && !dep.includes(`${path.sep}node_modules${path.sep}`)) stack.push(dep);
    }
  }
  return [...seen].map(rel).sort();
};

const hashFiles = (files) => Object.fromEntries(files.map((f) => [f, sha256(fs.readFileSync(path.join(REPO, f)))]));
const combined = (map) => sha256(Object.entries(map).sort(([a], [b]) => (a < b ? -1 : 1)).map(([f, h]) => `${f}\n${h}`).join('\n'));

const testFiles = () => fs.readdirSync(path.join(REPO, 'scripts')).filter((f) => /^test-x-.*\.mjs$/.test(f)).sort().map((f) => `scripts/${f}`);

/** Content identity of the X candidate as it is in the worktree right now. */
export const xCandidateIdentity = () => {
  const files = hashFiles(candidateFiles());
  const tests = hashFiles(testFiles());
  return { x_files: files, x_sha256: combined(files), x_file_count: Object.keys(files).length, test_files: tests, tests_sha256: combined(tests), test_file_count: Object.keys(tests).length };
};

export const readManifest = () => (fs.existsSync(MANIFEST_PATH) ? JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) : null);

/** { ok, problems[] }: the worktree must match the manifest exactly (X closure AND X tests) and Gold must still be the locked fingerprint. */
export const verifyCandidate = (manifest = readManifest()) => {
  const problems = [];
  if (!manifest) return { ok: false, problems: [`no candidate manifest at ${rel(MANIFEST_PATH)}`] };
  const now = xCandidateIdentity();
  if (now.x_sha256 !== manifest.x_sha256) {
    const changed = Object.keys({ ...manifest.x_files, ...now.x_files }).filter((f) => manifest.x_files[f] !== now.x_files[f]);
    problems.push(`X candidate differs from the frozen manifest: ${changed.join(', ') || '(hash only)'}`);
  }
  if (now.tests_sha256 !== manifest.tests_sha256) problems.push('X test files differ from the frozen manifest');
  if (lockFingerprint() !== manifest.gold_fingerprint) problems.push(`Gold fingerprint ${lockFingerprint()} != frozen ${manifest.gold_fingerprint}`);
  return { ok: problems.length === 0, problems, identity: now };
};

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { values } = parseArgs({ options: { freeze: { type: 'boolean', default: false }, verify: { type: 'boolean', default: false } } });
  if (values.freeze) {
    const previous = readManifest();
    const manifest = {
      name: 'x-v0.2-candidate', schema: 1, frozen_at: new Date().toISOString(),
      base_head: gitRepo(['rev-parse', 'HEAD']).trim(), committed: false,
      gold_fingerprint: lockFingerprint(), ...xCandidateIdentity(),
      verification: previous?.verification ?? null,
      // Approved departures from the previous freeze, carried forward so the
      // reason a frozen file changed survives every later re-freeze.
      exceptions: previous?.exceptions ?? [],
    };
    fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
    console.error(`froze ${manifest.x_file_count} X files (${manifest.x_sha256.slice(0, 16)}…) and ${manifest.test_file_count} X test files -> ${rel(MANIFEST_PATH)}`);
  } else if (values.verify) {
    const r = verifyCandidate();
    console.error(r.ok ? 'candidate matches the frozen manifest' : `MISMATCH:\n- ${r.problems.join('\n- ')}`);
    process.exit(r.ok ? 0 : 1);
  } else { console.error('use --freeze or --verify'); process.exit(2); }
}
