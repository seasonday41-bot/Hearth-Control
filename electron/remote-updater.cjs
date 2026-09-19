const crypto = require('node:crypto');
const dns = require('node:dns');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const {
  SCHEMA_V2,
  APP_NAME,
  validateRemoteManifestSchema,
  verifyRemoteManifest,
  isSafeRelativeArtifactPath,
} = require('./remote-update-manifest.cjs');
const { isManifestNewer } = require('./updater.cjs');

const DEFAULT_TRUSTED_ORIGIN = 'https://releases.hearth.dev';
const MAX_MANIFEST_BYTES = 64 * 1024; // 64 KB
const MAX_DMG_BYTES = 500 * 1024 * 1024; // 500 MB
const DEFAULT_TIMEOUT_MS = 30_000; // 30s
const MAX_REDIRECTS = 3;
const EXPECTED_PLATFORM = 'darwin';
const EXPECTED_ARCH = 'arm64';
const DMG_FILENAME = 'Hearth-Control.dmg';
const PART_SUFFIX = '.part';

/**
 * Checks whether an IP address is in a prohibited range:
 * - IPv4: loopback (127/8), RFC1918 (10/8, 172.16/12, 192.168/16), link-local (169.254/16),
 *   0.0.0.0/8, CGNAT (100.64/10), multicast/reserved/broadcast (>= 224).
 * - IPv6: loopback (::1), unspecified (::), unique-local (fc00::/7), link-local (fe80::/10),
 *   multicast (ff00::/8), IPv4-mapped (::ffff:0:0/96 wrapping prohibited IPv4).
 */
function isProhibitedIp(ip) {
  const family = net.isIP(ip);
  if (family === 4) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts;
    if (a === 0) return true; // 0.0.0.0/8 (current network)
    if (a === 10) return true; // 10.0.0.0/8 (RFC 1918)
    if (a === 127) return true; // 127.0.0.0/8 (loopback)
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 (RFC 1918)
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 (RFC 1918)
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
    if (a >= 224) return true; // 224.0.0.0/4 (multicast / reserved / broadcast)
    return false;
  }
  if (family === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('::ffff:')) {
      const remainder = lower.slice(7);
      if (net.isIPv4(remainder)) {
        return isProhibitedIp(remainder);
      }
    }
    if (/^f[cd][0-9a-f]{2}:/i.test(lower)) return true; // fc00::/7 (unique-local)
    if (/^fe[89ab][0-9a-f]:/i.test(lower)) return true; // fe80::/10 (link-local unicast)
    if (/^ff[0-9a-f]{2}:/i.test(lower)) return true; // ff00::/8 (multicast)
    return false;
  }
  return false;
}

/**
 * Checks whether an IP address is strictly a loopback or local address.
 */
function isLoopbackOrLocalIp(ip) {
  const family = net.isIP(ip);
  if (family === 4) {
    const [a] = ip.split('.').map(Number);
    return a === 127 || ip === '0.0.0.0';
  }
  if (family === 6) {
    return ip === '::1' || ip === '::';
  }
  return false;
}

/**
 * Checks whether a hostname represents a private or loopback IP/host string.
 */
function isPrivateOrLocalHost(hostname) {
  const lower = String(hostname || '').toLowerCase();
  if (
    lower === 'localhost' ||
    lower === '127.0.0.1' ||
    lower === '::1' ||
    lower === '0.0.0.0' ||
    lower.endsWith('.local')
  ) {
    return true;
  }
  if (net.isIP(lower)) {
    return isProhibitedIp(lower);
  }
  return false;
}

/**
 * Resolves DNS for a hostname and enforces the multi-address security rule:
 * If ANY resolved IP is prohibited (private/loopback/reserved), fails closed.
 */
async function resolveAndValidateDns(hostname, options = {}) {
  const { lookupFn = dns.promises.lookup, allowLocalhost = false } = options;

  if (net.isIP(hostname)) {
    if (isProhibitedIp(hostname)) {
      if (allowLocalhost && isLoopbackOrLocalIp(hostname)) {
        return [hostname];
      }
      throw new Error(`Destination IP address '${hostname}' is prohibited (private, loopback, or reserved).`);
    }
    return [hostname];
  }

  const isLocalName = isPrivateOrLocalHost(hostname);
  if (isLocalName && !allowLocalhost) {
    throw new Error(`Hostname '${hostname}' is prohibited (local/loopback).`);
  }

  let results;
  try {
    results = await lookupFn(hostname, { all: true });
  } catch (err) {
    throw new Error(`DNS resolution failed for '${hostname}': ${err.message}`);
  }

  if (!results || results.length === 0) {
    throw new Error(`DNS resolution returned no addresses for '${hostname}'.`);
  }

  const addresses = results.map((r) => (typeof r === 'string' ? r : r.address));

  // Multi-address rule: if ANY resolved address is prohibited, fail closed!
  for (const address of addresses) {
    if (isProhibitedIp(address)) {
      if (allowLocalhost && isLoopbackOrLocalIp(address)) {
        continue;
      }
      throw new Error(
        `Destination hostname '${hostname}' resolves to prohibited address '${address}' (multi-address/private network rule).`,
      );
    }
  }

  return addresses;
}

/**
 * Creates a pinned connection agent that binds socket resolution
 * strictly to the pre-validated address set using Node's built-in https/http modules,
 * preventing DNS-rebinding TOCTOU attacks while preserving the original hostname
 * for TLS SNI, host header, and certificate validation.
 */
function createPinnedAgent(hostname, validatedIps, protocol = 'https:') {
  const pinnedEntries = validatedIps.map((ip) => ({
    address: ip,
    family: net.isIP(ip),
  }));

  const pinnedLookup = (lookupHost, opts, cb) => {
    if (lookupHost !== hostname) {
      return cb(new Error(`Pinned lookup host mismatch: expected '${hostname}', got '${lookupHost}'.`));
    }
    if (opts && opts.all) {
      cb(null, pinnedEntries);
    } else {
      cb(null, pinnedEntries[0].address, pinnedEntries[0].family);
    }
  };

  const isHttps = protocol === 'https:';
  const AgentClass = isHttps ? https.Agent : http.Agent;
  const agent = new AgentClass({
    keepAlive: false,
    lookup: pinnedLookup,
  });

  const origDestroy = agent.destroy.bind(agent);
  agent.destroyed = false;
  agent.destroy = () => {
    agent.destroyed = true;
    origDestroy();
  };

  agent._pinnedLookup = pinnedLookup;
  agent._pinnedHostname = hostname;
  agent._pinnedAddresses = [...validatedIps];

  return agent;
}

const createPinnedConnectionDispatcher = createPinnedAgent;

/**
 * Executes a low-level HTTP/HTTPS request using Node's built-in modules,
 * returning a Web-Response compatible interface with streaming body.
 */
function nodeHttpsRequest(targetUrl, options = {}) {
  const {
    headers = {},
    agent,
    signal,
  } = options;

  const parsed = new URL(targetUrl);
  const isHttps = parsed.protocol === 'https:';
  const transport = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    let settled = false;

    const req = transport.request(parsed, {
      method: 'GET',
      headers,
      agent,
    }, (res) => {
      if (settled) {
        res.destroy();
        return;
      }
      settled = true;

      const headersMap = new Map();
      for (const [key, val] of Object.entries(res.headers)) {
        if (Array.isArray(val)) {
          headersMap.set(key.toLowerCase(), val.join(', '));
        } else if (typeof val === 'string') {
          headersMap.set(key.toLowerCase(), val);
        }
      }

      const headersHelper = {
        get(name) {
          return headersMap.get(name.toLowerCase()) || null;
        },
      };

      const bodyStream = Readable.toWeb(res);

      res.on('close', () => {
        if (agent && typeof agent.destroy === 'function') {
          agent.destroy();
        }
      });

      resolve({
        status: res.statusCode,
        statusText: res.statusMessage || '',
        ok: res.statusCode >= 200 && res.statusCode < 300,
        headers: headersHelper,
        body: bodyStream,
        _rawResponse: res,
        _req: req,
        _agent: agent,
      });
    });

    const cleanup = (err) => {
      if (!settled) {
        settled = true;
        req.destroy();
        if (agent && typeof agent.destroy === 'function') {
          agent.destroy();
        }
        reject(err);
      }
    };

    req.on('error', cleanup);

    if (signal) {
      if (signal.aborted) {
        cleanup(signal.reason || new Error('Request aborted.'));
        return;
      }
      signal.addEventListener('abort', () => {
        cleanup(signal.reason || new Error('Request aborted.'));
      }, { once: true });
    }

    req.end();
  });
}

/**
 * Validates a target URL against trusted origin and security restrictions.
 */
function validateUrl({ url, trustedOrigin = DEFAULT_TRUSTED_ORIGIN, trustedOrigins, allowLocalhost = false }) {
  if (!url || typeof url !== 'string') {
    throw new Error('URL must be a non-empty string.');
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch (err) {
    throw new Error(`Malformed URL: '${url}'.`);
  }

  const configuredTrustedOrigins = Array.isArray(trustedOrigins) && trustedOrigins.length > 0
    ? trustedOrigins
    : [trustedOrigin];
  const parsedTrustedOrigins = configuredTrustedOrigins.map((origin) => {
    try {
      const parsedOrigin = new URL(origin);
      if (parsedOrigin.pathname !== '/' || parsedOrigin.search || parsedOrigin.hash || parsedOrigin.username || parsedOrigin.password) {
        throw new Error('trusted origin must be an origin only');
      }
      return parsedOrigin.origin;
    } catch {
      throw new Error(`Malformed trusted origin: '${origin}'.`);
    }
  });

  // Protocol check: HTTPS only (allow HTTP only if allowLocalhost is explicitly set for testing on localhost)
  const isLocalhost = isPrivateOrLocalHost(parsed.hostname);
  if (parsed.protocol !== 'https:') {
    if (allowLocalhost && isLocalhost && parsed.protocol === 'http:') {
      // Permitted only in explicit local test mode
    } else {
      throw new Error(`Protocol '${parsed.protocol}' is not permitted. Only HTTPS is allowed.`);
    }
  }

  // Reject URL credentials
  if (parsed.username || parsed.password) {
    throw new Error('URL credentials (userinfo) are strictly prohibited.');
  }

  // Reject URL fragments
  if (parsed.hash) {
    throw new Error('URL fragments are strictly prohibited.');
  }

  // Reject private / loopback IPs on literal hostname string unless allowLocalhost is enabled
  if (!allowLocalhost && isLocalhost) {
    throw new Error(`Private or loopback destination is not permitted: '${parsed.hostname}'.`);
  }

  // Exact origin allowlist check. Production may include GitHub's dedicated
  // release-asset delivery origin, but never wildcard host trust.
  if (!parsedTrustedOrigins.includes(parsed.origin)) {
    if (parsedTrustedOrigins.length === 1) {
      throw new Error(`URL origin '${parsed.origin}' does not match trusted origin '${parsedTrustedOrigins[0]}'.`);
    }
    throw new Error(`URL origin '${parsed.origin}' is not permitted by the trusted origin policy.`);
  }

  return parsed;
}

/**
 * Executes a network fetch with strict manual redirect handling, origin validation,
 * DNS resolution validation (multi-address rule), connection DNS pinning (anti-rebinding),
 * and timeouts.
 */
async function safeFetchWithRedirects(initialUrl, options = {}) {
  const {
    trustedOrigin = DEFAULT_TRUSTED_ORIGIN,
    trustedOrigins,
    maxRedirects = MAX_REDIRECTS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchFn,
    lookupFn,
    allowLocalhost = false,
    headers = {},
  } = options;

  const dnsResolver = lookupFn || (fetchFn && fetchFn !== nodeHttpsRequest
    ? async (host) => {
        if (isPrivateOrLocalHost(host)) return [{ address: '127.0.0.1', family: 4 }];
        return [{ address: '93.184.216.34', family: 4 }];
      }
    : dns.promises.lookup);

  let currentUrl = initialUrl;
  let redirectCount = 0;

  while (true) {
    const parsedCurrent = validateUrl({ url: currentUrl, trustedOrigin, trustedOrigins, allowLocalhost });
    const validatedIps = await resolveAndValidateDns(parsedCurrent.hostname, { lookupFn: dnsResolver, allowLocalhost });
    const agent = createPinnedAgent(parsedCurrent.hostname, validatedIps, parsedCurrent.protocol);

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error(`Request timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    let response;
    try {
      if (fetchFn && fetchFn !== nodeHttpsRequest) {
        response = await fetchFn(currentUrl, {
          method: 'GET',
          headers,
          redirect: 'manual',
          signal: controller.signal,
          agent,
          dispatcher: agent,
        });
      } else {
        response = await nodeHttpsRequest(currentUrl, {
          headers,
          agent,
          signal: controller.signal,
        });
      }
      if (response && !response._agent) {
        response._agent = agent;
      }
    } catch (err) {
      clearTimeout(timer);
      if (agent && typeof agent.destroy === 'function') {
        agent.destroy();
      }
      throw new Error(`Network request failed for '${currentUrl}': ${err.message}`);
    }

    clearTimeout(timer);

    // Check for redirects
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (response._rawResponse && !response._rawResponse.destroyed) {
        response._rawResponse.destroy();
      } else if (response.body && typeof response.body.cancel === 'function') {
        response.body.cancel().catch(() => {});
      }
      if (agent && typeof agent.destroy === 'function') {
        agent.destroy();
      }

      redirectCount += 1;
      if (redirectCount > maxRedirects) {
        throw new Error(`Redirect limit exceeded (${maxRedirects}).`);
      }

      const location = response.headers.get('location');
      if (!location) {
        throw new Error(`Redirect status ${response.status} missing Location header.`);
      }

      let nextUrl;
      try {
        nextUrl = new URL(location, currentUrl);
      } catch {
        throw new Error(`Malformed redirect Location header: '${location}'.`);
      }

      // Check protocol downgrade
      if (parsedCurrent.protocol === 'https:' && nextUrl.protocol !== 'https:') {
        throw new Error(`Protocol downgrade redirect is not permitted: '${nextUrl.href}'.`);
      }

      // Validate next destination against origin and credentials
      validateUrl({ url: nextUrl.href, trustedOrigin, trustedOrigins, allowLocalhost });

      currentUrl = nextUrl.href;
      continue;
    }

    if (!response.ok) {
      if (response._rawResponse && !response._rawResponse.destroyed) {
        response._rawResponse.destroy();
      } else if (response.body && typeof response.body.cancel === 'function') {
        response.body.cancel().catch(() => {});
      }
      if (agent && typeof agent.destroy === 'function') {
        agent.destroy();
      }
      throw new Error(`HTTP request failed with status ${response.status} ${response.statusText}.`);
    }

    return response;
  }
}

/**
 * Validates platform and architecture against expected values.
 */
function validatePlatformAndArch(manifest, options = {}) {
  const expectedPlatform = options.expectedPlatform || EXPECTED_PLATFORM;
  const expectedArch = options.expectedArch || EXPECTED_ARCH;

  if (manifest.platform !== expectedPlatform) {
    throw new Error(`Unsupported platform: expected '${expectedPlatform}', received '${manifest.platform}'.`);
  }
  if (manifest.arch !== expectedArch) {
    throw new Error(`Unsupported arch: expected '${expectedArch}', received '${manifest.arch}'.`);
  }
  return true;
}

/**
 * Fetches and cryptographically verifies a remote update manifest.
 * Guarantees signature is verified BEFORE returning the manifest.
 */
async function fetchRemoteManifest({
  manifestUrl,
  trustedOrigin = DEFAULT_TRUSTED_ORIGIN,
  trustedOrigins,
  trustedKeys = {},
  maxManifestBytes = MAX_MANIFEST_BYTES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchFn,
  lookupFn,
  allowLocalhost = false,
}) {
  let response;
  try {
    response = await safeFetchWithRedirects(manifestUrl, {
      trustedOrigin,
      trustedOrigins,
      timeoutMs,
      fetchFn,
      lookupFn,
      allowLocalhost,
    });

    // Pre-check Content-Length header if available
    const contentLength = response.headers.get('content-length');
    if (contentLength && Number(contentLength) > maxManifestBytes) {
      throw new Error(`Manifest size (${contentLength} bytes) exceeds maximum limit (${maxManifestBytes} bytes).`);
    }

    // Stream-read response to enforce size bound even if Content-Length was omitted/incorrect
    let rawText = '';
    let bytesReceived = 0;
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf8');

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytesReceived += value.byteLength;
        if (bytesReceived > maxManifestBytes) {
          await reader.cancel();
          throw new Error(`Manifest stream exceeded maximum limit of ${maxManifestBytes} bytes.`);
        }
        rawText += decoder.decode(value, { stream: true });
      }
      rawText += decoder.decode(); // flush
    } catch (err) {
      await reader.cancel().catch(() => {});
      throw err;
    }

    let parsedManifest;
    try {
      parsedManifest = JSON.parse(rawText);
    } catch {
      throw new Error('Malformed manifest JSON: failed to parse response body.');
    }

    // Cryptographic Ed25519 verification (fails closed on unknown keyId, bad sig, or invalid schema)
    verifyRemoteManifest(parsedManifest, { trustedKeys });

    return parsedManifest;
  } finally {
    if (response) {
      if (response._rawResponse && !response._rawResponse.destroyed) {
        response._rawResponse.destroy();
      }
      if (response._agent && typeof response._agent.destroy === 'function') {
        response._agent.destroy();
      }
    }
  }
}

/**
 * Resolves the updates directory on disk.
 */
function resolveUpdatesDirectory(options = {}) {
  if (options.updatesDir) {
    return path.resolve(options.updatesDir);
  }
  if (process.env.HEARTH_UPDATES_DIR) {
    return path.resolve(process.env.HEARTH_UPDATES_DIR);
  }
  return path.join(os.homedir(), 'Library', 'Application Support', 'Hearth Control', 'updates', 'remote');
}

/**
 * Downloads a verified DMG artifact to a .part file, checks byte size and SHA-256,
 * and atomically renames to .dmg only upon complete verification.
 * Cleans up .part files on any failure.
 */
async function downloadRemoteArtifact({
  manifest,
  trustedOrigin = DEFAULT_TRUSTED_ORIGIN,
  trustedOrigins,
  artifactBaseUrl,
  updatesDir,
  maxDmgBytes = MAX_DMG_BYTES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchFn,
  lookupFn,
  allowLocalhost = false,
}) {
  if (!manifest || !manifest.artifact || typeof manifest.artifact.path !== 'string') {
    throw new Error('Invalid manifest: missing artifact specification.');
  }

  if (!isSafeRelativeArtifactPath(manifest.artifact.path)) {
    throw new Error(`Artifact path must be strictly relative: '${manifest.artifact.path}'.`);
  }

  // Resolve the signed relative artifact path against a main-process-owned
  // release base URL. Legacy callers fall back to the trusted origin root.
  const resolvedArtifactBaseUrl = artifactBaseUrl || `${new URL(trustedOrigin).origin}/`;
  validateUrl({ url: resolvedArtifactBaseUrl, trustedOrigin, trustedOrigins, allowLocalhost });
  const artifactUrl = new URL(manifest.artifact.path, resolvedArtifactBaseUrl).href;

  // Validate artifact URL against the same exact delivery-origin policy.
  validateUrl({ url: artifactUrl, trustedOrigin, trustedOrigins, allowLocalhost });

  const targetDir = path.join(resolveUpdatesDirectory({ updatesDir }), manifest.buildId);
  const partPath = path.join(targetDir, `${DMG_FILENAME}${PART_SUFFIX}`);
  const finalDmgPath = path.join(targetDir, DMG_FILENAME);

  await fs.promises.mkdir(targetDir, { recursive: true });

  let response;
  try {
    response = await safeFetchWithRedirects(artifactUrl, {
      trustedOrigin,
      trustedOrigins,
      timeoutMs,
      fetchFn,
      lookupFn,
      allowLocalhost,
    });

    const expectedSize = manifest.artifact.size;
    const expectedSha256 = manifest.artifact.sha256.toLowerCase();

    // Validate Content-Length header if present
    const contentLength = response.headers.get('content-length');
    if (contentLength) {
      const lengthNum = Number(contentLength);
      if (lengthNum > maxDmgBytes) {
        throw new Error(`Artifact Content-Length (${lengthNum}) exceeds maximum allowed (${maxDmgBytes}).`);
      }
      if (lengthNum !== expectedSize) {
        throw new Error(`Artifact Content-Length (${lengthNum}) does not match manifest size (${expectedSize}).`);
      }
    }

    let fileHandle;
    let bytesReceived = 0;
    const hash = crypto.createHash('sha256');
    const reader = response.body.getReader();

    try {
      fileHandle = await fs.promises.open(partPath, 'w');

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        bytesReceived += value.byteLength;

        if (bytesReceived > maxDmgBytes) {
          await reader.cancel();
          throw new Error(`Artifact download exceeded maximum permitted size of ${maxDmgBytes} bytes.`);
        }

        if (bytesReceived > expectedSize) {
          await reader.cancel();
          throw new Error(`Artifact download exceeded manifest expected size of ${expectedSize} bytes.`);
        }

        hash.update(value);
        await fileHandle.write(value);
      }

      await fileHandle.sync();
      await fileHandle.close();
      fileHandle = null;

      // Verify exact byte length
      if (bytesReceived !== expectedSize) {
        throw new Error(`Artifact download size mismatch: expected ${expectedSize} bytes, got ${bytesReceived} bytes.`);
      }

      // Verify SHA-256
      const calculatedSha256 = hash.digest('hex').toLowerCase();
      if (calculatedSha256 !== expectedSha256) {
        throw new Error(`Artifact SHA-256 mismatch: expected ${expectedSha256}, calculated ${calculatedSha256}.`);
      }

      // Atomically rename .part -> final .dmg
      await fs.promises.rename(partPath, finalDmgPath);

      return {
        dmgPath: finalDmgPath,
        size: bytesReceived,
        sha256: calculatedSha256,
        buildId: manifest.buildId,
      };
    } catch (err) {
      if (fileHandle) {
        await fileHandle.close().catch(() => {});
      }
      // Clean up .part file on any failure
      await fs.promises.rm(partPath, { force: true }).catch(() => {});
      // Guarantee final DMG is not left in broken state
      await fs.promises.rm(finalDmgPath, { force: true }).catch(() => {});
      throw err;
    }
  } finally {
    if (response) {
      if (response._rawResponse && !response._rawResponse.destroyed) {
        response._rawResponse.destroy();
      }
      if (response._agent && typeof response._agent.destroy === 'function') {
        response._agent.destroy();
      }
    }
  }
}

/**
 * Complete P2B workflow:
 * 1. Fetch remote manifest
 * 2. Size-bound manifest
 * 3. Parse JSON
 * 4. Validate schema
 * 5. Verify Ed25519 signature
 * 6. Validate platform/arch
 * 7. Validate update recency (authoritative isManifestNewer from updater.cjs)
 * 8. If update available, stream download DMG to .part, verify size + SHA-256, rename to .dmg
 * 9. Never touches installed /Applications/Hearth Control.app
 */
async function fetchAndVerifyUpdate({
  manifestUrl,
  trustedOrigin = DEFAULT_TRUSTED_ORIGIN,
  trustedOrigins,
  trustedKeys = {},
  artifactBaseUrl,
  currentVersion,
  currentBuiltAt,
  isPackaged = true,
  expectedPlatform = EXPECTED_PLATFORM,
  expectedArch = EXPECTED_ARCH,
  updatesDir,
  maxManifestBytes = MAX_MANIFEST_BYTES,
  maxDmgBytes = MAX_DMG_BYTES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchFn,
  lookupFn,
  allowLocalhost = false,
}) {
  // Step 1 - 5: Fetch and verify signature BEFORE doing anything else
  const manifest = await fetchRemoteManifest({
    manifestUrl,
    trustedOrigin,
    trustedOrigins,
    trustedKeys,
    maxManifestBytes,
    timeoutMs,
    fetchFn,
    lookupFn,
    allowLocalhost,
  });

  // Step 6: Validate platform and arch
  validatePlatformAndArch(manifest, { expectedPlatform, expectedArch });

  // Step 7: Check update recency using existing updater comparison
  if (isPackaged === false) {
    return {
      updateAvailable: false,
      reason: 'dev_mode',
      manifest,
      currentVersion,
    };
  }

  const isNewer = isManifestNewer({
    manifest,
    currentVersion,
    currentBuiltAt,
  });

  if (!isNewer) {
    return {
      updateAvailable: false,
      reason: 'not_newer',
      manifest,
      currentVersion,
    };
  }

  // Step 8: Download artifact and verify integrity
  const downloadResult = await downloadRemoteArtifact({
    manifest,
    trustedOrigin,
    trustedOrigins,
    artifactBaseUrl,
    updatesDir,
    maxDmgBytes,
    timeoutMs,
    fetchFn,
    lookupFn,
    allowLocalhost,
  });

  return {
    updateAvailable: true,
    manifest,
    dmgPath: downloadResult.dmgPath,
    size: downloadResult.size,
    sha256: downloadResult.sha256,
  };
}

module.exports = {
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
};
