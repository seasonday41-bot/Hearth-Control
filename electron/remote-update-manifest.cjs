const crypto = require('node:crypto');
const path = require('node:path');

const SCHEMA_V2 = 'hearth-update-v2';
const APP_NAME = 'Hearth Control.app';
const EXPECTED_PLATFORM = 'darwin';
const EXPECTED_ARCH = 'arm64';
const SUPPORTED_ALGORITHM = 'ed25519';

/**
 * Built-in trusted public keys keyed by keyId.
 * Production keys are injected or configured; tests can pass custom trustedKeys.
 */
const DEFAULT_TRUSTED_KEYS = Object.freeze({});

/**
 * Deterministic JSON canonicalization (RFC 8785 subset).
 * Keys of objects are sorted lexicographically by UTF-16 code units.
 * Whitespace is eliminated.
 */
function canonicalizeJson(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw new TypeError('Cannot canonicalize non-finite numbers');
      }
      return JSON.stringify(value);
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalizeJson(item));
    return `[${items.join(',')}]`;
  }

  const sortedKeys = Object.keys(value).sort();
  const pairs = [];
  for (const key of sortedKeys) {
    const val = value[key];
    if (val === undefined || typeof val === 'function' || typeof val === 'symbol') {
      continue;
    }
    pairs.push(`${JSON.stringify(key)}:${canonicalizeJson(val)}`);
  }
  return `{${pairs.join(',')}}`;
}

/**
 * Extracts the canonical signing payload bytes for a remote manifest.
 * Excludes the `signature` field entirely so the unsigned document is signed.
 * Returns a UTF-8 Buffer.
 */
function getCanonicalSigningPayload(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new TypeError('Manifest must be a non-null object');
  }
  const { signature: _ignored, ...unsignedPayload } = manifest;
  const canonicalString = canonicalizeJson(unsignedPayload);
  return Buffer.from(canonicalString, 'utf8');
}

/**
 * Helper to check whether a string is a clean build ID.
 */
function isCleanBuildId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{5,127}$/.test(value);
}

/**
 * Helper to validate semantic version.
 */
function isSemver(value) {
  return typeof value === 'string' && /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.test(value);
}

/**
 * Helper to validate 64-character lowercase or uppercase hex hash.
 */
function isSha256Hex(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

/**
 * Validates whether an artifact path is safe and strictly relative.
 * Rejects:
 * - absolute paths (/foo, \foo, C:\foo)
 * - URLs (http://, https://, file://)
 * - path traversals (..)
 */
function isSafeRelativeArtifactPath(artifactPath) {
  if (typeof artifactPath !== 'string' || artifactPath.trim().length === 0) {
    return false;
  }
  if (artifactPath.startsWith('/') || artifactPath.startsWith('\\')) {
    return false;
  }
  if (path.win32.isAbsolute(artifactPath) || path.posix.isAbsolute(artifactPath)) {
    return false;
  }
  // URL scheme check: e.g. https://, http://, file://, ftp://
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(artifactPath)) {
    return false;
  }
  // Traversal segment check
  const segments = artifactPath.split(/[/\\]/);
  if (segments.some((seg) => seg === '..')) {
    return false;
  }
  return true;
}

/**
 * Validates the schema of a Hearth Remote Manifest v2.
 * @param {object} manifest
 * @param {{ requireSignature?: boolean }} [options]
 */
function validateRemoteManifestSchema(manifest, options = {}) {
  const requireSignature = options.requireSignature ?? true;

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Manifest must be a non-null object.');
  }

  if (manifest.schema !== SCHEMA_V2) {
    throw new Error(`Invalid manifest schema: expected '${SCHEMA_V2}', received '${manifest.schema}'.`);
  }

  if (!isSemver(manifest.version)) {
    throw new Error(`Invalid manifest version: '${manifest.version}'.`);
  }

  if (!isCleanBuildId(manifest.buildId)) {
    throw new Error(`Invalid manifest buildId: '${manifest.buildId}'.`);
  }

  if (typeof manifest.builtAt !== 'string' || Number.isNaN(Date.parse(manifest.builtAt))) {
    throw new Error(`Invalid manifest builtAt timestamp: '${manifest.builtAt}'.`);
  }

  if (typeof manifest.channel !== 'string' || manifest.channel.trim().length === 0) {
    throw new Error('Manifest channel must be a non-empty string.');
  }

  if (manifest.platform !== EXPECTED_PLATFORM) {
    throw new Error(`Unsupported manifest platform: expected '${EXPECTED_PLATFORM}', received '${manifest.platform}'.`);
  }

  if (manifest.arch !== EXPECTED_ARCH) {
    throw new Error(`Unsupported manifest arch: expected '${EXPECTED_ARCH}', received '${manifest.arch}'.`);
  }

  if (manifest.appPath !== APP_NAME) {
    throw new Error(`Invalid manifest appPath: expected '${APP_NAME}', received '${manifest.appPath}'.`);
  }

  if (!isSha256Hex(manifest.sha256)) {
    throw new Error('Invalid manifest application tree sha256: must be a 64-character hex string.');
  }

  if (!manifest.artifact || typeof manifest.artifact !== 'object' || Array.isArray(manifest.artifact)) {
    throw new Error('Manifest artifact must be a non-null object.');
  }

  if (manifest.artifact.kind !== 'dmg') {
    throw new Error(`Unsupported artifact kind: expected 'dmg', received '${manifest.artifact.kind}'.`);
  }

  if (!isSafeRelativeArtifactPath(manifest.artifact.path)) {
    throw new Error(`Invalid artifact path: must be a strictly relative path, received '${manifest.artifact.path}'.`);
  }

  if (typeof manifest.artifact.size !== 'number' || !Number.isInteger(manifest.artifact.size) || manifest.artifact.size <= 0) {
    throw new Error(`Invalid artifact size: must be a positive integer, received ${manifest.artifact.size}.`);
  }

  if (!isSha256Hex(manifest.artifact.sha256)) {
    throw new Error('Invalid artifact sha256: must be a 64-character hex string.');
  }

  if (typeof manifest.releaseNotes !== 'string') {
    throw new Error('Manifest releaseNotes must be a string.');
  }

  // Optional source-build metadata used only by the owner's LOCAL_UPDATE
  // mode. Public DMG updates remain unchanged; when present this signed
  // record pins the source repository, full commit, archive path and hash.
  if (manifest.source !== undefined) {
    const source = manifest.source;
    if (!source || typeof source !== 'object' || Array.isArray(source)
      || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.repository || '')
      || !/^[0-9a-f]{40}$/.test(source.commit || '')
      || source.archivePath !== `${source.repository}/archive/${source.commit}.tar.gz`
      || !/^[a-f0-9]{64}$/i.test(source.sha256 || '')) {
      throw new Error('Manifest source metadata is invalid.');
    }
  }

  if (requireSignature) {
    if (!manifest.signature || typeof manifest.signature !== 'object' || Array.isArray(manifest.signature)) {
      throw new Error('Manifest signature object is required.');
    }

    if (manifest.signature.algorithm !== SUPPORTED_ALGORITHM) {
      throw new Error(`Unsupported signature algorithm: expected '${SUPPORTED_ALGORITHM}', received '${manifest.signature.algorithm}'.`);
    }

    if (typeof manifest.signature.keyId !== 'string' || manifest.signature.keyId.trim().length === 0) {
      throw new Error('Manifest signature keyId must be a non-empty string.');
    }

    if (typeof manifest.signature.value !== 'string' || manifest.signature.value.trim().length === 0) {
      throw new Error('Manifest signature value must be a non-empty string.');
    }

    // Check base64 validity and 64-byte decoded signature length for Ed25519
    const base64Clean = manifest.signature.value.trim();
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64Clean)) {
      throw new Error('Malformed signature encoding: not valid base64.');
    }

    const decoded = Buffer.from(base64Clean, 'base64');
    if (decoded.length !== 64) {
      throw new Error(`Malformed signature encoding: expected 64 decoded bytes for Ed25519, got ${decoded.length}.`);
    }
  }

  return true;
}

/**
 * Signs an unsigned remote manifest with an Ed25519 private key.
 * @param {{ manifest: object, privateKey: string|crypto.KeyObject, keyId: string }} params
 * @returns {object} signed manifest
 */
function signRemoteManifest({ manifest, privateKey, keyId }) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('Manifest is required.');
  }
  if (!keyId || typeof keyId !== 'string' || keyId.trim().length === 0) {
    throw new Error('keyId is required.');
  }
  if (!privateKey) {
    throw new Error('privateKey is required.');
  }

  // Validate unsigned schema first
  validateRemoteManifestSchema(manifest, { requireSignature: false });

  const payloadBuffer = getCanonicalSigningPayload(manifest);
  const signatureBuffer = crypto.sign(null, payloadBuffer, privateKey);
  const signatureBase64 = signatureBuffer.toString('base64');

  const { signature: _ignored, ...unsignedFields } = manifest;
  const signedManifest = {
    ...unsignedFields,
    signature: {
      algorithm: SUPPORTED_ALGORITHM,
      keyId: keyId.trim(),
      value: signatureBase64,
    },
  };

  validateRemoteManifestSchema(signedManifest, { requireSignature: true });
  return signedManifest;
}

/**
 * Verifies a signed remote manifest against trusted public keys.
 * Fails closed on:
 * - malformed schema
 * - unknown keyId
 * - unsupported algorithm
 * - malformed signature encoding
 * - signature verification failure
 *
 * @param {object} manifest
 * @param {{ trustedKeys?: Record<string, string|crypto.KeyObject> }} [options]
 * @returns {{ valid: boolean, manifest: object }}
 */
function verifyRemoteManifest(manifest, options = {}) {
  const trustedKeys = options.trustedKeys || DEFAULT_TRUSTED_KEYS;

  // 1. Schema & signature field validation
  validateRemoteManifestSchema(manifest, { requireSignature: true });

  const { keyId, algorithm, value } = manifest.signature;

  if (algorithm !== SUPPORTED_ALGORITHM) {
    throw new Error(`Unsupported signature algorithm: '${algorithm}'.`);
  }

  const publicKey = trustedKeys[keyId];
  if (!publicKey) {
    throw new Error(`Unknown or untrusted signing keyId: '${keyId}'.`);
  }

  const payloadBuffer = getCanonicalSigningPayload(manifest);
  const signatureBuffer = Buffer.from(value.trim(), 'base64');

  let isValid = false;
  try {
    isValid = crypto.verify(null, payloadBuffer, publicKey, signatureBuffer);
  } catch (err) {
    throw new Error(`Signature verification error: ${err.message}`);
  }

  if (!isValid) {
    throw new Error('Manifest signature verification failed.');
  }

  return { valid: true, manifest };
}

module.exports = {
  SCHEMA_V2,
  APP_NAME,
  EXPECTED_PLATFORM,
  EXPECTED_ARCH,
  SUPPORTED_ALGORITHM,
  DEFAULT_TRUSTED_KEYS,
  canonicalizeJson,
  getCanonicalSigningPayload,
  validateRemoteManifestSchema,
  signRemoteManifest,
  verifyRemoteManifest,
  isSafeRelativeArtifactPath,
};
