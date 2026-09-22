import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fork } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const reservePort = async () => await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close((error) => error ? reject(error) : resolve(port));
  });
});

test('P6 HTTP transport round-trips Vercel read request with no credential material', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-p6-http-'));
  const port = await reservePort();
  const child = fork(path.join(process.cwd(), 'mcp/http.mjs'), [], {
    cwd: process.cwd(),
    silent: true,
    env: {
      ...process.env,
      CONTROL_PORT: String(port),
      CONTROL_WORKSPACE: root,
      CONTROL_PERMISSIONS: JSON.stringify({ Git: 'Blocked', Files: 'Allow', Terminal: 'Blocked', Browser: 'Blocked', Vercel: 'Allow' }),
      HEARTH_RUNTIME_DIR: root,
    },
  });

  const requests = [];
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.on('message', (message) => {
    if (message?.type === 'vercel_projects_list_request') {
      requests.push(message);
      child.send({
        type: 'vercel_projects_list_ack',
        transportId: message.transportId,
        ok: true,
        result: { projects: [{ id: 'prj_1', name: 'app' }] },
      });
    }
  });

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`HTTP child did not become ready: ${stderr}`)), 5000);
      const onMessage = (message) => {
        if (message?.type === 'ready') {
          clearTimeout(timer);
          child.off('message', onMessage);
          resolve();
        }
      };
      child.on('message', onMessage);
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`HTTP child exited early with ${code}: ${stderr}`));
      });
    });

    const client = new Client({ name: 'p6-http-test', version: '0.1.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    try {
      const response = await client.callTool({
        name: 'vercel_projects_list',
        arguments: { connection: 'vercel:main', team_id: 'team_abc123', limit: 10 },
      });
      const body = JSON.parse(response.content[0].text);
      assert.equal(body.projects[0].id, 'prj_1');
    } finally {
      await client.close();
    }

    assert.equal(requests.length, 1);
    assert.equal(requests[0].connection, 'vercel:main');
    assert.equal(requests[0].teamId, 'team_abc123');
    const serialized = JSON.stringify(requests[0]);
    assert.doesNotMatch(serialized, /token|credential|authorization|bearer|secret|ciphertext/i);
  } finally {
    try { child.send({ type: 'shutdown' }); } catch {}
    if (child.exitCode === null) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 1500);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    if (child.exitCode === null) child.kill('SIGTERM');
    fs.rmSync(root, { recursive: true, force: true });
  }
});
