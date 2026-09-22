import { parseExecutorXTask, validateExecutorXTask } from './x-task.schema.mjs';

export const EXECUTOR_API_VERSION = 'x-executor-api-v1';

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
const isNonEmptyString = (value) => typeof value === 'string' && Boolean(value.trim());

export class ExecutorApiValidationError extends Error {
  constructor(errors) {
    super('Invalid executor API payload: ' + errors.map((item) => item.path).join(', '));
    this.name = 'ExecutorApiValidationError';
    this.code = 'INVALID_EXECUTOR_API_PAYLOAD';
    this.errors = errors;
  }
}

const rejectUnknownFields = (input, known, errors) => {
  for (const field of Object.keys(input).sort()) {
    if (!known.has(field)) errors.push({ path: field, code: 'UNKNOWN_FIELD', message: 'is not allowed' });
  }
};

const validateEnvelopeVersion = (input, errors) => {
  if (input.version !== EXECUTOR_API_VERSION) {
    errors.push({ path: 'version', code: 'INVALID_VERSION', message: 'must equal ' + EXECUTOR_API_VERSION });
  }
};

const finalize = (errors, value) => errors.length > 0 ? { ok: false, errors } : { ok: true, value };

export const validateSubmitRequest = (input) => {
  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ path: '$', code: 'INVALID_TYPE', message: 'request must be an object' }] };
  }
  const errors = [];
  rejectUnknownFields(input, new Set(['version', 'idempotency_key', 'task', 'lease_expires_at']), errors);
  validateEnvelopeVersion(input, errors);
  if (!isNonEmptyString(input.idempotency_key) || input.idempotency_key.trim().length > 256) {
    errors.push({ path: 'idempotency_key', code: 'INVALID_VALUE', message: 'must be a non-empty string up to 256 characters' });
  }
  if (!Number.isInteger(input.lease_expires_at) || input.lease_expires_at <= 0) {
    errors.push({ path: 'lease_expires_at', code: 'INVALID_VALUE', message: 'must be a positive epoch-millisecond integer' });
  }
  const taskResult = validateExecutorXTask(input.task);
  if (!taskResult.ok) {
    for (const item of taskResult.errors) {
      errors.push({ ...item, path: 'task.' + item.path });
    }
  }
  return finalize(errors, {
    version: EXECUTOR_API_VERSION,
    idempotency_key: typeof input.idempotency_key === 'string' ? input.idempotency_key.trim() : input.idempotency_key,
    lease_expires_at: input.lease_expires_at,
    task: taskResult.ok ? taskResult.value : input.task,
  });
};

const validateRunRequest = (input, operation) => {
  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ path: '$', code: 'INVALID_TYPE', message: operation + ' request must be an object' }] };
  }
  const errors = [];
  rejectUnknownFields(input, new Set(['version', 'run_id']), errors);
  validateEnvelopeVersion(input, errors);
  if (!isNonEmptyString(input.run_id)) {
    errors.push({ path: 'run_id', code: 'REQUIRED', message: 'must be a non-empty string' });
  }
  return finalize(errors, {
    version: EXECUTOR_API_VERSION,
    run_id: typeof input.run_id === 'string' ? input.run_id.trim() : input.run_id,
  });
};

export const validateStatusRequest = (input) => validateRunRequest(input, 'status');
export const validateCancelRequest = (input) => validateRunRequest(input, 'cancel');

export const validateLeaseValidRequest = (input) => {
  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ path: '$', code: 'INVALID_TYPE', message: 'lease-valid request must be an object' }] };
  }
  const errors = [];
  rejectUnknownFields(input, new Set(['version', 'run_id', 'lease_expires_at']), errors);
  validateEnvelopeVersion(input, errors);
  if (!isNonEmptyString(input.run_id)) {
    errors.push({ path: 'run_id', code: 'REQUIRED', message: 'must be a non-empty string' });
  }
  if (!Number.isInteger(input.lease_expires_at) || input.lease_expires_at <= 0) {
    errors.push({ path: 'lease_expires_at', code: 'INVALID_VALUE', message: 'must be a positive epoch-millisecond integer' });
  }
  return finalize(errors, {
    version: EXECUTOR_API_VERSION,
    run_id: typeof input.run_id === 'string' ? input.run_id.trim() : input.run_id,
    lease_expires_at: input.lease_expires_at,
  });
};

const parseWith = (validator, input) => {
  const result = validator(input);
  if (!result.ok) throw new ExecutorApiValidationError(result.errors);
  return result.value;
};

export const parseSubmitRequest = (input) => {
  const parsed = parseWith(validateSubmitRequest, input);
  parsed.task = parseExecutorXTask(parsed.task);
  return parsed;
};
export const parseStatusRequest = (input) => parseWith(validateStatusRequest, input);
export const parseCancelRequest = (input) => parseWith(validateCancelRequest, input);
export const parseLeaseValidRequest = (input) => parseWith(validateLeaseValidRequest, input);
