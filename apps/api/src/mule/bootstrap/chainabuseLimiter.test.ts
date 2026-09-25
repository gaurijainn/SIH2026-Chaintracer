import { describe, expect, it, vi } from 'vitest';
import { loadEnv } from '@ps26183/shared';
import { createChainLayer } from '@ps26183/workers/adapters';
import { fakeTransport, tronAddr, type Route } from '@ps26183/workers/adapters/testing';
import { ChainabuseClient } from '../../attribution/loaders/chainabuse';
import { ChainabuseBudget, ChainabuseBudgetExceededError, enrichHighRiskWithChainabuse, selectChainabuseCandidates } from './chainabuseLimiter';

function layer(routes: Route[]) {
  const env = { ...loadEnv({ DATA_MODE: 'live' }), FIXTURES_DIR: 'unused' };
  return createChainLayer({ env, transport: fakeTransport(routes), pricing: false, guard: { unlimited: true, sleep: async () => undefined, random: () => 0 } });
}

describe('selectChainabuseCandidates', () => {
  it('picks a stable, deterministic subset of exactly `max` addresses when more are eligible', () => {
    const addrs = Array.from({ length: 15 }, (_, i) => tronAddr(`ca-${i}`));
    const a = selectChainabuseCandidates(addrs, 10);
    const b = selectChainabuseCandidates([...addrs].reverse(), 10);
    expect(a).toHaveLength(10);
    expect(a).toEqual(b); // order-independent, same 10 every time
    expect(a).toEqual([...a].sort((x, y) => x.localeCompare(y)));
  });

  it('returns every address unchanged (sorted) when fewer than max are eligible', () => {
    const addrs = [tronAddr('x'), tronAddr('y')];
    expect(selectChainabuseCandidates(addrs, 10).sort()).toEqual([...addrs].sort());
  });
});

describe('ChainabuseBudget', () => {
  it('allows exactly `max` consumptions and throws on the (max+1)th', () => {
    const budget = new ChainabuseBudget(10);
    for (let i = 0; i < 10; i++) budget.consume();
    expect(budget.remaining).toBe(0);
    expect(() => budget.consume()).toThrow(ChainabuseBudgetExceededError);
  });
});

describe('enrichHighRiskWithChainabuse: hard 10-call limit', () => {
  const addr = (i: number) => tronAddr(`hr-${i}`);
  const route: Route = [/api\.chainabuse\.com\/v0\/reports/, () => ({ count: 0, reports: [] })];

  it('never makes more than 10 Chainabuse calls for exactly 10 selected addresses', async () => {
    const l = layer([route]);
    const client = new ChainabuseClient({ guard: l.guard, http: l.http });
    const budget = new ChainabuseBudget(10);
    const addresses = Array.from({ length: 10 }, (_, i) => addr(i));
    const records = await enrichHighRiskWithChainabuse(client, budget, addresses, { maxRetries: 0 });
    expect(records).toHaveLength(10);
    expect(budget.callsUsed).toBe(10);
  });

  it('refuses further attempts once the budget is exhausted, even mid-retry on a single flaky address', async () => {
    const failing: Route = [/api\.chainabuse\.com\/v0\/reports\?address=fail-target/, () => { throw new Error('simulated transient failure'); }];
    const l = layer([failing]);
    const client = new ChainabuseClient({ guard: l.guard, http: l.http });
    const reportsForSpy = vi.spyOn(client, 'reportsFor');
    const budget = new ChainabuseBudget(3); // a single flaky address retried many times must still hit the hard cap
    await expect(enrichHighRiskWithChainabuse(client, budget, ['fail-target'], { maxRetries: 10 })).rejects.toThrow(ChainabuseBudgetExceededError);
    expect(budget.callsUsed).toBe(3); // exactly 3 attempts made, never a 4th, despite maxRetries allowing up to 11
    expect(reportsForSpy).toHaveBeenCalledTimes(3);
  });

  it('a caller trying to force an 11th real network attempt is blocked before ChainabuseClient.reportsFor is even invoked', async () => {
    const l = layer([route]);
    const client = new ChainabuseClient({ guard: l.guard, http: l.http });
    const reportsForSpy = vi.spyOn(client, 'reportsFor');
    const budget = new ChainabuseBudget(10);
    const addresses = Array.from({ length: 11 }, (_, i) => addr(i));
    await expect(enrichHighRiskWithChainabuse(client, budget, addresses, { maxRetries: 0 })).rejects.toThrow(ChainabuseBudgetExceededError);
    expect(reportsForSpy).toHaveBeenCalledTimes(10); // the 11th was refused before any call
  });
});
