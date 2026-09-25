import fs from 'node:fs/promises';
import path from 'node:path';

export const createWorkspaceGuard = (workspace) => {
  const root = workspace ? path.resolve(workspace) : '';

  const requireRoot = () => {
    if (!root || !path.isAbsolute(root)) throw new Error('No valid workspace is configured. Choose a workspace in Hearth Control first.');
    return root;
  };

  const resolvePath = (relativePath = '.') => {
    const workspaceRoot = requireRoot();
    const candidate = path.resolve(workspaceRoot, relativePath);
    if (candidate !== workspaceRoot && !candidate.startsWith(`${workspaceRoot}${path.sep}`)) {
      throw new Error('Path is outside the configured workspace.');
    }
    return candidate;
  };

  const resolveExistingPath = async (relativePath = '.') => {
    const workspaceRoot = await fs.realpath(requireRoot());
    const candidate = await fs.realpath(resolvePath(relativePath));
    if (candidate !== workspaceRoot && !candidate.startsWith(`${workspaceRoot}${path.sep}`)) {
      throw new Error('Resolved path escapes the configured workspace.');
    }
    return candidate;
  };

  const resolveWritablePath = async (relativePath) => {
    const candidate = resolvePath(relativePath);
    const parent = await fs.realpath(path.dirname(candidate));
    const workspaceRoot = await fs.realpath(requireRoot());
    if (parent !== workspaceRoot && !parent.startsWith(`${workspaceRoot}${path.sep}`)) {
      throw new Error('Write target escapes the configured workspace.');
    }
    const existing = await fs.lstat(candidate).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (existing?.isSymbolicLink()) throw new Error('Writing through a symbolic link is not permitted.');
    return candidate;
  };

  return { root, resolvePath, resolveExistingPath, resolveWritablePath };
};
