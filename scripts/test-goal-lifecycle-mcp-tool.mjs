import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fork } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { registerWorkspaceTools, toolNames } from '../mcp/tools.mjs';

const body = (result) => JSON.parse(result.content[0].text);

test('Goal lifecycle tools register, forward authored steps, and fail closed without a live transport', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-goal-mcp-'));
  try {
    const tools = new Map();
    const server = { registerTool: (name, config, handler) => tools.set(name, { config, handler }) };
    const calls = [];
    registerWorkspaceTools(server, {
      workspace: root,
      permissions: {},
      goalTransport: {
        createGoal: async (args) => { calls.push(['create', args]); return { id: 'goal-1', status: 'draft' }; },
        runGoal: async (args) => { calls.push(['run', args]); return { id: args.goalId, status: 'waiting' }; },
        resumeGoal: async (args) => { calls.push(['resume', args]); return { id: args.goalId, status: 'completed' }; },
      },
    });

    for (const name of ['goal_create', 'goal_run', 'goal_resume']) {
      assert.ok(toolNames.includes(name));
      assert.ok(tools.has(name));
    }
    const steps = [{ id: 'step-1', title: 'Run X', route: 'x', xTask: { version: 'x-task-v1', task_id: 'task-1' } }];
    assert.equal(tools.get('goal_create').config.inputSchema.steps.safeParse(steps).success, true);
    assert.deepEqual(body(await tools.get('goal_create').handler({ title: 'Goal', objective: 'Test', steps, constraints: ['Keep state'] })), { id: 'goal-1', status: 'draft' });
    assert.deepEqual(body(await tools.get('goal_run').handler({ goal_id: 'goal-1' })), { id: 'goal-1', status: 'waiting' });
    assert.deepEqual(body(await tools.get('goal_resume').handler({ goal_id: 'goal-1' })), { id: 'goal-1', status: 'completed' });
    assert.deepEqual(calls, [
      ['create', { title: 'Goal', objective: 'Test', steps, constraints: ['Keep state'] }],
      ['run', { goalId: 'goal-1' }],
      ['resume', { goalId: 'goal-1' }],
    ]);

    const disconnected = new Map();
    registerWorkspaceTools({ registerTool: (name, config, handler) => disconnected.set(name, handler) }, { workspace: root, permissions: {} });
    for (const name of ['goal_create', 'goal_run', 'goal_resume']) {
      assert.deepEqual(body(await disconnected.get(name)(name === 'goal_create'
        ? { title: 'Goal', objective: 'Test', steps }
        : { goal_id: 'goal-1' })), { error: 'transport_unavailable' });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const reservePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close((error) => error ? reject(error) : resolve(port));
  });
});

test('Goal lifecycle HTTP tools round-trip through the existing parent IPC channel', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-goal-http-'));
  const port = await reservePort().catch((error) => {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  });
  const child = fork(path.join(process.cwd(), 'mcp/http.mjs'), [], {
    cwd: process.cwd(),
    silent: true,
    env: { ...process.env, CONTROL_PORT: String(port), CONTROL_WORKSPACE: root, CONTROL_PERMISSIONS: '{}' },
  });
  const requests = [];
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.on('message', (message) => {
    if (!['goal_create_request', 'goal_run_request', 'goal_resume_request'].includes(message?.type)) return;
    requests.push(message);
    child.send({
      type: message.type.replace(/_request$/, '_ack'),
      transportId: message.transportId,
      ok: message.type !== 'goal_resume_request',
      result: { id: 'goal-1', status: message.type === 'goal_create_request' ? 'draft' : 'waiting' },
      error: message.type === 'goal_resume_request' ? 'review_required' : null,
    });
  });

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`HTTP child did not become ready: ${stderr}`)), 5000);
      child.on('message', (message) => {
        if (message?.type === 'ready') { clearTimeout(timer); resolve(); }
      });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`HTTP child exited with ${code}: ${stderr}`)); });
    });

    const client = new Client({ name: 'goal-lifecycle-test', version: '0.1.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    try {
      const steps = [{ title: 'X step', route: 'x', xTask: { version: 'x-task-v1' } }];
      assert.deepEqual(body(await client.callTool({ name: 'goal_create', arguments: { title: 'Goal', objective: 'Test', steps: [{ ...steps[0], status: 'completed' }] } })), { id: 'goal-1', status: 'draft' });
      assert.deepEqual(body(await client.callTool({ name: 'goal_run', arguments: { goal_id: 'goal-1' } })), { id: 'goal-1', status: 'waiting' });
      assert.deepEqual(body(await client.callTool({ name: 'goal_resume', arguments: { goal_id: 'goal-1' } })), { error: 'review_required' });
      assert.equal(requests.length, 3);
      assert.deepEqual(requests.map((request) => request.type), ['goal_create_request', 'goal_run_request', 'goal_resume_request']);
      assert.deepEqual(requests[0].steps, steps);
      assert.equal(requests[1].goalId, 'goal-1');
      assert.equal(requests[2].goalId, 'goal-1');
    } finally {
      await client.close();
    }
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(root, { recursive: true, force: true });
  }
});
