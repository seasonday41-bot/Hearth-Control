import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  EXECUTOR_API_VERSION,
  ExecutorApiValidationError,
  parseCancelRequest,
  parseLeaseValidRequest,
  parseStatusRequest,
  parseSubmitRequest,
} from '../x/executor-contract/index.mjs';
import { XCoderIdempotencyStore } from './idempotency-store.mjs';
import { XCoderRunRegistry } from './run-registry.mjs';
import { StubExecutor } from './stub-executor.mjs';

const DEFAULT_PORT = 3217;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export const defaultXCoderStoragePath = () =>
  path.join(os.homedir(), '.hearth-control', 'x-coder-service', 'idempotency.sqlite');

const responseForStatus = (status) => status && ({
  version: EXECUTOR_API_VERSION,
  run_id: status.runId,
  status: status.status,
  result: status.result ?? null,
  error: status.error ?? null,
});

export function createXCoderService({ storagePath = defaultXCoderStoragePath(), executor } = {}) {
  const store = new XCoderIdempotencyStore({ storagePath });
  const interruptedOnStartup = store.reconcileStartupState();
  const registry = new XCoderRunRegistry({
    store,
    executor: executor ?? new StubExecutor(),
  });

  return {
    storagePath,
    interruptedOnStartup,
    store,
    registry,

    submit(input) {
      const request = parseSubmitRequest(input);
      const submitted = registry.submit({
        idempotencyKey: request.idempotency_key,
        task: request.task,
        leaseExpiresAt: request.lease_expires_at,
      });
      return {
        version: EXECUTOR_API_VERSION,
        run_id: submitted.runId,
        status: submitted.status,
        duplicate: submitted.duplicate,
      };
    },

    getStatus(input) {
      const request = parseStatusRequest(input);
      return responseForStatus(registry.getStatus(request.run_id));
    },

    async cancel(input) {
      const request = parseCancelRequest(input);
      const outcome = await registry.cancel(request.run_id);
      if (!outcome) return null;
      return {
        version: EXECUTOR_API_VERSION,
        run_id: outcome.runId,
        status: outcome.status,
        result: outcome.result ?? null,
        error: outcome.error ?? null,
        acknowledged: outcome.acknowledged === true,
      };
    },

    leaseValid(input) {
      const request = parseLeaseValidRequest(input);
      const outcome = registry.leaseValid(request.run_id, request.lease_expires_at);
      if (!outcome) return null;
      return {
        version: EXECUTOR_API_VERSION,
        run_id: outcome.runId,
        status: outcome.status,
        lease_expires_at: outcome.leaseExpiresAt,
        accepted: outcome.accepted === true,
      };
    },

    close() {
      if (registry.attachedCount() !== 0) {
        throw new Error('Cannot close X Coder Service while executions are attached.');
      }
      store.close();
    },
  };
}

const readJsonBody = (request) => new Promise((resolve, reject) => {
  let bytes = 0;
  const chunks = [];
  request.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      reject(Object.assign(new Error('request body too large'), { statusCode: 413 }));
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on('end', () => {
    try {
      const text = Buffer.concat(chunks).toString('utf8');
      resolve(text ? JSON.parse(text) : {});
    } catch (error) {
      reject(Object.assign(new Error('invalid JSON body'), { statusCode: 400, cause: error }));
    }
  });
  request.on('error', reject);
});

const sendJson = (response, statusCode, value) => {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
};

export async function startXCoderHttpServer({
  service,
  storagePath,
  executor,
  host = '127.0.0.1',
  port = DEFAULT_PORT,
} = {}) {
  const ownedService = service ?? createXCoderService({ storagePath, executor });
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/health') {
        sendJson(response, 200, {
          status: 'ok',
          service: 'x-coder-service',
          protocol: EXECUTOR_API_VERSION,
          pid: process.pid,
        });
        return;
      }

      if (request.method !== 'POST' || !['/submit', '/status', '/cancel', '/lease-valid'].includes(request.url)) {
        sendJson(response, 404, { error: 'not_found' });
        return;
      }

      const body = await readJsonBody(request);
      if (request.url === '/submit') {
        sendJson(response, 200, ownedService.submit(body));
        return;
      }
      if (request.url === '/status') {
        const status = ownedService.getStatus(body);
        sendJson(response, status ? 200 : 404, status ?? { error: 'run_not_found' });
        return;
      }
      if (request.url === '/lease-valid') {
        const lease = ownedService.leaseValid(body);
        sendJson(response, lease ? 200 : 404, lease ?? { error: 'run_not_found' });
        return;
      }
      const cancelled = await ownedService.cancel(body);
      sendJson(response, cancelled ? 200 : 404, cancelled ?? { error: 'run_not_found' });
    } catch (error) {
      const validationError =
        error instanceof ExecutorApiValidationError || error?.code === 'INVALID_EXECUTOR_X_TASK';
      sendJson(response, error?.statusCode ?? (validationError ? 400 : 500), {
        error: validationError ? 'invalid_request' : 'internal_error',
        message: error?.message || String(error),
      });
    }
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });

  const address = server.address();
  return {
    service: ownedService,
    server,
    host,
    port: typeof address === 'object' && address ? address.port : port,
    async stop({ closeService = true } = {}) {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      if (closeService) ownedService.close();
    },
  };
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const storagePath = process.env.X_CODER_STORAGE_PATH || defaultXCoderStoragePath();
  const port = process.env.X_CODER_PORT ? Number(process.env.X_CODER_PORT) : DEFAULT_PORT;
  const delayMs = process.env.X_CODER_STUB_DELAY_MS ? Number(process.env.X_CODER_STUB_DELAY_MS) : 25;
  const counterPath = process.env.X_CODER_STUB_COUNTER_PATH || null;

  const runtime = await startXCoderHttpServer({
    storagePath,
    port,
    executor: new StubExecutor({ delayMs, counterPath }),
  });

  process.stdout.write(JSON.stringify({
    event: 'ready',
    port: runtime.port,
    pid: process.pid,
    interrupted_on_startup: runtime.service.interruptedOnStartup,
  }) + '\n');

  const shutdown = async () => {
    try {
      await runtime.stop();
      process.exit(0);
    } catch {
      process.exit(1);
    }
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
