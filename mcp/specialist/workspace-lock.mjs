import fsSync from 'node:fs';

/**
 * Normalizes a workspace directory path to its realpath for consistent comparison.
 * @param {string} workspace
 * @returns {string}
 */
export function normalizeWorkspacePath(workspace) {
  if (!workspace || typeof workspace !== 'string') return '';
  try {
    return fsSync.realpathSync(workspace);
  } catch {
    return workspace.trim();
  }
}

/**
 * Checks if a workspace currently has an active write-capable worker execution (X or Specialist).
 * @param {string} workspacePath
 * @param {object} deps
 * @param {import('../runtime/job-manager.mjs').JobManager} [deps.jobManager]
 * @param {object} [deps.claimStore]
 * @param {object} [deps.runStore]
 * @param {object} [deps.goalStorage]
 * @returns {{ locked: boolean, reason?: string, activeJobId?: string, activeRunId?: string }}
 */
export function isWorkspaceLocked(workspacePath, { jobManager, claimStore, runStore, goalStorage, ignoreExecutionId } = {}) {
  const targetPath = normalizeWorkspacePath(workspacePath);
  if (!targetPath) return { locked: false };

  // 1. Check active jobs in JobManager
  if (jobManager) {
    const jobs = Array.from(jobManager.jobs.values());
    for (const job of jobs) {
      if (job.status === 'running' || job.status === 'queued') {
        const jobCwd = normalizeWorkspacePath(job.cwd);
        const jobWorkspace = normalizeWorkspacePath(job.metadata?.workspace);
        if (jobCwd === targetPath || jobWorkspace === targetPath) {
          if (ignoreExecutionId && (job.id === ignoreExecutionId || job.metadata?.specialistExecutionId === ignoreExecutionId)) {
            continue;
          }
          return {
            locked: true,
            reason: `Workspace '${workspacePath}' is locked by active background job '${job.id}'`,
            activeJobId: job.id,
          };
        }
      }
    }
  }

  // 2. Check active claims in XClaimStore / XRunStore
  if (claimStore && typeof claimStore.listActiveClaims === 'function') {
    try {
      const activeClaims = claimStore.listActiveClaims();
      for (const claim of activeClaims) {
        if (['claiming', 'executing'].includes(claim.status)) {
          const claimWorkspace = normalizeWorkspacePath(claim.workspaceRoot || claim.workspace);
          if (claimWorkspace === targetPath) {
            return {
              locked: true,
              reason: `Workspace '${workspacePath}' is locked by active X claim '${claim.claimId || claim.id}'`,
              activeRunId: claim.runId || null,
            };
          }
        }
      }
    } catch {}
  }

  // 3. Check Goals in storage for active running specialist executions
  if (goalStorage && typeof goalStorage.listGoals === 'function') {
    try {
      const goals = goalStorage.listGoals();
      for (const g of goals) {
        const gWorkspace = normalizeWorkspacePath(g.workspace);
        if (gWorkspace === targetPath) {
          const activeExec = (g.specialistExecutions || []).find(
            (e) => e.id !== ignoreExecutionId && ['authorized', 'dispatching', 'running'].includes(e.status)
          );
          if (activeExec) {
            return {
              locked: true,
              reason: `Workspace '${workspacePath}' is locked by active specialist execution '${activeExec.id}' in Goal '${g.id}'`,
              activeJobId: activeExec.jobId || null,
            };
          }
        }
      }
    } catch {}
  }

  return { locked: false };
}
