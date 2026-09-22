import crypto from 'node:crypto';
import path from 'node:path';

import { EXECUTOR_API_VERSION } from '../../mcp/x/executor-contract/index.mjs';
import { createXCoderService } from '../../mcp/x-coder-service/server.mjs';
import { RealXCoderExecutor } from '../../mcp/x-coder-service/real-executor.mjs';

export function createTestXCoderClient({
  root,
  modelAdapter,
  executionOptions = {},
  storagePath,
} = {}) {
  if (!root && !storagePath) throw new TypeError('root or storagePath is required.');
  const dbPath = storagePath ?? path.join(root, '.x-coder-test-' + crypto.randomUUID() + '.sqlite');
  const service = createXCoderService({
    storagePath: dbPath,
    executor: new RealXCoderExecutor({ modelAdapter, executionOptions }),
  });

  const client = {
    async submit({ idempotencyKey, task, leaseExpiresAt } = {}) {
      const result = service.submit({
        version: EXECUTOR_API_VERSION,
        idempotency_key: idempotencyKey,
        lease_expires_at: leaseExpiresAt,
        task,
      });
      return {
        runId: result.run_id,
        status: result.status,
        duplicate: result.duplicate,
      };
    },

    async getStatus(runId) {
      const result = service.getStatus({
        version: EXECUTOR_API_VERSION,
        run_id: runId,
      });
      if (!result) return null;
      return {
        runId: result.run_id,
        status: result.status,
        result: result.result ?? null,
        error: result.error ?? null,
      };
    },

    async leaseValid(runId, leaseExpiresAt) {
      const result = service.leaseValid({
        version: EXECUTOR_API_VERSION,
        run_id: runId,
        lease_expires_at: leaseExpiresAt,
      });
      if (!result) return null;
      return {
        runId: result.run_id,
        status: result.status,
        leaseExpiresAt: result.lease_expires_at,
        accepted: result.accepted,
      };
    },

    async cancel(runId) {
      const result = await service.cancel({
        version: EXECUTOR_API_VERSION,
        run_id: runId,
      });
      if (!result) return null;
      return {
        runId: result.run_id,
        status: result.status,
        result: result.result ?? null,
        error: result.error ?? null,
        acknowledged: result.acknowledged,
      };
    },

    async close() {
      for (const runId of [...service.registry.live.keys()]) {
        try {
          await service.cancel({ version: EXECUTOR_API_VERSION, run_id: runId });
        } catch {}
      }
      service.close();
    },
  };

  return { client, service, storagePath: dbPath };
}

export function attachTestXCoderClient(modelAdapter, options = {}) {
  const runtime = createTestXCoderClient({ ...options, modelAdapter });
  Object.defineProperty(modelAdapter, 'xCoderClient', {
    value: runtime.client,
    enumerable: false,
    configurable: true,
  });
  return runtime;
}
