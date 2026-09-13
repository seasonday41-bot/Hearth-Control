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
    return this.runToolLoop('chat', withCompactContext(request));
  }

  async stream(request = {}) {
    return this.runToolLoop('chatStream', withCompactContext(request));
  }

  async runToolLoop(method, request) {
    if (request.provider !== 'local') return this.selection[method](request);
    const gateway = request.gateway;
    const messages = [...(request.messages || [])];
    const maxSteps = Math.max(0, Math.min(6, Number(gateway?.maxToolSteps || 0)));
    const prompt = [...messages].reverse().find((message) => message.role === 'user')?.content || '';
    const mode = groundingMode(prompt);
    const tools = gateway && maxSteps > 0 && ['repo', 'ui', 'git'].includes(mode) ? LOCAL_SKILL_TOOLS : undefined;
    const facts = authoritativeLocalFacts(request);
    const productPacket = mode === 'product' ? createProductFactPacket(facts) : null;
    if (productPacket) {
      const contract = `Hearth product fact selection. Return ONLY JSON of the form {"claims":[{"factId":"LOCAL_CHAT_AVAILABLE"}]}. Choose fact IDs only from available. Do not include an answer, prose, or unknown IDs. Hearth will render the user-visible answer. Fact packet: ${JSON.stringify(productPacket)}`;
      if (messages[0]?.role === 'system') messages[0] = { ...messages[0], content: `${messages[0].content}\n\n${contract}` };
      else messages.unshift({ role: 'system', content: contract });
    }
    const trace = createEvidenceTrace(prompt, mode);
    const needsGate = mode !== 'conversation';
    let steps = 0;
    let correctionPending = false;
    let claimRetry = false;
    const attemptedSearches = new Set();
    let emptySearches = 0;
    const finish = async (result, response) => {
      if (needsGate && method === 'chatStream' && response) await request.onChunk?.(response);
      return { ...result, response, toolCalls: undefined };
    };
    const incomplete = async (result = {}) => {
      await request.onActivity?.({ type: 'evidence_incomplete', skill: 'evidence', resultCount: trace.records.length });
      return finish({ ok: true, provider: 'ollama', ...result, toolLimitReached: steps >= maxSteps }, safeGroundingResponse(mode, facts, prompt));
    };
    while (true) {
      if (request.signal?.aborted) return { ok: false, provider: 'ollama', error: { code: 'CANCELLED', message: 'chat request was cancelled', status: null, retryable: false } };
      let buffered = '';
      const result = await this.selection[method]({ ...request, messages, tools: steps < maxSteps ? tools : undefined, gateway: undefined, onActivity: undefined,
        onChunk: needsGate && method === 'chatStream' ? async (chunk) => { buffered += chunk; } : request.onChunk });
      if (!result?.ok) {
        if (needsGate && result?.response) {
          const partial = result.response || buffered;
          const safePartial = mode === 'product' || ['repo', 'ui', 'git'].includes(mode) && !trace.check(partial).ok
            ? safeGroundingResponse(mode, facts, prompt) : partial;
          return result.error?.code === 'CANCELLED' ? finish(result, safePartial) : { ...result, response: safePartial };
        }
        return result;
      }
      if (Array.isArray(result.toolCalls) && result.toolCalls.length > 0 && gateway && tools) {
        if (steps + result.toolCalls.length > maxSteps) return incomplete();
        messages.push({ role: 'assistant', content: result.response || '', tool_calls: result.toolCalls });
        for (const call of result.toolCalls) {
          if (request.signal?.aborted) return { ok: false, provider: 'ollama', error: { code: 'CANCELLED', message: 'chat request was cancelled', status: null, retryable: false } };
          const name = call?.function?.name || call?.name;
          let args = call?.function?.arguments ?? call?.arguments ?? {};
          if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
          const searchKey = name === 'file_search' ? `${String(args?.path || '')}\u0000${String(args?.query || '').trim().toLowerCase()}` : null;
          if (searchKey && attemptedSearches.has(searchKey)) {
            messages.push({ role: 'tool', content: JSON.stringify({ ok: true, skill: name, skipped: true, reason: 'equivalent search already attempted; broaden the query or inspect a likely production file' }), tool_name: name });
            continue;
          }
          if (searchKey) attemptedSearches.add(searchKey);
          steps += 1;
          await request.onActivity?.({ type: 'skill_started', skill: name || 'unknown', step: steps });
          const startedAt = Date.now();
          const toolResult = await gateway.execute(name, args).catch((error) => ({ ok: false, skill: name, error: { code: error.code || 'SKILL_ERROR', message: error.message || 'Skill failed' } }));
          if (name === 'file_search' && toolResult.ok && !(toolResult.result?.matches || []).length) emptySearches += 1;
          const before = trace.records.length;
          trace.add(name, args, toolResult);
          await request.onActivity?.({ type: toolResult.ok ? 'skill_completed' : 'skill_failed', skill: name || 'unknown', elapsedMs: Date.now() - startedAt, resultCount: toolResult.result?.matches?.length ?? toolResult.result?.entries?.length ?? undefined });
          const progression = trace.records.slice(before);
          for (const stage of ['SOURCE', 'TRANSFORM', 'OUTPUT']) {
            const evidence = progression.find((item) => item.stage === stage);
            if (evidence) await request.onActivity?.({ type: 'evidence_progress', skill: name || 'unknown', stage, relativePath: evidence.path, resultCount: progression.filter((item) => item.stage === stage).length });
          }
          messages.push({ role: 'tool', content: JSON.stringify(toolResult), tool_name: name || 'unknown' });
        }
        correctionPending = false;
        continue;
      }
      const answer = result.response || buffered;
      if (mode === 'product') {
        const validation = validateProductClaims(answer, productPacket);
        if (validation.ok) return finish(result, renderProductFacts(productPacket, validation.factIds, prompt));
        if (!claimRetry) {
          claimRetry = true;
          messages.push({ role: 'user', content: `Hearth fact contract rejected: ${validation.reason}. Retry once with JSON claims containing only available factId values. No answer or prose. Fact packet: ${JSON.stringify(productPacket)}` });
          continue;
        }
        return finish(result, safeGroundingResponse(mode, facts, prompt));
      }
      if (mode === 'repo' || mode === 'ui' || mode === 'git') {
        const validation = trace.check(answer);
        if (validation.ok) {
          await request.onActivity?.({ type: 'evidence_complete', skill: 'evidence', resultCount: trace.records.length });
          return finish(result, answer);
        }
        if (!gateway || steps >= maxSteps || correctionPending) return incomplete();
        correctionPending = true;
        const strategy = emptySearches >= 1 ? 'Broaden the query or use repo_list to discover production source before searching again; do not repeat an equivalent empty search.' : 'Start with production source discovery, then read the candidate file.';
        messages.push({ role: 'user', content: `Hearth evidence check: ${validation.reason}. The preceding results are only candidates. ${strategy} Use available read-only tools to collect and cite real path:line evidence. For a displayed UI count, read the aggregation and rendered output lines. Do not answer until the trace is complete. Remaining tool calls: ${maxSteps - steps}.` });
        continue;
      }
      return result;
    }
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
import { LOCAL_SKILL_TOOLS } from '../skills/gateway.mjs';
import { authoritativeLocalFacts, createEvidenceTrace, createProductFactPacket, groundingMode, renderProductFacts, safeGroundingResponse, validateProductClaims } from './grounding.mjs';
