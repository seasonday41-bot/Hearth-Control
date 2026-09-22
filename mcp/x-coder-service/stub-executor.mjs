import fs from 'node:fs';

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(signal.reason ?? new Error('Aborted'));
    return;
  }
  const timer = setTimeout(resolve, ms);
  const onAbort = () => {
    clearTimeout(timer);
    reject(signal.reason ?? new Error('Aborted'));
  };
  signal?.addEventListener('abort', onAbort, { once: true });
});

const incrementCounterFile = (counterPath) => {
  if (!counterPath) return;
  let current = 0;
  try {
    const raw = fs.readFileSync(counterPath, 'utf8').trim();
    current = raw ? Number.parseInt(raw, 10) || 0 : 0;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  fs.writeFileSync(counterPath, String(current + 1));
};

export class StubExecutor {
  constructor({ delayMs = 25, counterPath = null, resultFactory } = {}) {
    this.delayMs = delayMs;
    this.counterPath = counterPath;
    this.resultFactory = resultFactory ?? (({ runId, task }) => ({
      kind: 'stub-result',
      run_id: runId,
      task_id: task.task_id,
    }));
    this.calls = 0;
  }

  async execute({ runId, task, signal } = {}) {
    this.calls += 1;
    incrementCounterFile(this.counterPath);
    await sleep(this.delayMs, signal);
    if (signal?.aborted) throw signal.reason ?? new Error('Aborted');
    return this.resultFactory({ runId, task });
  }
}
