import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerWorkspaceTools } from './tools.mjs';

export const createMcpServer = (options) => {
  const server = new McpServer({ name: 'hearth-control', version: '0.2.0' });
  registerWorkspaceTools(server, options);
  return server;
};
