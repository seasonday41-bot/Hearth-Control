// Writes electron/build-meta.json for the build that is about to happen.
//
// The identity is derived from the version and the exact commit, so building
// the same source twice produces the same build ID. The previous scheme
// appended three random bytes, which meant every rebuild invented a new
// identity and an installed artifact could not be matched to the one that had
// been verified.
const { buildMetadataFor, writeJson, BUILD_META, gitState } = require('./release/version.cjs');

const SOURCE_COMMIT = /^[0-9a-f]{40}$/;
const requestedSourceCommit = String(process.env.HEARTH_BUILD_SOURCE_COMMIT || '').trim();
const currentGit = gitState();

let metadata;
if (requestedSourceCommit) {
  if (!SOURCE_COMMIT.test(requestedSourceCommit)) {
    throw new Error('HEARTH_BUILD_SOURCE_COMMIT must be a full lowercase Git commit SHA.');
  }
  if (currentGit.available && currentGit.commit !== requestedSourceCommit) {
    throw new Error('HEARTH_BUILD_SOURCE_COMMIT does not match the current Git HEAD.');
  }
  metadata = buildMetadataFor({
    git: {
      ...currentGit,
      available: true,
      commit: requestedSourceCommit,
      shortCommit: requestedSourceCommit.slice(0, 7),
      dirty: currentGit.available ? currentGit.dirty : false,
    },
  });
} else {
  metadata = buildMetadataFor();
}
writeJson(BUILD_META, metadata);
process.stdout.write(`Build metadata: ${metadata.buildId}${metadata.dirty ? ' (DIRTY TREE: not reproducible)' : ''}\n`);
