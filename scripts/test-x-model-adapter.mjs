import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { OllamaProvider } from '../mcp/providers/ollama.mjs';
import {
  assertModelAdapterContract,
  createModelAdapter,
  createOllamaModelAdapter,
  normalizeModelResponse,
} from '../mcp/x/model-adapter.mjs';

const response = (status, payload) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(payload),
});

test('MODEL1 ModelAdapter contract requires generate and accepts cancel', () => {
  const adapter = createModelAdapter({ provider: { chat: async () => ({ ok: true, response: 'ok' }) } });
  assert.equal(assertModelAdapterContract(adapter), adapter);
  assert.throws(() => assertModelAdapterContract({}), /generate/);
});

test('MODEL2 wraps the existing Ollama provider without another client', async () => {
  let payload;
  const provider = new OllamaProvider({ fetchFn: async (_url, options) => {
    payload = JSON.parse(options.body);
    return response(200, { message: { content: 'local answer' }, done: true, done_reason: 'stop' });
  } });
  const result = await createOllamaModelAdapter({ provider }).generate({ prompt: 'hello' });
  assert.equal(payload.messages[0].content, 'hello');
  assert.equal(result.provider, 'ollama');
  assert.equal(result.text, 'local answer');
  assert.equal(result.finishReason, 'stop');
});

test('MODEL3 configured model and runtime options are forwarded', async () => {
  let request;
  const adapter = createModelAdapter({ provider: { chat: async (value) => { request = value; return { ok: true, provider: 'local', model: value.model, response: 'ok' }; } } });
  const result = await adapter.generate({ messages: [{ role: 'user', content: 'write' }], model: 'configured-model', profile: 'normal', num_ctx: 8192, temperature: 0.2, timeoutMs: 90000 });
  assert.equal(request.model, 'configured-model');
  assert.equal(request.profile, 'normal');
  assert.equal(request.num_ctx, 8192);
  assert.equal(request.temperature, 0.2);
  assert.equal(request.timeoutMs, 90000);
  assert.equal(result.model, 'configured-model');
});

test('MODEL3b X always requests Ollama structured-output JSON enforcement by default', async () => {
  let request;
  const adapter = createModelAdapter({ provider: { chat: async (value) => { request = value; return { ok: true, provider: 'local', response: '{}' }; } } });
  await adapter.generate({ messages: [{ role: 'user', content: 'write' }] });
  assert.equal(request.format, 'json');
});

test('MODEL3c a caller may still override the default format', async () => {
  let request;
  const adapter = createModelAdapter({ provider: { chat: async (value) => { request = value; return { ok: true, provider: 'local', response: 'ok' }; } } });
  await adapter.generate({ messages: [{ role: 'user', content: 'write' }], format: 'a-future-schema' });
  assert.equal(request.format, 'a-future-schema');
});

test('MODEL4 messages are forwarded unchanged', async () => {
  let request;
  const messages = [{ role: 'system', content: 'bounded context' }, { role: 'user', content: 'inspect' }];
  const adapter = createModelAdapter({ provider: { chat: async (value) => { request = value; return { ok: true, provider: 'local', response: 'ok' }; } } });
  await adapter.generate({ messages });
  assert.equal(request.messages, messages);
});

test('MODEL5 provider response normalizes text, finish reason, and available usage', () => {
  const actual = normalizeModelResponse({ ok: true, provider: 'local', model: 'configured', response: 'answer', done_reason: 'length', usage: { promptTokens: 3 } });
  assert.deepEqual(actual, { ok: true, provider: 'local', model: 'configured', requestedModel: null, text: 'answer', finishReason: 'length', usage: { promptTokens: 3 }, error: null });
  assert.equal(normalizeModelResponse({ ok: true, provider: 'local', response: 'answer' }).usage, null);
});

test('MODEL6 provider errors propagate without becoming text responses', async () => {
  const error = { code: 'UNAVAILABLE', message: 'Ollama is unavailable', status: null, retryable: true };
  const adapter = createModelAdapter({ provider: { chat: async () => ({ ok: false, provider: 'ollama', error }) } });
  const actual = await adapter.generate({ prompt: 'x' });
  assert.equal(actual.ok, false);
  assert.equal(actual.text, null);
  assert.equal(actual.error, error);
});

test('MODEL7 cancel aborts an owned request signal and preserves provider cancellation', async () => {
  let resolveProvider;
  const adapter = createModelAdapter({ provider: { chat: ({ signal }) => new Promise((resolve) => {
    resolveProvider = resolve;
    signal.addEventListener('abort', () => resolve({ ok: false, provider: 'ollama', error: { code: 'CANCELLED', message: 'cancelled', retryable: false } }), { once: true });
  }) } });
  const pending = adapter.generate({ requestId: 'request-x', prompt: 'x' });
  assert.equal(adapter.cancel('request-x'), true);
  const actual = await pending;
  assert.equal(actual.error.code, 'CANCELLED');
  assert.equal(adapter.cancel('request-x'), false);
  assert.equal(resolveProvider instanceof Function, true);
});

test('MODEL7b provider timeout remains a timeout error', async () => {
  const error = { code: 'TIMEOUT', message: 'chat request timed out', retryable: true };
  const adapter = createModelAdapter({ provider: { chat: async () => ({ ok: false, provider: 'ollama', error }) } });
  const actual = await adapter.generate({ prompt: 'x', timeoutMs: 5 });
  assert.equal(actual.ok, false);
  assert.equal(actual.error.code, 'TIMEOUT');
});

test('MODEL8 configured models are forwarded without claiming they are installed', async () => {
  let model;
  const provider = { chat: async (request) => { model = request.model; return { ok: true, provider: 'local', response: 'ok' }; } };
  const adapter = createModelAdapter({ provider });
  const actual = await adapter.generate({ prompt: 'x', model: 'future-configurable-model' });
  assert.equal(model, 'future-configurable-model');
  assert.equal(actual.model, null);
  assert.equal(actual.requestedModel, 'future-configurable-model');
  assert.equal(typeof adapter.listModels, 'undefined');
});

test('MODEL9 adapter has no repository mutation, tool, or process ownership', () => {
  const source = fs.readFileSync(fileURLToPath(new URL('../mcp/x/model-adapter.mjs', import.meta.url)), 'utf8');
  for (const forbidden of ['node:fs', 'process.kill', 'child_process', '.writeFile', '.exec(', 'JobManager', 'TaskStore']) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

console.log('X ModelAdapter Phase 2 tests: 10 passed');
