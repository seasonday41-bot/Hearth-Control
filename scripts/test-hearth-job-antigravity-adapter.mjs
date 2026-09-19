import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { TaskStore } from '../mcp/executors/task-store.mjs';
import {
  startAntigravityTask,
  getAntigravityTask,
  setTaskStore,
  taskRegistry,
} from '../mcp/executors/antigravity.mjs';

test('P8 Antigravity adapter preserves universal identity in authoritative TaskStore', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-p8-antigravity-'));
  const storePath = path.join(root, 'tasks.json');
  const store = new TaskStore({ storagePath: storePath });
  store.load();
  setTaskStore(store);

  const taskId = 'hearthjob:general-smoke';
  const requestId = `${taskId}:${'a'.repeat(64)}`;
  const conversationId = crypto.randomUUID();

  try {
    const result = await startAntigravityTask({
      workspace: root,
      prompt: '[Hearth Universal Job]\n\nObjective: inspect safely',
      title: 'Universal general smoke',
      customAgentApiPath: '/mock/bin/agentapi',
      runner: async () => ({
        stdout: JSON.stringify({
          response: {
            conversationMetadata: {
              metadata: { rootConversationId: conversationId },
            },
          },
        }),
        stderr: '',
      }),
      userApproved: true,
      awaitCompletion: false,
      source: 'local',
      requestId,
      requestedRoute: 'auto',
      resolvedRoute: 'antigravity',
      routeReason: 'Hearth Router · general work uses Antigravity',
      existingTaskId: taskId,
    });

    assert.equal(result.taskId, taskId);
    assert.equal(result.conversationId, conversationId);

    const persisted = store.getTask(taskId);
    assert.ok(persisted);
    assert.equal(persisted.taskId, taskId);
    assert.equal(persisted.requestId, requestId);
    assert.equal(persisted.requestedRoute, 'auto');
    assert.equal(persisted.resolvedRoute, 'antigravity');
    assert.equal(persisted.routeReason, 'Hearth Router · general work uses Antigravity');

    const publicTask = getAntigravityTask(taskId);
    assert.equal(publicTask.taskId, taskId);
    assert.equal(publicTask.status, 'running');
  } finally {
    const raw = taskRegistry.get(taskId);
    try { raw?.cleanup?.(); } catch {}
    taskRegistry.delete(taskId);
    setTaskStore(null);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
