const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;

class SupabaseProviderError extends Error {
  constructor(code, message, { status = null, retryable = false } = {}) {
    super(String(message || code).replace(/[\r\n\t]+/g, ' ').trim().slice(0, 500));
    this.name = 'SupabaseProviderError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

const decodeBase64UrlJson = (segment) => {
  try {
    const normalized = String(segment).replace(/-/g, '+').replace(/_/g, '/');
    const pad = '='.repeat((4 - (normalized.length % 4)) % 4);
    return JSON.parse(Buffer.from(normalized + pad, 'base64').toString('utf8'));
  } catch {
    return null;
  }
};

const validatePublishableKey = (value) => {
  if (typeof value !== 'string') throw new SupabaseProviderError('supabase_publishable_key_invalid', 'Supabase publishable key is required');
  const key = value.trim();
  if (!key || key.length > 4096 || /\s/.test(key)) {
    throw new SupabaseProviderError('supabase_publishable_key_invalid', 'Supabase publishable key is invalid');
  }
  if (key.startsWith('sb_secret_')) {
    throw new SupabaseProviderError('supabase_secret_key_forbidden', 'Supabase secret keys are forbidden in Hearth client project configuration');
  }
  if (key.startsWith('sb_publishable_')) return key;

  const parts = key.split('.');
  if (parts.length === 3 && parts[0].startsWith('eyJ')) {
    const payload = decodeBase64UrlJson(parts[1]);
    if (payload?.role === 'anon') return key;
    if (payload?.role === 'service_role') {
      throw new SupabaseProviderError('supabase_secret_key_forbidden', 'Supabase service_role keys are forbidden in Hearth client project configuration');
    }
  }
  throw new SupabaseProviderError('supabase_publishable_key_invalid', 'Use a Supabase publishable key or legacy anon key');
};

const validateProjectUrl = (value) => {
  if (typeof value !== 'string' || !value.trim()) throw new SupabaseProviderError('supabase_project_url_invalid', 'Supabase project URL is required');
  let parsed;
  try { parsed = new URL(value.trim()); } catch {
    throw new SupabaseProviderError('supabase_project_url_invalid', 'Supabase project URL is invalid');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    parsed.search ||
    (parsed.pathname !== '/' && parsed.pathname !== '') ||
    !/^[a-z0-9-]+\.supabase\.co$/i.test(parsed.hostname)
  ) {
    throw new SupabaseProviderError('supabase_project_url_invalid', 'P5 V1 requires an HTTPS hosted Supabase project URL');
  }
  return parsed.origin;
};

const projectRefFromUrl = (url) => {
  try {
    const host = new URL(url).hostname;
    return host.endsWith('.supabase.co') ? host.slice(0, -'.supabase.co'.length) : null;
  } catch { return null; }
};

const sanitizeProviderMessage = (value, fallback = 'Supabase request failed') =>
  String(value || fallback)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/(?:token|password|apikey|authorization|secret|refresh_token|access_token)\s*[:=]\s*\S+/gi, '[REDACTED]')
    .trim()
    .slice(0, 500) || fallback;

class SupabaseProjectService {
  constructor({
    registry,
    connectionService,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    now = () => new Date().toISOString(),
  } = {}) {
    if (!registry) throw new Error('supabase_registry_required');
    if (!connectionService) throw new Error('supabase_connection_service_required');
    if (typeof fetchImpl !== 'function') throw new Error('supabase_fetch_required');
    this.registry = registry;
    this.connectionService = connectionService;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
    this.now = now;
  }

  requireProject(alias) {
    const connection = this.registry.get(alias);
    if (!connection || connection.provider !== 'supabase') throw new SupabaseProviderError('supabase_connection_not_found', 'Supabase connection was not found');
    return connection;
  }

  getProjectConfig(alias, { requirePublishableKey = true } = {}) {
    const connection = this.requireProject(alias);
    const url = validateProjectUrl(connection.target?.url);
    const rawKey = connection.target?.publishableKey;
    const publishableKey = rawKey ? validatePublishableKey(rawKey) : null;
    if (requirePublishableKey && !publishableKey) {
      throw new SupabaseProviderError('supabase_project_not_configured', 'Supabase project publishable key is not configured');
    }
    return { alias, url, publishableKey, projectRef: projectRefFromUrl(url) };
  }

  updateProjectConfig(alias, { url, publishableKey } = {}) {
    const existing = this.requireProject(alias);
    const nextUrl = url === undefined ? existing.target?.url : validateProjectUrl(url);
    const nextKey = publishableKey === undefined ? existing.target?.publishableKey : validatePublishableKey(publishableKey);
    if (!nextUrl || !nextKey) throw new SupabaseProviderError('supabase_project_not_configured', 'Supabase project configuration is incomplete');
    const updated = this.registry.upsert({
      ...existing,
      target: {
        ...(existing.target || {}),
        url: validateProjectUrl(nextUrl),
        publishableKey: validatePublishableKey(nextKey),
      },
      lastError: null,
    });
    return this.publicSnapshot(updated.alias);
  }

  async request(alias, { method = 'POST', path, body, accessToken = null } = {}) {
    const config = this.getProjectConfig(alias);
    if (typeof path !== 'string' || !path.startsWith('/auth/v1/')) {
      throw new SupabaseProviderError('supabase_auth_path_invalid', 'Supabase Auth path is invalid');
    }
    const url = new URL(path, config.url);
    if (url.origin !== config.url) throw new SupabaseProviderError('supabase_auth_origin_invalid', 'Supabase Auth origin is invalid');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers = {
        apikey: config.publishableKey,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      };
      if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
      let encoded;
      if (body !== undefined) {
        encoded = JSON.stringify(body);
        if (Buffer.byteLength(encoded, 'utf8') > 64 * 1024) throw new SupabaseProviderError('supabase_request_too_large', 'Supabase auth request is too large');
      }

      let response;
      try {
        response = await this.fetchImpl(url.toString(), {
          method,
          headers,
          ...(encoded !== undefined ? { body: encoded } : {}),
          redirect: 'error',
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted || error?.name === 'AbortError') {
          throw new SupabaseProviderError('supabase_timeout', 'Supabase request timed out', { retryable: true });
        }
        throw new SupabaseProviderError('supabase_network_error', 'Supabase request failed', { retryable: true });
      }

      const contentLength = Number(response.headers?.get?.('content-length'));
      if (Number.isFinite(contentLength) && contentLength > this.maxResponseBytes) {
        throw new SupabaseProviderError('supabase_response_too_large', 'Supabase response exceeded the configured size limit', { status: response.status });
      }
      const raw = response.status === 204 ? '' : await response.text();
      if (Buffer.byteLength(raw, 'utf8') > this.maxResponseBytes) {
        throw new SupabaseProviderError('supabase_response_too_large', 'Supabase response exceeded the configured size limit', { status: response.status });
      }
      let data = {};
      if (raw) {
        try { data = JSON.parse(raw); }
        catch { throw new SupabaseProviderError('supabase_response_invalid', 'Supabase returned invalid JSON', { status: response.status }); }
      }
      if (!response.ok) {
        const status = response.status;
        const code = status === 401 ? 'supabase_unauthorized'
          : status === 403 ? 'supabase_forbidden'
            : status >= 500 ? 'supabase_server_error'
              : 'supabase_request_failed';
        throw new SupabaseProviderError(
          code,
          sanitizeProviderMessage(data?.msg || data?.message || `Supabase request failed with status ${status}`),
          { status, retryable: status >= 500 || status === 429 },
        );
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  signUp(alias, email, password) {
    return this.request(alias, { path: '/auth/v1/signup', body: { email, password } });
  }

  signIn(alias, email, password) {
    return this.request(alias, { path: '/auth/v1/token?grant_type=password', body: { email, password } });
  }

  refreshSession(alias, refreshToken) {
    return this.request(alias, { path: '/auth/v1/token?grant_type=refresh_token', body: { refresh_token: refreshToken } });
  }

  getRemoteUser(alias, accessToken) {
    return this.request(alias, { method: 'GET', path: '/auth/v1/user', accessToken });
  }

  publicSnapshot(alias) {
    const connection = this.requireProject(alias);
    const url = typeof connection.target?.url === 'string' ? connection.target.url : null;
    return {
      id: connection.id,
      alias: connection.alias,
      provider: connection.provider,
      label: connection.label,
      target: {
        url,
        projectRef: url ? projectRefFromUrl(url) : null,
        publishableKeyConfigured: Boolean(connection.target?.publishableKey),
      },
      capabilities: [...(connection.capabilities || [])],
      status: connection.status,
      account: null,
      lastCheckedAt: connection.lastCheckedAt || null,
      lastError: connection.lastError || null,
      createdAt: connection.createdAt,
      updatedAt: connection.updatedAt,
    };
  }

  async refreshHealth(alias) {
    const connection = this.requireProject(alias);
    let credential;
    try { credential = this.connectionService.getCredential(alias); }
    catch (error) {
      const updated = this.registry.updateStatus(alias, 'ERROR', { lastError: 'secure_storage_unavailable', checkedAt: this.now() });
      return this.publicSnapshot(updated.alias);
    }
    if (!credential?.accessToken) {
      const updated = this.registry.updateStatus(alias, 'DISCONNECTED', { lastError: null, checkedAt: this.now() });
      return this.publicSnapshot(updated.alias);
    }
    try {
      const user = await this.getRemoteUser(alias, credential.accessToken);
      const updated = this.registry.upsert({
        ...connection,
        status: 'CONNECTED',
        lastCheckedAt: this.now(),
        lastError: null,
      });
      const snapshot = this.publicSnapshot(updated.alias);
      snapshot.account = typeof user?.email === 'string' ? user.email : credential.email || null;
      return snapshot;
    } catch (error) {
      const status = error instanceof SupabaseProviderError && error.status === 401 ? 'NEEDS_REAUTH' : 'ERROR';
      const updated = this.registry.upsert({
        ...connection,
        status,
        lastCheckedAt: this.now(),
        lastError: typeof error?.code === 'string' ? error.code : 'supabase_health_failed',
      });
      const snapshot = this.publicSnapshot(updated.alias);
      snapshot.account = credential.email || null;
      return snapshot;
    }
  }
}

module.exports = {
  SupabaseProviderError,
  SupabaseProjectService,
  validateProjectUrl,
  validatePublishableKey,
  projectRefFromUrl,
};
