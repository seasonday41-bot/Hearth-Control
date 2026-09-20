const { app, BrowserWindow, dialog, ipcMain, safeStorage, Notification, shell } = require('electron');
const { Worker } = require('node:worker_threads');
const { fork, spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const crypto = require('node:crypto');
const localUpdater = require('./updater.cjs');
const remoteUpdater = require('./remote-updater.cjs');
const remoteUpdateStager = require('./remote-update-stager.cjs');
const remoteUpdateState = require('./remote-update-state.cjs');
const updateTrust = require('./update-trust-config.cjs');
const { createTaskNotifier } = require('./task-notifications.cjs');
const { SecureCredentialStore } = require('./security/secure-credential-store.cjs');
const { ConnectionService } = require('./connections/connection-service.cjs');
const { GitHubClient } = require('./github/github-client.cjs');
const { GitHubConnectionService } = require('./github/github-connection-service.cjs');
const { SupabaseProjectService } = require('./supabase/supabase-project-service.cjs');
const { VercelClient } = require('./vercel/vercel-client.cjs');
const { VercelConnectionService } = require('./vercel/vercel-connection-service.cjs');

const importFromHere = (relativePath) => import(pathToFileURL(path.join(__dirname, relativePath)).href);
let buildMetadata;
try { buildMetadata = require('./build-meta.json'); }
catch { buildMetadata = { version: require('../package.json').version, buildId: 'development-build', builtAt: null, platform: process.platform, arch: process.arch }; }

const defaults = {
  workspace: '',
  port: 3001,
  theme: 'light',
  bridgeEnabled: false,
  updateDirectory: '',
  supabaseUrl: 'https://wxxocsfygxlwaklncmop.supabase.co',
  supabaseAnonKey: 'sb_publishable_eyK3gxO_LoDEMzYriH9DCQ_PUgeiuFC',
  // Project X (public.tasks) is a SEPARATE Supabase project from the legacy
  // bridge above -- it is never signed in via bridgeSession/bridgeClientInstance,
  // and this anon key is intentionally blank until the user supplies Project
  // X's own publishable key (see publicTasksClientInstance below).
  publicTasksSupabaseUrl: 'https://pavrugcmxdgdxrjinzlm.supabase.co',
  publicTasksSupabaseAnonKey: '',
  permissions: { X: 'Ask', Codex: 'Ask', Files: 'Allow', Git: 'Allow', Terminal: 'Ask', Browser: 'Blocked', MarketResearch: 'Ask', Antigravity: 'Ask', Vercel: 'Ask' },
};
let mainWindow;
let serverProcess;
let serverState = { running: false, port: 3001, pid: null };
let goalRunner = null;
let taskStore = null;
let mt5BridgeServer = null;
let investModeController = null;
let investMonitor = null;
let investSignalJournal = null;
let connectionRegistry = null;
let credentialStore = null;
let connectionService = null;
let githubConnectionService = null;
let supabaseProjectService = null;
let vercelConnectionService = null;
let jobManager = null;
let xQueueCoordinator = null;
let xQueueStore = null;
let xQueueDispatchEnabled = false;
let xQueueCapacityTimer = null;
let xQueueCapacityImmediate = null;
let xGetQueueCapacityDeadline = null;
let xRunStore = null;
let xParseTask = null;
let xShuttingDown = false;
const xQueueInflight = new Map();
const xQueueRequests = new Map();
const pendingXApprovals = new Map();
const hearthJobRequests = new Map();
const hearthJobGeneralInflight = new Map();
const hearthJobMarketInflight = new Map();
let xWakeupTimer = null;
let xGetNextWakeupDeadline = null;
let xReconcileRuntimeNow = null;
let continuationRecoveryTimer = null;
let updaterInstallInProgress = false;
let remoteUpdateSession = null;
const localApprovals = new Map();
const BRIDGE_CONNECTION_ALIAS = 'supabase:hearth';
const PUBLIC_TASKS_CONNECTION_ALIAS = 'supabase:xgen';
const BRIDGE_PAIRING_CREDENTIAL_REF = 'credential:bridge:pairing';
let bridgeClientInstance = null;
let bridgeSession = null;
let bridgePairingSecret = null;
// Project X's own client + session -- deliberately separate from
// bridgeClientInstance/bridgeSession above (a different Supabase project);
// see publicTasksSupabaseUrl/publicTasksSupabaseAnonKey in `defaults`.
let publicTasksClientInstance = null;
let publicTasksSession = null;
// Review Queue remote projection (visibility-only): shares Project X's SAME
// session (publicTasksSession) since it's the same Supabase project/owner,
// just a different, dedicated table (public.review_items, never
// public.tasks -- see mcp/bridge/review-queue-sync.mjs's own docstring).
let reviewItemsClientInstance = null;
// Remote Goal ingress (public.goal_requests): also shares Project X's SAME
// session as publicTasksClientInstance/reviewItemsClientInstance -- same
// Supabase project/owner, a third dedicated table (never public.tasks, never
// review_items -- see mcp/bridge/goal-requests-client.mjs's own docstring).
let goalRequestsClientInstance = null;
let bridgeState = {
  enabled: false,
  deviceId: '',
  connected: false,
  configured: true,
  signedIn: false,
  accountEmail: null,
  pairingReady: false,
  pendingTasks: [],
  activeRemoteTaskId: null,
  pendingGoalRequests: [],
  activeGoalRequestId: null,
};
const taskNotifier = createTaskNotifier({ Notification, app });
const taskMonitors = new Map();
const localChatStreams = new Map();
const localChatTestApprovals = new Map();
let localChatTestRunner = null;
let isStartingTask = false;
let storageAuditWorker = null;
let storageAuditItems = new Map();
const monitorTaskTransition = async (taskId) => {
  if (!taskId || taskMonitors.has(taskId)) return;
  let lastSyncedConversationId = null;
  let lastSyncedStatus = null;

  try {
    const { getAntigravityTask, onTaskTransition } = await importFromHere('../mcp/executors/antigravity.mjs');
    const { syncRemoteTaskState } = await importFromHere('../mcp/bridge/client.mjs');

    const checkAndSync = async (currentTask) => {
      const task = currentTask || getAntigravityTask(taskId) || (taskStore ? taskStore.getTask(taskId) : null);
      if (!task) return;
      taskNotifier.setDockBadge(task.status);

      // Synchronize remote task state to Supabase
      if (task.source === 'remote' && task.remoteTaskId) {
        const needsSync =
          task.remoteSyncPending ||
          (task.conversationId && task.conversationId !== lastSyncedConversationId) ||
          (task.status !== lastSyncedStatus) ||
          ['waiting', 'done', 'error'].includes(task.status);

        if (needsSync) {
          lastSyncedConversationId = task.conversationId;
          lastSyncedStatus = task.status;
          await syncRemoteTaskState({ bridgeClient: bridgeClientInstance, taskStore, task });
        }
      }

      // Release active remote lock on terminal states
      if (['done', 'error'].includes(task.status)) {
        if (bridgeState.activeRemoteTaskId === task.remoteTaskId || bridgeState.activeRemoteTaskId === task.taskId) {
          bridgeState.activeRemoteTaskId = null;
          sendEvent({ type: 'bridge:state', state: bridgeState });
        }
      }

      // Terminal completion cleanup (done or error)
      if (taskNotifier.notify(task) || ['done', 'error'].includes(task.status)) {
        cleanup();
      }
    };

    const unsubscribe = onTaskTransition((updatedTask) => {
      if (updatedTask && (updatedTask.taskId === taskId || updatedTask.remoteTaskId === taskId)) {
        void checkAndSync(updatedTask);
      }
    });

    const cleanup = () => {
      unsubscribe();
      const timer = taskMonitors.get(taskId);
      if (timer) {
        clearInterval(timer);
        taskMonitors.delete(taskId);
      }
    };

    const timer = setInterval(() => void checkAndSync(), 2500);
    taskMonitors.set(taskId, timer);
    await checkAndSync();
  } catch {
    const timer = taskMonitors.get(taskId);
    if (timer) {
      clearInterval(timer);
      taskMonitors.delete(taskId);
    }
  }
};

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
const defaultUpdateDirectory = () => path.join(app.getPath('userData'), 'updates');
const readSettings = () => {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    return { ...defaults, ...saved, updateDirectory: saved.updateDirectory || defaultUpdateDirectory(), permissions: { ...defaults.permissions, ...saved.permissions } };
  } catch { return { ...defaults, updateDirectory: defaultUpdateDirectory(), permissions: { ...defaults.permissions } }; }
};
const writeSettingsDocument = (settings) => {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  return settings;
};
const saveSettings = (next) => {
  if (Object.keys(next || {}).some((key) => /Encrypted$/.test(key))) {
    throw new Error('secret_settings_write_forbidden');
  }
  return writeSettingsDocument({ ...readSettings(), ...next });
};
const removeSettingsKeys = (keys) => {
  const settings = readSettings();
  for (const key of keys) delete settings[key];
  return writeSettingsDocument(settings);
};
const publicSettingsSnapshot = () => {
  const settings = { ...readSettings() };
  for (const key of Object.keys(settings)) {
    if (/Encrypted$/.test(key)) delete settings[key];
  }
  return settings;
};
const sanitizeRendererSettingsInput = (settings = {}) => {
  const allowed = {};
  for (const key of ['workspace', 'port', 'theme', 'permissions']) {
    if (Object.hasOwn(settings, key)) allowed[key] = settings[key];
  }
  return allowed;
};
// Legacy decrypt-only helper used exclusively by the verified P3 migration.
// New credential writes never go back to settings.json.
const decryptLocalSecret = (encoded) => {
  if (!encoded || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return JSON.parse(safeStorage.decryptString(Buffer.from(encoded, 'base64')));
  } catch { return null; }
};
const migrateLegacyCredentialSetting = ({ settingKey, credentialRef }) => {
  if (!credentialStore) return false;
  const settings = readSettings();
  const encoded = settings[settingKey];
  if (!encoded) return false;
  try {
    if (!credentialStore.hasSecret(credentialRef)) {
      const decoded = decryptLocalSecret(encoded);
      if (!decoded) return false;
      credentialStore.setSecret(credentialRef, decoded);
    }
    if (!credentialStore.hasSecret(credentialRef)) return false;
    removeSettingsKeys([settingKey]);
    return true;
  } catch (error) {
    console.warn(`[Connections] Legacy credential migration skipped for ${settingKey}: ${error.message}`);
    return false;
  }
};
const migrateLegacyCredentials = () => {
  migrateLegacyCredentialSetting({
    settingKey: 'bridgeSessionEncrypted',
    credentialRef: 'credential:supabase:hearth',
  });
  migrateLegacyCredentialSetting({
    settingKey: 'publicTasksSessionEncrypted',
    credentialRef: 'credential:supabase:xgen',
  });
  migrateLegacyCredentialSetting({
    settingKey: 'bridgePairingEncrypted',
    credentialRef: BRIDGE_PAIRING_CREDENTIAL_REF,
  });
};
const readConnectionCredential = (alias) => {
  if (!connectionService) return null;
  try { return connectionService.getCredential(alias); }
  catch (error) {
    console.warn(`[Connections] Could not load credential for ${alias}: ${error.message}`);
    return null;
  }
};
const loadBridgeSecrets = () => {
  bridgeSession = readConnectionCredential(BRIDGE_CONNECTION_ALIAS);
  let pairing = null;
  try { pairing = credentialStore?.getSecret(BRIDGE_PAIRING_CREDENTIAL_REF) || null; }
  catch (error) { console.warn(`[Connections] Could not load bridge pairing secret: ${error.message}`); }
  bridgePairingSecret = typeof pairing?.secret === 'string' ? pairing.secret : null;
};
// A SEPARATE encrypted-at-rest session for Project X -- never derived from,
// or falls back to, bridgeSession. P3 moves storage behind the canonical
// Connection Service while preserving this strict auth-domain isolation.
const loadPublicTasksSecrets = () => {
  publicTasksSession = readConnectionCredential(PUBLIC_TASKS_CONNECTION_ALIAS);
};
const persistBridgeSession = (session) => {
  if (!connectionService) throw new Error('connection_service_unavailable');
  bridgeSession = session;
  connectionService.setCredential(BRIDGE_CONNECTION_ALIAS, session);
};
const clearBridgeSession = () => {
  bridgeSession = null;
  saveSettings({ bridgeEnabled: false });
  if (!connectionService) throw new Error('connection_service_unavailable');
  connectionService.clearCredential(BRIDGE_CONNECTION_ALIAS);
};
const persistPublicTasksSession = (session) => {
  if (!connectionService) throw new Error('connection_service_unavailable');
  publicTasksSession = session;
  connectionService.setCredential(PUBLIC_TASKS_CONNECTION_ALIAS, session);
};
const clearPublicTasksSession = () => {
  publicTasksSession = null;
  if (!connectionService) throw new Error('connection_service_unavailable');
  connectionService.clearCredential(PUBLIC_TASKS_CONNECTION_ALIAS);
};
/** Small, renderer-facing snapshot -- never includes the access/refresh token itself. */
const getPublicTasksState = () => {
  let configured = false;
  try {
    configured = Boolean(
      supabaseProjectService
        ?.getProjectConfig(PUBLIC_TASKS_CONNECTION_ALIAS, { requirePublishableKey: false })
        ?.publishableKey,
    );
  } catch {}
  return {
    configured,
    signedIn: Boolean(publicTasksSession?.accessToken && publicTasksSession?.ownerId),
    accountEmail: publicTasksSession?.email || null,
  };
};
const sendPublicTasksState = () => sendEvent({ type: 'publicTasks:state', state: getPublicTasksState() });
const sendEvent = (event) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('server:event', event); };
const publicInvestStatus = () => {
  if (!investModeController) throw new Error('invest_mode_controller_unavailable');
  const bridge = mt5BridgeServer?.status?.() ?? { running: false, snapshots: [] };
  const permission = readSettings().permissions?.MarketResearch ?? 'Ask';
  return {
    mode: investModeController.getState(),
    monitor: investMonitor?.getState?.() ?? {
      state: 'unavailable', interval_ms: 15_000, timeframe: 'H1', last_checked_at: null,
      last_signal_at: null, last_bar_as_of: null, last_error: null,
    },
    signals: investSignalJournal?.list?.() ?? [],
    mt5_bridge: bridge,
    search_ai: { permission, ready: permission !== 'Blocked', approval_required: permission === 'Ask' },
    invest_ai: { ready: true },
  };
};
const sendInvestUpdate = () => {
  try { sendEvent({ type: 'invest:updated', status: publicInvestStatus() }); } catch {}
};
const requestInvestMonitorPermission = ({ timeframe, asOf }) => new Promise((resolve) => {
  const requestId = `invest-monitor:${crypto.randomUUID()}`;
  let settled = false;
  const finish = (allowed, reason = 'user') => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    localApprovals.delete(requestId);
    sendEvent({ type: 'approval:resolved', requestId, permission: 'MarketResearch', allowed: allowed === true, reason });
    resolve(allowed === true);
  };
  const timer = setTimeout(() => finish(false, 'timeout'), 60_000);
  timer.unref?.();
  localApprovals.set(requestId, (allowed) => finish(allowed, 'user'));
  sendEvent({
    type: 'approval', requestId, permission: 'MarketResearch',
    action: `Analyze XAU/USD ${timeframe} bar ${asOf} and save a local signal`,
  });
});
const notifyInvestSignal = (signal) => {
  try {
    if (!Notification?.isSupported?.()) return;
    const entry = signal.entry_zone.length ? signal.entry_zone.join('–') : '—';
    const stop = signal.stop_loss == null ? '—' : signal.stop_loss;
    const target = signal.targets[0] ?? '—';
    const summary = String(signal.summary || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
    new Notification({
      title: `XAU/USD · ${signal.direction} · ${signal.confidence}%`,
      body: `Entry ${entry} · SL ${stop} · TP ${target}${summary ? `\n${summary}` : ''}`,
    }).show();
  } catch { /* best effort */ }
};

const initializeConnectionInfrastructure = async () => {
  const { ConnectionRegistry } = await importFromHere('../mcp/connections/registry.mjs');
  const { builtinConnectionDefinitions } = await importFromHere('../mcp/connections/model.mjs');
  const userDataPath = app.getPath('userData');

  connectionRegistry = new ConnectionRegistry({
    storagePath: path.join(userDataPath, 'connections.json'),
  });
  connectionRegistry.load();
  connectionRegistry.ensure(builtinConnectionDefinitions(readSettings()));

  credentialStore = new SecureCredentialStore({
    storagePath: path.join(userDataPath, 'credentials.json'),
    safeStorage,
  });
  connectionService = new ConnectionService({
    registry: connectionRegistry,
    secureStore: credentialStore,
  });

  migrateLegacyCredentials();

  githubConnectionService = new GitHubConnectionService({
    registry: connectionRegistry,
    connectionService,
    githubClient: new GitHubClient(),
  });
  supabaseProjectService = new SupabaseProjectService({
    registry: connectionRegistry,
    connectionService,
  });
  vercelConnectionService = new VercelConnectionService({
    registry: connectionRegistry,
    connectionService,
    vercelClient: new VercelClient(),
  });

  // Keep startup health local/non-networked. Provider-specific remote health
  // runs only when connections:refresh is explicitly requested.
  for (const connection of connectionRegistry.list()) {
    if (!['github', 'vercel'].includes(connection.provider)) connectionService.refreshHealth(connection.alias);
  }
};

let canonicalJson = null;
let canonicalizeXTask = null;
let computeXTaskFingerprint = null;
void importFromHere('../mcp/x/fingerprint.mjs').then((m) => {
  canonicalJson = m.canonicalJson;
  canonicalizeXTask = m.canonicalizeXTask;
  computeXTaskFingerprint = m.computeXTaskFingerprint;
});

const xQueueError = (code) => Object.assign(new Error(code), { code });
const hasLiveXQueueEntries = () => Boolean(xQueueStore &&
  (xQueueStore.listPending().length || xQueueStore.listDispatching().length || xQueueStore.listDispatched().length));
const xQueueWorkspaceMatches = (workspace) => {
  if (!hasLiveXQueueEntries()) return true;
  try {
    const selected = fs.realpathSync(workspace);
    return [...xQueueStore.listPending(), ...xQueueStore.listDispatching(), ...xQueueStore.listDispatched()]
      .every((entry) => fs.realpathSync(entry.workspaceRoot || entry.task?.workspace?.root) === selected);
  } catch { return false; }
};
const xQueueReceiptStatus = (receipt) => {
  if (!receipt) return { found: false, reason: xQueueStore?.recoveryRequired ? 'queue_recovery_required' : 'not_found' };
  const result = {
    found: true, request_id: receipt.requestId, queue_id: receipt.queueId, task_id: receipt.taskId,
    queue_status: receipt.queueStatus, run_id: receipt.runId, terminal_status: receipt.terminalStatus,
    accepted_at: receipt.acceptedAt,
  };
  if (receipt.queueStatus === 'terminal') {
    const run = receipt.runId ? xRunStore?.getRun(receipt.runId) : null;
    result.execution_detail_available = Boolean(run);
    if (run) {
      result.terminal_status = run.status;
      result.gate_status = run.gateStatus;
      result.hearth_outcome = run.hearthOutcome;
      result.error = run.error;
      result.result = run.result;
    }
  }
  if (xQueueStore?.recoveryRequired) result.recovery_required = true;
  return result;
};
const cancelXQueueRequest = (transportId) => {
  const waiter = xQueueRequests.get(transportId);
  if (!waiter) return;
  xQueueRequests.delete(transportId);
  waiter.active = false;
  if (waiter.inflight) {
    waiter.inflight.waiters.delete(transportId);
    if (!waiter.inflight.committed && waiter.inflight.waiters.size === 0) waiter.inflight.abort.abort();
  }
};
const cancelXQueueChild = (child) => {
  for (const [transportId, waiter] of xQueueRequests) if (waiter.child === child) cancelXQueueRequest(transportId);
  for (const pending of pendingXApprovals.values()) if (pending.child === child) pending.cancel();
};
const SUPABASE_REQUEST_ID_PREFIX = 'supabase:';
/**
 * Slice 1D: when a terminal X run is reconciled for a requestId that came
 * from Project X (requestId === `supabase:<public.tasks row id>`), forwards
 * the already-locked terminal-truth mapping to that SAME public.tasks row.
 * Read-only against XQueueStore/XRunStore (via the existing
 * findReceiptByRunId + xQueueReceiptStatus helpers -- no X-core mutation);
 * a sync failure never reruns X and never mutates queue/run state -- the
 * durable local receipt/run remain the sole authoritative truth, and a
 * later call (e.g. resyncTerminalPublicXTasks after bridge reconnect) can
 * simply retry.
 */
const syncTerminalReceiptToPublicTasks = async (receipt) => {
  if (!publicTasksClientInstance || !receipt || receipt.queueStatus !== 'terminal') return;
  if (typeof receipt.requestId !== 'string' || !receipt.requestId.startsWith(SUPABASE_REQUEST_ID_PREFIX)) return;
  const rowId = receipt.requestId.slice(SUPABASE_REQUEST_ID_PREFIX.length);
  if (!rowId) return;
  const status = xQueueReceiptStatus(receipt);
  try {
    await publicTasksClientInstance.updateTaskFromXRun({
      id: rowId,
      xStatus: receipt.terminalStatus,
      result: status.result ?? null,
      error: status.error ?? null,
    });
  } catch (err) {
    console.warn(`[Bridge] Failed to sync X terminal result for public.tasks row '${rowId}' (will retry on reconnect):`, err.message);
  }
};
/** Slice 1D retry: re-attempts syncTerminalReceiptToPublicTasks for every currently-terminal Project-X-originated receipt this store still holds. updateTaskFromXRun is an unconditional PATCH by id, so this is safe to call repeatedly (e.g. on bridge reconnect). */
const resyncTerminalPublicXTasks = async () => {
  if (!xQueueStore || !publicTasksClientInstance) return;
  for (const receipt of xQueueStore.receipts.values()) {
    if (receipt.queueStatus === 'terminal' && typeof receipt.requestId === 'string' && receipt.requestId.startsWith(SUPABASE_REQUEST_ID_PREFIX)) {
      await syncTerminalReceiptToPublicTasks(receipt);
    }
  }
};
/**
 * Remote Goal ingress: projects EVERY locally-linked Goal's CURRENT durable
 * state onto its goal_requests row -- read-only against goals.json (via
 * goalRunner.list_goals(), the same live instance every other caller uses),
 * best-effort against the remote row. Mirrors resyncTerminalPublicXTasks's
 * own philosophy exactly: goals.json is the sole authoritative truth, this
 * only ever PROJECTS it outward, never re-derives/re-imports/re-runs
 * anything from the remote side, and a write failure here can never rerun
 * Goal/X work -- it just gets retried on the next tick or reconnect.
 * Safe to call on every poll tick and on reconnect/sign-in alike.
 */
const resyncGoalRequestStates = async () => {
  if (!goalRunner || !goalRequestsClientInstance?.ownerId) return;
  await refreshPublicTasksSessionBestEffort();
  let goals;
  try { goals = goalRunner.list_goals(); } catch { return; }
  for (const goal of goals) {
    if (goal.remoteGoalRequest?.provider !== 'project-x') continue;
    const requestId = goal.remoteGoalRequest.requestId;
    if (!requestId) continue;
    try {
      await goalRequestsClientInstance.projectGoalState({ id: requestId, goal });
    } catch (err) {
      console.warn(`[Bridge] Failed to project Goal '${goal.id}' state to goal_requests row '${requestId}' (will retry):`, err.message);
    }
  }
};
const requestXApproval = (record, child, action, options = {}) => new Promise((resolve) => {
  const requestId = crypto.randomUUID();
  const isLive = options.isLive || (() => serverProcess === child);
  let settled = false;
  // Every settlement path (user, timeout, abort/child-replacement, shutdown)
  // funnels through here exactly once, and always makes the resolution
  // visible to the renderer via approval:resolved -- lifecycle notification
  // only, never re-derived/reinterpreted execution state.
  const finish = (allowed, reason) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    record.abort.signal.removeEventListener('abort', onAbort);
    pendingXApprovals.delete(requestId);
    localApprovals.delete(requestId);

    resolve(allowed === true);

    sendEvent({
      type: 'approval:resolved',
      requestId,
      allowed: allowed === true,
      reason,
    });
  };

  const onAbort = () => finish(false, 'aborted');
  const timer = setTimeout(() => finish(false, 'timeout'), 60000);

  pendingXApprovals.set(requestId, {
    child,
    cancel: (reason = xShuttingDown ? 'shutdown' : 'aborted') =>
      finish(false, reason),
  });

  localApprovals.set(requestId, (allowed) => finish(allowed, 'user'));

  record.abort.signal.addEventListener('abort', onAbort, { once: true });

  if (record.abort.signal.aborted || xShuttingDown || !isLive()) {
    finish(false, xShuttingDown ? 'shutdown' : 'aborted');
  } else {
    sendEvent({ type: 'approval', requestId, permission: 'X', action });
  }
});
/**
 * Goal-level X approval (Phase 2 slice): lets a user approve an entire
 * already-authored Goal's route:'x' steps in ONE prompt instead of once per
 * step. The approval is recorded as `goal.xApproval` (see mcp/goals/
 * model.mjs's validateXApproval) directly on the SAME live Goal object
 * GoalRunner's run_goal loop itself holds and repeatedly saves for the rest
 * of this run -- never via a separate storage fetch-mutate-save round trip.
 * That distinction is load-bearing: GoalStorage.saveGoal() always returns a
 * brand-new re-validated object rather than mutating its input in place, and
 * run_goal's own `goal` variable is captured once at the top of the run and
 * never refreshed from that return value -- so a write that instead re-
 * fetched the goal from storage would land on a DIFFERENT object than
 * run_goal's, and get silently clobbered the next time run_goal calls
 * `this.storage.saveGoal(goal)` with its own stale reference (this was the
 * exact cause of a live-smoke regression: the approval was granted and
 * briefly persisted, then immediately overwritten back to nothing the
 * moment step 1 finished, so step 2 saw no approval and re-prompted).
 * Mutating the passed-in `goal` object directly sidesteps that race
 * entirely: run_goal's own subsequent saveGoal(goal) calls naturally carry
 * `xApproval` forward, exactly like every other in-place field it sets.
 *
 * Local to Hearth only, never a remote or standing bypass mechanism, and
 * never a generic "allow all X": it authorizes only the EXACT already-
 * authored step ids of THIS one goal, at THIS exact resolved workspace
 * root, each pinned to its own xTask's exact fingerprint via the SAME
 * canonicalizeXTask/computeXTaskFingerprint formula ingestXTask itself uses
 * for its own idempotency. Any step added, removed, or whose xTask content
 * changes breaks that step's fingerprint match (reordering alone does not,
 * since a step's own id+fingerprint pair is unaffected by its position --
 * only content and set-membership are what "unchanged" means here) and
 * falls back to the normal per-step Ask prompt for that step -- this
 * function never auto-fails a goal on a stale/missing match. Callers only
 * invoke this when the GLOBAL X permission is already exactly 'Ask' (see
 * the goalRunner.xExecutor wiring below); it never runs, and so never
 * matters, under Blocked or Allow. Scoped to exactly one goal object:
 * every other X caller (local x_enqueue, Project X remote approval, or a
 * DIFFERENT Goal's steps) can never match this goal's approval record.
 *
 * @returns {Promise<boolean>} true only if THIS step is covered by a
 *   verified-matching (already-existing or freshly-approved-just-now) Goal
 *   approval snapshot.
 */
const resolveGoalXApproval = async ({ goal, step, task, action }) => {
  if (!goal || !step) return false;

  let taskRoot;
  try { taskRoot = await fs.promises.realpath(task.workspace.root); } catch { return false; }
  const currentFingerprint = computeXTaskFingerprint(task, taskRoot);

  const existing = goal.xApproval;
  if (existing && existing.workspaceRoot === taskRoot) {
    const match = existing.steps.find((s) => s.stepId === step.id && s.xTaskFingerprint === currentFingerprint);
    if (match) return true;
  }

  // No existing match: offer ONE bulk approval covering every route:'x'
  // step in the Goal's CURRENT snapshot that shares this SAME resolved
  // workspace root (a step whose own xTask points elsewhere is excluded
  // from this snapshot -- it falls back to its own normal per-step Ask
  // when it later dispatches). Only AUTHORING content (each step's own
  // xTask) feeds the fingerprint -- never mutable runtime fields like
  // status/result/evidence/startedAt/finishedAt, which live on the step
  // object itself, not inside xTask, and so can never affect this snapshot.
  const stepFingerprints = [];
  for (const s of goal.steps) {
    if (s.route !== 'x' || !s.xTask) continue;
    let root;
    try { root = await fs.promises.realpath(s.xTask.workspace.root); } catch { continue; }
    if (root !== taskRoot) continue;
    stepFingerprints.push({ stepId: s.id, title: s.title, xTaskFingerprint: computeXTaskFingerprint(s.xTask, root) });
  }
  if (!stepFingerprints.some((s) => s.stepId === step.id)) return false;

  const promptAction = [
    `Approve Goal "${goal.title}" (${stepFingerprints.length} X step${stepFingerprints.length === 1 ? '' : 's'}) in workspace ${taskRoot}:`,
    ...stepFingerprints.map((s, i) => `${i + 1}. ${s.title}`),
  ].join('\n');
  const approvalRecord = { abort: new AbortController() };
  const allowed = await requestXApproval(approvalRecord, null, promptAction, { isLive: () => true });
  if (!allowed) return false;

  goal.xApproval = {
    approvedAt: new Date().toISOString(),
    workspaceRoot: taskRoot,
    steps: stepFingerprints.map(({ stepId, xTaskFingerprint }) => ({ stepId, xTaskFingerprint })),
  };
  return true;
};
/**
 * The Electron-owned X ingress core shared by BOTH the local HTTP transport
 * (x_enqueue) and the remote-approved public.tasks path: task-workspace-
 * vs-CURRENT-settings-workspace validation, canonical fingerprint, requestId
 * / durable receipt idempotency (including in-flight coalescing across
 * concurrent callers of the SAME requestId), permission/admission via
 * requestXApproval, and xQueueCoordinator.enqueue()'s durable receipt.
 *
 * Callers parse their own raw payload with the SAME xParseTask before
 * calling this, and own any further transport-specific checks of their own
 * (e.g. the HTTP transport's child-process-liveness / 3-way childRoot-
 * reportedRoot-settingsRoot check, done by handleXQueueEnqueue below,
 * BEFORE it calls this) -- this core never knows about HTTP children,
 * waiters, or Supabase rows.
 *
 * `isLive` gates requestXApproval's own admission and the post-approval
 * recheck (record/process-identity liveness, e.g. serverProcess === child
 * for the HTTP transport); `waiterActive` gates ONLY this specific call's
 * own admission into an in-flight record (e.g. this one waiter.active) --
 * they are deliberately different so that one disconnected waiter sharing
 * an in-flight record with another still-connected waiter never aborts the
 * other's approved request (see the concurrent-waiter regression test).
 */
const ingestXTask = async ({ requestId, task, settingsRoot: preResolvedSettingsRoot, waiterId, waiterActive, child, action, isLive, onInflightRecord, skipStepApproval = false }) => {
  if (!xQueueStore) throw xQueueError('queue_unavailable');
  if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 256) throw xQueueError('invalid_request_id');
  let settingsRoot, taskRoot;
  try {
    settingsRoot = preResolvedSettingsRoot || await fs.promises.realpath(readSettings().workspace);
    taskRoot = await fs.promises.realpath(task.workspace.root);
  } catch { throw xQueueError('workspace_mismatch'); }
  const canonicalTask = canonicalizeXTask(task, taskRoot);
  const fingerprint = computeXTaskFingerprint(task, taskRoot);
  if (xQueueStore.recoveryRequired) throw xQueueError('queue_recovery_required');
  const prior = xQueueStore.getReceipt(requestId);
  if (prior) {
    if (prior.fingerprint !== fingerprint) throw xQueueError('request_id_conflict');
    return { accepted: true, ...xQueueReceiptStatus(prior) };
  }
  if (!waiterActive() || xShuttingDown || !isLive()) throw xQueueError('transport_unavailable');
  if (!xQueueCoordinator) throw xQueueError('workspace_mismatch');
  if (taskRoot !== settingsRoot || !xQueueDispatchEnabled || !xQueueWorkspaceMatches(settingsRoot)) throw xQueueError('workspace_mismatch');
  const existing = xQueueInflight.get(requestId);
  if (existing) {
    if (existing.fingerprint !== fingerprint) throw xQueueError('request_id_conflict');
    existing.waiters.add(waiterId);
    onInflightRecord?.(existing);
    return existing.promise;
  }
  const record = { fingerprint, waiters: new Set([waiterId]), abort: new AbortController(), committed: false, promise: null };
  onInflightRecord?.(record);
  xQueueInflight.set(requestId, record);
  record.promise = (async () => {
    const permission = readSettings().permissions.X ?? 'Ask';
    if (permission === 'Blocked') throw xQueueError('permission_blocked');
    if (permission !== 'Allow' && permission !== 'Ask') throw xQueueError('permission_blocked');
    // skipStepApproval is set ONLY by the goalRunner.xExecutor wiring below,
    // and only after resolveGoalXApproval has verified an exact match
    // against a durably-persisted, per-step-fingerprinted Goal approval
    // snapshot -- every other caller (local x_enqueue, Project X remote
    // approval) never passes it, so their behavior here is byte-for-byte
    // unchanged. 'Blocked' above and 'Allow' below are both untouched by it.
    if (permission === 'Ask' && !skipStepApproval && !(await requestXApproval(record, child, action, { isLive }))) throw xQueueError('permission_denied');
    if (record.abort.signal.aborted || xShuttingDown || !isLive() || record.waiters.size === 0) throw xQueueError('transport_unavailable');
    let currentRoot;
    try { currentRoot = await fs.promises.realpath(readSettings().workspace); } catch { throw xQueueError('workspace_mismatch'); }
    if (record.abort.signal.aborted || xShuttingDown || !isLive() || record.waiters.size === 0) throw xQueueError('transport_unavailable');
    if (currentRoot !== taskRoot || !xQueueDispatchEnabled || !xQueueWorkspaceMatches(currentRoot)) throw xQueueError('workspace_mismatch');
    const accepted = xQueueCoordinator.enqueue(canonicalTask, { requestId, fingerprint, workspaceRoot: taskRoot });
    if (accepted.error) throw xQueueError(accepted.error);
    record.committed = true;
    return { accepted: true, ...xQueueReceiptStatus(accepted.receipt) };
  })();
  try { return await record.promise; }
  finally { if (xQueueInflight.get(requestId) === record) xQueueInflight.delete(requestId); }
};
const handleXQueueEnqueue = async (message, child, launchWorkspace, waiter) => {
  if (!xQueueStore || !xParseTask) throw xQueueError('queue_unavailable');
  let task;
  try { task = xParseTask(message.task); } catch (error) { throw xQueueError(error?.code || 'invalid_x_task'); }
  let childRoot, reportedRoot, settingsRoot;
  try {
    [childRoot, reportedRoot, settingsRoot] = await Promise.all([
      fs.promises.realpath(launchWorkspace), fs.promises.realpath(message.workspace), fs.promises.realpath(readSettings().workspace),
    ]);
  } catch { throw xQueueError('workspace_mismatch'); }
  if (childRoot !== reportedRoot || childRoot !== settingsRoot) throw xQueueError('workspace_mismatch');
  return ingestXTask({
    requestId: message.requestId, task, settingsRoot, child,
    waiterId: waiter.transportId, waiterActive: () => waiter.active,
    isLive: () => serverProcess === child,
    action: `Queue X task: ${task.task_id}`,
    onInflightRecord: (record) => { waiter.inflight = record; },
  });
};

const hearthJobError = (code) => Object.assign(new Error(code), { code });

const validateHearthJobId = (jobId) => {
  if (typeof jobId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(jobId)) {
    throw hearthJobError('invalid_job_id');
  }
  return jobId;
};

const resolveHearthJobWorkspace = async (reportedWorkspace, launchWorkspace) => {
  let childRoot, reportedRoot, settingsRoot;
  try {
    [childRoot, reportedRoot, settingsRoot] = await Promise.all([
      fs.promises.realpath(launchWorkspace),
      fs.promises.realpath(reportedWorkspace),
      fs.promises.realpath(readSettings().workspace),
    ]);
  } catch {
    throw hearthJobError('workspace_mismatch');
  }
  if (childRoot !== reportedRoot || childRoot !== settingsRoot) {
    throw hearthJobError('workspace_mismatch');
  }
  return settingsRoot;
};

const publicHearthAntigravityStatus = (task) => ({
  task_id: task.taskId,
  status: task.status,
  title: task.title || null,
  created_at: task.createdAt || null,
  updated_at: task.updatedAt || null,
  last_event: task.lastEvent || null,
  completion: task.completion || null,
  error: task.error || null,
  route_reason: task.routeReason || null,
});

const hearthMarketKindFromTask = (task) => {
  const match = /^hearthmarket:(market_search|investment_analysis):/.exec(task?.requestId || '');
  return match?.[1] || null;
};

const publicHearthMarketStatus = (task) => {
  let result = null;
  if (typeof task?.lastAnswer === 'string' && task.lastAnswer.trim()) {
    try { result = JSON.parse(task.lastAnswer); } catch { result = null; }
  }
  return {
    task_id: task.taskId,
    kind: hearthMarketKindFromTask(task),
    status: task.status,
    title: task.title || null,
    created_at: task.createdAt || null,
    updated_at: task.updatedAt || null,
    last_event: task.lastEvent || null,
    completion: task.completion || null,
    error: task.error || null,
    route_reason: task.routeReason || null,
    result,
  };
};

const cancelHearthJobRequest = (transportId) => {
  const waiter = hearthJobRequests.get(transportId);
  if (!waiter) return;
  hearthJobRequests.delete(transportId);
  waiter.active = false;

  if (waiter.xInflight) {
    waiter.xInflight.waiters.delete(transportId);
    if (!waiter.xInflight.committed && waiter.xInflight.waiters.size === 0) {
      waiter.xInflight.abort.abort();
    }
  }

  if (waiter.generalInflight) {
    waiter.generalInflight.waiters.delete(transportId);
    if (!waiter.generalInflight.committed && waiter.generalInflight.waiters.size === 0) {
      waiter.generalInflight.abort.abort();
    }
  }

  if (waiter.marketInflight) {
    waiter.marketInflight.waiters.delete(transportId);
    if (!waiter.marketInflight.committed && waiter.marketInflight.waiters.size === 0) {
      waiter.marketInflight.abort.abort();
    }
  }
};

const cancelHearthJobChild = (child) => {
  for (const [transportId, waiter] of hearthJobRequests.entries()) {
    if (waiter.child === child) cancelHearthJobRequest(transportId);
  }
};

const requestHearthJobPermissionApproval = (shared, child, permission, action) => new Promise((resolve) => {
  const requestId = crypto.randomUUID();
  let settled = false;

  const finish = (allowed, reason) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    shared.abort.signal.removeEventListener('abort', onAbort);
    localApprovals.delete(requestId);
    resolve(allowed === true);
    sendEvent({
      type: 'approval:resolved',
      requestId,
      allowed: allowed === true,
      reason,
    });
  };

  const onAbort = () => finish(false, 'aborted');
  const timer = setTimeout(() => finish(false, 'timeout'), 60000);
  localApprovals.set(requestId, (allowed) => finish(allowed, 'user'));
  shared.abort.signal.addEventListener('abort', onAbort, { once: true });

  if (shared.abort.signal.aborted || xShuttingDown || shared.waiters.size === 0 || serverProcess !== child) {
    finish(false, xShuttingDown ? 'shutdown' : 'aborted');
    return;
  }

  sendEvent({
    type: 'approval',
    requestId,
    permission,
    action,
  });
});

const handleHearthJobStatus = async (message, launchWorkspace) => {
  const jobId = validateHearthJobId(message.jobId);
  await resolveHearthJobWorkspace(message.workspace, launchWorkspace);
  const { hearthJobTaskId, hearthJobXRequestId } = await importFromHere('../mcp/router/router.mjs');
  const requestId = hearthJobXRequestId(jobId);
  const taskId = hearthJobTaskId(jobId);
  const xReceipt = xQueueStore?.getReceipt(requestId) || null;
  const storedTask = taskStore?.getTask(taskId) || null;

  if (xReceipt && storedTask) throw hearthJobError('ambiguous_job_state');
  if (xReceipt) {
    return {
      found: true,
      job_id: jobId,
      route: 'x',
      status: xReceipt.queueStatus === 'terminal' ? (xReceipt.terminalStatus || 'terminal') : xReceipt.queueStatus,
      detail: xQueueReceiptStatus(xReceipt),
    };
  }
  if (storedTask) {
    const marketKind = hearthMarketKindFromTask(storedTask);
    return {
      found: true,
      job_id: jobId,
      route: marketKind ? 'market' : 'antigravity',
      status: storedTask.status,
      detail: marketKind ? publicHearthMarketStatus(storedTask) : publicHearthAntigravityStatus(storedTask),
    };
  }
  return { found: false, job_id: jobId, reason: 'not_found' };
};

const handleHearthJobSubmit = async (message, child, launchWorkspace, waiter) => {
  const {
    parseHearthJob,
  } = await importFromHere('../mcp/router/hearth-job-contract.mjs');
  const {
    routeHearthJob,
    adaptHearthJobToXTask,
    buildAntigravityPrompt,
    buildAntigravityRequestId,
    computeHearthJobFingerprint,
    hearthJobTaskId,
    hearthJobXRequestId,
  } = await importFromHere('../mcp/router/router.mjs');

  let job;
  try {
    job = parseHearthJob(message.job);
  } catch (error) {
    throw hearthJobError(error?.code || 'invalid_hearth_job');
  }

  const settingsRoot = await resolveHearthJobWorkspace(message.workspace, launchWorkspace);
  const { route, reason } = routeHearthJob(job);
  const taskId = hearthJobTaskId(job.job_id);
  const xRequestId = hearthJobXRequestId(job.job_id);
  const xReceipt = xQueueStore?.getReceipt(xRequestId) || null;
  const storedTask = taskStore?.getTask(taskId) || null;
  const storedMarketKind = hearthMarketKindFromTask(storedTask);

  if (xReceipt && storedTask) throw hearthJobError('ambiguous_job_state');
  if (route === 'x' && storedTask) throw hearthJobError('job_route_conflict');
  if (route === 'antigravity' && (xReceipt || storedMarketKind)) throw hearthJobError('job_route_conflict');
  if (route === 'market' && (xReceipt || (storedTask && !storedMarketKind))) throw hearthJobError('job_route_conflict');

  if (route === 'x') {
    const xTask = adaptHearthJobToXTask(job, {
      workspaceRoot: settingsRoot,
      repo: path.basename(settingsRoot),
    });
    const receipt = await ingestXTask({
      requestId: xRequestId,
      task: xTask,
      settingsRoot,
      child,
      waiterId: waiter.transportId,
      waiterActive: () => waiter.active,
      isLive: () => serverProcess === child && waiter.active,
      action: `Submit Hearth coding job: ${job.title || job.objective.slice(0, 80)}`,
      onInflightRecord: (record) => { waiter.xInflight = record; },
    });
    return {
      accepted: true,
      job_id: job.job_id,
      route: 'x',
      status: receipt.queue_status === 'terminal' ? (receipt.terminal_status || 'terminal') : receipt.queue_status,
      detail: receipt,
    };
  }

  if (!taskStore) throw hearthJobError('task_store_unavailable');

  if (route === 'market') {
    const fingerprint = computeHearthJobFingerprint(job);
    const marketRequestId = `hearthmarket:${job.kind}:${job.job_id}:${fingerprint}`;
    const current = taskStore.getTask(taskId);
    if (current) {
      if (current.requestId !== marketRequestId) throw hearthJobError('job_id_conflict');
      return {
        accepted: true,
        job_id: job.job_id,
        route: 'market',
        status: current.status,
        detail: publicHearthMarketStatus(current),
      };
    }

    const existingInflight = hearthJobMarketInflight.get(taskId);
    if (existingInflight) {
      if (existingInflight.fingerprint !== fingerprint) throw hearthJobError('job_id_conflict');
      existingInflight.waiters.add(waiter.transportId);
      waiter.marketInflight = existingInflight;
      return existingInflight.promise;
    }

    const shared = {
      fingerprint,
      waiters: new Set([waiter.transportId]),
      abort: new AbortController(),
      committed: false,
      promise: null,
    };
    waiter.marketInflight = shared;
    hearthJobMarketInflight.set(taskId, shared);

    shared.promise = (async () => {
      const permission = readSettings().permissions?.MarketResearch ?? 'Ask';
      if (permission === 'Blocked') throw hearthJobError('permission_blocked');
      if (permission !== 'Allow' && permission !== 'Ask') throw hearthJobError('permission_blocked');

      if (permission === 'Ask') {
        const allowed = await requestHearthJobPermissionApproval(
          shared,
          child,
          'MarketResearch',
          `Allow live XAU/USD market research for: ${job.title || job.objective.slice(0, 80)}`,
        );
        if (!allowed) throw hearthJobError('permission_denied');
      }

      if (shared.abort.signal.aborted || xShuttingDown || shared.waiters.size === 0 || serverProcess !== child) {
        throw hearthJobError('transport_unavailable');
      }

      let currentRoot;
      try {
        currentRoot = await fs.promises.realpath(readSettings().workspace);
      } catch {
        throw hearthJobError('workspace_mismatch');
      }
      if (currentRoot !== settingsRoot) throw hearthJobError('workspace_mismatch');

      const afterApproval = taskStore.getTask(taskId);
      if (afterApproval) {
        if (afterApproval.requestId !== marketRequestId) throw hearthJobError('job_id_conflict');
        return {
          accepted: true,
          job_id: job.job_id,
          route: 'market',
          status: afterApproval.status,
          detail: publicHearthMarketStatus(afterApproval),
        };
      }

      shared.committed = true;
      const startedAt = new Date().toISOString();
      const startEvent = {
        stepIndex: 1,
        type: 'MARKET_SPECIALIST_START',
        status: 'RUNNING',
        createdAt: startedAt,
        summary: job.kind === 'market_search'
          ? 'XAU/USD Search AI started.'
          : 'XAU/USD Search AI -> MT5 -> Invest AI pipeline started.',
      };
      const runningTask = {
        taskId,
        conversationId: null,
        workspace: settingsRoot,
        title: job.title || (job.kind === 'market_search' ? 'XAU/USD Search AI' : 'XAU/USD Invest AI'),
        source: 'local',
        requestId: marketRequestId,
        status: 'running',
        createdAt: startedAt,
        updatedAt: startedAt,
        lastAnswer: null,
        error: null,
        lastEvent: startEvent,
        recentEvents: [startEvent],
        completion: null,
        requestedRoute: 'auto',
        resolvedRoute: 'mcp',
        routeReason: reason,
      };
      taskStore.saveTask(runningTask);

      try {
        const { runLiveXauSearch, runLiveXauInvestment } = await importFromHere('../mcp/market/live-runtime.mjs');
        const result = job.kind === 'market_search'
          ? await runLiveXauSearch({ signal: shared.abort.signal })
          : await runLiveXauInvestment({ signal: shared.abort.signal });
        const completedAt = new Date().toISOString();
        const resultJson = JSON.stringify(result);
        const summary = job.kind === 'market_search'
          ? `XAU/USD Search AI completed with ${Array.isArray(result?.sources) ? result.sources.length : 0} sourced records.`
          : `XAU/USD Invest AI completed: ${result?.analysis?.direction || 'NEUTRAL'} at ${result?.analysis?.confidence ?? 'n/a'}% confidence.`;
        const doneEvent = {
          stepIndex: 2,
          type: 'MARKET_SPECIALIST_COMPLETE',
          status: 'DONE',
          createdAt: completedAt,
          summary,
        };
        const saved = taskStore.saveTask({
          ...runningTask,
          status: 'done',
          updatedAt: completedAt,
          lastAnswer: resultJson,
          lastEvent: doneEvent,
          recentEvents: [startEvent, doneEvent],
          completion: {
            status: 'done',
            normalizedStatus: 'completed',
            summary,
            error: null,
            checks: { build: 'not_run', tests: 'not_run' },
            artifacts: [],
          },
        });
        return {
          accepted: true,
          job_id: job.job_id,
          route: 'market',
          status: saved.status,
          detail: publicHearthMarketStatus(saved),
        };
      } catch (error) {
        const failedAt = new Date().toISOString();
        const message = String(error?.message || 'market_job_failed').slice(0, 2000);
        const errorEvent = {
          stepIndex: 2,
          type: 'MARKET_SPECIALIST_ERROR',
          status: 'ERROR',
          createdAt: failedAt,
          summary: message,
        };
        taskStore.saveTask({
          ...runningTask,
          status: 'error',
          updatedAt: failedAt,
          error: message,
          lastEvent: errorEvent,
          recentEvents: [startEvent, errorEvent],
          completion: {
            status: 'error',
            normalizedStatus: 'error',
            summary: 'XAU/USD market specialist failed.',
            error: message,
            checks: { build: 'not_run', tests: 'not_run' },
            artifacts: [],
          },
        });
        throw hearthJobError('market_job_failed');
      }
    })();

    try {
      return await shared.promise;
    } finally {
      if (hearthJobMarketInflight.get(taskId) === shared) hearthJobMarketInflight.delete(taskId);
    }
  }

  const fingerprint = computeHearthJobFingerprint(job);
  const requestId = buildAntigravityRequestId(job);
  const current = taskStore.getTask(taskId);
  if (current) {
    if (current.requestId !== requestId) throw hearthJobError('job_id_conflict');
    return {
      accepted: true,
      job_id: job.job_id,
      route: 'antigravity',
      status: current.status,
      detail: publicHearthAntigravityStatus(current),
    };
  }

  const existingInflight = hearthJobGeneralInflight.get(taskId);
  if (existingInflight) {
    if (existingInflight.fingerprint !== fingerprint) throw hearthJobError('job_id_conflict');
    existingInflight.waiters.add(waiter.transportId);
    waiter.generalInflight = existingInflight;
    return existingInflight.promise;
  }

  const shared = {
    fingerprint,
    waiters: new Set([waiter.transportId]),
    abort: new AbortController(),
    committed: false,
    promise: null,
  };
  waiter.generalInflight = shared;
  hearthJobGeneralInflight.set(taskId, shared);

  shared.promise = (async () => {
    const permission = readSettings().permissions?.Antigravity ?? 'Ask';
    if (permission === 'Blocked') throw hearthJobError('permission_blocked');
    if (permission !== 'Allow' && permission !== 'Ask') throw hearthJobError('permission_blocked');

    if (permission === 'Ask') {
      const allowed = await requestHearthJobPermissionApproval(
        shared,
        child,
        'Antigravity',
        `Submit Hearth general job: ${job.title || job.objective.slice(0, 80)}`,
      );
      if (!allowed) throw hearthJobError('permission_denied');
    }

    if (shared.abort.signal.aborted || xShuttingDown || shared.waiters.size === 0 || serverProcess !== child) {
      throw hearthJobError('transport_unavailable');
    }

    let currentRoot;
    try {
      currentRoot = await fs.promises.realpath(readSettings().workspace);
    } catch {
      throw hearthJobError('workspace_mismatch');
    }
    if (currentRoot !== settingsRoot) throw hearthJobError('workspace_mismatch');

    const afterApproval = taskStore.getTask(taskId);
    if (afterApproval) {
      if (afterApproval.requestId !== requestId) throw hearthJobError('job_id_conflict');
      return {
        accepted: true,
        job_id: job.job_id,
        route: 'antigravity',
        status: afterApproval.status,
        detail: publicHearthAntigravityStatus(afterApproval),
      };
    }

    // This is the P8 general-route commit boundary. Every permission and
    // transport/workspace liveness check has passed. From this point onward
    // the existing Antigravity start transaction owns launch/recovery truth;
    // a caller disconnect must not retroactively tear down admitted work.
    shared.committed = true;
    const { startAntigravityTask, getAntigravityTask } = await importFromHere('../mcp/executors/antigravity.mjs');
    const { getProductionAntigravityClaimStore } = await importFromHere('../mcp/executors/antigravity-admission.mjs');
    const result = await startAntigravityTask({
      workspace: settingsRoot,
      prompt: buildAntigravityPrompt(job),
      title: job.title || job.objective.slice(0, 120),
      userApproved: true,
      awaitCompletion: false,
      source: 'local',
      requestId,
      requestedRoute: 'auto',
      resolvedRoute: 'antigravity',
      routeReason: reason,
      existingTaskId: taskId,
      claimStore: getProductionAntigravityClaimStore(),
    });
    void monitorTaskTransition(result.taskId);
    const started = getAntigravityTask(result.taskId);
    return {
      accepted: true,
      job_id: job.job_id,
      route: 'antigravity',
      status: started.status,
      detail: publicHearthAntigravityStatus(started),
    };
  })();

  try {
    return await shared.promise;
  } finally {
    if (hearthJobGeneralInflight.get(taskId) === shared) hearthJobGeneralInflight.delete(taskId);
  }
};

// Fast-restart X liveness: a single one-shot wakeup, never polling/setInterval.
// Electron never inspects claim/run truth itself here -- it only ever reads
// one persisted deadline (getNextXWakeupDeadline) and, on fire, re-runs the
// exact same reconciliation production startup already performs
// (reconcileXRuntimeNow), feeding any newly-interrupted runIds into the
// already-existing XQueueCoordinator.onXRunTerminal(). Both function
// references are populated once, inside the X startup block below; a call
// to armXWakeup() before that (e.g. an early x_admission_hint) is a safe
// no-op -- the startup block's own final arm call covers it.
const armXWakeup = () => {
  if (xWakeupTimer) { clearTimeout(xWakeupTimer); xWakeupTimer = null; }
  if (!xGetNextWakeupDeadline) return;
  let deadline;
  try { deadline = xGetNextWakeupDeadline(); } catch (error) {
    console.error('[Electron] X wakeup deadline lookup failed:', error);
    return;
  }
  if (deadline == null) return;
  xWakeupTimer = setTimeout(onXWakeupFire, Math.max(0, deadline - Date.now()));
  xWakeupTimer.unref?.();
};

const onXWakeupFire = () => {
  xWakeupTimer = null;
  try {
    const runIds = xReconcileRuntimeNow ? xReconcileRuntimeNow() : [];
    for (const runId of runIds) {
      try {
        xQueueCoordinator?.onXRunTerminal({ runId });
      } catch (error) {
        console.error('[Electron] X wakeup terminal notification failed:', error);
      }
    }
  } catch (error) {
    console.error('[Electron] X wakeup reconciliation failed:', error);
  } finally {
    // Unconditional re-arm, even on an empty result or a notification
    // failure -- required for lease renewal: the same run's lease may have
    // been extended to a later deadline, which this re-read picks up.
    armXWakeup();
  }
};
const clearXQueueCapacityWakeup = () => {
  if (xQueueCapacityTimer) clearTimeout(xQueueCapacityTimer);
  if (xQueueCapacityImmediate) clearImmediate(xQueueCapacityImmediate);
  xQueueCapacityTimer = null;
  xQueueCapacityImmediate = null;
};
const armXQueueCapacityWakeup = () => {
  clearXQueueCapacityWakeup();
  if (!xQueueDispatchEnabled || !xQueueStore?.listPending().length || !xGetQueueCapacityDeadline) return;
  let deadline;
  try { deadline = xGetQueueCapacityDeadline(); }
  catch (error) { console.error('[Electron] X queue capacity deadline lookup failed:', error); return; }
  if (deadline == null) {
    xQueueCapacityImmediate = setImmediate(() => {
      xQueueCapacityImmediate = null;
      if (xQueueDispatchEnabled) xQueueCoordinator?.kick();
    });
    return;
  }
  xQueueCapacityTimer = setTimeout(() => {
    xQueueCapacityTimer = null;
    if (xQueueDispatchEnabled) xQueueCoordinator?.kick();
  }, Math.max(0, deadline - Date.now()));
  xQueueCapacityTimer.unref?.();
};
const getUpdaterInfo = () => ({
  currentVersion: buildMetadata.version,
  currentBuildId: buildMetadata.buildId,
  builtAt: buildMetadata.builtAt,
  updateDirectory: readSettings().updateDirectory,
  isPackaged: app.isPackaged,
});

const updaterDebug = (phase, detail) => {
  if (process.env.HEARTH_UPDATER_DEBUG !== '1') return;
  console.info(`[Updater] ${phase}`, detail ?? '');
};

const safeRemoteUpdateError = (error) => {
  const message = String(error?.message || '');
  if (/status 404\b/i.test(message)) return 'No published update is currently available.';
  if (/signature|keyId|signing key/i.test(message)) return 'The remote update could not be trusted.';
  if (/platform|arch/i.test(message)) return 'The published update is not compatible with this Mac.';
  if (/size|sha-?256|checksum|artifact/i.test(message)) return 'The downloaded update failed integrity verification.';
  if (/redirect|origin|protocol|DNS|network|request|URL|hostname|address/i.test(message)) return 'The update service could not be reached securely.';
  if (/mount|staging|application bundle|detach/i.test(message)) return 'The downloaded update could not be prepared safely.';
  return 'The remote update could not be prepared safely.';
};

const remoteUpdateOptions = () => ({
  manifestUrl: updateTrust.MANIFEST_URL,
  trustedOrigin: updateTrust.TRUSTED_DELIVERY_ORIGINS[0],
  trustedOrigins: updateTrust.TRUSTED_DELIVERY_ORIGINS,
  trustedKeys: updateTrust.TRUSTED_SIGNING_KEYS,
  artifactBaseUrl: updateTrust.ARTIFACT_BASE_URL,
  expectedPlatform: process.platform,
  expectedArch: process.arch,
});

const inspectLocalUpdateDirectory = async (updateDirectory, info = getUpdaterInfo()) => localUpdater.inspectUpdate({
  updateDirectory,
  currentVersion: info.currentVersion,
  currentBuildId: info.currentBuildId,
  currentBuiltAt: info.builtAt,
  isPackaged: info.isPackaged,
  platform: process.platform,
  arch: process.arch,
});

const getInstallUpdateDirectory = () => (
  remoteUpdateSession?.state === localUpdater.UPDATE_STATES.UPDATE_READY && remoteUpdateSession.stagedDir
    ? remoteUpdateSession.stagedDir
    : getUpdaterInfo().updateDirectory
);

const getUpdaterRuntimeBlocker = ({ ignoreUpdaterBusy = false } = {}) => {
  if (typeof xGetNextWakeupDeadline !== 'function' || !goalRunner || !jobManager) {
    return localUpdater.evaluateUpdaterRuntimePreflight({ runtimeAvailable: false });
  }

  try {
    return localUpdater.evaluateUpdaterRuntimePreflight({
      xActive: xGetNextWakeupDeadline() != null,
      goalActive: goalRunner.is_goal_active(),
      queuedJobCount: jobManager.listJobs({ status: 'queued' }).length,
      runningJobCount: jobManager.listJobs({ status: 'running' }).length,
      updaterBusy: !ignoreUpdaterBusy && updaterInstallInProgress,
    });
  } catch {
    console.error('[Updater] Runtime preflight state lookup failed.');
    return localUpdater.evaluateUpdaterRuntimePreflight({ runtimeAvailable: false });
  }
};
const startRollbackWatchdog = ({ token, target, backup, userDataPath }) => {
  const helper = path.join(__dirname, 'updater-helper.cjs');
  const child = spawn(process.execPath, [helper, token, target, backup, userDataPath, '15000'], {
    detached: true,
    stdio: 'ignore',
    shell: false,
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  child.unref();
};

const supabaseAuthRequest = async (pathName, body) => {
  if (!supabaseProjectService) throw new Error('Supabase project service is unavailable.');
  if (pathName === 'signup') {
    return supabaseProjectService.signUp(BRIDGE_CONNECTION_ALIAS, body?.email, body?.password);
  }
  if (pathName === 'token?grant_type=password') {
    return supabaseProjectService.signIn(BRIDGE_CONNECTION_ALIAS, body?.email, body?.password);
  }
  if (pathName === 'token?grant_type=refresh_token') {
    return supabaseProjectService.refreshSession(BRIDGE_CONNECTION_ALIAS, body?.refresh_token);
  }
  throw new Error('Unsupported Supabase auth operation.');
};

const applyBridgeSession = (data) => {
  if (!data?.access_token || !data?.refresh_token || !data?.user?.id) {
    throw new Error('Supabase did not return a valid session.');
  }
  const session = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    ownerId: data.user.id,
    email: data.user.email || null,
    expiresAt: Date.now() + Math.max(60, Number(data.expires_in) || 3600) * 1000,
  };
  persistBridgeSession(session);
  bridgeState.signedIn = true;
  bridgeState.accountEmail = session.email;
  bridgeClientInstance?.setSession({ accessToken: session.accessToken, ownerId: session.ownerId });
  return session;
};

const ensureBridgeSession = async () => {
  if (!bridgeSession?.refreshToken) throw new Error('Sign in to Supabase first.');
  if (bridgeSession.expiresAt > Date.now() + 60000) return bridgeSession;
  const refreshed = await supabaseAuthRequest('token?grant_type=refresh_token', { refresh_token: bridgeSession.refreshToken });
  return applyBridgeSession(refreshed);
};

// Project X keeps its OWN explicit auth wrapper and session application
// side effects. P5 centralizes only project/config authority behind the
// explicit supabase:xgen alias; it never shares or falls back to Hearth's
// session/project.
const supabasePublicTasksAuthRequest = async (pathName, body) => {
  if (!supabaseProjectService) throw new Error('Project X Supabase service is unavailable.');
  if (pathName === 'signup') {
    return supabaseProjectService.signUp(PUBLIC_TASKS_CONNECTION_ALIAS, body?.email, body?.password);
  }
  if (pathName === 'token?grant_type=password') {
    return supabaseProjectService.signIn(PUBLIC_TASKS_CONNECTION_ALIAS, body?.email, body?.password);
  }
  if (pathName === 'token?grant_type=refresh_token') {
    return supabaseProjectService.refreshSession(PUBLIC_TASKS_CONNECTION_ALIAS, body?.refresh_token);
  }
  throw new Error('Unsupported Project X auth operation.');
};

const applyPublicTasksSession = (data) => {
  if (!data?.access_token || !data?.refresh_token || !data?.user?.id) {
    throw new Error('Project X did not return a valid session.');
  }
  const session = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    ownerId: data.user.id,
    email: data.user.email || null,
    expiresAt: Date.now() + Math.max(60, Number(data.expires_in) || 3600) * 1000,
  };
  persistPublicTasksSession(session);
  publicTasksClientInstance?.setSession({ accessToken: session.accessToken, ownerId: session.ownerId });
  // Same Supabase project/owner, a different table -- see
  // reviewItemsClientInstance's own declaration comment.
  reviewItemsClientInstance?.setSession({ accessToken: session.accessToken, ownerId: session.ownerId });
  goalRequestsClientInstance?.setSession({ accessToken: session.accessToken, ownerId: session.ownerId });
  return session;
};

const ensurePublicTasksSession = async () => {
  if (!publicTasksSession?.refreshToken) throw new Error('Sign in to Project X first.');
  if (publicTasksSession.expiresAt > Date.now() + 60000) return publicTasksSession;
  const refreshed = await supabasePublicTasksAuthRequest('token?grant_type=refresh_token', { refresh_token: publicTasksSession.refreshToken });
  return applyPublicTasksSession(refreshed);
};

const refreshPublicTasksSessionBestEffort = async () => {
  if (publicTasksSession?.refreshToken) { try { await ensurePublicTasksSession(); } catch {} }
};

const probeHearthServer = (port = 3001) => new Promise((resolve) => {
  const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: 800 }, (res) => {
    let data = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      try {
        const json = JSON.parse(data);
        if (json?.status === 'ok' && json?.service === 'hearth-control') {
          resolve({ running: true, pid: typeof json.pid === 'number' ? json.pid : null, workspace: json.workspace || '' });
          return;
        }
      } catch {}
      resolve({ running: false, error: 'foreign_service' });
    });
  });
  req.on('error', (err) => resolve({ running: false, code: err.code }));
  req.on('timeout', () => { req.destroy(); resolve({ running: false, code: 'ETIMEDOUT' }); });
});

const stopServer = async () => {
  if (serverProcess) {
    const child = serverProcess;
    return new Promise((resolve) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 2500);
      child.once('exit', () => { clearTimeout(timer); resolve(serverState); });
      child.send({ type: 'shutdown' });
    });
  }
  if (serverState.running && serverState.pid) {
    const targetPid = serverState.pid;
    try { process.kill(targetPid, 'SIGTERM'); } catch {}
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      const probe = await probeHearthServer(serverState.port);
      if (!probe.running) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const finalProbe = await probeHearthServer(serverState.port);
    if (finalProbe.running) {
      try { process.kill(targetPid, 'SIGKILL'); } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
    serverState = { running: false, port: serverState.port, pid: null };
    sendEvent({ type: 'state', state: serverState });
    sendEvent({ type: 'log', source: 'mcp', tone: 'quiet', message: 'Local control server stopped' });
    return serverState;
  }
  return serverState;
};

const startServer = async ({ workspace, port }) => {
  const selectedPort = Number(port) || 3001;
  if (serverProcess) {
    serverState = { running: true, port: selectedPort, pid: serverProcess?.pid ?? null };
    sendEvent({ type: 'state', state: serverState });
    return serverState;
  }
  if (hasLiveXQueueEntries() && !xQueueWorkspaceMatches(workspace)) throw xQueueError('workspace_mismatch');

  const probe = await probeHearthServer(selectedPort);
  if (probe.running) {
    serverState = { running: true, port: selectedPort, pid: probe.pid };
    sendEvent({ type: 'state', state: serverState });
    sendEvent({ type: 'log', source: 'mcp', tone: 'quiet', message: `Local control server already running on 127.0.0.1:${selectedPort} (PID ${probe.pid})` });
    return serverState;
  }
  if (probe.error === 'foreign_service') {
    throw new Error(`Port ${selectedPort} is already in use by another application.`);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let startTimeout = null;
    const finishResolve = (val) => {
      if (settled) return;
      settled = true;
      if (startTimeout) clearTimeout(startTimeout);
      resolve(val);
    };
    const finishReject = (err) => {
      if (settled) return;
      settled = true;
      if (startTimeout) clearTimeout(startTimeout);
      reject(err);
    };
    startTimeout = setTimeout(() => {
      if (!settled) {
        try { child.kill('SIGKILL'); } catch {}
        finishReject(new Error('Server start timed out'));
      }
    }, 10000);
    startTimeout.unref();

    serverProcess = fork(path.join(__dirname, 'server.cjs'), [], {
      env: {
        ...process.env,
        CONTROL_PORT: String(selectedPort),
        CONTROL_WORKSPACE: workspace || '',
        CONTROL_PERMISSIONS: JSON.stringify(readSettings().permissions),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const child = serverProcess;
    const launchWorkspace = workspace || '';
    serverState = { running: false, port: selectedPort, pid: serverProcess.pid ?? null };
    sendEvent({ type: 'log', source: 'core', tone: 'quiet', message: `Starting local server process (PID ${serverProcess.pid})` });
    let stderrBuffer = '';
    serverProcess.stdout.on('data', (chunk) => sendEvent({ type: 'log', source: 'server', tone: 'quiet', message: chunk.toString().trim() }));
    serverProcess.stderr.on('data', (chunk) => {
      const msg = chunk.toString().trim();
      stderrBuffer = (stderrBuffer + '\n' + msg).trim();
      sendEvent({ type: 'log', source: 'server', tone: 'error', message: msg });
    });
    serverProcess.on('message', async (message) => {
      if (serverProcess !== child) return;
      if (message?.type === 'ready') {
        serverState = { running: true, port: selectedPort, pid: serverProcess?.pid ?? null };
        sendEvent({ type: 'state', state: serverState });
        sendEvent({ type: 'log', source: 'mcp', tone: 'success', message: `Local control server listening on 127.0.0.1:${selectedPort}` });
        finishResolve(serverState);
      }
    if (message?.type === 'approval') sendEvent(message);
    // Child-owned (Antigravity/Files/Terminal/Browser) approval lifecycle
    // notification -- a plain relay, exactly like 'approval' above. Main
    // never reinterprets it; it only forwards the child's own resolution.
    if (message?.type === 'approval:resolved') sendEvent(message);
    if (message?.type === 'x_run_terminal') {
      sendEvent(message);
      try {
        // The Project-X remote-result sync now fires centrally from
        // within the wrapped onXRunTerminal itself (see its construction
        // above) -- this relay no longer needs its own copy of that call.
        const handled = xQueueCoordinator?.onXRunTerminal(message);
        if (handled?.reason === 'not_tracked') xQueueCoordinator?.kick();
      } catch (err) {
        console.error('[XQueueCoordinator] onXRunTerminal failed:', err);
      }
    }
    if (message?.type === 'x_admission_hint') armXWakeup();
    if (message?.type === 'x_capacity_released_hint' && xQueueDispatchEnabled) {
      xQueueCoordinator?.kick();
      armXQueueCapacityWakeup();
    }
    if (message?.type === 'x_queue_request_cancel') cancelXQueueRequest(message.transportId);
    if (message?.type === 'x_queue_enqueue_request' || message?.type === 'x_queue_status_request') {
      if (typeof message.transportId !== 'string' || !/^[0-9a-f-]{36}$/i.test(message.transportId) || xQueueRequests.has(message.transportId)) return;
      const waiter = { transportId: message.transportId, child, active: true, inflight: null };
      xQueueRequests.set(message.transportId, waiter);
      const operation = message.type === 'x_queue_enqueue_request'
        ? handleXQueueEnqueue(message, child, launchWorkspace, waiter)
        : Promise.resolve().then(() => xQueueReceiptStatus(xQueueStore?.getReceipt(message.requestId)));
      void operation.then((receipt) => {
        if (waiter.active && serverProcess === child) {
          try { child.send({ type: message.type === 'x_queue_enqueue_request' ? 'x_queue_enqueue_ack' : 'x_queue_status_ack', transportId: message.transportId, ok: true, receipt }); }
          catch (error) { console.error('[Electron] X queue ack failed:', error); }
        }
      }, (error) => {
        if (waiter.active && serverProcess === child) {
          try { child.send({ type: message.type === 'x_queue_enqueue_request' ? 'x_queue_enqueue_ack' : 'x_queue_status_ack', transportId: message.transportId, ok: false, error: error?.code || 'queue_error' }); }
          catch (sendError) { console.error('[Electron] X queue error ack failed:', sendError); }
        }
      }).finally(() => cancelXQueueRequest(message.transportId));
    }
    if (message?.type === 'hearth_job_request_cancel') cancelHearthJobRequest(message.transportId);
    if (message?.type === 'hearth_job_submit_request' || message?.type === 'hearth_job_status_request') {
      if (typeof message.transportId !== 'string' || !/^[0-9a-f-]{36}$/i.test(message.transportId)) return;
      if (message.type === 'hearth_job_submit_request' && hearthJobRequests.has(message.transportId)) return;

      const waiter = message.type === 'hearth_job_submit_request'
        ? { transportId: message.transportId, child, active: true, xInflight: null, generalInflight: null, marketInflight: null }
        : null;
      if (waiter) hearthJobRequests.set(message.transportId, waiter);

      const operation = message.type === 'hearth_job_submit_request'
        ? handleHearthJobSubmit(message, child, launchWorkspace, waiter)
        : handleHearthJobStatus(message, launchWorkspace);

      void operation.then((result) => {
        if ((!waiter || waiter.active) && serverProcess === child) {
          try {
            child.send({
              type: message.type === 'hearth_job_submit_request' ? 'hearth_job_submit_ack' : 'hearth_job_status_ack',
              transportId: message.transportId,
              ok: true,
              result,
            });
          } catch (error) {
            console.error('[Electron] Hearth job ack failed:', error);
          }
        }
      }, (error) => {
        if ((!waiter || waiter.active) && serverProcess === child) {
          try {
            child.send({
              type: message.type === 'hearth_job_submit_request' ? 'hearth_job_submit_ack' : 'hearth_job_status_ack',
              transportId: message.transportId,
              ok: false,
              error: error?.code || 'hearth_job_error',
            });
          } catch (sendError) {
            console.error('[Electron] Hearth job error ack failed:', sendError);
          }
        }
      }).finally(() => {
        if (waiter) cancelHearthJobRequest(message.transportId);
      });
    }
    if ([
      'github_connections_list_request',
      'github_repositories_list_request',
      'github_repository_get_request',
      'github_pull_requests_list_request',
      'github_pull_request_create_request',
    ].includes(message?.type)) {
      if (typeof message.transportId !== 'string' || !/^[0-9a-f-]{36}$/i.test(message.transportId)) return;
      let result = null;
      let ok = true;
      let error = null;
      try {
        if (!githubConnectionService || !connectionRegistry) throw Object.assign(new Error('github_connection_service_unavailable'), { code: 'github_connection_service_unavailable' });
        if (message.type === 'github_connections_list_request') {
          result = {
            connections: connectionRegistry.list()
              .filter((connection) => connection.provider === 'github')
              .map((connection) => githubConnectionService.publicSnapshot(connection)),
          };
        } else if (message.type === 'github_repositories_list_request') {
          result = await githubConnectionService.listRepositories(message.connection, {
            page: message.page,
            perPage: message.perPage,
          });
        } else if (message.type === 'github_repository_get_request') {
          result = await githubConnectionService.getRepository(message.connection, {
            owner: message.owner,
            repo: message.repo,
          });
        } else if (message.type === 'github_pull_requests_list_request') {
          result = await githubConnectionService.listPullRequests(message.connection, {
            owner: message.owner,
            repo: message.repo,
            state: message.state,
            page: message.page,
            perPage: message.perPage,
          });
        } else if (message.type === 'github_pull_request_create_request') {
          result = await githubConnectionService.createPullRequest(message.connection, {
            owner: message.owner,
            repo: message.repo,
            title: message.title,
            head: message.head,
            base: message.base,
            body: message.body,
            draft: message.draft === true,
          });
        }
      } catch (err) {
        ok = false;
        error = typeof err?.code === 'string' ? err.code : 'github_request_failed';
      }
      if (serverProcess === child) {
        try {
          child.send({
            type: message.type.replace(/_request$/, '_ack'),
            transportId: message.transportId,
            ok,
            result,
            error,
          });
        } catch (sendError) {
          console.error('[Electron] GitHub request ack failed');
        }
      }
    }
    if ([
      'vercel_projects_list_request',
      'vercel_project_get_request',
      'vercel_deployments_list_request',
      'vercel_deployment_get_request',
    ].includes(message?.type)) {
      if (typeof message.transportId !== 'string' || !/^[0-9a-f-]{36}$/i.test(message.transportId)) return;
      let result = null;
      let ok = true;
      let error = null;
      try {
        if (!vercelConnectionService) throw Object.assign(new Error('vercel_connection_service_unavailable'), { code: 'vercel_connection_service_unavailable' });
        if (message.type === 'vercel_projects_list_request') {
          result = await vercelConnectionService.listProjects(message.connection, {
            teamId: message.teamId || null,
            limit: message.limit,
          });
        } else if (message.type === 'vercel_project_get_request') {
          result = await vercelConnectionService.getProject(message.connection, {
            idOrName: message.idOrName,
            teamId: message.teamId || null,
          });
        } else if (message.type === 'vercel_deployments_list_request') {
          result = await vercelConnectionService.listDeployments(message.connection, {
            projectId: message.projectId || null,
            teamId: message.teamId || null,
            limit: message.limit,
            target: message.target || null,
          });
        } else if (message.type === 'vercel_deployment_get_request') {
          result = await vercelConnectionService.getDeployment(message.connection, {
            idOrUrl: message.idOrUrl,
            teamId: message.teamId || null,
          });
        }
      } catch (err) {
        ok = false;
        error = typeof err?.code === 'string' ? err.code : 'vercel_request_failed';
      }
      if (serverProcess === child) {
        try {
          child.send({
            type: message.type.replace(/_request$/, '_ack'),
            transportId: message.transportId,
            ok,
            result,
            error,
          });
        } catch {
          console.error('[Electron] Vercel request ack failed');
        }
      }
    }
    if (message?.type === 'review_queue_list_request') {
      if (typeof message.transportId !== 'string' || !/^[0-9a-f-]{36}$/i.test(message.transportId)) return;
      // Read-only: calls the SAME live goalRunner.list_review_queue() the
      // running app itself uses -- never a second GoalRunner/GoalStorage,
      // and list_review_queue() itself makes no writes (see mcp/goals/
      // runner.mjs). No waiter/cancel bookkeeping needed: this is a single
      // synchronous read, not an in-flight X admission.
      let items = [];
      let ok = true;
      let error = null;
      try {
        items = goalRunner ? goalRunner.list_review_queue(message.goalId ? { goalId: message.goalId } : {}) : [];
        if (!goalRunner) { ok = false; error = 'goal_runner_unavailable'; }
      } catch (err) {
        ok = false;
        error = err?.message || 'review_queue_list_failed';
        items = [];
      }
      if (serverProcess === child) {
        try { child.send({ type: 'review_queue_list_ack', transportId: message.transportId, ok, items, error }); }
        catch (sendError) { console.error('[Electron] Review Queue list ack failed:', sendError); }
      }
    }
    if (message?.type === 'review_queue_acknowledge_request') {
      if (typeof message.transportId !== 'string' || !/^[0-9a-f-]{36}$/i.test(message.transportId)) return;
      let result = null;
      let ok = true;
      let error = null;
      try {
        if (!goalRunner) { ok = false; error = 'goal_runner_unavailable'; }
        else {
          result = await goalRunner.acknowledge_review(message.goalId, message.reviewItemId, {
            actor: message.actor,
            note: message.note,
          });
          ok = true;
          sendEvent({ type: 'goals:updated', goal: result.goal });
        }
      } catch (err) {
        ok = false;
        error = err?.message || 'review_queue_acknowledge_failed';
      }
      if (serverProcess === child) {
        try { child.send({ type: 'review_queue_acknowledge_ack', transportId: message.transportId, ok, result, error }); }
        catch (sendError) { console.error('[Electron] Review Queue acknowledge ack failed:', sendError); }
      }
    }
    if (message?.type === 'review_queue_resolve_request') {
      if (typeof message.transportId !== 'string' || !/^[0-9a-f-]{36}$/i.test(message.transportId)) return;
      let result = null;
      let ok = true;
      let error = null;
      try {
        if (!goalRunner) { ok = false; error = 'goal_runner_unavailable'; }
        else {
          result = await goalRunner.resolve_review(message.goalId, message.reviewItemId, {
            action: message.action || 'accept',
            note: message.note,
          });
          ok = true;
          sendEvent({ type: 'goals:updated', goal: result.goal });
          void resyncGoalRequestStates();
        }
      } catch (err) {
        ok = false;
        error = err?.message || 'review_queue_resolve_failed';
      }
      if (serverProcess === child) {
        try { child.send({ type: 'review_queue_resolve_ack', transportId: message.transportId, ok, result, error }); }
        catch (sendError) { console.error('[Electron] Review Queue resolve ack failed:', sendError); }
      }
    }
    if (message?.type === 'review_queue_retry_request') {
      if (typeof message.transportId !== 'string' || !/^[0-9a-f-]{36}$/i.test(message.transportId)) return;
      let result = null;
      let ok = true;
      let error = null;
      try {
        if (!goalRunner) { ok = false; error = 'goal_runner_unavailable'; }
        else {
          result = await goalRunner.retry_review(message.goalId, message.reviewItemId, {
            xTask: message.xTask,
            note: message.note,
            actor: message.actor,
          });
          ok = true;
          sendEvent({ type: 'goals:updated', goal: result.goal });
          void resyncGoalRequestStates();
        }
      } catch (err) {
        ok = false;
        error = err?.message || 'review_queue_retry_failed';
      }
      if (serverProcess === child) {
        try { child.send({ type: 'review_queue_retry_ack', transportId: message.transportId, ok, result, error }); }
        catch (sendError) { console.error('[Electron] Review Queue retry ack failed:', sendError); }
      }
    }
    if (message?.type === 'goal_get_context_request') {
      if (typeof message.transportId !== 'string' || !/^[0-9a-f-]{36}$/i.test(message.transportId)) return;
      let context = null;
      let ok = true;
      let error = null;
      try {
        if (!goalRunner) { ok = false; error = 'goal_runner_unavailable'; }
        else {
          context = await goalRunner.getGoalContext(message.goalId);
          ok = true;
        }
      } catch (err) {
        ok = false;
        error = err?.message || 'goal_get_context_failed';
      }
      if (serverProcess === child) {
        try { child.send({ type: 'goal_get_context_ack', transportId: message.transportId, ok, context, error }); }
        catch (sendError) { console.error('[Electron] Goal context ack failed:', sendError); }
      }
    }
    if (message?.type === 'goal_request_specialist_handoff_request') {
      if (typeof message.transportId !== 'string' || !/^[0-9a-f-]{36}$/i.test(message.transportId)) return;
      let result = null;
      let ok = true;
      let error = null;
      try {
        if (!goalRunner) { ok = false; error = 'goal_runner_unavailable'; }
        else {
          result = await goalRunner.request_specialist_handoff(message.goalId, message.stepId, {
            target: message.target,
            reason: message.reason,
            requestedAction: message.requestedAction,
            actor: message.actor,
          });
          ok = true;
          sendEvent({ type: 'goals:updated', goal: result.goal });
        }
      } catch (err) {
        ok = false;
        error = err?.message || 'request_specialist_handoff_failed';
      }
      if (serverProcess === child) {
        try { child.send({ type: 'goal_request_specialist_handoff_ack', transportId: message.transportId, ok, result, error }); }
        catch (sendError) { console.error('[Electron] Request specialist handoff ack failed:', sendError); }
      }
    }
    if (message?.type === 'goal_get_specialist_handoff_request') {
      if (typeof message.transportId !== 'string' || !/^[0-9a-f-]{36}$/i.test(message.transportId)) return;
      let handoffPackage = null;
      let ok = true;
      let error = null;
      try {
        if (!goalRunner) { ok = false; error = 'goal_runner_unavailable'; }
        else {
          handoffPackage = await goalRunner.build_specialist_handoff(message.goalId, message.handoffId);
          ok = true;
        }
      } catch (err) {
        ok = false;
        error = err?.message || 'get_specialist_handoff_failed';
      }
      if (serverProcess === child) {
        try { child.send({ type: 'goal_get_specialist_handoff_ack', transportId: message.transportId, ok, result: handoffPackage, error }); }
        catch (sendError) { console.error('[Electron] Get specialist handoff ack failed:', sendError); }
      }
    }
    if (message?.type === 'goal_list_specialist_handoffs_request') {
      if (typeof message.transportId !== 'string' || !/^[0-9a-f-]{36}$/i.test(message.transportId)) return;
      let handoffs = null;
      let ok = true;
      let error = null;
      try {
        if (!goalRunner) { ok = false; error = 'goal_runner_unavailable'; }
        else {
          handoffs = await goalRunner.list_specialist_handoffs(message.goalId);
          ok = true;
        }
      } catch (err) {
        ok = false;
        error = err?.message || 'list_specialist_handoffs_failed';
      }
      if (serverProcess === child) {
        try { child.send({ type: 'goal_list_specialist_handoffs_ack', transportId: message.transportId, ok, result: handoffs, error }); }
        catch (sendError) { console.error('[Electron] List specialist handoffs ack failed:', sendError); }
      }
    }
    if (message?.type === 'goal_authorize_specialist_execution_request') {
      if (typeof message.transportId !== 'string' || !/^[0-9a-f-]{36}$/i.test(message.transportId)) return;
      let result = null;
      let ok = true;
      let error = null;
      try {
        if (!goalRunner) { ok = false; error = 'goal_runner_unavailable'; }
        else {
          result = await goalRunner.authorize_specialist_execution(message.goalId, message.handoffId, { actor: message.actor });
          ok = true;
          sendEvent({ type: 'goals:updated', goal: result.goal });
        }
      } catch (err) {
        ok = false;
        error = err?.message || 'authorize_specialist_execution_failed';
      }
      if (serverProcess === child) {
        try { child.send({ type: 'goal_authorize_specialist_execution_ack', transportId: message.transportId, ok, result, error }); }
        catch (sendError) { console.error('[Electron] Authorize specialist execution ack failed:', sendError); }
      }
    }
    if (message?.type === 'goal_dispatch_specialist_execution_request') {
      if (typeof message.transportId !== 'string' || !/^[0-9a-f-]{36}$/i.test(message.transportId)) return;
      let result = null;
      let ok = true;
      let error = null;
      try {
        if (!goalRunner) { ok = false; error = 'goal_runner_unavailable'; }
        else if ((readSettings().permissions?.Codex ?? 'Ask') === 'Blocked') {
          ok = false;
          error = 'codex_permission_blocked';
        } else {
          result = await goalRunner.dispatch_specialist_execution(message.goalId, message.executionId, { codexBin: message.codexBin });
          ok = true;
          sendEvent({ type: 'goals:updated', goal: result.goal });
        }
      } catch (err) {
        ok = false;
        error = err?.message || 'dispatch_specialist_execution_failed';
      }
      if (serverProcess === child) {
        try { child.send({ type: 'goal_dispatch_specialist_execution_ack', transportId: message.transportId, ok, result, error }); }
        catch (sendError) { console.error('[Electron] Dispatch specialist execution ack failed:', sendError); }
      }
    }
    if (message?.type === 'goal_get_specialist_execution_request') {
      if (typeof message.transportId !== 'string' || !/^[0-9a-f-]{36}$/i.test(message.transportId)) return;
      let execution = null;
      let ok = true;
      let error = null;
      try {
        if (!goalRunner) { ok = false; error = 'goal_runner_unavailable'; }
        else {
          execution = await goalRunner.get_specialist_execution(message.goalId, message.executionId);
          ok = true;
        }
      } catch (err) {
        ok = false;
        error = err?.message || 'get_specialist_execution_failed';
      }
      if (serverProcess === child) {
        try { child.send({ type: 'goal_get_specialist_execution_ack', transportId: message.transportId, ok, result: execution, error }); }
        catch (sendError) { console.error('[Electron] Get specialist execution ack failed:', sendError); }
      }
    }
    if (message?.type === 'goal_get_specialist_result_request') {
      if (typeof message.transportId !== 'string' || !/^[0-9a-f-]{36}$/i.test(message.transportId)) return;
      let resRecord = null;
      let ok = true;
      let error = null;
      try {
        if (!goalRunner) { ok = false; error = 'goal_runner_unavailable'; }
        else {
          resRecord = await goalRunner.get_specialist_result(message.goalId, message.resultId);
          ok = true;
        }
      } catch (err) {
        ok = false;
        error = err?.message || 'get_specialist_result_failed';
      }
      if (serverProcess === child) {
        try { child.send({ type: 'goal_get_specialist_result_ack', transportId: message.transportId, ok, result: resRecord, error }); }
        catch (sendError) { console.error('[Electron] Get specialist result ack failed:', sendError); }
      }
    }
    if (message?.type === 'goal_accept_specialist_result_request') {
      if (typeof message.transportId !== 'string' || !/^[0-9a-f-]{36}$/i.test(message.transportId)) return;
      let resData = null;
      let ok = true;
      let error = null;
      try {
        if (!goalRunner) { ok = false; error = 'goal_runner_unavailable'; }
        else {
          resData = await goalRunner.accept_specialist_result(message.goalId, message.resultId, { decidedBy: message.decidedBy, note: message.note });
          ok = true;
        }
      } catch (err) {
        ok = false;
        error = err?.message || 'accept_specialist_result_failed';
      }
      if (serverProcess === child) {
        try { child.send({ type: 'goal_accept_specialist_result_ack', transportId: message.transportId, ok, result: resData, error }); }
        catch (sendError) { console.error('[Electron] Accept specialist result ack failed:', sendError); }
      }
    }
    if (message?.type === 'goal_reject_specialist_result_request') {
      if (typeof message.transportId !== 'string' || !/^[0-9a-f-]{36}$/i.test(message.transportId)) return;
      let resData = null;
      let ok = true;
      let error = null;
      try {
        if (!goalRunner) { ok = false; error = 'goal_runner_unavailable'; }
        else {
          resData = await goalRunner.reject_specialist_result(message.goalId, message.resultId, { decidedBy: message.decidedBy, note: message.note });
          ok = true;
        }
      } catch (err) {
        ok = false;
        error = err?.message || 'reject_specialist_result_failed';
      }
      if (serverProcess === child) {
        try { child.send({ type: 'goal_reject_specialist_result_ack', transportId: message.transportId, ok, result: resData, error }); }
        catch (sendError) { console.error('[Electron] Reject specialist result ack failed:', sendError); }
      }
    }
    if (message?.type === 'goal_get_specialist_result_decision_request') {
      if (typeof message.transportId !== 'string' || !/^[0-9a-f-]{36}$/i.test(message.transportId)) return;
      let decRecord = null;
      let ok = true;
      let error = null;
      try {
        if (!goalRunner) { ok = false; error = 'goal_runner_unavailable'; }
        else {
          decRecord = await goalRunner.get_specialist_result_decision(message.goalId, message.resultId);
          ok = true;
        }
      } catch (err) {
        ok = false;
        error = err?.message || 'get_specialist_result_decision_failed';
      }
      if (serverProcess === child) {
        try { child.send({ type: 'goal_get_specialist_result_decision_ack', transportId: message.transportId, ok, result: decRecord, error }); }
        catch (sendError) { console.error('[Electron] Get specialist result decision ack failed:', sendError); }
      }
    }
  });
    serverProcess.once('exit', (code, signal) => {
      cancelXQueueChild(child);
      cancelHearthJobChild(child);
      if (serverProcess === child) serverProcess = undefined;
      serverState = { running: false, port: selectedPort, pid: null };
      sendEvent({ type: 'state', state: serverState });
      sendEvent({ type: 'log', source: 'mcp', tone: code === 0 || signal === 'SIGTERM' ? 'quiet' : 'error', message: code === 0 || signal === 'SIGTERM' ? 'Local server stopped' : `Server exited unexpectedly (${code ?? signal})` });
      if (!settled) {
        const lastErr = stderrBuffer ? `: ${stderrBuffer.split('\n').filter(Boolean).pop()}` : ` (exit code ${code ?? signal})`;
        finishReject(new Error(`Server failed to start${lastErr}`));
      }
    });
    serverProcess.once('error', (error) => {
      sendEvent({ type: 'log', source: 'server', tone: 'error', message: error.message });
      if (!settled) {
        finishReject(new Error(`Server failed to spawn: ${error.message}`));
      }
    });
  });
};

const createWindow = () => {
  const settings = readSettings();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0d1117',
    title: 'Hearth Control',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const devServer = process.env.VITE_DEV_SERVER_URL;
  if (devServer) mainWindow.loadURL(devServer); else mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));

  // Clear the stale reference once this exact window is destroyed, so later
  // code (second-instance, activate) never calls a method on a destroyed
  // BrowserWindow. Identity-checked (`mainWindow === window`) rather than an
  // unconditional `mainWindow = null`, so a 'closed' event from an OLDER
  // window (already superseded by a newer createWindow() call) can never
  // clobber a currently-live mainWindow reference.
  const window = mainWindow;
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
};

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});
app.whenReady().then(async () => {
  try {
    await initializeConnectionInfrastructure();
  } catch (err) {
    console.error('[Connections] Failed to initialize secure connection infrastructure:', err.message);
  }

  try {
    const { TaskStore } = await importFromHere('../mcp/executors/task-store.mjs');
    const { setTaskStore } = await importFromHere('../mcp/executors/antigravity.mjs');
    const tasksPath = path.join(app.getPath('userData'), 'tasks.json');
    taskStore = new TaskStore({ storagePath: tasksPath });
    taskStore.load();
    const { reconciledCount } = taskStore.reconcileStartupState();
    if (reconciledCount > 0) {
      console.info(`[TaskStore] Reconciled ${reconciledCount} interrupted task(s) to recovery_required.`);
    }
    setTaskStore(taskStore);
  } catch (err) {
    console.error('Failed to initialize TaskStore:', err);
  }

  try {
    const { InvestModeController, InvestModeFileStore } = await importFromHere('../mcp/market/invest-mode-controller.mjs');
    const investModePath = path.join(app.getPath('userData'), 'invest-mode.json');
    investModeController = new InvestModeController({
      store: new InvestModeFileStore({ storagePath: investModePath }),
    });
    const investModeState = investModeController.restore();
    console.info(`[InvestMode] Started in ${investModeState.mode}; restart mode is ${investModeState.startup_mode}.`);
  } catch (err) {
    investModeController = null;
    console.error('[InvestMode] Failed to initialize controller:', err?.message || err);
  }

  try {
    const { createMt5SocketBridge } = await importFromHere('../mcp/market/mt5-bridge-server.mjs');
    mt5BridgeServer = createMt5SocketBridge();
    const bridgeState = await mt5BridgeServer.start();
    console.info(
      `[MT5Bridge] Listening on http://${bridgeState.host}:${bridgeState.http_port} and TCP ${bridgeState.host}:${bridgeState.ingest_port}.`,
    );
  } catch (err) {
    mt5BridgeServer = null;
    console.error('[MT5Bridge] Failed to start local bridge:', err?.message || err);
  }

  try {
    const { InvestMonitor, InvestSignalJournal, InvestSignalJournalFileStore } = await importFromHere('../mcp/market/invest-monitor.mjs');
    const { runLiveXauInvestment } = await importFromHere('../mcp/market/live-runtime.mjs');
    investSignalJournal = new InvestSignalJournal({
      store: new InvestSignalJournalFileStore({ storagePath: path.join(app.getPath('userData'), 'invest-signals.json') }),
    });
    investSignalJournal.load();
    investMonitor = new InvestMonitor({
      getMode: () => investModeController?.getState?.() ?? { automatic_analysis_enabled: false },
      getPermission: () => readSettings().permissions?.MarketResearch ?? 'Ask',
      getBridgeStatus: () => mt5BridgeServer?.status?.() ?? { running: false, snapshots: [] },
      requestPermission: requestInvestMonitorPermission,
      runInvestment: ({ timeframe, signal }) => runLiveXauInvestment({ timeframe, signal }),
      journal: investSignalJournal,
      notify: notifyInvestSignal,
      onUpdate: sendInvestUpdate,
    });
    investMonitor.start();
  } catch (err) {
    investMonitor = null;
    investSignalJournal = null;
    console.error('[InvestMonitor] Failed to initialize:', err?.message || err);
  }

  try {
    const { JobManager, setJobManager } = await importFromHere('../mcp/runtime/job-manager.mjs');
    const {
      getAntigravityTask,
      getAuthoritativeAntigravityTask,
      resumeAntigravityTask,
      emitTaskTransition,
      createTaskContinuationRunner,
      reconcileDurableContinuations,
    } = await importFromHere('../mcp/executors/antigravity.mjs');
    const { getProductionAntigravityClaimStore } = await importFromHere('../mcp/executors/antigravity-admission.mjs');
    const jobsPath = path.join(app.getPath('userData'), 'jobs.json');
    jobManager = new JobManager({ storagePath: jobsPath });
    jobManager.load();
    const { reconciledCount } = jobManager.reconcileStartupState();
    if (reconciledCount > 0) {
      console.info(`[JobManager] Reconciled ${reconciledCount} interrupted job(s) to recovery_required.`);
    }
    setJobManager(jobManager);

    jobManager.setTaskResolver((taskId) => {
      return getAuthoritativeAntigravityTask(taskId);
    });

    jobManager.setTaskStoreSaver((task) => {
      if (taskStore) {
        try { taskStore.saveTask(task); } catch (err) { console.error('[TaskStore] Failed to save job evidence:', err); }
      }
      try { emitTaskTransition(task); } catch {}
    });

    const continuationRunner = createTaskContinuationRunner({
      jobManager,
      taskStore,
      getAntigravityTask,
      resumeAntigravityTask,
      emitTaskTransition,
      syncRemoteTaskState: async (opts) => {
        const { syncRemoteTaskState } = await importFromHere('../mcp/bridge/client.mjs');
        return syncRemoteTaskState(opts);
      },
      getBridgeClient: () => bridgeClientInstance,
      getBridgeState: () => bridgeState,
      sendEvent,
      monitorTaskTransition,
      claimStore: getProductionAntigravityClaimStore(),
    });
    jobManager.setContinuationRunner(continuationRunner);
    const reconcileContinuations = () => {
      void reconcileDurableContinuations({ taskStore, jobManager, continuationRunner })
        .catch((err) => console.error('[Continuation] Reconciliation failed:', err));
      void resyncGoalRequestStates();
    };
    reconcileContinuations();
    continuationRecoveryTimer = setInterval(reconcileContinuations, 30000);
  } catch (err) {
    console.error('Failed to initialize JobManager:', err);
  }

  try {
    const { GoalStorage } = await importFromHere('../mcp/goals/storage.mjs');
    const { GoalRunner } = await importFromHere('../mcp/goals/runner.mjs');
    const antigravityExecutor = await importFromHere('../mcp/executors/antigravity.mjs');
    const { getProductionAntigravityClaimStore } = await importFromHere('../mcp/executors/antigravity-admission.mjs');
    const goalsPath = path.join(app.getPath('userData'), 'goals.json');
    const goalStorage = new GoalStorage({ storagePath: goalsPath });
    goalRunner = new GoalRunner({ storage: goalStorage, antigravityExecutor, claimStore: getProductionAntigravityClaimStore() });
  } catch (err) {
    console.error('Failed to initialize GoalRunner:', err);
  }

  try {
    const { XQueueStore } = await importFromHere('../mcp/x/queue-store.mjs');
    const { XQueueCoordinator } = await importFromHere('../mcp/x/queue-coordinator.mjs');
    const { getProductionXRuntime, getNextXWakeupDeadline, getNextXQueueCapacityDeadline, reconcileXRuntimeNow } = await importFromHere('../mcp/x/production-runtime.mjs');
    const { parseXTask } = await importFromHere('../mcp/x/task-contract.mjs');
    xGetNextWakeupDeadline = getNextXWakeupDeadline;
    xGetQueueCapacityDeadline = getNextXQueueCapacityDeadline;
    xReconcileRuntimeNow = reconcileXRuntimeNow;
    xParseTask = parseXTask;
    const { onAntigravityAdmissionReleased } = await importFromHere('../mcp/executors/antigravity-admission.mjs');
    const queueStorePath = path.join(app.getPath('userData'), 'x-queue.json');
    xQueueStore = new XQueueStore({ storagePath: queueStorePath });
    xQueueStore.load();
    const { claimStore, runStore, modelAdapter, ownerId } = getProductionXRuntime();
    xRunStore = runStore;
    xQueueCoordinator = new XQueueCoordinator({
      queueStore: xQueueStore, claimStore, runStore, modelAdapter, ownerId,
      onAdmissionAccepted: () => armXWakeup(),
      onCapacityBlocked: () => armXQueueCapacityWakeup(),
    });
    // Slice 1D fix: wrap onXRunTerminal ONCE, centrally, so every genuine
    // terminal event -- however it was discovered (the coordinator's own
    // live dispatchNext().done.then() completion, the HTTP child's
    // x_run_terminal relay, wakeup-triggered reconciliation, or startup
    // reconciliation) -- also triggers the SAME Project-X remote-result
    // sync. This is required precisely because a LIVE task (local or
    // remote) actually completes via the coordinator's own internal
    // dispatchNext() completion path, which no external x_run_terminal
    // message ever reaches -- adding the sync call only inside the
    // serverProcess message relay (as before) silently never fired for
    // that common case. No X-core file is modified; onXRunTerminal's own
    // return value/contract is passed through unchanged to every caller.
    {
      const baseOnXRunTerminal = xQueueCoordinator.onXRunTerminal.bind(xQueueCoordinator);
      xQueueCoordinator.onXRunTerminal = (event) => {
        const handled = baseOnXRunTerminal(event);
        if (handled?.handled && xQueueStore && event?.runId) {
          const receipt = xQueueStore.findReceiptByRunId(event.runId);
          if (receipt) void syncTerminalReceiptToPublicTasks(receipt);
        }
        return handled;
      };
    }
    onAntigravityAdmissionReleased(() => {
      if (xQueueDispatchEnabled) xQueueCoordinator?.kick();
    });
    xQueueDispatchEnabled = !xQueueStore.recoveryRequired && xQueueWorkspaceMatches(readSettings().workspace);
    if (!xQueueDispatchEnabled) {
      console.error(`[Electron] X queue ${xQueueStore.recoveryRequired ? 'recovery required' : 'workspace mismatch'}; preserving entries without dispatch.`);
      xQueueCoordinator = null;
    }
    if (xQueueDispatchEnabled) {
    for (const entry of xQueueStore.listDispatched()) {
      try {
        xQueueCoordinator.onXRunTerminal({ runId: entry.runId });
      } catch (error) {
        console.error('[Electron] X startup queue reconciliation failed:', error);
      }
    }
    for (const entry of xQueueStore.listDispatching()) {
      try {
        xQueueCoordinator.reconcileDispatchingEntry(entry);
      } catch (error) {
        console.error('[Electron] X startup dispatching reconciliation failed:', error);
      }
    }
    xQueueCoordinator.kick();
    }
    armXWakeup();
  } catch (err) {
    console.error('Failed to initialize XQueueCoordinator:', err);
  }

  // Goal Runner -> X wiring (Phase 2 slice): reuses the SAME Electron-owned
  // X ingress (ingestXTask) and receipt-status helper (xQueueReceiptStatus)
  // the local x_enqueue transport and the Project X remote-approval path
  // already use -- no parseXTask/workspace-guard/fingerprint/admission/
  // queue-receipt logic is duplicated here. child:null + an always-true
  // waiter mirror approveRemotePublicXTask's own non-HTTP-transport call
  // shape (see above); the X permission Ask/Allow/Blocked gate inside
  // ingestXTask still applies unchanged, including a fresh user approval
  // prompt when permission is 'Ask'.
  if (goalRunner) {
    goalRunner.xExecutor = {
      dispatchXTask: async ({ requestId, task, action, goal, step }) => {
        // Goal-level bulk approval only ever applies -- and only ever needs
        // to be checked -- while the GLOBAL X permission is exactly 'Ask';
        // under 'Blocked' ingestXTask rejects unconditionally below, and
        // under 'Allow' it never asks in the first place, so skipping the
        // check entirely in both cases changes nothing observable while
        // avoiding a pointless goal/xTask lookup on every dispatch. `goal`
        // and `step` are GoalRunner's own LIVE, in-flight objects (not just
        // their ids) -- see resolveGoalXApproval's own doc comment for why
        // that distinction is what makes the approval actually stick.
        const permission = readSettings().permissions.X ?? 'Ask';
        const skipStepApproval = permission === 'Ask'
          ? await resolveGoalXApproval({ goal, step, task, action })
          : false;
        return ingestXTask({
          requestId, task, child: null,
          waiterId: requestId, waiterActive: () => true, isLive: () => true,
          action, skipStepApproval,
        });
      },
      getXTaskStatus: (requestId) => xQueueReceiptStatus(xQueueStore?.getReceipt(requestId)),
    };
  }

  ipcMain.handle('settings:get', () => publicSettingsSnapshot());
  ipcMain.handle('invest-mode:get', () => {
    if (!investModeController) throw new Error('invest_mode_controller_unavailable');
    return investModeController.getState();
  });
  ipcMain.handle('invest-mode:set', (_event, mode) => {
    if (!investModeController) throw new Error('invest_mode_controller_unavailable');
    const state = investModeController.setMode(mode);
    investMonitor?.syncMode?.();
    return state;
  });
  ipcMain.handle('invest-mode:kill-switch', () => {
    if (!investModeController) throw new Error('invest_mode_controller_unavailable');
    const state = investModeController.killSwitch();
    investMonitor?.syncMode?.();
    return state;
  });
  ipcMain.handle('invest-status:get', () => publicInvestStatus());
  const listPublicConnections = () => {
    if (!connectionService || !connectionRegistry) return [];
    return connectionRegistry.list().map((connection) => {
      if (connection.provider === 'github' && githubConnectionService) {
        return githubConnectionService.publicSnapshot(connection);
      }
      if (connection.provider === 'supabase' && supabaseProjectService) {
        return supabaseProjectService.publicSnapshot(connection.alias);
      }
      if (connection.provider === 'vercel' && vercelConnectionService) {
        return vercelConnectionService.publicSnapshot(connection);
      }
      return connectionService.toPublic(connection);
    });
  };
  ipcMain.handle('connections:list', () => listPublicConnections());
  ipcMain.handle('connections:refresh', async (_event, alias) => {
    if (!connectionService || !connectionRegistry) throw new Error('connection_service_unavailable');
    const refreshOne = async (connectionAlias) => {
      const connection = connectionRegistry.get(connectionAlias);
      if (!connection) throw new Error('connection_not_found');
      if (connection.provider === 'github') {
        if (!githubConnectionService) throw new Error('github_connection_service_unavailable');
        return githubConnectionService.refresh(connectionAlias);
      }
      if (connection.provider === 'supabase') {
        if (!supabaseProjectService) throw new Error('supabase_project_service_unavailable');
        return supabaseProjectService.refreshHealth(connectionAlias);
      }
      if (connection.provider === 'vercel') {
        if (!vercelConnectionService) throw new Error('vercel_connection_service_unavailable');
        return vercelConnectionService.refresh(connectionAlias);
      }
      return connectionService.refreshHealth(connectionAlias);
    };
    if (alias) return [await refreshOne(alias)];
    const results = [];
    for (const connection of connectionRegistry.list()) results.push(await refreshOne(connection.alias));
    return results;
  });
  ipcMain.handle('github:connect', async (_event, request) => {
    if (!githubConnectionService) throw new Error('github_connection_service_unavailable');
    if (!request || typeof request !== 'object') throw new Error('github_connect_request_invalid');
    const capabilities = ['repo.read', 'pull_request.read'];
    if (request.allowPullRequestCreate === true) capabilities.push('pull_request.create');
    return githubConnectionService.connect(request.alias, request.token, { capabilities });
  });
  ipcMain.handle('github:disconnect', (_event, alias) => {
    if (!githubConnectionService) throw new Error('github_connection_service_unavailable');
    return githubConnectionService.disconnect(alias);
  });
  ipcMain.handle('github:repositories', async (_event, alias) => {
    if (!githubConnectionService) throw new Error('github_connection_service_unavailable');
    return githubConnectionService.listRepositories(alias, { page: 1, perPage: 100 });
  });
  ipcMain.handle('github:set-default-repository', async (_event, request) => {
    if (!githubConnectionService) throw new Error('github_connection_service_unavailable');
    if (!request || typeof request !== 'object') throw new Error('github_repository_request_invalid');
    return githubConnectionService.setDefaultRepository(request.alias, request.fullName || null);
  });
  ipcMain.handle('vercel:connect', async (_event, request) => {
    if (!vercelConnectionService) throw new Error('vercel_connection_service_unavailable');
    if (!request || typeof request !== 'object') throw new Error('vercel_connect_request_invalid');
    return vercelConnectionService.connect(request.alias, request.token, { teamId: request.teamId || null });
  });
  ipcMain.handle('vercel:disconnect', (_event, alias) => {
    if (!vercelConnectionService) throw new Error('vercel_connection_service_unavailable');
    return vercelConnectionService.disconnect(alias);
  });
  ipcMain.handle('settings:save', async (_event, settings) => {
    settings = sanitizeRendererSettingsInput(settings);
    if (settings.workspace && settings.workspace !== readSettings().workspace && hasLiveXQueueEntries()) throw xQueueError('workspace_locked_by_x_queue');
    const { hasRunningTask } = await importFromHere('../mcp/executors/antigravity.mjs');
    if (settings.workspace && (goalRunner?.is_goal_active() || (hasRunningTask && hasRunningTask()))) {
      const current = readSettings();
      if (settings.workspace !== current.workspace) {
        throw new Error('Cannot change workspace while a goal or task is active or requires recovery');
      }
    }
    const saved = saveSettings(settings);
    if (serverProcess && settings.permissions) serverProcess.send({ type: 'settings:update', permissions: saved.permissions });
    if (settings.permissions) investMonitor?.syncMode?.();
    return saved;
  });
  ipcMain.handle('local-chat:status', async () => {
    const { createProviderSelection } = await importFromHere('../mcp/providers/selection.mjs');
    const selection = createProviderSelection();
    const local = selection.getProvider('local');
    if (!local.ok) return { health: local, models: local };
    const health = await local.adapter.health();
    const models = health.ok ? await local.adapter.listModels() : { ok: false, provider: 'ollama', error: health.error };
    return { health, models };
  });
  ipcMain.handle('local-chat:context', async (_event, request = {}) => {
    const { buildContextPreview } = await importFromHere('../mcp/context/builder.mjs');
    const settings = readSettings();
    return buildContextPreview({
      version: buildMetadata.version,
      buildId: buildMetadata.buildId,
      model: request.model || process.env.OLLAMA_MODEL || 'qwen3.5:9b-hermes',
      profile: request.profile || 'normal',
      longResponse: Boolean(request.longResponse),
      ollamaAvailable: typeof request.ollamaAvailable === 'boolean' ? request.ollamaAvailable : undefined,
      workspace: settings.workspace || null,
      projectName: settings.workspace ? path.basename(settings.workspace) : null,
      gitBranch: null,
      gitCommit: null,
      gitState: null,
    });
  });
  ipcMain.handle('storage-audit:scan', async (event) => {
    if (storageAuditWorker) return { ok: false, error: 'A storage scan is already running.' };
    const worker = new Worker(path.join(__dirname, 'storage-audit-worker.mjs'), {
      workerData: {
        home: app.getPath('home'),
        workspace: readSettings().workspace || null,
        hearthDataPath: app.getPath('userData'),
        hearthProjectPath: app.isPackaged ? null : path.join(__dirname, '..'),
      },
    });
    storageAuditWorker = worker;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (storageAuditWorker === worker) storageAuditWorker = null;
        worker.removeAllListeners();
        resolve(result);
      };
      worker.on('message', (message) => {
        if (message.type === 'progress') {
          if (!event.sender.isDestroyed()) event.sender.send('storage-audit:progress', message.progress);
        } else if (message.type === 'done') {
          storageAuditItems = new Map(message.result.items.map((item) => [item.id, item]));
          finish({ ok: true, ...message.result });
        } else if (message.type === 'error') finish({ ok: false, error: message.error });
      });
      worker.on('error', (error) => finish({ ok: false, error: error.message || 'Storage scan failed.' }));
      worker.on('exit', (code) => finish({ ok: false, error: `Storage scan ended unexpectedly (${code}).` }));
    });
  });
  ipcMain.handle('storage-audit:reveal', async (_event, id) => {
    const { revealAuditedItem } = await importFromHere('../mcp/storage/reveal.mjs');
    return revealAuditedItem({ id, items: storageAuditItems, reveal: (value) => shell.showItemInFolder(value) });
  });
  ipcMain.handle('local-chat:send', async (_event, request = {}) => {
    const settings = readSettings();
    const provider = request.provider === 'external' ? 'external' : request.provider === 'local' ? 'local' : request.provider;
    const messages = Array.isArray(request.messages) ? request.messages : [];
    if (!provider || messages.length === 0) {
      return { ok: false, provider: provider || null, error: { code: 'CONFIGURATION_ERROR', message: 'A provider and at least one message are required', status: null, retryable: false } };
    }

    const { createProviderSelection } = await importFromHere('../mcp/providers/selection.mjs');
    let externalProvider = null;
    if (provider === 'external') {
      externalProvider = {
        chat: async ({ messages: externalMessages }) => {
          const settings = readSettings();
          const permission = settings.permissions?.Antigravity ?? 'Ask';
          if (permission === 'Blocked') {
            return { ok: false, provider: 'external', error: { code: 'PERMISSION_BLOCKED', message: 'Antigravity permission is Blocked', status: null, retryable: false } };
          }
          if (permission !== 'Allow') {
            return { ok: false, provider: 'external', error: { code: 'PERMISSION_REQUIRED', message: 'Set Antigravity permission to Allow before using External Chat', status: null, retryable: false } };
          }
          if (!settings.workspace) {
            return { ok: false, provider: 'external', error: { code: 'CONFIGURATION_ERROR', message: 'No workspace configured for the external provider', status: null, retryable: false } };
          }
          const { startAntigravityTask } = await importFromHere('../mcp/executors/antigravity.mjs');
          const { getProductionAntigravityClaimStore } = await importFromHere('../mcp/executors/antigravity-admission.mjs');
          const prompt = externalMessages.map((message) => `${message.role || 'user'}: ${message.content || ''}`).join('\n');
          const result = await startAntigravityTask({
            workspace: settings.workspace,
            prompt,
            title: 'Local Chat · External Provider',
            userApproved: true,
            awaitCompletion: true,
            source: 'local',
            metadata: { experimentalLocalChat: true },
            claimStore: getProductionAntigravityClaimStore(),
          });
          const completion = result.completion;
          if (!completion || completion.status !== 'completed') {
            return { ok: false, provider: 'external', error: { code: completion?.status === 'waiting' ? 'WAITING' : 'PROVIDER_ERROR', message: completion?.summary || 'External provider did not complete', status: null, retryable: completion?.status === 'waiting' } };
          }
          return { ok: true, provider: 'external', response: completion.summary || '', done: true };
        },
      };
    }

    const selection = createProviderSelection({
      externalProvider,
      localProviderOptions: provider === 'local' ? { model: request.model, profile: request.profile } : undefined,
    });
    const { createLocalChatCaller } = await importFromHere('../mcp/providers/local-chat.mjs');
    const caller = createLocalChatCaller({ selection });
    const gateway = provider === 'local' && settings.workspace ? createReadOnlyToolGateway({ workspace: settings.workspace, maxToolSteps: 6 }) : null;
    const startedAt = Date.now();
    const result = await caller.send({
      provider,
      messages,
      ...(provider === 'local' ? {
        model: request.model,
        profile: request.profile,
        options: request.options,
        think: request.think,
        num_ctx: request.num_ctx,
        num_predict: request.num_predict,
        temperature: request.temperature,
        longResponse: request.longResponse,
        timeoutMs: request.timeoutMs,
        version: buildMetadata.version,
        buildId: buildMetadata.buildId,
        ollamaAvailable: request.ollamaAvailable,
        workspace: settings.workspace || null,
        projectName: settings.workspace ? path.basename(settings.workspace) : null,
        gitBranch: null,
        gitCommit: null,
        gitState: null,
        gateway,
        localEndpoint: selection.localProvider?.baseUrl,
      } : {}),
    });
    return { ...result, elapsedMs: Date.now() - startedAt };
  });
  ipcMain.on('local-chat:stream-start', async (event, { requestId, ...request } = {}) => {
    const settings = readSettings();
    if (!requestId || request.provider !== 'local') {
      event.sender.send('local-chat:stream-error', { requestId, result: { ok: false, provider: request.provider || null, error: { code: 'CONFIGURATION_ERROR', message: 'Streaming is available for explicit Local provider requests only', status: null, retryable: false } } });
      return;
    }
    const prior = localChatStreams.get(requestId);
    if (prior) prior.abort();
    const controller = new AbortController();
    localChatStreams.set(requestId, controller);
    const onSenderDestroyed = () => controller.abort();
    event.sender.once('destroyed', onSenderDestroyed);
    const startedAt = Date.now();
    try {
      const { createProviderSelection } = await importFromHere('../mcp/providers/selection.mjs');
      const { createLocalChatCaller } = await importFromHere('../mcp/providers/local-chat.mjs');
      const { createReadOnlyToolGateway } = await importFromHere('../mcp/skills/gateway.mjs');
      const { createTestRunner } = await importFromHere('../mcp/skills/test-runner.mjs');
      const selection = createProviderSelection({ localProviderOptions: { model: request.model, profile: request.profile } });
      const caller = createLocalChatCaller({ selection });
      const gateway = settings.workspace ? createReadOnlyToolGateway({ workspace: settings.workspace, maxToolSteps: 6 }) : null;
      if (settings.workspace && (!localChatTestRunner || localChatTestRunner.workspace !== settings.workspace && !localChatTestRunner.active)) localChatTestRunner = createTestRunner({ workspace: settings.workspace });
      const testRunner = settings.workspace && localChatTestRunner?.workspace === settings.workspace ? localChatTestRunner : null;
      const result = await caller.stream({
        provider: 'local',
        messages: request.messages,
        model: request.model,
        profile: request.profile,
        longResponse: request.longResponse,
        options: request.options,
        think: request.think,
        num_ctx: request.num_ctx,
        num_predict: request.num_predict,
        temperature: request.temperature,
        timeoutMs: request.timeoutMs,
        version: buildMetadata.version,
        buildId: buildMetadata.buildId,
        ollamaAvailable: request.ollamaAvailable,
        workspace: settings.workspace || null,
        projectName: settings.workspace ? path.basename(settings.workspace) : null,
        gitBranch: null,
        gitCommit: null,
        gitState: null,
        gateway,
        testRunner,
        approveTest: (selected) => new Promise((resolve) => {
          if (controller.signal.aborted || localChatStreams.get(requestId) !== controller || event.sender.isDestroyed()) return resolve(false);
          const priorApproval = localChatTestApprovals.get(requestId);
          if (priorApproval) priorApproval.respond(false);
          const onAbort = () => respond(false);
          const respond = (approved) => {
            if (localChatTestApprovals.get(requestId)?.respond === respond) localChatTestApprovals.delete(requestId);
            controller.signal.removeEventListener('abort', onAbort);
            resolve(Boolean(approved) && !controller.signal.aborted);
          };
          localChatTestApprovals.set(requestId, { sender: event.sender, controller, respond });
          controller.signal.addEventListener('abort', onAbort, { once: true });
          if (controller.signal.aborted) respond(false);
        }),
        localEndpoint: selection.localProvider?.baseUrl,
        signal: controller.signal,
        onChunk: async (content) => {
          if (localChatStreams.get(requestId) !== controller || event.sender.isDestroyed()) return;
          event.sender.send('local-chat:stream-chunk', { requestId, content });
        },
        onActivity: async (activity) => {
          if (localChatStreams.get(requestId) !== controller || event.sender.isDestroyed()) return;
          event.sender.send('local-chat:stream-activity', { requestId, activity });
        },
      });
      if (event.sender.isDestroyed()) return;
      event.sender.send('local-chat:stream-done', { requestId, result: { ...result, elapsedMs: Date.now() - startedAt } });
    } catch (error) {
      if (!event.sender.isDestroyed()) event.sender.send('local-chat:stream-error', { requestId, result: { ok: false, provider: 'ollama', error: { code: 'PROVIDER_ERROR', message: error?.message || 'Provider stream failed', status: null, retryable: false } } });
    } finally {
      event.sender.removeListener('destroyed', onSenderDestroyed);
      if (localChatTestApprovals.get(requestId)?.controller === controller) localChatTestApprovals.get(requestId)?.respond(false);
      if (localChatStreams.get(requestId) === controller) localChatStreams.delete(requestId);
    }
  });
  ipcMain.on('local-chat:test-approval-response', (event, { requestId, approved } = {}) => {
    const pending = localChatTestApprovals.get(requestId);
    if (pending?.sender === event.sender && typeof approved === 'boolean') pending.respond(approved);
  });
  ipcMain.on('local-chat:stream-stop', (_event, requestId) => {
    const controller = localChatStreams.get(requestId);
    if (controller) controller.abort();
  });
  ipcMain.handle('workspace:choose', async () => {
    if (hasLiveXQueueEntries()) throw xQueueError('workspace_locked_by_x_queue');
    const { hasRunningTask } = await importFromHere('../mcp/executors/antigravity.mjs');
    if (goalRunner?.is_goal_active() || (hasRunningTask && hasRunningTask())) {
      throw new Error('Cannot change workspace while a goal or task is active or requires recovery');
    }
    const result = await dialog.showOpenDialog(mainWindow, { title: 'Choose a workspace', properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    saveSettings({ workspace: result.filePaths[0] });
    return result.filePaths[0];
  });
  ipcMain.handle('goals:list', async () => {
    return goalRunner ? goalRunner.list_goals() : [];
  });
  ipcMain.handle('specialists:codex-status', async () => {
    try {
      const { resolveCodexBinary } = await importFromHere('../mcp/specialist/codex-adapter.mjs');
      await resolveCodexBinary();
      return { available: true };
    } catch {
      return { available: false };
    }
  });
  ipcMain.handle('goals:clear-history', async () => {
    if (!goalRunner) throw new Error('Goal runner not initialized');
    const result = goalRunner.clear_goal_history();
    sendEvent({ type: 'log', source: 'goals', tone: 'success', message: `Cleared ${result.removedIds.length} terminal Goal(s) from local history` });
    return result;
  });
  ipcMain.handle('goals:get', async (_event, goalId) => {
    if (!goalRunner) throw new Error('Goal runner not initialized');
    return goalRunner.get_goal(goalId);
  });
  ipcMain.handle('goals:create', async (_event, data) => {
    if (!goalRunner) throw new Error('Goal runner not initialized');
    const settings = readSettings();
    const workspace = data.workspace || settings.workspace;
    if (!workspace) throw new Error('Workspace is required to create a goal');
    const goal = await goalRunner.create_goal({ ...data, workspace });
    sendEvent({ type: 'goals:updated', goal });
    return goal;
  });
  ipcMain.handle('goals:run', async (_event, goalId) => {
    if (!goalRunner) throw new Error('Goal runner not initialized');
    const settings = readSettings();
    const onProgress = (goal) => {
      sendEvent({ type: 'goals:updated', goal });
    };
    return goalRunner.run_goal(goalId, {
      permissions: settings.permissions,
      onProgress,
    });
  });
  ipcMain.handle('goals:pause', async (_event, goalId) => {
    if (!goalRunner) throw new Error('Goal runner not initialized');
    const goal = await goalRunner.pause_goal(goalId);
    sendEvent({ type: 'goals:updated', goal });
    return goal;
  });
  ipcMain.handle('goals:resume', async (_event, goalId) => {
    if (!goalRunner) throw new Error('Goal runner not initialized');
    const settings = readSettings();
    const onProgress = (goal) => {
      sendEvent({ type: 'goals:updated', goal });
    };
    return goalRunner.resume_goal(goalId, {
      permissions: settings.permissions,
      onProgress,
    });
  });
  ipcMain.handle('goals:signoff-step', async (_event, { goalId, stepId, action, note, autoRun }) => {
    if (!goalRunner) throw new Error('Goal runner not initialized');
    const settings = readSettings();
    const onProgress = (goal) => {
      sendEvent({ type: 'goals:updated', goal });
    };
    const goal = await goalRunner.signoff_step(goalId, stepId, {
      action,
      note,
      autoRun,
      permissions: settings.permissions,
      onProgress,
    });
    sendEvent({ type: 'goals:updated', goal });
    return goal;
  });
  ipcMain.handle('goals:review-acknowledge', async (_event, { goalId, reviewItemId, actor, note }) => {
    if (!goalRunner) throw new Error('Goal runner not initialized');
    const result = await goalRunner.acknowledge_review(goalId, reviewItemId, { actor, note });
    sendEvent({ type: 'goals:updated', goal: result.goal });
    return result;
  });
  ipcMain.handle('goals:review-resolve', async (_event, { goalId, reviewItemId, action, note }) => {
    if (!goalRunner) throw new Error('Goal runner not initialized');
    const result = await goalRunner.resolve_review(goalId, reviewItemId, { action, note });
    sendEvent({ type: 'goals:updated', goal: result.goal });
    return result;
  });
  ipcMain.handle('goals:is-active', async () => {
    return goalRunner ? goalRunner.is_goal_active() : false;
  });
  ipcMain.handle('server:get-state', async () => {
    if (serverProcess) return serverState;
    const probe = await probeHearthServer(serverState.port);
    if (probe.running) {
      serverState = { running: true, port: serverState.port, pid: probe.pid };
    } else if (serverState.running && !probe.running) {
      serverState = { running: false, port: serverState.port, pid: null };
    }
    return serverState;
  });
  ipcMain.handle('server:start', (_event, options) => startServer(options));
  ipcMain.handle('server:stop', () => stopServer());
  ipcMain.handle('server:respond-approval', (_event, response) => {
    if (pendingXApprovals.has(response.requestId)) {
      localApprovals.get(response.requestId)?.(response.allowed === true);
      return true;
    }
    if (localApprovals.has(response.requestId)) {
      localApprovals.get(response.requestId)(response.allowed === true);
    }
    if (serverProcess) {
      serverProcess.send({ type: 'approval:result', requestId: response.requestId, allowed: response.allowed === true });
    }
    return true;
  });
  ipcMain.handle('workspace:validate', async (_event, workspacePath) => {
    if (!workspacePath || typeof workspacePath !== 'string') return { valid: false, reason: 'not_configured' };
    try {
      await fs.promises.access(workspacePath, fs.constants.R_OK);
      const stat = await fs.promises.stat(workspacePath);
      if (!stat.isDirectory()) return { valid: false, reason: 'not_a_directory' };
      return { valid: true };
    } catch { return { valid: false, reason: 'not_accessible' }; }
  });
  // The only install entry point is this local renderer IPC handler. The bridge
  // has no updater IPC or service reference, so remote tasks cannot install apps.
  ipcMain.handle('updater:get-info', () => getUpdaterInfo());
  ipcMain.handle('updater:check', async (event) => {
    if (!mainWindow || event.sender.id !== mainWindow.webContents.id) throw new Error('Update checks must come from the local Hearth window.');
    const info = getUpdaterInfo();
    try {
      const checked = await remoteUpdateState.checkRemoteUpdate({
        currentSession: remoteUpdateSession,
        info,
        remoteOptions: remoteUpdateOptions(),
      });
      remoteUpdateSession = checked.session;
      return checked.result;
    } catch (error) {
      updaterDebug('check_failed', error?.message);
      remoteUpdateSession = null;
      return { state: localUpdater.UPDATE_STATES.ERROR, currentVersion: info.currentVersion, currentBuildId: info.currentBuildId, available: null, error: safeRemoteUpdateError(error) };
    }
  });
  ipcMain.handle('updater:prepare', async (event) => {
    if (!mainWindow || event.sender.id !== mainWindow.webContents.id) throw new Error('Update preparation must come from the local Hearth window.');
    const info = getUpdaterInfo();
    const expectedBuildId = remoteUpdateSession?.state === 'update_available' ? remoteUpdateSession.manifest?.buildId : null;
    if (!expectedBuildId) {
      updaterDebug(
        'prepare_rejected',
        `session_state=${remoteUpdateSession?.state ?? 'none'}`,
      );
      throw new Error('Check for a remote update before preparing it.');
    }
    let phase = 'fetch';
    try {
      remoteUpdateSession = { ...remoteUpdateSession, state: 'downloading' };
      const fetched = await remoteUpdater.fetchAndVerifyUpdate({
        ...remoteUpdateOptions(),
        currentVersion: info.currentVersion,
        currentBuiltAt: info.builtAt,
        isPackaged: info.isPackaged,
      });
      updaterDebug(
        'fetch_ok',
        `build=${fetched.manifest?.buildId ?? 'none'} available=${fetched.updateAvailable}`,
      );
      if (!fetched.updateAvailable) {
        updaterDebug('fetch_not_newer', fetched.reason ?? '');
        remoteUpdateSession = null;
        return { state: localUpdater.UPDATE_STATES.UP_TO_DATE, currentVersion: info.currentVersion, currentBuildId: info.currentBuildId, available: null, error: null };
      }
      if (fetched.manifest.buildId !== expectedBuildId) {
        updaterDebug(
          'release_changed',
          `expected=${expectedBuildId} actual=${fetched.manifest.buildId}`,
        );
        remoteUpdateSession = null;
        return { state: localUpdater.UPDATE_STATES.ERROR, currentVersion: info.currentVersion, currentBuildId: info.currentBuildId, available: null, error: 'The published release changed. Check for updates again.' };
      }
      remoteUpdateSession = { state: 'verifying', manifest: fetched.manifest };
      phase = 'stage';
      const staged = await remoteUpdateStager.stageVerifiedUpdate({
        manifest: fetched.manifest,
        dmgPath: fetched.dmgPath,
      });
      updaterDebug('stage_ok', fetched.manifest.buildId);
      phase = 'local_validate';
      const check = await inspectLocalUpdateDirectory(staged.stagedDir, info);
      updaterDebug(
        'local_compare',
        `manifest=${fetched.manifest.version}@${fetched.manifest.builtAt} current=${info.currentVersion}@${info.builtAt}`,
      );
      updaterDebug(
        'local_validate_state',
        `${check.state} ${check.error || ''}`,
      );
      if (check.state !== localUpdater.UPDATE_STATES.UPDATE_READY) {
        throw new Error(check.error || 'The staged update did not pass local updater validation.');
      }
      remoteUpdateSession = {
        state: localUpdater.UPDATE_STATES.UPDATE_READY,
        manifest: fetched.manifest,
        stagedDir: staged.stagedDir,
      };
      updaterDebug('update_ready', fetched.manifest.buildId);
      return check;
    } catch (error) {
      updaterDebug(
        `prepare_failed@${phase}`,
        error?.message,
      );
      remoteUpdateSession = null;
      return { state: localUpdater.UPDATE_STATES.ERROR, currentVersion: info.currentVersion, currentBuildId: info.currentBuildId, available: null, error: safeRemoteUpdateError(error) };
    }
  });
  ipcMain.handle('updater:check-local', async (event) => {
    if (!mainWindow || event.sender.id !== mainWindow.webContents.id) throw new Error('Local update checks must come from the local Hearth window.');
    remoteUpdateSession = null;
    const info = getUpdaterInfo();
    return inspectLocalUpdateDirectory(info.updateDirectory, info);
  });
  ipcMain.handle('updater:choose-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: 'Choose trusted update folder', properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return getUpdaterInfo();
    remoteUpdateSession = null;
    saveSettings({ updateDirectory: result.filePaths[0] });
    return getUpdaterInfo();
  });
  ipcMain.handle('updater:install', async (event) => {
    if (!mainWindow || event.sender.id !== mainWindow.webContents.id) throw new Error('Install requests must come from the local Hearth window.');
    const info = getUpdaterInfo();
    const installUpdateDirectory = getInstallUpdateDirectory();
    const check = await inspectLocalUpdateDirectory(installUpdateDirectory, info);
    if (check.state !== localUpdater.UPDATE_STATES.UPDATE_READY) throw new Error(check.error || 'No verified update is ready to install.');

    const initialBlocker = getUpdaterRuntimeBlocker();
    if (initialBlocker) return localUpdater.blockedUpdateResult(initialBlocker);

    // This process-local lock is acquired synchronously after the canonical
    // runtime checks, before the first approval await, so a concurrent IPC
    // attempt observes UPDATER_BUSY instead of racing a second install.
    updaterInstallInProgress = true;
    let installCommitted = false;
    try {
      const approval = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        buttons: ['Update & Restart', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        title: 'Install Hearth Control Update',
        message: `Install Hearth Control ${check.available?.version || 'update'}?`,
        detail: 'The current app will be backed up and Hearth will restart.',
      });
      if (approval.response !== 0) {
        return { state: localUpdater.UPDATE_STATES.UPDATE_READY, cancelled: true };
      }

      const manifest = await localUpdater.readAndValidateManifest(installUpdateDirectory, process.platform, process.arch);

      // Approval can remain open while runtime state changes. Recheck the
      // canonical sources after approval/revalidation, ignoring only this
      // handler's own updater lock.
      const lateBlocker = getUpdaterRuntimeBlocker({ ignoreUpdaterBusy: true });
      if (lateBlocker) return localUpdater.blockedUpdateResult(lateBlocker);

      const install = await localUpdater.installUpdate({
        manifest,
        currentVersion: info.currentVersion,
        currentBuiltAt: info.builtAt,
        isPackaged: info.isPackaged,
        applicationsDirectory: '/Applications',
        userDataPath: app.getPath('userData'),
        launchRollbackHelper: startRollbackWatchdog,
        // The main process sets this only after its own native confirmation
        // and runtime preflight. No renderer payload, remote task, Goal, X
        // run, or MCP request can supply or bypass either gate.
        userApproved: true,
      });
      // The installed app has now been replaced and rollback/restart state is
      // armed. Keep the process-local updater lock held until this process exits.
      installCommitted = true;
      app.relaunch({ args: process.argv.slice(1) });
      setImmediate(() => app.exit(0));
      return install;
    } finally {
      if (!installCommitted) updaterInstallInProgress = false;
    }
  });
  ipcMain.handle('antigravity:status', async () => {
    const { detectAntigravity } = await importFromHere('../mcp/executors/antigravity.mjs');
    return detectAntigravity();
  });
  ipcMain.handle('antigravity:start', async (_event, { prompt, title }) => {
    if (isStartingTask) {
      throw new Error('Another task is already starting. Please wait.');
    }
    const { startAntigravityTask, hasRunningTask } = await importFromHere('../mcp/executors/antigravity.mjs');
    const { getProductionAntigravityClaimStore } = await importFromHere('../mcp/executors/antigravity-admission.mjs');
    if (hasRunningTask && hasRunningTask()) {
      throw new Error('A task is already running. Please wait for it to complete or pause.');
    }

    isStartingTask = true;
    try {
      const settings = readSettings();
      const currentWorkspace = settings.workspace;
      if (!currentWorkspace) {
        throw new Error('No workspace configured. Please select a workspace first.');
      }

      const permission = settings.permissions?.Antigravity ?? 'Ask';
      if (permission === 'Blocked') {
        throw new Error('Antigravity permission is Blocked. Change it to Allow or Ask in Permissions settings.');
      }
      if (permission === 'Ask') {
        const approvalResult = await new Promise((resolve) => {
          const requestId = crypto.randomUUID();
          const timer = setTimeout(() => {
            localApprovals.delete(requestId);
            resolve({ allowed: false, reason: 'Approval request timed out.' });
          }, 60000);
          localApprovals.set(requestId, (ans) => {
            clearTimeout(timer);
            localApprovals.delete(requestId);
            resolve({
              allowed: ans === true,
              reason: ans === true ? null : 'User denied Antigravity access for this request.',
            });
          });
          sendEvent({
            type: 'approval',
            requestId,
            permission: 'Antigravity',
            action: `Start Antigravity task: ${title || (prompt || '').slice(0, 60)}`,
          });
        });
        if (!approvalResult.allowed) {
          throw new Error(approvalResult.reason || 'User denied Antigravity access for this request.');
        }
      }

      const result = await startAntigravityTask({
        workspace: currentWorkspace,
        prompt,
        title,
        userApproved: true,
        awaitCompletion: false,
        claimStore: getProductionAntigravityClaimStore(),
      });
      void monitorTaskTransition(result.taskId);
      return result;
    } finally {
      isStartingTask = false;
    }
  });
  ipcMain.handle('antigravity:task', async (_event, taskId) => {
    const { getAntigravityTask } = await importFromHere('../mcp/executors/antigravity.mjs');
    return getAntigravityTask(taskId);
  });
  ipcMain.handle('antigravity:send', async (_event, { taskId, message }) => {
    const settings = readSettings();
    const permission = settings.permissions?.Antigravity ?? 'Ask';
    if (permission === 'Blocked') {
      throw new Error('Antigravity permission is Blocked. Change it to Allow or Ask in Permissions settings.');
    }
    if (permission === 'Ask') {
      const allowed = await new Promise((resolve) => {
        const requestId = crypto.randomUUID();
        const timer = setTimeout(() => { localApprovals.delete(requestId); resolve(false); }, 60000);
        localApprovals.set(requestId, (ans) => { clearTimeout(timer); localApprovals.delete(requestId); resolve(ans); });
        sendEvent({ type: 'approval', requestId, permission: 'Antigravity', action: `Send follow-up message to task ${taskId}` });
      });
      if (!allowed) {
        throw new Error('User denied Antigravity access for this request.');
      }
    }

    const { sendAntigravityMessage, getAntigravityTask } = await importFromHere('../mcp/executors/antigravity.mjs');
    const res = await sendAntigravityMessage({ taskId, message });
    const taskObj = getAntigravityTask(taskId) || res;
    if (taskObj.source === 'remote' && taskObj.remoteTaskId) {
      bridgeState.activeRemoteTaskId = taskObj.remoteTaskId;
      sendEvent({ type: 'bridge:state', state: bridgeState });
      const { syncRemoteTaskState } = await importFromHere('../mcp/bridge/client.mjs');
      await syncRemoteTaskState({
        bridgeClient: bridgeClientInstance,
        taskStore,
        task: taskObj,
        overrides: { status: 'running' },
      });
    }
    void monitorTaskTransition(taskId);
    return res;
  });
  ipcMain.handle('antigravity:resume', async (_event, taskId) => {
    const { resumeAntigravityTask, getAntigravityTask } = await importFromHere('../mcp/executors/antigravity.mjs');
    const { getProductionAntigravityClaimStore } = await importFromHere('../mcp/executors/antigravity-admission.mjs');
    const res = await resumeAntigravityTask({ taskId, claimStore: getProductionAntigravityClaimStore() });
    const taskObj = getAntigravityTask(res.taskId) || res;
    if (taskObj.source === 'remote' && taskObj.remoteTaskId) {
      bridgeState.activeRemoteTaskId = taskObj.remoteTaskId;
      sendEvent({ type: 'bridge:state', state: bridgeState });
      const { syncRemoteTaskState } = await importFromHere('../mcp/bridge/client.mjs');
      await syncRemoteTaskState({
        bridgeClient: bridgeClientInstance,
        taskStore,
        task: taskObj,
        overrides: { status: 'running' },
      });
    }
    void monitorTaskTransition(res.taskId);
    return res;
  });
  ipcMain.handle('antigravity:mark-failed', async (_event, { taskId, reason }) => {
    const { markTaskFailed } = await importFromHere('../mcp/executors/antigravity.mjs');
    const task = markTaskFailed({ taskId, reason });
    if (bridgeState.activeRemoteTaskId === taskId || (task && task.remoteTaskId && bridgeState.activeRemoteTaskId === task.remoteTaskId)) {
      bridgeState.activeRemoteTaskId = null;
      sendEvent({ type: 'bridge:state', state: bridgeState });
    }
    if (task.source === 'remote' && task.remoteTaskId) {
      const { syncRemoteTaskState } = await importFromHere('../mcp/bridge/client.mjs');
      await syncRemoteTaskState({
        bridgeClient: bridgeClientInstance,
        taskStore,
        task,
        overrides: { status: 'error', error: task.error },
      });
    }
    return task;
  });
  ipcMain.handle('antigravity:dismiss', async (_event, taskId) => {
    const { dismissRecoveryTask } = await importFromHere('../mcp/executors/antigravity.mjs');
    const task = dismissRecoveryTask({ taskId });
    if (bridgeState.activeRemoteTaskId === taskId || (task && task.remoteTaskId && bridgeState.activeRemoteTaskId === task.remoteTaskId)) {
      bridgeState.activeRemoteTaskId = null;
      sendEvent({ type: 'bridge:state', state: bridgeState });
    }
    return task;
  });
  ipcMain.handle('antigravity:list-tasks', async () => {
    if (!taskStore) return [];
    return taskStore.listTasks();
  });

  // Bridge Initialization & Handlers
  try {
    const { getOrCreateDeviceId, generatePairingSecret } = await importFromHere('../mcp/bridge/identity.mjs');
    const { HearthBridgeClient } = await importFromHere('../mcp/bridge/client.mjs');
    const { PublicTasksClient } = await importFromHere('../mcp/bridge/public-tasks-client.mjs');
    const { ReviewItemsClient, resyncPendingReviewItems, syncReviewItemToRemote } = await importFromHere('../mcp/bridge/review-queue-sync.mjs');
    const { GoalRequestsClient } = await importFromHere('../mcp/bridge/goal-requests-client.mjs');
    const settings = readSettings();
    if (!supabaseProjectService) throw new Error('supabase_project_service_unavailable');
    const hearthProject = supabaseProjectService.getProjectConfig(BRIDGE_CONNECTION_ALIAS, { requirePublishableKey: false });
    const xgenProject = supabaseProjectService.getProjectConfig(PUBLIC_TASKS_CONNECTION_ALIAS, { requirePublishableKey: false });
    loadBridgeSecrets();
    loadPublicTasksSecrets();
    const deviceId = getOrCreateDeviceId(app.getPath('userData'));
    bridgeState.deviceId = deviceId;
    bridgeState.enabled = Boolean(settings.bridgeEnabled);
    bridgeState.configured = Boolean(hearthProject.url && hearthProject.publishableKey);
    bridgeState.signedIn = Boolean(bridgeSession?.accessToken && bridgeSession?.ownerId);
    bridgeState.accountEmail = bridgeSession?.email || null;
    bridgeState.pairingReady = Boolean(bridgePairingSecret);

    bridgeClientInstance = new HearthBridgeClient({
      deviceId,
      supabaseUrl: hearthProject.url || '',
      supabaseAnonKey: hearthProject.publishableKey || '',
      pollIntervalMs: 5000,
    });
    bridgeClientInstance.setSession({
      accessToken: bridgeSession?.accessToken || null,
      ownerId: bridgeSession?.ownerId || null,
    });
    bridgeClientInstance.enabled = bridgeState.enabled && bridgeState.signedIn;

    // Project X's OWN client, deliberately never sharing bridgeSession's JWT
    // (a different Supabase project). With no sign-in flow yet wired to it,
    // publicTasksSession stays null and this client simply reports
    // not-ready -- syncPublicXTasks/bridge:approve-task below fail closed
    // (skip / throw a clear error) rather than ever guessing credentials.
    publicTasksClientInstance = new PublicTasksClient({
      supabaseUrl: xgenProject.url || '',
      supabaseAnonKey: xgenProject.publishableKey || '',
    });
    publicTasksClientInstance.setSession({
      accessToken: publicTasksSession?.accessToken || null,
      ownerId: publicTasksSession?.ownerId || null,
    });
    const publicTasksReady = () => Boolean(
      publicTasksClientInstance.supabaseUrl && publicTasksClientInstance.accessToken && publicTasksClientInstance.ownerId,
    );
    // Same best-effort refresh syncPublicXTasks already does before its own
    // Project X calls (a stored access token can simply have aged past its
    // ~1hr expiry between a sign-in and a later sync attempt) -- reuses the
    // existing ensurePublicTasksSession() unchanged; a refresh success
    // already mirrors onto reviewItemsClientInstance via
    // applyPublicTasksSession. Never throws: a failed refresh just leaves
    // the (possibly still-stale) token in place, and the sync call that
    // follows fails and retries later exactly as it already does today.


    // Shares Project X's SAME session -- same Supabase project, same
    // authenticated owner, a different table. Never itself authenticates;
    // applyPublicTasksSession/sign-out above keep it mirrored to
    // publicTasksSession wherever that session changes (sign-in/sign-out);
    // this constructor call only covers the initial value at startup.
    reviewItemsClientInstance = new ReviewItemsClient({
      supabaseUrl: xgenProject.url || '',
      supabaseAnonKey: xgenProject.publishableKey || '',
    });
    reviewItemsClientInstance.setSession({
      accessToken: publicTasksSession?.accessToken || null,
      ownerId: publicTasksSession?.ownerId || null,
    });
    // Same session-sharing pattern as reviewItemsClientInstance above; see
    // goalRequestsClientInstance's own declaration comment.
    goalRequestsClientInstance = new GoalRequestsClient({
      supabaseUrl: xgenProject.url || '',
      supabaseAnonKey: xgenProject.publishableKey || '',
    });
    goalRequestsClientInstance.setSession({
      accessToken: publicTasksSession?.accessToken || null,
      ownerId: publicTasksSession?.ownerId || null,
    });
    // The ONLY wiring between GoalRunner and any remote/network concern --
    // GoalRunner itself only ever calls this as an opaque, fire-and-forget
    // notification (see onReviewItemPersisted's own doc comment in
    // mcp/goals/runner.mjs); it is never awaited, its return value is never
    // inspected, and nothing it does can affect Goal/Review Queue state,
    // X dispatch, or continuation.
    if (goalRunner) {
      goalRunner.onReviewItemPersisted = (item, goal) => {
        void (async () => {
          await refreshPublicTasksSessionBestEffort();
          await syncReviewItemToRemote({ client: reviewItemsClientInstance, item, goalId: goal.id, goalTitle: goal.title });
          await resyncGoalRequestStates();
        })();
      };
      goalRunner.onGoalPersisted = (goal) => {
        void (async () => {
          await refreshPublicTasksSessionBestEffort();
          await resyncGoalRequestStates();
        })();
      };
    }

    // A restored session at startup is itself a reconnect (the whole point
    // of persisting it via safeStorage is to avoid a fresh sign-in) -- retry
    // syncing any already-terminal local X truth now, exactly as sign-in
    // already does. Read-only/PATCH-by-id and idempotent; never reruns X,
    // never creates a queue entry, never mutates X queue/run state.
    if (publicTasksReady()) {
      void resyncTerminalPublicXTasks();
      // Same reconnect trigger, same idempotent-upsert safety, for the
      // Review Queue remote projection -- a pure read of local state
      // (goalRunner.list_review_queue()) followed by best-effort writes;
      // never mutates Goal/Review Queue local state, never throws. A
      // restored session can be stale (see refreshPublicTasksSessionBestEffort),
      // so refresh first.
      void refreshPublicTasksSessionBestEffort().then(() => resyncPendingReviewItems({ client: reviewItemsClientInstance, goalRunner }));
      // Same reconnect trigger for remote Goal state projection -- read-only
      // against goals.json, best-effort idempotent writes, never re-imports
      // or re-runs anything.
      void refreshPublicTasksSessionBestEffort().then(() => resyncGoalRequestStates());
      // And for finishing any import that was already authorized (claimed)
      // but got interrupted before completing -- never claims anything new.
      void refreshPublicTasksSessionBestEffort().then(() => recoverUnimportedGoalRequests());
    }

    const registerBridgeDevice = async () => {
      const session = await ensureBridgeSession();
      if (!bridgePairingSecret) {
        const pairing = generatePairingSecret();
        bridgePairingSecret = pairing.secret;
        if (!credentialStore) throw new Error('credential_store_unavailable');
        credentialStore.setSecret(BRIDGE_PAIRING_CREDENTIAL_REF, { secret: pairing.secret });
      }
      const { hashPairingSecret } = await importFromHere('../mcp/bridge/identity.mjs');
      const currentSettings = readSettings();
      const hearthProjectConfig = supabaseProjectService.getProjectConfig(BRIDGE_CONNECTION_ALIAS);
      const response = await fetch(`${hearthProjectConfig.url}/rest/v1/hearth_devices?on_conflict=device_id`, {
        method: 'POST',
        headers: {
          apikey: hearthProjectConfig.publishableKey,
          Authorization: `Bearer ${session.accessToken}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=representation',
        },
        body: JSON.stringify({
          owner_id: session.ownerId,
          device_id: deviceId,
          display_name: 'Hearth Control on Mac',
          bridge_enabled: Boolean(currentSettings.bridgeEnabled),
          pairing_hash: hashPairingSecret(bridgePairingSecret),
          updated_at: new Date().toISOString(),
        }),
      });
      if (!response.ok) throw new Error('Could not register this Hearth device.');
      bridgeState.pairingReady = true;
      return true;
    };

    const setRemoteBridgeEnabled = async (enabled) => {
      const session = await ensureBridgeSession();
      const hearthProjectConfig = supabaseProjectService.getProjectConfig(BRIDGE_CONNECTION_ALIAS);
      const response = await fetch(`${hearthProjectConfig.url}/rest/v1/hearth_devices?device_id=eq.${encodeURIComponent(deviceId)}`, {
        method: 'PATCH',
        headers: {
          apikey: hearthProjectConfig.publishableKey,
          Authorization: `Bearer ${session.accessToken}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify({ bridge_enabled: Boolean(enabled), updated_at: new Date().toISOString() }),
      });
      const rows = await response.json().catch(() => []);
      if (!response.ok || !Array.isArray(rows) || rows.length !== 1) {
        throw new Error('Could not update the remote bridge state.');
      }
    };

    // Main-process-only lookup from a public.tasks row id to its full,
    // already-validated x-task-v1 payload (never sent to the renderer --
    // bridgeState.pendingTasks only ever gets a small display-shaped
    // summary of it). Repopulated wholesale on every syncPublicXTasks poll.
    let publicXTaskRowsById = new Map();

    /**
     * R2: a PURE read -- fetchQueuedTasks() never claims or executes
     * anything. Returns a small array of display-shaped BridgeTask-like
     * summaries to merge into bridgeState.pendingTasks; the full parsed
     * task stays in publicXTaskRowsById for bridge:approve-task to use.
     * Silently returns [] when Project X isn't configured/signed in yet
     * (the auth boundary -- see publicTasksReady above) rather than ever
     * guessing credentials or spamming errors for an expected state.
     */
    const syncPublicXTasks = async () => {
      // A best-effort silent refresh -- if it fails, publicTasksReady() below
      // simply reports not-ready, exactly as if no session existed at all.
      if (publicTasksSession?.refreshToken) { try { await ensurePublicTasksSession(); } catch {} }
      if (!publicTasksReady()) { publicXTaskRowsById = new Map(); return []; }
      let rows;
      try { rows = await publicTasksClientInstance.fetchQueuedTasks(); }
      catch (err) { console.warn('[Bridge] Failed to fetch Project X queued tasks:', err.message); return []; }
      const nextRows = new Map();
      const summaries = rows.map((row) => {
        nextRows.set(row.id, row);
        const objective = row.task.objective || '';
        return {
          id: row.id, deviceId: '', source: 'x', routedTo: 'x',
          title: objective.length > 80 ? `${objective.slice(0, 80)}…` : objective,
          prompt: `${objective}\n\n${row.task.problem || ''}`.trim(),
          status: 'pending', createdAt: row.createdAt, requestId: `${SUPABASE_REQUEST_ID_PREFIX}${row.id}`,
        };
      });
      publicXTaskRowsById = nextRows;
      return summaries;
    };

    const syncBridgeTasks = async (tasks) => {
      bridgeState.connected = true;
      const xTasks = await syncPublicXTasks();
      bridgeState.pendingTasks = [...tasks, ...xTasks];
      bridgeState.pendingGoalRequests = await syncRemoteGoalRequests();
      sendEvent({ type: 'bridge:state', state: bridgeState });
      try {
        const { flushPendingRemoteSyncs } = await importFromHere('../mcp/bridge/client.mjs');
        await flushPendingRemoteSyncs({ bridgeClient: bridgeClientInstance, taskStore });
      } catch (err) {
        console.warn('[Bridge] Failed to flush pending remote syncs:', err.message);
      }
    };
    const handleBridgeError = (_err) => {
      bridgeState.connected = false;
      sendEvent({ type: 'bridge:state', state: bridgeState });
    };

    // Main-process-only lookup from a goal_requests row id to its full,
    // already-validated remote-goal-v1 payload -- same shape/lifetime as
    // publicXTaskRowsById above, just for the Remote Goals card list.
    let goalRequestRowsById = new Map();

    /**
     * A PURE read, same shape as syncPublicXTasks -- fetchQueuedGoalRequests()
     * never claims or imports anything. Returns small display-shaped
     * summaries (title, step count, X-step count, workspace, constraints,
     * ordered step titles) to merge into bridgeState.pendingGoalRequests; the
     * full parsed remote-goal-v1 stays in goalRequestRowsById for the
     * approve/reject handlers below to use. NEVER exposes raw xTask JSON to
     * the renderer. Called from syncBridgeTasks above (declared after it in
     * source, but only ever invoked later via the polling callback, so this
     * ordering is safe).
     */
    const syncRemoteGoalRequests = async () => {
      if (publicTasksSession?.refreshToken) { try { await ensurePublicTasksSession(); } catch {} }
      if (!publicTasksReady() || !goalRequestsClientInstance) { goalRequestRowsById = new Map(); return []; }
      let rows;
      try { rows = await goalRequestsClientInstance.fetchQueuedGoalRequests(); }
      catch (err) { console.warn('[Bridge] Failed to fetch Project X queued goal requests:', err.message); return []; }
      const nextRows = new Map();
      const summaries = rows.map((row) => {
        nextRows.set(row.id, row);
        const xStepCount = row.goal.steps.filter((s) => s.route === 'x').length;
        return {
          id: row.id,
          title: row.title,
          objective: row.goal.objective,
          workspace: row.goal.workspace,
          constraints: row.goal.constraints,
          stepCount: row.goal.steps.length,
          xStepCount,
          stepTitles: row.goal.steps.map((s) => s.title),
          createdAt: row.createdAt,
        };
      });
      goalRequestRowsById = nextRows;
      // Best-effort: also re-project any already-imported remote Goal's
      // current state on the same tick, so progress stays fresh without a
      // second timer, and finish any import interrupted mid-way.
      void resyncGoalRequestStates();
      void recoverUnimportedGoalRequests();
      return summaries;
    };

    if (bridgeClientInstance.enabled && bridgeClientInstance.supabaseUrl) {
      bridgeClientInstance.startPolling(syncBridgeTasks, handleBridgeError);
      try {
        const { flushPendingRemoteSyncs } = await importFromHere('../mcp/bridge/client.mjs');
        void flushPendingRemoteSyncs({ bridgeClient: bridgeClientInstance, taskStore });
      } catch {}
    }

    ipcMain.handle('bridge:get-state', () => bridgeState);

    ipcMain.handle('bridge:sign-up', async (_event, { email, password }) => {
      if (typeof email !== 'string' || typeof password !== 'string' || password.length < 8) {
        throw new Error('Enter a valid email and a password of at least 8 characters.');
      }
      const data = await supabaseAuthRequest('signup', { email: email.trim(), password });
      if (data?.access_token) {
        applyBridgeSession(data);
        await registerBridgeDevice();
        sendEvent({ type: 'bridge:state', state: bridgeState });
        return { signedIn: true, needsEmailVerification: false };
      }
      return { signedIn: false, needsEmailVerification: true };
    });

    ipcMain.handle('bridge:sign-in', async (_event, { email, password }) => {
      if (typeof email !== 'string' || typeof password !== 'string') throw new Error('Email and password are required.');
      const data = await supabaseAuthRequest('token?grant_type=password', { email: email.trim(), password });
      applyBridgeSession(data);
      await registerBridgeDevice();
      sendEvent({ type: 'bridge:state', state: bridgeState });
      return bridgeState;
    });

    ipcMain.handle('bridge:sign-out', async () => {
      if (bridgeState.enabled) await setRemoteBridgeEnabled(false).catch(() => {});
      bridgeClientInstance.stopPolling();
      bridgeClientInstance.enabled = false;
      bridgeClientInstance.setSession({ accessToken: null, ownerId: null });
      clearBridgeSession();
      bridgeState.enabled = false;
      bridgeState.connected = false;
      bridgeState.signedIn = false;
      bridgeState.accountEmail = null;
      bridgeState.pendingTasks = [];
      sendEvent({ type: 'bridge:state', state: bridgeState });
      return bridgeState;
    });

    // Project X's OWN auth IPC surface -- a SEPARATE namespace from every
    // bridge:* handler above (different settings keys, different encrypted
    // session, different Supabase project). Reuses the exact same
    // email/password Supabase-auth pattern the legacy bridge panel already
    // uses, just against publicTasksSupabaseUrl/publicTasksSupabaseAnonKey.
    ipcMain.handle('publicTasks:get-state', () => getPublicTasksState());

    ipcMain.handle('publicTasks:save-anon-key', async (_event, anonKey) => {
      if (typeof anonKey !== 'string' || !anonKey.trim()) throw new Error('Enter Project X\'s publishable (anon) key.');
      if (!supabaseProjectService) throw new Error('supabase_project_service_unavailable');
      const publishableKey = anonKey.trim();
      supabaseProjectService.updateProjectConfig(PUBLIC_TASKS_CONNECTION_ALIAS, { publishableKey });
      // Compatibility persistence: existing UI/settings recovery still sees
      // the same field, while the registry alias is now runtime authority.
      saveSettings({ publicTasksSupabaseAnonKey: publishableKey });
      publicTasksClientInstance?.setSession({ supabaseAnonKey: publishableKey });
      reviewItemsClientInstance?.setSession({ supabaseAnonKey: publishableKey });
      goalRequestsClientInstance?.setSession({ supabaseAnonKey: publishableKey });
      sendPublicTasksState();
      return getPublicTasksState();
    });

    ipcMain.handle('publicTasks:sign-up', async (_event, { email, password }) => {
      if (typeof email !== 'string' || typeof password !== 'string' || password.length < 8) {
        throw new Error('Enter a valid email and a password of at least 8 characters.');
      }
      const data = await supabasePublicTasksAuthRequest('signup', { email: email.trim(), password });
      if (data?.access_token) {
        applyPublicTasksSession(data);
        sendPublicTasksState();
        void resyncTerminalPublicXTasks();
        void resyncPendingReviewItems({ client: reviewItemsClientInstance, goalRunner });
        void resyncGoalRequestStates();
        void recoverUnimportedGoalRequests();
        return { signedIn: true, needsEmailVerification: false };
      }
      return { signedIn: false, needsEmailVerification: true };
    });

    ipcMain.handle('publicTasks:sign-in', async (_event, { email, password }) => {
      if (typeof email !== 'string' || typeof password !== 'string') throw new Error('Email and password are required.');
      const data = await supabasePublicTasksAuthRequest('token?grant_type=password', { email: email.trim(), password });
      applyPublicTasksSession(data);
      sendPublicTasksState();
      // Slice: once Project X becomes ready/reconnects, retry syncing any
      // already-terminal local X truth back to its row -- this NEVER reruns
      // X, creates another queue entry, or mutates X terminal truth (it is
      // a pure PATCH-by-id retry over already-durable receipts).
      void resyncTerminalPublicXTasks();
      // Same reconnect trigger for the Review Queue remote projection --
      // read-only against local state, best-effort idempotent writes.
      void resyncPendingReviewItems({ client: reviewItemsClientInstance, goalRunner });
      // Same reconnect trigger for remote Goal state projection.
      void resyncGoalRequestStates();
      void recoverUnimportedGoalRequests();
      return getPublicTasksState();
    });

    ipcMain.handle('publicTasks:sign-out', async () => {
      publicTasksClientInstance?.setSession({ accessToken: null, ownerId: null });
      reviewItemsClientInstance?.setSession({ accessToken: null, ownerId: null });
      goalRequestsClientInstance?.setSession({ accessToken: null, ownerId: null });
      clearPublicTasksSession();
      bridgeState.pendingGoalRequests = [];
      goalRequestRowsById = new Map();
      sendPublicTasksState();
      sendEvent({ type: 'bridge:state', state: bridgeState });
      return getPublicTasksState();
    });

    ipcMain.handle('bridge:get-pairing-secret', async () => {
      if (!bridgeState.signedIn) throw new Error('Sign in to Supabase first.');
      await registerBridgeDevice();
      return bridgePairingSecret;
    });

    ipcMain.handle('bridge:set-enabled', async (_event, enabled) => {
      if (!bridgeState.signedIn) throw new Error('Sign in to Supabase first.');
      await registerBridgeDevice();
      await setRemoteBridgeEnabled(Boolean(enabled));
      bridgeState.enabled = Boolean(enabled);
      saveSettings({ bridgeEnabled: bridgeState.enabled });
      if (bridgeClientInstance) {
        bridgeClientInstance.enabled = bridgeState.enabled;
        if (bridgeState.enabled && bridgeClientInstance.supabaseUrl) {
          bridgeClientInstance.startPolling(syncBridgeTasks, handleBridgeError);
          const { flushPendingRemoteSyncs } = await importFromHere('../mcp/bridge/client.mjs');
          void flushPendingRemoteSyncs({ bridgeClient: bridgeClientInstance, taskStore });
        } else {
          bridgeClientInstance.stopPolling();
          bridgeState.connected = false;
        }
      }
      sendEvent({ type: 'bridge:state', state: bridgeState });
      return bridgeState;
    });

    /**
     * Slice 1B/1C/1D remote-X approval path: Remote Inbox row -> manual
     * Approve -> conditional public.tasks claim (queued -> running) ->
     * the SAME shared Electron X ingress core (ingestXTask) the local
     * x_enqueue transport uses -- same parseXTask, same task-workspace-
     * vs-CURRENT-settings-workspace check, same fingerprint, same
     * requestId idempotency, same permission/admission, same durable X
     * queue receipt. taskStore/monitorTaskTransition/JobManager are never
     * touched here -- the X queue receipt + XRunStore + Result Gate are
     * this path's own durable local truth (see syncTerminalReceiptToPublicTasks
     * for how a terminal run is later synced back to this SAME row).
     */
    const approveRemotePublicXTask = async (taskId) => {
      const row = publicXTaskRowsById.get(taskId);
      if (!row) throw new Error('Task not found in pending inbox.');
      const claim = await publicTasksClientInstance.claimQueuedTask({ id: taskId });
      if (!claim.claimed) {
        publicXTaskRowsById.delete(taskId);
        bridgeState.pendingTasks = bridgeState.pendingTasks.filter((t) => t.id !== taskId);
        sendEvent({ type: 'bridge:state', state: bridgeState });
        throw new Error('Task was already claimed or cancelled.');
      }
      bridgeState.activeRemoteTaskId = taskId;
      sendEvent({ type: 'bridge:state', state: bridgeState });
      const requestId = `${SUPABASE_REQUEST_ID_PREFIX}${taskId}`;
      try {
        const result = await ingestXTask({
          requestId, task: row.task, child: null,
          waiterId: requestId, waiterActive: () => true, isLive: () => true,
          action: `Approve remote X task: ${row.task.task_id}`,
        });
        publicXTaskRowsById.delete(taskId);
        bridgeState.pendingTasks = bridgeState.pendingTasks.filter((t) => t.id !== taskId);
        bridgeState.activeRemoteTaskId = null;
        sendEvent({ type: 'bridge:state', state: bridgeState });
        return { success: true, taskId: requestId, routedTo: 'x', queueId: result.queue_id };
      } catch (err) {
        bridgeState.activeRemoteTaskId = null;
        sendEvent({ type: 'bridge:state', state: bridgeState });
        // The row was already claimed (queued -> running) but never actually
        // dispatched to X (e.g. workspace_mismatch/permission_denied) --
        // Slice 1C: "preserve remote task safely for review" means making
        // the failure visible on the SAME row, never silently rerunning X
        // and never leaving it stuck at 'running' with no record of why.
        try {
          await publicTasksClientInstance.updateTaskFromXRun({ id: taskId, xStatus: 'failed', result: null, error: err.message || String(err) });
        } catch (syncErr) {
          console.warn('[Bridge] Failed to mark an unrun X task as failed on public.tasks:', syncErr.message);
        }
        throw err;
      }
    };

    ipcMain.handle('bridge:approve-task', async (_event, taskId) => {
      if (publicXTaskRowsById.has(taskId)) return approveRemotePublicXTask(taskId);
      const {
        hasRunningTask,
        isTaskActivelyRunning,
        startAntigravityTask,
        getAntigravityTask,
      } = await importFromHere('../mcp/executors/antigravity.mjs');
      if (bridgeState.activeRemoteTaskId) {
        if (!isTaskActivelyRunning(bridgeState.activeRemoteTaskId)) {
          // Stale, dormant waiting, or terminal lock: clear it
          bridgeState.activeRemoteTaskId = null;
          sendEvent({ type: 'bridge:state', state: bridgeState });
        } else {
          throw new Error('Another task is currently running.');
        }
      }
      if (hasRunningTask && hasRunningTask()) {
        throw new Error('Another task is currently running.');
      }
      const task = bridgeState.pendingTasks.find(t => t.id === taskId);
      if (!task) throw new Error('Task not found in pending inbox.');

      // Atomic claim from database
      if (bridgeClientInstance?.supabaseUrl) {
        const claimResult = await bridgeClientInstance.claimTask({ taskId });
        if (!claimResult.claimed) {
          bridgeState.pendingTasks = bridgeState.pendingTasks.filter(t => t.id !== taskId);
          sendEvent({ type: 'bridge:state', state: bridgeState });
          throw new Error('Task was already claimed or cancelled.');
        }
      }

      bridgeState.activeRemoteTaskId = taskId;
      sendEvent({ type: 'bridge:state', state: bridgeState });

      // Execute via existing Antigravity integration
      const currentSettings = readSettings();
      const currentWorkspace = currentSettings.workspace;
      if (!currentWorkspace) {
        bridgeState.activeRemoteTaskId = null;
        sendEvent({ type: 'bridge:state', state: bridgeState });
        throw new Error('No workspace configured. Please select a workspace first.');
      }

      const permission = currentSettings.permissions?.Antigravity ?? 'Ask';
      if (permission === 'Blocked') {
        bridgeState.activeRemoteTaskId = null;
        sendEvent({ type: 'bridge:state', state: bridgeState });
        throw new Error('Antigravity permission is Blocked. Change it to Allow or Ask in Permissions settings.');
      }
      if (permission === 'Ask') {
        const allowed = await new Promise((resolve) => {
          const requestId = crypto.randomUUID();
          const timer = setTimeout(() => { localApprovals.delete(requestId); resolve(false); }, 60000);
          localApprovals.set(requestId, (ans) => { clearTimeout(timer); localApprovals.delete(requestId); resolve(ans); });
          sendEvent({ type: 'approval', requestId, permission: 'Antigravity', action: `Execute remote task: ${task.title || task.prompt.slice(0, 60)}` });
        });
        if (!allowed) {
          bridgeState.activeRemoteTaskId = null;
          sendEvent({ type: 'bridge:state', state: bridgeState });
          throw new Error('User denied permission for this remote task.');
        }
      }

      let hearthTaskId = null;
      try {
        if (taskStore) {
          const existing = taskStore.findTaskByRemoteLink({ remoteTaskId: taskId, requestId: task.requestId });
          if (existing && existing.status !== 'error') {
            throw new Error(`Remote task '${taskId}' has already been processed or is active.`);
          }
        }

        // Rule 4: Durable Remote Linkage Ordering
        // 1. Pre-allocate local Hearth taskId and persist task record with remoteTaskId/requestId
        hearthTaskId = crypto.randomUUID();
        const now = new Date().toISOString();
        const requiresDurableJob = Boolean(
          task.metadata?.requires_hearth_owned_job === true ||
          task.metadata?.requires_hearth_owned_job === 'true' ||
          task.metadata?.durable_route === true
        );

        const initialTask = {
          taskId: hearthTaskId,
          conversationId: null,
          workspace: currentWorkspace,
          title: task.title || task.prompt.slice(0, 60),
          source: 'remote',
          remoteTaskId: taskId,
          requestId: task.requestId || null,
          dismissed: false,
          status: 'starting',
          durableRoute: requiresDurableJob,
          metadata: task.metadata || {},
          createdAt: now,
          updatedAt: now,
          lastEvent: null,
          recentEvents: [],
          error: null,
          remoteSyncPending: false,
          remoteSyncStatus: 'pending',
        };
        if (taskStore) {
          taskStore.saveTask(initialTask);
        }

        // 2. Sync hearth_task_id immediately to the same Supabase row
        const { syncRemoteTaskState } = await importFromHere('../mcp/bridge/client.mjs');
        await syncRemoteTaskState({
          bridgeClient: bridgeClientInstance,
          taskStore,
          task: initialTask,
          overrides: { status: 'running' },
        });

        // 3. Start monitorTaskTransition immediately so early conversationId extractions are caught
        void monitorTaskTransition(hearthTaskId);

        // 4. If task requires a Hearth-owned durable job, launch it deterministically!
        let durableJob = null;
        if (requiresDurableJob) {
          const { startDurableJob, createControlledWorkerSpec } = await importFromHere('../mcp/executors/antigravity.mjs');
          const workerSpec = createControlledWorkerSpec(task.metadata, currentWorkspace);
          durableJob = startDurableJob({
            taskId: hearthTaskId,
            command: workerSpec.command,
            args: workerSpec.args,
            cwd: workerSpec.cwd,
            env: workerSpec.env || {},
            metadata: task.metadata,
          });
          initialTask.jobId = durableJob.id;
          initialTask.jobIds = [durableJob.id];
          initialTask.status = 'running';
          if (taskStore) {
            taskStore.saveTask(initialTask);
          }
        }

        // 5. Spawn executor using existingTaskId
        const { startAntigravityTask } = await importFromHere('../mcp/executors/antigravity.mjs');
        const { getProductionAntigravityClaimStore } = await importFromHere('../mcp/executors/antigravity-admission.mjs');
        const delegatedPrompt = requiresDurableJob && durableJob
          ? `[Hearth Durable Job Active]\nHearth has launched the authoritative background job (ID: ${durableJob.id}, PID: ${durableJob.pid}). Do NOT launch background processes or unmanaged shells via run_command. The durable job runs under Hearth ownership. Await completion or plan verification.\n\nTask Prompt:\n${task.prompt}`
          : task.prompt;

        const startRes = await startAntigravityTask({
          existingTaskId: hearthTaskId,
          workspace: currentWorkspace,
          prompt: delegatedPrompt,
          title: task.title,
          source: 'remote',
          remoteTaskId: taskId,
          requestId: task.requestId || null,
          userApproved: true,
          durableRoute: requiresDurableJob,
          jobId: durableJob?.id || null,
          jobIds: durableJob ? [durableJob.id] : [],
          metadata: task.metadata || {},
          verificationRequirements: task.verificationRequirements || (task.artifacts ? { requiredArtifacts: task.artifacts } : null),
          claimStore: getProductionAntigravityClaimStore(),
        });

        const taskObj = getAntigravityTask(hearthTaskId) || startRes;
        if (taskObj && taskObj.conversationId) {
          await syncRemoteTaskState({
            bridgeClient: bridgeClientInstance,
            taskStore,
            task: taskObj,
          });
        }

        // Remove from pending list
        bridgeState.pendingTasks = bridgeState.pendingTasks.filter(t => t.id !== taskId);
        sendEvent({ type: 'bridge:state', state: bridgeState });

        return { success: true, taskId: hearthTaskId, conversationId: startRes.conversationId };
      } catch (err) {
        bridgeState.activeRemoteTaskId = null;
        if (bridgeClientInstance?.supabaseUrl) {
          await bridgeClientInstance.updateTaskResult({
            taskId,
            hearthTaskId: hearthTaskId || null,
            status: 'error',
            error: err.message,
          });
        }
        sendEvent({ type: 'bridge:state', state: bridgeState });
        throw err;
      }
    });

    ipcMain.handle('bridge:reject-task', async (_event, taskId) => {
      // A Project X row has no remote-reject concept in this slice (Slice 1A's
      // adapter intentionally exposes only fetch/claim/update) -- rejecting
      // here is a LOCAL dismissal from this inbox only; the row stays
      // 'queued' remotely and may resurface on a later poll.
      if (publicXTaskRowsById.has(taskId)) {
        publicXTaskRowsById.delete(taskId);
        bridgeState.pendingTasks = bridgeState.pendingTasks.filter((t) => t.id !== taskId);
        sendEvent({ type: 'bridge:state', state: bridgeState });
        return true;
      }
      if (bridgeClientInstance?.supabaseUrl) {
        await bridgeClientInstance.rejectTask({ taskId });
      }
      if (bridgeState.activeRemoteTaskId === taskId) {
        bridgeState.activeRemoteTaskId = null;
      }
      bridgeState.pendingTasks = bridgeState.pendingTasks.filter(t => t.id !== taskId);
      sendEvent({ type: 'bridge:state', state: bridgeState });
      return true;
    });

    /**
     * Shared import core: workspace authority check (the SAME "task
     * workspace vs CURRENT settings workspace" decision ingestXTask makes
     * for a bare X task, here applied once to the whole Goal) -> the
     * EXISTING create_goal() on the LIVE goalRunner instance (never a
     * second GoalRunner/GoalStorage) -> durable local_goal_id written back.
     * ONLY imports -- never calls run_goal, never touches X approval.
     * Deterministic `remote-goal:<rowId>` local id makes this idempotent
     * whether called from a fresh approve or a crash-recovery retry.
     * Used by both approveRemoteGoalRequest (row already claimed just now)
     * and recoverUnimportedGoalRequests (row was claimed in a PRIOR,
     * interrupted attempt).
     */
    const importGoalFromRequestRow = async (requestId, row) => {
      if (!goalRunner) throw new Error('Goal runner is not initialized.');
      const currentWorkspace = readSettings().workspace;
      if (!currentWorkspace) throw new Error('No local workspace is configured.');
      let currentRoot;
      try { currentRoot = fs.realpathSync(currentWorkspace); } catch { throw new Error('The currently configured workspace is not accessible.'); }
      let goalRoot;
      try { goalRoot = fs.realpathSync(row.goal.workspace); } catch { throw new Error('The remote Goal workspace is not accessible on this machine.'); }
      if (goalRoot !== currentRoot) {
        throw new Error('The remote Goal workspace does not match the currently configured Hearth workspace.');
      }
      const localGoalId = `remote-goal:${requestId}`;
      let goal = goalRunner.get_goal(localGoalId);
      if (!goal) {
        goal = await goalRunner.create_goal({
          id: localGoalId,
          title: row.goal.title,
          objective: row.goal.objective,
          workspace: row.goal.workspace,
          constraints: row.goal.constraints,
          steps: row.goal.steps.map((s) => ({ id: s.id, title: s.title, route: s.route, xTask: s.xTask })),
          remoteGoalRequest: { provider: 'project-x', requestId },
        });
      }
      try { await goalRequestsClientInstance.recordLocalGoalId({ id: requestId, localGoalId: goal.id }); }
      catch (err) { console.warn('[Bridge] Failed to record local_goal_id on goal_requests row (import still succeeded):', err.message); }
      return goal;
    };

    /**
     * Remote Goal ingress: Remote Goals card -> manual Approve -> conditional
     * goal_requests claim (queued -> running) -> importGoalFromRequestRow.
     * The user still has to press Run on the newly-imported Goal exactly as
     * they would for any local Goal, and that already-existing Goal-level X
     * approval prompt is the ONLY thing that can ever authorize an X step
     * to dispatch.
     */
    const approveRemoteGoalRequest = async (requestId) => {
      const row = goalRequestRowsById.get(requestId);
      if (!row) throw new Error('Goal request not found in pending inbox.');
      const claim = await goalRequestsClientInstance.claimQueuedGoalRequest({ id: requestId });
      if (!claim.claimed) {
        goalRequestRowsById.delete(requestId);
        bridgeState.pendingGoalRequests = bridgeState.pendingGoalRequests.filter((g) => g.id !== requestId);
        sendEvent({ type: 'bridge:state', state: bridgeState });
        throw new Error('Goal request was already claimed or cancelled.');
      }
      bridgeState.activeGoalRequestId = requestId;
      sendEvent({ type: 'bridge:state', state: bridgeState });
      try {
        const goal = await importGoalFromRequestRow(requestId, row);
        goalRequestRowsById.delete(requestId);
        bridgeState.pendingGoalRequests = bridgeState.pendingGoalRequests.filter((g) => g.id !== requestId);
        bridgeState.activeGoalRequestId = null;
        sendEvent({ type: 'bridge:state', state: bridgeState });
        sendEvent({ type: 'goals:updated', goal });
        void resyncGoalRequestStates();
        return { success: true, goalId: goal.id };
      } catch (err) {
        bridgeState.activeGoalRequestId = null;
        sendEvent({ type: 'bridge:state', state: bridgeState });
        // The row was already claimed (queued -> running) but never actually
        // imported (e.g. workspace mismatch) -- make the failure visible on
        // the SAME row, never silently retry, never leave it stuck at
        // 'running' with no record of why.
        try { await goalRequestsClientInstance.markGoalRequestFailed({ id: requestId, error: err.message || String(err) }); }
        catch (syncErr) { console.warn('[Bridge] Failed to mark an unimported Goal request as failed on goal_requests:', syncErr.message); }
        throw err;
      }
    };

    /** Rejects a still-queued Goal request (queued -> cancelled). Never claims, never imports, never touches an already-claimed row. */
    const rejectRemoteGoalRequest = async (requestId) => {
      if (!goalRequestRowsById.has(requestId)) throw new Error('Goal request not found in pending inbox.');
      const rejected = await goalRequestsClientInstance.rejectQueuedGoalRequest({ id: requestId });
      goalRequestRowsById.delete(requestId);
      bridgeState.pendingGoalRequests = bridgeState.pendingGoalRequests.filter((g) => g.id !== requestId);
      sendEvent({ type: 'bridge:state', state: bridgeState });
      if (!rejected) throw new Error('Goal request was already claimed or cancelled.');
      return { success: true };
    };

    /**
     * Crash-recovery sweep: finds rows THIS owner already claimed (running)
     * but that never got a local_goal_id -- i.e. Hearth was interrupted
     * strictly between a successful claim and finishing the local import
     * (workspace unreachable at that moment, a crash, a forced quit). A row
     * here was already claimed by a genuine prior approve click; this never
     * claims anything new and never runs/approves X -- it only finishes an
     * import that had already been authorized. Safe to call repeatedly
     * (idempotent via the SAME deterministic id + get_goal check
     * importGoalFromRequestRow already does) and on every poll tick.
     */
    async function recoverUnimportedGoalRequests() {
      if (!goalRunner || !goalRequestsClientInstance?.ownerId) return;
      let rows;
      try { rows = await goalRequestsClientInstance.fetchClaimedUnimportedGoalRequests(); }
      catch (err) { console.warn('[Bridge] Failed to fetch claimed-unimported goal requests:', err.message); return; }
      for (const row of rows) {
        try {
          const goal = await importGoalFromRequestRow(row.id, row);
          sendEvent({ type: 'goals:updated', goal });
        } catch (err) {
          console.warn(`[Bridge] Failed to recover unimported goal_requests row '${row.id}':`, err.message);
          try { await goalRequestsClientInstance.markGoalRequestFailed({ id: row.id, error: err.message || String(err) }); }
          catch (syncErr) { console.warn('[Bridge] Failed to mark an unrecoverable goal_requests row as failed:', syncErr.message); }
        }
      }
    }

    ipcMain.handle('bridge:approve-goal-request', async (_event, requestId) => approveRemoteGoalRequest(requestId));
    ipcMain.handle('bridge:reject-goal-request', async (_event, requestId) => rejectRemoteGoalRequest(requestId));
  } catch (err) {
    console.error('Failed to initialize bridge:', err);
  }

  // The updater watchdog accepts this main-process marker as the V1 health
  // handshake only after essential local initialization above has completed
  // and the main BrowserWindow has been created successfully. If createWindow()
  // throws, startup remains unhealthy and the marker is deliberately absent.
  createWindow();
  await localUpdater.recordStartupSuccess(app.getPath('userData'));
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
}
app.on('before-quit', () => {
  xShuttingDown = true;
  for (const transportId of xQueueRequests.keys()) cancelXQueueRequest(transportId);
  for (const transportId of hearthJobRequests.keys()) cancelHearthJobRequest(transportId);
  for (const pending of pendingXApprovals.values()) pending.cancel();
  clearXQueueCapacityWakeup();
  for (const controller of localChatStreams.values()) controller.abort();
  if (continuationRecoveryTimer) clearInterval(continuationRecoveryTimer);
  if (serverProcess) serverProcess.kill('SIGTERM');
  else if (serverState.pid) { try { process.kill(serverState.pid, 'SIGTERM'); } catch {} }
  if (bridgeClientInstance) bridgeClientInstance.stopPolling();
  if (mt5BridgeServer) {
    const bridge = mt5BridgeServer;
    mt5BridgeServer = null;
    void bridge.stop().catch((error) => console.error('[MT5Bridge] Failed to stop local bridge:', error));
  }
  if (investMonitor) {
    investMonitor.stop();
    investMonitor = null;
  }
  for (const timer of taskMonitors.values()) clearInterval(timer);
  taskMonitors.clear();
  taskNotifier.setDockBadge('idle');
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
