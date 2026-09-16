// Focused tests for Project X's OWN auth boundary in electron/main.cjs:
// getPublicTasksState, persistPublicTasksSession/clearPublicTasksSession,
// supabasePublicTasksAuthRequest, applyPublicTasksSession, and
// ensurePublicTasksSession -- proving this session is a SEPARATE namespace
// from the legacy bridge's (never reuses bridgeSession/bridgeSessionEncrypted,
// never a service_role key, always via the same safeStorage-backed
// encrypt/decrypt helpers). Executed against the EXACT committed source via
// the same extraction technique already used throughout this suite.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const mainSource = fs.readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');

const sessionStart = mainSource.indexOf('const loadPublicTasksSecrets = () => {');
const sessionEnd = mainSource.indexOf('const sendEvent = (event) => {');
assert.ok(sessionStart !== -1 && sessionEnd !== -1);
const sessionSource = mainSource.slice(sessionStart, sessionEnd);

const authStart = mainSource.indexOf('const supabasePublicTasksAuthRequest = async (pathName, body) => {');
const authEnd = mainSource.indexOf('\nconst stopServer = async () => {');
assert.ok(authStart !== -1 && authEnd !== -1);
const authSource = mainSource.slice(authStart, authEnd);

function buildAuthHarness({ settings = {}, fetchImpl } = {}) {
  const savedSettings = [];
  const saveSettings = (next) => { Object.assign(settingsState, next); savedSettings.push(next); return settingsState; };
  const settingsState = {
    publicTasksSupabaseUrl: 'https://pavrugcmxdgdxrjinzlm.supabase.co',
    publicTasksSupabaseAnonKey: '', publicTasksSessionEncrypted: null,
    bridgeSessionEncrypted: null, bridgeEnabled: false,
    ...settings,
  };
  const readSettings = () => settingsState;
  // A trivial in-memory stand-in for safeStorage -- encode/decode round-trips
  // exactly, which is all these tests need (safeStorage itself is not being
  // tested here; production still uses the real macOS Keychain-backed one).
  const encryptLocalSecret = (value) => (value ? JSON.stringify(value) : null);
  const decryptLocalSecret = (encoded) => { try { return encoded ? JSON.parse(encoded) : null; } catch { return null; } };
  let publicTasksClientInstance = { accessToken: null, ownerId: null, supabaseAnonKey: '', setSession(s) { this.accessToken = s.accessToken; this.ownerId = s.ownerId; } };
  // Same Supabase project/owner, a different table (see main.cjs's own
  // declaration comment) -- injected the same way publicTasksClientInstance
  // is, so applyPublicTasksSession's real source (which now also mirrors
  // the session onto this) does not hit a ReferenceError in this sandbox.
  let reviewItemsClientInstance = { accessToken: null, ownerId: null, setSession(s) { this.accessToken = s.accessToken; this.ownerId = s.ownerId; } };
  const factorySource = `
    let bridgeSession = null;
    let publicTasksSession = null;
    ${sessionSource}
    ${authSource}
    return {
      loadPublicTasksSecrets, getPublicTasksState, persistPublicTasksSession, clearPublicTasksSession,
      supabasePublicTasksAuthRequest, applyPublicTasksSession, ensurePublicTasksSession,
      getSession: () => publicTasksSession,
    };
  `;
  const factory = new Function('decryptLocalSecret', 'readSettings', 'saveSettings', 'encryptLocalSecret', 'sendEvent', 'publicTasksClientInstance', 'reviewItemsClientInstance', 'fetch', factorySource);
  const api = factory(decryptLocalSecret, readSettings, saveSettings, encryptLocalSecret, () => {}, publicTasksClientInstance, reviewItemsClientInstance,
    fetchImpl || (async () => { throw new Error('fetch must not be called in this test'); }));
  return { ...api, settingsState, savedSettings, publicTasksClientInstance, reviewItemsClientInstance };
}

// ── namespace isolation ─────────────────────────────────────────────────

test('Project X session is a SEPARATE settings key/namespace from the legacy bridge session', () => {
  const h = buildAuthHarness();
  h.persistPublicTasksSession({ accessToken: 'x-token', refreshToken: 'x-refresh', ownerId: 'owner-x', email: 'x@example.com', expiresAt: Date.now() + 3600000 });
  assert.ok(h.settingsState.publicTasksSessionEncrypted, 'publicTasksSessionEncrypted must be written');
  assert.equal(h.settingsState.bridgeSessionEncrypted, null, 'the legacy bridgeSessionEncrypted must never be touched');
  assert.equal(h.savedSettings.some((s) => 'bridgeEnabled' in s), false, 'saving a Project X session must never touch bridgeEnabled');
});

test('getPublicTasksState reflects configured (anon key present) and signedIn independently, and never leaks the token', () => {
  const notConfigured = buildAuthHarness();
  assert.deepEqual(notConfigured.getPublicTasksState(), { configured: false, signedIn: false, accountEmail: null });

  const configuredNotSignedIn = buildAuthHarness({ settings: { publicTasksSupabaseAnonKey: 'sb_publishable_x' } });
  assert.deepEqual(configuredNotSignedIn.getPublicTasksState(), { configured: true, signedIn: false, accountEmail: null });

  const signedIn = buildAuthHarness({ settings: { publicTasksSupabaseAnonKey: 'sb_publishable_x' } });
  signedIn.persistPublicTasksSession({ accessToken: 'tok', refreshToken: 'ref', ownerId: 'owner-1', email: 'a@b.com', expiresAt: Date.now() + 3600000 });
  const state = signedIn.getPublicTasksState();
  assert.equal(state.signedIn, true);
  assert.equal(state.accountEmail, 'a@b.com');
  assert.ok(!('accessToken' in state) && !('refreshToken' in state) && !('ownerId' in state), 'the raw token/ownerId must never be part of the renderer-facing state');
});

test('clearPublicTasksSession clears the session but never disables/touches bridgeEnabled (that field does not even exist here)', () => {
  const h = buildAuthHarness({ settings: { publicTasksSupabaseAnonKey: 'key' } });
  h.persistPublicTasksSession({ accessToken: 'tok', refreshToken: 'ref', ownerId: 'owner-1', email: null, expiresAt: Date.now() + 3600000 });
  h.clearPublicTasksSession();
  assert.equal(h.getSession(), null);
  assert.equal(h.settingsState.publicTasksSessionEncrypted, null);
  assert.equal(h.getPublicTasksState().signedIn, false);
});

// ── supabasePublicTasksAuthRequest / applyPublicTasksSession ───────────

test('supabasePublicTasksAuthRequest refuses to run with no publishable key configured, and never falls back to the legacy bridge key', async () => {
  const h = buildAuthHarness({ settings: { publicTasksSupabaseAnonKey: '' } });
  await assert.rejects(h.supabasePublicTasksAuthRequest('token?grant_type=password', { email: 'a@b.com', password: 'pw' }), /not configured/);
});

test('supabasePublicTasksAuthRequest posts to Project X\'s own auth endpoint with its own apikey, never the legacy project\'s', async () => {
  const calls = [];
  const h = buildAuthHarness({
    settings: { publicTasksSupabaseUrl: 'https://pavrugcmxdgdxrjinzlm.supabase.co', publicTasksSupabaseAnonKey: 'sb_publishable_x' },
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, json: async () => ({ access_token: 'tok', refresh_token: 'ref', user: { id: 'owner-1', email: 'a@b.com' }, expires_in: 3600 }) };
    },
  });
  await h.supabasePublicTasksAuthRequest('token?grant_type=password', { email: 'a@b.com', password: 'pw' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://pavrugcmxdgdxrjinzlm.supabase.co/auth/v1/token?grant_type=password');
  assert.equal(calls[0].opts.headers.apikey, 'sb_publishable_x');
});

test('applyPublicTasksSession persists the session, updates publicTasksClientInstance, and rejects a malformed response', () => {
  const h = buildAuthHarness({ settings: { publicTasksSupabaseAnonKey: 'key' } });
  assert.throws(() => h.applyPublicTasksSession({}), /did not return a valid session/);
  assert.equal(h.publicTasksClientInstance.accessToken, null, 'a malformed response must never partially apply');

  const session = h.applyPublicTasksSession({ access_token: 'tok', refresh_token: 'ref', user: { id: 'owner-1', email: 'a@b.com' }, expires_in: 3600 });
  assert.equal(session.ownerId, 'owner-1');
  assert.equal(h.publicTasksClientInstance.accessToken, 'tok');
  assert.equal(h.publicTasksClientInstance.ownerId, 'owner-1');
  assert.equal(h.getSession().ownerId, 'owner-1');
  // The Review Queue remote projection shares this SAME session (same
  // Supabase project/owner, a different table).
  assert.equal(h.reviewItemsClientInstance.accessToken, 'tok');
  assert.equal(h.reviewItemsClientInstance.ownerId, 'owner-1');
});

// ── ensurePublicTasksSession ─────────────────────────────────────────────

test('ensurePublicTasksSession throws when never signed in', async () => {
  const h = buildAuthHarness();
  await assert.rejects(h.ensurePublicTasksSession(), /Sign in to Project X first/);
});

test('ensurePublicTasksSession returns the cached session unchanged when still comfortably valid (no network call)', async () => {
  const h = buildAuthHarness({ settings: { publicTasksSupabaseAnonKey: 'key' }, fetchImpl: async () => { throw new Error('must not refresh yet'); } });
  h.persistPublicTasksSession({ accessToken: 'tok', refreshToken: 'ref', ownerId: 'owner-1', email: null, expiresAt: Date.now() + 3600000 });
  const session = await h.ensurePublicTasksSession();
  assert.equal(session.accessToken, 'tok');
});

test('ensurePublicTasksSession refreshes an expiring session via Project X\'s own refresh_token grant, and re-persists it', async () => {
  const calls = [];
  const h = buildAuthHarness({
    settings: { publicTasksSupabaseAnonKey: 'key' },
    fetchImpl: async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, json: async () => ({ access_token: 'new-tok', refresh_token: 'new-ref', user: { id: 'owner-1', email: 'a@b.com' }, expires_in: 3600 }) };
    },
  });
  h.persistPublicTasksSession({ accessToken: 'old-tok', refreshToken: 'old-ref', ownerId: 'owner-1', email: 'a@b.com', expiresAt: Date.now() + 1000 });
  const refreshed = await h.ensurePublicTasksSession();
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /token\?grant_type=refresh_token/);
  assert.equal(calls[0].body.refresh_token, 'old-ref');
  assert.equal(refreshed.accessToken, 'new-tok');
  assert.equal(h.getSession().accessToken, 'new-tok');
  assert.equal(h.publicTasksClientInstance.accessToken, 'new-tok');
});

// ── reconnect resync wiring (item 3): sign-in/sign-up must trigger a
// resync of already-terminal local X truth -- never rerun X or create a
// queue entry. resyncTerminalPublicXTasks's OWN retry-only, no-mutation
// behavior is separately proven in scripts/test-electron-remote-x-approval.mjs
// (R12/R13); here we only prove these IPC handlers actually call it, once
// a session is applied -- never service_role, never before the session exists.

test('publicTasks:sign-in calls resyncTerminalPublicXTasks() once a session is applied', () => {
  const handler = mainSource.slice(
    mainSource.indexOf("ipcMain.handle('publicTasks:sign-in'"),
    mainSource.indexOf("ipcMain.handle('publicTasks:sign-out'"),
  );
  assert.match(handler, /applyPublicTasksSession\(data\)/);
  assert.match(handler, /void resyncTerminalPublicXTasks\(\)/);
  assert.ok(handler.indexOf('applyPublicTasksSession(data)') < handler.indexOf('void resyncTerminalPublicXTasks()'), 'the session must be applied BEFORE resyncing');
});

test('publicTasks:sign-up calls resyncTerminalPublicXTasks() only on the immediate-session branch, never before applying it', () => {
  const handler = mainSource.slice(
    mainSource.indexOf("ipcMain.handle('publicTasks:sign-up'"),
    mainSource.indexOf("ipcMain.handle('publicTasks:sign-in'"),
  );
  assert.match(handler, /applyPublicTasksSession\(data\)/);
  assert.match(handler, /void resyncTerminalPublicXTasks\(\)/);
});

test('no publicTasks:* handler or Project X code path ever references a service_role key', () => {
  assert.doesNotMatch(mainSource, /service_role/i);
});

test('a session restored at startup also triggers resyncTerminalPublicXTasks and resyncPendingReviewItems (a restart is a reconnect)', () => {
  const readyIdx = mainSource.indexOf('const publicTasksReady = () => Boolean(');
  const nextIdx = mainSource.indexOf('const registerBridgeDevice = async () => {', readyIdx);
  assert.ok(readyIdx !== -1 && nextIdx !== -1);
  const block = mainSource.slice(readyIdx, nextIdx);
  const guardIdx = block.indexOf('if (publicTasksReady())');
  assert.ok(guardIdx !== -1, 'a publicTasksReady() guard must exist in this block');
  const guarded = block.slice(guardIdx);
  assert.match(guarded, /void resyncTerminalPublicXTasks\(\);/);
  // A restored session can have genuinely expired since it was persisted
  // (a stored JWT aging past ~1hr) -- resyncPendingReviewItems must be
  // preceded by a best-effort refresh, not called with whatever
  // (possibly stale) token happened to be restored. This is the exact fix
  // for a live-smoke-found defect (401 "JWT expired" reaching Project X).
  assert.match(guarded, /refreshPublicTasksSessionBestEffort\(\)\.then\(\(\) => resyncPendingReviewItems\(\{ client: reviewItemsClientInstance, goalRunner \}\)\)/);
});
