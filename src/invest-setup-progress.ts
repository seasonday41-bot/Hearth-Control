// Turns the coordinator's machine-readable state into something an operator can
// read at a glance. Pure presentation: this decides nothing and changes no rule,
// it only says, in plain words, how far a setup got and whether the data behind
// it is fresh enough for the Risk Gate to act on.

export type StepState = 'done' | 'waiting' | 'failed' | 'pending';

export interface SetupStep {
  label: string;
  state: StepState;
}

/** A setup's ladder, in the order the engine actually requires them. */
const SMC_LADDER: Array<{ label: string; failedBy?: string; waitingFor?: string }> = [
  { label: 'H1 direction', failedBy: 'context_not_directional' },
  { label: 'M15 break of structure', failedBy: 'bos_not_confirmed' },
  { label: 'IDM point', failedBy: 'idm_not_found' },
  { label: 'Entry zone', failedBy: 'discount_premium_zone_not_found' },
  { label: 'IDM sweep', waitingFor: 'waiting_for_idm_sweep' },
  { label: 'Price touched the zone', waitingFor: 'waiting_for_zone_touch' },
  { label: 'M5 micro break', waitingFor: 'waiting_for_m5_micro_bos' },
];

const HARMONIC_LADDER: Array<{ label: string; failedBy?: string; waitingFor?: string }> = [
  { label: 'Pattern found', failedBy: 'harmonic_pattern_not_found' },
  { label: 'D point confirmed', waitingFor: 'waiting_for_d_confirmation' },
  { label: 'Structure still valid', failedBy: 'harmonic_structure_invalidated' },
  { label: 'M5 micro break', waitingFor: 'waiting_for_m5_micro_bos' },
];

/** A structural break invalidates the whole setup rather than one rung. */
const STRUCTURE_BROKEN = new Set(['idm_structure_invalidated', 'harmonic_structure_invalidated']);

/**
 * How far the setup climbed. Everything before the first unmet rung is done,
 * that rung is the one being waited on (or the one that failed), and the rest
 * have not been reached yet. A READY setup has climbed all of them.
 */
export const setupSteps = (
  strategy: 'SMC_IDM' | 'HARMONIC_PRZ',
  state: string | undefined,
  reasonCodes: readonly string[] = [],
): SetupStep[] => {
  const ladder = strategy === 'SMC_IDM' ? SMC_LADDER : HARMONIC_LADDER;
  if (state === 'READY') return ladder.map((rung) => ({ label: rung.label, state: 'done' as const }));

  const codes = new Set(reasonCodes);
  const blockedAt = ladder.findIndex((rung) => (
    (rung.failedBy && codes.has(rung.failedBy)) || (rung.waitingFor && codes.has(rung.waitingFor))
  ));

  return ladder.map((rung, index) => {
    // No recognised blocker and not READY means the engine has not told us how
    // far this setup got. "Not reached" is the honest answer; claiming every
    // rung is done would read as "about to trigger" when nothing is happening.
    if (blockedAt === -1) return { label: rung.label, state: 'pending' };
    if (index < blockedAt) return { label: rung.label, state: 'done' };
    if (index > blockedAt) return { label: rung.label, state: 'pending' };
    return { label: rung.label, state: rung.failedBy && codes.has(rung.failedBy) ? 'failed' : 'waiting' };
  });
};

/** The one sentence that explains the current state, without jargon. */
export const setupSummary = (state: string | undefined, reasonCodes: readonly string[] = []): string => {
  if (state === 'READY') return 'Ready. Waiting for the price to be inside the entry zone.';
  if (reasonCodes.some((code) => STRUCTURE_BROKEN.has(code))) return 'The setup broke before it could trigger. Waiting for a new one.';
  const waiting = setupSteps('SMC_IDM', state, reasonCodes).find((step) => step.state === 'waiting' || step.state === 'failed');
  if (state === 'INVALID') return 'No valid setup right now.';
  // Labels carry acronyms (H1, M15, IDM), so they keep their own casing.
  if (waiting) return `Waiting for the ${waiting.label}.`;
  return 'Watching for a setup.';
};

export type FreshnessTone = 'live' | 'lagging' | 'stale' | 'absent';

export interface Freshness {
  tone: FreshnessTone;
  label: string;
}

/**
 * The Risk Gate rejects telemetry older than 15s, so that is the honest
 * boundary between "trading can happen" and "it cannot", and the reason this
 * cannot simply report "connected" whenever a snapshot exists at all: a
 * snapshot survives the EA going away, and a stale one buys nothing.
 */
export const RISK_MAX_STATE_AGE_MS = 15_000;

export const freshness = (ageMs: number | null | undefined): Freshness => {
  if (ageMs == null || !Number.isFinite(ageMs)) return { tone: 'absent', label: 'No data' };
  if (ageMs <= RISK_MAX_STATE_AGE_MS) return { tone: 'live', label: 'Live' };
  if (ageMs < 60_000) return { tone: 'lagging', label: `${Math.round(ageMs / 1000)}s behind` };
  if (ageMs < 3_600_000) return { tone: 'stale', label: `Stale · ${Math.round(ageMs / 60_000)} min old` };
  return { tone: 'stale', label: `Stale · ${Math.round(ageMs / 3_600_000)} h old` };
};

/** Minutes and seconds left before a waiting setup expires, or null once it has. */
export const timeLeft = (expiresAt: string | null | undefined, now: number = Date.now()): string | null => {
  if (!expiresAt) return null;
  const remaining = Date.parse(expiresAt) - now;
  if (!Number.isFinite(remaining) || remaining <= 0) return null;
  const minutes = Math.floor(remaining / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1000);
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
};
