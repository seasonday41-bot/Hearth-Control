#!/usr/bin/env node
// npm run release:status -- read-only. Reports what this checkout would build
// and whether it is in a state worth building. Never writes and never prints
// key material; the signing key is reported as present or absent only.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { currentVersion, gitState, buildMetadataFor, versionProblems, readJson, BUILD_META, STABLE_META, ROOT } = require('./version.cjs');

const SIGNING_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'Hearth Control', 'release-signing');

/** Presence and permissions only. The key itself is never read. */
const signingStatus = () => {
  if (!fs.existsSync(SIGNING_DIR)) return { available: false, detail: 'no release-signing directory' };
  const keys = fs.readdirSync(SIGNING_DIR).filter((name) => name.endsWith('-private.pem'));
  if (keys.length === 0) return { available: false, detail: 'no private key in release-signing' };
  const mode = (fs.statSync(path.join(SIGNING_DIR, keys[0])).mode & 0o777).toString(8);
  return { available: true, detail: `${keys.length} key(s), private key mode ${mode}`, restricted: mode === '600' };
};

const version = currentVersion();
const git = gitState();
const problems = versionProblems({ version });
const signing = signingStatus();
const would = buildMetadataFor({ version, git });

const line = (label, value) => process.stdout.write(`${label.padEnd(22)}${value}\n`);

line('Version:', version);
line('Git commit:', git.available ? `${git.shortCommit} (${git.branch || 'detached'})` : 'not a git checkout');
line('Working tree:', git.available ? (git.dirty ? 'DIRTY (tracked files modified)' : 'clean') : 'unknown');
line('Would build as:', would.buildId);
for (const [label, file] of [['Build metadata:', BUILD_META], ['Stable metadata:', STABLE_META]]) {
  if (!fs.existsSync(file)) { line(label, 'MISSING'); continue; }
  const meta = readJson(file);
  line(label, `${meta.version} / ${meta.buildId}`);
}
line('Signing key:', signing.available ? `available (${signing.detail})` : `unavailable (${signing.detail})`);
line('Version consistency:', problems.length === 0 ? 'PASS' : 'FAIL');
for (const problem of problems) process.stdout.write(`  - ${problem}\n`);

const blockers = [...problems];
if (git.available && git.dirty) blockers.push('working tree is dirty, so a build could not be traced to a commit');
if (!git.available) blockers.push('not a git checkout, so no commit can be recorded');

line('Release gate:', blockers.length === 0 ? 'READY' : 'BLOCKED');
for (const blocker of blockers) if (!problems.includes(blocker)) process.stdout.write(`  - ${blocker}\n`);

process.stdout.write(`\nArtifact would be: release/Hearth Control-${version}-arm64.dmg\n`);
process.stdout.write(`Repository:        ${path.relative(os.homedir(), ROOT) || ROOT}\n`);
