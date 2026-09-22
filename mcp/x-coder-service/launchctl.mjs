import { spawnSync } from 'node:child_process';

/**
 * Thin, real-launchctl implementations shared by the CLI installer
 * (scripts/x-coder-service-launch-agent.mjs) and the packaged app's
 * startup/update lifecycle (mcp/x-coder-service/packaged-lifecycle.mjs), so
 * the two entry points never drift on how a launchd result is interpreted.
 * Every caller that needs deterministic tests injects its own fakes instead
 * of importing the `run`/`waitForHealth` functions here.
 */

export const domainForUid = (uid) => `gui/${uid}`;
export const launchAgentServiceTarget = ({ domain, label }) => `${domain}/${label}`;

export const runLaunchctl = (args, { allowFailure = false } = {}) => {
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

export const launchdSnapshot = ({ serviceTarget, runLaunchctl: run = runLaunchctl }) => {
  const printed = run(['print', serviceTarget], { allowFailure: true });
  const pidMatch = printed.stdout.match(/\bpid = (\d+)/);
  return {
    loaded: printed.status === 0,
    pid: pidMatch ? Number(pidMatch[1]) : null,
    print: printed,
  };
};

export const listenerPids = ({ port }) => {
  const result = spawnSync('/usr/sbin/lsof', [
    '-nP',
    '-t',
    `-iTCP:${port}`,
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

export const checkHttpHealth = async ({ port, timeoutMs = 800 }) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
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

/**
 * Some automation/sandbox environments can inspect launchd but cannot
 * connect to a host LaunchAgent over loopback. Fall back only when the
 * exact launchd PID is also the process listening on the configured port.
 */
export const effectiveHealth = async ({ port, serviceTarget, runLaunchctl: run = runLaunchctl }) => {
  const http = await checkHttpHealth({ port });
  if (http.ok) return http;

  const launchd = launchdSnapshot({ serviceTarget, runLaunchctl: run });
  const listeners = listenerPids({ port });
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

export const waitForHealth = async ({
  port,
  serviceTarget,
  runLaunchctl: run = runLaunchctl,
  attempts = 25,
  intervalMs = 100,
}) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await effectiveHealth({ port, serviceTarget, runLaunchctl: run });
    if (result.ok) return result;
    if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return effectiveHealth({ port, serviceTarget, runLaunchctl: run });
};
