// Focused tests for the renderer's approval FIFO queue in src/App.tsx:
// upsertApproval/removeApproval as the pure, deterministic queue-transition
// logic behind the single-slot-overwrite fix and the stale-modal-after-
// timeout fix (see docs of both functions in App.tsx itself).
//
// src/App.tsx is a .tsx React component file (JSX, TypeScript type
// annotations) with no Vitest/React Testing Library infrastructure in this
// project, so it cannot be imported or rendered directly in a plain Node
// test process. Consistent with this repo's established pattern for
// un-importable source (scripts/test-updater.mjs,
// scripts/test-electron-x-wakeup.mjs, scripts/test-electron-window-lifecycle.mjs,
// scripts/test-http-approval-lifecycle.mjs), this suite:
//  - extracts the EXACT committed upsertApproval/removeApproval text, strips
//    only their parameter/return TYPE ANNOTATIONS (a narrow, exact string
//    replacement tuned to this specific, known function signature -- not a
//    general TypeScript-stripping tool), and executes the result via
//    new Function against real arguments -- proving the real committed pure
//    logic, never a hand-copied duplicate;
//  - statically verifies (exact substring checks on the raw source) that
//    answerApproval and the Escape handler are wired to remove only the
//    currently active (queue head) requestId through that same
//    removeApproval function, since those two are closures over component
//    state and cannot be extracted and executed in isolation the same way.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const appSource = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

// ── extraction ───────────────────────────────────────────────────────────

const queueLogicStart = appSource.indexOf('export const upsertApproval = ');
const queueLogicEnd = appSource.indexOf('\n\nconst initialPermissions');
assert.ok(queueLogicStart !== -1 && queueLogicEnd !== -1, 'the upsertApproval/removeApproval block must be found in src/App.tsx');
let queueLogicSource = appSource.slice(queueLogicStart, queueLogicEnd);

// Narrow, exact strips of this one known signature shape -- not a general
// TS-stripping tool. If the real signatures ever change incompatibly, these
// replacements simply stop matching and the factory below throws a syntax
// error, failing this suite loudly rather than silently testing stale logic.
queueLogicSource = queueLogicSource
  .replaceAll('export const ', 'const ')
  .replace('(queue: ApprovalRequest[], incoming: ApprovalRequest): ApprovalRequest[] => {', '(queue, incoming) => {')
  .replace('(queue: ApprovalRequest[], requestId: string): ApprovalRequest[] => {', '(queue, requestId) => {');
assert.doesNotMatch(queueLogicSource, /:\s*ApprovalRequest/, 'all known type annotations must have been stripped');

const { upsertApproval, removeApproval } = new Function(`${queueLogicSource}\nreturn { upsertApproval, removeApproval };`)();

// ── dynamic: the exact extracted, type-stripped committed logic ──────────

const A = { requestId: 'A', permission: 'Antigravity', action: 'do A' };
const B = { requestId: 'B', permission: 'Terminal', action: 'do B' };

test('APP-Q1 A then B arrives -- A remains active (queue head), B is queued behind it', () => {
  const afterA = upsertApproval([], A);
  const afterB = upsertApproval(afterA, B);
  assert.deepEqual(afterB, [A, B]);
  assert.deepEqual(afterB[0], A, 'the active approval (queue head) must still be A');
});

test('APP-Q2 resolving A promotes B to active', () => {
  const queue = [A, B];
  const afterResolveA = removeApproval(queue, A.requestId);
  assert.deepEqual(afterResolveA, [B]);
  assert.deepEqual(afterResolveA[0], B, 'B must now be the active approval');
});

test('APP-Q3 resolving B while A is active leaves A active and unchanged', () => {
  const queue = [A, B];
  const afterResolveB = removeApproval(queue, B.requestId);
  assert.deepEqual(afterResolveB, [A]);
  assert.deepEqual(afterResolveB[0], A, 'A must remain the active approval, undisturbed');
});

test('APP-Q4 a duplicate approval requestId is never queued twice', () => {
  const once = upsertApproval([], A);
  const twice = upsertApproval(once, { ...A, action: 'a different action text for the same id' });
  assert.equal(twice.length, 1);
  assert.deepEqual(twice, once, 'the original entry must be preserved unchanged, not replaced');
});

test('APP-Q5 an unknown or late approval:resolved requestId is a harmless no-op', () => {
  const queue = [A, B];
  const result = removeApproval(queue, 'not-a-real-id');
  assert.equal(result, queue, 'an unknown requestId must return the exact same array reference (true no-op)');
});

test('APP-Q8 resolving the last remaining request leaves an empty queue (no modal)', () => {
  const queue = [A];
  const result = removeApproval(queue, A.requestId);
  assert.deepEqual(result, []);
});

// ── static: real committed source shape for click/Escape (cases 6 and 7) ──
// answerApproval and the Escape keydown handler are closures over component
// state (approval, setApprovalQueue) and cannot be extracted/executed in
// isolation the same way the pure queue functions above can. Proven
// structurally instead, via exact substring checks: both must resolve only
// the CURRENT active request (approval.requestId, i.e. the queue head)
// through the same removeApproval used everywhere else, never a queue-wide
// clear.

const answerApprovalStart = appSource.indexOf('const answerApproval = async (allowedChoice: boolean) => {');
const answerApprovalEnd = appSource.indexOf('\n\n  const navigate');
assert.ok(answerApprovalStart !== -1 && answerApprovalEnd !== -1, 'answerApproval must be found in src/App.tsx');
const answerApprovalSource = appSource.slice(answerApprovalStart, answerApprovalEnd);

test('APP-S1 answerApproval resolves only the active approval, via respondToApproval then removeApproval', () => {
  assert.ok(
    answerApprovalSource.includes('const { requestId, action } = approval;'),
    "must capture the active approval's own requestId before anything async happens",
  );
  assert.ok(
    answerApprovalSource.includes(
      'await window.controlApp.respondToApproval({ requestId, allowed: allowedChoice });',
    ),
    'must send the response for exactly that requestId',
  );
  assert.ok(
    answerApprovalSource.includes(
      'setApprovalQueue((current) => removeApproval(current, requestId));',
    ),
    'must remove exactly that requestId from the queue',
  );
  assert.ok(
    !answerApprovalSource.includes('setApprovalQueue([])'),
    'must never clear the whole queue',
  );
});

const escapeEffectStart = appSource.indexOf('if (!approval) return;\n    const handleKeyDown');
assert.ok(escapeEffectStart !== -1, 'the Escape-key effect must be found in src/App.tsx');
const escapeEffectSource = appSource.slice(escapeEffectStart, escapeEffectStart + 300);

test('APP-S2 Escape denies only the currently active approval, via answerApproval(false)', () => {
  assert.ok(
    escapeEffectSource.includes("if (e.key === 'Escape') {"),
    'Escape branch must exist',
  );
  assert.ok(
    escapeEffectSource.includes('void answerApproval(false);'),
    'Escape must deny only the active approval through answerApproval(false)',
  );
});

test('APP-S3 the renderer state is a queue, not a single overwritable slot', () => {
  assert.ok(
    appSource.includes(
      'const [approvalQueue, setApprovalQueue] = useState<ApprovalRequest[]>([]);',
    ),
  );
  assert.ok(
    appSource.includes('const approval = approvalQueue[0] ?? null;'),
    'the active approval must be the FIFO head',
  );
  assert.ok(
    !appSource.includes('useState<ApprovalRequest | null>'),
    'the old single-slot approval state must be gone',
  );
});

test('APP-S4 an approval:resolved server event removes exactly its own requestId from the queue', () => {
  assert.ok(
    appSource.includes(
      "if (event.type === 'approval:resolved' && event.requestId) {",
    ),
  );
  assert.ok(
    appSource.includes(
      'setApprovalQueue((current) => removeApproval(current, event.requestId!));',
    ),
    'approval:resolved must remove only its own requestId',
  );
});

test('APP-S5 an approval event upserts (never unconditionally overwrites) the queue', () => {
  const guard = "if (event.type === 'approval' && event.requestId && event.permission && event.action) {";
  const branchStart = appSource.indexOf(guard);
  assert.notEqual(branchStart, -1, 'the approval-event guard must be present');

  // Assert the BEHAVIOUR of the branch, not one exact source line: the incoming
  // request may legitimately be hoisted into a local so sibling calls (evidence
  // recording) can reuse it. What must never change is that the queue is only
  // ever updated through upsertApproval -- never replaced wholesale.
  const branch = appSource.slice(branchStart, appSource.indexOf('\n      }', branchStart));

  const upsertCall = branch.match(/setApprovalQueue\(\(current\) => upsertApproval\(current, ([^)]+)\)\);/);
  assert.ok(upsertCall, 'approval must be upserted, never overwrite the queue');

  const incoming = upsertCall[1].trim();
  const incomingLiteral = incoming.startsWith('{')
    ? incoming
    : (appSource.slice(branchStart).match(new RegExp(`const ${incoming} = (\\{[^}]+\\});`)) || [])[1];
  assert.ok(incomingLiteral, `the upserted value ${incoming} must be an object literal built in this branch`);
  for (const field of ['requestId: event.requestId!', 'permission: event.permission!', 'action: event.action!']) {
    assert.ok(incomingLiteral.includes(field), `the upserted request must carry ${field}`);
  }

  assert.doesNotMatch(
    branch,
    /setApprovalQueue\((?!\(current\) => upsertApproval)/,
    'the approval branch must not write the queue by any other path',
  );
});
