import { resolveHearthRuntimeDatabasePath } from './runtime-paths.mjs';
import { XClaimStore } from './claim-store.mjs';
import { XRunStore } from './run-store.mjs';
import { createOllamaModelAdapter } from './model-adapter.mjs';

/**
 * Lazy, per-process singleton for the real X production dependencies.
 *
 * `XClaimStore` and `XRunStore` are constructed pointed at the SAME
 * resolved `hearth-runtime.sqlite` path -- never a per-tool temp database,
 * never a cwd-relative path, never separate claim/run files. Both classes'
 * own constructors are side-effect-free (they only open the SQLite file
 * lazily, on first real use), so importing or calling this module does not
 * touch the filesystem or a local Ollama instance until an X tool is
 * actually invoked.
 *
 * Global execution admission remains entirely SQLite-backed
 * (`XClaimStore`'s file-level locking). This module deliberately holds no
 * lock of its own: constructing this singleton independently in a second
 * OS process (the forked HTTP MCP server vs. an externally launched stdio
 * MCP server vs. Electron's own process) is the CORRECT, intended pattern
 * -- each process gets its own object, all pointed at the same file, and
 * SQLite itself is what actually serializes them. This is not an
 * in-memory lock and must never be treated as one.
 *
 * STARTUP RECONCILIATION: the first construction in each process also runs
 * `runStore.reconcileStartupState(isClaimLive)` exactly once, before the
 * singleton is ever handed to a caller -- `registerWorkspaceTools` (in
 * mcp/tools.mjs) calls this synchronously, unconditionally, at server
 * construction time in both the stdio and forked-HTTP processes, so this
 * is genuinely "process startup," not "before every x_task poll" (every
 * later call just returns the memoized `singleton` below, never
 * re-running reconciliation). `isClaimLive` is READ-ONLY -- a single
 * `XClaimStore.getActiveClaim(taskId)` lookup and an exact `leaseId`
 * comparison, never `renew`/`release`/`claim`/any write to
 * `x_task_claims` -- so a run whose claim is still genuinely held by a
 * DIFFERENT, still-alive process (e.g. this process restarted while
 * another one is mid-execution against the same shared file) is
 * guaranteed to be left completely untouched; `XRunStore` itself already
 * owns the `BEGIN IMMEDIATE` transaction around the whole decision (see
 * run-store.mjs), and this exact read-only-callback-inside-that-
 * transaction shape is what run-store.mjs's own C4/C5 focused tests
 * already prove safe against a real `XClaimStore`.
 *
 * If reconciliation itself throws (e.g. the SQLite file is unreadable),
 * this function does NOT catch it and does NOT populate `singleton` --
 * the error propagates all the way up through `registerWorkspaceTools` /
 * `createMcpServer`, so `mcp/stdio.mjs` and `mcp/http.mjs` fail loudly at
 * startup rather than silently serving stale, unreconciled X state. This
 * matches how every other setup-time failure in `registerWorkspaceTools`
 * (e.g. an invalid workspace path) already behaves -- no new isolation
 * machinery was introduced for X specifically.
 */
let singleton = null;

/**
 * The exact liveness check XRunStore.reconcileStartupState() requires:
 * read-only, a single XClaimStore.getActiveClaim(taskId) lookup plus an
 * exact leaseId comparison. Factored out so getProductionXRuntime()'s own
 * startup call and reconcileXRuntimeNow() below are provably the same
 * check, not merely similar-looking duplicates.
 */
function makeIsClaimLive(claimStore) {
  return (taskId, claimLeaseId) => {
    const active = claimStore.getActiveClaim(taskId);
    return Boolean(active && active.leaseId === claimLeaseId);
  };
}

export function getProductionXRuntime() {
  if (singleton) return singleton;
  const storagePath = resolveHearthRuntimeDatabasePath();
  const claimStore = new XClaimStore({ storagePath });
  const runStore = new XRunStore({ storagePath });

  runStore.reconcileStartupState(makeIsClaimLive(claimStore));

  singleton = {
    claimStore,
    runStore,
    modelAdapter: createOllamaModelAdapter(),
    ownerId: `mcp-${process.pid}`,
  };
  return singleton;
}

/** Test-only: forces the next getProductionXRuntime() call to construct a fresh singleton. */
export function __resetProductionXRuntimeForTests() {
  singleton = null;
}

/**
 * Fast-restart liveness (wakeup arming): the persisted deadline a caller
 * should schedule a one-shot re-reconciliation for, or null if there is
 * currently nothing X-relevant to wait on. Pure read, no decision beyond
 * the one below, no write -- the caller (Electron) never inspects
 * claim/run truth itself, it only ever receives this one timestamp.
 *
 * The shared claim table (XClaimStore) is deliberately claim-kind-agnostic
 * -- global execution admission (capacity=1) can hold a claim with
 * no corresponding X run. Surfacing that claim's deadline unconditionally
 * would arm an unrelated X wakeup. The correction is to ask XRunStore -- the actual X-side source of
 * truth -- whether that exact leaseId is the one recorded on a still-
 * non-terminal X run (`hasNonTerminalRunForClaimLease`); only then is the
 * claim's expiry X-relevant. This never inspects task_id naming
 * conventions or ownerId --
 * it is answered entirely from X's own already-recorded claim_lease_id.
 * @returns {number|null} epoch-ms leaseExpiresAt, or null
 */
export function getNextXWakeupDeadline() {
  const { claimStore, runStore } = getProductionXRuntime();
  const active = claimStore.getActiveClaim();
  if (!active) return null;
  if (!runStore.hasNonTerminalRunForClaimLease(active.leaseId)) return null;
  return active.leaseExpiresAt;
}

/** Queue-capacity wakeup only: read the current shared lease, regardless of claim kind. */
export function getNextXQueueCapacityDeadline() {
  const { claimStore } = getProductionXRuntime();
  return claimStore.getActiveClaim()?.leaseExpiresAt ?? null;
}

/**
 * Fast-restart liveness (wakeup fire): re-runs the EXACT SAME reconciliation
 * production startup already performs -- XRunStore.reconcileStartupState()
 * with the identical isClaimLive check (see makeIsClaimLive above) -- so a
 * run whose owning process died with the lease still technically unexpired
 * at Hearth's last startup (correctly preserved then) can still be
 * discovered once that lease genuinely expires later, without requiring a
 * second Electron restart. Not a new reconciliation policy: same atomic
 * BEGIN IMMEDIATE transaction, same terminal write, same idempotency,
 * already proven safe by run-store.mjs's own C4/C5 tests -- this function
 * only re-invokes it.
 * @returns {string[]} runIds newly marked interrupted by THIS call only
 */
export function reconcileXRuntimeNow() {
  const { claimStore, runStore } = getProductionXRuntime();
  return runStore.reconcileStartupState(makeIsClaimLive(claimStore));
}
