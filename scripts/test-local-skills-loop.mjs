import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { createLocalChatCaller } from '../mcp/providers/local-chat.mjs';
import { LOCAL_SKILL_TOOLS } from '../mcp/skills/gateway.mjs';

const toolCall = (name, args = {}) => ({ function: { name, arguments: JSON.stringify(args) } });
const gateway = (execute, maxToolSteps = 6) => ({ execute, maxToolSteps });
const callerWith = (chat) => createLocalChatCaller({ selection: { chat, chatStream: chat } });

test('SKILL15 tool call budget is enforced even when the model asks for more', async () => {
  let calls = 0;
  let executions = 0;
  const caller = callerWith(async () => { calls += 1; return { ok: true, provider: 'ollama', toolCalls: [toolCall('repo_list')] }; });
  const result = await caller.send({ provider: 'local', messages: [{ role: 'user', content: 'Inspect repository' }], gateway: gateway(async () => { executions++; return { ok: true, result: {} }; }, 1) });
  assert.equal(result.toolLimitReached, true);
  assert.equal(calls, 2);
  assert.equal(executions, 1);
});

test('SKILL16 failed tool result is visible to model; missing evidence stays incomplete', async () => {
  const messages = [];
  const caller = callerWith(async (request) => {
    messages.push(request.messages);
    return messages.length === 1 ? { ok: true, toolCalls: [toolCall('repo_read_file', { path: 'missing.ts' })] } : { ok: true, response: 'I could not inspect that file.' };
  });
  const result = await caller.send({ provider: 'local', messages: [{ role: 'user', content: 'Inspect missing.ts' }], gateway: gateway(async () => ({ ok: false, error: { code: 'PATH_REJECTED', message: 'Path rejected' } }), 1) });
  assert.match(JSON.stringify(messages[1]), /PATH_REJECTED/);
  assert.match(result.response, /incomplete/);
});

test('SKILL17 Activity events reflect actual read and confirmed evidence', async () => {
  const events = [];
  const caller = callerWith(async (request) => request.messages.some((message) => message.role === 'tool') ? { ok: true, response: 'Confirmed: src/logic.ts:1.' } : { ok: true, toolCalls: [toolCall('repo_read_file', { path: 'src/logic.ts' })] });
  const result = await caller.send({ provider: 'local', messages: [{ role: 'user', content: 'Inspect logic.ts' }], gateway: gateway(async () => ({ ok: true, result: { path: 'src/logic.ts', partial: false, content: '1: export const logic = true;' } })), onActivity: (event) => events.push(event) });
  assert.equal(result.response, 'Confirmed: src/logic.ts:1.');
  assert.deepEqual(events.map((event) => event.type), ['skill_started', 'skill_completed', 'evidence_progress', 'evidence_complete']);
});

test('SKILL18 stale stream request events remain fenced in renderer', async () => {
  const app = await fs.readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /event\.requestId !== chatRequestIdRef\.current/);
});

test('SKILL19 Stop prevents subsequent tool calls', async () => {
  const controller = new AbortController();
  let executed = 0;
  const caller = callerWith(async () => ({ ok: true, toolCalls: [toolCall('repo_list')] }));
  const pending = caller.send({ provider: 'local', messages: [{ role: 'user', content: 'Inspect repository' }], signal: controller.signal, gateway: gateway(async () => { executed++; controller.abort(); return { ok: true, result: {} }; }) });
  const result = await pending;
  assert.equal(executed, 1);
  assert.equal(result.error.code, 'CANCELLED');
});

test('TOOLHOST2 repository question offers only the four read-only skills', async () => {
  let offered;
  const caller = callerWith(async (request) => { offered = request.tools; return { ok: true, response: 'I cannot confirm without source.' }; });
  await caller.send({ provider: 'local', messages: [{ role: 'user', content: 'Inspect repository' }], gateway: gateway(async () => ({ ok: true })) });
  assert.deepEqual(offered.map((tool) => tool.function.name), ['repo_list', 'repo_read_file', 'file_search', 'git_inspect']);
  assert.deepEqual(LOCAL_SKILL_TOOLS.map((tool) => tool.function.name).filter((name) => /write|edit|delete|execute|test|shell|commit|push/.test(name)), []);
});

test('TOOLHOST3 a superficial search result cannot confirm displayed partial count', async () => {
  let calls = 0;
  const caller = callerWith(async () => ++calls === 1 ? { ok: true, toolCalls: [toolCall('file_search', { query: 'fileCount' })] } : { ok: true, response: 'Confirmed: mcp/storage/audit.mjs:80 calculates + N partial areas.' });
  const result = await caller.send({ provider: 'local', messages: [{ role: 'user', content: 'Where is Storage Audit partial count calculated?' }], gateway: gateway(async () => ({ ok: true, result: { matches: [{ path: 'mcp/storage/audit.mjs', line: 80, excerpt: 'fileCount++' }] } }), 1) });
  assert.match(result.response, /incomplete/);
  assert.doesNotMatch(result.response, /fileCount/);
});

test('TOOLHOST5 normal conversation does not offer or run tools', async () => {
  const caller = callerWith(async (request) => { assert.equal(request.tools, undefined); return { ok: true, response: 'Hello.' }; });
  const result = await caller.send({ provider: 'local', messages: [{ role: 'user', content: 'Say hello.' }], gateway: gateway(async () => { throw Error('Unexpected tool'); }) });
  assert.equal(result.response, 'Hello.');
});

test('TOOLHOST6 branch question calls git_inspect', async () => {
  const caller = callerWith(async (request) => request.messages.some((message) => message.role === 'tool') ? { ok: true, response: 'Branch: feature/local-ai-skills-readonly-v0.1' } : { ok: true, toolCalls: [toolCall('git_inspect', { operation: 'branch' })] });
  const result = await caller.send({ provider: 'local', messages: [{ role: 'user', content: 'What branch am I on?' }], gateway: gateway(async (name, args) => { assert.equal(name, 'git_inspect'); assert.equal(args.operation, 'branch'); return { ok: true, result: { operation: 'branch', output: 'feature/local-ai-skills-readonly-v0.1' } }; }) });
  assert.match(result.response, /feature\/local-ai-skills-readonly-v0\.1/);
});
