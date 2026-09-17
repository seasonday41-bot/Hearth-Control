import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHearthSkillRegistry } from '../mcp/skills/registry.mjs';
import { LOCAL_SKILL_TOOLS } from '../mcp/skills/gateway.mjs';
import { TEST_RUN_TOOL } from '../mcp/skills/test-runner.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'mcp', 'skills', 'definitions');
const registry = createHearthSkillRegistry({ definitionsRoot: root });
const availableTools = [
  ...LOCAL_SKILL_TOOLS.map((tool) => tool.function.name),
  TEST_RUN_TOOL.function.name,
];

test('initial Hearth skill catalog is discoverable for X', async () => {
  const skills = await registry.listMetadata({ agent: 'x' });
  assert.deepEqual(skills.map((skill) => skill.id), ['bug-fix', 'repo-inspect', 'test-regression']);
});

test('repo-inspect is strictly read-only and fully backed by current local tools', async () => {
  const skill = await registry.load('repo-inspect', { agent: 'x', availableTools });
  assert.equal(skill.metadata.mode, 'read-only');
  assert.deepEqual(skill.missingTools, []);
  assert.equal(skill.grantsPermissions, false);
});

test('test-regression is fully backed by gateway plus approved Test Runner', async () => {
  const skill = await registry.load('test-regression', { agent: 'x', availableTools });
  assert.deepEqual(skill.missingTools, []);
  assert.ok(skill.permittedTools.includes('test_run'));
  assert.equal(skill.grantsPermissions, false);
});

test('bug-fix remains capability-limited instead of gaining a write tool from its definition', async () => {
  const skill = await registry.load('bug-fix', { agent: 'x', availableTools });
  assert.equal(skill.metadata.mode, 'workspace-write');
  assert.deepEqual(skill.missingTools, []);
  assert.equal(skill.grantsPermissions, false);
  assert.ok(!skill.permittedTools.some((tool) => /write|edit|delete|shell|exec/i.test(tool)));
});

console.log('Hearth initial skill definition tests: 4 passed');
