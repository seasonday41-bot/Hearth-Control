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

const COMPACT_LOCAL_CONTEXT = 'Answer directly with short paragraphs and minimal preamble. Do not repeat the request. For coding tasks, introduce the approach briefly, provide code promptly, then add only a short explanation. Do not reveal hidden reasoning.';
const withCompactContext = (request = {}) => request.provider === 'local' && Array.isArray(request.messages)
  ? {
      ...request,
      messages: request.messages.some((message) => message?.role === 'system')
        ? request.messages
        : [{ role: 'system', content: COMPACT_LOCAL_CONTEXT }, ...request.messages],
    }
  : request;

export const createLocalChatCaller = (options) => new LocalChatCaller(options);
