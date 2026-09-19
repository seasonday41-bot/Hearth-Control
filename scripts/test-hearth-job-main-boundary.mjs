import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const main = fs.readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
const http = fs.readFileSync(new URL('../mcp/http.mjs', import.meta.url), 'utf8');
const tools = fs.readFileSync(new URL('../mcp/tools.mjs', import.meta.url), 'utf8');
const contract = fs.readFileSync(new URL('../mcp/router/hearth-job-contract.mjs', import.meta.url), 'utf8');
const router = fs.readFileSync(new URL('../mcp/router/router.mjs', import.meta.url), 'utf8');

const helperStart = main.indexOf('const hearthJobError = (code) =>');
const helperEnd = main.indexOf('// Fast-restart X liveness:', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'P8 Electron ingress helper block must exist');
const ingress = main.slice(helperStart, helperEnd);

const handlerStart = main.indexOf("if (message?.type === 'hearth_job_request_cancel')");
const handlerEnd = main.indexOf("if ([\n      'github_connections_list_request'", handlerStart);
assert.ok(handlerStart >= 0 && handlerEnd > handlerStart, 'P8 message handler block must exist');
const handler = main.slice(handlerStart, handlerEnd);

test('P8.12 universal MCP tools expose submit/status only, not worker selection', () => {
  assert.match(tools, /server\.registerTool\('hearth_job_submit'/);
  assert.match(tools, /server\.registerTool\('hearth_job_status'/);
  const start = tools.indexOf("server.registerTool('hearth_job_submit'");
  const end = tools.indexOf("server.registerTool('review_queue_list'", start);
  const block = tools.slice(start, end);
  assert.doesNotMatch(block, /worker\s*:/);
  assert.doesNotMatch(block, /provider\s*:/);
  assert.doesNotMatch(block, /codex/i);
});

test('P8.13 HTTP transport sends generic job/status to Electron and submit has disconnect cancellation', () => {
  assert.match(http, /hearth_job_submit_request/);
  assert.match(http, /hearth_job_status_request/);
  assert.match(http, /cancelType: 'hearth_job_request_cancel'/);
  assert.match(http, /hearthJobTransport: hearthJobTransportFor\(response\)/);
  assert.match(http, /hearth_job_submit_ack/);
  assert.match(http, /hearth_job_status_ack/);
});

test('P8.14 Electron X route reuses canonical ingestXTask with no approval bypass', () => {
  assert.match(ingress, /adaptHearthJobToXTask/);
  assert.match(ingress, /await ingestXTask\(/);
  assert.match(ingress, /requestId: xRequestId/);
  assert.match(ingress, /onInflightRecord: \(record\) => \{ waiter\.xInflight = record; \}/);
  assert.doesNotMatch(ingress, /skipStepApproval\s*:\s*true/);
  assert.doesNotMatch(ingress, /runXTask\(/);
});

test('P8.15 Electron general route is TaskStore-owned and reuses Antigravity runtime', () => {
  assert.match(ingress, /taskStore\.getTask\(taskId\)/);
  assert.match(ingress, /await startAntigravityTask\(/);
  assert.match(ingress, /existingTaskId: taskId/);
  assert.match(ingress, /requestId,/);
  assert.match(ingress, /getProductionAntigravityClaimStore/);
  assert.match(ingress, /void monitorTaskTransition\(result\.taskId\)/);
  assert.doesNotMatch(router, /new TaskStore|new JobManager|XQueueStore|XRunStore/);
});

test('P8.16 cross-route ambiguity and same-id conflicts fail closed', () => {
  assert.match(ingress, /if \(xReceipt && antigravityTask\) throw hearthJobError\('ambiguous_job_state'\)/);
  assert.match(ingress, /if \(route === 'x' && antigravityTask\) throw hearthJobError\('job_route_conflict'\)/);
  assert.match(ingress, /if \(route === 'antigravity' && xReceipt\) throw hearthJobError\('job_route_conflict'\)/);
  assert.match(ingress, /if \(current\.requestId !== requestId\) throw hearthJobError\('job_id_conflict'\)/);
  assert.match(ingress, /existingInflight\.fingerprint !== fingerprint/);
});

test('P8.17 universal workspace is transport/Electron-owned and three-way checked', () => {
  assert.doesNotMatch(contract, /'workspace'/);
  assert.doesNotMatch(contract, /'workspace_root'/);
  assert.match(ingress, /fs\.promises\.realpath\(launchWorkspace\)/);
  assert.match(ingress, /fs\.promises\.realpath\(reportedWorkspace\)/);
  assert.match(ingress, /fs\.promises\.realpath\(readSettings\(\)\.workspace\)/);
  assert.match(ingress, /childRoot !== reportedRoot \|\| childRoot !== settingsRoot/);
});

test('P8.18 Antigravity permission and approval liveness stay authoritative', () => {
  assert.match(ingress, /readSettings\(\)\.permissions\?\.Antigravity \?\? 'Ask'/);
  assert.match(ingress, /permission === 'Blocked'/);
  assert.match(ingress, /requestHearthJobAntigravityApproval/);
  assert.match(ingress, /shared\.abort\.signal\.aborted/);
  assert.match(ingress, /shared\.waiters\.size === 0/);
  assert.match(ingress, /serverProcess !== child/);
  assert.match(ingress, /shared\.committed = true/);
  assert.match(ingress, /type: 'approval:resolved'/);
});

test('P8.19 cancellation removes generic waiters and aborts only uncommitted orphaned work', () => {
  assert.match(ingress, /waiter\.xInflight\.waiters\.delete\(transportId\)/);
  assert.match(ingress, /!waiter\.xInflight\.committed && waiter\.xInflight\.waiters\.size === 0/);
  assert.match(ingress, /waiter\.generalInflight\.waiters\.delete\(transportId\)/);
  assert.match(ingress, /!waiter\.generalInflight\.committed && waiter\.generalInflight\.waiters\.size === 0/);
  assert.match(handler, /hearth_job_request_cancel/);
  assert.match(main, /cancelHearthJobChild\(child\)/);
  assert.match(main, /for \(const transportId of hearthJobRequests\.keys\(\)\) cancelHearthJobRequest\(transportId\)/);
});

test('P8.20 status reads only existing X receipt or TaskStore truth and fails closed if both exist', () => {
  assert.match(ingress, /xQueueStore\?\.getReceipt\(requestId\)/);
  assert.match(ingress, /taskStore\?\.getTask\(taskId\)/);
  assert.match(ingress, /ambiguous_job_state/);
  assert.doesNotMatch(ingress, /new Map\(\).*status/i);
});

test('P8.21 Codex remains outside fresh-job router implementation', () => {
  assert.doesNotMatch(contract, /codex/i);
  assert.doesNotMatch(router, /codex/i);
  assert.doesNotMatch(ingress, /codex/i);
  assert.doesNotMatch(ingress, /specialist/i);
});
