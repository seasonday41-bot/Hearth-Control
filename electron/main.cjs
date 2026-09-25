const { app, BrowserWindow, dialog, ipcMain, safeStorage } = require('electron');
const { fork, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const { pathToFileURL } = require('node:url');
const localUpdater = require('./updater.cjs');
const remoteUpdater = require('./remote-updater.cjs');
const remoteUpdateStager = require('./remote-update-stager.cjs');
const localUpdate = require('./local-update.cjs');
const updateTrust = require('./update-trust-config.cjs');
const { SecureCredentialStore } = require('./security/secure-credential-store.cjs');
const { ConnectionService } = require('./connections/connection-service.cjs');
const { GitHubClient } = require('./github/github-client.cjs');
const { GitHubConnectionService } = require('./github/github-connection-service.cjs');
const { VercelClient } = require('./vercel/vercel-client.cjs');
const { VercelConnectionService } = require('./vercel/vercel-connection-service.cjs');

const importFromHere = (relative) => import(pathToFileURL(path.join(__dirname, relative)).href);
let buildMetadata;
try { buildMetadata = require('./build-meta.json'); }
catch { buildMetadata = { version: require('../package.json').version, buildId: 'development-build', builtAt: null }; }
const defaults = { workspace: '', port: 3001, theme: 'light', updateDirectory: '', permissions: { Files: 'Allow', Git: 'Allow', Terminal: 'Ask', Vercel: 'Ask', LAYA: 'Ask' } };
let mainWindow = null;
let serverProcess = null;
let serverState = { running: false, port: 3001, pid: null };
let connectionRegistry = null;
let connectionService = null;
let githubConnectionService = null;
let vercelConnectionService = null;
let remoteUpdateSession = null;
let updaterInstallInProgress = false;
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
const defaultUpdateDirectory = () => path.join(app.getPath('userData'), 'updates');
const readRawSettings = () => { try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); } catch { return {}; } };
const readSettings = () => {
  const saved = readRawSettings();
  return {
    workspace: typeof saved.workspace === 'string' ? saved.workspace : defaults.workspace,
    port: Number.isInteger(saved.port) ? saved.port : defaults.port,
    theme: saved.theme === 'dark' ? 'dark' : 'light',
    updateDirectory: saved.updateDirectory || defaultUpdateDirectory(),
    permissions: Object.fromEntries(Object.entries(defaults.permissions).map(([key, value]) => [key, ['Allow', 'Ask', 'Blocked'].includes(saved.permissions?.[key]) ? saved.permissions[key] : value])),
  };
};
const saveSettings = (changes) => {
  if (Object.keys(changes || {}).some((key) => /Encrypted$/.test(key))) throw new Error('secret_settings_write_forbidden');
  const current = readSettings();
  const next = { ...current };
  if (changes.workspace !== undefined) next.workspace = changes.workspace;
  if (changes.port !== undefined) next.port = changes.port;
  if (changes.theme !== undefined) next.theme = changes.theme;
  if (changes.updateDirectory !== undefined) next.updateDirectory = changes.updateDirectory;
  if (changes.permissions) next.permissions = { ...current.permissions, ...Object.fromEntries(Object.entries(changes.permissions).filter(([key, value]) => key in defaults.permissions && ['Allow', 'Ask', 'Blocked'].includes(value))) };
  if (typeof next.workspace !== 'string' || (next.workspace && !fs.existsSync(next.workspace))) throw new Error('workspace_invalid');
  if (!Number.isInteger(next.port) || next.port < 1024 || next.port > 65535) throw new Error('port_invalid');
  if (!['light', 'dark'].includes(next.theme)) throw new Error('theme_invalid');
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify({ ...readRawSettings(), ...next }, null, 2));
  return next;
};
const sendEvent = (event) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('server:event', event); };
const localWindowOnly = (event) => { if (!mainWindow || event.sender.id !== mainWindow.webContents.id) throw new Error('Local window only.'); };

const initConnections = async () => {
  const { ConnectionRegistry } = await importFromHere('../mcp/connections/registry.mjs');
  const { builtinConnectionDefinitions } = await importFromHere('../mcp/connections/model.mjs');
  const root = app.getPath('userData');
  connectionRegistry = new ConnectionRegistry({ storagePath: path.join(root, 'connections.json') });
  connectionRegistry.load();
  connectionRegistry.ensure(builtinConnectionDefinitions(readSettings()).filter((record) => ['github', 'vercel'].includes(record.provider)));
  connectionService = new ConnectionService({ registry: connectionRegistry, secureStore: new SecureCredentialStore({ storagePath: path.join(root, 'credentials.json'), safeStorage }) });
  githubConnectionService = new GitHubConnectionService({ registry: connectionRegistry, connectionService, githubClient: new GitHubClient() });
  vercelConnectionService = new VercelConnectionService({ registry: connectionRegistry, connectionService, vercelClient: new VercelClient() });
};
const publicConnections = () => connectionRegistry?.list().filter((entry) => ['github', 'vercel'].includes(entry.provider)).map((entry) => entry.provider === 'github' ? githubConnectionService.publicSnapshot(entry) : vercelConnectionService.publicSnapshot(entry)) || [];
const probeServer = (port) => new Promise((resolve) => {
  const request = http.get(`http://127.0.0.1:${port}/health`, { timeout: 800 }, (response) => {
    let body = '';
    response.on('data', (chunk) => { body = (body + chunk).slice(0, 2000); });
    response.on('end', () => { try { const value = JSON.parse(body); resolve(value.service === 'hearth-control' ? value : { foreign: true }); } catch { resolve({ foreign: true }); } });
  });
  request.on('error', () => resolve(null));
  request.on('timeout', () => { request.destroy(); resolve(null); });
});
const forwardConnectionRequest = async (child, message) => {
  if (typeof message.transportId !== 'string' || !/^[0-9a-f-]{36}$/i.test(message.transportId)) return;
  const type = message.type;
  let result, error;
  try {
    if (type === 'github_connections_list_request') result = { connections: publicConnections().filter((entry) => entry.provider === 'github') };
    else if (type === 'github_repositories_list_request') result = await githubConnectionService.listRepositories(message.connection, { page: message.page, perPage: message.perPage });
    else if (type === 'github_repository_get_request') result = await githubConnectionService.getRepository(message.connection, { owner: message.owner, repo: message.repo });
    else if (type === 'github_pull_requests_list_request') result = await githubConnectionService.listPullRequests(message.connection, { owner: message.owner, repo: message.repo, state: message.state, page: message.page, perPage: message.perPage });
    else if (type === 'github_pull_request_create_request') result = await githubConnectionService.createPullRequest(message.connection, { owner: message.owner, repo: message.repo, title: message.title, head: message.head, base: message.base, body: message.body, draft: message.draft === true });
    else if (type === 'vercel_projects_list_request') result = await vercelConnectionService.listProjects(message.connection, { teamId: message.teamId || null, limit: message.limit });
    else if (type === 'vercel_project_get_request') result = await vercelConnectionService.getProject(message.connection, { idOrName: message.idOrName, teamId: message.teamId || null });
    else if (type === 'vercel_deployments_list_request') result = await vercelConnectionService.listDeployments(message.connection, { projectId: message.projectId || null, teamId: message.teamId || null, limit: message.limit, target: message.target || null });
    else if (type === 'vercel_deployment_get_request') result = await vercelConnectionService.getDeployment(message.connection, { idOrUrl: message.idOrUrl, teamId: message.teamId || null });
    else return;
  } catch (cause) { error = typeof cause?.code === 'string' ? cause.code : 'connection_request_failed'; }
  if (serverProcess === child && child.connected) child.send({ type: type.replace(/_request$/, '_ack'), transportId: message.transportId, ok: !error, result, error });
};
const connectionRequestTypes = new Set(['github_connections_list_request', 'github_repositories_list_request', 'github_repository_get_request', 'github_pull_requests_list_request', 'github_pull_request_create_request', 'vercel_projects_list_request', 'vercel_project_get_request', 'vercel_deployments_list_request', 'vercel_deployment_get_request']);
const startServer = async () => {
  const { workspace, port } = readSettings();
  if (!workspace || !(await fs.promises.stat(workspace).catch(() => null))?.isDirectory()) throw new Error('Choose a valid workspace first.');
  if (serverProcess) return serverState;
  const existing = await probeServer(port);
  if (existing?.foreign) throw new Error(`Port ${port} is in use by another service.`);
  if (existing) {
    if (existing.workspace !== workspace) throw new Error('A Hearth MCP server is already running for another workspace.');
    serverState = { running: true, port, pid: existing.pid || null };
    sendEvent({ type: 'state', state: serverState });
    return serverState;
  }
  return new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, 'server.cjs'), [], { env: { ...process.env, CONTROL_PORT: String(port), CONTROL_WORKSPACE: workspace, CONTROL_JOB_STORE: path.join(app.getPath('userData'), 'generic-jobs.json'), CONTROL_PERMISSIONS: JSON.stringify(readSettings().permissions) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    serverProcess = child;
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('MCP startup timed out.')); }, 10000);
    child.stdout.on('data', (chunk) => sendEvent({ type: 'log', source: 'mcp', message: chunk.toString().slice(0, 500) }));
    child.stderr.on('data', (chunk) => sendEvent({ type: 'log', source: 'mcp', message: chunk.toString().slice(0, 500) }));
    child.on('message', (message) => {
      if (serverProcess !== child) return;
      if (message?.type === 'ready') { clearTimeout(timer); serverState = { running: true, port, pid: child.pid }; sendEvent({ type: 'state', state: serverState }); resolve(serverState); }
      if (message?.type === 'approval' || message?.type === 'approval:resolved') sendEvent(message);
      if (connectionRequestTypes.has(message?.type)) void forwardConnectionRequest(child, message);
    });
    child.once('exit', (code) => { clearTimeout(timer); if (serverProcess === child) serverProcess = null; serverState = { running: false, port, pid: null }; sendEvent({ type: 'state', state: serverState }); if (code && !serverState.running) reject(new Error(`MCP exited with code ${code}.`)); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
};
const stopServer = async () => {
  const jobs = await requestJobs();
  if (jobs === null) throw new Error('Cannot verify background job ownership; MCP server remains running.');
  if (jobs.some((job) => ['running', 'queued', 'recovery_required'].includes(job.status) || (job.pid && !job.process_stopped))) throw new Error('Stop running jobs before stopping the MCP server.');
  return new Promise((resolve) => {
  if (!serverProcess) { resolve(serverState); return; }
  const child = serverProcess;
  if (!child.connected) { resolve(serverState); return; }
  const timer = setTimeout(() => child.kill('SIGTERM'), 2500);
  child.once('exit', () => { clearTimeout(timer); resolve(serverState); });
  child.send({ type: 'shutdown' });
  });
};
const requestJobs = () => new Promise((resolve) => {
  if (!serverProcess?.connected) { resolve([]); return; }
  const child = serverProcess, requestId = crypto.randomUUID();
  const finish = (jobs) => { clearTimeout(timer); child.off('message', onMessage); resolve(Array.isArray(jobs) ? jobs : null); };
  const onMessage = (message) => { if (message?.type === 'jobs:list-response' && message.requestId === requestId) finish(message.jobs); };
  const timer = setTimeout(() => finish(null), 2500);
  child.on('message', onMessage);
  try { child.send({ type: 'jobs:list-request', requestId }); } catch { finish(null); }
});
const createWindow = () => {
  mainWindow = new BrowserWindow({ width: 1160, height: 780, minWidth: 740, minHeight: 550, backgroundColor: '#f7f8f5', title: 'Hearth Control', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false } });
  if (process.env.VITE_DEV_SERVER_URL) mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  else mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  const window = mainWindow;
  window.on('closed', () => { if (mainWindow === window) mainWindow = null; });
};

const getUpdaterInfo = () => ({
  currentVersion: buildMetadata.version,
  currentBuildId: buildMetadata.buildId,
  // The commit this binary was built from, so an installed app can be matched
  // to its source rather than only to a version number.
  currentCommit: buildMetadata.commit ?? null,
  builtFromDirtyTree: buildMetadata.dirty === true,
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
  if (/LOCAL_UPDATE|git|repository|credential|fetch|main ref/i.test(message)) return 'The private Git update source could not be reached securely.';
  if (/mount|staging|application bundle|detach/i.test(message)) return 'The downloaded update could not be prepared safely.';
  return 'The remote update could not be prepared safely.';
};

const remoteUpdateOptions = () => ({
  manifestUrl: updateTrust.MANIFEST_URL,
  trustedOrigin: updateTrust.TRUSTED_DELIVERY_ORIGINS[0],
  trustedOrigins: updateTrust.TRUSTED_DELIVERY_ORIGINS,
  trustedKeys: updateTrust.TRUSTED_SIGNING_KEYS,
  artifactBaseUrl: updateTrust.ARTIFACT_BASE_URL,
  sourceArchiveBaseUrl: updateTrust.SOURCE_ARCHIVE_BASE_URL,
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

const pendingGenericJobs = () => {
  const file = path.join(app.getPath('userData'), 'generic-jobs.json');
  if (!fs.existsSync(file)) return 0;
  try {
    const jobs = JSON.parse(fs.readFileSync(file, 'utf8')).jobs;
    if (!Array.isArray(jobs)) return 1;
    return jobs.filter((job) => ['queued', 'running', 'recovery_required'].includes(job.status)).length;
  } catch { return 1; }
};
// Installation waits until the MCP process and all background jobs are stopped.
const getUpdaterRuntimeBlocker = ({ ignoreUpdaterBusy = false } = {}) => localUpdater.evaluateUpdaterRuntimePreflight({
  runtimeAvailable: true, xActive: false, goalActive: false,
  queuedJobCount: pendingGenericJobs(), runningJobCount: serverState.running ? 1 : 0,
  updaterBusy: !ignoreUpdaterBusy && updaterInstallInProgress,
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


if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (!mainWindow || mainWindow.isDestroyed()) createWindow(); else { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
  app.whenReady().then(async () => {
    await initConnections();
    ipcMain.handle('settings:get', (event) => { localWindowOnly(event); return readSettings(); });
    ipcMain.handle('settings:save', (event, request) => {
      localWindowOnly(event);
      if (Object.keys(request || {}).some((key) => /Encrypted$/.test(key))) throw new Error('secret_settings_write_forbidden');
      const previous = readSettings();
      const allowed = Object.fromEntries(Object.entries(request || {}).filter(([key]) => ['workspace', 'port', 'theme', 'permissions'].includes(key)));
      if (serverProcess && ((allowed.workspace && allowed.workspace !== previous.workspace) || (allowed.port && allowed.port !== previous.port))) throw new Error('Stop the MCP server before changing workspace or port.');
      const saved = saveSettings(allowed);
      if (serverProcess && allowed.permissions) serverProcess.send({ type: 'settings:update', permissions: saved.permissions });
      return saved;
    });
    ipcMain.handle('workspace:choose', async (event) => {
      localWindowOnly(event);
      const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
      if (result.canceled || !result.filePaths[0]) return null;
      if (serverProcess) throw new Error('Stop the MCP server before changing workspace.');
      return saveSettings({ workspace: result.filePaths[0] }).workspace;
    });
    ipcMain.handle('workspace:validate', async (event, candidate) => {
      localWindowOnly(event);
      if (typeof candidate !== 'string' || !candidate) return { valid: false, reason: 'not_configured' };
      try { return { valid: (await fs.promises.stat(candidate)).isDirectory() }; } catch { return { valid: false, reason: 'not_accessible' }; }
    });
    ipcMain.handle('workspace:summary', async (event) => {
      localWindowOnly(event);
      const root = readSettings().workspace;
      if (!root) return { path: '', branch: null, dirty: null, files: [] };
      const files = (await fs.promises.readdir(root, { withFileTypes: true })).filter((entry) => !entry.name.startsWith('.')).slice(0, 30).map((entry) => ({ name: entry.name, directory: entry.isDirectory() }));
      try {
        const [branch, status] = await Promise.all([
          execFileAsync('git', ['-C', root, 'branch', '--show-current'], { timeout: 5000 }),
          execFileAsync('git', ['-C', root, 'status', '--porcelain'], { timeout: 5000 }),
        ]);
        return { path: root, branch: branch.stdout.trim() || null, dirty: Boolean(status.stdout.trim()), files };
      } catch { return { path: root, branch: null, dirty: null, files }; }
    });
    ipcMain.handle('server:get-state', async (event) => {
      localWindowOnly(event);
      if (!serverProcess) {
        const existing = await probeServer(readSettings().port);
        serverState = { running: Boolean(existing && !existing.foreign && existing.workspace === readSettings().workspace), port: readSettings().port, pid: existing?.pid || null };
      }
      return serverState;
    });
    ipcMain.handle('server:start', (event) => { localWindowOnly(event); return startServer(); });
    ipcMain.handle('server:stop', (event) => { localWindowOnly(event); return stopServer(); });
    ipcMain.handle('server:respond-approval', (event, response) => {
      localWindowOnly(event);
      if (!serverProcess || typeof response?.requestId !== 'string') return false;
      serverProcess.send({ type: 'approval:result', requestId: response.requestId, allowed: response.allowed === true });
      return true;
    });
    ipcMain.handle('server:tools', async (event) => { localWindowOnly(event); return (await importFromHere('../mcp/tools.mjs')).toolNames; });
    ipcMain.handle('jobs:list', async (event) => { localWindowOnly(event); return await requestJobs() || []; });
    ipcMain.handle('laya:status', async (event) => { localWindowOnly(event); return (await importFromHere('../mcp/laya.mjs')).layaStatus(); });
    const authorizeLaya = async (event) => {
      localWindowOnly(event);
      const level = readSettings().permissions.LAYA;
      if (level === 'Blocked') throw new Error('LAYA permission is Blocked.');
      if (level === 'Ask') {
        const choice = await dialog.showMessageBox(mainWindow, { type: 'question', title: 'Consult LAYA', message: 'Send this text to the configured local LAYA specialist?', buttons: ['Allow once', 'Cancel'], defaultId: 1, cancelId: 1 });
        if (choice.response !== 0) throw new Error('LAYA consultation was cancelled.');
      }
    };
    ipcMain.handle('laya:consult', async (event, prompt) => {
      await authorizeLaya(event);
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 16000) throw new Error('Invalid consultation text.');
      return (await importFromHere('../mcp/laya.mjs')).layaConsult(prompt);
    });
    ipcMain.handle('laya:review', async (event, input) => {
      await authorizeLaya(event);
      if (!input || typeof input.objective !== 'string' || input.objective.length > 4000 || !['ui', 'code'].includes(input.focus)) throw new Error('Invalid review request.');
      return (await importFromHere('../mcp/laya.mjs')).layaReview({ objective: input.objective, changed_files: [], summary: input.objective, focus: input.focus });
    });
    ipcMain.handle('connections:list', (event) => { localWindowOnly(event); return publicConnections(); });
    ipcMain.handle('connections:refresh', async (event, alias) => {
      localWindowOnly(event);
      const entries = alias ? [connectionRegistry.get(alias)] : connectionRegistry.list().filter((entry) => ['github', 'vercel'].includes(entry.provider));
      return Promise.all(entries.filter(Boolean).map((entry) => entry.provider === 'github' ? githubConnectionService.refresh(entry.alias) : vercelConnectionService.refresh(entry.alias)));
    });
    ipcMain.handle('github:connect', (event, request) => { localWindowOnly(event); return githubConnectionService.connect(request.alias, request.token, { capabilities: request.allowPullRequestCreate ? ['repo.read', 'pull_request.read', 'pull_request.create'] : ['repo.read', 'pull_request.read'] }); });
    ipcMain.handle('github:disconnect', (event, alias) => { localWindowOnly(event); return githubConnectionService.disconnect(alias); });
    ipcMain.handle('github:repositories', (event, alias) => { localWindowOnly(event); return githubConnectionService.listRepositories(alias, { page: 1, perPage: 100 }); });
    ipcMain.handle('github:set-default-repository', (event, request) => { localWindowOnly(event); return githubConnectionService.setDefaultRepository(request.alias, request.fullName || null); });
    ipcMain.handle('vercel:connect', (event, request) => { localWindowOnly(event); return vercelConnectionService.connect(request.alias, request.token, { teamId: request.teamId || null }); });
    ipcMain.handle('vercel:disconnect', (event, alias) => { localWindowOnly(event); return vercelConnectionService.disconnect(alias); });
  ipcMain.handle('updater:get-info', () => getUpdaterInfo());
  ipcMain.handle('updater:check', async (event) => {
    if (!mainWindow || event.sender.id !== mainWindow.webContents.id) throw new Error('Update checks must come from the local Hearth window.');
    const info = getUpdaterInfo();
    try {
      const checked = await localUpdate.checkGitMainUpdate({
        currentVersion: info.currentVersion,
        currentBuildId: info.currentBuildId,
        currentBuiltAt: info.builtAt,
        currentCommit: info.currentCommit,
        isPackaged: info.isPackaged,
        stagingRoot: info.updateDirectory,
        expectedRepository: updateTrust.SOURCE_REPOSITORY,
        expectedBranch: updateTrust.SOURCE_BRANCH,
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
      if (remoteUpdateSession?.mode === 'local_git') {
        const expectedManifest = remoteUpdateSession.manifest;
        const rechecked = await localUpdate.checkGitMainUpdate({
          currentVersion: info.currentVersion,
          currentBuildId: info.currentBuildId,
          currentBuiltAt: info.builtAt,
          currentCommit: info.currentCommit,
          isPackaged: info.isPackaged,
          stagingRoot: info.updateDirectory,
          expectedRepository: updateTrust.SOURCE_REPOSITORY,
          expectedBranch: updateTrust.SOURCE_BRANCH,
        });
        if (rechecked.session?.manifest?.buildId !== expectedBuildId
          || rechecked.session?.manifest?.source?.commit !== expectedManifest?.source?.commit) {
          remoteUpdateSession = null;
          return { state: localUpdater.UPDATE_STATES.ERROR, currentVersion: info.currentVersion, currentBuildId: info.currentBuildId, available: null, error: 'Git main changed. Check for updates again.' };
        }
        remoteUpdateSession = { ...rechecked.session, state: 'building' };
        sendEvent({ type: 'updater:state', state: 'building' });
        phase = 'stage';
        const staged = await localUpdate.buildAndStageGitUpdate({
          manifest: rechecked.session.manifest,
          stagingRoot: info.updateDirectory,
          expectedRepository: updateTrust.SOURCE_REPOSITORY,
        });
        phase = 'local_validate';
        const check = await inspectLocalUpdateDirectory(staged.stagedDir, info);
        if (check.state !== localUpdater.UPDATE_STATES.UPDATE_READY) {
          throw new Error(check.error || 'The staged update did not pass local updater validation.');
        }
        remoteUpdateSession = {
          state: localUpdater.UPDATE_STATES.UPDATE_READY,
          mode: 'local_git',
          manifest: rechecked.session.manifest,
          stagedDir: staged.stagedDir,
        };
        sendEvent({ type: 'updater:state', state: 'update_ready' });
        updaterDebug('update_ready', rechecked.session.manifest.buildId);
        return check;
      }

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
      sendEvent({ type: 'updater:state', state: 'verifying' });
      phase = 'stage';
      const staged = fetched.manifest.source
        ? await (async () => {
          sendEvent({ type: 'updater:state', state: 'building' });
          if (fetched.manifest.source.transport === 'git') {
            return localUpdate.buildAndStageGitUpdate({
              manifest: fetched.manifest,
              stagingRoot: info.updateDirectory,
              expectedRepository: updateTrust.SOURCE_REPOSITORY,
            });
          }
          const sourceArchive = await localUpdate.downloadSourceArchive({
            manifest: fetched.manifest,
            sourceRoot: remoteUpdateOptions().sourceArchiveBaseUrl,
            updatesDir: info.updateDirectory,
            trustedOrigin: remoteUpdateOptions().sourceArchiveBaseUrl.replace(/\/$/, ''),
            trustedOrigins: [remoteUpdateOptions().sourceArchiveBaseUrl.replace(/\/$/, '')],
          });
          return localUpdate.buildAndStageLocalUpdate({
            manifest: fetched.manifest,
            archivePath: sourceArchive.archivePath,
            stagingRoot: info.updateDirectory,
            expectedRepository: updateTrust.SOURCE_REPOSITORY,
          });
        })()
        : await remoteUpdateStager.stageVerifiedUpdate({ manifest: fetched.manifest, dmgPath: fetched.dmgPath });
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
      sendEvent({ type: 'updater:state', state: 'update_ready' });
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
        // and runtime preflight. No renderer payload, remote request or MCP tool call can supply or bypass either gate.
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
    createWindow();
    await localUpdater.recordStartupSuccess(app.getPath('userData'));
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  }).catch((error) => { console.error('[Hearth] Startup failed:', error); app.quit(); });
}
let quitApproved = false;
let quitCheckPending = false;
app.on('before-quit', (event) => {
  if (quitApproved || !serverProcess?.connected) {
    if (serverProcess?.connected) serverProcess.send({ type: 'shutdown' });
    return;
  }
  event.preventDefault();
  if (quitCheckPending) return;
  quitCheckPending = true;
  void requestJobs().then((jobs) => {
    if (jobs === null || jobs.some((job) => ['running', 'queued', 'recovery_required'].includes(job.status) || (job.pid && !job.process_stopped))) {
      const options = { type: 'warning', message: 'Stop background jobs before quitting Hearth.', buttons: ['OK'] };
      return mainWindow ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options);
    }
    quitApproved = true;
    app.quit();
  }).finally(() => { quitCheckPending = false; });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
