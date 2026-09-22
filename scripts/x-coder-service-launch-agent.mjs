import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

import {
  X_CODER_LAUNCH_AGENT_LABEL,
  buildXCoderLaunchAgentPlist,
  resolveXCoderLaunchAgentPaths,
} from '../mcp/x-coder-service/launch-agent.mjs';

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

const paths = resolveXCoderLaunchAgentPaths();
const domain = `gui/${process.getuid?.() ?? os.userInfo().uid}`;
const serviceTarget = `${domain}/${X_CODER_LAUNCH_AGENT_LABEL}`;

const failIfNotMac = () => {
  if (process.platform !== 'darwin') {
    console.error(JSON.stringify({ ok: false, error: 'macos_required' }));
    process.exit(3);
  }
};

const runLaunchctl = (args, { allowFailure = false } = {}) => {
  const result = spawnSync('/bin/launchctl', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!allowFailure && result.status !== 0) {
    const error = new Error((result.stderr || result.stdout || 'launchctl_failed').trim());
    error.code = 'launchctl_failed';
    error.status = result.status;
    throw error;
  }
  return {
    status: result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
  };
};

const launchdSnapshot = () => {
  const printed = runLaunchctl(['print', serviceTarget], { allowFailure: true });
  const pidMatch = printed.stdout.match(/\bpid = (\d+)/);
  return {
    loaded: printed.status === 0,
    pid: pidMatch ? Number(pidMatch[1]) : null,
    print: printed,
  };
};

const listenerPids = () => {
  const result = spawnSync('/usr/sbin/lsof', [
    '-nP',
    '-t',
    `-iTCP:${paths.port}`,
    '-sTCP:LISTEN',
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
    .filter(Number.isInteger);
};

const httpHealth = async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 800);
  try {
    const response = await fetch(`http://127.0.0.1:${paths.port}/health`, {
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, status: response.status };
    const body = await response.json();
    return {
      ok: body?.status === 'ok' && body?.service === 'x-coder-service',
      status: response.status,
      pid: body?.pid ?? null,
      protocol: body?.protocol ?? null,
      probe: 'http',
    };
  } catch {
    return { ok: false, status: null, pid: null, protocol: null, probe: 'http' };
  } finally {
    clearTimeout(timer);
  }
};

const effectiveHealth = async () => {
  const http = await httpHealth();
  if (http.ok) return http;

  // Some automation/sandbox environments can inspect launchd but cannot
  // connect to a host LaunchAgent over loopback. Fall back only when the
  // exact launchd PID is also the process listening on the configured port.
  const launchd = launchdSnapshot();
  const listeners = listenerPids();
  if (launchd.loaded && Number.isInteger(launchd.pid) && listeners.includes(launchd.pid)) {
    return {
      ok: true,
      status: null,
      pid: launchd.pid,
      protocol: null,
      probe: 'launchd_listener',
      http_ok: false,
    };
  }
  return http;
};

const waitForHealth = async () => {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const result = await effectiveHealth();
    if (result.ok) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return effectiveHealth();
};

try {
  if (action === 'print') {
    process.stdout.write(buildXCoderLaunchAgentPlist());
    process.exit(0);
  }

  failIfNotMac();

  if (action === 'install') {
    if (!fs.existsSync(paths.nodePath)) {
      throw new Error(`node executable not found: ${paths.nodePath}`);
    }
    if (!fs.existsSync(paths.servicePath)) {
      throw new Error(`X Coder Service entrypoint not found: ${paths.servicePath}`);
    }

    fs.mkdirSync(paths.launchAgentsDir, { recursive: true });
    fs.mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });

    const tempPath = paths.plistPath + '.tmp-' + process.pid;
    fs.writeFileSync(tempPath, buildXCoderLaunchAgentPlist(), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, paths.plistPath);
    fs.chmodSync(paths.plistPath, 0o600);

    runLaunchctl(['bootout', serviceTarget], { allowFailure: true });
    let bootstrapped = false;
    let bootstrapResult = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 120));
      bootstrapResult = runLaunchctl(['bootstrap', domain, paths.plistPath], { allowFailure: true });
      if (bootstrapResult.status === 0) { bootstrapped = true; break; }
    }
    if (!bootstrapped) {
      const error = new Error((bootstrapResult?.stderr || bootstrapResult?.stdout || 'launchctl_bootstrap_failed').trim());
      error.code = 'launchctl_bootstrap_failed';
      throw error;
    }
    const serviceHealth = await waitForHealth();

    console.log(JSON.stringify({
      ok: serviceHealth.ok,
      action,
      label: paths.label,
      plist_path: paths.plistPath,
      service_path: paths.servicePath,
      storage_path: paths.storagePath,
      stdout_path: paths.stdoutPath,
      stderr_path: paths.stderrPath,
      health: serviceHealth,
    }, null, 2));
    process.exit(serviceHealth.ok ? 0 : 4);
  }

  if (action === 'uninstall') {
    const stopped = runLaunchctl(['bootout', serviceTarget], { allowFailure: true });
    fs.rmSync(paths.plistPath, { force: true });
    console.log(JSON.stringify({
      ok: true,
      action,
      label: paths.label,
      plist_path: paths.plistPath,
      launchctl_status: stopped.status,
    }, null, 2));
    process.exit(0);
  }

  const printed = launchdSnapshot();
  const serviceHealth = await effectiveHealth();
  console.log(JSON.stringify({
    ok: printed.loaded && serviceHealth.ok,
    action,
    label: paths.label,
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
