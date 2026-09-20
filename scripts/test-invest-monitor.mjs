import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  INVEST_JOURNAL_VERSION,
  InvestMonitor,
  InvestSignalJournal,
  InvestSignalJournalFileStore,
} from '../mcp/market/invest-monitor.mjs';

class MemoryStore {
  constructor(document = null) { this.document = document; this.saved = []; }
  load() { return this.document; }
  save(document) { this.document = structuredClone(document); this.saved.push(structuredClone(document)); }
}

const result = (asOf = '2026-09-20T15:00:00.000Z') => ({
  analysis: {
    symbol: 'XAUUSD', timeframe: 'H1', as_of: asOf, direction: 'UP', confidence: 74,
    entry_zone: [3685, 3690], invalidation: 3672, targets: [3715, 3730], risk_level: 'medium',
  },
  narrative: { summary: 'H1 structure is rising.', risks: ['Fed news can change the setup.'] },
});

const makeMonitor = ({ permission = 'Allow', automatic = true, run = async () => result(), request = async () => true } = {}) => {
  const journal = new InvestSignalJournal({ store: new MemoryStore(), now: () => '2026-09-20T15:00:01.000Z' });
  journal.load();
  const notifications = [];
  const updates = [];
  const monitor = new InvestMonitor({
    getMode: () => ({ automatic_analysis_enabled: automatic }),
    getPermission: () => permission,
    getBridgeStatus: () => ({ snapshots: [{ timeframe: 'H1', as_of: '2026-09-20T15:00:00.000Z' }] }),
    requestPermission: request,
    runInvestment: run,
    journal,
    notify: (signal) => notifications.push(signal),
    onUpdate: (state, signals) => updates.push({ state, signals }),
  });
  return { monitor, journal, notifications, updates };
};

test('Invest Monitor V1.1 persists a bounded deterministic signal shape', () => {
  const store = new MemoryStore();
  const journal = new InvestSignalJournal({ store, now: () => '2026-09-20T15:00:01.000Z' });
  journal.load();
  const appended = journal.append(result());
  assert.equal(appended.created, true);
  assert.deepEqual(appended.signal, {
    version: INVEST_JOURNAL_VERSION,
    id: 'XAUUSD:H1:2026-09-20T15:00:00.000Z', symbol: 'XAUUSD', timeframe: 'H1',
    market_as_of: '2026-09-20T15:00:00.000Z', created_at: '2026-09-20T15:00:01.000Z',
    direction: 'UP', confidence: 74, entry_zone: [3685, 3690], stop_loss: 3672,
    targets: [3715, 3730], risk_level: 'medium', summary: 'H1 structure is rising.',
    risks: ['Fed news can change the setup.'],
  });
  assert.equal(store.document.signals.length, 1);
  assert.equal(journal.append(result()).created, false);
  assert.equal(store.saved.length, 1, 'same bar must not be persisted twice');
});

test('Invest Monitor V1.2 analyzes one new H1 bar once, journals before notification, and deduplicates it', async () => {
  const order = [];
  const fixture = makeMonitor({ run: async () => { order.push('analysis'); return result(); } });
  const originalAppend = fixture.journal.append.bind(fixture.journal);
  fixture.journal.append = (value) => { order.push('journal'); return originalAppend(value); };
  fixture.monitor.notify = () => order.push('notification');
  await fixture.monitor.tick();
  await fixture.monitor.tick();
  assert.deepEqual(order, ['analysis', 'journal', 'notification']);
  assert.equal(fixture.journal.list().length, 1);
  assert.equal(fixture.monitor.getState().state, 'monitoring');
});

test('Invest Monitor V1.3 OFF and missing price never call Search or Invest', async () => {
  let calls = 0;
  const off = makeMonitor({ automatic: false, run: async () => { calls += 1; return result(); } });
  await off.monitor.tick();
  assert.equal(off.monitor.getState().state, 'idle');
  const waiting = makeMonitor({ run: async () => { calls += 1; return result(); } });
  waiting.monitor.getBridgeStatus = () => ({ snapshots: [] });
  await waiting.monitor.tick();
  assert.equal(waiting.monitor.getState().state, 'waiting_for_price');
  assert.equal(calls, 0);
});

test('Invest Monitor V1.4 Ask prompts once per bar and denial never loops', async () => {
  let prompts = 0;
  let runs = 0;
  const fixture = makeMonitor({ permission: 'Ask', request: async () => { prompts += 1; return false; }, run: async () => { runs += 1; return result(); } });
  await fixture.monitor.tick();
  await fixture.monitor.tick();
  assert.equal(prompts, 1);
  assert.equal(runs, 0);
  assert.equal(fixture.monitor.getState().state, 'permission_denied');
});

test('Invest Monitor V1.5 Blocked fails before network analysis', async () => {
  let runs = 0;
  const fixture = makeMonitor({ permission: 'Blocked', run: async () => { runs += 1; return result(); } });
  await fixture.monitor.tick();
  assert.equal(runs, 0);
  assert.equal(fixture.monitor.getState().last_error, 'market_research_blocked');
});

test('Invest Monitor V1.6 file journal atomically restores signals across restart', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-invest-journal-'));
  try {
    const storagePath = path.join(root, 'signals.json');
    const first = new InvestSignalJournal({ store: new InvestSignalJournalFileStore({ storagePath }) });
    first.load();
    first.append(result());
    const restarted = new InvestSignalJournal({ store: new InvestSignalJournalFileStore({ storagePath }) });
    assert.equal(restarted.load().length, 1);
    assert.equal(fs.readdirSync(root).some((name) => name.endsWith('.tmp')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Invest Monitor V1.7 malformed stored entries cannot break the journal UI contract', () => {
  const store = new MemoryStore({
    version: INVEST_JOURNAL_VERSION,
    signals: [
      { id: 'bad-direction', market_as_of: '2026-09-20T14:00:00.000Z', direction: 'BUY' },
      { id: 'XAUUSD:H1:2026-09-20T15:00:00.000Z', market_as_of: '2026-09-20T15:00:00.000Z', direction: 'UP', entry_zone: 'oops', targets: null, risks: [42, ' valid '] },
    ],
  });
  const journal = new InvestSignalJournal({ store });
  const signals = journal.load();
  assert.equal(signals.length, 1);
  assert.deepEqual(signals[0].entry_zone, []);
  assert.deepEqual(signals[0].targets, []);
  assert.deepEqual(signals[0].risks, ['valid']);
});
