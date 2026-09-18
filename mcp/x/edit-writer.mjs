import path from 'node:path';
import crypto from 'node:crypto';
import { readFile, writeFile, rename, unlink, link, chmod, realpath, stat as fsStat } from 'node:fs/promises';
import { isProtectedPath } from '../skills/gateway.mjs';
import {
  XContextScopeError, assertValidatedTaskShape, normalizePathString, isTraversal, scopeCheck,
} from './context-loader.mjs';
import { throwIfAborted } from './cancellation.mjs';

/**
 * Bounded, scoped, atomic file-write primitives for x-task-v1 tasks -- the
 * write-side counterpart to Phase 5A's read-only `context-loader.mjs`.
 *
 * safe edit/patch request -> pre-write verification -> atomic bounded write -> evidence
 *
 * This module does not invoke a model, run tests, or run any shell command
 * -- it has no `node:child_process` import at all. It supports exactly
 * three bounded operations: create a new text file, replace a complete
 * existing text file, and apply one or more deterministic exact-match text
 * edits to an existing file (the same "old_string must match exactly and
 * uniquely" contract as a conventional patch/edit tool -- never fuzzy).
 * There is no delete, recursive delete, rename/move across arbitrary
 * caller-supplied paths, or general chmod capability anywhere in this
 * module. `rename`/`unlink`/`link`/`chmod` are used only for this module's
 * own atomic-publish mechanics (see below), always inside a directory that
 * has itself been proven authorized (see "Temp directory authorization"),
 * never on a caller-supplied arbitrary target.
 *
 * Path resolution has NO external authority. There is no gateway object
 * (or any other injectable resolver) consulted for path facts anywhere in
 * this module -- earlier drafts of this module accepted one, but any such
 * object can only ever be a source of truth you'd have to trust, and this
 * write boundary trusts nothing but the real filesystem. `resolveWriteTarget`
 * derives the one candidate absolute path solely from the caller-requested
 * string and this module's own `realpath`-canonicalized `task.workspace.root`,
 * then resolves symlinks by calling `realpath` on that exact path (or its
 * parent, for a not-yet-existing file) -- nothing can substitute a
 * different file than the one actually requested.
 *
 * Scope is authoritative and identical to Phase 5A: `task.workspace.root`
 * is the only filesystem root, and every write target -- including the
 * *resolved* realpath for an existing target, or the resolved realpath of
 * the *nearest existing parent* for a brand-new file -- must fall under
 * `scope.allowed_paths`, outside `scope.forbidden_paths`, and outside every
 * protected/secret path rule, checked BEFORE anything is written. A
 * missing/invalid scope throws, exactly as it does for reads.
 *
 * Temp directory authorization: a sibling temp file is placed next to the
 * target for atomic publish. That temp path is a *different* path from the
 * target, so it is re-authorized on its own terms -- the target's
 * containing directory must itself pass `scopeCheck` (and not be a
 * protected path) before any temp file is created there. This matters for
 * an exact-file grant such as `allowed_paths: ['src/app.js']`: that scope
 * authorizes only that one file, not the `src/` directory, so this module
 * safely REJECTS (PATH_REJECTED) writing to it rather than silently
 * widening the grant to place a temp sibling under `src/`. A directory
 * grant such as `allowed_paths: ['src']` authorizes `src/` itself, so
 * ordinary file-under-directory scopes are unaffected.
 *
 * Every temp path -- whether the real internal generator or the test-only
 * injection seam described below -- is additionally run through
 * `assertSafeTempPath` before any write: it must resolve to exactly the
 * one already-authorized directory, use the reserved internal prefix, and
 * not itself be a protected/secret-shaped name. This makes the temp
 * mechanic structurally incapable of writing to `/tmp`, a different
 * workspace directory, `.env`, or an arbitrary sibling filename, no matter
 * what produced the candidate path.
 *
 * Atomicity and race safety:
 *  - `createFile` publishes via `link(temp, target)` then `unlink(temp)`,
 *    NOT `rename`. `link()` fails with EEXIST if `target` already exists,
 *    so a competing creator that wins the race is never clobbered -- this
 *    is an OS-level atomic compare-and-create, not a check-then-write.
 *  - `replaceFile`/`applyEdits` re-read and re-hash the live target
 *    immediately before the final `rename(temp, target)` publish and abort
 *    (leaving the temp file discarded, target untouched) if it no longer
 *    matches the hash captured at inspection time. This shrinks the
 *    TOCTOU window to the few in-process instructions between the
 *    recheck and the rename syscall; it is not a true cross-process
 *    atomic compare-and-swap on file content (POSIX/Node provide no such
 *    primitive without external locking), so a change landing in that
 *    sub-millisecond window is a disclosed residual risk (see report).
 *  - Every temp file is created with `flag: 'wx'` (exclusive create).
 *    Cleanup on failure only ever unlinks a temp path THIS call itself
 *    successfully created -- if `wx` fails with EEXIST (a name collision
 *    with something this call did not create), that path is left
 *    completely untouched rather than deleted.
 *  - An existing target's file mode (permission bits) is captured and
 *    re-applied to the temp file (via the `mode` option at creation, then
 *    an authoritative `chmod`, since `mode` at creation is subject to
 *    umask masking) before publish, so `replace`/`patch` can never turn an
 *    executable file into a non-executable one. This is internal-only
 *    mode preservation; no caller-facing chmod operation is exposed.
 *
 * Every mutation of an existing file requires an explicit precondition
 * (`expectedHash` or `expectedContent` for `replaceFile`; each edit's own
 * exact `old_string` match for `applyEdits`) -- content that changed since
 * it was last inspected is never silently overwritten. For `applyEdits`,
 * every edit's projected output byte size is computed and bounded BEFORE
 * the replacement string is ever constructed (see `countOccurrences` /
 * the projected-size check), so a small `old_string` with many occurrences
 * and a large `new_string` under `replace_all` is rejected without ever
 * allocating the expanded result.
 */

export const EDIT_ERROR_CODES = Object.freeze([
  'INVALID_SCOPE', 'PATH_REJECTED', 'PROTECTED_PATH', 'SYMLINK_ESCAPE',
  'WRITE_LIMIT_EXCEEDED', 'PRECONDITION_FAILED', 'UNREADABLE_TARGET', 'WRITE_FAILED',
]);

export const DEFAULT_EDIT_LIMITS = Object.freeze({
  maxBytesPerWrite: 200_000,
  maxEditsPerOperation: 10,
  maxBytesPerEditString: 50_000,
  maxAggregateEditBytes: 200_000,
});

// Absolute ceilings a caller's `options.limits` can never exceed.
const HARD_EDIT_LIMITS = Object.freeze({
  maxBytesPerWrite: 1_000_000,
  maxEditsPerOperation: 50,
  maxBytesPerEditString: 500_000,
  maxAggregateEditBytes: 1_000_000,
});

const TEMP_PREFIX = '.x-write-tmp-';
const DEFAULT_NEW_FILE_MODE = 0o644;

export class XEditError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'XEditError';
    this.code = code;
    this.detail = detail;
  }
}

const clampPositiveInt = (value, fallback, hardMax) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), hardMax);
};

/** Merges caller-supplied limits into the defaults, then clamps every field to its hard ceiling -- a caller may only ever reduce a limit, never raise it past the hard maximum. */
const resolveLimits = (overrides) => {
  const merged = { ...DEFAULT_EDIT_LIMITS, ...(overrides || {}) };
  return Object.freeze({
    maxBytesPerWrite: clampPositiveInt(merged.maxBytesPerWrite, DEFAULT_EDIT_LIMITS.maxBytesPerWrite, HARD_EDIT_LIMITS.maxBytesPerWrite),
    maxEditsPerOperation: clampPositiveInt(merged.maxEditsPerOperation, DEFAULT_EDIT_LIMITS.maxEditsPerOperation, HARD_EDIT_LIMITS.maxEditsPerOperation),
    maxBytesPerEditString: clampPositiveInt(merged.maxBytesPerEditString, DEFAULT_EDIT_LIMITS.maxBytesPerEditString, HARD_EDIT_LIMITS.maxBytesPerEditString),
    maxAggregateEditBytes: clampPositiveInt(merged.maxAggregateEditBytes, DEFAULT_EDIT_LIMITS.maxAggregateEditBytes, HARD_EDIT_LIMITS.maxAggregateEditBytes),
  });
};

const sha256 = (content) => crypto.createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');

/** Counts non-overlapping occurrences of `needle` in `haystack` via a scan, never allocating a split array proportional to occurrence count. */
const countOccurrences = (haystack, needle) => {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  for (;;) {
    const found = haystack.indexOf(needle, index);
    if (found === -1) return count;
    count += 1;
    index = found + needle.length;
  }
};

const emptyResult = (operation, relativePath) => ({
  operation,
  path: relativePath,
  status: 'error',
  code: null,
  detail: null,
  before_hash: null,
  after_hash: null,
  bytes_written: 0,
  created: false,
  changed: false,
});

const failure = (operation, relativePath, code, detail) => ({
  ...emptyResult(operation, relativePath),
  code,
  detail: detail || null,
});

/**
 * Resolves and fully authorizes a write target using ONLY the caller-
 * requested path string and our own canonicalized workspace root -- no
 * external object is ever consulted for path facts, so nothing can
 * substitute a different file than the one actually requested.
 * `intendedAbsolute` is derived solely from `canonicalRoot` (self-
 * realpath'd) and `normalized` (the validated, scope-checked request);
 * `realpath` is then applied ONLY to that exact path (or its parent, for a
 * not-yet-existing file) to resolve any symlink in it, and the resulting
 * real path is what everything downstream operates on.
 */
async function resolveWriteTarget(scope, workspaceRoot, rawPath) {
  const normalized = normalizePathString(rawPath);
  if (isTraversal(normalized)) return { ok: false, code: 'PATH_REJECTED', detail: 'path traversal or absolute path rejected' };
  const nominal = scopeCheck(normalized, scope);
  if (!nominal.ok) return { ok: false, code: 'PATH_REJECTED', detail: `'${normalized}' is outside the authorized scope (${nominal.reason})` };
  if (isProtectedPath(normalized)) return { ok: false, code: 'PROTECTED_PATH', detail: `'${normalized}' is a protected/secret path` };

  let canonicalRoot;
  try {
    canonicalRoot = await realpath(workspaceRoot);
  } catch {
    return { ok: false, code: 'PATH_REJECTED', detail: 'workspace root does not exist or is unreadable' };
  }
  const rootStat = await fsStat(canonicalRoot).catch(() => null);
  if (!rootStat?.isDirectory()) return { ok: false, code: 'PATH_REJECTED', detail: 'workspace root is not a directory' };

  // The ONLY candidate path ever considered -- built exclusively from the
  // requested string and our own root. Nothing external can substitute a
  // different filename here.
  const intendedAbsolute = path.resolve(canonicalRoot, normalized);

  let verifiedAbsolute;
  let exists = true;
  try {
    verifiedAbsolute = await realpath(intendedAbsolute);
  } catch (err) {
    if (err?.code !== 'ENOENT') return { ok: false, code: 'UNREADABLE_TARGET', detail: err?.code || err?.message || 'target could not be resolved' };
    exists = false;
    let parentReal;
    try {
      parentReal = await realpath(path.dirname(intendedAbsolute));
    } catch {
      return { ok: false, code: 'PATH_REJECTED', detail: 'parent directory does not exist; this module does not create directories' };
    }
    const parentStat = await fsStat(parentReal).catch(() => null);
    if (!parentStat?.isDirectory()) return { ok: false, code: 'PATH_REJECTED', detail: 'parent path is not a directory' };
    verifiedAbsolute = path.join(parentReal, path.basename(intendedAbsolute));
  }

  if (exists) {
    const targetStat = await fsStat(verifiedAbsolute).catch(() => null);
    if (targetStat?.isDirectory()) return { ok: false, code: 'PATH_REJECTED', detail: 'target is an existing directory' };
  }

  // Derive the relative path OURSELVES from the canonical root and the
  // independently verified absolute path. This is the only containment
  // check that matters, and it is computed entirely from data this
  // function verified against the real filesystem.
  const relative = path.relative(canonicalRoot, verifiedAbsolute).split(path.sep).join('/');
  if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
    return { ok: false, code: exists ? 'SYMLINK_ESCAPE' : 'PATH_REJECTED', detail: 'resolved path escapes the canonical workspace root' };
  }

  const resolvedCheck = scopeCheck(relative, scope);
  if (!resolvedCheck.ok) return { ok: false, code: exists ? 'SYMLINK_ESCAPE' : 'PATH_REJECTED', detail: `resolved path is outside the authorized scope (${resolvedCheck.reason})` };
  if (isProtectedPath(relative)) return { ok: false, code: 'PROTECTED_PATH', detail: 'resolved path is a protected/secret path' };

  return { ok: true, absolute: verifiedAbsolute, relative, exists };
}

/**
 * Authorizes the target's containing directory for placing an internally
 * generated sibling temporary file required for atomic publication of that
 * authorized target.
 *
 * An exact-file grant (e.g. `allowed_paths: ['src/app.js']`) explicitly
 * authorizes writing to `src/app.js`. For atomic create/replace/patch,
 * edit-writer derives and places ONLY its own internal sibling temporary file
 * directly inside the authorized target's containing directory. The directory
 * itself is not granted as an independent write target to the model (arbitrary
 * sibling writes remain PATH_REJECTED by resolveWriteTarget).
 */
function authorizeTempDirectory(scope, targetRelative) {
  const dirRelative = path.posix.dirname(targetRelative);
  if (!dirRelative || dirRelative === '..' || dirRelative.startsWith('../') || path.posix.isAbsolute(dirRelative)) {
    return { ok: false, detail: 'target has no valid containing directory inside the workspace for atomic-write mechanics' };
  }
  if (dirRelative !== '.' && isProtectedPath(dirRelative)) {
    return { ok: false, detail: `containing directory '${dirRelative}' is a protected path` };
  }
  if (dirRelative !== '.' && Array.isArray(scope.forbidden_paths) && scope.forbidden_paths.some((p) => dirRelative === p || dirRelative.startsWith(`${p}/`))) {
    return { ok: false, detail: `containing directory '${dirRelative}' is inside forbidden_paths` };
  }

  // Permitted if the directory itself is authorized by scope.allowed_paths (directory-level grant):
  if (dirRelative !== '.' && scopeCheck(dirRelative, scope).ok) {
    return { ok: true, dirRelative };
  }

  // Permitted if the target file itself is authorized by scope.allowed_paths (exact-file grant):
  if (scopeCheck(targetRelative, scope).ok) {
    return { ok: true, dirRelative };
  }

  return { ok: false, detail: `containing directory '${dirRelative}' is not authorized for atomic-write mechanics` };
}

/** Reads the current raw (unformatted, untruncated) content + mode of an already-authorized existing target, for hashing/patching/mode-preservation. Bounded by the same hard write ceiling, since a file too large to safely write back is also too large to safely patch here. */
async function readRawForWrite(absolutePath) {
  const stat = await fsStat(absolutePath).catch(() => null);
  if (!stat || !stat.isFile()) return { ok: false, code: 'UNREADABLE_TARGET', detail: 'target is not a regular file' };
  if (stat.size > HARD_EDIT_LIMITS.maxBytesPerWrite) return { ok: false, code: 'WRITE_LIMIT_EXCEEDED', detail: 'existing file exceeds the maximum size this module will read/patch' };
  let buffer;
  try {
    buffer = await readFile(absolutePath);
  } catch (err) {
    return { ok: false, code: 'UNREADABLE_TARGET', detail: err?.message || 'read failed' };
  }
  if (buffer.includes(0)) return { ok: false, code: 'UNREADABLE_TARGET', detail: 'binary file was not read' };
  return { ok: true, content: buffer.toString('utf8'), mode: stat.mode & 0o777 };
}

const defaultTempPathFor = (dir) => path.join(dir, `${TEMP_PREFIX}${process.pid}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);

/**
 * Defends `writeTempFile` against a hostile or buggy temp-path source
 * (including the test-only injection seam below): no matter what path is
 * returned, it can only ever be used if it is lexically, exactly inside
 * the one already-authorized real directory for THIS operation and uses
 * the reserved internal prefix. This makes the internal temp mechanic
 * incapable of writing to `/tmp`, a different workspace directory, a
 * protected path, or an arbitrary sibling filename -- regardless of what
 * produced the candidate path.
 *
 *   1. path.resolve() the candidate (lexical normalization only -- the
 *      path does not exist yet, so there is nothing to realpath)
 *   2. its dirname must be EXACTLY `authorizedDirAbsolute` (the real,
 *      already scope+realpath-verified directory for this write) --
 *      this alone rejects /tmp, another workspace directory, a `../`
 *      traversal, or any symlink-parent substitution, since none of
 *      those can lexically equal the known-good canonical directory
 *   3. its basename must not contain a path separator, `..`, or a NUL
 *   4. its basename must start with the reserved TEMP_PREFIX
 *   5. its basename must not itself be a protected/secret-shaped path
 */
function assertSafeTempPath(candidate, authorizedDirAbsolute) {
  const resolved = path.resolve(candidate);
  const dir = path.dirname(resolved);
  const base = path.basename(resolved);
  if (dir !== authorizedDirAbsolute) {
    throw new XEditError('PATH_REJECTED', 'internal temp path must reside directly inside the authorized directory');
  }
  if (!base || base.includes('..') || base.includes('/') || base.includes('\\') || base.includes('\0') || base !== resolved.slice(dir.length + 1)) {
    throw new XEditError('PATH_REJECTED', 'internal temp path basename is invalid');
  }
  if (!base.startsWith(TEMP_PREFIX)) {
    throw new XEditError('PATH_REJECTED', 'internal temp path must use the reserved internal temp prefix');
  }
  if (isProtectedPath(base)) {
    throw new XEditError('PROTECTED_PATH', 'internal temp path must not be a protected/secret-shaped path');
  }
  return resolved;
}

/**
 * Writes `content` to a freshly, exclusively created (`wx`) sibling temp
 * file in `dir`, applying `mode` both at creation and via an authoritative
 * post-creation `chmod` (creation-time `mode` is subject to umask masking;
 * `chmod` is not). On any failure, the temp path is unlinked ONLY if this
 * call's own `wx` create actually succeeded -- a name collision with a
 * path this call did NOT create (`EEXIST` from `writeFile` itself) leaves
 * that path completely untouched.
 *
 * `tempPathFor` is a TEST-ONLY seam for deterministic collision/race
 * testing -- it is never part of the public `createFile`/`replaceFile`/
 * `applyEdits` contract (see their signatures below, which do not accept
 * it), and whatever it returns is always run through `assertSafeTempPath`
 * before any write, so even a hostile override cannot write outside the
 * one already-authorized directory.
 */
async function writeTempFile(dir, content, mode, tempPathFor = defaultTempPathFor, signal) {
  throwIfAborted(signal);
  const tempAbsolute = assertSafeTempPath(tempPathFor(dir), dir);
  let createdByUs = false;
  try {
    throwIfAborted(signal);
    await writeFile(tempAbsolute, content, { encoding: 'utf8', flag: 'wx', mode: mode ?? DEFAULT_NEW_FILE_MODE });
    createdByUs = true;
    throwIfAborted(signal);
    if (mode !== undefined) await chmod(tempAbsolute, mode);
    throwIfAborted(signal);
  } catch (err) {
    if (createdByUs) await unlink(tempAbsolute).catch(() => {});
    throwIfAborted(signal);
    if (err?.code === 'EEXIST') {
      throw new XEditError('WRITE_FAILED', 'temp file name collision with a path this operation did not create; left untouched', 'EEXIST');
    }
    throw new XEditError('WRITE_FAILED', err?.message || 'temp file write failed', err?.code || null);
  }
  return tempAbsolute;
}

/** Atomic no-clobber publish for `createFile`: `link()` fails with EEXIST if a competing writer already published `targetAbsolute`, so the competing file is never overwritten -- this is the OS-level compare-and-create, not a check-then-rename. */
async function publishNoClobber(tempAbsolute, targetAbsolute, signal) {
  try {
    throwIfAborted(signal);
    await link(tempAbsolute, targetAbsolute);
  } catch (err) {
    await unlink(tempAbsolute).catch(() => {});
    throwIfAborted(signal);
    if (err?.code === 'EEXIST') throw new XEditError('PRECONDITION_FAILED', 'a file already exists at this path; use replaceFile to modify it');
    throw new XEditError('WRITE_FAILED', err?.message || 'atomic no-clobber publish failed', err?.code || null);
  }
  await unlink(tempAbsolute).catch(() => {});
}

/** Publish for `replaceFile`/`applyEdits`: re-reads and re-hashes the live target immediately before the rename and aborts (temp discarded, target untouched) if it no longer matches `expectedBeforeHash`. */
async function publishWithRevalidation(tempAbsolute, targetAbsolute, expectedBeforeHash, signal) {
  const recheck = await readRawForWrite(targetAbsolute);
  if (signal?.aborted) {
    await unlink(tempAbsolute).catch(() => {});
    throwIfAborted(signal);
  }
  if (!recheck.ok || sha256(recheck.content) !== expectedBeforeHash) {
    await unlink(tempAbsolute).catch(() => {});
    throw new XEditError('PRECONDITION_FAILED', 'target content changed after inspection and before publish; write aborted');
  }
  try {
    throwIfAborted(signal);
    await rename(tempAbsolute, targetAbsolute);
  } catch (err) {
    await unlink(tempAbsolute).catch(() => {});
    throwIfAborted(signal);
    throw new XEditError('WRITE_FAILED', err?.message || 'atomic write failed', err?.code || null);
  }
}

async function readBackEvidence(targetAbsolute) {
  const onDisk = (await readFile(targetAbsolute)).toString('utf8');
  return { onDisk, afterHash: sha256(onDisk), bytesWritten: Buffer.byteLength(onDisk, 'utf8') };
}

/**
 * Creates a new text file. Rejected (PRECONDITION_FAILED) if a file
 * already exists at the target -- including one created concurrently
 * between this call's existence check and its publish step, since publish
 * itself is an atomic no-clobber operation, not merely a prior check.
 *
 * @param {object} task validated x-task-v1 (never mutated)
 * @param {string} relPath
 * @param {string} content
 * @param {{ limits?: object, signal?: AbortSignal }} [options]
 */
export async function createFile(task, relPath, content, options = {}) {
  throwIfAborted(options.signal);
  assertValidatedTaskShape(task);
  const operation = 'create';
  if (typeof content !== 'string') return failure(operation, relPath, 'WRITE_FAILED', 'content must be a string');
  const limits = resolveLimits(options.limits);
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > limits.maxBytesPerWrite) return failure(operation, relPath, 'WRITE_LIMIT_EXCEEDED', `content is ${bytes} bytes, over the ${limits.maxBytesPerWrite} byte limit`);

  const target = await resolveWriteTarget(task.scope, task.workspace.root, relPath);
  throwIfAborted(options.signal);
  if (!target.ok) return failure(operation, normalizePathString(relPath), target.code, target.detail);
  if (target.exists) return failure(operation, target.relative, 'PRECONDITION_FAILED', 'a file already exists at this path; use replaceFile to modify it');

  const tempDir = authorizeTempDirectory(task.scope, target.relative);
  if (!tempDir.ok) return failure(operation, target.relative, 'PATH_REJECTED', tempDir.detail);

  try {
    const tempAbsolute = await writeTempFile(path.dirname(target.absolute), content, undefined, options.__testTempPathFor, options.signal);
    await publishNoClobber(tempAbsolute, target.absolute, options.signal);
    const { afterHash, bytesWritten } = await readBackEvidence(target.absolute);
    return {
      operation, path: target.relative, status: 'ok', code: null, detail: null,
      before_hash: null, after_hash: afterHash, bytes_written: bytesWritten, created: true, changed: true,
    };
  } catch (err) {
    throwIfAborted(options.signal);
    if (err instanceof XEditError) return failure(operation, target.relative, err.code, err.message);
    return failure(operation, target.relative, 'WRITE_FAILED', err?.message || 'write failed');
  }
}

/**
 * Replaces the complete content of an existing text file. A precondition
 * is REQUIRED -- `expectedHash` (sha256 hex of the current content) or
 * `expectedContent` (the exact current text) -- and is re-verified again
 * immediately before publish, so content that changed since it was last
 * inspected -- including a change landing after inspection but before this
 * call's own publish step -- is never silently overwritten. The existing
 * file's permission bits are preserved.
 *
 * @param {object} task validated x-task-v1 (never mutated)
 * @param {string} relPath
 * @param {string} content
 * @param {{ expectedHash?: string, expectedContent?: string, limits?: object, signal?: AbortSignal }} options
 */
export async function replaceFile(task, relPath, content, options = {}) {
  throwIfAborted(options.signal);
  assertValidatedTaskShape(task);
  const operation = 'replace';
  if (typeof content !== 'string') return failure(operation, relPath, 'WRITE_FAILED', 'content must be a string');
  if (!options.expectedHash && options.expectedContent === undefined) {
    return failure(operation, normalizePathString(relPath), 'PRECONDITION_FAILED', 'replaceFile requires expectedHash or expectedContent to prevent a blind overwrite');
  }
  const limits = resolveLimits(options.limits);
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > limits.maxBytesPerWrite) return failure(operation, relPath, 'WRITE_LIMIT_EXCEEDED', `content is ${bytes} bytes, over the ${limits.maxBytesPerWrite} byte limit`);

  const target = await resolveWriteTarget(task.scope, task.workspace.root, relPath);
  throwIfAborted(options.signal);
  if (!target.ok) return failure(operation, normalizePathString(relPath), target.code, target.detail);
  if (!target.exists) return failure(operation, target.relative, 'UNREADABLE_TARGET', 'no file exists at this path; use createFile to create it');

  const current = await readRawForWrite(target.absolute);
  throwIfAborted(options.signal);
  if (!current.ok) return failure(operation, target.relative, current.code, current.detail);
  const beforeHash = sha256(current.content);

  if (options.expectedHash && options.expectedHash !== beforeHash) {
    return { ...failure(operation, target.relative, 'PRECONDITION_FAILED', 'expectedHash did not match the current file content'), before_hash: beforeHash };
  }
  if (options.expectedContent !== undefined && options.expectedContent !== current.content) {
    return { ...failure(operation, target.relative, 'PRECONDITION_FAILED', 'expectedContent did not match the current file content'), before_hash: beforeHash };
  }

  const tempDir = authorizeTempDirectory(task.scope, target.relative);
  if (!tempDir.ok) return { ...failure(operation, target.relative, 'PATH_REJECTED', tempDir.detail), before_hash: beforeHash };

  try {
    const tempAbsolute = await writeTempFile(path.dirname(target.absolute), content, current.mode, options.__testTempPathFor, options.signal);
    await publishWithRevalidation(tempAbsolute, target.absolute, beforeHash, options.signal);
    const { afterHash, bytesWritten } = await readBackEvidence(target.absolute);
    return {
      operation, path: target.relative, status: 'ok', code: null, detail: null,
      before_hash: beforeHash, after_hash: afterHash, bytes_written: bytesWritten, created: false, changed: afterHash !== beforeHash,
    };
  } catch (err) {
    throwIfAborted(options.signal);
    if (err instanceof XEditError) return { ...failure(operation, target.relative, err.code, err.message), before_hash: beforeHash };
    return { ...failure(operation, target.relative, 'WRITE_FAILED', err?.message || 'write failed'), before_hash: beforeHash };
  }
}

/**
 * Applies one or more deterministic exact-match text edits to an existing
 * file: each edit's `old_string` must occur exactly once in the file's
 * current working text (or `replace_all: true` to replace every
 * occurrence), or the whole operation is rejected with no write performed.
 * Edits apply in order, each against the result of the previous one. This
 * is intentionally the same "exact, unique match" contract as a
 * conventional patch/edit tool -- never fuzzy matching.
 *
 * Every edit string and the aggregate edit payload are hard-bounded BEFORE
 * any file is read. Then, for each edit, occurrences are counted with a
 * scan (never a `.split()` allocation proportional to occurrence count)
 * and the exact PROJECTED output byte size is computed from that count --
 * `currentBytes - occurrences*oldBytes + occurrences*newBytes` -- and
 * checked against the byte limit BEFORE the replacement string is ever
 * constructed. A small `old_string` with many occurrences and a large
 * `new_string` under `replace_all` is rejected without ever allocating the
 * expanded result.
 *
 * The precondition is re-verified immediately before publish (see
 * `replaceFile`), and the existing file's permission bits are preserved.
 *
 * @param {object} task validated x-task-v1 (never mutated)
 * @param {string} relPath
 * @param {{ old_string: string, new_string: string, replace_all?: boolean }[]} edits
 * @param {{ expectedHash?: string, limits?: object, signal?: AbortSignal }} [options]
 */
export async function applyEdits(task, relPath, edits, options = {}) {
  throwIfAborted(options.signal);
  assertValidatedTaskShape(task);
  const operation = 'patch';
  if (!Array.isArray(edits) || edits.length === 0) return failure(operation, relPath, 'WRITE_FAILED', 'edits must be a non-empty array');
  const limits = resolveLimits(options.limits);
  if (edits.length > limits.maxEditsPerOperation) {
    return failure(operation, relPath, 'WRITE_LIMIT_EXCEEDED', `${edits.length} edits exceeds the ${limits.maxEditsPerOperation} edit limit`);
  }

  // Hard-bound every edit string and the aggregate payload BEFORE resolving
  // the target or reading the file.
  let aggregateBytes = 0;
  for (const [index, edit] of edits.entries()) {
    if (!edit || typeof edit.old_string !== 'string' || typeof edit.new_string !== 'string' || !edit.old_string) {
      return failure(operation, relPath, 'WRITE_FAILED', `edit ${index}: requires a non-empty old_string and a new_string`);
    }
    const oldBytes = Buffer.byteLength(edit.old_string, 'utf8');
    const newBytes = Buffer.byteLength(edit.new_string, 'utf8');
    if (oldBytes > limits.maxBytesPerEditString) return failure(operation, relPath, 'WRITE_LIMIT_EXCEEDED', `edit ${index}: old_string is ${oldBytes} bytes, over the ${limits.maxBytesPerEditString} byte limit`);
    if (newBytes > limits.maxBytesPerEditString) return failure(operation, relPath, 'WRITE_LIMIT_EXCEEDED', `edit ${index}: new_string is ${newBytes} bytes, over the ${limits.maxBytesPerEditString} byte limit`);
    aggregateBytes += oldBytes + newBytes;
  }
  if (aggregateBytes > limits.maxAggregateEditBytes) {
    return failure(operation, relPath, 'WRITE_LIMIT_EXCEEDED', `aggregate edit payload is ${aggregateBytes} bytes, over the ${limits.maxAggregateEditBytes} byte limit`);
  }

  const target = await resolveWriteTarget(task.scope, task.workspace.root, relPath);
  throwIfAborted(options.signal);
  if (!target.ok) return failure(operation, normalizePathString(relPath), target.code, target.detail);
  if (!target.exists) return failure(operation, target.relative, 'UNREADABLE_TARGET', 'no file exists at this path to patch');

  const current = await readRawForWrite(target.absolute);
  throwIfAborted(options.signal);
  if (!current.ok) return failure(operation, target.relative, current.code, current.detail);
  const beforeHash = sha256(current.content);

  if (options.expectedHash && options.expectedHash !== beforeHash) {
    return { ...failure(operation, target.relative, 'PRECONDITION_FAILED', 'expectedHash did not match the current file content'), before_hash: beforeHash };
  }

  let working = current.content;
  let workingBytes = Buffer.byteLength(working, 'utf8');
  for (const [index, edit] of edits.entries()) {
    const occurrences = countOccurrences(working, edit.old_string);
    if (occurrences === 0) {
      return { ...failure(operation, target.relative, 'PRECONDITION_FAILED', `edit ${index}: old_string not found`), before_hash: beforeHash };
    }
    if (!edit.replace_all && occurrences > 1) {
      return { ...failure(operation, target.relative, 'PRECONDITION_FAILED', `edit ${index}: old_string is not unique (${occurrences} occurrences); pass replace_all to replace every occurrence`), before_hash: beforeHash };
    }

    const applyCount = edit.replace_all ? occurrences : 1;
    const oldBytes = Buffer.byteLength(edit.old_string, 'utf8');
    const newBytes = Buffer.byteLength(edit.new_string, 'utf8');
    const projectedBytes = workingBytes - (applyCount * oldBytes) + (applyCount * newBytes);
    if (projectedBytes > limits.maxBytesPerWrite) {
      return { ...failure(operation, target.relative, 'WRITE_LIMIT_EXCEEDED', `edit ${index}: projected result is ${projectedBytes} bytes, over the ${limits.maxBytesPerWrite} byte limit`), before_hash: beforeHash };
    }

    working = edit.replace_all
      ? working.split(edit.old_string).join(edit.new_string)
      : working.replace(edit.old_string, edit.new_string);
    workingBytes = Buffer.byteLength(working, 'utf8');
  }

  if (workingBytes > limits.maxBytesPerWrite) {
    return { ...failure(operation, target.relative, 'WRITE_LIMIT_EXCEEDED', `resulting content is ${workingBytes} bytes, over the ${limits.maxBytesPerWrite} byte limit`), before_hash: beforeHash };
  }

  const tempDir = authorizeTempDirectory(task.scope, target.relative);
  if (!tempDir.ok) return { ...failure(operation, target.relative, 'PATH_REJECTED', tempDir.detail), before_hash: beforeHash };

  try {
    const tempAbsolute = await writeTempFile(path.dirname(target.absolute), working, current.mode, options.__testTempPathFor, options.signal);
    await publishWithRevalidation(tempAbsolute, target.absolute, beforeHash, options.signal);
    const { afterHash, bytesWritten } = await readBackEvidence(target.absolute);
    return {
      operation, path: target.relative, status: 'ok', code: null, detail: null,
      before_hash: beforeHash, after_hash: afterHash, bytes_written: bytesWritten, created: false, changed: afterHash !== beforeHash,
    };
  } catch (err) {
    throwIfAborted(options.signal);
    if (err instanceof XEditError) return { ...failure(operation, target.relative, err.code, err.message), before_hash: beforeHash };
    return { ...failure(operation, target.relative, 'WRITE_FAILED', err?.message || 'write failed'), before_hash: beforeHash };
  }
}

export { XContextScopeError as XEditScopeError };
