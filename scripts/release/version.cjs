// The one place that knows what version this checkout is, and what identity a
// build of it would have.
//
// Before this module the version lived in four places -- package.json,
// package-lock.json, electron/build-meta.json and electron/stable-build-meta.json --
// and two of them carried a hand-edited regex pinning the current series
// (`/^0\.4\.22-\d{14}-[0-9a-f]{6}$/`). Every release meant editing that regex by
// hand in two files, and forgetting either one produced a green tree whose
// installed app reported a different version from its source.
//
// Here package.json is the single source of truth and everything else is
// derived from it plus the git commit.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');

const PACKAGE_JSON = path.join(ROOT, 'package.json');
const PACKAGE_LOCK = path.join(ROOT, 'package-lock.json');
const BUILD_META = path.join(ROOT, 'electron', 'build-meta.json');
const STABLE_META = path.join(ROOT, 'electron', 'stable-build-meta.json');

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/**
 * A build identity the updater will accept: `^[A-Za-z0-9][A-Za-z0-9._-]{5,127}$`
 * (electron/remote-update-manifest.cjs). Anything generated here must satisfy it.
 */
const BUILD_ID = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-[0-9a-f]{7,40}(?:-dirty)?$/;

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

const isSemver = (value) => typeof value === 'string' && SEMVER.test(value);

/** The canonical version of this checkout. Everything else is derived from it. */
const currentVersion = () => readJson(PACKAGE_JSON).version;

const git = (args) => {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};

/**
 * What git says about the tree a build would be made from. `available: false`
 * means this is not a git checkout at all (a packaged app, a tarball), which is
 * different from a checkout whose tree is dirty.
 */
const gitState = () => {
  const commit = git(['rev-parse', 'HEAD']);
  if (!commit) return { available: false, commit: null, shortCommit: null, dirty: false, committedAt: null, branch: null };
  return {
    available: true,
    commit,
    shortCommit: commit.slice(0, 7),
    // Only tracked, modified files make a build unreproducible; untracked files
    // are not part of what electron-builder packages.
    //
    // build-meta.json is a generated, untracked artifact. Every tracked
    // change must therefore count as dirty, including release source files.
    dirty: git(['status', '--porcelain', '--untracked-files=no'])
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .length > 0,
    committedAt: git(['show', '-s', '--format=%cI', 'HEAD']) || null,
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']) || null,
  };
};

/**
 * The identity of a build of this exact source.
 *
 * Deterministic on purpose: the same version at the same commit always produces
 * the same build ID, so building twice cannot silently yield two artifacts that
 * claim to be different things. The previous scheme appended three random bytes,
 * which made every rebuild a new identity and made it impossible to tell whether
 * an installed artifact was the one that had been verified.
 */
const buildIdFor = ({ version, shortCommit, dirty }) => {
  if (!shortCommit) return `${version}-nogit`;
  return `${version}-${shortCommit}${dirty ? '-dirty' : ''}`;
};

/** Build metadata for this checkout, without writing anything. */
const buildMetadataFor = ({ version = currentVersion(), git: state = gitState(), builtAt } = {}) => ({
  version,
  buildId: buildIdFor({ version, shortCommit: state.shortCommit, dirty: state.dirty }),
  builtAt: builtAt ?? new Date().toISOString(),
  commit: state.commit,
  dirty: state.dirty,
  platform: process.platform,
  arch: process.arch,
});

/**
 * The stable checkpoint `npm run dev` and `npm start` restore, so a developer
 * run does not churn build-meta.json. It is derived rather than copied from a
 * build, so preparing a release no longer depends on remembering to copy it.
 */
const stableMetadataFor = ({ version = currentVersion(), git: state = gitState() } = {}) =>
  // A checkpoint describes a COMMIT, so it is never dirty -- and it must not be,
  // or it stops being idempotent: writing the checkpoint modifies a tracked
  // file, which would make the next derivation see a dirty tree and produce a
  // different identity for the same commit.
  buildMetadataFor({ version, git: { ...state, dirty: false }, builtAt: state.committedAt ?? new Date().toISOString() });

/**
 * Every mismatch between the canonical version and something derived from it.
 * An empty array means the tree is internally consistent.
 */
const versionProblems = ({ version = currentVersion(), requireStableCommit = false } = {}) => {
  const problems = [];
  if (!isSemver(version)) problems.push(`package.json version '${version}' is not a semantic version`);

  const lock = fs.existsSync(PACKAGE_LOCK) ? readJson(PACKAGE_LOCK) : null;
  if (lock) {
    if (lock.version !== version) problems.push(`package-lock.json version ${lock.version} != package.json ${version}`);
    const root = lock.packages?.[''];
    if (root && root.version !== version) problems.push(`package-lock.json packages[""].version ${root.version} != package.json ${version}`);
  }

  for (const [label, file] of [['build-meta.json', BUILD_META], ['stable-build-meta.json', STABLE_META]]) {
    if (!fs.existsSync(file)) {
      problems.push(`${label} is missing`);
      continue;
    }
    const meta = readJson(file);
    if (meta.version !== version) problems.push(`${label} version ${meta.version} != package.json ${version}`);
    if (!BUILD_ID.test(meta.buildId || '')) problems.push(`${label} buildId '${meta.buildId}' is not <version>-<commit>[-dirty]`);
    else if (!String(meta.buildId).startsWith(`${version}-`)) problems.push(`${label} buildId '${meta.buildId}' does not belong to version ${version}`);
    if (!meta.commit) problems.push(`${label} has no commit, so the artifact cannot be traced to a source tree`);
  }

  if (requireStableCommit && fs.existsSync(STABLE_META)) {
    const state = gitState();
    const stable = readJson(STABLE_META);
    if (state.available && stable.commit !== state.commit) {
      problems.push(`stable-build-meta.json commit ${String(stable.commit).slice(0, 7)} != HEAD ${state.shortCommit}`);
    }
  }

  return problems;
};

/** Writes the version everywhere it is derived. Returns the files it changed. */
const setVersion = (version) => {
  if (!isSemver(version)) throw new Error(`'${version}' is not a semantic version (expected MAJOR.MINOR.PATCH)`);

  const changed = [];
  const state = gitState();

  const pkg = readJson(PACKAGE_JSON);
  if (pkg.version !== version) {
    pkg.version = version;
    writeJson(PACKAGE_JSON, pkg);
    changed.push('package.json');
  }

  if (fs.existsSync(PACKAGE_LOCK)) {
    const lock = readJson(PACKAGE_LOCK);
    let touched = false;
    if (lock.version !== version) { lock.version = version; touched = true; }
    if (lock.packages?.['']?.version && lock.packages[''].version !== version) { lock.packages[''].version = version; touched = true; }
    if (touched) {
      writeJson(PACKAGE_LOCK, lock);
      changed.push('package-lock.json');
    }
  }

  // The stable checkpoint is derived, never hand-copied from a build.
  const stable = stableMetadataFor({ version, git: state });
  const existingStable = fs.existsSync(STABLE_META) ? readJson(STABLE_META) : null;
  if (JSON.stringify(existingStable) !== JSON.stringify(stable)) {
    writeJson(STABLE_META, stable);
    changed.push('electron/stable-build-meta.json');
  }

  // build-meta.json describes the last build. Keep it in step so a stale one
  // cannot make the app report a version its source no longer has; a real build
  // overwrites it with its own builtAt.
  // Matches the checkpoint until a real build overwrites it with the true state
  // of the tree it was built from.
  const existingBuild = fs.existsSync(BUILD_META) ? readJson(BUILD_META) : null;
  const build = { ...stable };
  if (JSON.stringify(existingBuild) !== JSON.stringify(build)) {
    writeJson(BUILD_META, build);
    changed.push('electron/build-meta.json');
  }

  return { version, changed, buildId: stable.buildId, commit: state.commit };
};

module.exports = {
  ROOT,
  PACKAGE_JSON,
  PACKAGE_LOCK,
  BUILD_META,
  STABLE_META,
  SEMVER,
  BUILD_ID,
  isSemver,
  currentVersion,
  gitState,
  buildIdFor,
  buildMetadataFor,
  stableMetadataFor,
  versionProblems,
  setVersion,
  readJson,
  writeJson,
  sha256File: (filePath) => new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  }),
};
