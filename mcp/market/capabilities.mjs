export const INVEST_CAPABILITY_IDS = Object.freeze([
  'market_analysis',
  'technical_analysis',
  'risk_management',
  'portfolio_diversification',
  'economic_indicators',
  'value_investing',
  'earnings_reports',
  'market_sentiment',
  'growth_vs_dividend',
  'global_events',
]);

export const INVEST_CAPABILITIES = Object.freeze([
  Object.freeze({ id: 'market_analysis', label: 'Market Analysis', xauusd: 'core' }),
  Object.freeze({ id: 'technical_analysis', label: 'Technical Analysis', xauusd: 'core' }),
  Object.freeze({ id: 'risk_management', label: 'Risk Management', xauusd: 'core' }),
  Object.freeze({ id: 'portfolio_diversification', label: 'Portfolio Diversification', xauusd: 'contextual' }),
  Object.freeze({ id: 'economic_indicators', label: 'Economic Indicators', xauusd: 'core' }),
  Object.freeze({ id: 'value_investing', label: 'Value Investing', xauusd: 'not_applicable' }),
  Object.freeze({ id: 'earnings_reports', label: 'Earnings Reports', xauusd: 'not_applicable' }),
  Object.freeze({ id: 'market_sentiment', label: 'Market Sentiment', xauusd: 'core' }),
  Object.freeze({ id: 'growth_vs_dividend', label: 'Growth vs Dividend Stocks', xauusd: 'not_applicable' }),
  Object.freeze({ id: 'global_events', label: 'Global Events', xauusd: 'core' }),
]);

export const getInvestCapabilities = (symbol = 'XAUUSD') => {
  const normalized = String(symbol || '').trim().toUpperCase().replace('/', '');
  if (normalized !== 'XAUUSD') throw new Error('unsupported_market_symbol');
  return INVEST_CAPABILITIES.map((item) => ({ ...item }));
};

export const isInvestCapability = (value) => INVEST_CAPABILITY_IDS.includes(value);
