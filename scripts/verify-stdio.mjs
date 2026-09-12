import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['mcp/stdio.mjs'],
  cwd: process.cwd(),
  env: {
    PATH: process.env.PATH ?? '',
    HEARTH_WORKSPACE: process.cwd(),
    HEARTH_PERMISSIONS: JSON.stringify({ Files: 'Allow', Git: 'Allow', Terminal: 'Blocked', Browser: 'Blocked' }),
  },
  stderr: 'pipe',
});
const client = new Client({ name: 'hearth-stdio-verifier', version: '0.1.0' });
await client.connect(transport);
const tools = await client.listTools();
console.log(JSON.stringify({ transport: 'stdio', pid: transport.pid, tools: tools.tools.map((tool) => tool.name) }, null, 2));
await client.close();
