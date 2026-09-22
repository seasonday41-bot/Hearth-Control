/**
 * Renews one already-owned X execution lease on a timer. The claim store owns
 * fencing and reclaim; this keeper neither claims nor releases a lease.
 */
export class XLeaseKeeper {
  constructor({ claimStore, claim, onRenewed } = {}) {
    if (typeof claimStore?.renew !== 'function' || typeof claimStore?.isOwner !== 'function' ||
        typeof claimStore?.getActiveClaim !== 'function') {
      throw new TypeError('XLeaseKeeper requires a claim store with renew(), isOwner(), and getActiveClaim().');
    }
    if (onRenewed !== undefined && typeof onRenewed !== 'function') {
      throw new TypeError('XLeaseKeeper onRenewed must be a function when provided.');
    }
    this.store = claimStore;
    this.claim = claim;
    this.onRenewed = onRenewed ?? null;
    this.state = 'idle';
    this.error = null;
    this.timer = null;
    this.inFlight = null;
    this.done = new Promise((resolve) => { this.resolveDone = resolve; });
  }

  start() {
    if (this.state === 'active') return this;
    if (this.state !== 'idle') throw new Error('XLeaseKeeper cannot be restarted.');
    try {
      const claim = this.claim;
      const current = claim?.taskId ? this.store.getActiveClaim(claim.taskId) : null;
      if (!claim || claim.state !== 'active' ||
          typeof claim.taskId !== 'string' || !claim.taskId ||
          typeof claim.ownerId !== 'string' || !claim.ownerId ||
          typeof claim.leaseId !== 'string' || !claim.leaseId ||
          !Number.isInteger(claim.attempt) || claim.attempt < 1 ||
          !Number.isInteger(claim.renewedAt) ||
          !Number.isInteger(claim.leaseExpiresAt) || claim.leaseExpiresAt <= Date.now() ||
          claim.leaseExpiresAt <= claim.renewedAt ||
          current?.taskId !== claim.taskId || current.ownerId !== claim.ownerId ||
          current.leaseId !== claim.leaseId || current.attempt !== claim.attempt ||
          current.renewedAt !== claim.renewedAt || current.leaseExpiresAt !== claim.leaseExpiresAt ||
          !this.store.isOwner(claim.taskId, claim.ownerId, claim.leaseId)) {
        throw new TypeError('XLeaseKeeper requires a current, active lease.');
      }
      this.claim = current;
    } catch (error) {
      this.finish('error', error);
      throw error;
    }
    this.state = 'active';
    this.schedule();
    return this;
  }

  schedule() {
    if (this.state !== 'active') return;
    const remaining = this.claim.leaseExpiresAt - Date.now();
    // Each next attempt is scheduled only after the prior attempt settles.
    // Renew at one third of the remaining lease, before its expiry.
    const delay = Math.min(2_147_483_647, Math.max(1, Math.floor(remaining / 3)));
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.state === 'active') this.inFlight = this.renewOnce();
    }, delay);
  }

  async renewOnce() {
    try {
      const previous = this.claim;
      const leaseDurationMs = previous.leaseExpiresAt - previous.renewedAt;
      const renewed = await this.store.renew({
        taskId: previous.taskId,
        ownerId: previous.ownerId,
        leaseId: previous.leaseId,
        leaseDurationMs,
      });
      if (renewed === null) {
        this.finish('ownership_lost');
        return;
      }
      if (!renewed || renewed.taskId !== previous.taskId ||
          renewed.ownerId !== previous.ownerId || renewed.leaseId !== previous.leaseId ||
          renewed.attempt !== previous.attempt || renewed.state !== 'active' ||
          !Number.isInteger(renewed.leaseExpiresAt) || renewed.leaseExpiresAt <= Date.now()) {
        this.finish('ownership_lost');
        return;
      }
      this.claim = renewed;
      if (this.onRenewed) await this.onRenewed(renewed);
      if (this.state === 'active') this.schedule();
    } catch (error) {
      this.finish('error', error);
    } finally {
      this.inFlight = null;
    }
  }

  /** Stops renewal only. The caller remains responsible for releasing its lease. */
  async stop() {
    if (this.state === 'active') this.state = 'stopping';
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.inFlight) await this.inFlight;
    if (this.state === 'idle' || this.state === 'stopping') this.finish('stopped');
    return this.done;
  }

  finish(state, error = null) {
    if (['stopped', 'ownership_lost', 'error'].includes(this.state)) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.state = state;
    this.error = error;
    this.resolveDone({ status: state, claim: this.claim, error });
  }
}
