#!/usr/bin/env node
// npm run release:provenance -- records exactly what was built, so the artifact
// that gets published can be proved to be the artifact that was verified.
//
// Read-only with respect to source: it reads the artifacts already in release/
// and the build metadata they were built with, and writes two files next to
// them. It never rebuilds, so it cannot substitute a different binary for the
// one under test.
const fs = require('node:fs');
const path = require('node:path');
const { currentVersion, gitState, readJson, writeJson, versionProblems, sha256File, BUILD_META, ROOT } = require('./version.cjs');

const RELEASE_DIR = path.join(ROOT, 'release');

const fail = (message) => { process.stderr.write(`${message}\n`); process.exit(1); };

const main = async () => {
  const version = currentVersion();
  const problems = versionProblems({ version });
  if (problems.length) fail(`Refusing to record provenance for an inconsistent tree:\n  - ${problems.join('\n  - ')}`);

  if (!fs.existsSync(BUILD_META)) fail('No build metadata. Build first: npm run dist:mac');
  const meta = readJson(BUILD_META);
  const git = gitState();

  if (meta.version !== version) fail(`Build metadata is version ${meta.version}, package.json is ${version}. Rebuild.`);
  if (git.available && meta.commit !== git.commit) {
    fail(`Build metadata commit ${String(meta.commit).slice(0, 7)} != HEAD ${git.shortCommit}. The artifacts in release/ were built from different source; rebuild before publishing.`);
  }

  const dmgName = `Hearth Control-${version}-arm64.dmg`;
  const dmgPath = path.join(RELEASE_DIR, dmgName);
  const stat = fs.existsSync(dmgPath) ? fs.statSync(dmgPath) : null;
  if (!stat?.isFile()) fail(`Artifact not found: release/${dmgName}. Build first: npm run dist:mac`);
  if (stat.size === 0) fail(`Artifact release/${dmgName} is empty.`);

  // build-meta.json is written before electron-builder packages it, so the
  // artifact is always newer. If it is not, the metadata was rewritten after
  // the build (by set-version, say) and no longer describes this artifact --
  // exactly the "published something other than what was verified" case.
  const metaStat = fs.statSync(BUILD_META);
  if (metaStat.mtimeMs > stat.mtimeMs) {
    fail(`Build metadata was written after release/${dmgName} was built, so it no longer describes it. Rebuild: npm run dist:mac`);
  }

  const sha256 = await sha256File(dmgPath);
  const provenance = {
    schema: 'hearth-release-provenance-v1',
    version,
    buildId: meta.buildId,
    commit: meta.commit,
    dirty: Boolean(meta.dirty),
    platform: meta.platform,
    arch: meta.arch,
    builtAt: meta.builtAt,
    artifact: { name: dmgName, size: stat.size, sha256 },
    recordedAt: new Date().toISOString(),
  };

  writeJson(path.join(RELEASE_DIR, `provenance-${version}.json`), provenance);
  fs.writeFileSync(path.join(RELEASE_DIR, 'SHA256SUMS.txt'), `${sha256}  ${dmgName}\n`);

  process.stdout.write(`Version:  ${version}\nBuild ID: ${meta.buildId}\nCommit:   ${meta.commit}\nArtifact: ${dmgName}\nSHA-256:  ${sha256}\nSize:     ${stat.size} bytes\n`);
  if (meta.dirty) process.stdout.write('\nWARNING: built from a dirty tree. This artifact cannot be reproduced from its commit.\n');
  process.stdout.write(`\nWrote release/provenance-${version}.json and release/SHA256SUMS.txt\n`);
};

main().catch((error) => fail(error.message));
