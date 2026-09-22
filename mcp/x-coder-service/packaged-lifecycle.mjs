import fs from 'node:fs';
import os from 'node:os';

import {
  X_CODER_LAUNCH_AGENT_LABEL,
  buildXCoderLaunchAgentPlist,
  resolvePackagedAppResourcesDir,
  resolveXCoderLaunchAgentPaths,
  stageXCoderServiceRuntime,
} from './launch-agent.mjs';
import { installXCoderLaunchAgent } from './launch-agent-installer.mjs';
import { ensureXCoderAuthSecret } from '../x/x-coder-auth.mjs';
import {
  domainForUid,
  launchAgentServiceTarget,
  runLaunchctl as realRunLaunchctl,
  waitForHealth as realWaitForHealth,
} from './launchctl.mjs';

/**
 * Called once from the packaged Electron app's own startup (app.whenReady),
 * this is what actually makes Slice 9's LaunchAgent lifecycle real for an
 * installed Hearth Control -- not just a `npm run x-coder:install` a
 * developer can run from the source repo. It:
 *
 *  - is a strict no-op outside a packaged, macOS build (dev mode/tests are
 *    completely unaffected: the manual `npm run x-coder:*` flow still points
 *    at the checkout the same way it always has);
 *  - resolves the CURRENT installed app's version into a stable, per-version
 *    staged runtime under Application Support (never the app bundle/asar);
 *  - skips the (disruptive) install/restart entirely when the LaunchAgent
 *    already points at that exact staged runtime and is healthy;
 *  - otherwise stages the running app's real mcp/ files (asarUnpack, never
 *    reading the asar archive itself) and performs a transactional install,
 *    so a version update safely stages the new version and moves the
 *    LaunchAgent onto it, or leaves the previous one running if that fails.
 */
export async function ensureXCoderServiceInstalled({
  isPackaged,
  resourcesPath,
  appVersion,
  homeDir = os.homedir(),
  uid = process.getuid?.() ?? os.userInfo().uid,
  runLaunchctl = realRunLaunchctl,
  waitForHealth,
} = {}) {
  if (!isPackaged) return { ok: true, skipped: true, reason: 'dev_mode' };
  if (process.platform !== 'darwin') return { ok: true, skipped: true, reason: 'unsupported_platform' };

  const paths = resolveXCoderLaunchAgentPaths({
    homeDir,
    packaged: true,
    appResourcesDir: resolvePackagedAppResourcesDir(resourcesPath),
    appVersion,
  });
  const domain = domainForUid(uid);
  const serviceTarget = launchAgentServiceTarget({ domain, label: X_CODER_LAUNCH_AGENT_LABEL });
  const health = (options) => (waitForHealth
    ? waitForHealth(options)
    : realWaitForHealth({ port: paths.port, serviceTarget, runLaunchctl, ...options }));

  const desiredPlist = buildXCoderLaunchAgentPlist({
    homeDir,
    packaged: true,
    appResourcesDir: paths.appResourcesDir,
    appVersion,
  });

  const currentPlist = fs.existsSync(paths.plistPath) ? fs.readFileSync(paths.plistPath, 'utf8') : null;
  if (currentPlist === desiredPlist) {
    const currentHealth = await health({ attempts: 1 });
    if (currentHealth.ok) {
      return {
        ok: true,
        skipped: true,
        reason: 'already_current',
        stagedRuntimeRoot: paths.stagedRuntimeRoot,
        servicePath: paths.servicePath,
      };
    }
  }

  stageXCoderServiceRuntime({ sourceMcpDir: paths.sourceMcpDir, destMcpDir: paths.stagedMcpDir });
  fs.mkdirSync(paths.launchAgentsDir, { recursive: true });
  fs.mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
  ensureXCoderAuthSecret({ secretPath: paths.authSecretPath });

  const result = await installXCoderLaunchAgent({
    plistPath: paths.plistPath,
    plistContent: desiredPlist,
    domain,
    serviceTarget,
    runLaunchctl,
    waitForHealth: health,
  });

  return {
    ...result,
    skipped: false,
    stagedRuntimeRoot: paths.stagedRuntimeRoot,
    servicePath: paths.servicePath,
  };
}
