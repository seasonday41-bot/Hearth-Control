import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const X_CODER_LAUNCH_AGENT_LABEL = 'com.hearth-control.x-coder-service';
export const X_CODER_LAUNCH_AGENT_PORT = 3217;

const SERVICE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SERVICE_PATH = path.join(SERVICE_DIR, 'server.mjs');
const DEFAULT_WORKING_DIRECTORY = path.resolve(SERVICE_DIR, '..', '..');

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

export function resolveXCoderLaunchAgentPaths({
  homeDir = os.homedir(),
  nodePath = process.execPath,
  servicePath = DEFAULT_SERVICE_PATH,
  workingDirectory = DEFAULT_WORKING_DIRECTORY,
  port = X_CODER_LAUNCH_AGENT_PORT,
} = {}) {
  const normalizedHome = requireAbsolute('homeDir', homeDir);
  const normalizedNode = requireAbsolute('nodePath', nodePath);
  const normalizedService = requireAbsolute('servicePath', servicePath);
  const normalizedWorkingDirectory = requireAbsolute('workingDirectory', workingDirectory);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError('port must be an integer between 1 and 65535.');
  }

  const runtimeDir = path.join(normalizedHome, '.hearth-control', 'x-coder-service');
  return {
    label: X_CODER_LAUNCH_AGENT_LABEL,
    port,
    nodePath: normalizedNode,
    servicePath: normalizedService,
    workingDirectory: normalizedWorkingDirectory,
    launchAgentsDir: path.join(normalizedHome, 'Library', 'LaunchAgents'),
    plistPath: path.join(
      normalizedHome,
      'Library',
      'LaunchAgents',
      X_CODER_LAUNCH_AGENT_LABEL + '.plist',
    ),
    runtimeDir,
    storagePath: path.join(runtimeDir, 'idempotency.sqlite'),
    stdoutPath: path.join(runtimeDir, 'service.stdout.log'),
    stderrPath: path.join(runtimeDir, 'service.stderr.log'),
    pathEnv: safePath(normalizedNode),
  };
}

export function buildXCoderLaunchAgentPlist(options = {}) {
  const resolved = resolveXCoderLaunchAgentPaths(options);
  const environment = {
    HOME: path.dirname(path.dirname(resolved.launchAgentsDir)),
    PATH: resolved.pathEnv,
    X_CODER_STORAGE_PATH: resolved.storagePath,
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
