#!/usr/bin/env node
// npm run release:prepare -- 0.4.23
//
// Safe preparation only: set the version, prove the tree is consistent, run the
// gates that guard release identity, and report readiness. It deliberately does
// not push, tag, build, publish or deploy -- those stay explicit human steps.
const { execFileSync } = require('node:child_process');
const { setVersion, versionProblems, gitState, currentVersion } = require('./version.cjs');
const { ROOT } = require('./version.cjs');

const requested = process.argv[2];
const run = (label, args) => {
  process.stdout.write(`\n== ${label}\n`);
  try {
    execFileSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
    return true;
  } catch {
    process.stdout.write(`   ${label}: FAIL\n`);
    return false;
  }
};

if (requested) {
  const { version, changed, buildId } = setVersion(requested);
  process.stdout.write(`Version ${version} (${buildId})\n`);
  for (const file of changed) process.stdout.write(`  updated ${file}\n`);
  if (changed.length === 0) process.stdout.write('  already up to date\n');
}

const version = currentVersion();
const git = gitState();
const problems = versionProblems({ version });

const gates = [
  ['version consistency', () => problems.length === 0],
  ['build metadata tests', () => run('build metadata tests', ['--test', 'scripts/test-release-version.mjs', 'scripts/test-build-metadata.mjs'])],
  ['updater tests', () => run('updater tests', ['scripts/test-updater.mjs'])],
];

const results = gates.map(([name, check]) => [name, check()]);

process.stdout.write('\n== Release readiness\n');
process.stdout.write(`Version:        ${version}\n`);
process.stdout.write(`Commit:         ${git.available ? git.shortCommit : 'not a git checkout'}\n`);
process.stdout.write(`Working tree:   ${git.available ? (git.dirty ? 'DIRTY' : 'clean') : 'unknown'}\n`);
for (const [name, ok] of results) process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}\n`);
for (const problem of problems) process.stdout.write(`      - ${problem}\n`);

const ready = results.every(([, ok]) => ok) && git.available && !git.dirty;
process.stdout.write(`\n${ready ? 'READY to build' : 'NOT ready'}\n`);
if (!ready && git.dirty) process.stdout.write('Commit the working tree first: a build from a dirty tree cannot be traced to a commit.\n');
process.stdout.write('\nNothing was pushed, tagged, built or published. Next steps are in docs/RELEASE_PROCESS.md.\n');
process.exit(ready ? 0 : 1);
