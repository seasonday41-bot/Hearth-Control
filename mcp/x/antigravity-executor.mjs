import {
  resumeAntigravityTask,
  startAntigravityTask,
  stopAntigravityTask,
} from '../executors/antigravity.mjs';
import { assertExecutorContract, normalizeExecutorResult } from './executor.mjs';

/**
 * Adapts the existing Antigravity lifecycle API without taking ownership of
 * tasks, child processes, durable jobs, continuation, or cancellation.
 */
export const createAntigravityExecutor = ({
  start = startAntigravityTask,
  resume = resumeAntigravityTask,
  stop = stopAntigravityTask,
} = {}) => {
  const executor = {
    async run(task) {
      return normalizeExecutorResult(await start(task));
    },

    async resume(task, checkpoint = {}) {
      if (!task || typeof task !== 'object') throw new TypeError('Task is required to resume.');
      if (!checkpoint || typeof checkpoint !== 'object') throw new TypeError('Checkpoint must be an object.');
      return normalizeExecutorResult(await resume({ ...task, ...checkpoint }));
    },

    async stop(taskId) {
      // Phase 1A is the sole Antigravity cancellation owner.
      await stop(taskId);
    },
  };
  return assertExecutorContract(executor);
};

export const antigravityExecutor = createAntigravityExecutor();
