import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { X_TASK_VERSION } from '../x/task-contract.mjs';
import { createXCoderService } from './server.mjs';

const live = process.env.X_CODER_LIVE_OLLAMA === '1' ? test : test.skip;

live('S7.5-live default service executor reaches Ollama/Qwen and returns a real RepairOutcome', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-x-coder-live-'));
  const serviceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-x-coder-live-db-'));
  try {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'context.txt'), 'This is a read-only live model smoke fixture.\n');
    fs.writeFileSync(
      path.join(root, 'scripts', 'test-pass.mjs'),
      "import test from 'node:test';\ntest('ok', () => {});\n",
    );

    const task = {
      version: X_TASK_VERSION,
      task_id: 'TASK-X-CODER-LIVE-OLLAMA',
      parent_task_id: null,
      revision: 1,
      attempt: 1,
      based_on_result_id: null,
      objective: 'Inspect the provided read-only context and make no repository edits.',
      problem: 'The standalone X Coder Service real executor needs a live-model smoke proof.',
      expected_behavior: 'The model returns structured JSON and the task validates without mutation.',
      observed_behavior: 'Only deterministic model fixtures have been used in automated extraction tests.',
      why_this_matters: 'The extracted process must actually reach the configured local Ollama/Qwen model.',
      known_evidence: ['This is a read-only smoke; return actions: [].'],
      suspected_area: ['src/context.txt'],
      workspace: { repo: 'live-smoke-fixture', root },
      scope: { allowed_paths: ['src'], preferred_files: ['src/context.txt'], forbidden_paths: [] },
      constraints: { preserve: ['Do not modify files.'], do_not: ['Do not propose repository edits.'] },
      allowed_tools: ['repo_read'],
      acceptance_criteria: ['The response is structured and required validation passes.'],
      validation: { required: ['node --test scripts/test-pass.mjs'], optional: [] },
      verification: null,
      done_criteria: ['A real RepairOutcome is returned through the service.'],
      teaching_notes: [],
      uncertainty_policy: { policy: 'bounded_autonomy', stop_conditions: [] },
      repair_budget: { initial_attempts: 1, max_repairs: 0, max_total_rounds: 1 },
      timing: { estimated_minutes: 5, first_check_after_minutes: 1, soft_deadline_minutes: 3, hard_timeout_minutes: 10 },
      commit_policy: { mode: 'never' },
    };

    const service = createXCoderService({
      storagePath: path.join(serviceDir, 'idempotency.sqlite'),
    });
    const submitted = service.submit({
      version: 'x-executor-api-v1',
      idempotency_key: 'live-ollama-smoke',
      lease_expires_at: Date.now() + 180_000,
      task,
    });

    await service.registry.waitForAttachedRun(submitted.run_id);
    const status = service.getStatus({ version: 'x-executor-api-v1', run_id: submitted.run_id });

    assert.equal(status.status, 'completed');
    assert.equal(status.error, null);
    assert.equal(status.result.task_id, task.task_id);
    assert.equal(status.result.status, 'validated');
    assert.equal(status.result.total_rounds, 1);
    assert.equal(status.result.rounds[0].executor.model_metadata.provider, 'ollama');
    assert.match(status.result.rounds[0].executor.model_metadata.model, /^qwen/i);
    assert.deepEqual(fs.readdirSync(path.join(root, 'src')).sort(), ['context.txt']);

    service.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(serviceDir, { recursive: true, force: true });
  }
});
