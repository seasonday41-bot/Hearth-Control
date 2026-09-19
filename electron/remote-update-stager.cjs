// P2C: delivery/staging layer in front of the existing local updater.
//
// Takes a DMG that has already passed P2A/P2B verification (signed manifest,
// platform/arch, newness, exact byte size, DMG SHA-256 -- see
// electron/remote-updater.cjs) and mounts it read-only, validates it contains
// exactly the expected application bundle, copies that bundle into the
// trusted local staging layout, and detaches the mount. It never installs
// the staged app and never touches electron/updater.cjs's install path --
// it only prepares the exact directory shape that module's
// readAndValidateManifest() already expects, for a future handoff.
const fs = require('node:fs');
// Electron patches node:fs with ASAR-aware semantics. Keep that behavior for
// ordinary validation/cleanup, but copy a verified .app bundle through the
// physical filesystem so Contents/Resources/app.asar remains an opaque file.
const physicalFs = (() => {
  try { return require('original-fs'); }
  catch { return fs; }
})();
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const util = require('node:util');

const {
  PRODUCT_NAME,
  MANIFEST_NAME,
  sha256Directory,
  isInside,
  safeReason,
} = require('./updater.cjs');

const { resolveUpdatesDirectory } = require('./remote-updater.cjs');

const HDIUTIL_BIN = '/usr/bin/hdiutil';
const MOUNT_DIR_NAME = 'mount';
const STAGED_DIR_NAME = 'staged';
const DEFAULT_MOUNT_TIMEOUT_MS = 30_000;
const DEFAULT_DETACH_TIMEOUT_MS = 15_000;
const DEFAULT_DETACH_MAX_ATTEMPTS = 3;
const DEFAULT_DETACH_RETRY_DELAY_MS = 300;

const execFileAsync = util.promisify(execFile);
const defaultExecFileFn = (file, args, options) => execFileAsync(file, args, options);
const defaultDelayFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isCleanBuildIdSegment = (value) =>
  typeof value === 'string' && value.length > 0 && !value.includes('/') && !value.includes('\\') && value !== '.' && value !== '..';

/**
 * Mounts a verified DMG read-only, non-interactively, at a caller-controlled
 * mount point. Uses the fixed absolute hdiutil path (no PATH lookup, no
 * shell) and fails closed on any non-zero exit or timeout.
 */
async function mountDmgReadOnly({ dmgPath, mountPoint, execFileFn = defaultExecFileFn, timeoutMs = DEFAULT_MOUNT_TIMEOUT_MS }) {
  if (!dmgPath || typeof dmgPath !== 'string') throw new Error('dmgPath is required to mount an update image.');
  if (!mountPoint || typeof mountPoint !== 'string') throw new Error('mountPoint is required to mount an update image.');

  await fs.promises.mkdir(mountPoint, { recursive: true });
  const existing = await fs.promises.readdir(mountPoint);
  if (existing.length > 0) {
    throw new Error(`Mount point is not empty; refusing to attach over existing contents.`);
  }

  const args = ['attach', dmgPath, '-mountpoint', mountPoint, '-nobrowse', '-noautoopen', '-readonly'];
  try {
    const { stdout, stderr } = await execFileFn(HDIUTIL_BIN, args, { shell: false, timeout: timeoutMs, windowsHide: true });
    return { mountPoint, stdout, stderr };
  } catch (err) {
    throw new Error(`Update image could not be mounted: ${safeReason(err.message, 'hdiutil attach failed.')}`);
  }
}

/**
 * Detaches a mounted DMG. Retries a bounded number of times on failure
 * (e.g. "resource busy"), using a plain detach first and only falling back
 * to a forced detach on the final attempt.
 */
async function detachDmg({
  mountPoint,
  execFileFn = defaultExecFileFn,
  timeoutMs = DEFAULT_DETACH_TIMEOUT_MS,
  maxAttempts = DEFAULT_DETACH_MAX_ATTEMPTS,
  retryDelayMs = DEFAULT_DETACH_RETRY_DELAY_MS,
  delayFn = defaultDelayFn,
}) {
  if (!mountPoint || typeof mountPoint !== 'string') throw new Error('mountPoint is required to detach an update image.');

  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const isFinalAttempt = attempt === maxAttempts;
    const args = isFinalAttempt ? ['detach', mountPoint, '-force'] : ['detach', mountPoint];
    try {
      await execFileFn(HDIUTIL_BIN, args, { shell: false, timeout: timeoutMs, windowsHide: true });
      return { detached: true, attempts: attempt, forced: isFinalAttempt };
    } catch (err) {
      lastErr = err;
      if (!isFinalAttempt) await delayFn(retryDelayMs);
    }
  }
  throw new Error(`Update image could not be detached after ${maxAttempts} attempts: ${safeReason(lastErr?.message, 'hdiutil detach failed.')}`);
}

/**
 * Validates that the mounted volume contains exactly the expected top-level
 * application bundle: not missing, not differently named (we only ever look
 * up the exact expected name -- never scan for alternates), not a symlink
 * alias, not a file, and not resolving outside the mount root.
 */
async function validateAppCandidate(mountPoint) {
  const candidatePath = path.join(mountPoint, PRODUCT_NAME);
  const stat = await fs.promises.lstat(candidatePath).catch(() => null);
  if (!stat) throw new Error(`Expected application bundle '${PRODUCT_NAME}' was not found in the mounted image.`);
  if (stat.isSymbolicLink()) throw new Error(`Top-level '${PRODUCT_NAME}' must not be a symlink.`);
  if (!stat.isDirectory()) throw new Error(`Top-level '${PRODUCT_NAME}' must be a directory.`);

  const mountRealPath = await fs.promises.realpath(mountPoint);
  const candidateRealPath = await fs.promises.realpath(candidatePath);
  if (!isInside(mountRealPath, candidateRealPath)) {
    throw new Error('Application bundle candidate resolves outside the mounted volume root.');
  }

  return candidatePath;
}

/**
 * Copies the validated app bundle into the staging directory. Mirrors
 * updater.cjs's installUpdate() copy semantics exactly (verbatimSymlinks so
 * relative framework symlinks are preserved rather than dereferenced, and
 * force:false/errorOnExist so a partial destination is never silently
 * merged into).
 */
async function copyAppBundle(candidatePath, stagedAppPath) {
  await physicalFs.promises.mkdir(path.dirname(stagedAppPath), { recursive: true });
  await physicalFs.promises.cp(candidatePath, stagedAppPath, {
    recursive: true,
    force: false,
    errorOnExist: true,
    verbatimSymlinks: true,
  });
}

/**
 * Converts a verified remote manifest (v2, signed, from
 * electron/remote-update-manifest.cjs) into the local trusted candidate
 * manifest shape that electron/updater.cjs's readAndValidateManifest()
 * expects: version, builtAt, app name/path, and application-tree SHA-256,
 * with no other fields. appPath is always the constant PRODUCT_NAME rather
 * than trusting the remote manifest's own appPath field, so this conversion
 * cannot be tricked into pointing the local manifest anywhere else.
 */
function buildLocalManifestFromRemote(remoteManifest, appTreeSha256) {
  return {
    version: remoteManifest.version,
    buildId: remoteManifest.buildId,
    builtAt: remoteManifest.builtAt,
    platform: remoteManifest.platform,
    arch: remoteManifest.arch,
    appPath: PRODUCT_NAME,
    sha256: appTreeSha256,
  };
}

async function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp-${crypto.randomUUID()}`);
  await fs.promises.writeFile(tmpPath, JSON.stringify(data, null, 2));
  await fs.promises.rename(tmpPath, filePath);
}

/**
 * Full P2C workflow for one already-verified build:
 *   verified .dmg -> mounted read-only -> inspected -> exact app copied ->
 *   staged -> DMG detached.
 *
 * Layout produced under resolveUpdatesDirectory()/<buildId>/:
 *   update-manifest.json   the raw verified remote (v2) manifest, kept for
 *                           audit/diagnostics next to the already-verified
 *                           DMG (never modified by this function).
 *   staged/update-manifest.json  the converted local (v1) trusted manifest,
 *                           ready for a future handoff to
 *                           updater.cjs's readAndValidateManifest(stagedDir).
 *   staged/Hearth Control.app    the copied, validated application bundle.
 *
 * Never calls updater.cjs's installUpdate() and never writes outside the
 * controlled per-build directory.
 */
async function stageVerifiedUpdate({
  manifest,
  dmgPath,
  updatesDir,
  execFileFn,
  mountTimeoutMs,
  detachTimeoutMs,
  detachMaxAttempts,
  detachRetryDelayMs,
  delayFn,
} = {}) {
  if (!manifest || typeof manifest !== 'object') throw new Error('A verified remote manifest is required.');
  if (!isCleanBuildIdSegment(manifest.buildId)) throw new Error('Manifest buildId is invalid for staging.');
  if (!dmgPath || typeof dmgPath !== 'string') throw new Error('A verified DMG path is required.');

  const baseDir = resolveUpdatesDirectory({ updatesDir });
  const buildDir = path.join(baseDir, manifest.buildId);
  if (!isInside(baseDir, buildDir)) {
    throw new Error('Build directory would escape the trusted updates root.');
  }

  const mountPoint = path.join(buildDir, MOUNT_DIR_NAME);
  const stagedDir = path.join(buildDir, STAGED_DIR_NAME);
  const stagedAppPath = path.join(stagedDir, PRODUCT_NAME);

  // An old incomplete staged directory for this exact build is never trusted;
  // remove it (only within this controlled build directory) before starting.
  await physicalFs.promises.rm(stagedDir, { recursive: true, force: true });

  let mounted = false;
  let stagingError = null;
  let stagingResult = null;

  try {
    await mountDmgReadOnly({ dmgPath, mountPoint, execFileFn, timeoutMs: mountTimeoutMs });
    mounted = true;

    const candidatePath = await validateAppCandidate(mountPoint);

    await copyAppBundle(candidatePath, stagedAppPath);

    const actualSha256 = await sha256Directory(stagedAppPath);
    if (typeof manifest.sha256 === 'string' && actualSha256 !== manifest.sha256.toLowerCase()) {
      throw new Error('Staged application tree checksum does not match the verified manifest.');
    }

    await writeJsonAtomic(path.join(stagedDir, MANIFEST_NAME), buildLocalManifestFromRemote(manifest, actualSha256));
    await writeJsonAtomic(path.join(buildDir, MANIFEST_NAME), manifest);

    stagingResult = {
      buildDir,
      mountPoint,
      stagedDir,
      stagedAppPath,
      localManifestPath: path.join(stagedDir, MANIFEST_NAME),
    };
  } catch (err) {
    stagingError = err;
  }

  if (stagingError) {
    // Staging itself failed: the staged candidate (if any partial state
    // exists) is never trusted, regardless of what happens to the mount.
    await physicalFs.promises.rm(stagedDir, { recursive: true, force: true }).catch(() => {});
  }

  let detachError = null;
  if (mounted) {
    try {
      await detachDmg({
        mountPoint,
        execFileFn,
        timeoutMs: detachTimeoutMs,
        maxAttempts: detachMaxAttempts,
        retryDelayMs: detachRetryDelayMs,
        delayFn,
      });
    } catch (err) {
      detachError = err;
    }
    await fs.promises.rm(mountPoint, { recursive: true, force: true }).catch(() => {});
  }

  if (stagingError) {
    // The original staging failure is always primary. A detach failure on
    // top of it is reported, not hidden, but it must never replace or mask
    // the real cause -- attach it rather than throwing a different error.
    if (detachError) {
      stagingError.cleanupError = detachError;
      console.error('[remote-update-stager] Detach also failed while cleaning up after a staging error:', safeReason(detachError.message));
    }
    throw stagingError;
  }

  if (detachError) {
    // Staging itself succeeded, but the mounted volume could not be detached
    // even after every bounded retry (including the final forced attempt).
    // A mounted volume must never be left behind silently, and staging must
    // never report success while that is true -- fail closed: discard the
    // staged trusted-candidate state and surface the detach failure.
    await physicalFs.promises.rm(stagedDir, { recursive: true, force: true }).catch(() => {});
    const failClosedErr = new Error(
      `Update image could not be detached after staging succeeded; the staged candidate has been discarded: ${safeReason(detachError.message)}`,
    );
    failClosedErr.cause = detachError;
    throw failClosedErr;
  }

  return stagingResult;
}

module.exports = {
  HDIUTIL_BIN,
  MOUNT_DIR_NAME,
  STAGED_DIR_NAME,
  mountDmgReadOnly,
  detachDmg,
  validateAppCandidate,
  copyAppBundle,
  buildLocalManifestFromRemote,
  stageVerifiedUpdate,
};
