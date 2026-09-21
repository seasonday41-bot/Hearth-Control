// X-Eval RUNTIME PROTOCOL AMENDMENT 1 (memory handling only). NOT part of the Gold v1.1 fingerprint.
//
// Gold v1.1 (fingerprint a472f193...) is approved and frozen, including MEMORY_GUARD in lanes.mjs and host-sampler.mjs.
// This module supersedes those memory thresholds for real-model runs WITHOUT touching those files: baseline.mjs uses this
// sampler instead. It reuses host-sampler's raw `sampleOnce` unchanged.
//
// Semantics (summary field names are kept compatible with the frozen stop-rules.mjs):
//   warnings : WARN only, recorded, never halts.
//   flags    : HALT conditions. The baseline stops after the current task (no next task, no rerun).
//   aborted  : ABORT conditions (unchanged from Gold v1.1). The current run is aborted immediately via the AbortController.
import { sampleOnce } from './host-sampler.mjs';

export const AMENDMENT = Object.freeze({
  id: 'runtime-protocol-amendment-1',
  interval_ms: 2000,
  warn: Object.freeze({ pressure_level_at_least: 2, consecutive_samples: 3 }),
  halt: Object.freeze({ pressure_level_at_least: 2, consecutive_samples: 15, swap_growth_mb_at_least: 512, free_pct_below: 10, free_consecutive_samples: 3 }),
  abort: Object.freeze({ pressure_level_at_least: 4, swap_growth_mb_at_least: 2048, free_pct_below: 5 }), // unchanged from Gold v1.1
});

export const startSampler = ({ controller = null, sampleFn = sampleOnce, intervalMs = AMENDMENT.interval_ms } = {}) => {
  const A = AMENDMENT; const samples = []; let start = null; let running = true; let abortReason = null;
  let pressureRun = 0; let freeRun = 0; const warnings = new Set(); const flags = new Set();
  const tick = async () => {
    const s = await sampleFn();
    if (start === null) start = s;
    samples.push(s);
    const growth = s.swap_used_mb - start.swap_used_mb;
    pressureRun = s.pressure_level >= A.halt.pressure_level_at_least ? pressureRun + 1 : 0;
    freeRun = s.free_pct < A.halt.free_pct_below ? freeRun + 1 : 0;
    if (pressureRun >= A.warn.consecutive_samples) warnings.add(`pressure_level>=${A.warn.pressure_level_at_least} for ${A.warn.consecutive_samples}+ samples`);
    if (pressureRun >= A.halt.consecutive_samples) flags.add(`HALT pressure_level>=${A.halt.pressure_level_at_least} for ${A.halt.consecutive_samples} samples`);
    if (growth >= A.halt.swap_growth_mb_at_least) flags.add(`HALT swap_growth>=${A.halt.swap_growth_mb_at_least}MB`);
    if (freeRun >= A.halt.free_consecutive_samples) flags.add(`HALT free_pct<${A.halt.free_pct_below} for ${A.halt.free_consecutive_samples} samples`);
    const why = s.pressure_level >= A.abort.pressure_level_at_least ? `pressure_level>=${A.abort.pressure_level_at_least}`
      : growth >= A.abort.swap_growth_mb_at_least ? `swap_growth>=${A.abort.swap_growth_mb_at_least}MB` : s.free_pct < A.abort.free_pct_below ? `free_pct<${A.abort.free_pct_below}` : null;
    if (why && !abortReason) { abortReason = `memory_guard: ${why}`; controller?.abort(new Error(abortReason)); }
  };
  const loop = (async () => { while (running) { await tick(); await new Promise((r) => setTimeout(r, intervalMs)); } })();
  return {
    async stop() {
      running = false; await loop;
      const ok = samples.filter((s) => Number.isFinite(s.free_pct));
      return { samples: samples.length, start, end: samples.at(-1) ?? null, max_pressure_level: Math.max(...samples.map((s) => s.pressure_level ?? 0), 0),
        min_free_pct: ok.length ? Math.min(...ok.map((s) => s.free_pct)) : null, swap_growth_mb_max: samples.length ? Math.max(...samples.map((s) => s.swap_used_mb - start.swap_used_mb)) : 0,
        ollama_rss_mb_max: Math.max(...samples.map((s) => s.ollama_rss_mb ?? 0), 0), max_consecutive_pressure_ge2: Math.max(0, ...(() => { let r = 0; return samples.map((s) => (r = s.pressure_level >= 2 ? r + 1 : 0)); })()),
        warnings: [...warnings], flags: [...flags], aborted: abortReason };
    },
  };
};
