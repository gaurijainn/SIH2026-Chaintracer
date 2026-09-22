import type { AxiosAdapter } from 'axios';
import { describe, expect, it } from 'vitest';
import { USDT_TRC20, loadEnv, type Transfer } from '@ps26183/shared';
import { PricingService } from './pricing';
import { createChainLayer } from './index';
import { fakeTransport, reply, type Route } from './testing';

const NOW = Date.UTC(2026, 8, 20);
const TS = Date.UTC(2026, 7, 15, 10, 30, 0); // 2026-08-15 10:30 UTC
const xfer = (over: Partial<Transfer> = {}): Transfer => ({
  chain: 'TRON', txHash: 'a'.repeat(64), idx: 1, from: 'F', to: 'T', token: USDT_TRC20, amount: '1500.5', ts: TS, block: 0, ...over,
});

function pricing(transport: AxiosAdapter, opts: { key?: string } = {}) {
  const l = createChainLayer({
    env: { ...loadEnv({ DATA_MODE: 'live', COINGECKO_DEMO_KEY: opts.key ?? 'cg-secret' }), FIXTURES_DIR: 'unused' },
    transport,
    pricing: false,
    guard: { unlimited: true, sleep: async () => undefined, random: () => 0, now: () => NOW },
  });
  return { svc: new PricingService({ guard: l.guard, http: l.http, now: () => NOW }), guard: l.guard };
}

const cg = (usd: number, inr: number): Route => [/api\.coingecko\.com/, () => ({ market_data: { current_price: { usd, inr } } })];
const llama = (price: number): Route => [/coins\.llama\.fi/, () => ({ coins: { 'coingecko:tether': { price } } })];
const frank = (inr: number): Route => [/api\.frankfurter\.app/, () => ({ rates: { INR: inr } })];

describe('PricingService: CoinGecko Demo (INR direct)', () => {
  it('asks for the transaction\'s own UTC day with the demo key header and returns USD and INR', async () => {
    const t = fakeTransport([cg(1.0004, 88.13)]);
    const q = await pricing(t).svc.quote('USDT', TS);
    expect(q).toEqual({ usd: 1.0004, inr: 88.13, source: 'coingecko' });
    expect(t.calls[0].url).toBe('https://api.coingecko.com/api/v3/coins/tether/history?date=15-08-2026&localization=false');
    expect(t.calls[0].headers['x-cg-demo-api-key']).toBe('cg-secret');
  });

  it('prices at each transfer\'s timestamp: different days -> different lookups; same day -> one call', async () => {
    const t = fakeTransport([[/date=(\d\d)-08-2026/, (_r, m) => ({ market_data: { current_price: { usd: 1 + Number(m[1]) / 1000, inr: 88 } } })]]);
    const { svc } = pricing(t);
    const out = await svc.enrich([xfer({ ts: TS, amount: '1000' }), xfer({ ts: TS + 3_600_000, amount: '2000', idx: 2 }), xfer({ ts: TS + 86_400_000, amount: '1000', idx: 3 })]);
    expect(out.map((o) => o.usd)).toEqual([1015, 2030, 1016]);
    expect(t.calls).toHaveLength(2); // 15 Aug and 16 Aug
  });

  it('caches quotes forever: a second lookup makes no provider call', async () => {
    const t = fakeTransport([cg(1, 88)]);
    const { svc } = pricing(t);
    await svc.quote('USDT', TS);
    await svc.quote('USDT', TS + 1000);
    expect(t.calls).toHaveLength(1);
  });
});

describe('PricingService: fallback DefiLlama USD x Frankfurter USD->INR', () => {
  it('falls back when CoinGecko is throttled: exact-timestamp USD from DefiLlama, INR via the daily ECB rate', async () => {
    const t = fakeTransport([[/api\.coingecko\.com/, () => reply({}, 429)], llama(0.9991), frank(88.2)]);
    const q = await pricing(t).svc.quote('USDT', TS);
    expect(q.source).toBe('defillama+frankfurter');
    expect(q.usd).toBe(0.9991);
    expect(q.inr).toBeCloseTo(0.9991 * 88.2, 6);
    expect(t.calls.find((c) => c.url.includes('llama'))!.url).toBe(`https://coins.llama.fi/prices/historical/${TS / 1000}/coingecko:tether`);
    expect(t.calls.find((c) => c.url.includes('frankfurter'))!.url).toBe('https://api.frankfurter.app/2026-08-15?from=USD&to=INR');
  });

  it('falls back on a CoinGecko answer without a price for that date', async () => {
    const t = fakeTransport([[/api\.coingecko\.com/, () => ({ id: 'tether' })], llama(1), frank(88)]);
    expect((await pricing(t).svc.quote('USDT', TS)).source).toBe('defillama+frankfurter');
  });

  it('skips CoinGecko entirely for dates beyond the Demo plan\'s history window', async () => {
    const t = fakeTransport([cg(1, 88), llama(1), frank(88)]);
    const old = NOW - 400 * 86_400_000;
    const q = await pricing(t).svc.quote('USDT', old);
    expect(q.source).toBe('defillama+frankfurter');
    expect(t.calls.some((c) => c.url.includes('api.coingecko.com'))).toBe(false);
  });

  it('fails clearly when neither path can price it', async () => {
    const t = fakeTransport([[/./, () => reply({}, 404)]]);
    await expect(pricing(t).svc.quote('USDT', TS)).rejects.toThrow(/no price for USDT on 2026-08-15/);
  });
});

describe('PricingService.enrich', () => {
  it('prices whitelisted stablecoins and native coins; never prices unknown tokens', async () => {
    const t = fakeTransport([[/coins\/tether\//, () => ({ market_data: { current_price: { usd: 1, inr: 88 } } })], [/coins\/tron\//, () => ({ market_data: { current_price: { usd: 0.25, inr: 22 } } })]]);
    const { svc } = pricing(t);
    const out = await svc.enrich([xfer(), xfer({ token: 'TRX', amount: '400', idx: 2 }), xfer({ token: 'TKX4tuVb4ApiutoibSFugfFW9nBcXaMNDe', idx: 3 })]);
    expect(out.map((o) => o.usd)).toEqual([1500.5, 100, undefined]);
  });

  it('a price failure leaves the transfer unpriced instead of failing the page', async () => {
    const t = fakeTransport([[/./, () => reply({}, 500)]]);
    const out = await pricing(t).svc.enrich([xfer()]);
    expect(out).toHaveLength(1);
    expect(out[0].usd).toBeUndefined();
    expect(out[0].amount).toBe('1500.5');
  });

  it('converts an amount to INR at the transaction time (for report generation)', async () => {
    const t = fakeTransport([cg(1, 88.13)]);
    expect(await pricing(t).svc.inrValue('USDT', '1000', TS)).toBe(88130);
  });
});

describe('quota handling under CoinGecko\'s ~30 calls/minute Demo limit', () => {
  it('a throttled CoinGecko trips its breaker and later lookups go straight to the fallback', async () => {
    const t = fakeTransport([[/api\.coingecko\.com/, () => reply({}, 429)], llama(1), frank(88)]);
    const l = createChainLayer({
      env: { ...loadEnv({ DATA_MODE: 'live' }), FIXTURES_DIR: 'unused' },
      transport: t, pricing: false,
      guard: { unlimited: true, sleep: async () => undefined, random: () => 0, now: () => NOW, breaker: { failureThreshold: 5, cooldownMs: 60_000 }, retry: { attempts: 3 } },
    });
    const svc = new PricingService({ guard: l.guard, http: l.http, now: () => NOW });
    await svc.quote('USDT', TS);
    await svc.quote('USDT', TS + 86_400_000); // CoinGecko circuit is now open
    const cgCalls = t.calls.filter((c) => c.url.includes('api.coingecko.com')).length;
    await svc.quote('USDT', TS + 2 * 86_400_000);
    expect(t.calls.filter((c) => c.url.includes('api.coingecko.com')).length).toBe(cgCalls); // no more hammering
    expect(l.stats().providers.coingecko.circuit).toBe('open');
  });
});
