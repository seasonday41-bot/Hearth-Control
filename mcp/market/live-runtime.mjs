import { createOllamaProvider } from '../providers/ollama.mjs';
import { runXauSearchSpecialist } from './search-pipeline.mjs';
import { runLeanLiveXauSearch } from './live-search-synthesis.mjs';
import { createPublicMarketSearchProvider } from './web-search-provider.mjs';
import { createMt5LoopbackAdapter } from './mt5-adapter.mjs';
import { runXauInvestSpecialist } from './invest-specialist.mjs';

const ensureOkResponse = (result, code) => {
  if (!result?.ok || typeof result.response !== 'string' || !result.response.trim()) {
    const detail = result?.error?.code || result?.error?.message || 'unknown';
    throw new Error(`${code}:${detail}`);
  }
  return result.response;
};

export const createOllamaMarketSynthesizer = ({ provider = createOllamaProvider() } = {}) => ({
  async synthesize({ instruction, signal }) {
    const result = await provider.chat({
      messages: [
        {
          role: 'system',
          content: 'You are Hearth Search AI for XAU/USD. Return strict JSON only. Never invent sources or financial data.',
        },
        { role: 'user', content: instruction },
      ],
      profile: 'normal',
      longResponse: true,
      temperature: 0.1,
      format: 'json',
      signal,
    });
    return ensureOkResponse(result, 'xau_search_model_failed');
  },
});

export const createOllamaMarketClassifier = ({ provider = createOllamaProvider() } = {}) => ({
  async classify({ instruction, signal }) {
    const result = await provider.chat({
      messages: [
        {
          role: 'system',
          content: 'You are Hearth Search AI for XAU/USD. Classify supplied evidence only. Return strict JSON only and never invent facts, URLs, prices, or economic numbers.',
        },
        { role: 'user', content: instruction },
      ],
      profile: 'fast',
      num_ctx: 8192,
      num_predict: 768,
      temperature: 0.1,
      format: 'json',
      signal,
      timeoutMs: 60_000,
    });
    return ensureOkResponse(result, 'xau_search_classifier_failed');
  },
});

export const createOllamaInvestNarrator = ({ provider = createOllamaProvider() } = {}) => ({
  async explain({ instruction, signal }) {
    const result = await provider.chat({
      messages: [
        {
          role: 'system',
          content: 'You are Hearth Invest AI for XAU/USD. Explain the deterministic engine output without changing any numeric level or signal. Return strict JSON only.',
        },
        { role: 'user', content: instruction },
      ],
      profile: 'fast',
      num_ctx: 8192,
      num_predict: 768,
      temperature: 0.1,
      format: 'json',
      signal,
      timeoutMs: 60_000,
    });
    return ensureOkResponse(result, 'xau_invest_model_failed');
  },
});

export const runLiveXauSearch = async ({
  searchProvider = createPublicMarketSearchProvider(),
  synthesizer = null,
  classifier = null,
  generatedAt = new Date().toISOString(),
  limitPerTopic = 3,
  signal,
} = {}) => {
  if (synthesizer) {
    const result = await runXauSearchSpecialist({
      searchProvider,
      synthesizer,
      generatedAt,
      limitPerTopic,
      signal,
    });
    return result.research;
  }

  return runLeanLiveXauSearch({
    searchProvider,
    classifier: classifier || createOllamaMarketClassifier(),
    generatedAt,
    limitPerTopic,
    signal,
  });
};

export const runLiveXauInvestment = async ({
  searchProvider = createPublicMarketSearchProvider(),
  synthesizer = null,
  classifier = null,
  mt5 = createMt5LoopbackAdapter(),
  narrator = createOllamaInvestNarrator(),
  generatedAt = new Date().toISOString(),
  timeframe = 'H1',
  barLimit = 250,
  closedBarsOnly = false,
  signal,
} = {}) => {
  const research = await runLiveXauSearch({
    searchProvider,
    synthesizer,
    classifier,
    generatedAt,
    signal,
  });
  const rawMarket = await mt5.getBars({
    symbol: 'XAUUSD',
    timeframe,
    limit: barLimit,
    signal,
  });
  const market = closedBarsOnly
    ? {
        ...rawMarket,
        as_of: rawMarket.bars.at(-2)?.time || rawMarket.as_of,
        bars: rawMarket.bars.slice(0, -1),
      }
    : rawMarket;
  if (closedBarsOnly && market.bars.length < 20) throw new Error('mt5_insufficient_closed_bars');
  const result = await runXauInvestSpecialist({
    market,
    research,
    narrator,
    signal,
  });
  return {
    research,
    market: {
      symbol: market.symbol,
      timeframe: market.timeframe,
      as_of: market.as_of,
      source: market.source,
      bar_count: market.bars.length,
    },
    analysis: result.analysis,
    narrative: result.narrative,
  };
};
