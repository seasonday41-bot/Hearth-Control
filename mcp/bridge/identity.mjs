import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Persists and retrieves a cryptographically random device UUID for Hearth Bridge.
 * STRICTURES:
 * - Zero collection or hashing of MAC addresses, hardware serials, usernames, or machine IDs.
 * - Must be a random UUID generated via crypto.randomUUID().
 * - Persisted in the app userData directory.
 *
 * @param {string} userDataDir
 * @returns {string} deviceId (UUID)
 */
export const getOrCreateDeviceId = (userDataDir) => {
  if (!userDataDir || typeof userDataDir !== 'string') {
    throw new Error('userDataDir is required to load or generate deviceId');
  }

  const identityFilePath = path.join(userDataDir, 'bridge-identity.json');
  try {
    if (fs.existsSync(identityFilePath)) {
      const content = JSON.parse(fs.readFileSync(identityFilePath, 'utf8'));
      if (content?.deviceId && typeof content.deviceId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(content.deviceId)) {
        return content.deviceId;
      }
    }
  } catch {
    // If reading failed, generate fresh below
  }

  const newDeviceId = crypto.randomUUID();
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(
      identityFilePath,
      JSON.stringify({ deviceId: newDeviceId, createdAt: new Date().toISOString() }, null, 2),
      'utf8'
    );
  } catch (err) {
    console.error('Failed to persist bridge-identity.json:', err);
  }
  return newDeviceId;
};

/**
 * Computes a SHA-256 hash of a pairing secret string.
 * @param {string} secret
 * @returns {string} hex hash
 */
export const hashPairingSecret = (secret) => {
  if (typeof secret !== 'string' || !secret.trim()) {
    throw new Error('Pairing secret must be a non-empty string');
  }
  return crypto.createHash('sha256').update(secret.trim()).digest('hex');
};

/**
 * Generates a high-entropy pairing secret and its SHA-256 hash.
 * The raw secret is displayed once to the user for pairing.
 * The hash is stored in the database (hearth_devices.pairing_hash).
 *
 * @returns {{ secret: string, hash: string }}
 */
export const generatePairingSecret = () => {
  const secret = `hearth_sec_${crypto.randomBytes(24).toString('hex')}`;
  const hash = hashPairingSecret(secret);
  return { secret, hash };
};
