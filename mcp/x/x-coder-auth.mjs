import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const X_CODER_AUTH_HEADER = 'x-hearth-x-coder-auth';
const SECRET_BYTES = 32;

export const defaultXCoderAuthSecretPath = () =>
  path.join(os.homedir(), '.hearth-control', 'x-coder-service', 'auth.secret');

const isValidSecret = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const SETTLE_POLL_ATTEMPTS = 200;
const SETTLE_POLL_DELAY_MS = 5; // 200 * 5ms = 1s worst-case bound on the wait below.

const readSecretFile = (secretPath) => {
  try {
    return fs.readFileSync(secretPath, 'utf8').trim();
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
};

/**
 * ensureXCoderAuthSecret() is called from a synchronous constructor
 * (XCoderClient) as well as from async contexts, so it cannot become async
 * without forcing every caller onto an async factory instead -- real blast
 * radius across the client, production-runtime, and every test that builds
 * one inline. Atomics.wait gives a genuine, bounded, synchronous sleep
 * (Node -- unlike browsers -- allows this on the main thread) instead of a
 * hot spin, so a loser only burns a handful of 5ms ticks waiting for the
 * winner's write, not up to 200 back-to-back synchronous reads.
 */
const syncSleep = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * Reads whatever is currently on secretPath. Returns undefined if nothing is
 * there yet. A momentarily-empty file (another process holds an exclusive
 * create but has not written its contents yet) is treated as transient: it
 * is waited past with a short real delay between checks, never treated as
 * corruption -- corruption is only ever a *non-empty* value that does not
 * parse as a secret, and that always fails closed immediately, with no wait.
 */
const settleSecretFile = (secretPath) => {
  for (let attempt = 0; attempt < SETTLE_POLL_ATTEMPTS; attempt += 1) {
    const raw = readSecretFile(secretPath);
    if (raw === undefined) return undefined;
    if (raw === '') {
      syncSleep(SETTLE_POLL_DELAY_MS);
      continue;
    }
    if (!isValidSecret(raw)) throw new Error('x_coder_auth_secret_corrupt');
    return raw;
  }
  throw new Error('x_coder_auth_secret_unavailable');
};

/**
 * Reads the shared per-user secret, generating it on first use. Creation is
 * atomic via O_EXCL (`wx`): exactly one caller's open() can ever succeed for
 * a given path, so there is never a second writer that could overwrite an
 * already-settled secret (unlike a write-temp-then-rename scheme, where
 * rename silently replaces an existing destination on POSIX). Every other
 * caller -- across processes, across the service/client split -- takes the
 * EEXIST branch and reads back the exact value the winner wrote.
 */
export function ensureXCoderAuthSecret({ secretPath = defaultXCoderAuthSecretPath() } = {}) {
  fs.mkdirSync(path.dirname(secretPath), { recursive: true, mode: 0o700 });

  const existing = settleSecretFile(secretPath);
  if (existing !== undefined) return existing;

  const generated = crypto.randomBytes(SECRET_BYTES).toString('hex');
  let fd;
  try {
    fd = fs.openSync(secretPath, 'wx', 0o600);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const winnerSecret = settleSecretFile(secretPath);
    if (winnerSecret === undefined) throw new Error('x_coder_auth_secret_unavailable');
    return winnerSecret;
  }

  try {
    fs.writeSync(fd, generated, 0, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
  // openSync's mode is subject to umask; pin the exact permission explicitly.
  fs.chmodSync(secretPath, 0o600);
  return generated;
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
