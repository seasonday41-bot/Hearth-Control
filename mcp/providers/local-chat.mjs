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
    return this.selection.chat(withCompactContext(request));
  }

  async stream(request = {}) {
    return this.selection.chatStream(withCompactContext(request));
  }
}

const withCompactContext = (request = {}) => request.provider === 'local' && Array.isArray(request.messages)
  ? {
      ...request,
      messages: request.messages[0]?.role === 'system'
        ? [{ ...request.messages[0], content: `${buildLocalContext(request)}\n\n${request.messages[0].content || ''}` }, ...request.messages.slice(1)]
        : [{ role: 'system', content: buildLocalContext(request) }, ...request.messages],
    }
  : request;

export const createLocalChatCaller = (options) => new LocalChatCaller(options);
import { buildLocalContext } from '../context/builder.mjs';
