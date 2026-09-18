import { executeTask } from './local-executor.mjs';
import { runRequiredValidation, runOptionalValidation } from './validation-runner.mjs';
import { scopeCheck, XContextScopeError } from './context-loader.mjs';
import { throwIfAborted } from './cancellation.mjs';

/**
 * Orchestrates Phase 6 (`executeTask`) and Phase 7's own validation runner
 * across a bounded number of rounds, exactly as declared by the task's own
 * `repair_budget.max_total_rounds` (never more) -- this is the last piece
 * of "execute -> validate -> repair -> revalidate -> stop" from the phase
 * spec. It adds no new edit path: every round, repair or not, calls the
 * SAME unmodified `executeTask`. It adds no new queue/lease/concurrency
 * state: `runTaskWithRepair` is a plain function over one already-claimed
 * task, exactly like `executeTask` itself -- Phase 4's serial dispatcher
 * remains the sole authority for "only one task at a time."
 *
 * Failure classification is explicit and fail-closed (see
 * `FAILURE_CLASSIFICATION` below): a handful of executor outcomes are
 * `'repairable'` (worth spending a repair round on), everything else --
 * including any reason/code this table does not name -- is `'escalate'`.
 * There is no prose/content heuristic anywhere in this module; every
 * branch is keyed on a fixed reason or error code already produced by
 * Phase 6/5B.
 *
 * Required validation (`task.validation.required`) gates success: every
 * result must have `status === 'passed'` (Phase 7's own runValidation
 * authority -- exit code/signal/timeout only, never reporter text). A
 * required result of `status === 'invalid_command'` is treated as
 * structural, not repairable, and escalates immediately without spending
 * a repair round: the model never controls `task.validation.required` --
 * that string comes only from the task contract itself -- so no amount of
 * retrying the model's edit intent can ever fix a malformed or
 * unauthorized validation command. Optional validation
 * (`task.validation.optional`) runs only once required has passed, is
 * attached to evidence, and can never turn a `'validated'` outcome into
 * anything else.
 *
 * A repair round is built by `buildRepairTask`: it NEVER mutates the
 * original task object, NEVER changes `scope.allowed_paths` or
 * `scope.forbidden_paths`, and adds only the previous round's
 * successfully-changed files to `scope.preferred_files` -- itself
 * re-checked against the ORIGINAL `scope` via `scopeCheck` (the same
 * function Phase 5A/5B/6 use for every authorization decision), so a
 * theoretically-impossible out-of-scope entry could never slip through
 * even if some upstream invariant were ever violated. `preferred_files`
 * is already documented everywhere else in this codebase as a hint, never
 * a grant, so this can never widen what a repair round is authorized to
 * touch. This exists because Phase 6 correctly refuses to `replace`/
 * `patch` a file it was not shown a complete snapshot of -- a file the
 * PREVIOUS round created is otherwise invisible to the next round's model
 * call.
 *
 * Repair evidence fed back to the model is a small, bounded, deterministic
 * text block appended to `known_evidence` (never chain-of-thought, never
 * unbounded process output) -- see `buildRepairEvidence`.
 */

export const REPAIR_STATUSES = Object.freeze(['validated', 'escalation_required']);

export const FAILURE_CLASSIFICATION = Object.freeze({
  // Structural / authorization / schema violations -- retrying the same
  // model against the same scope will not change these facts.
  PATH_REJECTED: 'escalate',
  PROTECTED_PATH: 'escalate',
  SYMLINK_ESCAPE: 'escalate',
  UNREADABLE_TARGET: 'escalate',
  WRITE_FAILED: 'escalate',
  INVALID_SCOPE: 'escalate',
  PERMISSION_DENIED: 'escalate',
  context_load_failed: 'escalate',
  schema_invalid: 'escalate',
  unsupported_action: 'escalate',
  missing_field: 'escalate',
  too_many_actions: 'escalate',
  too_many_files: 'escalate',
  // Bounded / plausibly transient -- a repair round with fresh context or a
  // corrected response can reasonably resolve these.
  PRECONDITION_FAILED: 'repairable',
  WRITE_LIMIT_EXCEEDED: 'repairable',
  model_request_failed: 'repairable',
  malformed_json: 'repairable',
  response_too_large: 'repairable',
});

/** Any reason/code not in the table above is fail-closed to 'escalate' -- an unrecognized failure is never assumed repairable. */
export function classifyExecutorFailure(executorResult) {
  const blocker = executorResult?.blockers?.[0];
  const key = blocker?.code ?? blocker?.reason;
  return FAILURE_CLASSIFICATION[key] ?? 'escalate';
}

const MAX_EVIDENCE_BYTES = 2_000;
const MAX_EVIDENCE_TAIL_BYTES = 500;
const MAX_REPAIR_PREFERRED_FILES = 50;

const truncateText = (text, maxBytes) => {
  const buf = Buffer.from(String(text ?? ''), 'utf8');
  return buf.byteLength <= maxBytes ? String(text ?? '') : buf.subarray(0, maxBytes).toString('utf8');
};

const dedupe = (values) => [...new Set(values)];

/** A small, bounded, deterministic text summary of the round just attempted -- never chain-of-thought, never unbounded process output. */
function buildRepairEvidence(round) {
  const lines = [`Repair context from round ${round.round}:`];
  if (round.kind === 'execution') {
    const blocker = round.executor.blockers?.[0];
    const label = blocker?.code || blocker?.reason || 'unknown';
    lines.push(`Execution ${round.executor.status}: ${label} at '${blocker?.path ?? 'n/a'}' -- ${blocker?.detail ?? ''}`.trim());
    for (const change of round.executor.changes ?? []) {
      lines.push(`  ${change.operation} ${change.path}: ${change.status}${change.code ? ` (${change.code})` : ''}`);
    }
  } else {
    for (const result of round.validation.required) {
      const tail = truncateText(result.stderr || result.stdout || '', MAX_EVIDENCE_TAIL_BYTES);
      lines.push(`Validation '${result.command}': ${result.status}; exit ${result.exitCode ?? 'none'}${result.signal ? `; signal ${result.signal}` : ''}${result.timedOut ? '; timed out' : ''}`);
      if (tail) lines.push(`  tail: ${tail}`);
    }
  }
  return truncateText(lines.join('\n'), MAX_EVIDENCE_BYTES);
}

/**
 * Builds the next round's task. Never mutates `originalTask`. Preserves
 * `scope.allowed_paths`/`scope.forbidden_paths` verbatim. Adds only
 * previously-changed files that independently re-check as authorized
 * under the ORIGINAL scope to `scope.preferred_files` (a hint, never a
 * grant), bounded and deduped.
 */
function buildRepairTask(originalTask, rounds) {
  const changedFiles = dedupe(
    rounds.flatMap((round) => round.executor?.files_changed ?? [])
      .filter((filePath) => scopeCheck(filePath, originalTask.scope).ok),
  ).slice(0, MAX_REPAIR_PREFERRED_FILES);

  const evidence = buildRepairEvidence(rounds[rounds.length - 1]);

  return {
    ...originalTask,
    attempt: originalTask.attempt + rounds.length,
    known_evidence: [...(originalTask.known_evidence ?? []), evidence],
    scope: {
      ...originalTask.scope,
      allowed_paths: originalTask.scope.allowed_paths,
      forbidden_paths: originalTask.scope.forbidden_paths,
      preferred_files: dedupe([...(originalTask.scope.preferred_files ?? []), ...changedFiles]),
    },
  };
}

const finalize = (taskId, status, rounds, blockers = []) => Object.freeze({
  task_id: taskId,
  status,
  rounds: Object.freeze(rounds),
  total_rounds: rounds.length,
  blockers: Object.freeze(blockers),
});

/**
 * Runs one validated x-task-v1 through execute -> validate -> (repair ->
 * revalidate)* -> stop, bounded by `task.repair_budget.max_total_rounds`.
 * Never mutates `task`.
 *
 * @param {object} task validated x-task-v1
 * @param {{ generate: Function, cancel?: Function }} modelAdapter
 * @param {{ limits?: object, contextOptions?: object, writeLimits?: object, modelOptions?: object, validationLimits?: object, signal?: AbortSignal }} [options]
 * @returns {Promise<{ task_id, status: 'validated'|'escalation_required', rounds, total_rounds, blockers }>}
 */
export async function runTaskWithRepair(task, modelAdapter, options = {}) {
  throwIfAborted(options.signal);
  const maxTotalRounds = task?.repair_budget?.max_total_rounds;
  if (!Number.isInteger(maxTotalRounds) || maxTotalRounds < 1) {
    throw new TypeError('task.repair_budget.max_total_rounds must be a positive integer');
  }
  const taskId = typeof task?.task_id === 'string' ? task.task_id : null;
  const executorOptions = {
    limits: options.limits, contextOptions: options.contextOptions,
    writeLimits: options.writeLimits, modelOptions: options.modelOptions, signal: options.signal,
  };
  const validationOptions = { limits: options.validationLimits, signal: options.signal };

  const rounds = [];
  let roundTask = task;

  for (let round = 1; round <= maxTotalRounds; round += 1) {
    throwIfAborted(options.signal);
    let executorResult;
    try {
      // eslint-disable-next-line no-await-in-loop -- rounds are strictly sequential by design.
      executorResult = await executeTask(roundTask, modelAdapter, executorOptions);
    } catch (err) {
      throwIfAborted(options.signal);
      if (err instanceof XContextScopeError) {
        return finalize(taskId, 'escalation_required', rounds, [{ reason: 'invalid_task_scope', detail: err.message }]);
      }
      throw err;
    }
    throwIfAborted(options.signal);

    if (executorResult.status !== 'completed') {
      const classification = classifyExecutorFailure(executorResult);
      rounds.push(Object.freeze({ round, kind: 'execution', executor: executorResult, validation: null, classification }));
      if (classification === 'escalate' || round === maxTotalRounds) {
        return finalize(taskId, 'escalation_required', rounds);
      }
      roundTask = buildRepairTask(task, rounds);
      continue;
    }

    // eslint-disable-next-line no-await-in-loop -- rounds are strictly sequential by design.
    throwIfAborted(options.signal);
    const requiredResults = await runRequiredValidation(task, validationOptions);
    throwIfAborted(options.signal);

    // A malformed/unauthorized validation COMMAND is a task-authoring
    // defect, not something an edit retry can ever fix -- the model never
    // controls task.validation.required. Escalate immediately, spending
    // no repair round, regardless of how many rounds remain.
    const invalidCommand = requiredResults.find((result) => result.status === 'invalid_command');
    if (invalidCommand) {
      rounds.push(Object.freeze({
        round, kind: 'validation', executor: executorResult,
        validation: Object.freeze({ required: Object.freeze(requiredResults), optional: Object.freeze([]) }),
        classification: 'escalate',
      }));
      return finalize(taskId, 'escalation_required', rounds, [{ reason: 'invalid_validation_command', detail: invalidCommand.summary }]);
    }

    const requiredPassed = requiredResults.every((result) => result.status === 'passed');

    if (requiredPassed) {
      throwIfAborted(options.signal);
      // eslint-disable-next-line no-await-in-loop -- rounds are strictly sequential by design.
      const optionalResults = await runOptionalValidation(task, validationOptions);
      throwIfAborted(options.signal);
      rounds.push(Object.freeze({
        round, kind: 'validation', executor: executorResult,
        validation: Object.freeze({ required: Object.freeze(requiredResults), optional: Object.freeze(optionalResults) }),
        classification: null,
      }));
      return finalize(taskId, 'validated', rounds);
    }

    rounds.push(Object.freeze({
      round, kind: 'validation', executor: executorResult,
      validation: Object.freeze({ required: Object.freeze(requiredResults), optional: Object.freeze([]) }),
      classification: 'repairable',
    }));
    if (round === maxTotalRounds) {
      return finalize(taskId, 'escalation_required', rounds);
    }
    throwIfAborted(options.signal);
    roundTask = buildRepairTask(task, rounds);
  }

  // Unreachable given the loop bounds above; kept as a safe, explicit fallback.
  return finalize(taskId, 'escalation_required', rounds);
}
