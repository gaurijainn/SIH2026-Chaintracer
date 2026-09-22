/**
 * B3 replay fixtures. Runs the REAL provider layer in record mode against the simulated providers in
 * workers/adapters/testing.ts, so the shipped fixtures are exactly what the adapters request (same URLs, same
 * sha1 file names) and are flagged `synthetic: true`. Real recordings (DATA_MODE=record with API keys) overwrite them.
 *
 * Demo data: a busy TRON wallet with 1,050 USDT-TRC20 transfers, an Ethereum wallet, a Bitcoin wallet, and prices.
 */
import { loadEnv } from '../packages/shared/src/index.ts';
import { DEMO_NOW, DEMO_READ } from '../workers/adapters/smoke-lib.ts';
import { createChainLayer } from '../workers/adapters/index.ts';
import { demoTransport } from '../workers/adapters/testing.ts';

const dir = process.env.FIXTURES_DIR ?? 'fixtures';
const layer = createChainLayer({
  env: { ...loadEnv({ DATA_MODE: 'record' }), FIXTURES_DIR: dir },
  transport: demoTransport(),
  synthetic: true,
  now: () => DEMO_NOW,
  guard: { unlimited: true },
});
const out = await DEMO_READ(layer);
console.log(`recorded B3 demo fixtures into ${dir}: ${out.tron.length} TRON transfers, ${out.eth.length} ETH, ${out.btc.length} BTC`);
