/**
 * Provider-independent execution boundary. Lifecycle status remains owned by
 * Hearth; `outcome` is present only when the underlying executor is terminal.
 */
export const EXECUTOR_OUTCOMES = Object.freeze(['completed', 'waiting', 'error']);

const OUTCOME_BY_LIFECYCLE_STATUS = Object.freeze({
  done: 'completed',
  completed: 'completed',
  waiting: 'waiting',
  error: 'error',
});

/**
 * Preserves executor identity and evidence while exposing a common terminal
 * outcome. A live `running` result intentionally has `outcome: null`.
 */
export const normalizeExecutorResult = (result) => {
  if (!result || typeof result !== 'object') {
    throw new TypeError('Executor result must be an object.');
  }
  const lifecycleStatus = typeof result.status === 'string' ? result.status : null;
  return {
    ...result,
    lifecycleStatus,
    outcome: OUTCOME_BY_LIFECYCLE_STATUS[lifecycleStatus] || null,
  };
};

/** Validates the narrow executor surface without granting lifecycle ownership. */
export const assertExecutorContract = (executor) => {
  if (!executor || typeof executor !== 'object') {
    throw new TypeError('Executor must be an object.');
  }
  for (const method of ['run', 'resume', 'stop']) {
    if (typeof executor[method] !== 'function') {
      throw new TypeError(`Executor must implement ${method}().`);
    }
  }
  return executor;
};
