const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('controlApp', {
  platform: process.platform,
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  chooseWorkspace: () => ipcRenderer.invoke('workspace:choose'),
  validateWorkspace: (candidate) => ipcRenderer.invoke('workspace:validate', candidate),
  getWorkspaceSummary: () => ipcRenderer.invoke('workspace:summary'),
  getServerState: () => ipcRenderer.invoke('server:get-state'),
  getToolNames: () => ipcRenderer.invoke('server:tools'),
  getJobs: () => ipcRenderer.invoke('jobs:list'),
  getLayaStatus: () => ipcRenderer.invoke('laya:status'),
  layaConsult: (prompt) => ipcRenderer.invoke('laya:consult', prompt),
  layaReview: (input) => ipcRenderer.invoke('laya:review', input),
  startServer: (options) => ipcRenderer.invoke('server:start', options),
  stopServer: () => ipcRenderer.invoke('server:stop'),
  respondToApproval: (response) => ipcRenderer.invoke('server:respond-approval', response),
  connectionsList: () => ipcRenderer.invoke('connections:list'),
  connectionsRefresh: (alias) => ipcRenderer.invoke('connections:refresh', alias),
  githubConnect: (request) => ipcRenderer.invoke('github:connect', request),
  githubDisconnect: (alias) => ipcRenderer.invoke('github:disconnect', alias),
  githubRepositories: (alias) => ipcRenderer.invoke('github:repositories', alias),
  githubSetDefaultRepository: (request) => ipcRenderer.invoke('github:set-default-repository', request),
  vercelConnect: (request) => ipcRenderer.invoke('vercel:connect', request),
  vercelDisconnect: (alias) => ipcRenderer.invoke('vercel:disconnect', alias),
  updaterGetInfo: () => ipcRenderer.invoke('updater:get-info'),
  updaterCheck: () => ipcRenderer.invoke('updater:check'),
  updaterPrepare: () => ipcRenderer.invoke('updater:prepare'),
  updaterCheckLocal: () => ipcRenderer.invoke('updater:check-local'),
  updaterChooseDirectory: () => ipcRenderer.invoke('updater:choose-directory'),
  updaterInstall: () => ipcRenderer.invoke('updater:install'),
  onServerEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('server:event', listener);
    return () => ipcRenderer.removeListener('server:event', listener);
  },
});
