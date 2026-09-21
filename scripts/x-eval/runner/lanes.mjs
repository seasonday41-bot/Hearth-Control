// X-Eval v1 Step 6: the two measurement LANES (locked). Every run record carries the lane id and the
// list of EVAL OVERRIDES (values that differ from what production X sends), so an override can never
// be mistaken for a production default.
//
// Production facts (verified in source, Step 6A):
//  - the production path passes NO contextOptions  -> loader default maxBytesPerFile = 8,000
//  - createOllamaModelAdapter() defaults           -> profile 'normal': num_ctx 8,192, think false
//  - executor's own request sets num_predict 4096 + longResponse:true, and the provider then forces
//    num_predict = max(value, 4096) and a 300 s timeout. So the EFFECTIVE output cap in production is
//    4,096, NOT the profile's 1,024. It is not reachable via modelOptions.num_predict.

export const MODEL = 'qwen3.5:9b-hermes';
export const SEED = 42;

export const PRODUCTION = Object.freeze({
  maxBytesPerFile: 8000, num_ctx: 8192, profile: 'normal', think: false, temperature: null, seed: null,
  effective_num_predict: 4096, timeout_ms: 300_000,
});

export const LANES = Object.freeze({
  production_capability: Object.freeze({
    id: 'production_capability', runnable_in: '6C (defined and locked, NOT run in 6B)',
    purpose: 'Measure frozen X v0.1 as it really behaves.',
    contextOptions: undefined, // exactly what production does: no override
    modelOptions: Object.freeze({ model: MODEL, profile: 'normal', think: false, temperature: 0, num_ctx: 8192, context: Object.freeze({ seed: SEED }) }),
  }),
  model_quality: Object.freeze({
    id: 'model_quality', runnable_in: '6B',
    purpose: 'Separate model quality from the small per-file / context ceilings.',
    contextOptions: Object.freeze({ limits: Object.freeze({ maxBytesPerFile: 20000 }) }), // X hard ceiling, harness-set
    modelOptions: Object.freeze({ model: MODEL, profile: 'normal', think: false, temperature: 0, num_ctx: 16384, context: Object.freeze({ seed: SEED }) }),
  }),
});

/** Values in a lane that differ from production. `temperature` / `seed` are determinism controls the production path leaves unset. */
export const evalOverrides = (lane) => {
  const o = [];
  const mb = lane.contextOptions?.limits?.maxBytesPerFile ?? PRODUCTION.maxBytesPerFile;
  if (mb !== PRODUCTION.maxBytesPerFile) o.push({ key: 'maxBytesPerFile', eval: mb, production: PRODUCTION.maxBytesPerFile, kind: 'eval_override' });
  if (lane.modelOptions.num_ctx !== PRODUCTION.num_ctx) o.push({ key: 'num_ctx', eval: lane.modelOptions.num_ctx, production: PRODUCTION.num_ctx, kind: 'eval_override' });
  if (lane.modelOptions.temperature !== undefined) o.push({ key: 'temperature', eval: lane.modelOptions.temperature, production: 'unset (provider/model default)', kind: 'determinism_control' });
  if (lane.modelOptions.context?.seed !== undefined) o.push({ key: 'seed', eval: lane.modelOptions.context.seed, production: 'unset', kind: 'determinism_control' });
  return o;
};

/** What actually reaches Ollama, derived from the (verified) provider logic; recorded per run. */
export const effectiveConfig = (lane) => ({
  lane: lane.id, model: lane.modelOptions.model, profile: lane.modelOptions.profile, think: lane.modelOptions.think,
  maxBytesPerFile: lane.contextOptions?.limits?.maxBytesPerFile ?? PRODUCTION.maxBytesPerFile,
  num_ctx: lane.modelOptions.num_ctx, num_predict: PRODUCTION.effective_num_predict, num_predict_note: 'forced to max(value, 4096) by longResponse; not settable via modelOptions',
  temperature: lane.modelOptions.temperature ?? null, seed: lane.modelOptions.context?.seed ?? null, request_timeout_ms: PRODUCTION.timeout_ms,
});

/** Locked host-memory guard. Thresholds are fixed BEFORE the run. */
export const MEMORY_GUARD = Object.freeze({
  interval_ms: 2000,
  abort: Object.freeze({ pressure_level_at_least: 4, swap_growth_mb_at_least: 2048, free_pct_below: 5 }),
  flag: Object.freeze({ pressure_level_at_least: 2, consecutive_samples: 3, swap_growth_mb_at_least: 512, free_pct_below: 15 }),
});
