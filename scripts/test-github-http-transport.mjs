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

const waitFor = (emitter, event, timeoutMs = 5000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), timeoutMs);
  emitter.once(event, (...args) => {
    clearTimeout(timer);
    resolve(args);
  });
});

test('P4 HTTP transport round-trips GitHub read request through parent IPC with no credential material', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-p4-http-'));
  const port = await reservePort();
  const child = fork(path.join(process.cwd(), 'mcp/http.mjs'), [], {
    cwd: process.cwd(),
    silent: true,
    env: {
      ...process.env,
      CONTROL_PORT: String(port),
      CONTROL_WORKSPACE: root,
      CONTROL_PERMISSIONS: JSON.stringify({ Git: 'Allow', Files: 'Allow', Terminal: 'Blocked', Browser: 'Blocked' }),
      HEARTH_RUNTIME_DIR: root,
    },
  });

  const requests = [];
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.on('message', (message) => {
    if (message?.type === 'github_repositories_list_request') {
      requests.push(message);
      child.send({
        type: 'github_repositories_list_ack',
        transportId: message.transportId,
        ok: true,
        result: {
          repositories: [{ fullName: 'work/example', private: true }],
          rateLimit: { remaining: 42, resetAt: 123000 },
        },
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

    const client = new Client({ name: 'p4-http-test', version: '0.1.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    try {
      const response = await client.callTool({
        name: 'github_repositories_list',
        arguments: { connection: 'github:work', page: 1, per_page: 30 },
      });
      assert.equal(response.isError, undefined);
      const body = JSON.parse(response.content[0].text);
      assert.equal(body.repositories[0].fullName, 'work/example');
    } finally {
      await client.close();
    }

    assert.equal(requests.length, 1);
    assert.equal(requests[0].connection, 'github:work');
    assert.equal(requests[0].page, 1);
    assert.equal(requests[0].perPage, 30);
    const serialized = JSON.stringify(requests[0]);
    assert.doesNotMatch(serialized, /token|credential|authorization|bearer|secret|ciphertext/i);
  } finally {
    try { child.send({ type: 'shutdown' }); } catch {}
    if (child.exitCode === null) {
      await Promise.race([
        waitFor(child, 'exit', 2000).catch(() => null),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    }
    if (child.exitCode === null) child.kill('SIGTERM');
    fs.rmSync(root, { recursive: true, force: true });
  }
});
