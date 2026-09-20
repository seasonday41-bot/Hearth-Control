import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEMO_RISK_CONFIG_VERSION = 'demo-risk-config-v1';

const finite = (value) => Number.isFinite(value);
const clone = (value) => structuredClone(value);

const positive = (value, code, { allowZero = false } = {}) => {
  const number = Number(value);
  if (!finite(number) || (allowZero ? number < 0 : number <= 0)) throw new Error(code);
  return number;
};

const fraction = (value, code) => {
  const number = positive(value, code);
  if (number > 1) throw new Error(code);
  return number;
};

const integer = (value, code) => {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(code);
  return number;
};

export const parseDemoRiskConfig = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('demo_risk_config_required');
  if (value.version !== DEMO_RISK_CONFIG_VERSION) throw new Error('demo_risk_config_version_invalid');

  const config = {
    version: DEMO_RISK_CONFIG_VERSION,
    risk_fraction_per_trade: fraction(value.risk_fraction_per_trade, 'demo_risk_per_trade_invalid'),
    max_daily_loss_fraction: fraction(value.max_daily_loss_fraction, 'demo_risk_daily_loss_invalid'),
    max_drawdown_fraction: fraction(value.max_drawdown_fraction, 'demo_risk_drawdown_invalid'),
    max_total_open_risk_fraction: fraction(value.max_total_open_risk_fraction, 'demo_risk_open_risk_invalid'),
    max_positions: integer(value.max_positions, 'demo_risk_max_positions_invalid'),
    max_spread_points: positive(value.max_spread_points, 'demo_risk_spread_invalid'),
    max_slippage_points: positive(value.max_slippage_points, 'demo_risk_slippage_invalid', { allowZero: true }),
    min_stop_points: positive(value.min_stop_points, 'demo_risk_min_stop_invalid'),
    max_stop_points: positive(value.max_stop_points, 'demo_risk_max_stop_invalid'),
    requested_volume: value.requested_volume == null || value.requested_volume === ''
      ? null
      : positive(value.requested_volume, 'demo_risk_requested_volume_invalid'),
  };

  if (config.max_daily_loss_fraction > config.max_drawdown_fraction) {
    throw new Error('demo_risk_daily_loss_exceeds_drawdown');
  }
  if (config.risk_fraction_per_trade > config.max_total_open_risk_fraction) {
    throw new Error('demo_risk_trade_exceeds_open_risk');
  }
  if (config.max_stop_points < config.min_stop_points) {
    throw new Error('demo_risk_stop_bounds_invalid');
  }

  return Object.freeze(config);
};

export class DemoRiskConfigFileStore {
  constructor({ storagePath, fsImpl = fs } = {}) {
    if (!storagePath || typeof storagePath !== 'string') throw new Error('demo_risk_storage_path_required');
    this.storagePath = storagePath;
    this.fs = fsImpl;
  }

  load() {
    try { return JSON.parse(this.fs.readFileSync(this.storagePath, 'utf8')); }
    catch (error) {
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

export class DemoRiskConfigController {
  constructor({ store = null } = {}) {
    if (store && (typeof store.load !== 'function' || typeof store.save !== 'function')) {
      throw new Error('demo_risk_store_invalid');
    }
    this.store = store;
    this.config = null;
    this.error = null;
  }

  restore() {
    try {
      const document = this.store?.load() ?? null;
      this.config = document == null ? null : parseDemoRiskConfig(document);
      this.error = null;
    } catch (error) {
      this.config = null;
      this.error = String(error?.message || error);
    }
    return this.getState();
  }

  save(input) {
    const parsed = parseDemoRiskConfig({
      version: DEMO_RISK_CONFIG_VERSION,
      ...input,
    });
    this.store?.save(parsed);
    this.config = parsed;
    this.error = null;
    return this.getState();
  }

  getConfig() {
    return this.config ? clone(this.config) : null;
  }

  getState() {
    return {
      version: DEMO_RISK_CONFIG_VERSION,
      configured: Boolean(this.config),
      config: this.config ? clone(this.config) : null,
      error: this.error,
    };
  }
}
