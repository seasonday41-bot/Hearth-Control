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

test('P8 HTTP transport round-trips generic submit/status through Electron parent IPC', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-p8-http-'));
  const port = await reservePort();
  const child = fork(path.join(process.cwd(), 'mcp/http.mjs'), [], {
    cwd: process.cwd(),
    silent: true,
    env: {
      ...process.env,
      CONTROL_PORT: String(port),
      CONTROL_WORKSPACE: root,
      CONTROL_PERMISSIONS: JSON.stringify({
        Files: 'Allow',
        Git: 'Allow',
        Terminal: 'Blocked',
        Browser: 'Blocked',
        X: 'Ask',
      }),
      HEARTH_RUNTIME_DIR: root,
    },
  });

  const requests = [];
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.on('message', (message) => {
    if (message?.type === 'hearth_job_submit_request') {
      requests.push(message);
      child.send({
        type: 'hearth_job_submit_ack',
        transportId: message.transportId,
        ok: true,
        result: {
          accepted: true,
          job_id: message.job.job_id,
          route: 'x',
          status: 'queued',
          detail: { request_id: `hearthjob:${message.job.job_id}` },
        },
      });
    }
    if (message?.type === 'hearth_job_status_request') {
      requests.push(message);
      child.send({
        type: 'hearth_job_status_ack',
        transportId: message.transportId,
        ok: true,
        result: {
          found: true,
          job_id: message.jobId,
          route: 'x',
          status: 'queued',
          detail: { request_id: `hearthjob:${message.jobId}` },
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

    const client = new Client({ name: 'p8-http-test', version: '0.1.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    try {
      const job = {
        version: 'hearth-job-v1',
        job_id: 'http-job-1',
        kind: 'code_inspect',
        objective: 'Inspect one file and report whether it satisfies the requirement.',
        scope: {
          allowed_paths: ['src/App.tsx'],
          preferred_files: ['src/App.tsx'],
          forbidden_paths: [],
        },
        acceptance_criteria: ['Return evidence-backed findings'],
        validation: { required: ['git status --short'], optional: [] },
      };

      const submitResponse = await client.callTool({
        name: 'hearth_job_submit',
        arguments: { job },
      });
      assert.equal(submitResponse.isError, undefined);
      const submit = JSON.parse(submitResponse.content[0].text);
      assert.equal(submit.accepted, true);
      assert.equal(submit.job_id, 'http-job-1');
      assert.equal(submit.route, 'x');

      const statusResponse = await client.callTool({
        name: 'hearth_job_status',
        arguments: { job_id: 'http-job-1' },
      });
      assert.equal(statusResponse.isError, undefined);
      const status = JSON.parse(statusResponse.content[0].text);
      assert.equal(status.found, true);
      assert.equal(status.job_id, 'http-job-1');
    } finally {
      await client.close();
    }

    assert.equal(requests.length, 2);
    const submitRequest = requests.find((item) => item.type === 'hearth_job_submit_request');
    const statusRequest = requests.find((item) => item.type === 'hearth_job_status_request');
    assert.ok(submitRequest);
    assert.ok(statusRequest);
    assert.equal(submitRequest.workspace, root);
    assert.equal(statusRequest.workspace, root);
    assert.equal(submitRequest.job.job_id, 'http-job-1');
    assert.equal(Object.hasOwn(submitRequest.job, 'worker'), false);
    assert.equal(Object.hasOwn(submitRequest.job, 'provider'), false);
    assert.doesNotMatch(JSON.stringify(requests), /credential|authorization|bearer|secret|ciphertext/i);
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
