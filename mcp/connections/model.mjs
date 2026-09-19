import crypto from 'node:crypto';

export const CONNECTION_STATUSES = Object.freeze([
  'UNKNOWN',
  'CONNECTED',
  'DISCONNECTED',
  'EXPIRED',
  'NEEDS_REAUTH',
  'ERROR',
]);

export const CONNECTION_PROVIDERS = Object.freeze([
  'github',
  'supabase',
  'vercel',
]);

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const asOptionalString = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

export const assertConnectionAlias = (alias) => {
  if (typeof alias !== 'string' || !/^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/.test(alias)) {
    throw new Error('connection_alias_invalid');
  }
  return alias;
};

export const normalizeConnectionRecord = (input, { existing = null, now = () => new Date().toISOString() } = {}) => {
  if (!isPlainObject(input)) throw new Error('connection_record_invalid');

  const alias = assertConnectionAlias(input.alias);
  const provider = typeof input.provider === 'string' ? input.provider.trim() : '';
  if (!CONNECTION_PROVIDERS.includes(provider)) throw new Error('connection_provider_invalid');

  const status = input.status || existing?.status || 'UNKNOWN';
  if (!CONNECTION_STATUSES.includes(status)) throw new Error('connection_status_invalid');

  const auth = isPlainObject(input.auth) ? input.auth : {};
  const authType = asOptionalString(auth.type);
  const credentialRef = asOptionalString(auth.credentialRef);
  if (credentialRef && !authType) throw new Error('connection_auth_type_required');

  const capabilities = Array.isArray(input.capabilities)
    ? [...new Set(input.capabilities.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))].sort()
    : [];

  const timestamp = now();
  return {
    id: asOptionalString(input.id) || existing?.id || `conn_${crypto.randomUUID()}`,
    alias,
    provider,
    label: asOptionalString(input.label) || alias,
    target: isPlainObject(input.target) ? structuredClone(input.target) : {},
    auth: {
      type: authType,
      credentialRef,
    },
    capabilities,
    status,
    lastCheckedAt: asOptionalString(input.lastCheckedAt) || existing?.lastCheckedAt || null,
    lastError: asOptionalString(input.lastError) || null,
    createdAt: asOptionalString(existing?.createdAt) || asOptionalString(input.createdAt) || timestamp,
    updatedAt: timestamp,
  };
};

export const toPublicConnection = (record, { account = null } = {}) => ({
  id: record.id,
  alias: record.alias,
  provider: record.provider,
  label: record.label,
  target: structuredClone(record.target || {}),
  capabilities: [...(record.capabilities || [])],
  status: record.status,
  account: asOptionalString(account),
  lastCheckedAt: record.lastCheckedAt || null,
  lastError: record.lastError || null,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

export const builtinConnectionDefinitions = (settings = {}) => ([
  {
    id: 'conn_github_personal',
    alias: 'github:personal',
    provider: 'github',
    label: 'GitHub Personal',
    target: {},
    auth: { type: 'github_token', credentialRef: 'credential:github:personal' },
    capabilities: [],
    status: 'DISCONNECTED',
  },
  {
    id: 'conn_github_work',
    alias: 'github:work',
    provider: 'github',
    label: 'GitHub Work',
    target: {},
    auth: { type: 'github_token', credentialRef: 'credential:github:work' },
    capabilities: [],
    status: 'DISCONNECTED',
  },
  {
    id: 'conn_supabase_hearth',
    alias: 'supabase:hearth',
    provider: 'supabase',
    label: 'Hearth Supabase',
    target: {
      url: settings.supabaseUrl || null,
      ...(settings.supabaseAnonKey ? { publishableKey: settings.supabaseAnonKey } : {}),
    },
    auth: { type: 'supabase_session', credentialRef: 'credential:supabase:hearth' },
    capabilities: ['auth', 'bridge.read', 'bridge.write'],
    status: 'UNKNOWN',
  },
  {
    id: 'conn_supabase_xgen',
    alias: 'supabase:xgen',
    provider: 'supabase',
    label: 'Project X Supabase',
    target: {
      url: settings.publicTasksSupabaseUrl || null,
      ...(settings.publicTasksSupabaseAnonKey ? { publishableKey: settings.publicTasksSupabaseAnonKey } : {}),
    },
    auth: { type: 'supabase_session', credentialRef: 'credential:supabase:xgen' },
    capabilities: ['auth', 'goals.read', 'goals.write', 'reviews.write', 'tasks.read', 'tasks.write'],
    status: 'UNKNOWN',
  },
  {
    id: 'conn_vercel_main',
    alias: 'vercel:main',
    provider: 'vercel',
    label: 'Vercel Main',
    target: {},
    auth: { type: 'vercel_token', credentialRef: 'credential:vercel:main' },
    capabilities: [],
    status: 'DISCONNECTED',
  },
]);
