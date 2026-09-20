import { createXauSearchPlan, buildSearchSynthesisInstruction } from './search-specialist.mjs';
import { parseXauResearch } from './research-contract.mjs';

const normalizeUrl = (value) => {
  try {
    const url = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
};

const clean = (value, max) => String(value || '').trim().slice(0, max);

const normalizeSearchResult = (item, { topicId, retrievedAt }) => {
  if (!item || typeof item !== 'object') return null;
  const url = normalizeUrl(item.url);
  const title = clean(item.title, 500);
  if (!url || !title) return null;
  return {
    topic_id: topicId,
    title,
    url,
    publisher: clean(item.publisher, 200) || 'Unknown',
    published_at: clean(item.published_at, 64),
    retrieved_at: clean(item.retrieved_at, 64) || retrievedAt,
    snippet: clean(item.snippet, 1200),
  };
};

const appendNormalized = (results, seen, counts, rows, { topicId, limitPerTopic }) => {
  const retrievedAt = new Date().toISOString();
  for (const row of rows) {
    const effectiveTopic = clean(row?.topic_id, 100) || topicId;
    const used = counts.get(effectiveTopic) || 0;
    if (used >= limitPerTopic) continue;
    const normalized = normalizeSearchResult(row, { topicId: effectiveTopic, retrievedAt });
    if (!normalized || seen.has(normalized.url)) continue;
    seen.add(normalized.url);
    counts.set(effectiveTopic, used + 1);
    results.push(normalized);
  }
};

export const collectXauSearchResults = async ({
  searchProvider,
  plan = createXauSearchPlan(),
  limitPerTopic = 8,
  signal,
} = {}) => {
  if (!searchProvider || (typeof searchProvider.search !== 'function' && typeof searchProvider.searchBatch !== 'function')) {
    throw new Error('xau_search_provider_required');
  }
  if (!plan || !Array.isArray(plan.topics)) throw new Error('invalid_xau_search_plan');

  const seen = new Set();
  const results = [];
  const counts = new Map();

  if (typeof searchProvider.searchBatch === 'function') {
    if (signal?.aborted) throw new Error('xau_search_cancelled');
    const response = await searchProvider.searchBatch({
      topics: plan.topics,
      symbol: 'XAUUSD',
      limitPerTopic,
      signal,
    });
    const rows = Array.isArray(response) ? response : response?.results;
    if (!Array.isArray(rows)) throw new Error('xau_search_provider_malformed:batch');
    const allowedTopics = new Set(plan.topics.map((topic) => topic.id));
    for (const row of rows) {
      if (!allowedTopics.has(row?.topic_id)) continue;
      appendNormalized(results, seen, counts, [row], {
        topicId: row.topic_id,
        limitPerTopic,
      });
    }
    return results;
  }

  for (const topic of plan.topics) {
    if (signal?.aborted) throw new Error('xau_search_cancelled');
    const response = await searchProvider.search({
      query: topic.query,
      topicId: topic.id,
      symbol: 'XAUUSD',
      limit: limitPerTopic,
      signal,
    });
    const rows = Array.isArray(response) ? response : response?.results;
    if (!Array.isArray(rows)) throw new Error(`xau_search_provider_malformed:${topic.id}`);
    appendNormalized(results, seen, counts, rows.slice(0, limitPerTopic), {
      topicId: topic.id,
      limitPerTopic,
    });
  }
  return results;
};

const parseSynthesis = (value) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) throw new Error('xau_search_synthesis_empty');
  try {
    return JSON.parse(value);
  } catch {
    throw new Error('xau_search_synthesis_invalid_json');
  }
};

const enforceRetrievedProvenance = (research, rawResults) => {
  const retrievedUrls = new Set(rawResults.map((item) => normalizeUrl(item.url)).filter(Boolean));
  for (const source of research.sources) {
    const normalized = normalizeUrl(source.url);
    if (!normalized || !retrievedUrls.has(normalized)) {
      throw new Error('xau_search_source_not_retrieved');
    }
  }
};

export const runXauSearchSpecialist = async ({
  searchProvider,
  synthesizer,
  generatedAt = new Date().toISOString(),
  limitPerTopic = 8,
  signal,
} = {}) => {
  if (!synthesizer || typeof synthesizer.synthesize !== 'function') {
    throw new Error('xau_search_synthesizer_required');
  }
  const plan = createXauSearchPlan({ generatedAt });
  const rawResults = await collectXauSearchResults({ searchProvider, plan, limitPerTopic, signal });
  if (rawResults.length === 0) throw new Error('xau_search_no_results');

  const instruction = buildSearchSynthesisInstruction({ plan, rawResults });
  const synthesis = await synthesizer.synthesize({
    instruction,
    plan,
    rawResults,
    signal,
  });
  const research = parseXauResearch(parseSynthesis(synthesis));
  enforceRetrievedProvenance(research, rawResults);
  if (research.sources.length === 0 || research.items.length === 0) {
    throw new Error('xau_search_no_evidence');
  }
  return {
    plan,
    raw_results: rawResults,
    research,
  };
};
