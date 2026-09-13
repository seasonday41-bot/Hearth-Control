import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { authoritativeLocalFacts, createEvidenceTrace, createProductFactPacket, groundingMode, renderProductFacts, validateProductClaims } from '../mcp/providers/grounding.mjs';
import { createLocalChatCaller } from '../mcp/providers/local-chat.mjs';

const prompt = 'ดูหน่อยว่า Storage Audit คำนวณ partial count ที่ไฟล์ไหน';
const mockRead = { ok: true, result: { path: 'src/StorageAudit.tsx', partial: false, content: [
  '40: const items = result?.items || [];',
  '43: partial: items.filter((item) => item.classification === category && item.incomplete).length,',
  '74: <small>+ {totals[category].partial} partial areas</small>',
].join('\n') } };
const search = { ok: true, result: { matches: [{ path: 'mcp/storage/audit.mjs', line: 80, excerpt: 'fileCount++' }] } };
const answer = 'Confirmed: src/StorageAudit.tsx:43 counts incomplete items; src/StorageAudit.tsx:74 renders + N partial areas.';
const model = (responses) => { const received = []; let index = 0; return { received, selection: { chat: async (request) => { received.push(request); return responses[Math.min(index++, responses.length - 1)]; }, chatStream: async (request) => { received.push(request); const result = responses[Math.min(index++, responses.length - 1)]; await request.onChunk?.(result.response || ''); return result; } } }; };
const toolCall = (name, args = {}) => ({ function: { name, arguments: JSON.stringify(args) } });

test('GROUNDGATE1 authoritative facts retain unknown global policies', () => {
  const facts = authoritativeLocalFacts({ version: '0.4.3', buildId: 'stable', model: 'qwen', profile: 'normal', localEndpoint: 'http://127.0.0.1:11434' });
  assert.equal(facts.localOllamaEndpoint, 'http://127.0.0.1:11434');
  for (const key of ['globalRetentionPolicy', 'allHearthDataLocal', 'allFeaturesOffline', 'trainingPrivacyGuarantee']) assert.equal(facts[key], 'unknown');
  assert.equal(authoritativeLocalFacts({ localEndpoint: 'https://remote.example' }).localOllamaEndpoint, null);
});

test('authoritative runtime version/build and selected endpoint reach Local Chat from main', async () => {
  const main = await fs.readFile(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  assert.match(main, /version: buildMetadata\.version/);
  assert.match(main, /buildId: buildMetadata\.buildId/);
  assert.match(main, /localEndpoint: selection\.localProvider\?\.baseUrl/);
});

const packet = createProductFactPacket(authoritativeLocalFacts({ version: '0.4.3', buildId: 'stable-build', model: 'qwen3.5:9b-hermes', profile: 'normal', localEndpoint: 'http://127.0.0.1:11434' }));
const claims = (...factIds) => JSON.stringify({ claims: factIds.map((factId) => ({ factId })) });

test('FACT1/2 selected model and loopback endpoint render from Hearth values', async () => {
  const { selection, received } = model([{ ok: true, response: claims('LOCAL_CHAT_AVAILABLE', 'LOCAL_MODEL', 'OLLAMA_ENDPOINT_IS_LOOPBACK') }]);
  const result = await createLocalChatCaller({ selection }).send({ provider: 'local', model: 'qwen3.5:9b-hermes', localEndpoint: 'http://127.0.0.1:11434', messages: [{ role: 'user', content: 'Local Chat คืออะไร' }] });
  assert.equal(received.length, 1);
  assert.match(result.response, /qwen3\.5:9b-hermes/);
  assert.match(result.response, /127\.0\.0\.1:11434.*loopback/);
  assert.doesNotMatch(result.response, /ข้อมูลทั้งหมด.*ในเครื่อง/);
});

test('FACT3-6 loopback never authorizes unknown application-wide guarantees', () => {
  for (const id of ['ALL_DATA_STAYS_LOCAL', 'FULL_OFFLINE_OPERATION', 'PRIVACY_GUARANTEE', 'NO_EXTERNAL_CONNECTIONS', 'ALL_PROCESSING_LOCAL', 'RETENTION_POLICY', 'TRAINING_POLICY']) {
    assert.ok(packet.unknown.includes(id));
    assert.equal(validateProductClaims(claims('OLLAMA_ENDPOINT_IS_LOOPBACK', id), packet).ok, false);
  }
});

test('FACT7 unsupported paraphrase is rejected regardless of wording or claimed IDs', async () => {
  const unsupported = JSON.stringify({ answer: 'โหมดแชทส่วนตัวบนเครื่อง ไม่ขึ้นกับอินเทอร์เน็ต', claims: [{ factId: 'LOCAL_CHAT_AVAILABLE' }] });
  const { selection, received } = model([{ ok: true, response: unsupported }, { ok: true, response: claims('LOCAL_CHAT_AVAILABLE') }]);
  const chunks = [];
  const result = await createLocalChatCaller({ selection }).stream({ provider: 'local', version: '0.4.3', messages: [{ role: 'user', content: 'Local Chat คืออะไร' }], onChunk: (chunk) => chunks.push(chunk) });
  assert.equal(received.length, 2);
  assert.equal(chunks.join(''), result.response);
  assert.doesNotMatch(result.response, /โหมดแชทส่วนตัว|ไม่ขึ้นกับอินเทอร์เน็ต/);
  assert.match(result.response, /Local Chat/);
});

test('FACT8-10 second failed contract produces deterministic runtime fallback', async () => {
  const modelProse = 'การสนทนาเกิดขึ้นภายในเครื่อง';
  const { selection, received } = model([{ ok: true, response: modelProse }, { ok: true, response: claims('PRIVACY_GUARANTEE') }]);
  const result = await createLocalChatCaller({ selection }).send({ provider: 'local', version: '0.4.3', model: 'qwen3.5:9b-hermes', profile: 'normal', localEndpoint: 'http://127.0.0.1:11434', messages: [{ role: 'user', content: 'ช่วยอธิบายว่า Local Chat คืออะไร' }] });
  assert.equal(received.length, 2);
  assert.match(result.response, /0\.4\.3/);
  assert.match(result.response, /qwen3\.5:9b-hermes/);
  const fallbackPacket = createProductFactPacket(authoritativeLocalFacts({ version: '0.4.3', model: 'qwen3.5:9b-hermes', profile: 'normal', localEndpoint: 'http://127.0.0.1:11434' }));
  assert.equal(result.response, renderProductFacts(fallbackPacket, Object.keys(fallbackPacket.available), 'ช่วยอธิบายว่า Local Chat คืออะไร'));
  assert.doesNotMatch(result.response, /การสนทนาเกิดขึ้นภายในเครื่อง/);
});

test('FACT11 ordinary conversation is not routed into the fact contract', async () => {
  for (const question of ['Local Chat คืออะไร', 'Hearth ทำอะไรได้บ้าง', 'Local AI ปลอดภัยไหม', 'ทำงาน offline ไหม', 'ข้อมูลออกจากเครื่องไหม']) assert.equal(groundingMode(question), 'product');
  assert.equal(groundingMode('สวัสดี วันนี้เป็นอย่างไรบ้าง'), 'conversation');
  const { selection, received } = model([{ ok: true, response: 'สวัสดีครับ' }]);
  const result = await createLocalChatCaller({ selection }).send({ provider: 'local', messages: [{ role: 'user', content: 'สวัสดี วันนี้เป็นอย่างไรบ้าง' }] });
  assert.equal(received.length, 1);
  assert.equal(result.response, 'สวัสดีครับ');
});

test('timed-out partial product response cannot surface an unchecked privacy claim', async () => {
  const { selection } = model([{ ok: false, response: 'No data leaves the machine.', error: { code: 'TIMEOUT', message: 'Timed out' } }]);
  const result = await createLocalChatCaller({ selection }).stream({ provider: 'local', version: '0.4.3', localEndpoint: 'http://127.0.0.1:11434', messages: [{ role: 'user', content: 'Explain Local Chat.' }], onChunk: () => { throw Error('unverified chunk emitted'); } });
  assert.equal(result.ok, false);
  assert.doesNotMatch(result.response, /no data leaves/i);
});

test('EVIDENCEGATE1 fabricated source line cannot pass', () => {
  const trace = createEvidenceTrace(prompt, 'ui');
  trace.add('file_search', { query: 'partial' }, search);
  trace.add('repo_read_file', { path: 'src/StorageAudit.tsx' }, mockRead);
  assert.equal(trace.check('Confirmed at src/StorageAudit.tsx:999.').reason, 'citation_unverified');
});

test('evidence citations support root-level files and Git identity must match inspected output', () => {
  const repo = createEvidenceTrace('Inspect package config', 'repo');
  repo.add('repo_read_file', { path: 'package.json' }, { ok: true, result: { path: 'package.json', partial: false, content: '2: "name": "hearth-control"' } });
  assert.equal(repo.check('package.json:2 defines the package name.').ok, true);
  const git = createEvidenceTrace('What branch am I on?', 'git');
  git.add('git_inspect', { operation: 'branch' }, { ok: true, result: { operation: 'branch', output: 'feature/local-ai-skills-readonly-v0.1' } });
  assert.equal(git.check('We are on main.').ok, false);
  assert.equal(git.check('Branch: feature/local-ai-skills-readonly-v0.1').ok, true);
});

test('EVIDENCEGATE2 one backend match cannot pass a UI trace', () => {
  const trace = createEvidenceTrace(prompt, 'ui');
  trace.add('file_search', { query: 'fileCount' }, search);
  assert.equal(trace.check('Confirmed at mcp/storage/audit.mjs:80.').ok, false);
});

test('EVIDENCEGATE3 search result prompts additional read before final answer', async () => {
  const { selection, received } = model([
    { ok: true, response: '', toolCalls: [toolCall('file_search', { query: 'fileCount' })] },
    { ok: true, response: 'The partial-area count is fileCount at mcp/storage/audit.mjs:80.' },
    { ok: true, response: '', toolCalls: [toolCall('repo_read_file', { path: 'src/StorageAudit.tsx' })] },
    { ok: true, response: answer },
  ]);
  const events = [];
  const result = await createLocalChatCaller({ selection }).send({ provider: 'local', messages: [{ role: 'user', content: prompt }], gateway: { maxToolSteps: 6, execute: async (name) => name === 'file_search' ? search : mockRead }, onActivity: (event) => events.push(event) });
  assert.equal(received.length, 4);
  assert.equal(result.response, answer);
  assert.ok(events.some((event) => event.type === 'evidence_complete'));
  assert.ok(events.some((event) => event.type === 'evidence_progress' && event.stage === 'OUTPUT'));
});

test('SEARCH1/2 duplicate empty searches are skipped and guidance broadens', async () => {
  const { selection, received } = model([
    { ok: true, toolCalls: [toolCall('file_search', { query: 'partial count' })] },
    { ok: true, toolCalls: [toolCall('file_search', { query: 'partial count' })] },
    { ok: true, response: 'Still incomplete.' },
  ]);
  let executions = 0;
  const result = await createLocalChatCaller({ selection }).send({ provider: 'local', messages: [{ role: 'user', content: prompt }], gateway: { maxToolSteps: 3, execute: async () => { executions += 1; return { ok: true, result: { matches: [] } }; } } });
  assert.equal(executions, 1);
  assert.match(JSON.stringify(received[1].messages), /broaden|repo_list|equivalent/i);
  assert.match(result.response, /incomplete|ยังไม่ครบ/i);
});

test('SEARCH3 test fixtures are TEST_EVIDENCE and cannot satisfy a production UI trace', () => {
  const trace = createEvidenceTrace(prompt, 'ui');
  trace.add('repo_read_file', { path: 'scripts/test-grounding-gate.mjs' }, { ok: true, result: { path: 'scripts/test-grounding-gate.mjs', partial: false, content: '10: const partial = true;\n11: <small>partial areas</small>' } });
  assert.equal(trace.records.every((item) => item.stage === 'TEST_EVIDENCE'), true);
  assert.equal(trace.check('Confirmed at scripts/test-grounding-gate.mjs:11.').ok, false);
});

test('EVIDENCEGATE4 exhaustion reports incomplete without accepting model certainty', async () => {
  const { selection } = model([{ ok: true, toolCalls: [toolCall('file_search', { query: 'fileCount' })] }, { ok: true, response: 'Confirmed fileCount is the count.' }]);
  const result = await createLocalChatCaller({ selection }).send({ provider: 'local', messages: [{ role: 'user', content: prompt }], gateway: { maxToolSteps: 1, execute: async () => search } });
  assert.equal(result.toolLimitReached, true);
  assert.match(result.response, /หลักฐาน.*ยังไม่ครบ/);
});

test('EVIDENCEGATE5 read aggregation and output supports confirmed answer', () => {
  const trace = createEvidenceTrace(prompt, 'ui');
  trace.add('file_search', { query: 'fileCount' }, search);
  trace.add('repo_read_file', { path: 'src/StorageAudit.tsx' }, mockRead);
  assert.equal(trace.check(answer).ok, true);
  assert.equal(trace.check('Confirmed: mcp/storage/audit.mjs:80 is partial count.').ok, false);
  assert.equal(trace.check('mcp/storage/audit.mjs:80 fileCount is the partial count; src/StorageAudit.tsx:43 and src/StorageAudit.tsx:74 show it.').reason, 'unsupported_semantic_match');
});

test('EVIDENCEGATE6 normal conversation stays tool-free', async () => {
  assert.equal(groundingMode('How are you today?'), 'conversation');
  const { selection, received } = model([{ ok: true, response: 'Hello.' }]);
  const result = await createLocalChatCaller({ selection }).send({ provider: 'local', messages: [{ role: 'user', content: 'How are you today?' }], gateway: { maxToolSteps: 6, execute: () => { throw Error('unexpected tool'); } } });
  assert.equal(received[0].tools, undefined);
  assert.equal(result.response, 'Hello.');
});

test('external provider request retains the existing selection path', async () => {
  const { selection, received } = model([{ ok: true, provider: 'external', response: 'External result.' }]);
  const result = await createLocalChatCaller({ selection }).send({ provider: 'external', messages: [{ role: 'user', content: prompt }] });
  assert.equal(received.length, 1);
  assert.equal(result.response, 'External result.');
});

test('product contract accepts only known IDs and never accepts prose', () => {
  assert.equal(validateProductClaims(claims('HEARTH_VERSION', 'LOCAL_MODEL'), packet).ok, true);
  assert.equal(validateProductClaims('Hearth 0.4.3 uses the local endpoint.', packet).ok, false);
  assert.equal(validateProductClaims(JSON.stringify({ answer: 'Fully private', claims: [{ factId: 'HEARTH_VERSION' }] }), packet).ok, false);
});
