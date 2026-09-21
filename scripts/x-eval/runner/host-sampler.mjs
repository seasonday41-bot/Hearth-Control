// Host memory sampler + guard for real-model runs (macOS). Samples every MEMORY_GUARD.interval_ms.
// `abort` conditions trigger the AbortController immediately; `flag` conditions are recorded and make the
// baseline stop AFTER the current task. Swap is judged by GROWTH from the start of the sampler, because
// swap may already be in use before any run.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MEMORY_GUARD } from './lanes.mjs';

const exec = promisify(execFile);
const run = async (cmd, args) => { try { return (await exec(cmd, args, { timeout: 5000 })).stdout; } catch { return ''; } };

export const sampleOnce = async () => {
  const [level, swap, mp, ps] = await Promise.all([
    run('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']), run('sysctl', ['-n', 'vm.swapusage']),
    run('memory_pressure', []), run('ps', ['-axo', 'rss=,comm=']),
  ]);
  const swapUsed = Number(/used = ([\d.]+)M/.exec(swap)?.[1] ?? NaN);
  const ollamaKb = ps.split('\n').filter((l) => /ollama/i.test(l)).reduce((a, l) => a + (Number(l.trim().split(/\s+/)[0]) || 0), 0);
  return { t: Date.now(), pressure_level: Number(level.trim()) || null, swap_used_mb: swapUsed, free_pct: Number(/free percentage: (\d+)%/.exec(mp)?.[1] ?? NaN), ollama_rss_mb: Math.round(ollamaKb / 1024) };
};

export const startSampler = ({ controller = null, sampleFn = sampleOnce, intervalMs = MEMORY_GUARD.interval_ms } = {}) => {
  const samples = []; let start = null; let consecutiveWarn = 0; let running = true; let abortReason = null; const flags = new Set();
  const G = MEMORY_GUARD;
  const tick = async () => {
    const s = await sampleFn();
    if (start === null) start = s;
    samples.push(s);
    const growth = s.swap_used_mb - start.swap_used_mb;
    consecutiveWarn = s.pressure_level >= G.flag.pressure_level_at_least ? consecutiveWarn + 1 : 0;
    if (consecutiveWarn >= G.flag.consecutive_samples) flags.add(`pressure_level>=${G.flag.pressure_level_at_least} for ${consecutiveWarn} samples`);
    if (growth >= G.flag.swap_growth_mb_at_least) flags.add(`swap_growth>=${G.flag.swap_growth_mb_at_least}MB`);
    if (s.free_pct < G.flag.free_pct_below) flags.add(`free_pct<${G.flag.free_pct_below}`);
    const why = s.pressure_level >= G.abort.pressure_level_at_least ? `pressure_level>=${G.abort.pressure_level_at_least}`
      : growth >= G.abort.swap_growth_mb_at_least ? `swap_growth>=${G.abort.swap_growth_mb_at_least}MB` : s.free_pct < G.abort.free_pct_below ? `free_pct<${G.abort.free_pct_below}` : null;
    if (why && !abortReason) { abortReason = `memory_guard: ${why}`; controller?.abort(new Error(abortReason)); }
  };
  const loop = (async () => { while (running) { await tick(); await new Promise((r) => setTimeout(r, intervalMs)); } })();
  return {
    async stop() {
      running = false; await loop;
      const ok = samples.filter((s) => Number.isFinite(s.free_pct));
      return { samples: samples.length, start: start, end: samples.at(-1) ?? null, max_pressure_level: Math.max(...samples.map((s) => s.pressure_level ?? 0), 0),
        min_free_pct: ok.length ? Math.min(...ok.map((s) => s.free_pct)) : null, swap_growth_mb_max: samples.length ? Math.max(...samples.map((s) => s.swap_used_mb - start.swap_used_mb)) : 0,
        ollama_rss_mb_max: Math.max(...samples.map((s) => s.ollama_rss_mb ?? 0), 0), flags: [...flags], aborted: abortReason };
    },
  };
};
