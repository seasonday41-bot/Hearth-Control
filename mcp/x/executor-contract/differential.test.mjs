import assert from 'node:assert/strict';
import test from 'node:test';

import { validateXTask, parseXTask } from '../task-contract.mjs';
import { validateExecutorXTask } from './x-task.schema.mjs';
import { differentialFixtures } from './fixtures.mjs';

const parseVerdict = (input) => {
  try {
    parseXTask(input);
    return true;
  } catch {
    return false;
  }
};

test('executor wire validator stays verdict-compatible with the real x-task-v1 contract', () => {
  for (const fixture of differentialFixtures) {
    const real = validateXTask(fixture.input);
    const independent = validateExecutorXTask(fixture.input);
    const parsed = parseVerdict(fixture.input);

    assert.equal(real.ok, fixture.expectedOk, 'real contract fixture expectation drifted: ' + fixture.name);
    assert.equal(parsed, real.ok, 'real parse/validate disagreement: ' + fixture.name);
    assert.equal(
      independent.ok,
      real.ok,
      'executor contract drifted from task-contract.mjs: ' + fixture.name +
        '\nreal=' + JSON.stringify(real.errors ?? []) +
        '\nindependent=' + JSON.stringify(independent.errors ?? []),
    );
  }
});

test('fixture corpus covers every current top-level commit policy mode', () => {
  for (const mode of ['never', 'require_user_approval', 'after_tests']) {
    assert.ok(
      differentialFixtures.some((fixture) => fixture.expectedOk &&
        (fixture.input?.commit_policy === mode || fixture.input?.commit_policy?.mode === mode)),
      'missing valid fixture for commit policy ' + mode,
    );
  }
});

test('fixture corpus explicitly covers legacy aliases and scope safety branches', () => {
  const names = new Set(differentialFixtures.map((fixture) => fixture.name));
  for (const name of [
    'legacy verification fallback',
    'legacy uncertainty fallback',
    'workspace supplied through scope.workspace fallback',
    'scope path traversal rejected',
    'scope path length rejected',
    'allowed and forbidden paths overlap',
    'reference_paths overlap allowed_paths',
    'timing ordering violation',
    'repair total exceeds initial plus repairs',
  ]) {
    assert.ok(names.has(name), 'missing differential fixture: ' + name);
  }
});
