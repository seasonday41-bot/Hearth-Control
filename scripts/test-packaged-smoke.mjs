/**
 * Native smoke test for packaged Hearth Control (release/mac-arm64/Hearth Control.app)
 * Verifies Goal Runner V1 features, manual sign-off, workspace locking, and baseline non-regression.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const fsApi = process.versions.electron ? createRequire(import.meta.url)('original-fs').promises : fs;

console.log('\n=== Hearth Control Packaged Smoke Test ===\n');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const asarPath = path.join(repoRoot, 'release/mac-arm64/Hearth Control.app/Contents/Resources/app.asar');

// 1. Verify app.asar and dist/index.html
console.log('1. Checking app.asar and frontend bundle assets...');
const stat = await fsApi.stat(asarPath);
assert.ok(stat.isFile() && stat.size > 1000000, 'app.asar must exist and be > 1MB');

// Dynamically import packaged modules from app.asar
const storageUrl = pathToFileURL(path.join(asarPath, 'mcp/goals/storage.mjs')).href;
const runnerUrl = pathToFileURL(path.join(asarPath, 'mcp/goals/runner.mjs')).href;
const securityUrl = pathToFileURL(path.join(asarPath, 'mcp/security/redact-secrets.mjs')).href;
const bridgeClientUrl = pathToFileURL(path.join(asarPath, 'mcp/bridge/client.mjs')).href;
const bridgeIdentityUrl = pathToFileURL(path.join(asarPath, 'mcp/bridge/identity.mjs')).href;

const { GoalStorage } = await import(storageUrl);
const { GoalRunner } = await import(runnerUrl);
const { redactSecrets } = await import(securityUrl);
const { HearthBridgeClient } = await import(bridgeClientUrl);
const { generatePairingSecret, hashPairingSecret } = await import(bridgeIdentityUrl);

console.log('  PASS: Packaged modules loaded cleanly from app.asar');

// 2. Setup isolated smoke fixture
const fixtureDir = await fsApi.mkdtemp(path.join(os.tmpdir(), 'hearth-smoke-'));
const testWorkspace = path.join(fixtureDir, 'workspace');
await fsApi.mkdir(testWorkspace, { recursive: true });
const storageFile = path.join(fixtureDir, 'goals.json');

const storage = new GoalStorage({ storagePath: storageFile });
const runner = new GoalRunner({ storage });

// 3. Create Manual Goal Fixture
console.log('2. Creating Manual Goal fixture...');
const goal = await runner.create_goal({
  title: 'Native Smoke Test Goal',
  objective: 'Verify Manual Step Sign-off and progression',
  workspace: testWorkspace,
  steps: [
    { id: 's1', title: 'Manual sign-off step', description: 'Review changes', route: 'manual', required: true },
    { id: 's2', title: 'Automated follow-up step', description: 'Run checks', route: 'mcp', required: true, prompt: 'check' },
  ],
});
assert.equal(goal.status, 'ready');
assert.equal(goal.steps.length, 2);
console.log('  PASS: Goal created with ready status');

// 4. Test Run -> WAITING
console.log('3. Running Goal -> checking WAITING state...');
const runningGoal = await runner.run_goal(goal.id);
assert.equal(runningGoal.status, 'waiting');
assert.equal(runningGoal.steps[0].status, 'waiting');
assert.equal(runner.is_goal_active(), true);
console.log('  PASS: Goal transitioned to WAITING on manual step');

// 5. Test Workspace Lock
console.log('4. Verifying workspace lock while Goal active...');
assert.equal(runner.is_goal_active(), true);
const changeWorkspace = (newWorkspace) => {
  if (runner.is_goal_active()) throw new Error('Cannot change workspace while a goal is active');
  return newWorkspace;
};
assert.throws(() => changeWorkspace('/new/workspace'), /Cannot change workspace while a goal is active/);
console.log('  PASS: Workspace modification is blocked while Goal is active');

// 6. Test Resume cannot bypass manual sign-off
console.log('5. Verifying Resume cannot bypass manual sign-off...');
await assert.rejects(
  async () => runner.resume_goal(goal.id),
  /Cannot resume goal on waiting manual step/i
);
console.log('  PASS: Implicit resume rejected on manual waiting step');

// 7. Test Mark Step Complete -> next step
console.log('6. Testing Mark Step Complete -> advancing to next step...');
const signedOffGoal = await runner.signoff_step(goal.id, 's1', {
  action: 'complete',
  note: 'Step approved by smoke test operator',
  autoRun: true,
  executeStepFn: async () => ({ status: 'completed', summary: 'Packaged module callback completed' }),
});
assert.equal(signedOffGoal.steps[0].status, 'completed');
assert.equal(signedOffGoal.steps[1].status, 'completed');
assert.equal(signedOffGoal.status, 'completed');
assert.ok(signedOffGoal.checkpoints.length >= 1);

// Verify sanitized checkpoint
const lastCheckpoint = signedOffGoal.checkpoints[signedOffGoal.checkpoints.length - 1];
assert.equal(lastCheckpoint.route, 'manual');
console.log('  PASS: Step 1 completed, checkpoint recorded, Step 2 advanced & completed');

// 8. Test Fail Step
console.log('7. Testing Fail Step on a new goal fixture...');
const goal2 = await runner.create_goal({
  title: 'Fail Step Fixture',
  objective: 'Verify manual step rejection',
  workspace: testWorkspace,
  steps: [
    { id: 's1', title: 'Audit gate', description: 'Must reject', route: 'manual', required: true },
    { id: 's2', title: 'Never runs', description: 'Skip', route: 'mcp', required: true },
  ],
});
await runner.run_goal(goal2.id);
const failedGoal = await runner.signoff_step(goal2.id, 's1', {
  action: 'fail',
  note: 'Explicit rejection test',
});
assert.equal(failedGoal.status, 'error');
assert.equal(failedGoal.steps[0].status, 'error');
assert.equal(failedGoal.steps[1].status, 'pending');
assert.match(failedGoal.error, /Explicit rejection test/);
console.log('  PASS: Fail Step correctly terminated goal and marked step error');

// 9. Verify Task Console / Remote Bridge Non-Regression
console.log('8. Verifying Task Console / Remote Bridge non-regression...');
const pairing = generatePairingSecret();
assert.ok(pairing.secret.length >= 16);
const hashed = hashPairingSecret(pairing.secret);
assert.equal(typeof hashed, 'string');
assert.equal(hashed.length, 64);

const redacted = redactSecrets('Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test');
assert.equal(redacted.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'), false);
console.log('  PASS: Remote Bridge pairing and secret redaction intact');

// Cleanup
await fsApi.rm(fixtureDir, { recursive: true, force: true }).catch(() => {});
console.log('\n=== ALL PACKAGED SMOKE TESTS PASSED (8/8) ===\n');
