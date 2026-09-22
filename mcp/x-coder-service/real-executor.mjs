import { runTaskWithRepair } from '../x/repair-loop.mjs';
import { assertModelAdapterContract, createOllamaModelAdapter } from '../x/model-adapter.mjs';

/**
 * Production executor for the standalone X Coder Service.
 *
 * It owns no new execution logic: one service run delegates directly to the
 * established Core X repair loop, which in turn uses LocalExecutor,
 * ContextLoader, EditWriter, validation-runner, and the injected ModelAdapter.
 * The returned service result is the RepairOutcome verbatim; Result Gate and
 * x-result-v1 construction remain Hearth-side until Slice 8.
 */
export class RealXCoderExecutor {
  constructor({ modelAdapter, executionOptions = {} } = {}) {
    this.modelAdapter = assertModelAdapterContract(modelAdapter ?? createOllamaModelAdapter());
    if (!executionOptions || typeof executionOptions !== 'object' || Array.isArray(executionOptions)) {
      throw new TypeError('executionOptions must be an object.');
    }
    this.executionOptions = executionOptions;
  }

  async execute({ task, signal } = {}) {
    if (!task || typeof task !== 'object' || Array.isArray(task)) {
      throw new TypeError('RealXCoderExecutor requires a task.');
    }
    return runTaskWithRepair(task, this.modelAdapter, {
      ...this.executionOptions,
      signal,
    });
  }
}

export const createRealXCoderExecutor = (options = {}) => new RealXCoderExecutor(options);
