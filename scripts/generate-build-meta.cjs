// Writes electron/build-meta.json for the build that is about to happen.
//
// The identity is derived from the version and the exact commit, so building
// the same source twice produces the same build ID. The previous scheme
// appended three random bytes, which meant every rebuild invented a new
// identity and an installed artifact could not be matched to the one that had
// been verified.
const { buildMetadataFor, writeJson, BUILD_META } = require('./release/version.cjs');

const metadata = buildMetadataFor();
writeJson(BUILD_META, metadata);
process.stdout.write(`Build metadata: ${metadata.buildId}${metadata.dirty ? ' (DIRTY TREE: not reproducible)' : ''}\n`);
