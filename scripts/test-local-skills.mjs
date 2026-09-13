import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createReadOnlyToolGateway } from '../mcp/skills/gateway.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hearth-skills-'));
await fs.mkdir(path.join(root, 'src'), { recursive: true });
await fs.writeFile(path.join(root, 'src', 'sample.js'), 'const partial = true;\n// partial count\n');
await fs.writeFile(path.join(root, '.env'), 'SECRET=do-not-return\n');
await fs.writeFile(path.join(root, '.env.test'), 'SECRET=do-not-return-either\n');
await fs.writeFile(path.join(root, 'id_rsa'), 'PRIVATE SSH KEY\n');
await fs.writeFile(path.join(root, 'private.pem'), 'PRIVATE KEY DATA\n');
await fs.writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
await fs.writeFile(path.join(root, 'large.txt'), 'x'.repeat(1024 * 1024 + 100));
await fs.symlink('/tmp', path.join(root, 'outside-link'));
const gateway = createReadOnlyToolGateway({ workspace: root });
const repoGateway = createReadOnlyToolGateway({ workspace: process.cwd() });

test('SKILL1 repo list stays inside workspace', async () => {
  const result = await gateway.repoList();
  assert.ok(result.entries.some((entry) => entry.path === 'src/sample.js'));
  assert.ok(result.entries.every((entry) => !entry.path.startsWith('..')));
  assert.ok(!result.entries.some((entry) => entry.path.startsWith('outside-link/')));
});
test('SKILL2 repo read returns source with line numbers', async () => {
  const result = await gateway.repoReadFile({ path: 'src/sample.js' });
  assert.match(result.content, /^1: const partial/m);
  assert.match(result.content, /^2: \/\/ partial count/m);
});
test('SKILL3 path escape is rejected', async () => { await assert.rejects(() => gateway.repoReadFile({ path: '../outside.txt' }), { code: 'PATH_REJECTED' }); });
test('SKILL4 symlink escape is rejected', async () => { await assert.rejects(() => gateway.repoReadFile({ path: 'outside-link/secret.txt' }), { code: 'PATH_REJECTED' }); });
test('SKILL5 protected env contents are not returned', async () => { const result = await gateway.repoReadFile({ path: '.env' }); assert.equal(result.protected, true); assert.doesNotMatch(JSON.stringify(result), /do-not-return/); });
test('SKILL6 private key contents are not returned', async () => { const result = await gateway.repoReadFile({ path: 'private.pem' }); assert.equal(result.protected, true); assert.doesNotMatch(JSON.stringify(result), /PRIVATE KEY DATA/); });
test('SKILL6b env variants and SSH key names are protected', async () => { const env = await gateway.repoReadFile({ path: '.env.test' }); const ssh = await gateway.repoReadFile({ path: 'id_rsa' }); assert.equal(env.protected, true); assert.equal(ssh.protected, true); });
test('SKILL7 large file is bounded', async () => { const result = await gateway.repoReadFile({ path: 'large.txt' }); assert.equal(result.partial, true); assert.equal(result.truncated, true); assert.ok(result.content.length < 1024 * 1024 + 100); });
test('SKILL8 file search finds expected matches', async () => { const result = await gateway.fileSearch({ query: 'partial' }); assert.equal(result.matches[0].path, 'src/sample.js'); assert.equal(result.matches[0].line, 1); });
test('SKILL9 file search result count is bounded', async () => { await fs.writeFile(path.join(root, 'many.txt'), `${'partial\n'.repeat(150)}`); const result = await gateway.fileSearch({ query: 'partial' }); assert.equal(result.matches.length, 100); assert.equal(result.truncated, true); });
test('SKILL10 binary files are skipped', async () => { const result = await gateway.fileSearch({ query: 'partial' }); assert.ok(!result.matches.some((match) => match.path === 'binary.bin')); });
test('SKILL11 Git branch inspection works read-only', async () => { const result = await repoGateway.gitInspect({ operation: 'branch' }); assert.equal(result.operation, 'branch'); });
test('SKILL12 Git status inspection works read-only', async () => { const result = await repoGateway.gitInspect({ operation: 'status' }); assert.match(result.output, /##| M |\?\?|fatal/i); });
test('SKILL13 Git diff output is bounded', async () => { const result = await repoGateway.gitInspect({ operation: 'diff' }); assert.ok(result.output.length <= 64 * 1024); });
test('SKILL14 Git mutation operations are unavailable', async () => { await assert.rejects(() => gateway.gitInspect({ operation: 'commit' }), { code: 'OPERATION_REJECTED' }); });
test('SKILL22 gateway exposes no lifecycle ownership', () => { assert.equal(typeof gateway.jobManager, 'undefined'); assert.equal(typeof gateway.markTaskDone, 'undefined'); });
test('SKILL23 gateway exposes no filesystem mutation API', () => { assert.equal(typeof gateway.writeFile, 'undefined'); assert.equal(typeof gateway.deleteFile, 'undefined'); });
test('SKILL24 gateway exposes no general shell API', () => { assert.equal(typeof gateway.shell, 'undefined'); assert.equal(typeof gateway.exec, 'undefined'); });

console.log('Local Skills gateway tests: 18 passed');
