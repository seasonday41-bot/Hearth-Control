/** Cooperative X execution cancellation, outside repair and Result Gate outcomes. */
export class XExecutionAbortedError extends Error {
  constructor() {
    super('X execution was aborted.');
    this.name = 'XExecutionAbortedError';
    this.code = 'X_EXECUTION_ABORTED';
  }
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw new XExecutionAbortedError();
}
