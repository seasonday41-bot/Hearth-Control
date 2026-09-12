const { app, BrowserWindow, dialog, ipcMain, safeStorage, Notification } = require('electron');
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
  permissions: { Files: 'Allow', Git: 'Allow', Terminal: 'Ask', Browser: 'Blocked', Antigravity: 'Ask' },
};
let mainWindow;
let serverProcess;
let serverState = { running: false, port: 3001, pid: null };
let goalRunner = null;
let taskStore = null;
let jobManager = null;
let continuationRecoveryTimer = null;
const localApprovals = new Map();
let bridgeClientInstance = null;
let bridgeSession = null;
let bridgePairingSecret = null;
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
let isStartingTask = false;
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
const persistBridgeSession = (session) => {
  bridgeSession = session;
  saveSettings({ bridgeSessionEncrypted: encryptLocalSecret(session) });
};
const clearBridgeSession = () => {
  bridgeSession = null;
  saveSettings({ bridgeSessionEncrypted: null, bridgeEnabled: false });
};
const sendEvent = (event) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('server:event', event); };
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
  serverState = { running: false, port: selectedPort, pid: serverProcess.pid ?? null };
  sendEvent({ type: 'log', source: 'core', tone: 'quiet', message: `Starting local server process (PID ${serverProcess.pid})` });
  serverProcess.stdout.on('data', (chunk) => sendEvent({ type: 'log', source: 'server', tone: 'quiet', message: chunk.toString().trim() }));
  serverProcess.stderr.on('data', (chunk) => sendEvent({ type: 'log', source: 'server', tone: 'error', message: chunk.toString().trim() }));
  serverProcess.on('message', (message) => {
    if (message?.type === 'ready') {
      serverState = { running: true, port: selectedPort, pid: serverProcess?.pid ?? null };
      sendEvent({ type: 'state', state: serverState });
      sendEvent({ type: 'log', source: 'mcp', tone: 'success', message: `Local control server listening on 127.0.0.1:${selectedPort}` });
    }
    if (message?.type === 'approval') sendEvent(message);
  });
  serverProcess.once('exit', (code, signal) => {
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
};

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
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
    const goalsPath = path.join(app.getPath('userData'), 'goals.json');
    const goalStorage = new GoalStorage({ storagePath: goalsPath });
    goalRunner = new GoalRunner({ storage: goalStorage, antigravityExecutor });
  } catch (err) {
    console.error('Failed to initialize GoalRunner:', err);
  }

  ipcMain.handle('settings:get', () => {
    const { bridgeSessionEncrypted, bridgePairingEncrypted, ...publicSettings } = readSettings();
    return publicSettings;
  });
  ipcMain.handle('settings:save', async (_event, settings) => {
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
  ipcMain.handle('workspace:choose', async () => {
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
    const res = await resumeAntigravityTask({ taskId });
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
    const settings = readSettings();
    loadBridgeSecrets();
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

    const syncBridgeTasks = async (tasks) => {
      bridgeState.connected = true;
      bridgeState.pendingTasks = tasks;
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

    ipcMain.handle('bridge:approve-task', async (_event, taskId) => {
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
  if (continuationRecoveryTimer) clearInterval(continuationRecoveryTimer);
  if (serverProcess) serverProcess.kill('SIGTERM');
  if (bridgeClientInstance) bridgeClientInstance.stopPolling();
  for (const timer of taskMonitors.values()) clearInterval(timer);
  taskMonitors.clear();
  taskNotifier.setDockBadge('idle');
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
