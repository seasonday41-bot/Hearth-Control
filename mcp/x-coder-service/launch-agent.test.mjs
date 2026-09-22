import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  X_CODER_LAUNCH_AGENT_LABEL,
  buildXCoderLaunchAgentPlist,
  resolveXCoderLaunchAgentPaths,
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
