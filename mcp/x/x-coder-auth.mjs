import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const X_CODER_AUTH_HEADER = 'x-hearth-x-coder-auth';
const SECRET_BYTES = 32;

export const defaultXCoderAuthSecretPath = () =>
  path.join(os.homedir(), '.hearth-control', 'x-coder-service', 'auth.secret');

const isValidSecret = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

/**
 * Reads the shared per-user secret, generating it on first use. Either the
 * service or the client may win the create race; both converge on whichever
 * value landed on disk first.
 */
export function ensureXCoderAuthSecret({ secretPath = defaultXCoderAuthSecretPath() } = {}) {
  fs.mkdirSync(path.dirname(secretPath), { recursive: true, mode: 0o700 });

  try {
    const existing = fs.readFileSync(secretPath, 'utf8').trim();
    if (isValidSecret(existing)) return existing;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const generated = crypto.randomBytes(SECRET_BYTES).toString('hex');
  const tempPath = `${secretPath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tempPath, generated, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, secretPath);
  } catch (error) {
    try { fs.rmSync(tempPath, { force: true }); } catch {}
    if (error?.code !== 'EEXIST') throw error;
  }
  fs.chmodSync(secretPath, 0o600);

  const settled = fs.readFileSync(secretPath, 'utf8').trim();
  if (!isValidSecret(settled)) throw new Error('x_coder_auth_secret_corrupt');
  return settled;
}

export function constantTimeEquals(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(candidate, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    // Still run a fixed-cost comparison so the response timing does not leak length.
    crypto.timingSafeEqual(b, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}
