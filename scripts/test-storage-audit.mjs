import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { CLASSIFICATION, classifyPath, createDefaultScanAreas, measurePath, potentiallyReclaimableBytes, scanStorage, sortItemsBySize } from '../mcp/storage/audit.mjs';
import { revealAuditedItem } from '../mcp/storage/reveal.mjs';

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hearth-storage-audit-test-'));
const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
test.after(async () => fs.rm(tempRoot, { recursive: true, force: true }));

test('STORAGE1 known cache path is Safe-ish with evidence', () => {
  const areas = createDefaultScanAreas({ home: tempRoot });
  const cache = areas.find((area) => area.id === 'macos-caches');
  const result = classifyPath(path.join(cache.root, 'com.example.cache'), cache);
  assert.equal(result.classification, CLASSIFICATION.SAFE_ISH);
  assert.ok(result.evidence.includes('Known macOS cache directory'));
});

test('STORAGE2 Ollama model directory is Review', () => {
  const ollama = createDefaultScanAreas({ home: tempRoot }).find((area) => area.id === 'ollama-models');
  assert.equal(classifyPath(ollama.root, ollama).classification, CLASSIFICATION.REVIEW);
});

test('STORAGE3 protected credential/session path is never Safe-ish', () => {
  const cache = createDefaultScanAreas({ home: tempRoot }).find((area) => area.id === 'macos-caches');
  for (const name of ['credentials', 'OAuth', 'session', 'transcript.jsonl', '.env', 'com.example.AuthStore', 'private-key']) {
    const result = classifyPath(path.join(cache.root, name), cache);
    assert.equal(result.classification, CLASSIFICATION.PROTECTED_OR_UNKNOWN);
    assert.equal(result.protected, true);
  }
});

test('STORAGE4 unknown folder stays unknown', () => {
  const result = classifyPath(path.join(tempRoot, 'unfamiliar-data'), null);
  assert.equal(result.classification, CLASSIFICATION.PROTECTED_OR_UNKNOWN);
  assert.equal(result.riskLevel, 'UNKNOWN');
});

test('STORAGE5 permission denied does not crash measurement', async () => {
  const blocked = path.join(tempRoot, 'blocked');
  await fs.mkdir(blocked);
  const fsApi = { lstat: fs.lstat, readdir: async (value) => { if (value === blocked) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return fs.readdir(value); } };
  const result = await measurePath(blocked, { fsApi });
  assert.equal(result.incomplete, true);
  assert.equal(result.fileCount, 1);
});

test('STORAGE6 missing optional area is skipped', async () => {
  const missing = path.join(tempRoot, 'optional-tool-not-installed');
  const result = await scanStorage({ areas: [{ id: 'missing', root: missing, name: 'Optional', classification: CLASSIFICATION.REVIEW, reason: 'Optional', evidence: [] }], home: tempRoot });
  assert.deepEqual(result.items, []);
});

test('STORAGE7 symlink is not followed into another tree', async () => {
  const outside = path.join(tempRoot, 'outside');
  const inside = path.join(tempRoot, 'inside');
  await fs.mkdir(outside);
  await fs.mkdir(inside);
  await fs.writeFile(path.join(outside, 'large'), Buffer.alloc(512));
  await fs.symlink(outside, path.join(inside, 'link'));
  const result = await measurePath(inside);
  assert.equal(result.sizeBytes, 0);
  assert.equal(result.incomplete, true);
});

test('STORAGE8 results sort largest first', () => {
  assert.deepEqual(sortItemsBySize([{ name: 'small', sizeBytes: 1 }, { name: 'large', sizeBytes: 20 }]).map((item) => item.name), ['large', 'small']);
});

test('STORAGE9 reclaimable counts complete Safe-ish candidates only', () => {
  const items = [
    { classification: CLASSIFICATION.SAFE_ISH, sizeBytes: 10, protected: false, incomplete: false },
    { classification: CLASSIFICATION.SAFE_ISH, sizeBytes: 20, protected: false, incomplete: true },
    { classification: CLASSIFICATION.REVIEW, sizeBytes: 30, protected: false, incomplete: false },
    { classification: CLASSIFICATION.SAFE_ISH, sizeBytes: 40, protected: true, incomplete: false },
  ];
  assert.equal(potentiallyReclaimableBytes(items), 10);
});

test('STORAGE10 no delete or Move-to-Trash IPC backend exists', async () => {
  const main = await fs.readFile(path.join(projectRoot, 'electron/main.cjs'), 'utf8');
  assert.doesNotMatch(main, /ipcMain\.(?:handle|on)\(['"]storage-audit:(?:delete|trash|remove)/);
});

test('STORAGE11 reveal validates a selected, existing path', async () => {
  const itemPath = path.join(tempRoot, 'reveal-me');
  await fs.writeFile(itemPath, 'metadata fixture');
  const items = new Map([['known', { path: itemPath, revealable: true }]]);
  const revealed = [];
  assert.deepEqual(await revealAuditedItem({ id: 'known', items, reveal: (value) => revealed.push(value) }), { ok: true });
  assert.deepEqual(revealed, [itemPath]);
  assert.equal((await revealAuditedItem({ id: 'unknown', items, reveal: () => {} })).ok, false);
});

test('STORAGE12 audit modules have no lifecycle or provider ownership imports', async () => {
  for (const relative of ['mcp/storage/audit.mjs', 'mcp/storage/reveal.mjs', 'electron/storage-audit-worker.mjs']) {
    const source = await fs.readFile(path.join(projectRoot, relative), 'utf8');
    assert.doesNotMatch(source, /(?:from|require\()\s*['"][^'"]*(?:job-manager|antigravity|continuation|bridge\/client|ollama)/, relative);
  }
});

test('STORAGE13 scanner runs in a worker and reports progress', async () => {
  const root = path.join(tempRoot, 'worker-cache');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'generated.bin'), Buffer.alloc(8));
  const areas = [{ id: 'worker-cache', root, name: 'Worker cache', classification: CLASSIFICATION.SAFE_ISH, reason: 'Known cache', evidence: ['Test cache'], riskLevel: 'LOW', recreatable: 'YES' }];
  const worker = new Worker(path.join(projectRoot, 'electron/storage-audit-worker.mjs'), { workerData: { home: tempRoot, areas } });
  const messages = [];
  const result = await new Promise((resolve, reject) => {
    worker.on('message', (message) => { messages.push(message); if (message.type === 'done') resolve(message.result); else if (message.type === 'error') reject(new Error(message.error)); });
    worker.on('error', reject);
  });
  assert.ok(messages.some((message) => message.type === 'progress'));
  assert.equal(result.items[0].sizeBytes, 8);
});

test('STORAGE14 protected directory receives metadata only, with no child listing', async () => {
  const root = path.join(tempRoot, 'credentials');
  await fs.mkdir(root);
  let listed = false;
  const result = await measurePath(root, { fsApi: {
    lstat: fs.lstat,
    readdir: async () => { listed = true; return []; },
  } });
  assert.equal(listed, false);
  assert.equal(result.incomplete, true);
  assert.equal(result.fileCount, 1);
});

test('STORAGE15 workspace artifacts stay inside the user home and outside protected paths', () => {
  const home = path.join(tempRoot, 'home');
  const allowed = createDefaultScanAreas({ home, workspace: path.join(home, 'project') });
  assert.ok(allowed.some((entry) => entry.id === 'workspace-dist'));
  for (const workspace of ['/', '/System', '/private', home, path.join(home, 'credentials')]) {
    const areas = createDefaultScanAreas({ home, workspace });
    assert.equal(areas.some((entry) => entry.id.startsWith('workspace-')), false);
  }
});
