// X-Eval RUNTIME PROTOCOL AMENDMENT 2 (memory handling only). NOT part of the Gold v1.1 fingerprint.
// Supersedes the pressure rule of amendment 1 with a BASELINE-RELATIVE rule; everything else about memory is unchanged.
// Reuses host-sampler.sampleOnce unchanged and reports through the field names the frozen stop-rules.mjs understands
// (`flags` = HALT conditions, `aborted` = ABORT). WARN is recorded in `warnings` and never stops anything.
import { sampleOnce } from './host-sampler.mjs';

export const AMENDMENT2 = Object.freeze({
  id: 'runtime-protocol-amendment-2',
  interval_ms: 2000,
  baseline: Object.freeze({ samples: 5, statistic: 'median', refuse_start_if_baseline_pressure_at_least: 3, also_refuse_if_any_baseline_sample_hits_an_abort_threshold: true }),
  warn: Object.freeze({ pressure_above_baseline_consecutive_samples: 3 }),
  halt: Object.freeze({ pressure_at_least_baseline_plus: 1, consecutive_samples: 15, swap_growth_mb_at_least: 512, free_pct_below: 10, free_consecutive_samples: 3 }),
  abort: Object.freeze({ pressure_level_at_least: 4, swap_growth_mb_at_least: 2048, free_pct_below: 5 }), // unchanged from Gold v1.1
});

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const hitsAbort = (s, ref = null) => { const A = AMENDMENT2.abort; return s.pressure_level >= A.pressure_level_at_least || s.free_pct < A.free_pct_below || (ref && s.swap_used_mb - ref.swap_used_mb >= A.swap_growth_mb_at_least); };

/** Measure the steady state AFTER warm-up (model resident). Refuses to start when it is already at pressure >= 3. */
export const measureBaseline = async ({ sampleFn = sampleOnce, intervalMs = AMENDMENT2.interval_ms, n = AMENDMENT2.baseline.samples } = {}) => {
  const samples = [];
  for (let i = 0; i < n; i += 1) { samples.push(await sampleFn()); if (i < n - 1) await new Promise((r) => setTimeout(r, intervalMs)); }
  const pressure = median(samples.map((s) => s.pressure_level ?? 0));
  const refusals = [];
  if (pressure >= AMENDMENT2.baseline.refuse_start_if_baseline_pressure_at_least) refusals.push(`baseline pressure ${pressure} >= ${AMENDMENT2.baseline.refuse_start_if_baseline_pressure_at_least}`);
  if (samples.some((s) => hitsAbort(s))) refusals.push('a baseline sample already meets an ABORT threshold');
  return { samples, baseline_pressure: pressure, baseline_free_pct_min: Math.min(...samples.map((s) => s.free_pct)), swap_used_mb: samples.at(-1).swap_used_mb, start_allowed: refusals.length === 0, refusals };
};

export const startSampler = ({ baselinePressure, controller = null, sampleFn = sampleOnce, intervalMs = AMENDMENT2.interval_ms } = {}) => {
  if (!Number.isFinite(baselinePressure)) throw new TypeError('baselinePressure is required (run measureBaseline first)');
  const A = AMENDMENT2; const samples = []; let start = null; let running = true; let abortReason = null; let above = 0; let freeRun = 0; const warnings = new Set(); const flags = new Set();
  const tick = async () => {
    const s = await sampleFn();
    if (start === null) start = s;
    samples.push(s);
    const growth = s.swap_used_mb - start.swap_used_mb;
    above = s.pressure_level >= baselinePressure + A.halt.pressure_at_least_baseline_plus ? above + 1 : 0; // ">= baseline+1" == "> baseline"
    freeRun = s.free_pct < A.halt.free_pct_below ? freeRun + 1 : 0;
    if (above >= A.warn.pressure_above_baseline_consecutive_samples) warnings.add(`pressure > baseline(${baselinePressure}) for ${A.warn.pressure_above_baseline_consecutive_samples}+ samples`);
    if (above >= A.halt.consecutive_samples) flags.add(`HALT pressure >= baseline(${baselinePressure})+${A.halt.pressure_at_least_baseline_plus} for ${A.halt.consecutive_samples} samples`);
    if (growth >= A.halt.swap_growth_mb_at_least) flags.add(`HALT swap_growth>=${A.halt.swap_growth_mb_at_least}MB`);
    if (freeRun >= A.halt.free_consecutive_samples) flags.add(`HALT free_pct<${A.halt.free_pct_below} for ${A.halt.free_consecutive_samples} samples`);
    const why = s.pressure_level >= A.abort.pressure_level_at_least ? `pressure_level>=${A.abort.pressure_level_at_least}` : growth >= A.abort.swap_growth_mb_at_least ? `swap_growth>=${A.abort.swap_growth_mb_at_least}MB` : s.free_pct < A.abort.free_pct_below ? `free_pct<${A.abort.free_pct_below}` : null;
    if (why && !abortReason) { abortReason = `memory_guard: ${why}`; controller?.abort(new Error(abortReason)); }
  };
  const loop = (async () => { while (running) { await tick(); await new Promise((r) => setTimeout(r, intervalMs)); } })();
  return {
    async stop() {
      running = false; await loop;
      const ok = samples.filter((s) => Number.isFinite(s.free_pct));
      let run = 0; let longest = 0; let runGe2 = 0; let longestGe2 = 0;
      for (const s of samples) { run = s.pressure_level >= baselinePressure + 1 ? run + 1 : 0; longest = Math.max(longest, run); runGe2 = s.pressure_level >= 2 ? runGe2 + 1 : 0; longestGe2 = Math.max(longestGe2, runGe2); }
      return { baseline_pressure: baselinePressure, samples: samples.length, start, end: samples.at(-1) ?? null, max_pressure_level: Math.max(...samples.map((s) => s.pressure_level ?? 0), 0),
        longest_run_above_baseline: longest, longest_run_pressure_ge2: longestGe2, min_free_pct: ok.length ? Math.min(...ok.map((s) => s.free_pct)) : null,
        swap_growth_mb_max: samples.length ? Math.max(...samples.map((s) => s.swap_used_mb - start.swap_used_mb)) : 0, ollama_rss_mb_max: Math.max(...samples.map((s) => s.ollama_rss_mb ?? 0), 0),
        warnings: [...warnings], flags: [...flags], aborted: abortReason };
    },
  };
};
