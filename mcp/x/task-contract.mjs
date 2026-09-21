export const X_TASK_VERSION = 'x-task-v1';
export const X_TASK_REPAIR_LIMITS = Object.freeze({ initialAttempts: 1, maxRepairs: 2, maxTotalRounds: 3 });
export const X_TASK_COMMIT_POLICIES = Object.freeze(['never', 'require_user_approval', 'after_tests']);

const MAX_SCOPE_PATHS = 64;
const MAX_SCOPE_PATH_LENGTH = 1024;
const KNOWN_FIELDS = new Set([
  'version', 'task_id', 'parent_task_id', 'revision', 'attempt', 'based_on_result_id',
  'objective', 'problem', 'expected_behavior', 'observed_behavior', 'why_this_matters',
  'known_evidence', 'suspected_area', 'workspace', 'scope', 'constraints', 'allowed_tools',
  'acceptance_criteria', 'validation', 'verification', 'done_criteria', 'teaching_notes',
  'uncertainty_policy', 'uncertainty', 'repair_budget', 'timing', 'commit_policy',
]);

export class XTaskValidationError extends Error {
  constructor(errors) {
    super(`Invalid ${X_TASK_VERSION} task: ${errors.map((error) => error.path).join(', ')}`);
    this.name = 'XTaskValidationError';
    this.code = 'INVALID_X_TASK';
    this.errors = errors;
  }
}

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const isNonEmptyString = (value) => typeof value === 'string' && Boolean(value.trim());
const error = (errors, path, code, message) => errors.push({ path, code, message });

const clone = (value) => structuredClone(value);

const normalizedPath = (value) => {
  if (!isNonEmptyString(value)) return null;
  const path = value.trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!path || path === '.' || path.startsWith('/') || path.includes('\0') || path.split('/').includes('..')) return null;
  return path;
};

const pathsOverlap = (left, right) => left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);

const validateStringArray = (errors, value, path, { required = true, nonEmpty = false } = {}) => {
  if (!Array.isArray(value)) {
    if (required) error(errors, path, 'INVALID_TYPE', 'must be an array');
    return null;
  }
  if (nonEmpty && value.length === 0) error(errors, path, 'REQUIRED', 'must not be empty');
  if (value.some((entry) => !isNonEmptyString(entry))) error(errors, path, 'INVALID_VALUE', 'must contain non-empty strings only');
  return value.map((entry) => String(entry).trim());
};

const validateNullableId = (errors, value, path) => {
  if (value === null) return null;
  if (!isNonEmptyString(value)) error(errors, path, 'INVALID_VALUE', 'must be a non-empty string or null');
  return typeof value === 'string' ? value.trim() : null;
};

const normalizeValidation = (errors, task) => {
  const validation = task.validation;
  const legacyVerification = task.verification;
  if (validation !== undefined && !isPlainObject(validation)) {
    error(errors, 'validation', 'INVALID_TYPE', 'must be an object');
    return null;
  }
  if (validation === undefined && isPlainObject(legacyVerification) &&
      Array.isArray(legacyVerification.required) && Array.isArray(legacyVerification.optional)) {
    return {
      required: validateStringArray(errors, legacyVerification.required, 'verification.required', { nonEmpty: true }),
      optional: validateStringArray(errors, legacyVerification.optional, 'verification.optional'),
    };
  }
  if (!validation) {
    error(errors, 'validation.required', 'REQUIRED', 'explicit required validation is required');
    return null;
  }
  return {
    required: validateStringArray(errors, validation.required, 'validation.required', { nonEmpty: true }),
    optional: validateStringArray(errors, validation.optional, 'validation.optional'),
  };
};

/**
 * Returns a deterministic validation result without mutating the input.
 * Unknown fields are rejected deliberately so task authority is explicit.
 */
export const validateXTask = (input) => {
  const errors = [];
  if (!isPlainObject(input)) return { ok: false, errors: [{ path: '$', code: 'INVALID_TYPE', message: 'task must be an object' }] };
  const task = clone(input);
  for (const field of Object.keys(task).sort()) {
    if (!KNOWN_FIELDS.has(field)) error(errors, field, 'UNKNOWN_FIELD', 'is not part of x-task-v1');
  }
  if (task.version !== X_TASK_VERSION) error(errors, 'version', 'INVALID_VERSION', `must equal ${X_TASK_VERSION}`);

  const requiredStrings = ['task_id', 'objective', 'problem', 'expected_behavior', 'observed_behavior', 'why_this_matters'];
  for (const field of requiredStrings) {
    if (!isNonEmptyString(task[field])) error(errors, field, 'REQUIRED', 'must be a non-empty string');
  }
  if (!Number.isInteger(task.revision) || task.revision < 1) error(errors, 'revision', 'INVALID_VALUE', 'must be an integer greater than or equal to 1');
  if (!Number.isInteger(task.attempt) || task.attempt < 1) error(errors, 'attempt', 'INVALID_VALUE', 'must be an integer greater than or equal to 1');

  const parentTaskId = validateNullableId(errors, task.parent_task_id, 'parent_task_id');
  const basedOnResultId = validateNullableId(errors, task.based_on_result_id, 'based_on_result_id');
  const knownEvidence = validateStringArray(errors, task.known_evidence, 'known_evidence');
  const suspectedArea = validateStringArray(errors, task.suspected_area, 'suspected_area');
  const allowedTools = validateStringArray(errors, task.allowed_tools, 'allowed_tools');
  const acceptanceCriteria = validateStringArray(errors, task.acceptance_criteria, 'acceptance_criteria', { nonEmpty: true });
  const doneCriteria = validateStringArray(errors, task.done_criteria, 'done_criteria', { nonEmpty: true });
  const teachingNotes = validateStringArray(errors, task.teaching_notes, 'teaching_notes');

  const scopedWorkspace = isPlainObject(task.scope) ? task.scope.workspace : undefined;
  const workspaceInput = task.workspace === undefined ? scopedWorkspace : task.workspace;
  let workspace = null;
  if (!isPlainObject(workspaceInput) || !isNonEmptyString(workspaceInput.repo) || !isNonEmptyString(workspaceInput.root)) {
    error(errors, 'workspace', 'INVALID_VALUE', 'must contain non-empty repo and root strings');
  } else {
    workspace = { repo: workspaceInput.repo.trim(), root: workspaceInput.root.trim() };
    if (task.workspace !== undefined && scopedWorkspace !== undefined &&
        (!isPlainObject(scopedWorkspace) || scopedWorkspace.repo !== workspace.repo || scopedWorkspace.root !== workspace.root)) {
      error(errors, 'scope.workspace', 'CONFLICT', 'must match workspace when supplied');
    }
  }

  let scope = null;
  if (!isPlainObject(task.scope)) {
    error(errors, 'scope', 'INVALID_TYPE', 'must be an object');
  } else {
    if (task.scope.workspace !== undefined) {
      if (!workspace || !isPlainObject(task.scope.workspace) || task.scope.workspace.repo !== workspace.repo || task.scope.workspace.root !== workspace.root) {
        error(errors, 'scope.workspace', 'CONFLICT', 'must match workspace when supplied');
      }
    }
    const pathFields = ['allowed_paths', 'preferred_files', 'forbidden_paths'];
    const normalized = {};
    for (const field of pathFields) {
      const values = task.scope[field];
      if (!Array.isArray(values)) {
        error(errors, `scope.${field}`, 'INVALID_TYPE', 'must be an array');
        normalized[field] = null;
        continue;
      }
      if (field === 'allowed_paths' && values.length === 0) error(errors, `scope.${field}`, 'REQUIRED', 'must not be empty');
      if (values.length > MAX_SCOPE_PATHS) error(errors, `scope.${field}`, 'OUT_OF_BOUNDS', `must contain at most ${MAX_SCOPE_PATHS} paths`);
      const clean = values.map(normalizedPath);
      if (clean.some((path) => !path || path.length > MAX_SCOPE_PATH_LENGTH)) {
        error(errors, `scope.${field}`, 'OUT_OF_BOUNDS', 'must contain bounded workspace-relative paths');
      }
      normalized[field] = clean;
    }
    if (normalized.allowed_paths && normalized.forbidden_paths && normalized.allowed_paths.some((allowed) => normalized.forbidden_paths.some((forbidden) => allowed && forbidden && pathsOverlap(allowed, forbidden)))) {
      error(errors, 'scope', 'CONFLICT', 'allowed_paths and forbidden_paths must not overlap');
    }
    // Optional explicit READ-ONLY reference authority (X v0.2 Slice 2). Absent means none: allowed_paths stays the whole
    // read AND write scope. Listed paths may be shown to the model as reference context, never edited, and must not overlap
    // allowed_paths (that would be ambiguous) or forbidden_paths. Only emitted when supplied, so existing task shapes are unchanged.
    if (task.scope.reference_paths !== undefined) {
      const values = task.scope.reference_paths;
      if (!Array.isArray(values)) {
        error(errors, 'scope.reference_paths', 'INVALID_TYPE', 'must be an array');
      } else {
        if (values.length > MAX_SCOPE_PATHS) error(errors, 'scope.reference_paths', 'OUT_OF_BOUNDS', `must contain at most ${MAX_SCOPE_PATHS} paths`);
        const clean = values.map(normalizedPath);
        if (clean.some((path) => !path || path.length > MAX_SCOPE_PATH_LENGTH)) {
          error(errors, 'scope.reference_paths', 'OUT_OF_BOUNDS', 'must contain bounded workspace-relative paths');
        } else if (['allowed_paths', 'forbidden_paths'].some((field) => (normalized[field] || []).some((other) => other && clean.some((ref) => pathsOverlap(ref, other))))) {
          error(errors, 'scope.reference_paths', 'CONFLICT', 'reference_paths must not overlap allowed_paths or forbidden_paths');
        }
        normalized.reference_paths = clean;
      }
    }
    scope = normalized;
  }

  let constraints = null;
  if (!isPlainObject(task.constraints)) {
    error(errors, 'constraints', 'INVALID_TYPE', 'must be an object');
  } else {
    constraints = {
      preserve: validateStringArray(errors, task.constraints.preserve, 'constraints.preserve'),
      do_not: validateStringArray(errors, task.constraints.do_not, 'constraints.do_not'),
    };
  }

  const validation = normalizeValidation(errors, task);
  let uncertaintyPolicy = task.uncertainty_policy;
  if (uncertaintyPolicy === undefined && task.uncertainty !== undefined) uncertaintyPolicy = task.uncertainty;
  if (!isPlainObject(uncertaintyPolicy) || !isNonEmptyString(uncertaintyPolicy.policy)) {
    error(errors, 'uncertainty_policy', 'INVALID_VALUE', 'must contain a non-empty policy');
    uncertaintyPolicy = null;
  } else {
    uncertaintyPolicy = {
      policy: uncertaintyPolicy.policy.trim(),
      stop_conditions: validateStringArray(errors, uncertaintyPolicy.stop_conditions, 'uncertainty_policy.stop_conditions'),
    };
  }

  let repairBudget = null;
  if (!isPlainObject(task.repair_budget)) {
    error(errors, 'repair_budget', 'INVALID_TYPE', 'must be an object');
  } else {
    const { initial_attempts: initialAttempts, max_repairs: maxRepairs, max_total_rounds: maxTotalRounds } = task.repair_budget;
    if (initialAttempts !== X_TASK_REPAIR_LIMITS.initialAttempts) error(errors, 'repair_budget.initial_attempts', 'INVALID_VALUE', 'must equal canonical initial attempt count');
    if (!Number.isInteger(maxRepairs) || maxRepairs < 0 || maxRepairs > X_TASK_REPAIR_LIMITS.maxRepairs) error(errors, 'repair_budget.max_repairs', 'OUT_OF_BOUNDS', 'exceeds canonical repair maximum');
    if (!Number.isInteger(maxTotalRounds) || maxTotalRounds < initialAttempts || maxTotalRounds > X_TASK_REPAIR_LIMITS.maxTotalRounds || maxTotalRounds > initialAttempts + maxRepairs) error(errors, 'repair_budget.max_total_rounds', 'OUT_OF_BOUNDS', 'exceeds canonical total-round maximum');
    repairBudget = { initial_attempts: initialAttempts, max_repairs: maxRepairs, max_total_rounds: maxTotalRounds };
  }

  let timing = null;
  if (!isPlainObject(task.timing)) {
    error(errors, 'timing', 'INVALID_TYPE', 'must be an object');
  } else {
    const fields = ['estimated_minutes', 'first_check_after_minutes', 'soft_deadline_minutes', 'hard_timeout_minutes'];
    if (fields.some((field) => !Number.isInteger(task.timing[field]) || task.timing[field] <= 0)) {
      error(errors, 'timing', 'INVALID_VALUE', 'all timing values must be positive integers');
    }
    if (!(task.timing.first_check_after_minutes <= task.timing.soft_deadline_minutes && task.timing.soft_deadline_minutes <= task.timing.hard_timeout_minutes)) {
      error(errors, 'timing', 'INVALID_ORDER', 'first check must be no later than soft deadline, which must be no later than hard timeout');
    }
    timing = Object.fromEntries(fields.map((field) => [field, task.timing[field]]));
  }

  const commitMode = typeof task.commit_policy === 'string' ? task.commit_policy : task.commit_policy?.mode;
  if (!X_TASK_COMMIT_POLICIES.includes(commitMode)) error(errors, 'commit_policy', 'INVALID_VALUE', 'must be never, require_user_approval, or after_tests');

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      version: X_TASK_VERSION,
      task_id: task.task_id.trim(),
      parent_task_id: parentTaskId,
      revision: task.revision,
      attempt: task.attempt,
      based_on_result_id: basedOnResultId,
      objective: task.objective.trim(),
      problem: task.problem.trim(),
      expected_behavior: task.expected_behavior.trim(),
      observed_behavior: task.observed_behavior.trim(),
      why_this_matters: task.why_this_matters.trim(),
      known_evidence: knownEvidence,
      suspected_area: suspectedArea,
      workspace,
      scope,
      constraints,
      allowed_tools: allowedTools,
      acceptance_criteria: acceptanceCriteria,
      validation,
      verification: task.verification === undefined ? null : clone(task.verification),
      done_criteria: doneCriteria,
      teaching_notes: teachingNotes,
      uncertainty_policy: uncertaintyPolicy,
      repair_budget: repairBudget,
      timing,
      commit_policy: { mode: commitMode },
    },
  };
};

export const parseXTask = (input) => {
  const result = validateXTask(input);
  if (!result.ok) throw new XTaskValidationError(result.errors);
  return result.value;
};
