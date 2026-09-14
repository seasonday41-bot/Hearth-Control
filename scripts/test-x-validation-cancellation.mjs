import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { XClaimStore } from '../mcp/x/claim-store.mjs';
import { XRunStore } from '../mcp/x/run-store.mjs';
import { X_TASK_VERSION } from '../mcp/x/task-contract.mjs';
import { runXTask } from '../mcp/x/run-x-task.mjs';

/**
 * Closes the one integration gap identified in the prior runXTask safety
 * review: no existing test proved that ownership loss actually reaches a
 * REAL, already-spawned validation child process and kills it (SIGTERM /
 * SIGKILL, via validation-runner.mjs's own abort-signal handling), rather
 * than merely aborting the in-process JS promise while the real OS child
 * keeps running to completion in the background.
 *
 * Test-only: no frozen module is modified. The proof technique is a
 * REAL, slow `node --test` validation script (matching validation-runner's
 * only allowlisted command shape) that writes an observable "started"
 * marker immediately, sleeps briefly, then writes a "finished" marker. If
 * the child is genuinely killed mid-sleep, "started" exists but "finished"
 * never does, even after waiting well past the child's own sleep duration
 * -- if the child were merely abandoned in the background (not actually
 * killed), "finished" would eventually appear.
 */

const dirs = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-x-validation-cancel-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'scripts'));
  dirs.push(root);
  return root;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function taskFor(root, taskId = 'task-x-1') {
  return {
    version: X_TASK_VERSION, task_id: taskId, parent_task_id: null,
    revision: 1, attempt: 1, based_on_result_id: null,
    objective: 'Prove real validation-child cancellation.', problem: 'No integration test covered the real kill path.',
    expected_behavior: 'Ownership loss actually terminates a real, in-flight validation child.',
    observed_behavior: 'Only fake in-process model hangs were previously tested.',
    why_this_matters: 'A merely-aborted promise with a still-running child is a real concurrency hazard.',
    known_evidence: [], suspected_area: [], workspace: { repo: 'Hearth-Control', root },
    scope: { allowed_paths: ['src'], preferred_files: [], forbidden_paths: [] },
    constraints: { preserve: [], do_not: [] }, allowed_tools: ['repo_read'],
    acceptance_criteria: ['The real validation child is killed on ownership loss.'],
    validation: { required: ['node --test scripts/test-slow.mjs'], optional: [] },
    verification: null, done_criteria: ['Validation completes or is genuinely terminated.'], teaching_notes: [],
    uncertainty_policy: { policy: 'bounded_autonomy', stop_conditions: [] },
    repair_budget: { initial_attempts: 1, max_repairs: 2, max_total_rounds: 3 },
    timing: { estimated_minutes: 5, first_check_after_minutes: 1, soft_deadline_minutes: 3, hard_timeout_minutes: 10 },
    commit_policy: { mode: 'never' },
  };
}

const model = (actions = []) => ({
  async generate() {
    return { ok: true, provider: 'fake', model: 'fake', text: JSON.stringify({ actions }), finishReason: 'stop', usage: null, error: null };
  },
});

async function waitForFile(filePath, { timeoutMs = 4000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${filePath}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

test('a real, in-flight validation child is actually killed (not merely abandoned) when ownership is lost', async () => {
  const root = fixture();
  const startedMarker = path.join(root, 'started.marker');
  const finishedMarker = path.join(root, 'finished.marker');

  // A real node:test file: writes "started" immediately, sleeps 1.2s, then
  // writes "finished". If it is genuinely SIGTERM/SIGKILL-ed mid-sleep,
  // "finished" must never appear, even well after the 1.2s would have elapsed.
  fs.writeFileSync(path.join(root, 'scripts/test-slow.mjs'), `
import test from 'node:test';
import fs from 'node:fs';
test('slow', async () => {
  fs.writeFileSync(${JSON.stringify(startedMarker)}, '1');
  await new Promise((resolve) => setTimeout(resolve, 1200));
  fs.writeFileSync(${JSON.stringify(finishedMarker)}, '1');
});
`);

  const dbPath = path.join(root, 'hearth-runtime.sqlite');
  const claims = new XClaimStore({ storagePath: dbPath, leaseDurationMs: 1000 });
  const otherClaims = new XClaimStore({ storagePath: dbPath, leaseDurationMs: 1000 });
  const runs = new XRunStore({ storagePath: dbPath });

  try {
    const admitted = await runXTask(
      taskFor(root),
      model([{ type: 'create', path: 'src/ok.js', content: 'ok\n' }]),
      {
        claimStore: claims,
        runStore: runs,
        ownerId: 'owner-a',
        leaseDurationMs: 1000,
      },
    );
    assert.equal(admitted.accepted, true);

    // Wait until the REAL validation child has genuinely started (not the model call -- the model resolves instantly).
    await waitForFile(startedMarker);

    // Confirmed ownership loss: another owner releases the exact lease runXTask is holding.
    const active = claims.getActiveClaim('task-x-1');
    assert.ok(active);
    const leaseId = active.leaseId;
    assert.equal(otherClaims.release({ taskId: 'task-x-1', ownerId: 'owner-a', leaseId }), true);

    const result = await admitted.done;

    assert.equal(result.status, 'ownership_lost');
    assert.equal(
      runs.getRun(admitted.runId).status,
      'running',
      'a lost-ownership run must remain nonterminal, never a persisted result',
    );
    assert.equal(runs.getRun(admitted.runId).result, null);

    // Wait longer than the child's own 1.2s lifetime.
    // If it was merely abandoned instead of killed, finished.marker will appear.
    await new Promise((r) => setTimeout(r, 1500));

    assert.equal(
      fs.existsSync(finishedMarker),
      false,
      'validation child must remain terminated; it must not continue in background',
    );
  } finally {
    claims.close();
    otherClaims.close();
    runs.close();
  }
});
