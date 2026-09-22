import fs from 'node:fs';
import os from 'node:os';

import {
  X_CODER_LAUNCH_AGENT_LABEL,
  buildXCoderLaunchAgentPlist,
  resolvePackagedAppResourcesDir,
  resolveXCoderLaunchAgentPaths,
  stageXCoderServiceRuntime,
} from '../mcp/x-coder-service/launch-agent.mjs';
import { ensureXCoderAuthSecret } from '../mcp/x/x-coder-auth.mjs';
import {
  installXCoderLaunchAgent,
  uninstallXCoderLaunchAgent,
} from '../mcp/x-coder-service/launch-agent-installer.mjs';
import {
  domainForUid,
  launchAgentServiceTarget,
  launchdSnapshot,
  effectiveHealth,
  runLaunchctl,
  waitForHealth as waitForHealthReal,
} from '../mcp/x-coder-service/launchctl.mjs';

const action = process.argv[2] || 'status';
const supported = new Set(['install', 'status', 'uninstall', 'print']);
if (!supported.has(action)) {
  console.error(JSON.stringify({
    ok: false,
    error: 'unsupported_action',
    supported: [...supported],
  }));
  process.exit(2);
}

// A production/DMG install stages the running app's mcp/ tree into a stable,
// per-version directory under Application Support and points the LaunchAgent
// there instead of at the source repo or an asar archive. Dev/test mode
// (the default) is unchanged: it points directly at this checkout. This CLI
// path is a manual/debug entry point; the packaged app itself drives the
// equivalent flow through mcp/x-coder-service/packaged-lifecycle.mjs at
// startup, with no dependency on this script being present in the bundle.
const packaged = process.env.X_CODER_PACKAGED_INSTALL === '1';
const pathOptions = packaged
  ? {
    packaged: true,
    appResourcesDir: process.env.X_CODER_RESOURCES_PATH
      ? resolvePackagedAppResourcesDir(process.env.X_CODER_RESOURCES_PATH)
      : undefined,
    appVersion: process.env.X_CODER_APP_VERSION || undefined,
  }
  : {};

const paths = resolveXCoderLaunchAgentPaths(pathOptions);
const domain = domainForUid(process.getuid?.() ?? os.userInfo().uid);
const serviceTarget = launchAgentServiceTarget({ domain, label: X_CODER_LAUNCH_AGENT_LABEL });

const failIfNotMac = () => {
  if (process.platform !== 'darwin') {
    console.error(JSON.stringify({ ok: false, error: 'macos_required' }));
    process.exit(3);
  }
};

const waitForHealth = () => waitForHealthReal({ port: paths.port, serviceTarget, runLaunchctl });

try {
  if (action === 'print') {
    process.stdout.write(buildXCoderLaunchAgentPlist(pathOptions));
    process.exit(0);
  }

  failIfNotMac();

  if (action === 'install') {
    if (packaged) {
      stageXCoderServiceRuntime({ sourceMcpDir: paths.sourceMcpDir, destMcpDir: paths.stagedMcpDir });
    }
    if (!fs.existsSync(paths.nodePath)) {
      throw new Error(`node executable not found: ${paths.nodePath}`);
    }
    if (!fs.existsSync(paths.servicePath)) {
      throw new Error(`X Coder Service entrypoint not found: ${paths.servicePath}`);
    }

    fs.mkdirSync(paths.launchAgentsDir, { recursive: true });
    fs.mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
    ensureXCoderAuthSecret({ secretPath: paths.authSecretPath });

    const result = await installXCoderLaunchAgent({
      plistPath: paths.plistPath,
      plistContent: buildXCoderLaunchAgentPlist(pathOptions),
      domain,
      serviceTarget,
      runLaunchctl,
      waitForHealth,
    });

    console.log(JSON.stringify({
      ok: result.ok,
      action,
      label: paths.label,
      packaged,
      plist_path: paths.plistPath,
      service_path: paths.servicePath,
      staged_runtime_root: paths.stagedRuntimeRoot,
      storage_path: paths.storagePath,
      auth_secret_path: paths.authSecretPath,
      stdout_path: paths.stdoutPath,
      stderr_path: paths.stderrPath,
      stage: result.stage,
      had_previous_service: result.hadPrevious,
      rollback: result.rollback,
      health: result.health,
    }, null, 2));
    process.exit(result.ok ? 0 : 4);
  }

  if (action === 'uninstall') {
    const result = uninstallXCoderLaunchAgent({
      plistPath: paths.plistPath,
      serviceTarget,
      runLaunchctl,
    });

    console.log(JSON.stringify({
      ok: result.ok,
      action,
      label: paths.label,
      plist_path: paths.plistPath,
      had_plist: result.hadPlist,
      reason: result.reason,
      launchctl_status: result.launchctl.status,
      launchctl_stderr: result.launchctl.stderr || null,
    }, null, 2));
    process.exit(result.ok ? 0 : 6);
  }

  const printed = launchdSnapshot({ serviceTarget, runLaunchctl });
  const serviceHealth = await effectiveHealth({ port: paths.port, serviceTarget, runLaunchctl });
  console.log(JSON.stringify({
    ok: printed.loaded && serviceHealth.ok,
    action,
    label: paths.label,
    packaged,
    loaded: printed.loaded,
    pid: printed.pid,
    health: serviceHealth,
    plist_path: paths.plistPath,
    launchctl: {
      status: printed.print.status,
      stderr: printed.print.stderr || null,
    },
  }, null, 2));
  process.exit(printed.loaded && serviceHealth.ok ? 0 : 5);
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    action,
    error: error?.code || 'x_coder_launch_agent_error',
    message: error?.message || String(error),
  }, null, 2));
  process.exit(1);
}
