const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('controlApp', {
  platform: process.platform,
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
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
  goalsList: () => ipcRenderer.invoke('goals:list'),
  goalsGet: (goalId) => ipcRenderer.invoke('goals:get', goalId),
  goalsCreate: (data) => ipcRenderer.invoke('goals:create', data),
  goalsRun: (goalId) => ipcRenderer.invoke('goals:run', goalId),
  goalsPause: (goalId) => ipcRenderer.invoke('goals:pause', goalId),
  goalsResume: (goalId) => ipcRenderer.invoke('goals:resume', goalId),
  goalsSignoffStep: (options) => ipcRenderer.invoke('goals:signoff-step', options),
  goalsIsActive: () => ipcRenderer.invoke('goals:is-active'),
  onServerEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('server:event', listener);
    return () => ipcRenderer.removeListener('server:event', listener);
  },
});
