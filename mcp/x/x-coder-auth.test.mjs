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

// Spawns a real, independent process that exclusively creates secretPath and
// then deliberately delays before writing the actual secret bytes and
// closing -- reproducing the "winner holds the file open-but-empty" window a
// racing reader must wait through, rather than only ever observing a file
// that is already fully written.
const spawnDelayedWriter = (secretPath, delayMs) => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import crypto from 'node:crypto';
    const secretPath = ${JSON.stringify(secretPath)};
    const fd = fs.openSync(secretPath, 'wx', 0o600);
    await new Promise((resolve) => setTimeout(resolve, ${delayMs}));
    const secret = crypto.randomBytes(32).toString('hex');
    fs.writeSync(fd, secret, 0, 'utf8');
    fs.closeSync(fd);
    fs.chmodSync(secretPath, 0o600);
    process.stdout.write(secret);
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return {
    exited: new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => (code !== 0 ? reject(new Error(`delayed writer exited ${code}: ${stderr}`)) : resolve(stdout.trim())));
    }),
  };
};

const waitUntil = async (predicate, { timeoutMs = 2000, intervalMs = 2 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('condition not met before timeout');
};

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

test('R3-1 a genuinely delayed writer: the reader waits through the empty-file window instead of failing, and both converge', async () => {
  const secretPath = tmpSecretPath();
  fs.mkdirSync(path.dirname(secretPath), { recursive: true, mode: 0o700 });

  const writer = spawnDelayedWriter(secretPath, 300);

  // Synchronize on the actual observable state -- created but not yet
  // written -- instead of guessing a sleep duration, so this test reliably
  // exercises the wait path rather than sometimes racing past it.
  await waitUntil(() => fs.existsSync(secretPath) && fs.statSync(secretPath).size === 0);
  assert.equal(fs.statSync(secretPath).size, 0, 'must catch the writer before it writes, to genuinely test the wait');

  // This call is synchronous/blocking (ensureXCoderAuthSecret cannot become
  // async without forcing XCoderClient's constructor async too), and must
  // not throw x_coder_auth_secret_unavailable while it waits out the window.
  const readerSecret = ensureXCoderAuthSecret({ secretPath });

  const writerSecret = await writer.exited;

  assert.match(readerSecret, /^[0-9a-f]{64}$/);
  assert.equal(readerSecret, writerSecret, 'the reader must converge on the exact secret the delayed writer wrote');
  assert.equal(fs.readFileSync(secretPath, 'utf8').trim(), readerSecret);
  assert.equal(fs.statSync(secretPath).mode & 0o777, 0o600);
});
