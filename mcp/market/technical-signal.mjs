import crypto from 'node:crypto';

export const TECHNICAL_SIGNAL_VERSION = 'technical-signal-v1';
export const TECHNICAL_SIGNAL_STRATEGIES = Object.freeze(['SMC_IDM', 'HARMONIC_PRZ']);
export const TECHNICAL_SIGNAL_STATES = Object.freeze(['PRE_SIGNAL', 'READY', 'INVALID']);
export const TECHNICAL_SIGNAL_TTL_MS = Object.freeze({
  PRE_SIGNAL: 4 * 60 * 60 * 1000,
  READY: 30 * 60 * 1000,
});

const KNOWN_FIELDS = new Set([
  'version',
  'id',
  'strategy',
  'symbol',
  'direction',
  'state',
  'context_timeframe',
  'setup_timeframe',
  'trigger_timeframe',
  'entry_zone',
  'invalidation',
  'targets',
  'evidence',
  'reason_codes',
  'as_of',
  'expires_at',
]);

const FORBIDDEN_TECHNICAL_KEYS = /^(balance|equity|lot|lots|volume|margin|leverage|order|orders|order_send|approved_volume|approved_risk_fraction|risk_fraction)$/i;
const MAX_EVIDENCE_BYTES = 64 * 1024;
const MAX_REASON_CODES = 20;

const clone = (value) => structuredClone(value);
const finite = (value) => Number.isFinite(value);

const normalizeIso = (value, code) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(code);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(code);
  return date.toISOString();
};

const normalizeNullableIso = (value, code) => {
  if (value == null) return null;
  return normalizeIso(value, code);
};

const normalizeEntryZone = (value, { required }) => {
  if (value == null && !required) return null;
  if (!Array.isArray(value) || value.length !== 2 || !value.every(finite)) {
    throw new Error('technical_signal_entry_zone_invalid');
  }
  const lower = Number(value[0]);
  const upper = Number(value[1]);
  if (lower > upper) throw new Error('technical_signal_entry_zone_invalid');
  return [lower, upper];
};

const normalizeTargets = (value, { required }) => {
  if (!Array.isArray(value)) throw new Error('technical_signal_targets_invalid');
  const targets = value.map(Number);
  if (targets.some((item) => !finite(item))) throw new Error('technical_signal_targets_invalid');
  if (required && targets.length === 0) throw new Error('technical_signal_targets_required');
  if (targets.length > 8) throw new Error('technical_signal_targets_too_many');
  return targets;
};

const normalizeReasons = (value) => {
  if (!Array.isArray(value)) throw new Error('technical_signal_reason_codes_invalid');
  const reasons = value.map((item) => String(item || '').trim()).filter(Boolean);
  if (reasons.length !== value.length || reasons.length > MAX_REASON_CODES) {
    throw new Error('technical_signal_reason_codes_invalid');
  }
  if (reasons.some((item) => !/^[a-z0-9_:-]{1,120}$/i.test(item))) {
    throw new Error('technical_signal_reason_code_invalid');
  }
  return [...new Set(reasons)];
};

const inspectForbiddenKeys = (value, depth = 0) => {
  if (depth > 20 || value == null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) inspectForbiddenKeys(item, depth + 1);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_TECHNICAL_KEYS.test(key)) throw new Error(`technical_signal_forbidden_field:${key}`);
    inspectForbiddenKeys(child, depth + 1);
  }
};

const normalizeEvidence = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('technical_signal_evidence_invalid');
  inspectForbiddenKeys(value);
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_EVIDENCE_BYTES) throw new Error('technical_signal_evidence_too_large');
  return clone(value);
};

const ttlForState = (state, ttlMs = TECHNICAL_SIGNAL_TTL_MS) => {
  if (state === 'INVALID') return null;
  const ttl = Number(ttlMs?.[state]);
  if (!Number.isFinite(ttl) || ttl <= 0) throw new Error(`technical_signal_ttl_invalid:${state}`);
  return ttl;
};

const expiryFrom = (asOf, state, ttlMs) => {
  const ttl = ttlForState(state, ttlMs);
  if (ttl == null) return null;
  return new Date(Date.parse(asOf) + ttl).toISOString();
};

const canonicalIdentity = (result) => {
  if (result.strategy === 'SMC_IDM') {
    const bosReference = result.evidence?.bos?.reference?.time;
    const bosBreak = result.evidence?.bos?.break_time;
    const idm = result.evidence?.idm?.time;
    if (![bosReference, bosBreak, idm].every((item) => typeof item === 'string' && item)) {
      throw new Error('technical_signal_identity_unavailable');
    }
    return {
      strategy: 'SMC_IDM',
      symbol: 'XAUUSD',
      direction: result.direction,
      bos_reference_time: normalizeIso(bosReference, 'technical_signal_identity_invalid'),
      bos_break_time: normalizeIso(bosBreak, 'technical_signal_identity_invalid'),
      idm_time: normalizeIso(idm, 'technical_signal_identity_invalid'),
    };
  }

  if (result.strategy === 'HARMONIC_PRZ') {
    const points = result.evidence?.points;
    const anchors = ['X', 'A', 'B', 'C'].map((label) => points?.[label]?.time);
    if (!result.pattern || !anchors.every((item) => typeof item === 'string' && item)) {
      throw new Error('technical_signal_identity_unavailable');
    }
    return {
      strategy: 'HARMONIC_PRZ',
      symbol: 'XAUUSD',
      direction: result.direction,
      pattern: result.pattern,
      xabc_times: anchors.map((item) => normalizeIso(item, 'technical_signal_identity_invalid')),
    };
  }

  throw new Error('technical_signal_strategy_unsupported');
};

export const deriveTechnicalSignalId = (engineResult) => {
  if (!engineResult || typeof engineResult !== 'object' || Array.isArray(engineResult)) {
    throw new Error('technical_signal_engine_result_invalid');
  }
  if (!['BUY', 'SELL'].includes(engineResult.direction)) throw new Error('technical_signal_direction_invalid');
  const identity = canonicalIdentity(engineResult);
  const digest = crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 24);
  return `techsig:v1:${digest}`;
};

export const parseTechnicalSignal = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('technical_signal_invalid');
  for (const field of Object.keys(value)) {
    if (!KNOWN_FIELDS.has(field)) throw new Error(`technical_signal_unknown_field:${field}`);
  }

  if (value.version !== TECHNICAL_SIGNAL_VERSION) throw new Error('technical_signal_version_invalid');
  if (typeof value.id !== 'string' || !/^techsig:v1:[a-f0-9]{24}$/.test(value.id)) throw new Error('technical_signal_id_invalid');
  if (!TECHNICAL_SIGNAL_STRATEGIES.includes(value.strategy)) throw new Error('technical_signal_strategy_invalid');
  if (value.symbol !== 'XAUUSD') throw new Error('technical_signal_symbol_invalid');
  if (!['BUY', 'SELL'].includes(value.direction)) throw new Error('technical_signal_direction_invalid');
  if (!TECHNICAL_SIGNAL_STATES.includes(value.state)) throw new Error('technical_signal_state_invalid');
  if (value.context_timeframe !== 'H1' || value.setup_timeframe !== 'M15' || value.trigger_timeframe !== 'M5') {
    throw new Error('technical_signal_timeframes_invalid');
  }

  const executableShapeRequired = value.state !== 'INVALID';
  const entryZone = normalizeEntryZone(value.entry_zone, { required: executableShapeRequired });
  const invalidation = value.invalidation == null ? null : Number(value.invalidation);
  if ((executableShapeRequired && !finite(invalidation)) || (invalidation != null && !finite(invalidation))) {
    throw new Error('technical_signal_invalidation_invalid');
  }
  const targets = normalizeTargets(value.targets, { required: executableShapeRequired });
  const evidence = normalizeEvidence(value.evidence);
  const reasonCodes = normalizeReasons(value.reason_codes);
  const asOf = normalizeIso(value.as_of, 'technical_signal_as_of_invalid');
  const expiresAt = normalizeNullableIso(value.expires_at, 'technical_signal_expires_at_invalid');

  if (value.state === 'INVALID') {
    if (expiresAt !== null) throw new Error('technical_signal_invalid_must_not_expire');
  } else {
    if (!expiresAt) throw new Error('technical_signal_expiry_required');
    if (Date.parse(expiresAt) <= Date.parse(asOf)) throw new Error('technical_signal_expiry_not_after_as_of');
  }

  inspectForbiddenKeys(value);

  return Object.freeze({
    version: TECHNICAL_SIGNAL_VERSION,
    id: value.id,
    strategy: value.strategy,
    symbol: 'XAUUSD',
    direction: value.direction,
    state: value.state,
    context_timeframe: 'H1',
    setup_timeframe: 'M15',
    trigger_timeframe: 'M5',
    entry_zone: entryZone ? Object.freeze([...entryZone]) : null,
    invalidation,
    targets: Object.freeze([...targets]),
    evidence: Object.freeze(evidence),
    reason_codes: Object.freeze([...reasonCodes]),
    as_of: asOf,
    expires_at: expiresAt,
  });
};

export const normalizeEngineTechnicalSignal = (engineResult, { ttlMs = TECHNICAL_SIGNAL_TTL_MS } = {}) => {
  if (!engineResult || typeof engineResult !== 'object' || Array.isArray(engineResult)) {
    throw new Error('technical_signal_engine_result_invalid');
  }
  if (!TECHNICAL_SIGNAL_STRATEGIES.includes(engineResult.strategy)) throw new Error('technical_signal_strategy_unsupported');
  if (String(engineResult.symbol || '').toUpperCase().replace('/', '') !== 'XAUUSD') throw new Error('technical_signal_symbol_invalid');
  if (!['BUY', 'SELL'].includes(engineResult.direction)) throw new Error('technical_signal_direction_invalid');
  if (!TECHNICAL_SIGNAL_STATES.includes(engineResult.state)) throw new Error('technical_signal_state_invalid');

  const asOf = normalizeIso(engineResult.as_of, 'technical_signal_as_of_invalid');
  const normalized = {
    version: TECHNICAL_SIGNAL_VERSION,
    id: deriveTechnicalSignalId(engineResult),
    strategy: engineResult.strategy,
    symbol: 'XAUUSD',
    direction: engineResult.direction,
    state: engineResult.state,
    context_timeframe: engineResult.context_timeframe,
    setup_timeframe: engineResult.setup_timeframe,
    trigger_timeframe: engineResult.trigger_timeframe,
    entry_zone: engineResult.entry_zone == null ? null : [...engineResult.entry_zone],
    invalidation: engineResult.invalidation,
    targets: Array.isArray(engineResult.targets) ? [...engineResult.targets] : [],
    evidence: clone(engineResult.evidence),
    reason_codes: Array.isArray(engineResult.reason_codes) ? [...engineResult.reason_codes] : [],
    as_of: asOf,
    expires_at: expiryFrom(asOf, engineResult.state, ttlMs),
  };
  return parseTechnicalSignal(normalized);
};

export const isTechnicalSignalExpired = (signal, now = new Date().toISOString()) => {
  const parsed = parseTechnicalSignal(signal);
  if (parsed.state === 'INVALID') return false;
  const checkedAt = normalizeIso(now, 'technical_signal_now_invalid');
  return Date.parse(checkedAt) >= Date.parse(parsed.expires_at);
};

export const expireTechnicalSignal = (signal, now = new Date().toISOString()) => {
  const parsed = parseTechnicalSignal(signal);
  if (!isTechnicalSignalExpired(parsed, now)) return parsed;
  return parseTechnicalSignal({
    ...parsed,
    state: 'INVALID',
    expires_at: null,
    reason_codes: [...new Set([...parsed.reason_codes, 'signal_expired'])],
  });
};

const fingerprint = (signal) => crypto.createHash('sha256').update(JSON.stringify(signal)).digest('hex');

const stateRank = Object.freeze({
  PRE_SIGNAL: 0,
  READY: 1,
  INVALID: 2,
});

export class TechnicalSignalBook {
  constructor() {
    this.signals = new Map();
  }

  upsert(signal, { now = signal?.as_of } = {}) {
    let next = parseTechnicalSignal(signal);
    if (now && isTechnicalSignalExpired(next, now)) next = expireTechnicalSignal(next, now);

    const existing = this.signals.get(next.id);
    if (!existing) {
      this.signals.set(next.id, next);
      return { signal: clone(next), created: true, updated: false };
    }

    if (fingerprint(existing) === fingerprint(next)) {
      return { signal: clone(existing), created: false, updated: false };
    }

    if (
      existing.strategy !== next.strategy ||
      existing.symbol !== next.symbol ||
      existing.direction !== next.direction
    ) {
      throw new Error('technical_signal_identity_conflict');
    }

    if (existing.state === 'INVALID') throw new Error('technical_signal_terminal');
    if (stateRank[next.state] < stateRank[existing.state]) throw new Error('technical_signal_state_regression');
    if (Date.parse(next.as_of) < Date.parse(existing.as_of)) throw new Error('technical_signal_stale_update');

    this.signals.set(next.id, next);
    return { signal: clone(next), created: false, updated: true };
  }

  get(id) {
    const signal = this.signals.get(id);
    return signal ? clone(signal) : null;
  }

  list() {
    return [...this.signals.values()]
      .map((signal) => clone(signal))
      .sort((a, b) => Date.parse(b.as_of) - Date.parse(a.as_of));
  }

  expire(now = new Date().toISOString()) {
    const checkedAt = normalizeIso(now, 'technical_signal_now_invalid');
    const expired = [];
    for (const [id, signal] of this.signals.entries()) {
      if (!isTechnicalSignalExpired(signal, checkedAt)) continue;
      const next = expireTechnicalSignal(signal, checkedAt);
      this.signals.set(id, next);
      expired.push(clone(next));
    }
    return expired;
  }
}
