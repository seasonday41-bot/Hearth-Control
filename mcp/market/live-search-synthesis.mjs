import { createXauSearchPlan } from './search-specialist.mjs';
import { collectXauSearchResults } from './search-pipeline.mjs';
import { parseXauResearch } from './research-contract.mjs';

const FACT_TYPES = new Set(['fact', 'claim', 'interpretation']);
const BIASES = new Set(['bullish', 'bearish', 'neutral', 'mixed']);
const IMPACTS = new Set(['low', 'medium', 'high']);
const HORIZONS = new Set(['intraday', 'swing', 'macro']);
const OFFICIAL_HOSTS = new Set(['www.federalreserve.gov', 'www.bls.gov']);

const clampWindowStart = (rows, end) => {
  const endMs = new Date(end).getTime();
  const values = rows
    .map((row) => new Date(row.published_at).getTime())
    .filter((value) => Number.isFinite(value) && value <= endMs);
  return values.length ? new Date(Math.min(...values)).toISOString() : end;
};

const selectDiverseResults = (rows, maxPerTopic = 2, maxTotal = 12) => {
  const counts = new Map();
  const selected = [];
  const prioritized = [...rows].sort((a, b) => {
    const aOfficial = OFFICIAL_HOSTS.has(new URL(a.url).hostname) ? 1 : 0;
    const bOfficial = OFFICIAL_HOSTS.has(new URL(b.url).hostname) ? 1 : 0;
    return bOfficial - aOfficial;
  });
  for (const row of prioritized) {
    const used = counts.get(row.topic_id) || 0;
    if (used >= maxPerTopic) continue;
    selected.push(row);
    counts.set(row.topic_id, used + 1);
    if (selected.length >= maxTotal) break;
  }
  return selected;
};

const sourceTypeFor = (url) => {
  const hostname = new URL(url).hostname;
  return OFFICIAL_HOSTS.has(hostname) ? 'official' : 'news';
};

const credibilityFor = (url) => {
  const hostname = new URL(url).hostname;
  return OFFICIAL_HOSTS.has(hostname) ? 'primary' : 'unknown';
};

const parseClassifierResponse = (value) => {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); }
    catch { throw new Error('xau_live_classifier_invalid_json'); }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.items)) {
    throw new Error('xau_live_classifier_invalid');
  }
  return parsed.items;
};

export const buildLeanClassifierInstruction = ({ sources }) => [
  '[Hearth Search AI — XAU/USD evidence classifier]',
  'Return ONLY JSON: {"items":[...]}',
  'Each item must contain exactly: source_id, summary, fact_type, bias, impact, horizon.',
  'Use only supplied source_id values. One item maximum per source. Omit a source if it is not useful.',
  'fact_type must be fact, claim, or interpretation.',
  'bias must be bullish, bearish, neutral, or mixed for XAU/USD.',
  'impact must be low, medium, or high.',
  'horizon must be intraday, swing, or macro.',
  'Do not create URLs, source metadata, prices, economic numbers, or trading levels.',
  'Do not output Buy/Sell/Hold.',
  `Sources: ${JSON.stringify(sources)}`,
].join('\n\n');

export const runLeanLiveXauSearch = async ({
  searchProvider,
  classifier,
  generatedAt = new Date().toISOString(),
  limitPerTopic = 3,
  signal,
} = {}) => {
  if (!classifier || typeof classifier.classify !== 'function') {
    throw new Error('xau_live_classifier_required');
  }
  const plan = createXauSearchPlan({ generatedAt });
  const rawResults = await collectXauSearchResults({
    searchProvider,
    plan,
    limitPerTopic,
    signal,
  });
  if (rawResults.length === 0) throw new Error('xau_search_no_results');

  const selected = selectDiverseResults(rawResults);
  const topicMap = new Map(plan.topics.map((topic) => [topic.id, topic]));
  const sourceRows = selected.map((row, index) => {
    const id = `src-${String(index + 1).padStart(3, '0')}`;
    return {
      id,
      topic_id: row.topic_id,
      title: row.title,
      url: row.url,
      publisher: row.publisher,
      published_at: row.published_at,
      retrieved_at: row.retrieved_at,
      snippet: row.snippet,
    };
  });
  const sourceById = new Map(sourceRows.map((row) => [row.id, row]));

  const instruction = buildLeanClassifierInstruction({ sources: sourceRows });
  const response = await classifier.classify({
    instruction,
    sources: sourceRows,
    signal,
  });
  const classified = parseClassifierResponse(response);

  const items = [];
  const usedSourceIds = new Set();
  for (const item of classified.slice(0, sourceRows.length)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const sourceId = String(item.source_id || '');
    const source = sourceById.get(sourceId);
    if (!source || usedSourceIds.has(sourceId)) continue;
    const factType = String(item.fact_type || '');
    const bias = String(item.bias || '');
    const impact = String(item.impact || '');
    const horizon = String(item.horizon || '');
    const summary = String(item.summary || '').trim().slice(0, 2000);
    if (!summary || !FACT_TYPES.has(factType) || !BIASES.has(bias) || !IMPACTS.has(impact) || !HORIZONS.has(horizon)) continue;
    const topic = topicMap.get(source.topic_id);
    if (!topic) continue;
    usedSourceIds.add(sourceId);
    items.push({
      id: `item-${String(items.length + 1).padStart(3, '0')}`,
      capability: topic.capability,
      topic: source.topic_id,
      summary,
      fact_type: factType,
      bias,
      impact,
      horizon,
      source_ids: [sourceId],
    });
  }
  if (items.length === 0) throw new Error('xau_search_no_evidence');

  const usedSources = sourceRows
    .filter((row) => usedSourceIds.has(row.id))
    .map((row) => ({
      id: row.id,
      url: row.url,
      title: row.title,
      publisher: row.publisher,
      published_at: row.published_at,
      retrieved_at: row.retrieved_at,
      source_type: sourceTypeFor(row.url),
      credibility: credibilityFor(row.url),
    }));

  return parseXauResearch({
    version: 'xau-research-v1',
    symbol: 'XAUUSD',
    generated_at: generatedAt,
    window: {
      start: clampWindowStart(usedSources, generatedAt),
      end: generatedAt,
    },
    sources: usedSources,
    items,
    macro: [],
  });
};
