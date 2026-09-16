import crypto from 'node:crypto';

/**
 * The single canonical JSON stringification formula for x-task-v1 payloads.
 * Sorts object keys deterministically.
 */
export const canonicalJson = (value) => JSON.stringify(value, (_key, item) => {
  if (!item || Array.isArray(item) || typeof item !== 'object') return item;
  return Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]));
});

/**
 * Normalizes an x-task-v1 object with its resolved workspaceRoot.
 */
export const canonicalizeXTask = (task, taskRoot) => ({
  ...task,
  workspace: { ...task.workspace, root: taskRoot },
});

/**
 * Computes the SHA256 hex fingerprint for an x-task-v1 payload.
 */
export const computeXTaskFingerprint = (task, taskRoot) =>
  crypto.createHash('sha256').update(canonicalJson(canonicalizeXTask(task, taskRoot))).digest('hex');
