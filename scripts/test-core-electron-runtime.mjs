import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-core-runtime-'));
const handlers = new Map();
const ipcMain = { handle(name, callback) { handlers.set(name, callback); } };
const events = new Map();
const app = {
  isPackaged: false, requestSingleInstanceLock: () => true,
  getPath: () => temp, getVersion: () => '0.4.25',
  on(name, callback) { events.set(name, callback); },
  whenReady: () => Promise.resolve(), quit() { throw new Error('Startup quit unexpectedly'); },
};
class BrowserWindow {
  constructor() { this.webContents = { id: 1, send() {} }; }
  loadFile() {} loadURL() {} on() {} isDestroyed() { return false; }
  static getAllWindows() { return []; }
}
const electron = {
  app, BrowserWindow, ipcMain, safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value), decryptString: (value) => value.toString(),
  },
  dialog: { showOpenDialog: async () => ({ canceled: true }) },
};
Module._load = function (name, parent, isMain) { return name === 'electron' ? electron : originalLoad.call(this, name, parent, isMain); };
try { require('../electron/main.cjs'); } finally { Module._load = originalLoad; }
const event = { sender: { id: 1 } };
const invoke = async (name, ...args) => {
  for (let i = 0; i < 100 && !handlers.has(name); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(handlers.has(name), `Missing IPC handler ${name}`);
  return handlers.get(name)(event, ...args);
};
const availablePort = () => new Promise((resolve) => {
  const socket = net.createServer().listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)); });
});

test('Electron starts Core MCP and retains connections/updater without legacy IPC', async () => {
  const port = await availablePort();
  let client;
  try {
    const settings = await invoke('settings:save', { workspace: process.cwd(), port, permissions: { Terminal: 'Allow' } });
    assert.equal(settings.workspace, process.cwd());
    assert.ok((await invoke('connections:list')).every((entry) => ['github', 'vercel'].includes(entry.provider)));
    assert.ok((await invoke('updater:get-info')).currentVersion);
    assert.ok(!handlers.has('goals:list'));
    assert.ok(!handlers.has('invest-status:get'));
    assert.ok(!handlers.has('x:queue-status'));
    const state = await invoke('server:start');
    assert.equal(state.running, true);
    client = new Client({ name: 'core-runtime-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    const names = (await client.listTools()).tools.map((entry) => entry.name);
    for (const name of ['apply_patch', 'job_start', 'job_status', 'job_output', 'job_stop', 'laya_status', 'github_connections_list', 'vercel_projects_list']) assert.ok(names.includes(name), name);
    assert.ok(names.every((name) => !/^x_|^market_|^hearth_job_|^goal_|^review_queue_/.test(name)));
    const started = await client.callTool({ name: 'job_start', arguments: { command: process.execPath, args: ['-e', 'setTimeout(() => console.log("done"), 2000)'], cwd: '.' } });
    assert.equal(started.isError, undefined);
    const id = JSON.parse(started.content[0].text).job_id;
    await assert.rejects(invoke('server:stop'), /Stop running jobs/);
    assert.equal(JSON.parse((await client.callTool({ name: 'job_status', arguments: { job_id: id } })).content[0].text).status, 'running');
    assert.equal(JSON.parse((await client.callTool({ name: 'job_stop', arguments: { job_id: id } })).content[0].text).stopped, true);
    assert.equal((await invoke('workspace:summary')).path, process.cwd());
    assert.ok((await invoke('jobs:list')).some((job) => job.job_id === id));
  } finally {
    await client?.close();
    await invoke('server:stop').catch(() => {});
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
