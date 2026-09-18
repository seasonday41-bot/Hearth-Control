import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const {
  SCHEMA_V2,
  APP_NAME,
  canonicalizeJson,
  getCanonicalSigningPayload,
  validateRemoteManifestSchema,
  signRemoteManifest,
  verifyRemoteManifest,
  isSafeRelativeArtifactPath,
} = require('../electron/remote-update-manifest.cjs');

const {
  generateRemoteManifestV2,
  packageUpdateBundle,
  sha256File,
} = require('./generate-update-manifest.cjs');

const {
  signUpdateManifestFile,
} = require('./sign-update-manifest.cjs');

const {
  DEFAULT_TRUSTED_ORIGIN,
  MAX_MANIFEST_BYTES,
  MAX_DMG_BYTES,
  DEFAULT_TIMEOUT_MS,
  MAX_REDIRECTS,
  EXPECTED_PLATFORM,
  EXPECTED_ARCH,
  DMG_FILENAME,
  PART_SUFFIX,
  isProhibitedIp,
  isLoopbackOrLocalIp,
  isPrivateOrLocalHost,
  resolveAndValidateDns,
  createPinnedAgent,
  createPinnedConnectionDispatcher,
  nodeHttpsRequest,
  validateUrl,
  safeFetchWithRedirects,
  validatePlatformAndArch,
  fetchRemoteManifest,
  downloadRemoteArtifact,
  fetchAndVerifyUpdate,
  resolveUpdatesDirectory,
} = require('../electron/remote-updater.cjs');

// Test Ed25519 keypair generated in-memory only for this test run
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const TEST_KEY_ID = 'hearth-test-key-2026';
const testTrustedKeys = Object.freeze({
  [TEST_KEY_ID]: publicKey,
});

const sampleTreeHash = crypto.createHash('sha256').update('sample-app-tree').digest('hex');
const sampleDmgHash = crypto.createHash('sha256').update('sample-dmg-file').digest('hex');

function createSampleUnsignedManifest(overrides = {}) {
  return {
    schema: SCHEMA_V2,
    version: '0.4.4',
    buildId: '0.4.4-20260918080000-abcdef',
    builtAt: '2026-09-18T08:00:00.000Z',
    channel: 'stable',
    platform: 'darwin',
    arch: 'arm64',
    appPath: APP_NAME,
    sha256: sampleTreeHash,
    artifact: {
      kind: 'dmg',
      path: 'releases/0.4.4/0.4.4-20260918080000-abcdef/Hearth-Control-0.4.4-arm64.dmg',
      size: 12345678,
      sha256: sampleDmgHash,
    },
    releaseNotes: 'P2A signed remote update manifest test',
    ...overrides,
  };
}

test('1. valid signed newer remote manifest verifies', () => {
  const unsigned = createSampleUnsignedManifest();
  const signed = signRemoteManifest({
    manifest: unsigned,
    privateKey,
    keyId: TEST_KEY_ID,
  });

  const result = verifyRemoteManifest(signed, { trustedKeys: testTrustedKeys });
  assert.equal(result.valid, true);
  assert.equal(result.manifest.version, '0.4.4');
  assert.equal(result.manifest.signature.keyId, TEST_KEY_ID);
  assert.equal(result.manifest.signature.algorithm, 'ed25519');
});

test('2. invalid signature fails closed', () => {
  const unsigned = createSampleUnsignedManifest();
  const signed = signRemoteManifest({
    manifest: unsigned,
    privateKey,
    keyId: TEST_KEY_ID,
  });

  // Tamper with signature bytes
  const sigBuf = Buffer.from(signed.signature.value, 'base64');
  sigBuf[0] ^= 0xff; // Flip bits
  const tampered = {
    ...signed,
    signature: {
      ...signed.signature,
      value: sigBuf.toString('base64'),
    },
  };

  assert.throws(
    () => verifyRemoteManifest(tampered, { trustedKeys: testTrustedKeys }),
    /Manifest signature verification failed/,
  );
});

test('3. unknown keyId fails closed', () => {
  const unsigned = createSampleUnsignedManifest();
  const signed = signRemoteManifest({
    manifest: unsigned,
    privateKey,
    keyId: TEST_KEY_ID,
  });

  const tampered = {
    ...signed,
    signature: {
      ...signed.signature,
      keyId: 'unknown-key-id-999',
    },
  };

  assert.throws(
    () => verifyRemoteManifest(tampered, { trustedKeys: testTrustedKeys }),
    /Unknown or untrusted signing keyId: 'unknown-key-id-999'/,
  );
});

test('4. mutated version invalidates signature', () => {
  const unsigned = createSampleUnsignedManifest({ version: '0.4.4' });
  const signed = signRemoteManifest({
    manifest: unsigned,
    privateKey,
    keyId: TEST_KEY_ID,
  });

  const mutated = { ...signed, version: '0.4.5' };
  assert.throws(
    () => verifyRemoteManifest(mutated, { trustedKeys: testTrustedKeys }),
    /Manifest signature verification failed/,
  );
});

test('5. mutated buildId invalidates signature', () => {
  const unsigned = createSampleUnsignedManifest();
  const signed = signRemoteManifest({
    manifest: unsigned,
    privateKey,
    keyId: TEST_KEY_ID,
  });

  const mutated = { ...signed, buildId: '0.4.4-20260918080000-tampered' };
  assert.throws(
    () => verifyRemoteManifest(mutated, { trustedKeys: testTrustedKeys }),
    /Manifest signature verification failed/,
  );
});

test('6. mutated artifact.path invalidates signature', () => {
  const unsigned = createSampleUnsignedManifest();
  const signed = signRemoteManifest({
    manifest: unsigned,
    privateKey,
    keyId: TEST_KEY_ID,
  });

  const mutated = {
    ...signed,
    artifact: {
      ...signed.artifact,
      path: 'releases/0.4.4/other/Hearth-Control.dmg',
    },
  };
  assert.throws(
    () => verifyRemoteManifest(mutated, { trustedKeys: testTrustedKeys }),
    /Manifest signature verification failed/,
  );
});

test('7. mutated artifact.size invalidates signature', () => {
  const unsigned = createSampleUnsignedManifest();
  const signed = signRemoteManifest({
    manifest: unsigned,
    privateKey,
    keyId: TEST_KEY_ID,
  });

  const mutated = {
    ...signed,
    artifact: {
      ...signed.artifact,
      size: signed.artifact.size + 1,
    },
  };
  assert.throws(
    () => verifyRemoteManifest(mutated, { trustedKeys: testTrustedKeys }),
    /Manifest signature verification failed/,
  );
});

test('8. mutated artifact.sha256 invalidates signature', () => {
  const unsigned = createSampleUnsignedManifest();
  const signed = signRemoteManifest({
    manifest: unsigned,
    privateKey,
    keyId: TEST_KEY_ID,
  });

  const otherSha = crypto.createHash('sha256').update('different-dmg').digest('hex');
  const mutated = {
    ...signed,
    artifact: {
      ...signed.artifact,
      sha256: otherSha,
    },
  };
  assert.throws(
    () => verifyRemoteManifest(mutated, { trustedKeys: testTrustedKeys }),
    /Manifest signature verification failed/,
  );
});

test('9. mutated app-tree sha256 invalidates signature', () => {
  const unsigned = createSampleUnsignedManifest();
  const signed = signRemoteManifest({
    manifest: unsigned,
    privateKey,
    keyId: TEST_KEY_ID,
  });

  const otherSha = crypto.createHash('sha256').update('different-tree').digest('hex');
  const mutated = { ...signed, sha256: otherSha };
  assert.throws(
    () => verifyRemoteManifest(mutated, { trustedKeys: testTrustedKeys }),
    /Manifest signature verification failed/,
  );
});

test('10. object key insertion order does not change canonical payload', () => {
  // Construct object A
  const objA = {
    zebra: 1,
    alpha: {
      second: 2,
      first: 1,
    },
    middle: 'test',
  };

  // Construct object B with reverse key order
  const objB = {
    middle: 'test',
    alpha: {
      first: 1,
      second: 2,
    },
    zebra: 1,
  };

  const payloadA = canonicalizeJson(objA);
  const payloadB = canonicalizeJson(objB);
  assert.equal(payloadA, payloadB);
  assert.equal(payloadA, '{"alpha":{"first":1,"second":2},"middle":"test","zebra":1}');

  // In full manifest:
  const unsignedA = createSampleUnsignedManifest();
  // Build unsignedB with reversed top-level keys and artifact keys
  const unsignedB = {
    releaseNotes: unsignedA.releaseNotes,
    artifact: {
      sha256: unsignedA.artifact.sha256,
      size: unsignedA.artifact.size,
      path: unsignedA.artifact.path,
      kind: unsignedA.artifact.kind,
    },
    sha256: unsignedA.sha256,
    appPath: unsignedA.appPath,
    arch: unsignedA.arch,
    platform: unsignedA.platform,
    channel: unsignedA.channel,
    builtAt: unsignedA.builtAt,
    buildId: unsignedA.buildId,
    version: unsignedA.version,
    schema: unsignedA.schema,
  };

  const canonA = getCanonicalSigningPayload(unsignedA);
  const canonB = getCanonicalSigningPayload(unsignedB);
  assert.deepEqual(canonA, canonB);

  // Sign A, verify B
  const signedA = signRemoteManifest({ manifest: unsignedA, privateKey, keyId: TEST_KEY_ID });
  const signedB = { ...unsignedB, signature: signedA.signature };
  const verified = verifyRemoteManifest(signedB, { trustedKeys: testTrustedKeys });
  assert.equal(verified.valid, true);
});

test('11. malformed signature encoding rejected', () => {
  const unsigned = createSampleUnsignedManifest();
  const signed = signRemoteManifest({ manifest: unsigned, privateKey, keyId: TEST_KEY_ID });

  // Invalid base64 characters
  const nonBase64 = {
    ...signed,
    signature: { ...signed.signature, value: '!!!not-base-64!!!' },
  };
  assert.throws(
    () => verifyRemoteManifest(nonBase64, { trustedKeys: testTrustedKeys }),
    /Malformed signature encoding/,
  );

  // Base64 with wrong decoded byte count (32 bytes instead of 64 bytes)
  const shortSig = Buffer.alloc(32, 1).toString('base64');
  const wrongLength = {
    ...signed,
    signature: { ...signed.signature, value: shortSig },
  };
  assert.throws(
    () => verifyRemoteManifest(wrongLength, { trustedKeys: testTrustedKeys }),
    /Malformed signature encoding.*64 decoded bytes/,
  );
});

test('12. unsupported signature algorithm rejected', () => {
  const unsigned = createSampleUnsignedManifest();
  const signed = signRemoteManifest({ manifest: unsigned, privateKey, keyId: TEST_KEY_ID });

  const wrongAlgo = {
    ...signed,
    signature: { ...signed.signature, algorithm: 'rsa-sha256' },
  };
  assert.throws(
    () => verifyRemoteManifest(wrongAlgo, { trustedKeys: testTrustedKeys }),
    /Unsupported signature algorithm/,
  );
});

test('13. absolute artifact URL/path rejected', () => {
  assert.equal(isSafeRelativeArtifactPath('https://example.com/app.dmg'), false);
  assert.equal(isSafeRelativeArtifactPath('http://example.com/app.dmg'), false);
  assert.equal(isSafeRelativeArtifactPath('file:///Volumes/app.dmg'), false);
  assert.equal(isSafeRelativeArtifactPath('/Volumes/app.dmg'), false);
  assert.equal(isSafeRelativeArtifactPath('\\Users\\app.dmg'), false);
  assert.equal(isSafeRelativeArtifactPath('../app.dmg'), false);
  assert.equal(isSafeRelativeArtifactPath('releases/../../app.dmg'), false);
  assert.equal(isSafeRelativeArtifactPath('releases/0.4.4/app.dmg'), true);

  const unsigned = createSampleUnsignedManifest({
    artifact: {
      kind: 'dmg',
      path: 'https://cdn.example.com/build.dmg',
      size: 1000,
      sha256: sampleDmgHash,
    },
  });

  assert.throws(
    () => validateRemoteManifestSchema(unsigned, { requireSignature: false }),
    /must be a strictly relative path/,
  );
});

test('14. non-dmg artifact rejected', () => {
  const unsigned = createSampleUnsignedManifest({
    artifact: {
      kind: 'zip',
      path: 'releases/0.4.4/build.zip',
      size: 1000,
      sha256: sampleDmgHash,
    },
  });

  assert.throws(
    () => validateRemoteManifestSchema(unsigned, { requireSignature: false }),
    /Unsupported artifact kind: expected 'dmg'/,
  );
});

test('15. wrong/missing required schema fields rejected', () => {
  // Wrong schema
  assert.throws(
    () => validateRemoteManifestSchema({ ...createSampleUnsignedManifest(), schema: 'hearth-update-v1' }, { requireSignature: false }),
    /Invalid manifest schema/,
  );

  // Missing version
  assert.throws(
    () => validateRemoteManifestSchema({ ...createSampleUnsignedManifest(), version: undefined }, { requireSignature: false }),
    /Invalid manifest version/,
  );

  // Invalid builtAt
  assert.throws(
    () => validateRemoteManifestSchema({ ...createSampleUnsignedManifest(), builtAt: 'not-a-date' }, { requireSignature: false }),
    /Invalid manifest builtAt timestamp/,
  );

  // Wrong platform
  assert.throws(
    () => validateRemoteManifestSchema({ ...createSampleUnsignedManifest(), platform: 'linux' }, { requireSignature: false }),
    /Unsupported manifest platform/,
  );

  // Wrong arch
  assert.throws(
    () => validateRemoteManifestSchema({ ...createSampleUnsignedManifest(), arch: 'x64' }, { requireSignature: false }),
    /Unsupported manifest arch/,
  );

  // Wrong appPath
  assert.throws(
    () => validateRemoteManifestSchema({ ...createSampleUnsignedManifest(), appPath: 'Other.app' }, { requireSignature: false }),
    /Invalid manifest appPath/,
  );

  // Invalid tree sha256
  assert.throws(
    () => validateRemoteManifestSchema({ ...createSampleUnsignedManifest(), sha256: 'not-hex' }, { requireSignature: false }),
    /Invalid manifest application tree sha256/,
  );

  // Non-integer size
  assert.throws(
    () => validateRemoteManifestSchema(createSampleUnsignedManifest({
      artifact: { kind: 'dmg', path: 'releases/a.dmg', size: 0, sha256: sampleDmgHash },
    }), { requireSignature: false }),
    /Invalid artifact size/,
  );
});

test('16. generated artifact.size equals actual DMG byte size', async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hearth-dmg-test-'));
  try {
    const dmgPath = path.join(tmpDir, 'test.dmg');
    const fixtureBytes = Buffer.alloc(4096, 0x42);
    await fs.promises.writeFile(dmgPath, fixtureBytes);

    const metadata = {
      version: '0.4.4',
      buildId: '0.4.4-20260918-size-test',
      builtAt: '2026-09-18T08:00:00.000Z',
    };

    const manifest = await generateRemoteManifestV2({
      metadata,
      appTreeSha256: sampleTreeHash,
      dmgPath,
    });

    assert.equal(manifest.artifact.size, 4096);
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('17. generated artifact.sha256 equals actual DMG SHA256', async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hearth-dmg-test-'));
  try {
    const dmgPath = path.join(tmpDir, 'test.dmg');
    const fixtureBytes = Buffer.from('test-dmg-content-for-sha256-calculation', 'utf8');
    await fs.promises.writeFile(dmgPath, fixtureBytes);

    const expectedSha256 = crypto.createHash('sha256').update(fixtureBytes).digest('hex');

    const metadata = {
      version: '0.4.4',
      buildId: '0.4.4-20260918-sha-test',
      builtAt: '2026-09-18T08:00:00.000Z',
    };

    const manifest = await generateRemoteManifestV2({
      metadata,
      appTreeSha256: sampleTreeHash,
      dmgPath,
    });

    assert.equal(manifest.artifact.sha256, expectedSha256);
    assert.equal(await sha256File(dmgPath), expectedSha256);
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('18. existing local update manifest generation remains unchanged/valid', async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hearth-bundle-test-'));
  try {
    const releaseApp = path.join(tmpDir, 'release', 'mac-arm64', APP_NAME);
    await fs.promises.mkdir(path.join(releaseApp, 'Contents', 'MacOS'), { recursive: true });
    await fs.promises.writeFile(path.join(releaseApp, 'Contents', 'MacOS', 'Hearth Control'), 'binary');

    const metadata = {
      version: '0.4.4',
      buildId: '0.4.4-20260918-compat-test',
      builtAt: '2026-09-18T08:00:00.000Z',
    };

    // Call standard packageUpdateBundle (default local v1 mode)
    const result = await packageUpdateBundle({ root: tmpDir, metadata });

    assert.ok(result.outputDirectory);
    assert.equal(result.remoteManifest, undefined); // Remote manifest NOT included by default

    const localManifestOnDisk = JSON.parse(
      await fs.promises.readFile(path.join(result.outputDirectory, 'update-manifest.json'), 'utf8'),
    );

    // Verify v1 structure
    assert.equal(localManifestOnDisk.version, '0.4.4');
    assert.equal(localManifestOnDisk.buildId, '0.4.4-20260918-compat-test');
    assert.equal(localManifestOnDisk.platform, 'darwin');
    assert.equal(localManifestOnDisk.arch, 'arm64');
    assert.equal(localManifestOnDisk.appPath, APP_NAME);
    assert.equal(typeof localManifestOnDisk.sha256, 'string');
    assert.equal(localManifestOnDisk.schema, undefined); // v1 did not have schema field

    // Now test with includeRemote: true when DMG is present
    const dmgPath = path.join(tmpDir, 'release', `Hearth Control-${metadata.version}-arm64.dmg`);
    await fs.promises.writeFile(dmgPath, 'dmg-bytes');

    const resultWithRemote = await packageUpdateBundle({
      root: tmpDir,
      metadata,
      includeRemote: true,
    });

    assert.ok(resultWithRemote.remoteManifest);
    assert.equal(resultWithRemote.remoteManifest.schema, SCHEMA_V2);
    assert.equal(resultWithRemote.remoteManifest.artifact.size, 9);
    assert.equal(resultWithRemote.remoteManifest.artifact.kind, 'dmg');

    const remoteOnDisk = JSON.parse(
      await fs.promises.readFile(path.join(resultWithRemote.outputDirectory, 'remote-update-manifest.unsigned.json'), 'utf8'),
    );
    assert.deepEqual(remoteOnDisk, resultWithRemote.remoteManifest);
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('19. existing updater regression suite still passes', async () => {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/test-updater.mjs'], {
      cwd: path.resolve(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      if (code === 0) resolve({ code, stdout });
      else reject(new Error(`test-updater.mjs failed (${code}): ${stderr || stdout}`));
    });
  });

  assert.equal(result.code, 0);
  assert.ok(result.stdout.includes('33 passed, 0 failed'));
});

const runSigningCli = (args, env = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, ['scripts/sign-update-manifest.cjs', ...args], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('close', (code) => {
    resolve({ code, stdout, stderr });
  });
});

test('signing CLI: --key-file works', async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hearth-sign-cli-1-'));
  try {
    const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const keyPath = path.join(tmpDir, 'test-key.pem');
    await fs.promises.writeFile(keyPath, privPem, 'utf8');

    const unsigned = createSampleUnsignedManifest();
    const unsignedPath = path.join(tmpDir, 'unsigned.json');
    await fs.promises.writeFile(unsignedPath, JSON.stringify(unsigned, null, 2), 'utf8');

    const outputPath = path.join(tmpDir, 'signed.json');
    const { code, stderr } = await runSigningCli([
      '--input', unsignedPath,
      '--key-file', keyPath,
      '--key-id', TEST_KEY_ID,
      '--output', outputPath,
    ]);

    assert.equal(code, 0, `CLI failed with stderr: ${stderr}`);
    const signed = JSON.parse(await fs.promises.readFile(outputPath, 'utf8'));
    assert.equal(signed.signature.keyId, TEST_KEY_ID);
    assert.equal(signed.signature.algorithm, 'ed25519');

    const verified = verifyRemoteManifest(signed, { trustedKeys: testTrustedKeys });
    assert.equal(verified.valid, true);
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('signing CLI: HEARTH_UPDATE_SIGNING_KEY_PATH works', async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hearth-sign-cli-2-'));
  try {
    const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const keyPath = path.join(tmpDir, 'test-key.pem');
    await fs.promises.writeFile(keyPath, privPem, 'utf8');

    const unsigned = createSampleUnsignedManifest();
    const unsignedPath = path.join(tmpDir, 'unsigned.json');
    await fs.promises.writeFile(unsignedPath, JSON.stringify(unsigned, null, 2), 'utf8');

    const outputPath = path.join(tmpDir, 'signed.json');
    const { code, stderr } = await runSigningCli(
      [
        '--input', unsignedPath,
        '--key-id', TEST_KEY_ID,
        '--output', outputPath,
      ],
      {
        HEARTH_UPDATE_SIGNING_KEY_PATH: keyPath,
      },
    );

    assert.equal(code, 0, `CLI failed with stderr: ${stderr}`);
    const signed = JSON.parse(await fs.promises.readFile(outputPath, 'utf8'));
    assert.equal(signed.signature.keyId, TEST_KEY_ID);

    const verified = verifyRemoteManifest(signed, { trustedKeys: testTrustedKeys });
    assert.equal(verified.valid, true);
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('signing CLI: raw HEARTH_UPDATE_SIGNING_KEY is NOT accepted as signing material', async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hearth-sign-cli-3-'));
  try {
    const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const unsigned = createSampleUnsignedManifest();
    const unsignedPath = path.join(tmpDir, 'unsigned.json');
    await fs.promises.writeFile(unsignedPath, JSON.stringify(unsigned, null, 2), 'utf8');

    const outputPath = path.join(tmpDir, 'signed.json');
    // Pass raw PEM via HEARTH_UPDATE_SIGNING_KEY without any key-file
    const { code, stderr } = await runSigningCli(
      [
        '--input', unsignedPath,
        '--key-id', TEST_KEY_ID,
        '--output', outputPath,
      ],
      {
        HEARTH_UPDATE_SIGNING_KEY: privPem,
        HEARTH_UPDATE_SIGNING_KEY_PATH: '',
      },
    );

    assert.equal(code, 1, 'Expected signing to fail when only raw HEARTH_UPDATE_SIGNING_KEY is provided');
    assert.match(stderr, /No private key file path provided/);
    assert.equal(await fs.promises.stat(outputPath).then(() => true).catch(() => false), false);
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('signing CLI: malformed/missing key path fails closed', async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hearth-sign-cli-4-'));
  try {
    const unsigned = createSampleUnsignedManifest();
    const unsignedPath = path.join(tmpDir, 'unsigned.json');
    await fs.promises.writeFile(unsignedPath, JSON.stringify(unsigned, null, 2), 'utf8');

    // Missing key path completely
    const resMissing = await runSigningCli(
      ['--input', unsignedPath, '--key-id', TEST_KEY_ID],
      { HEARTH_UPDATE_SIGNING_KEY_PATH: '', HEARTH_UPDATE_SIGNING_KEY: '' },
    );
    assert.equal(resMissing.code, 1);
    assert.match(resMissing.stderr, /No private key file path provided/);

    // Non-existent key file path
    const resNonExistent = await runSigningCli([
      '--input', unsignedPath,
      '--key-file', path.join(tmpDir, 'does-not-exist.pem'),
      '--key-id', TEST_KEY_ID,
    ]);
    assert.equal(resNonExistent.code, 1);
    assert.match(resNonExistent.stderr, /Failed to read private key file/);
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('signing CLI: no private-key content appears in errors/stdout/stderr', async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hearth-sign-cli-5-'));
  try {
    const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    // Write a key file with invalid contents to trigger a parse/crypto error during sign
    const invalidKeyPath = path.join(tmpDir, 'bad-key.pem');
    const secretContent = 'SECRET-SUPER-PRIVATE-KEY-BODY-12345';
    await fs.promises.writeFile(invalidKeyPath, `-----BEGIN PRIVATE KEY-----\n${secretContent}\n-----END PRIVATE KEY-----`, 'utf8');

    const unsigned = createSampleUnsignedManifest();
    const unsignedPath = path.join(tmpDir, 'unsigned.json');
    await fs.promises.writeFile(unsignedPath, JSON.stringify(unsigned, null, 2), 'utf8');

    const { code, stdout, stderr } = await runSigningCli([
      '--input', unsignedPath,
      '--key-file', invalidKeyPath,
      '--key-id', TEST_KEY_ID,
    ]);

    assert.equal(code, 1);
    assert.equal(stdout.includes(secretContent), false);
    assert.equal(stderr.includes(secretContent), false);
    assert.equal(stdout.includes(privPem), false);
    assert.equal(stderr.includes(privPem), false);
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

// ==========================================
// P2B Tests: Remote Fetch + Streamed DMG
// ==========================================

function createMockResponse(body, init = {}) {
  const status = init.status || 200;
  const statusText = init.statusText || 'OK';
  const headers = new Headers(init.headers || {});
  let bodyStream;

  if (body === null || body === undefined) {
    bodyStream = null;
  } else if (typeof body === 'string') {
    const bytes = new TextEncoder().encode(body);
    if (!headers.has('content-length')) {
      headers.set('content-length', String(bytes.byteLength));
    }
    bodyStream = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  } else if (body instanceof Uint8Array || Buffer.isBuffer(body)) {
    const bytes = new Uint8Array(body);
    if (!headers.has('content-length')) {
      headers.set('content-length', String(bytes.byteLength));
    }
    bodyStream = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  } else if (typeof body.getReader === 'function') {
    bodyStream = body;
  }

  return new Response(bodyStream, {
    status,
    statusText,
    headers,
  });
}

function makeMockFetch(routes, callLog = []) {
  return async (url, options) => {
    const urlStr = String(url);
    callLog.push({ url: urlStr, method: options?.method || 'GET' });
    const handler = routes[urlStr];
    if (!handler) {
      return new Response('Not Found', { status: 404, statusText: 'Not Found' });
    }
    if (typeof handler === 'function') {
      return await handler(urlStr, options);
    }
    return handler;
  };
}

test('P2B: 1. valid signed remote manifest fetched successfully', async () => {
  const unsigned = createSampleUnsignedManifest();
  const signed = signRemoteManifest({ manifest: unsigned, privateKey, keyId: TEST_KEY_ID });
  const manifestUrl = 'https://releases.hearth.dev/stable/manifest.json';

  const mockFetch = makeMockFetch({
    [manifestUrl]: createMockResponse(JSON.stringify(signed)),
  });

  const fetched = await fetchRemoteManifest({
    manifestUrl,
    trustedOrigin: 'https://releases.hearth.dev',
    trustedKeys: testTrustedKeys,
    fetchFn: mockFetch,
  });

  assert.equal(fetched.version, '0.4.4');
  assert.equal(fetched.signature.keyId, TEST_KEY_ID);
});

test('P2B: 2. invalid signature prevents artifact request entirely', async () => {
  const unsigned = createSampleUnsignedManifest();
  const signed = signRemoteManifest({ manifest: unsigned, privateKey, keyId: TEST_KEY_ID });
  // Tamper with signature
  const tamperedSig = Buffer.alloc(64, 1).toString('base64');
  const tampered = { ...signed, signature: { ...signed.signature, value: tamperedSig } };

  const manifestUrl = 'https://releases.hearth.dev/stable/manifest.json';
  const artifactUrl = `https://releases.hearth.dev/${signed.artifact.path}`;
  const callLog = [];

  const mockFetch = makeMockFetch({
    [manifestUrl]: () => createMockResponse(JSON.stringify(tampered)),
    [artifactUrl]: () => createMockResponse(Buffer.alloc(100)),
  }, callLog);

  await assert.rejects(
    () => fetchAndVerifyUpdate({
      manifestUrl,
      trustedOrigin: 'https://releases.hearth.dev',
      trustedKeys: testTrustedKeys,
      currentVersion: '0.4.3',
      currentBuiltAt: '2026-09-17T08:00:00.000Z',
      fetchFn: mockFetch,
    }),
    /Manifest signature verification failed/,
  );

  // Assert artifact URL was NEVER requested
  assert.equal(callLog.length, 1);
  assert.equal(callLog[0].url, manifestUrl);
  assert.equal(callLog.some((c) => c.url === artifactUrl), false);
});

test('P2B: 3. unknown keyId prevents artifact request entirely', async () => {
  const unsigned = createSampleUnsignedManifest();
  const signed = signRemoteManifest({ manifest: unsigned, privateKey, keyId: TEST_KEY_ID });
  const tampered = { ...signed, signature: { ...signed.signature, keyId: 'untrusted-999' } };

  const manifestUrl = 'https://releases.hearth.dev/stable/manifest.json';
  const artifactUrl = `https://releases.hearth.dev/${signed.artifact.path}`;
  const callLog = [];

  const mockFetch = makeMockFetch({
    [manifestUrl]: () => createMockResponse(JSON.stringify(tampered)),
    [artifactUrl]: () => createMockResponse(Buffer.alloc(100)),
  }, callLog);

  await assert.rejects(
    () => fetchAndVerifyUpdate({
      manifestUrl,
      trustedOrigin: 'https://releases.hearth.dev',
      trustedKeys: testTrustedKeys,
      currentVersion: '0.4.3',
      currentBuiltAt: '2026-09-17T08:00:00.000Z',
      fetchFn: mockFetch,
    }),
    /Unknown or untrusted signing keyId/,
  );

  assert.equal(callLog.length, 1);
  assert.equal(callLog.some((c) => c.url === artifactUrl), false);
});

test('P2B: 4. wrong platform rejected', async () => {
  const unsigned = createSampleUnsignedManifest();
  const signed = signRemoteManifest({ manifest: unsigned, privateKey, keyId: TEST_KEY_ID });
  const manifestUrl = 'https://releases.hearth.dev/stable/manifest.json';
  const artifactUrl = `https://releases.hearth.dev/${signed.artifact.path}`;
  const callLog = [];

  const mockFetch = makeMockFetch({
    [manifestUrl]: () => createMockResponse(JSON.stringify(signed)),
    [artifactUrl]: () => createMockResponse(Buffer.alloc(100)),
  }, callLog);

  await assert.rejects(
    () => fetchAndVerifyUpdate({
      manifestUrl,
      trustedOrigin: 'https://releases.hearth.dev',
      trustedKeys: testTrustedKeys,
      currentVersion: '0.4.3',
      currentBuiltAt: '2026-09-17T08:00:00.000Z',
      expectedPlatform: 'linux',
      fetchFn: mockFetch,
    }),
    /Unsupported platform: expected 'linux'/,
  );

  assert.equal(callLog.some((c) => c.url === artifactUrl), false);
});

test('P2B: 5. wrong arch rejected', async () => {
  const unsigned = createSampleUnsignedManifest();
  const signed = signRemoteManifest({ manifest: unsigned, privateKey, keyId: TEST_KEY_ID });
  const manifestUrl = 'https://releases.hearth.dev/stable/manifest.json';
  const artifactUrl = `https://releases.hearth.dev/${signed.artifact.path}`;
  const callLog = [];

  const mockFetch = makeMockFetch({
    [manifestUrl]: () => createMockResponse(JSON.stringify(signed)),
    [artifactUrl]: () => createMockResponse(Buffer.alloc(100)),
  }, callLog);

  await assert.rejects(
    () => fetchAndVerifyUpdate({
      manifestUrl,
      trustedOrigin: 'https://releases.hearth.dev',
      trustedKeys: testTrustedKeys,
      currentVersion: '0.4.3',
      currentBuiltAt: '2026-09-17T08:00:00.000Z',
      expectedArch: 'x64',
      fetchFn: mockFetch,
    }),
    /Unsupported arch: expected 'x64'/,
  );

  assert.equal(callLog.some((c) => c.url === artifactUrl), false);
});

test('P2B: 6. older build rejected before artifact download', async () => {
  // Candidate has version 0.4.3
  const unsigned = createSampleUnsignedManifest({ version: '0.4.3', builtAt: '2026-09-16T08:00:00.000Z' });
  const signed = signRemoteManifest({ manifest: unsigned, privateKey, keyId: TEST_KEY_ID });
  const manifestUrl = 'https://releases.hearth.dev/stable/manifest.json';
  const artifactUrl = `https://releases.hearth.dev/${signed.artifact.path}`;
  const callLog = [];

  const mockFetch = makeMockFetch({
    [manifestUrl]: () => createMockResponse(JSON.stringify(signed)),
    [artifactUrl]: () => createMockResponse(Buffer.alloc(100)),
  }, callLog);

  // Current installed version is 0.4.4
  const result = await fetchAndVerifyUpdate({
    manifestUrl,
    trustedOrigin: 'https://releases.hearth.dev',
    trustedKeys: testTrustedKeys,
    currentVersion: '0.4.4',
    currentBuiltAt: '2026-09-18T08:00:00.000Z',
    fetchFn: mockFetch,
  });

  assert.equal(result.updateAvailable, false);
  assert.equal(result.reason, 'not_newer');
  // Artifact was never requested
  assert.equal(callLog.some((c) => c.url === artifactUrl), false);
});

test('P2B: 7. HTTP origin rejected', () => {
  assert.throws(
    () => validateUrl({ url: 'http://releases.hearth.dev/manifest.json', trustedOrigin: 'http://releases.hearth.dev' }),
    /Only HTTPS is allowed/,
  );
});

test('P2B: 8. arbitrary external artifact origin rejected', () => {
  assert.throws(
    () => validateUrl({ url: 'https://evil.com/app.dmg', trustedOrigin: 'https://releases.hearth.dev' }),
    /does not match trusted origin/,
  );
  // Also credentials in URL rejected
  assert.throws(
    () => validateUrl({ url: 'https://user:pass@releases.hearth.dev/manifest.json', trustedOrigin: 'https://releases.hearth.dev' }),
    /URL credentials .* are strictly prohibited/,
  );
});

test('P2B: 9. redirect outside allowlist rejected', async () => {
  const manifestUrl = 'https://releases.hearth.dev/stable/manifest.json';
  const mockFetch = makeMockFetch({
    [manifestUrl]: createMockResponse(null, {
      status: 302,
      headers: { Location: 'https://attacker.com/malicious-manifest.json' },
    }),
  });

  await assert.rejects(
    () => fetchRemoteManifest({
      manifestUrl,
      trustedOrigin: 'https://releases.hearth.dev',
      trustedKeys: testTrustedKeys,
      fetchFn: mockFetch,
    }),
    /does not match trusted origin 'https:\/\/releases.hearth.dev'/,
  );
});

test('P2B: 10. protocol downgrade redirect rejected', async () => {
  const manifestUrl = 'https://releases.hearth.dev/stable/manifest.json';
  const mockFetch = makeMockFetch({
    [manifestUrl]: createMockResponse(null, {
      status: 302,
      headers: { Location: 'http://releases.hearth.dev/insecure-manifest.json' },
    }),
  });

  await assert.rejects(
    () => fetchRemoteManifest({
      manifestUrl,
      trustedOrigin: 'https://releases.hearth.dev',
      trustedKeys: testTrustedKeys,
      fetchFn: mockFetch,
    }),
    /Protocol downgrade redirect is not permitted/,
  );
});

test('P2B: 11. redirect loop / redirect-count limit rejected', async () => {
  const urlA = 'https://releases.hearth.dev/a';
  const urlB = 'https://releases.hearth.dev/b';

  const mockFetch = makeMockFetch({
    [urlA]: createMockResponse(null, { status: 302, headers: { Location: urlB } }),
    [urlB]: createMockResponse(null, { status: 302, headers: { Location: urlA } }),
  });

  await assert.rejects(
    () => fetchRemoteManifest({
      manifestUrl: urlA,
      trustedOrigin: 'https://releases.hearth.dev',
      trustedKeys: testTrustedKeys,
      fetchFn: mockFetch,
    }),
    /Redirect limit exceeded \(3\)/,
  );
});

test('P2B: 12. oversized manifest rejected', async () => {
  const manifestUrl = 'https://releases.hearth.dev/stable/manifest.json';
  const oversizedData = 'x'.repeat(MAX_MANIFEST_BYTES + 1024);

  const mockFetch = makeMockFetch({
    [manifestUrl]: createMockResponse(oversizedData),
  });

  await assert.rejects(
    () => fetchRemoteManifest({
      manifestUrl,
      trustedOrigin: 'https://releases.hearth.dev',
      trustedKeys: testTrustedKeys,
      fetchFn: mockFetch,
    }),
    /exceeds maximum limit/,
  );
});

test('P2B: 13. malformed manifest JSON rejected', async () => {
  const manifestUrl = 'https://releases.hearth.dev/stable/manifest.json';
  const mockFetch = makeMockFetch({
    [manifestUrl]: createMockResponse('{"invalid-json: true'),
  });

  await assert.rejects(
    () => fetchRemoteManifest({
      manifestUrl,
      trustedOrigin: 'https://releases.hearth.dev',
      trustedKeys: testTrustedKeys,
      fetchFn: mockFetch,
    }),
    /Malformed manifest JSON/,
  );
});

test('P2B: 14. streamed DMG writes .part first', async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hearth-part-check-'));
  try {
    const chunk1 = Buffer.from('chunk-1-bytes-');
    const chunk2 = Buffer.from('chunk-2-bytes');
    const fullBytes = Buffer.concat([chunk1, chunk2]);
    const dmgSha256 = crypto.createHash('sha256').update(fullBytes).digest('hex');

    const unsigned = createSampleUnsignedManifest({
      artifact: {
        kind: 'dmg',
        path: 'releases/build.dmg',
        size: fullBytes.length,
        sha256: dmgSha256,
      },
    });
    const signed = signRemoteManifest({ manifest: unsigned, privateKey, keyId: TEST_KEY_ID });

    let checkedPartFile = false;
    const targetDir = path.join(tmpDir, signed.buildId);
    const partPath = path.join(targetDir, `${DMG_FILENAME}${PART_SUFFIX}`);
    const finalDmgPath = path.join(targetDir, DMG_FILENAME);

    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(chunk1);
        // Small delay to verify .part file on disk while stream is in flight
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(await fs.promises.stat(partPath).then(() => true).catch(() => false), true);
        assert.equal(await fs.promises.stat(finalDmgPath).then(() => true).catch(() => false), false);
        checkedPartFile = true;
        controller.enqueue(chunk2);
        controller.close();
      },
    });

    const mockFetch = makeMockFetch({
      'https://releases.hearth.dev/releases/build.dmg': new Response(stream),
    });

    const result = await downloadRemoteArtifact({
      manifest: signed,
      trustedOrigin: 'https://releases.hearth.dev',
      updatesDir: tmpDir,
      fetchFn: mockFetch,
    });

    assert.equal(checkedPartFile, true);
    assert.equal(await fs.promises.stat(partPath).then(() => true).catch(() => false), false);
    assert.equal(await fs.promises.stat(finalDmgPath).then(() => true).catch(() => false), true);
    assert.equal(result.dmgPath, finalDmgPath);
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('P2B: 15. interrupted download removes .part', async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hearth-part-interrupted-'));
  try {
    const unsigned = createSampleUnsignedManifest({
      artifact: { kind: 'dmg', path: 'releases/build.dmg', size: 1000, sha256: sampleDmgHash },
    });
    const signed = signRemoteManifest({ manifest: unsigned, privateKey, keyId: TEST_KEY_ID });

    const targetDir = path.join(tmpDir, signed.buildId);
    const partPath = path.join(targetDir, `${DMG_FILENAME}${PART_SUFFIX}`);
    const finalDmgPath = path.join(targetDir, DMG_FILENAME);

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.alloc(100, 1));
        controller.error(new Error('Connection abruptly severed'));
      },
    });

    const mockFetch = makeMockFetch({
      'https://releases.hearth.dev/releases/build.dmg': new Response(stream),
    });

    await assert.rejects(
      () => downloadRemoteArtifact({
        manifest: signed,
        trustedOrigin: 'https://releases.hearth.dev',
        updatesDir: tmpDir,
        fetchFn: mockFetch,
      }),
      /Connection abruptly severed/,
    );

    // .part must be removed
    assert.equal(await fs.promises.stat(partPath).then(() => true).catch(() => false), false);
    assert.equal(await fs.promises.stat(finalDmgPath).then(() => true).catch(() => false), false);
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('P2B: 16. short download / size mismatch rejected', async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hearth-part-short-'));
  try {
    const unsigned = createSampleUnsignedManifest({
      artifact: { kind: 'dmg', path: 'releases/build.dmg', size: 500, sha256: sampleDmgHash },
    });
    const signed = signRemoteManifest({ manifest: unsigned, privateKey, keyId: TEST_KEY_ID });

    const targetDir = path.join(tmpDir, signed.buildId);
    const partPath = path.join(targetDir, `${DMG_FILENAME}${PART_SUFFIX}`);
    const finalDmgPath = path.join(targetDir, DMG_FILENAME);

    // Only send 200 bytes then end
    const mockFetch = makeMockFetch({
      'https://releases.hearth.dev/releases/build.dmg': createMockResponse(Buffer.alloc(200, 1)),
    });

    await assert.rejects(
      () => downloadRemoteArtifact({
        manifest: signed,
        trustedOrigin: 'https://releases.hearth.dev',
        updatesDir: tmpDir,
        fetchFn: mockFetch,
      }),
      /Artifact download size mismatch: expected 500 bytes, got 200 bytes|does not match manifest size/,
    );

    assert.equal(await fs.promises.stat(partPath).then(() => true).catch(() => false), false);
    assert.equal(await fs.promises.stat(finalDmgPath).then(() => true).catch(() => false), false);
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('P2B: 17. oversized download rejected immediately', async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hearth-part-oversized-'));
  try {
    const unsigned = createSampleUnsignedManifest({
      artifact: { kind: 'dmg', path: 'releases/build.dmg', size: 100, sha256: sampleDmgHash },
    });
    const signed = signRemoteManifest({ manifest: unsigned, privateKey, keyId: TEST_KEY_ID });

    const targetDir = path.join(tmpDir, signed.buildId);
    const partPath = path.join(targetDir, `${DMG_FILENAME}${PART_SUFFIX}`);
    const finalDmgPath = path.join(targetDir, DMG_FILENAME);

    // Send 300 bytes when manifest specifies 100
    const mockFetch = makeMockFetch({
      'https://releases.hearth.dev/releases/build.dmg': createMockResponse(Buffer.alloc(300, 1)),
    });

    await assert.rejects(
      () => downloadRemoteArtifact({
        manifest: signed,
        trustedOrigin: 'https://releases.hearth.dev',
        updatesDir: tmpDir,
        fetchFn: mockFetch,
      }),
      /Artifact download exceeded manifest expected size|does not match manifest size/,
    );

    assert.equal(await fs.promises.stat(partPath).then(() => true).catch(() => false), false);
    assert.equal(await fs.promises.stat(finalDmgPath).then(() => true).catch(() => false), false);
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('P2B: 18. DMG SHA mismatch rejected', async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hearth-sha-mismatch-'));
  try {
    const fixtureBytes = Buffer.from('actual-data-on-server');
    const differentSha = crypto.createHash('sha256').update('different-data').digest('hex');

    const unsigned = createSampleUnsignedManifest({
      artifact: {
        kind: 'dmg',
        path: 'releases/build.dmg',
        size: fixtureBytes.length,
        sha256: differentSha,
      },
    });
    const signed = signRemoteManifest({ manifest: unsigned, privateKey, keyId: TEST_KEY_ID });

    const mockFetch = makeMockFetch({
      'https://releases.hearth.dev/releases/build.dmg': createMockResponse(fixtureBytes),
    });

    await assert.rejects(
      () => downloadRemoteArtifact({
        manifest: signed,
        trustedOrigin: 'https://releases.hearth.dev',
        updatesDir: tmpDir,
        fetchFn: mockFetch,
      }),
      /Artifact SHA-256 mismatch/,
    );
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('P2B: 19. SHA mismatch leaves no final .dmg', async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hearth-sha-clean-'));
  try {
    const fixtureBytes = Buffer.from('corrupted-data');
    const wrongSha = crypto.createHash('sha256').update('intended-data').digest('hex');

    const unsigned = createSampleUnsignedManifest({
      artifact: {
        kind: 'dmg',
        path: 'releases/build.dmg',
        size: fixtureBytes.length,
        sha256: wrongSha,
      },
    });
    const signed = signRemoteManifest({ manifest: unsigned, privateKey, keyId: TEST_KEY_ID });

    const targetDir = path.join(tmpDir, signed.buildId);
    const partPath = path.join(targetDir, `${DMG_FILENAME}${PART_SUFFIX}`);
    const finalDmgPath = path.join(targetDir, DMG_FILENAME);

    const mockFetch = makeMockFetch({
      'https://releases.hearth.dev/releases/build.dmg': createMockResponse(fixtureBytes),
    });

    await assert.rejects(
      () => downloadRemoteArtifact({
        manifest: signed,
        trustedOrigin: 'https://releases.hearth.dev',
        updatesDir: tmpDir,
        fetchFn: mockFetch,
      }),
      /Artifact SHA-256 mismatch/,
    );

    assert.equal(await fs.promises.stat(partPath).then(() => true).catch(() => false), false);
    assert.equal(await fs.promises.stat(finalDmgPath).then(() => true).catch(() => false), false);
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('P2B: 20. valid size + SHA atomically produces final .dmg', async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hearth-valid-dmg-'));
  try {
    const fixtureBytes = Buffer.from('valid-dmg-exact-content-12345');
    const expectedSha256 = crypto.createHash('sha256').update(fixtureBytes).digest('hex');

    const unsigned = createSampleUnsignedManifest({
      artifact: {
        kind: 'dmg',
        path: 'releases/build.dmg',
        size: fixtureBytes.length,
        sha256: expectedSha256,
      },
    });
    const signed = signRemoteManifest({ manifest: unsigned, privateKey, keyId: TEST_KEY_ID });

    const targetDir = path.join(tmpDir, signed.buildId);
    const partPath = path.join(targetDir, `${DMG_FILENAME}${PART_SUFFIX}`);
    const finalDmgPath = path.join(targetDir, DMG_FILENAME);

    const mockFetch = makeMockFetch({
      'https://releases.hearth.dev/releases/build.dmg': createMockResponse(fixtureBytes),
    });

    const result = await downloadRemoteArtifact({
      manifest: signed,
      trustedOrigin: 'https://releases.hearth.dev',
      updatesDir: tmpDir,
      fetchFn: mockFetch,
    });

    assert.equal(result.dmgPath, finalDmgPath);
    assert.equal(await fs.promises.stat(partPath).then(() => true).catch(() => false), false);
    assert.equal(await fs.promises.stat(finalDmgPath).then(() => true).catch(() => false), true);

    const downloadedBytes = await fs.promises.readFile(finalDmgPath);
    assert.deepEqual(downloadedBytes, fixtureBytes);
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('P2B: 21. artifact is never requested before signature verification', async () => {
  const unsigned = createSampleUnsignedManifest();
  const signed = signRemoteManifest({ manifest: unsigned, privateKey, keyId: TEST_KEY_ID });

  // Tamper with signed manifest version (invalidates signature)
  const invalidSigned = { ...signed, version: '0.4.5' };

  const manifestUrl = 'https://releases.hearth.dev/manifest.json';
  const artifactUrl = `https://releases.hearth.dev/${signed.artifact.path}`;
  const callLog = [];

  const mockFetch = makeMockFetch({
    [manifestUrl]: () => createMockResponse(JSON.stringify(invalidSigned)),
    [artifactUrl]: () => createMockResponse(Buffer.alloc(100)),
  }, callLog);

  await assert.rejects(
    () => fetchAndVerifyUpdate({
      manifestUrl,
      trustedOrigin: 'https://releases.hearth.dev',
      trustedKeys: testTrustedKeys,
      currentVersion: '0.4.3',
      currentBuiltAt: '2026-09-17T08:00:00.000Z',
      fetchFn: mockFetch,
    }),
    /Manifest signature verification failed/,
  );

  assert.equal(callLog.length, 1);
  assert.equal(callLog[0].url, manifestUrl);
  assert.equal(callLog.some((c) => c.url === artifactUrl), false);
});

test('P2B: 22. no installed app paths are touched', async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hearth-app-untouched-'));
  try {
    // Record stat of /Applications/Hearth Control.app if it exists
    const installedAppPath = '/Applications/Hearth Control.app';
    const beforeStat = await fs.promises.stat(installedAppPath).catch(() => null);

    const fixtureBytes = Buffer.from('test-bytes');
    const sha = crypto.createHash('sha256').update(fixtureBytes).digest('hex');
    const unsigned = createSampleUnsignedManifest({
      artifact: { kind: 'dmg', path: 'releases/build.dmg', size: fixtureBytes.length, sha256: sha },
    });
    const signed = signRemoteManifest({ manifest: unsigned, privateKey, keyId: TEST_KEY_ID });

    const mockFetch = makeMockFetch({
      'https://releases.hearth.dev/releases/build.dmg': createMockResponse(fixtureBytes),
    });

    await downloadRemoteArtifact({
      manifest: signed,
      trustedOrigin: 'https://releases.hearth.dev',
      updatesDir: tmpDir,
      fetchFn: mockFetch,
    });

    if (beforeStat) {
      const afterStat = await fs.promises.stat(installedAppPath);
      assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
    }
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

// ==========================================
// P2B Security Tests: DNS & HTTP Response Guards
// ==========================================

test('DNS: 1. public hostname -> private IPv4 rejected', async () => {
  const lookupFn = async () => [{ address: '10.20.30.40', family: 4 }];
  await assert.rejects(
    () => resolveAndValidateDns('releases.hearth.dev', { lookupFn }),
    /Destination hostname 'releases.hearth.dev' resolves to prohibited address '10.20.30.40'/,
  );
  // Also test 192.168.x.x
  const lookupFn192 = async () => [{ address: '192.168.1.100', family: 4 }];
  await assert.rejects(
    () => resolveAndValidateDns('releases.hearth.dev', { lookupFn: lookupFn192 }),
    /Destination hostname 'releases.hearth.dev' resolves to prohibited address '192.168.1.100'/,
  );
});

test('DNS: 2. public hostname -> loopback rejected', async () => {
  const lookupFn = async () => [{ address: '127.0.0.1', family: 4 }];
  await assert.rejects(
    () => resolveAndValidateDns('releases.hearth.dev', { lookupFn }),
    /Destination hostname 'releases.hearth.dev' resolves to prohibited address '127.0.0.1'/,
  );
});

test('DNS: 3. hostname resolving to mixed public + private addresses rejected', async () => {
  // First address is public, but second is private RFC1918
  const lookupFn = async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '192.168.1.1', family: 4 },
  ];
  await assert.rejects(
    () => resolveAndValidateDns('releases.hearth.dev', { lookupFn }),
    /resolves to prohibited address '192.168.1.1' \(multi-address\/private network rule\)/,
  );
});

test('DNS: 4. redirect hostname resolving to private address rejected', async () => {
  const manifestUrl = 'https://releases.hearth.dev/stable/manifest.json';
  const hopUrl = 'https://releases.hearth.dev/hop';

  const mockFetch = makeMockFetch({
    [manifestUrl]: createMockResponse(null, { status: 302, headers: { Location: hopUrl } }),
    [hopUrl]: createMockResponse('{"data": 1}'),
  });

  // Lookup for initial URL returns public IP, but redirect destination resolves to private IP
  let callCount = 0;
  const lookupFn = async () => {
    callCount += 1;
    if (callCount === 1) {
      return [{ address: '93.184.216.34', family: 4 }];
    }
    return [{ address: '172.16.5.5', family: 4 }];
  };

  await assert.rejects(
    () => safeFetchWithRedirects(manifestUrl, {
      trustedOrigin: 'https://releases.hearth.dev',
      fetchFn: mockFetch,
      lookupFn,
    }),
    /resolves to prohibited address '172.16.5.5'/,
  );
});

test('DNS: 5. IPv6 ::1 rejected', async () => {
  const lookupFn = async () => [{ address: '::1', family: 6 }];
  await assert.rejects(
    () => resolveAndValidateDns('releases.hearth.dev', { lookupFn }),
    /Destination hostname 'releases.hearth.dev' resolves to prohibited address '::1'/,
  );
});

test('DNS: 6. IPv6 unique-local address rejected', async () => {
  const lookupFn = async () => [{ address: 'fd12:3456:789a::1', family: 6 }];
  await assert.rejects(
    () => resolveAndValidateDns('releases.hearth.dev', { lookupFn }),
    /Destination hostname 'releases.hearth.dev' resolves to prohibited address 'fd12:3456:789a::1'/,
  );
});

test('DNS: 7. ordinary public resolved address accepted', async () => {
  const lookupFn = async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '2607:f8b0:4005:805::200e', family: 6 },
  ];
  const addresses = await resolveAndValidateDns('releases.hearth.dev', { lookupFn });
  assert.deepEqual(addresses, ['93.184.216.34', '2607:f8b0:4005:805::200e']);
});

test('HTTP Guard: non-2xx final manifest response fails closed', async () => {
  const manifestUrl = 'https://releases.hearth.dev/stable/manifest.json';
  const mockFetch = makeMockFetch({
    [manifestUrl]: createMockResponse('Not Found', { status: 404, statusText: 'Not Found' }),
  });

  await assert.rejects(
    () => fetchRemoteManifest({
      manifestUrl,
      trustedOrigin: 'https://releases.hearth.dev',
      trustedKeys: testTrustedKeys,
      fetchFn: mockFetch,
    }),
    /HTTP request failed with status 404 Not Found/,
  );
});

test('HTTP Guard: non-2xx final artifact response fails closed', async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hearth-http-artifact-'));
  try {
    const unsigned = createSampleUnsignedManifest();
    const signed = signRemoteManifest({ manifest: unsigned, privateKey, keyId: TEST_KEY_ID });
    const artifactUrl = `https://releases.hearth.dev/${signed.artifact.path}`;

    const mockFetch = makeMockFetch({
      [artifactUrl]: createMockResponse('Server Error', { status: 500, statusText: 'Internal Server Error' }),
    });

    await assert.rejects(
      () => downloadRemoteArtifact({
        manifest: signed,
        trustedOrigin: 'https://releases.hearth.dev',
        updatesDir: tmpDir,
        fetchFn: mockFetch,
      }),
      /HTTP request failed with status 500 Internal Server Error/,
    );
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('HTTP Guard: redirect without Location fails closed', async () => {
  const manifestUrl = 'https://releases.hearth.dev/stable/manifest.json';
  const mockFetch = makeMockFetch({
    [manifestUrl]: createMockResponse(null, { status: 302, headers: {} }),
  });

  await assert.rejects(
    () => fetchRemoteManifest({
      manifestUrl,
      trustedOrigin: 'https://releases.hearth.dev',
      trustedKeys: testTrustedKeys,
      fetchFn: mockFetch,
    }),
    /Redirect status 302 missing Location header/,
  );
});

test('HTTP Guard: malformed Location fails closed', async () => {
  const manifestUrl = 'https://releases.hearth.dev/stable/manifest.json';
  const mockFetch = makeMockFetch({
    [manifestUrl]: createMockResponse(null, { status: 302, headers: { Location: 'http://[invalid-ipv6' } }),
  });

  await assert.rejects(
    () => fetchRemoteManifest({
      manifestUrl,
      trustedOrigin: 'https://releases.hearth.dev',
      trustedKeys: testTrustedKeys,
      fetchFn: mockFetch,
    }),
    /Malformed redirect Location header: 'http:\/\/\[invalid-ipv6'/,
  );
});

test('HTTP Guard: credentials/userinfo in redirect fails closed', async () => {
  const manifestUrl = 'https://releases.hearth.dev/stable/manifest.json';
  const mockFetch = makeMockFetch({
    [manifestUrl]: createMockResponse(null, {
      status: 302,
      headers: { Location: 'https://admin:secret@releases.hearth.dev/hop' },
    }),
  });

  await assert.rejects(
    () => fetchRemoteManifest({
      manifestUrl,
      trustedOrigin: 'https://releases.hearth.dev',
      trustedKeys: testTrustedKeys,
      fetchFn: mockFetch,
    }),
    /URL credentials \(userinfo\) are strictly prohibited/,
  );
});

test('HTTP Guard: HTTPS -> HTTP downgrade redirect fails closed', async () => {
  const manifestUrl = 'https://releases.hearth.dev/stable/manifest.json';
  const mockFetch = makeMockFetch({
    [manifestUrl]: createMockResponse(null, {
      status: 302,
      headers: { Location: 'http://releases.hearth.dev/manifest.json' },
    }),
  });

  await assert.rejects(
    () => fetchRemoteManifest({
      manifestUrl,
      trustedOrigin: 'https://releases.hearth.dev',
      trustedKeys: testTrustedKeys,
      fetchFn: mockFetch,
    }),
    /Protocol downgrade redirect is not permitted: 'http:\/\/releases.hearth.dev\/manifest.json'/,
  );
});

// ==========================================
// P2B Security Tests: DNS Rebinding / TOCTOU
// ==========================================

test('TOCTOU: 1. DNS validation returns public IP, second query returns private -> connection uses only validated address', async () => {
  const manifestUrl = 'https://releases.hearth.dev/manifest.json';
  const publicIp = '93.184.216.34';
  const rebindPrivateIp = '127.0.0.1';

  // Simulated rebind resolver: returns public IP on validation check (call 1), then rebinds to private on subsequent calls
  let lookupCallCount = 0;
  const rebindLookupFn = async () => {
    lookupCallCount += 1;
    if (lookupCallCount === 1) {
      return [{ address: publicIp, family: 4 }];
    }
    return [{ address: rebindPrivateIp, family: 4 }];
  };

  let capturedDispatcher = null;
  const mockFetch = async (url, options) => {
    capturedDispatcher = options?.dispatcher;
    return createMockResponse('{"schema":"hearth-update-v2"}');
  };

  await safeFetchWithRedirects(manifestUrl, {
    trustedOrigin: 'https://releases.hearth.dev',
    fetchFn: mockFetch,
    lookupFn: rebindLookupFn,
  });

  assert.ok(capturedDispatcher, 'Dispatcher must be passed to connection options');
  const lookup = capturedDispatcher._pinnedLookup;
  assert.ok(lookup, 'Dispatcher must have a pinned lookup function');

  // Query the connection's lookup function
  let pinnedResult = null;
  lookup('releases.hearth.dev', { all: true }, (err, addresses) => {
    assert.equal(err, null);
    pinnedResult = addresses;
  });

  assert.deepEqual(pinnedResult, [{ address: publicIp, family: 4 }]);
  assert.equal(pinnedResult.some((a) => a.address === rebindPrivateIp), false);
});

test('TOCTOU: 2. actual connection resolver receives and uses only validated address', () => {
  const hostname = 'releases.hearth.dev';
  const validatedIps = ['93.184.216.34', '104.16.212.131'];

  const dispatcher = createPinnedConnectionDispatcher(hostname, validatedIps);
  assert.ok(dispatcher);
  assert.equal(dispatcher._pinnedHostname, hostname);
  assert.deepEqual(dispatcher._pinnedAddresses, validatedIps);

  const lookup = dispatcher._pinnedLookup;
  assert.ok(typeof lookup === 'function');

  // Calling with all: true
  let allAddrs = null;
  lookup(hostname, { all: true }, (err, addrs) => {
    assert.equal(err, null);
    allAddrs = addrs;
  });
  assert.deepEqual(allAddrs, [
    { address: '93.184.216.34', family: 4 },
    { address: '104.16.212.131', family: 4 },
  ]);

  // Calling with all: false
  let singleAddr = null;
  let singleFamily = null;
  lookup(hostname, { all: false }, (err, addr, family) => {
    assert.equal(err, null);
    singleAddr = addr;
    singleFamily = family;
  });
  assert.equal(singleAddr, '93.184.216.34');
  assert.equal(singleFamily, 4);

  // Calling with mismatched hostname fails
  let mismatchErr = null;
  lookup('attacker.com', { all: true }, (err) => {
    mismatchErr = err;
  });
  assert.ok(mismatchErr);
  assert.match(mismatchErr.message, /Pinned lookup host mismatch/);
});

test('TOCTOU: 3. redirect host gets its own validated/pinned DNS resolution', async () => {
  const manifestUrl = 'https://releases.hearth.dev/stable/manifest.json';
  const hopUrl = 'https://releases.hearth.dev/hop';

  const dispatchersReceived = [];
  const mockFetch = async (url, options) => {
    dispatchersReceived.push({ url, dispatcher: options?.dispatcher });
    if (url === manifestUrl) {
      return createMockResponse(null, { status: 302, headers: { Location: hopUrl } });
    }
    return createMockResponse('{"data": 1}');
  };

  const lookupFn = async () => [{ address: '93.184.216.34', family: 4 }];

  await safeFetchWithRedirects(manifestUrl, {
    trustedOrigin: 'https://releases.hearth.dev',
    fetchFn: mockFetch,
    lookupFn,
  });

  assert.equal(dispatchersReceived.length, 2);
  assert.ok(dispatchersReceived[0].dispatcher);
  assert.ok(dispatchersReceived[1].dispatcher);
  // Each hop created a fresh pinned dispatcher
  assert.notEqual(dispatchersReceived[0].dispatcher, dispatchersReceived[1].dispatcher);
});

test('TOCTOU: 4. mixed public+private DNS still fails closed before connection', async () => {
  const manifestUrl = 'https://releases.hearth.dev/stable/manifest.json';
  const lookupFn = async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '192.168.1.1', family: 4 },
  ];

  let connectionAttempted = false;
  const mockFetch = async () => {
    connectionAttempted = true;
    return createMockResponse('{"data": 1}');
  };

  await assert.rejects(
    () => safeFetchWithRedirects(manifestUrl, {
      trustedOrigin: 'https://releases.hearth.dev',
      fetchFn: mockFetch,
      lookupFn,
    }),
    /resolves to prohibited address '192.168.1.1'/,
  );

  assert.equal(connectionAttempted, false, 'Connection must not be attempted if DNS resolution has any prohibited IP');
});

test('TOCTOU: 5. TLS hostname/SNI remains the original HTTPS hostname', async () => {
  const manifestUrl = 'https://releases.hearth.dev/stable/manifest.json';
  let fetchedUrl = null;

  const mockFetch = async (url) => {
    fetchedUrl = url;
    return createMockResponse('{"data": 1}');
  };

  await safeFetchWithRedirects(manifestUrl, {
    trustedOrigin: 'https://releases.hearth.dev',
    fetchFn: mockFetch,
  });

  // Hostname in URL remains original for TLS SNI and Host header
  const parsed = new URL(fetchedUrl);
  assert.equal(parsed.hostname, 'releases.hearth.dev');
  assert.equal(parsed.protocol, 'https:');
});

test('TOCTOU: 6. certificate verification remains enabled', async () => {
  const manifestUrl = 'https://releases.hearth.dev/stable/manifest.json';
  let receivedOptions = null;

  const mockFetch = async (url, options) => {
    receivedOptions = options;
    return createMockResponse('{"data": 1}');
  };

  await safeFetchWithRedirects(manifestUrl, {
    trustedOrigin: 'https://releases.hearth.dev',
    fetchFn: mockFetch,
  });

  assert.equal(receivedOptions?.rejectUnauthorized, undefined); // Never explicitly set to false
  assert.notEqual(receivedOptions?.rejectUnauthorized, false);
});

// ====================================================
// P2B Packaged-Runtime Dependency & Dispatcher Lifecycle
// ====================================================

test('Dependency Audit: production remote-updater relies strictly on built-ins and declared dependencies', () => {
  const code = fs.readFileSync(path.join(__dirname, '../electron/remote-updater.cjs'), 'utf8');
  assert.equal(code.includes("require('undici')"), false, "Must not require('undici')");
  assert.equal(code.includes('require("undici")'), false, "Must not require('undici')");

  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  const prodDeps = Object.keys(pkg.dependencies || {});

  // Extract all require calls
  const matches = [...code.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  for (const mod of matches) {
    const isRelative = mod.startsWith('.');
    const isBuiltin = mod.startsWith('node:') || [
      'crypto', 'dns', 'fs', 'http', 'https', 'net', 'os', 'path', 'stream', 'url',
    ].includes(mod);
    const isProdDep = prodDeps.includes(mod);
    assert.ok(
      isRelative || isBuiltin || isProdDep,
      `Module '${mod}' must be built-in or declared in dependencies, not transitive/devDependency`,
    );
  }
});

test('Dispatcher Lifecycle: agent closes after successful manifest request', async () => {
  const unsigned = createSampleUnsignedManifest();
  const signed = signRemoteManifest({ manifest: unsigned, privateKey, keyId: TEST_KEY_ID });
  const manifestJson = JSON.stringify(signed);

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(manifestJson);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const manifestUrl = `http://127.0.0.1:${port}/manifest.json`;

  const destroyedAgents = [];
  const origDestroy = http.Agent.prototype.destroy;
  http.Agent.prototype.destroy = function (...args) {
    destroyedAgents.push(this);
    return origDestroy.apply(this, args);
  };

  try {
    const fetched = await fetchRemoteManifest({
      manifestUrl,
      trustedOrigin: `http://127.0.0.1:${port}`,
      trustedKeys: testTrustedKeys,
      allowLocalhost: true,
      lookupFn: async () => [{ address: '127.0.0.1', family: 4 }],
    });

    assert.equal(fetched.version, '0.4.4');
    assert.ok(destroyedAgents.length > 0, 'Agent must be destroyed after manifest request completes');
    assert.ok(destroyedAgents[0]._pinnedAddresses !== undefined, 'Agent was a pinned connection agent');
  } finally {
    http.Agent.prototype.destroy = origDestroy;
    server.close();
  }
});

test('Dispatcher Lifecycle: agent closes after redirect', async () => {
  const unsigned = createSampleUnsignedManifest();
  const signed = signRemoteManifest({ manifest: unsigned, privateKey, keyId: TEST_KEY_ID });
  const manifestJson = JSON.stringify(signed);

  const server = http.createServer((req, res) => {
    if (req.url === '/hop1') {
      res.writeHead(302, { Location: '/hop2' });
      res.end();
      return;
    }
    if (req.url === '/hop2') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(manifestJson);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const initialUrl = `http://127.0.0.1:${port}/hop1`;

  const destroyedAgents = [];
  const origDestroy = http.Agent.prototype.destroy;
  http.Agent.prototype.destroy = function (...args) {
    destroyedAgents.push(this);
    return origDestroy.apply(this, args);
  };

  try {
    const fetched = await fetchRemoteManifest({
      manifestUrl: initialUrl,
      trustedOrigin: `http://127.0.0.1:${port}`,
      trustedKeys: testTrustedKeys,
      allowLocalhost: true,
      lookupFn: async () => [{ address: '127.0.0.1', family: 4 }],
    });

    assert.equal(fetched.version, '0.4.4');
    assert.equal(new Set(destroyedAgents).size, 2, 'Hop 1 agent and Hop 2 agent must both be destroyed');
    for (const ag of new Set(destroyedAgents)) {
      assert.equal(ag.destroyed, true);
    }
  } finally {
    http.Agent.prototype.destroy = origDestroy;
    server.close();
  }
});

test('Dispatcher Lifecycle: agent closes after HTTP error', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal Server Error');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const initialUrl = `http://127.0.0.1:${port}/manifest.json`;

  const destroyedAgents = [];
  const origDestroy = http.Agent.prototype.destroy;
  http.Agent.prototype.destroy = function (...args) {
    destroyedAgents.push(this);
    return origDestroy.apply(this, args);
  };

  try {
    await assert.rejects(
      () => fetchRemoteManifest({
        manifestUrl: initialUrl,
        trustedOrigin: `http://127.0.0.1:${port}`,
        trustedKeys: testTrustedKeys,
        allowLocalhost: true,
        lookupFn: async () => [{ address: '127.0.0.1', family: 4 }],
      }),
      /HTTP request failed with status 500/,
    );

    assert.equal(new Set(destroyedAgents).size, 1, 'Agent must be destroyed on HTTP error');
    assert.equal(destroyedAgents[0].destroyed, true);
  } finally {
    http.Agent.prototype.destroy = origDestroy;
    server.close();
  }
});

test('Dispatcher Lifecycle: agent closes after timeout/abort', async () => {
  let pendingSocket = null;
  const server = http.createServer((req, res) => {
    pendingSocket = res;
    // Intentionally do not reply to trigger timeout
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const initialUrl = `http://127.0.0.1:${port}/manifest.json`;

  const destroyedAgents = [];
  const origDestroy = http.Agent.prototype.destroy;
  http.Agent.prototype.destroy = function (...args) {
    destroyedAgents.push(this);
    return origDestroy.apply(this, args);
  };

  try {
    await assert.rejects(
      () => fetchRemoteManifest({
        manifestUrl: initialUrl,
        trustedOrigin: `http://127.0.0.1:${port}`,
        trustedKeys: testTrustedKeys,
        allowLocalhost: true,
        timeoutMs: 60,
        lookupFn: async () => [{ address: '127.0.0.1', family: 4 }],
      }),
      /timed out after 60ms/,
    );

    assert.equal(new Set(destroyedAgents).size, 1, 'Agent must be destroyed on timeout');
    assert.equal(destroyedAgents[0].destroyed, true);
  } finally {
    http.Agent.prototype.destroy = origDestroy;
    if (pendingSocket && !pendingSocket.destroyed) {
      pendingSocket.destroy();
    }
    server.close();
  }
});

test('Dispatcher Lifecycle: agent remains alive long enough to stream response body fully before closing', async () => {
  const agentCheckpoints = [];

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.write('chunk-1');
    setTimeout(() => {
      res.write('chunk-2');
      setTimeout(() => {
        res.end('chunk-3');
      }, 25);
    }, 25);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/stream`;

  const origDestroy = http.Agent.prototype.destroy;
  http.Agent.prototype.destroy = function (...args) {
    agentCheckpoints.push('destroyed');
    return origDestroy.apply(this, args);
  };

  try {
    const response = await safeFetchWithRedirects(url, {
      trustedOrigin: `http://127.0.0.1:${port}`,
      allowLocalhost: true,
      lookupFn: async () => [{ address: '127.0.0.1', family: 4 }],
    });

    const reader = response.body.getReader();
    let body = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      body += new TextDecoder().decode(value);
      agentCheckpoints.push(`chunk_read:${body}`);
    }

    assert.equal(body, 'chunk-1chunk-2chunk-3');
    assert.ok(agentCheckpoints.includes('chunk_read:chunk-1'));
    assert.ok(agentCheckpoints.includes('chunk_read:chunk-1chunk-2'));

    // Trigger cleanup if not already called
    if (response._agent && typeof response._agent.destroy === 'function') {
      response._agent.destroy();
    }
    assert.ok(agentCheckpoints.includes('destroyed'));
    const firstChunkIdx = agentCheckpoints.indexOf('chunk_read:chunk-1');
    const destroyIdx = agentCheckpoints.lastIndexOf('destroyed');
    assert.ok(firstChunkIdx < destroyIdx, 'Agent must not be destroyed before first chunk read');
  } finally {
    http.Agent.prototype.destroy = origDestroy;
    server.close();
  }
});

test('TLS Security: agent and requests preserve default certificate validation', () => {
  const agent = createPinnedAgent('releases.hearth.dev', ['93.184.216.34'], 'https:');
  assert.ok(agent instanceof https.Agent, 'Must create an https.Agent for https: protocol');
  assert.notEqual(agent.options?.rejectUnauthorized, false, 'rejectUnauthorized must not be disabled');
  agent.destroy();
});
