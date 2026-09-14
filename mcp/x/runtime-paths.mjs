import path from 'node:path';
import os from 'node:os';

/**
 * Process-independent resolver for the single shared Hearth runtime SQLite
 * database (global execution admission + X run status/result). Used
 * identically by the Electron main process, the forked HTTP MCP server, and
 * an externally-launched stdio MCP server -- none of which share memory, so
 * this resolver deliberately has NO Electron dependency and computes a pure
 * function of its inputs only (`env`/`homedir` are both injectable for
 * deterministic testing).
 *
 * This never creates any directory -- callers (XClaimStore, XRunStore)
 * already `fs.mkdirSync(path.dirname(storagePath), { recursive: true })`
 * themselves before opening the database, matching this codebase's existing
 * convention (see claim-store.mjs).
 *
 * `HEARTH_RUNTIME_DIR`, when set to a non-empty value, MUST be an absolute
 * path: a relative override would resolve differently depending on each
 * process's own working directory (Electron main vs. a forked child vs. an
 * externally-launched stdio server), silently breaking the "identical path
 * for the same user across every process" requirement this resolver exists
 * to guarantee. `path.resolve()` is deliberately never used for the same
 * reason -- it would silently anchor a relative override to whichever
 * process happened to call this function, rather than surfacing the
 * ambiguity as an error.
 */

export const HEARTH_RUNTIME_DB_FILENAME = 'hearth-runtime.sqlite';

/**
 * @param {{ env?: object, homedir?: () => string }} [options]
 * @returns {string} absolute path to the shared runtime SQLite database
 */
export function resolveHearthRuntimeDatabasePath({ env = process.env, homedir = os.homedir } = {}) {
  const raw = env?.HEARTH_RUNTIME_DIR;
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (trimmed) {
    if (!path.isAbsolute(trimmed)) {
      throw new TypeError(`HEARTH_RUNTIME_DIR must be an absolute path; received '${trimmed}'`);
    }
    return path.join(trimmed, HEARTH_RUNTIME_DB_FILENAME);
  }
  return path.join(homedir(), '.hearth-control', 'runtime', HEARTH_RUNTIME_DB_FILENAME);
}
