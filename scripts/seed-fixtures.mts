/**
 * Writes SYNTHETIC replay fixtures for every provider's /health probe so replay mode
 * works on a fresh clone with no keys. Real recordings come from DATA_MODE=record and
 * overwrite these (same sha1 file names). Flagged `synthetic: true` inside each file.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PROVIDERS, fixtureKey, fixturePath, type FixtureFile } from '../packages/shared/src/index.ts';

const dir = process.env.FIXTURES_DIR ?? 'fixtures';
const rpcOk = { jsonrpc: '2.0', id: 1, result: '0x1312d00' };

const bodies: Record<string, unknown> = {
  trongrid: { data: [{ address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', type: 'Contract' }], success: true },
  tronscan: { database: 'ok', sync: { progress: 100 } },
  etherscan: { jsonrpc: '2.0', id: 83, result: '0x1312d00' },
  meganode: rpcOk,
  blockscout: { total_blocks: '20000000', total_transactions: '2500000000' },
  esplora: 900000,
  mempool: 900000,
  alchemy: rpcOk,
  chainabuse: [],
  coingecko: { gecko_says: '(V3) To the Moon!' },
  defillama: { coins: { 'coingecko:tron': { price: 0.25, symbol: 'TRX' } } },
  frankfurter: { amount: 1, base: 'USD', date: '2026-09-18', rates: { INR: 88.1 } },
  ankr: rpcOk,
};

for (const p of PROVIDERS) {
  const body = p.probe.data === undefined ? undefined : JSON.stringify(p.probe.data);
  const key = fixtureKey(p.probe.method, p.probe.url, body);
  const fx: FixtureFile = {
    provider: p.id,
    request: { method: p.probe.method, url: p.probe.url, body },
    response: { status: 200, data: bodies[p.id] },
    recordedAt: '2026-09-20T00:00:00.000Z',
    synthetic: true,
  };
  const file = fixturePath(dir, p.id, key);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(fx, null, 2) + '\n');
  console.log('wrote', file);
}
