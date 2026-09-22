import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { XClaimStore } from '../mcp/x/claim-store.mjs';
import { XRunStore } from '../mcp/x/run-store.mjs';
import { XLeaseKeeper } from '../mcp/x/lease-keeper.mjs';
import { cancelXTask } from '../mcp/x/cancel-x-task.mjs';
import { XCoderClient } from '../mcp/x/x-coder-client.mjs';
import { createOllamaModelAdapter } from '../mcp/x/model-adapter.mjs';
import { RealXCoderExecutor } from '../mcp/x-coder-service/real-executor.mjs';
import { startXCoderHttpServer } from '../mcp/x-coder-service/server.mjs';

const sha256 = (value) => crypto.createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex');
const tmpRoots = [];
const tmpDir = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
};

const makeTask = (root, { taskId, allowedTools = ['repo_read'], suspectedArea = [], validation } = {}) => ({
  version: 'x-task-v1',
  task_id: taskId,
  parent_task_id: null,
  revision: 1,
  attempt: 1,
  based_on_result_id: null,
  objective: allowedTools.includes('repo_edit')
    ? 'Update src/target.js safely. Return only the structured JSON action object required by the executor.'
    : 'Inspect the provided repository context. Do not modify files. Return the structured JSON response required by the executor with an empty actions array.',
  problem: 'Prove the extracted X Coder Service can run through the real local Ollama model path.',
  expected_behavior: 'The real model request completes through the existing ModelAdapter and Core X repair loop.',
  observed_behavior: 'This is the pre-cutover standalone verification.',
  why_this_matters: 'Slice 7.5 must prove real model execution before Hearth production cutover.',
  known_evidence: [],
  suspected_area: suspectedArea,
  workspace: { repo: 'fixture-repo', root },
  scope: { allowed_paths: ['src'], preferred_files: suspectedArea, forbidden_paths: [] },
  constraints: { preserve: ['all files outside the requested target'], do_not: ['do not widen scope'] },
  allowed_tools: allowedTools,
  acceptance_criteria: ['The standalone service returns a real RepairOutcome.'],
  validation: validation ?? { required: ['node --test scripts/test-pass.mjs'], optional: [] },
  done_criteria: ['The result is bounded and evidence-backed.'],
  teaching_notes: [],
  uncertainty_policy: { policy: 'bounded_autonomy', stop_conditions: [] },
  repair_budget: { initial_attempts: 1, max_repairs: 0, max_total_rounds: 1 },
  timing: { estimated_minutes: 5, first_check_after_minutes: 1, soft_deadline_minutes: 3, hard_timeout_minutes: 10 },
  commit_policy: { mode: 'never' },
});

const realAdapter = () => createOllamaModelAdapter({
  providerOptions: {
    model: 'qwen3:8b',
    profile: 'fast',
    timeoutMs: 30_000,
  },
});

async function main() {
  let runtime = null;
  let claimStore = null;
  let runStore = null;
  let keeper = null;

  try {
    const readRoot = tmpDir('hearth-x-real-ollama-read-');
    fs.mkdirSync(path.join(readRoot, 'src'), { recursive: true });
    fs.mkdirSync(path.join(readRoot, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(readRoot, 'src/readme.txt'), 'fixture context\n');
    fs.writeFileSync(path.join(readRoot, 'scripts/test-pass.mjs'), "import test from 'node:test';\ntest('ok', () => {});\n");

    const readServiceDb = path.join(tmpDir('hearth-x-real-ollama-db-'), 'idempotency.sqlite');
    runtime = await startXCoderHttpServer({
      storagePath: readServiceDb,
      port: 0,
      executor: new RealXCoderExecutor({
        modelAdapter: realAdapter(),
        executionOptions: {
          modelOptions: {
            model: 'qwen3:8b',
            think: false,
            num_ctx: 4096,
            num_predict: 256,
            temperature: 0,
            timeoutMs: 30_000,
          },
        },
      }),
    });
    let client = new XCoderClient({ baseUrl: 'http://127.0.0.1:' + runtime.port, timeoutMs: 35_000 });
    const readTask = makeTask(readRoot, { taskId: 'TASK-S7.5-REAL-OLLAMA-READ' });
    const readSubmit = await client.submit({
      idempotencyKey: 's7.5-real-ollama-read',
      task: readTask,
      leaseExpiresAt: Date.now() + 60_000,
    });
    await runtime.service.registry.waitForAttachedRun(readSubmit.runId);
    const readStatus = await client.getStatus(readSubmit.runId);

    assert.equal(readStatus.status, 'completed');
    assert.ok(readStatus.result && typeof readStatus.result === 'object');
    assert.equal(readStatus.result.task_id, readTask.task_id);
    assert.ok(['validated', 'escalation_required'].includes(readStatus.result.status));
    assert.ok(Array.isArray(readStatus.result.rounds));
    const providerNames = readStatus.result.rounds
      .map((round) => round.executor?.model_metadata?.provider)
      .filter(Boolean);
    assert.ok(providerNames.includes('ollama'), 'RepairOutcome must contain evidence from the real Ollama provider');

    await runtime.stop();
    runtime = null;

    const writeRoot = tmpDir('hearth-x-real-ollama-write-');
    fs.mkdirSync(path.join(writeRoot, 'src'), { recursive: true });
    fs.mkdirSync(path.join(writeRoot, 'scripts'), { recursive: true });
    const target = path.join(writeRoot, 'src/target.js');
    const original = 'export const value = "before";\n';
    fs.writeFileSync(target, original);
    fs.writeFileSync(path.join(writeRoot, 'scripts/test-pass.mjs'), "import test from 'node:test';\ntest('ok', () => {});\n");
    const beforeStat = fs.statSync(target, { bigint: true });
    const beforeHash = sha256(fs.readFileSync(target, 'utf8'));

    let writerEnteredResolve;
    const writerEntered = new Promise((resolve) => { writerEnteredResolve = resolve; });
    let writerEnteredOnce = false;
    const writeLimits = {
      get maxBytesPerWrite() {
        if (!writerEnteredOnce) {
          writerEnteredOnce = true;
          writerEnteredResolve();
        }
        return 200_000;
      },
    };

    const genuine = realAdapter();
    let genuineModelCalls = 0;
    const genuineThenDeterministic = {
      async generate(request, options) {
        genuineModelCalls += 1;
        const observed = await genuine.generate(request, {
          ...options,
          model: 'qwen3:8b',
          think: false,
          num_ctx: 4096,
          num_predict: 192,
          temperature: 0,
          timeoutMs: 30_000,
        });
        if (!observed.ok) return observed;
        return {
          ...observed,
          text: JSON.stringify({
            actions: [{
              type: 'replace',
              path: 'src/target.js',
              content: 'export const value = "after";\n',
            }],
            explanation: 'Deterministic race fixture after a genuine local Ollama call.',
            confidence: 1,
          }),
        };
      },
    };

    const writeDb = path.join(tmpDir('hearth-x-real-ollama-write-db-'), 'idempotency.sqlite');
    runtime = await startXCoderHttpServer({
      storagePath: writeDb,
      port: 0,
      executor: new RealXCoderExecutor({
        modelAdapter: genuineThenDeterministic,
        executionOptions: { writeLimits },
      }),
    });
    client = new XCoderClient({ baseUrl: 'http://127.0.0.1:' + runtime.port, timeoutMs: 35_000 });

    const hearthDb = path.join(tmpDir('hearth-x-real-ollama-hearth-'), 'hearth-runtime.sqlite');
    claimStore = new XClaimStore({ storagePath: hearthDb, leaseDurationMs: 120_000 });
    runStore = new XRunStore({ storagePath: hearthDb });
    const task = makeTask(writeRoot, {
      taskId: 'TASK-S7.5-REAL-OLLAMA-CANCEL',
      allowedTools: ['repo_read', 'repo_edit'],
      suspectedArea: ['src/target.js'],
    });
    const claim = claimStore.claim({ taskId: task.task_id, ownerId: 'owner-real-ollama-cancel' });
    keeper = new XLeaseKeeper({ claimStore, claim }).start();

    const submitted = await client.submit({
      idempotencyKey: 's7.5-real-ollama-cancel',
      task,
      leaseExpiresAt: claim.leaseExpiresAt,
    });
    runStore.createRun({ runId: submitted.runId, taskId: task.task_id, claimLeaseId: claim.leaseId });
    runStore.markRunning({ runId: submitted.runId, claimLeaseId: claim.leaseId });

    await writerEntered;
    assert.equal(genuineModelCalls, 1, 'cancel race must occur after one genuine Ollama request completed');

    const cancelResult = await cancelXTask({
      runId: submitted.runId,
      taskId: task.task_id,
      claim,
      claimStore,
      runStore,
      keeper,
      xCoderClient: client,
    });
    keeper = null;

    assert.equal(cancelResult.cancelled, true);
    assert.equal(cancelResult.run.status, 'cancelled');
    assert.equal((await client.getStatus(submitted.runId)).status, 'cancelled');

    const afterContent = fs.readFileSync(target, 'utf8');
    const afterStat = fs.statSync(target, { bigint: true });
    assert.equal(afterContent, original);
    assert.equal(sha256(afterContent), beforeHash);
    assert.equal(afterStat.size, beforeStat.size);
    assert.equal(afterStat.mtimeNs, beforeStat.mtimeNs, 'target mtime must remain unchanged: no publish occurred');
    assert.equal(fs.readdirSync(path.dirname(target)).some((name) => name.startsWith('.x-write-tmp-')), false);

    process.stdout.write(JSON.stringify({
      status: 'PASS',
      model: 'qwen3:8b',
      read_repair_status: readStatus.result.status,
      real_model_calls_before_cancel: genuineModelCalls,
      cancel_status: cancelResult.status,
      target_hash_unchanged: true,
      target_mtime_unchanged: true,
      temp_residue: false,
    }) + '\n');
  } finally {
    if (keeper) await keeper.stop().catch(() => {});
    if (runtime) await runtime.stop().catch(() => {});
    runStore?.close();
    claimStore?.close();
    for (const root of tmpRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
