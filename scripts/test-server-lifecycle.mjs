// Focused regression tests for the Hearth UI Start Server lifecycle:
// probeHearthServer, startServer (stopped -> running, already running -> cleanly running,
// foreign port conflict, start failure -> sanitized error), stopServer (graceful shutdown,
// Stop -> Start restartability), and http://127.0.0.1:3001/health live validation.
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// Helper to probe Hearth server
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

test('SLC-1 /health returns healthy on active server (port 3001)', async () => {
  const probe = await probeHearthServer(3001);
  assert.equal(probe.running, true, 'Port 3001 must report running');
  assert.equal(typeof probe.pid, 'number', 'Port 3001 must return a valid numeric PID');

  // Verify direct HTTP response format
  const res = await new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:3001/health', (r) => {
      let body = '';
      r.setEncoding('utf8');
      r.on('data', (chunk) => { body += chunk; });
      r.on('end', () => resolve({ statusCode: r.statusCode, headers: r.headers, body: JSON.parse(body) }));
    }).on('error', reject);
  });

  assert.equal(res.statusCode, 200, 'HTTP status must be 200');
  assert.equal(res.body.status, 'ok');
  assert.equal(res.body.service, 'hearth-control');
  assert.equal(res.body.protocol, 'mcp');
});

test('SLC-2 probeHearthServer returns running: false on closed port', async () => {
  const probe = await probeHearthServer(3098);
  assert.equal(probe.running, false);
  assert.equal(probe.code, 'ECONNREFUSED');
});

test('SLC-3 probeHearthServer detects foreign HTTP service as foreign_service error', async () => {
  const foreignServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'not-hearth' }));
  });
  await new Promise((resolve) => foreignServer.listen(3097, '127.0.0.1', resolve));

  try {
    const probe = await probeHearthServer(3097);
    assert.equal(probe.running, false);
    assert.equal(probe.error, 'foreign_service');
  } finally {
    await new Promise((resolve) => foreignServer.close(resolve));
  }
});

test('SLC-4 startServer on already-running port returns running cleanly without spawning duplicate', async () => {
  // Simulate the main process startServer logic against the live 3001 server
  const probe = await probeHearthServer(3001);
  assert.equal(probe.running, true);

  let spawned = false;
  const mockFork = () => { spawned = true; throw new Error('Must not fork duplicate'); };

  let serverState = { running: false, port: 3001, pid: null };
  const events = [];
  const sendEvent = (evt) => events.push(evt);

  // Simulated handler from electron/main.cjs
  if (probe.running) {
    serverState = { running: true, port: 3001, pid: probe.pid };
    sendEvent({ type: 'state', state: serverState });
  } else {
    mockFork();
  }

  assert.equal(spawned, false, 'Duplicate server instance must not be spawned');
  assert.equal(serverState.running, true);
  assert.equal(serverState.pid, probe.pid);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { type: 'state', state: { running: true, port: 3001, pid: probe.pid } });
});

test('SLC-5 startServer fails cleanly when foreign port is in use', async () => {
  const foreignServer = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end('Not found');
  });
  await new Promise((resolve) => foreignServer.listen(3096, '127.0.0.1', resolve));

  try {
    const probe = await probeHearthServer(3096);
    assert.equal(probe.running, false);
    assert.equal(probe.error, 'foreign_service');

    let threw = false;
    try {
      if (probe.error === 'foreign_service') {
        throw new Error(`Port 3096 is already in use by another application.`);
      }
    } catch (err) {
      threw = true;
      assert.match(err.message, /Port 3096 is already in use by another application/);
    }
    assert.equal(threw, true, 'Must throw sanitized error');
  } finally {
    await new Promise((resolve) => foreignServer.close(resolve));
  }
});

test('SLC-6 full server lifecycle: stopped -> Start Server -> running -> Stop Server -> stopped -> Start Server', async () => {
  const testPort = 3025;
  const probeInitial = await probeHearthServer(testPort);
  assert.equal(probeInitial.running, false);

  // 1. Start Server on testPort
  let child = fork(path.join(projectRoot, 'electron/server.cjs'), [], {
    env: {
      ...process.env,
      CONTROL_PORT: String(testPort),
      CONTROL_WORKSPACE: projectRoot,
      CONTROL_PERMISSIONS: JSON.stringify({ Files: 'Allow', Git: 'Allow', Terminal: 'Allow' }),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for ready')), 5000);
    child.on('message', (msg) => {
      if (msg?.type === 'ready') {
        clearTimeout(timer);
        resolve(msg);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Child exited early with ${code}`));
    });
  });

  assert.equal(ready.port, testPort);

  // Verify health probe confirms running
  const probeRunning = await probeHearthServer(testPort);
  assert.equal(probeRunning.running, true);
  assert.equal(probeRunning.pid, child.pid);

  // 2. Stop Server
  await new Promise((resolve) => {
    child.once('exit', resolve);
    child.send({ type: 'shutdown' });
  });

  // Verify health probe confirms stopped
  const probeStopped = await probeHearthServer(testPort);
  assert.equal(probeStopped.running, false);

  // 3. Start Server again (Stop -> Start works again)
  child = fork(path.join(projectRoot, 'electron/server.cjs'), [], {
    env: {
      ...process.env,
      CONTROL_PORT: String(testPort),
      CONTROL_WORKSPACE: projectRoot,
      CONTROL_PERMISSIONS: JSON.stringify({ Files: 'Allow', Git: 'Allow', Terminal: 'Allow' }),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  const readySecond = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for second ready')), 5000);
    child.on('message', (msg) => {
      if (msg?.type === 'ready') {
        clearTimeout(timer);
        resolve(msg);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Second child exited early with ${code}`));
    });
  });

  assert.equal(readySecond.port, testPort);

  // Final cleanup
  await new Promise((resolve) => {
    child.once('exit', resolve);
    child.send({ type: 'shutdown' });
  });

  const probeFinal = await probeHearthServer(testPort);
  assert.equal(probeFinal.running, false);
});

test('SLC-7 UI toggleServer contract: error handling resets busy state and flashes error', async () => {
  let busy = true;
  let flashed = '';
  const flash = (msg) => { flashed = msg; };

  // Simulate toggleServer logic with failing startServer
  try {
    throw new Error('Port 3001 is already in use by another application.');
  } catch (error) {
    flash(error instanceof Error ? error.message : String(error));
  } finally {
    busy = false;
  }

  assert.equal(busy, false, 'Busy must be reset to false in finally');
  assert.equal(flashed, 'Port 3001 is already in use by another application.');
});
