const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('controlApp', {
  platform: process.platform,
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  investModeGet: () => ipcRenderer.invoke('invest-mode:get'),
  investModeSet: (mode) => ipcRenderer.invoke('invest-mode:set', mode),
  investModeKillSwitch: () => ipcRenderer.invoke('invest-mode:kill-switch'),
  connectionsList: () => ipcRenderer.invoke('connections:list'),
  connectionsRefresh: (alias) => ipcRenderer.invoke('connections:refresh', alias),
  githubConnect: (request) => ipcRenderer.invoke('github:connect', request),
  githubDisconnect: (alias) => ipcRenderer.invoke('github:disconnect', alias),
  githubRepositories: (alias) => ipcRenderer.invoke('github:repositories', alias),
  githubSetDefaultRepository: (request) => ipcRenderer.invoke('github:set-default-repository', request),
  vercelConnect: (request) => ipcRenderer.invoke('vercel:connect', request),
  vercelDisconnect: (alias) => ipcRenderer.invoke('vercel:disconnect', alias),
  localChatStatus: () => ipcRenderer.invoke('local-chat:status'),
  localChatContext: (request) => ipcRenderer.invoke('local-chat:context', request),
  storageAuditScan: () => ipcRenderer.invoke('storage-audit:scan'),
  storageAuditReveal: (id) => ipcRenderer.invoke('storage-audit:reveal', id),
  onStorageAuditProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('storage-audit:progress', listener);
    return () => ipcRenderer.removeListener('storage-audit:progress', listener);
  },
  localChatSend: (request) => ipcRenderer.invoke('local-chat:send', request),
  localChatStreamStart: (request) => ipcRenderer.send('local-chat:stream-start', request),
  localChatStreamStop: (requestId) => ipcRenderer.send('local-chat:stream-stop', requestId),
  localChatTestApproval: (requestId, approved) => ipcRenderer.send('local-chat:test-approval-response', { requestId, approved }),
  onLocalChatStream: (callback) => {
    const events = ['chunk', 'done', 'error', 'activity'];
    const listeners = events.map((kind) => {
      const channel = `local-chat:stream-${kind}`;
      const listener = (_event, payload) => callback({ type: kind, ...payload });
      ipcRenderer.on(channel, listener);
      return [channel, listener];
    });
    return () => listeners.forEach(([channel, listener]) => ipcRenderer.removeListener(channel, listener));
  },
  chooseWorkspace: () => ipcRenderer.invoke('workspace:choose'),
  validateWorkspace: (path) => ipcRenderer.invoke('workspace:validate', path),
  getServerState: () => ipcRenderer.invoke('server:get-state'),
  startServer: (options) => ipcRenderer.invoke('server:start', options),
  stopServer: () => ipcRenderer.invoke('server:stop'),
  respondToApproval: (response) => ipcRenderer.invoke('server:respond-approval', response),
  antigravityStatus: () => ipcRenderer.invoke('antigravity:status'),
  antigravityStart: (options) => ipcRenderer.invoke('antigravity:start', options),
  antigravityTask: (taskId) => ipcRenderer.invoke('antigravity:task', taskId),
  antigravitySend: (options) => ipcRenderer.invoke('antigravity:send', options),
  antigravityResume: (taskId) => ipcRenderer.invoke('antigravity:resume', taskId),
  antigravityMarkFailed: (options) => ipcRenderer.invoke('antigravity:mark-failed', options),
  antigravityDismiss: (taskId) => ipcRenderer.invoke('antigravity:dismiss', taskId),
  antigravityListTasks: () => ipcRenderer.invoke('antigravity:list-tasks'),
  updaterGetInfo: () => ipcRenderer.invoke('updater:get-info'),
  updaterCheck: () => ipcRenderer.invoke('updater:check'),
  updaterPrepare: () => ipcRenderer.invoke('updater:prepare'),
  updaterCheckLocal: () => ipcRenderer.invoke('updater:check-local'),
  updaterChooseDirectory: () => ipcRenderer.invoke('updater:choose-directory'),
  // There is intentionally no bridge equivalent: installation is initiated only
  // from the visible, local Hearth window after an explicit button click.
  updaterInstall: () => ipcRenderer.invoke('updater:install'),
  bridgeGetState: () => ipcRenderer.invoke('bridge:get-state'),
  bridgeSignUp: (credentials) => ipcRenderer.invoke('bridge:sign-up', credentials),
  bridgeSignIn: (credentials) => ipcRenderer.invoke('bridge:sign-in', credentials),
  bridgeSignOut: () => ipcRenderer.invoke('bridge:sign-out'),
  bridgeGetPairingSecret: () => ipcRenderer.invoke('bridge:get-pairing-secret'),
  bridgeSetEnabled: (enabled) => ipcRenderer.invoke('bridge:set-enabled', enabled),
  bridgeApproveTask: (taskId) => ipcRenderer.invoke('bridge:approve-task', taskId),
  bridgeRejectTask: (taskId) => ipcRenderer.invoke('bridge:reject-task', taskId),
  bridgeApproveGoalRequest: (requestId) => ipcRenderer.invoke('bridge:approve-goal-request', requestId),
  bridgeRejectGoalRequest: (requestId) => ipcRenderer.invoke('bridge:reject-goal-request', requestId),
  // Project X's OWN auth surface -- a separate namespace from every bridge* call above.
  publicTasksGetState: () => ipcRenderer.invoke('publicTasks:get-state'),
  publicTasksSaveAnonKey: (anonKey) => ipcRenderer.invoke('publicTasks:save-anon-key', anonKey),
  publicTasksSignUp: (credentials) => ipcRenderer.invoke('publicTasks:sign-up', credentials),
  publicTasksSignIn: (credentials) => ipcRenderer.invoke('publicTasks:sign-in', credentials),
  publicTasksSignOut: () => ipcRenderer.invoke('publicTasks:sign-out'),
  goalsList: () => ipcRenderer.invoke('goals:list'),
  codexStatus: () => ipcRenderer.invoke('specialists:codex-status'),
  goalsClearHistory: () => ipcRenderer.invoke('goals:clear-history'),
  goalsGet: (goalId) => ipcRenderer.invoke('goals:get', goalId),
  goalsCreate: (data) => ipcRenderer.invoke('goals:create', data),
  goalsRun: (goalId) => ipcRenderer.invoke('goals:run', goalId),
  goalsPause: (goalId) => ipcRenderer.invoke('goals:pause', goalId),
  goalsResume: (goalId) => ipcRenderer.invoke('goals:resume', goalId),
  goalsSignoffStep: (options) => ipcRenderer.invoke('goals:signoff-step', options),
  goalsReviewAcknowledge: (options) => ipcRenderer.invoke('goals:review-acknowledge', options),
  goalsReviewResolve: (options) => ipcRenderer.invoke('goals:review-resolve', options),
  goalsIsActive: () => ipcRenderer.invoke('goals:is-active'),
  onServerEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('server:event', listener);
    return () => ipcRenderer.removeListener('server:event', listener);
  },
});
