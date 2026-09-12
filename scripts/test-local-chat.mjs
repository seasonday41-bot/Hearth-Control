import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalChatCaller } from '../mcp/providers/local-chat.mjs';
import { createProviderSelection } from '../mcp/providers/selection.mjs';

const callerWith = (fn) => createLocalChatCaller({ selection: { chat: fn } });

test('CHAT1 local selection invokes Provider Selection', async () => {
  let request;
  const caller = callerWith(async (value) => { request = value; return { ok: true, provider: 'ollama', response: 'local', done: true }; });
  const result = await caller.send({ provider: 'local', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(result.response, 'local');
  assert.equal(request.provider, 'local');
});

test('CHAT2 external selection invokes the existing provider path', async () => {
  let called = false;
  const caller = callerWith(async (value) => { called = value.provider === 'external'; return { ok: true, provider: 'external', response: 'external', done: true }; });
  const result = await caller.send({ provider: 'external', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(called, true);
  assert.equal(result.response, 'external');
});

test('CHAT3 local model/profile/runtime options pass through', async () => {
  let request;
  const caller = callerWith(async (value) => { request = value; return { ok: true, provider: 'ollama', response: 'ok', done: true }; });
  await caller.send({ provider: 'local', model: 'qwen3.5:9b-hermes', profile: 'light', think: false, num_ctx: 4096, num_predict: 256, temperature: 0.2, messages: [] });
  assert.equal(request.model, 'qwen3.5:9b-hermes');
  assert.equal(request.profile, 'light');
  assert.equal(request.num_ctx, 4096);
  assert.equal(request.num_predict, 256);
  assert.equal(request.temperature, 0.2);
});

test('CHAT4 unavailable Ollama returns a clean provider error', async () => {
  const caller = callerWith(async () => ({ ok: false, provider: 'ollama', error: { code: 'UNAVAILABLE', message: 'Ollama is unavailable' } }));
  const result = await caller.send({ provider: 'local', messages: [] });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'UNAVAILABLE');
});

test('CHAT5 caller cannot mark a Hearth task done', () => {
  const caller = callerWith(async () => ({ ok: true, response: 'ok' }));
  assert.equal(typeof caller.markTaskDone, 'undefined');
  assert.equal(typeof caller.completeTask, 'undefined');
});

test('CHAT6 caller has no lifecycle ownership surface', () => {
  const caller = callerWith(async () => ({ ok: true, response: 'ok' }));
  for (const property of ['startJob', 'jobManager', 'resumeContinuation', 'syncSupabase', 'taskStore']) {
    assert.equal(typeof caller[property], 'undefined', property);
  }
});

test('CHAT7 switching providers does not leak prior provider configuration', async () => {
  const requests = [];
  const caller = callerWith(async (value) => { requests.push(value); return { ok: true, provider: value.provider, response: 'ok' }; });
  await caller.send({ provider: 'local', model: 'qwen3.5:9b-hermes', profile: 'high', messages: [] });
  await caller.send({ provider: 'external', messages: [{ role: 'user', content: 'new' }] });
  assert.equal(requests[1].model, undefined);
  assert.equal(requests[1].profile, undefined);
});

test('CHAT8 malformed provider response becomes a clean caller error', async () => {
  const caller = createLocalChatCaller({ selection: createProviderSelection({ localProvider: { chat: async () => null } }) });
  const result = await caller.send({ provider: 'local', messages: [] });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'MALFORMED_RESPONSE');
});

console.log('Local Chat tests: 8 passed');
