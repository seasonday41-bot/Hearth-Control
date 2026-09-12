import assert from 'node:assert/strict';
import test from 'node:test';
import { buildContextPreview, buildLocalContext } from '../mcp/context/builder.mjs';

const fixedNow = new Date('2026-09-13T20:15:30.000Z');
const options = { now: fixedNow, timezone: 'Asia/Bangkok', version: '0.4.3', buildId: '0.4.3-20260912150720-3bd6ad', model: 'qwen3.5:9b-hermes', profile: 'normal', longResponse: true, ollamaAvailable: true, workspace: '/Users/example/Hearth', projectName: 'Hearth', gitBranch: null, gitCommit: null, gitState: null };

test('CONTEXT1 runtime date/time comes from the supplied runtime', () => {
  const context = buildLocalContext(options);
  assert.match(context, /Current local date: 2026-09-14/);
  assert.match(context, /Current local time: 03:15:30/);
  assert.doesNotMatch(context, /2026-09-13 03:/);
});
test('CONTEXT2 timezone and offset are included', () => assert.match(buildLocalContext(options), /Asia\/Bangkok \(UTC\+07:00\)/));
test('CONTEXT3 Hearth version and build are included', () => { const c = buildLocalContext(options); assert.match(c, /0\.4\.3/); assert.match(c, /0\.4\.3-20260912150720-3bd6ad/); });
test('CONTEXT4 selected model/profile are included', () => { const c = buildLocalContext(options); assert.match(c, /qwen3\.5:9b-hermes/); assert.match(c, /Selected profile: NORMAL/); assert.match(c, /Long response: on/); });
test('CONTEXT5 filesystem access is unavailable', () => assert.match(buildLocalContext(options), /read arbitrary Mac files/));
test('CONTEXT6 Terminal execution is unavailable', () => assert.match(buildLocalContext(options), /run Terminal commands/));
test('CONTEXT7 web browsing is unavailable', () => assert.match(buildLocalContext(options), /browse the web/));
test('CONTEXT8 Storage Audit is read-only', () => assert.match(buildLocalContext(options), /Storage Audit v0\.1 is read-only/));
test('CONTEXT17 unavailable capabilities prohibit invented file contents', () => { const c = buildLocalContext(options); assert.match(c, /do not invent unseen file contents/i); assert.match(c, /safest next step/i); });
test('CONTEXT18 unavailable capabilities prohibit framework assumptions', () => assert.match(buildLocalContext(options), /assume a framework\/library\/project structure/i));
test('CONTEXT19 project state explicitly lists completed Storage Audit and next skills', () => { const c = buildLocalContext(options); assert.match(c, /Storage Audit v0\.1 implemented and READ ONLY/); assert.match(c, /Next: Local AI Skills \/ Tool Gateway/); assert.match(c, /Repo Reader/); });
test('CONTEXT9 unknown values remain unknown', () => assert.match(buildLocalContext({ now: fixedNow, timezone: 'Asia/Bangkok' }), /Hearth version: unknown[\s\S]*Git branch: unknown/));
test('CONTEXT10 user prompt is not part of context assembly', () => assert.doesNotMatch(buildLocalContext(options), /secret user prompt/));
test('CONTEXT11 external provider path is not referenced', () => assert.doesNotMatch(buildLocalContext(options), /external provider/));
test('CONTEXT12 Local streaming/Stop are described as capabilities', () => { const c = buildLocalContext(options); assert.match(c, /stream responses/); assert.match(c, /stop generation/); });
test('CONTEXT13 builder has no lifecycle ownership imports', async () => { const source = await (await import('node:fs/promises')).readFile(new URL('../mcp/context/builder.mjs', import.meta.url), 'utf8'); assert.doesNotMatch(source, /from ['"].*(?:job-manager|continuation|supabase)/i); });
test('CONTEXT14 context stays within the defined compact budget', () => assert.ok(buildLocalContext(options).length < 9000));
test('CONTEXT15 generated context contains no credential/session/token content', () => assert.doesNotMatch(buildLocalContext(options), /Bearer\s+\S+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|sb_(?:publishable|secret)_/i));
test('CONTEXT16 inspector exposes runtime, capabilities, project, safety, and style', () => { const preview = buildContextPreview(options); for (const key of ['runtime', 'capabilities', 'project', 'safety', 'responseStyle']) assert.ok(preview[key]); });

console.log('Context Builder tests: 16 passed');
