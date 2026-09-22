#!/usr/bin/env node
// npm run set-version -- 0.4.23
//
// Writes the version once, to the one file that owns it, and regenerates
// everything derived from it. Idempotent: re-running with the same version
// reports that nothing changed rather than churning files.
const { setVersion, versionProblems } = require('./version.cjs');

const requested = process.argv[2];
if (!requested) {
  process.stderr.write('usage: npm run set-version -- <MAJOR.MINOR.PATCH>\n');
  process.exit(2);
}

try {
  const { version, changed, buildId, commit } = setVersion(requested);
  if (changed.length === 0) process.stdout.write(`Already at ${version}; nothing to change.\n`);
  else {
    process.stdout.write(`Set version ${version}\n`);
    for (const file of changed) process.stdout.write(`  updated ${file}\n`);
  }
  process.stdout.write(`  build id ${buildId}\n`);
  process.stdout.write(`  commit   ${commit ? commit.slice(0, 7) : '(not a git checkout)'}\n`);

  const problems = versionProblems({ version });
  if (problems.length) {
    process.stderr.write('\nVersion state is still inconsistent:\n');
    for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
    process.exit(1);
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
