import { redactSecretContent } from '../x/secret-guard.mjs';

export const HEARTH_JOB_VERSION = 'hearth-job-v1';
export const HEARTH_JOB_KINDS = Object.freeze(['code_change', 'code_inspect', 'general']);

const KNOWN_FIELDS = new Set([
  'version', 'job_id', 'kind', 'title', 'objective',
  'problem', 'expected_behavior', 'observed_behavior', 'why_this_matters',
  'known_evidence', 'suspected_area', 'scope', 'constraints',
  'acceptance_criteria', 'validation', 'done_criteria', 'stop_conditions',
]);

const MAX_TEXT = 8000;
const MAX_ARRAY_ITEMS = 64;
const MAX_ARRAY_TEXT = 4000;
const MAX_PATH_LENGTH = 1024;

export class HearthJobValidationError extends Error {
  constructor(errors) {
    super(`Invalid ${HEARTH_JOB_VERSION}: ${errors.map((item) => item.path).join(', ')}`);
    this.name = 'HearthJobValidationError';
    this.code = 'INVALID_HEARTH_JOB';
    this.errors = errors;
  }
}

const isPlainObject = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const cleanText = (value, { required = false, max = MAX_TEXT } = {}) => {
  if (value == null) return required ? null : '';
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (required && !text) return null;
  if (text.length > max) return null;
  return redactSecretContent(text);
};

const cleanStringArray = (value, path, errors, { required = false, nonEmpty = false } = {}) => {
  if (value == null && !required) return [];
  if (!Array.isArray(value)) {
    errors.push({ path, code: 'INVALID_TYPE', message: 'must be an array' });
    return [];
  }
  if (value.length > MAX_ARRAY_ITEMS) {
    errors.push({ path, code: 'OUT_OF_BOUNDS', message: `must contain at most ${MAX_ARRAY_ITEMS} entries` });
  }
  if (nonEmpty && value.length === 0) {
    errors.push({ path, code: 'REQUIRED', message: 'must not be empty' });
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const text = cleanText(value[index], { required: true, max: MAX_ARRAY_TEXT });
    if (text == null) {
      errors.push({ path: `${path}[${index}]`, code: 'INVALID_VALUE', message: 'must be a bounded non-empty string' });
      continue;
    }
    result.push(text);
  }
  return result;
};

const normalizePath = (value) => {
  if (typeof value !== 'string') return null;
  const text = value.trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!text || text === '.' || text.startsWith('/') || text.includes('\0') || text.split('/').includes('..')) return null;
  if (text.length > MAX_PATH_LENGTH) return null;
  return text;
};

const cleanPathArray = (value, path, errors, { required = false, nonEmpty = false } = {}) => {
  if (value == null && !required) return [];
  if (!Array.isArray(value)) {
    errors.push({ path, code: 'INVALID_TYPE', message: 'must be an array' });
    return [];
  }
  if (value.length > MAX_ARRAY_ITEMS) errors.push({ path, code: 'OUT_OF_BOUNDS', message: 'too many paths' });
  if (nonEmpty && value.length === 0) errors.push({ path, code: 'REQUIRED', message: 'must not be empty' });
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const normalized = normalizePath(value[index]);
    if (!normalized) {
      errors.push({ path: `${path}[${index}]`, code: 'INVALID_PATH', message: 'must be a workspace-relative path' });
      continue;
    }
    result.push(normalized);
  }
  return result;
};

const overlap = (left, right) =>
  left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);

export const validateHearthJob = (input) => {
  const errors = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ path: '$', code: 'INVALID_TYPE', message: 'job must be an object' }] };
  }

  for (const field of Object.keys(input).sort()) {
    if (!KNOWN_FIELDS.has(field)) errors.push({ path: field, code: 'UNKNOWN_FIELD', message: 'is not part of hearth-job-v1' });
  }

  if (input.version !== HEARTH_JOB_VERSION) {
    errors.push({ path: 'version', code: 'INVALID_VERSION', message: `must equal ${HEARTH_JOB_VERSION}` });
  }

  const jobId = cleanText(input.job_id, { required: true, max: 128 });
  if (!jobId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(jobId)) {
    errors.push({ path: 'job_id', code: 'INVALID_VALUE', message: 'must be a stable bounded identifier' });
  }

  if (!HEARTH_JOB_KINDS.includes(input.kind)) {
    errors.push({ path: 'kind', code: 'INVALID_VALUE', message: `must be one of ${HEARTH_JOB_KINDS.join(', ')}` });
  }

  const title = cleanText(input.title, { max: 200 });
  if (input.title != null && title == null) errors.push({ path: 'title', code: 'INVALID_VALUE', message: 'must be a bounded string' });

  const objective = cleanText(input.objective, { required: true });
  if (!objective) errors.push({ path: 'objective', code: 'REQUIRED', message: 'must be a non-empty bounded string' });

  const optionalText = {};
  for (const field of ['problem', 'expected_behavior', 'observed_behavior', 'why_this_matters']) {
    const value = cleanText(input[field]);
    if (input[field] != null && value == null) errors.push({ path: field, code: 'INVALID_VALUE', message: 'must be a bounded string' });
    optionalText[field] = value || '';
  }

  const knownEvidence = cleanStringArray(input.known_evidence, 'known_evidence', errors);
  const suspectedArea = cleanPathArray(input.suspected_area, 'suspected_area', errors);

  const isCode = input.kind === 'code_change' || input.kind === 'code_inspect';
  let scope = null;
  if (input.scope != null || isCode) {
    if (!isPlainObject(input.scope)) {
      errors.push({ path: 'scope', code: 'INVALID_TYPE', message: 'must be an object for code jobs' });
      scope = { allowed_paths: [], preferred_files: [], forbidden_paths: [] };
    } else {
      const scopeKnown = new Set(['allowed_paths', 'preferred_files', 'forbidden_paths']);
      for (const field of Object.keys(input.scope)) {
        if (!scopeKnown.has(field)) errors.push({ path: `scope.${field}`, code: 'UNKNOWN_FIELD', message: 'is not supported' });
      }
      const allowed = cleanPathArray(input.scope.allowed_paths, 'scope.allowed_paths', errors, { required: isCode, nonEmpty: isCode });
      const preferred = cleanPathArray(input.scope.preferred_files, 'scope.preferred_files', errors);
      const forbidden = cleanPathArray(input.scope.forbidden_paths, 'scope.forbidden_paths', errors);
      if (allowed.some((a) => forbidden.some((b) => overlap(a, b)))) {
        errors.push({ path: 'scope', code: 'CONFLICT', message: 'allowed_paths and forbidden_paths must not overlap' });
      }
      scope = { allowed_paths: allowed, preferred_files: preferred, forbidden_paths: forbidden };
    }
  }

  let constraints = { preserve: [], do_not: [] };
  if (input.constraints != null) {
    if (!isPlainObject(input.constraints)) {
      errors.push({ path: 'constraints', code: 'INVALID_TYPE', message: 'must be an object' });
    } else {
      const known = new Set(['preserve', 'do_not']);
      for (const field of Object.keys(input.constraints)) {
        if (!known.has(field)) errors.push({ path: `constraints.${field}`, code: 'UNKNOWN_FIELD', message: 'is not supported' });
      }
      constraints = {
        preserve: cleanStringArray(input.constraints.preserve, 'constraints.preserve', errors),
        do_not: cleanStringArray(input.constraints.do_not, 'constraints.do_not', errors),
      };
    }
  }

  const acceptanceCriteria = cleanStringArray(
    input.acceptance_criteria,
    'acceptance_criteria',
    errors,
    { required: isCode, nonEmpty: isCode },
  );

  let validation = { required: [], optional: [] };
  if (input.validation != null || isCode) {
    if (!isPlainObject(input.validation)) {
      errors.push({ path: 'validation', code: 'INVALID_TYPE', message: 'must be an object for code jobs' });
    } else {
      const known = new Set(['required', 'optional']);
      for (const field of Object.keys(input.validation)) {
        if (!known.has(field)) errors.push({ path: `validation.${field}`, code: 'UNKNOWN_FIELD', message: 'is not supported' });
      }
      validation = {
        required: cleanStringArray(input.validation.required, 'validation.required', errors, { required: isCode, nonEmpty: isCode }),
        optional: cleanStringArray(input.validation.optional, 'validation.optional', errors),
      };
    }
  }

  const doneCriteria = cleanStringArray(input.done_criteria, 'done_criteria', errors);
  const stopConditions = cleanStringArray(input.stop_conditions, 'stop_conditions', errors);

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      version: HEARTH_JOB_VERSION,
      job_id: jobId,
      kind: input.kind,
      title: title || '',
      objective,
      problem: optionalText.problem,
      expected_behavior: optionalText.expected_behavior,
      observed_behavior: optionalText.observed_behavior,
      why_this_matters: optionalText.why_this_matters,
      known_evidence: knownEvidence,
      suspected_area: suspectedArea,
      scope,
      constraints,
      acceptance_criteria: acceptanceCriteria,
      validation,
      done_criteria: doneCriteria,
      stop_conditions: stopConditions,
    },
  };
};

export const parseHearthJob = (input) => {
  const result = validateHearthJob(input);
  if (!result.ok) throw new HearthJobValidationError(result.errors);
  return result.value;
};
