import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const INVEST_JOURNAL_VERSION = 'invest-signal-journal-v1';
export const DEFAULT_INVEST_MONITOR_INTERVAL_MS = 15_000;
const MAX_SIGNALS = 200;

const clone = (value) => structuredClone(value);
const cleanText = (value, max = 4000) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const finiteOrNull = (value) => Number.isFinite(value) ? value : null;
const finiteList = (value, max = 10) => Array.isArray(value) ? value.filter(Number.isFinite).slice(0, max) : [];
const normalizeStoredSignal = (item) => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  if (typeof item.id !== 'string' || typeof item.market_as_of !== 'string' || !['UP', 'DOWN', 'NEUTRAL'].includes(item.direction)) return null;
  return {
    version: INVEST_JOURNAL_VERSION,
    id: item.id,
    symbol: 'XAUUSD',
    timeframe: cleanText(item.timeframe, 10).toUpperCase() || 'H1',
    market_as_of: item.market_as_of,
    created_at: typeof item.created_at === 'string' ? item.created_at : item.market_as_of,
    direction: item.direction,
    confidence: Math.max(0, Math.min(100, Math.round(Number(item.confidence) || 0))),
    entry_zone: finiteList(item.entry_zone, 2),
    stop_loss: finiteOrNull(item.stop_loss),
    targets: finiteList(item.targets, 4),
    risk_level: ['low', 'medium', 'high'].includes(item.risk_level) ? item.risk_level : 'high',
    summary: cleanText(item.summary),
    risks: Array.isArray(item.risks) ? item.risks.map((risk) => cleanText(risk, 500)).filter(Boolean).slice(0, 20) : [],
  };
};

export class InvestSignalJournalFileStore {
  constructor({ storagePath, fsImpl = fs } = {}) {
    if (!storagePath || typeof storagePath !== 'string') throw new Error('invest_journal_storage_path_required');
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

export class InvestSignalJournal {
  constructor({ store = null, now = () => new Date().toISOString() } = {}) {
    if (store && (typeof store.load !== 'function' || typeof store.save !== 'function')) throw new Error('invest_journal_store_invalid');
    this.store = store;
    this.now = now;
    this.signals = [];
  }

  load() {
    let document = null;
    try { document = this.store?.load() ?? null; } catch { document = null; }
    const candidates = document?.version === INVEST_JOURNAL_VERSION && Array.isArray(document.signals) ? document.signals : [];
    this.signals = candidates.map(normalizeStoredSignal).filter(Boolean).slice(-MAX_SIGNALS);
    return this.list();
  }

  has(id) { return this.signals.some((item) => item.id === id); }

  append(result) {
    const analysis = result?.analysis;
    if (!analysis || analysis.symbol !== 'XAUUSD' || !['UP', 'DOWN', 'NEUTRAL'].includes(analysis.direction)) throw new Error('invest_signal_invalid');
    if (!analysis.as_of || typeof analysis.as_of !== 'string') throw new Error('invest_signal_as_of_required');
    const timeframe = String(analysis.timeframe || 'H1').toUpperCase();
    const id = `XAUUSD:${timeframe}:${analysis.as_of}`;
    const existing = this.signals.find((item) => item.id === id);
    if (existing) return { signal: clone(existing), created: false };
    const signal = {
      version: INVEST_JOURNAL_VERSION,
      id,
      symbol: 'XAUUSD',
      timeframe,
      market_as_of: analysis.as_of,
      created_at: this.now(),
      direction: analysis.direction,
      confidence: Math.max(0, Math.min(100, Math.round(Number(analysis.confidence) || 0))),
      entry_zone: finiteList(analysis.entry_zone, 2),
      stop_loss: finiteOrNull(analysis.invalidation),
      targets: finiteList(analysis.targets, 4),
      risk_level: ['low', 'medium', 'high'].includes(analysis.risk_level) ? analysis.risk_level : 'high',
      summary: cleanText(result?.narrative?.summary),
      risks: Array.isArray(result?.narrative?.risks) ? result.narrative.risks.map((item) => cleanText(item, 500)).filter(Boolean).slice(0, 20) : [],
    };
    this.signals = [...this.signals, signal].slice(-MAX_SIGNALS);
    this.store?.save({ version: INVEST_JOURNAL_VERSION, signals: this.signals });
    return { signal: clone(signal), created: true };
  }

  list({ limit = 50 } = {}) {
    const bounded = Math.max(1, Math.min(Number(limit) || 50, MAX_SIGNALS));
    return clone(this.signals.slice(-bounded).reverse());
  }
}

const monitorSnapshot = (monitor) => ({
  state: monitor.state,
  interval_ms: monitor.intervalMs,
  timeframe: monitor.timeframe,
  last_checked_at: monitor.lastCheckedAt,
  last_signal_at: monitor.lastSignalAt,
  last_bar_as_of: monitor.lastBarAsOf,
  last_error: monitor.lastError,
});

export class InvestMonitor {
  constructor({
    getMode,
    getPermission,
    getBridgeStatus,
    requestPermission,
    runInvestment,
    journal,
    notify = () => {},
    onUpdate = () => {},
    intervalMs = DEFAULT_INVEST_MONITOR_INTERVAL_MS,
    timeframe = 'H1',
    timers = globalThis,
    now = () => new Date().toISOString(),
  } = {}) {
    if (typeof getMode !== 'function' || typeof getPermission !== 'function' || typeof getBridgeStatus !== 'function' || typeof requestPermission !== 'function' || typeof runInvestment !== 'function') throw new Error('invest_monitor_dependency_required');
    if (!journal || typeof journal.append !== 'function' || typeof journal.list !== 'function') throw new Error('invest_monitor_journal_required');
    this.getMode = getMode;
    this.getPermission = getPermission;
    this.getBridgeStatus = getBridgeStatus;
    this.requestPermission = requestPermission;
    this.runInvestment = runInvestment;
    this.journal = journal;
    this.notify = notify;
    this.onUpdate = onUpdate;
    this.intervalMs = Math.max(5_000, Number(intervalMs) || DEFAULT_INVEST_MONITOR_INTERVAL_MS);
    this.timeframe = String(timeframe).toUpperCase();
    this.timers = timers;
    this.now = now;
    this.timer = null;
    this.inflight = null;
    this.deniedBarKey = null;
    this.state = 'idle';
    this.lastCheckedAt = null;
    this.lastSignalAt = null;
    this.lastBarAsOf = null;
    this.lastError = null;
  }

  getState() { return monitorSnapshot(this); }
  emit() { this.onUpdate(this.getState(), this.journal.list()); }

  start() {
    if (this.timer) return this.getState();
    this.timer = this.timers.setInterval(() => void this.tick(), this.intervalMs);
    this.timer?.unref?.();
    void this.tick();
    return this.getState();
  }

  stop() {
    if (this.timer) this.timers.clearInterval(this.timer);
    this.timer = null;
    this.inflight?.abort();
    this.inflight = null;
    this.state = 'idle';
    this.emit();
  }

  syncMode() {
    if (!this.getMode()?.automatic_analysis_enabled) {
      this.inflight?.abort();
      this.state = 'idle';
      this.lastError = null;
      this.emit();
      return;
    }
    void this.tick();
  }

  async tick() {
    if (this.inflight) return this.getState();
    const mode = this.getMode();
    if (!mode?.automatic_analysis_enabled) {
      this.state = 'idle';
      this.lastError = null;
      this.emit();
      return this.getState();
    }
    this.lastCheckedAt = this.now();
    const snapshot = this.getBridgeStatus()?.snapshots?.find((item) => item.timeframe === this.timeframe);
    if (!snapshot?.as_of) {
      this.state = 'waiting_for_price';
      this.lastError = null;
      this.emit();
      return this.getState();
    }
    const barKey = `XAUUSD:${this.timeframe}:${snapshot.as_of}`;
    this.lastBarAsOf = snapshot.as_of;
    if (this.journal.has(barKey)) {
      this.state = 'monitoring';
      this.lastError = null;
      this.emit();
      return this.getState();
    }
    const permission = this.getPermission();
    if (permission === 'Blocked') {
      this.state = 'permission_blocked';
      this.lastError = 'market_research_blocked';
      this.emit();
      return this.getState();
    }
    if (permission === 'Ask') {
      if (this.deniedBarKey === barKey) {
        this.state = 'permission_denied';
        this.lastError = 'market_research_denied_for_bar';
        this.emit();
        return this.getState();
      }
      this.state = 'waiting_for_permission';
      this.lastError = null;
      this.emit();
      const allowed = await this.requestPermission({ timeframe: this.timeframe, asOf: snapshot.as_of });
      if (!this.getMode()?.automatic_analysis_enabled) {
        this.state = 'idle';
        this.lastError = null;
        this.emit();
        return this.getState();
      }
      if (!allowed) {
        this.deniedBarKey = barKey;
        this.state = 'permission_denied';
        this.lastError = 'market_research_denied_for_bar';
        this.emit();
        return this.getState();
      }
    }
    this.deniedBarKey = null;
    const controller = new AbortController();
    this.inflight = controller;
    this.state = 'analyzing';
    this.lastError = null;
    this.emit();
    try {
      const result = await this.runInvestment({ timeframe: this.timeframe, signal: controller.signal });
      if (!this.getMode()?.automatic_analysis_enabled || controller.signal.aborted) return this.getState();
      const appended = this.journal.append(result);
      this.state = 'monitoring';
      this.lastSignalAt = appended.signal.created_at;
      if (appended.created) this.notify(appended.signal);
      this.emit();
      return this.getState();
    } catch (error) {
      if (controller.signal.aborted) return this.getState();
      this.state = 'error';
      this.lastError = cleanText(error?.message || error, 300) || 'invest_monitor_failed';
      this.emit();
      return this.getState();
    } finally {
      if (this.inflight === controller) this.inflight = null;
    }
  }
}
