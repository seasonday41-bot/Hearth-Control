import { analyzeSmcIdm } from './smc-idm-engine.mjs';
import { analyzeHarmonicPrz } from './harmonic-prz-engine.mjs';
import { normalizeEngineTechnicalSignal } from './technical-signal.mjs';
import { evaluateXauRisk } from './risk-gate.mjs';

export const LIVE_V2_COORDINATOR_VERSION = 'live-v2-coordinator-v1';
export const LIVE_V2_REQUIRED_TIMEFRAMES = Object.freeze(['H1', 'M15', 'M5']);
const SYSTEM_MAX_STATE_AGE_MS = 15_000;

const clone = (value) => structuredClone(value);
const safeError = (error) => String(error?.message || error || 'unknown_error').slice(0, 240);

const emptyStrategy = (strategy) => ({
  strategy,
  state: 'NO_SETUP',
  direction: null,
  signal_id: null,
  entry_zone: null,
  invalidation: null,
  targets: [],
  reason_codes: [],
  as_of: null,
  expires_at: null,
});

const strategyView = (engineResult) => {
  if (!engineResult || typeof engineResult !== 'object') {
    return { ...emptyStrategy('UNKNOWN'), state: 'INVALID', reason_codes: ['engine_result_invalid'] };
  }

  if (!['PRE_SIGNAL', 'READY'].includes(engineResult.state)) {
    return {
      ...emptyStrategy(engineResult.strategy),
      state: 'INVALID',
      direction: ['BUY', 'SELL'].includes(engineResult.direction) ? engineResult.direction : null,
      reason_codes: Array.isArray(engineResult.reason_codes) ? [...engineResult.reason_codes] : ['no_setup'],
      as_of: engineResult.as_of || null,
    };
  }

  try {
    const signal = normalizeEngineTechnicalSignal(engineResult);
    return {
      strategy: signal.strategy,
      state: signal.state,
      direction: signal.direction,
      signal_id: signal.id,
      entry_zone: signal.entry_zone ? [...signal.entry_zone] : null,
      invalidation: signal.invalidation,
      targets: [...signal.targets],
      reason_codes: [...signal.reason_codes],
      as_of: signal.as_of,
      expires_at: signal.expires_at,
      signal,
    };
  } catch (error) {
    return {
      ...emptyStrategy(engineResult.strategy),
      state: 'INVALID',
      direction: ['BUY', 'SELL'].includes(engineResult.direction) ? engineResult.direction : null,
      reason_codes: [`normalization_failed:${safeError(error)}`],
      as_of: engineResult.as_of || null,
    };
  }
};

const publicStrategy = (view) => {
  const { signal, ...safe } = view;
  return clone(safe);
};

const closedBars = (payload, timeframe) => {
  if (!payload || payload.timeframe !== timeframe || !Array.isArray(payload.bars) || payload.bars.length < 4) {
    throw new Error(`v2_${timeframe.toLowerCase()}_bars_unavailable`);
  }
  const confirmed = payload.bars.slice(0, -1);
  if (confirmed.length < 3) throw new Error(`v2_${timeframe.toLowerCase()}_confirmed_bars_insufficient`);
  return confirmed;
};

const executionAlreadyRecorded = (journal, proposalId) => {
  const entries = journal?.list?.({ limit: 500 }) ?? [];
  return entries.some((item) => item?.proposal_id === proposalId);
};

export class LiveV2Coordinator {
  constructor({
    getMode,
    getRiskConfig,
    marketAdapter,
    riskAdapter,
    executor,
    executionJournal,
    analyzeSmc = analyzeSmcIdm,
    analyzeHarmonic = analyzeHarmonicPrz,
    evaluateRisk = evaluateXauRisk,
    intervalMs = 5_000,
    now = () => new Date().toISOString(),
    onUpdate = () => {},
  } = {}) {
    if (typeof getMode !== 'function') throw new Error('v2_coordinator_get_mode_required');
    if (typeof getRiskConfig !== 'function') throw new Error('v2_coordinator_get_risk_config_required');
    if (!marketAdapter || typeof marketAdapter.getBars !== 'function') throw new Error('v2_coordinator_market_adapter_required');
    if (!riskAdapter || typeof riskAdapter.getRiskState !== 'function') throw new Error('v2_coordinator_risk_adapter_required');
    if (!executor || typeof executor.execute !== 'function') throw new Error('v2_coordinator_executor_required');
    if (!executionJournal || typeof executionJournal.list !== 'function') throw new Error('v2_coordinator_execution_journal_required');
    if (typeof analyzeSmc !== 'function' || typeof analyzeHarmonic !== 'function' || typeof evaluateRisk !== 'function') {
      throw new Error('v2_coordinator_engine_required');
    }

    this.getMode = getMode;
    this.getRiskConfig = getRiskConfig;
    this.marketAdapter = marketAdapter;
    this.riskAdapter = riskAdapter;
    this.executor = executor;
    this.executionJournal = executionJournal;
    this.analyzeSmc = analyzeSmc;
    this.analyzeHarmonic = analyzeHarmonic;
    this.evaluateRisk = evaluateRisk;
    this.intervalMs = Math.max(1_000, Math.min(Number(intervalMs) || 5_000, 60_000));
    this.now = now;
    this.onUpdate = onUpdate;

    this.timer = null;
    this.inFlight = null;
    this.lastClosedM5 = null;
    this.circuitBreakerActive = false;
    this.state = {
      version: LIVE_V2_COORDINATOR_VERSION,
      state: 'stopped',
      interval_ms: this.intervalMs,
      required_timeframes: [...LIVE_V2_REQUIRED_TIMEFRAMES],
      last_checked_at: null,
      last_cycle_at: null,
      last_closed_m5: null,
      last_error: null,
      execution_blocked_reason: null,
      strategies: {
        SMC_IDM: emptyStrategy('SMC_IDM'),
        HARMONIC_PRZ: emptyStrategy('HARMONIC_PRZ'),
      },
      risk: {
        configured: false,
        signal_id: null,
        decision: null,
        approved_volume: null,
        reason_codes: [],
        evaluated_at: null,
      },
      circuit_breaker_active: false,
    };
  }

  emit() {
    try { this.onUpdate(this.getState()); } catch {}
  }

  getState() {
    return clone(this.state);
  }

  start() {
    if (this.timer) return this.getState();
    this.state.state = 'idle';
    this.emit();
    this.timer = setInterval(() => { void this.check(); }, this.intervalMs);
    this.timer.unref?.();
    void this.check();
    return this.getState();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.state.state = 'stopped';
    this.emit();
  }

  async check({ force = false } = {}) {
    if (this.inFlight) return this.inFlight;
    const run = this.runCycle({ force }).finally(() => {
      if (this.inFlight === run) this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  async runCycle({ force = false } = {}) {
    const checkedAt = this.now();
    this.state.last_checked_at = checkedAt;
    this.state.last_error = null;

    const mode = this.getMode();
    if (!mode?.automatic_analysis_enabled) {
      this.state.state = 'off';
      this.state.execution_blocked_reason = 'mode_off';
      this.emit();
      return this.getState();
    }

    this.state.state = 'reading_mt5';
    this.emit();

    let h1;
    let m15;
    let m5;
    try {
      [h1, m15, m5] = await Promise.all([
        this.marketAdapter.getBars({ symbol: 'XAUUSD', timeframe: 'H1', limit: 250 }),
        this.marketAdapter.getBars({ symbol: 'XAUUSD', timeframe: 'M15', limit: 250 }),
        this.marketAdapter.getBars({ symbol: 'XAUUSD', timeframe: 'M5', limit: 250 }),
      ]);
    } catch (error) {
      this.state.state = 'waiting_for_mt5';
      this.state.execution_blocked_reason = 'multi_timeframe_data_unavailable';
      this.state.last_error = safeError(error);
      this.emit();
      return this.getState();
    }

    let contextBars;
    let setupBars;
    let triggerBars;
    try {
      contextBars = closedBars(h1, 'H1');
      setupBars = closedBars(m15, 'M15');
      triggerBars = closedBars(m5, 'M5');
    } catch (error) {
      this.state.state = 'waiting_for_mt5';
      this.state.execution_blocked_reason = 'confirmed_bar_data_unavailable';
      this.state.last_error = safeError(error);
      this.emit();
      return this.getState();
    }

    const closedM5 = triggerBars.at(-1)?.time;
    if (!closedM5) {
      this.state.state = 'waiting_for_mt5';
      this.state.execution_blocked_reason = 'm5_closed_bar_unavailable';
      this.emit();
      return this.getState();
    }

    if (!force && this.lastClosedM5 === closedM5) {
      this.state.state = 'idle';
      this.state.last_closed_m5 = closedM5;
      this.emit();
      return this.getState();
    }

    this.lastClosedM5 = closedM5;
    this.state.last_closed_m5 = closedM5;
    this.state.last_cycle_at = checkedAt;
    this.state.state = 'analyzing';
    this.state.execution_blocked_reason = null;
    this.emit();

    const smcResult = this.analyzeSmc({ contextBars, setupBars, triggerBars });
    const harmonicResult = this.analyzeHarmonic({ contextBars, setupBars, triggerBars });
    const smc = strategyView(smcResult);
    const harmonic = strategyView(harmonicResult);

    this.state.strategies = {
      SMC_IDM: publicStrategy(smc),
      HARMONIC_PRZ: publicStrategy(harmonic),
    };

    const riskConfig = this.getRiskConfig();
    this.state.risk = {
      configured: Boolean(riskConfig),
      signal_id: null,
      decision: null,
      approved_volume: null,
      reason_codes: [],
      evaluated_at: null,
    };

    const ready = [smc, harmonic].filter((item) => item.state === 'READY' && item.signal);

    if (mode.mode !== 'DEMO_AUTO') {
      this.state.state = ready.length ? 'ready_monitor_only' : 'idle';
      this.state.execution_blocked_reason = ready.length ? 'demo_auto_not_enabled' : null;
      this.emit();
      return this.getState();
    }

    if (this.circuitBreakerActive) {
      this.state.state = 'blocked';
      this.state.circuit_breaker_active = true;
      this.state.execution_blocked_reason = 'coordinator_circuit_breaker_active';
      this.emit();
      return this.getState();
    }

    if (ready.length === 0) {
      this.state.state = 'idle';
      this.state.execution_blocked_reason = 'no_ready_setup';
      this.emit();
      return this.getState();
    }

    if (ready.length > 1) {
      this.state.state = 'blocked';
      this.state.execution_blocked_reason = 'multiple_ready_setups';
      this.emit();
      return this.getState();
    }

    const candidate = ready[0];
    if (!riskConfig) {
      this.state.state = 'blocked';
      this.state.execution_blocked_reason = 'risk_config_required';
      this.emit();
      return this.getState();
    }

    if (executionAlreadyRecorded(this.executionJournal, candidate.signal.id)) {
      this.state.state = 'blocked';
      this.state.execution_blocked_reason = 'setup_already_submitted';
      this.emit();
      return this.getState();
    }

    let telemetry;
    try {
      telemetry = await this.riskAdapter.getRiskState({ symbol: 'XAUUSD' });
    } catch (error) {
      this.state.state = 'blocked';
      this.state.execution_blocked_reason = 'risk_telemetry_unavailable';
      this.state.last_error = safeError(error);
      this.emit();
      return this.getState();
    }

    const riskDecision = this.evaluateRisk({
      technicalSignal: candidate.signal,
      modeState: mode,
      accountState: {
        ...telemetry.account,
        cooldown_active: false,
        circuit_breaker_active: this.circuitBreakerActive,
      },
      brokerState: telemetry.broker,
      riskConfig: {
        ...riskConfig,
        max_state_age_ms: SYSTEM_MAX_STATE_AGE_MS,
      },
      now: checkedAt,
    });

    this.state.risk = {
      configured: true,
      signal_id: candidate.signal.id,
      decision: riskDecision.decision,
      approved_volume: riskDecision.approved_volume,
      reason_codes: [...riskDecision.reason_codes],
      evaluated_at: riskDecision.as_of,
    };

    if (!['APPROVE', 'RESIZE'].includes(riskDecision.decision)) {
      this.state.state = 'risk_rejected';
      this.state.execution_blocked_reason = 'risk_rejected';
      this.emit();
      return this.getState();
    }

    this.state.state = 'executing';
    this.emit();

    try {
      await this.executor.execute({
        technicalSignal: candidate.signal,
        riskDecision,
        brokerState: telemetry.broker,
      });
      this.state.state = 'executed';
      this.state.execution_blocked_reason = 'setup_already_submitted';
      this.emit();
      return this.getState();
    } catch (error) {
      this.circuitBreakerActive = true;
      this.state.circuit_breaker_active = true;
      this.state.state = 'blocked';
      this.state.execution_blocked_reason = 'execution_uncertain_circuit_breaker';
      this.state.last_error = safeError(error);
      this.emit();
      return this.getState();
    }
  }
}
