import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { localhostHostValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { createMcpServer } from './create-server.mjs';
import { toolNames, recentJobViews } from './tools.mjs';
import crypto from 'node:crypto';

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
const queueReplies = new Map();
const queueError = (code) => Object.assign(new Error(code), { code });

/**
 * Shared request/ack round trip over the fork-IPC channel to Electron main.
 * Correlate connection-service replies with transportId and clean up on
 * timeout or response close. Optional cancelType stops in-flight work.
 */
const createRoundTripTransport = (response, { cancelType } = {}) => {
  const active = new Set();
  const roundTrip = (type, payload) => new Promise((resolve, reject) => {
    if (typeof process.send !== 'function' || !process.connected) { reject(queueError('transport_unavailable')); return; }
    const transportId = crypto.randomUUID();
    const finish = (error, result) => {
      const pending = queueReplies.get(transportId);
      if (!pending) return;
      clearTimeout(pending.timer);
      queueReplies.delete(transportId);
      active.delete(transportId);
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => {
      if (cancelType) { try { process.send({ type: cancelType, transportId }); } catch {} }
      finish(queueError('transport_timeout'));
    }, 120000);
    active.add(transportId);
    queueReplies.set(transportId, { finish, timer });
    try { process.send({ type, transportId, ...payload }); }
    catch { finish(queueError('transport_unavailable')); }
  });
  response.on('close', () => {
    for (const transportId of active) {
      if (cancelType) { try { process.send?.({ type: cancelType, transportId }); } catch {} }
      queueReplies.get(transportId)?.finish(queueError('transport_unavailable'));
    }
  });
  return roundTrip;
};

const githubTransportFor = (response) => {
  const roundTrip = createRoundTripTransport(response);
  return {
    listConnections: () => roundTrip('github_connections_list_request', {}),
    listRepositories: ({ connection, page, perPage }) =>
      roundTrip('github_repositories_list_request', { connection, page, perPage }),
    getRepository: ({ connection, owner, repo }) =>
      roundTrip('github_repository_get_request', { connection, owner, repo }),
    listPullRequests: ({ connection, owner, repo, state, page, perPage }) =>
      roundTrip('github_pull_requests_list_request', { connection, owner, repo, state, page, perPage }),
    createPullRequest: ({ connection, owner, repo, title, head, base, body, draft }) =>
      roundTrip('github_pull_request_create_request', { connection, owner, repo, title, head, base, body, draft }),
  };
};

const vercelTransportFor = (response) => {
  const roundTrip = createRoundTripTransport(response);
  return {
    listProjects: ({ connection, teamId, limit }) =>
      roundTrip('vercel_projects_list_request', { connection, teamId: teamId || null, limit }),
    getProject: ({ connection, idOrName, teamId }) =>
      roundTrip('vercel_project_get_request', { connection, idOrName, teamId: teamId || null }),
    listDeployments: ({ connection, projectId, teamId, limit, target }) =>
      roundTrip('vercel_deployments_list_request', {
        connection,
        projectId: projectId || null,
        teamId: teamId || null,
        limit,
        target: target || null,
      }),
    getDeployment: ({ connection, idOrUrl, teamId }) =>
      roundTrip('vercel_deployment_get_request', { connection, idOrUrl, teamId: teamId || null }),
  };
};

const settleApproval = (requestId, allowed, reason) => {
  const pending = approvals.get(requestId);
  if (!pending) return;
  approvals.delete(requestId);
  clearTimeout(pending.timer);
  pending.resolve(allowed);
  try {
    process.send?.({
      type: 'approval:resolved',
      requestId,
      allowed,
      reason,
    });
  } catch {
    /* best-effort only */
  }
};

const requestApproval = ({ permission, action }) => new Promise((resolve) => {
  const requestId = crypto.randomUUID();
  const timer = setTimeout(
    () => settleApproval(requestId, false, 'timeout'),
    60000,
  );

  approvals.set(requestId, { resolve, timer });

  if (process.send) {
    process.send({
      type: 'approval',
      requestId,
      permission,
      action,
    });
  } else {
    settleApproval(requestId, false, 'aborted');
  }
});

process.on('message', (message) => {
  if (message?.type === 'jobs:list-request' && typeof message.requestId === 'string') {
    process.send?.({ type: 'jobs:list-response', requestId: message.requestId, jobs: recentJobViews(workspace) });
  }
  if (message?.type === 'approval:result') {
    settleApproval(
      message.requestId,
      message.allowed === true,
      'user',
    );
  }
  if (message?.type === 'settings:update' && message.permissions) Object.assign(permissions, message.permissions);
  if (typeof message?.type === 'string' && message.type.startsWith('github_') && message.type.endsWith('_ack')) {
    queueReplies.get(message.transportId)?.finish(
      null,
      message.ok ? message.result : { ok: false, error: message.error || 'github_request_failed' },
    );
  }
  if (typeof message?.type === 'string' && message.type.startsWith('vercel_') && message.type.endsWith('_ack')) {
    queueReplies.get(message.transportId)?.finish(
      null,
      message.ok ? message.result : { ok: false, error: message.error || 'vercel_request_failed' },
    );
  }
});
process.on('disconnect', () => {
  for (const pending of queueReplies.values()) pending.finish(queueError('transport_unavailable'));
});

app.get('/health', (_request, response) => {
  response.json({ status: 'ok', service: 'hearth-control', protocol: 'mcp', pid: process.pid, workspace, uptime: process.uptime() });
});

app.get('/tools', (_request, response) => response.json({ tools: toolNames }));

app.post('/mcp', async (request, response) => {
  const server = createMcpServer({
    workspace, permissions, requestApproval,
    githubTransport: githubTransportFor(response),
    vercelTransport: vercelTransportFor(response),
  });
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

const shutdown = () => {
  for (const requestId of [...approvals.keys()]) {
    settleApproval(requestId, false, 'shutdown');
  }

  listener.close(() => process.exit(0));
};
process.on('message', (message) => { if (message?.type === 'shutdown') shutdown(); });
process.on('SIGTERM', shutdown);
