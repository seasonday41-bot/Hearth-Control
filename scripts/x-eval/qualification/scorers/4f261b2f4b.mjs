// Hidden scorer: getUpdaterRuntimeBlocker (electron/main.cjs) must consult the
// X wakeup-deadline function that actually exists in main.cjs's scope. Independent
// of the visible test: it EXECUTES the helper against fakes instead of matching
// its source text. The sandbox defines ONLY `xGetNextWakeupDeadline` (the real
// identifier), so a reference to any other name behaves as it would in main.cjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createScorer, parseRoot } from './_lib.mjs';

const root = parseRoot();
const s = createScorer();
const require = createRequire(path.join(root, 'electron', 'x.cjs'));
let localUpdater; let makeBlocker;
await s.check('extract getUpdaterRuntimeBlocker from electron/main.cjs', () => {
  localUpdater = require('./updater.cjs');
  const main = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8');
  const start = main.indexOf('const getUpdaterRuntimeBlocker =');
  const end = main.indexOf('const startRollbackWatchdog =', start);
  assert.ok(start >= 0 && end > start, 'helper not found in main.cjs');
  const helper = main.slice(start, end);
  const factory = new Function('xGetNextWakeupDeadline', 'goalRunner', 'jobManager', 'updaterInstallInProgress', 'localUpdater',
    `${helper}\nreturn getUpdaterRuntimeBlocker;`);
  makeBlocker = ({ deadline = () => null, goal = false, queued = 0, running = 0, busy = false, goalRunner, jobManager } = {}) => factory(
    deadline,
    goalRunner === undefined ? { is_goal_active: () => goal } : goalRunner,
    jobManager === undefined ? { listJobs: ({ status }) => new Array(status === 'queued' ? queued : running).fill({}) } : jobManager,
    busy,
    localUpdater,
  );
});
if (!makeBlocker) s.finish();

const B = () => localUpdater.UPDATE_RUNTIME_BLOCKERS;
await s.check('idle runtime (no X, goal, or jobs) -> no blocker', () => {
  assert.equal(makeBlocker()(), null);
});
await s.check('X has a pending wakeup deadline -> X_ACTIVE', () => {
  assert.equal(makeBlocker({ deadline: () => 1234567890 })().code, B().X_ACTIVE);
});
await s.check('active Goal -> GOAL_ACTIVE', () => {
  assert.equal(makeBlocker({ goal: true })().code, B().GOAL_ACTIVE);
});
await s.check('queued durable job -> DURABLE_JOB_ACTIVE', () => {
  assert.equal(makeBlocker({ queued: 1 })().code, B().DURABLE_JOB_ACTIVE);
});
await s.check('updater already installing -> UPDATER_BUSY, unless ignoreUpdaterBusy', () => {
  const blocker = makeBlocker({ busy: true });
  assert.equal(blocker().code, B().UPDATER_BUSY);
  assert.equal(blocker({ ignoreUpdaterBusy: true }), null);
});
await s.check('control: uninitialized X (deadline fn is not a function) fails closed as RUNTIME_STATE_UNAVAILABLE', () => {
  assert.equal(makeBlocker({ deadline: null })().code, B().RUNTIME_STATE_UNAVAILABLE);
});
await s.check('control: missing goalRunner fails closed as RUNTIME_STATE_UNAVAILABLE', () => {
  assert.equal(makeBlocker({ goalRunner: null })().code, B().RUNTIME_STATE_UNAVAILABLE);
});
s.finish();
