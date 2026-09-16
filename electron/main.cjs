const { app, BrowserWindow, dialog, ipcMain, safeStorage, Notification, shell } = require('electron');
const { Worker } = require('node:worker_threads');
const { fork, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const crypto = require('node:crypto');
const localUpdater = require('./updater.cjs');
const { createTaskNotifier } = require('./task-notifications.cjs');

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
  permissions: { Files: 'Allow', Git: 'Allow', Terminal: 'Ask', Browser: 'Blocked', Antigravity: 'Ask' },
};
let mainWindow;
let serverProcess;
let serverState = { running: false, port: 3001, pid: null };
let goalRunner = null;
let taskStore = null;
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
let xWakeupTimer = null;
let xGetNextWakeupDeadline = null;
let xReconcileRuntimeNow = null;
let continuationRecoveryTimer = null;
const localApprovals = new Map();
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
const saveSettings = (next) => {
  const settings = { ...readSettings(), ...next };
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  return settings;
};
const encryptLocalSecret = (value) => {
  if (!value || !safeStorage.isEncryptionAvailable()) return null;
  return safeStorage.encryptString(JSON.stringify(value)).toString('base64');
};
const decryptLocalSecret = (encoded) => {
  if (!encoded || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return JSON.parse(safeStorage.decryptString(Buffer.from(encoded, 'base64')));
  } catch { return null; }
};
const loadBridgeSecrets = () => {
  const settings = readSettings();
  bridgeSession = decryptLocalSecret(settings.bridgeSessionEncrypted);
  const pairing = decryptLocalSecret(settings.bridgePairingEncrypted);
  bridgePairingSecret = typeof pairing?.secret === 'string' ? pairing.secret : null;
};
// A SEPARATE encrypted-at-rest session for Project X -- never derived from,
// or falls back to, bridgeSession (see supabasePublicTasksAuthRequest /
// applyPublicTasksSession / ensurePublicTasksSession below, and the
// publicTasks:sign-in/-up/-out IPC handlers, which are Project X's OWN
// sign-in flow, deliberately isolated from the legacy bridge's).
const loadPublicTasksSecrets = () => {
  const settings = readSettings();
  publicTasksSession = decryptLocalSecret(settings.publicTasksSessionEncrypted);
};
const persistBridgeSession = (session) => {
  bridgeSession = session;
  saveSettings({ bridgeSessionEncrypted: encryptLocalSecret(session) });
};
const clearBridgeSession = () => {
  bridgeSession = null;
  saveSettings({ bridgeSessionEncrypted: null, bridgeEnabled: false });
};
const persistPublicTasksSession = (session) => {
  publicTasksSession = session;
  saveSettings({ publicTasksSessionEncrypted: encryptLocalSecret(session) });
};
const clearPublicTasksSession = () => {
  publicTasksSession = null;
  saveSettings({ publicTasksSessionEncrypted: null });
};
/** Small, renderer-facing snapshot -- never includes the access/refresh token itself. */
const getPublicTasksState = () => ({
  configured: Boolean(readSettings().publicTasksSupabaseAnonKey),
  signedIn: Boolean(publicTasksSession?.accessToken && publicTasksSession?.ownerId),
  accountEmail: publicTasksSession?.email || null,
});
const sendPublicTasksState = () => sendEvent({ type: 'publicTasks:state', state: getPublicTasksState() });
const sendEvent = (event) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('server:event', event); };

const xQueueError = (code) => Object.assign(new Error(code), { code });
const canonicalJson = (value) => JSON.stringify(value, (_key, item) => {
  if (!item || Array.isArray(item) || typeof item !== 'object') return item;
  return Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]));
});
/**
 * The REAL, single canonicalization + fingerprint formula for an x-task-v1
 * payload -- used by ingestXTask's own idempotency/conflict detection AND
 * by Goal-level X approval (resolveGoalXApproval below) to verify an
 * approved Goal snapshot's per-step fingerprints against the CURRENT xTask
 * content. Never duplicated: both callers share this exact function so the
 * two can never silently drift into disagreeing about what "unchanged"
 * means.
 */
const canonicalizeXTask = (task, taskRoot) => ({ ...task, workspace: { ...task.workspace, root: taskRoot } });
const computeXTaskFingerprint = (task, taskRoot) =>
  crypto.createHash('sha256').update(canonicalJson(canonicalizeXTask(task, taskRoot))).digest('hex');
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
});
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
  const settings = readSettings();
  if (!settings.supabaseUrl || !settings.supabaseAnonKey) throw new Error('Supabase is not configured.');
  const response = await fetch(`${settings.supabaseUrl}/auth/v1/${pathName}`, {
    method: 'POST',
    headers: {
      apikey: settings.supabaseAnonKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.msg || data?.message || 'Supabase authentication failed.');
  return data;
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

// Project X's OWN auth request/session/refresh helpers -- an exact mirror of
// supabaseAuthRequest/applyBridgeSession/ensureBridgeSession above, but
// against publicTasksSupabaseUrl/publicTasksSupabaseAnonKey and
// publicTasksSession, NEVER the legacy bridge's settings/session. Kept as a
// deliberate duplication of this small, already-proven pattern rather than
// a shared parameterized helper, so the two projects' credentials can never
// accidentally cross-wire through a shared code path.
const supabasePublicTasksAuthRequest = async (pathName, body) => {
  const settings = readSettings();
  if (!settings.publicTasksSupabaseUrl || !settings.publicTasksSupabaseAnonKey) {
    throw new Error('Project X is not configured. Enter its publishable key first.');
  }
  const response = await fetch(`${settings.publicTasksSupabaseUrl}/auth/v1/${pathName}`, {
    method: 'POST',
    headers: {
      apikey: settings.publicTasksSupabaseAnonKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.msg || data?.message || 'Project X authentication failed.');
  return data;
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
  return session;
};

const ensurePublicTasksSession = async () => {
  if (!publicTasksSession?.refreshToken) throw new Error('Sign in to Project X first.');
  if (publicTasksSession.expiresAt > Date.now() + 60000) return publicTasksSession;
  const refreshed = await supabasePublicTasksAuthRequest('token?grant_type=refresh_token', { refresh_token: publicTasksSession.refreshToken });
  return applyPublicTasksSession(refreshed);
};

const stopServer = async () => {
  if (!serverProcess) return serverState;
  const child = serverProcess;
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 2500);
    child.once('exit', () => { clearTimeout(timer); resolve(serverState); });
    child.send({ type: 'shutdown' });
  });
};

const startServer = async ({ workspace, port }) => {
  if (serverProcess) return serverState;
  if (hasLiveXQueueEntries() && !xQueueWorkspaceMatches(workspace)) throw xQueueError('workspace_mismatch');
  const selectedPort = Number(port) || 3001;
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
  serverProcess.stdout.on('data', (chunk) => sendEvent({ type: 'log', source: 'server', tone: 'quiet', message: chunk.toString().trim() }));
  serverProcess.stderr.on('data', (chunk) => sendEvent({ type: 'log', source: 'server', tone: 'error', message: chunk.toString().trim() }));
  serverProcess.on('message', (message) => {
    if (serverProcess !== child) return;
    if (message?.type === 'ready') {
      serverState = { running: true, port: selectedPort, pid: serverProcess?.pid ?? null };
      sendEvent({ type: 'state', state: serverState });
      sendEvent({ type: 'log', source: 'mcp', tone: 'success', message: `Local control server listening on 127.0.0.1:${selectedPort}` });
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
  });
  serverProcess.once('exit', (code, signal) => {
    cancelXQueueChild(child);
    serverProcess = undefined;
    serverState = { running: false, port: selectedPort, pid: null };
    sendEvent({ type: 'state', state: serverState });
    sendEvent({ type: 'log', source: 'mcp', tone: code === 0 || signal === 'SIGTERM' ? 'quiet' : 'error', message: code === 0 || signal === 'SIGTERM' ? 'Local server stopped' : `Server exited unexpectedly (${code ?? signal})` });
  });
  serverProcess.once('error', (error) => sendEvent({ type: 'log', source: 'server', tone: 'error', message: error.message }));
  return serverState;
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

  ipcMain.handle('settings:get', () => {
    const { bridgeSessionEncrypted, bridgePairingEncrypted, ...publicSettings } = readSettings();
    return publicSettings;
  });
  ipcMain.handle('settings:save', async (_event, settings) => {
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
  ipcMain.handle('goals:is-active', async () => {
    return goalRunner ? goalRunner.is_goal_active() : false;
  });
  ipcMain.handle('server:get-state', () => serverState);
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
  ipcMain.handle('updater:check', async () => {
    const info = getUpdaterInfo();
    return localUpdater.inspectUpdate({
      updateDirectory: info.updateDirectory,
      currentVersion: info.currentVersion,
      currentBuildId: info.currentBuildId,
      platform: process.platform,
      arch: process.arch,
    });
  });
  ipcMain.handle('updater:choose-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: 'Choose trusted update folder', properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return getUpdaterInfo();
    saveSettings({ updateDirectory: result.filePaths[0] });
    return getUpdaterInfo();
  });
  ipcMain.handle('updater:install', async (event) => {
    if (!mainWindow || event.sender.id !== mainWindow.webContents.id) throw new Error('Install requests must come from the local Hearth window.');
    const info = getUpdaterInfo();
    const check = await localUpdater.inspectUpdate({
      updateDirectory: info.updateDirectory,
      currentVersion: info.currentVersion,
      currentBuildId: info.currentBuildId,
      platform: process.platform,
      arch: process.arch,
    });
    if (check.state !== localUpdater.UPDATE_STATES.UPDATE_READY) throw new Error(check.error || 'No verified update is ready to install.');
    const manifest = await localUpdater.readAndValidateManifest(info.updateDirectory, process.platform, process.arch);
    const install = await localUpdater.installUpdate({
      manifest,
      applicationsDirectory: '/Applications',
      userDataPath: app.getPath('userData'),
      launchRollbackHelper: startRollbackWatchdog,
      // This handler is reachable only after the visible local button and its
      // confirmation dialog. No remote payload can supply this flag.
      userApproved: true,
    });
    app.relaunch({ args: process.argv.slice(1) });
    setImmediate(() => app.exit(0));
    return install;
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
    const settings = readSettings();
    loadBridgeSecrets();
    loadPublicTasksSecrets();
    const deviceId = getOrCreateDeviceId(app.getPath('userData'));
    bridgeState.deviceId = deviceId;
    bridgeState.enabled = Boolean(settings.bridgeEnabled);
    bridgeState.configured = Boolean(settings.supabaseUrl && settings.supabaseAnonKey);
    bridgeState.signedIn = Boolean(bridgeSession?.accessToken && bridgeSession?.ownerId);
    bridgeState.accountEmail = bridgeSession?.email || null;
    bridgeState.pairingReady = Boolean(bridgePairingSecret);

    bridgeClientInstance = new HearthBridgeClient({
      deviceId,
      supabaseUrl: settings.supabaseUrl || '',
      supabaseAnonKey: settings.supabaseAnonKey || '',
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
      supabaseUrl: settings.publicTasksSupabaseUrl || '',
      supabaseAnonKey: settings.publicTasksSupabaseAnonKey || '',
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
    const refreshPublicTasksSessionBestEffort = async () => {
      if (publicTasksSession?.refreshToken) { try { await ensurePublicTasksSession(); } catch {} }
    };

    // Shares Project X's SAME session -- same Supabase project, same
    // authenticated owner, a different table. Never itself authenticates;
    // applyPublicTasksSession/sign-out above keep it mirrored to
    // publicTasksSession wherever that session changes (sign-in/sign-out);
    // this constructor call only covers the initial value at startup.
    reviewItemsClientInstance = new ReviewItemsClient({
      supabaseUrl: settings.publicTasksSupabaseUrl || '',
      supabaseAnonKey: settings.publicTasksSupabaseAnonKey || '',
    });
    reviewItemsClientInstance.setSession({
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
    }

    const registerBridgeDevice = async () => {
      const session = await ensureBridgeSession();
      if (!bridgePairingSecret) {
        const pairing = generatePairingSecret();
        bridgePairingSecret = pairing.secret;
        saveSettings({ bridgePairingEncrypted: encryptLocalSecret({ secret: pairing.secret }) });
      }
      const { hashPairingSecret } = await importFromHere('../mcp/bridge/identity.mjs');
      const currentSettings = readSettings();
      const response = await fetch(`${currentSettings.supabaseUrl}/rest/v1/hearth_devices?on_conflict=device_id`, {
        method: 'POST',
        headers: {
          apikey: currentSettings.supabaseAnonKey,
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
      const currentSettings = readSettings();
      const response = await fetch(`${currentSettings.supabaseUrl}/rest/v1/hearth_devices?device_id=eq.${encodeURIComponent(deviceId)}`, {
        method: 'PATCH',
        headers: {
          apikey: currentSettings.supabaseAnonKey,
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
      saveSettings({ publicTasksSupabaseAnonKey: anonKey.trim() });
      publicTasksClientInstance.supabaseAnonKey = anonKey.trim();
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
      return getPublicTasksState();
    });

    ipcMain.handle('publicTasks:sign-out', async () => {
      publicTasksClientInstance?.setSession({ accessToken: null, ownerId: null });
      reviewItemsClientInstance?.setSession({ accessToken: null, ownerId: null });
      clearPublicTasksSession();
      sendPublicTasksState();
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
  } catch (err) {
    console.error('Failed to initialize bridge:', err);
  }

  // A detached updater watchdog accepts this main-process marker as the V1
  // health handshake. It never relies on renderer text or a remote event.
  await localUpdater.recordStartupSuccess(app.getPath('userData'));
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
}
app.on('before-quit', () => {
  xShuttingDown = true;
  for (const transportId of xQueueRequests.keys()) cancelXQueueRequest(transportId);
  for (const pending of pendingXApprovals.values()) pending.cancel();
  clearXQueueCapacityWakeup();
  for (const controller of localChatStreams.values()) controller.abort();
  if (continuationRecoveryTimer) clearInterval(continuationRecoveryTimer);
  if (serverProcess) serverProcess.kill('SIGTERM');
  if (bridgeClientInstance) bridgeClientInstance.stopPolling();
  for (const timer of taskMonitors.values()) clearInterval(timer);
  taskMonitors.clear();
  taskNotifier.setDockBadge('idle');
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
