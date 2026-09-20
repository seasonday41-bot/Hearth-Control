import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  INVEST_MODE_DOCUMENT_VERSION,
  INVEST_MODES,
  InvestModeController,
  InvestModeFileStore,
} from '../mcp/market/invest-mode-controller.mjs';

class MemoryStore {
  constructor(document = null) {
    this.document = document;
    this.saved = [];
  }

  load() {
    return this.document;
  }

  save(document) {
    this.document = structuredClone(document);
    this.saved.push(structuredClone(document));
  }
}

test('Invest Mode V1.1 fresh startup is OFF with no execution capability', () => {
  const controller = new InvestModeController({ store: new MemoryStore() });
  assert.deepEqual(controller.restore(), {
    version: INVEST_MODE_DOCUMENT_VERSION,
    mode: INVEST_MODES.OFF,
    startup_mode: INVEST_MODES.OFF,
    automatic_analysis_enabled: false,
    demo_auto_enabled: false,
    trade_execution_enabled: false,
    restore_reason: 'default_off',
  });
});

test('Invest Mode V1.2 MONITOR persists and restores across restart', () => {
  const store = new MemoryStore();
  const first = new InvestModeController({ store });
  first.restore();
  const active = first.setMode(INVEST_MODES.MONITOR);
  assert.equal(active.automatic_analysis_enabled, true);
  assert.equal(active.trade_execution_enabled, false);

  const restarted = new InvestModeController({ store });
  assert.equal(restarted.restore().mode, INVEST_MODES.MONITOR);
});

test('Invest Mode V1.3 DEMO_AUTO is runtime-only and restores the previous safe mode', () => {
  const store = new MemoryStore();
  const first = new InvestModeController({ store });
  first.restore();
  first.setMode(INVEST_MODES.MONITOR);
  const demo = first.setMode(INVEST_MODES.DEMO_AUTO);

  assert.equal(demo.mode, INVEST_MODES.DEMO_AUTO);
  assert.equal(demo.startup_mode, INVEST_MODES.MONITOR);
  assert.equal(demo.demo_auto_enabled, true);
  assert.equal(demo.trade_execution_enabled, false);
  assert.equal(store.saved.length, 1, 'DEMO_AUTO must never be persisted');

  const restarted = new InvestModeController({ store });
  assert.equal(restarted.restore().mode, INVEST_MODES.MONITOR);
});

test('Invest Mode V1.4 DEMO_AUTO from a fresh OFF state restores OFF', () => {
  const store = new MemoryStore();
  const first = new InvestModeController({ store });
  first.restore();
  first.setMode(INVEST_MODES.DEMO_AUTO);
  assert.equal(store.saved.length, 0);

  const restarted = new InvestModeController({ store });
  assert.equal(restarted.restore().mode, INVEST_MODES.OFF);
});

test('Invest Mode V1.5 unsafe or invalid persisted mode fails closed to OFF', () => {
  for (const startupMode of [INVEST_MODES.DEMO_AUTO, 'LIVE_AUTO', null]) {
    const controller = new InvestModeController({
      store: new MemoryStore({ version: INVEST_MODE_DOCUMENT_VERSION, startup_mode: startupMode }),
    });
    const state = controller.restore();
    assert.equal(state.mode, INVEST_MODES.OFF);
    assert.equal(state.restore_reason, 'unsafe_or_invalid_persisted_mode_off');
  }
});

test('Invest Mode V1.6 kill switch immediately sets and persists OFF', () => {
  const store = new MemoryStore();
  const controller = new InvestModeController({ store });
  controller.restore();
  controller.setMode(INVEST_MODES.MONITOR);
  controller.setMode(INVEST_MODES.DEMO_AUTO);
  const stopped = controller.killSwitch();

  assert.equal(stopped.mode, INVEST_MODES.OFF);
  assert.equal(stopped.startup_mode, INVEST_MODES.OFF);
  assert.deepEqual(store.document, {
    version: INVEST_MODE_DOCUMENT_VERSION,
    startup_mode: INVEST_MODES.OFF,
  });
});

test('Invest Mode V1.7 invalid transitions leave current mode unchanged', () => {
  const controller = new InvestModeController({ store: new MemoryStore() });
  controller.restore();
  assert.throws(() => controller.setMode('AUTO'), /invest_mode_invalid/);
  assert.equal(controller.getState().mode, INVEST_MODES.OFF);
});

test('Invest Mode V1.8 file store atomically round-trips only the safe startup document', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-invest-mode-'));
  try {
    const storagePath = path.join(root, 'invest-mode.json');
    const store = new InvestModeFileStore({ storagePath });
    const controller = new InvestModeController({ store });
    controller.restore();
    controller.setMode(INVEST_MODES.MONITOR);
    controller.setMode(INVEST_MODES.DEMO_AUTO);

    assert.deepEqual(JSON.parse(fs.readFileSync(storagePath, 'utf8')), {
      version: INVEST_MODE_DOCUMENT_VERSION,
      startup_mode: INVEST_MODES.MONITOR,
    });
    assert.equal(fs.readdirSync(root).some((name) => name.endsWith('.tmp')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Invest Mode V1.9 OFF takes effect in memory even if persistence fails', () => {
  const store = new MemoryStore();
  const controller = new InvestModeController({ store });
  controller.restore();
  controller.setMode(INVEST_MODES.DEMO_AUTO);
  store.save = () => { throw new Error('disk_unavailable'); };

  assert.throws(() => controller.killSwitch(), /disk_unavailable/);
  assert.equal(controller.getState().mode, INVEST_MODES.OFF);
  assert.equal(controller.getState().demo_auto_enabled, false);
  assert.equal(controller.getState().trade_execution_enabled, false);
});
