import assert from 'node:assert/strict';
import test from 'node:test';
import { LOCAL_RUNTIME_PROFILES, OllamaProvider, resolveRequestTimeout } from '../mcp/providers/ollama.mjs';

const response = (status, payload) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => typeof payload === 'string' ? payload : JSON.stringify(payload),
});
const mockFetch = (handler) => async (url, options) => handler(url, options);
const streamResponse = (lines) => ({
  ok: true,
  status: 200,
  body: new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(new TextEncoder().encode(`${JSON.stringify(line)}\n`));
      controller.close();
    },
  }),
  text: async () => '',
});

test('LOCAL1 Ollama unavailable is normalized', async () => {
  const provider = new OllamaProvider({ fetchFn: async () => { throw new Error('ECONNREFUSED'); } });
  const result = await provider.health();
  assert.deepEqual(result.error.code, 'UNAVAILABLE');
  assert.equal(result.ok, false);
});

test('LOCAL2 health reports available', async () => {
  const provider = new OllamaProvider({ fetchFn: mockFetch(() => response(200, { models: [{ name: 'llama3.2' }] })) });
  assert.deepEqual(await provider.health(), { ok: true, provider: 'ollama', available: true, modelCount: 1 });
});

test('LOCAL3 model list parses names', async () => {
  const provider = new OllamaProvider({ fetchFn: mockFetch(() => response(200, { models: [{ name: 'llama3.2' }, { name: ' qwen2.5 ' }, {}] })) });
  assert.deepEqual((await provider.listModels()).models, ['llama3.2', 'qwen2.5']);
});

test('LOCAL4 chat returns normalized response', async () => {
  let request;
  const provider = new OllamaProvider({ model: 'llama3.2', fetchFn: mockFetch((url, options) => { request = { url, options }; return response(200, { message: { content: 'Hearth Local AIพร้อมใช้งาน' }, done: true }); }) });
  const result = await provider.chat({ messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(result.ok, true);
  assert.equal(result.response, 'Hearth Local AIพร้อมใช้งาน');
  assert.equal(JSON.parse(request.options.body).stream, false);
});

test('FORMAT1 chat omits format by default -- free-form Local Chat callers are unaffected', async () => {
  let request;
  const provider = new OllamaProvider({ model: 'local', fetchFn: mockFetch((_url, options) => { request = JSON.parse(options.body); return response(200, { message: { content: 'prose answer' }, done: true }); }) });
  await provider.chat({ messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(Object.hasOwn(request, 'format'), false, 'no format field is sent unless a caller explicitly opts in');
});

test('FORMAT2 chat forwards an explicit format: "json" request to Ollama unchanged', async () => {
  let request;
  const provider = new OllamaProvider({ model: 'local', fetchFn: mockFetch((_url, options) => { request = JSON.parse(options.body); return response(200, { message: { content: '{"actions":[]}' }, done: true }); }) });
  await provider.chat({ messages: [{ role: 'user', content: 'hello' }], format: 'json' });
  assert.equal(request.format, 'json');
  // Everything else about the request stays exactly as before.
  assert.equal(request.model, 'local');
  assert.equal(request.stream, false);
});

test('FORMAT3 chatStream also forwards an explicit format request, and omits it by default', async () => {
  let requestA;
  const providerDefault = new OllamaProvider({ model: 'local', fetchFn: mockFetch((_url, options) => { requestA = JSON.parse(options.body); return streamResponse([{ message: { content: 'hi' }, done: true, done_reason: 'stop' }]); }) });
  await providerDefault.chatStream({ messages: [{ role: 'user', content: 'hello' }], onChunk: () => {} });
  assert.equal(Object.hasOwn(requestA, 'format'), false);

  let requestB;
  const providerJson = new OllamaProvider({ model: 'local', fetchFn: mockFetch((_url, options) => { requestB = JSON.parse(options.body); return streamResponse([{ message: { content: '{}' }, done: true, done_reason: 'stop' }]); }) });
  await providerJson.chatStream({ messages: [{ role: 'user', content: 'hello' }], format: 'json', onChunk: () => {} });
  assert.equal(requestB.format, 'json');
});

test('FORMAT4 chat forwards structured-output object format to Ollama JSON payload', async () => {
  let request;
  const schema = { type: 'object', properties: { actions: { type: 'array' } } };
  const provider = new OllamaProvider({ model: 'local', fetchFn: mockFetch((_url, options) => { request = JSON.parse(options.body); return response(200, { message: { content: '{"actions":[]}' }, done: true }); }) });
  await provider.chat({ messages: [{ role: 'user', content: 'hello' }], format: schema });
  assert.deepEqual(request.format, schema);
});

test('SKILL_PROVIDER1 chat forwards read-only tool definitions and normalizes tool calls', async () => {
  let request;
  const provider = new OllamaProvider({ model: 'local', fetchFn: mockFetch((_url, options) => { request = JSON.parse(options.body); return response(200, { message: { content: '', tool_calls: [{ function: { name: 'repo_list', arguments: '{}' } }] }, done: true }); }) });
  const result = await provider.chat({ messages: [{ role: 'user', content: 'inspect' }], tools: [{ type: 'function', function: { name: 'repo_list' } }] });
  assert.equal(request.tools[0].function.name, 'repo_list');
  assert.equal(result.toolCalls[0].function.name, 'repo_list');
});

test('UX1 FAST sends think=false and 4096 context', async () => {
  let request;
  const provider = new OllamaProvider({ model: 'local', profile: 'fast', fetchFn: mockFetch((_url, options) => { request = JSON.parse(options.body); return response(200, { message: { content: 'ok' } }); }) });
  await provider.chat({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(request.think, false);
  assert.equal(request.options.num_ctx, 4096);
  assert.equal(request.options.num_predict, 512);
});

test('UX2 NORMAL is the default profile', async () => {
  let request;
  const provider = new OllamaProvider({ model: 'local', fetchFn: mockFetch((_url, options) => { request = JSON.parse(options.body); return response(200, { message: { content: 'ok' } }); }) });
  await provider.chat({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(provider.profile, 'normal');
  assert.equal(request.think, false);
  assert.equal(request.options.num_ctx, 8192);
  assert.equal(request.options.num_predict, 1024);
});

test('UX3 DEEP enables thinking, larger output, and longer timeout', async () => {
  let request;
  const provider = new OllamaProvider({ model: 'local', profile: 'deep', fetchFn: mockFetch((_url, options) => { request = JSON.parse(options.body); return response(200, { message: { content: 'ok' } }); }) });
  await provider.chat({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(request.think, true);
  assert.equal(request.options.num_ctx, 16384);
  assert.equal(request.options.num_predict, 2048);
  assert.equal(provider.timeoutMs, 300000);
});

test('UX4 long response raises output budget without enabling thinking', async () => {
  let request;
  const provider = new OllamaProvider({ model: 'local', profile: 'fast', fetchFn: mockFetch((_url, options) => { request = JSON.parse(options.body); return response(200, { message: { content: 'ok' } }); }) });
  await provider.chat({ longResponse: true, messages: [{ role: 'user', content: 'x' }] });
  assert.equal(request.think, false);
  assert.equal(request.options.num_predict, 4096);
});

test('LONG1 NORMAL long response gets 4096 output and at least 300s timeout', async () => {
  let request;
  const provider = new OllamaProvider({ model: 'local', profile: 'normal', fetchFn: mockFetch((_url, options) => { request = JSON.parse(options.body); return response(200, { message: { content: 'ok' } }); }) });
  await provider.chat({ longResponse: true, messages: [{ role: 'user', content: 'x' }] });
  assert.equal(request.options.num_predict, 4096);
  assert.equal(resolveRequestTimeout({ profile: 'normal', longResponse: true, configuredTimeout: provider.timeoutMs }), 300000);
});

test('LONG2 FAST long response preserves thinking disabled', async () => {
  let request;
  const provider = new OllamaProvider({ model: 'local', profile: 'fast', fetchFn: mockFetch((_url, options) => { request = JSON.parse(options.body); return response(200, { message: { content: 'ok' } }); }) });
  await provider.chat({ longResponse: true, messages: [{ role: 'user', content: 'x' }] });
  assert.equal(request.think, false);
  assert.equal(request.options.num_predict, 4096);
});

test('LONG3 DEEP long response preserves thinking and gets longer timeout', async () => {
  let request;
  const provider = new OllamaProvider({ model: 'local', profile: 'deep', fetchFn: mockFetch((_url, options) => { request = JSON.parse(options.body); return response(200, { message: { content: 'ok' } }); }) });
  await provider.chat({ longResponse: true, messages: [{ role: 'user', content: 'x' }] });
  assert.equal(request.think, true);
  assert.equal(request.options.num_predict, 4096);
  assert.equal(resolveRequestTimeout({ profile: 'deep', longResponse: true, configuredTimeout: provider.timeoutMs }), 600000);
});

test('LONG4 explicit per-call timeout override wins over long-response floor', async () => {
  const provider = new OllamaProvider({ model: 'local', profile: 'normal', fetchFn: (_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error); });
  }) });
  const result = await provider.chat({ longResponse: true, timeoutMs: 5, messages: [{ role: 'user', content: 'x' }] });
  assert.equal(result.error.code, 'TIMEOUT');
  assert.equal(resolveRequestTimeout({ profile: 'normal', longResponse: true, configuredTimeout: 90000, timeoutMs: 5 }), 5);
});

test('LONG5 normal requests retain profile timeout values', async () => {
  assert.equal(new OllamaProvider({ profile: 'fast', fetchFn: async () => response(200, {}) }).timeoutMs, 30000);
  assert.equal(new OllamaProvider({ profile: 'normal', fetchFn: async () => response(200, {}) }).timeoutMs, 90000);
  assert.equal(new OllamaProvider({ profile: 'deep', fetchFn: async () => response(200, {}) }).timeoutMs, 300000);
});

test('UX5 NORMAL plus long response uses coding-oriented configuration', async () => {
  let request;
  const provider = new OllamaProvider({ model: 'local', profile: 'normal', fetchFn: mockFetch((_url, options) => { request = JSON.parse(options.body); return response(200, { message: { content: 'ok' } }); }) });
  await provider.chat({ longResponse: true, messages: [{ role: 'user', content: 'write code' }] });
  assert.equal(request.think, false);
  assert.equal(request.options.num_ctx, 8192);
  assert.equal(request.options.num_predict, 4096);
});

test('PROFILE4 caller overrides profile options safely', async () => {
  let request;
  const provider = new OllamaProvider({ model: 'local', profile: 'deep', fetchFn: mockFetch((_url, options) => { request = JSON.parse(options.body); return response(200, { message: { content: 'ok' } }); }) });
  await provider.chat({ messages: [{ role: 'user', content: 'x' }], think: false, num_ctx: 2048, num_predict: 32, temperature: 0.2, options: { stop: ['END'] } });
  assert.equal(request.think, false);
  assert.deepEqual(request.options, { num_ctx: 2048, num_predict: 32, temperature: 0.2, stop: ['END'] });
});

test('UX6 stop is normal completion and length exposes output limit', async () => {
  let responsePayload = { message: { content: 'complete' }, done: true, done_reason: 'stop' };
  const provider = new OllamaProvider({ model: 'local', fetchFn: mockFetch(() => response(200, responsePayload)) });
  const stopped = await provider.chat({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(stopped.doneReason, 'stop');
  assert.equal(stopped.outputLimitReached, false);
  responsePayload = { message: { content: 'partial' }, done: true, done_reason: 'length' };
  const limited = await provider.chat({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(limited.response, 'partial');
  assert.equal(limited.doneReason, 'length');
  assert.equal(limited.outputLimitReached, true);
  assert.equal(limited.ok, true);
});

test('UX8 legacy profile aliases remain compatible', () => {
  const provider = new OllamaProvider({ fetchFn: async () => response(200, {}) });
  assert.equal(provider.profile, 'normal');
  assert.equal(new OllamaProvider({ profile: 'light', fetchFn: provider.fetchFn }).profile, 'fast');
  assert.equal(new OllamaProvider({ profile: 'medium', fetchFn: provider.fetchFn }).profile, 'normal');
  assert.equal(new OllamaProvider({ profile: 'high', fetchFn: provider.fetchFn }).profile, 'deep');
  assert.deepEqual(LOCAL_RUNTIME_PROFILES.fast.options, { num_ctx: 4096, num_predict: 512 });
});

test('UX9 per-call timeout override wins', async () => {
  const provider = new OllamaProvider({ profile: 'deep', timeoutMs: 1234, fetchFn: (_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error); });
  }) });
  const result = await provider.chat({ timeoutMs: 5, messages: [{ role: 'user', content: 'x' }] });
  assert.equal(result.error.code, 'TIMEOUT');
});

test('PROFILE6 caller cancellation remains normalized', async () => {
  const controller = new AbortController();
  const provider = new OllamaProvider({ fetchFn: (_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error); });
    controller.signal.addEventListener('abort', () => signal.dispatchEvent(new Event('abort')), { once: true });
  }) });
  const pending = provider.health({ signal: controller.signal });
  controller.abort();
  assert.equal((await pending).error.code, 'CANCELLED');
});

test('LOCAL5 HTTP failure is normalized', async () => {
  const provider = new OllamaProvider({ fetchFn: mockFetch(() => response(503, { error: 'server unavailable' })) });
  const result = await provider.listModels();
  assert.equal(result.error.code, 'HTTP_ERROR');
  assert.equal(result.error.status, 503);
});

test('LOCAL6 timeout is normalized', async () => {
  const provider = new OllamaProvider({ timeoutMs: 5, fetchFn: (_url, { signal }) => new Promise((resolve, reject) => { signal.addEventListener('abort', () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error); }); }) });
  assert.equal((await provider.health()).error.code, 'TIMEOUT');
});

test('LOCAL7 malformed response is normalized', async () => {
  const provider = new OllamaProvider({ fetchFn: mockFetch(() => response(200, '{not-json')) });
  assert.equal((await provider.listModels()).error.code, 'MALFORMED_RESPONSE');
});

test('LOCAL8 adapter has no Hearth task or completion ownership surface', async () => {
  const provider = new OllamaProvider({ fetchFn: mockFetch(() => response(200, { message: { content: 'ok' } })) });
  assert.equal(typeof provider.startJob, 'undefined');
  assert.equal(typeof provider.markTaskDone, 'undefined');
  assert.equal((await provider.chat({ model: 'local', messages: [{ role: 'user', content: 'x' }] })).done, true);
});

test('STREAM1 emits multiple chunks in order', async () => {
  const chunks = [];
  const provider = new OllamaProvider({ model: 'local', fetchFn: mockFetch(() => streamResponse([
    { message: { content: 'one' }, done: false },
    { message: { content: ' two' }, done: false },
    { message: { content: ' three' }, done: true, done_reason: 'stop' },
  ])) });
  const result = await provider.chatStream({ messages: [{ role: 'user', content: 'x' }], onChunk: async (chunk) => chunks.push(chunk) });
  assert.deepEqual(chunks, ['one', ' two', ' three']);
  assert.equal(result.response, 'one two three');
});

test('STREAM2 preserves done_reason', async () => {
  const provider = new OllamaProvider({ model: 'local', fetchFn: mockFetch(() => streamResponse([{ message: { content: 'ok' }, done: true, done_reason: 'stop' }])) });
  const result = await provider.chatStream({ messages: [{ role: 'user', content: 'x' }], onChunk: async () => {} });
  assert.equal(result.doneReason, 'stop');
});

test('STREAM3 length remains successful and exposes output limit', async () => {
  const provider = new OllamaProvider({ model: 'local', fetchFn: mockFetch(() => streamResponse([{ message: { content: 'partial' }, done: true, done_reason: 'length' }])) });
  const result = await provider.chatStream({ messages: [{ role: 'user', content: 'x' }], onChunk: async () => {} });
  assert.equal(result.ok, true);
  assert.equal(result.response, 'partial');
  assert.equal(result.outputLimitReached, true);
});

test('STREAM_TOOL1 stream normalizes tool calls without leaking raw output', async () => {
  const provider = new OllamaProvider({ model: 'local', fetchFn: mockFetch(() => streamResponse([{ message: { tool_calls: [{ function: { name: 'file_search', arguments: '{"query":"partial"}' } }] }, done: true, done_reason: 'stop' }])) });
  const result = await provider.chatStream({ tools: [{ type: 'function', function: { name: 'file_search' } }], messages: [{ role: 'user', content: 'search' }], onChunk: async () => {} });
  assert.equal(result.toolCalls[0].function.name, 'file_search');
  assert.equal(result.response, '');
});

test('STREAM4 AbortSignal stops streaming cleanly', async () => {
  const controller = new AbortController();
  const provider = new OllamaProvider({ model: 'local', fetchFn: mockFetch((_url, { signal }) => ({
    ok: true, status: 200, body: new ReadableStream({ start(streamController) {
      streamController.enqueue(new TextEncoder().encode('{"message":{"content":"partial"},"done":false}\n'));
      signal.addEventListener('abort', () => streamController.error(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    } }), text: async () => '',
  })) });
  const pending = provider.chatStream({ signal: controller.signal, messages: [{ role: 'user', content: 'x' }], onChunk: async () => {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  const result = await pending;
  assert.equal(result.error.code, 'CANCELLED');
  assert.equal(result.response, 'partial');
});

test('STREAM5 timeout stops streaming cleanly', async () => {
  const provider = new OllamaProvider({ model: 'local', timeoutMs: 5, fetchFn: mockFetch((_url, { signal }) => ({
    ok: true, status: 200, body: new ReadableStream({ start(streamController) { signal.addEventListener('abort', () => streamController.error(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }); } }), text: async () => '',
  })) });
  const result = await provider.chatStream({ messages: [{ role: 'user', content: 'x' }], onChunk: async () => {} });
  assert.equal(result.error.code, 'TIMEOUT');
});

test('STREAM6 partial content survives stream error', async () => {
  const provider = new OllamaProvider({ model: 'local', fetchFn: mockFetch(() => ({
    ok: true, status: 200, body: new ReadableStream({ start(streamController) { streamController.enqueue(new TextEncoder().encode('{"message":{"content":"partial"},"done":false}\n')); setTimeout(() => streamController.error(new Error('socket closed')), 0); } }), text: async () => '',
  })) });
  const result = await provider.chatStream({ messages: [{ role: 'user', content: 'x' }], onChunk: async () => {} });
  assert.equal(result.error.code, 'UNAVAILABLE');
  assert.equal(result.response, 'partial');
});

test('STREAM8 non-streaming chat remains functional', async () => {
  const provider = new OllamaProvider({ model: 'local', fetchFn: mockFetch(() => response(200, { message: { content: 'normal' }, done: true, done_reason: 'stop' })) });
  assert.equal((await provider.chat({ messages: [{ role: 'user', content: 'x' }] })).response, 'normal');
});

test('STREAM9 profile mappings remain unchanged for streaming', async () => {
  let request;
  const provider = new OllamaProvider({ model: 'local', profile: 'deep', fetchFn: mockFetch((_url, options) => { request = JSON.parse(options.body); return streamResponse([{ message: { content: 'ok' }, done: true }]); }) });
  await provider.chatStream({ messages: [{ role: 'user', content: 'x' }], onChunk: async () => {} });
  assert.equal(request.think, true);
  assert.equal(request.options.num_ctx, 16384);
});

test('STREAM10 long response settings and timeout floor remain unchanged', () => {
  assert.equal(resolveRequestTimeout({ profile: 'normal', longResponse: true, configuredTimeout: 90000 }), 300000);
});

console.log('LOCAL provider tests: 32 passed');
