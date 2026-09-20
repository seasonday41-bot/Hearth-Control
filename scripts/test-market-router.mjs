import test from 'node:test';
import assert from 'node:assert/strict';
import { validateHearthJob } from '../mcp/router/hearth-job-contract.mjs';
import { routeHearthJob } from '../mcp/router/router.mjs';

const job = (kind) => ({
  version: 'hearth-job-v1',
  job_id: `market-${kind}`,
  kind,
  objective: 'Analyze XAUUSD using Hearth market specialists.',
});

test('Market Router V1.1 market_search is a valid universal job kind', () => {
  const result = validateHearthJob(job('market_search'));
  assert.equal(result.ok, true);
  assert.equal(routeHearthJob(job('market_search')).route, 'market');
  assert.match(routeHearthJob(job('market_search')).reason, /Search AI/);
});

test('Market Router V1.2 investment_analysis is a valid universal job kind', () => {
  const result = validateHearthJob(job('investment_analysis'));
  assert.equal(result.ok, true);
  assert.equal(routeHearthJob(job('investment_analysis')).route, 'market');
  assert.match(routeHearthJob(job('investment_analysis')).reason, /Invest AI/);
});

test('Market Router V1.3 callers still cannot select worker/provider directly', () => {
  for (const field of ['worker', 'agent', 'provider']) {
    const result = validateHearthJob({ ...job('market_search'), [field]: 'custom' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((item) => item.path === field && item.code === 'UNKNOWN_FIELD'));
  }
});
