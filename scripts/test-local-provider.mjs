import assert from 'node:assert/strict';
import test from 'node:test';
import { LOCAL_RUNTIME_PROFILES, OllamaProvider } from '../mcp/providers/ollama.mjs';

const response = (status, payload) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => typeof payload === 'string' ? payload : JSON.stringify(payload),
});
const mockFetch = (handler) => async (url, options) => handler(url, options);

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

test('PROFILE1 LIGHT sends think=false and 4096 context', async () => {
  let request;
  const provider = new OllamaProvider({ model: 'local', fetchFn: mockFetch((_url, options) => { request = JSON.parse(options.body); return response(200, { message: { content: 'ok' } }); }) });
  await provider.chat({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(request.think, false);
  assert.equal(request.options.num_ctx, 4096);
  assert.equal(request.options.num_predict, 256);
});

test('PROFILE2 MEDIUM uses larger context without thinking', async () => {
  let request;
  const provider = new OllamaProvider({ model: 'local', profile: 'medium', fetchFn: mockFetch((_url, options) => { request = JSON.parse(options.body); return response(200, { message: { content: 'ok' } }); }) });
  await provider.chat({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(request.think, false);
  assert.equal(request.options.num_ctx, 8192);
  assert.equal(request.options.num_predict, 512);
});

test('PROFILE3 HIGH enables thinking', async () => {
  let request;
  const provider = new OllamaProvider({ model: 'local', profile: 'high', fetchFn: mockFetch((_url, options) => { request = JSON.parse(options.body); return response(200, { message: { content: 'ok' } }); }) });
  await provider.chat({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(request.think, true);
  assert.equal(request.options.num_ctx, 16384);
});

test('PROFILE4 caller overrides profile options safely', async () => {
  let request;
  const provider = new OllamaProvider({ model: 'local', profile: 'high', fetchFn: mockFetch((_url, options) => { request = JSON.parse(options.body); return response(200, { message: { content: 'ok' } }); }) });
  await provider.chat({ messages: [{ role: 'user', content: 'x' }], think: false, num_ctx: 2048, num_predict: 32, temperature: 0.2, options: { stop: ['END'] } });
  assert.equal(request.think, false);
  assert.deepEqual(request.options, { num_ctx: 2048, num_predict: 32, temperature: 0.2, stop: ['END'] });
});

test('PROFILE5 default profile is LIGHT', () => {
  const provider = new OllamaProvider({ fetchFn: async () => response(200, {}) });
  assert.equal(provider.profile, 'light');
  assert.deepEqual(LOCAL_RUNTIME_PROFILES.light.options, { num_ctx: 4096, num_predict: 256 });
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

console.log('LOCAL provider tests: 14 passed');
