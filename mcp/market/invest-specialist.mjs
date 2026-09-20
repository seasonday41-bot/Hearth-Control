import { analyzeXauUsd } from './invest-engine.mjs';

const MAX_TEXT = 4000;

const cleanText = (value, required = false) => {
  if (typeof value !== 'string') return required ? null : '';
  const text = value.trim();
  if (required && !text) return null;
  if (text.length > MAX_TEXT) return null;
  return text;
};

const normalizeRisks = (value) => {
  if (value == null) return [];
  const candidates = Array.isArray(value) ? value : [value];
  return candidates
    .map((item) => cleanText(item, true))
    .filter(Boolean)
    .slice(0, 20);
};

const parseNarrative = (value) => {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); }
    catch { throw new Error('xau_invest_narrative_invalid_json'); }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('xau_invest_narrative_invalid');
  const known = new Set(['summary', 'bull_case', 'base_case', 'bear_case', 'risks']);
  for (const field of Object.keys(parsed)) if (!known.has(field)) throw new Error(`xau_invest_narrative_unknown_field:${field}`);
  const summary = cleanText(parsed.summary, true);
  const bullCase = cleanText(parsed.bull_case, true);
  const baseCase = cleanText(parsed.base_case, true);
  const bearCase = cleanText(parsed.bear_case, true);
  if (!summary || !bullCase || !baseCase || !bearCase) throw new Error('xau_invest_narrative_missing_text');
  return {
    summary,
    bull_case: bullCase,
    base_case: baseCase,
    bear_case: bearCase,
    risks: normalizeRisks(parsed.risks),
  };
};

export const buildInvestNarrativeInstruction = ({ analysis, research }) => [
  '[Hearth Invest Specialist — XAU/USD]',
  'Return ONLY JSON with exactly: summary, bull_case, base_case, bear_case, risks.',
  'The deterministic analysis below is authoritative for all numeric fields, direction, confidence, support, resistance, entry zone, invalidation, targets, and risk level.',
  'Do not change, recompute, contradict, or invent numeric levels.',
  'Use the evidence summaries only to explain scenarios and risks.',
  'Clearly distinguish uncertainty. Do not claim guaranteed profit.',
  `Deterministic analysis: ${JSON.stringify(analysis)}`,
  `Evidence: ${JSON.stringify(research.items.map((item) => ({
    id: item.id,
    capability: item.capability,
    summary: item.summary,
    fact_type: item.fact_type,
    bias: item.bias,
    impact: item.impact,
    horizon: item.horizon,
    source_ids: item.source_ids,
  })))}`,
].join('\n\n');

export const runXauInvestSpecialist = async ({ market, research, narrator, signal } = {}) => {
  const analysis = analyzeXauUsd({ market, research });
  if (!narrator) return { analysis, narrative: null };
  if (typeof narrator.explain !== 'function') throw new Error('xau_invest_narrator_invalid');
  const instruction = buildInvestNarrativeInstruction({ analysis, research });
  const response = await narrator.explain({ instruction, analysis, research, signal });
  return {
    analysis,
    narrative: parseNarrative(response),
  };
};
