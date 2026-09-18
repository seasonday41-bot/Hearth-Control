const fs = require('node:fs');
const path = require('node:path');
const { signRemoteManifest, validateRemoteManifestSchema } = require('../electron/remote-update-manifest.cjs');

/**
 * Loads private key safely from an external file path without logging key content.
 * Accepts key file path from CLI or HEARTH_UPDATE_SIGNING_KEY_PATH.
 * Never accepts raw private-key text via environment variables.
 */
async function loadPrivateKey({ keyPath } = {}) {
  if (!keyPath || typeof keyPath !== 'string' || keyPath.trim().length === 0) {
    throw new Error('No private key file path provided. Specify --key-file <path> or HEARTH_UPDATE_SIGNING_KEY_PATH=<path>.');
  }
  const resolved = path.resolve(keyPath);
  try {
    return await fs.promises.readFile(resolved, 'utf8');
  } catch (err) {
    throw new Error(`Failed to read private key file at '${keyPath}': ${err.code || err.message}`);
  }
}

/**
 * Signs an unsigned remote manifest file and writes or returns the signed manifest.
 * Accepts private key exclusively via an external file path.
 * @param {{ inputPath: string, keyPath: string, keyId: string, outputPath?: string }} params
 */
async function signUpdateManifestFile({ inputPath, keyPath, keyId, outputPath }) {
  if (!inputPath) {
    throw new Error('Missing input path for unsigned manifest.');
  }
  if (!keyId || typeof keyId !== 'string' || keyId.trim().length === 0) {
    throw new Error('Missing keyId for signing.');
  }

  let rawContent;
  try {
    rawContent = await fs.promises.readFile(path.resolve(inputPath), 'utf8');
  } catch (err) {
    throw new Error(`Failed to read input manifest at '${inputPath}': ${err.code || err.message}`);
  }

  let unsignedManifest;
  try {
    unsignedManifest = JSON.parse(rawContent);
  } catch {
    throw new Error(`Input manifest at '${inputPath}' is not valid JSON.`);
  }

  // Pre-validate before loading key
  validateRemoteManifestSchema(unsignedManifest, { requireSignature: false });

  const privateKey = await loadPrivateKey({ keyPath });

  const signedManifest = signRemoteManifest({
    manifest: unsignedManifest,
    privateKey,
    keyId: keyId.trim(),
  });

  const formattedJson = `${JSON.stringify(signedManifest, null, 2)}\n`;

  if (outputPath) {
    const resolvedOut = path.resolve(outputPath);
    await fs.promises.mkdir(path.dirname(resolvedOut), { recursive: true });
    await fs.promises.writeFile(resolvedOut, formattedJson, 'utf8');
  }

  return signedManifest;
}

function parseArgs(args) {
  const parsed = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--input' || arg === '-i') {
      parsed.input = args[++i];
    } else if (arg === '--key-file' || arg === '--key' || arg === '-k') {
      parsed.keyFile = args[++i];
    } else if (arg === '--key-id') {
      parsed.keyId = args[++i];
    } else if (arg === '--output' || arg === '-o') {
      parsed.output = args[++i];
    }
  }
  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = args.input || process.env.HEARTH_UPDATE_INPUT_MANIFEST;
  const keyPath = args.keyFile || process.env.HEARTH_UPDATE_SIGNING_KEY_PATH;
  const keyId = args.keyId || process.env.HEARTH_UPDATE_KEY_ID;
  const outputPath = args.output;

  if (!inputPath) {
    throw new Error('Usage: node scripts/sign-update-manifest.cjs --input <path> --key-file <path> --key-id <id> [--output <path>]');
  }

  const signed = await signUpdateManifestFile({
    inputPath,
    keyPath,
    keyId,
    outputPath,
  });

  if (!outputPath) {
    process.stdout.write(`${JSON.stringify(signed, null, 2)}\n`);
  } else {
    process.stdout.write(`Signed manifest written to: ${outputPath}\n`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    // Fail closed, never log private key content
    process.stderr.write(`Signing error: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  signUpdateManifestFile,
  loadPrivateKey,
};
