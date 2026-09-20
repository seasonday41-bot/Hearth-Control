import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseTechnicalSignal } from './technical-signal.mjs';

export const DEMO_EXECUTION_VERSION = 'demo-execution-v1';
export const DEMO_EXECUTION_JOURNAL_VERSION = 'demo-execution-journal-v1';
export const DEMO_EXECUTION_STATES = Object.freeze([
  'PREPARED',
  'SENT',
  'FILLED',
  'REJECTED',
  'DUPLICATE',
  'UNCERTAIN',
]);

const FINAL_STATES = new Set(['FILLED', 'REJECTED', 'DUPLICATE']);
const clone = (value) => structuredClone(value);
const finite = (value) => Number.isFinite(value);
const round = (value, digits = 8) => {
  if (!finite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const normalizeIso = (value, code) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(code);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(code);
  return date.toISOString();
};

const normalizeDemoSessionId = (value) => {
  const sessionId = String(value || '');
  if (!/^demo:[0-9a-f-]{36}$/i.test(sessionId)) throw new Error('demo_executor_session_invalid');
  return sessionId;
};

const parseRiskDecision = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('demo_executor_risk_decision_required');
  if (value.version !== 'xau-risk-decision-v1') throw new Error('demo_executor_risk_version_invalid');
  if (typeof value.id !== 'string' || !/^riskdec:v1:[a-f0-9]{24}$/.test(value.id)) throw new Error('demo_executor_risk_id_invalid');
  if (typeof value.proposal_id !== 'string' || !/^techsig:v1:[a-f0-9]{24}$/.test(value.proposal_id)) {
    throw new Error('demo_executor_proposal_id_invalid');
  }
  if (!['SMC_IDM', 'HARMONIC_PRZ'].includes(value.strategy)) throw new Error('demo_executor_strategy_invalid');
  if (value.symbol !== 'XAUUSD') throw new Error('demo_executor_symbol_invalid');
  if (!['APPROVE', 'RESIZE'].includes(value.decision)) throw new Error('demo_executor_risk_not_approved');

  const sessionId = normalizeDemoSessionId(value.demo_session_id);
  const volume = Number(value.approved_volume);
  const riskFraction = Number(value.approved_risk_fraction);
  if (!finite(volume) || volume <= 0) throw new Error('demo_executor_volume_invalid');
  if (!finite(riskFraction) || riskFraction <= 0 || riskFraction > 1) throw new Error('demo_executor_risk_fraction_invalid');
  if (!value.checks || typeof value.checks !== 'object' || Array.isArray(value.checks)) throw new Error('demo_executor_checks_invalid');
  if (Object.values(value.checks).some((status) => status !== 'pass')) throw new Error('demo_executor_risk_checks_not_passed');
  if (!value.sizing || typeof value.sizing !== 'object' || Array.isArray(value.sizing)) throw new Error('demo_executor_sizing_invalid');

  const maxDeviationPoints = Number(value.sizing.max_slippage_points);
  if (!Number.isInteger(maxDeviationPoints) || maxDeviationPoints < 0 || maxDeviationPoints > 100) {
    throw new Error('demo_executor_deviation_invalid');
  }

  return {
    version: value.version,
    id: value.id,
    proposal_id: value.proposal_id,
    strategy: value.strategy,
    symbol: 'XAUUSD',
    decision: value.decision,
    demo_session_id: sessionId,
    approved_risk_fraction: riskFraction,
    approved_volume: volume,
    max_slippage_points: maxDeviationPoints,
    as_of: normalizeIso(value.as_of, 'demo_executor_risk_as_of_invalid'),
  };
};

const normalizeMode = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('demo_executor_mode_required');
  const sessionId = value.demo_session_id == null ? null : normalizeDemoSessionId(value.demo_session_id);
  return {
    mode: String(value.mode || ''),
    demo_auto_enabled: value.demo_auto_enabled === true,
    trade_execution_enabled: value.trade_execution_enabled === true,
    demo_session_id: sessionId,
  };
};

const normalizeBroker = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('demo_executor_broker_required');
  if (String(value.symbol || '').toUpperCase().replace('/', '') !== 'XAUUSD') throw new Error('demo_executor_broker_symbol_invalid');
  const bid = Number(value.bid);
  const ask = Number(value.ask);
  const pointSize = Number(value.point_size);
  if (![bid, ask, pointSize].every(finite) || bid <= 0 || ask <= 0 || pointSize <= 0 || ask < bid) {
    throw new Error('demo_executor_broker_quote_invalid');
  }
  return {
    symbol: 'XAUUSD',
    bid,
    ask,
    point_size: pointSize,
    as_of: normalizeIso(value.as_of, 'demo_executor_broker_as_of_invalid'),
  };
};

const executionRequestId = (riskDecisionId, demoSessionId) => {
  const digest = crypto.createHash('sha256').update(`${riskDecisionId}|${demoSessionId}`).digest('hex').slice(0, 24);
  return `exec:v1:${digest}`;
};

const requestTag = (requestId) => `HRT8_${requestId.slice(-12).toUpperCase()}`;

const validateEntryGeometry = ({ signal, broker, tolerancePoints }) => {
  const price = signal.direction === 'BUY' ? broker.ask : broker.bid;
  const tolerance = broker.point_size * tolerancePoints;
  const [lower, upper] = signal.entry_zone;
  if (price < lower - tolerance || price > upper + tolerance) throw new Error('demo_executor_price_outside_entry_zone');

  const stop = signal.invalidation;
  const takeProfit = signal.targets[0];
  if (signal.direction === 'BUY') {
    if (!(stop < price && takeProfit > price)) throw new Error('demo_executor_trade_geometry_invalid');
  } else if (!(stop > price && takeProfit < price)) {
    throw new Error('demo_executor_trade_geometry_invalid');
  }
  return { price, stop, takeProfit };
};

export const prepareDemoExecutionRequest = ({
  technicalSignal,
  riskDecision,
  modeState,
  brokerState,
  now = new Date().toISOString(),
  maxDecisionAgeMs = 15_000,
  maxBrokerAgeMs = 15_000,
  entryTolerancePoints = 0,
  requestTtlMs = 5_000,
} = {}) => {
  const signal = parseTechnicalSignal(technicalSignal);
  if (signal.state !== 'READY') throw new Error('demo_executor_ready_signal_required');

  const decision = parseRiskDecision(riskDecision);
  const mode = normalizeMode(modeState);
  const broker = normalizeBroker(brokerState);
  const asOf = normalizeIso(now, 'demo_executor_now_invalid');

  if (
    mode.mode !== 'DEMO_AUTO' ||
    !mode.demo_auto_enabled ||
    !mode.trade_execution_enabled ||
    !mode.demo_session_id
  ) {
    throw new Error('demo_executor_not_enabled');
  }
  if (mode.demo_session_id !== decision.demo_session_id) throw new Error('demo_executor_session_mismatch');
  if (decision.proposal_id !== signal.id || decision.strategy !== signal.strategy) throw new Error('demo_executor_risk_binding_mismatch');
  if (Date.parse(asOf) >= Date.parse(signal.expires_at)) throw new Error('demo_executor_signal_stale');

  const decisionAge = Date.parse(asOf) - Date.parse(decision.as_of);
  const brokerAge = Date.parse(asOf) - Date.parse(broker.as_of);
  if (decisionAge < 0 || decisionAge > maxDecisionAgeMs) throw new Error('demo_executor_risk_decision_stale');
  if (brokerAge < 0 || brokerAge > maxBrokerAgeMs) throw new Error('demo_executor_broker_state_stale');

  const tolerancePoints = Number(entryTolerancePoints);
  const ttlMs = Number(requestTtlMs);
  if (!Number.isInteger(tolerancePoints) || tolerancePoints < 0 || tolerancePoints > 100) {
    throw new Error('demo_executor_entry_tolerance_invalid');
  }
  if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 30_000) throw new Error('demo_executor_request_ttl_invalid');

  const { price, stop, takeProfit } = validateEntryGeometry({ signal, broker, tolerancePoints });
  const requestId = executionRequestId(decision.id, decision.demo_session_id);
  const expiresAt = new Date(Math.min(Date.parse(signal.expires_at), Date.parse(asOf) + ttlMs)).toISOString();

  return Object.freeze({
    version: DEMO_EXECUTION_VERSION,
    type: 'demo_order',
    request_id: requestId,
    request_tag: requestTag(requestId),
    risk_decision_id: decision.id,
    proposal_id: signal.id,
    demo_session_id: decision.demo_session_id,
    strategy: signal.strategy,
    canonical_symbol: 'XAUUSD',
    side: signal.direction,
    volume: round(decision.approved_volume),
    reference_price: round(price),
    stop_loss: round(stop),
    take_profit: round(takeProfit),
    max_deviation_points: decision.max_slippage_points,
    created_at: asOf,
    expires_at: expiresAt,
    expires_epoch: Math.floor(Date.parse(expiresAt) / 1000),
  });
};

export const parseDemoExecutionReceipt = (value, request) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('demo_executor_receipt_invalid');
  if (value.type !== 'execution_receipt' || Number(value.version) !== 1) throw new Error('demo_executor_receipt_version_invalid');
  if (value.request_id !== request.request_id) throw new Error('demo_executor_receipt_request_mismatch');
  if (String(value.account_type || '').toLowerCase() !== 'demo') throw new Error('demo_executor_receipt_not_demo');
  if (!['FILLED', 'REJECTED', 'DUPLICATE'].includes(value.status)) throw new Error('demo_executor_receipt_status_invalid');

  const receipt = {
    type: 'execution_receipt',
    version: 1,
    request_id: value.request_id,
    status: value.status,
    account_type: 'demo',
    retcode: value.retcode == null ? null : Number(value.retcode),
    reason: String(value.reason || '').slice(0, 200),
    order_ticket: value.order_ticket == null ? null : String(value.order_ticket).slice(0, 40),
    deal_ticket: value.deal_ticket == null ? null : String(value.deal_ticket).slice(0, 40),
    position_ticket: value.position_ticket == null ? null : String(value.position_ticket).slice(0, 40),
    fill_price: value.fill_price == null ? null : Number(value.fill_price),
    volume: value.volume == null ? null : Number(value.volume),
    stop_loss: value.stop_loss == null ? null : Number(value.stop_loss),
    take_profit: value.take_profit == null ? null : Number(value.take_profit),
    as_of: normalizeIso(value.as_of, 'demo_executor_receipt_as_of_invalid'),
  };

  if (receipt.retcode != null && !Number.isInteger(receipt.retcode)) throw new Error('demo_executor_receipt_retcode_invalid');
  if (['FILLED', 'DUPLICATE'].includes(receipt.status)) {
    if (!finite(receipt.fill_price) || receipt.fill_price <= 0) throw new Error('demo_executor_receipt_fill_invalid');
    if (!finite(receipt.volume) || receipt.volume <= 0 || receipt.volume > request.volume + 1e-8) {
      throw new Error('demo_executor_receipt_volume_invalid');
    }
  }
  return Object.freeze(receipt);
};

const normalizeJournalRecord = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.version !== DEMO_EXECUTION_JOURNAL_VERSION) return null;
  if (typeof value.request_id !== 'string' || !/^exec:v1:[a-f0-9]{24}$/.test(value.request_id)) return null;
  if (!DEMO_EXECUTION_STATES.includes(value.state)) return null;
  if (!value.request || typeof value.request !== 'object') return null;
  return clone(value);
};

export class DemoExecutionJournalFileStore {
  constructor({ storagePath, fsImpl = fs } = {}) {
    if (!storagePath || typeof storagePath !== 'string') throw new Error('demo_executor_journal_path_required');
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

export class DemoExecutionJournal {
  constructor({ store = null, now = () => new Date().toISOString(), maxRecords = 500 } = {}) {
    if (store && (typeof store.load !== 'function' || typeof store.save !== 'function')) {
      throw new Error('demo_executor_journal_store_invalid');
    }
    this.store = store;
    this.now = now;
    this.maxRecords = Math.max(10, Math.min(Number(maxRecords) || 500, 2000));
    this.records = [];
  }

  load() {
    let document = null;
    try { document = this.store?.load() ?? null; } catch { document = null; }
    const candidates = document?.version === DEMO_EXECUTION_JOURNAL_VERSION && Array.isArray(document.records)
      ? document.records
      : [];
    this.records = candidates.map(normalizeJournalRecord).filter(Boolean).slice(-this.maxRecords);
    return this.list();
  }

  save() {
    this.store?.save({
      version: DEMO_EXECUTION_JOURNAL_VERSION,
      records: this.records,
    });
  }

  get(requestId) {
    const record = this.records.find((item) => item.request_id === requestId);
    return record ? clone(record) : null;
  }

  prepare(request) {
    const existing = this.records.find((item) => item.request_id === request.request_id);
    if (existing) return { record: clone(existing), created: false };
    const at = this.now();
    const record = {
      version: DEMO_EXECUTION_JOURNAL_VERSION,
      request_id: request.request_id,
      proposal_id: request.proposal_id,
      risk_decision_id: request.risk_decision_id,
      demo_session_id: request.demo_session_id,
      strategy: request.strategy,
      side: request.side,
      state: 'PREPARED',
      attempts: 0,
      created_at: at,
      updated_at: at,
      request: clone(request),
      receipt: null,
      error: null,
    };
    this.records = [...this.records, record].slice(-this.maxRecords);
    this.save();
    return { record: clone(record), created: true };
  }

  transition(requestId, state, { receipt = null, error = null } = {}) {
    if (!DEMO_EXECUTION_STATES.includes(state)) throw new Error('demo_executor_journal_state_invalid');
    const index = this.records.findIndex((item) => item.request_id === requestId);
    if (index < 0) throw new Error('demo_executor_journal_record_missing');
    const existing = this.records[index];
    if (FINAL_STATES.has(existing.state) && existing.state !== state) throw new Error('demo_executor_journal_terminal');

    const next = {
      ...existing,
      state,
      attempts: state === 'SENT' ? existing.attempts + 1 : existing.attempts,
      updated_at: this.now(),
      receipt: receipt ? clone(receipt) : existing.receipt,
      error: error == null ? null : String(error).slice(0, 500),
    };
    this.records[index] = next;
    this.save();
    return clone(next);
  }

  list({ limit = 50 } = {}) {
    const bounded = Math.max(1, Math.min(Number(limit) || 50, this.maxRecords));
    return clone(this.records.slice(-bounded).reverse());
  }
}

export class DemoAutoExecutor {
  constructor({
    getMode,
    transport,
    journal,
    now = () => new Date().toISOString(),
    maxDecisionAgeMs = 15_000,
    maxBrokerAgeMs = 15_000,
    entryTolerancePoints = 0,
    requestTtlMs = 5_000,
  } = {}) {
    if (typeof getMode !== 'function') throw new Error('demo_executor_get_mode_required');
    if (!transport || typeof transport.executeDemoOrder !== 'function') throw new Error('demo_executor_transport_required');
    if (!journal || typeof journal.prepare !== 'function' || typeof journal.transition !== 'function') {
      throw new Error('demo_executor_journal_required');
    }
    this.getMode = getMode;
    this.transport = transport;
    this.journal = journal;
    this.now = now;
    this.options = { maxDecisionAgeMs, maxBrokerAgeMs, entryTolerancePoints, requestTtlMs };
    this.inflight = null;
    this.lastError = null;
    this.lastExecutionAt = null;
  }

  getState() {
    const mode = this.getMode();
    const transportState = this.transport.status?.() ?? {};
    return {
      state: this.inflight ? 'executing' : 'idle',
      demo_session_id: mode?.demo_session_id ?? null,
      enabled: Boolean(mode?.mode === 'DEMO_AUTO' && mode?.trade_execution_enabled && mode?.demo_session_id),
      transport_ready: Boolean(transportState.executor_ready),
      executor_account_type: transportState.executor_account_type ?? null,
      last_execution_at: this.lastExecutionAt,
      last_error: this.lastError,
    };
  }

  async execute({ technicalSignal, riskDecision, brokerState } = {}) {
    if (this.inflight) throw new Error('demo_executor_busy');

    const request = prepareDemoExecutionRequest({
      technicalSignal,
      riskDecision,
      modeState: this.getMode(),
      brokerState,
      now: this.now(),
      ...this.options,
    });

    const existing = this.journal.get(request.request_id);
    if (existing && FINAL_STATES.has(existing.state)) return existing;

    this.journal.prepare(request);

    const currentMode = normalizeMode(this.getMode());
    if (
      currentMode.mode !== 'DEMO_AUTO' ||
      !currentMode.trade_execution_enabled ||
      currentMode.demo_session_id !== request.demo_session_id
    ) {
      throw new Error('demo_executor_kill_switch_active');
    }

    const run = (async () => {
      this.lastError = null;
      this.journal.transition(request.request_id, 'SENT');
      try {
        const rawReceipt = await this.transport.executeDemoOrder(request);
        const receipt = parseDemoExecutionReceipt(rawReceipt, request);
        const state = receipt.status === 'FILLED'
          ? 'FILLED'
          : receipt.status === 'DUPLICATE'
            ? 'DUPLICATE'
            : 'REJECTED';
        const record = this.journal.transition(request.request_id, state, { receipt });
        this.lastExecutionAt = record.updated_at;
        return record;
      } catch (error) {
        this.lastError = String(error?.message || error).slice(0, 500);
        this.journal.transition(request.request_id, 'UNCERTAIN', { error: this.lastError });
        throw error;
      }
    })();

    this.inflight = run;
    try {
      return await run;
    } finally {
      if (this.inflight === run) this.inflight = null;
    }
  }
}
