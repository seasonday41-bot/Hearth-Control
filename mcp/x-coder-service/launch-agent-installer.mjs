import fs from 'node:fs';

const BENIGN_BOOTOUT_PATTERN = /could not find|no such process|not loaded|service not found|no such file/i;

const isBenignBootoutFailure = (result) => {
  if (!result || result.status === 0) return true;
  const text = `${result.stdout || ''} ${result.stderr || ''}`;
  return BENIGN_BOOTOUT_PATTERN.test(text);
};

const writePlistFile = (plistPath, content) => {
  const tempPath = `${plistPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, content, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tempPath, plistPath);
  fs.chmodSync(plistPath, 0o600);
};

const removePlistFile = (plistPath) => fs.rmSync(plistPath, { force: true });

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Transactional install: the previous plist (if any) is captured before the
 * candidate is written, so a bootstrap or health failure can restore the
 * prior working service instead of leaving the host with a broken or
 * half-installed LaunchAgent.
 */
export async function installXCoderLaunchAgent({
  plistPath,
  plistContent,
  domain,
  serviceTarget,
  runLaunchctl,
  waitForHealth,
  bootstrapAttempts = 5,
  bootstrapRetryDelayMs = 120,
  sleep = defaultSleep,
}) {
  if (typeof runLaunchctl !== 'function') throw new TypeError('runLaunchctl is required.');
  if (typeof waitForHealth !== 'function') throw new TypeError('waitForHealth is required.');

  const hadPrevious = fs.existsSync(plistPath);
  const previousContent = hadPrevious ? fs.readFileSync(plistPath, 'utf8') : null;

  const restorePrevious = () => {
    if (!hadPrevious) {
      removePlistFile(plistPath);
      return { attempted: false, restored: false, bootstrap: null };
    }
    writePlistFile(plistPath, previousContent);
    let bootstrapResult = null;
    for (let attempt = 0; attempt < bootstrapAttempts; attempt += 1) {
      bootstrapResult = runLaunchctl(['bootstrap', domain, plistPath], { allowFailure: true });
      if (bootstrapResult.status === 0) break;
    }
    return { attempted: true, restored: bootstrapResult?.status === 0, bootstrap: bootstrapResult };
  };

  // Stop whatever is currently loaded under this label before installing the
  // candidate. An unexpected failure here (permissions, a launchd fault --
  // anything other than "was already not loaded") means we do not actually
  // know the current service's state, so we must not touch the plist or
  // attempt a bootstrap: the existing service/plist is left exactly as-is.
  const preInstallBootout = runLaunchctl(['bootout', serviceTarget], { allowFailure: true });
  if (!isBenignBootoutFailure(preInstallBootout)) {
    return {
      ok: false,
      stage: 'pre_install_bootout',
      hadPrevious,
      rollback: { attempted: false, restored: false, bootstrap: null },
      bootstrap: null,
      health: null,
      preInstallBootout,
    };
  }

  writePlistFile(plistPath, plistContent);

  let bootstrapped = false;
  let bootstrapResult = null;
  for (let attempt = 0; attempt < bootstrapAttempts; attempt += 1) {
    if (attempt > 0) await sleep(bootstrapRetryDelayMs);
    bootstrapResult = runLaunchctl(['bootstrap', domain, plistPath], { allowFailure: true });
    if (bootstrapResult.status === 0) { bootstrapped = true; break; }
  }

  if (!bootstrapped) {
    runLaunchctl(['bootout', serviceTarget], { allowFailure: true });
    return {
      ok: false,
      stage: 'bootstrap',
      hadPrevious,
      rollback: restorePrevious(),
      bootstrap: bootstrapResult,
      health: null,
    };
  }

  const health = await waitForHealth();
  if (!health?.ok) {
    runLaunchctl(['bootout', serviceTarget], { allowFailure: true });
    return {
      ok: false,
      stage: 'health',
      hadPrevious,
      rollback: restorePrevious(),
      bootstrap: bootstrapResult,
      health,
    };
  }

  return { ok: true, stage: 'complete', hadPrevious, rollback: null, bootstrap: bootstrapResult, health };
}

/**
 * Uninstall never reports success just because it removed a plist file: a
 * bootout failure that is not "already not loaded" leaves the previous
 * service state ambiguous and must be surfaced as a failure.
 */
export function uninstallXCoderLaunchAgent({ plistPath, serviceTarget, runLaunchctl }) {
  if (typeof runLaunchctl !== 'function') throw new TypeError('runLaunchctl is required.');

  const hadPlist = fs.existsSync(plistPath);
  const stopped = runLaunchctl(['bootout', serviceTarget], { allowFailure: true });

  if (!isBenignBootoutFailure(stopped)) {
    return { ok: false, hadPlist, launchctl: stopped, reason: 'bootout_failed' };
  }

  removePlistFile(plistPath);
  return { ok: true, hadPlist, launchctl: stopped, reason: null };
}

export const __testing = { isBenignBootoutFailure };
