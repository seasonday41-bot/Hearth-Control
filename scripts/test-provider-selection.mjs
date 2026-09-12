import assert from 'node:assert/strict';
import test from 'node:test';
import { createProviderSelection } from '../mcp/providers/selection.mjs';

const localSuccess = (request) => ({ ok: true, provider: 'ollama', model: request.model, response: 'HEARTH_LOCAL_PROVIDER_OK', done: true });

test('SELECT1 explicit local invokes the Ollama adapter', async () => {
  let calls = 0;
  const localProvider = { chat: async (request) => { calls += 1; return localSuccess(request); } };
  const result = await createProviderSelection({ localProvider }).chat({ provider: 'local', model: 'qwen3.5:9b-hermes', profile: 'light', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(calls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'ollama');
});

test('SELECT2 explicit external delegates the existing provider path', async () => {
  const expected = { ok: true, provider: 'existing-external', response: 'unchanged', done: true, metadata: { preserved: true } };
  const externalProvider = { chat: async (request) => { assert.deepEqual(request.messages, [{ role: 'user', content: 'x' }]); return expected; } };
  const result = await createProviderSelection({ externalProvider }).chat({ provider: 'external', messages: [{ role: 'user', content: 'x' }] });
  assert.deepEqual(result, expected);
});

test('SELECT3 unknown provider returns a normalized configuration error', async () => {
  const result = await createProviderSelection({}).chat({ provider: 'router', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'CONFIGURATION_ERROR');
});

test('SELECT4 local unavailable returns the provider error unchanged', async () => {
  const localProvider = { chat: async () => ({ ok: false, provider: 'ollama', error: { code: 'UNAVAILABLE', message: 'Ollama is unavailable', retryable: true } }) };
  const result = await createProviderSelection({ localProvider }).chat({ provider: 'local', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'UNAVAILABLE');
});

test('SELECT5 provider result cannot mark a Hearth task done', () => {
  const selection = createProviderSelection({ localProvider: { chat: async () => localSuccess({}) } });
  assert.equal(typeof selection.markTaskDone, 'undefined');
  assert.equal(typeof selection.completeTask, 'undefined');
});

test('SELECT6 selection layer has no durable lifecycle ownership', () => {
  const selection = createProviderSelection({ localProvider: { chat: async () => localSuccess({}) } });
  for (const property of ['startJob', 'jobManager', 'resumeContinuation', 'syncSupabase', 'taskStore', 'safetyPolicy']) {
    assert.equal(typeof selection[property], 'undefined', property);
  }
});

test('SELECT7 model, profile, and runtime options reach the local provider', async () => {
  let request;
  const localProvider = { chat: async (value) => { request = value; return localSuccess(value); } };
  await createProviderSelection({ localProvider }).chat({
    provider: 'local', model: 'qwen3.5:9b-hermes', profile: 'medium',
    num_ctx: 8192, num_predict: 512, think: false, temperature: 0.2,
    messages: [{ role: 'user', content: 'x' }],
  });
  assert.equal(request.model, 'qwen3.5:9b-hermes');
  assert.equal(request.profile, 'medium');
  assert.equal(request.num_ctx, 8192);
  assert.equal(request.num_predict, 512);
  assert.equal(request.think, false);
  assert.equal(request.temperature, 0.2);
});

test('SELECT8 external provider behavior is not modified', async () => {
  const calls = [];
  const externalProvider = { chat: async (request) => { calls.push(request); return { ok: true, provider: 'external', response: 'same', done: false }; } };
  const request = { messages: [{ role: 'assistant', content: 'existing' }], signal: null };
  const result = await createProviderSelection({ externalProvider }).chat({ provider: 'external', ...request });
  assert.deepEqual(calls, [request]);
  assert.deepEqual(result, { ok: true, provider: 'external', response: 'same', done: false });
});

console.log('Provider selection tests: 8 passed');
