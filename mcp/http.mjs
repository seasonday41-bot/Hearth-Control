import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { localhostHostValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { createMcpServer } from './create-server.mjs';
import { toolNames } from './tools.mjs';

// Build Express app manually so we can set body-parser limit to 12 MB.
// This allows write_file's own 10 MB guard to fire with a readable error
// instead of Express returning a raw HTML 413 PayloadTooLargeError.
// DNS-rebinding protection (localhostHostValidation) is applied identically
// to what createMcpExpressApp does for 127.0.0.1.
const app = express();
app.use(express.json({ limit: '12mb' }));
app.use(localhostHostValidation());

const port = Number(process.env.CONTROL_PORT || 3001);
const workspace = process.env.CONTROL_WORKSPACE || '';
const permissions = process.env.CONTROL_PERMISSIONS ? JSON.parse(process.env.CONTROL_PERMISSIONS) : {};
const approvals = new Map();

const requestApproval = ({ permission, action }) => new Promise((resolve) => {
  const requestId = crypto.randomUUID();
  const timer = setTimeout(() => { approvals.delete(requestId); resolve(false); }, 60000);
  approvals.set(requestId, (allowed) => { clearTimeout(timer); approvals.delete(requestId); resolve(allowed); });
  if (process.send) process.send({ type: 'approval', requestId, permission, action });
  else { clearTimeout(timer); approvals.delete(requestId); resolve(false); }
});

process.on('message', (message) => {
  if (message?.type === 'approval:result') approvals.get(message.requestId)?.(message.allowed === true);
  if (message?.type === 'settings:update' && message.permissions) Object.assign(permissions, message.permissions);
});

app.get('/health', (_request, response) => {
  response.json({ status: 'ok', service: 'hearth-control', protocol: 'mcp', pid: process.pid, workspace, uptime: process.uptime() });
});

app.get('/tools', (_request, response) => response.json({ tools: toolNames }));

app.post('/mcp', async (request, response) => {
  const server = createMcpServer({ workspace, permissions, requestApproval });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  response.on('close', () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(request, response, request.body);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    if (!response.headersSent) response.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
  }
});

app.get('/mcp', (_request, response) => response.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }));
app.delete('/mcp', (_request, response) => response.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }));

const listener = app.listen(port, '127.0.0.1', () => {
  if (process.send) process.send({ type: 'ready', port });
});
listener.on('error', (error) => {
  console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use.` : error.message);
  process.exit(1);
});

const shutdown = () => listener.close(() => process.exit(0));
process.on('message', (message) => { if (message?.type === 'shutdown') shutdown(); });
process.on('SIGTERM', shutdown);
