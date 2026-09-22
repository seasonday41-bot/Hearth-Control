export const EXECUTOR_X_TASK_VERSION = 'x-task-v1';
export const EXECUTOR_REPAIR_LIMITS = Object.freeze({ initialAttempts: 1, maxRepairs: 2, maxTotalRounds: 3 });
export const EXECUTOR_COMMIT_POLICIES = Object.freeze(['never', 'require_user_approval', 'after_tests']);

const MAX_SCOPE_PATHS = 64;
const MAX_SCOPE_PATH_LENGTH = 1024;
const KNOWN_FIELDS = new Set([
  'version', 'task_id', 'parent_task_id', 'revision', 'attempt', 'based_on_result_id',
  'objective', 'problem', 'expected_behavior', 'observed_behavior', 'why_this_matters',
  'known_evidence', 'suspected_area', 'workspace', 'scope', 'constraints', 'allowed_tools',
  'acceptance_criteria', 'validation', 'verification', 'done_criteria', 'teaching_notes',
  'uncertainty_policy', 'uncertainty', 'repair_budget', 'timing', 'commit_policy',
]);

export class ExecutorTaskValidationError extends Error {
  constructor(errors) {
    super('Invalid x-task-v1 executor task: ' + errors.map((item) => item.path).join(', '));
    this.name = 'ExecutorTaskValidationError';
    this.code = 'INVALID_EXECUTOR_X_TASK';
    this.errors = errors;
  }
}

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
const isNonEmptyString = (value) => typeof value === 'string' && Boolean(value.trim());
const addError = (errors, path, code, message) => errors.push({ path, code, message });
const clone = (value) => structuredClone(value);

const normalizedPath = (value) => {
  if (!isNonEmptyString(value)) return null;
  const normalized = value.trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!normalized || normalized === '.' || normalized.startsWith('/') || normalized.includes('\0') ||
      normalized.split('/').includes('..')) return null;
  return normalized;
};

const pathsOverlap = (left, right) =>
  left === right || left.startsWith(right + '/') || right.startsWith(left + '/');

const validateStringArray = (errors, value, path, options = {}) => {
  const required = options.required !== false;
  const nonEmpty = options.nonEmpty === true;
  if (!Array.isArray(value)) {
    if (required) addError(errors, path, 'INVALID_TYPE', 'must be an array');
    return null;
  }
  if (nonEmpty && value.length === 0) addError(errors, path, 'REQUIRED', 'must not be empty');
  if (value.some((entry) => !isNonEmptyString(entry))) {
    addError(errors, path, 'INVALID_VALUE', 'must contain non-empty strings only');
  }
  return value.map((entry) => String(entry).trim());
};

const validateNullableId = (errors, value, path) => {
  if (value === null) return null;
  if (!isNonEmptyString(value)) addError(errors, path, 'INVALID_VALUE', 'must be a non-empty string or null');
  return typeof value === 'string' ? value.trim() : null;
};

const validateValidationBlock = (errors, task) => {
  if (task.validation !== undefined && !isPlainObject(task.validation)) {
    addError(errors, 'validation', 'INVALID_TYPE', 'must be an object');
    return;
  }
  const legacy = task.verification;
  if (task.validation === undefined && isPlainObject(legacy) &&
      Array.isArray(legacy.required) && Array.isArray(legacy.optional)) {
    validateStringArray(errors, legacy.required, 'verification.required', { nonEmpty: true });
    validateStringArray(errors, legacy.optional, 'verification.optional');
    return;
  }
  if (!task.validation) {
    addError(errors, 'validation.required', 'REQUIRED', 'explicit required validation is required');
    return;
  }
  validateStringArray(errors, task.validation.required, 'validation.required', { nonEmpty: true });
  validateStringArray(errors, task.validation.optional, 'validation.optional');
};

export const validateExecutorXTask = (input) => {
  const errors = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ path: '$', code: 'INVALID_TYPE', message: 'task must be an object' }] };
  }

  const task = clone(input);
  for (const field of Object.keys(task).sort()) {
    if (!KNOWN_FIELDS.has(field)) addError(errors, field, 'UNKNOWN_FIELD', 'is not part of x-task-v1');
  }

  if (task.version !== EXECUTOR_X_TASK_VERSION) {
    addError(errors, 'version', 'INVALID_VERSION', 'must equal x-task-v1');
  }

  for (const field of ['task_id', 'objective', 'problem', 'expected_behavior', 'observed_behavior', 'why_this_matters']) {
    if (!isNonEmptyString(task[field])) addError(errors, field, 'REQUIRED', 'must be a non-empty string');
  }

  if (!Number.isInteger(task.revision) || task.revision < 1) {
    addError(errors, 'revision', 'INVALID_VALUE', 'must be an integer >= 1');
  }
  if (!Number.isInteger(task.attempt) || task.attempt < 1) {
    addError(errors, 'attempt', 'INVALID_VALUE', 'must be an integer >= 1');
  }

  validateNullableId(errors, task.parent_task_id, 'parent_task_id');
  validateNullableId(errors, task.based_on_result_id, 'based_on_result_id');
  validateStringArray(errors, task.known_evidence, 'known_evidence');
  validateStringArray(errors, task.suspected_area, 'suspected_area');
  validateStringArray(errors, task.allowed_tools, 'allowed_tools');
  validateStringArray(errors, task.acceptance_criteria, 'acceptance_criteria', { nonEmpty: true });
  validateStringArray(errors, task.done_criteria, 'done_criteria', { nonEmpty: true });
  validateStringArray(errors, task.teaching_notes, 'teaching_notes');

  const scopedWorkspace = isPlainObject(task.scope) ? task.scope.workspace : undefined;
  const workspaceInput = task.workspace === undefined ? scopedWorkspace : task.workspace;
  let workspace = null;
  if (!isPlainObject(workspaceInput) || !isNonEmptyString(workspaceInput.repo) || !isNonEmptyString(workspaceInput.root)) {
    addError(errors, 'workspace', 'INVALID_VALUE', 'must contain non-empty repo and root strings');
  } else {
    workspace = { repo: workspaceInput.repo.trim(), root: workspaceInput.root.trim() };
    if (task.workspace !== undefined && scopedWorkspace !== undefined &&
        (!isPlainObject(scopedWorkspace) || scopedWorkspace.repo !== workspace.repo || scopedWorkspace.root !== workspace.root)) {
      addError(errors, 'scope.workspace', 'CONFLICT', 'must match workspace when supplied');
    }
  }

  if (!isPlainObject(task.scope)) {
    addError(errors, 'scope', 'INVALID_TYPE', 'must be an object');
  } else {
    if (task.scope.workspace !== undefined &&
        (!workspace || !isPlainObject(task.scope.workspace) ||
         task.scope.workspace.repo !== workspace.repo || task.scope.workspace.root !== workspace.root)) {
      addError(errors, 'scope.workspace', 'CONFLICT', 'must match workspace when supplied');
    }

    const normalized = {};
    for (const field of ['allowed_paths', 'preferred_files', 'forbidden_paths']) {
      const values = task.scope[field];
      if (!Array.isArray(values)) {
        addError(errors, 'scope.' + field, 'INVALID_TYPE', 'must be an array');
        normalized[field] = null;
        continue;
      }
      if (field === 'allowed_paths' && values.length === 0) {
        addError(errors, 'scope.allowed_paths', 'REQUIRED', 'must not be empty');
      }
      if (values.length > MAX_SCOPE_PATHS) {
        addError(errors, 'scope.' + field, 'OUT_OF_BOUNDS', 'must contain at most 64 paths');
      }
      const clean = values.map(normalizedPath);
      if (clean.some((item) => !item || item.length > MAX_SCOPE_PATH_LENGTH)) {
        addError(errors, 'scope.' + field, 'OUT_OF_BOUNDS', 'must contain bounded workspace-relative paths');
      }
      normalized[field] = clean;
    }

    if (normalized.allowed_paths && normalized.forbidden_paths &&
        normalized.allowed_paths.some((allowed) =>
          normalized.forbidden_paths.some((forbidden) => allowed && forbidden && pathsOverlap(allowed, forbidden)))) {
      addError(errors, 'scope', 'CONFLICT', 'allowed_paths and forbidden_paths must not overlap');
    }

    if (task.scope.reference_paths !== undefined) {
      const values = task.scope.reference_paths;
      if (!Array.isArray(values)) {
        addError(errors, 'scope.reference_paths', 'INVALID_TYPE', 'must be an array');
      } else {
        if (values.length > MAX_SCOPE_PATHS) {
          addError(errors, 'scope.reference_paths', 'OUT_OF_BOUNDS', 'must contain at most 64 paths');
        }
        const clean = values.map(normalizedPath);
        if (clean.some((item) => !item || item.length > MAX_SCOPE_PATH_LENGTH)) {
          addError(errors, 'scope.reference_paths', 'OUT_OF_BOUNDS', 'must contain bounded workspace-relative paths');
        } else if (['allowed_paths', 'forbidden_paths'].some((field) =>
          (normalized[field] || []).some((other) => other && clean.some((ref) => pathsOverlap(ref, other))))) {
          addError(errors, 'scope.reference_paths', 'CONFLICT', 'reference_paths must not overlap allowed_paths or forbidden_paths');
        }
      }
    }
  }

  if (!isPlainObject(task.constraints)) {
    addError(errors, 'constraints', 'INVALID_TYPE', 'must be an object');
  } else {
    validateStringArray(errors, task.constraints.preserve, 'constraints.preserve');
    validateStringArray(errors, task.constraints.do_not, 'constraints.do_not');
  }

  validateValidationBlock(errors, task);

  let uncertaintyPolicy = task.uncertainty_policy;
  if (uncertaintyPolicy === undefined && task.uncertainty !== undefined) uncertaintyPolicy = task.uncertainty;
  if (!isPlainObject(uncertaintyPolicy) || !isNonEmptyString(uncertaintyPolicy.policy)) {
    addError(errors, 'uncertainty_policy', 'INVALID_VALUE', 'must contain a non-empty policy');
  } else {
    validateStringArray(errors, uncertaintyPolicy.stop_conditions, 'uncertainty_policy.stop_conditions');
  }

  if (!isPlainObject(task.repair_budget)) {
    addError(errors, 'repair_budget', 'INVALID_TYPE', 'must be an object');
  } else {
    const initialAttempts = task.repair_budget.initial_attempts;
    const maxRepairs = task.repair_budget.max_repairs;
    const maxTotalRounds = task.repair_budget.max_total_rounds;
    if (initialAttempts !== EXECUTOR_REPAIR_LIMITS.initialAttempts) {
      addError(errors, 'repair_budget.initial_attempts', 'INVALID_VALUE', 'must equal canonical initial attempt count');
    }
    if (!Number.isInteger(maxRepairs) || maxRepairs < 0 || maxRepairs > EXECUTOR_REPAIR_LIMITS.maxRepairs) {
      addError(errors, 'repair_budget.max_repairs', 'OUT_OF_BOUNDS', 'exceeds canonical repair maximum');
    }
    if (!Number.isInteger(maxTotalRounds) || maxTotalRounds < initialAttempts ||
        maxTotalRounds > EXECUTOR_REPAIR_LIMITS.maxTotalRounds ||
        maxTotalRounds > initialAttempts + maxRepairs) {
      addError(errors, 'repair_budget.max_total_rounds', 'OUT_OF_BOUNDS', 'exceeds canonical total-round maximum');
    }
  }

  if (!isPlainObject(task.timing)) {
    addError(errors, 'timing', 'INVALID_TYPE', 'must be an object');
  } else {
    const fields = ['estimated_minutes', 'first_check_after_minutes', 'soft_deadline_minutes', 'hard_timeout_minutes'];
    if (fields.some((field) => !Number.isInteger(task.timing[field]) || task.timing[field] <= 0)) {
      addError(errors, 'timing', 'INVALID_VALUE', 'all timing values must be positive integers');
    }
    if (!(task.timing.first_check_after_minutes <= task.timing.soft_deadline_minutes &&
          task.timing.soft_deadline_minutes <= task.timing.hard_timeout_minutes)) {
      addError(errors, 'timing', 'INVALID_ORDER', 'invalid timing order');
    }
  }

  const commitMode = typeof task.commit_policy === 'string' ? task.commit_policy : task.commit_policy?.mode;
  if (!EXECUTOR_COMMIT_POLICIES.includes(commitMode)) {
    addError(errors, 'commit_policy', 'INVALID_VALUE', 'must be a supported commit policy');
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: task };
};

export const parseExecutorXTask = (input) => {
  const result = validateExecutorXTask(input);
  if (!result.ok) throw new ExecutorTaskValidationError(result.errors);
  return result.value;
};
