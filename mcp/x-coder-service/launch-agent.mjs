import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const X_CODER_LAUNCH_AGENT_LABEL = 'com.hearth-control.x-coder-service';
export const X_CODER_LAUNCH_AGENT_PORT = 3217;

// The stable, user-owned directory that a packaged install's staged runtime
// lives under. Never the source repo and never inside the app bundle/asar,
// so it survives DMG install, one-click update, and app replacement.
export const X_CODER_PACKAGED_PRODUCT_DIR = 'Hearth Control';

const SERVICE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SERVICE_PATH = path.join(SERVICE_DIR, 'server.mjs');
const DEFAULT_WORKING_DIRECTORY = path.resolve(SERVICE_DIR, '..', '..');
const SAFE_VERSION = /^[0-9A-Za-z._+-]+$/;

const xmlEscape = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&apos;');

const requireAbsolute = (name, value) => {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) {
    throw new TypeError(`${name} must be an absolute path.`);
  }
  return path.normalize(value);
};

const safePath = (nodePath) => [...new Set([
  path.dirname(nodePath),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
])].join(':');

/**
 * In dev/test mode (the default), servicePath/workingDirectory point directly
 * at the repo the code is running from. When `packaged` is true, they instead
 * point at a per-version staged runtime under Application Support, computed
 * from `appVersion` alone -- never from `appResourcesDir`, which is only the
 * *source* to stage from and may sit inside an asar archive that will not
 * exist once the app is updated or replaced.
 */
export function resolveXCoderLaunchAgentPaths({
  homeDir = os.homedir(),
  nodePath = process.execPath,
  servicePath = DEFAULT_SERVICE_PATH,
  workingDirectory = DEFAULT_WORKING_DIRECTORY,
  port = X_CODER_LAUNCH_AGENT_PORT,
  packaged = false,
  appResourcesDir,
  appVersion,
} = {}) {
  const normalizedHome = requireAbsolute('homeDir', homeDir);
  const normalizedNode = requireAbsolute('nodePath', nodePath);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError('port must be an integer between 1 and 65535.');
  }

  let normalizedService = requireAbsolute('servicePath', servicePath);
  let normalizedWorkingDirectory = requireAbsolute('workingDirectory', workingDirectory);
  let normalizedAppResourcesDir = null;
  let stagedRuntimeRoot = null;

  if (packaged) {
    if (typeof appVersion !== 'string' || !SAFE_VERSION.test(appVersion)) {
      throw new TypeError('appVersion must be a non-empty version string for a packaged install.');
    }
    normalizedAppResourcesDir = requireAbsolute('appResourcesDir', appResourcesDir);
    stagedRuntimeRoot = path.join(
      normalizedHome,
      'Library',
      'Application Support',
      X_CODER_PACKAGED_PRODUCT_DIR,
      'x-coder-service',
      appVersion,
    );
    normalizedWorkingDirectory = stagedRuntimeRoot;
    normalizedService = path.join(stagedRuntimeRoot, 'mcp', 'x-coder-service', 'server.mjs');
  }

  const runtimeDir = path.join(normalizedHome, '.hearth-control', 'x-coder-service');
  return {
    label: X_CODER_LAUNCH_AGENT_LABEL,
    port,
    packaged,
    nodePath: normalizedNode,
    servicePath: normalizedService,
    workingDirectory: normalizedWorkingDirectory,
    appResourcesDir: normalizedAppResourcesDir,
    sourceMcpDir: normalizedAppResourcesDir ? path.join(normalizedAppResourcesDir, 'mcp') : null,
    stagedRuntimeRoot,
    stagedMcpDir: stagedRuntimeRoot ? path.join(stagedRuntimeRoot, 'mcp') : null,
    launchAgentsDir: path.join(normalizedHome, 'Library', 'LaunchAgents'),
    plistPath: path.join(
      normalizedHome,
      'Library',
      'LaunchAgents',
      X_CODER_LAUNCH_AGENT_LABEL + '.plist',
    ),
    runtimeDir,
    storagePath: path.join(runtimeDir, 'idempotency.sqlite'),
    authSecretPath: path.join(runtimeDir, 'auth.secret'),
    stdoutPath: path.join(runtimeDir, 'service.stdout.log'),
    stderrPath: path.join(runtimeDir, 'service.stderr.log'),
    pathEnv: safePath(normalizedNode),
  };
}

/**
 * Copies the runtime's mcp/ tree (self-contained: node: builtins only, no
 * npm deps) from the running app's resources into the stable staged
 * directory a packaged LaunchAgent points at. Excludes test files. Safe to
 * call repeatedly; it always leaves destMcpDir matching sourceMcpDir.
 */
export function stageXCoderServiceRuntime({ sourceMcpDir, destMcpDir }) {
  const normalizedSource = requireAbsolute('sourceMcpDir', sourceMcpDir);
  const normalizedDest = requireAbsolute('destMcpDir', destMcpDir);
  if (!fs.existsSync(normalizedSource)) {
    throw new Error(`X Coder Service source tree not found: ${normalizedSource}`);
  }

  fs.mkdirSync(path.dirname(normalizedDest), { recursive: true });
  fs.rmSync(normalizedDest, { recursive: true, force: true });
  fs.cpSync(normalizedSource, normalizedDest, {
    recursive: true,
    filter: (source) => !source.endsWith('.test.mjs'),
  });

  return { sourceMcpDir: normalizedSource, destMcpDir: normalizedDest };
}

export function buildXCoderLaunchAgentPlist(options = {}) {
  const resolved = resolveXCoderLaunchAgentPaths(options);
  const environment = {
    HOME: path.dirname(path.dirname(resolved.launchAgentsDir)),
    PATH: resolved.pathEnv,
    X_CODER_STORAGE_PATH: resolved.storagePath,
    X_CODER_AUTH_SECRET_PATH: resolved.authSecretPath,
    X_CODER_PORT: String(resolved.port),
  };

  if (process.versions?.electron) {
    environment.ELECTRON_RUN_AS_NODE = '1';
  }

  const environmentXml = Object.entries(environment)
    .map(([key, value]) => [
      `    <key>${xmlEscape(key)}</key>`,
      `    <string>${xmlEscape(value)}</string>`,
    ].join('\n'))
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(resolved.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(resolved.nodePath)}</string>
    <string>${xmlEscape(resolved.servicePath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(resolved.workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${environmentXml}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(resolved.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(resolved.stderrPath)}</string>
</dict>
</plist>
`;
}
