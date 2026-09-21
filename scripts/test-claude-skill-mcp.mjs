import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sharedIds = ['debug-discipline', 'delegate-to-x', 'scrutinize'];

test('Claude project MCP config reuses Hearth stdio with unchanged permission defaults', async () => {
  const config = JSON.parse(await fs.readFile(path.join(root, '.mcp.json'), 'utf8'));
  assert.deepEqual(Object.keys(config.mcpServers), ['hearth']);
  assert.equal(config.mcpServers.hearth.command, 'node');
  assert.deepEqual(config.mcpServers.hearth.args, ['${CLAUDE_PROJECT_DIR:-.}/mcp/stdio.mjs']);
  assert.equal(config.mcpServers.hearth.env.HEARTH_WORKSPACE, '${CLAUDE_PROJECT_DIR:-.}');
  assert.equal(config.mcpServers.hearth.env.HEARTH_PERMISSIONS, undefined);
});

test('Claude lists and loads only declared skills through the existing stdio MCP server', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, 'mcp', 'stdio.mjs')],
    cwd: root,
    env: {
      PATH: process.env.PATH ?? '',
      HEARTH_WORKSPACE: root,
      HEARTH_PERMISSIONS: JSON.stringify({ Files: 'Ask', Git: 'Allow', Terminal: 'Blocked', Browser: 'Blocked' }),
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'hearth-claude-skill-test', version: '0.1.0' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === 'skill_list'));
    assert.ok(tools.tools.some((tool) => tool.name === 'skill_load'));

    const listed = await client.callTool({ name: 'skill_list', arguments: { agent: 'claude' } });
    assert.equal(listed.isError, undefined);
    const catalog = JSON.parse(listed.content[0].text);
    assert.deepEqual(catalog.skills.map((skill) => skill.id), sharedIds);
    assert.ok(catalog.skills.every((skill) => skill.agents.includes('claude') && !skill.agents.includes('x')));

    for (const id of sharedIds) {
      const response = await client.callTool({ name: 'skill_load', arguments: { id, agent: 'claude' } });
      assert.equal(response.isError, undefined);
      const skill = JSON.parse(response.content[0].text);
      assert.equal(skill.metadata.id, id);
      assert.equal(skill.grantsPermissions, false);
      assert.deepEqual(skill.requestedTools, []);
      assert.deepEqual(skill.permittedTools, []);
      assert.ok(skill.instructions.length > 0);
    }

    const xSkill = await client.callTool({ name: 'skill_load', arguments: { id: 'repo-inspect', agent: 'claude' } });
    assert.equal(xSkill.isError, true);
    const spoofedAgent = await client.callTool({ name: 'skill_list', arguments: { agent: 'x' } });
    assert.equal(spoofedAgent.isError, true);
  } finally {
    await client.close();
  }
});
