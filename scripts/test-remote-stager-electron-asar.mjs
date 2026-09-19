import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createPackage: createAsar } = require('@electron/asar');
const updater = require('../electron/updater.cjs');
const electronExecutable = require('electron');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const stagerPath = path.join(__dirname, '..', 'electron', 'remote-update-stager.cjs');
const updaterPath = path.join(__dirname, '..', 'electron', 'updater.cjs');

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

async function createRealAppFixture(root) {
  const app = path.join(root, 'Hearth Control.app');
  const resources = path.join(app, 'Contents', 'Resources');
  const macos = path.join(app, 'Contents', 'MacOS');
  const framework = path.join(app, 'Contents', 'Frameworks', 'Example.framework');

  await fs.promises.mkdir(resources, { recursive: true });
  await fs.promises.mkdir(macos, { recursive: true });
  await fs.promises.writeFile(path.join(macos, 'Hearth Control'), 'binary-fixture');
  await fs.promises.chmod(path.join(macos, 'Hearth Control'), 0o755);

  await fs.promises.mkdir(path.join(framework, 'Versions', 'A'), { recursive: true });
  await fs.promises.writeFile(path.join(framework, 'Versions', 'A', 'Example'), 'framework-binary');
  await fs.promises.symlink('Versions/A/Example', path.join(framework, 'Example'));
  await fs.promises.symlink('A', path.join(framework, 'Versions', 'Current'));

  const asarSource = await fs.promises.mkdtemp(path.join(root, 'asar-source-'));
  await fs.promises.writeFile(path.join(asarSource, 'main.js'), 'module.exports = "physical-asar";');
  await createAsar(asarSource, path.join(resources, 'app.asar'));

  return app;
}

function runElectron(script, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(electronExecutable, ['-e', script, ...args], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`Electron stager regression failed (${code}): ${stderr || stdout}`));
    });
  });
}

function manifestFor(treeSha, buildId = '0.4.4-electron-asar-regression') {
  return {
    schema: 'hearth-update-v2',
    version: '0.4.4',
    buildId,
    builtAt: '2026-09-19T02:42:32.292Z',
    channel: 'stable',
    platform: 'darwin',
    arch: 'arm64',
    appPath: 'Hearth Control.app',
    sha256: treeSha,
    artifact: {
      kind: 'dmg',
      path: 'Hearth.Control-0.4.4-arm64.dmg',
      size: 1,
      sha256: '0'.repeat(64),
    },
    releaseNotes: '',
    signature: { algorithm: 'ed25519', keyId: 'fixture', value: Buffer.alloc(64).toString('base64') },
  };
}

test('Electron stager physically copies a real app.asar bundle without ASAR virtualization', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hearth-electron-stager-asar-'));
  try {
    const sourceRoot = path.join(root, 'source');
    await fs.promises.mkdir(sourceRoot, { recursive: true });
    const sourceApp = await createRealAppFixture(sourceRoot);
    const sourceAsar = path.join(sourceApp, 'Contents', 'Resources', 'app.asar');
    const sourceAsarSha = sha256(await fs.promises.readFile(sourceAsar));
    const treeSha = await updater.sha256Directory(sourceApp);
    const dmgPath = path.join(root, 'verified.dmg');
    await fs.promises.writeFile(dmgPath, 'fixture');
    const updatesDir = path.join(root, 'updates');
    const manifest = manifestFor(treeSha);

    const script = String.raw`
      const fs=require('node:fs');
      const physicalFs=require('original-fs');
      const path=require('node:path');
      const crypto=require('node:crypto');
      const stager=require(process.argv[1]);
      const updater=require(process.argv[2]);
      const sourceApp=process.argv[3];
      const dmgPath=process.argv[4];
      const updatesDir=process.argv[5];
      const manifest=JSON.parse(process.argv[6]);
      const sourceAsarSha=process.argv[7];

      const hash=(b)=>crypto.createHash('sha256').update(b).digest('hex');
      const copyOptions={recursive:true,force:false,errorOnExist:true,verbatimSymlinks:true};

      (async()=>{
        const probe=path.join(updatesDir,'patched-fs-probe.app');
        let patchedCopyFailed=false;
        let patchedCopyError='';
        try {
          await fs.promises.mkdir(updatesDir,{recursive:true});
          await fs.promises.cp(sourceApp,probe,copyOptions);
        } catch (error) {
          patchedCopyFailed=true;
          patchedCopyError=String(error && error.message || error);
        } finally {
          await physicalFs.promises.rm(probe,{recursive:true,force:true}).catch(()=>{});
        }
        if (!patchedCopyFailed || !/Invalid package.*app\.asar/i.test(patchedCopyError)) {
          throw new Error('Regression precondition failed: Electron-patched node:fs did not reproduce the app.asar copy failure.');
        }

        const execFileFn=async(file,args,options)=>{
          if (file !== '/usr/bin/hdiutil' || options.shell !== false) throw new Error('Unexpected hdiutil contract');
          if (args[0] === 'attach') {
            const mountPoint=args[args.indexOf('-mountpoint')+1];
            await physicalFs.promises.cp(sourceApp,path.join(mountPoint,'Hearth Control.app'),copyOptions);
            return {stdout:'',stderr:''};
          }
          if (args[0] === 'detach') return {stdout:'',stderr:''};
          throw new Error('Unexpected hdiutil operation');
        };

        const result=await stager.stageVerifiedUpdate({manifest,dmgPath,updatesDir,execFileFn,delayFn:async()=>{}});
        const copiedAsar=path.join(result.stagedAppPath,'Contents','Resources','app.asar');
        const asarStat=await physicalFs.promises.lstat(copiedAsar);
        const copiedAsarSha=hash(await physicalFs.promises.readFile(copiedAsar));
        const symlink=await physicalFs.promises.readlink(path.join(result.stagedAppPath,'Contents','Frameworks','Example.framework','Example'));
        const copiedTreeSha=await updater.sha256Directory(result.stagedAppPath);
        process.stdout.write(JSON.stringify({
          patchedCopyFailed,
          patchedCopyError,
          asarIsFile:asarStat.isFile(),
          copiedAsarSha,
          sourceAsarSha,
          symlink,
          copiedTreeSha,
          expectedTreeSha:manifest.sha256,
          stagedDir:result.stagedDir
        }));
      })().catch((error)=>{process.stderr.write(error.stack || String(error));process.exitCode=1;});
    `;

    const result = JSON.parse(await runElectron(script, [
      stagerPath,
      updaterPath,
      sourceApp,
      dmgPath,
      updatesDir,
      JSON.stringify(manifest),
      sourceAsarSha,
    ]));

    assert.equal(result.patchedCopyFailed, true);
    assert.match(result.patchedCopyError, /Invalid package.*app\.asar/i);
    assert.equal(result.asarIsFile, true);
    assert.equal(result.copiedAsarSha, sourceAsarSha);
    assert.equal(result.sourceAsarSha, sourceAsarSha);
    assert.equal(result.symlink, 'Versions/A/Example');
    assert.equal(result.copiedTreeSha, treeSha);
    assert.equal(result.expectedTreeSha, treeSha);
    assert.equal(await fs.promises.stat(result.stagedDir).then((s) => s.isDirectory()), true);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test('Electron stager keeps top-level symlink and buildId traversal rejection intact', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hearth-electron-stager-unsafe-'));
  try {
    const script = String.raw`
      const fs=require('node:fs');
      const physicalFs=require('original-fs');
      const path=require('node:path');
      const stager=require(process.argv[1]);
      const root=process.argv[2];
      (async()=>{
        const outside=path.join(root,'outside.app');
        const mount=path.join(root,'mount');
        await physicalFs.promises.mkdir(outside,{recursive:true});
        await physicalFs.promises.mkdir(mount,{recursive:true});
        await physicalFs.promises.symlink(outside,path.join(mount,'Hearth Control.app'));
        let symlinkRejected=false;
        try { await stager.validateAppCandidate(mount); }
        catch (e) { symlinkRejected=/must not be a symlink/i.test(e.message); }

        let traversalRejected=false;
        try {
          await stager.stageVerifiedUpdate({
            manifest:{buildId:'../escape'},
            dmgPath:path.join(root,'fixture.dmg'),
            updatesDir:path.join(root,'updates'),
            execFileFn:async()=>{throw new Error('must not execute');}
          });
        } catch (e) { traversalRejected=/buildId is invalid/i.test(e.message); }

        process.stdout.write(JSON.stringify({symlinkRejected,traversalRejected}));
      })().catch((error)=>{process.stderr.write(error.stack || String(error));process.exitCode=1;});
    `;
    const result = JSON.parse(await runElectron(script, [stagerPath, root]));
    assert.equal(result.symlinkRejected, true);
    assert.equal(result.traversalRejected, true);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test('Electron stager removes copied candidate when canonical tree validation fails', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hearth-electron-stager-cleanup-'));
  try {
    const sourceRoot = path.join(root, 'source');
    await fs.promises.mkdir(sourceRoot, { recursive: true });
    const sourceApp = await createRealAppFixture(sourceRoot);
    const dmgPath = path.join(root, 'verified.dmg');
    await fs.promises.writeFile(dmgPath, 'fixture');
    const updatesDir = path.join(root, 'updates');
    const manifest = manifestFor('f'.repeat(64), '0.4.4-electron-asar-cleanup');

    const script = String.raw`
      const physicalFs=require('original-fs');
      const path=require('node:path');
      const stager=require(process.argv[1]);
      const sourceApp=process.argv[2];
      const dmgPath=process.argv[3];
      const updatesDir=process.argv[4];
      const manifest=JSON.parse(process.argv[5]);
      const copyOptions={recursive:true,force:false,errorOnExist:true,verbatimSymlinks:true};
      (async()=>{
        let errorMessage='';
        const execFileFn=async(file,args,options)=>{
          if (file !== '/usr/bin/hdiutil' || options.shell !== false) throw new Error('Unexpected hdiutil contract');
          if (args[0] === 'attach') {
            const mountPoint=args[args.indexOf('-mountpoint')+1];
            await physicalFs.promises.cp(sourceApp,path.join(mountPoint,'Hearth Control.app'),copyOptions);
            return {stdout:'',stderr:''};
          }
          if (args[0] === 'detach') return {stdout:'',stderr:''};
          throw new Error('Unexpected hdiutil operation');
        };
        try { await stager.stageVerifiedUpdate({manifest,dmgPath,updatesDir,execFileFn,delayFn:async()=>{}}); }
        catch (e) { errorMessage=String(e.message || e); }
        const staged=path.join(updatesDir,manifest.buildId,'staged');
        const stagedExists=Boolean(await physicalFs.promises.stat(staged).catch(()=>null));
        process.stdout.write(JSON.stringify({errorMessage,stagedExists}));
      })().catch((error)=>{process.stderr.write(error.stack || String(error));process.exitCode=1;});
    `;

    const result = JSON.parse(await runElectron(script, [
      stagerPath,
      sourceApp,
      dmgPath,
      updatesDir,
      JSON.stringify(manifest),
    ]));
    assert.match(result.errorMessage, /checksum does not match/i);
    assert.equal(result.stagedExists, false);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
