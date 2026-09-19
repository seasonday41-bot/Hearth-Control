const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sha256Directory } = require('../electron/updater.cjs');
const {
  SCHEMA_V2,
  APP_NAME,
  validateRemoteManifestSchema,
  isSafeRelativeArtifactPath,
} = require('../electron/remote-update-manifest.cjs');

async function pathExists(candidate) {
  return fs.promises.lstat(candidate).then(() => true).catch(() => false);
}

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function replaceOutputDirectory({ outputDirectory, stagingDirectory }) {
  const backupDirectory = `${outputDirectory}.previous-${crypto.randomUUID()}`;
  const hadExistingOutput = await pathExists(outputDirectory);
  let movedExistingOutput = false;
  try {
    if (hadExistingOutput) {
      await fs.promises.rename(outputDirectory, backupDirectory);
      movedExistingOutput = true;
    }
    await fs.promises.rename(stagingDirectory, outputDirectory);
    if (movedExistingOutput) await fs.promises.rm(backupDirectory, { recursive: true, force: true });
  } catch (error) {
    if (movedExistingOutput && !(await pathExists(outputDirectory)) && await pathExists(backupDirectory)) {
      await fs.promises.rename(backupDirectory, outputDirectory).catch(() => {});
    }
    throw error;
  }
}

/**
 * Generates an unsigned remote update manifest v2 conforming to docs/REMOTE-ONE-CLICK-UPDATER-V1.md.
 * @param {{
 *   metadata: { version: string, buildId: string, builtAt: string, channel?: string, releaseNotes?: string },
 *   appTreeSha256: string,
 *   dmgPath: string,
 *   relativeArtifactPath?: string,
 *   channel?: string,
 *   releaseNotes?: string,
 * }} params
 */
async function generateRemoteManifestV2({
  metadata,
  appTreeSha256,
  dmgPath,
  relativeArtifactPath,
  channel = 'stable',
  releaseNotes = '',
}) {
  if (!metadata || typeof metadata !== 'object') {
    throw new Error('Metadata object is required for remote manifest.');
  }
  if (!appTreeSha256 || typeof appTreeSha256 !== 'string') {
    throw new Error('appTreeSha256 is required for remote manifest.');
  }
  if (!dmgPath || typeof dmgPath !== 'string') {
    throw new Error('dmgPath is required for remote manifest.');
  }

  const stat = await fs.promises.stat(dmgPath).catch(() => null);
  if (!stat?.isFile()) {
    throw new Error(`DMG file was not found at '${dmgPath}'.`);
  }

  const dmgSha256 = await sha256File(dmgPath);
  const dmgName = path.basename(dmgPath);
  // GitHub Releases exposes assets as flat filenames within a release.
  // Keep the signed artifact authority relative; production main resolves it
  // against its fixed /releases/latest/download/ base URL.
  const resolvedArtifactPath = relativeArtifactPath || dmgName;

  if (!isSafeRelativeArtifactPath(resolvedArtifactPath)) {
    throw new Error(`Artifact path must be strictly relative and safe: '${resolvedArtifactPath}'.`);
  }

  const manifest = {
    schema: SCHEMA_V2,
    version: metadata.version,
    buildId: metadata.buildId,
    builtAt: metadata.builtAt,
    channel: channel || metadata.channel || 'stable',
    platform: 'darwin',
    arch: 'arm64',
    appPath: APP_NAME,
    sha256: appTreeSha256,
    artifact: {
      kind: 'dmg',
      path: resolvedArtifactPath,
      size: stat.size,
      sha256: dmgSha256,
    },
    releaseNotes: releaseNotes !== undefined ? releaseNotes : (metadata.releaseNotes || ''),
  };

  validateRemoteManifestSchema(manifest, { requireSignature: false });
  return manifest;
}

async function packageUpdateBundle({
  root,
  metadata,
  includeRemote = false,
  relativeArtifactPath,
  channel = 'stable',
  releaseNotes = '',
}) {
  const release = path.join(root, 'release');
  const sourceApp = path.join(release, 'mac-arm64', APP_NAME);
  const outputDirectory = path.join(root, 'outputs');
  const stagingDirectory = path.join(root, `.outputs-staging-${crypto.randomUUID()}`);
  const targetApp = path.join(stagingDirectory, APP_NAME);
  const sourceStat = await fs.promises.stat(sourceApp).catch(() => null);
  if (!sourceStat?.isDirectory()) throw new Error('Packaged application was not found; output was left unchanged.');

  try {
    await fs.promises.mkdir(stagingDirectory, { recursive: true });
    // Keep the framework bundle's relative symlinks relative. The default
    // Node behaviour resolves them against release/, leaving the updater
    // artifact coupled to this source checkout after it is installed.
    await fs.promises.cp(sourceApp, targetApp, { recursive: true, verbatimSymlinks: true });
    const dmgName = `Hearth Control-${metadata.version}-arm64.dmg`;
    const sourceDmg = path.join(release, dmgName);
    const dmgStat = await fs.promises.stat(sourceDmg).catch(() => null);
    if (dmgStat?.isFile()) await fs.promises.copyFile(sourceDmg, path.join(stagingDirectory, dmgName));

    const appTreeSha256 = await sha256Directory(targetApp);

    // V1 local manifest (preserved for backward compatibility with updater.cjs)
    const manifest = {
      version: metadata.version,
      buildId: metadata.buildId,
      builtAt: metadata.builtAt,
      platform: 'darwin',
      arch: 'arm64',
      appPath: APP_NAME,
      ...(dmgStat?.isFile() ? { dmgPath: dmgName } : {}),
      sha256: appTreeSha256,
    };
    await fs.promises.writeFile(path.join(stagingDirectory, 'update-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    let remoteManifest = null;
    if (includeRemote && dmgStat?.isFile()) {
      remoteManifest = await generateRemoteManifestV2({
        metadata,
        appTreeSha256,
        dmgPath: path.join(stagingDirectory, dmgName),
        relativeArtifactPath,
        channel,
        releaseNotes,
      });
      await fs.promises.writeFile(
        path.join(stagingDirectory, 'remote-update-manifest.unsigned.json'),
        `${JSON.stringify(remoteManifest, null, 2)}\n`,
      );
    }

    await replaceOutputDirectory({ outputDirectory, stagingDirectory });
    return { outputDirectory, manifest, ...(remoteManifest ? { remoteManifest } : {}) };
  } catch (error) {
    await fs.promises.rm(stagingDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const includeRemote = args.includes('--remote');
  const root = path.join(__dirname, '..');
  const metadata = require('../electron/build-meta.json');
  const result = await packageUpdateBundle({ root, metadata, includeRemote });
  process.stdout.write(`Update manifest: ${path.join(result.outputDirectory, 'update-manifest.json')}\n`);
  if (result.remoteManifest) {
    process.stdout.write(`Remote manifest (unsigned): ${path.join(result.outputDirectory, 'remote-update-manifest.unsigned.json')}\n`);
  }
}

if (require.main === module) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

module.exports = {
  packageUpdateBundle,
  replaceOutputDirectory,
  generateRemoteManifestV2,
  sha256File,
};
