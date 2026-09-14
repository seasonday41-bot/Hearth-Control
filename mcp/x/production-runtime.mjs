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

export function getProductionXRuntime() {
  if (singleton) return singleton;
  const storagePath = resolveHearthRuntimeDatabasePath();
  const claimStore = new XClaimStore({ storagePath });
  const runStore = new XRunStore({ storagePath });

  const isClaimLive = (taskId, claimLeaseId) => {
    const active = claimStore.getActiveClaim(taskId);
    return Boolean(active && active.leaseId === claimLeaseId);
  };
  runStore.reconcileStartupState(isClaimLive);

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
