import type { AxiosAdapter } from 'axios';
import type { Chain, ChainAdapter, Env, ProbeCapable } from '@ps26183/shared';
import { BtcAdapter } from './btc';
import { MemoryCache, type Cache } from './cache';
import { EvmAdapter } from './evm';
import { createProviderHttp, type HttpFactory } from './http';
import { parseLimitOverrides } from './limits';
import { PricingService } from './pricing';
import { ProviderGuard, type GuardOptions } from './providerGuard';
import { TronAdapter } from './tron';

export * from './btc';
export * from './cache';
export * from './errors';
export * from './evm';
export * from './http';
export * from './limits';
export * from './paginate';
export * from './pricing';
export * from './providerGuard';
export * from './tron';

export interface ChainLayerOptions {
  env: Pick<Env, 'DATA_MODE' | 'FIXTURES_DIR' | 'PROVIDER_LIMITS'> & Record<string, unknown>;
  /** Redis in production, in-memory in tests. Defaults to memory. */
  cache?: Cache;
  guard?: GuardOptions;
  /** fill Transfer.usd at each transfer's timestamp (default true) */
  pricing?: boolean;
  transport?: AxiosAdapter;
  /** mark recorded fixtures synthetic (data came from a simulated provider) */
  synthetic?: boolean;
  /** clock for quota days, breaker cooldowns and the pricing history window (fixed in demos so replays are reproducible) */
  now?: () => number;
}

export interface ChainLayer {
  guard: ProviderGuard;
  http: HttpFactory;
  pricing: PricingService;
  tron: TronAdapter;
  btc: BtcAdapter;
  adapter(chain: Chain): ChainAdapter & ProbeCapable;
  /** limiter/retry/breaker/quota counters and cache hit rate, for the admin quota panel (B11) */
  stats: ProviderGuard['stats'];
}

/**
 * Builds the whole provider layer: one adapter per chain over a shared provider guard, all HTTP going through the
 * B0 record/replay client. In replay mode nothing touches the network and rate limiting is off (only local reads).
 */
export function createChainLayer(o: ChainLayerOptions): ChainLayer {
  const { env } = o;
  const http = createProviderHttp({ mode: env.DATA_MODE, fixturesDir: env.FIXTURES_DIR, env, transport: o.transport, synthetic: o.synthetic });
  const guard = new ProviderGuard({
    cache: o.cache ?? new MemoryCache(),
    limits: parseLimitOverrides(env.PROVIDER_LIMITS),
    unlimited: env.DATA_MODE === 'replay',
    ...(o.now ? { now: o.now } : {}),
    ...o.guard,
  });
  const pricing = new PricingService({ guard, http, now: o.now });
  const deps = { guard, http, pricing: o.pricing === false ? undefined : pricing };
  const tron = new TronAdapter(deps);
  const btc = new BtcAdapter(deps);
  const evm = (chain: 'ETH' | 'POLYGON' | 'BSC') => new EvmAdapter({ ...deps, chain });
  const adapters: Record<Chain, ChainAdapter & ProbeCapable> = { TRON: tron, BTC: btc, ETH: evm('ETH'), POLYGON: evm('POLYGON'), BSC: evm('BSC') };
  return { guard, http, pricing, tron, btc, adapter: (c) => adapters[c], stats: () => guard.stats() };
}
