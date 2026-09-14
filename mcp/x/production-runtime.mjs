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
 */
let singleton = null;

export function getProductionXRuntime() {
  if (singleton) return singleton;
  const storagePath = resolveHearthRuntimeDatabasePath();
  singleton = {
    claimStore: new XClaimStore({ storagePath }),
    runStore: new XRunStore({ storagePath }),
    modelAdapter: createOllamaModelAdapter(),
    ownerId: `mcp-${process.pid}`,
  };
  return singleton;
}

/** Test-only: forces the next getProductionXRuntime() call to construct a fresh singleton. */
export function __resetProductionXRuntimeForTests() {
  singleton = null;
}
