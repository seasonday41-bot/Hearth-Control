// Focused tests for mcp/bridge/public-tasks-client.mjs -- the Project X
// (public.tasks) remote transport adapter. Proves R1, R3, R4, R8-R11 from
// the Remote-Bridge-to-X migration's locked acceptance contract, PLUS the
// schema-reconciliation contract against the REAL verified public.tasks
// columns (user_id, metadata.x_task, no owner_id/task/claim columns) --
// against the real, unmodified production module (a real ESM import; this
// file has no Electron/module-level side effects, unlike electron/main.cjs).
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parsePublicXTaskRow,
  mapXStatusToPublicTasksStatus,
  PublicTasksClient,
  createMockPublicTasksTransport,
} from '../mcp/bridge/public-tasks-client.mjs';
import { X_TASK_VERSION } from '../mcp/x/task-contract.mjs';

const validXTask = (taskId = 'remote-task-1') => ({
  version: X_TASK_VERSION,
  task_id: taskId,
  parent_task_id: null,
  revision: 1,
  attempt: 1,
  based_on_result_id: null,
  objective: 'Create one harmless marker file.',
  problem: 'A deterministic marker file does not exist yet.',
  expected_behavior: "Create 'src/marker.txt' with content 'OK\\n'.",
  observed_behavior: "The file 'src/marker.txt' does not exist.",
  why_this_matters: 'Proves the remote-to-X pipeline end to end.',
  known_evidence: [], suspected_area: [],
  workspace: { repo: 'remote-repo', root: '/some/workspace' },
  scope: { allowed_paths: ['src'], preferred_files: [], forbidden_paths: [] },
  constraints: { preserve: [], do_not: [] },
  allowed_tools: ['repo_read'],
  acceptance_criteria: ['The file exists with the exact content.'],
  validation: { required: ['node --test scripts/test-pass.mjs'], optional: [] },
  verification: null,
  done_criteria: ['Done.'],
  teaching_notes: [],
  uncertainty_policy: { policy: 'bounded_autonomy', stop_conditions: [] },
  repair_budget: { initial_attempts: 1, max_repairs: 2, max_total_rounds: 3 },
  timing: { estimated_minutes: 3, first_check_after_minutes: 1, soft_deadline_minutes: 3, hard_timeout_minutes: 10 },
  commit_policy: { mode: 'never' },
});

// REAL public.tasks row shape (verified live schema): id, user_id, title,
// instruction, status, priority, result, error, scheduled_for, started_at,
// finished_at, metadata (x_task lives here), client_created_at,
// client_updated_at, sync_version, deleted_at, created_at, updated_at.
// origin_device_id/conversation_id exist but are never read by this
// adapter -- neither is a target-device or claim concept here.
const queuedRow = (overrides = {}) => ({
  id: 'row-1', user_id: 'owner-A', status: 'queued', created_at: '2026-01-01T00:00:00.000Z',
  title: 'Remote X Smoke', instruction: 'A human-readable summary only -- never X input.',
  origin_device_id: 'some-other-device-uuid',
  metadata: { x_task: validXTask() },
  result: null, error: null,
  ...overrides,
});

// ── owner uses user_id, foreign user_id rejected ────────────────────────

test('R1 a row owned by a different user_id is rejected', () => {
  const row = queuedRow({ user_id: 'owner-B' });
  assert.throws(() => parsePublicXTaskRow(row, 'owner-A'), /Owner mismatch/);
});

test('R1b a matching user_id is accepted, and ownerId is read from user_id', () => {
  const row = queuedRow({ user_id: 'owner-A' });
  const parsed = parsePublicXTaskRow(row, 'owner-A');
  assert.equal(parsed.ownerId, 'owner-A');
  assert.equal(parsed.id, 'row-1');
});

test('a row with a legacy owner_id field (not user_id) is still owner-matched on user_id only', () => {
  // Proves the parser reads user_id, not owner_id, even if a stray
  // owner_id-shaped key were ever present on a row.
  const row = queuedRow({ user_id: 'owner-A', owner_id: 'owner-B' });
  const parsed = parsePublicXTaskRow(row, 'owner-A');
  assert.equal(parsed.ownerId, 'owner-A');
});

// ── metadata.x_task required, malformed/missing rejected ───────────────

test('metadata.x_task is required -- a row with no metadata is rejected', () => {
  const row = queuedRow({ metadata: undefined });
  assert.throws(() => parsePublicXTaskRow(row, 'owner-A'), /metadata must be an object/);
});

test('metadata.x_task is required -- metadata present but x_task missing is rejected', () => {
  const row = queuedRow({ metadata: { some_other_field: true } });
  assert.throws(() => parsePublicXTaskRow(row, 'owner-A'), /metadata\.x_task is required/);
});

test('title/instruction alone can never become an X task, even when populated and metadata.x_task is absent', () => {
  const row = queuedRow({
    title: 'Please fix the login bug',
    instruction: 'Look at auth.js and fix the null check.',
    metadata: {},
  });
  assert.throws(() => parsePublicXTaskRow(row, 'owner-A'), /metadata\.x_task is required/);
});

test('R3 a malformed (incomplete) x-task-v1 payload at metadata.x_task is rejected, never repaired', () => {
  const malformed = { version: X_TASK_VERSION, task_id: 'x' }; // missing every other required field
  const row = queuedRow({ metadata: { x_task: malformed } });
  assert.throws(() => parsePublicXTaskRow(row, 'owner-A'));
});

test('R3b a row whose metadata.x_task is not an object at all is rejected', () => {
  const row = queuedRow({ metadata: { x_task: 'not an object' } });
  assert.throws(() => parsePublicXTaskRow(row, 'owner-A'));
});

// ── R4: x-task-v1 with unknown fields is rejected ───────────────────────

test('R4 an x-task-v1 payload with an unknown field is rejected via the existing contract', () => {
  const withUnknownField = { ...validXTask(), extra_field_not_in_contract: 'nope' };
  const row = queuedRow({ metadata: { x_task: withUnknownField } });
  assert.throws(() => parsePublicXTaskRow(row, 'owner-A'), /extra_field_not_in_contract/);
});

// ── origin_device_id is never treated as a target ───────────────────────

test('origin_device_id is completely ignored -- it never gates, filters, or influences parsing', () => {
  const row = queuedRow({ origin_device_id: 'device-that-does-not-exist-anywhere' });
  const parsed = parsePublicXTaskRow(row, 'owner-A');
  assert.equal(parsed.id, 'row-1');
  assert.ok(!('originDeviceId' in parsed), 'the parsed result must not surface a device concept at all');
});

// ── status invariants ────────────────────────────────────────────────────

test('a non-queued row is rejected regardless of task validity', () => {
  const row = queuedRow({ status: 'running' });
  assert.throws(() => parsePublicXTaskRow(row, 'owner-A'), /expected 'queued'/);
});

// ── R8-R11: X terminal status -> public.tasks status mapping ───────────

test('R8 completed maps to completed', () => {
  assert.equal(mapXStatusToPublicTasksStatus('completed'), 'completed');
});

test('R9 needs_review maps to waiting', () => {
  assert.equal(mapXStatusToPublicTasksStatus('needs_review'), 'waiting');
});

test('R10 failed maps to failed', () => {
  assert.equal(mapXStatusToPublicTasksStatus('failed'), 'failed');
});

test('R11 interrupted maps to waiting', () => {
  assert.equal(mapXStatusToPublicTasksStatus('interrupted'), 'waiting');
});

test('a non-terminal or unrecognized X status is never mapped', () => {
  assert.throws(() => mapXStatusToPublicTasksStatus('running'));
  assert.throws(() => mapXStatusToPublicTasksStatus('queued'));
  assert.throws(() => mapXStatusToPublicTasksStatus('bogus'));
});

// ── fetchQueuedTasks: a pure read, never a side effect, real filter shape ─

test('R2 fetchQueuedTasks is a pure read -- it never claims or mutates rows', async () => {
  const transport = createMockPublicTasksTransport([queuedRow()]);
  const client = new PublicTasksClient({ supabaseUrl: 'https://example.supabase.co', fetchFn: transport.fetch });
  client.setSession({ accessToken: 'jwt-token', ownerId: 'owner-A' });

  const tasks = await client.fetchQueuedTasks();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, 'row-1');
  // Nothing about the underlying row may have changed from a plain read.
  assert.equal(transport.getRows()[0].status, 'queued');
  assert.equal(transport.getRows()[0].started_at, undefined);
});

test('fetchQueuedTasks requests user_id/status/deleted_at -- never nonexistent owner_id/task columns', async () => {
  let capturedUrl;
  const transport = createMockPublicTasksTransport([queuedRow()]);
  const client = new PublicTasksClient({
    supabaseUrl: 'https://example.supabase.co',
    fetchFn: (url, opts) => { capturedUrl = url; return transport.fetch(url, opts); },
  });
  client.setSession({ accessToken: 'jwt-token', ownerId: 'owner-A' });
  await client.fetchQueuedTasks();
  assert.match(capturedUrl, /user_id=eq\.owner-A/);
  assert.match(capturedUrl, /status=eq\.queued/);
  assert.match(capturedUrl, /deleted_at=is\.null/);
  assert.doesNotMatch(capturedUrl, /owner_id=/, 'owner_id does not exist on public.tasks and must never be requested');
  assert.doesNotMatch(capturedUrl, /[?&]task=/, 'task is not a real column and must never be requested');
});

test('a row with deleted_at set is excluded from queued fetch results', async () => {
  const transport = createMockPublicTasksTransport([
    queuedRow({ id: 'alive-row' }),
    queuedRow({ id: 'deleted-row', deleted_at: '2026-01-02T00:00:00.000Z' }),
  ]);
  const client = new PublicTasksClient({ supabaseUrl: 'https://example.supabase.co', fetchFn: transport.fetch });
  client.setSession({ accessToken: 'jwt-token', ownerId: 'owner-A' });
  const tasks = await client.fetchQueuedTasks();
  assert.deepEqual(tasks.map((t) => t.id), ['alive-row']);
});

test('fetchQueuedTasks skips a malformed row without throwing for the whole batch', async () => {
  const transport = createMockPublicTasksTransport([
    queuedRow({ id: 'good-row' }),
    queuedRow({ id: 'bad-row', metadata: { x_task: { version: X_TASK_VERSION } } }),
  ]);
  const client = new PublicTasksClient({ supabaseUrl: 'https://example.supabase.co', fetchFn: transport.fetch });
  client.setSession({ accessToken: 'jwt-token', ownerId: 'owner-A' });

  const tasks = await client.fetchQueuedTasks();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, 'good-row');
});

// ── claimQueuedTask: conditional queued -> running, races fail safely ──

test('claimQueuedTask transitions queued -> running, sets started_at, and preserves metadata.x_task', async () => {
  const transport = createMockPublicTasksTransport([queuedRow()]);
  const client = new PublicTasksClient({ supabaseUrl: 'https://example.supabase.co', fetchFn: transport.fetch });
  client.setSession({ accessToken: 'jwt-token', ownerId: 'owner-A' });

  const result = await client.claimQueuedTask({ id: 'row-1' });
  assert.equal(result.claimed, true);
  assert.equal(result.row.status, 'running');
  const row = transport.getRows()[0];
  assert.equal(row.status, 'running');
  assert.ok(row.started_at, 'started_at must be set on claim');
  assert.equal(row.claimed_at, undefined, 'there is no claimed_at column');
  assert.deepEqual(row.metadata.x_task.task_id, 'remote-task-1', 'metadata.x_task must be untouched by the claim PATCH');
});

test('claimQueuedTask requests user_id, never owner_id or a claim/lease column', async () => {
  let capturedUrl, capturedBody;
  const transport = createMockPublicTasksTransport([queuedRow()]);
  const client = new PublicTasksClient({
    supabaseUrl: 'https://example.supabase.co',
    fetchFn: (url, opts) => { capturedUrl = url; capturedBody = JSON.parse(opts.body); return transport.fetch(url, opts); },
  });
  client.setSession({ accessToken: 'jwt-token', ownerId: 'owner-A' });
  await client.claimQueuedTask({ id: 'row-1' });
  assert.match(capturedUrl, /user_id=eq\.owner-A/);
  assert.doesNotMatch(capturedUrl, /owner_id=/);
  assert.deepEqual(Object.keys(capturedBody).sort(), ['started_at', 'status']);
  assert.ok(!('updated_at' in capturedBody), 'updated_at is owned by the existing DB trigger, never written here');
  assert.ok(!('sync_version' in capturedBody), 'sync_version is owned by the existing DB trigger, never written here');
  assert.ok(!('metadata' in capturedBody), 'metadata must never be included, so it is preserved untouched');
});

test('a second claim attempt on an already-claimed row fails safely (claimed: false, no throw)', async () => {
  const transport = createMockPublicTasksTransport([queuedRow()]);
  const client = new PublicTasksClient({ supabaseUrl: 'https://example.supabase.co', fetchFn: transport.fetch });
  client.setSession({ accessToken: 'jwt-token', ownerId: 'owner-A' });

  const first = await client.claimQueuedTask({ id: 'row-1' });
  assert.equal(first.claimed, true);
  const second = await client.claimQueuedTask({ id: 'row-1' });
  assert.equal(second.claimed, false, 'a lost race must never throw, only report claimed: false');
});

// ── updateTaskFromXRun: sanitized jsonb result, correct status mapping ──

test('updateTaskFromXRun writes the mapped status and redacts a string result, never a raw transcript', async () => {
  const transport = createMockPublicTasksTransport([queuedRow({ status: 'running' })]);
  const client = new PublicTasksClient({ supabaseUrl: 'https://example.supabase.co', fetchFn: transport.fetch });
  client.setSession({ accessToken: 'jwt-token', ownerId: 'owner-A' });

  const secretLookingResult = 'Result included Bearer abc123def456ghi789 in the evidence log';
  const ok = await client.updateTaskFromXRun({
    id: 'row-1', xStatus: 'completed',
    result: secretLookingResult,
    error: null,
  });
  assert.equal(ok, true);
  const row = transport.getRows()[0];
  assert.equal(row.status, 'completed');
  assert.ok(row.finished_at);
  assert.notEqual(row.result, secretLookingResult, 'a secret-looking result must be redacted, never stored raw');
  assert.ok(row.result.includes('[REDACTED]'), 'the redacted marker must be present');
  assert.deepEqual(row.metadata.x_task.task_id, 'remote-task-1', 'metadata.x_task must survive the terminal update untouched');
});

test('updateTaskFromXRun deep-sanitizes an OBJECT-shaped x-result-v1 result without collapsing it to a stringified blob', async () => {
  const transport = createMockPublicTasksTransport([queuedRow({ status: 'running' })]);
  const client = new PublicTasksClient({ supabaseUrl: 'https://example.supabase.co', fetchFn: transport.fetch });
  client.setSession({ accessToken: 'jwt-token', ownerId: 'owner-A' });

  const xResultV1 = {
    version: 'x-result-v1', task_id: 'remote-task-1', gate_status: 'COMPLETED',
    evidence_found: ['Used Bearer abc123def456ghi789 during the check.'],
    blockers: [], files_changed: ['src/marker.txt'],
  };
  const ok = await client.updateTaskFromXRun({ id: 'row-1', xStatus: 'completed', result: xResultV1, error: null });
  assert.equal(ok, true);
  const row = transport.getRows()[0];
  assert.equal(typeof row.result, 'object', 'result must remain a structured jsonb object, never String(result)');
  assert.notEqual(row.result, '[object Object]');
  assert.equal(row.result.version, 'x-result-v1');
  assert.deepEqual(row.result.files_changed, ['src/marker.txt']);
  assert.ok(row.result.evidence_found[0].includes('[REDACTED]'), 'a secret-looking string nested inside the result object must still be redacted');
});

test("finished_at is set for completed/failed but NOT for a 'waiting' outcome (needs_review/interrupted)", async () => {
  const transportA = createMockPublicTasksTransport([queuedRow({ id: 'row-nr', status: 'running' })]);
  const clientA = new PublicTasksClient({ supabaseUrl: 'https://example.supabase.co', fetchFn: transportA.fetch });
  clientA.setSession({ accessToken: 'jwt-token', ownerId: 'owner-A' });
  await clientA.updateTaskFromXRun({ id: 'row-nr', xStatus: 'needs_review', result: null, error: null });
  assert.equal(transportA.getRows()[0].status, 'waiting');
  assert.equal(transportA.getRows()[0].finished_at, undefined, 'needs_review -> waiting must not set finished_at');

  const transportB = createMockPublicTasksTransport([queuedRow({ id: 'row-int', status: 'running' })]);
  const clientB = new PublicTasksClient({ supabaseUrl: 'https://example.supabase.co', fetchFn: transportB.fetch });
  clientB.setSession({ accessToken: 'jwt-token', ownerId: 'owner-A' });
  await clientB.updateTaskFromXRun({ id: 'row-int', xStatus: 'interrupted', result: null, error: null });
  assert.equal(transportB.getRows()[0].status, 'waiting');
  assert.equal(transportB.getRows()[0].finished_at, undefined, 'interrupted -> waiting must not set finished_at');
});

test('updateTaskFromXRun requests user_id, never touches updated_at/sync_version, and never overwrites user_id', async () => {
  let capturedUrl, capturedBody;
  const transport = createMockPublicTasksTransport([queuedRow({ status: 'running' })]);
  const client = new PublicTasksClient({
    supabaseUrl: 'https://example.supabase.co',
    fetchFn: (url, opts) => { capturedUrl = url; capturedBody = JSON.parse(opts.body); return transport.fetch(url, opts); },
  });
  client.setSession({ accessToken: 'jwt-token', ownerId: 'owner-A' });
  await client.updateTaskFromXRun({ id: 'row-1', xStatus: 'completed', result: 'ok', error: null });
  assert.match(capturedUrl, /user_id=eq\.owner-A/);
  assert.doesNotMatch(capturedUrl, /owner_id=/);
  assert.ok(!('updated_at' in capturedBody));
  assert.ok(!('sync_version' in capturedBody));
  assert.ok(!('user_id' in capturedBody), 'user_id must never be part of the write payload');
  assert.equal(transport.getRows()[0].user_id, 'owner-A', 'user_id on the row remains unchanged');
});
