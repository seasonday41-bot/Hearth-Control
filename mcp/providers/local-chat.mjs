/**
 * Hearth-owned chat caller. It returns provider results only and has no task,
 * durable-job, continuation, completion, synchronization, or safety ownership.
 */
export class LocalChatCaller {
  constructor({ selection }) {
    if (!selection || typeof selection.chat !== 'function') throw new TypeError('LocalChatCaller requires provider selection');
    this.selection = selection;
  }

  async send(request = {}) {
    return this.selection.chat(request);
  }
}

export const createLocalChatCaller = (options) => new LocalChatCaller(options);
