import { runTaskWithRepair } from './repair-loop.mjs';
import { evaluateResultGate } from './result-gate.mjs';
import { buildXResult } from './result-builder.mjs';

/** Compose the existing Core X execution, gate, and result contracts. */
export async function executeXTask(task, modelAdapter, options = {}) {
  const repairOutcome = await runTaskWithRepair(task, modelAdapter, options);
  const gateResult = evaluateResultGate(repairOutcome);
  const xResult = buildXResult(task, repairOutcome, gateResult);

  return { repairOutcome, gateResult, xResult };
}
