import { parentPort, workerData } from 'node:worker_threads';
import { createDefaultScanAreas, scanStorage } from '../mcp/storage/audit.mjs';

const areas = workerData.areas || createDefaultScanAreas(workerData);
try {
  const result = await scanStorage({
    areas,
    home: workerData.home,
    onProgress: (progress) => parentPort.postMessage({ type: 'progress', progress }),
  });
  parentPort.postMessage({ type: 'done', result });
} catch (error) {
  parentPort.postMessage({ type: 'error', error: error?.message || 'Storage scan failed' });
}
