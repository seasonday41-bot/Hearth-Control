import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './create-server.mjs';

const permissions = process.env.HEARTH_PERMISSIONS
  ? JSON.parse(process.env.HEARTH_PERMISSIONS)
  : { Files: 'Ask', Git: 'Allow', Terminal: 'Blocked', Browser: 'Blocked' };
const workspace = process.env.HEARTH_WORKSPACE || process.cwd();
const server = createMcpServer({ workspace, permissions });
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`Hearth MCP stdio ready for workspace: ${workspace}`);
