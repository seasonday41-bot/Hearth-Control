import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEMO_RISK_CONFIG_VERSION,
  DemoRiskConfigController,
  DemoRiskConfigFileStore,
  parseDemoRiskConfig,
} from '../mcp/market/demo-risk-config.mjs';

const valid = (overrides = {}) => ({
  version: DEMO_RISK_CONFIG_VERSION,
  risk_fraction_per_trade: 0.005,
  max_daily_loss_fraction: 0.02,
  max_drawdown_fraction: 0.05,
  max_total_open_risk_fraction: 0.02,
  max_positions: 3,
  max_spread_points: 10,
  max_slippage_points: 3,
  min_stop_points: 10,
  max_stop_points: 200,
  requested_volume: null,
  ...overrides,
});

test('Demo Risk Config V2.1 no file means intentionally unconfigured', () => {
  const controller = new DemoRiskConfigController();
  assert.deepEqual(controller.restore(), {
    version: DEMO_RISK_CONFIG_VERSION,
    configured: false,
    config: null,
    error: null,
  });
});

test('Demo Risk Config V2.2 validates an explicit complete policy', () => {
  const config = parseDemoRiskConfig(valid());
  assert.equal(config.risk_fraction_per_trade, 0.005);
  assert.equal(config.max_positions, 3);
  assert.equal(config.requested_volume, null);
});

test('Demo Risk Config V2.3 invalid relationships fail closed', () => {
  assert.throws(
    () => parseDemoRiskConfig(valid({ max_daily_loss_fraction: 0.06 })),
    /daily_loss_exceeds_drawdown/,
  );
  assert.throws(
    () => parseDemoRiskConfig(valid({ risk_fraction_per_trade: 0.03 })),
    /trade_exceeds_open_risk/,
  );
  assert.throws(
    () => parseDemoRiskConfig(valid({ min_stop_points: 300 })),
    /stop_bounds_invalid/,
  );
});

test('Demo Risk Config V2.4 file store atomically persists and restores policy', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-risk-config-'));
  try {
    const storagePath = path.join(root, 'demo-risk-config.json');
    const first = new DemoRiskConfigController({
      store: new DemoRiskConfigFileStore({ storagePath }),
    });
    first.restore();
    const saved = first.save(valid());
    assert.equal(saved.configured, true);

    const second = new DemoRiskConfigController({
      store: new DemoRiskConfigFileStore({ storagePath }),
    });
    const restored = second.restore();
    assert.equal(restored.configured, true);
    assert.deepEqual(restored.config, valid());
    assert.equal(fs.readdirSync(root).some((name) => name.endsWith('.tmp')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Demo Risk Config V2.5 corrupt persisted config restores blocked, never defaults', () => {
  const store = {
    load: () => ({ version: DEMO_RISK_CONFIG_VERSION, risk_fraction_per_trade: 0.005 }),
    save: () => {},
  };
  const controller = new DemoRiskConfigController({ store });
  const state = controller.restore();
  assert.equal(state.configured, false);
  assert.equal(state.config, null);
  assert.match(state.error, /demo_risk_/);
});
