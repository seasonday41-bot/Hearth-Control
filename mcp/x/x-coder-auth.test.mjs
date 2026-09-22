import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test, { afterEach } from 'node:test';

import { constantTimeEquals, ensureXCoderAuthSecret } from './x-coder-auth.mjs';

const AUTH_MODULE_URL = new URL('./x-coder-auth.mjs', import.meta.url).href;

// Spawns a real child process that calls ensureXCoderAuthSecret against the
// same path and prints the result, so the race is genuinely inter-process
// (two independent OS processes hitting O_EXCL on the same file), not just
// two sequential calls in this one process.
const raceCreator = (secretPath) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { ensureXCoderAuthSecret } from '${AUTH_MODULE_URL}';
    process.stdout.write(ensureXCoderAuthSecret({ secretPath: ${JSON.stringify(secretPath)} }));
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', reject);
  child.on('close', (code) => {
    if (code !== 0) reject(new Error(`race creator exited ${code}: ${stderr}`));
    else resolve(stdout.trim());
  });
});

const dirs = [];
const tmpSecretPath = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-x-coder-auth-'));
  dirs.push(dir);
  return path.join(dir, 'nested', 'auth.secret');
};

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test('R1-1 first call generates a 64-char hex secret with user-only permissions', () => {
  const secretPath = tmpSecretPath();
  const secret = ensureXCoderAuthSecret({ secretPath });

  assert.match(secret, /^[0-9a-f]{64}$/);
  const mode = fs.statSync(secretPath).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('R1-2 repeated calls return the same durable secret rather than regenerating it', () => {
  const secretPath = tmpSecretPath();
  const first = ensureXCoderAuthSecret({ secretPath });
  const second = ensureXCoderAuthSecret({ secretPath });
  assert.equal(first, second);
});

test('R1-3 whichever side creates the secret first, the other side reads the same value', () => {
  const secretPath = tmpSecretPath();
  const serviceSide = ensureXCoderAuthSecret({ secretPath });
  const clientSide = ensureXCoderAuthSecret({ secretPath });
  assert.equal(serviceSide, clientSide);
});

test('R1-4 constantTimeEquals accepts the exact secret and rejects near-misses', () => {
  const secret = 'a'.repeat(64);
  assert.equal(constantTimeEquals(secret, secret), true);
  assert.equal(constantTimeEquals('b'.repeat(64), secret), false);
  assert.equal(constantTimeEquals(secret.slice(0, 63), secret), false);
  assert.equal(constantTimeEquals('', secret), false);
  assert.equal(constantTimeEquals(undefined, secret), false);
});

test('R2-1 two real processes racing to create the secret converge on exactly one value', async () => {
  const secretPath = tmpSecretPath();

  const results = await Promise.all(
    Array.from({ length: 8 }, () => raceCreator(secretPath)),
  );

  for (const value of results) assert.match(value, /^[0-9a-f]{64}$/);
  assert.equal(new Set(results).size, 1, 'every racer must converge on the exact same secret');

  const onDisk = fs.readFileSync(secretPath, 'utf8').trim();
  assert.equal(onDisk, results[0]);
});

test('R2-2 the loser of the create race reads back the winner\'s exact value, never overwriting it', () => {
  const secretPath = tmpSecretPath();
  const winner = ensureXCoderAuthSecret({ secretPath });

  // A second caller now finds the file already created (the real EEXIST path
  // any true racer would hit) and must read the winner's value, not replace it.
  const loser = ensureXCoderAuthSecret({ secretPath });

  assert.equal(loser, winner);
  assert.equal(fs.readFileSync(secretPath, 'utf8').trim(), winner);
});

test('R2-3 an existing corrupt secret is rejected, never silently replaced', () => {
  const secretPath = tmpSecretPath();
  fs.mkdirSync(path.dirname(secretPath), { recursive: true });
  fs.writeFileSync(secretPath, 'not-a-valid-secret', { mode: 0o600 });

  assert.throws(() => ensureXCoderAuthSecret({ secretPath }), /x_coder_auth_secret_corrupt/);

  // The corrupt value must still be there -- no silent regeneration/overwrite.
  assert.equal(fs.readFileSync(secretPath, 'utf8'), 'not-a-valid-secret');
});
