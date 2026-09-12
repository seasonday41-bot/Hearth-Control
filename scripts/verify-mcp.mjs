import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const endpoint = new URL(process.env.HEARTH_MCP_URL || 'http://127.0.0.1:3001/mcp');
const client = new Client({ name: 'hearth-verifier', version: '0.1.0' });
await client.connect(new StreamableHTTPClientTransport(endpoint));
const tools = await client.listTools();
const workspace = await client.callTool({ name: 'workspace_info', arguments: {} });
const files = await client.callTool({ name: 'list_files', arguments: { path: '.', limit: 10 } });
const blockedEscape = await client.callTool({ name: 'read_file', arguments: { path: '../../../../../etc/hosts' } });
console.log(JSON.stringify({
  endpoint: endpoint.href,
  tools: tools.tools.map((tool) => tool.name),
  workspace: workspace.content?.[0]?.text,
  listFilesSucceeded: files.isError !== true,
  outsideWorkspaceBlocked: blockedEscape.isError === true,
}, null, 2));
await client.close();
