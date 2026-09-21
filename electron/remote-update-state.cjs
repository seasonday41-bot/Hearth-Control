// Main-process remote updater state recovery. A signed current remote manifest
// remains the authority for which build may be offered, while the existing
// local updater validator remains the authority for whether its staged app
// tree is complete and trusted.
const path = require('node:path');

const localUpdater = require('./updater.cjs');
const remoteUpdater = require('./remote-updater.cjs');
const remoteUpdateStager = require('./remote-update-stager.cjs');

const publicRemoteManifest = (manifest) => manifest ? ({
  version: manifest.version,
  buildId: manifest.buildId,
  builtAt: manifest.builtAt,
  platform: manifest.platform,
  arch: manifest.arch,
  dmgPath: null,
}) : null;

const sameRemoteCandidateIdentity = (left, right) => Boolean(left && right)
  && left.version === right.version
  && left.buildId === right.buildId
  && left.builtAt === right.builtAt
  && left.platform === right.platform
  && left.arch === right.arch
  && String(left.sha256 || '').toLowerCase() === String(right.sha256 || '').toLowerCase();

async function inspectPreparedRemoteCandidate({ manifest, info, updatesDir }) {
  const stagedDir = remoteUpdateStager.resolveStagedDirectory({ buildId: manifest.buildId, updatesDir });
  let localManifest;
  try {
    // This is the canonical local updater validation path: controlled direct
    // child, real directory (not a symlink), and canonical app-tree SHA-256.
    localManifest = await localUpdater.readAndValidateManifest(stagedDir, manifest.platform, manifest.arch);
  } catch {
    return null;
  }

  const expectedAppPath = path.join(stagedDir, localUpdater.PRODUCT_NAME);
  if (!sameRemoteCandidateIdentity(localManifest, manifest) || localManifest.appPath !== expectedAppPath) return null;
  if (!localUpdater.isManifestNewer({
    manifest: localManifest,
    currentVersion: info.currentVersion,
    currentBuiltAt: info.builtAt,
  })) return null;

  return { stagedDir, localManifest };
}

async function checkRemoteUpdate({ currentSession, info, remoteOptions, updatesDir }) {
  const baseResult = {
    currentVersion: info.currentVersion,
    currentBuildId: info.currentBuildId,
    error: null,
  };
  if (info.isPackaged === false) {
    return {
      session: null,
      result: { ...baseResult, state: localUpdater.UPDATE_STATES.UP_TO_DATE, available: null, devMode: true },
    };
  }

  // fetchRemoteManifest validates schema and signature before any staged data
  // is considered. Disk state never overrides the signed latest manifest.
  const manifest = await remoteUpdater.fetchRemoteManifest(remoteOptions);
  remoteUpdater.validatePlatformAndArch(manifest, {
    expectedPlatform: remoteOptions.expectedPlatform,
    expectedArch: remoteOptions.expectedArch,
  });

  if (!localUpdater.isManifestNewer({
    manifest,
    currentVersion: info.currentVersion,
    currentBuiltAt: info.builtAt,
  })) {
    return {
      session: null,
      result: { ...baseResult, state: localUpdater.UPDATE_STATES.UP_TO_DATE, available: null, latestRelease: publicRemoteManifest(manifest) },
    };
  }

  const prepared = await inspectPreparedRemoteCandidate({ manifest, info, updatesDir });
  if (prepared) {
    const existingSessionMatches = currentSession?.state === localUpdater.UPDATE_STATES.UPDATE_READY
      && sameRemoteCandidateIdentity(currentSession.manifest, manifest)
      && path.resolve(currentSession.stagedDir || '') === path.resolve(prepared.stagedDir);
    const session = existingSessionMatches ? currentSession : {
      state: localUpdater.UPDATE_STATES.UPDATE_READY,
      manifest,
      stagedDir: prepared.stagedDir,
    };
    return {
      session,
      result: {
        ...baseResult,
        state: localUpdater.UPDATE_STATES.UPDATE_READY,
        available: publicRemoteManifest(manifest),
      },
    };
  }

  return {
    session: { state: 'update_available', manifest },
    result: { ...baseResult, state: 'update_available', available: publicRemoteManifest(manifest) },
  };
}

module.exports = {
  publicRemoteManifest,
  sameRemoteCandidateIdentity,
  inspectPreparedRemoteCandidate,
  checkRemoteUpdate,
};
