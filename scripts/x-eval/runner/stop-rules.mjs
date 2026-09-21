// Locked stop rules for the real-model baseline. After ANY task, if this returns reasons, the baseline HALTS:
// no further task, no rerun, no config change. Analysis comes first. A wrong-but-clean model answer
// (outcome FAILURE / FALSE_SUCCESS) is a RESULT, not a stop reason. Gold v1.1: outcome REVIEW (the independent scorer
// passes but X's own validation disagrees) HALTS, because it means the instrument and X disagree and a human must look.
export const stopConditions = (record, mem) => {
  const reasons = [];
  const calls = record.model_calls ?? [];
  if (calls.some((c) => c.result?.finishReason === 'length')) reasons.push('finish_reason=length');
  const failed = calls.filter((c) => c.result?.ok === false);
  if (failed.length) reasons.push(`model_call_failed:${failed.map((c) => c.result.error?.code ?? 'unknown').join(',')}`);
  if (record.outcome?.label === 'MODEL_UNAVAILABLE') reasons.push('model_unavailable');
  if (record.outcome?.label === 'HARNESS_ERROR') reasons.push(`harness_error:${record.outcome.reason ?? ''}`.slice(0, 160));
  if (record.outcome?.label === 'REVIEW') reasons.push('outcome_review: hidden scorer passes but X validation did not complete');
  if (record.outcome?.label === 'STOPPED_BY_GUARD') reasons.push(`guard:${record.outcome.reason ?? ''}`);
  if (mem?.aborted) reasons.push(mem.aborted);
  if (mem?.flags?.length) reasons.push(`memory_flags:${mem.flags.join('; ')}`);
  return reasons;
};
