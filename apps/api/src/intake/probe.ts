import { createChainLayer, type Cache, type ChainLayer } from '@ps26183/workers/adapters';
import type { Chain, Env } from '@ps26183/shared';

/**
 * Chain probes used by complaint intake (B2) to disambiguate EVM chains and verify transaction hashes.
 * Since B3 these are answered by the real provider layer (rate limiting, retries, cache, failover, record/replay).
 */
export interface ChainProbe {
  /** true = address has any activity on that chain, false = none. Throws when no provider can answer. */
  addressActive(chain: Chain, addr: string): Promise<boolean>;
  txExists(chain: Chain, hash: string): Promise<boolean>;
}

export type ProbeStatus = 'active' | 'inactive' | 'unknown';

// Re-exported so fixture seeding hashes exactly the URLs the adapters request.
export { MEGANODE_URL, bscActivityBody, etherscanUrl, txlistQuery } from '@ps26183/workers/adapters';

export function createAdapterProbe(layer: ChainLayer): ChainProbe {
  return {
    addressActive: (chain, addr) => layer.adapter(chain).hasActivity(addr),
    txExists: (chain, hash) => layer.adapter(chain).txExists(hash),
  };
}

export function createHttpProbe(env: Pick<Env, 'DATA_MODE' | 'FIXTURES_DIR' | 'PROVIDER_LIMITS'> & Record<string, unknown>, cache?: Cache): ChainProbe {
  return createAdapterProbe(createChainLayer({ env, cache, pricing: false }));
}

/** Memoises probe results per batch, caps concurrency and bounds each call, so one slow provider cannot stall an import. */
export function createProbeRunner(probe: ChainProbe | null, opts: { concurrency?: number; timeoutMs?: number } = {}) {
  const { concurrency = 8, timeoutMs = 4000 } = opts;
  const memo = new Map<string, Promise<ProbeStatus>>();
  let running = 0;
  const waiters: (() => void)[] = [];

  const slot = async <T>(fn: () => Promise<T>): Promise<T> => {
    while (running >= concurrency) await new Promise<void>((r) => waiters.push(r));
    running++;
    try {
      return await fn();
    } finally {
      running--;
      waiters.shift()?.();
    }
  };

  const run = (key: string, call: () => Promise<boolean>): Promise<ProbeStatus> => {
    let p = memo.get(key);
    if (!p) {
      p = slot(async () => {
        if (!probe) return 'unknown' as const;
        try {
          const ok = await Promise.race([
            call(),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error('probe timeout')), timeoutMs).unref?.()),
          ]);
          return ok ? ('active' as const) : ('inactive' as const);
        } catch {
          return 'unknown' as const;
        }
      });
      memo.set(key, p);
    }
    return p;
  };

  return {
    address: (chain: Chain, addr: string) => run(`a:${chain}:${addr}`, () => probe!.addressActive(chain, addr)),
    tx: (chain: Chain, hash: string) => run(`t:${chain}:${hash}`, () => probe!.txExists(chain, hash)),
  };
}
export type ProbeRunner = ReturnType<typeof createProbeRunner>;
