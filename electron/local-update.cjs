// LOCAL_UPDATE source-build delivery for the owner's Mac.
// This module is deliberately separate from the public DMG updater: it accepts
// only a signed manifest carrying the fixed source repository and exact commit,
// builds in an isolated staging tree, and returns a normal local-updater bundle.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const util = require('node:util');
const { PRODUCT_NAME, MANIFEST_NAME, sha256Directory, isInside } = require('./updater.cjs');
const { safeFetchWithRedirects } = require('./remote-updater.cjs');

const execFileAsync = util.promisify(execFile);
const SOURCE_COMMIT = /^[0-9a-f]{40}$/;
const REPOSITORY = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
const MAX_SOURCE_BYTES = 500 * 1024 * 1024;

const validateSourceManifest = (manifest, { expectedRepository } = {}) => {
  const source = manifest?.source;
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('LOCAL_UPDATE source metadata is required.');
  if (!REPOSITORY.test(source.repository)) throw new Error('LOCAL_UPDATE source repository is invalid.');
  if (expectedRepository && source.repository !== expectedRepository) throw new Error('LOCAL_UPDATE source repository is not trusted.');
  if (!SOURCE_COMMIT.test(source.commit)) throw new Error('LOCAL_UPDATE source commit is invalid.');
  if (typeof source.archivePath !== 'string' || source.archivePath !== `${source.repository}/archive/${source.commit}.tar.gz`) {
    throw new Error('LOCAL_UPDATE source archive path is invalid.');
  }
  if (!/^[a-f0-9]{64}$/i.test(source.sha256 || '')) throw new Error('LOCAL_UPDATE source SHA-256 is invalid.');
  if (manifest?.buildId !== `${manifest.version}-${source.commit.slice(0, 7)}`) throw new Error('LOCAL_UPDATE build ID is not derived from the source commit.');
  return source;
};

const safeMkdir = (dir) => fs.promises.mkdir(dir, { recursive: true });

async function downloadSourceArchive({ manifest, sourceRoot, updatesDir, trustedOrigin, trustedOrigins, fetchFn, lookupFn, allowLocalhost = false }) {
  const source = validateSourceManifest(manifest);
  const base = new URL(sourceRoot || `${new URL(trustedOrigin).origin}/`);
  const url = new URL(source.archivePath, base).href;
  const response = await safeFetchWithRedirects(url, { trustedOrigin, trustedOrigins, fetchFn, lookupFn, allowLocalhost });
  const targetDir = path.resolve(updatesDir);
  await safeMkdir(targetDir);
  const part = path.join(targetDir, `${manifest.buildId}.source.part`);
  const final = path.join(targetDir, `${manifest.buildId}.source.tar.gz`);
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const file = await fs.promises.open(part, 'w');
  try {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_SOURCE_BYTES) throw new Error('LOCAL_UPDATE source archive exceeds the size limit.');
      hash.update(value);
      await file.write(value);
    }
    await file.sync();
    await file.close();
    const sha256 = hash.digest('hex');
    if (sha256 !== source.sha256.toLowerCase()) throw new Error('LOCAL_UPDATE source SHA-256 mismatch.');
    await fs.promises.rename(part, final);
    return { archivePath: final, sha256, bytes };
  } catch (error) {
    await file.close().catch(() => {});
    await fs.promises.rm(part, { force: true }).catch(() => {});
    await fs.promises.rm(final, { force: true }).catch(() => {});
    throw error;
  } finally {
    response._rawResponse?.destroy?.();
    response._agent?.destroy?.();
  }
}

async function buildAndStageLocalUpdate({ manifest, archivePath, stagingRoot, expectedRepository, execFileFn = execFileAsync, sign = true }) {
  const source = validateSourceManifest(manifest, { expectedRepository });
  const archiveHash = crypto.createHash('sha256').update(await fs.promises.readFile(archivePath)).digest('hex');
  if (archiveHash !== source.sha256.toLowerCase()) throw new Error('LOCAL_UPDATE source SHA-256 mismatch.');
  const root = path.resolve(stagingRoot);
  const buildRoot = path.join(root, manifest.buildId);
  const checkout = path.join(buildRoot, 'source');
  if (!isInside(root, buildRoot)) throw new Error('LOCAL_UPDATE staging path escaped its trusted root.');
  await fs.promises.rm(buildRoot, { recursive: true, force: true });
  await safeMkdir(checkout);
  try {
    await execFileFn('/usr/bin/tar', ['-xzf', archivePath, '-C', checkout], { shell: false });
    const entries = await fs.promises.readdir(checkout, { withFileTypes: true });
    const top = entries.filter((entry) => entry.isDirectory());
    if (top.length !== 1 || !top[0].name.endsWith(`-${source.commit}`)) throw new Error('LOCAL_UPDATE source archive root does not match the signed commit.');
    const repoRoot = path.join(checkout, top[0].name);
    const packageJson = JSON.parse(await fs.promises.readFile(path.join(repoRoot, 'package.json'), 'utf8'));
    if (packageJson.version !== manifest.version) throw new Error('LOCAL_UPDATE source version does not match manifest.');
    await execFileFn('npm', ['ci'], { cwd: repoRoot, shell: false, timeout: 15 * 60 * 1000 });
    await execFileFn('npm', ['run', 'dist:mac'], { cwd: repoRoot, shell: false, timeout: 30 * 60 * 1000 });
    const meta = JSON.parse(await fs.promises.readFile(path.join(repoRoot, 'electron', 'build-meta.json'), 'utf8').catch(() => '{}'));
    if (meta.version !== manifest.version || meta.buildId !== manifest.buildId || meta.commit !== source.commit || meta.dirty === true) {
      throw new Error('LOCAL_UPDATE generated build metadata does not match the signed source identity.');
    }
    const appPath = path.join(repoRoot, 'release', 'mac-arm64', PRODUCT_NAME);
    const appStat = await fs.promises.stat(appPath).catch(() => null);
    if (!appStat?.isDirectory()) throw new Error('LOCAL_UPDATE packaging did not produce Hearth Control.app.');
    if (sign) await execFileFn('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath], { shell: false, timeout: 5 * 60 * 1000 });
    if (sign) await execFileFn('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], { shell: false, timeout: 5 * 60 * 1000 });
    const staged = path.join(buildRoot, 'staged');
    await safeMkdir(staged);
    await fs.promises.cp(appPath, path.join(staged, PRODUCT_NAME), { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
    const treeSha256 = await sha256Directory(path.join(staged, PRODUCT_NAME));
    const localManifest = { version: manifest.version, buildId: manifest.buildId, builtAt: manifest.builtAt, platform: 'darwin', arch: 'arm64', appPath: PRODUCT_NAME, sha256: treeSha256 };
    await fs.promises.writeFile(path.join(staged, MANIFEST_NAME), `${JSON.stringify(localManifest, null, 2)}\n`);
    return { buildRoot, stagedDir: staged, stagedAppPath: path.join(staged, PRODUCT_NAME), localManifest };
  } catch (error) {
    await fs.promises.rm(buildRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

module.exports = { MAX_SOURCE_BYTES, validateSourceManifest, downloadSourceArchive, buildAndStageLocalUpdate };
