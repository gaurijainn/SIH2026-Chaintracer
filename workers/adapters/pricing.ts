import { NATIVE_SYMBOL, TOKEN_WHITELIST, type Chain, type Transfer } from '@ps26183/shared';
import { TTL_FOREVER } from './cache';
import { ProviderHttpError, ProviderUnavailableError } from './errors';
import type { HttpFactory } from './http';
import type { ProviderGuard } from './providerGuard';

/** CoinGecko ids. Whitelisted stablecoins (USDT, BSC-USD) are priced as tether. */
const COIN_ID: Record<string, string> = {
  USDT: 'tether',
  [NATIVE_SYMBOL.TRON]: 'tron',
  [NATIVE_SYMBOL.ETH]: 'ethereum',
  [NATIVE_SYMBOL.POLYGON]: 'polygon-ecosystem-token',
  [NATIVE_SYMBOL.BSC]: 'binancecoin',
  [NATIVE_SYMBOL.BTC]: 'bitcoin',
};

/** The CoinGecko Demo plan only serves roughly the last year of history; older dates go straight to the fallback. */
export const COINGECKO_HISTORY_DAYS = 365;
const DAY_MS = 86_400_000;

export interface Quote {
  /** USD and INR per one unit of the asset, at the transaction's timestamp */
  usd: number;
  inr: number;
  source: 'coingecko' | 'defillama+frankfurter';
}

const pad = (n: number) => String(n).padStart(2, '0');
const cgDate = (ts: number) => {
  const d = new Date(ts);
  return `${pad(d.getUTCDate())}-${pad(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`;
};
const isoDate = (ts: number) => new Date(ts).toISOString().slice(0, 10);

/**
 * Historical pricing at each transaction's own timestamp.
 *   1. CoinGecko Demo, INR directly (per UTC day)
 *   2. fallback: DefiLlama historical USD at the exact timestamp x Frankfurter USD->INR for that day
 * Results are immutable history, so they are cached forever. Both paths go through the provider guard
 * (rate limits, retries, circuit breaker), so a throttled CoinGecko simply falls back.
 */
export class PricingService {
  private cgFlight = new Map<string, Promise<Quote>>();
  constructor(private d: { guard: ProviderGuard; http: HttpFactory; now?: () => number }) {}

  /** Pricing asset for a transfer, or null for tokens outside the whitelist (never priced). */
  assetOf(t: Pick<Transfer, 'chain' | 'token'>): string | null {
    if (TOKEN_WHITELIST.some((w) => w.chain === t.chain && w.contract.toLowerCase() === t.token.toLowerCase())) return 'USDT';
    return COIN_ID[t.token] && t.token === NATIVE_SYMBOL[t.chain as Chain] ? t.token : null;
  }

  async quote(asset: string, tsMs: number): Promise<Quote> {
    const id = COIN_ID[asset];
    if (!id) throw new ProviderHttpError(`no price source for ${asset}`, 'pricing', 404, undefined, false);
    const now = this.d.now?.() ?? Date.now();
    const cgKey = `price:cg:${id}:${cgDate(tsMs)}`;
    const dlKey = `price:dl:${id}:${Math.floor(tsMs / 1000)}`;
    const useCg = now - tsMs <= COINGECKO_HISTORY_DAYS * DAY_MS;

    // already known? (historical prices never change, so this is a forever cache) Only real network calls reach the guard.
    const known = (useCg ? await this.d.guard.peek<Quote>(cgKey) : undefined) ?? (await this.d.guard.peek<Quote>(dlKey));
    if (known) return known;

    // CoinGecko is a per-day lookup: concurrent transfers of the same day share ONE request (Demo quota is ~30/min)
    if (useCg) {
      let flight = this.cgFlight.get(cgKey);
      if (!flight) {
        flight = this.d.guard.call([
          {
            provider: 'coingecko',
            run: async () => {
              const q = await this.coingecko(id, tsMs);
              await this.d.guard.remember(cgKey, q, TTL_FOREVER);
              return q;
            },
          },
        ]);
        this.cgFlight.set(cgKey, flight);
        const done = () => void this.cgFlight.delete(cgKey);
        flight.then(done, done);
      }
      try {
        return await flight;
      } catch {
        /* CoinGecko cannot price this day (throttled, open circuit, no data): use the fallback */
      }
    }
    try {
      return await this.d.guard.call([
        {
          provider: 'defillama',
          run: async () => {
            const q = await this.defillama(id, tsMs);
            await this.d.guard.remember(dlKey, q, TTL_FOREVER);
            return q;
          },
        },
      ]);
    } catch (error) {
      throw new ProviderUnavailableError(`no price for ${asset} on ${isoDate(tsMs)}: CoinGecko and DefiLlama/Frankfurter both failed`, [{ provider: 'defillama', error }]);
    }
  }

  private async coingecko(id: string, tsMs: number): Promise<Quote> {
    const url = `https://api.coingecko.com/api/v3/coins/${id}/history?date=${cgDate(tsMs)}&localization=false`;
    const { data } = await this.d.http('coingecko').get(url, { headers: { 'x-cg-demo-api-key': '{COINGECKO_DEMO_KEY}' } });
    const p = (data as { market_data?: { current_price?: { usd?: number; inr?: number } } })?.market_data?.current_price;
    if (typeof p?.usd !== 'number' || typeof p.inr !== 'number') throw new ProviderHttpError(`coingecko: no price for ${id} on ${cgDate(tsMs)}`, 'coingecko', 404, undefined, false);
    return { usd: p.usd, inr: p.inr, source: 'coingecko' };
  }

  private async defillama(id: string, tsMs: number): Promise<Quote> {
    const coin = `coingecko:${id}`;
    const { data } = await this.d.http('defillama').get(`https://coins.llama.fi/prices/historical/${Math.floor(tsMs / 1000)}/${coin}`);
    const usd = (data as { coins?: Record<string, { price?: number }> })?.coins?.[coin]?.price;
    if (typeof usd !== 'number') throw new ProviderHttpError(`defillama: no price for ${id}`, 'defillama', 404, undefined, false);
    const rate = await this.usdInr(tsMs);
    return { usd, inr: usd * rate, source: 'defillama+frankfurter' };
  }

  /** ECB daily USD->INR (Frankfurter). Weekends resolve to the previous business day on the provider side. */
  private usdInr(tsMs: number): Promise<number> {
    return this.d.guard.cached(`fx:usdinr:${isoDate(tsMs)}`, TTL_FOREVER, () =>
      this.d.guard.call([
        {
          provider: 'frankfurter',
          run: async () => {
            const { data } = await this.d.http('frankfurter').get(`https://api.frankfurter.app/${isoDate(tsMs)}?from=USD&to=INR`);
            const inr = (data as { rates?: { INR?: number } })?.rates?.INR;
            if (typeof inr !== 'number') throw new ProviderHttpError('frankfurter: no USD->INR rate', 'frankfurter', 404, undefined, false);
            return inr;
          },
        },
      ]),
    );
  }

  /**
   * Fills `usd` (amount x USD price at the transfer's timestamp). A transfer whose price cannot be found is
   * returned unpriced rather than failing the whole page.
   */
  async enrich(items: Transfer[]): Promise<Transfer[]> {
    const wanted = new Map<string, Promise<Quote | null>>();
    const key = (t: Transfer) => `${this.assetOf(t)}|${t.ts}`;
    for (const t of items) {
      const asset = this.assetOf(t);
      if (asset && !wanted.has(key(t))) wanted.set(key(t), this.quote(asset, t.ts).catch(() => null));
    }
    const quotes = new Map(await Promise.all([...wanted].map(async ([k, p]) => [k, await p] as const)));
    return items.map((t) => {
      const q = quotes.get(key(t));
      return q ? { ...t, usd: Math.round(Number(t.amount) * q.usd * 1e6) / 1e6 } : t;
    });
  }

  /** INR value of an amount at a timestamp (used by report generation, B9). */
  async inrValue(asset: string, amount: string, tsMs: number): Promise<number> {
    return Math.round(Number(amount) * (await this.quote(asset, tsMs)).inr * 100) / 100;
  }
}
