// Restores the stable checkpoint before `npm run dev` / `npm start`, so a
// developer run does not churn build-meta.json.
//
// The checkpoint is validated against the canonical version rather than a
// hand-edited regex pinning one release series. That regex had to be updated by
// hand in two files on every release, and forgetting either left a green tree
// whose app reported the wrong version.
const fs = require('node:fs');
const { currentVersion, versionProblems, readJson, writeJson, BUILD_META, STABLE_META } = require('./release/version.cjs');

if (!fs.existsSync(STABLE_META)) {
  process.stderr.write('No stable build metadata. Run: npm run set-version -- <version>\n');
  process.exit(1);
}

const problems = versionProblems({ version: currentVersion() });
if (problems.length) {
  process.stderr.write('Stable build metadata is inconsistent:\n');
  for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
  process.stderr.write('Run: npm run set-version -- <version>\n');
  process.exit(1);
}

const stable = readJson(STABLE_META);
writeJson(BUILD_META, stable);
process.stdout.write(`Restored stable build metadata: ${stable.buildId}\n`);
