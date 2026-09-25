import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerWorkspaceTools } from '../mcp/tools.mjs';

const create = (permissions = { Files: 'Allow', Terminal: 'Allow' }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-core-tools-'));
  fs.writeFileSync(path.join(root, 'sample.txt'), 'before\n');
  const tools = new Map();
  registerWorkspaceTools({ registerTool(name, _, handler) { tools.set(name, handler); } }, { workspace: root, permissions });
  const call = (name, params) => tools.get(name)(params);
  return { root, call, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
};
const diff = (old, updated) => `diff --git a/sample.txt b/sample.txt\n--- a/sample.txt\n+++ b/sample.txt\n@@ -1 +1 @@\n-${old}\n+${updated}\n`;
const value = (result) => JSON.parse(result.content[0].text);

 test('patch applies only matching context; mismatched context makes no changes', async () => {
  const f = create();
  try {
    const applied = await f.call('apply_patch', { patch: diff('before', 'after') });
    assert.equal(applied.isError, undefined);
    assert.deepEqual(value(applied).changed_files, ['sample.txt']);
    assert.equal(fs.readFileSync(path.join(f.root, 'sample.txt'), 'utf8'), 'after\n');
    const rejected = await f.call('apply_patch', { patch: diff('before', 'again') });
    assert.equal(rejected.isError, true);
    assert.equal(fs.readFileSync(path.join(f.root, 'sample.txt'), 'utf8'), 'after\n');
  } finally { f.cleanup(); }
});

test('patch rejects traversal and blocked Files permission', async () => {
  const f = create();
  try {
    const escaped = diff('before', 'after').replaceAll('sample.txt', '../escape.txt');
    assert.equal((await f.call('apply_patch', { patch: escaped })).isError, true);
    assert.equal(fs.readFileSync(path.join(f.root, 'sample.txt'), 'utf8'), 'before\n');
  } finally { f.cleanup(); }
  const blocked = create({ Files: 'Blocked', Terminal: 'Allow' });
  try { assert.equal((await blocked.call('apply_patch', { patch: diff('before', 'after') })).isError, true); }
  finally { blocked.cleanup(); }
});

test('background job reports output, exit and can be cancelled without arbitrary PID', async () => {
  const f = create();
  try {
    const started = await f.call('job_start', { command: process.execPath, args: ['-e', 'console.log("job output")'], cwd: '.' });
    assert.equal(started.isError, undefined);
    const { job_id } = value(started);
    let status;
    for (let i = 0; i < 50; i++) {
      status = value(await f.call('job_status', { job_id }));
      if (status.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(status.status, 'completed');
    assert.equal(status.exit_code, 0);
    assert.match(value(await f.call('job_output', { job_id, max_chars: 32 })).stdout, /job output/);
    const long = value(await f.call('job_start', { command: process.execPath, args: ['-e', 'setTimeout(() => {}, 10000)'], cwd: '.' }));
    assert.equal(value(await f.call('job_stop', { job_id: long.job_id })).stopped, true);
    assert.equal((await f.call('job_stop', { job_id: 'not-owned' })).isError, true);
    assert.equal((await f.call('job_start', { command: 'rm', args: ['-rf', '.'], cwd: '.' })).isError, true);
    assert.equal((await f.call('job_start', { command: process.execPath, args: [], cwd: '..' })).isError, true);
  } finally { f.cleanup(); }
});
