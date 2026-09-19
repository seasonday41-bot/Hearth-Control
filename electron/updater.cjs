// Local updater implementation lives here. It deliberately has no IPC or UI access
// so its validation and file operations can be exercised against temporary fixtures.
// Electron patches node:fs with ASAR-aware path handling. That is useful for
// loading files from this app's own archive, but it treats a candidate
// bundle's Contents/Resources/app.asar as a virtual archive path. A local
// update must inspect the bundle as an ordinary directory tree, so use
// Electron's unpatched filesystem when it is available and fall back to
// node:fs in tests and the manifest generator.
const fs = (() => {
  try { return require('original-fs'); }
  catch { return require('node:fs'); }
})();
const path = require('node:path');
const crypto = require('node:crypto');

const PRODUCT_NAME = 'Hearth Control.app';
const MANIFEST_NAME = 'update-manifest.json';
const UPDATE_STATES = Object.freeze({
  IDLE: 'idle',
  CHECKING: 'checking',
  UP_TO_DATE: 'up_to_date',
  UPDATE_READY: 'update_ready',
  INSTALLING: 'installing',
  RESTARTING: 'restarting',
  ROLLBACK: 'rollback',
  ERROR: 'error',
});

const UPDATE_RUNTIME_BLOCKERS = Object.freeze({
  X_ACTIVE: 'X_ACTIVE',
  GOAL_ACTIVE: 'GOAL_ACTIVE',
  DURABLE_JOB_ACTIVE: 'DURABLE_JOB_ACTIVE',
  UPDATER_BUSY: 'UPDATER_BUSY',
  RUNTIME_STATE_UNAVAILABLE: 'RUNTIME_STATE_UNAVAILABLE',
});
const UPDATE_RUNTIME_BLOCKER_MESSAGES = Object.freeze({
  [UPDATE_RUNTIME_BLOCKERS.X_ACTIVE]: 'Update installation is blocked while X is active.',
  [UPDATE_RUNTIME_BLOCKERS.GOAL_ACTIVE]: 'Update installation is blocked while a Goal is active.',
  [UPDATE_RUNTIME_BLOCKERS.DURABLE_JOB_ACTIVE]: 'Update installation is blocked while a durable job is queued or running.',
  [UPDATE_RUNTIME_BLOCKERS.UPDATER_BUSY]: 'Another update installation is already in progress.',
  [UPDATE_RUNTIME_BLOCKERS.RUNTIME_STATE_UNAVAILABLE]: 'Update installation is blocked because Hearth runtime activity could not be verified.',
});

function evaluateUpdaterRuntimePreflight({
  runtimeAvailable = true,
  xActive = false,
  goalActive = false,
  queuedJobCount = 0,
  runningJobCount = 0,
  updaterBusy = false,
} = {}) {
  let code = null;
  if (!runtimeAvailable) code = UPDATE_RUNTIME_BLOCKERS.RUNTIME_STATE_UNAVAILABLE;
  else if (updaterBusy) code = UPDATE_RUNTIME_BLOCKERS.UPDATER_BUSY;
  else if (xActive) code = UPDATE_RUNTIME_BLOCKERS.X_ACTIVE;
  else if (goalActive) code = UPDATE_RUNTIME_BLOCKERS.GOAL_ACTIVE;
  else if (Number(queuedJobCount) > 0 || Number(runningJobCount) > 0) code = UPDATE_RUNTIME_BLOCKERS.DURABLE_JOB_ACTIVE;
  if (!code) return null;
  return { code, message: UPDATE_RUNTIME_BLOCKER_MESSAGES[code] };
}

function blockedUpdateResult(blocker) {
  if (!blocker?.code || !UPDATE_RUNTIME_BLOCKER_MESSAGES[blocker.code]) {
    throw new Error('A valid updater runtime blocker is required.');
  }
  return {
    state: UPDATE_STATES.UPDATE_READY,
    blocked: true,
    blocker: blocker.code,
    message: UPDATE_RUNTIME_BLOCKER_MESSAGES[blocker.code],
  };
}

const safeReason = (message, fallback = 'The local update could not be verified.') => {
  const text = String(message || fallback).replace(/[\r\n]+/g, ' ').trim();
  // Keep filesystem paths out of the UI. The old whitespace-based replacement
  // left `Control.app` visible for a bundle whose name contains spaces.
  if (/^(?:ENOENT|ENOTDIR)\b|\bnot found in\b/i.test(text)) return 'The update application artifact is missing.';
  if (/^(?:EACCES|EPERM)\b/i.test(text)) return 'The update application artifact is not accessible.';
  if (/^EISDIR\b/i.test(text)) return 'The update artifact has an invalid file type.';
  return text.replace(/(?:[A-Za-z]:[\\/]|\/)[^\r\n]*/g, '[path]').trim().slice(0, 180) || fallback;
};
const sha256File = async (filePath) => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  stream.on('error', reject);
  stream.on('data', (chunk) => hash.update(chunk));
  stream.on('end', () => resolve(hash.digest('hex')));
});
const sha256Directory = async (directory) => {
  const hash = crypto.createHash('sha256');
  const writeRecord = (type, relativePath, extra = '') => {
    const record = JSON.stringify([type, relativePath.split(path.sep).join('/'), extra]);
    hash.update(Buffer.from(`${record}\n`, 'utf8'));
  };
  hash.update(Buffer.from('hearth-update-tree-sha256-v1\n', 'utf8'));
  const walk = async (current, relative = '') => {
    const entries = await fs.promises.readdir(current, { withFileTypes: true });
    // Sort UTF-8 bytes rather than locale-aware strings, and record every
    // entry kind. This makes the tree hash deterministic across hosts and
    // prevents a changed symlink or empty directory being ignored.
    for (const entry of entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)))) {
      const entryRelative = path.join(relative, entry.name);
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        writeRecord('directory', entryRelative);
        await walk(entryPath, entryRelative);
      } else if (entry.isFile()) {
        const contents = await fs.promises.readFile(entryPath);
        writeRecord('file', entryRelative, String(contents.length));
        hash.update(contents);
        hash.update(Buffer.from('\n', 'utf8'));
      } else if (entry.isSymbolicLink()) {
        writeRecord('symlink', entryRelative, await fs.promises.readlink(entryPath));
      } else {
        throw new Error('Update artifact contains an unsupported filesystem entry.');
      }
    }
  };
  await walk(directory);
  return hash.digest('hex');
};
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const parseVersion = (value) => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(value || ''));
  if (!match) return null;
  return { parts: match.slice(1, 4).map(Number), prerelease: match[4] || null };
};
const compareVersions = (left, right) => {
  const a = parseVersion(left); const b = parseVersion(right);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i += 1) if (a.parts[i] !== b.parts[i]) return a.parts[i] > b.parts[i] ? 1 : -1;
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease);
};
const isInside = (parent, candidate) => {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
};
const cleanBuildId = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{5,127}$/.test(value);

async function readAndValidateManifest(updateDirectory, expectedPlatform = process.platform, expectedArch = process.arch) {
  const trustedDirectory = path.resolve(updateDirectory);
  const manifestPath = path.join(trustedDirectory, MANIFEST_NAME);
  let manifest;
  try { manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8')); }
  catch { throw new Error('Update manifest is unavailable or malformed.'); }
  if (!isPlainObject(manifest) || typeof manifest.version !== 'string' || !cleanBuildId(manifest.buildId)
    || typeof manifest.builtAt !== 'string' || Number.isNaN(Date.parse(manifest.builtAt))
    || manifest.platform !== expectedPlatform || manifest.arch !== expectedArch
    || typeof manifest.appPath !== 'string' || typeof manifest.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(manifest.sha256)) {
    throw new Error('Update manifest has invalid metadata.');
  }
  if (!parseVersion(manifest.version)) throw new Error('Update manifest has an invalid version.');
  const appPath = path.resolve(trustedDirectory, manifest.appPath);
  // The manifest describes exactly one, direct child of the trusted folder.
  // This permits the product name's spaces while rejecting aliases, nested
  // paths, absolute paths, and every form of traversal.
  if (manifest.appPath !== PRODUCT_NAME || !isInside(trustedDirectory, appPath) || path.basename(appPath) !== PRODUCT_NAME) {
    throw new Error('Update artifact location is not trusted.');
  }
  const stat = await fs.promises.lstat(appPath).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error('Update application artifact is missing.');
  let actualChecksum;
  try { actualChecksum = await sha256Directory(appPath); }
  catch (error) { throw new Error(safeReason(error?.message, 'Update application artifact could not be read.')); }
  if (actualChecksum !== manifest.sha256.toLowerCase()) throw new Error('Update artifact checksum did not match.');
  return { ...manifest, appPath, manifestPath, sha256: actualChecksum };
}

/**
 * Whether a candidate manifest is actually newer than the running build.
 * Semantic version is authoritative first; a HIGHER version is always newer,
 * a LOWER version is never newer. Only when versions are EQUAL does build
 * recency matter -- and buildId is an identity string, not a clock, so it is
 * never used here. builtAt is compared chronologically instead; if either
 * timestamp is missing or unparseable this fails closed (not newer), rather
 * than ever treating an unverifiable same-version manifest as an update.
 * @param {{ manifest: { version: string, builtAt: string }, currentVersion: string, currentBuiltAt: string|null|undefined }} params
 * @returns {boolean}
 */
function isManifestNewer({ manifest, currentVersion, currentBuiltAt }) {
  const versionComparison = compareVersions(manifest.version, currentVersion);
  if (versionComparison === null) return false;
  if (versionComparison === 1) return true;
  if (versionComparison === -1) return false;
  const manifestBuiltAtMs = Date.parse(manifest.builtAt);
  const currentBuiltAtMs = Date.parse(currentBuiltAt);
  if (Number.isNaN(manifestBuiltAtMs) || Number.isNaN(currentBuiltAtMs)) return false;
  return manifestBuiltAtMs > currentBuiltAtMs;
}

/**
 * `isPackaged: false` (development mode) means the running build's identity
 * comes from a static, dev-restored electron/build-meta.json that has no
 * relationship to the actual running source/HEAD (see restore-stable-build-
 * meta.cjs). Comparing that static file against a packaged manifest would be
 * meaningless at best and could surface a strictly older packaged build as
 * "update ready" -- so development mode never reads or compares the
 * manifest at all, and never reports UPDATE_READY.
 */
async function inspectUpdate({ updateDirectory, currentVersion, currentBuildId, currentBuiltAt, isPackaged, platform, arch }) {
  if (isPackaged === false) {
    return { state: UPDATE_STATES.UP_TO_DATE, currentVersion, currentBuildId, available: null, error: null, devMode: true };
  }
  try {
    const manifest = await readAndValidateManifest(updateDirectory, platform, arch);
    const isNewer = isManifestNewer({ manifest, currentVersion, currentBuiltAt });
    return {
      state: isNewer ? UPDATE_STATES.UPDATE_READY : UPDATE_STATES.UP_TO_DATE,
      currentVersion, currentBuildId,
      available: isNewer ? publicManifest(manifest) : null,
      error: null,
    };
  } catch (error) {
    return { state: UPDATE_STATES.ERROR, currentVersion, currentBuildId, available: null, error: safeReason(error.message) };
  }
}
const publicManifest = (manifest) => ({ version: manifest.version, buildId: manifest.buildId, builtAt: manifest.builtAt, platform: manifest.platform, arch: manifest.arch, dmgPath: manifest.dmgPath || null });

const moveIfPresent = async (source, target) => {
  if (await fs.promises.stat(source).catch(() => null)) await fs.promises.rename(source, target);
};
const uniqueSibling = (target, label) => `${target}.${label}-${crypto.randomUUID()}`;

async function installUpdate({ manifest, currentVersion, currentBuiltAt, isPackaged, applicationsDirectory, userDataPath, launchRollbackHelper, userApproved }) {
  if (userApproved !== true) throw new Error('Local user approval is required before installing an update.');
  if (!manifest?.appPath || !manifest?.sha256) throw new Error('A verified update is required.');
  // Independent guard, deliberately re-derived here rather than trusting the
  // caller already ran inspectUpdate(): a stale renderer, race, or a future
  // caller that forgets the pre-check must never be able to force an install
  // that isn't actually newer than what's currently running.
  if (isPackaged === false) throw new Error('Updates are not available in development mode.');
  if (!isManifestNewer({ manifest, currentVersion, currentBuiltAt })) {
    throw new Error('The selected build is not newer than the currently running version.');
  }
  const source = manifest.appPath;
  const target = path.join(applicationsDirectory, PRODUCT_NAME);
  const backup = path.join(applicationsDirectory, 'Hearth Control.previous.app');
  if (path.basename(target) !== PRODUCT_NAME || path.basename(backup) !== 'Hearth Control.previous.app') throw new Error('Install target is invalid.');
  const sourceStat = await fs.promises.stat(source).catch(() => null);
  if (!sourceStat?.isDirectory()) throw new Error('Update application artifact is missing.');
  if (await sha256Directory(source) !== manifest.sha256) throw new Error('Update artifact checksum did not match.');
  await fs.promises.mkdir(applicationsDirectory, { recursive: true });
  const staging = uniqueSibling(target, 'installing');
  const previousArchive = uniqueSibling(backup, 'archived');
  try {
    // macOS framework bundles use relative symlinks extensively. Node resolves
    // them unless verbatimSymlinks is set, which rewrites an otherwise portable
    // bundle into one that points back to the build machine's release folder.
    await fs.promises.cp(source, staging, {
      recursive: true,
      force: false,
      errorOnExist: true,
      verbatimSymlinks: true,
    });
    await moveIfPresent(backup, previousArchive);
    await moveIfPresent(target, backup);
    await fs.promises.rename(staging, target);
    await fs.promises.rm(previousArchive, { recursive: true, force: true });
    const token = crypto.randomUUID();
    await fs.promises.writeFile(path.join(userDataPath, 'update-pending.json'), JSON.stringify({ token, target, backup, version: manifest.version, startedAt: new Date().toISOString() }));
    await launchRollbackHelper({ token, target, backup, userDataPath });
    return { state: UPDATE_STATES.RESTARTING, target, backup, token };
  } catch (error) {
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {});
    const targetExists = await fs.promises.stat(target).catch(() => null);
    const backupExists = await fs.promises.stat(backup).catch(() => null);
    if (!targetExists && backupExists) await fs.promises.rename(backup, target).catch(() => {});
    throw new Error(safeReason(error.message, 'The update could not be installed.'));
  }
}

async function recordStartupSuccess(userDataPath) {
  const pendingPath = path.join(userDataPath, 'update-pending.json');
  try {
    const pending = JSON.parse(await fs.promises.readFile(pendingPath, 'utf8'));
    if (!pending?.token || typeof pending.token !== 'string') return null;
    const marker = path.join(userDataPath, `update-startup-success-${pending.token}.json`);
    await fs.promises.writeFile(marker, JSON.stringify({ token: pending.token, at: new Date().toISOString() }));
    return pending.token;
  } catch { return null; }
}

async function rollbackPendingUpdate({ userDataPath, token, target, backup }) {
  const marker = path.join(userDataPath, `update-startup-success-${token}.json`);
  if (await fs.promises.stat(marker).catch(() => null)) return { rolledBack: false, healthy: true };
  const targetStat = await fs.promises.stat(target).catch(() => null);
  const backupStat = await fs.promises.stat(backup).catch(() => null);
  if (!backupStat?.isDirectory()) throw new Error('A previous version was not available for rollback.');
  const failed = uniqueSibling(target, 'failed');
  if (targetStat) await fs.promises.rename(target, failed);
  await fs.promises.rename(backup, target);
  await fs.promises.rm(failed, { recursive: true, force: true }).catch(() => {});
  await fs.promises.rm(path.join(userDataPath, 'update-pending.json'), { force: true }).catch(() => {});
  return { rolledBack: true, healthy: false, target };
}

module.exports = { PRODUCT_NAME, MANIFEST_NAME, UPDATE_STATES, UPDATE_RUNTIME_BLOCKERS, evaluateUpdaterRuntimePreflight, blockedUpdateResult, sha256File, sha256Directory, compareVersions, isManifestNewer, isInside, readAndValidateManifest, inspectUpdate, installUpdate, recordStartupSuccess, rollbackPendingUpdate, safeReason };
