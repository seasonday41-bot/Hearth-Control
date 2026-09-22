import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MCP_ROOT = path.resolve(HERE, '..');
const LEGACY_EXECUTOR = path.join(MCP_ROOT, 'x', 'execute-x-task.mjs');

const walkMjs = (root) => {
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkMjs(full));
    else if (entry.isFile() && entry.name.endsWith('.mjs') && !entry.name.endsWith('.test.mjs')) out.push(full);
  }
  return out;
};

test('S9-4 production MCP modules cannot import the retired in-process execute-x-task path', () => {
  assert.equal(fs.existsSync(LEGACY_EXECUTOR), true, 'compatibility executor remains available to tests/eval during rollback window');

  const offenders = [];
  const importPattern = /from\s+['"][^'"]*execute-x-task\.mjs['"]/;
  for (const file of walkMjs(MCP_ROOT)) {
    if (file === LEGACY_EXECUTOR) continue;
    const source = fs.readFileSync(file, 'utf8');
    if (importPattern.test(source)) offenders.push(path.relative(MCP_ROOT, file));
  }

  assert.deepEqual(offenders, []);
});

test('S9-5 split authority remains explicit after cutover', () => {
  const hearthRunner = fs.readFileSync(path.join(MCP_ROOT, 'x', 'run-x-task.mjs'), 'utf8');
  const productionRuntime = fs.readFileSync(path.join(MCP_ROOT, 'x', 'production-runtime.mjs'), 'utf8');
  const serviceExecutor = fs.readFileSync(path.join(HERE, 'real-executor.mjs'), 'utf8');

  assert.doesNotMatch(hearthRunner, /execute-x-task\.mjs|runTaskWithRepair/);
  assert.match(hearthRunner, /evaluateResultGate/);
  assert.match(hearthRunner, /buildXResult/);
  assert.match(hearthRunner, /xCoderClient\.submit/);
  assert.match(productionRuntime, /createXCoderClient/);
  assert.doesNotMatch(productionRuntime, /XLeaseKeeper|startXCoderHttpServer/);

  assert.match(serviceExecutor, /runTaskWithRepair/);
  assert.doesNotMatch(serviceExecutor, /evaluateResultGate|buildXResult/);
});
