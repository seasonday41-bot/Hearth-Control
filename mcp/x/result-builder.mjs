import crypto from 'node:crypto';
import { GATE_STATUSES, WAITING_REASONS } from './result-gate.mjs';
import { redactSecretContent } from './secret-guard.mjs';

/**
 * Phase 9: the x-result-v1 contract builder.
 *
 * `buildXResult(task, repairOutcome, gateResult, options)` is a pure
 * function that assembles the canonical x-result-v1 record (docs/
 * X-EXECUTOR-V1-SPEC.md §12) entirely from evidence Phases 6-8 already
 * produced. It performs no model call, no filesystem access, no shell, no
 * network, no Supabase write, and no repair/retry -- it only imports
 * `GATE_STATUSES`/`WAITING_REASONS` from result-gate.mjs to validate that
 * `gateResult` carries values from Phase 8's own published vocabulary and
 * to independently re-check the locked gate/hearth/waiting-reason
 * bijection holds, and `redactSecretContent` from secret-guard.mjs (the
 * same pure Secret Guard Phase 5A's Context Loader uses) to sanitize every
 * free-form string before it is copied into the result. It never
 * recomputes or reinterprets the gate decision itself --
 * `gate_status`/`hearth_outcome`/`reason_code`/`waiting_reason` are always
 * copied verbatim from `gateResult` once that structural check passes.
 *
 * Outbound secret sanitization: every free-form string this module copies
 * from task/executor/validation evidence into x-result-v1 --
 * `task.known_evidence[]`, a validation result's `summary`, an execution
 * blocker's `detail` (both inside `evidence_found` and inside the
 * top-level `blockers` array), and `gateResult.evidence.blocker.detail` --
 * is passed through `redactSecretContent` BEFORE byte truncation, never
 * after. Redacting after truncation could cut a multi-line secret pattern
 * (e.g. a PEM block) in half before the regex ever sees the whole thing,
 * silently leaking a fragment; redacting first and truncating the already-
 * safe text second is the same ordering Context Loader itself relies on.
 * No new redaction logic is implemented here -- the existing pure,
 * dependency-free `redactSecretContent` is reused as-is.
 *
 * Cross-input correlation: `task`, `repairOutcome`, and `gateResult` must
 * actually describe the same task (`repairOutcome.task_id === task.task_id`,
 * and `gateResult.evidence.task_id === task.task_id` when Phase 8 supplied
 * one) and `repairOutcome` must be internally consistent
 * (`total_rounds === rounds.length`, guaranteed by repair-loop.mjs's own
 * `finalize()` -- a mismatch means the input itself is malformed, not that
 * this module should guess which count is right). Any of these failing is
 * a caller contract violation -- `TypeError`, matching the rest of this
 * module's fail-loud style.
 *
 * Evidence contract:
 *   - `root_cause`, `why_fix_works`, `lesson_candidate`,
 *     `next_recommended_action` are always `null`, and `remaining_risks` is
 *     always `[]`, for this first builder. None of Phases 6-8 produce a
 *     verified root-cause/correctness/risk assessment, and
 *     `model_metadata.explanation` (LocalExecutor's captured model prose)
 *     is deliberately never mapped into any of these fields or into
 *     `evidence_found` -- it is unverified model-stated prose, not
 *     deterministic evidence, and surfacing it as if it were would
 *     misrepresent what Phase 6 actually proved.
 *   - `validation` describes the FINAL round's state only, never any
 *     earlier round. If `repairOutcome.rounds.at(-1)` is not a
 *     `kind: 'validation'` round (or there is no final round at all --
 *     e.g. an execution-side escalation before validation ever ran), every
 *     command declared on `task.validation.required`/`.optional` is
 *     reported `status: 'not_run'`. Earlier rounds are repair history and
 *     must never be presented as validation of the terminal attempt.
 *   - `timing.validation_minutes` is the one exception: it sums
 *     `durationMs` across every validation round in the ENTIRE history,
 *     because it represents total actual time spent validating, not the
 *     terminal attempt's state.
 *   - `files_changed`/`change_summary` are aggregated (deduped) across
 *     every round, since a supervisor reviewing the result needs to see
 *     everything X actually touched during the whole repair loop, not only
 *     the final round.
 *   - `commit` is always `{ created: false, sha: null, branch: null }` --
 *     nothing in Phases 1-8 ever commits.
 *   - `final_diff_summary.insertions`/`.deletions` are always `null` -- no
 *     line-diff evidence exists anywhere without a `git diff` shell call,
 *     which this module is forbidden from making.
 *   - `validation[].failure_origin` is `'unknown'` for a failed entry and
 *     `null` otherwise -- Phases 6-8 have no way to prove whether a failure
 *     was introduced by X's own change, matching the Result Gate's own
 *     documented provenance gap (see result-gate.mjs).
 *   - `validation[].stdout_ref`/`.stderr_ref` are always `null` -- no
 *     artifact store exists yet to point a reference at; raw stdout/stderr
 *     is never embedded here, matching the spec's "full terminal logs are
 *     not embedded" rule. The bounded, redacted `summary` string Phase 7
 *     already computed is surfaced instead, via `evidence_found`.
 */

export const X_RESULT_VERSION = 'x-result-v1';

const MAX_EVIDENCE_ENTRIES = 50;
const MAX_EVIDENCE_ENTRY_BYTES = 500;
const MAX_CHANGE_SUMMARY_ENTRIES = 100;
const MAX_CHANGE_SUMMARY_FIELD_BYTES = 500;
const MAX_BLOCKERS = 10;
const MAX_BLOCKER_DETAIL_BYTES = 500;

/** Single source of truth for the locked bijection, re-checked (never re-derived) against whatever gateResult claims. */
const HEARTH_OUTCOME_BY_GATE_STATUS = Object.freeze({
  COMPLETED: 'completed',
  NEEDS_REVIEW: 'waiting',
  FAILED: 'error',
});

const truncateBytes = (text, maxBytes) => {
  const buf = Buffer.from(String(text ?? ''), 'utf8');
  return buf.byteLength <= maxBytes ? String(text ?? '') : buf.subarray(0, maxBytes).toString('utf8');
};

/** Redact BEFORE truncate, always -- truncating first could cut a multi-line secret pattern in half before the Secret Guard ever sees the whole thing. */
const sanitizeAndTruncate = (text, maxBytes) => truncateBytes(redactSecretContent(text ?? ''), maxBytes);

function assertTaskShape(task) {
  if (!task || typeof task !== 'object') throw new TypeError('buildXResult: task must be an object');
  if (typeof task.task_id !== 'string' || !task.task_id.trim()) {
    throw new TypeError('buildXResult: task.task_id must be a non-empty string');
  }
  if (task.parent_task_id !== null && task.parent_task_id !== undefined && typeof task.parent_task_id !== 'string') {
    throw new TypeError('buildXResult: task.parent_task_id must be a string or null');
  }
  if (!Number.isInteger(task.revision)) throw new TypeError('buildXResult: task.revision must be an integer');
  if (!Number.isInteger(task.attempt)) throw new TypeError('buildXResult: task.attempt must be an integer');
  if (!task.validation || !Array.isArray(task.validation.required) || !Array.isArray(task.validation.optional)) {
    throw new TypeError('buildXResult: task.validation.required/optional must be arrays');
  }
  if (task.known_evidence !== undefined && !Array.isArray(task.known_evidence)) {
    throw new TypeError('buildXResult: task.known_evidence must be an array when present');
  }
  if (task.timing !== undefined && task.timing !== null && typeof task.timing !== 'object') {
    throw new TypeError('buildXResult: task.timing must be an object when present');
  }
}

function assertRepairOutcomeShape(repairOutcome) {
  if (!repairOutcome || typeof repairOutcome !== 'object') {
    throw new TypeError('buildXResult: repairOutcome must be an object');
  }
  if (repairOutcome.status !== 'validated' && repairOutcome.status !== 'escalation_required') {
    throw new TypeError("buildXResult: repairOutcome.status must be 'validated' or 'escalation_required'");
  }
  if (!Array.isArray(repairOutcome.rounds)) throw new TypeError('buildXResult: repairOutcome.rounds must be an array');
  if (!Array.isArray(repairOutcome.blockers)) throw new TypeError('buildXResult: repairOutcome.blockers must be an array');
  if (!Number.isInteger(repairOutcome.total_rounds) || repairOutcome.total_rounds < 0) {
    throw new TypeError('buildXResult: repairOutcome.total_rounds must be a non-negative integer');
  }
  // repair-loop.mjs's own finalize() guarantees total_rounds === rounds.length.
  // Disagreement means the input itself is malformed -- never guess which
  // count is authoritative.
  if (repairOutcome.total_rounds !== repairOutcome.rounds.length) {
    throw new TypeError('buildXResult: repairOutcome.total_rounds must equal repairOutcome.rounds.length');
  }
}

/**
 * Structural + bijection validation only -- never reclassification. Checks
 * that `gateResult` uses Phase 8's own published vocabulary AND that the
 * locked gate_status/hearth_outcome/waiting_reason invariants actually
 * hold; a `gateResult` that fails this is internally inconsistent and must
 * never be allowed to produce an x-result-v1 record.
 */
function assertGateResultShape(gateResult) {
  if (!gateResult || typeof gateResult !== 'object') throw new TypeError('buildXResult: gateResult must be an object');
  if (!GATE_STATUSES.includes(gateResult.gate_status)) {
    throw new TypeError('buildXResult: gateResult.gate_status is not a recognized gate status');
  }
  if (!['completed', 'waiting', 'error'].includes(gateResult.hearth_outcome)) {
    throw new TypeError('buildXResult: gateResult.hearth_outcome is not a recognized outcome');
  }
  if (gateResult.hearth_outcome !== HEARTH_OUTCOME_BY_GATE_STATUS[gateResult.gate_status]) {
    throw new TypeError(`buildXResult: gateResult violates the locked gate_status/hearth_outcome bijection (${gateResult.gate_status} <-> ${HEARTH_OUTCOME_BY_GATE_STATUS[gateResult.gate_status]})`);
  }
  if (typeof gateResult.reason_code !== 'string' || !gateResult.reason_code) {
    throw new TypeError('buildXResult: gateResult.reason_code must be a non-empty string');
  }
  if (gateResult.hearth_outcome === 'waiting') {
    if (gateResult.waiting_reason === null || !WAITING_REASONS.includes(gateResult.waiting_reason)) {
      throw new TypeError('buildXResult: gateResult.waiting_reason must be a recognized, non-null reason when hearth_outcome is waiting');
    }
  } else if (gateResult.waiting_reason !== null) {
    throw new TypeError('buildXResult: gateResult.waiting_reason must be null when hearth_outcome is not waiting');
  }
}

/** task/repairOutcome/gateResult must describe the same task -- never silently combine evidence from different tasks. */
function assertCrossInputConsistency(task, repairOutcome, gateResult) {
  if (repairOutcome.task_id !== task.task_id) {
    throw new TypeError('buildXResult: repairOutcome.task_id does not match task.task_id');
  }
  const gateTaskId = gateResult.evidence?.task_id;
  if (gateTaskId !== undefined && gateTaskId !== null && gateTaskId !== task.task_id) {
    throw new TypeError('buildXResult: gateResult.evidence.task_id does not match task.task_id');
  }
}

function resolveResultId(resultId) {
  if (resultId === undefined) return crypto.randomUUID();
  if (typeof resultId !== 'string' || !resultId.trim()) {
    throw new TypeError('buildXResult: options.resultId must be a non-empty string when provided');
  }
  return resultId;
}

/** Normalizes a Phase 7 validation-runner status into the x-result-v1 enum. Fail closed: any status this module does not recognize is reported 'failed', never silently 'passed'. */
function normalizeValidationStatus(status) {
  if (status === 'passed') return 'passed';
  return 'failed'; // 'failed' | 'timed_out' | 'invalid_command' | anything unrecognized
}

function findResult(results, command) {
  return results.find((r) => r?.command === command) ?? null;
}

function normalizeValidationEntry(command, required, result) {
  if (!result) {
    return { name: command, required, status: 'not_run', exit_code: null, failure_origin: null, stdout_ref: null, stderr_ref: null };
  }
  const status = normalizeValidationStatus(result.status);
  return {
    name: command,
    required,
    status,
    exit_code: Number.isInteger(result.exitCode) ? result.exitCode : null,
    failure_origin: status === 'failed' ? 'unknown' : null,
    stdout_ref: null,
    stderr_ref: null,
  };
}

/**
 * Builds the `validation` array from the FINAL round only. If the final
 * round is not a validation round (or there is no round at all), every
 * declared command is reported 'not_run' -- an earlier round's results are
 * never substituted in, even if that round actually ran validation.
 */
function buildValidationEntries(task, repairOutcome) {
  const finalRound = repairOutcome.rounds.length ? repairOutcome.rounds[repairOutcome.rounds.length - 1] : null;
  const requiredResults = finalRound?.kind === 'validation' ? (finalRound.validation?.required ?? []) : [];
  const optionalResults = finalRound?.kind === 'validation' ? (finalRound.validation?.optional ?? []) : [];

  return [
    ...task.validation.required.map((command) => normalizeValidationEntry(command, true, findResult(requiredResults, command))),
    ...task.validation.optional.map((command) => normalizeValidationEntry(command, false, findResult(optionalResults, command))),
  ];
}

/** Sums real durationMs evidence across every validation round in the whole history -- this field means total actual time spent validating, not the terminal attempt's state. */
function computeValidationMinutes(repairOutcome) {
  let sawValidationRound = false;
  let totalMs = 0;
  for (const round of repairOutcome.rounds) {
    if (round.kind !== 'validation') continue;
    sawValidationRound = true;
    for (const result of [...(round.validation?.required ?? []), ...(round.validation?.optional ?? [])]) {
      if (Number.isFinite(result?.durationMs)) totalMs += result.durationMs;
    }
  }
  return sawValidationRound ? totalMs / 60_000 : null;
}

/** Deduped union of files touched across every round, not only the final one -- a supervisor needs everything X touched during the whole repair loop. */
function buildFilesChanged(repairOutcome) {
  const set = new Set();
  for (const round of repairOutcome.rounds) {
    for (const filePath of round.executor?.files_changed ?? []) set.add(filePath);
  }
  return [...set];
}

/** Bounded in both entry count and per-string byte size -- defense in depth even though Phase 6's own limits already keep these fields small. */
function buildChangeSummary(repairOutcome) {
  const entries = [];
  outer: for (const round of repairOutcome.rounds) {
    for (const change of round.executor?.changes ?? []) {
      entries.push({
        round: round.round,
        operation: truncateBytes(change.operation, MAX_CHANGE_SUMMARY_FIELD_BYTES),
        path: truncateBytes(change.path, MAX_CHANGE_SUMMARY_FIELD_BYTES),
        status: truncateBytes(change.status, MAX_CHANGE_SUMMARY_FIELD_BYTES),
      });
      if (entries.length >= MAX_CHANGE_SUMMARY_ENTRIES) break outer;
    }
  }
  return entries;
}

/**
 * Bounded, deterministic, SECRET-GUARDED evidence strings only --
 * task-declared evidence, Phase 7's own already-truncated validation
 * summaries, and Phase 6 blocker labels. Every free-form string here is
 * redacted BEFORE truncation. Never model_metadata.explanation (unverified
 * model prose) and never raw stdout/stderr.
 */
function buildEvidenceFound(task, repairOutcome) {
  const entries = [];
  for (const item of task.known_evidence ?? []) entries.push(sanitizeAndTruncate(item, MAX_EVIDENCE_ENTRY_BYTES));
  outer: for (const round of repairOutcome.rounds) {
    if (round.kind === 'validation') {
      for (const result of [...(round.validation?.required ?? []), ...(round.validation?.optional ?? [])]) {
        if (result?.summary) entries.push(sanitizeAndTruncate(result.summary, MAX_EVIDENCE_ENTRY_BYTES));
        if (entries.length >= MAX_EVIDENCE_ENTRIES) break outer;
      }
    } else if (round.kind === 'execution') {
      const blocker = round.executor?.blockers?.[0];
      if (blocker) {
        const label = blocker.code || blocker.reason || 'unknown';
        // detail is free-form (an error/precondition message) and is
        // redacted on its own, BEFORE it is spliced into the composed
        // string and truncated.
        const redactedDetail = blocker.detail ? redactSecretContent(blocker.detail) : '';
        const composed = `Round ${round.round} execution ${round.executor.status}: ${label}${redactedDetail ? ` -- ${redactedDetail}` : ''}`;
        entries.push(truncateBytes(composed, MAX_EVIDENCE_ENTRY_BYTES));
      }
    }
    if (entries.length >= MAX_EVIDENCE_ENTRIES) break;
  }
  for (const blocker of repairOutcome.blockers) {
    const redactedDetail = blocker.detail ? redactSecretContent(blocker.detail) : '';
    entries.push(truncateBytes(`${blocker.reason}${redactedDetail ? `: ${redactedDetail}` : ''}`, MAX_EVIDENCE_ENTRY_BYTES));
  }
  return entries.slice(0, MAX_EVIDENCE_ENTRIES);
}

/** Top-level `blockers`: the RepairOutcome's own top-level blocker(s), plus the specific blocker Phase 8's own evidence identified as decisive for the gate -- never a re-derivation of Phase 8's classification logic. Every `detail` is Secret-Guarded before truncation. */
function buildBlockers(repairOutcome, gateResult) {
  const entries = repairOutcome.blockers.map((blocker) => ({
    reason: blocker.reason ?? null,
    detail: blocker.detail ? sanitizeAndTruncate(blocker.detail, MAX_BLOCKER_DETAIL_BYTES) : null,
  }));
  const evidenceBlocker = gateResult.evidence?.blocker;
  if (evidenceBlocker && (evidenceBlocker.code || evidenceBlocker.reason)) {
    entries.push({
      reason: evidenceBlocker.code ?? evidenceBlocker.reason,
      detail: evidenceBlocker.detail ? sanitizeAndTruncate(evidenceBlocker.detail, MAX_BLOCKER_DETAIL_BYTES) : null,
    });
  }
  return entries.slice(0, MAX_BLOCKERS);
}

/**
 * Assembles the canonical x-result-v1 record from Phase 6/7/8 evidence.
 * Never mutates `task`, `repairOutcome`, or `gateResult`. Returns a deeply
 * frozen object.
 *
 * @param {object} task validated x-task-v1
 * @param {object} repairOutcome the frozen object returned by `runTaskWithRepair` (repair-loop.mjs)
 * @param {object} gateResult the frozen object returned by `evaluateResultGate` (result-gate.mjs)
 * @param {{ resultId?: string }} [options]
 */
export function buildXResult(task, repairOutcome, gateResult, options = {}) {
  assertTaskShape(task);
  assertRepairOutcomeShape(repairOutcome);
  assertGateResultShape(gateResult);
  assertCrossInputConsistency(task, repairOutcome, gateResult);
  const resultId = resolveResultId(options.resultId);

  const filesChanged = buildFilesChanged(repairOutcome);
  const validation = buildValidationEntries(task, repairOutcome).map((entry) => Object.freeze(entry));
  const changeSummary = buildChangeSummary(repairOutcome).map((entry) => Object.freeze(entry));
  const evidenceFound = buildEvidenceFound(task, repairOutcome);
  const blockers = buildBlockers(repairOutcome, gateResult).map((entry) => Object.freeze(entry));

  return Object.freeze({
    version: X_RESULT_VERSION,
    result_id: resultId,
    task_id: task.task_id,
    parent_task_id: task.parent_task_id ?? null,
    revision: task.revision,
    attempt: task.attempt,

    gate_status: gateResult.gate_status,
    hearth_outcome: gateResult.hearth_outcome,
    waiting_reason: gateResult.waiting_reason,
    reason_code: gateResult.reason_code,

    root_cause: null,
    evidence_found: Object.freeze(evidenceFound),

    files_changed: Object.freeze(filesChanged),
    change_summary: Object.freeze(changeSummary),
    why_fix_works: null,

    validation: Object.freeze(validation),

    repair_attempts: Math.max(0, repairOutcome.total_rounds - 1),

    final_diff_summary: Object.freeze({
      files_changed: filesChanged.length,
      insertions: null,
      deletions: null,
    }),

    commit: Object.freeze({ created: false, sha: null, branch: null }),

    lesson_candidate: null,
    remaining_risks: Object.freeze([]),
    blockers: Object.freeze(blockers),
    next_recommended_action: null,

    timing: Object.freeze({
      estimated_minutes: task.timing?.estimated_minutes ?? null,
      actual_minutes: null,
      validation_minutes: computeValidationMinutes(repairOutcome),
      repair_minutes: null,
    }),
  });
}
