import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const INVEST_MODE_DOCUMENT_VERSION = 'invest-mode-v1';
export const INVEST_MODES = Object.freeze({
  OFF: 'OFF',
  MONITOR: 'MONITOR',
  DEMO_AUTO: 'DEMO_AUTO',
});

const VALID_MODES = new Set(Object.values(INVEST_MODES));
const SAFE_STARTUP_MODES = new Set([INVEST_MODES.OFF, INVEST_MODES.MONITOR]);

const stateSnapshot = ({ mode, startupMode, restoreReason }) => Object.freeze({
  version: INVEST_MODE_DOCUMENT_VERSION,
  mode,
  startup_mode: startupMode,
  automatic_analysis_enabled: mode !== INVEST_MODES.OFF,
  demo_auto_enabled: mode === INVEST_MODES.DEMO_AUTO,
  trade_execution_enabled: false,
  restore_reason: restoreReason,
});

export class InvestModeFileStore {
  constructor({ storagePath, fsImpl = fs } = {}) {
    if (!storagePath || typeof storagePath !== 'string') throw new Error('invest_mode_storage_path_required');
    this.storagePath = storagePath;
    this.fs = fsImpl;
  }

  load() {
    try {
      return JSON.parse(this.fs.readFileSync(this.storagePath, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  save(document) {
    const directory = path.dirname(this.storagePath);
    const temporaryPath = `${this.storagePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    this.fs.mkdirSync(directory, { recursive: true });
    try {
      this.fs.writeFileSync(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      this.fs.renameSync(temporaryPath, this.storagePath);
    } catch (error) {
      try { this.fs.unlinkSync(temporaryPath); } catch {}
      throw error;
    }
  }
}

export class InvestModeController {
  constructor({ store = null } = {}) {
    if (store && (typeof store.load !== 'function' || typeof store.save !== 'function')) {
      throw new Error('invest_mode_store_invalid');
    }
    this.store = store;
    this.mode = INVEST_MODES.OFF;
    this.startupMode = INVEST_MODES.OFF;
    this.restoreReason = 'default_off';
  }

  restore() {
    let document = null;
    try {
      document = this.store?.load() ?? null;
    } catch {
      this.mode = INVEST_MODES.OFF;
      this.startupMode = INVEST_MODES.OFF;
      this.restoreReason = 'storage_error_off';
      return this.getState();
    }

    const persistedMode = document?.version === INVEST_MODE_DOCUMENT_VERSION
      ? document.startup_mode
      : null;
    const startupMode = SAFE_STARTUP_MODES.has(persistedMode)
      ? persistedMode
      : INVEST_MODES.OFF;

    this.mode = startupMode;
    this.startupMode = startupMode;
    this.restoreReason = document == null
      ? 'default_off'
      : persistedMode === startupMode
        ? 'restored_safe_mode'
        : 'unsafe_or_invalid_persisted_mode_off';
    return this.getState();
  }

  setMode(nextMode) {
    if (!VALID_MODES.has(nextMode)) throw new Error('invest_mode_invalid');

    if (SAFE_STARTUP_MODES.has(nextMode)) {
      this.mode = nextMode;
      this.startupMode = nextMode;
      this.restoreReason = 'runtime_transition';
      this.store?.save({
        version: INVEST_MODE_DOCUMENT_VERSION,
        startup_mode: nextMode,
      });
      return this.getState();
    }

    this.mode = nextMode;
    this.restoreReason = 'runtime_transition';
    return this.getState();
  }

  killSwitch() {
    return this.setMode(INVEST_MODES.OFF);
  }

  getState() {
    return stateSnapshot({
      mode: this.mode,
      startupMode: this.startupMode,
      restoreReason: this.restoreReason,
    });
  }
}
