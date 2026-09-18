import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
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
