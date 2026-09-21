// Hidden scorer: staging a .app bundle that contains .asar archives must copy
// them as opaque files under Electron (whose patched `fs` treats .asar as a
// directory). Independent of the visible test: a DIFFERENT fixture (two
// archives + app.asar.unpacked + a relative symlink to an archive), copyAppBundle
// called directly, and tree hashes compared from plain Node (not from inside
// Electron). Needs the Electron binary; a missing binary is BLOCKED, not a pass.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createScorer, parseRoot } from './_lib.mjs';

const root = parseRoot();
const s = createScorer();
const require = createRequire(path.join(root, 'x.cjs'));
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xeval-asar-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

let env;
await s.check('environment: electron binary + @electron/asar + updater loadable', async () => {
  const electron = require('electron');
  assert.ok(typeof electron === 'string' && fs.existsSync(electron), 'electron binary missing');
  const { createPackage } = require('@electron/asar');
  const updater = require('./electron/updater.cjs');
  const src = path.join(tmp, 'src', 'Hearth Control.app');
  const res = path.join(src, 'Contents', 'Resources');
  fs.mkdirSync(path.join(src, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(src, 'Contents', 'MacOS', 'Hearth Control'), 'bin-B');
  fs.mkdirSync(path.join(res, 'plugins'), { recursive: true });
  for (const [dest, name] of [[path.join(res, 'app.asar'), 'primary'], [path.join(res, 'plugins', 'extra.asar'), 'secondary']]) {
    const dir = fs.mkdtempSync(path.join(tmp, 'pkg-'));
    fs.mkdirSync(path.join(dir, 'lib'));
    fs.writeFileSync(path.join(dir, 'lib', 'index.js'), `module.exports='${name}';`);
    await createPackage(dir, dest);
  }
  fs.mkdirSync(path.join(res, 'app.asar.unpacked', 'native'), { recursive: true });
  fs.writeFileSync(path.join(res, 'app.asar.unpacked', 'native', 'addon.node'), 'unpacked-native');
  fs.symlinkSync('app.asar', path.join(res, 'current.asar'));
  env = { electron, updater, src, res, treeSha: await updater.sha256Directory(src),
    asarShas: { 'app.asar': sha(fs.readFileSync(path.join(res, 'app.asar'))), 'plugins/extra.asar': sha(fs.readFileSync(path.join(res, 'plugins', 'extra.asar'))) } };
});
if (!env) s.finish();

const runElectron = (script, args) => new Promise((resolve) => {
  const child = spawn(env.electron, ['-e', script, ...args], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = ''; let err = '';
  const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
});

const INNER = String.raw`
  const path = require('node:path');
  const physicalFs = require('original-fs');
  const stager = require(process.argv[1]);
  const [ , , src, dest, mode, treeSha ] = process.argv;
  (async () => {
    let error = null;
    try {
      if (mode === 'copy') {
        await stager.copyAppBundle(src, dest);
      } else {
        const execFileFn = async (file, args) => {
          if (args[0] === 'attach') { const mp = args[args.indexOf('-mountpoint') + 1]; await physicalFs.promises.cp(src, path.join(mp, 'Hearth Control.app'), { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true }); return { stdout: '', stderr: '' }; }
          if (args[0] === 'detach') return { stdout: '', stderr: '' };
          throw new Error('unexpected hdiutil op');
        };
        const manifest = { schema: 'hearth-update-v2', version: '9.9.9', buildId: 'xeval-asar-B', builtAt: '2026-09-19T02:42:32.292Z', channel: 'stable', platform: 'darwin', arch: 'arm64', appPath: 'Hearth Control.app', sha256: treeSha, artifact: { kind: 'dmg', path: 'x.dmg', size: 1, sha256: '0'.repeat(64) }, releaseNotes: '', signature: { algorithm: 'ed25519', keyId: 'f', value: Buffer.alloc(64).toString('base64') } };
        const r = await stager.stageVerifiedUpdate({ manifest, dmgPath: process.argv[6], updatesDir: dest, execFileFn, delayFn: async () => {} });
        process.stdout.write(JSON.stringify({ stagedApp: r.stagedAppPath }));
        return;
      }
    } catch (e) { error = String(e && e.message || e); }
    process.stdout.write(JSON.stringify({ error }));
  })();
`;
const parseOut = (r) => { try { return JSON.parse(r.out.trim().split('\n').pop()); } catch { return { error: `no JSON from electron (exit ${r.code}): ${r.err.slice(-200)}` }; } };
const asFile = (p) => fs.lstatSync(p).isFile();

await s.check('copyAppBundle copies both .asar archives as opaque files, plus unpacked dir and relative symlink', async () => {
  const dest = path.join(tmp, 'copied', 'Hearth Control.app');
  const out = parseOut(await runElectron(INNER, [path.join(root, 'electron', 'remote-update-stager.cjs'), env.src, dest, 'copy', env.treeSha]));
  assert.equal(out.error, null, `copy failed under Electron: ${out.error}`);
  for (const [rel, expected] of Object.entries(env.asarShas)) {
    const p = path.join(dest, 'Contents', 'Resources', rel);
    assert.ok(asFile(p), `${rel} must be a regular file`);
    assert.equal(sha(fs.readFileSync(p)), expected, `${rel} bytes differ`);
  }
  assert.equal(fs.readFileSync(path.join(dest, 'Contents', 'Resources', 'app.asar.unpacked', 'native', 'addon.node'), 'utf8'), 'unpacked-native');
  assert.equal(fs.readlinkSync(path.join(dest, 'Contents', 'Resources', 'current.asar')), 'app.asar');
  assert.equal(await env.updater.sha256Directory(dest), env.treeSha, 'staged tree hash differs from source');
});

await s.check('stageVerifiedUpdate stages this bundle under Electron and the staged tree hash matches', async () => {
  const updates = path.join(tmp, 'updates');
  const dmg = path.join(tmp, 'fixture.dmg');
  fs.writeFileSync(dmg, 'x');
  const out = parseOut(await runElectron(INNER, [path.join(root, 'electron', 'remote-update-stager.cjs'), env.src, updates, 'stage', env.treeSha, dmg]));
  assert.equal(out.error ?? null, null, `stageVerifiedUpdate failed under Electron: ${out.error}`);
  assert.ok(out.stagedApp, 'no staged app path returned');
  assert.equal(await env.updater.sha256Directory(out.stagedApp), env.treeSha);
  assert.ok(asFile(path.join(out.stagedApp, 'Contents', 'Resources', 'app.asar')));
});
s.finish();
