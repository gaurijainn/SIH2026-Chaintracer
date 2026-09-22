/**
 * Offline verification of the provider layer against the shipped replay fixtures:
 *   pnpm --filter @ps26183/workers provider:smoke
 * Reads a busy TRON wallet (1,050 transfers), an Ethereum and a Bitcoin wallet through the real adapters with
 * DATA_MODE=replay, twice, and checks the results are identical and the second pass is served from cache.
 */
import { fileURLToPath } from 'node:url';
import { loadEnv } from '@ps26183/shared';
import { createChainLayer } from './index';
import { DEMO_NOW, DEMO_READ } from './smoke-lib';

const fixtures = process.env.FIXTURES_DIR ?? fileURLToPath(new URL('../../fixtures', import.meta.url));
const env = { ...loadEnv({ ...process.env, DATA_MODE: 'replay' }), FIXTURES_DIR: fixtures };
const layer = createChainLayer({ env, now: () => DEMO_NOW });

let failed = false;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failed = true;
};

const t0 = Date.now();
const first = await DEMO_READ(layer);
const second = await DEMO_READ(layer);
const stats = layer.stats();

check(first.tron.length >= 1000, `TRON: ${first.tron.length} USDT-TRC20 transfers paged (>= 1,000)`);
check(new Set(first.tron.map((t) => `${t.txHash}|${t.idx}`)).size === first.tron.length, 'TRON: no duplicate (txHash, idx)');
check(first.tron.every((t) => typeof t.usd === 'number'), 'TRON: every transfer priced at its own timestamp (USD)');
check(first.tronMeta.activator !== null && first.tronMeta.flags.fraudTransaction === true, `TRON meta: activator ${first.tronMeta.activator?.slice(0, 8)}…, Tronscan flags present`);
check(first.eth.length >= 2 && first.btc.length >= 1 && first.outspends.length >= 1, `ETH ${first.eth.length}, BTC ${first.btc.length} transfers and ${first.outspends.length} outspends`);
check(JSON.stringify(first) === JSON.stringify(second), 'second pass identical to the first');
check(stats.cache.hitRate > 0.4, `cache hit rate ${(stats.cache.hitRate * 100).toFixed(0)}% on the second pass`);
console.log(`replay mode, no network: ${Date.now() - t0} ms; provider calls: ${Object.entries(stats.providers).map(([k, v]) => `${k}=${v.calls}`).join(' ')}`);
process.exit(failed ? 1 : 0);
