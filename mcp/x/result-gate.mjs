/**
 * Phase 8: deterministic Result Gate.
 *
 * A pure function over Phase 7's own `RepairOutcome` (as returned by
 * `runTaskWithRepair` in repair-loop.mjs) that reduces it to exactly one of
 * three gate states for Hearth. No model call, no filesystem access, no
 * shell, no network, no repair, no retry, no remote write -- this module
 * imports nothing from Phase 1-7 and adds no new evidence of its own. It
 * only reads fields Phase 6/7 already produced.
 *
 * This module is standalone. Its locked mapping is its own local source of truth:
 *
 *   COMPLETED    <-> hearth_outcome: completed
 *   NEEDS_REVIEW <-> hearth_outcome: waiting
 *   FAILED       <-> hearth_outcome: error
 *
 * `hearth_outcome` is always DERIVED from `gate_status` (never set
 * independently), and `waiting_reason` is always derived from
 * `hearth_outcome` -- this makes the bijection above structurally
 * impossible to violate rather than merely tested.
 *
 * `status: 'validated'` is trusted only when the RepairOutcome carries
 * evidence consistent with that claim (no top-level blockers, a final
 * validation round whose `validation.required` results are all
 * `'passed'`) -- see `hasConsistentCompletionEvidence`. A structurally
 * valid RepairOutcome whose `status` and evidence disagree is never
 * silently promoted to COMPLETED; it fails closed to NEEDS_REVIEW instead.
 *
 * This module does not (and, per the current Phase 7 evidence, cannot)
 * distinguish a required-validation failure X's own edit introduced from
 * one that pre-existed or is otherwise unrelated -- no `failure_origin`
 * signal exists anywhere in Phase 6/7. Per explicit product decision, that
 * gap is NOT closed here (Phase 7 is not modified); a repairable failure
 * that survives the full repair budget is therefore routed to
 * NEEDS_REVIEW, never asserted as FAILED, so X's own change is never
 * blamed without proof. A future x-result-v1 phase can represent that
 * absence of provenance honestly as `failure_origin: "unknown"`.
 *
 * `PROTECTED_PATH`/`SYMLINK_ESCAPE` are Phase 5B safety-boundary blocks:
 * the mutation never happened (Phase 5B refused it before any write), but
 * the attempt itself is worth a supervisor's eyes rather than being
 * collapsed into a generic terminal FAILED alongside ordinary tool errors.
 */

import { failureSubtypeOf } from './failure-kinds.mjs';

export const GATE_STATUSES = Object.freeze(['COMPLETED', 'NEEDS_REVIEW', 'FAILED']);
export const WAITING_REASONS = Object.freeze(['supervisor_review', 'external_dependency']);

/** Single source of truth for the locked bijection; hearth_outcome is always derived from this, never set independently. */
const HEARTH_OUTCOME_BY_GATE_STATUS = Object.freeze({
  COMPLETED: 'completed',
  NEEDS_REVIEW: 'waiting',
  FAILED: 'error',
});

// Phase 5B safety-boundary codes: the model attempted an out-of-bounds
// write and Phase 5B refused it before any mutation. Explicit supervisor
// visibility rather than a generic structural FAILED.
const SAFETY_BOUNDARY_CODES = Object.freeze(new Set(['PROTECTED_PATH', 'SYMLINK_ESCAPE']));

// Deterministic, objective, not model-retryable structural/authorization/
// schema failures. All of these collapse to the single stable reason_code
// 'structural_execution_failure' -- the underlying Phase 5B/6 identifier
// (see FAILURE_CLASSIFICATION in repair-loop.mjs) is preserved only in
// evidence.blocker.code/.reason, never promoted to reason_code itself, so
// x-result-v1's reason_code taxonomy stays stable even if Phase 5B/6 ever
// add or rename an underlying code.
const KNOWN_FAILED_EXECUTION_CODES = Object.freeze(new Set([
  'PERMISSION_DENIED',
  'PATH_REJECTED',
  'INVALID_SCOPE',
  'WRITE_FAILED',
  'UNREADABLE_TARGET',
  'context_load_failed',
  'schema_invalid',
  'unsupported_action',
  'missing_field',
  'too_many_actions',
  'too_many_files',
]));

const buildGateResult = (gateStatus, reasonCode, evidence, waitingReason = null) => {
  const hearthOutcome = HEARTH_OUTCOME_BY_GATE_STATUS[gateStatus];
  return Object.freeze({
    gate_status: gateStatus,
    hearth_outcome: hearthOutcome,
    reason_code: reasonCode,
    waiting_reason: hearthOutcome === 'waiting' ? waitingReason : null,
    evidence: Object.freeze(evidence),
  });
};

/** Structural precondition check. A malformed RepairOutcome is a caller contract violation, not a gate outcome -- fails loudly, matching repair-loop.mjs's own style. */
function assertRepairOutcomeShape(repairOutcome) {
  if (!repairOutcome || typeof repairOutcome !== 'object') {
    throw new TypeError('evaluateResultGate: repairOutcome must be an object');
  }
  if (repairOutcome.status !== 'validated' && repairOutcome.status !== 'escalation_required') {
    throw new TypeError("evaluateResultGate: repairOutcome.status must be 'validated' or 'escalation_required'");
  }
  if (!Array.isArray(repairOutcome.rounds)) {
    throw new TypeError('evaluateResultGate: repairOutcome.rounds must be an array');
  }
  if (!Array.isArray(repairOutcome.blockers)) {
    throw new TypeError('evaluateResultGate: repairOutcome.blockers must be an array');
  }
}

/** Same key derivation classifyExecutorFailure (repair-loop.mjs) uses: the specific code wins over the generic reason when both are present. */
const blockerKeyOf = (blocker) => blocker?.code ?? blocker?.reason ?? null;

const baseEvidence = (repairOutcome, extra = {}) => ({
  task_id: repairOutcome.task_id ?? null,
  total_rounds: repairOutcome.total_rounds,
  ...extra,
});

/**
 * `status: 'validated'` is Phase 7's own claim; this independently checks
 * the evidence actually backs it up before Phase 8 ever reports COMPLETED.
 * Required: no top-level blockers, at least one round, a final round of
 * kind 'validation' whose `validation.required` is an array every entry of
 * which actually reports `status: 'passed'` (an empty required array is
 * valid evidence -- vacuously "every result passed" -- since a task may
 * legitimately declare no required validation). Any mismatch means the
 * RepairOutcome is structurally valid but internally inconsistent -- never
 * silently promoted to COMPLETED.
 */
function hasConsistentCompletionEvidence(repairOutcome) {
  if (repairOutcome.blockers.length !== 0) return false;
  const lastRound = repairOutcome.rounds[repairOutcome.rounds.length - 1] ?? null;
  if (!lastRound || lastRound.kind !== 'validation') return false;
  const required = lastRound.validation?.required;
  if (!Array.isArray(required)) return false;
  return required.every((result) => result?.status === 'passed');
}

/**
 * Classifies the final execution-kind round of an escalated RepairOutcome.
 * `round.classification` is already 'escalate' or 'repairable' (computed by
 * Phase 7); this only reads the underlying blocker code to decide which
 * NEEDS_REVIEW/FAILED bucket applies, and to fail closed on anything Phase 8
 * does not itself recognize.
 */
function classifyExecutionRound(repairOutcome, round) {
  const blocker = round.executor?.blockers?.[0] ?? null;
  const key = blockerKeyOf(blocker);
  const subtype = failureSubtypeOf(blocker);
  const evidence = baseEvidence(repairOutcome, {
    last_round_kind: 'execution',
    last_round_classification: round.classification,
    blocker: blocker ? Object.freeze({ code: blocker.code ?? null, reason: blocker.reason ?? null, detail: blocker.detail ?? null, ...(subtype ? { subtype: blocker.subtype } : {}) }) : null,
    ...(subtype ? { failure_class: subtype.failure_class } : {}),
  });

  if (round.classification === 'escalate') {
    // A permanent PRECONDITION_FAILED subtype (X v0.2 Slice 4): X cannot show / let the model edit what the fix needs, or an
    // internal contract is violated. Deterministic and not model-retryable, so it is the same structural bucket as the codes
    // below -- never a "transient repair exhaustion". The subtype and failure_class stay in the evidence, not in reason_code.
    if (subtype && (subtype.failure_class === 'context_limitation' || subtype.failure_class === 'structural')) {
      return buildGateResult('FAILED', 'structural_execution_failure', evidence);
    }
    if (SAFETY_BOUNDARY_CODES.has(key)) {
      return buildGateResult('NEEDS_REVIEW', 'safety_boundary_review', evidence, 'supervisor_review');
    }
    if (KNOWN_FAILED_EXECUTION_CODES.has(key)) {
      return buildGateResult('FAILED', 'structural_execution_failure', evidence);
    }
    return buildGateResult('NEEDS_REVIEW', 'unrecognized_repair_outcome', evidence, 'supervisor_review');
  }

  if (round.classification === 'repairable') {
    // Only reachable when the repair budget is exhausted (repair-loop.mjs
    // only escalates a 'repairable' round on its final allowed round).
    if (key === 'model_request_failed') {
      return buildGateResult('NEEDS_REVIEW', 'model_unavailable_after_repair', evidence, 'external_dependency');
    }
    return buildGateResult('NEEDS_REVIEW', 'repair_budget_exhausted_transient', evidence, 'supervisor_review');
  }

  // Unexpected classification value on an execution round of an escalated
  // outcome -- Phase 7 never produces this today. Fail closed.
  return buildGateResult('NEEDS_REVIEW', 'unrecognized_repair_outcome', evidence, 'supervisor_review');
}

/**
 * Classifies the final validation-kind round of an escalated RepairOutcome.
 * The only validation-side escalation this module expects here is a
 * required-validation failure that survived the full repair budget --
 * invalid_command escalations are already caught via top-level `blockers`
 * before this function is ever reached.
 */
function classifyValidationRound(repairOutcome, round) {
  const evidence = baseEvidence(repairOutcome, {
    last_round_kind: 'validation',
    last_round_classification: round.classification,
    required_validation: (round.validation?.required ?? []).map((r) => ({ command: r.command, status: r.status })),
  });

  if (round.classification === 'repairable') {
    // Required-validation-failed-after-repair-exhaustion: Phase 7 carries
    // no failure_origin evidence, so this can never be asserted as FAILED
    // (that would blame X's change without proof). See module docstring.
    return buildGateResult('NEEDS_REVIEW', 'repair_budget_exhausted_transient', evidence, 'supervisor_review');
  }

  // classification 'escalate' (invalid_command) is handled via top-level
  // blockers before reaching here; any other value is unexpected. Fail closed.
  return buildGateResult('NEEDS_REVIEW', 'unrecognized_repair_outcome', evidence, 'supervisor_review');
}

/**
 * Reduces a Phase 7 `RepairOutcome` to a deterministic Result Gate decision.
 *
 * @param {object} repairOutcome the frozen object returned by `runTaskWithRepair`
 * @returns {{gate_status: 'COMPLETED'|'NEEDS_REVIEW'|'FAILED', hearth_outcome: 'completed'|'waiting'|'error', reason_code: string, waiting_reason: 'supervisor_review'|'external_dependency'|null, evidence: object}}
 */
export function evaluateResultGate(repairOutcome) {
  assertRepairOutcomeShape(repairOutcome);

  if (repairOutcome.status === 'validated') {
    if (hasConsistentCompletionEvidence(repairOutcome)) {
      const lastRound = repairOutcome.rounds[repairOutcome.rounds.length - 1];
      const evidence = baseEvidence(repairOutcome, {
        last_round_kind: 'validation',
        required_validation: lastRound.validation.required.map((r) => ({ command: r.command, status: r.status })),
      });
      return buildGateResult('COMPLETED', 'validated', evidence);
    }
    // status claims 'validated' but the evidence backing that claim is
    // missing or contradictory (e.g. a failed/timed-out required result, a
    // non-validation final round, zero rounds, or a stray top-level
    // blocker). Fail closed to supervisor review rather than throw -- the
    // object itself is structurally valid, only internally inconsistent.
    const lastRound = repairOutcome.rounds[repairOutcome.rounds.length - 1] ?? null;
    const evidence = baseEvidence(repairOutcome, {
      last_round_kind: lastRound?.kind ?? null,
      top_level_blockers: repairOutcome.blockers.length,
      required_validation: Array.isArray(lastRound?.validation?.required)
        ? lastRound.validation.required.map((r) => ({ command: r.command, status: r.status }))
        : null,
    });
    return buildGateResult('NEEDS_REVIEW', 'unrecognized_repair_outcome', evidence, 'supervisor_review');
  }

  // status === 'escalation_required' from here on.
  const topBlocker = repairOutcome.blockers[0] ?? null;
  if (topBlocker?.reason === 'invalid_task_scope' || topBlocker?.reason === 'invalid_validation_command') {
    const evidence = baseEvidence(repairOutcome, {
      top_level_blocker: Object.freeze({ reason: topBlocker.reason, detail: topBlocker.detail ?? null }),
    });
    return buildGateResult('FAILED', topBlocker.reason, evidence);
  }
  if (repairOutcome.blockers.length > 0) {
    // A top-level blocker is present but its reason is neither of the two
    // Phase 8 recognizes. This is unknown/future evidence -- fail closed
    // immediately rather than fall through to round-based classification,
    // which was never meant to explain an unrecognized top-level blocker.
    const evidence = baseEvidence(repairOutcome, {
      top_level_blocker: Object.freeze({ reason: topBlocker?.reason ?? null, detail: topBlocker?.detail ?? null }),
    });
    return buildGateResult('NEEDS_REVIEW', 'unrecognized_repair_outcome', evidence, 'supervisor_review');
  }

  const lastRound = repairOutcome.rounds[repairOutcome.rounds.length - 1] ?? null;
  if (!lastRound) {
    // Escalated with no round evidence and no top-level blocker at all --
    // nothing to classify against. Fail closed rather than guess.
    return buildGateResult('NEEDS_REVIEW', 'unrecognized_repair_outcome', baseEvidence(repairOutcome), 'supervisor_review');
  }

  if (lastRound.kind === 'execution') return classifyExecutionRound(repairOutcome, lastRound);
  if (lastRound.kind === 'validation') return classifyValidationRound(repairOutcome, lastRound);

  // Unrecognized round.kind value. Fail closed.
  return buildGateResult(
    'NEEDS_REVIEW',
    'unrecognized_repair_outcome',
    baseEvidence(repairOutcome, { last_round_kind: lastRound.kind ?? null }),
    'supervisor_review',
  );
}
