import fs from 'node:fs/promises';

export const revealAuditedItem = async ({ id, items, lstat = fs.lstat, reveal }) => {
  const item = items.get(id);
  if (!item || !item.revealable) return { ok: false, error: 'Item is not in the current audit.' };
  try {
    await lstat(item.path);
  } catch {
    return { ok: false, error: 'Item no longer exists.' };
  }
  reveal(item.path);
  return { ok: true };
};
