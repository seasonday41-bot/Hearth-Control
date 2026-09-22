import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach } from 'node:test';

import { constantTimeEquals, ensureXCoderAuthSecret } from './x-coder-auth.mjs';

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
