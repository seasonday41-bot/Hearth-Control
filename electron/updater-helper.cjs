// Detached watchdog started only after a user-approved local install. It is kept
// independent from the renderer so a failed Electron launch can still roll back.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { rollbackPendingUpdate } = require('./updater.cjs');

const [token, target, backup, userDataPath, timeoutText] = process.argv.slice(2);
const timeoutMs = Math.max(5000, Math.min(Number(timeoutText) || 15000, 60000));
const markerPath = path.join(userDataPath || '', `update-startup-success-${token}.json`);
const pendingPath = path.join(userDataPath || '', 'update-pending.json');

const cleanHealthyUpdate = async () => {
  await fs.promises.rm(backup, { recursive: true, force: true }).catch(() => {});
  await fs.promises.rm(markerPath, { force: true }).catch(() => {});
  await fs.promises.rm(pendingPath, { force: true }).catch(() => {});
};

setTimeout(async () => {
  try {
    if (await fs.promises.stat(markerPath).catch(() => null)) {
      await cleanHealthyUpdate();
      process.exit(0);
      return;
    }
    const result = await rollbackPendingUpdate({ userDataPath, token, target, backup });
    if (result.rolledBack) execFile('/usr/bin/open', ['-n', target], { windowsHide: true }, () => {});
  } catch {
    // The UI is unavailable at this point. Keep the backup intact for manual recovery.
  }
  process.exit(0);
}, timeoutMs);
