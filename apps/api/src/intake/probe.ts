import { buildSecrets, createHttp, type Chain, type Env } from '@ps26183/shared';

/**
 * Minimal on-chain existence probes used only to disambiguate EVM chains and verify tx hashes at intake.
 * Full provider adapters (paging, limiter, cache, failover) are B3; these are single calls that go
 * through the same record/replay client, so they work offline in replay mode.
 */
export interface ChainProbe {
  /** true = address has any activity on that chain, false = none. Throws when the provider cannot answer. */
  addressActive(chain: Chain, addr: string): Promise<boolean>;
  txExists(chain: Chain, hash: string): Promise<boolean>;
}

export type ProbeStatus = 'active' | 'inactive' | 'unknown';

export const ETHERSCAN_CHAIN_ID: Partial<Record<Chain, number>> = { ETH: 1, POLYGON: 137 };

// URL builders are exported so fixture seeding uses exactly the same strings (and hashes).
export const etherscanUrl = (chain: Chain, query: string) =>
  `https://api.etherscan.io/v2/api?chainid=${ETHERSCAN_CHAIN_ID[chain]}&${query}&apikey={ETHERSCAN_KEY}`;
export const txlistQuery = (action: 'txlist' | 'tokentx', addr: string) =>
  `module=account&action=${action}&address=${addr}&startblock=0&endblock=99999999&page=1&offset=1&sort=asc`;
export const MEGANODE_URL = 'https://bsc-mainnet.nodereal.io/v1/{MEGANODE_KEY}';
export const bscActivityBody = (addr: string) => [
  { jsonrpc: '2.0', id: 1, method: 'eth_getTransactionCount', params: [addr, 'latest'] },
  { jsonrpc: '2.0', id: 2, method: 'eth_getBalance', params: [addr, 'latest'] },
];
export const TRONGRID_TX_URL = 'https://api.trongrid.io/wallet/gettransactionbyid';
export const esploraTxUrl = (hash: string) => `https://blockstream.info/api/tx/${hash}`;

const nonZeroHex = (v: unknown) => typeof v === 'string' && /^0x[0-9a-f]+$/i.test(v) && BigInt(v) > 0n;

export function createHttpProbe(env: Pick<Env, 'DATA_MODE' | 'FIXTURES_DIR'> & Record<string, unknown>): ChainProbe {
  const secrets = buildSecrets(env);
  const clients = new Map<string, ReturnType<typeof createHttp>>();
  const http = (provider: string) => {
    let c = clients.get(provider);
    if (!c) clients.set(provider, (c = createHttp({ provider, mode: env.DATA_MODE, fixturesDir: env.FIXTURES_DIR, secrets, timeoutMs: 4000 })));
    return c;
  };

  const etherscan = async (chain: Chain, query: string) => {
    const { data } = await http('etherscan').get(etherscanUrl(chain, query));
    return data as { status?: string; message?: string; result?: unknown };
  };
  const hasRows = (d: { status?: string; message?: string; result?: unknown }) => {
    if (d.status === '1' && Array.isArray(d.result)) return d.result.length > 0;
    if (d.status === '0' && Array.isArray(d.result) && d.result.length === 0) return false; // "No transactions found"
    throw new Error(`etherscan: ${typeof d.result === 'string' ? d.result : (d.message ?? 'unexpected response')}`);
  };

  return {
    async addressActive(chain, addr) {
      if (chain === 'BSC') {
        const { data } = await http('meganode').post(MEGANODE_URL, bscActivityBody(addr));
        if (!Array.isArray(data)) throw new Error('meganode: unexpected response');
        return data.some((r: { result?: unknown }) => nonZeroHex(r.result));
      }
      if (chain === 'ETH' || chain === 'POLYGON') {
        if (hasRows(await etherscan(chain, txlistQuery('txlist', addr)))) return true;
        return hasRows(await etherscan(chain, txlistQuery('tokentx', addr))); // receive-only wallets
      }
      throw new Error(`no address probe for ${chain}`);
    },

    async txExists(chain, hash) {
      if (chain === 'ETH' || chain === 'POLYGON') {
        const d = await etherscan(chain, `module=proxy&action=eth_getTransactionByHash&txhash=${hash}`);
        if (d.result && typeof d.result === 'object') return true;
        if (d.result === null) return false;
        throw new Error('etherscan: unexpected response');
      }
      if (chain === 'BSC') {
        const { data } = await http('meganode').post(MEGANODE_URL, { jsonrpc: '2.0', id: 1, method: 'eth_getTransactionByHash', params: [hash] });
        return !!data?.result;
      }
      if (chain === 'TRON') {
        const { data } = await http('trongrid').post(TRONGRID_TX_URL, { value: hash }, { headers: { 'TRON-PRO-API-KEY': '{TRONGRID_KEY}' } });
        return !!data?.txID;
      }
      const r = await http('esplora').get(esploraTxUrl(hash), { validateStatus: (s) => s === 200 || s === 404 });
      return r.status === 200;
    },
  };
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
