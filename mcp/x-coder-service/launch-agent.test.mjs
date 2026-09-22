import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach } from 'node:test';

import {
  X_CODER_LAUNCH_AGENT_LABEL,
  buildXCoderLaunchAgentPlist,
  resolvePackagedAppResourcesDir,
  resolveXCoderLaunchAgentPaths,
  stageXCoderServiceRuntime,
} from './launch-agent.mjs';

test('S9-1 LaunchAgent paths are user-scoped, deterministic, and use an absolute service entrypoint', () => {
  const resolved = resolveXCoderLaunchAgentPaths({
    homeDir: '/tmp/hearth-home',
    nodePath: '/usr/local/bin/node',
    servicePath: '/Applications/Hearth Control/mcp/x-coder-service/server.mjs',
    workingDirectory: '/Applications/Hearth Control',
  });

  assert.equal(resolved.label, X_CODER_LAUNCH_AGENT_LABEL);
  assert.equal(
    resolved.plistPath,
    '/tmp/hearth-home/Library/LaunchAgents/com.hearth-control.x-coder-service.plist',
  );
  assert.equal(
    resolved.storagePath,
    '/tmp/hearth-home/.hearth-control/x-coder-service/idempotency.sqlite',
  );
  assert.equal(path.isAbsolute(resolved.servicePath), true);
  assert.match(resolved.pathEnv, /^\/usr\/local\/bin:/);
});

test('S9-2 plist is restart-on-failure capable, private-by-default, and XML-escapes absolute paths', () => {
  const plist = buildXCoderLaunchAgentPlist({
    homeDir: '/tmp/Home & QA',
    nodePath: '/usr/local/bin/node',
    servicePath: '/Applications/Hearth & Control/mcp/x-coder-service/server.mjs',
    workingDirectory: '/Applications/Hearth & Control',
  });

  assert.match(plist, /<string>com\.hearth-control\.x-coder-service<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<key>Umask<\/key>\s*<integer>63<\/integer>/);
  assert.match(plist, /Hearth &amp; Control/);
  assert.match(plist, /Home &amp; QA/);
  assert.match(plist, /<key>X_CODER_PORT<\/key>\s*<string>3217<\/string>/);
  assert.match(plist, /<key>X_CODER_STORAGE_PATH<\/key>/);
  assert.doesNotMatch(plist, /0\.0\.0\.0/);
});

test('S9-3 relative executable or service paths fail closed before a plist can be installed', () => {
  assert.throws(
    () => resolveXCoderLaunchAgentPaths({
      homeDir: '/tmp/home',
      nodePath: 'node',
      servicePath: '/tmp/server.mjs',
      workingDirectory: '/tmp',
    }),
    /nodePath must be an absolute path/,
  );
  assert.throws(
    () => resolveXCoderLaunchAgentPaths({
      homeDir: '/tmp/home',
      nodePath: '/usr/bin/node',
      servicePath: 'mcp/x-coder-service/server.mjs',
      workingDirectory: '/tmp',
    }),
    /servicePath must be an absolute path/,
  );
});

test('S11-1 a packaged install resolves a stable, per-version path under Application Support, never the app bundle/asar', () => {
  const devRepoServicePath = '/Users/dev/Documents/Codex/some-workspace/mcp/x-coder-service/server.mjs';
  const resourcesPath = '/Applications/Hearth Control.app/Contents/Resources';
  const resolved = resolveXCoderLaunchAgentPaths({
    homeDir: '/Users/qa',
    nodePath: '/Applications/Hearth Control.app/Contents/MacOS/Hearth Control',
    packaged: true,
    appResourcesDir: resolvePackagedAppResourcesDir(resourcesPath),
    appVersion: '0.4.24',
  });

  assert.equal(
    resolved.servicePath,
    '/Users/qa/Library/Application Support/Hearth Control/x-coder-service/0.4.24/mcp/x-coder-service/server.mjs',
  );
  assert.equal(
    resolved.workingDirectory,
    '/Users/qa/Library/Application Support/Hearth Control/x-coder-service/0.4.24',
  );
  assert.doesNotMatch(resolved.servicePath, /app\.asar/);
  assert.doesNotMatch(resolved.servicePath, /Documents\/Codex/);
  assert.notEqual(resolved.servicePath, devRepoServicePath);
  assert.equal(
    resolved.sourceMcpDir,
    '/Applications/Hearth Control.app/Contents/Resources/app.asar.unpacked/mcp',
  );
});

test('S11-1b resolvePackagedAppResourcesDir always points at the unpacked resource tree, never the asar archive itself', () => {
  const resourcesPath = '/Applications/Hearth Control.app/Contents/Resources';
  const resourcesDir = resolvePackagedAppResourcesDir(resourcesPath);

  assert.equal(resourcesDir, '/Applications/Hearth Control.app/Contents/Resources/app.asar.unpacked');
  assert.match(resourcesDir, /app\.asar\.unpacked$/);
  assert.doesNotMatch(resourcesDir, /app\.asar$/);
  assert.throws(() => resolvePackagedAppResourcesDir('Resources'), /resourcesPath must be an absolute path/);
});

test('S11-2 a packaged install still fails closed on relative/missing inputs', () => {
  assert.throws(
    () => resolveXCoderLaunchAgentPaths({ packaged: true, appResourcesDir: '/Applications/App.app/Contents/Resources' }),
    /appVersion must be a non-empty version string/,
  );
  assert.throws(
    () => resolveXCoderLaunchAgentPaths({ packaged: true, appVersion: '0.4.24', appResourcesDir: 'Resources' }),
    /appResourcesDir must be an absolute path/,
  );
  assert.throws(
    () => resolveXCoderLaunchAgentPaths({
      packaged: true,
      appVersion: '../../etc',
      appResourcesDir: '/Applications/App.app/Contents/Resources',
    }),
    /appVersion must be a non-empty version string/,
  );
});

test('S11-3 dev/test mode is unaffected when packaged is left at its default', () => {
  const resolved = resolveXCoderLaunchAgentPaths({ homeDir: '/tmp/hearth-home' });
  assert.equal(resolved.packaged, false);
  assert.equal(resolved.stagedRuntimeRoot, null);
  assert.equal(resolved.appResourcesDir, null);
  assert.match(resolved.servicePath, /mcp\/x-coder-service\/server\.mjs$/);
});

const tmpDirs = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test('S11-4 stageXCoderServiceRuntime copies the mcp tree and excludes test files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-x-coder-stage-'));
  tmpDirs.push(root);
  const source = path.join(root, 'source-mcp');
  const dest = path.join(root, 'staged', 'mcp');

  fs.mkdirSync(path.join(source, 'x-coder-service'), { recursive: true });
  fs.writeFileSync(path.join(source, 'x-coder-service', 'server.mjs'), '// server\n');
  fs.writeFileSync(path.join(source, 'x-coder-service', 'server.test.mjs'), '// test\n');

  const result = stageXCoderServiceRuntime({ sourceMcpDir: source, destMcpDir: dest });

  assert.equal(fs.existsSync(path.join(dest, 'x-coder-service', 'server.mjs')), true);
  assert.equal(fs.existsSync(path.join(dest, 'x-coder-service', 'server.test.mjs')), false);
  assert.equal(result.destMcpDir, dest);
});

test('S11-5 stageXCoderServiceRuntime is safe to re-run and converges on the current source', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-x-coder-stage-'));
  tmpDirs.push(root);
  const source = path.join(root, 'source-mcp');
  const dest = path.join(root, 'staged', 'mcp');

  fs.mkdirSync(path.join(source, 'x-coder-service'), { recursive: true });
  fs.writeFileSync(path.join(source, 'x-coder-service', 'server.mjs'), '// v1\n');
  stageXCoderServiceRuntime({ sourceMcpDir: source, destMcpDir: dest });

  fs.writeFileSync(path.join(source, 'x-coder-service', 'server.mjs'), '// v2\n');
  fs.writeFileSync(path.join(source, 'x-coder-service', 'stub-executor.mjs'), '// new file\n');
  stageXCoderServiceRuntime({ sourceMcpDir: source, destMcpDir: dest });

  assert.equal(fs.readFileSync(path.join(dest, 'x-coder-service', 'server.mjs'), 'utf8'), '// v2\n');
  assert.equal(fs.existsSync(path.join(dest, 'x-coder-service', 'stub-executor.mjs')), true);
});
