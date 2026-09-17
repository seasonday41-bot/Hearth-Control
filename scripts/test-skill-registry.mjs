import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHearthSkillRegistry, parseSkillDocument } from '../mcp/skills/registry.mjs';

const validSkill = `---
schema: hearth-skill-v1
id: repo-inspect
name: Repo Inspect
version: 1
summary: Inspect a repository without changing it.
agents: [x]
mode: read-only
risk: low
tools: [repo_list, repo_read_file, file_search, git_inspect]
---

# Repo Inspect

Read only.
`;

test('SKREG1 parses Hearth Skill v1 frontmatter and body', () => {
  const parsed = parseSkillDocument(validSkill);
  assert.equal(parsed.metadata.schema, 'hearth-skill-v1');
  assert.equal(parsed.metadata.id, 'repo-inspect');
  assert.equal(parsed.metadata.version, 1);
  assert.deepEqual(parsed.metadata.agents, ['x']);
  assert.deepEqual(parsed.metadata.tools, ['repo_list', 'repo_read_file', 'file_search', 'git_inspect']);
  assert.match(parsed.instructions, /^# Repo Inspect/m);
});

test('SKREG2 rejects unsupported schemas', () => {
  assert.throws(() => parseSkillDocument(validSkill.replace('hearth-skill-v1', 'other-skill-v1')), { code: 'UNSUPPORTED_SKILL_SCHEMA' });
});

test('SKREG3 rejects invalid skill ids', () => {
  assert.throws(() => parseSkillDocument(validSkill.replace('id: repo-inspect', 'id: Repo Inspect')), { code: 'INVALID_SKILL_ID' });
});

test('SKREG4 registry loads the real repo-inspect definition for X', async () => {
  const registry = createHearthSkillRegistry();
  const loaded = await registry.load('repo-inspect', {
    agent: 'x',
    availableTools: ['repo_list', 'repo_read_file', 'file_search', 'git_inspect'],
  });
  assert.equal(loaded.metadata.id, 'repo-inspect');
  assert.equal(loaded.metadata.mode, 'read-only');
  assert.equal(loaded.grantsPermissions, false);
  assert.deepEqual(loaded.missingTools, []);
  assert.deepEqual(loaded.permittedTools, ['repo_list', 'repo_read_file', 'file_search', 'git_inspect']);
  assert.match(loaded.instructions, /strictly read-only/i);
});

test('SKREG5 loader intersects requested tools instead of granting them', async () => {
  const registry = createHearthSkillRegistry();
  const loaded = await registry.load('repo-inspect', { agent: 'x', availableTools: ['repo_list'] });
  assert.deepEqual(loaded.permittedTools, ['repo_list']);
  assert.deepEqual(loaded.missingTools, ['repo_read_file', 'file_search', 'git_inspect']);
  assert.equal(loaded.grantsPermissions, false);
});

test('SKREG6 loader rejects an agent not declared by the skill', async () => {
  const registry = createHearthSkillRegistry();
  await assert.rejects(() => registry.load('repo-inspect', { agent: 'search-agent', availableTools: [] }), { code: 'SKILL_AGENT_REJECTED' });
});

test('SKREG7 metadata listing can filter by agent without loading unrelated skill bodies', async () => {
  const registry = createHearthSkillRegistry();
  const xSkills = await registry.listMetadata({ agent: 'x' });
  assert.ok(xSkills.some((skill) => skill.id === 'repo-inspect'));
  const otherSkills = await registry.listMetadata({ agent: 'search-agent' });
  assert.ok(!otherSkills.some((skill) => skill.id === 'repo-inspect'));
});

test('SKREG8 registry rejects path-shaped skill identifiers', async () => {
  const registry = createHearthSkillRegistry();
  await assert.rejects(() => registry.load('../repo-inspect', { agent: 'x', availableTools: [] }), { code: 'INVALID_SKILL_ID' });
});

test('SKREG9 registry rejects a directory/metadata id mismatch', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hearth-skill-registry-'));
  const dir = path.join(root, 'wrong-id');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), validSkill);
  const registry = createHearthSkillRegistry({ definitionsRoot: root });
  await assert.rejects(() => registry.load('wrong-id', { agent: 'x', availableTools: [] }), { code: 'SKILL_ID_MISMATCH' });
});

test('SKREG10 registry does not expose execution or permission mutation APIs', () => {
  const registry = createHearthSkillRegistry();
  assert.equal(typeof registry.execute, 'undefined');
  assert.equal(typeof registry.runCommand, 'undefined');
  assert.equal(typeof registry.grantPermission, 'undefined');
  assert.equal(typeof registry.writeFile, 'undefined');
});

console.log('Hearth Skill registry tests: 10 declared');
