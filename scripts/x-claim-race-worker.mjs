// Test helper: run out-of-process so claim races are proven across real OS
// processes/connections, not just interleaved JS calls in one thread.
// argv: storagePath taskId ownerId [leaseDurationMs]
import { XClaimStore } from '../mcp/x/claim-store.mjs';

const [, , storagePath, taskId, ownerId, leaseDurationMsRaw] = process.argv;
const leaseDurationMs = Number.parseInt(leaseDurationMsRaw, 10) || undefined;

const store = new XClaimStore({ storagePath, leaseDurationMs });
let claim = null;
try {
  claim = store.claim({ taskId, ownerId, leaseDurationMs });
} finally {
  store.close();
}

process.stdout.write(JSON.stringify({
  ownerId,
  taskId,
  claimed: Boolean(claim),
  leaseId: claim?.leaseId || null,
}));
