const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sha256Directory } = require('../electron/updater.cjs');

const APP_NAME = 'Hearth Control.app';

async function pathExists(candidate) {
  return fs.promises.lstat(candidate).then(() => true).catch(() => false);
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

async function packageUpdateBundle({ root, metadata }) {
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
    const manifest = {
      version: metadata.version,
      buildId: metadata.buildId,
      builtAt: metadata.builtAt,
      platform: 'darwin',
      arch: 'arm64',
      appPath: APP_NAME,
      ...(dmgStat?.isFile() ? { dmgPath: dmgName } : {}),
      sha256: await sha256Directory(targetApp),
    };
    await fs.promises.writeFile(path.join(stagingDirectory, 'update-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await replaceOutputDirectory({ outputDirectory, stagingDirectory });
    return { outputDirectory, manifest };
  } catch (error) {
    await fs.promises.rm(stagingDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function main() {
  const root = path.join(__dirname, '..');
  const metadata = require('../electron/build-meta.json');
  const { outputDirectory } = await packageUpdateBundle({ root, metadata });
  process.stdout.write(`Update manifest: ${path.join(outputDirectory, 'update-manifest.json')}\n`);
}

if (require.main === module) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

module.exports = { packageUpdateBundle, replaceOutputDirectory };
