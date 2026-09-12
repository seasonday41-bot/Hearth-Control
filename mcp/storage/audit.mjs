import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setImmediate as yieldToLoop } from 'node:timers/promises';

export const CLASSIFICATION = Object.freeze({
  SAFE_ISH: 'SAFE_ISH', REVIEW: 'REVIEW', KEEP: 'KEEP', PROTECTED_OR_UNKNOWN: 'PROTECTED_OR_UNKNOWN',
});

const PROTECTED_NAME = /(credential|secret|token|oauth|session|cookie|password|keychain|transcript|private.?key|auth)/i;
const PROTECTED_SEGMENTS = new Set(['.ssh', '.gnupg', '.aws', '.config', '.env', 'keychains', 'cookies', 'sessions', 'credentials', 'transcripts']);
const normalizePath = (value) => path.resolve(String(value));
const isWithin = (candidate, root) => candidate === root || candidate.startsWith(`${root}${path.sep}`);
const displayPath = (value, home) => value === home ? '~' : value.startsWith(`${home}${path.sep}`) ? `~${value.slice(home.length)}` : value;

export const isProtectedPath = (value) => {
  const segments = normalizePath(value).split(path.sep).filter(Boolean);
  return segments.some((segment) => PROTECTED_SEGMENTS.has(segment.toLowerCase()) || PROTECTED_NAME.test(segment));
};

const area = (id, root, name, classification, reason, evidence, extras = {}) => ({
  id, root: normalizePath(root), name, classification, reason, evidence, ...extras,
});

/** Known roots only. Optional software is represented by optional paths and skipped when absent. */
export const createDefaultScanAreas = ({ home = os.homedir(), workspace = null, hearthDataPath = null, hearthProjectPath = null } = {}) => {
  const homeRoot = normalizePath(home);
  const library = path.join(home, 'Library');
  const areas = [
    area('macos-caches', path.join(library, 'Caches'), 'macOS application caches', CLASSIFICATION.SAFE_ISH, 'Application cache location; files are usually regenerated.', ['Known macOS cache directory'], { listChildren: true, riskLevel: 'MEDIUM', recreatable: 'UNKNOWN' }),
    area('ollama-models', path.join(home, '.ollama', 'models'), 'Ollama models', CLASSIFICATION.REVIEW, 'Local AI models may be expensive to download again or actively used.', ['Ollama model directory'], { riskLevel: 'MEDIUM', recreatable: 'YES' }),
    area('homebrew-cache', path.join(library, 'Caches', 'Homebrew'), 'Homebrew cache', CLASSIFICATION.SAFE_ISH, 'Downloaded Homebrew cache artifacts are generally re-creatable.', ['Known Homebrew cache directory'], { riskLevel: 'LOW', recreatable: 'YES' }),
    area('vscode-data', path.join(library, 'Application Support', 'Code'), 'VS Code data', CLASSIFICATION.REVIEW, 'Editor data can contain extensions, settings, and working state.', ['Known VS Code application data'], { riskLevel: 'HIGH', recreatable: 'UNKNOWN' }),
    area('vscode-cache', path.join(library, 'Application Support', 'Code', 'Cache'), 'VS Code cache', CLASSIFICATION.SAFE_ISH, 'Editor cache is likely regenerated.', ['Known VS Code cache subdirectory'], { riskLevel: 'MEDIUM', recreatable: 'YES' }),
    area('docker-data', path.join(library, 'Containers', 'com.docker.docker', 'Data'), 'Docker data', CLASSIFICATION.REVIEW, 'Containers, images, and volumes may contain persistent data.', ['Known Docker data root'], { riskLevel: 'HIGH', recreatable: 'UNKNOWN' }),
    area('unity-data', path.join(library, 'Application Support', 'Unity'), 'Unity data', CLASSIFICATION.REVIEW, 'Unity application data can include reusable and persistent assets.', ['Known Unity application data'], { riskLevel: 'MEDIUM', recreatable: 'UNKNOWN' }),
    area('unity-cache', path.join(library, 'Caches', 'com.unity3d.UnityEditor5.x'), 'Unity cache', CLASSIFICATION.SAFE_ISH, 'Unity cache is likely regenerated.', ['Known Unity cache location'], { riskLevel: 'MEDIUM', recreatable: 'UNKNOWN' }),
  ];
  if (workspace && isWithin(normalizePath(workspace), homeRoot) && normalizePath(workspace) !== homeRoot
    && !isProtectedPath(workspace) && (!hearthProjectPath || normalizePath(workspace) !== normalizePath(hearthProjectPath))) {
    const root = normalizePath(workspace);
    for (const name of ['dist', 'build', 'release', 'node_modules']) {
      areas.push(area(`workspace-${name}`, path.join(root, name), `${name} · active workspace`, CLASSIFICATION.REVIEW, 'Build or dependency output in the active workspace; review before removing.', ['Known developer output name', 'Active workspace path'], { riskLevel: 'MEDIUM', recreatable: 'UNKNOWN' }));
    }
  }
  if (hearthDataPath) areas.push(area('hearth-data', hearthDataPath, 'Hearth runtime data', CLASSIFICATION.KEEP, 'Current Hearth application state should normally remain.', ['Active Hearth user data directory'], { riskLevel: 'HIGH', recreatable: 'NO' }));
  if (hearthProjectPath) {
    const project = normalizePath(hearthProjectPath);
    areas.push(area('hearth-dist', path.join(project, 'dist'), 'Hearth renderer build', CLASSIFICATION.SAFE_ISH, 'Generated Hearth renderer files can be rebuilt from source.', ['Known Hearth build output'], { riskLevel: 'LOW', recreatable: 'YES' }));
    areas.push(area('hearth-release', path.join(project, 'release'), 'Hearth release output', CLASSIFICATION.REVIEW, 'Packaged release files may be needed as local backups.', ['Known Hearth release output'], { riskLevel: 'MEDIUM', recreatable: 'UNKNOWN' }));
    areas.push(area('hearth-outputs', path.join(project, 'outputs'), 'Hearth verified artifacts', CLASSIFICATION.KEEP, 'Current verified app artifacts should remain available.', ['Known Hearth packaged artifact location'], { riskLevel: 'HIGH', recreatable: 'UNKNOWN' }));
  }
  return areas;
};

export const classifyPath = (candidate, scanArea) => {
  const resolved = normalizePath(candidate);
  if (isProtectedPath(resolved)) return {
    classification: CLASSIFICATION.PROTECTED_OR_UNKNOWN,
    reason: 'Sensitive or protected location; contents were not inspected.',
    evidence: ['Protected path name'], riskLevel: 'HIGH', recreatable: 'UNKNOWN', protected: true,
  };
  if (!scanArea || !isWithin(resolved, scanArea.root)) return {
    classification: CLASSIFICATION.PROTECTED_OR_UNKNOWN,
    reason: 'Not enough evidence to classify this location.',
    evidence: ['Unknown folder type'], riskLevel: 'UNKNOWN', recreatable: 'UNKNOWN', protected: false,
  };
  return {
    classification: scanArea.classification,
    reason: scanArea.reason,
    evidence: [...scanArea.evidence],
    riskLevel: scanArea.riskLevel || 'UNKNOWN',
    recreatable: scanArea.recreatable || 'UNKNOWN',
    protected: false,
  };
};

const getId = (value) => createHash('sha256').update(value).digest('hex').slice(0, 20);

/** Counts metadata only. Symlinks and protected subtrees are never traversed. */
export const measurePath = async (root, { fsApi = fs, maxEntries = 120_000, maxDepth = 32, excludePaths = [] } = {}) => {
  const stack = [{ value: root, depth: 0 }];
  let sizeBytes = 0;
  let fileCount = 0;
  let incomplete = false;
  let modifiedAt = null;
  let kind = 'directory';
  while (stack.length) {
    if (fileCount >= maxEntries) { incomplete = true; break; }
    const { value, depth } = stack.pop();
    if (value !== root && excludePaths.some((excluded) => isWithin(value, excluded))) continue;
    let stat;
    try { stat = await fsApi.lstat(value); }
    catch (error) { if (error?.code !== 'ENOENT') incomplete = true; continue; }
    fileCount++;
    if (value === root) { modifiedAt = stat.mtime?.toISOString?.() || null; kind = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'file'; }
    if (stat.isSymbolicLink()) { incomplete = true; continue; }
    if (isProtectedPath(value)) {
      incomplete = true;
      if (!stat.isDirectory()) sizeBytes += stat.size || 0;
      continue;
    }
    if (!stat.isDirectory()) { sizeBytes += stat.size || 0; continue; }
    if (depth >= maxDepth) { incomplete = true; continue; }
    let children;
    try { children = await fsApi.readdir(value); }
    catch { incomplete = true; continue; }
    for (const child of children) stack.push({ value: path.join(value, child), depth: depth + 1 });
    if (fileCount % 250 === 0) await yieldToLoop();
  }
  return { sizeBytes, fileCount, modifiedAt, kind, incomplete };
};

export const sortItemsBySize = (items) => [...items].sort((a, b) => b.sizeBytes - a.sizeBytes || a.name.localeCompare(b.name));
export const potentiallyReclaimableBytes = (items) => items.reduce((total, item) => total + (item.classification === CLASSIFICATION.SAFE_ISH && !item.protected && !item.incomplete ? item.sizeBytes : 0), 0);

export const scanStorage = async ({ areas, home = os.homedir(), fsApi = fs, onProgress = () => {}, maxEntries = 120_000 } = {}) => {
  const items = [];
  const selectedAreas = areas || createDefaultScanAreas({ home });
  const roots = selectedAreas.map((entry) => entry.root);
  let remainingEntries = maxEntries;
  for (const scanArea of selectedAreas) {
    if (remainingEntries <= 0) break;
    onProgress({ area: scanArea.name, path: displayPath(scanArea.root, home) });
    let rootStat;
    try { rootStat = await fsApi.lstat(scanArea.root); }
    catch { continue; }
    if (rootStat.isSymbolicLink()) continue;
    const paths = [scanArea.root];
    if (scanArea.listChildren && rootStat.isDirectory()) {
      try {
        const children = await fsApi.readdir(scanArea.root);
        paths.push(...children.map((name) => path.join(scanArea.root, name)).filter((value) => !roots.some((root) => root !== scanArea.root && isWithin(value, root))));
      } catch {}
    }
    for (const value of paths) {
      if (remainingEntries <= 0) break;
      // A root with children is a navigation heading only; child sizes are the counted candidates.
      if (value === scanArea.root && paths.length > 1) continue;
      const classification = classifyPath(value, scanArea);
      const measured = await measurePath(value, {
        fsApi,
        maxEntries: remainingEntries,
        excludePaths: roots.filter((root) => root !== scanArea.root && isWithin(root, value)),
      });
      remainingEntries -= measured.fileCount;
      if (measured.fileCount === 0) continue;
      if (measured.kind === 'symlink') continue;
      items.push({
        id: getId(value), path: value, displayPath: displayPath(value, home),
        name: value === scanArea.root ? scanArea.name : path.basename(value),
        ...measured, ...classification,
        activeUsage: scanArea.id === 'hearth-data' ? 'YES' : 'UNKNOWN',
        revealable: measured.kind !== 'symlink',
        whatIsThis: classification.reason,
        ifRemoved: classification.classification === CLASSIFICATION.SAFE_ISH
          ? 'The application may recreate this data, possibly after a delay or re-download.'
          : classification.classification === CLASSIFICATION.KEEP
            ? 'Current application data or settings may be lost.'
            : 'Consequences are uncertain; inspect this location before deciding.',
      });
    }
  }
  let disk = { usedBytes: null, totalBytes: null };
  try {
    const stat = await fsApi.statfs(home, { bigint: true });
    const totalBytes = Number(stat.blocks * stat.bsize);
    const usedBytes = Number((stat.blocks - stat.bfree) * stat.bsize);
    if (Number.isFinite(totalBytes) && Number.isFinite(usedBytes)) disk = { usedBytes, totalBytes };
  } catch {}
  const sorted = sortItemsBySize(items);
  return { scannedAt: new Date().toISOString(), disk, items: sorted, potentiallyReclaimableBytes: potentiallyReclaimableBytes(sorted) };
};
