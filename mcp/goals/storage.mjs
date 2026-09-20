import fs from 'node:fs';
import path from 'node:path';
import { validateGoal, createGoal, createGoalCheckpoint } from './model.mjs';

export class GoalStorage {
  /**
   * @param {string | { storagePath: string }} options
   */
  constructor(options) {
    const storagePath = typeof options === 'string' ? options : options?.storagePath;
    if (!storagePath || typeof storagePath !== 'string') {
      throw new Error('storagePath is required for GoalStorage');
    }
    this.storagePath = storagePath;
    this.backupPath = `${storagePath}.bak`;
    /** @type {Map<string, any>} */
    this.goals = new Map();
    this.loaded = false;
  }

  /**
   * Loads goals from disk into memory.
   * If primary storage is corrupted or malformed, attempts recovery from backup.
   */
  load() {
    this.goals.clear();
    let rawData = null;

    if (fs.existsSync(this.storagePath)) {
      try {
        const raw = fs.readFileSync(this.storagePath, 'utf8');
        rawData = JSON.parse(raw);
      } catch (err) {
        console.warn(`[GoalStorage] Primary store '${this.storagePath}' corrupted: ${err.message}. Trying backup...`);
      }
    }

    if (!rawData && fs.existsSync(this.backupPath)) {
      try {
        const raw = fs.readFileSync(this.backupPath, 'utf8');
        rawData = JSON.parse(raw);
        console.info(`[GoalStorage] Successfully restored goals from backup '${this.backupPath}'`);
      } catch (err) {
        console.warn(`[GoalStorage] Backup store '${this.backupPath}' also corrupted: ${err.message}`);
      }
    }

    if (rawData) {
      const items = Array.isArray(rawData) ? rawData : Array.isArray(rawData.goals) ? rawData.goals : [];
      for (const item of items) {
        try {
          const validated = validateGoal(item);
          this.goals.set(validated.id, validated);
        } catch (err) {
          console.warn(`[GoalStorage] Skipping invalid stored goal: ${err.message}`);
        }
      }
    }
    this.loaded = true;
  }

  /**
   * Persists current memory goals to disk safely using atomic rename and backup copy.
   */
  save() {
    try {
      const dir = path.dirname(this.storagePath);
      fs.mkdirSync(dir, { recursive: true });
      const payload = {
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        goals: Array.from(this.goals.values()),
      };
      const serialized = JSON.stringify(payload, null, 2);
      const tempPath = `${this.storagePath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      fs.writeFileSync(tempPath, serialized, 'utf8');

      if (fs.existsSync(this.storagePath)) {
        try {
          fs.copyFileSync(this.storagePath, this.backupPath);
        } catch { /* Non-fatal */ }
      }

      fs.renameSync(tempPath, this.storagePath);
    } catch (err) {
      console.error(`[GoalStorage] Failed to save goals to ${this.storagePath}:`, err.message);
      throw err;
    }
  }

  /**
   * Returns list of all goals, sorted by updatedAt descending.
   * @returns {any[]}
   */
  listGoals() {
    if (!this.loaded) this.load();
    return Array.from(this.goals.values()).sort((a, b) => {
      const timeA = new Date(a.updatedAt || a.createdAt).getTime();
      const timeB = new Date(b.updatedAt || b.createdAt).getTime();
      return timeB - timeA;
    });
  }

  /**
   * Removes terminal Goal history only. Active/draft/ready goals are preserved.
   * @returns {{ removedIds: string[], remaining: any[] }}
   */
  clearGoalHistory() {
    if (!this.loaded) this.load();
    const removedIds = [];
    for (const [id, goal] of this.goals.entries()) {
      if (['completed', 'error'].includes(goal.status)) {
        removedIds.push(id);
        this.goals.delete(id);
      }
    }
    if (removedIds.length > 0) this.save();
    return { removedIds, remaining: this.listGoals() };
  }

  /**
   * Retrieves a single goal by ID.
   * @param {string} id
   * @returns {any | null}
   */
  getGoal(id) {
    if (!this.loaded) this.load();
    return this.goals.get(id) || null;
  }

  /**
   * Saves or updates a goal.
   * @param {any} goal
   * @returns {any} validated saved goal
   */
  saveGoal(goal) {
    if (!this.loaded) this.load();
    const validated = validateGoal(goal);
    validated.updatedAt = new Date().toISOString();
    this.goals.set(validated.id, validated);
    this.save();
    return validated;
  }

  /**
   * Creates and persists a new goal.
   * @param {any} params
   * @returns {any}
   */
  createGoal(params) {
    const goal = createGoal(params);
    return this.saveGoal(goal);
  }

  /**
   * Updates goal fields and saves.
   * @param {string} id
   * @param {any} updates
   * @returns {any}
   */
  updateGoal(id, updates) {
    const goal = this.getGoal(id);
    if (!goal) throw new Error(`Goal '${id}' not found`);
    Object.assign(goal, updates);
    return this.saveGoal(goal);
  }

  /**
   * Updates a specific step inside a goal.
   * @param {string} goalId
   * @param {string} stepId
   * @param {any} updates
   * @returns {any}
   */
  updateStep(goalId, stepId, updates) {
    const goal = this.getGoal(goalId);
    if (!goal) throw new Error(`Goal '${goalId}' not found`);
    const step = goal.steps.find((s) => s.id === stepId);
    if (!step) throw new Error(`Step '${stepId}' not found in goal '${goalId}'`);
    Object.assign(step, updates);
    return this.saveGoal(goal);
  }

  /**
   * Appends a checkpoint to a goal and saves.
   * @param {string} goalId
   * @param {any} cpData
   * @returns {any}
   */
  saveCheckpoint(goalId, cpData) {
    const goal = this.getGoal(goalId);
    if (!goal) throw new Error(`Goal '${goalId}' not found`);
    const checkpoint = createGoalCheckpoint({
      goalId,
      stepId: cpData.stepId || goal.currentStepId,
      summary: cpData.summary,
      completedSteps: cpData.completedSteps ?? goal.steps.filter((s) => s.status === 'completed').length,
      evidence: cpData.evidence,
      filesChanged: cpData.filesChanged,
      checks: cpData.checks,
      nextStep: cpData.nextStep,
      route: cpData.route,
    });
    goal.checkpoints.push(checkpoint);
    return this.saveGoal(goal);
  }
}

