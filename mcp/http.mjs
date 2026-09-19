import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { localhostHostValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { createMcpServer } from './create-server.mjs';
import { toolNames } from './tools.mjs';
import crypto from 'node:crypto';
import { onAntigravityAdmissionReleased } from './executors/antigravity-admission.mjs';

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
 * Shared request/ack round trip over the fork-IPC channel to Electron main
 * (process.send/process.on('message')) -- the SAME mechanism
 * x_queue_enqueue_request/x_queue_status_request already use, generalized
 * so a new request kind (e.g. review_queue_list_request) can reuse the
 * identical transportId correlation, timeout, and response-close cleanup
 * instead of re-implementing it. `cancelType`, when given, is sent on
 * timeout/response-close exactly like x_queue_request_cancel already is;
 * omit it for a request with no server-side in-flight state worth
 * cancelling (e.g. a pure read like review_queue_list_request).
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

const queueIngressTransportFor = (response) => {
  const roundTrip = createRoundTripTransport(response, { cancelType: 'x_queue_request_cancel' });
  return {
    enqueue: ({ requestId, task, workspace }) => roundTrip('x_queue_enqueue_request', { requestId, task, workspace }),
    status: ({ requestId }) => roundTrip('x_queue_status_request', { requestId }),
  };
};

const hearthJobTransportFor = (response) => {
  const submitRoundTrip = createRoundTripTransport(response, { cancelType: 'hearth_job_request_cancel' });
  const statusRoundTrip = createRoundTripTransport(response);
  return {
    submit: ({ job }) => submitRoundTrip('hearth_job_submit_request', { job, workspace }),
    status: ({ jobId }) => statusRoundTrip('hearth_job_status_request', { jobId, workspace }),
  };
};

/**
 * Read-only bridge to the LIVE GoalRunner instance Electron main owns --
 * never a second GoalRunner/GoalStorage. Electron main's own
 * review_queue_list_request handler (electron/main.cjs) calls the SAME
 * goalRunner.list_review_queue() the running app itself uses; this makes
 * zero writes on either side of the channel.
 */
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

const reviewQueueTransportFor = (response) => {
  const roundTrip = createRoundTripTransport(response);
  return {
    list: ({ goalId } = {}) => roundTrip('review_queue_list_request', { goalId: goalId || null }),
    acknowledge: ({ goalId, reviewItemId, actor, note } = {}) =>
      roundTrip('review_queue_acknowledge_request', { goalId, reviewItemId, actor: actor || null, note: note || null }),
    resolve: ({ goalId, reviewItemId, action, note } = {}) =>
      roundTrip('review_queue_resolve_request', { goalId, reviewItemId, action: action || 'accept', note: note || null }),
    retry: ({ goalId, reviewItemId, xTask, note, actor } = {}) =>
      roundTrip('review_queue_retry_request', { goalId, reviewItemId, xTask: xTask || null, note: note || null, actor: actor || null }),
    getGoalContext: ({ goalId } = {}) => roundTrip('goal_get_context_request', { goalId }),
    requestSpecialistHandoff: ({ goalId, stepId, target, reason, requestedAction, actor } = {}) =>
      roundTrip('goal_request_specialist_handoff_request', { goalId, stepId, target, reason: reason || null, requestedAction: requestedAction || null, actor: actor || null }),
    getSpecialistHandoff: ({ goalId, handoffId } = {}) =>
      roundTrip('goal_get_specialist_handoff_request', { goalId, handoffId }),
    listSpecialistHandoffs: ({ goalId } = {}) =>
      roundTrip('goal_list_specialist_handoffs_request', { goalId }),
  };
};

onAntigravityAdmissionReleased(() => {
  if (typeof process.send === 'function') {
    try { process.send({ type: 'x_capacity_released_hint' }); } catch {}
  }
});

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
  if (message?.type === 'approval:result') {
    settleApproval(
      message.requestId,
      message.allowed === true,
      'user',
    );
  }
  if (message?.type === 'settings:update' && message.permissions) Object.assign(permissions, message.permissions);
  if (message?.type === 'x_queue_enqueue_ack' || message?.type === 'x_queue_status_ack') {
    queueReplies.get(message.transportId)?.finish(null, message.ok ? message.receipt : { accepted: false, found: false, reason: message.error });
  }
  if (message?.type === 'hearth_job_submit_ack' || message?.type === 'hearth_job_status_ack') {
    queueReplies.get(message.transportId)?.finish(
      null,
      message.ok ? message.result : {
        accepted: false,
        found: false,
        reason: message.error || 'hearth_job_request_failed',
      },
    );
  }
  if (message?.type === 'review_queue_list_ack') {
    queueReplies.get(message.transportId)?.finish(null, message.ok ? { items: message.items } : { items: [], reason: message.error });
  }
  if (message?.type === 'review_queue_acknowledge_ack' || message?.type === 'review_queue_resolve_ack' || message?.type === 'review_queue_retry_ack') {
    queueReplies.get(message.transportId)?.finish(null, message.ok ? message.result : { ok: false, reason: message.error });
  }
  if (message?.type === 'goal_get_context_ack') {
    queueReplies.get(message.transportId)?.finish(null, message.ok ? message.context : { error: message.error });
  }
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
    queueIngressTransport: queueIngressTransportFor(response),
    hearthJobTransport: hearthJobTransportFor(response),
    reviewQueueTransport: reviewQueueTransportFor(response),
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
